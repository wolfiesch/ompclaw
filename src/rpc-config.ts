import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { defaultAccess, ensureStateDir, loadAccess, saveAccess, statePath, type Access } from "./access";
import { isRecord } from "./type-guards";

export type RpcCliCommand = "run" | "doctor" | "pair" | "allow" | "remove" | "service-install" | "service-uninstall" | "help";

export interface RpcRuntimeConfig {
  command: RpcCliCommand;
  commandArg?: string;
  cwd: string;
  stateDir: string;
  profile: string;
  ompCommand: string;
  model?: string;
  resume?: string;
  sessionDir?: string;
  configFiles: string[];
  ompArgs: string[];
  envFile?: string;
  authBrokerTokenFile?: string;
  allowRpcBash: boolean;
  inheritHarness: boolean;
  autoRestart: boolean;
}

export interface PersistedRpcState {
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  lastUpdateId?: number;
  updatedAt: number;
}

const KNOWN_COMMANDS: Record<RpcCliCommand, true> = {
  run: true,
  doctor: true,
  pair: true,
  allow: true,
  remove: true,
  "service-install": true,
  "service-uninstall": true,
  help: true,
};

function expandPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}
export function assertRpcAccess(access: Pick<Access, "allowFrom" | "groups">): void {
  if (access.allowFrom.length > 1) throw new Error("RPC mode supports at most one paired Telegram operator");
  if (Object.keys(access.groups).length > 0) throw new Error("RPC mode supports private chats only; remove group policies from this state directory");
}


/** Parse the small public CLI surface without a runtime dependency. */
export function parseRpcCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RpcRuntimeConfig {
  const args = [...argv];
  let command: RpcCliCommand = "run";
  let commandArg: string | undefined;
  if (args[0] && KNOWN_COMMANDS[args[0] as RpcCliCommand]) {
    command = args.shift() as RpcCliCommand;
    if (["pair", "allow", "remove"].includes(command) && args[0] && !args[0].startsWith("--")) commandArg = args.shift();
  }

  let cwd = env.OMP_TELEGRAM_RPC_CWD ?? process.cwd();
  let stateDir = env.OMP_TELEGRAM_RPC_STATE_DIR ?? join(homedir(), ".omp", "agent", "telegram-rpc");
  let profile = env.OMP_TELEGRAM_RPC_PROFILE ?? "telegram";
  let ompCommand = env.OMP_TELEGRAM_RPC_OMP ?? "omp";
  let model = env.OMP_TELEGRAM_RPC_MODEL;
  let resume = env.OMP_TELEGRAM_RPC_RESUME;
  let sessionDir = env.OMP_TELEGRAM_RPC_SESSION_DIR;
  let envFile = env.OMP_TELEGRAM_RPC_ENV_FILE;
  let authBrokerTokenFile = env.OMP_TELEGRAM_RPC_AUTH_BROKER_TOKEN_FILE;
  let allowRpcBash = env.OMP_TELEGRAM_RPC_ALLOW_BASH === "1";
  let inheritHarness = env.OMP_TELEGRAM_RPC_INHERIT_HARNESS === "1";
  let autoRestart = env.OMP_TELEGRAM_RPC_AUTO_RESTART !== "0";
  const configFiles: string[] = [];
  const ompArgs: string[] = [];

  const valueAfter = (flag: string): string => {
    const value = args.shift();
    if (!value) throw new Error(`${flag} requires a value`);
    return value;
  };

  while (args.length > 0) {
    const flag = args.shift()!;
    if (flag === "--cwd") cwd = valueAfter(flag);
    else if (flag === "--state-dir") stateDir = valueAfter(flag);
    else if (flag === "--profile") profile = valueAfter(flag);
    else if (flag === "--omp") ompCommand = valueAfter(flag);
    else if (flag === "--model") model = valueAfter(flag);
    else if (flag === "--resume") resume = valueAfter(flag);
    else if (flag === "--session-dir") sessionDir = valueAfter(flag);
    else if (flag === "--config") configFiles.push(valueAfter(flag));
    else if (flag === "--omp-arg") ompArgs.push(valueAfter(flag));
    else if (flag === "--env-file") envFile = valueAfter(flag);
    else if (flag === "--auth-broker-token-file") authBrokerTokenFile = valueAfter(flag);
    else if (flag === "--inherit-harness") inheritHarness = true;
    else if (flag === "--allow-rpc-bash") allowRpcBash = true;
    else if (flag === "--no-auto-restart") autoRestart = false;
    else if (flag === "--help" || flag === "-h") command = "help";
    else throw new Error(`Unknown option: ${flag}`);
  }

  return {
    command,
    commandArg,
    cwd: expandPath(cwd),
    stateDir: expandPath(stateDir),
    profile,
    ompCommand: ompCommand.includes("/") ? expandPath(ompCommand) : ompCommand,
    model,
    resume: resume ? expandPath(resume) : undefined,
    sessionDir: sessionDir ? expandPath(sessionDir) : undefined,
    configFiles: configFiles.map(expandPath),
    ompArgs,
    envFile: envFile ? expandPath(envFile) : undefined,
    authBrokerTokenFile: authBrokerTokenFile ? expandPath(authBrokerTokenFile) : undefined,
    inheritHarness,
    allowRpcBash,
    autoRestart,
  };
}

