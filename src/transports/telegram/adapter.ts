import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  Poller,
  acquireLock,
  downloadFileBytes,
  releaseLock,
  startLockHeartbeat,
  tg,
  type Logger,
  type TgCallbackQuery,
  type TgMessage,
  type TgMessageGenerationStopped,
  type TgUpdate,
  withRateLimit,
} from "../../api";
import type { GatewayStore, PendingInteraction } from "../../gateway-store";
import type {
  ConversationAddress,
  DeliveryContext,
  InboundEnvelope,
  MessageAttachment,
  OutboundContent,
  OutboundReceipt,
  Reaction,
  TransportAdapter,
  TransportCapabilities,
  TransportStartContext,
  UiRequest,
  UiResponse,
  UiResponseFor,
} from "../../gateway-types";
import { INBOX_MAX_FILE_BYTES, storeInboxFile } from "../../inbox";
import { Outbound, telegramDraftId, type TelegramCall, type TelegramUpload } from "../../outbound";

const execFileAsync = promisify(execFile);
const DEFAULT_UI_TIMEOUT_MS = 5 * 60 * 1000;
const CALLBACK_PREFIX = "ompui";
const TASK_STOP_CALLBACK = "ompctl:stop";
const SELECT_PAGE_SIZE = 8;

export interface TelegramPoller {
  start(
    token: string,
    onUpdate: (update: TgUpdate) => void | Promise<void>,
    onFatal: (reason: string) => void,
    logger?: Logger,
  ): void;
  stop(): void;
  done(): Promise<void>;
}

export interface TelegramApiSeams {
  readonly poller?: TelegramPoller;
  readonly callTelegram?: TelegramCall;
  readonly uploadTelegram?: TelegramUpload;
  readonly downloadFileBytes?: (token: string, filePath: string) => Promise<Uint8Array>;
  readonly acquireLock?: (lockPath: string) => { readonly ok: true } | { readonly ok: false; readonly holder: number };
  readonly releaseLock?: (lockPath: string) => void;
  readonly startLockHeartbeat?: (lockPath: string) => () => void;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly transcribe?: (command: readonly string[], file: string, signal?: AbortSignal) => Promise<string>;
}

export interface TelegramTransportAdapterOptions {
  readonly token: string;
  readonly account?: string;
  readonly stateDir: string;
  readonly store: Pick<GatewayStore, "getCheckpoint" | "setCheckpoint" | "putPendingInteraction" | "deletePendingInteraction">;
  readonly transcribeCommand?: readonly string[];
  readonly logger?: Logger;
  readonly api?: TelegramApiSeams;
  readonly uiTimeoutMs?: number;
  readonly commands?: readonly { readonly command: string; readonly description: string }[];
}

type PendingKind = "confirm" | "select" | "input" | "editor";

interface PendingUi {
  readonly id: string;
  readonly kind: PendingKind;
  readonly address: ConversationAddress;
  readonly title: string;
  readonly delivery: DeliveryContext;
  readonly options: readonly string[];
  readonly labels: readonly string[];
  readonly descriptions: readonly (string | undefined)[];
  readonly multiSelect: boolean;
  readonly selected: Set<number>;
  readonly resolve: (response: UiResponse) => void;
  page: number;
  message?: OutboundReceipt;
  timer?: NodeJS.Timeout;
  removeAbortListener?: () => void;
}

interface PendingDraft {
  readonly address: ConversationAddress;
  readonly delivery: DeliveryContext;
}

interface Surface {
  title: string;
  editorText: string;
  readonly statuses: Map<string, string>;
  readonly widgets: Map<string, readonly string[]>;
  message?: OutboundReceipt;
  delivery?: DeliveryContext;
  stopControlVisible?: boolean;
}

interface MediaSpec {
  readonly fileId: string;
  readonly uniqueId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size?: number;
  readonly voice: boolean;
}

function sameAddress(left: ConversationAddress, right: ConversationAddress): boolean {
  return (
    left.transport === right.transport &&
    left.account === right.account &&
    left.channel === right.channel &&
    left.thread === right.thread
  );
}

function sourceFor(update: TgUpdate): TgMessage | undefined {
  if (update.message) return update.message;
  if (update.edited_message) return { ...update.edited_message, edited_flag: true };
  return undefined;
}

function addressFor(message: Pick<TgMessage, "chat" | "is_topic_message" | "message_thread_id">, account: string): ConversationAddress {
  return {
    transport: "telegram",
    account,
    channel: String(message.chat.id),
    ...(message.is_topic_message && message.message_thread_id !== undefined ? { thread: String(message.message_thread_id) } : {}),
  };
}

function identityFor(userId: number, account: string): InboundEnvelope["identity"] {
  return { transport: "telegram", account, subject: String(userId) };
}

