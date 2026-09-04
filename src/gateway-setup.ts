import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  TELEGRAM_BOT_DESCRIPTION,
  TELEGRAM_BOT_SHORT_DESCRIPTION,
  acquireLock,
  refreshTelegramBotProfile,
  releaseLock,
  startLockHeartbeat,
  tg,
} from "./transports/telegram/bot-api";
import type { ConversationAddress, TransportIdentity } from "./gateway-types";

const DEFAULT_ACCOUNT = "default";
const DEFAULT_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";
const DEFAULT_DISCOVERY_TIMEOUT_MS = 120_000;
const MAX_DISCOVERY_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_TIMEOUT_SECONDS = 20;
const MAX_POLL_TIMEOUT_SECONDS = 50;
const PAIRING_REQUEST_ACKNOWLEDGEMENT =
  "Your pairing request was received. Local approval is required before access is granted.";

export const DEFAULT_GATEWAY_SETUP_CONFIG_PATH = join(homedir(), ".config", "ompclaw", "config.json");
export const DEFAULT_GATEWAY_SETUP_ENV_FILE = join(homedir(), ".config", "ompclaw", "ompclaw.env");

export type TelegramApiCall = <Result>(
  token: string,
  method: string,
  payload?: Record<string, unknown>,
  options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
) => Promise<Result>;

export interface TelegramBotIdentity {
  readonly id: number;
  readonly username?: string;
  readonly friendlyName?: string;
  readonly displayName: string;
}

export interface TelegramCredentialValidation {
  readonly bot: TelegramBotIdentity;
  readonly pendingUpdateCount: number;
}

export interface ValidateTelegramCredentialsOptions {
  readonly callTelegram?: TelegramApiCall;
}

/** Verify that a BotFather token belongs to a bot that is safe to long-poll. */
export async function validateTelegramCredentials(
  token: string,
  options: ValidateTelegramCredentialsOptions = {},
): Promise<TelegramCredentialValidation> {
  const secret = telegramToken(token);
  const callTelegram = options.callTelegram ?? tg;

  let me: unknown;
  try {
    me = await callTelegram<unknown>(secret, "getMe");
  } catch {
    throw new Error("Telegram token validation failed");
  }

  const bot = telegramBot(me);

  let webhook: unknown;
  try {
    webhook = await callTelegram<unknown>(secret, "getWebhookInfo");
  } catch {
    throw new Error("Telegram webhook validation failed");
  }

  const webhookInfo = record(webhook);
  if (!webhookInfo) throw new Error("Telegram getWebhookInfo returned an invalid response");
  if (webhookInfo.url !== undefined && typeof webhookInfo.url !== "string") {
    throw new Error("Telegram getWebhookInfo returned an invalid response");
  }
  if (typeof webhookInfo.url === "string" && webhookInfo.url.trim().length > 0) {
    throw new Error("Telegram has an active webhook; remove it before enabling long polling");
  }

  return {
    bot,
    pendingUpdateCount: nonNegativeInteger(webhookInfo.pending_update_count) ?? 0,
  };
}

export interface GatewaySetupFilesInput {
  readonly configPath: string;
  readonly envFile: string;
  readonly token: string;
  readonly account?: string;
  readonly tokenEnv?: string;
  readonly workspace?: string;
}

export interface GatewaySetupFiles {
  readonly configPath: string;
  readonly envFile: string;
}

/** Write the token-free config and its private literal environment file atomically. */
export function writeGatewaySetupFiles(input: GatewaySetupFilesInput): GatewaySetupFiles {
  const configPath = filePath(input.configPath, "configPath");
  const envFile = filePath(input.envFile, "envFile");
  if (configPath === envFile) throw new Error("configPath and envFile must be different files");
  if (existsSync(configPath)) throw new Error(`setup config already exists: ${configPath}`);
  if (existsSync(envFile)) throw new Error(`setup environment file already exists: ${envFile}`);

  const token = telegramToken(input.token);
  const account = gatewayIdentifier(input.account ?? DEFAULT_ACCOUNT, "account");
  const tokenEnv = telegramTokenEnvironment(input.tokenEnv ?? DEFAULT_TOKEN_ENV);
  const workspace = workspacePath(input.workspace ?? process.cwd());
  const config = {
    workspace,
    transports: {
      telegram: {
        enabled: true,
        account,
        tokenEnv,
        topicSessions: {
          enabled: false,
          createFromRoot: false,
        },
      },
    },
  };

  writePrivateFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writePrivateFileAtomic(envFile, `${tokenEnv}=${token}\n`);
  return { configPath, envFile };
}

