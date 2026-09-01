import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { RpcFrameDecoder, type RpcCommand, type RpcInboundFrame, type RpcResponse, isRpcReady, isRpcResponse } from "./rpc-protocol";
import { isRecord } from "./type-guards";

export interface OmpRpcClientOptions {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  readyTimeoutMs?: number;
  commandTimeoutMs?: number;
  maxStderrBytes?: number;
}

export interface RpcCommandInput {
  type: string;
  [key: string]: unknown;
}

export type RpcFrameListener = (frame: Record<string, unknown>) => void | Promise<void>;
export type RpcExitListener = (error: Error) => void | Promise<void>;

export interface RpcClient {
  readonly running: boolean;
  onFrame(listener: RpcFrameListener): () => void;
  onExit(listener: RpcExitListener): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(command: RpcCommandInput, timeoutMs?: number): Promise<RpcResponse>;
  write(frame: RpcInboundFrame): void;
}

interface PendingRequest {
  command: string;
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcCommandError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RpcCommandError";
  }
}

/** Process-backed OMP RPC client with v2 negotiation, lossless frames, and restart-safe teardown. */
export class OmpRpcClient implements RpcClient {
  readonly #options: Required<Pick<OmpRpcClientOptions, "readyTimeoutMs" | "commandTimeoutMs" | "maxStderrBytes">> & OmpRpcClientOptions;
  readonly #frameListeners = new Set<RpcFrameListener>();
  readonly #exitListeners = new Set<RpcExitListener>();
  readonly #pending = new Map<string, PendingRequest>();
  #eventQueue: Promise<void> = Promise.resolve();
  #child: ChildProcessWithoutNullStreams | undefined;
  #exited: Promise<void> | undefined;
  #requestId = 0;
  #stderr = "";
  #protocolVersion = 1;
  #stopping = false;
  #ready = false;