function safeFilename(name: string): string {
  const finalSegment = name.replaceAll("\\", "/").split("/").at(-1) ?? "attachment";
  const normalized = finalSegment.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return (normalized || "attachment").slice(0, 120);
}

function mediaFor(message: TgMessage): MediaSpec | undefined {
  const photo = message.photo?.at(-1);
  if (photo) {
    return {
      fileId: photo.file_id,
      uniqueId: photo.file_unique_id,
      name: `photo-${photo.file_unique_id}.jpg`,
      mediaType: "image/jpeg",
      size: photo.file_size,
      voice: false,
    };
  }
  if (message.document) {
    return {
      fileId: message.document.file_id,
      uniqueId: message.document.file_unique_id,
      name: message.document.file_name ?? `document-${message.document.file_unique_id}`,
      mediaType: message.document.mime_type ?? "application/octet-stream",
      size: message.document.file_size,
      voice: false,
    };
  }
  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      uniqueId: message.audio.file_unique_id,
      name: message.audio.file_name ?? `audio-${message.audio.file_unique_id}.mp3`,
      mediaType: message.audio.mime_type ?? "audio/mpeg",
      size: message.audio.file_size,
      voice: false,
    };
  }
  if (message.video) {
    return {
      fileId: message.video.file_id,
      uniqueId: message.video.file_unique_id,
      name: message.video.file_name ?? `video-${message.video.file_unique_id}.mp4`,
      mediaType: message.video.mime_type ?? "video/mp4",
      size: message.video.file_size,
      voice: false,
    };
  }
  if (message.voice) {
    return {
      fileId: message.voice.file_id,
      uniqueId: message.voice.file_unique_id,
      name: `voice-${message.voice.file_unique_id}.ogg`,
      mediaType: message.voice.mime_type ?? "audio/ogg",
      size: message.voice.file_size,
      voice: true,
    };
  }
  if (message.video_note) {
    return {
      fileId: message.video_note.file_id,
      uniqueId: message.video_note.file_unique_id,
      name: `video-note-${message.video_note.file_unique_id}.mp4`,
      mediaType: "video/mp4",
      size: message.video_note.file_size,
      voice: false,
    };
  }
  if (message.sticker) {
    return {
      fileId: message.sticker.file_id,
      uniqueId: message.sticker.file_unique_id,
      name: `sticker-${message.sticker.file_unique_id}.webp`,
      mediaType: "image/webp",
      size: message.sticker.file_size,
      voice: false,
    };
  }
  return undefined;
}

function isPublicIdentityCommand(text: string | undefined): boolean {
  return /^\/(?:start|whoami)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text ?? "");
}

function callbackData(id: string, action: string): string {
  return `${CALLBACK_PREFIX}:${id}:${action}`;
}

/** Transport-neutral gateway adapter for Telegram Bot API long polling. */
export class TelegramTransportAdapter implements TransportAdapter {
  readonly id: string;
  readonly capabilities: TransportCapabilities = {
    streamingUpdates: true,
    buttons: true,
    multiSelect: true,
    textInput: true,
    attachments: true,
    reactions: true,
    threads: true,
    // Logical input bound; Outbound enforces Telegram's 4096-code-unit native segments.
    maxMessageLength: Number.MAX_SAFE_INTEGER,
  };

  readonly #token: string;
  readonly #account: string;
  readonly #checkpointKey: string;
  readonly #stateDir: string;
  readonly #inboxDir: string;
  readonly #store: TelegramTransportAdapterOptions["store"];
  readonly #logger?: Logger;
  readonly #poller: TelegramPoller;
  readonly #callTelegram: TelegramCall;
  readonly #download: (token: string, filePath: string) => Promise<Uint8Array>;
  readonly #acquireLock: NonNullable<TelegramApiSeams["acquireLock"]>;
  readonly #releaseLock: NonNullable<TelegramApiSeams["releaseLock"]>;
  readonly #startLockHeartbeat: NonNullable<TelegramApiSeams["startLockHeartbeat"]>;
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #transcribeCommand?: readonly string[];
  readonly #transcribe?: TelegramApiSeams["transcribe"];
  readonly #uiTimeoutMs: number;
  readonly #commands: readonly { readonly command: string; readonly description: string }[];
  readonly #outbound: Outbound;
  readonly #pending = new Map<string, PendingUi>();
  readonly #surfaces = new Map<string, Surface>();
  readonly #drafts = new Map<number, PendingDraft>();
  readonly #inflight = new Map<number, Promise<void>>();
  readonly #receivedUpdateIds: number[] = [];
  readonly #completedUpdateIds = new Set<number>();
  #startContext: TransportStartContext | undefined;
  #releaseHeartbeat: (() => void) | undefined;
  #lockPath: string | undefined;
  #stopping = false;

