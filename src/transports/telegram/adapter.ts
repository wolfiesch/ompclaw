import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { GatewayStore, JsonValue, PendingInteraction } from "../../gateway-store";
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
import {
  acquireLock,
  downloadFileBytes,
  Poller,
  releaseLock,
  startLockHeartbeat,
  telegramPollLockPath,
  tg,
  TgError,
  type Logger,
  type TgCallbackQuery,
  type TgFileBase,
  type TgMessage,
  type TgMessageGenerationStopped,
  type TgUpdate,
  withTelegramRetry,
} from "./bot-api";
import { Outbound, telegramDraftId, type TelegramCall, type TelegramUpload } from "./delivery";
import { MAX_INBOUND_ATTACHMENT_BYTES, saveInboxAttachment } from "./inbox";
import { decodeTelegramSemanticCallback, TelegramSemanticViewReconciler } from "./semantic-views";

const executeFile = promisify(execFile);
const INTERACTION_LIFETIME_MS = 5 * 60 * 1_000;
const INTERACTION_CALLBACK = "ompui";
const STOP_CALLBACK = "ompctl:stop";
const SELECT_PAGE_SIZE = 8;
const TOPIC_NAME_LIMIT = 128;

type InteractiveRequest = Extract<UiRequest, { type: "confirm" | "select" | "input" | "editor" }>;
type InteractiveResponse = Extract<UiResponse, { type: "confirm" | "select" | "input" | "editor" }>;

export interface TelegramPoller {
  start(token: string, handleUpdate: (update: TgUpdate) => void | Promise<void>, logger?: Logger): void;
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
  readonly store: Pick<
    GatewayStore,
    | "getCheckpoint"
    | "setCheckpoint"
    | "putPendingInteraction"
    | "deletePendingInteraction"
    | "listPendingIngressCompositions"
    | "listPendingInboundMessages"
    | "getSemanticView"
    | "putSemanticView"
  >;
  readonly transcribeCommand?: readonly string[];
  readonly logger?: Logger;
  readonly api?: TelegramApiSeams;
  readonly uiTimeoutMs?: number;
  readonly commands?: readonly { readonly command: string; readonly description: string }[];
  readonly createTopicsFromRoot?: boolean;
}

interface MediaSelection {
  readonly telegramId: string;
  readonly stableId: string;
  readonly displayName: string;
  readonly mediaType: string;
  readonly declaredBytes?: number;
  readonly transcribable: boolean;
}

interface InteractiveState {
  readonly id: string;
  readonly request: InteractiveRequest;
  readonly address: ConversationAddress;
  readonly context: DeliveryContext;
  readonly principalId: string;
  readonly choices: readonly string[];
  readonly labels: readonly string[];
  readonly notes: readonly (string | undefined)[];
  readonly selected: Set<number>;
  readonly settle: (value: InteractiveResponse) => void;
  readonly reject: (error: Error) => void;
  readonly multiple: boolean;
  page: number;
  prompt?: OutboundReceipt;
  timeout?: NodeJS.Timeout;
  detachAbort?: () => void;
}

interface ControlCard {
  title: string;
  editorText: string;
  readonly statuses: Map<string, string>;
  readonly widgets: Map<string, readonly string[]>;
  receipts: readonly OutboundReceipt[];
  context?: DeliveryContext;
  stopVisible: boolean;
}

interface DraftRoute {
  readonly address: ConversationAddress;
  readonly context: DeliveryContext;
}

function sameAddress(left: ConversationAddress, right: ConversationAddress): boolean {
  return (
    left.transport === right.transport &&
    left.account === right.account &&
    left.channel === right.channel &&
    left.thread === right.thread
  );
}

function telegramAddress(
  message: Pick<TgMessage, "chat" | "is_topic_message" | "message_thread_id">,
  account: string,
  thread?: number,
): ConversationAddress {
  const topic = thread ?? (message.is_topic_message ? message.message_thread_id : undefined);
  return {
    transport: "telegram",
    account,
    channel: String(message.chat.id),
    ...(topic === undefined ? {} : { thread: String(topic) }),
  };
}

function telegramIdentity(userId: number, account: string): InboundEnvelope["identity"] {
  return { transport: "telegram", account, subject: String(userId) };
}

function updateMessage(update: TgUpdate): TgMessage | undefined {
  return update.message ?? update.edited_message;
}

const REPLY_CONTEXT_TEXT_LIMIT = 1_000;

function truncateReplyText(text: string): string {
  return text.length <= REPLY_CONTEXT_TEXT_LIMIT ? text : Array.from(text).slice(0, REPLY_CONTEXT_TEXT_LIMIT).join("");
}

function replyContextFrom(message: TgMessage): InboundEnvelope["replyContext"] | undefined {
  const reply = message.reply_to_message;
  if (!reply) return undefined;
  const author = reply.from?.first_name || (reply.from?.username === undefined ? undefined : `@${reply.from.username}`);
  const text = reply.text ?? reply.caption;
  return {
    messageId: String(reply.message_id),
    ...(author === undefined ? {} : { author }),
    ...(text === undefined ? {} : { text: truncateReplyText(text) }),
    ...(reply.from?.is_bot === undefined ? {} : { isBot: reply.from.is_bot }),
  };
}

function safeFilename(candidate: string): string {
  const leaf = basename(candidate.replaceAll("\\", "/"));
  const cleaned = leaf.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return (cleaned || "attachment.bin").slice(0, 180);
}

function topicName(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim() || "New conversation";
  return Array.from(singleLine).slice(0, TOPIC_NAME_LIMIT).join("");
}

function isBotCommand(text: string | undefined): boolean {
  return /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text?.trimStart() ?? "");
}

