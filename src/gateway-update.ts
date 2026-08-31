import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { GatewayUpdatesConfig } from "./gateway-config";
import type { GatewayDelivery } from "./gateway-tools";
import type { ConversationAddress, Principal } from "./gateway-types";
import { isRecord } from "./type-guards";

const UPDATE_SCHEMA = 1;
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT_ID = /^[0-9a-f]{40,64}$/;
const POLL_INTERVAL_MS = 250;

export interface GatewayUpdateOrigin {
  readonly address: ConversationAddress;
  readonly principal: Principal;
}

export interface GatewayUpdateRelease {
  readonly id: string;
  readonly commit: string;
  readonly version: string;
  readonly path: string;
}

export interface GatewayUpdateStageResult {
  readonly release: GatewayUpdateRelease;
  readonly reused: boolean;
}

export interface GatewayUpdateControl {
  stage(commit: string, signal?: AbortSignal): Promise<GatewayUpdateStageResult>;
  arm(releaseId: string, origin: GatewayUpdateOrigin): Promise<{ update: string }>;
  commitArmed(): Promise<void>;
  discardArmed(): Promise<void>;
}

interface GatewayUpdateRequest {
  readonly schema: 1;
  readonly id: string;
  readonly status: "armed" | "committed" | "notified";
  readonly candidate: GatewayUpdateRelease;
  readonly previous: GatewayUpdateRelease;
  readonly origin: GatewayUpdateOrigin;
  readonly requestedAt: string;
  readonly committedAt?: string;
}

export interface GatewayUpdateResult {
  readonly schema: 1;
  readonly requestId: string;
  readonly status: "succeeded" | "rolled_back";
  readonly releaseId: string;
  readonly previousReleaseId: string;
  readonly detail?: string;
  readonly completedAt: string;
}

export interface GatewayUpdatePaths {
  readonly root: string;
  readonly releases: string;
  readonly current: string;
  readonly request: string;
  readonly result: string;
  readonly ready: string;
}

export type GatewayUpdateCommandRunner = (argv: readonly string[], cwd: string, signal?: AbortSignal) => Promise<string>;

export interface GatewayUpdateCoordinatorOptions {
  readonly config: GatewayUpdatesConfig;
  readonly stateDir: string;
  readonly runCommand?: GatewayUpdateCommandRunner;
  readonly now?: () => Date;
}

export class GatewayUpdateCoordinator implements GatewayUpdateControl {
  readonly #config: GatewayUpdatesConfig;
  readonly #paths: GatewayUpdatePaths;
  readonly #runCommand: GatewayUpdateCommandRunner;
  readonly #now: () => Date;
  #watchAbort: AbortController | undefined;

