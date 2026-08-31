#!/usr/bin/env bun
import { existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  currentGatewayRelease,
  gatewayUpdatePaths,
  readReleaseManifest,
  readUpdateRequest,
  readUpdateResult,
  switchCurrentRelease,
  writeUpdateResult,
  type GatewayUpdateRelease,
  type GatewayUpdateResult,
} from "./gateway-update";

export interface SupervisorArgs {
  readonly stateDir: string;
  readonly configPath: string;
  readonly envFile: string;
  readonly healthTimeoutMs: number;
}
export interface ManagedGatewayProcess {
  exitCode: number | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
}

export interface GatewayUpdateSupervisorSeams {
  readonly onResult?: (result: GatewayUpdateResult) => void;
  readonly spawnRelease?: (release: GatewayUpdateRelease, requestId?: string) => ManagedGatewayProcess;
}

const POLL_INTERVAL_MS = 250;
const STOP_TIMEOUT_MS = 15_000;
const RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export class GatewayUpdateSupervisor {
  readonly #args: SupervisorArgs;
  readonly #paths;
  readonly #seams: GatewayUpdateSupervisorSeams;
  #child: ManagedGatewayProcess | undefined;
  #stopping = false;
  #restartAttempt = 0;
  readonly #stopRequested = Promise.withResolvers<void>();
  #replacementRequested = false;

  constructor(args: SupervisorArgs, seams: GatewayUpdateSupervisorSeams = {}) {
    this.#args = args;
    this.#seams = seams;
    this.#paths = gatewayUpdatePaths(args.stateDir);
  }

  get replacementRequested(): boolean {
    return this.#replacementRequested;
  }

  stop(): void {
    this.#stopping = true;
    this.#stopRequested.resolve();
  }

  async run(): Promise<void> {
    const stop = (): void => this.stop();
    const signals = process as unknown as {
      once(event: "SIGINT" | "SIGTERM", listener: () => void): void;
      off(event: "SIGINT" | "SIGTERM", listener: () => void): void;
    };
    signals.once("SIGINT", stop);
    signals.once("SIGTERM", stop);

    let active = currentGatewayRelease(this.#paths);
    this.#child = this.#spawnRelease(active);
    try {
      while (!this.#stopping) {
        const request = readUpdateRequest(this.#paths.request);
        const result = readUpdateResult(this.#paths.result);
        if (request?.status === "committed" && result?.requestId !== request.id) {
          active = await this.#applyUpdate(active, request.id, request.candidate.id, request.previous.id);
          continue;
        }
        if (this.#child.exitCode !== null) {
          const delay = RESTART_DELAYS_MS[Math.min(this.#restartAttempt++, RESTART_DELAYS_MS.length - 1)]!;
          await this.#wait(delay);
          if (!this.#stopping) {
            active = currentGatewayRelease(this.#paths);
            this.#child = this.#spawnRelease(active);
          }
          continue;
        }
        this.#restartAttempt = 0;
        await this.#wait(POLL_INTERVAL_MS);
      }
    } finally {
      signals.off("SIGINT", stop);
      signals.off("SIGTERM", stop);
      await this.#stopChild();
    }
  }

  #spawnRelease(release: GatewayUpdateRelease, requestId?: string): ManagedGatewayProcess {
    if (this.#seams.spawnRelease !== undefined) return this.#seams.spawnRelease(release, requestId);
    const executable = join(release.path, "ompclaw");
    return spawn(executable, ["run", "--config", this.#args.configPath, "--env-file", this.#args.envFile], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OMPCLAW_RELEASE_ID: release.id,
        ...(requestId === undefined ? {} : { OMPCLAW_UPDATE_REQUEST_ID: requestId }),
      },
      stdio: "inherit",
    });
  }

  async #applyUpdate(
    active: GatewayUpdateRelease,
    requestId: string,
    candidateId: string,
    previousId: string,
  ): Promise<GatewayUpdateRelease> {
    const candidate = readReleaseManifest(join(this.#paths.releases, candidateId));
    const previous = readReleaseManifest(join(this.#paths.releases, previousId));
    if (previous.id !== active.id && candidate.id !== active.id) {
      this.#recordRollback(requestId, candidate, previous, `Active release ${active.id} did not match update base ${previous.id}.`);
      return active;
    }

    rmSync(join(this.#paths.ready, `${requestId}.json`), { force: true });
    await this.#stopChild();
    if (this.#stopping) return active;
    this.#child = this.#spawnRelease(candidate, requestId);

    const ready = await this.#waitForCandidate(requestId);
    if (ready) {
      switchCurrentRelease(this.#paths, candidate.path);
      const result: GatewayUpdateResult = {
        schema: 1,
        requestId,
        status: "succeeded",
        releaseId: candidate.id,
        previousReleaseId: previous.id,
        completedAt: new Date().toISOString(),
      };
      writeUpdateResult(this.#paths.result, result);
      this.#seams.onResult?.(result);
      this.#replacementRequested = true;
      this.stop();
      this.#restartAttempt = 0;
      return candidate;
    }

    await this.#stopChild();
    switchCurrentRelease(this.#paths, previous.path);
    this.#recordRollback(requestId, candidate, previous, `Candidate did not become ready within ${this.#args.healthTimeoutMs} ms.`);
    if (!this.#stopping) this.#child = this.#spawnRelease(previous);
    this.#restartAttempt = 0;
    return previous;
  }

  async #waitForCandidate(requestId: string): Promise<boolean> {
    const readyPath = join(this.#paths.ready, `${requestId}.json`);
    const deadline = Date.now() + this.#args.healthTimeoutMs;
    while (!this.#stopping && Date.now() < deadline) {
      if (existsSync(readyPath)) return this.#child?.exitCode === null;
      if (this.#child?.exitCode !== null) return false;
      await this.#wait(POLL_INTERVAL_MS);
    }
    return false;
  }

  async #wait(milliseconds: number): Promise<void> {
    if (this.#stopping) return;
    await Promise.race([sleep(milliseconds), this.#stopRequested.promise]);
  }

  #recordRollback(
    requestId: string,
    candidate: GatewayUpdateRelease,
    previous: GatewayUpdateRelease,
    detail: string,
  ): void {
    const result: GatewayUpdateResult = {
      schema: 1,
      requestId,
      status: "rolled_back",
      releaseId: candidate.id,
      previousReleaseId: previous.id,
      detail,
      completedAt: new Date().toISOString(),
    };
    writeUpdateResult(this.#paths.result, result);
    this.#seams.onResult?.(result);
  }

  async #stopChild(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (child === undefined || child.exitCode !== null) return;
    child.kill("SIGTERM");
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (child.exitCode === null && Date.now() < deadline) await sleep(100);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }
}

export function parseSupervisorArgs(argv: readonly string[]): SupervisorArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--")) {
      throw new Error("Expected --state-dir, --config, --env-file, and --health-timeout-ms values");
    }
    if (values.has(name)) throw new Error(`${name} may be supplied only once`);
    values.set(name, value);
  }
  const stateDir = requiredArgument(values, "--state-dir");
  const configPath = requiredArgument(values, "--config");
  const envFile = requiredArgument(values, "--env-file");
  const timeoutText = requiredArgument(values, "--health-timeout-ms");
  if (!["--state-dir", "--config", "--env-file", "--health-timeout-ms"].every((name) => values.has(name)) || values.size !== 4) {
    throw new Error("Unknown supervisor argument");
  }
  const healthTimeoutMs = Number(timeoutText);
  if (!Number.isSafeInteger(healthTimeoutMs) || healthTimeoutMs < 5_000 || healthTimeoutMs > 300_000) {
    throw new Error("--health-timeout-ms must be an integer between 5000 and 300000");
  }
  return { stateDir, configPath, envFile, healthTimeoutMs };
}

function requiredArgument(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.length === 0 || value.includes("\0")) throw new Error(`${name} requires a value`);
  return value;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

if (import.meta.main) {
  const supervisor = new GatewayUpdateSupervisor(parseSupervisorArgs(process.argv.slice(2)));
  supervisor.run().then(() => {
    if (supervisor.replacementRequested) process.exitCode = 75;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