function storedTopicThread(value: JsonValue | undefined, messageId: number): number | undefined {
  if (value === null || typeof value !== "object" || !("messageId" in value) || !("threadId" in value))
    return undefined;
  return value.messageId === messageId && typeof value.threadId === "number" ? value.threadId : undefined;
}

function bestPhoto(photos: readonly TgFileBase[]): TgFileBase | undefined {
  return photos.reduce<TgFileBase | undefined>((winner, candidate) => {
    if (winner === undefined) return candidate;
    return (candidate.file_size ?? 0) >= (winner.file_size ?? 0) ? candidate : winner;
  }, undefined);
}

function mediaFrom(message: TgMessage): MediaSelection | undefined {
  if (message.document) {
    return {
      telegramId: message.document.file_id,
      stableId: message.document.file_unique_id,
      displayName: message.document.file_name ?? "document.bin",
      mediaType: message.document.mime_type ?? "application/octet-stream",
      declaredBytes: message.document.file_size,
      transcribable: false,
    };
  }
  if (message.voice) {
    return {
      telegramId: message.voice.file_id,
      stableId: message.voice.file_unique_id,
      displayName: "voice.ogg",
      mediaType: message.voice.mime_type ?? "audio/ogg",
      declaredBytes: message.voice.file_size,
      transcribable: true,
    };
  }
  if (message.audio) {
    return {
      telegramId: message.audio.file_id,
      stableId: message.audio.file_unique_id,
      displayName: message.audio.file_name ?? "audio.mp3",
      mediaType: message.audio.mime_type ?? "audio/mpeg",
      declaredBytes: message.audio.file_size,
      transcribable: true,
    };
  }
  if (message.video_note) {
    return {
      telegramId: message.video_note.file_id,
      stableId: message.video_note.file_unique_id,
      displayName: "video-note.mp4",
      mediaType: "video/mp4",
      declaredBytes: message.video_note.file_size,
      transcribable: true,
    };
  }
  if (message.video) {
    return {
      telegramId: message.video.file_id,
      stableId: message.video.file_unique_id,
      displayName: message.video.file_name ?? "video.mp4",
      mediaType: message.video.mime_type ?? "video/mp4",
      declaredBytes: message.video.file_size,
      transcribable: false,
    };
  }
  if (message.animation) {
    return {
      telegramId: message.animation.file_id,
      stableId: message.animation.file_unique_id,
      displayName: message.animation.file_name ?? "animation.gif",
      mediaType: message.animation.mime_type ?? "image/gif",
      declaredBytes: message.animation.file_size,
      transcribable: false,
    };
  }
  if (message.sticker) {
    return {
      telegramId: message.sticker.file_id,
      stableId: message.sticker.file_unique_id,
      displayName: message.sticker.is_animated
        ? "sticker.tgs"
        : message.sticker.is_video
          ? "sticker.webm"
          : "sticker.webp",
      mediaType: message.sticker.is_animated
        ? "application/x-tgsticker"
        : message.sticker.is_video
          ? "video/webm"
          : "image/webp",
      declaredBytes: message.sticker.file_size,
      transcribable: false,
    };
  }
  const photo = bestPhoto(message.photo ?? []);
  if (photo) {
    return {
      telegramId: photo.file_id,
      stableId: photo.file_unique_id,
      displayName: "photo.jpg",
      mediaType: "image/jpeg",
      declaredBytes: photo.file_size,
      transcribable: false,
    };
  }
  return undefined;
}

function identityHelp(text: string | undefined): boolean {
  return /^\/(?:start|whoami)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text ?? "");
}

function callback(id: string, action: string): string {
  return `${INTERACTION_CALLBACK}:${id}:${action}`;
}

function cardKey(address: ConversationAddress): string {
  return `${address.channel}\n${address.thread ?? ""}`;
}

function activeTask(text: string | undefined): boolean {
  return /^(?:Queued|Working)(?:\n|$)/.test(text ?? "");
}

function assertRemoteFilePath(value: string): void {
  if (value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) {
    throw new Error("Telegram returned an unsafe file path");
  }
}

