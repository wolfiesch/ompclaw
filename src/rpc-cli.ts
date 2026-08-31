#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { OmpRpcClient, type OmpRpcClientOptions } from "./rpc-client";
import { buildOmpChildEnv, loadLiteralEnvFile } from "./rpc-config";
import {
  expandGatewayPath,
  gatewayRpcRuntimeConfig,
  loadGatewayConfig,
  resolveGatewaySecrets,
  stripGatewaySecretsFromChildEnv,
  type GatewayConfig,
} from "./gateway-config";
import { GatewayApplication } from "./gateway-app";
import { GatewayStore, type LegacyTelegramStateImportResult } from "./gateway-store";
import {
  installRpcService,
  resolveGatewayServicePaths,
  uninstallRpcService,
  type ServiceInstallResult,
} from "./rpc-service";
import type { RpcResponse, RpcSessionState } from "./rpc-protocol";
import { tg } from "./api";

const COMMANDS = [
  "run",
  "doctor",
  "principal-add",
  "identity-bind",
  "telegram-allow",
  "migrate-telegram",
  "service-install",
  "service-uninstall",
] as const;

export type GatewayCliCommand = (typeof COMMANDS)[number];

export interface GatewayCliArgs {
  readonly command: GatewayCliCommand;
  readonly configPath?: string;
  readonly envFile?: string;
  readonly positionals: readonly string[];
}

export interface GatewayDoctorRpc {
  readonly protocolVersion: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(command: { readonly type: "get_state" }): Promise<RpcResponse>;
}

export type GatewayTelegramCall = <Result>(
  token: string,
  method: string,
  payload?: Record<string, unknown>,
  options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
) => Promise<Result>;

export interface GatewayCliSeams {
  readonly createApplication?: (config: GatewayConfig) => GatewayApplication;
  readonly createStore?: (path: string) => GatewayStore;
  readonly createDoctorRpc?: (options: OmpRpcClientOptions) => GatewayDoctorRpc;
  readonly callTelegram?: GatewayTelegramCall;
  readonly installService?: (config: GatewayConfig, configPath: string, envFile: string) => ServiceInstallResult;
  readonly uninstallService?: () => ServiceInstallResult;
  readonly write?: (line: string) => void;
}

const HELP = `ompclaw - authenticated multi-transport gateway for one persistent OMP session

Usage:
  ompclaw run [--config <path>] [--env-file <path>]
  ompclaw doctor [--config <path>] [--env-file <path>]
  ompclaw principal-add <principal-id> [role ...] [--config <path>]
  ompclaw identity-bind <transport> <account> <subject> <principal-id> [--config <path>]
  ompclaw telegram-allow <numeric-user-id> [principal-id] [--config <path>]
  ompclaw migrate-telegram <legacy-access.json> <legacy-rpc-state.json> [--config <path>]
  ompclaw service-install --config <path> --env-file <path>
  ompclaw service-uninstall

The JSON config carries only paths, OMP options, and credential environment names.
Transport token values stay in the environment and are removed from the OMP child.`;

/** Parse the small public gateway command surface without touching state. */
export function parseGatewayCliArgs(argv: readonly string[]): GatewayCliArgs {
  const [commandValue, ...rest] = argv;
  if (!isGatewayCliCommand(commandValue)) throw new Error(`Expected one of: ${COMMANDS.join(", ")}`);

  let configPath: string | undefined;
  let envFile: string | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]!;
    if (value === "--config" || value === "--env-file") {
      const optionValue = rest[index + 1];
      if (optionValue === undefined || optionValue.startsWith("--")) throw new Error(`${value} requires a value`);
      if (value === "--config") {
        if (configPath !== undefined) throw new Error("--config may be supplied only once");
        configPath = optionValue;
      } else {
        if (envFile !== undefined) throw new Error("--env-file may be supplied only once");
        envFile = optionValue;
      }
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw new Error(`Unknown option ${value}`);
    positionals.push(value);
  }
  return {
    command: commandValue,
    ...(configPath === undefined ? {} : { configPath }),
    ...(envFile === undefined ? {} : { envFile }),
    positionals,
  };
}