export function buildOmpRpcArgv(config: RpcRuntimeConfig, resume = config.resume): string[] {
  const argv = [config.ompCommand, "--mode", "rpc-ui", "--cwd", config.cwd, "--profile", config.profile, "--no-title"];
  if (resume) argv.push("--resume", resume);
  if (config.model) argv.push("--model", config.model);
  if (config.sessionDir) argv.push("--session-dir", config.sessionDir);
  for (const file of config.configFiles) argv.push("--config", file);
  argv.push(...config.ompArgs);
  return argv;
}

function readPrivateFile(path: string, label: string): string {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file, not a symlink`);
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid != null && info.uid !== uid) throw new Error(`${label} must be owned by the current user`);
    if ((info.mode & 0o077) !== 0) throw new Error(`${label} permissions must be 0600 or stricter`);
  }
  return readFileSync(path, "utf8");
}

/** OMP gets the normal harness environment, never Telegram transport secrets. */
export function buildOmpChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  config?: Pick<RpcRuntimeConfig, "authBrokerTokenFile">,
): Record<string, string | undefined> {
  const childEnv: Record<string, string | undefined> = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("OMP_TELEGRAM_")) delete childEnv[key];
  }
  delete childEnv.TELEGRAM_BOT_TOKEN;
  delete childEnv.TELEGRAM_ALLOWED_USERS;
  childEnv.OMP_TELEGRAM_RPC_CHILD = "1";
  if (config?.authBrokerTokenFile) {
    childEnv.OMP_AUTH_BROKER_TOKEN = readPrivateFile(config.authBrokerTokenFile, "Auth broker token file").trim();
    if (!childEnv.OMP_AUTH_BROKER_TOKEN) throw new Error("Auth broker token file is empty");
  }
  return childEnv;
}
/** Load literal KEY=VALUE pairs. Existing process variables always win. */
export function loadLiteralEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  const content = readPrivateFile(path, "Environment file");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const split = normalized.indexOf("=");
    if (split <= 0) continue;
    const key = normalized.slice(0, split).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || env[key] !== undefined) continue;
    let value = normalized.slice(split + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}

/** Point the shared access helpers at the isolated RPC state root. */
export function activateRpcStateDir(config: RpcRuntimeConfig): void {
  process.env.OMP_TELEGRAM_STATE_DIR = config.stateDir;
  ensureStateDir();
}

/** Import an existing immutable numeric allowlist without copying the bot token. */
export function bootstrapAccessFromEnv(env: NodeJS.ProcessEnv = process.env): Access {
  const current = loadAccess();
  const configured = env.TELEGRAM_ALLOWED_USERS?.split(/[\s,]+/).filter(Boolean) ?? [];
  const valid = [...new Set(configured.filter((value) => /^\d+$/.test(value)))];
  if (current.allowFrom.length > 0 || valid.length === 0) return current;
  const access = { ...defaultAccess(), enabled: true, dmPolicy: "allowlist" as const, allowFrom: valid };
  saveAccess(access);
  return access;
}

export function loadPersistedRpcState(): PersistedRpcState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath("rpc-state.json"), "utf8"));
    if (!isRecord(parsed)) return { updatedAt: 0 };
    return {
      sessionFile: typeof parsed.sessionFile === "string" ? parsed.sessionFile : undefined,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      sessionName: typeof parsed.sessionName === "string" ? parsed.sessionName : undefined,
      lastUpdateId: Number.isSafeInteger(parsed.lastUpdateId) ? Number(parsed.lastUpdateId) : undefined,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { updatedAt: 0 };
    throw error;
  }
}

/** Atomic 0600 state update used for exact-session resume and update deduplication. */
export function savePersistedRpcState(state: PersistedRpcState): void {
  const dir = ensureStateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = statePath("rpc-state.json");
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
  chmodSync(target, 0o600);
}
