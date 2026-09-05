#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { OmpRpcClient, type OmpRpcClientOptions } from "./rpc-client";
import { buildOmpChildEnv, loadLiteralEnvFile } from "./rpc-config";
import {
  DEFAULT_GATEWAY_STATE_DIR,
  expandGatewayPath,
  gatewayRpcRuntimeConfig,
  loadGatewayConfig,
  resolveGatewaySecrets,
  stripGatewaySecretsFromChildEnv,
  type GatewayConfig,
} from "./gateway-config";
import { GatewayApplication } from "./gateway-app";
import { GatewayStore, type LegacyTelegramStateImportResult } from "./gateway-store";
import { GatewayPairingService, type PairingRequestResult, type PairingRequestView } from "./gateway-pairing";
import {
  DEFAULT_GATEWAY_SETUP_CONFIG_PATH,
  DEFAULT_GATEWAY_SETUP_ENV_FILE,
  listenForFirstTelegramUser,
  runGatewaySetupWizard,
  type FirstTelegramUserCandidate,
  type GatewaySetupReceipt,
  type GatewaySetupWizardOptions,
} from "./gateway-setup";
import { availableFilesystemBytes, formatBinaryBytes, MIN_GATEWAY_UPDATE_FREE_BYTES } from "./gateway-update";
import {
  installRpcService,
  resolveGatewayServicePaths,
  uninstallRpcService,
  type ServiceInstallResult,
} from "./rpc-service";
import type { RpcResponse, RpcSessionState } from "./rpc-protocol";
import { telegramPollLockPath, tg } from "./transports/telegram/bot-api";

const COMMANDS = [
  "run",
  "setup",
  "doctor",
  "pairing-listen",
  "pairing-list",
  "pairing-approve",
  "pairing-reject",
  "pairing-clear",
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
  readonly installService?: boolean;
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
  readonly findExecutable?: (program: string) => string | null | undefined;
  readonly getAvailableBytes?: (path: string) => bigint;
  readonly installService?: (
    config: GatewayConfig,
    configPath: string,
    envFile: string,
  ) => ServiceInstallResult | Promise<ServiceInstallResult>;
  readonly uninstallService?: () => ServiceInstallResult;
  readonly runSetupWizard?: (options: GatewaySetupWizardOptions) => Promise<GatewaySetupReceipt>;
  readonly listenForFirstTelegramUser?: typeof listenForFirstTelegramUser;
  readonly promptSecret?: (question: string) => Promise<string | undefined>;
  readonly now?: () => number;
  readonly write?: (line: string) => void;
}

const HELP = `ompclaw - authenticated multi-transport gateway for one persistent OMP session

Usage:
  ompclaw setup [--config <path>] [--env-file <path>] [--install-service]
  ompclaw run [--config <path>] [--env-file <path>]
  ompclaw doctor [--config <path>] [--env-file <path>]
  ompclaw pairing-listen [--config <path>] [--env-file <path>]
  ompclaw pairing-list [--config <path>]
  ompclaw pairing-approve <code> [principal-id] [--config <path>]
  ompclaw pairing-reject <code> [--config <path>]
  ompclaw pairing-clear [--config <path>]
  ompclaw principal-add <principal-id> [role ...] [--config <path>]
  ompclaw identity-bind <transport> <account> <subject> <principal-id> [--config <path>]
  ompclaw telegram-allow <numeric-user-id> [principal-id] [--config <path>]
  ompclaw migrate-telegram <legacy-access.json> <legacy-rpc-state.json> [--config <path>]
  ompclaw service-install --config <path> --env-file <path>
  ompclaw service-uninstall

Setup validates the Telegram bot, writes mode-0600 config and credential files,
waits for one direct message, and prints a local pairing approval command.
Transport token values stay outside the JSON config and are removed from the OMP child.`;

