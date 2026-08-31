import { randomInt } from "node:crypto";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname } from "node:path";
import { TgError, tg, tgUpload, type Logger, withTelegramRetry } from "./api";
import type {
  ConversationAddress,
  DeliveryContext,
  OutboundContent,
  OutboundReceipt,
  Reaction,
} from "./gateway-types";
import { TELEGRAM_MAX_CHARS, chunkLabeled, mdToMarkdownV2 } from "./markdown";

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const PHOTO_EXTENSIONS: Record<string, true> = {
  ".avif": true,
  ".gif": true,
  ".jpeg": true,
  ".jpg": true,
  ".png": true,
  ".webp": true,
};
const DRAFT_RECEIPT_PREFIX = "draft:";
const TYPING_RECEIPT_PREFIX = "typing:";

export interface TelegramRequestOptions {
  readonly signal?: AbortSignal;
}

/** Injectable Bot API boundary. Tests should inject this instead of replacing global fetch. */
export type TelegramCall = (
  method: string,
  payload?: Record<string, unknown>,
  options?: TelegramRequestOptions,
) => Promise<unknown>;

export type TelegramUpload = (
  method: string,
  fields: Record<string, string | number | undefined>,
  file: { readonly field: string; readonly path: string; readonly filename?: string },
  options?: TelegramRequestOptions,
) => Promise<unknown>;

/** Server-side delivery guard; Telegram addresses must never be selected by tool input. */
export type TelegramAddressAuthorizer = (
  address: ConversationAddress,
  context: DeliveryContext,
) => boolean | void | Promise<boolean | void>;

