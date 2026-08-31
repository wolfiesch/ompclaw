import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { RpcRuntimeConfig } from "./rpc-config";
import { isRecord } from "./type-guards";

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_STRING_LENGTH = 4_096;
const MAX_OMP_ARGS = 64;
const MAX_TRANSPORT_CREDENTIALS = 128;
const GATEWAY_SECRET_ENV = /^OMPCLAW_[A-Z][A-Z0-9_]*$/;
const TELEGRAM_SECRET_ENV = "TELEGRAM_BOT_TOKEN";

export interface GatewayOmpConfig {
  readonly command: string;
  readonly model?: string;
  readonly resume?: string;
  readonly sessionDir?: string;
  readonly configFiles: readonly string[];
  readonly args: readonly string[];
  readonly authBrokerTokenFile?: string;
  readonly allowRpcBash: boolean;
  readonly inheritHarness: boolean;
  readonly autoRestart: boolean;
}

export interface GatewayTelegramConfig {
  readonly enabled: boolean;
  readonly account: string;
  readonly tokenEnv: string;
}

export interface GatewayWebSocketCredentialConfig {
  readonly tokenEnv: string;
  readonly subject: string;
  readonly channel: string;
  readonly thread?: string;
}

export interface GatewayWebSocketConfig {
  readonly enabled: boolean;
  readonly hostname: string;
  readonly port: number;
  readonly account: string;
  readonly credentials: readonly GatewayWebSocketCredentialConfig[];
}

export interface GatewayAutomationConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly retryDelayMs: number;
  readonly maxAttempts: number;
}

export type GatewayMemoryModel = "online" | "qwen3-1.7b" | "llama3.2:3b" | "gemma-3-1b" | "qwen2.5-1.5b" | "lfm2-1.2b";

export interface GatewayLearningConfig {
  readonly enabled: boolean;
  readonly autoCapture: boolean;
  readonly minToolCalls: number;
  readonly memoryModel: GatewayMemoryModel;
}

export interface GatewayConfig {
  readonly workspace: string;
  readonly stateDir: string;
  readonly profile: string;
  readonly omp: GatewayOmpConfig;
  readonly transports: {
    readonly telegram?: GatewayTelegramConfig;
    readonly websocket?: GatewayWebSocketConfig;
  };
  readonly automation: GatewayAutomationConfig;
  readonly learning: GatewayLearningConfig;
}

export interface GatewaySecrets {
  readonly telegramToken?: string;
  readonly webSocketCredentials: readonly {
    readonly token: string;
    readonly subject: string;
    readonly channel: string;
    readonly thread?: string;
  }[];
}

export interface LoadGatewayConfigOptions {
  readonly path?: string;
  readonly cwd?: string;
}