function menuCommands(
  input: readonly { readonly command: string; readonly description: string }[],
): readonly { command: string; description: string }[] {
  const unique = new Set<string>();
  const result: { command: string; description: string }[] = [];
  for (const item of input) {
    const command = item.command.trim().replace(/^\//, "");
    const description = item.description.trim().slice(0, 256);
    if (!/^[a-z0-9_]{1,32}$/.test(command) || description.length === 0 || unique.has(command)) continue;
    unique.add(command);
    result.push({ command, description });
    if (result.length === 100) break;
  }
  return result;
}

export class TelegramTransportAdapter implements TransportAdapter {
  readonly id = "telegram";
  readonly capabilities: TransportCapabilities = {
    streamingUpdates: true,
    buttons: true,
    multiSelect: true,
    textInput: true,
    attachments: true,
    reactions: true,
    threads: true,
    maxMessageLength: Number.MAX_SAFE_INTEGER,
  };

  readonly #token: string;
  readonly #account: string;
  readonly #stateDir: string;
  readonly #inboxDir: string;
  readonly #store: TelegramTransportAdapterOptions["store"];
  readonly #log: Logger | undefined;
  readonly #poller: TelegramPoller;
  readonly #call: TelegramCall;
  readonly #download: (token: string, filePath: string) => Promise<Uint8Array>;
  readonly #claimLock: NonNullable<TelegramApiSeams["acquireLock"]>;
  readonly #dropLock: NonNullable<TelegramApiSeams["releaseLock"]>;
  readonly #heartbeat: NonNullable<TelegramApiSeams["startLockHeartbeat"]>;
  readonly #clock: () => number;
  readonly #newId: () => string;
  readonly #transcriptionCommand: readonly string[] | undefined;
  readonly #transcriptionOverride: TelegramApiSeams["transcribe"];
  readonly #interactionLifetime: number;
  readonly #commands: readonly { command: string; description: string }[];
  readonly #topicsFromRoot: boolean;
  readonly #outbound: Outbound;
  readonly #semanticViews: TelegramSemanticViewReconciler;
  readonly #interactions = new Map<string, InteractiveState>();
  readonly #draftRoutes = new Map<number, DraftRoute>();
  readonly #cards = new Map<string, ControlCard>();
  readonly #activeUpdates = new Set<number>();
  readonly #updateTasks = new Set<Promise<void>>();

  #context: TransportStartContext | undefined;
  #lockPath: string | undefined;
  #stopHeartbeat: (() => void) | undefined;
  #stopTask: Promise<void> | undefined;

  constructor(options: TelegramTransportAdapterOptions) {
    if (options.token.length === 0) throw new Error("Telegram bot token is required");
    if (options.stateDir.length === 0) throw new Error("Telegram stateDir is required");
    this.#token = options.token;
    this.#account = options.account ?? "default";
    this.#stateDir = resolve(options.stateDir);
    this.#inboxDir = join(this.#stateDir, "inbox", "telegram", this.#account.replace(/[^A-Za-z0-9._-]/g, "_"));
    this.#store = options.store;
    this.#log = options.logger;
    this.#poller = options.api?.poller ?? new Poller();
    this.#call =
      options.api?.callTelegram ??
      ((method, payload = {}, request = {}) => tg(this.#token, method, payload, { signal: request.signal }));
    this.#download = options.api?.downloadFileBytes ?? downloadFileBytes;
    this.#claimLock = options.api?.acquireLock ?? acquireLock;
    this.#dropLock = options.api?.releaseLock ?? releaseLock;
    this.#heartbeat = options.api?.startLockHeartbeat ?? startLockHeartbeat;
    this.#clock = options.api?.now ?? Date.now;
    this.#newId = options.api?.randomId ?? (() => randomBytes(18).toString("base64url"));
    this.#transcriptionCommand = options.transcribeCommand;
    this.#transcriptionOverride = options.api?.transcribe;
    this.#interactionLifetime = options.uiTimeoutMs ?? INTERACTION_LIFETIME_MS;
    this.#commands = menuCommands(options.commands ?? []);
    this.#topicsFromRoot = options.createTopicsFromRoot ?? false;
    this.#outbound = new Outbound({
      token: this.#token,
      account: this.#account,
      authorizeAddress: (address, context) => this.#deliveryAllowed(address, context),
      logger: this.#log,
      callTelegram: this.#call,
      uploadTelegram: options.api?.uploadTelegram,
    });
    this.#semanticViews = new TelegramSemanticViewReconciler(this.#store, this.#outbound, this.#clock);
  }

  async start(context: TransportStartContext): Promise<void> {
    if (this.#context !== undefined) throw new Error("Telegram transport is already started");
    await mkdir(this.#inboxDir, { recursive: true, mode: 0o700 });
    const lock = telegramPollLockPath(this.#stateDir, this.#account);
    const ownership = this.#claimLock(lock);
    if (!ownership.ok) throw new Error(`Telegram account is already polled by process ${ownership.holder}`);
    this.#lockPath = lock;
    this.#context = context;
    this.#stopHeartbeat = this.#heartbeat(lock);
    try {
      if (this.#commands.length > 0) {
        try {
          await this.#telegram("setMyCommands", { commands: this.#commands }, context.signal);
        } catch (error) {
          if (context.signal?.aborted) throw error;
          if (error instanceof TgError && (error.code === 401 || error.code === 404)) throw error;
          this.#log?.warn(
            `[telegram] command menu registration failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      this.#poller.start(this.#token, (update) => this.#trackUpdate(update), this.#log);
      if (context.signal) {
        const abort = (): void => {
          void this.stop();
        };
        context.signal.addEventListener("abort", abort, { once: true });
      }
    } catch (error) {
      this.#releaseRuntimeOwnership();
      this.#context = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#context === undefined) return;
    if (this.#stopTask) return this.#stopTask;
    this.#stopTask = (async () => {
      this.#poller.stop();
      await Promise.allSettled([this.#poller.done(), ...this.#updateTasks]);
      for (const state of [...this.#interactions.values()]) {
        this.#finishInteraction(state, this.#cancelledResponse(state.request));
      }
      this.#cards.clear();
      this.#draftRoutes.clear();
      this.#releaseRuntimeOwnership();
      this.#context = undefined;
      this.#stopTask = undefined;
    })();
    return this.#stopTask;
  }

  async handleUpdate(update: TgUpdate): Promise<void> {
    const context = this.#requireContext();
    const checkpoint = this.#store.getCheckpoint(this.id, `update_id:${this.#account}`);
    if (typeof checkpoint === "number" && update.update_id <= checkpoint) return;
    if (this.#activeUpdates.has(update.update_id)) return;
    this.#activeUpdates.add(update.update_id);
    try {
      if (update.callback_query) await this.#handleCallback(update.callback_query, update.update_id, context);
      else {
        const stopped = update.stopped_message_generation;
        if (stopped) await this.#handleDraftStop(stopped, update.update_id, context);
        else {
          const message = updateMessage(update);
          if (message) await this.#handleMessage(message, update, context);
        }
      }
      this.#store.setCheckpoint(this.id, `update_id:${this.#account}`, update.update_id);
    } finally {
      this.#activeUpdates.delete(update.update_id);
    }
  }

  async send(
    address: ConversationAddress,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    const sent = await this.#outbound.send(address, content, context, signal);
    const draft = telegramDraftId(sent);
    if (draft !== undefined) this.#draftRoutes.set(draft, { address, context });
    return sent;
  }

  async typing(address: ConversationAddress, context: DeliveryContext, signal?: AbortSignal): Promise<void> {
    await this.#outbound.typing(address, context, signal);
  }

  async update(
    address: ConversationAddress,
    receipt: OutboundReceipt,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    const next = await this.#outbound.update(address, receipt, content, context, signal);
    const priorDraft = telegramDraftId(receipt);
    const nextDraft = telegramDraftId(next);
    if (priorDraft !== undefined && nextDraft === undefined) this.#draftRoutes.delete(priorDraft);
    if (nextDraft !== undefined) this.#draftRoutes.set(nextDraft, { address, context });
    return next;
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
      const draft = telegramDraftId(receipt);
      if (draft !== undefined) this.#draftRoutes.delete(draft);
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

  presentUi<Request extends UiRequest>(
    address: ConversationAddress,
    request: Request,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<UiResponseFor<Request>>;
  async presentUi(
    address: ConversationAddress,
    request: UiRequest,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<UiResponse> {
    await this.#assertUiOrigin(address, context);
    signal?.throwIfAborted();
    if (request.type === "semantic_view") {
      await this.#semanticViews.reconcile(address, context.principal.id, request.view, context, signal);
      return { type: "semantic_view", acknowledged: true };
    }
    if (request.type === "notify") {
      await this.#outbound.sendMessage(address, request.message, context, {}, signal);
      return { type: "notify", acknowledged: true };
    }
    if (request.type === "open_url") {
      await this.#outbound.sendMessage(
        address,
        request.label ?? request.url,
        context,
        {
          replyMarkup: { inline_keyboard: [[{ text: request.label ?? "Open link", url: request.url }]] },
        },
        signal,
      );
      return { type: "open_url", opened: true };
    }
    if (
      request.type === "status" ||
      request.type === "widget" ||
      request.type === "title" ||
      request.type === "editor_text"
    ) {
      await this.#updateControlCard(address, request, context, signal);
      if (request.type === "status") return { type: "status", acknowledged: true };
      if (request.type === "widget") return { type: "widget", acknowledged: true };
      if (request.type === "title") return { type: "title", acknowledged: true };
      return { type: "editor_text", acknowledged: true };
    }
    if (request.type === "select" && request.options.length === 0) {
      return { type: "select", selected: [] };
    }
    return this.#openInteraction(address, request, context, signal);
  }

  async #acknowledgeTranscription(
    message: TgMessage,
    address: ConversationAddress,
    signal?: AbortSignal,
  ): Promise<void> {
    if (message.voice === undefined && message.video_note === undefined) return;
    try {
      await this.#telegram(
        "setMessageReaction",
        {
          chat_id: message.chat.id,
          message_id: message.message_id,
          reaction: [{ type: "emoji", emoji: "👀" }],
        },
        signal,
      );
    } catch (reactionError) {
      try {
        await this.#telegram(
          "sendMessage",
          {
            chat_id: message.chat.id,
            message_thread_id: address.thread === undefined ? undefined : Number(address.thread),
            text: "Received. Transcribing your voice note now.",
          },
          signal,
        );
      } catch (messageError) {
        this.#log?.warn(
          `[telegram] voice acknowledgement failed for message ${message.message_id}: ${
            messageError instanceof Error ? messageError.message : String(messageError)
          } (reaction: ${reactionError instanceof Error ? reactionError.message : String(reactionError)})`,
        );
      }
    }
  }

  async #handleMessage(message: TgMessage, update: TgUpdate, context: TransportStartContext): Promise<void> {
    if (!message.from || message.from.is_bot) return;
    const identity = telegramIdentity(message.from.id, this.#account);
    const principal = await context.resolveIdentity(identity, context.signal);
    let address = telegramAddress(message, this.#account);
    if (!principal) {
      if (identityHelp(message.text)) await this.#sendIdentityHelp(message);
      return;
    }
    if (await this.#captureReply(message, principal.id, address)) return;
    if (this.#topicsFromRoot && message.chat.is_forum && !message.is_topic_message && !isBotCommand(message.text)) {
      const routeKey = `forum-topic:${message.chat.id}`;
      let threadId = storedTopicThread(this.#store.getCheckpoint(this.id, routeKey), message.message_id);
      if (threadId === undefined) {
        const created = await this.#telegram(
          "createForumTopic",
          {
            chat_id: message.chat.id,
            name: topicName(message.text ?? message.caption ?? ""),
          },
          context.signal,
        );
        if (
          created !== null &&
          typeof created === "object" &&
          "message_thread_id" in created &&
          typeof created.message_thread_id === "number"
        ) {
          threadId = created.message_thread_id;
          this.#store.setCheckpoint(this.id, routeKey, { messageId: message.message_id, threadId });
        }
      }
      if (threadId !== undefined) address = telegramAddress(message, this.#account, threadId);
    }
    await this.#acknowledgeTranscription(message, address, context.signal);
    const attachment = await this.#saveIncomingMedia(message, context.signal).catch((error) => {
      if (context.signal?.aborted) throw error;
      this.#log?.warn(
        `[telegram] attachment retrieval failed for message ${message.message_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    });
    const transcript = attachment?.transcribable
      ? await this.#transcribe(attachment.localPath, context.signal).catch((error) => {
          if (context.signal?.aborted) throw error;
          this.#log?.warn(
            `[telegram] transcription failed for message ${message.message_id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        })
      : undefined;
    const textParts = [message.text ?? message.caption, transcript].filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );
    const messageAttachment: MessageAttachment | undefined =
      attachment === undefined
        ? undefined
        : {
            url: pathToFileURL(attachment.localPath).href,
            name: attachment.displayName,
            mediaType: attachment.mediaType,
          };
    const replyContext = replyContextFrom(message);
    const envelope: InboundEnvelope = {
      id: `telegram:${this.#account}:${message.chat.id}:${message.message_id}`,
      sentAt: message.date * 1_000,
      identity,
      address,
      content: {
        ...(textParts.length === 0 ? {} : { text: textParts.join("\n\n") }),
        ...(messageAttachment === undefined ? {} : { attachments: [messageAttachment] }),
      },
      ...(message.reply_to_message === undefined
        ? {}
        : {
            replyTo: { transport: "telegram", messageId: String(message.reply_to_message.message_id) },
            ...(replyContext === undefined ? {} : { replyContext }),
          }),
      composition: {
        kind: message.media_group_id === undefined ? "text" : "media",
        ...(message.media_group_id === undefined ? {} : { groupId: message.media_group_id }),
        order: message.message_id,
      },
      sourceReceipt: { transport: "telegram", messageId: String(message.message_id) },
      edited: update.edited_message !== undefined,
    };
    if (envelope.content.text === undefined && envelope.content.attachments === undefined) return;
    await context.receive(envelope, context.signal);
  }

  async #handleCallback(query: TgCallbackQuery, updateId: number, context: TransportStartContext): Promise<void> {
    const acknowledge = (text?: string, alert = false): Promise<unknown> =>
      this.#telegram(
        "answerCallbackQuery",
        {
          callback_query_id: query.id,
          ...(text === undefined ? {} : { text }),
          ...(alert ? { show_alert: true } : {}),
        },
        context.signal,
      );
    if (!query.message || !query.data) {
      await acknowledge("This control is no longer available.");
      return;
    }
    const identity = telegramIdentity(query.from.id, this.#account);
    const principal = await context.resolveIdentity(identity, context.signal);
    if (!principal) {
      await acknowledge("Not authorized.", true);
      return;
    }
    const address = telegramAddress(query.message, this.#account);
    const callbackContext: DeliveryContext = { principal, origin: address };
    if (query.data.startsWith("s1.")) {
      let callbackData: ReturnType<typeof decodeTelegramSemanticCallback>;
      try {
        callbackData = decodeTelegramSemanticCallback(query.data);
      } catch {
        await acknowledge("Invalid control.");
        return;
      }
      const current = this.#store.getSemanticView(address, callbackData.viewId);
      const messageId = String(query.message.message_id);
      if (current === undefined || !current.receipts.some((receipt) => receipt.messageId === messageId)) {
        await acknowledge("This control has expired.");
        return;
      }
      if (current.principalId !== principal.id) {
        await acknowledge("This control belongs to another user.", true);
        return;
      }
      if (callbackData.viewVersion !== current.view.version) {
        await this.#semanticViews.refresh(address, callbackData.viewId, callbackContext, context.signal);
        await acknowledge("Updated to the latest controls.");
        return;
      }
      const action = current.view.actions.find(
        (candidate) => candidate.id === callbackData.actionId && candidate.enabled !== false,
      );
      if (action?.command === undefined) {
        await acknowledge("This control is no longer available.");
        return;
      }
      await acknowledge(action.label);
      await context.receive(
        {
          id: `telegram:${this.#account}:semantic:${updateId}`,
          sentAt: this.#clock(),
          identity,
          address,
          content: { text: action.command },
          sourceReceipt: { transport: "telegram", messageId },
          edited: false,
        },
        context.signal,
      );
      return;
    }
    if (query.data === STOP_CALLBACK) {
      const card = this.#cards.get(cardKey(address));
      const receipt = card?.receipts.at(-1);
      if (!card || !receipt || receipt.messageId !== String(query.message.message_id)) {
        await acknowledge("This control has expired.");
        return;
      }
      if (card.context?.principal.id !== principal.id) {
        await acknowledge("This control belongs to another user.", true);
        return;
      }
      await context.receive(
        {
          id: `telegram:${this.#account}:callback:${updateId}`,
          sentAt: this.#clock(),
          identity,
          address,
          content: { text: "/stop" },
          sourceReceipt: { transport: "telegram", messageId: String(query.message.message_id) },
          edited: false,
        },
        context.signal,
      );
      await acknowledge("Stopping…");
      return;
    }
    const prefix = `${INTERACTION_CALLBACK}:`;
    if (!query.data.startsWith(prefix)) {
      await acknowledge("Unknown control.");
      return;
    }
    const remainder = query.data.slice(prefix.length);
    const separator = remainder.indexOf(":");
    if (separator < 1) {
      await acknowledge("Invalid control.");
      return;
    }
    const id = remainder.slice(0, separator);
    const action = remainder.slice(separator + 1);
    const state = this.#interactions.get(id);
    if (!state) {
      await acknowledge("This prompt has expired.");
      return;
    }
    if (state.principalId !== principal.id || !sameAddress(state.address, address)) {
      await acknowledge("This prompt belongs to another user.", true);
      return;
    }
    await this.#applyInteractionAction(state, action, query, acknowledge);
  }

  async #handleDraftStop(
    event: TgMessageGenerationStopped,
    updateId: number,
    context: TransportStartContext,
  ): Promise<void> {
    const route = this.#draftRoutes.get(event.draft_id);
    if (!route) return;
    const identity = telegramIdentity(event.chat.id, this.#account);
    const principal = await context.resolveIdentity(identity, context.signal);
    if (!principal || principal.id !== route.context.principal.id) return;
    const address = telegramAddress(event, this.#account, event.message_thread_id);
    if (!sameAddress(address, route.address)) return;
    this.#draftRoutes.delete(event.draft_id);
    await context.receive(
      {
        id: `telegram:${this.#account}:draft-stop:${event.draft_id}:${updateId}`,
        sentAt: this.#clock(),
        identity,
        address,
        content: { text: "/stop" },
        edited: false,
      },
      context.signal,
    );
  }

  async #saveIncomingMedia(
    message: TgMessage,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly localPath: string;
        readonly displayName: string;
        readonly mediaType: string;
        readonly transcribable: boolean;
      }
    | undefined
  > {
    const media = mediaFrom(message);
    if (!media) return undefined;
    if (media.declaredBytes !== undefined && media.declaredBytes > MAX_INBOUND_ATTACHMENT_BYTES) {
      this.#log?.warn(
        `[telegram] ignored ${media.displayName}: declared size ${media.declaredBytes} exceeds the inbound limit`,
      );
      return undefined;
    }
    const file = await this.#telegram("getFile", { file_id: media.telegramId }, signal);
    if (file === null || typeof file !== "object" || !("file_path" in file) || typeof file.file_path !== "string") {
      throw new Error("Telegram getFile returned no file path");
    }
    assertRemoteFilePath(file.file_path);
    const bytes = await this.#download(this.#token, file.file_path);
    const displayName = safeFilename(media.displayName);
    const diskName = `${this.#newId()}-${safeFilename(media.stableId)}-${displayName}`;
    const localPath = await saveInboxAttachment(this.#inboxDir, {
      filename: diskName,
      bytes,
      protect: this.#protectedInboxPaths(),
    });
    return { localPath, displayName, mediaType: media.mediaType, transcribable: media.transcribable };
  }

  #protectedInboxPaths(): ReadonlySet<string> {
    const paths = new Set<string>();
    const protect = (attachments: readonly MessageAttachment[] | undefined): void => {
      for (const attachment of attachments ?? []) {
        try {
          const url = new URL(attachment.url);
          if (url.protocol === "file:") paths.add(resolve(fileURLToPath(url)));
        } catch {
          // Ignore malformed attachment URLs while preserving valid inbox paths.
        }
      }
    };
    for (const pending of this.#store.listPendingInboundMessages()) {
      protect(pending.message.content.attachments);
    }
    for (const composition of this.#store.listPendingIngressCompositions()) {
      for (const fragment of composition.fragments) protect(fragment.content.attachments);
    }
    return paths;
  }

  async #transcribe(path: string, signal?: AbortSignal): Promise<string | undefined> {
    const command = this.#transcriptionCommand;
    if (!command || command.length === 0) return undefined;
    try {
      const output = this.#transcriptionOverride
        ? await this.#transcriptionOverride(command, path, signal)
        : await this.#runTranscriber(command, path, signal);
      const trimmed = output.trim();
      return trimmed.length === 0 ? undefined : `[Voice transcript: ${trimmed}]`;
    } catch (error) {
      this.#log?.warn(`[telegram] transcription failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  async #runTranscriber(command: readonly string[], path: string, signal?: AbortSignal): Promise<string> {
    const needsDirectory = command.some((part) => part.includes("{outputDir}"));
    const directory = needsDirectory ? await mkdtemp(join(tmpdir(), "ompclaw-transcript-")) : undefined;
    try {
      const expanded = command.map((part) =>
        part.replaceAll("{file}", path).replaceAll("{outputDir}", directory ?? ""),
      );
      const program = expanded[0];
      if (!program) throw new Error("Telegram transcription command is empty");
      const completed = await executeFile(program, expanded.slice(1), {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        signal,
      });
      if (!directory) return completed.stdout;
      return readFile(join(directory, `${basename(path, extname(path))}.txt`), "utf8");
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  #openInteraction(
    address: ConversationAddress,
    request: InteractiveRequest,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<InteractiveResponse> {
    return new Promise<InteractiveResponse>((resolvePromise, rejectPromise) => {
      const id = this.#newId();
      const choices = request.type === "select" ? request.options.map((option) => option.value) : [];
      const labels = request.type === "select" ? request.options.map((option) => option.label) : [];
      const notes = request.type === "select" ? request.options.map((option) => option.description) : [];
      const state: InteractiveState = {
        id,
        request,
        address,
        context,
        principalId: context.principal.id,
        choices,
        labels,
        notes,
        selected: new Set<number>(),
        settle: resolvePromise,
        reject: rejectPromise,
        multiple: request.type === "select" && request.multiSelect === true,
        page: 0,
      };
      this.#interactions.set(id, state);
      this.#store.putPendingInteraction(this.#pendingInteraction(state));
      state.timeout = setTimeout(
        () => this.#finishInteraction(state, this.#cancelledResponse(request)),
        this.#interactionLifetime,
      );
      state.timeout.unref?.();
      if (signal) {
        const abort = (): void => this.#finishInteraction(state, this.#cancelledResponse(request));
        signal.addEventListener("abort", abort, { once: true });
        state.detachAbort = () => signal.removeEventListener("abort", abort);
      }
      void this.#sendInteractionPrompt(state, signal).catch((error) => this.#failInteraction(state, error));
    });
  }

  #pendingInteraction(state: InteractiveState): PendingInteraction {
    const payload: JsonValue = {
      title: state.request.title,
      principalId: state.principalId,
      choices: state.choices,
      multiple: state.multiple,
    };
    return {
      id: state.id,
      address: state.address,
      kind: state.request.type,
      payload,
      createdAt: this.#clock(),
      expiresAt: this.#clock() + this.#interactionLifetime,
    };
  }

  async #sendInteractionPrompt(state: InteractiveState, signal?: AbortSignal): Promise<void> {
    const request = state.request;
    if (request.type === "confirm") {
      state.prompt = await this.#outbound.sendMessage(
        state.address,
        `${request.title}\n\n${request.message}`,
        state.context,
        {
          replyMarkup: {
            inline_keyboard: [
              [
                { text: request.confirmLabel ?? "Confirm", callback_data: callback(state.id, "accept") },
                { text: request.cancelLabel ?? "Cancel", callback_data: callback(state.id, "reject") },
              ],
            ],
          },
        },
        signal,
      );
      return;
    }
    if (request.type === "select") {
      state.prompt = await this.#outbound.sendMessage(
        state.address,
        this.#selectPrompt(state),
        state.context,
        {
          replyMarkup: this.#selectKeyboard(state),
        },
        signal,
      );
      return;
    }
    const prompt = request.type === "input" ? request.prompt : undefined;
    const initial = request.initialValue;
    const lines = [request.title, prompt, initial ? `Current value:\n${initial}` : undefined].filter(
      (part): part is string => Boolean(part),
    );
    state.prompt = await this.#outbound.sendMessage(
      state.address,
      lines.join("\n\n"),
      state.context,
      {
        replyMarkup: { force_reply: true, selective: true },
      },
      signal,
    );
  }

  #selectPrompt(state: InteractiveState): string {
    const request = state.request;
    if (request.type !== "select") return request.title;
    const start = state.page * SELECT_PAGE_SIZE;
    const end = Math.min(start + SELECT_PAGE_SIZE, state.labels.length);
    const options = state.labels.slice(start, end).map((label, relative) => {
      const index = start + relative;
      const marker = state.selected.has(index) ? "[selected]" : "[ ]";
      const note = state.notes[index];
      return `${marker} ${label}${note ? `\n${note}` : ""}`;
    });
    return [request.title, ...options].join("\n\n");
  }

  #selectKeyboard(state: InteractiveState): Record<string, unknown> {
    const start = state.page * SELECT_PAGE_SIZE;
    const end = Math.min(start + SELECT_PAGE_SIZE, state.labels.length);
    const rows: Record<string, string>[][] = [];
    for (let index = start; index < end; index += 1) {
      rows.push([
        {
          text: `${state.selected.has(index) ? "✓ " : ""}${state.labels[index]}`.slice(0, 64),
          callback_data: callback(state.id, `pick-${index}`),
        },
      ]);
    }
    const pages = Math.max(1, Math.ceil(state.labels.length / SELECT_PAGE_SIZE));
    if (pages > 1) {
      rows.push([
        { text: "Previous", callback_data: callback(state.id, "previous") },
        { text: `${state.page + 1}/${pages}`, callback_data: callback(state.id, "noop") },
        { text: "Next", callback_data: callback(state.id, "next") },
      ]);
    }
    if (state.multiple) {
      rows.push([
        { text: "Done", callback_data: callback(state.id, "done") },
        { text: "Cancel", callback_data: callback(state.id, "cancel") },
      ]);
    }
    return { inline_keyboard: rows };
  }

  async #applyInteractionAction(
    state: InteractiveState,
    action: string,
    query: TgCallbackQuery,
    acknowledge: (text?: string, alert?: boolean) => Promise<unknown>,
  ): Promise<void> {
    if (state.request.type === "confirm") {
      if (action !== "accept" && action !== "reject") {
        await acknowledge("Invalid response.");
        return;
      }
      this.#finishInteraction(state, { type: "confirm", confirmed: action === "accept" });
      await acknowledge(action === "accept" ? "Confirmed" : "Cancelled");
      return;
    }
    if (state.request.type !== "select") {
      await acknowledge("Reply to the prompt instead.");
      return;
    }
    if (action === "noop") {
      await acknowledge();
      return;
    }
    if (action === "previous" || action === "next") {
      const pageCount = Math.max(1, Math.ceil(state.choices.length / SELECT_PAGE_SIZE));
      state.page = Math.max(0, Math.min(pageCount - 1, state.page + (action === "next" ? 1 : -1)));
      await this.#refreshSelection(state);
      await acknowledge();
      return;
    }
    if (action === "cancel") {
      this.#finishInteraction(state, { type: "select", selected: [] });
      await acknowledge("Cancelled");
      return;
    }
    if (action === "done") {
      this.#finishInteraction(state, {
        type: "select",
        selected: [...state.selected].sort((a, b) => a - b).map((index) => state.choices[index]!),
      });
      await acknowledge("Selected");
      return;
    }
    const picked = /^pick-(\d+)$/.exec(action);
    const index = picked ? Number(picked[1]) : -1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= state.choices.length) {
      await acknowledge("Invalid option.");
      return;
    }
    if (!state.multiple) {
      this.#finishInteraction(state, { type: "select", selected: [state.choices[index]!] });
      await acknowledge(state.labels[index]);
      return;
    }
    if (state.selected.has(index)) state.selected.delete(index);
    else state.selected.add(index);
    await this.#refreshSelection(state);
    await acknowledge();
    void query;
  }

  async #refreshSelection(state: InteractiveState): Promise<void> {
    if (!state.prompt) return;
    await this.#outbound.update(state.address, state.prompt, { text: this.#selectPrompt(state) }, state.context);
    await this.#outbound.setReplyMarkup(state.address, state.prompt, this.#selectKeyboard(state), state.context);
  }

  async #captureReply(message: TgMessage, principalId: string, address: ConversationAddress): Promise<boolean> {
    if (!message.reply_to_message || typeof message.text !== "string") return false;
    for (const state of this.#interactions.values()) {
      if (state.request.type !== "input" && state.request.type !== "editor") continue;
      if (state.principalId !== principalId || !sameAddress(state.address, address)) continue;
      if (state.prompt?.messageId !== String(message.reply_to_message.message_id)) continue;
      this.#finishInteraction(
        state,
        state.request.type === "input"
          ? { type: "input", cancelled: false, value: message.text }
          : { type: "editor", cancelled: false, value: message.text },
      );
      return true;
    }
    return false;
  }

  #cancelledResponse(request: InteractiveRequest): InteractiveResponse {
    if (request.type === "confirm") return { type: "confirm", confirmed: false };
    if (request.type === "select") return { type: "select", selected: [] };
    if (request.type === "input") return { type: "input", cancelled: true };
    return { type: "editor", cancelled: true };
  }

  #finishInteraction(state: InteractiveState, response: InteractiveResponse): void {
    if (!this.#interactions.delete(state.id)) return;
    if (state.timeout) clearTimeout(state.timeout);
    state.detachAbort?.();
    this.#store.deletePendingInteraction(state.id);
    if (state.prompt)
      void this.#outbound
        .setReplyMarkup(state.address, state.prompt, { inline_keyboard: [] }, state.context)
        .catch(() => undefined);
    state.settle(response);
  }

  #failInteraction(state: InteractiveState, error: unknown): void {
    if (!this.#interactions.delete(state.id)) return;
    if (state.timeout) clearTimeout(state.timeout);
    state.detachAbort?.();
    this.#store.deletePendingInteraction(state.id);
    state.reject(error instanceof Error ? error : new Error(String(error)));
  }

  async #updateControlCard(
    address: ConversationAddress,
    request: Extract<UiRequest, { type: "status" | "widget" | "title" | "editor_text" }>,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = cardKey(address);
    const card = this.#cards.get(key) ?? {
      title: "OmpClaw control center",
      editorText: "",
      statuses: new Map<string, string>(),
      widgets: new Map<string, readonly string[]>(),
      stopVisible: false,
      receipts: [],
    };
    if (request.type === "title") card.title = request.title;
    if (request.type === "editor_text") card.editorText = request.text;
    if (request.type === "status") {
      if (request.text === undefined) card.statuses.delete(request.key);
      else card.statuses.set(request.key, request.text);
    }
    if (request.type === "widget") {
      if (request.lines === undefined || request.lines.length === 0) card.widgets.delete(request.key);
      else card.widgets.set(request.key, request.lines);
    }
    card.context = context;
    card.stopVisible = [...card.statuses.values()].some(activeTask);
    this.#cards.set(key, card);
    const body = this.#renderCard(card);
    const markup = card.stopVisible
      ? { inline_keyboard: [[{ text: "Stop", callback_data: STOP_CALLBACK }]] }
      : { inline_keyboard: [] };
    const options = {
      replyMarkup: markup,
      ...(request.type === "status" && request.notification !== undefined
        ? { notification: request.notification }
        : {}),
    };
    if (card.receipts.length === 0) {
      card.receipts = await this.#outbound.sendMessages(address, body, context, options, signal);
      return;
    }
    card.receipts = await this.#outbound.replaceMessages(address, card.receipts, body, context, options, signal);
  }

  #renderCard(card: ControlCard): string {
    const sections: string[] = [card.title];
    for (const [name, value] of card.statuses) sections.push(`${name}\n${value}`);
    for (const [name, lines] of card.widgets) sections.push(`${name}\n${lines.join("\n")}`);
    if (card.editorText) sections.push(`Suggested reply\n${card.editorText}`);
    return sections.join("\n\n");
  }

  async #sendIdentityHelp(message: TgMessage): Promise<void> {
    const address = telegramAddress(message, this.#account);
    const principal = { id: `telegram-unresolved:${message.from?.id ?? "unknown"}`, roles: [] };
    await this.#outbound.sendMessage(
      address,
      [
        `Telegram user ID: ${message.from?.id ?? "unknown"}`,
        `Chat ID: ${message.chat.id}`,
        address.thread ? `Topic ID: ${address.thread}` : undefined,
        "Ask the gateway operator to authorize this numeric user ID.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
      { principal, origin: address },
    );
  }

  async #assertUiOrigin(address: ConversationAddress, context: DeliveryContext): Promise<void> {
    if (!this.#deliveryAllowed(address, context))
      throw new Error("Telegram UI target is not authorized for this delivery context");
  }

  #deliveryAllowed(address: ConversationAddress, context: DeliveryContext): boolean {
    return (
      address.transport === "telegram" &&
      address.account === this.#account &&
      context.origin.transport === "telegram" &&
      context.origin.account === this.#account &&
      sameAddress(address, context.origin)
    );
  }

  #trackUpdate(update: TgUpdate): Promise<void> {
    const task = this.handleUpdate(update).catch((error) => {
      this.#log?.error(
        `[telegram] update ${update.update_id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    });
    this.#updateTasks.add(task);
    void task.then(
      () => this.#updateTasks.delete(task),
      () => this.#updateTasks.delete(task),
    );
    return task;
  }

  async #telegram(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return withTelegramRetry(() => this.#call(method, payload, { signal }), { signal, log: this.#log });
  }

  #releaseRuntimeOwnership(): void {
    this.#stopHeartbeat?.();
    this.#stopHeartbeat = undefined;
    if (this.#lockPath) this.#dropLock(this.#lockPath);
    this.#lockPath = undefined;
  }

  #requireContext(): TransportStartContext {
    if (!this.#context) throw new Error("Telegram transport is not started");
    return this.#context;
  }
}
