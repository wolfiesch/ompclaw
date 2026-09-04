import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { CommandCatalogEntry } from "../../command-catalog";
import { CommandCatalog } from "../../command-catalog";
import type { GatewayPairingService, PairingRequestView } from "../../gateway-pairing";
import type { GatewayStore, JsonValue, PendingInteraction } from "../../gateway-store";
import type {
  ConversationAddress,
  DeliveryContext,
  InboundEnvelope,
  InboundReplyMediaKind,
  InboundReplyTargetKind,
  Principal,
  MessageAttachment,
  OutboundContent,
  OutboundReceipt,
  Reaction,
  TransportAdapter,
  TransportCapabilities,
  TransportIdentity,
  TransportStartContext,
  UiRequest,
  UiResponse,
  UiResponseFor,
} from "../../gateway-types";
import { parseSlashCommand } from "../../rpc-commands";
import {
  TELEGRAM_BOT_DESCRIPTION,
  TELEGRAM_BOT_SHORT_DESCRIPTION,
  answerInlineQuery,
  acquireLock,
  downloadFileBytes,
  Poller,
  refreshTelegramBotProfile,
  releaseLock,
  startLockHeartbeat,
  telegramPollLockPath,
  tg,
  TgError,
  type Logger,
  type TgAnimation,
  type TgAudio,
  type TgCallbackQuery,
  type TgChat,
  type TgDocument,
  type TgFileBase,
  type TgInlineQuery,
  type TgInlineQueryAnswerOptions,
  type TgInlineQueryResultArticle,
  type TgMessage,
  type TgMessageGenerationStopped,
  type TgPhotoSize,
  type TgSticker,
  type TgUpdate,
  type TgUser,
  type TgVideo,
  type TgVideoNote,
  type TgVoice,
  withTelegramRetry,
} from "./bot-api";
import { Outbound, telegramDraftId, type TelegramCall, type TelegramUpload } from "./delivery";
import { MAX_INBOUND_ATTACHMENT_BYTES, saveInboxAttachment } from "./inbox";
import type { SemanticViewActionInput } from "../../gateway-views";
import { isRecord } from "../../type-guards";
import {
  renderDecisionCard,
  renderPairingJourneyCard,
  renderPickerCard,
  type DecisionCardState,
  type PairingJourneyCardState,
  type TelegramCardRender,
} from "./cards";
import { decodeTelegramSemanticCallback, TelegramSemanticViewReconciler } from "./semantic-views";

const executeFile = promisify(execFile);
const INTERACTION_LIFETIME_MS = 5 * 60 * 1_000;
const INTERACTION_CALLBACK = "ompui";
const PAIRING_CALLBACK = "omppair";
const STOP_CALLBACK = "ompctl:stop";
const SELECT_PAGE_SIZE = 8;
const TOPIC_NAME_LIMIT = 128;
const PAIRING_APPROVAL_CHECK_MS = 1_000;
const CATALOG_CALLBACK = "ompcat";
const INLINE_RESULT_LIMIT = 50;

