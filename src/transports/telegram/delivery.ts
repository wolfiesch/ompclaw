import { randomInt } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ConversationAddress,
  DeliveryContext,
  OutboundContent,
  OutboundReceipt,
  Reaction,
} from "../../gateway-types";
import { isMissingThreadError, TgError, tg, tgUpload, type Logger, withTelegramRetry } from "./bot-api";
import { chunkLabeled, mdToMarkdownV2, TELEGRAM_MAX_CHARS } from "./formatting";

const DRAFT_MARKER = "draft:";
const TYPING_MARKER = "typing:";
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const TYPING_REFRESH_MS = 4_000;
const TELEGRAM_PHOTO_EXTENSIONS = new Set([".avif", ".jpeg", ".jpg", ".png", ".webp"]);

export interface TelegramRequestOptions {
  readonly signal?: AbortSignal;
}

export type TelegramCall = (
  method: string,
  payload?: Record<string, unknown>,
  options?: TelegramRequestOptions,
) => Promise<unknown>;

export type TelegramUpload = (
  method: string,
  fields: Record<string, string | number | undefined>,
  file: Readonly<{ field: string; path: string; filename?: string }>,
  options?: TelegramRequestOptions,
) => Promise<unknown>;

export type TelegramAddressAuthorizer = (
  address: ConversationAddress,
  context: DeliveryContext,
) => boolean | void | Promise<boolean | void>;

export interface TelegramMessageOptions {
  readonly replyMarkup?: Record<string, unknown>;
  readonly replyTo?: OutboundReceipt;
  readonly parseMode?: "MarkdownV2";
  readonly plainFallbackText?: string;
}

export interface OutboundOptions {
  readonly token: string;
  readonly account?: string;
  readonly authorizeAddress: TelegramAddressAuthorizer;
  readonly logger?: Logger;
  readonly callTelegram?: TelegramCall;
  readonly uploadTelegram?: TelegramUpload;
  readonly nextDraftId?: () => number;
}

type RenderedText = Readonly<{
  wireText: string;
  plainText: string;
  parseMode?: "MarkdownV2";
}>;

function receipt(id: number | string): OutboundReceipt {
  return { transport: "telegram", messageId: String(id) };
}