export interface FirstTelegramUserCandidate {
  readonly identity: TransportIdentity;
  readonly address: ConversationAddress;
  readonly displayLabel: string;
  readonly updateId: number;
}

export interface FirstTelegramUserListenerOptions {
  readonly token: string;
  readonly account?: string;
  readonly callTelegram?: TelegramApiCall;
  readonly write?: (line: string) => void;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly pollTimeoutSeconds?: number;
  readonly now?: () => number;
  readonly pollLockPath?: string;
}

/**
 * Temporarily long-poll Telegram until one unambiguous direct human message arrives.
 * Discovery only reports a candidate; it never grants access or writes authorization state.
 */
export async function listenForFirstTelegramUser(
  options: FirstTelegramUserListenerOptions,
): Promise<FirstTelegramUserCandidate | undefined> {
  const token = telegramToken(options.token);
  const account = gatewayIdentifier(options.account ?? DEFAULT_ACCOUNT, "account");
  const callTelegram = options.callTelegram ?? tg;
  const timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
  const pollTimeoutSeconds = boundedPollTimeout(options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  if (options.signal?.aborted) return undefined;
  const controller = new AbortController();
  const stop = () => controller.abort();
  const timeout = setTimeout(stop, timeoutMs);
  options.signal?.addEventListener("abort", stop, { once: true });
  const lockPath = options.pollLockPath;
  let stopHeartbeat: (() => void) | undefined;
  if (lockPath !== undefined) {
    const ownership = acquireLock(lockPath);
    if (!ownership.ok) {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", stop);
      const holder = ownership.holder > 0 ? ` by process ${ownership.holder}` : "";
      throw new Error(`Telegram account is already being polled${holder}`);
    }
    stopHeartbeat = startLockHeartbeat(lockPath);
  }

  let nextOffset = 0;
  try {
    if (now() >= deadline) return undefined;
    const backlog = await abortableTelegramCall<unknown>(
      callTelegram,
      token,
      "getUpdates",
      { offset: -1, limit: 1, timeout: 0, allowed_updates: ["message"] },
      controller.signal,
    );
    if (backlog.aborted) return undefined;
    const queued = telegramUpdates(backlog.value, 0);
    if (queued.length > 0) nextOffset = queued[queued.length - 1]!.id + 1;
    options.write?.("Telegram pairing listener ready; send the bot a direct message.");
    while (!controller.signal.aborted && now() < deadline) {
      const remainingMs = Math.max(1, deadline - now());
      const telegramTimeoutSeconds = Math.max(1, Math.min(pollTimeoutSeconds, Math.ceil(remainingMs / 1_000)));
      const result = await abortableTelegramCall<unknown>(
        callTelegram,
        token,
        "getUpdates",
        {
          offset: nextOffset,
          timeout: telegramTimeoutSeconds,
          allowed_updates: ["message"],
        },
        controller.signal,
      );
      if (result.aborted) return undefined;

      const updates = telegramUpdates(result.value, nextOffset);
      for (const update of updates) {
        nextOffset = Math.max(nextOffset, update.id + 1);
        const candidate = firstUserCandidate(update.value, account);
        if (!candidate) continue;

        const acknowledgement = await abortableTelegramCall<unknown>(
          callTelegram,
          token,
          "sendMessage",
          { chat_id: candidate.address.channel, text: PAIRING_REQUEST_ACKNOWLEDGEMENT },
          controller.signal,
        );
        if (acknowledgement.aborted) return undefined;
        options.write?.("Telegram pairing request received; awaiting local approval.");
        return candidate;
      }
    }
    return undefined;
  } catch (error) {
    if (controller.signal.aborted || options.signal?.aborted) return undefined;
    if (error instanceof Error && error.message.startsWith("Telegram getUpdates returned")) throw error;
    throw new Error("Telegram pairing discovery failed");
  } finally {
    stopHeartbeat?.();
    if (lockPath !== undefined) releaseLock(lockPath);
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", stop);
  }
}

export interface GatewaySetupSecrets {
  readonly readTelegramBotToken: () => string | undefined | Promise<string | undefined>;
}

export interface GatewaySetupServiceReceipt {
  readonly manager: string;
  readonly path: string;
}

export type GatewaySetupServiceInstaller = (
  files: GatewaySetupFiles,
) => GatewaySetupServiceReceipt | Promise<GatewaySetupServiceReceipt>;

export interface GatewaySetupWizardOptions {
  readonly configPath?: string;
  readonly envFile?: string;
  readonly workspace?: string;
  readonly account?: string;
  readonly tokenEnv?: string;
  readonly prompt?: (question: string) => string | undefined | Promise<string | undefined>;
  readonly write?: (line: string) => void;
  readonly callTelegram?: TelegramApiCall;
  readonly secrets?: GatewaySetupSecrets;
  readonly installService?: GatewaySetupServiceInstaller;
  readonly signal?: AbortSignal;
  readonly discoveryTimeoutMs?: number;
  readonly pollTimeoutSeconds?: number;
  readonly pollLockPath?: string;
  readonly now?: () => number;
}

export interface GatewaySetupReceipt extends GatewaySetupFiles {
  readonly bot: TelegramBotIdentity;
  readonly discovery?: FirstTelegramUserCandidate;
  readonly service?: GatewaySetupServiceReceipt;
}

/** Run the token-safe setup flow. Discovery is deliberately not authorization. */
export async function runGatewaySetupWizard(options: GatewaySetupWizardOptions = {}): Promise<GatewaySetupReceipt> {
  const token = await wizardToken(options);
  const account = gatewayIdentifier(options.account ?? DEFAULT_ACCOUNT, "account");
  const tokenEnv = telegramTokenEnvironment(options.tokenEnv ?? DEFAULT_TOKEN_ENV);
  const validation = await validateTelegramCredentials(token, { callTelegram: options.callTelegram });
  const files = writeGatewaySetupFiles({
    configPath: options.configPath ?? DEFAULT_GATEWAY_SETUP_CONFIG_PATH,
    envFile: options.envFile ?? DEFAULT_GATEWAY_SETUP_ENV_FILE,
    token,
    account,
    tokenEnv,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
  });
  const profileFailures = await refreshTelegramBotProfile(
    (method, payload, request) => (options.callTelegram ?? tg)(token, method, payload, request),
    {
      description: TELEGRAM_BOT_DESCRIPTION,
      shortDescription: TELEGRAM_BOT_SHORT_DESCRIPTION,
      ...(validation.bot.friendlyName === undefined ? {} : { name: validation.bot.friendlyName }),
    },
    options.signal,
  );

  for (const failure of profileFailures) {
    options.write?.(
      `[telegram] bot profile ${failure.method} failed: ${
        failure.error instanceof Error ? failure.error.message : String(failure.error)
      }`,
    );
  }

  options.write?.(`Telegram bot verified: ${validation.bot.displayName}`);
  if (validation.bot.username !== undefined) options.write?.(`Open your bot: https://t.me/${validation.bot.username}`);
  options.write?.(`Setup files written: ${files.configPath} and ${files.envFile}`);
  options.write?.("Waiting briefly for one Telegram pairing request.");

  const discovery = await listenForFirstTelegramUser({
    token,
    account,
    callTelegram: options.callTelegram,
    write: options.write,
    signal: options.signal,
    timeoutMs: options.discoveryTimeoutMs,
    pollTimeoutSeconds: options.pollTimeoutSeconds,
    pollLockPath: options.pollLockPath,
    now: options.now,
  });
  const service = options.installService === undefined ? undefined : await options.installService(files);
  if (service) options.write?.(`Service installed: ${service.manager} (${service.path})`);

  return {
    ...files,
    bot: validation.bot,
    ...(discovery === undefined ? {} : { discovery }),
    ...(service === undefined ? {} : { service }),
  };
}

type TelegramUpdate = Readonly<{ id: number; value: Record<string, unknown> }>;
type AbortableTelegramResult<Result> = Readonly<{ aborted: false; value: Result }> | Readonly<{ aborted: true }>;

async function abortableTelegramCall<Result>(
  callTelegram: TelegramApiCall,
  token: string,
  method: string,
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<AbortableTelegramResult<Result>> {
  if (signal.aborted) return { aborted: true };

  let stop: (() => void) | undefined;
  const aborted = new Promise<AbortableTelegramResult<Result>>((resolveAbort) => {
    stop = () => resolveAbort({ aborted: true });
    signal.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([
      callTelegram<Result>(token, method, payload, { signal }).then((value) => ({ aborted: false, value }) as const),
      aborted,
    ]);
  } finally {
    if (stop) signal.removeEventListener("abort", stop);
  }
}

function telegramUpdates(value: unknown, minimumId: number): readonly TelegramUpdate[] {
  if (!Array.isArray(value)) throw new Error("Telegram getUpdates returned an invalid response");
  const updates: TelegramUpdate[] = [];
  const batchIds = new Set<number>();
  for (const entry of value) {
    const update = record(entry);
    const id = update ? nonNegativeInteger(update.update_id) : undefined;
    if (!update || id === undefined || id < minimumId || batchIds.has(id)) continue;
    batchIds.add(id);
    updates.push({ id, value: update });
  }
  return updates.sort((left, right) => left.id - right.id);
}

function firstUserCandidate(update: Record<string, unknown>, account: string): FirstTelegramUserCandidate | undefined {
  const message = record(update.message);
  if (
    !message ||
    message.sender_chat !== undefined ||
    message.is_topic_message === true ||
    message.message_thread_id !== undefined
  ) {
    return undefined;
  }

  const user = record(message.from);
  const chat = record(message.chat);
  const userId = user ? positiveInteger(user.id) : undefined;
  const chatId = chat ? positiveInteger(chat.id) : undefined;
  if (!user || !chat || userId === undefined || chatId === undefined || user.is_bot === true) return undefined;
  if (chat.type !== "private" || chatId !== userId) return undefined;

  const updateId = nonNegativeInteger(update.update_id);
  if (updateId === undefined) return undefined;
  return {
    identity: { transport: "telegram", account, subject: String(userId) },
    address: { transport: "telegram", account, channel: String(chatId) },
    displayLabel: telegramUserLabel(user, userId),
    updateId,
  };
}

function telegramBot(value: unknown): TelegramBotIdentity {
  const bot = record(value);
  const id = bot ? positiveInteger(bot.id) : undefined;
  if (!bot || id === undefined || bot.is_bot !== true) {
    throw new Error("Telegram getMe did not return a bot account");
  }
  const username = optionalLabel(bot.username);
  const friendlyName = optionalLabel(bot.first_name);
  return {
    id,
    ...(username === undefined ? {} : { username }),
    ...(friendlyName === undefined ? {} : { friendlyName }),
    displayName: username === undefined ? (friendlyName ?? `Telegram bot ${id}`) : `@${username}`,
  };
}

function telegramUserLabel(user: Record<string, unknown>, id: number): string {
  const firstName = optionalLabel(user.first_name);
  const username = optionalLabel(user.username);
  if (firstName && username) return `${firstName} (@${username})`;
  if (username) return `@${username}`;
  return firstName ?? `Telegram user ${id}`;
}

function telegramToken(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.trim() !== value ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error("Telegram token must be a non-empty single-line value");
  }
  return value;
}

function telegramTokenEnvironment(value: string): string {
  if (value === DEFAULT_TOKEN_ENV || /^OMPCLAW_[A-Z][A-Z0-9_]*$/.test(value)) return value;
  throw new Error("tokenEnv must name TELEGRAM_BOT_TOKEN or an OMPCLAW_ environment variable");
}

function gatewayIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a bounded identifier`);
  }
  return value;
}

function filePath(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
    throw new Error(`${label} must be a file path`);
  return resolve(value);
}

function workspacePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || value.includes("\0")) {
    throw new Error("workspace must be a bounded path");
  }
  return value;
}

function writePrivateFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The rename consumed the temporary path; no cleanup is needed.
    }
  }
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DISCOVERY_TIMEOUT_MS) {
    throw new Error(`discovery timeout must be an integer between 0 and ${MAX_DISCOVERY_TIMEOUT_MS}`);
  }
  return value;
}

function boundedPollTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_POLL_TIMEOUT_SECONDS) {
    throw new Error(`poll timeout must be an integer between 1 and ${MAX_POLL_TIMEOUT_SECONDS}`);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  return label.length > 0 && label.length <= 256 && !/[\0\r\n]/.test(label) ? label : undefined;
}

async function wizardToken(options: GatewaySetupWizardOptions): Promise<string> {
  if (options.secrets !== undefined) {
    try {
      const supplied = await options.secrets.readTelegramBotToken();
      if (supplied !== undefined) return telegramToken(supplied);
    } catch {
      throw new Error("Telegram token could not be read");
    }
  }
  if (!options.prompt) throw new Error("A Telegram token prompt or secret reader is required");
  let prompted: string | undefined;
  try {
    prompted = await options.prompt("Telegram BotFather token: ");
  } catch {
    throw new Error("Telegram token prompt failed");
  }
  if (prompted === undefined) throw new Error("Telegram setup was cancelled");
  return telegramToken(prompted);
}
