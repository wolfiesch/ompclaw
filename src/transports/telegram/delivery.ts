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
import { isMissingThreadError, TgError, tg, tgUpload, tgUploadMany, type Logger, withTelegramRetry } from "./bot-api";
import { chunkLabeled, renderMarkdownParts, TELEGRAM_MAX_CHARS } from "./formatting";

const DRAFT_MARKER = "draft:";
const TYPING_MARKER = "typing:";
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const TELEGRAM_PHOTO_EXTENSIONS = new Set([".avif", ".jpeg", ".jpg", ".png", ".webp"]);
const TELEGRAM_CAPTION_MAX_CHARS = 1_024;
const TELEGRAM_ALBUM_MAX_ITEMS = 10;

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

export type TelegramMultiUpload = (
  method: string,
  fields: Record<string, string | number | undefined>,
  files: readonly Readonly<{ field: string; path: string; filename?: string }>[],
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
  readonly notification?: OutboundContent["notification"];
}

export interface OutboundOptions {
  readonly token: string;
  readonly account?: string;
  readonly authorizeAddress: TelegramAddressAuthorizer;
  readonly logger?: Logger;
  readonly callTelegram?: TelegramCall;
  readonly uploadTelegram?: TelegramUpload;
  readonly uploadTelegramMany?: TelegramMultiUpload;
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

function messageIdsFromGroupResult(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Telegram sendMediaGroup returned no messages");
  return value.map((message) => messageIdFromResult(message, "sendMediaGroup"));
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

function missingDeleteTarget(error: unknown): boolean {
  return error instanceof TgError && error.code === 400 && /message (?:to delete )?not found/i.test(error.message);
}

function draftsUnavailable(error: unknown): boolean {
  return (
    error instanceof TgError &&
    error.code === 400 &&
    /method.*not found|not supported|private chat|draft/i.test(error.message)
  );
}

function renderText(text: string, format: OutboundContent["format"]): readonly RenderedText[] {
  if (format === "markdown") return renderMarkdownParts(text);
  return chunkLabeled(text, TELEGRAM_MAX_CHARS, "newline").map((part) => ({ wireText: part, plainText: part }));
}

function renderDirectText(text: string, options: TelegramMessageOptions): readonly RenderedText[] {
  const wireParts = chunkLabeled(text, TELEGRAM_MAX_CHARS, "newline");
  const plainParts = chunkLabeled(options.plainFallbackText ?? text, TELEGRAM_MAX_CHARS, "newline");
  return wireParts.map((wireText, index) => ({
    wireText,
    plainText: plainParts[index] ?? wireText,
    parseMode: options.parseMode,
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
  readonly #uploadMany: TelegramMultiUpload | undefined;
  readonly #draftId: () => number;

  constructor(options: OutboundOptions) {
    if (options.token.length === 0) throw new Error("Telegram bot token is required");
    this.#account = options.account ?? "default";
    this.#authorize = options.authorizeAddress;
    this.#log = options.logger;
    this.#draftId = options.nextDraftId ?? (() => randomInt(1, 2_147_483_647));
    this.#call =
      options.callTelegram ??
      ((method, payload = {}, request = {}) => tg(options.token, method, payload, { signal: request.signal }));
    this.#upload =
      options.uploadTelegram ??
      ((method, fields, file, request = {}) =>
        tgUpload(options.token, method, fields, file, { signal: request.signal }));
    this.#uploadMany =
      options.uploadTelegramMany ??
      (options.uploadTelegram === undefined
        ? (method, fields, files, request = {}) =>
          tgUploadMany(options.token, method, fields, files, { signal: request.signal })
        : undefined);
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

  async typing(address: ConversationAddress, context: DeliveryContext, signal?: AbortSignal): Promise<void> {
    await this.#assertTarget(address, context);
    signal?.throwIfAborted();
    await this.#request("sendChatAction", { ...messageBase(address), action: "typing" }, signal, address);
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
        await this.#request(
          "sendMessageDraft",
          {
            ...messageBase(address),
            draft_id: draft,
            can_stop: true,
            text: (content.text ?? "").slice(0, TELEGRAM_MAX_CHARS),
          },
          signal,
          address,
        );
        return target;
      } catch (error) {
        if (!draftsUnavailable(error)) throw error;
        await this.typing(address, context, signal);
        return receipt(`${TYPING_MARKER}${draft}`);
      }
    }
    if (typingId(target) !== undefined) return target;
    if (content.text === undefined) return target;
    await this.#editText(address, target, content.text, content.format, content.notification, signal);
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
      return this.#deliverPersistent(address, { ...content, transient: false }, context, signal);
    }
    if (target === undefined)
      return this.#deliverPersistent(address, { ...content, transient: false }, context, signal);

    const completed: OutboundReceipt[] = [target];
    if (content.text !== undefined) {
      await this.#editText(address, target, content.text, content.format, content.notification, signal);
    }
    if ((content.attachments?.length ?? 0) > 0) {
      completed.push(
        ...(await this.#sendAttachments(
          address,
          content.attachments!,
          context,
          undefined,
          content.notification,
          undefined,
          signal,
        )),
      );
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
    const messages = await this.sendMessages(address, text, context, options, signal);
    const result = messages.at(-1);
    if (result === undefined) throw new Error("Telegram message text must not be empty");
    return result;
  }

  async sendMessages(
    address: ConversationAddress,
    text: string,
    context: DeliveryContext,
    options: TelegramMessageOptions = {},
    signal?: AbortSignal,
  ): Promise<readonly OutboundReceipt[]> {
    await this.#assertTarget(address, context);
    const pieces = renderDirectText(text, options);
    const results: OutboundReceipt[] = [];
    for (let index = 0; index < pieces.length; index += 1) {
      results.push(
        await this.#sendOneText(
          address,
          pieces[index]!,
          {
            replyTo: index === 0 ? options.replyTo : undefined,
            replyMarkup: index === pieces.length - 1 ? options.replyMarkup : undefined,
            notification: options.notification,
          },
          signal,
        ),
      );
    }
    return results;
  }

  async replaceMessages(
    address: ConversationAddress,
    targets: readonly OutboundReceipt[],
    text: string,
    context: DeliveryContext,
    options: TelegramMessageOptions = {},
    signal?: AbortSignal,
  ): Promise<readonly OutboundReceipt[]> {
    await this.#assertTarget(address, context);
    const pieces = renderDirectText(text, options);
    const emptyMarkup = { inline_keyboard: [] };
    const retainedNotice: RenderedText = {
      wireText: "Control card content is shown above.",
      plainText: "Control card content is shown above.",
    };
    let retainedTargets = targets;
    if (targets.length > pieces.length) {
      let retainedCount = pieces.length;
      for (let index = targets.length - 1; index >= pieces.length; index -= 1) {
        const target = targets[index]!;
        try {
          await this.#request(
            "deleteMessage",
            {
              ...messageBase(address),
              message_id: messageId(target),
            },
            signal,
            address,
          );
        } catch (error) {
          if (missingDeleteTarget(error)) continue;
          retainedCount = index + 1;
          this.#log?.warn(
            `[telegram] stale control card chunk ${target.messageId} could not be deleted and will be retained: ${error instanceof Error ? error.message : String(error)}`,
          );
          break;
        }
      }
      retainedTargets = targets.slice(0, retainedCount);
    }
    const results: OutboundReceipt[] = [];
    const count = Math.max(retainedTargets.length, pieces.length);
    for (let index = 0; index < count; index += 1) {
      const target = retainedTargets[index];
      const piece = pieces[index] ?? retainedNotice;
      const replyMarkup = index === count - 1 ? (options.replyMarkup ?? emptyMarkup) : emptyMarkup;
      if (target === undefined) {
        results.push(
          await this.#sendOneText(address, piece, { replyMarkup, notification: options.notification }, signal),
        );
        continue;
      }
      await this.#editOneText(address, target, piece, replyMarkup, signal);
      results.push(target);
    }
    return results;
  }

  async setReplyMarkup(
    address: ConversationAddress,
    target: OutboundReceipt,
    replyMarkup: Record<string, unknown>,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#assertTarget(address, context);
    await this.#request(
      "editMessageReplyMarkup",
      {
        ...messageBase(address),
        message_id: messageId(target),
        reply_markup: replyMarkup,
      },
      signal,
      address,
    );
  }

  async react(
    address: ConversationAddress,
    target: OutboundReceipt,
    reaction: Reaction,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#assertTarget(address, context);
    await this.#request(
      "setMessageReaction",
      {
        ...messageBase(address),
        message_id: messageId(target),
        reaction: [{ type: "emoji", emoji: reaction.emoji }],
      },
      signal,
      address,
    );
  }

  async #startPreview(
    address: ConversationAddress,
    text: string,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    const draft = this.#draftId();
    try {
      await this.#request(
        "sendMessageDraft",
        {
          ...messageBase(address),
          draft_id: draft,
          can_stop: true,
          text: text.slice(0, TELEGRAM_MAX_CHARS),
        },
        signal,
        address,
      );
      return receipt(`${DRAFT_MARKER}${draft}`);
    } catch (error) {
      if (!draftsUnavailable(error)) throw error;
      await this.typing(address, context, signal);
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
    let caption: RenderedText | undefined;
    if (content.text !== undefined && content.text.length > 0 && (content.attachments?.length ?? 0) > 0) {
      const pieces = renderText(content.text, content.format);
      if (pieces.length === 1 && pieces[0]!.wireText.length <= TELEGRAM_CAPTION_MAX_CHARS) caption = pieces[0];
    }
    if (content.text !== undefined && content.text.length > 0 && caption === undefined) {
      const pieces = renderText(content.text, content.format);
      for (const piece of pieces) {
        delivered.push(
          await this.#sendOneText(
            address,
            piece,
            {
              replyTo: pendingReply,
              notification: content.notification,
            },
            signal,
          ),
        );
        pendingReply = undefined;
      }
    }
    if ((content.attachments?.length ?? 0) > 0) {
      delivered.push(
        ...(await this.#sendAttachments(
          address,
          content.attachments!,
          context,
          pendingReply,
          content.notification,
          caption,
          signal,
        )),
      );
    }
    return delivered;
  }

  async #sendOneText(
    address: ConversationAddress,
    text: RenderedText,
    options: Readonly<{
      replyTo?: OutboundReceipt;
      replyMarkup?: Record<string, unknown>;
      notification?: OutboundContent["notification"];
    }>,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    const payload: Record<string, unknown> = {
      ...messageBase(address),
      text: text.wireText,
      ...(text.parseMode === undefined ? {} : { parse_mode: text.parseMode }),
      ...(options.replyMarkup === undefined ? {} : { reply_markup: options.replyMarkup }),
      ...(options.replyTo === undefined ? {} : { reply_to_message_id: messageId(options.replyTo) }),
      ...(options.notification === "silent" ? { disable_notification: true } : {}),
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
    notification: OutboundContent["notification"],
    signal?: AbortSignal,
  ): Promise<void> {
    const [first, ...remaining] = renderText(text, format);
    if (first === undefined) return;
    await this.#editOneText(address, target, first, undefined, signal);
    for (const part of remaining) await this.#sendOneText(address, part, { notification }, signal);
  }

  async #editOneText(
    address: ConversationAddress,
    target: OutboundReceipt,
    text: RenderedText,
    replyMarkup: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      ...messageBase(address),
      message_id: messageId(target),
      text: text.wireText,
      ...(text.parseMode === undefined ? {} : { parse_mode: text.parseMode }),
      ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
    };
    try {
      await this.#request("editMessageText", payload, signal, address);
    } catch (error) {
      if (unchangedMessage(error)) return;
      if (text.parseMode === undefined || !parseFailure(error)) throw error;
      const plain: Record<string, unknown> = { ...payload, text: text.plainText };
      delete plain.parse_mode;
      try {
        await this.#request("editMessageText", plain, signal, address);
      } catch (plainError) {
        if (!unchangedMessage(plainError)) throw plainError;
      }
    }
  }

  async #sendAttachments(
    address: ConversationAddress,
    attachments: NonNullable<OutboundContent["attachments"]>,
    _context: DeliveryContext,
    replyTo: OutboundReceipt | undefined,
    notification: OutboundContent["notification"],
    caption: RenderedText | undefined,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt[]> {
    const prepared = await Promise.all(
      attachments.map(async (attachment) => {
        const path = attachmentPath(attachment.url);
        const details = await stat(path);
        if (!details.isFile()) throw new Error(`Telegram attachment is not a regular file: ${path}`);
        if (details.size > MAX_ATTACHMENT_BYTES)
          throw new Error(`Telegram attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
        return {
          path,
          filename: safeUploadName(attachment.name),
          photo: photoAttachment(path, attachment.mediaType),
        };
      }),
    );
    const receipts: OutboundReceipt[] = [];
    let pendingReply = replyTo;
    let pendingCaption = caption;
    let index = 0;
    while (index < prepared.length) {
      const current = prepared[index]!;
      let albumEnd = index;
      while (albumEnd < prepared.length && albumEnd - index < TELEGRAM_ALBUM_MAX_ITEMS && prepared[albumEnd]!.photo) {
        albumEnd += 1;
      }
      const group = this.#uploadMany === undefined ? [] : prepared.slice(index, albumEnd);
      if (group.length >= 2) {
        const media = (plain: boolean): string =>
          JSON.stringify(
            group.map((_item, groupIndex) => ({
              type: "photo",
              media: `attach://photo${groupIndex}`,
              ...(groupIndex !== 0 || pendingCaption === undefined
                ? {}
                : {
                  caption: plain ? pendingCaption.plainText : pendingCaption.wireText,
                  ...(plain || pendingCaption.parseMode === undefined
                    ? {}
                    : { parse_mode: pendingCaption.parseMode }),
                }),
            })),
          );
        const fields: Record<string, string | number | undefined> = {
          chat_id: address.channel,
          message_thread_id: topicId(address),
          reply_to_message_id: pendingReply === undefined ? undefined : messageId(pendingReply),
          media: media(false),
          ...(notification === "silent" ? { disable_notification: "true" } : {}),
        };
        let result: unknown;
        try {
          result = await this.#uploadManyRequest(
            "sendMediaGroup",
            fields,
            group.map((item, groupIndex) => ({
              field: `photo${groupIndex}`,
              path: item.path,
              filename: item.filename,
            })),
            signal,
            address,
          );
        } catch (error) {
          if (pendingCaption?.parseMode === undefined || !parseFailure(error)) throw error;
          result = await this.#uploadManyRequest(
            "sendMediaGroup",
            { ...fields, media: media(true) },
            group.map((item, groupIndex) => ({
              field: `photo${groupIndex}`,
              path: item.path,
              filename: item.filename,
            })),
            signal,
            address,
          );
        }
        receipts.push(...messageIdsFromGroupResult(result).map(receipt));
        index += group.length;
        pendingReply = undefined;
        pendingCaption = undefined;
        continue;
      }

      const method = current.photo ? "sendPhoto" : "sendDocument";
      const field = current.photo ? "photo" : "document";
      const fields: Record<string, string | number | undefined> = {
        chat_id: address.channel,
        message_thread_id: topicId(address),
        reply_to_message_id: pendingReply === undefined ? undefined : messageId(pendingReply),
        caption: pendingCaption?.wireText,
        parse_mode: pendingCaption?.parseMode,
        ...(notification === "silent" ? { disable_notification: "true" } : {}),
      };
      let result: unknown;
      try {
        result = await this.#uploadRequest(
          method,
          fields,
          { field, path: current.path, filename: current.filename },
          signal,
          address,
        );
      } catch (error) {
        if (pendingCaption?.parseMode === undefined || !parseFailure(error)) throw error;
        result = await this.#uploadRequest(
          method,
          { ...fields, caption: pendingCaption.plainText, parse_mode: undefined },
          { field, path: current.path, filename: current.filename },
          signal,
          address,
        );
      }
      receipts.push(receipt(messageIdFromResult(result, method)));
      index += 1;
      pendingReply = undefined;
      pendingCaption = undefined;
    }
    return receipts;
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
      if (!isMissingThreadError(error) || address.thread === undefined || !("message_thread_id" in payload))
        throw error;
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
      if (!isMissingThreadError(error) || address.thread === undefined || fields.message_thread_id === undefined)
        throw error;
      const rootFields = { ...fields, message_thread_id: undefined };
      this.#log?.warn(`[telegram] topic ${address.thread} is unavailable; retrying attachment in the root chat`);
      return withTelegramRetry(() => this.#upload(method, rootFields, file, { signal }), { log: this.#log, signal });
    }
  }

  async #uploadManyRequest(
    method: string,
    fields: Record<string, string | number | undefined>,
    files: readonly Readonly<{ field: string; path: string; filename?: string }>[],
    signal: AbortSignal | undefined,
    address: ConversationAddress,
  ): Promise<unknown> {
    const upload = this.#uploadMany;
    if (upload === undefined) throw new Error("Telegram media groups are unavailable");
    try {
      return await withTelegramRetry(() => upload(method, fields, files, { signal }), {
        log: this.#log,
        signal,
      });
    } catch (error) {
      if (!isMissingThreadError(error) || address.thread === undefined || fields.message_thread_id === undefined)
        throw error;
      const rootFields = { ...fields, message_thread_id: undefined };
      this.#log?.warn(`[telegram] topic ${address.thread} is unavailable; retrying media group in the root chat`);
      return withTelegramRetry(() => upload(method, rootFields, files, { signal }), {
        log: this.#log,
        signal,
      });
    }
  }

  async #assertTarget(address: ConversationAddress, context: DeliveryContext): Promise<void> {
    if (address.transport !== "telegram") throw new Error("Expected a Telegram address");
    if (address.account !== this.#account) throw new Error("Telegram delivery cannot target another account");
    if ((await this.#authorize(address, context)) === false)
      throw new Error("Telegram delivery address is not authorized");
  }
}
