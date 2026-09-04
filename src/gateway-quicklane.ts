import { gatewayRpcRuntimeConfig, stripGatewaySecretsFromChildEnv, type GatewayConfig } from "./gateway-config";
import type { ConversationAddress, InboundMessage } from "./gateway-types";
import type { GatewayDelivery } from "./gateway-tools";
import { OmpRpcClient, type OmpRpcClientOptions, type RpcClient } from "./rpc-client";
import { buildOmpChildEnv, buildOmpRpcArgv, type RpcRuntimeConfig } from "./rpc-config";
import { formatPromptInput } from "./rpc-prompt";
import { finalAssistantText, isRpcExtensionUiRequest, type RpcRecord, type RpcResponse } from "./rpc-protocol";
import { isRecord } from "./type-guards";

const QUICK_ASK_STATUS_KEY = "quick-ask";
const QUICK_ASK_ARMED_TEXT = "⚡ Quick ask armed — send your question";
const QUICK_COMMAND = /^\/quick(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i;
const QUICK_ARM_COMMAND = /^\/quick-arm$/i;
const QUICK_LANE_PROMPT = [
  "This is OmpClaw's isolated quick-answer lane, separate from the user's main task.",
  "Answer only the current question concisely. Do not discuss, steer, stop, or modify the main turn.",
  "Do not open an interactive prompt; cancel any interaction that cannot be answered directly.",
].join("\n");

export interface GatewayQuickLaneLogger {
  warn(message: string): void;
}

export interface GatewayQuickLaneOptions {
  readonly config: GatewayConfig;
  readonly delivery: GatewayDelivery;
  readonly readyTimeoutMs?: number;
  readonly createRpcClient?: (options: OmpRpcClientOptions) => RpcClient;
}

export type GatewayQuickLaneRoute =
  | { readonly kind: "arm" }
  | { readonly kind: "disabled" }
  | { readonly kind: "query"; readonly prompt: string; readonly consumesArm: boolean }
  | { readonly kind: "usage" };

export interface GatewayQuickLaneHandleResult {
  readonly armChanged: boolean;
  readonly armed: boolean;
}

interface ActiveQuickTurn {
  readonly message: InboundMessage;
  readonly completion: PromiseWithResolvers<void>;
  commandOutput?: string;
}

export class QuickLaneStoppedError extends Error {
  readonly name = "QuickLaneStoppedError";

  constructor() {
    super("Quick OMP session stopped");
  }
}

/**
 * A deliberately small, transport-neutral second OMP child. It owns no gateway
 * state: interruption during gateway shutdown drops the active quick request.
 */
export class GatewayQuickLane {
  readonly #options: GatewayQuickLaneOptions;
  readonly #log: GatewayQuickLaneLogger;

  isArmed(address: ConversationAddress): boolean {
    return this.#armedAddresses.has(addressKey(address));
  }
  readonly #armedAddresses = new Set<string>();
  #rpc: RpcClient | undefined;
  #sessionFile: string | undefined;
  #starting: Promise<void> | undefined;
  #queue: Promise<void> = Promise.resolve();
  #active: ActiveQuickTurn | undefined;
  #stopping = false;

  constructor(options: GatewayQuickLaneOptions, logger: GatewayQuickLaneLogger = console) {
    this.#options = options;
    this.#log = logger;
  }

  routeFor(message: InboundMessage): GatewayQuickLaneRoute | undefined {
    const text = message.content.text?.trim();
    if (!text) return undefined;
    if (QUICK_ARM_COMMAND.test(text))
      return this.#options.config.quickLane.enabled ? { kind: "arm" } : { kind: "disabled" };

    const explicit = text.match(QUICK_COMMAND);
    if (explicit) {
      if (!this.#options.config.quickLane.enabled) return { kind: "disabled" };
      const prompt = explicit[1]?.trim();
      if (!prompt) return { kind: "usage" };
      return { kind: "query", prompt, consumesArm: this.#isArmed(message) };
    }

    if (!this.#options.config.quickLane.enabled || text.startsWith("/") || !this.#isArmed(message)) return undefined;
    return { kind: "query", prompt: text, consumesArm: true };
  }

  async handle(message: InboundMessage, route: GatewayQuickLaneRoute): Promise<GatewayQuickLaneHandleResult> {
    switch (route.kind) {
      case "disabled":
        await this.#send(message, "⚡ Quick ask is disabled.");
        return { armChanged: false, armed: false };
      case "usage":
        await this.#send(message, "⚡ Usage: /quick <question>");
        return { armChanged: false, armed: this.#isArmed(message) };
      case "arm": {
        const armed = !this.#isArmed(message);
        await this.#setArmed(message, armed);
        return { armChanged: true, armed };
      }
      case "query":
        if (route.consumesArm) await this.#setArmed(message, false);
        await this.#enqueue({ ...message, content: { ...message.content, text: route.prompt } });
        return { armChanged: route.consumesArm, armed: false };
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#armedAddresses.clear();
    this.#active?.completion.reject(new QuickLaneStoppedError());
    const starting = this.#starting;
    if (starting !== undefined) await starting.catch(() => undefined);
    const rpc = this.#rpc;
    this.#rpc = undefined;
    await rpc?.stop();
    await this.#queue;
    this.#stopping = false;
  }

  async #enqueue(message: InboundMessage): Promise<void> {
    const work = this.#queue.then(() => this.#run(message));
    this.#queue = work.catch(() => undefined);
    await work;
  }

  async #run(message: InboundMessage): Promise<void> {
    if (this.#stopping) throw new QuickLaneStoppedError();
    await this.#start();
    const rpc = this.#rpc;
    if (!rpc?.running) throw new Error("Quick OMP session is not running");

    const completion = Promise.withResolvers<void>();
    const active: ActiveQuickTurn = { message, completion };
    this.#active = active;
    try {
      const input = await formatPromptInput(message, (warning) => this.#log.warn(warning));
      const response = await rpc.send({
        type: "prompt",
        message: [QUICK_LANE_PROMPT, input.prompt].join("\n\n"),
        ...(input.images.length === 0 ? {} : { images: input.images }),
      });
      if (agentNotInvoked(response)) await this.#complete(active, active.commandOutput ?? "");
      await completion.promise;
    } catch (error) {
      if (this.#active === active) this.#active = undefined;
      throw error;
    }
  }

  async #start(): Promise<void> {
    if (this.#rpc?.running) return;
    if (this.#starting !== undefined) return this.#starting;
    const start = this.#startRpc();
    this.#starting = start;
    try {
      await start;
    } finally {
      if (this.#starting === start) this.#starting = undefined;
    }
  }

  async #startRpc(): Promise<void> {
    const config = quickRuntimeConfig(this.#options.config);
    const clientOptions: OmpRpcClientOptions = {
      argv: buildOmpRpcArgv(config, this.#sessionFile),
      cwd: config.cwd,
      env: stripGatewaySecretsFromChildEnv(buildOmpChildEnv(process.env, config)),
      ...(this.#options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: this.#options.readyTimeoutMs }),
    };
    const rpc = this.#options.createRpcClient?.(clientOptions) ?? new OmpRpcClient(clientOptions);
    rpc.onFrame((frame) => this.#handleFrame(frame));
    rpc.onExit((error) => this.#handleExit(error));
    this.#rpc = rpc;
    try {
      await rpc.start();
      await rpc.send({ type: "set_host_tools", tools: [] });
      this.#recordSessionFile(await rpc.send({ type: "get_state" }));
    } catch (error) {
      if (this.#rpc === rpc) this.#rpc = undefined;
      await rpc.stop().catch(() => undefined);
      throw error;
    }
  }

  async #handleFrame(frame: RpcRecord): Promise<void> {
    if (isRpcExtensionUiRequest(frame)) {
      if (
        frame.method === "confirm" ||
        frame.method === "select" ||
        frame.method === "input" ||
        frame.method === "editor"
      ) {
        this.#rpc?.write({ type: "extension_ui_response", id: frame.id, cancelled: true });
      }
      return;
    }
    const active = this.#active;
    if (active === undefined) return;
    if (frame.type === "command_output" && typeof frame.text === "string") {
      active.commandOutput = frame.text;
      return;
    }
    if (frame.type === "agent_end" && frame.isTerminal !== false) {
      await this.#complete(active, finalAssistantText(frame.messages));
      return;
    }
    if (frame.type === "prompt_result" && frame.agentInvoked === false) {
      await this.#complete(active, active.commandOutput ?? "");
    }
  }

  async #complete(active: ActiveQuickTurn, text: string): Promise<void> {
    if (this.#active !== active) return;
    this.#active = undefined;
    try {
      await this.#send(active.message, `⚡ ${text.trim() || "I couldn't produce a quick answer."}`);
      active.completion.resolve();
    } catch (error) {
      active.completion.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #handleExit(error: Error): void {
    this.#rpc = undefined;
    const active = this.#active;
    this.#active = undefined;
    active?.completion.reject(error);
  }

  #recordSessionFile(response: RpcResponse): void {
    if (!isRecord(response.data) || typeof response.data.sessionFile !== "string" || response.data.sessionFile.length === 0) return;
    this.#sessionFile = response.data.sessionFile;
  }

  async #setArmed(message: InboundMessage, armed: boolean): Promise<void> {
    const key = addressKey(message.address);
    if (armed) this.#armedAddresses.add(key);
    else this.#armedAddresses.delete(key);
    await this.#options.delivery.presentUi(
      message.address,
      { type: "status", key: QUICK_ASK_STATUS_KEY, ...(armed ? { text: QUICK_ASK_ARMED_TEXT } : {}) },
      { principal: message.principal, origin: message.address },
    );
  }

  #isArmed(message: InboundMessage): boolean {
    return this.isArmed(message.address);
  }

  async #send(message: InboundMessage, text: string): Promise<void> {
    await this.#options.delivery.send(
      message.address,
      { text, format: "markdown" },
      { principal: message.principal, origin: message.address },
    );
  }
}

function quickRuntimeConfig(config: GatewayConfig): RpcRuntimeConfig {
  const runtime = gatewayRpcRuntimeConfig(config);
  const suffix = ".quick";
  return { ...runtime, profile: `${runtime.profile.slice(0, Math.max(1, 128 - suffix.length))}${suffix}` };
}

function addressKey(address: ConversationAddress): string {
  const { transport, account, channel, thread } = address;
  return `${transport}\u0000${account}\u0000${channel}\u0000${thread ?? ""}`;
}

function agentNotInvoked(response: RpcResponse): boolean {
  return isRecord(response.data) && response.data.agentInvoked === false;
}
