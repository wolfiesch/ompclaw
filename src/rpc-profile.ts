import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { RpcRuntimeConfig } from "./rpc-config";
import type { GatewayConfig } from "./gateway-config";

const SNAPSHOT_DIRECTORIES = ["skills", "rules", "commands", "agents", "docs", "bin"] as const;
const COPIED_FILES = ["AGENTS.md", "RULES.md", "SYSTEM.md", "WATCHDOG.md", "APPEND_SYSTEM.md", "config.yml", "mcp.json", "models.yml", "ssh.json"] as const;
const SNAPSHOT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".venv",
  ".venv_old",
  ".cache",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
  "node_modules",
  "logs",
  "browser_profile",
  "browser_profile_old",
  "browser-profile",
  "chrome_profile",
  "chrome-profile",
]);

/** Materialize OMP's experimental memory and auto-learn settings in gateway-owned state. */
export function prepareLearningOverlay(config: Pick<GatewayConfig, "stateDir" | "learning">): string | undefined {
  if (!config.learning.enabled) return undefined;
  const memoryDirectory = join(config.stateDir, "memory");
  mkdirSync(memoryDirectory, { recursive: true, mode: 0o700 });
  const path = join(config.stateDir, "omp-learning.json");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const content = {
    memory: { backend: "mnemopi" },
    mnemopi: {
      dbPath: join(memoryDirectory, "mnemopi.sqlite"),
      bank: "gateway",
      scoping: "global",
      autoRecall: true,
      autoRetain: true,
    },
    autolearn: {
      enabled: true,
      autoContinue: config.learning.autoCapture,
      minToolCalls: config.learning.minToolCalls,
    },
    providers: { memoryModel: config.learning.memoryModel },
  };
  writeFileSync(temporary, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return path;
}

/**
 * Seed a named transport profile with a read-only snapshot of the default
 * profile's harness surface. The gateway's writable managed skills, memories,
 * configuration, databases, sessions, blobs, credentials, and environment
 * remain in its named profile and never flow back into the default profile.
 */
export function prepareInheritedHarness(config: RpcRuntimeConfig): string | undefined {
  if (!config.inheritHarness) return undefined;
  if (!/^[A-Za-z0-9._-]+$/.test(config.profile)) throw new Error("Profile name contains unsupported characters");
  const root = process.env.OMP_HOME ?? join(homedir(), ".omp");
  const source = join(root, "agent");
  const target = join(root, "profiles", config.profile, "agent");
  if (!existsSync(source)) throw new Error(`Default OMP agent directory not found: ${source}`);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const snapshotRoot = join(target, ".gateway-inherited");
  mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });

  for (const name of SNAPSHOT_DIRECTORIES) {
    const from = join(source, name);
    const to = join(target, name);
    if (!existsSync(from)) continue;
    snapshotDirectory(from, to, snapshotRoot, name);
  }
  for (const name of COPIED_FILES) {
    const from = join(source, name);
    const to = join(target, name);
    if (!existsSync(from)) continue;
    snapshotFile(from, to);
  }
  return target;
}

function snapshotFile(from: string, to: string): void {
  const temporary = `${to}.gateway-next-${process.pid}-${randomUUID()}`;
  try {
    copyFileSync(from, temporary);
    if (process.platform !== "win32") chmodSync(temporary, 0o444);
    renameSync(temporary, to);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function snapshotDirectory(from: string, to: string, snapshotRoot: string, name: string): void {
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(to);
  } catch {
    existing = undefined;
  }

  let previousSnapshot: string | undefined;
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) return;
    const destination = resolve(dirname(to), readlinkSync(to));
    const ownedPrefix = `${resolve(snapshotRoot, name)}-`;
    if (destination !== resolve(from) && !destination.startsWith(ownedPrefix)) return;
    if (destination.startsWith(ownedPrefix)) previousSnapshot = destination;
  }

  const snapshot = join(snapshotRoot, `${name}-${randomUUID()}`);
  const nextLink = `${to}.gateway-next-${process.pid}-${randomUUID()}`;
  try {
    copySnapshotTree(from, snapshot);
    makeTreeReadOnly(snapshot);
    symlinkSync(relative(dirname(to), snapshot), nextLink, "dir");
    renameSync(nextLink, to);
  } catch (error) {
    rmSync(nextLink, { force: true });
    makeTreeRemovable(snapshot);
    rmSync(snapshot, { force: true, recursive: true });
    throw error;
  }
  if (previousSnapshot !== undefined) {
    makeTreeRemovable(previousSnapshot);
    rmSync(previousSnapshot, { force: true, recursive: true });
  }
}

function copySnapshotTree(source: string, destination: string, ancestors: ReadonlySet<string> = new Set()): void {
  const name = basename(source);
  if (name === ".DS_Store" || name.startsWith(".env") || name.startsWith(".chrome")) return;

  let resolved: string;
  let info: ReturnType<typeof lstatSync>;
  try {
    resolved = realpathSync(source);
    info = lstatSync(resolved);
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }

  if (info.isDirectory()) {
    if (isIgnoredSnapshotDirectory(name) || ancestors.has(resolved)) return;
    mkdirSync(destination, { mode: 0o700 });
    const nestedAncestors = new Set(ancestors);
    nestedAncestors.add(resolved);
    let entries: string[];
    try {
      entries = readdirSync(source);
    } catch (error) {
      if (isMissingPath(error)) return;
      throw error;
    }
    for (const entry of entries) copySnapshotTree(join(source, entry), join(destination, entry), nestedAncestors);
    return;
  }
  if (!info.isFile()) return;
  try {
    copyFileSync(source, destination);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
}

function isIgnoredSnapshotDirectory(name: string): boolean {
  return SNAPSHOT_IGNORED_DIRECTORIES.has(name)
    || name.startsWith("browser_profile")
    || name.startsWith("browser-profile")
    || name.startsWith("chrome_profile")
    || name.startsWith("chrome-profile");
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function makeTreeReadOnly(path: string): void {
  const info = lstatSync(path);
  if (info.isDirectory()) {
    for (const entry of readdirSync(path)) makeTreeReadOnly(join(path, entry));
    if (process.platform !== "win32") chmodSync(path, 0o555);
    return;
  }
  if (process.platform !== "win32") chmodSync(path, (info.mode & 0o111) === 0 ? 0o444 : 0o555);
}

function makeTreeRemovable(path: string): void {
  if (!existsSync(path) || process.platform === "win32") return;
  const info = lstatSync(path);
  if (!info.isDirectory()) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) makeTreeRemovable(join(path, entry));
}