/** Expand a home-relative path without allowing a different user's home. */
export function expandGatewayPath(path: string, cwd: string = process.cwd()): string {
  const value = nonEmptyString(path, "path");
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

/**
 * Load the intentionally small, token-free gateway JSON document. Missing config
 * is useful for tooling and has safe local defaults; a provided document is exact.
 */
export function loadGatewayConfig(options: LoadGatewayConfigOptions = {}): GatewayConfig {
  const cwd = resolve(options.cwd ?? process.cwd());
  if (options.path === undefined) return parseGatewayConfig({}, cwd);

  const path = expandGatewayPath(options.path, cwd);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("OmpClaw config must be a regular file, not a symlink");
  if (info.size > MAX_CONFIG_BYTES) throw new Error(`OmpClaw config exceeds ${MAX_CONFIG_BYTES} bytes`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`OmpClaw config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseGatewayConfig(parsed, cwd);
}

/** Parse a JSON value for callers that already bound file loading. */
export function parseGatewayConfig(value: unknown, cwd: string = process.cwd()): GatewayConfig {
  const root = object(value, "OmpClaw config");
  rejectUnknown(root, ["workspace", "stateDir", "profile", "omp", "transports", "automation", "learning"], "OmpClaw config");

  const workspace = root.workspace === undefined ? resolve(cwd) : expandGatewayPath(string(root.workspace, "workspace"), cwd);
  const stateDir = root.stateDir === undefined
    ? resolve(homedir(), ".omp", "agent", "ompclaw")
    : expandGatewayPath(string(root.stateDir, "stateDir"), cwd);
  const profile = root.profile === undefined ? "ompclaw" : identifier(root.profile, "profile");
  const omp = parseOmp(root.omp, cwd);
  const transports = parseTransports(root.transports);
  const automation = parseAutomation(root.automation);
  const learning = parseLearning(root.learning);

  return { workspace, stateDir, profile, omp, transports, automation, learning };
}

/** Resolve only the env names carried by config, keeping token values out of it. */
export function resolveGatewaySecrets(config: GatewayConfig, env: NodeJS.ProcessEnv = process.env): GatewaySecrets {
  const telegram = config.transports.telegram;
  const telegramToken = telegram?.enabled ? requiredEnv(env, telegram.tokenEnv) : undefined;
  const webSocketCredentials = config.transports.websocket?.enabled
    ? config.transports.websocket.credentials.map((credential) => ({
      token: requiredEnv(env, credential.tokenEnv),
      subject: credential.subject,
      channel: credential.channel,
      ...(credential.thread === undefined ? {} : { thread: credential.thread }),
    }))
    : [];
  return {
    ...(telegramToken === undefined ? {} : { telegramToken }),
    webSocketCredentials,
  };
}

/** Convert OmpClaw-owned OMP settings into the existing RPC runtime contract. */
export function gatewayRpcRuntimeConfig(config: GatewayConfig): RpcRuntimeConfig {
  return {
    cwd: config.workspace,
    stateDir: config.stateDir,
    profile: config.profile,
    ompCommand: config.omp.command,
    ...(config.omp.model === undefined ? {} : { model: config.omp.model }),
    ...(config.omp.resume === undefined ? {} : { resume: config.omp.resume }),
    ...(config.omp.sessionDir === undefined ? {} : { sessionDir: config.omp.sessionDir }),
    configFiles: [...config.omp.configFiles],
    ompArgs: [...config.omp.args],
    ...(config.omp.authBrokerTokenFile === undefined ? {} : { authBrokerTokenFile: config.omp.authBrokerTokenFile }),
    allowRpcBash: config.omp.allowRpcBash,
    inheritHarness: config.omp.inheritHarness,
    autoRestart: config.omp.autoRestart,
  };
}

/** The OMP child must not inherit any gateway transport secret environment. */
export function stripGatewaySecretsFromChildEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const child: Record<string, string | undefined> = { ...env };
  for (const key of Object.keys(child)) {
    if (
      key === TELEGRAM_SECRET_ENV ||
      key.startsWith("OMPCLAW_") ||
      key.startsWith("OMP_GATEWAY_") ||
      key.startsWith("GATEWAY_") ||
      key.startsWith("OMP_TRANSPORT_") ||
      key.startsWith("OMP_WEBSOCKET_") ||
      key.startsWith("WEBSOCKET_")
    ) {
      delete child[key];
    }
  }
  return child;
}

function parseOmp(value: unknown, cwd: string): GatewayOmpConfig {
  if (value === undefined) {
    return {
      command: "omp",
      configFiles: [],
      args: [],
      allowRpcBash: false,
      inheritHarness: false,
      autoRestart: true,
    };
  }
  const omp = object(value, "omp");
  rejectUnknown(
    omp,
    ["command", "model", "resume", "sessionDir", "configFiles", "args", "authBrokerTokenFile", "allowRpcBash", "inheritHarness", "autoRestart"],
    "omp",
  );
  const configFiles = stringArray(omp.configFiles, "omp.configFiles", MAX_OMP_ARGS).map((path) => expandGatewayPath(path, cwd));
  const args = stringArray(omp.args, "omp.args", MAX_OMP_ARGS);
  return {
    command: omp.command === undefined ? "omp" : nonEmptyString(omp.command, "omp.command"),
    ...(omp.model === undefined ? {} : { model: nonEmptyString(omp.model, "omp.model") }),
    ...(omp.resume === undefined ? {} : { resume: expandGatewayPath(string(omp.resume, "omp.resume"), cwd) }),
    ...(omp.sessionDir === undefined ? {} : { sessionDir: expandGatewayPath(string(omp.sessionDir, "omp.sessionDir"), cwd) }),
    configFiles,
    args,
    ...(omp.authBrokerTokenFile === undefined
      ? {}
      : { authBrokerTokenFile: expandGatewayPath(string(omp.authBrokerTokenFile, "omp.authBrokerTokenFile"), cwd) }),
    allowRpcBash: boolean(omp.allowRpcBash, "omp.allowRpcBash", false),
    inheritHarness: boolean(omp.inheritHarness, "omp.inheritHarness", false),
    autoRestart: boolean(omp.autoRestart, "omp.autoRestart", true),
  };
}

function parseTransports(value: unknown): GatewayConfig["transports"] {
  if (value === undefined) return {};
  const transports = object(value, "transports");
  rejectUnknown(transports, ["telegram", "websocket"], "transports");
  return {
    ...(transports.telegram === undefined ? {} : { telegram: parseTelegram(transports.telegram) }),
    ...(transports.websocket === undefined ? {} : { websocket: parseWebSocket(transports.websocket) }),
  };
}

function parseTelegram(value: unknown): GatewayTelegramConfig {
  const telegram = object(value, "transports.telegram");
  rejectUnknown(telegram, ["enabled", "account", "tokenEnv"], "transports.telegram");
  const tokenEnv = secretEnvName(telegram.tokenEnv, "transports.telegram.tokenEnv", true);
  return {
    enabled: boolean(telegram.enabled, "transports.telegram.enabled"),
    account: identifier(telegram.account, "transports.telegram.account"),
    tokenEnv,
  };
}

function parseWebSocket(value: unknown): GatewayWebSocketConfig {
  const websocket = object(value, "transports.websocket");
  rejectUnknown(websocket, ["enabled", "hostname", "port", "account", "credentials"], "transports.websocket");
  const credentials = array(websocket.credentials, "transports.websocket.credentials", MAX_TRANSPORT_CREDENTIALS).map((item, index) => {
    const credential = object(item, `transports.websocket.credentials[${index}]`);
    rejectUnknown(credential, ["tokenEnv", "subject", "channel", "thread"], `transports.websocket.credentials[${index}]`);
    return {
      tokenEnv: secretEnvName(credential.tokenEnv, `transports.websocket.credentials[${index}].tokenEnv`, false),
      subject: nonEmptyString(credential.subject, `transports.websocket.credentials[${index}].subject`),
      channel: nonEmptyString(credential.channel, `transports.websocket.credentials[${index}].channel`),
      ...(credential.thread === undefined ? {} : { thread: nonEmptyString(credential.thread, `transports.websocket.credentials[${index}].thread`) }),
    };
  });
  if (credentials.length === 0) throw new Error("transports.websocket.credentials must not be empty");
  const port = websocket.port;
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("transports.websocket.port must be an integer between 0 and 65535");
  }
  return {
    enabled: boolean(websocket.enabled, "transports.websocket.enabled"),
    hostname: nonEmptyString(websocket.hostname, "transports.websocket.hostname"),
    port,
    account: identifier(websocket.account, "transports.websocket.account"),
    credentials,
  };
}

function parseAutomation(value: unknown): GatewayAutomationConfig {
  if (value === undefined) {
    return { enabled: false, pollIntervalMs: 1_000, retryDelayMs: 15_000, maxAttempts: 3 };
  }
  const automation = object(value, "automation");
  rejectUnknown(automation, ["enabled", "pollIntervalMs", "retryDelayMs", "maxAttempts"], "automation");
  return {
    enabled: boolean(automation.enabled, "automation.enabled", false),
    pollIntervalMs: integer(automation.pollIntervalMs, "automation.pollIntervalMs", 250, 60_000, 1_000),
    retryDelayMs: integer(automation.retryDelayMs, "automation.retryDelayMs", 1_000, 3_600_000, 15_000),
    maxAttempts: integer(automation.maxAttempts, "automation.maxAttempts", 1, 10, 3),
  };
}

function parseLearning(value: unknown): GatewayLearningConfig {
  if (value === undefined) {
    return { enabled: false, autoCapture: false, minToolCalls: 5, memoryModel: "online" };
  }
  const learning = object(value, "learning");
  rejectUnknown(learning, ["enabled", "autoCapture", "minToolCalls", "memoryModel"], "learning");
  const memoryModel = learning.memoryModel === undefined ? "online" : nonEmptyString(learning.memoryModel, "learning.memoryModel");
  if (!["online", "qwen3-1.7b", "llama3.2:3b", "gemma-3-1b", "qwen2.5-1.5b", "lfm2-1.2b"].includes(memoryModel)) {
    throw new Error("learning.memoryModel is not a supported OMP memory model");
  }
  return {
    enabled: boolean(learning.enabled, "learning.enabled", false),
    autoCapture: boolean(learning.autoCapture, "learning.autoCapture", false),
    minToolCalls: integer(learning.minToolCalls, "learning.minToolCalls", 1, 100, 5),
    memoryModel: memoryModel as GatewayMemoryModel,
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function rejectUnknown(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${label} contains unknown key ${key}`);
  }
}

function array(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} entries`);
  return value;
}

function stringArray(value: unknown, label: string, maximum: number): string[] {
  if (value === undefined) return [];
  return array(value, label, maximum).map((item, index) => nonEmptyString(item, `${label}[${index}]`));
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  const text = string(value, label);
  if (text.length === 0 || text.length > MAX_STRING_LENGTH || text.includes("\0")) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return text;
}

function identifier(value: unknown, label: string): string {
  const text = nonEmptyString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(text)) throw new Error(`${label} must be a bounded identifier`);
  return text;
}

function boolean(value: unknown, label: string, defaultValue?: boolean): boolean {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function secretEnvName(value: unknown, label: string, telegram: boolean): string {
  const name = nonEmptyString(value, label);
  if (name === TELEGRAM_SECRET_ENV && telegram) return name;
  if (!GATEWAY_SECRET_ENV.test(name)) {
    throw new Error(`${label} must name an OMPCLAW_ environment variable${telegram ? ` or ${TELEGRAM_SECRET_ENV}` : ""}`);
  }
  return name;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Required gateway credential environment variable ${name} is not set`);
  return value;
}
