import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const BOT_METHOD_ROOT = "https://api.telegram.org/bot";
const BOT_FILE_ROOT = "https://api.telegram.org/file/bot";
const REQUEST_LIMIT_MS = 30_000;
const DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
const RETRY_LIMIT = 3;
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 15_000;
const OWNER_FILENAME = "owner.json";
const CLAIM_GRACE_MS = 2_000;
const PROCESS_NONCE = randomBytes(16).toString("hex");
const NETWORK_FAILURE =
  /connection|socket|network|fetch failed|econn|enotfound|eai_again|unable to connect|unexpected eof/i;

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const TELEGRAM_BOT_DESCRIPTION =
  "OmpClaw connects this chat to an OMP agent for messages, voice notes, photos, and files.";
export const TELEGRAM_BOT_SHORT_DESCRIPTION = "Your OMP agent on Telegram.";

export type TelegramMethodCall = (
  method: string,
  payload?: Record<string, unknown>,
  options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
) => Promise<unknown>;

function botProfileText(value: string, label: string): string {
  const text = value.trim();
  if (text.length === 0) throw new Error(`Telegram bot ${label} must not be empty`);
  return text;
}

export async function setMyDescription(
  call: TelegramMethodCall,
  description: string,
  signal?: AbortSignal,
): Promise<void> {
  await call("setMyDescription", { description: botProfileText(description, "description") }, { signal });
}

export async function setMyShortDescription(
  call: TelegramMethodCall,
  shortDescription: string,
  signal?: AbortSignal,
): Promise<void> {
  await call(
    "setMyShortDescription",
    { short_description: botProfileText(shortDescription, "short description") },
    {
      signal,
    },
  );
}

export async function setMyName(call: TelegramMethodCall, name: string, signal?: AbortSignal): Promise<void> {
  await call("setMyName", { name: botProfileText(name, "name") }, { signal });
}

export interface TelegramBotProfile {
  readonly description: string;
  readonly shortDescription: string;
  readonly name?: string;
}

export interface TelegramBotProfileFailure {
  readonly method: "setMyDescription" | "setMyShortDescription" | "setMyName";
  readonly error: unknown;
}

/** Applies the idempotent Bot API profile fields without making a rejected field fatal. */
export async function refreshTelegramBotProfile(
  call: TelegramMethodCall,
  profile: TelegramBotProfile,
  signal?: AbortSignal,
): Promise<readonly TelegramBotProfileFailure[]> {
  const operations: Array<readonly [TelegramBotProfileFailure["method"], () => Promise<void>]> = [
    ["setMyDescription", () => setMyDescription(call, profile.description, signal)],
    ["setMyShortDescription", () => setMyShortDescription(call, profile.shortDescription, signal)],
    ...(profile.name === undefined ? [] : [["setMyName", () => setMyName(call, profile.name!, signal)] as const]),
  ];
  const failures: TelegramBotProfileFailure[] = [];
  for (const [method, update] of operations) {
    try {
      await update();
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push({ method, error });
    }
  }
  return failures;
}

export class TgError extends Error {
  readonly name = "TelegramApiError";