  constructor(options: TelegramTransportAdapterOptions) {
    if (!options.token) throw new Error("Telegram bot token is required");
    if (!options.stateDir) throw new Error("Telegram stateDir is required");
    this.#token = options.token;
    this.#account = options.account ?? "default";
    this.id = "telegram";
    this.#checkpointKey = this.#account === "default" ? "update_id" : `update_id:${this.#account}`;
    this.#stateDir = resolve(options.stateDir);
    this.#inboxDir = resolve(this.#stateDir, "inbox");
    this.#store = options.store;
    this.#logger = options.logger;
    this.#poller = options.api?.poller ?? new Poller();
    this.#callTelegram =
      options.api?.callTelegram ??
      ((method, payload, requestOptions) => tg(this.#token, method, payload, { signal: requestOptions?.signal }));
    this.#download = options.api?.downloadFileBytes ?? downloadFileBytes;
    this.#acquireLock = options.api?.acquireLock ?? acquireLock;
    this.#releaseLock = options.api?.releaseLock ?? releaseLock;
    this.#startLockHeartbeat = options.api?.startLockHeartbeat ?? startLockHeartbeat;
    this.#now = options.api?.now ?? Date.now;
    this.#randomId = options.api?.randomId ?? (() => randomBytes(12).toString("base64url"));
    this.#transcribeCommand = options.transcribeCommand;
    this.#transcribe = options.api?.transcribe;
    this.#uiTimeoutMs = options.uiTimeoutMs ?? DEFAULT_UI_TIMEOUT_MS;
    this.#commands = (options.commands ?? [])
      .filter(({ command, description }) => /^[a-z0-9_]{1,32}$/.test(command) && description.trim().length > 0)
      .slice(0, 100)
      .map(({ command, description }) => ({ command, description: description.trim().slice(0, 256) }));
    this.#outbound = new Outbound({
      token: this.#token,
      account: this.#account,
      logger: this.#logger,
      callTelegram: this.#callTelegram,
      uploadTelegram: options.api?.uploadTelegram,
      authorizeAddress: (address, delivery) => this.#authorizes(address, delivery),
    });
  }