function syntheticId(value: OutboundReceipt | undefined, prefix: string): number | undefined {
  if (value?.transport !== "telegram" || !value.messageId.startsWith(prefix)) return undefined;
  const id = Number(value.messageId.slice(prefix.length));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function telegramDraftId(value: OutboundReceipt | undefined): number | undefined {
  return syntheticId(value, DRAFT_MARKER);
}

function typingId(value: OutboundReceipt | undefined): number | undefined {
  return syntheticId(value, TYPING_MARKER);
}

function messageId(value: OutboundReceipt): number {
  if (value.transport !== "telegram") throw new Error("Telegram delivery can only use Telegram receipts");
  const id = Number(value.messageId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Telegram receipt must contain a positive message id");
  return id;
}

function messageIdFromResult(value: unknown, operation: string): number {
  if (value !== null && typeof value === "object" && "message_id" in value && typeof value.message_id === "number") {
    return value.message_id;
  }
  throw new Error(`Telegram ${operation} returned no message_id`);
}

function topicId(address: ConversationAddress): number | undefined {
  if (address.thread === undefined) return undefined;
  const id = Number(address.thread);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Telegram thread must be a positive numeric identifier");
  return id;
}

function messageBase(address: ConversationAddress): Record<string, unknown> {
  const thread = topicId(address);
  return {
    chat_id: address.channel,
    ...(thread === undefined ? {} : { message_thread_id: thread }),
  };
}

function parseFailure(error: unknown): boolean {
  return error instanceof TgError && error.code === 400 && /parse entities|markdown/i.test(error.message);
}

function unchangedMessage(error: unknown): boolean {
  return error instanceof TgError && error.code === 400 && /message is not modified/i.test(error.message);
}

function draftsUnavailable(error: unknown): boolean {
  return error instanceof TgError
    && error.code === 400
    && /method.*not found|not supported|private chat|draft/i.test(error.message);
}

function renderText(text: string, format: OutboundContent["format"]): readonly RenderedText[] {
  const plainParts = chunkLabeled(text, TELEGRAM_MAX_CHARS, "newline");
  if (format !== "markdown") return plainParts.map((part) => ({ wireText: part, plainText: part }));
  const markdownParts = chunkLabeled(mdToMarkdownV2(text), TELEGRAM_MAX_CHARS, "newline");
  return markdownParts.map((part, index) => ({
    wireText: part,
    plainText: plainParts[index] ?? part,
    parseMode: "MarkdownV2",
  }));
}

function attachmentPath(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Telegram attachments require a local file URL");
  }
  if (parsed.protocol !== "file:") throw new Error("Telegram attachments require a local file URL");
  return fileURLToPath(parsed);
}

function safeUploadName(requested: string | undefined): string | undefined {
  if (requested === undefined) return undefined;
  const leaf = basename(requested.replaceAll("\\", "/")).trim();
  return leaf.length === 0 ? undefined : leaf.slice(0, 255);
}

function photoAttachment(path: string, mediaType: string | undefined): boolean {
  if (mediaType !== undefined) return mediaType.toLowerCase().startsWith("image/") && mediaType !== "image/gif";
  return TELEGRAM_PHOTO_EXTENSIONS.has(extname(path).toLowerCase());
}

export class Outbound {
  readonly #account: string;
  readonly #authorize: TelegramAddressAuthorizer;
  readonly #log: Logger | undefined;
  readonly #call: TelegramCall;
  readonly #upload: TelegramUpload;
  readonly #draftId: () => number;
  readonly #typing = new Map<number, NodeJS.Timeout>();

  constructor(options: OutboundOptions) {
    if (options.token.length === 0) throw new Error("Telegram bot token is required");
    this.#account = options.account ?? "default";
    this.#authorize = options.authorizeAddress;
    this.#log = options.logger;
    this.#draftId = options.nextDraftId ?? (() => randomInt(1, 2_147_483_647));
    this.#call = options.callTelegram ?? ((method, payload = {}, request = {}) =>
      tg(options.token, method, payload, { signal: request.signal }));
    this.#upload = options.uploadTelegram ?? ((method, fields, file, request = {}) =>
      tgUpload(options.token, method, fields, file, { signal: request.signal }));
  }

  async send(
    address: ConversationAddress,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    await this.#assertTarget(address, context);
    signal?.throwIfAborted();
    if (content.transient) return this.#startPreview(address, content.text ?? "", context, signal);
    const delivered = await this.#deliverPersistent(address, content, context, signal);
    if (delivered.length === 0) throw new Error("Telegram outbound content is empty");
    return delivered[0]!;
  }

  async update(
    address: ConversationAddress,
    target: OutboundReceipt,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    await this.#assertTarget(address, context);
    signal?.throwIfAborted();
    const draft = telegramDraftId(target);
    if (draft !== undefined) {
      if (!content.transient) return target;
      try {
        await this.#request("sendMessageDraft", {
          ...messageBase(address),
          draft_id: draft,
          can_stop: true,
          text: (content.text ?? "").slice(0, TELEGRAM_MAX_CHARS),
        }, signal, address);
        return target;
      } catch (error) {
        if (!draftsUnavailable(error)) throw error;
        await this.#beginTyping(address, draft, signal);
        return receipt(`${TYPING_MARKER}${draft}`);
      }
    }
    if (typingId(target) !== undefined) return target;
    if (content.text === undefined) return target;
    await this.#editText(address, target, content.text, content.format, signal);
    return target;
  }

  async finalize(
    address: ConversationAddress,
    target: OutboundReceipt | undefined,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<readonly OutboundReceipt[]> {
    await this.#assertTarget(address, context);
    signal?.throwIfAborted();
    const ephemeral = telegramDraftId(target) ?? typingId(target);
    if (ephemeral !== undefined) {
      this.#endTyping(ephemeral);
      return this.#deliverPersistent(address, { ...content, transient: false }, context, signal);
    }
    if (target === undefined) return this.#deliverPersistent(address, { ...content, transient: false }, context, signal);

    const completed: OutboundReceipt[] = [target];
    if (content.text !== undefined) await this.#editText(address, target, content.text, content.format, signal);
    if ((content.attachments?.length ?? 0) > 0) {
      completed.push(...await this.#sendAttachments(address, content.attachments!, context, undefined, signal));
    }
    return completed;
  }

  async sendMessage(
    address: ConversationAddress,
    text: string,
    context: DeliveryContext,
    options: TelegramMessageOptions = {},
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    await this.#assertTarget(address, context);
    const result = await this.#sendOneText(address, {
      wireText: text,
      plainText: options.plainFallbackText ?? text,
      parseMode: options.parseMode,
    }, {
      replyTo: options.replyTo,
      replyMarkup: options.replyMarkup,
    }, signal);
    return result;
  }

  async setReplyMarkup(
    address: ConversationAddress,
    target: OutboundReceipt,
    replyMarkup: Record<string, unknown>,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#assertTarget(address, context);
    await this.#request("editMessageReplyMarkup", {
      ...messageBase(address),
      message_id: messageId(target),
      reply_markup: replyMarkup,
    }, signal, address);
  }

  async react(
    address: ConversationAddress,
    target: OutboundReceipt,
    reaction: Reaction,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#assertTarget(address, context);
    await this.#request("setMessageReaction", {
      ...messageBase(address),
      message_id: messageId(target),
      reaction: [{ type: "emoji", emoji: reaction.emoji }],
    }, signal, address);
  }

  async #startPreview(
    address: ConversationAddress,
    text: string,
    _context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    const draft = this.#draftId();
    try {
      await this.#request("sendMessageDraft", {
        ...messageBase(address),
        draft_id: draft,
        can_stop: true,
        text: text.slice(0, TELEGRAM_MAX_CHARS),
      }, signal, address);
      return receipt(`${DRAFT_MARKER}${draft}`);
    } catch (error) {
      if (!draftsUnavailable(error)) throw error;
      await this.#beginTyping(address, draft, signal);
      return receipt(`${TYPING_MARKER}${draft}`);
    }
  }

  async #deliverPersistent(
    address: ConversationAddress,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt[]> {
    const delivered: OutboundReceipt[] = [];
    let pendingReply = content.replyTo;
    if (content.text !== undefined && content.text.length > 0) {
      const pieces = renderText(content.text, content.format);
      for (const piece of pieces) {
        delivered.push(await this.#sendOneText(address, piece, { replyTo: pendingReply }, signal));
        pendingReply = undefined;
      }
    }
    if ((content.attachments?.length ?? 0) > 0) {
      delivered.push(...await this.#sendAttachments(address, content.attachments!, context, pendingReply, signal));
    }
    return delivered;
  }

  async #sendOneText(
    address: ConversationAddress,
    text: RenderedText,
    options: Readonly<{ replyTo?: OutboundReceipt; replyMarkup?: Record<string, unknown> }>,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    const payload: Record<string, unknown> = {
      ...messageBase(address),
      text: text.wireText,
      ...(text.parseMode === undefined ? {} : { parse_mode: text.parseMode }),
      ...(options.replyMarkup === undefined ? {} : { reply_markup: options.replyMarkup }),
      ...(options.replyTo === undefined ? {} : { reply_to_message_id: messageId(options.replyTo) }),
    };
    let result: unknown;
    try {
      result = await this.#request("sendMessage", payload, signal, address);
    } catch (error) {
      if (text.parseMode === undefined || !parseFailure(error)) throw error;
      const plain: Record<string, unknown> = { ...payload, text: text.plainText };
      delete plain.parse_mode;
      result = await this.#request("sendMessage", plain, signal, address);
    }
    return receipt(messageIdFromResult(result, "sendMessage"));
  }

  async #editText(
    address: ConversationAddress,
    target: OutboundReceipt,
    text: string,
    format: OutboundContent["format"],
    signal?: AbortSignal,
  ): Promise<void> {
    const [first, ...remaining] = renderText(text, format);
    if (first === undefined) return;
    const payload: Record<string, unknown> = {
      ...messageBase(address),
      message_id: messageId(target),
      text: first.wireText,
      ...(first.parseMode === undefined ? {} : { parse_mode: first.parseMode }),
    };
    try {
      await this.#request("editMessageText", payload, signal, address);
    } catch (error) {
      if (unchangedMessage(error)) return;
      if (first.parseMode === undefined || !parseFailure(error)) throw error;
      const plain: Record<string, unknown> = { ...payload, text: first.plainText };
      delete plain.parse_mode;
      try {
        await this.#request("editMessageText", plain, signal, address);
      } catch (plainError) {
        if (!unchangedMessage(plainError)) throw plainError;
      }
    }
    for (const part of remaining) await this.#sendOneText(address, part, {}, signal);
  }

  async #sendAttachments(
    address: ConversationAddress,
    attachments: NonNullable<OutboundContent["attachments"]>,
    _context: DeliveryContext,
    replyTo: OutboundReceipt | undefined,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt[]> {
    const receipts: OutboundReceipt[] = [];
    let pendingReply = replyTo;
    for (const attachment of attachments) {
      const path = attachmentPath(attachment.url);
      const details = await stat(path);
      if (!details.isFile()) throw new Error(`Telegram attachment is not a regular file: ${path}`);
      if (details.size > MAX_ATTACHMENT_BYTES) throw new Error(`Telegram attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
      const photo = photoAttachment(path, attachment.mediaType);
      const method = photo ? "sendPhoto" : "sendDocument";
      const field = photo ? "photo" : "document";
      const fields: Record<string, string | number | undefined> = {
        chat_id: address.channel,
        message_thread_id: topicId(address),
        reply_to_message_id: pendingReply === undefined ? undefined : messageId(pendingReply),
      };
      const result = await this.#uploadRequest(method, fields, {
        field,
        path,
        filename: safeUploadName(attachment.name),
      }, signal, address);
      receipts.push(receipt(messageIdFromResult(result, method)));
      pendingReply = undefined;
    }
    return receipts;
  }

  async #beginTyping(address: ConversationAddress, id: number, signal?: AbortSignal): Promise<void> {
    await this.#request("sendChatAction", { ...messageBase(address), action: "typing" }, signal, address);
    this.#endTyping(id);
    const timer = setInterval(() => {
      void this.#request("sendChatAction", { ...messageBase(address), action: "typing" }, undefined, address)
        .catch((error) => this.#log?.warn(`[telegram] typing refresh failed: ${error instanceof Error ? error.message : String(error)}`));
    }, TYPING_REFRESH_MS);
    timer.unref?.();
    this.#typing.set(id, timer);
  }

  #endTyping(id: number): void {
    const timer = this.#typing.get(id);
    if (timer !== undefined) clearInterval(timer);
    this.#typing.delete(id);
  }

  async #request(
    method: string,
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
    address: ConversationAddress,
  ): Promise<unknown> {
    try {
      return await withTelegramRetry(() => this.#call(method, payload, { signal }), { log: this.#log, signal });
    } catch (error) {
      if (!isMissingThreadError(error) || address.thread === undefined || !("message_thread_id" in payload)) throw error;
      const rootPayload = { ...payload };
      delete rootPayload.message_thread_id;
      this.#log?.warn(`[telegram] topic ${address.thread} is unavailable; retrying in the root chat`);
      return withTelegramRetry(() => this.#call(method, rootPayload, { signal }), { log: this.#log, signal });
    }
  }

  async #uploadRequest(
    method: string,
    fields: Record<string, string | number | undefined>,
    file: Readonly<{ field: string; path: string; filename?: string }>,
    signal: AbortSignal | undefined,
    address: ConversationAddress,
  ): Promise<unknown> {
    try {
      return await withTelegramRetry(() => this.#upload(method, fields, file, { signal }), { log: this.#log, signal });
    } catch (error) {
      if (!isMissingThreadError(error) || address.thread === undefined || fields.message_thread_id === undefined) throw error;
      const rootFields = { ...fields, message_thread_id: undefined };
      this.#log?.warn(`[telegram] topic ${address.thread} is unavailable; retrying attachment in the root chat`);
      return withTelegramRetry(() => this.#upload(method, rootFields, file, { signal }), { log: this.#log, signal });
    }
  }

  async #assertTarget(address: ConversationAddress, context: DeliveryContext): Promise<void> {
    if (address.transport !== "telegram") throw new Error("Expected a Telegram address");
    if (address.account !== this.#account) throw new Error("Telegram delivery cannot target another account");
    if (await this.#authorize(address, context) === false) throw new Error("Telegram delivery address is not authorized");
  }
}