  constructor(
    message: string,
    readonly code: number,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export type TgUser = Readonly<{
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
}>;

export type TgChat = Readonly<{
  id: number;
  type: string;
  title?: string;
  is_forum?: boolean;
}>;

export type TgMessageEntity = Readonly<{
  type: string;
  offset: number;
  length: number;
  user?: TgUser;
}>;

export type TgPhotoSize = Readonly<{
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}>;

export type TgFileBase = Readonly<{
  file_id: string;
  file_unique_id: string;
  file_size?: number;
}>;

export type TgDocument = TgFileBase & Readonly<{ file_name?: string; mime_type?: string }>;
export type TgVoice = TgFileBase & Readonly<{ mime_type?: string }>;
export type TgAudio = TgFileBase & Readonly<{ file_name?: string; mime_type?: string }>;
export type TgVideo = TgFileBase & Readonly<{ file_name?: string; mime_type?: string }>;
export type TgVideoNote = TgFileBase;
export type TgAnimation = TgFileBase & Readonly<{ file_name?: string; mime_type?: string }>;
export type TgSticker = TgFileBase & Readonly<{ is_animated?: boolean; is_video?: boolean }>;
export type TgTextQuote = Readonly<{
  text: string;
  entities?: readonly TgMessageEntity[];
  position?: number;
  is_manual?: boolean;
}>;

export type TgMessageOrigin = Readonly<{
  type: "user" | "hidden_user" | "chat" | "channel" | string;
  date: number;
  sender_user?: TgUser;
  sender_user_name?: string;
  sender_chat?: TgChat;
  author_signature?: string;
}>;

export type TgExternalReplyInfo = Readonly<{
  origin: TgMessageOrigin;
  chat?: TgChat;
  message_id?: number;
  animation?: TgAnimation;
  audio?: TgAudio;
  document?: TgDocument;
  photo?: readonly TgPhotoSize[];
  sticker?: TgSticker;
  video?: TgVideo;
  video_note?: TgVideoNote;
  voice?: TgVoice;
  has_media_spoiler?: boolean;
  quote?: TgTextQuote;
}>;

export type TgMessage = Readonly<{
  message_id: number;
  date: number;
  edit_date?: number;
  media_group_id?: string;
  chat: TgChat;
  from?: TgUser;
  sender_chat?: TgChat;
  text?: string;
  caption?: string;
  entities?: readonly TgMessageEntity[];
  caption_entities?: readonly TgMessageEntity[];
  reply_to_message?: TgMessage;
  quote?: TgTextQuote;
  external_reply?: TgExternalReplyInfo;
  forward_origin?: TgMessageOrigin;
  photo?: readonly TgPhotoSize[];
  document?: TgDocument;
  voice?: TgVoice;
  audio?: TgAudio;
  video?: TgVideo;
  animation?: TgAnimation;
  video_note?: TgVideoNote;
  sticker?: TgSticker;
  message_thread_id?: number;
  is_topic_message?: boolean;
  edited_flag?: boolean;
}>;

export type TgCallbackQuery = Readonly<{
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
}>;

export type TgMessageGenerationStopped = Readonly<{
  draft_id: number;
  chat: TgChat;
  message_thread_id?: number;
}>;

export type TgUpdate = Readonly<{
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
  stopped_message_generation?: TgMessageGenerationStopped;
}>;

export type TgFile = Readonly<{
  file_id: string;
  file_unique_id: string;
  file_path?: string;
  file_size?: number;
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function abortValue(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

function requestSignal(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller === undefined ? timeout : AbortSignal.any([caller, timeout]);
}

async function unwrapTelegram<T>(response: Response): Promise<T> {
  let decoded: unknown;
  try {
    decoded = await response.json();
  } catch {
    throw new TgError(`Telegram returned non-JSON HTTP ${response.status}`, response.status);
  }
  const envelope = record(decoded);
  if (envelope === undefined || typeof envelope.ok !== "boolean") {
    throw new TgError(`Telegram returned a malformed response (HTTP ${response.status})`, response.status);
  }
  if (envelope.ok) {
    if (!("result" in envelope)) {
      throw new TgError(`Telegram returned a malformed response (HTTP ${response.status})`, response.status);
    }
    return envelope.result as T;
  }
  const parameters = record(envelope.parameters);
  const code = typeof envelope.error_code === "number" ? envelope.error_code : response.status;
  const reason = typeof envelope.description === "string" ? envelope.description : `Telegram HTTP ${response.status}`;
  const retryAfter = typeof parameters?.retry_after === "number" ? parameters.retry_after : undefined;
  throw new TgError(reason, code, retryAfter);
}

export async function tg<T>(
  token: string,
  method: string,
  payload: Record<string, unknown> = {},
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(`${BOT_METHOD_ROOT}${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: requestSignal(options.timeoutMs ?? REQUEST_LIMIT_MS, options.signal),
  });
  return unwrapTelegram<T>(response);
}

export async function tgUpload<T>(
  token: string,
  method: string,
  fields: Readonly<Record<string, string | number | undefined>>,
  file: Readonly<{ field: string; path: string; filename?: string }>,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  const bytes = await readFile(file.path, { signal: options.signal });
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.set(key, String(value));
  }
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  form.set(file.field, new Blob([arrayBuffer]), file.filename ?? basename(file.path));
  const response = await fetch(`${BOT_METHOD_ROOT}${token}/${method}`, {
    method: "POST",
    body: form,
    signal: requestSignal(options.timeoutMs ?? REQUEST_LIMIT_MS, options.signal),
  });
  return unwrapTelegram<T>(response);
}

export async function tgUploadMany<T>(
  token: string,
  method: string,
  fields: Readonly<Record<string, string | number | undefined>>,
  files: readonly Readonly<{ field: string; path: string; filename?: string }>[],
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  const bytes = await Promise.all(files.map((file) => readFile(file.path, { signal: options.signal })));
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.set(key, String(value));
  }
  for (const [index, file] of files.entries()) {
    const content = bytes[index]!;
    const arrayBuffer = content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer;
    form.set(file.field, new Blob([arrayBuffer]), file.filename ?? basename(file.path));
  }
  const response = await fetch(`${BOT_METHOD_ROOT}${token}/${method}`, {
    method: "POST",
    body: form,
    signal: requestSignal(options.timeoutMs ?? REQUEST_LIMIT_MS, options.signal),
  });
  return unwrapTelegram<T>(response);
}

export async function downloadFileBytes(
  token: string,
  filePath: string,
  options: { readonly maxBytes?: number; readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? DOWNLOAD_LIMIT_BYTES;
  const response = await fetch(`${BOT_FILE_ROOT}${token}/${filePath.replace(/^\/+/, "")}`, {
    signal: requestSignal(options.timeoutMs ?? REQUEST_LIMIT_MS, options.signal),
  });
  if (!response.ok) throw new TgError(`Telegram file HTTP ${response.status}`, response.status);
  const announced = Number(response.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > maxBytes) {
    throw new TgError(`Telegram file exceeds ${maxBytes} bytes`, 413);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new TgError(`Telegram file exceeds ${maxBytes} bytes`, 413);
  return bytes;
}

function retryDelay(error: unknown, attempt: number): number | undefined {
  if (error instanceof TgError) {
    if (error.code === 429) return Math.min((error.retryAfter ?? 1) * 1_000 + 250, RETRY_CAP_MS);
    if (error.code === 408 || error.code >= 500) return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
    return undefined;
  }
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || NETWORK_FAILURE.test(`${error.name}: ${error.message}`))
  ) {
    return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
  }
  return undefined;
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortValue(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortValue(signal));
      },
      { once: true },
    );
  });
}

export async function withTelegramRetry<T>(
  operation: () => Promise<T>,
  options: {
    readonly sleep?: (ms: number) => Promise<void>;
    readonly log?: Logger;
    readonly signal?: AbortSignal;
  } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      const wait = retryDelay(error, attempt);
      if (wait === undefined || attempt >= RETRY_LIMIT) throw error;
      options.log?.warn(`[telegram] ${error instanceof Error ? error.message : String(error)}; retrying in ${wait}ms`);
      if (options.sleep) {
        await Promise.race([
          options.sleep(wait),
          ...(options.signal === undefined
            ? []
            : [
                new Promise<never>((_resolve, reject) => {
                  options.signal!.addEventListener("abort", () => reject(abortValue(options.signal!)), { once: true });
                }),
              ]),
        ]);
      } else {
        await pause(wait, options.signal);
      }
    }
  }
}

export function isMissingThreadError(error: unknown): boolean {
  return (
    error instanceof TgError && error.code === 400 && /message thread not found|topic_id_invalid/i.test(error.message)
  );
}

export async function webhookConflictHint(token: string): Promise<string | undefined> {
  try {
    const info = await tg<{ url?: unknown; pending_update_count?: unknown }>(
      token,
      "getWebhookInfo",
      {},
      { timeoutMs: 10_000 },
    );
    if (typeof info.url !== "string" || info.url.length === 0) return undefined;
    const pending =
      typeof info.pending_update_count === "number" ? ` (${info.pending_update_count} queued update(s))` : "";
    return `Telegram webhook ${info.url} is active${pending}; remove it before using long polling.`;
  } catch {
    return undefined;
  }
}

export type LockOwner = Readonly<{
  pid: number;
  nonce: string;
  startedAt: number;
  heartbeatAt: number;
}>;

export type LockAttempt = Readonly<{ ok: true }> | Readonly<{ ok: false; holder: number }>;

export function telegramPollLockPath(stateDir: string, account: string): string {
  return join(stateDir, `telegram-${account.replace(/[^A-Za-z0-9._-]/g, "_")}.poll.lock`);
}

function ownerLocation(lockPath: string): string {
  try {
    return statSync(lockPath).isDirectory() ? join(lockPath, OWNER_FILENAME) : lockPath;
  } catch {
    return join(lockPath, OWNER_FILENAME);
  }
}

function validOwner(value: unknown): LockOwner | undefined {
  const item = record(value);
  if (item === undefined) return undefined;
  if (!Number.isSafeInteger(item.pid) || (item.pid as number) <= 0) return undefined;
  if (typeof item.nonce !== "string" || item.nonce.length < 1) return undefined;
  if (typeof item.startedAt !== "number" || typeof item.heartbeatAt !== "number") return undefined;
  return {
    pid: item.pid as number,
    nonce: item.nonce,
    startedAt: item.startedAt,
    heartbeatAt: item.heartbeatAt,
  };
}

export function readLockOwner(lockPath: string): LockOwner | undefined {
  try {
    return validOwner(JSON.parse(readFileSync(ownerLocation(lockPath), "utf8")));
  } catch {
    return undefined;
  }
}

function liveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function storeOwner(lockPath: string, owner: LockOwner): void {
  const target = join(lockPath, OWNER_FILENAME);
  const temporary = join(lockPath, `.${OWNER_FILENAME}.${process.pid}.${randomBytes(4).toString("hex")}`);
  writeFileSync(temporary, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  renameSync(temporary, target);
}

function freshOwnerlessClaim(lockPath: string, now: number): boolean {
  try {
    return now - statSync(lockPath).mtimeMs < CLAIM_GRACE_MS;
  } catch {
    return false;
  }
}

function reapLock(lockPath: string): boolean {
  const grave = `${lockPath}.stale.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    renameSync(lockPath, grave);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") return false;
    throw error;
  }
  rmSync(grave, { recursive: true, force: true });
  return true;
}

export function acquireLock(
  lockPath: string,
  claim: Readonly<{ pid?: number; nonce?: string; startedAt?: number }> = {},
): LockAttempt {
  const pid = claim.pid ?? process.pid;
  const nonce = claim.nonce ?? PROCESS_NONCE;
  const startedAt = claim.startedAt ?? Date.now();
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        storeOwner(lockPath, { pid, nonce, startedAt, heartbeatAt: startedAt });
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return { ok: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const owner = readLockOwner(lockPath);
    if (owner !== undefined && liveProcess(owner.pid)) return { ok: false, holder: owner.pid };
    if (owner === undefined && freshOwnerlessClaim(lockPath, Date.now())) return { ok: false, holder: 0 };
    reapLock(lockPath);
  }
  const holder = readLockOwner(lockPath)?.pid ?? 0;
  return { ok: false, holder };
}

export function releaseLock(lockPath: string, pid = process.pid, nonce = PROCESS_NONCE): void {
  const owner = readLockOwner(lockPath);
  if (owner?.pid !== pid || owner.nonce !== nonce) return;
  rmSync(lockPath, { recursive: true, force: true });
}

export function startLockHeartbeat(
  lockPath: string,
  pid = process.pid,
  intervalMs = 15_000,
  nonce = PROCESS_NONCE,
): () => void {
  const timer = setInterval(() => {
    const owner = readLockOwner(lockPath);
    if (owner?.pid !== pid || owner.nonce !== nonce) return;
    try {
      storeOwner(lockPath, { ...owner, heartbeatAt: Date.now() });
    } catch {
      // The next tick retries unless ownership has changed.
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export type UpdateHandler = (update: TgUpdate) => void | Promise<void>;

export class Poller {
  #active = false;
  #abort: AbortController | undefined;
  #completion: Promise<void> = Promise.resolve();

  start(token: string, handle: UpdateHandler, log?: Logger): void {
    if (this.#active) throw new Error("Telegram poller is already running");
    this.#active = true;
    this.#abort = new AbortController();
    this.#completion = this.#loop(token, handle, log, this.#abort.signal);
  }

  stop(): void {
    this.#active = false;
    this.#abort?.abort(new DOMException("Telegram poller stopped", "AbortError"));
  }

  done(): Promise<void> {
    return this.#completion;
  }

  async #loop(token: string, handle: UpdateHandler, log: Logger | undefined, signal: AbortSignal): Promise<void> {
    let offset = 0;
    let failures = 0;
    let conflicts = 0;
    while (this.#active && !signal.aborted) {
      try {
        const updates = await tg<readonly TgUpdate[]>(
          token,
          "getUpdates",
          {
            offset,
            timeout: 30,
            allowed_updates: ["message", "edited_message", "callback_query", "stopped_message_generation"],
          },
          { timeoutMs: 35_000, signal },
        );
        failures = 0;
        conflicts = 0;
        for (const update of updates) {
          await handle(update);
          offset = Math.max(offset, update.update_id + 1);
          if (!this.#active) break;
        }
      } catch (error) {
        if (!this.#active || signal.aborted) break;
        if (error instanceof TgError && error.code === 409) {
          conflicts += 1;
          if (conflicts % 8 === 0) {
            const hint = await webhookConflictHint(token);
            log?.warn(
              `[telegram] ${hint ?? "Telegram rejected long polling because another poller or webhook is active; retrying."}`,
            );
          }
        } else {
          conflicts = 0;
          log?.warn(`[telegram] poll failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const wait = Math.min(RETRY_BASE_MS * 2 ** Math.min(failures, 5), RETRY_CAP_MS);
        failures += 1;
        try {
          await pause(wait, signal);
        } catch {
          break;
        }
      }
    }
    this.#active = false;
  }
}