/** Parse the small public gateway command surface without touching state. */
export function parseGatewayCliArgs(argv: readonly string[]): GatewayCliArgs {
  const [commandValue, ...rest] = argv;
  if (!isGatewayCliCommand(commandValue)) throw new Error(`Expected one of: ${COMMANDS.join(", ")}`);

  let configPath: string | undefined;
  let envFile: string | undefined;
  let installService = false;
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
    if (value === "--install-service") {
      if (installService) throw new Error("--install-service may be supplied only once");
      installService = true;
      continue;
    }
    if (value.startsWith("--")) throw new Error(`Unknown option ${value}`);
    positionals.push(value);
  }
  return {
    command: commandValue,
    ...(configPath === undefined ? {} : { configPath }),
    ...(envFile === undefined ? {} : { envFile }),
    ...(installService ? { installService: true } : {}),
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
  const roles =
    positionals.length === 1
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
export function telegramAllow(
  config: GatewayConfig,
  positionals: readonly string[],
  seams: GatewayCliSeams = {},
): string {
  if (positionals.length < 1 || positionals.length > 2)
    throw new Error("telegram-allow requires a numeric Telegram user ID and optional principal ID");
  const userId = requiredTelegramUserId(positionals[0]);
  const account = config.transports.telegram?.account ?? "default";
  const principalId =
    positionals[1] === undefined
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
export function migrateTelegram(
  config: GatewayConfig,
  positionals: readonly string[],
  seams: GatewayCliSeams = {},
): LegacyTelegramStateImportResult {
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

/** Run first-use setup, persist one pending pairing request, and verify the resulting installation. */
export async function setupGateway(args: GatewayCliArgs, seams: GatewayCliSeams = {}): Promise<void> {
  requireNoPositionals(args);
  const write = seams.write ?? console.log;
  const configPath = expandGatewayPath(args.configPath ?? DEFAULT_GATEWAY_SETUP_CONFIG_PATH);
  const envFile = expandGatewayPath(args.envFile ?? DEFAULT_GATEWAY_SETUP_ENV_FILE);
  const setup = seams.runSetupWizard ?? runGatewaySetupWizard;
  const receipt = await setup({
    configPath,
    envFile,
    workspace: process.cwd(),
    secrets: {
      readTelegramBotToken: () => process.env.TELEGRAM_BOT_TOKEN,
    },
    prompt: (question) => (seams.promptSecret ?? readHiddenLine)(question),
    write,
    callTelegram: seams.callTelegram,
    pollLockPath: telegramPollLockPath(DEFAULT_GATEWAY_STATE_DIR, "default"),
  });
  const configuredArgs: GatewayCliArgs = {
    command: "doctor",
    configPath: receipt.configPath,
    envFile: receipt.envFile,
    positionals: [],
  };
  const config = loadGatewayCliConfig(configuredArgs);

  if (receipt.discovery === undefined) {
    write("No direct Telegram message arrived. Run `ompclaw pairing-listen` to try again.");
  } else {
    write(
      `Pairing request from ${receipt.discovery.displayLabel} (Telegram user ${receipt.discovery.identity.subject}).`,
    );
    const pairing = createPairingRequest(config, receipt.discovery, seams);
    write(`Pairing code: ${pairing.code}`);
    write(
      `Approve locally (POSIX shell): ompclaw pairing-approve ${posixQuote(pairing.code)} --config ${posixQuote(receipt.configPath)}`,
    );
  }

  await doctor(config, seams);
  if (args.installService === true) {
    const result = await (seams.installService ?? installRpcService)(config, receipt.configPath, receipt.envFile);
    write(`Installed and started ${result.manager} service: ${result.path}`);
  }
}

/** Listen for one direct Telegram user and persist a short-lived local approval request. */
export async function pairingListen(
  config: GatewayConfig,
  positionals: readonly string[],
  seams: GatewayCliSeams = {},
): Promise<PairingRequestResult & { readonly candidate: FirstTelegramUserCandidate }> {
  if (positionals.length > 0) throw new Error("pairing-listen does not accept positional arguments");
  const telegram = config.transports.telegram;
  if (!telegram?.enabled) throw new Error("Telegram transport is disabled");
  const token = resolveGatewaySecrets(config).telegramToken;
  if (token === undefined) throw new Error("Telegram credential is not configured");
  const candidate = await (seams.listenForFirstTelegramUser ?? listenForFirstTelegramUser)({
    token,
    account: telegram.account,
    callTelegram: seams.callTelegram,
    write: seams.write,
    pollLockPath: telegramPollLockPath(config.stateDir, telegram.account),
    now: seams.now,
  });
  if (candidate === undefined) throw new Error("No direct Telegram message arrived before pairing discovery timed out");
  return { ...createPairingRequest(config, candidate, seams), candidate };
}

export function pairingList(
  config: GatewayConfig,
  positionals: readonly string[],
  seams: GatewayCliSeams = {},
): PairingRequestView[] {
  if (positionals.length > 0) throw new Error("pairing-list does not accept positional arguments");
  return withPairingService(config, seams, (service) => service.list(seams.now?.()));
}

export function pairingApprove(
  config: GatewayConfig,
  positionals: readonly string[],
  seams: GatewayCliSeams = {},
): PairingRequestView {
  if (positionals.length < 1 || positionals.length > 2) {
    throw new Error("pairing-approve requires a code and optional principal ID");
  }
  const code = requiredBoundedText(positionals[0], "pairing code");
  const principalId = positionals[1] === undefined ? undefined : requiredBoundedText(positionals[1], "principal ID");
  return withPairingService(config, seams, (service) => service.approve(code, principalId, seams.now?.()));
}

export function pairingReject(
  config: GatewayConfig,
  positionals: readonly string[],
  seams: GatewayCliSeams = {},
): PairingRequestView {
  if (positionals.length !== 1) throw new Error("pairing-reject requires a code");
  const code = requiredBoundedText(positionals[0], "pairing code");
  return withPairingService(config, seams, (service) => service.reject(code, seams.now?.()));
}

export function pairingClear(
  config: GatewayConfig,
  positionals: readonly string[],
  seams: GatewayCliSeams = {},
): number {
  if (positionals.length > 0) throw new Error("pairing-clear does not accept positional arguments");
  return withPairingService(config, seams, (service) => service.clear(seams.now?.()));
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
  if (config.updates.enabled) {
    const availableBytes = (seams.getAvailableBytes ?? availableFilesystemBytes)(config.stateDir);
    write(
      `Update storage: ${formatBinaryBytes(availableBytes)} free at ${config.stateDir} (${formatBinaryBytes(MIN_GATEWAY_UPDATE_FREE_BYTES)} staging minimum)`,
    );
    if (availableBytes < MIN_GATEWAY_UPDATE_FREE_BYTES) {
      throw new Error(
        `Transactional update staging requires ${formatBinaryBytes(MIN_GATEWAY_UPDATE_FREE_BYTES)} free at ${config.stateDir}; ${formatBinaryBytes(availableBytes)} is available. Free disk space or move stateDir, then retry`,
      );
    }
  }

  const telegram = config.transports.telegram;
  if (telegram?.enabled) {
    const callTelegram = seams.callTelegram ?? tg;
    const bot = await callTelegram<{ id: number; username?: string }>(secrets.telegramToken!, "getMe");
    const webhook = await callTelegram<{ url?: string; pending_update_count?: number }>(
      secrets.telegramToken!,
      "getWebhookInfo",
    );
    if (webhook.url)
      throw new Error(`Telegram webhook is configured at ${webhook.url}; long polling requires it to be removed`);
    write(`Telegram: @${bot.username ?? bot.id}`);
    write(`Webhook: none (${webhook.pending_update_count ?? 0} updates pending)`);
    const transcriptionProgram = telegram.transcribeCommand?.[0];
    if (transcriptionProgram === undefined) {
      write("Voice transcription: disabled");
    } else {
      const executable = (seams.findExecutable ?? ((program: string) => Bun.which(program)))(transcriptionProgram);
      if (executable == null) {
        throw new Error(
          `Telegram transcription command "${transcriptionProgram}" was not found; install it or remove transports.telegram.transcribeCommand`,
        );
      }
      write(`Voice transcription: ready (${transcriptionProgram})`);
    }
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
  const application = (
    seams.createApplication ?? ((value: GatewayConfig) => new GatewayApplication({ config: value }))
  )(config);
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
export async function executeGatewayCommand(
  args: GatewayCliArgs,
  config: GatewayConfig | undefined,
  seams: GatewayCliSeams = {},
): Promise<void> {
  const write = seams.write ?? console.log;
  if (args.installService === true && args.command !== "setup") {
    throw new Error("--install-service is accepted only by setup");
  }
  if (args.command === "setup") {
    await setupGateway(args, seams);
    return;
  }
  if (config === undefined) throw new Error(`Configuration is required for ${args.command}`);

  switch (args.command) {
    case "run":
      requireNoPositionals(args);
      await runGateway(config, seams);
      return;
    case "doctor":
      requireNoPositionals(args);
      await doctor(config, seams);
      return;
    case "pairing-listen": {
      const result = await pairingListen(config, args.positionals, seams);
      write(
        `Pairing request from ${result.candidate.displayLabel} (Telegram user ${result.candidate.identity.subject}).`,
      );
      write(`Pairing code: ${result.code}`);
      const configOption =
        args.configPath === undefined ? "" : ` --config ${posixQuote(expandGatewayPath(args.configPath))}`;
      write(`Approve locally (POSIX shell): ompclaw pairing-approve ${posixQuote(result.code)}${configOption}`);
      return;
    }
    case "pairing-list": {
      const requests = pairingList(config, args.positionals, seams);
      if (requests.length === 0) {
        write("No pairing requests.");
        return;
      }
      for (const request of requests) write(formatPairingRequest(request));
      return;
    }
    case "pairing-approve": {
      const request = pairingApprove(config, args.positionals, seams);
      write(
        `Pairing approved: ${request.identity.transport}/${request.identity.account}/${request.identity.subject} as ${request.principalId}`,
      );
      return;
    }
    case "pairing-reject": {
      const request = pairingReject(config, args.positionals, seams);
      write(`Pairing rejected: ${request.identity.transport}/${request.identity.account}/${request.identity.subject}`);
      return;
    }
    case "pairing-clear": {
      const cleared = pairingClear(config, args.positionals, seams);
      write(`Cleared ${cleared} pairing request(s).`);
      return;
    }
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
      const result = await (seams.installService ?? installRpcService)(config, paths.configPath, paths.envFile);
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

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  seams: GatewayCliSeams = {},
): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    (seams.write ?? console.log)(HELP);
    return;
  }
  const args = parseGatewayCliArgs(argv);
  const config = args.command === "setup" ? undefined : loadGatewayCliConfig(args);
  await executeGatewayCommand(args, config, seams);
}

function isGatewayCliCommand(value: string | undefined): value is GatewayCliCommand {
  return typeof value === "string" && (COMMANDS as readonly string[]).includes(value);
}

function openStore(config: GatewayConfig, seams: GatewayCliSeams): GatewayStore {
  return (seams.createStore ?? ((path: string) => new GatewayStore(path)))(`${config.stateDir}/ompclaw.sqlite`);
}

function withPairingService<Result>(
  config: GatewayConfig,
  seams: GatewayCliSeams,
  use: (service: GatewayPairingService) => Result,
): Result {
  const store = openStore(config, seams);
  try {
    return use(new GatewayPairingService(store));
  } finally {
    store.close();
  }
}

function createPairingRequest(
  config: GatewayConfig,
  candidate: FirstTelegramUserCandidate,
  seams: GatewayCliSeams,
): PairingRequestResult {
  return withPairingService(config, seams, (service) =>
    service.request(candidate.identity, candidate.address, seams.now?.()),
  );
}

function formatPairingRequest(request: PairingRequestView): string {
  const identity = `${request.identity.transport}/${request.identity.account}/${request.identity.subject}`;
  const expiry = new Date(request.expiresAt).toISOString();
  const principal = request.principalId === undefined ? "" : ` principal=${request.principalId}`;
  return `${request.state} ${identity} expires=${expiry} attempts=${request.failedAttempts}/${request.maxAttempts}${principal}`;
}

function posixQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("Cannot render a multiline shell argument");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readHiddenLine(question: string): Promise<string | undefined> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("TELEGRAM_BOT_TOKEN is not set and setup requires an interactive terminal");
  }
  process.stderr.write(question);
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();

  return new Promise<string | undefined>((resolveLine, rejectLine) => {
    let value = "";
    const cleanup = (): void => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
    };
    const finish = (result: string | undefined): void => {
      cleanup();
      resolveLine(result);
    };
    const onData = (chunk: string | Buffer): void => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") {
          finish(value);
          return;
        }
        if (character === "\u0003") {
          cleanup();
          rejectLine(new Error("Telegram setup was cancelled"));
          return;
        }
        if (character === "\u0004") {
          finish(undefined);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " " && character !== "\u007f" && value.length < 4_096) value += character;
      }
    };
    input.on("data", onData);
  });
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