  async start(context: TransportStartContext): Promise<void> {
    if (this.#startContext !== undefined) throw new Error(`Telegram adapter ${this.id} is already started`);
    await mkdir(this.#stateDir, { recursive: true, mode: 0o700 });
    const lockPath = resolve(this.#stateDir, `telegram-${safeFilename(this.#account)}.poll.lock`);
    const claimed = this.#acquireLock(lockPath);
    if (!claimed.ok) throw new Error(`Telegram account ${this.#account} is already being polled by process ${claimed.holder}`);

    this.#stopping = false;
    this.#startContext = context;
    this.#lockPath = lockPath;
    this.#releaseHeartbeat = this.#startLockHeartbeat(lockPath);
    context.signal?.addEventListener("abort", () => void this.stop(), { once: true });
    await this.#registerCommands(context.signal);
    this.#poller.start(
      this.#token,
      (update) => this.handleUpdate(update),
      (reason) => this.#logger?.error(`[telegram] ${reason}`),
      this.#logger,
    );
  }

  async #registerCommands(signal?: AbortSignal): Promise<void> {
    if (this.#commands.length === 0) return;
    try {
      await withRateLimit(
        () => this.#callTelegram("setMyCommands", { commands: this.#commands }, { signal }),
        { log: this.#logger, signal },
      );
    } catch (error) {
      this.#logger?.warn(
        `[telegram] could not register bot command menu: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#poller.stop();
    await this.#poller.done();
    await Promise.allSettled([...this.#inflight.values()]);
    await Promise.allSettled([...this.#pending.values()].map((pending) => this.#finish(pending, undefined, true)));
    this.#pending.clear();
    this.#drafts.clear();
    this.#releaseHeartbeat?.();
    this.#releaseHeartbeat = undefined;
    if (this.#lockPath) this.#releaseLock(this.#lockPath);
    this.#lockPath = undefined;
    this.#startContext = undefined;
    this.#stopping = false;
  }

  async send(
    address: ConversationAddress,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    const sent = await this.#outbound.send(address, content, context, signal);
    const draftId = telegramDraftId(sent);
    if (draftId !== undefined) this.#drafts.set(draftId, { address, delivery: context });
    return sent;
  }

  async update(
    address: ConversationAddress,
    receipt: OutboundReceipt,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    const updated = await this.#outbound.update(address, receipt, content, context, signal);
    const priorDraftId = telegramDraftId(receipt);
    const nextDraftId = telegramDraftId(updated);
    if (priorDraftId !== undefined && nextDraftId === undefined) this.#drafts.delete(priorDraftId);
    if (nextDraftId !== undefined) this.#drafts.set(nextDraftId, { address, delivery: context });
    return updated;
  }
  async finalize(
    address: ConversationAddress,
    receipt: OutboundReceipt | undefined,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<readonly OutboundReceipt[]> {
    try {
      return await this.#outbound.finalize(address, receipt, content, context, signal);
    } finally {
      const draftId = telegramDraftId(receipt);
      if (draftId !== undefined) this.#drafts.delete(draftId);
    }
  }

  async react(
    address: ConversationAddress,
    receipt: OutboundReceipt,
    reaction: Reaction,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#outbound.react(address, receipt, reaction, context, signal);
  }

  async presentUi<Request extends UiRequest>(
    address: ConversationAddress,
    request: Request,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<UiResponseFor<Request>> {
    this.#assertStarted();
    if (!this.#authorizes(address, context)) throw new Error("Telegram UI target is not authorized for this delivery context");
    signal?.throwIfAborted();

    if (request.type === "notify") {
      await this.#outbound.sendMessage(address, request.message, context, {}, signal);
      return { type: "notify", acknowledged: true } as UiResponseFor<Request>;
    }
    if (request.type === "open_url") {
      await this.#outbound.sendMessage(address, request.label ?? "Open the requested URL", context, {
        replyMarkup: { inline_keyboard: [[{ text: request.label ?? "Open URL", url: request.url }]] },
      }, signal);
      return { type: "open_url", opened: true } as UiResponseFor<Request>;
    }
    if (request.type === "status" || request.type === "widget" || request.type === "title" || request.type === "editor_text") {
      await this.#presentSurface(address, request, context, signal);
      return { type: request.type, acknowledged: true } as UiResponseFor<Request>;
    }
    return (await this.#createPending(address, request, context, signal)) as UiResponseFor<Request>;
  }

  /** Handles one Telegram update; public for deterministic adapter tests and webhook bridges. */
  async handleUpdate(update: TgUpdate): Promise<void> {
    const checkpoint = this.#checkpoint();
    if (this.#completedUpdateIds.has(update.update_id)) return;
    if (update.update_id <= checkpoint) return;
    const inFlight = this.#inflight.get(update.update_id);
    if (inFlight) return inFlight;

    const work = this.#handleUpdate(update);
    this.#inflight.set(update.update_id, work);
    if (!this.#receivedUpdateIds.includes(update.update_id)) {
      const insertAt = this.#receivedUpdateIds.findIndex((id) => id > update.update_id);
      if (insertAt === -1) this.#receivedUpdateIds.push(update.update_id);
      else this.#receivedUpdateIds.splice(insertAt, 0, update.update_id);
    }
    try {
      await work;
      this.#completedUpdateIds.add(update.update_id);
      // Persist only the completed prefix: a later success must never skip an
      // earlier failed update when the process restarts.
      this.#checkpointCompletedUpdates();
    } finally {
      this.#inflight.delete(update.update_id);
    }
  }

  statusText(): string {
    const surfaces = [...this.#surfaces.values()];
    if (surfaces.length === 0) return "Telegram UI ready";
    return surfaces.map((surface) => this.#surfaceText(surface)).join("\n\n");
  }

  async #handleUpdate(update: TgUpdate): Promise<void> {
    if (update.stopped_message_generation) {
      await this.#handleGenerationStopped(update.stopped_message_generation, update.update_id);
      return;
    }
    if (update.callback_query) {
      if (await this.#handleCallback(update.callback_query)) return;
      return;
    }
    const message = sourceFor(update);
    if (!message || message.from?.is_bot || !message.from) return;
    if (await this.#handleReply(message)) return;

    const context = this.#assertStarted();
    if (isPublicIdentityCommand(message.text)) {
      const resolved = await context.resolveIdentity(identityFor(message.from.id, this.#account), context.signal);
      if (resolved === undefined) {
        await this.#sendUnknownIdentityGuidance(message);
        return;
      }
    }

    const attachment = await this.#attachmentFor(message, context.signal);
    const transcript = attachment?.voice ? await this.#transcript(attachment.path, context.signal) : undefined;
    const text = [message.text ?? message.caption, transcript].filter((value): value is string => Boolean(value)).join("\n\n") || undefined;
    const address = addressFor(message, this.#account);
    const envelope: InboundEnvelope = {
      id: `telegram:${this.#account}:${message.chat.id}:${message.message_id}`,
      sentAt: message.date * 1000,
      identity: identityFor(message.from.id, this.#account),
      address,
      content: {
        ...(text === undefined ? {} : { text }),
        ...(attachment === undefined ? {} : { attachments: [attachment.attachment] }),
      },
      ...(message.reply_to_message === undefined ? {} : { replyTo: { transport: "telegram", messageId: String(message.reply_to_message.message_id) } }),
      sourceReceipt: { transport: "telegram", messageId: String(message.message_id) },
      edited: message.edited_flag === true,
    };
    await context.receive(envelope, context.signal);
  }

  async #handleGenerationStopped(stopped: TgMessageGenerationStopped, updateId: number): Promise<void> {
    if (stopped.chat.type !== "private") return;
    const pending = this.#drafts.get(stopped.draft_id);
    if (!pending) return;
    const address: ConversationAddress = {
      transport: "telegram",
      account: this.#account,
      channel: String(stopped.chat.id),
      ...(stopped.message_thread_id === undefined ? {} : { thread: String(stopped.message_thread_id) }),
    };
    if (!sameAddress(address, pending.address)) return;

    const context = this.#assertStarted();
    const identity = identityFor(stopped.chat.id, this.#account);
    const principal = await context.resolveIdentity(identity, context.signal);
    if (principal?.id !== pending.delivery.principal.id) return;

    this.#drafts.delete(stopped.draft_id);
    await context.receive(
      {
        id: `telegram:${this.#account}:draft-stop:${stopped.draft_id}:${updateId}`,
        sentAt: this.#now(),
        identity,
        address,
        content: { text: "/stop" },
      },
      context.signal,
    );
  }

  async #handleCallback(query: TgCallbackQuery): Promise<boolean> {
    const data = query.data;
    if (data === TASK_STOP_CALLBACK) return this.#handleTaskStop(query);
    if (!data?.startsWith(`${CALLBACK_PREFIX}:`)) return false;
    const [, id, action] = data.split(":", 3);
    const pending = id === undefined ? undefined : this.#pending.get(id);
    if (!pending || !query.message || !pending.message) {
      await this.#answerCallback(query.id, "This control has expired.", true);
      return true;
    }
    const address = addressFor(query.message, this.#account);
    if (!sameAddress(address, pending.address) || query.message.message_id !== Number(pending.message.messageId)) {
      await this.#answerCallback(query.id, "This control is unavailable.", true);
      return true;
    }

    const context = this.#assertStarted();
    const resolved = await context.resolveIdentity(identityFor(query.from.id, this.#account), context.signal);
    if (resolved === undefined || resolved.id !== pending.delivery.principal.id) {
      await this.#answerCallback(query.id, "This control belongs to another user.", true);
      return true;
    }

    if (pending.kind === "confirm") {
      if (action !== "yes" && action !== "no") {
        await this.#answerCallback(query.id, "Invalid response.", true);
        return true;
      }
      await this.#answerCallback(query.id);
      await this.#finish(pending, { type: "confirm", confirmed: action === "yes" });
      return true;
    }
    if (pending.kind !== "select") {
      await this.#answerCallback(query.id, "Reply to the prompt instead.", true);
      return true;
    }
    if (action === "previous" || action === "next") {
      const pageCount = Math.ceil(pending.options.length / SELECT_PAGE_SIZE);
      pending.page = Math.max(0, Math.min(pageCount - 1, pending.page + (action === "next" ? 1 : -1)));
      await this.#answerCallback(query.id);
      pending.message = await this.#outbound.update(
        pending.address,
        pending.message,
        { text: this.#selectText(pending), format: "text" },
        pending.delivery,
        context.signal,
      );
      await this.#outbound.setReplyMarkup(
        pending.address,
        pending.message,
        this.#keyboard(pending),
        pending.delivery,
        context.signal,
      );
      return true;
    }
    if (pending.multiSelect && action === "done") {
      await this.#answerCallback(query.id, "Saved");
      await this.#finish(pending, {
        type: "select",
        selected: [...pending.selected].sort((left, right) => left - right).map((index) => pending.options[index]),
      });
      return true;
    }
    if (pending.multiSelect && action === "cancel") {
      await this.#answerCallback(query.id, "Cancelled");
      await this.#finish(pending, undefined, true);
      return true;
    }
    const index = Number(action);
    if (!Number.isSafeInteger(index) || index < 0 || index >= pending.options.length) {
      await this.#answerCallback(query.id, "Invalid option.", true);
      return true;
    }
    if (!pending.multiSelect) {
      await this.#answerCallback(query.id);
      await this.#finish(pending, { type: "select", selected: [pending.options[index]] });
      return true;
    }
    if (pending.selected.has(index)) pending.selected.delete(index);
    else pending.selected.add(index);
    await this.#answerCallback(query.id, pending.selected.has(index) ? "Selected" : "Removed");
    await this.#outbound.setReplyMarkup(pending.address, pending.message, this.#keyboard(pending), pending.delivery, context.signal);
    return true;
  }

  async #handleTaskStop(query: TgCallbackQuery): Promise<boolean> {
    if (!query.message) {
      await this.#answerCallback(query.id, "This control has expired.", true);
      return true;
    }
    const address = addressFor(query.message, this.#account);
    const surface = this.#surfaces.get(`${address.channel}:${address.thread ?? ""}`);
    const task = surface?.statuses.get("Task");
    if (
      !surface?.message ||
      query.message.message_id !== Number(surface.message.messageId) ||
      !task ||
      !/^(Queued|Running)(?:\n|$)/.test(task)
    ) {
      await this.#answerCallback(query.id, "This task is no longer running.", true);
      return true;
    }
    const context = this.#assertStarted();
    const identity = identityFor(query.from.id, this.#account);
    const principal = await context.resolveIdentity(identity, context.signal);
    if (!principal || principal.id !== surface.delivery?.principal.id) {
      await this.#answerCallback(query.id, "This control belongs to another user.", true);
      return true;
    }
    await context.receive({
      id: `telegram:${this.#account}:task-stop:${query.id}`,
      sentAt: this.#now(),
      identity,
      address,
      content: { text: "/stop" },
    }, context.signal);
    await this.#answerCallback(query.id, "Stop requested");
    return true;
  }

  async #handleReply(message: TgMessage): Promise<boolean> {
    const replyId = message.reply_to_message?.message_id;
    if (replyId === undefined || !message.from) return false;
    const address = addressFor(message, this.#account);
    const pending = [...this.#pending.values()].find(
      (candidate) =>
        (candidate.kind === "input" || candidate.kind === "editor") &&
        candidate.message?.messageId === String(replyId) &&
        sameAddress(candidate.address, address),
    );
    if (!pending) return false;

    const context = this.#assertStarted();
    const resolved = await context.resolveIdentity(identityFor(message.from.id, this.#account), context.signal);
    if (resolved === undefined) return false;
    if (resolved.id !== pending.delivery.principal.id) {
      await this.#outbound.sendMessage(address, "This prompt belongs to another authorized user.", pending.delivery, {}, context.signal);
      return true;
    }
    const value = message.text ?? message.caption;
    if (!value) return true;
    await this.#finish(
      pending,
      pending.kind === "input"
        ? { type: "input", cancelled: false, value }
        : { type: "editor", cancelled: false, value },
    );
    return true;
  }

  async #createPending(
    address: ConversationAddress,
    request: Extract<UiRequest, { readonly type: PendingKind }>,
    delivery: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<UiResponse> {
    if (request.type === "select" && request.options.length === 0) return { type: "select", selected: [] };
    const deferred = Promise.withResolvers<UiResponse>();
    const pending: PendingUi = {
      id: this.#randomId(),
      kind: request.type,
      address,
      title: request.title,
      delivery,
      options: request.type === "select" ? request.options.map((option) => option.value) : [],
      labels: request.type === "select" ? request.options.map((option) => option.label) : [],
      descriptions: request.type === "select" ? request.options.map((option) => option.description) : [],
      multiSelect: request.type === "select" && request.multiSelect === true,
      selected: new Set(),
      page: 0,
      resolve: deferred.resolve,
    };
    const body = pending.kind === "select" ? this.#selectText(pending) : this.#pendingText(request);
    const replyMarkup =
      pending.kind === "input" || pending.kind === "editor"
        ? { force_reply: true, selective: true, input_field_placeholder: body.slice(0, 64) }
        : this.#keyboard(pending);

    const sent = await this.#outbound.sendMessage(address, body, delivery, { replyMarkup }, signal);
    pending.message = sent;
    this.#store.putPendingInteraction(this.#storedPending(pending));
    this.#pending.set(pending.id, pending);
    if (this.#uiTimeoutMs > 0) {
      pending.timer = setTimeout(() => void this.#finish(pending, undefined, true), this.#uiTimeoutMs);
      pending.timer.unref?.();
    }
    const onAbort = () => void this.#finish(pending, undefined, true);
    if (signal?.aborted) void this.#finish(pending, undefined, true);
    else signal?.addEventListener("abort", onAbort, { once: true });
    pending.removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
    return deferred.promise;
  }

  async #presentSurface(
    address: ConversationAddress,
    request: Extract<UiRequest, { readonly type: "status" | "widget" | "title" | "editor_text" }>,
    delivery: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = `${address.channel}:${address.thread ?? ""}`;
    let surface = this.#surfaces.get(key);
    if (!surface) {
      surface = { title: "OMP", editorText: "", statuses: new Map(), widgets: new Map() };
      this.#surfaces.set(key, surface);
    }
    surface.delivery = delivery;
    if (request.type === "status") {
      if (request.text === undefined) surface.statuses.delete(request.key);
      else surface.statuses.set(request.key, request.text);
    } else if (request.type === "widget") {
      if (request.lines === undefined) surface.widgets.delete(request.key);
      else surface.widgets.set(request.key, request.lines);
    } else if (request.type === "title") surface.title = request.title;
    else surface.editorText = request.text;

    const text = this.#surfaceText(surface);
    const stopControlVisible = /^(Queued|Running)(?:\n|$)/.test(surface.statuses.get("Task") ?? "");
    const replyMarkup = stopControlVisible
      ? { inline_keyboard: [[{ text: "Stop", callback_data: TASK_STOP_CALLBACK }]] }
      : { inline_keyboard: [] };
    if (surface.message) {
      try {
        surface.message = await this.#outbound.update(address, surface.message, { text, format: "text" }, delivery, signal);
      } catch (error) {
        this.#logger?.warn(`[telegram] could not edit UI surface: ${error instanceof Error ? error.message : String(error)}`);
        surface.message = undefined;
      }
      if (surface.message) {
        if (surface.stopControlVisible !== stopControlVisible) {
          try {
            await this.#outbound.setReplyMarkup(address, surface.message, replyMarkup, delivery, signal);
          } catch (error) {
            this.#logger?.warn(`[telegram] could not edit UI controls: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        surface.stopControlVisible = stopControlVisible;
        return;
      }
    }
    surface.message = await this.#outbound.sendMessage(address, text, delivery, { replyMarkup }, signal);
    surface.stopControlVisible = stopControlVisible;
  }


  #surfaceText(surface: Surface): string {
    const lines = [`Surface: ${surface.title}`];
    for (const [key, text] of surface.statuses) lines.push(`${key}: ${text}`);
    for (const [key, widget] of surface.widgets) lines.push(`${key}: ${widget.join(" | ")}`);
    if (surface.editorText) lines.push(`Suggested input: ${surface.editorText}`);
    return lines.join("\n").slice(0, 4096);
  }

  #pendingText(request: Extract<UiRequest, { readonly type: PendingKind }>): string {
    if (request.type === "confirm") return [request.title, request.message].filter(Boolean).join("\n\n");
    if (request.type === "select") return request.title;
    if (request.type === "input") {
      return [request.title, request.prompt ?? request.placeholder ?? "Reply to this message.", request.initialValue].filter(Boolean).join("\n\n");
    }
    return [request.title, request.initialValue, "Reply to this message with the edited text."].filter(Boolean).join("\n\n");
  }

  #selectText(pending: PendingUi): string {
    const pageCount = Math.max(1, Math.ceil(pending.options.length / SELECT_PAGE_SIZE));
    const start = pending.page * SELECT_PAGE_SIZE;
    const end = Math.min(pending.options.length, start + SELECT_PAGE_SIZE);
    const lines = [
      pending.title,
      ...(pageCount > 1 ? [`Page ${pending.page + 1} of ${pageCount}`] : []),
    ];
    for (let index = start; index < end; index++) {
      const description = pending.descriptions[index];
      lines.push(`${index + 1}. ${pending.labels[index] ?? pending.options[index]}${description ? `: ${description}` : ""}`);
    }
    return lines.join("\n\n").slice(0, 4096);
  }

  #keyboard(pending: PendingUi): Record<string, unknown> {
    if (pending.kind === "confirm") {
      return {
        inline_keyboard: [
          [
            { text: "Confirm", callback_data: callbackData(pending.id, "yes") },
            { text: "Cancel", callback_data: callbackData(pending.id, "no") },
          ],
        ],
      };
    }
    const start = pending.page * SELECT_PAGE_SIZE;
    const end = Math.min(pending.options.length, start + SELECT_PAGE_SIZE);
    const rows: Array<Array<{ text: string; callback_data: string }>> = pending.options.slice(start, end).map((value, offset) => {
      const index = start + offset;
      return [
        {
          text: `${pending.multiSelect && pending.selected.has(index) ? "✓ " : ""}${(pending.labels[index] ?? value).slice(0, 48)}`,
          callback_data: callbackData(pending.id, String(index)),
        },
      ];
    });
    if (pending.options.length > SELECT_PAGE_SIZE) {
      const navigation: Array<{ text: string; callback_data: string }> = [];
      if (pending.page > 0) navigation.push({ text: "Previous", callback_data: callbackData(pending.id, "previous") });
      if ((pending.page + 1) * SELECT_PAGE_SIZE < pending.options.length) {
        navigation.push({ text: "Next", callback_data: callbackData(pending.id, "next") });
      }
      rows.push(navigation);
    }
    if (pending.multiSelect) {
      rows.push([
        { text: "Done", callback_data: callbackData(pending.id, "done") },
        { text: "Cancel", callback_data: callbackData(pending.id, "cancel") },
      ]);
    }
    return { inline_keyboard: rows };
  }

  async #finish(pending: PendingUi, response: UiResponse | undefined, cancelled = false): Promise<void> {
    if (!this.#pending.delete(pending.id)) return;
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    this.#store.deletePendingInteraction(pending.id);
    if (pending.message) {
      await this.#outbound
        .setReplyMarkup(pending.address, pending.message, { inline_keyboard: [] }, pending.delivery)
        .catch(() => undefined);
    }
    if (cancelled) {
      if (pending.kind === "confirm") pending.resolve({ type: "confirm", confirmed: false });
      else if (pending.kind === "select") pending.resolve({ type: "select", selected: [] });
      else if (pending.kind === "input") pending.resolve({ type: "input", cancelled: true });
      else pending.resolve({ type: "editor", cancelled: true });
      return;
    }
    if (response) pending.resolve(response);
  }

  #storedPending(pending: PendingUi): PendingInteraction {
    const createdAt = this.#now();
    return {
      id: pending.id,
      address: pending.address,
      kind: pending.kind,
      payload: {
        principalId: pending.delivery.principal.id,
        messageId: pending.message?.messageId ?? "",
        options: [...pending.options],
        multiSelect: pending.multiSelect,
      },
      createdAt,
      expiresAt: this.#uiTimeoutMs > 0 ? createdAt + this.#uiTimeoutMs : undefined,
    };
  }

  async #attachmentFor(
    message: TgMessage,
    signal?: AbortSignal,
  ): Promise<{ readonly attachment: MessageAttachment; readonly path: string; readonly voice: boolean } | undefined> {
    const media = mediaFor(message);
    if (!media || (media.size !== undefined && media.size > INBOX_MAX_FILE_BYTES)) {
      if (media) this.#logger?.warn(`[telegram] ignored oversized ${media.name}`);
      return undefined;
    }
    try {
      signal?.throwIfAborted();
      const rawFile = await this.#request("getFile", { file_id: media.fileId }, signal);
      if (!rawFile || typeof rawFile !== "object" || !("file_path" in rawFile) || typeof rawFile.file_path !== "string") {
        throw new Error("Telegram getFile returned no file_path");
      }
      const bytes = await this.#download(this.#token, rawFile.file_path);
      const extension = extname(media.name) || extname(rawFile.file_path) || ".bin";
      const name = `${this.#now()}-${safeFilename(media.uniqueId)}${extension}`;
      const path = await storeInboxFile(this.#inboxDir, name, bytes);
      return {
        path,
        voice: media.voice,
        attachment: { url: pathToFileURL(path).href, name: safeFilename(media.name), mediaType: media.mediaType },
      };
    } catch (error) {
      this.#logger?.warn(`[telegram] media download failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  async #transcript(path: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!this.#transcribeCommand || this.#transcribeCommand.length === 0) return undefined;
    try {
      const output = this.#transcribe
        ? await this.#transcribe(this.#transcribeCommand, path, signal)
        : await this.#runTranscription(this.#transcribeCommand, path, signal);
      const trimmed = output.trim();
      return trimmed ? `[Voice transcript: ${trimmed}]` : undefined;
    } catch (error) {
      this.#logger?.warn(`[telegram] voice transcription failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  async #runTranscription(command: readonly string[], file: string, signal?: AbortSignal): Promise<string> {
    const [executable, ...args] = command.map((part) => part.replaceAll("{file}", file));
    if (!executable) throw new Error("Telegram transcription command is empty");
    const result = await execFileAsync(executable, args, {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      signal,
    });
    return result.stdout;
  }

  async #sendUnknownIdentityGuidance(message: TgMessage): Promise<void> {
    const address = addressFor(message, this.#account);
    const context: DeliveryContext = {
      principal: { id: `telegram-unresolved:${this.#account}:${message.from!.id}`, roles: [] },
      origin: address,
    };
    await this.#outbound.sendMessage(
      address,
      `This gateway identifies Telegram users by numeric ID. Your user_id: ${message.from!.id}. Ask an administrator to authorize that ID.`,
      context,
    );
  }

  async #answerCallback(id: string, text?: string, showAlert = false): Promise<void> {
    await this.#request("answerCallbackQuery", {
      callback_query_id: id,
      ...(text === undefined ? {} : { text }),
      ...(showAlert ? { show_alert: true } : {}),
    }).catch(() => undefined);
  }

  async #request(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    return withRateLimit(() => this.#callTelegram(method, payload, { signal }), { signal, log: this.#logger });
  }

  #checkpointCompletedUpdates(): void {
    let completedCount = 0;
    let latest: number | undefined;
    for (const updateId of this.#receivedUpdateIds) {
      if (!this.#completedUpdateIds.has(updateId)) break;
      completedCount += 1;
      latest = updateId;
    }
    if (latest === undefined) return;
    this.#store.setCheckpoint(this.id, this.#checkpointKey, latest);
    const persisted = this.#receivedUpdateIds.splice(0, completedCount);
    for (const updateId of persisted) this.#completedUpdateIds.delete(updateId);
  }

  #checkpoint(): number {
    const value = this.#store.getCheckpoint(this.id, this.#checkpointKey);
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
    return -1;
  }
  #authorizes(address: ConversationAddress, delivery: DeliveryContext): boolean {
    return address.transport === "telegram" && address.account === this.#account && sameAddress(address, delivery.origin);
  }

  #assertStarted(): TransportStartContext {
    if (!this.#startContext) throw new Error(`Telegram adapter ${this.id} is not started`);
    return this.#startContext;
  }
}