  constructor(options: OmpRpcClientOptions) {
    if (options.argv.length === 0) throw new Error("OMP RPC argv must not be empty");
    this.#options = {
      readyTimeoutMs: options.readyTimeoutMs ?? 30_000,
      commandTimeoutMs: options.commandTimeoutMs ?? 30_000,
      maxStderrBytes: options.maxStderrBytes ?? 32 * 1024,
      ...options,
    };
  }

  get running(): boolean {
    return this.#child !== undefined && this.#ready;
  }

  get protocolVersion(): number {
    return this.#protocolVersion;
  }

  get stderr(): string {
    return this.#stderr;
  }

  onFrame(listener: RpcFrameListener): () => void {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  onExit(listener: RpcExitListener): () => void {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.#child) throw new Error("OMP RPC client is already started");
    this.#stopping = false;
    this.#ready = false;
    this.#protocolVersion = 1;
    this.#stderr = "";

    const [executable, ...args] = this.#options.argv;
    const child = spawn(executable, args, {
      cwd: this.#options.cwd,
      env: this.#options.env,
      stdio: "pipe",
    });
    this.#child = child;

    const ready = Promise.withResolvers<Record<string, unknown>>();
    let readySettled = false;
    const settleReady = (frame: Record<string, unknown>): void => {
      if (readySettled) return;
      readySettled = true;
      ready.resolve(frame);
    };
    const rejectReady = (error: Error): void => {
      if (readySettled) return;
      readySettled = true;
      ready.reject(error);
    };

    child.once("error", (cause) => {
      rejectReady(cause);
      if (!this.#stopping) void this.#handleUnexpectedExit(cause);
    });
    const exited = Promise.withResolvers<void>();
    this.#exited = exited.promise;
    child.once("close", (code, signal) => {
      const error = new Error(`OMP RPC process exited with ${signal ? `signal ${signal}` : `code ${code}`}${this.#stderr ? `: ${this.#stderr}` : ""}`);
      rejectReady(error);
      if (!this.#stopping) void this.#handleUnexpectedExit(error);
      exited.resolve();
    });
    void this.#readStderr(child);
    void this.#readStdout(child, settleReady).catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      rejectReady(error);
      if (!this.#stopping) void this.#handleUnexpectedExit(error);
    });

    const timer = setTimeout(() => {
      rejectReady(new Error(`Timed out waiting for OMP RPC readiness${this.#stderr ? `: ${this.#stderr}` : ""}`));
    }, this.#options.readyTimeoutMs);
    timer.unref?.();

    try {
      const frame = await ready.promise;
      this.#ready = true;
      const versions = Array.isArray(frame.supportedProtocolVersions) ? frame.supportedProtocolVersions : [];
      if (versions.includes(2)) {
        const advertised = frame.maxReassembledFrameBytes;
        if (!Number.isSafeInteger(advertised) || Number(advertised) <= 0) throw new Error("OMP advertised an invalid RPC reassembly limit");
        const response = await this.send({ type: "negotiate_protocol", protocolVersion: 2 });
        if (!response.success || !isRecord(response.data) || response.data.protocolVersion !== 2) {
          throw new Error("OMP RPC protocol-v2 negotiation failed");
        }
        this.#protocolVersion = 2;
      }
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    this.#child = undefined;
    this.#ready = false;
    const error = new Error("OMP RPC client stopped");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();

    child.stdin.end();
    const exited = this.#exited ?? Promise.resolve();
    if (!(await Promise.race([exited.then(() => true), sleep(1_500, false)]))) {
      child.kill("SIGTERM");
      if (!(await Promise.race([exited.then(() => true), sleep(1_500, false)]))) child.kill("SIGKILL");
    }
    await exited;
    this.#exited = undefined;
  }

  send(command: RpcCommandInput, timeoutMs = this.#options.commandTimeoutMs): Promise<RpcResponse> {
    const child = this.#child;
    if (!child) throw new Error("OMP RPC client is not started");
    const id = `tg_${++this.#requestId}`;
    const frame = { ...command, id } as RpcCommand;
    const pending = Promise.withResolvers<RpcResponse>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      pending.reject(new Error(`Timed out waiting for OMP RPC ${command.type}${this.#stderr ? `: ${this.#stderr}` : ""}`));
    }, timeoutMs);
    timer.unref?.();
    this.#pending.set(id, {
      command: command.type,
      timer,
      resolve: pending.resolve,
      reject: pending.reject,
    });
    try {
      this.write(frame);
    } catch (error) {
      clearTimeout(timer);
      this.#pending.delete(id);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return pending.promise;
  }

  write(frame: RpcInboundFrame): void {
    const child = this.#child;
    if (!child) throw new Error("OMP RPC client is not started");
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  async #readStdout(child: ChildProcessWithoutNullStreams, onReady: (frame: Record<string, unknown>) => void): Promise<void> {
    const textDecoder = new TextDecoder();
    const frameDecoder = new RpcFrameDecoder();
    let buffer = "";
    let maxFrameBytes = 1024 * 1024;
    for await (const chunk of child.stdout) {
      buffer += textDecoder.decode(chunk, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (Buffer.byteLength(line) > maxFrameBytes) throw new Error("OMP RPC physical frame exceeded the advertised limit");
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) throw new Error("OMP RPC frame is not an object");
        if (isRpcReady(parsed)) {
          if (typeof parsed.maxFrameBytes === "number" && Number.isSafeInteger(parsed.maxFrameBytes) && parsed.maxFrameBytes > 0) {
            maxFrameBytes = parsed.maxFrameBytes;
          }
          if (
            typeof parsed.maxReassembledFrameBytes === "number" &&
            Number.isSafeInteger(parsed.maxReassembledFrameBytes) &&
            parsed.maxReassembledFrameBytes > 0
          ) {
            frameDecoder.setMaxBytes(parsed.maxReassembledFrameBytes);
          }
          onReady(parsed);
          continue;
        }
        if (parsed.type === "rpc_chunk" && this.#protocolVersion !== 2) {
          throw new Error("OMP sent an RPC chunk before protocol-v2 negotiation");
        }
        const decoded = frameDecoder.push(parsed);
        if (decoded === undefined) continue;
        if (!isRecord(decoded)) throw new Error("Decoded OMP RPC frame is not an object");
        this.#handleFrame(decoded);
      }
      if (Buffer.byteLength(buffer) > maxFrameBytes) throw new Error("OMP RPC unterminated frame exceeded the advertised limit");
    }
    buffer += textDecoder.decode();
    if (buffer.trim().length > 0) throw new Error("OMP RPC stdout ended with an incomplete frame");
  }

  async #readStderr(child: ChildProcessWithoutNullStreams): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      this.#stderr += decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(this.#stderr) > this.#options.maxStderrBytes) {
        this.#stderr = this.#stderr.slice(-this.#options.maxStderrBytes);
      }
    }
    this.#stderr += decoder.decode();
  }

  #handleFrame(frame: Record<string, unknown>): void {
    if (isRpcResponse(frame) && frame.id) {
      const pending = this.#pending.get(frame.id);
      if (pending) {
        this.#pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.success) pending.resolve(frame);
        else pending.reject(new RpcCommandError(frame.error ?? `${pending.command} failed`, frame.command, frame.code));
        return;
      }
    }
    const delivery = this.#eventQueue.then(async () => {
      for (const listener of this.#frameListeners) await listener(frame);
    });
    this.#eventQueue = delivery.catch(() => {});
  }

  async #handleUnexpectedExit(error: Error): Promise<void> {
    const child = this.#child;
    if (this.#stopping || !child) return;
    this.#child = undefined;
    this.#ready = false;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();

    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGTERM");
      const exited = this.#exited ?? Promise.resolve();
      if (!(await Promise.race([exited.then(() => true), sleep(1_500, false)]))) child.kill("SIGKILL");
      await exited;
    }
    for (const listener of this.#exitListeners) await listener(error);
  }
}