/**
 * Load config first, then copy only configured transport credentials from an
 * optional private env file. Unrelated entries never enter the gateway process
 * and therefore cannot leak into the OMP child.
 */
export function loadGatewayCliConfig(args: GatewayCliArgs, env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const config = loadGatewayConfig({ path: args.configPath });
  if (args.envFile === undefined) return config;

  const envFile = expandGatewayPath(args.envFile);
  if (!existsSync(envFile)) throw new Error(`Environment file not found: ${envFile}`);
  const fileEnv: NodeJS.ProcessEnv = {};
  loadLiteralEnvFile(envFile, fileEnv);
  const credentials = gatewayCredentialEnvNames(config).map((name) => {
    const value = fileEnv[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Environment file does not define required gateway credential ${name}`);
    }
    return [name, value] as const;
  });
  for (const [name, value] of credentials) env[name] = value;
  return config;
}

function gatewayCredentialEnvNames(config: GatewayConfig): string[] {
  const names = new Set<string>();
  const telegram = config.transports.telegram;
  if (telegram?.enabled) names.add(telegram.tokenEnv);
  const websocket = config.transports.websocket;
  if (websocket?.enabled) {
    for (const credential of websocket.credentials) names.add(credential.tokenEnv);
  }
  return [...names];
}

/** Database-backed principal management; arguments are fully validated before opening SQLite. */
export function principalAdd(config: GatewayConfig, positionals: readonly string[], seams: GatewayCliSeams = {}): void {
  if (positionals.length === 0) throw new Error("principal-add requires a principal ID");
  const id = requiredBoundedText(positionals[0], "principal ID");
  const roles = positionals.length === 1
    ? ["operator"]
    : positionals.slice(1).map((role, index) => requiredRole(role, `role ${index + 1}`));
  if (new Set(roles).size !== roles.length) throw new Error("principal roles must be unique");

  const store = openStore(config, seams);
  try {
    store.upsertPrincipal({ id, roles });
  } finally {
    store.close();
  }
}

/** Bind one exact external transport identity to an existing principal. */
export function identityBind(config: GatewayConfig, positionals: readonly string[], seams: GatewayCliSeams = {}): void {
  if (positionals.length !== 4) throw new Error("identity-bind requires transport, account, subject, and principal ID");
  const transport = requiredIdentifier(positionals[0], "transport");
  const account = requiredIdentifier(positionals[1], "account");
  const subject = requiredBoundedText(positionals[2], "subject");
  const principalId = requiredBoundedText(positionals[3], "principal ID");

  const store = openStore(config, seams);
  try {
    store.bindIdentity({ transport, account, subject }, principalId);
  } finally {
    store.close();
  }
}

/** Create/update one operator principal and bind exactly one numeric Telegram identity. */
export function telegramAllow(config: GatewayConfig, positionals: readonly string[], seams: GatewayCliSeams = {}): string {
  if (positionals.length < 1 || positionals.length > 2) throw new Error("telegram-allow requires a numeric Telegram user ID and optional principal ID");
  const userId = requiredTelegramUserId(positionals[0]);
  const account = config.transports.telegram?.account ?? "default";
  const principalId = positionals[1] === undefined
    ? `telegram:${account}:${userId}`
    : requiredBoundedText(positionals[1], "principal ID");

  const store = openStore(config, seams);
  try {
    store.upsertPrincipal({ id: principalId, roles: ["operator"] });
    store.bindIdentity({ transport: "telegram", account, subject: userId }, principalId);
  } finally {
    store.close();
  }
  return principalId;
}

/** Invoke the store's token-free, transactional legacy Telegram importer. */
export function migrateTelegram(config: GatewayConfig, positionals: readonly string[], seams: GatewayCliSeams = {}): LegacyTelegramStateImportResult {
  if (positionals.length !== 2) throw new Error("migrate-telegram requires legacy access and RPC state paths");
  const accessPath = requiredExistingFile(positionals[0], "legacy access state");
  const rpcStatePath = requiredExistingFile(positionals[1], "legacy RPC state");
  const store = openStore(config, seams);
  try {
    return store.importLegacyTelegramState({ accessPath, rpcStatePath, workspace: config.workspace });
  } finally {
    store.close();
  }
}

/** Validate credentials, database, Telegram reachability, and a short OMP get_state RPC. */
export async function doctor(config: GatewayConfig, seams: GatewayCliSeams = {}): Promise<void> {
  const secrets = resolveGatewaySecrets(config);
  const store = openStore(config, seams);
  let sessionFile: string | undefined;
  try {
    const checkpoint = store.getCheckpoint("omp", "session_file");
    if (checkpoint !== undefined && (typeof checkpoint !== "string" || checkpoint.length === 0)) {
      throw new Error("OMP session checkpoint must be a non-empty string");
    }
    sessionFile = checkpoint;
  } finally {
    store.close();
  }

  const write = seams.write ?? console.log;
  const telegram = config.transports.telegram;
  if (telegram?.enabled) {
    const callTelegram = seams.callTelegram ?? tg;
    const bot = await callTelegram<{ id: number; username?: string }>(secrets.telegramToken!, "getMe");
    const webhook = await callTelegram<{ url?: string; pending_update_count?: number }>(secrets.telegramToken!, "getWebhookInfo");
    if (webhook.url) throw new Error(`Telegram webhook is configured at ${webhook.url}; long polling requires it to be removed`);
    write(`Telegram: @${bot.username ?? bot.id}`);
    write(`Webhook: none (${webhook.pending_update_count ?? 0} updates pending)`);
  }

  const rpcConfig = gatewayRpcRuntimeConfig(config);
  const childEnv = stripGatewaySecretsFromChildEnv(buildOmpChildEnv(process.env, rpcConfig));
  const client = (seams.createDoctorRpc ?? ((options: OmpRpcClientOptions) => new OmpRpcClient(options)))({
    argv: [
      rpcConfig.ompCommand,
      "--mode",
      "rpc-ui",
      "--cwd",
      rpcConfig.cwd,
      "--profile",
      rpcConfig.profile,
      "--no-title",
      ...(sessionFile === undefined ? [] : ["--resume", sessionFile]),
      ...(sessionFile !== undefined || rpcConfig.resume === undefined ? [] : ["--resume", rpcConfig.resume]),
      ...(rpcConfig.model === undefined ? [] : ["--model", rpcConfig.model]),
      ...(rpcConfig.sessionDir === undefined ? [] : ["--session-dir", rpcConfig.sessionDir]),
      ...rpcConfig.configFiles.flatMap((file) => ["--config", file]),
      ...rpcConfig.ompArgs,
    ],
    cwd: rpcConfig.cwd,
    env: childEnv,
  });
  try {
    await client.start();
    const response = await client.send({ type: "get_state" });
    const state = response.data as RpcSessionState;
    write(`OMP RPC: protocol v${client.protocolVersion}`);
    write(`Session: ${state.sessionName ?? state.sessionId}`);
    write(`Model: ${state.model?.provider ?? "?"}/${state.model?.id ?? "?"}`);
    write("Doctor: ready");
  } finally {
    await client.stop();
  }
}

/** Start the full application and stop it exactly once when the process is signalled. */
export async function runGateway(config: GatewayConfig, seams: GatewayCliSeams = {}): Promise<void> {
  const application = (seams.createApplication ?? ((value: GatewayConfig) => new GatewayApplication({ config: value })))(config);
  await application.start();
  const stopped = Promise.withResolvers<void>();
  const signals = process as unknown as {
    once(event: "SIGINT" | "SIGTERM", listener: () => void): void;
    off(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  };
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    signals.off("SIGINT", stop);
    signals.off("SIGTERM", stop);
    void application.stop().then(stopped.resolve, stopped.reject);
  };
  signals.once("SIGINT", stop);
  signals.once("SIGTERM", stop);
  await stopped.promise;
}

/** Execute a parsed command. This is exported for CLI contract tests and embedding. */
export async function executeGatewayCommand(args: GatewayCliArgs, config: GatewayConfig, seams: GatewayCliSeams = {}): Promise<void> {
  const write = seams.write ?? console.log;
  switch (args.command) {
    case "run":
      requireNoPositionals(args);
      await runGateway(config, seams);
      return;
    case "doctor":
      requireNoPositionals(args);
      await doctor(config, seams);
      return;
    case "principal-add":
      principalAdd(config, args.positionals, seams);
      write(`Principal updated: ${args.positionals[0]}`);
      return;
    case "identity-bind":
      identityBind(config, args.positionals, seams);
      write(`Identity bound: ${args.positionals.slice(0, 3).join("/")}`);
      return;
    case "telegram-allow": {
      const principalId = telegramAllow(config, args.positionals, seams);
      write(`Telegram user allowed as ${principalId}`);
      return;
    }
    case "migrate-telegram": {
      const result = migrateTelegram(config, args.positionals, seams);
      write(result.imported ? "Telegram state migrated" : "Telegram state was already migrated");
      return;
    }
    case "service-install": {
      requireNoPositionals(args);
      const paths = resolveGatewayServicePaths(
        args.configPath === undefined ? undefined : expandGatewayPath(args.configPath),
        args.envFile === undefined ? undefined : expandGatewayPath(args.envFile),
      );
      resolveGatewaySecrets(config);
      const result = (seams.installService ?? installRpcService)(config, paths.configPath, paths.envFile);
      write(`Installed and started ${result.manager} service: ${result.path}`);
      return;
    }
    case "service-uninstall": {
      requireNoPositionals(args);
      const result = (seams.uninstallService ?? uninstallRpcService)();
      write(`Stopped and removed ${result.manager} service: ${result.path}`);
      return;
    }
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2), seams: GatewayCliSeams = {}): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    (seams.write ?? console.log)(HELP);
    return;
  }
  const args = parseGatewayCliArgs(argv);
  const config = loadGatewayCliConfig(args);
  await executeGatewayCommand(args, config, seams);
}

function isGatewayCliCommand(value: string | undefined): value is GatewayCliCommand {
  return typeof value === "string" && (COMMANDS as readonly string[]).includes(value);
}

function openStore(config: GatewayConfig, seams: GatewayCliSeams): GatewayStore {
  return (seams.createStore ?? ((path: string) => new GatewayStore(path)))(`${config.stateDir}/ompclaw.sqlite`);
}

function requireNoPositionals(args: GatewayCliArgs): void {
  if (args.positionals.length > 0) throw new Error(`${args.command} does not accept positional arguments`);
}

function requiredExistingFile(value: string | undefined, label: string): string {
  const path = requiredBoundedText(value, label);
  if (!existsSync(path)) throw new Error(`${label} file not found: ${path}`);
  return path;
}

function requiredTelegramUserId(value: string | undefined): string {
  const userId = requiredBoundedText(value, "Telegram user ID");
  if (!/^[0-9]{1,19}$/.test(userId)) throw new Error("Telegram user ID must be numeric");
  return userId;
}

function requiredIdentifier(value: string | undefined, label: string): string {
  const text = requiredBoundedText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(text)) throw new Error(`${label} must be an identifier`);
  return text;
}

function requiredRole(value: string | undefined, label: string): string {
  const text = requiredIdentifier(value, label);
  if (text.length > 64) throw new Error(`${label} is too long`);
  return text;
}

function requiredBoundedText(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