function startPairingApprovalMonitor(run: () => void | Promise<void>): () => void {
  run();
  const timer = setInterval(run, PAIRING_APPROVAL_CHECK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

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
  readonly startPairingApprovalMonitor?: (run: () => void | Promise<void>) => () => void;
  readonly answerInlineQuery?: (
    inlineQueryId: string,
    results: readonly TgInlineQueryResultArticle[],
    options?: TgInlineQueryAnswerOptions,
  ) => Promise<boolean>;
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
    | "listPendingInteractions"
    | "getSemanticView"
    | "getSemanticViewByReceipt"
    | "putSemanticView"
  > &
    Partial<
      Pick<
        GatewayStore,
        "listOmpAvailableCommands" | "recordCommandUsage" | "listRecentCommandUsage"
      >
    >;
  readonly pairing?: Pick<
    GatewayPairingService,
    "requestFromTransport" | "listUnconfirmedApprovals" | "completeConfirmation"
  > &
    Partial<Pick<GatewayPairingService, "list">>;
  readonly transcribeCommand?: readonly string[];
  readonly logger?: Logger;
  readonly api?: TelegramApiSeams;
  readonly uiTimeoutMs?: number;
  readonly commands?: readonly { readonly command: string; readonly description: string }[];
  readonly createTopicsFromRoot?: boolean;
  readonly allowRpcBash?: boolean;
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
  decisionState?: DecisionCardState;
  decisionSettledLabel?: string;
  awaitingAnswer: boolean;
  restored: boolean;
  readonly createdAt: number;
  readonly expiresAt: number;
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

interface DurablePairingCard {
  readonly id: string;
  readonly identity: TransportIdentity;
  readonly address: ConversationAddress;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: PairingJourneyCardState;
  readonly principalId?: string;
  prompt?: OutboundReceipt;
}

interface DraftRoute {
  readonly address: ConversationAddress;
  readonly context: DeliveryContext;
}

interface CommandCatalogCard {
  readonly id: string;
  readonly address: ConversationAddress;
  readonly context: DeliveryContext;
  readonly principalId: string;
  readonly entries: readonly CommandCatalogEntry[];
  page: number;
  receipt?: OutboundReceipt;
}

function sameAddress(left: ConversationAddress, right: ConversationAddress): boolean {
  return (
    left.transport === right.transport &&
    left.account === right.account &&
    left.channel === right.channel &&
    left.thread === right.thread
  );
}

function sameIdentity(left: TransportIdentity, right: TransportIdentity): boolean {
  return left.transport === right.transport && left.account === right.account && left.subject === right.subject;
}

function pairingJourneyState(request: PairingRequestView): PairingJourneyCardState {
  if (request.state === "approved") return "connected";
  if (request.state === "expired") return "expired";
  if (request.state === "rejected" || request.state === "exhausted") return "rejected";
  return "pending";
}

function pairingCardFromPending(pending: PendingInteraction): DurablePairingCard | undefined {
  if (pending.kind !== "pairing" || !isRecord(pending.payload) || pending.payload.schemaVersion !== 1) return undefined;
  if (!isRecord(pending.payload.identity)) return undefined;
  const identity = pending.payload.identity;
  const state = pending.payload.state;
  const expiresAt = pending.payload.expiresAt;
  const promptMessageId = pending.payload.promptMessageId;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)) return undefined;
  if (
    typeof identity.transport !== "string" ||
    identity.transport.length === 0 ||
    typeof identity.account !== "string" ||
    identity.account.length === 0 ||
    typeof identity.subject !== "string" ||
    identity.subject.length === 0 ||
    (state !== "pending" &&
      state !== "connected" &&
      state !== "examples" &&
      state !== "rejected" &&
      state !== "expired") ||
    expiresAt < pending.createdAt ||
    (promptMessageId !== undefined && (typeof promptMessageId !== "string" || !/^[1-9]\d*$/.test(promptMessageId))) ||
    (pending.payload.principalId !== undefined &&
      (typeof pending.payload.principalId !== "string" || pending.payload.principalId.length === 0))
  ) {
    return undefined;
  }
  return {
    id: pending.id,
    identity: { transport: identity.transport, account: identity.account, subject: identity.subject },
    address: pending.address,
    createdAt: pending.createdAt,
    expiresAt,
    state,
    ...(typeof pending.payload.principalId === "string" ? { principalId: pending.payload.principalId } : {}),
    ...(typeof promptMessageId === "string" ? { prompt: { transport: "telegram", messageId: promptMessageId } } : {}),
  };
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
const REPLY_CONTEXT_QUOTE_LIMIT = 1_000;
const REPLY_CONTEXT_AUTHOR_LIMIT = 128;

function truncateReplyText(text: string, limit = REPLY_CONTEXT_TEXT_LIMIT): string {
  return text.length <= limit ? text : Array.from(text).slice(0, limit).join("");
}

function safeFilename(candidate: string): string {
  const leaf = basename(candidate.replaceAll("\\", "/"));
  const cleaned = leaf.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return (cleaned || "attachment.bin").slice(0, 180);
}

function resolveUserAuthor(user: TgUser | undefined): string | undefined {
  if (!user) return undefined;
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  const handle = user.username ? `@${user.username}` : undefined;
  let result: string | undefined;
  if (fullName && handle) {
    result = `${fullName} (${handle})`;
  } else {
    result = fullName || handle;
  }
  return result ? truncateReplyText(result, REPLY_CONTEXT_AUTHOR_LIMIT) : undefined;
}

function resolveChatAuthor(chat: TgChat | undefined): string | undefined {
  if (!chat) return undefined;
  const title = chat.title?.trim();
  return title ? truncateReplyText(title, REPLY_CONTEXT_AUTHOR_LIMIT) : undefined;
}

interface MediaDescriptor {
  readonly mediaKind?: InboundReplyMediaKind;
  readonly mediaName?: string;
  readonly placeholder: string;
}

function describeMedia(item: {
  photo?: readonly TgPhotoSize[];
  document?: TgDocument;
  voice?: TgVoice;
  audio?: TgAudio;
  video?: TgVideo;
  animation?: TgAnimation;
  video_note?: TgVideoNote;
  sticker?: TgSticker;
}): MediaDescriptor | undefined {
  if (item.photo && item.photo.length > 0) {
    return { mediaKind: "photo", placeholder: "[Photo]" };
  }
  if (item.document) {
    const mediaName = safeFilename(item.document.file_name ?? "attachment");
    return { mediaKind: "document", mediaName, placeholder: `[Document: ${mediaName}]` };
  }
  if (item.voice) {
    return { mediaKind: "voice", placeholder: "[Voice note]" };
  }
  if (item.audio) {
    const mediaName = safeFilename(item.audio.file_name ?? "audio.mp3");
    return { mediaKind: "audio", mediaName, placeholder: `[Audio: ${mediaName}]` };
  }
  if (item.video) {
    const mediaName = safeFilename(item.video.file_name ?? "video.mp4");
    return { mediaKind: "video", mediaName, placeholder: `[Video: ${mediaName}]` };
  }
  if (item.animation) {
    const mediaName = item.animation.file_name ? safeFilename(item.animation.file_name) : undefined;
    return {
      mediaKind: "animation",
      ...(mediaName ? { mediaName } : {}),
      placeholder: mediaName ? `[GIF: ${mediaName}]` : "[GIF / Animation]",
    };
  }
  if (item.video_note) {
    return { mediaKind: "video", placeholder: "[Video message]" };
  }
  if (item.sticker) {
    return { mediaKind: "sticker", placeholder: "[Sticker]" };
  }
  return undefined;
}

function replyContextFrom(message: TgMessage): InboundEnvelope["replyContext"] | undefined {
  const reply = message.reply_to_message;
  if (reply) {
    const author = resolveUserAuthor(reply.from) ?? resolveChatAuthor(reply.sender_chat);
    const media = describeMedia(reply);
    let text: string | undefined;
    if (reply.text) {
      text = truncateReplyText(reply.text);
    } else if (reply.caption) {
      text = media ? truncateReplyText(`${media.placeholder} ${reply.caption}`) : truncateReplyText(reply.caption);
    } else if (media) {
      text = media.placeholder;
    }
    const quote = message.quote?.text ? truncateReplyText(message.quote.text, REPLY_CONTEXT_QUOTE_LIMIT) : undefined;
    return {
      messageId: String(reply.message_id),
      ...(author === undefined ? {} : { author }),
      ...(text === undefined ? {} : { text }),
      ...(quote === undefined ? {} : { quote }),
      ...(reply.from?.is_bot === undefined ? {} : { isBot: reply.from.is_bot }),
      ...(reply.chat?.title === undefined ? {} : { chatTitle: reply.chat.title }),
      ...(media?.mediaKind === undefined ? {} : { mediaKind: media.mediaKind }),
      ...(media?.mediaName === undefined ? {} : { mediaName: media.mediaName }),
      isExternal: false,
    };
  }

  const external = message.external_reply;
  if (external) {
    const origin = external.origin;
    let author: string | undefined;
    if (origin.sender_user) {
      author = resolveUserAuthor(origin.sender_user);
    } else if (origin.sender_user_name) {
      author = truncateReplyText(origin.sender_user_name, REPLY_CONTEXT_AUTHOR_LIMIT);
    } else if (origin.sender_chat) {
      author = resolveChatAuthor(origin.sender_chat);
    } else if (origin.author_signature) {
      author = truncateReplyText(origin.author_signature, REPLY_CONTEXT_AUTHOR_LIMIT);
    }
    const media = describeMedia(external);
    const text = media?.placeholder;
    const quoteCandidate = message.quote?.text ?? external.quote?.text;
    const quote = quoteCandidate ? truncateReplyText(quoteCandidate, REPLY_CONTEXT_QUOTE_LIMIT) : undefined;
    return {
      messageId: String(external.message_id ?? "external"),
      ...(author === undefined ? {} : { author }),
      ...(text === undefined ? {} : { text }),
      ...(quote === undefined ? {} : { quote }),
      ...(origin.sender_user?.is_bot === undefined ? {} : { isBot: origin.sender_user.is_bot }),
      ...(external.chat?.title === undefined ? {} : { chatTitle: external.chat.title }),
      ...(media?.mediaKind === undefined ? {} : { mediaKind: media.mediaKind }),
      ...(media?.mediaName === undefined ? {} : { mediaName: media.mediaName }),
      isExternal: true,
    };
  }

  return undefined;
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

function groupMenuCommands(
  input: readonly { readonly command: string; readonly description: string }[],
): readonly { command: string; description: string }[] {
  const byCommand = new Map(input.map((command) => [command.command, command]));
  return ["help", "status", "stop", "new", "start"].flatMap((command) => {
    const item = byCommand.get(command);
    return item === undefined ? [] : [item];
  });
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
  readonly #answerInlineQuery: NonNullable<TelegramApiSeams["answerInlineQuery"]>;
  readonly #claimLock: NonNullable<TelegramApiSeams["acquireLock"]>;
  readonly #dropLock: NonNullable<TelegramApiSeams["releaseLock"]>;
  readonly #heartbeat: NonNullable<TelegramApiSeams["startLockHeartbeat"]>;
  readonly #clock: () => number;
  readonly #pairing: TelegramTransportAdapterOptions["pairing"];
  readonly #startPairingApprovalMonitor: NonNullable<TelegramApiSeams["startPairingApprovalMonitor"]>;
  readonly #newId: () => string;
  readonly #transcriptionCommand: readonly string[] | undefined;
  readonly #transcriptionOverride: TelegramApiSeams["transcribe"];
  readonly #interactionLifetime: number;
  readonly #commands: readonly { command: string; description: string }[];
  readonly #topicsFromRoot: boolean;
  readonly #allowRpcBash: boolean;
  readonly #outbound: Outbound;
  readonly #semanticViews: TelegramSemanticViewReconciler;
  readonly #interactions = new Map<string, InteractiveState>();
  readonly #draftRoutes = new Map<number, DraftRoute>();
  readonly #cards = new Map<string, ControlCard>();
  readonly #activeUpdates = new Set<number>();
  readonly #updateTasks = new Set<Promise<void>>();

  readonly #catalogCards = new Map<string, CommandCatalogCard>();
  #context: TransportStartContext | undefined;
  #lockPath: string | undefined;
  #stopHeartbeat: (() => void) | undefined;
  #stopTask: Promise<void> | undefined;
  #stopPairingApprovalMonitor: (() => void) | undefined;
  #pairingApprovalDrain: Promise<void> | undefined;

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
    this.#pairing = options.pairing;
    this.#startPairingApprovalMonitor = options.api?.startPairingApprovalMonitor ?? startPairingApprovalMonitor;
    this.#newId = options.api?.randomId ?? (() => randomBytes(18).toString("base64url"));
    this.#transcriptionCommand = options.transcribeCommand;
    this.#transcriptionOverride = options.api?.transcribe;
    this.#interactionLifetime = options.uiTimeoutMs ?? INTERACTION_LIFETIME_MS;
    this.#commands = menuCommands(options.commands ?? []);
    this.#topicsFromRoot = options.createTopicsFromRoot ?? false;
    this.#answerInlineQuery =
      options.api?.answerInlineQuery ??
      ((inlineQueryId, results, request) => answerInlineQuery(this.#token, inlineQueryId, results, request));
    this.#outbound = new Outbound({
      token: this.#token,
      account: this.#account,
      authorizeAddress: (address, context) => this.#deliveryAllowed(address, context),
      logger: this.#log,
      callTelegram: this.#call,
      uploadTelegram: options.api?.uploadTelegram,
    });
    this.#allowRpcBash = options.allowRpcBash ?? false;
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
    let pollerStarted = false;
    try {
      if (this.#commands.length > 0) await this.#registerCommandMenus(context.signal);
      await this.#refreshBotProfile(context.signal);
      this.#poller.start(this.#token, (update) => this.#trackUpdate(update), this.#log);
      pollerStarted = true;
      await this.#restoreInteractions(context.signal);
      if (this.#pairing !== undefined) {
        this.#stopPairingApprovalMonitor = this.#startPairingApprovalMonitor(() =>
          this.#schedulePairingApprovalDrain(),
        );
      }
      if (context.signal) {
        const abort = (): void => {
          void this.stop();
        };
        context.signal.addEventListener("abort", abort, { once: true });
      }
    } catch (error) {
      try {
        this.#stopPairingApprovalMonitor?.();
      } catch (cleanupError) {
        this.#log?.warn(
          `[telegram] pairing approval monitor cleanup failed: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        );
      }
      this.#stopPairingApprovalMonitor = undefined;
      if (pollerStarted) {
        try {
          this.#poller.stop();
        } catch (cleanupError) {
          this.#log?.warn(
            `[telegram] poller cleanup failed after startup error: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`,
          );
        }
        await Promise.allSettled([
          this.#poller.done(),
          ...this.#updateTasks,
          ...(this.#pairingApprovalDrain === undefined ? [] : [this.#pairingApprovalDrain]),
        ]);
      }
      this.#releaseRuntimeOwnership();
      this.#context = undefined;
      throw error;
    }
  }

  async #registerCommandMenus(signal?: AbortSignal): Promise<void> {
    const menus = [
      { commands: this.#commands, scope: { type: "all_private_chats" } },
      { commands: groupMenuCommands(this.#commands), scope: { type: "all_group_chats" } },
    ];
    for (const menu of menus) {
      if (menu.commands.length === 0) continue;
      try {
        await this.#telegram("setMyCommands", menu, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof TgError && (error.code === 401 || error.code === 404)) throw error;
        this.#log?.warn(
          `[telegram] command menu registration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.#context === undefined) return;
    if (this.#stopTask) return this.#stopTask;
    this.#stopTask = (async () => {
      this.#stopPairingApprovalMonitor?.();
      this.#stopPairingApprovalMonitor = undefined;
      this.#poller.stop();
      await Promise.allSettled([
        this.#poller.done(),
        ...this.#updateTasks,
        ...(this.#pairingApprovalDrain === undefined ? [] : [this.#pairingApprovalDrain]),
      ]);
      for (const state of [...this.#interactions.values()]) {
        this.#finishInteraction(state, this.#cancelledResponse(state.request));
      }
      this.#cards.clear();
      this.#draftRoutes.clear();
      this.#releaseRuntimeOwnership();
      this.#catalogCards.clear();
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
      else if (update.inline_query) await this.#handleInlineQuery(update.inline_query, context);
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

  async #handleInlineQuery(query: TgInlineQuery, context: TransportStartContext): Promise<void> {
    const identity = telegramIdentity(query.from.id, this.#account);
    const principal = query.from.is_bot ? undefined : await context.resolveIdentity(identity, context.signal);
    if (principal === undefined) {
      await this.#respondInlineQuery(query, [], context.signal);
      return;
    }
    const terms = query.query.trim().split(/\s+/);
    const filter = terms[0] ?? "";
    const args = terms.slice(1).join(" ");
    const recent = this.#store.listRecentCommandUsage?.(principal.id) ?? [];
    const results = this.#commandCatalog()
      .search(filter, recent)
      .slice(0, INLINE_RESULT_LIMIT)
      .map((entry) => {
        const description = args.length === 0 ? entry.description : `${entry.description}\nArguments: ${args}`;
        return {
          type: "article" as const,
          id: entry.name,
          title: `/${entry.name}`,
          ...(description.length === 0 ? {} : { description: description.slice(0, 512) }),
          input_message_content: { message_text: `/${entry.name}${args.length === 0 ? "" : ` ${args}`}` },
        };
      });
    await this.#respondInlineQuery(query, results, context.signal);
  }

  async #respondInlineQuery(
    query: TgInlineQuery,
    results: readonly TgInlineQueryResultArticle[],
    signal?: AbortSignal,
  ): Promise<void> {
    await withTelegramRetry(
      () => this.#answerInlineQuery(query.id, results, { cacheTime: 0, isPersonal: true, signal }),
      { signal, log: this.#log },
    );
  }

  #commandCatalog(): CommandCatalog {
    return new CommandCatalog({
      ompCommands: this.#store.listOmpAvailableCommands?.() ?? [],
      allowRpcBash: this.#allowRpcBash,
    });
  }

  async #showCommandCatalog(
    address: ConversationAddress,
    principal: Principal,
    query: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const catalog = this.#commandCatalog();
    const trimmedQuery = query.trim();
    const delivery: DeliveryContext = { principal, origin: address };
    if (trimmedQuery.length === 0) {
      const text = [
        "Commands",
        ...catalog.groups().flatMap((group) => [
          "",
          `${group.name}: ${group.entries.map((entry) => `/${entry.name}`).join(" ")}`,
        ]),
        "",
        "Search with /commands <query>.",
      ].join("\n");
      await this.#outbound.sendMessage(address, text, delivery, {}, signal);
      return;
    }
    const entries = catalog.search(trimmedQuery, this.#store.listRecentCommandUsage?.(principal.id) ?? []);
    if (entries.length === 0) {
      await this.#outbound.sendMessage(address, "No commands match that search.", delivery, {}, signal);
      return;
    }
    const card: CommandCatalogCard = {
      id: this.#newId(),
      address,
      context: delivery,
      principalId: principal.id,
      entries,
      page: 0,
    };
    const rendered = this.#renderCommandCatalogCard(card);
    card.receipt = await this.#outbound.sendMessage(
      address,
      rendered.text,
      delivery,
      { replyMarkup: this.#cardReplyMarkup(rendered) },
      signal,
    );
    this.#catalogCards.set(card.id, card);
  }

  #renderCommandCatalogCard(card: CommandCatalogCard): TelegramCardRender {
    const start = card.page * SELECT_PAGE_SIZE;
    const pageCount = Math.max(1, Math.ceil(card.entries.length / SELECT_PAGE_SIZE));
    return renderPickerCard(
      {
        title: "Command search",
        prompt: "Choose a command to send.",
        options: card.entries.slice(start, start + SELECT_PAGE_SIZE).map((entry, relative) => ({
          id: String(start + relative),
          label: `/${entry.name}`,
          ...(entry.description.length === 0 ? {} : { description: entry.description }),
        })),
        page: card.page,
        pageCount,
      },
      (action) => `${CATALOG_CALLBACK}:${card.id}:${action}`,
    );
  }

  async #handleMessage(message: TgMessage, update: TgUpdate, context: TransportStartContext): Promise<void> {
    if (!message.from || message.from.is_bot) return;
    const identity = telegramIdentity(message.from.id, this.#account);
    const principal = await context.resolveIdentity(identity, context.signal);
    let address = telegramAddress(message, this.#account);
    if (!principal) {
      if (message.chat.type === "private" && this.#pairing !== undefined) {
        await this.#sendPairingChallenge(message, identity);
      } else if (identityHelp(message.text)) {
        await this.#sendIdentityHelp(message);
      }
      return;
    }
    if (await this.#captureReply(message, principal.id, address)) return;
    const catalogRequest = parseSlashCommand(message.text);
    if (catalogRequest?.name === "commands") {
      await this.#showCommandCatalog(address, principal, catalogRequest.args, context.signal);
      return;
    }
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
    let replyContext = replyContextFrom(message);
    if (replyContext !== undefined && replyContext.targetKind === undefined) {
      const correlated = this.#store.getSemanticViewByReceipt?.(address, replyContext.messageId);
      if (correlated !== undefined) {
        const view = correlated.view;
        const targetKind: InboundReplyTargetKind =
          view.kind === "task"
            ? "task_card"
            : view.kind === "decision"
              ? "decision"
              : view.kind === "result"
                ? "turn_result"
                : "interaction";
        const targetSummary = truncateReplyText(
          view.summary ? `${view.title}: ${view.summary}` : view.title,
          REPLY_CONTEXT_TEXT_LIMIT,
        );
        replyContext = {
          ...replyContext,
          targetKind,
          targetId: view.id,
          targetSummary,
        };
      }
    }
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
          }),
      ...(replyContext === undefined ? {} : { replyContext }),
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
    const command = parseSlashCommand(envelope.content.text);
    if (command !== undefined && this.#commandCatalog().find(command.name) !== undefined) {
      this.#store.recordCommandUsage?.(principal.id, command.name, this.#clock());
    }
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
    const address = telegramAddress(query.message, this.#account);
    if (query.data.startsWith(`${PAIRING_CALLBACK}:`)) {
      await this.#handlePairingCardCallback(query, identity, address, updateId, context, acknowledge);
      return;
    }
    const principal = await context.resolveIdentity(identity, context.signal);
    if (!principal) {
      await acknowledge("Not authorized.", true);
      return;
    }
    const callbackContext: DeliveryContext = { principal, origin: address };
    const catalogPrefix = `${CATALOG_CALLBACK}:`;
    if (query.data.startsWith(catalogPrefix)) {
      await this.#handleCommandCatalogCallback(
        query,
        updateId,
        identity,
        address,
        principal,
        context,
        query.data.slice(catalogPrefix.length),
        acknowledge,
      );
      return;
    }
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
      if (action?.input !== undefined) {
        await acknowledge("Reply with your instruction.");
        void this.#collectSemanticInput(address, identity, action.input, callbackContext, updateId, context).catch(
          (error) =>
            this.#log?.warn(
              `[telegram] semantic input failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
        );
        return;
      }
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
    const stopRequested = state.request.type === "confirm" && action === "stop";
    await this.#applyInteractionAction(state, action, query, acknowledge);
    if (!stopRequested) return;
    await context.receive(
      {
        id: `telegram:${this.#account}:interaction-stop:${updateId}`,
        sentAt: this.#clock(),
        identity,
        address,
        content: { text: "/stop" },
        sourceReceipt: { transport: "telegram", messageId: String(query.message.message_id) },
        edited: false,
      },
      context.signal,
    );
  }

  async #handleCommandCatalogCallback(
    query: TgCallbackQuery,
    updateId: number,
    identity: TransportIdentity,
    address: ConversationAddress,
    principal: Principal,
    context: TransportStartContext,
    remainder: string,
    acknowledge: (text?: string, alert?: boolean) => Promise<unknown>,
  ): Promise<void> {
    const separator = remainder.indexOf(":");
    if (separator < 1 || query.message === undefined) {
      await acknowledge("Invalid command control.");
      return;
    }
    const card = this.#catalogCards.get(remainder.slice(0, separator));
    if (
      card === undefined ||
      card.principalId !== principal.id ||
      !sameAddress(card.address, address) ||
      card.receipt?.messageId !== String(query.message.message_id)
    ) {
      await acknowledge("This command search has expired.", true);
      return;
    }
    const action = remainder.slice(separator + 1);
    if (action === "noop") {
      await acknowledge();
      return;
    }
    if (action === "previous" || action === "next") {
      const pageCount = Math.max(1, Math.ceil(card.entries.length / SELECT_PAGE_SIZE));
      card.page =
        action === "previous" ? Math.max(0, card.page - 1) : Math.min(pageCount - 1, card.page + 1);
      const rendered = this.#renderCommandCatalogCard(card);
      if (card.receipt !== undefined) {
        await this.#outbound.update(card.address, card.receipt, { text: rendered.text }, card.context);
        await this.#outbound.setReplyMarkup(
          card.address,
          card.receipt,
          this.#cardReplyMarkup(rendered),
          card.context,
        );
      }
      await acknowledge();
      return;
    }
    const matched = /^pick-(\d+)$/.exec(action);
    const index = matched === null ? Number.NaN : Number(matched[1]);
    const entry = Number.isSafeInteger(index) ? card.entries[index] : undefined;
    if (entry === undefined) {
      await acknowledge("This command is no longer available.");
      return;
    }
    await context.receive(
      {
        id: `telegram:${this.#account}:command-catalog:${updateId}`,
        sentAt: this.#clock(),
        identity,
        address,
        content: { text: `/${entry.name}` },
        sourceReceipt: { transport: "telegram", messageId: String(query.message.message_id) },
        edited: false,
      },
      context.signal,
    );
    this.#store.recordCommandUsage?.(principal.id, entry.name, this.#clock());
    this.#catalogCards.delete(card.id);
    await acknowledge(`Sent /${entry.name}`);
  }

  async #collectSemanticInput(
    address: ConversationAddress,
    identity: TransportIdentity,
    input: SemanticViewActionInput,
    deliveryContext: DeliveryContext,
    updateId: number,
    context: TransportStartContext,
  ): Promise<void> {
    const response = await this.#openInteraction(
      address,
      { type: "input", title: input.title, prompt: input.prompt },
      deliveryContext,
      context.signal,
    );
    if (response.type !== "input" || response.cancelled || !response.value.trim()) return;
    await context.receive(
      {
        id: `telegram:${this.#account}:semantic-input:${updateId}`,
        sentAt: this.#clock(),
        identity,
        address,
        content: { text: `${input.command} ${response.value.trim()}` },
        edited: false,
      },
      context.signal,
    );
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
      const createdAt = this.#clock();
      const state: InteractiveState = {
        id: this.#newId(),
        request,
        address,
        context,
        principalId: context.principal.id,
        choices: request.type === "select" ? request.options.map((option) => option.value) : [],
        labels: request.type === "select" ? request.options.map((option) => option.label) : [],
        notes: request.type === "select" ? request.options.map((option) => option.description) : [],
        selected: new Set<number>(),
        settle: resolvePromise,
        reject: rejectPromise,
        multiple: request.type === "select" && request.multiSelect === true,
        page: 0,
        awaitingAnswer: false,
        restored: false,
        createdAt,
        expiresAt: createdAt + this.#interactionLifetime,
      };
      this.#interactions.set(state.id, state);
      this.#persistInteraction(state);
      this.#scheduleInteractionExpiry(state);
      if (signal) {
        const abort = (): void => {
          void this.#finishInteraction(state, this.#cancelledResponse(request), "expired");
        };
        signal.addEventListener("abort", abort, { once: true });
        state.detachAbort = () => signal.removeEventListener("abort", abort);
      }
      void this.#sendInteractionPrompt(state, signal).catch((error) => this.#failInteraction(state, error));
    });
  }

  #scheduleInteractionExpiry(state: InteractiveState): void {
    const timeout = Math.max(0, state.expiresAt - this.#clock());
    state.timeout = setTimeout(() => {
      void this.#finishInteraction(state, this.#cancelledResponse(state.request), "expired");
    }, timeout);
    state.timeout.unref?.();
  }

  async #restoreInteractions(signal?: AbortSignal): Promise<void> {
    for (const pending of this.#store.listPendingInteractions()) {
      if (pending.address.transport !== "telegram" || pending.address.account !== this.#account) continue;
      const state = this.#restoreInteractionState(pending);
      if (state === undefined) continue;
      if (state.expiresAt <= this.#clock()) {
        if (
          (state.request.type === "confirm" ||
            (state.request.type === "select" && state.request.presentation === "decision")) &&
          state.prompt !== undefined
        ) {
          state.decisionState = "expired";
          await this.#refreshInteraction(state).catch((error) => {
            this.#log?.warn(
              `[telegram] could not settle expired interaction ${state.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }
        this.#store.deletePendingInteraction(state.id);
        continue;
      }
      this.#interactions.set(state.id, state);
      this.#scheduleInteractionExpiry(state);
      if (state.prompt === undefined) {
        await this.#sendInteractionPrompt(state, signal);
      } else if (state.request.type === "confirm" || state.request.type === "select") {
        await this.#refreshInteraction(state);
      }
    }
  }

  #restoreInteractionState(pending: PendingInteraction): InteractiveState | undefined {
    if (!isRecord(pending.payload) || pending.payload.schemaVersion !== 1 || !isRecord(pending.payload.request)) {
      return undefined;
    }
    const principalId = pending.payload.principalId;
    const requestData = pending.payload.request;
    const title = requestData.title;
    if (
      typeof principalId !== "string" ||
      principalId.length === 0 ||
      typeof title !== "string" ||
      title.length === 0
    ) {
      return undefined;
    }
    let request: InteractiveRequest;
    let choices: readonly string[] = [];
    let labels: readonly string[] = [];
    let notes: readonly (string | undefined)[] = [];
    let multiple = false;
    if (pending.kind === "confirm" && typeof requestData.message === "string") {
      request = {
        type: "confirm",
        title,
        message: requestData.message,
        ...(typeof requestData.confirmLabel === "string" ? { confirmLabel: requestData.confirmLabel } : {}),
        ...(typeof requestData.cancelLabel === "string" ? { cancelLabel: requestData.cancelLabel } : {}),
      };
    } else if (pending.kind === "select" && Array.isArray(requestData.options)) {
      const options = requestData.options.map((option) => {
        if (!isRecord(option) || typeof option.value !== "string" || typeof option.label !== "string") return undefined;
        return {
          value: option.value,
          label: option.label,
          ...(typeof option.description === "string" ? { description: option.description } : {}),
        };
      });
      if (options.some((option) => option === undefined)) return undefined;
      const restoredOptions = options as Array<{
        readonly value: string;
        readonly label: string;
        readonly description?: string;
      }>;
      multiple = requestData.multiple === true;
      request = {
        type: "select",
        title,
        options: restoredOptions,
        ...(multiple ? { multiSelect: true } : {}),
        ...(requestData.presentation === "decision"
          ? { presentation: "decision" as const }
          : requestData.presentation === "picker"
            ? { presentation: "picker" as const }
            : {}),
      };
      choices = restoredOptions.map((option) => option.value);
      labels = restoredOptions.map((option) => option.label);
      notes = restoredOptions.map((option) => option.description);
    } else if (pending.kind === "input") {
      request = {
        type: "input",
        title,
        ...(typeof requestData.prompt === "string" ? { prompt: requestData.prompt } : {}),
        ...(typeof requestData.initialValue === "string" ? { initialValue: requestData.initialValue } : {}),
        ...(typeof requestData.placeholder === "string" ? { placeholder: requestData.placeholder } : {}),
      };
    } else if (pending.kind === "editor" && typeof requestData.initialValue === "string") {
      request = {
        type: "editor",
        title,
        initialValue: requestData.initialValue,
        ...(typeof requestData.language === "string" ? { language: requestData.language } : {}),
      };
    } else {
      return undefined;
    }
    const selected = new Set<number>();
    if (Array.isArray(pending.payload.selected)) {
      for (const index of pending.payload.selected) {
        if (typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index < choices.length) {
          selected.add(index);
        }
      }
    }
    const pageCount = Math.max(1, Math.ceil(choices.length / SELECT_PAGE_SIZE));
    const restoredPage =
      typeof pending.payload.page === "number" && Number.isSafeInteger(pending.payload.page)
        ? Math.max(0, Math.min(pageCount - 1, pending.payload.page))
        : 0;
    const promptMessageId = pending.payload.promptMessageId;
    const prompt =
      typeof promptMessageId === "string" && /^[1-9]\d*$/.test(promptMessageId)
        ? ({ transport: "telegram", messageId: promptMessageId } as const)
        : undefined;
    const expiresAt = pending.expiresAt ?? pending.createdAt + this.#interactionLifetime;
    return {
      id: pending.id,
      request,
      address: pending.address,
      context: {
        principal: { id: principalId, roles: [] },
        origin: pending.address,
      },
      principalId,
      choices,
      labels,
      notes,
      selected,
      settle: () => {},
      reject: () => {},
      multiple,
      page: restoredPage,
      ...(pending.payload.decisionState === "active" ||
      pending.payload.decisionState === "waiting_answer" ||
      pending.payload.decisionState === "approved" ||
      pending.payload.decisionState === "denied" ||
      pending.payload.decisionState === "expired"
        ? { decisionState: pending.payload.decisionState }
        : {}),
      ...(typeof pending.payload.decisionSettledLabel === "string"
        ? { decisionSettledLabel: pending.payload.decisionSettledLabel }
        : {}),
      awaitingAnswer: pending.payload.awaitingAnswer === true,
      restored: true,
      createdAt: pending.createdAt,
      expiresAt,
      ...(prompt === undefined ? {} : { prompt }),
    };
  }

  #pendingInteraction(state: InteractiveState): PendingInteraction {
    const request: JsonValue =
      state.request.type === "confirm"
        ? {
            title: state.request.title,
            message: state.request.message,
            ...(state.request.confirmLabel === undefined ? {} : { confirmLabel: state.request.confirmLabel }),
            ...(state.request.cancelLabel === undefined ? {} : { cancelLabel: state.request.cancelLabel }),
          }
        : state.request.type === "select"
          ? {
              title: state.request.title,
              options: state.choices.map((value, index) => ({
                value,
                label: state.labels[index]!,
                ...(state.notes[index] === undefined ? {} : { description: state.notes[index]! }),
              })),
              multiple: state.multiple,
              ...(state.request.presentation === undefined ? {} : { presentation: state.request.presentation }),
            }
          : state.request.type === "input"
            ? {
                title: state.request.title,
                ...(state.request.prompt === undefined ? {} : { prompt: state.request.prompt }),
                ...(state.request.initialValue === undefined ? {} : { initialValue: state.request.initialValue }),
                ...(state.request.placeholder === undefined ? {} : { placeholder: state.request.placeholder }),
              }
            : {
                title: state.request.title,
                initialValue: state.request.initialValue,
                ...(state.request.language === undefined ? {} : { language: state.request.language }),
              };
    return {
      id: state.id,
      address: state.address,
      kind: state.request.type,
      payload: {
        schemaVersion: 1,
        principalId: state.principalId,
        request,
        selected: [...state.selected].sort((left, right) => left - right),
        page: state.page,
        awaitingAnswer: state.awaitingAnswer,
        ...(state.decisionState === undefined ? {} : { decisionState: state.decisionState }),
        ...(state.decisionSettledLabel === undefined ? {} : { decisionSettledLabel: state.decisionSettledLabel }),
        ...(state.prompt === undefined ? {} : { promptMessageId: state.prompt.messageId }),
      },
      createdAt: state.createdAt,
      expiresAt: state.expiresAt,
    };
  }

  #persistInteraction(state: InteractiveState): void {
    this.#store.putPendingInteraction(this.#pendingInteraction(state));
  }

  async #sendInteractionPrompt(state: InteractiveState, signal?: AbortSignal): Promise<void> {
    const request = state.request;
    if (request.type === "confirm" || request.type === "select") {
      const rendered = this.#renderInteractiveCard(state);
      state.prompt = await this.#outbound.sendMessage(
        state.address,
        rendered.text,
        state.context,
        { replyMarkup: this.#cardReplyMarkup(rendered) },
        signal,
      );
      this.#persistInteraction(state);
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
      { replyMarkup: { force_reply: true, selective: true } },
      signal,
    );
    this.#persistInteraction(state);
  }

  #renderInteractiveCard(state: InteractiveState) {
    const decision =
      state.request.type === "confirm" ||
      (state.request.type === "select" && state.request.presentation === "decision");
    if (decision) {
      const choices =
        state.request.type === "confirm"
          ? [
              { id: "accept", label: state.request.confirmLabel ?? "Confirm" },
              { id: "reject", label: state.request.cancelLabel ?? "Cancel" },
            ]
          : state.choices.map((value, index) => ({
              id: `pick-${index}`,
              label: `${state.labels[index]!}${state.notes[index] === undefined ? "" : `\n${state.notes[index]!}`}`,
              shortLabel: String(index + 1),
              ...(value.length === 0 ? { disabled: true } : {}),
            }));
      return renderDecisionCard(
        {
          title: state.request.title,
          preview: state.request.type === "confirm" ? state.request.message : "Choose the best answer.",
          choices,
          expiresAt: state.expiresAt,
          state: state.decisionState ?? "active",
          ...(state.decisionSettledLabel === undefined ? {} : { settledLabel: state.decisionSettledLabel }),
        },
        (action) => callback(state.id, action),
      );
    }
    const start = state.page * SELECT_PAGE_SIZE;
    const pageCount = Math.max(1, Math.ceil(state.choices.length / SELECT_PAGE_SIZE));
    return renderPickerCard(
      {
        title: state.request.title,
        prompt: "Choose an option.",
        options: state.choices.slice(start, start + SELECT_PAGE_SIZE).map((value, relative) => {
          const index = start + relative;
          return {
            id: String(index),
            label: state.labels[index]!,
            ...(state.notes[index] === undefined ? {} : { description: state.notes[index]! }),
            ...(state.selected.has(index) ? { selected: true } : {}),
            ...(value.length === 0 ? { disabled: true } : {}),
          };
        }),
        page: state.page,
        pageCount,
        ...(state.multiple && state.selected.size > 0 ? { current: `${state.selected.size} selected` } : {}),
        ...(state.choices.length === 0 ? { warning: "No options are available." } : {}),
        ...(state.multiple ? { doneAction: "done" } : {}),
        cancelAction: "cancel",
      },
      (action) => callback(state.id, action),
    );
  }

  #cardReplyMarkup(rendered: TelegramCardRender): Record<string, unknown> {
    return {
      inline_keyboard: rendered.inlineKeyboard.map((row) =>
        row.map((button) => ({ text: button.text, callback_data: button.action })),
      ),
    };
  }

  async #refreshInteraction(state: InteractiveState, persist = true): Promise<void> {
    if (!state.prompt) return;
    if (state.request.type !== "confirm" && state.request.type !== "select") return;
    const rendered = this.#renderInteractiveCard(state);
    await this.#outbound.update(state.address, state.prompt, { text: rendered.text }, state.context);
    await this.#outbound.setReplyMarkup(state.address, state.prompt, this.#cardReplyMarkup(rendered), state.context);
    if (persist) this.#persistInteraction(state);
  }

  async #applyInteractionAction(
    state: InteractiveState,
    action: string,
    query: TgCallbackQuery,
    acknowledge: (text?: string, alert?: boolean) => Promise<unknown>,
  ): Promise<void> {
    if (state.request.type === "confirm") {
      if (action === "noop") {
        await acknowledge();
        return;
      }
      if (action !== "accept" && action !== "reject") {
        await acknowledge("This decision is no longer available.");
        return;
      }
      await this.#finishInteraction(
        state,
        { type: "confirm", confirmed: action === "accept" },
        action === "accept" ? "approved" : "denied",
      );
      await acknowledge(action === "accept" ? "Approved" : "Denied");
      return;
    }
    if (state.request.type !== "select") {
      await acknowledge("Reply to the prompt instead.");
      return;
    }
    if (state.request.presentation === "decision") {
      if (action === "other") {
        state.awaitingAnswer = true;
        state.decisionState = "waiting_answer";
        await this.#refreshInteraction(state);
        await acknowledge("Reply to this card with your answer.");
        return;
      }
      const picked = /^pick-(\d+)$/.exec(action);
      const index = picked === null ? -1 : Number(picked[1]);
      if (!Number.isSafeInteger(index) || index < 0 || index >= state.choices.length) {
        await acknowledge("This decision is no longer available.");
        return;
      }
      state.decisionSettledLabel = "✅ Answered";
      await this.#finishInteraction(state, { type: "select", selected: [state.choices[index]!] }, "approved");
      await acknowledge(`Selected ${index + 1}`);
      return;
    }
    if (action === "noop") {
      await acknowledge();
      return;
    }
    if (action === "previous" || action === "next") {
      const pageCount = Math.max(1, Math.ceil(state.choices.length / SELECT_PAGE_SIZE));
      state.page = Math.max(0, Math.min(pageCount - 1, state.page + (action === "next" ? 1 : -1)));
      await this.#refreshInteraction(state);
      await acknowledge();
      return;
    }
    if (action === "cancel") {
      await this.#finishInteraction(state, { type: "select", selected: [] });
      await acknowledge("Cancelled");
      return;
    }
    if (action === "done") {
      await this.#finishInteraction(state, {
        type: "select",
        selected: [...state.selected].sort((left, right) => left - right).map((index) => state.choices[index]!),
      });
      await acknowledge("Selected");
      return;
    }
    const picked = /^pick-(\d+)$/.exec(action);
    const index = picked === null ? -1 : Number(picked[1]);
    if (!Number.isSafeInteger(index) || index < 0 || index >= state.choices.length) {
      await acknowledge("Invalid option.");
      return;
    }
    if (!state.multiple) {
      await this.#finishInteraction(state, { type: "select", selected: [state.choices[index]!] });
      await acknowledge(state.labels[index]);
      return;
    }
    if (state.selected.has(index)) state.selected.delete(index);
    else state.selected.add(index);
    await this.#refreshInteraction(state);
    await acknowledge();
    void query;
  }

  async #captureReply(message: TgMessage, principalId: string, address: ConversationAddress): Promise<boolean> {
    if (!message.reply_to_message || typeof message.text !== "string") return false;
    for (const state of this.#interactions.values()) {
      if (state.principalId !== principalId || !sameAddress(state.address, address)) continue;
      if (state.prompt?.messageId !== String(message.reply_to_message.message_id)) continue;
      if (state.request.type === "select" && state.awaitingAnswer) {
        state.awaitingAnswer = false;
        state.decisionSettledLabel = "✅ Answered";
        await this.#finishInteraction(state, { type: "select", selected: [message.text] }, "approved");
        return true;
      }
      if (state.request.type !== "input" && state.request.type !== "editor") continue;
      await this.#finishInteraction(
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

  async #finishInteraction(
    state: InteractiveState,
    response: InteractiveResponse,
    decisionState?: Extract<DecisionCardState, "approved" | "denied" | "expired">,
  ): Promise<void> {
    if (!this.#interactions.delete(state.id)) return;
    clearTimeout(state.timeout);
    state.detachAbort?.();
    this.#store.deletePendingInteraction(state.id);
    const decision =
      state.request.type === "confirm" ||
      (state.request.type === "select" && state.request.presentation === "decision");
    if (decisionState !== undefined && decision) {
      state.decisionState = decisionState;
      await this.#refreshInteraction(state, false).catch(() => undefined);
    } else if (state.prompt) {
      await this.#outbound
        .setReplyMarkup(state.address, state.prompt, { inline_keyboard: [] }, state.context)
        .catch(() => undefined);
    }
    state.settle(response);
  }

  #failInteraction(state: InteractiveState, error: unknown): void {
    if (!this.#interactions.delete(state.id)) return;
    clearTimeout(state.timeout);
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

  #pairingCardFor(
    identity: TransportIdentity,
    address: ConversationAddress,
    messageId?: string,
  ): DurablePairingCard | undefined {
    for (const pending of this.#store.listPendingInteractions(address)) {
      const card = pairingCardFromPending(pending);
      if (
        card !== undefined &&
        sameIdentity(card.identity, identity) &&
        (messageId === undefined || card.prompt?.messageId === messageId)
      ) {
        return card;
      }
    }
    return undefined;
  }

  #persistPairingCard(card: DurablePairingCard): void {
    this.#store.putPendingInteraction({
      id: card.id,
      address: card.address,
      kind: "pairing",
      payload: {
        schemaVersion: 1,
        identity: {
          transport: card.identity.transport,
          account: card.identity.account,
          subject: card.identity.subject,
        },
        state: card.state,
        expiresAt: card.expiresAt,
        ...(card.principalId === undefined ? {} : { principalId: card.principalId }),
        ...(card.prompt === undefined ? {} : { promptMessageId: card.prompt.messageId }),
      },
      createdAt: card.createdAt,
    });
  }

  #pairingCardContext(card: DurablePairingCard): DeliveryContext {
    return {
      principal: { id: card.principalId ?? `telegram-unresolved:${card.identity.subject}`, roles: [] },
      origin: card.address,
    };
  }

  #renderPairingCard(card: DurablePairingCard, code?: string): TelegramCardRender {
    const remainingMs = Math.max(0, card.expiresAt - this.#clock());
    const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    const expiresIn = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
    return renderPairingJourneyCard(
      {
        state: card.state,
        ...(card.state === "pending" && code !== undefined ? { code } : {}),
        ...(card.state === "pending" ? { expiresIn } : {}),
      },
      (action) => `${PAIRING_CALLBACK}:${action}`,
    );
  }

  async #settlePairingCard(
    card: DurablePairingCard,
    state: PairingJourneyCardState,
    principalId?: string,
    signal?: AbortSignal,
  ): Promise<DurablePairingCard> {
    const next: DurablePairingCard = {
      ...card,
      state,
      ...(principalId === undefined ? {} : { principalId }),
    };
    if (next.prompt !== undefined) {
      const rendered = this.#renderPairingCard(next);
      const receipts = await this.#outbound.replaceMessages(
        next.address,
        [next.prompt],
        rendered.text,
        this.#pairingCardContext(next),
        { replyMarkup: this.#cardReplyMarkup(rendered) },
        signal,
      );
      const prompt = receipts.at(-1);
      if (prompt === undefined) throw new Error("Telegram pairing card update did not return a receipt");
      next.prompt = prompt;
    }
    this.#persistPairingCard(next);
    return next;
  }

  async #sendPairingChallenge(message: TgMessage, identity: TransportIdentity): Promise<void> {
    const pairing = this.#pairing;
    if (pairing === undefined) return;
    const address = telegramAddress(message, this.#account);
    const challenge = pairing.requestFromTransport(identity, address, this.#clock());
    if (challenge.status === "capacity") {
      await this.#outbound.sendMessage(
        address,
        [
          "Pairing is temporarily unavailable because this Telegram account has too many pending requests.",
          "Ask the gateway operator to approve or clear an existing request, then try again.",
        ].join("\n"),
        { principal: { id: `telegram-unresolved:${identity.subject}`, roles: [] }, origin: address },
      );
      return;
    }

    const { code, request } = challenge.result;
    const previous = this.#pairingCardFor(identity, address);
    const card: DurablePairingCard = {
      id: previous?.id ?? `pairing:${encodeURIComponent(identity.account)}:${encodeURIComponent(identity.subject)}`,
      identity,
      address,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      state: "pending",
      ...(previous?.prompt === undefined ? {} : { prompt: previous.prompt }),
    };
    const rendered = this.#renderPairingCard(card, code);
    const context = this.#pairingCardContext(card);
    if (card.prompt === undefined) {
      card.prompt = await this.#outbound.sendMessage(address, rendered.text, context, {
        replyMarkup: this.#cardReplyMarkup(rendered),
      });
    } else {
      const receipts = await this.#outbound.replaceMessages(address, [card.prompt], rendered.text, context, {
        replyMarkup: this.#cardReplyMarkup(rendered),
      });
      const prompt = receipts.at(-1);
      if (prompt === undefined) throw new Error("Telegram pairing card creation did not return a receipt");
      card.prompt = prompt;
    }
    this.#persistPairingCard(card);
  }

  async #handlePairingCardCallback(
    query: TgCallbackQuery,
    identity: TransportIdentity,
    address: ConversationAddress,
    updateId: number,
    context: TransportStartContext,
    acknowledge: (text?: string, alert?: boolean) => Promise<unknown>,
  ): Promise<void> {
    const message = query.message;
    const action = query.data?.slice(`${PAIRING_CALLBACK}:`.length);
    if (message === undefined || action === undefined) {
      await acknowledge("This control is no longer available.");
      return;
    }
    const card = this.#pairingCardFor(identity, address, String(message.message_id));
    if (card === undefined) {
      await acknowledge("This control has expired.");
      return;
    }
    if (action === "retry") {
      if (card.state !== "rejected" && card.state !== "expired") {
        await acknowledge("This pairing request is still active.");
        return;
      }
      await acknowledge("Requesting a new pairing code.");
      await this.#sendPairingChallenge(message, identity);
      return;
    }
    const principal = await context.resolveIdentity(identity, context.signal);
    if (principal === undefined || card.principalId !== principal.id) {
      await acknowledge("Not authorized.", true);
      return;
    }
    if (action === "examples" && card.state === "connected") {
      await this.#settlePairingCard(card, "examples", principal.id, context.signal);
      await acknowledge("Examples shown.");
      return;
    }
    if (action === "dismiss" && card.state === "examples") {
      await this.#settlePairingCard(card, "connected", principal.id, context.signal);
      await acknowledge("Examples dismissed.");
      return;
    }
    if (action !== "home" || card.state !== "connected") {
      await acknowledge("This control has expired.");
      return;
    }
    await acknowledge("Opening Home.");
    await context.receive(
      {
        id: `telegram:${this.#account}:pairing:${updateId}`,
        sentAt: this.#clock(),
        identity,
        address,
        content: { text: "/home" },
        sourceReceipt: { transport: "telegram", messageId: String(message.message_id) },
        edited: false,
      },
      context.signal,
    );
  }

  #schedulePairingApprovalDrain(): Promise<void> | undefined {
    if (this.#context === undefined) return;
    if (this.#pairingApprovalDrain !== undefined) return this.#pairingApprovalDrain;
    const drain = this.#drainPairingApprovals()
      .catch((error) => {
        this.#log?.warn(
          `[telegram] pairing approval check failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (this.#pairingApprovalDrain === drain) this.#pairingApprovalDrain = undefined;
      });
    this.#pairingApprovalDrain = drain;
    return drain;
  }

  async #drainPairingApprovals(): Promise<void> {
    const pairing = this.#pairing;
    const context = this.#context;
    if (pairing === undefined || context === undefined) return;
    const requests =
      pairing.list === undefined
        ? pairing.listUnconfirmedApprovals("telegram", this.#account)
        : pairing.list(this.#clock());
    const cards = this.#store
      .listPendingInteractions()
      .map(pairingCardFromPending)
      .filter((card): card is DurablePairingCard => card !== undefined);
    for (const card of cards) {
      const request = requests.find((candidate) => sameIdentity(candidate.identity, card.identity));
      if (request === undefined) continue;
      const state = pairingJourneyState(request);
      try {
        if (state === "connected") {
          const principal = await context.resolveIdentity(request.identity, context.signal);
          if (principal === undefined || principal.id !== request.principalId) continue;
          if (card.state !== "connected" && card.state !== "examples") {
            await this.#settlePairingCard(card, "connected", principal.id, context.signal);
          }
          pairing.completeConfirmation(request.identity, this.#clock());
          continue;
        }
        if (state !== card.state) await this.#settlePairingCard(card, state, undefined, context.signal);
      } catch (error) {
        if (context.signal?.aborted) return;
        this.#log?.warn(
          `[telegram] pairing confirmation failed for user ${request.identity.subject}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
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
  async #refreshBotProfile(signal?: AbortSignal): Promise<void> {
    let name: string | undefined;
    try {
      const bot = await this.#telegram("getMe", {}, signal);
      if (isRecord(bot) && typeof bot.first_name === "string" && bot.first_name.trim().length > 0) {
        name = bot.first_name.trim();
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      this.#log?.warn(
        `[telegram] bot profile identity lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const failures = await refreshTelegramBotProfile(
      (method, payload, options) => this.#telegram(method, payload ?? {}, options?.signal),
      {
        description: TELEGRAM_BOT_DESCRIPTION,
        shortDescription: TELEGRAM_BOT_SHORT_DESCRIPTION,
        ...(name === undefined ? {} : { name }),
      },
      signal,
    );
    for (const failure of failures) {
      this.#log?.warn(
        `[telegram] bot profile ${failure.method} failed: ${
          failure.error instanceof Error ? failure.error.message : String(failure.error)
        }`,
      );
    }
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