  constructor(options: GatewayUpdateCoordinatorOptions) {
    if (!options.config.enabled || options.config.repository === undefined) {
      throw new Error("OmpClaw transactional updates are not enabled");
    }
    this.#config = options.config;
    this.#paths = gatewayUpdatePaths(options.stateDir);
    this.#runCommand = options.runCommand ?? runUpdateCommand;
    this.#now = options.now ?? (() => new Date());
    ensureUpdateDirectories(this.#paths);
  }

  get paths(): GatewayUpdatePaths {
    return this.#paths;
  }

  async stage(commit: string, signal?: AbortSignal): Promise<GatewayUpdateStageResult> {
    const repository = this.#config.repository!;
    requireDirectory(repository, "updates.repository");
    const resolvedCommit = (await this.#runCommand(["git", "rev-parse", "--verify", `${commit}^{commit}`], repository, signal)).trim();
    if (!COMMIT_ID.test(resolvedCommit)) throw new Error("git rev-parse did not return a full commit ID");

    const packageText = await this.#runCommand(["git", "show", `${resolvedCommit}:package.json`], repository, signal);
    const packageValue: unknown = JSON.parse(packageText);
    if (!isRecord(packageValue) || typeof packageValue.version !== "string") {
      throw new Error("The update commit package.json has no version");
    }
    const version = requireReleaseComponent(packageValue.version, "package version");
    const id = requireReleaseId(`${version}-${resolvedCommit.slice(0, 12)}`);
    const releasePath = join(this.#paths.releases, id);
    const release = { id, commit: resolvedCommit, version, path: releasePath };
    if (existsSync(releasePath)) {
      const existing = readReleaseManifest(releasePath);
      if (existing.commit !== resolvedCommit) throw new Error(`Release directory ${id} does not match commit ${resolvedCommit}`);
      return { release: existing, reused: true };
    }

    const staging = join(this.#paths.root, `.staging-${randomUUID()}`);
    const source = join(staging, "source");
    const artifact = join(staging, "release");
    const archive = join(staging, "source.tar");
    mkdirSync(source, { recursive: true, mode: 0o700 });
    mkdirSync(artifact, { recursive: true, mode: 0o700 });
    try {
      await this.#runCommand(["git", "archive", "--format=tar", `--output=${archive}`, resolvedCommit], repository, signal);
      await this.#runCommand(["tar", "-xf", archive, "-C", source], repository, signal);
      const bun = Bun.which("bun");
      if (bun === null) throw new Error("bun is required to stage an OmpClaw update");
      await this.#runCommand([bun, "install", "--frozen-lockfile", "--ignore-scripts"], source, signal);
      await this.#runCommand([bun, "run", "check"], source, signal);
      await this.#runCommand([bun, "build", "--compile", "src/rpc-cli.ts", "--outfile", join(artifact, "ompclaw")], source, signal);
      await this.#runCommand([
        bun,
        "build",
        "--compile",
        "src/gateway-update-supervisor.ts",
        "--outfile",
        join(artifact, "ompclaw-supervisor"),
      ], source, signal);
      chmodSync(join(artifact, "ompclaw"), 0o700);
      chmodSync(join(artifact, "ompclaw-supervisor"), 0o700);
      writeJsonAtomic(join(artifact, "manifest.json"), release);
      renameSync(artifact, releasePath);
      return { release, reused: false };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  async arm(releaseId: string, origin: GatewayUpdateOrigin): Promise<{ update: string }> {
    const candidate = readReleaseManifest(join(this.#paths.releases, requireReleaseId(releaseId)));
    const previous = currentGatewayRelease(this.#paths);
    if (candidate.id === previous.id) throw new Error(`Release ${candidate.id} is already active`);
    const existing = readJsonIfPresent(this.#paths.request, parseUpdateRequest);
    if (existing !== undefined && existing.status !== "notified") {
      throw new Error(`Update ${existing.id} is already ${existing.status}`);
    }
    rmSync(this.#paths.result, { force: true });
    const request: GatewayUpdateRequest = {
      schema: UPDATE_SCHEMA,
      id: randomUUID(),
      status: "armed",
      candidate,
      previous,
      origin,
      requestedAt: this.#now().toISOString(),
    };
    writeJsonAtomic(this.#paths.request, request);
    return { update: `armed | ${candidate.id} | request ${request.id}` };
  }

  async commitArmed(): Promise<void> {
    const request = readJsonIfPresent(this.#paths.request, parseUpdateRequest);
    if (request === undefined || request.status !== "armed") return;
    writeJsonAtomic(this.#paths.request, {
      ...request,
      status: "committed",
      committedAt: this.#now().toISOString(),
    } satisfies GatewayUpdateRequest);
  }

  async discardArmed(): Promise<void> {
    const request = readJsonIfPresent(this.#paths.request, parseUpdateRequest);
    if (request?.status === "armed") rmSync(this.#paths.request, { force: true });
  }

  reconcile(delivery: GatewayDelivery): Promise<void> {
    this.#markCandidateReady();
    this.#watchAbort?.abort();
    const controller = new AbortController();
    this.#watchAbort = controller;
    return this.#watchResult(delivery, controller.signal);
  }

  stop(): void {
    this.#watchAbort?.abort();
    this.#watchAbort = undefined;
  }

  bootstrap(release: GatewayUpdateRelease): void {
    requireReleasePath(this.#paths, release.path);
    switchCurrentRelease(this.#paths, release.path);
  }

  #markCandidateReady(): void {
    const requestId = process.env.OMPCLAW_UPDATE_REQUEST_ID;
    const releaseId = process.env.OMPCLAW_RELEASE_ID;
    if (requestId === undefined || releaseId === undefined) return;
    const request = readJsonIfPresent(this.#paths.request, parseUpdateRequest);
    if (request?.status !== "committed" || request.id !== requestId || request.candidate.id !== releaseId) return;
    writeJsonAtomic(join(this.#paths.ready, `${request.id}.json`), {
      schema: UPDATE_SCHEMA,
      requestId: request.id,
      releaseId,
      pid: process.pid,
      readyAt: this.#now().toISOString(),
    });
  }

  async #watchResult(delivery: GatewayDelivery, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const request = readJsonIfPresent(this.#paths.request, parseUpdateRequest);
      const result = readJsonIfPresent(this.#paths.result, parseUpdateResult);
      if (request !== undefined && result?.requestId === request.id && request.status !== "notified") {
        const text = result.status === "succeeded"
          ? `OmpClaw update ${result.releaseId} is active.`
          : `OmpClaw update ${result.releaseId} failed and rolled back to ${result.previousReleaseId}.${result.detail ? ` ${result.detail}` : ""}`;
        try {
          await delivery.send(request.origin.address, { text, format: "markdown" }, {
            principal: request.origin.principal,
            origin: request.origin.address,
          });
          writeJsonAtomic(this.#paths.request, { ...request, status: "notified" } satisfies GatewayUpdateRequest);
          rmSync(this.#paths.result, { force: true });
          rmSync(join(this.#paths.ready, `${request.id}.json`), { force: true });
          return;
        } catch {
          // Delivery is at least once. Keep durable state for the next startup.
        }
      }
      await sleep(POLL_INTERVAL_MS, signal);
    }
  }
}

export function gatewayUpdatePaths(stateDir: string): GatewayUpdatePaths {
  const root = resolve(stateDir, "updates");
  return {
    root,
    releases: join(root, "releases"),
    current: join(root, "current"),
    request: join(root, "request.json"),
    result: join(root, "result.json"),
    ready: join(root, "ready"),
  };
}

export function ensureUpdateDirectories(paths: GatewayUpdatePaths): void {
  mkdirSync(paths.releases, { recursive: true, mode: 0o700 });
  mkdirSync(paths.ready, { recursive: true, mode: 0o700 });
}

export function currentGatewayRelease(paths: GatewayUpdatePaths): GatewayUpdateRelease {
  const target = resolve(dirname(paths.current), readlinkSync(paths.current));
  requireReleasePath(paths, target);
  return readReleaseManifest(realpathSync(target));
}

export function switchCurrentRelease(paths: GatewayUpdatePaths, releasePath: string): void {
  const target = requireReleasePath(paths, releasePath);
  const temporary = join(paths.root, `.current-${randomUUID()}`);
  symlinkSync(relative(paths.root, target), temporary, "dir");
  renameSync(temporary, paths.current);
}

export function readUpdateRequest(path: string): GatewayUpdateRequest | undefined {
  return readJsonIfPresent(path, parseUpdateRequest);
}

export function readUpdateResult(path: string): GatewayUpdateResult | undefined {
  return readJsonIfPresent(path, parseUpdateResult);
}

export function writeUpdateResult(path: string, result: GatewayUpdateResult): void {
  writeJsonAtomic(path, result);
}

export function readReleaseManifest(releasePath: string): GatewayUpdateRelease {
  const value = readJson(join(releasePath, "manifest.json"));
  if (!isRecord(value)) throw new Error("Release manifest must be an object");
  const id = requireReleaseId(value.id);
  const commit = requireCommit(value.commit);
  const version = requireReleaseComponent(value.version, "release version");
  const manifestPath = realpathSync(resolve(requireString(value.path, "release path")));
  const path = realpathSync(resolve(releasePath));
  if (manifestPath !== path) throw new Error(`Release manifest path does not match ${releasePath}`);
  requireExecutable(join(path, "ompclaw"));
  requireExecutable(join(path, "ompclaw-supervisor"));
  return { id, commit, version, path };
}

export async function runUpdateCommand(argv: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
  if (argv.length === 0) throw new Error("Update command must not be empty");
  if (signal?.aborted) throw new Error("OmpClaw update staging was cancelled");
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(argv[0]!, [...argv.slice(1)], {
      cwd,
      env: updateBuildEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const abort = (): void => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      rejectPromise(error);
    });
    child.once("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        rejectPromise(new Error("OmpClaw update staging was cancelled"));
        return;
      }
      const output = Buffer.concat(stdout).toString("utf8");
      if (code === 0) {
        resolvePromise(output);
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim() || output.trim();
      rejectPromise(new Error(`${argv[0]} exited ${code ?? closeSignal ?? "unknown"}${detail ? `: ${detail}` : ""}`));
    });
  });
}

function updateBuildEnvironment(): NodeJS.ProcessEnv {
  const names = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  const env: NodeJS.ProcessEnv = { CI: "1" };
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

function requireDirectory(path: string, label: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

function requireExecutable(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o100) === 0) {
    throw new Error(`${path} must be an executable regular file`);
  }
}

function requireReleasePath(paths: GatewayUpdatePaths, path: string): string {
  const releases = realpathSync(paths.releases);
  const target = realpathSync(resolve(path));
  const relativePath = relative(releases, target);
  if (relativePath.length === 0 || relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    throw new Error(`Release path escapes ${paths.releases}`);
  }
  return target;
}

function requireReleaseId(value: unknown): string {
  const id = requireString(value, "release ID");
  if (!RELEASE_ID.test(id)) throw new Error("Release ID is invalid");
  return id;
}

function requireCommit(value: unknown): string {
  const commit = requireString(value, "commit");
  if (!COMMIT_ID.test(commit)) throw new Error("Commit must be a full hexadecimal object ID");
  return commit;
}

function requireReleaseComponent(value: unknown, label: string): string {
  const component = requireString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(component)) throw new Error(`${label} is invalid`);
  return component;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function readJson(path: string): unknown {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error(`${path} must be a bounded regular file`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonIfPresent<T>(path: string, parse: (value: unknown) => T): T | undefined {
  try {
    return parse(readJson(path));
  } catch (error) {
    if (!existsSync(path)) return undefined;
    throw error;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

function parseUpdateRequest(value: unknown): GatewayUpdateRequest {
  if (!isRecord(value) || value.schema !== UPDATE_SCHEMA) throw new Error("Update request has an unsupported schema");
  if (value.status !== "armed" && value.status !== "committed" && value.status !== "notified") {
    throw new Error("Update request status is invalid");
  }
  if (!isRecord(value.origin) || !isRecord(value.origin.address) || !isRecord(value.origin.principal)) {
    throw new Error("Update request origin is invalid");
  }
  const address: ConversationAddress = {
    transport: requireString(value.origin.address.transport, "origin transport"),
    account: requireString(value.origin.address.account, "origin account"),
    channel: requireString(value.origin.address.channel, "origin channel"),
    ...(value.origin.address.thread === undefined ? {} : { thread: requireString(value.origin.address.thread, "origin thread") }),
  };
  if (!Array.isArray(value.origin.principal.roles) || !value.origin.principal.roles.every((role) => typeof role === "string")) {
    throw new Error("Update request principal roles are invalid");
  }
  return {
    schema: UPDATE_SCHEMA,
    id: requireString(value.id, "update request ID"),
    status: value.status,
    candidate: parseRelease(value.candidate),
    previous: parseRelease(value.previous),
    origin: {
      address,
      principal: { id: requireString(value.origin.principal.id, "principal ID"), roles: [...value.origin.principal.roles] },
    },
    requestedAt: requireString(value.requestedAt, "requestedAt"),
    ...(value.committedAt === undefined ? {} : { committedAt: requireString(value.committedAt, "committedAt") }),
  };
}

function parseUpdateResult(value: unknown): GatewayUpdateResult {
  if (!isRecord(value) || value.schema !== UPDATE_SCHEMA) throw new Error("Update result has an unsupported schema");
  if (value.status !== "succeeded" && value.status !== "rolled_back") throw new Error("Update result status is invalid");
  return {
    schema: UPDATE_SCHEMA,
    requestId: requireString(value.requestId, "result request ID"),
    status: value.status,
    releaseId: requireReleaseId(value.releaseId),
    previousReleaseId: requireReleaseId(value.previousReleaseId),
    ...(value.detail === undefined ? {} : { detail: requireString(value.detail, "result detail") }),
    completedAt: requireString(value.completedAt, "result completedAt"),
  };
}

function parseRelease(value: unknown): GatewayUpdateRelease {
  if (!isRecord(value)) throw new Error("Update release must be an object");
  return {
    id: requireReleaseId(value.id),
    commit: requireCommit(value.commit),
    version: requireReleaseComponent(value.version, "release version"),
    path: resolve(requireString(value.path, "release path")),
  };
}

async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolvePromise();
    }, { once: true });
  });
}