export interface TelegramMessageOptions {
  readonly replyMarkup?: Record<string, unknown>;
  readonly replyTo?: OutboundReceipt;
  readonly parseMode?: "MarkdownV2";
  /** Unformatted source used only when Telegram rejects MarkdownV2 parsing. */
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

interface TelegramMessage {
  readonly message_id: number;
}

function receipt(messageId: number | string): OutboundReceipt {
  return { transport: "telegram", messageId: String(messageId) };
}

function isTelegramMessage(value: unknown): value is TelegramMessage {
  if (typeof value !== "object" || value === null || !("message_id" in value)) return false;
  return typeof value.message_id === "number";
}

function messageThread(address: ConversationAddress): number | undefined {
  if (address.thread === undefined) return undefined;
  const thread = Number(address.thread);
  if (!Number.isSafeInteger(thread) || thread <= 0) throw new Error("Telegram thread must be a positive numeric identifier");
  return thread;
}

function messageId(value: OutboundReceipt): number {
  if (value.transport !== "telegram") throw new Error("Telegram delivery can only use Telegram receipts");
  const id = Number(value.messageId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Telegram message receipt must contain a positive numeric id");
  return id;
}

export function telegramDraftId(value: OutboundReceipt | undefined): number | undefined {
  if (value?.transport !== "telegram" || !value.messageId.startsWith(DRAFT_RECEIPT_PREFIX)) return undefined;
  const id = Number(value.messageId.slice(DRAFT_RECEIPT_PREFIX.length));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function typingId(value: OutboundReceipt | undefined): number | undefined {
  if (value?.transport !== "telegram" || !value.messageId.startsWith(TYPING_RECEIPT_PREFIX)) return undefined;
  const id = Number(value.messageId.slice(TYPING_RECEIPT_PREFIX.length));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function transientReceipt(prefix: string, id: number): OutboundReceipt {
  return { transport: "telegram", messageId: `${prefix}${id}` };
}

function contentText(content: OutboundContent): string | undefined {
  if (content.text === undefined) return undefined;
  if (typeof content.text !== "string") throw new Error("Outbound text must be a string");
  return content.text;
}

function attachmentPath(url: string): string {
  let path: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") throw new Error("not a file URL");
    path = fileURLToPath(parsed);
  } catch {
    throw new Error("Telegram attachments must use a local file:// URL");
  }
  return path;
}

function attachmentFilename(path: string, name?: string): string | undefined {
  if (name === undefined) return undefined;
  const normalized = name.replaceAll("\\", "/").split("/").at(-1)?.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, 255) || extname(path) || undefined;
}

function isPhoto(path: string, mediaType?: string): boolean {
  return mediaType?.toLowerCase().startsWith("image/") ?? PHOTO_EXTENSIONS[extname(path).toLowerCase()] === true;
}

function isMarkdownParseError(error: unknown): boolean {
  return error instanceof TgError && error.code === 400 && /parse entities|markdown/i.test(error.message);
}
function isMessageNotModifiedError(error: unknown): boolean {
  return error instanceof TgError && error.code === 400 && /message is not modified/i.test(error.message);
}
function isDraftUnsupportedError(error: unknown): boolean {
  return error instanceof TgError && error.code === 400 && /method.*not found|private chat|not supported|draft/i.test(error.message);
}

function draftText(text: string): string {
  if (text.length <= TELEGRAM_MAX_CHARS) return text;
  return `…${text.slice(-(TELEGRAM_MAX_CHARS - 1))}`;
}


/**
 * Telegram-specific delivery implementation. It deliberately accepts a
 * pre-authorized DeliveryContext, rather than any caller-controlled destination.
 */
export class Outbound {
  readonly #token: string;
  readonly #account: string;
  readonly #authorizeAddress: TelegramAddressAuthorizer;
  readonly #logger?: Logger;
  readonly #callTelegram: TelegramCall;
  readonly #uploadTelegram: TelegramUpload;
  readonly #nextDraftId: () => number;
  readonly #typingTimers = new Map<number, NodeJS.Timeout>();

  constructor(options: OutboundOptions) {
    if (!options.token) throw new Error("Telegram bot token is required");
    this.#token = options.token;
    this.#account = options.account ?? "default";
    this.#authorizeAddress = options.authorizeAddress;
    this.#logger = options.logger;
    this.#callTelegram =
      options.callTelegram ??
      ((method, payload, requestOptions) => tg(this.#token, method, payload, { signal: requestOptions?.signal }));
    this.#uploadTelegram =
      options.uploadTelegram ??
      ((method, fields, file, requestOptions) =>
        tgUpload(this.#token, method, fields, file, undefined, requestOptions?.signal));
    this.#nextDraftId = options.nextDraftId ?? (() => randomInt(1, 2_147_483_647));
  }

  async send(
    address: ConversationAddress,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    await this.#assertAddress(address, context);
    signal?.throwIfAborted();

    if (content.transient === true && !content.attachments?.length) {
      return this.#sendTransient(address, contentText(content) ?? "", content, context, signal);
    }
    const text = contentText(content);
    let first: OutboundReceipt | undefined;
    if (text !== undefined && text.length > 0) {
      for (const part of this.#textParts(text, content.format)) {
        const sent = await this.sendMessage(address, part.text, context, {
          replyTo: first === undefined ? content.replyTo : undefined,
          ...(part.parseMode === "MarkdownV2" ? { parseMode: "MarkdownV2", plainFallbackText: part.plainFallbackText } : {}),
        }, signal);
        first ??= sent;
      }
    }

    for (const attachment of content.attachments ?? []) {
      const sent = await this.#sendAttachment(address, attachment, context, first === undefined ? content.replyTo : undefined, signal);
      first ??= sent;
    }

    if (first === undefined) throw new Error("Telegram delivery requires text or at least one attachment");
    return first;
  }

  async update(
    address: ConversationAddress,
    target: OutboundReceipt,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    await this.#assertAddress(address, context);
    signal?.throwIfAborted();
    const draftId = telegramDraftId(target);
    if (draftId !== undefined) {
      try {
        await this.#sendDraft(address, draftId, contentText(content) ?? "", signal);
        return target;
      } catch (error) {
        if (!isDraftUnsupportedError(error)) throw error;
        const text = contentText(content) ?? "";
        return text.length === 0
          ? this.#startTyping(address, draftId, signal)
          : this.send(address, { ...content, transient: false }, context, signal);
      }
    }
    const pendingTypingId = typingId(target);
    if (pendingTypingId !== undefined) {
      this.#stopTyping(pendingTypingId);
      const text = contentText(content) ?? "";
      return text.length === 0
        ? this.#startTyping(address, pendingTypingId, signal)
        : this.send(address, { ...content, transient: false }, context, signal);
    }
    if (content.attachments?.length) throw new Error("Telegram message updates cannot replace attachments");
    const text = contentText(content);
    if (text === undefined) throw new Error("Telegram message updates require text");
    const part = this.#textParts(text, content.format)[0] ?? { text: "" };
    await this.#editTextPart(address, target, part, false, signal);
    return target;
  }

  async finalize(
    address: ConversationAddress,
    target: OutboundReceipt | undefined,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<readonly OutboundReceipt[]> {
    await this.#assertAddress(address, context);
    signal?.throwIfAborted();
    if (target === undefined) return [await this.send(address, content, context, signal)];
    const draftId = telegramDraftId(target);
    const pendingTypingId = typingId(target);
    if (pendingTypingId !== undefined) this.#stopTyping(pendingTypingId);

    const text = contentText(content);
    const parts = text === undefined ? [] : this.#textParts(text, content.format);
    if (parts.length === 0 && !content.attachments?.length) {
      throw new Error("Telegram finalization requires text or at least one attachment");
    }

    const receipts: OutboundReceipt[] = draftId !== undefined || pendingTypingId !== undefined ? [] : [target];
    const first = parts[0];
    if (first !== undefined) {
      if (draftId !== undefined || pendingTypingId !== undefined) {
        receipts.push(await this.sendMessage(address, first.text, context, {
          ...(first.parseMode === "MarkdownV2"
            ? { parseMode: "MarkdownV2" as const, plainFallbackText: first.plainFallbackText }
            : {}),
        }, signal));
      } else {
        await this.#editTextPart(address, target, first, true, signal);
      }
    }
    for (const part of parts.slice(1)) {
      receipts.push(await this.sendMessage(address, part.text, context, {
        ...(part.parseMode === "MarkdownV2"
          ? { parseMode: "MarkdownV2" as const, plainFallbackText: part.plainFallbackText }
          : {}),
      }, signal));
    }
    for (const attachment of content.attachments ?? []) {
      receipts.push(await this.#sendAttachment(address, attachment, context, undefined, signal));
    }
    return receipts;
  }


  async react(
    address: ConversationAddress,
    target: OutboundReceipt,
    reaction: Reaction,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#assertAddress(address, context);
    signal?.throwIfAborted();
    if (!reaction.emoji) throw new Error("Telegram reactions require an emoji");
    await this.#request(
      "setMessageReaction",
      {
        chat_id: address.channel,
        message_id: messageId(target),
        reaction: [{ type: "emoji", emoji: reaction.emoji }],
        is_big: false,
      },
      signal,
    );
  }

  /** Send a UI/control message while retaining the same authorization and retry rules as normal delivery. */
  async sendMessage(
    address: ConversationAddress,
    text: string,
    context: DeliveryContext,
    options: TelegramMessageOptions = {},
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    await this.#assertAddress(address, context);
    signal?.throwIfAborted();
    const payload: Record<string, unknown> = {
      chat_id: address.channel,
      text: text.slice(0, TELEGRAM_MAX_CHARS),
      ...(messageThread(address) === undefined ? {} : { message_thread_id: messageThread(address) }),
      ...(options.replyTo === undefined ? {} : { reply_to_message_id: messageId(options.replyTo) }),
      ...(options.replyMarkup === undefined ? {} : { reply_markup: options.replyMarkup }),
      ...(options.parseMode === undefined ? {} : { parse_mode: options.parseMode }),
    };

    try {
      const sent = await this.#request("sendMessage", payload, signal);
      if (!isTelegramMessage(sent)) throw new Error("Telegram sendMessage returned no message_id");
      return receipt(sent.message_id);
    } catch (error) {
      if (options.parseMode !== "MarkdownV2" || !isMarkdownParseError(error)) throw error;
      const fallbackText = options.plainFallbackText ?? text;
      const sent = await this.#request(
        "sendMessage",
        { ...payload, parse_mode: undefined, text: fallbackText.slice(0, TELEGRAM_MAX_CHARS) },
        signal,
      );
      if (!isTelegramMessage(sent)) throw new Error("Telegram sendMessage returned no message_id");
      return receipt(sent.message_id);
    }
  }

  async setReplyMarkup(
    address: ConversationAddress,
    target: OutboundReceipt,
    replyMarkup: Record<string, unknown>,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#assertAddress(address, context);
    await this.#request(
      "editMessageReplyMarkup",
      { chat_id: address.channel, message_id: messageId(target), reply_markup: replyMarkup },
      signal,
    );
  }

  async #sendTransient(
    address: ConversationAddress,
    text: string,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    const id = this.#nextDraftId();
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Telegram draft ID must be a positive safe integer");
    try {
      await this.#sendDraft(address, id, text, signal);
      return transientReceipt(DRAFT_RECEIPT_PREFIX, id);
    } catch (error) {
      if (!isDraftUnsupportedError(error)) throw error;
      if (text.length > 0) return this.send(address, { ...content, transient: false }, context, signal);
      return this.#startTyping(address, id, signal);
    }
  }

  async #sendDraft(
    address: ConversationAddress,
    draftId: number,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.#request(
      "sendMessageDraft",
      {
        chat_id: address.channel,
        ...(messageThread(address) === undefined ? {} : { message_thread_id: messageThread(address) }),
        draft_id: draftId,
        text: draftText(text),
        can_stop: true,
        keep_on_stop: true,
      },
      signal,
    );
    if (result !== true) throw new Error("Telegram sendMessageDraft did not return true");
  }

  async #startTyping(
    address: ConversationAddress,
    id: number,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    await this.#request(
      "sendChatAction",
      {
        chat_id: address.channel,
        ...(messageThread(address) === undefined ? {} : { message_thread_id: messageThread(address) }),
        action: "typing",
      },
      signal,
    );
    this.#stopTyping(id);
    const timer = setInterval(() => {
      void this.#request(
        "sendChatAction",
        {
          chat_id: address.channel,
          ...(messageThread(address) === undefined ? {} : { message_thread_id: messageThread(address) }),
          action: "typing",
        },
      ).catch((error: unknown) => {
        this.#logger?.warn(`[telegram] could not refresh typing action: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 4_000);
    timer.unref?.();
    this.#typingTimers.set(id, timer);
    return transientReceipt(TYPING_RECEIPT_PREFIX, id);
  }

  #stopTyping(id: number): void {
    const timer = this.#typingTimers.get(id);
    if (timer !== undefined) clearInterval(timer);
    this.#typingTimers.delete(id);
  }

  async #editTextPart(
    address: ConversationAddress,
    target: OutboundReceipt,
    part: { readonly text: string; readonly parseMode?: "MarkdownV2"; readonly plainFallbackText?: string },
    allowUnmodified: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      chat_id: address.channel,
      message_id: messageId(target),
      text: part.text,
      ...(messageThread(address) === undefined ? {} : { message_thread_id: messageThread(address) }),
      ...(part.parseMode === undefined ? {} : { parse_mode: part.parseMode }),
    };
    try {
      await this.#request("editMessageText", payload, signal);
    } catch (error) {
      if (allowUnmodified && isMessageNotModifiedError(error)) return;
      if (part.parseMode !== "MarkdownV2" || !isMarkdownParseError(error)) throw error;
      try {
        await this.#request(
          "editMessageText",
          { ...payload, text: part.plainFallbackText ?? part.text, parse_mode: undefined },
          signal,
        );
      } catch (fallbackError) {
        if (allowUnmodified && isMessageNotModifiedError(fallbackError)) return;
        throw fallbackError;
      }
    }
  }

  async #sendAttachment(
    address: ConversationAddress,
    attachment: { readonly url: string; readonly name?: string; readonly mediaType?: string },
    context: DeliveryContext,
    replyTo: OutboundReceipt | undefined,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    const path = attachmentPath(attachment.url);
    const info = await stat(path);
    if (!info.isFile()) throw new Error("Telegram attachments must point to a regular file");
    if (info.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Telegram attachment is too large (${info.size} bytes, max ${MAX_ATTACHMENT_BYTES})`);
    }

    const photo = isPhoto(path, attachment.mediaType);
    const method = photo ? "sendPhoto" : "sendDocument";
    const field = photo ? "photo" : "document";
    const sent = await this.#upload(method, {
      chat_id: address.channel,
      message_thread_id: messageThread(address),
      reply_to_message_id: replyTo === undefined ? undefined : messageId(replyTo),
    }, { field, path, filename: attachmentFilename(path, attachment.name) }, signal);
    if (!isTelegramMessage(sent)) throw new Error(`Telegram ${method} returned no message_id`);
    return receipt(sent.message_id);
  }

  #textParts(
    text: string,
    format: OutboundContent["format"],
  ): Array<{ readonly text: string; readonly parseMode?: "MarkdownV2"; readonly plainFallbackText?: string }> {
    if (format !== "markdown") return chunkLabeled(text, TELEGRAM_MAX_CHARS, "newline").map((part) => ({ text: part }));
    const plainParts = chunkLabeled(text, TELEGRAM_MAX_CHARS, "newline");
    return chunkLabeled(mdToMarkdownV2(text), TELEGRAM_MAX_CHARS, "newline").map((part, index) => ({
      text: part,
      parseMode: "MarkdownV2",
      plainFallbackText: plainParts[index] ?? part,
    }));
  }

  async #assertAddress(address: ConversationAddress, context: DeliveryContext): Promise<void> {
    if (address.transport !== "telegram") throw new Error("Telegram outbound requires a Telegram address");
    if (address.account !== this.#account) throw new Error("Telegram outbound address belongs to another account");
    const result = await this.#authorizeAddress(address, context);
    if (result === false) throw new Error("Telegram delivery address is not authorized for this context");
  }

  async #request(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    return withTelegramRetry(() => this.#callTelegram(method, payload, { signal }), { signal, log: this.#logger });
  }

  async #upload(
    method: string,
    fields: Record<string, string | number | undefined>,
    file: { readonly field: string; readonly path: string; readonly filename?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    return withTelegramRetry(() => this.#uploadTelegram(method, fields, file, { signal }), { signal, log: this.#logger });
  }
}
