import { randomBytes } from "node:crypto";
import type { TgCallbackQuery, TgMessage } from "./api";
import type { TelegramCall } from "./control";
import type { RpcExtensionUiRequest, RpcExtensionUiResponse } from "./rpc-protocol";

export interface RpcTelegramTarget {
  chatId: string;
  chatType: string;
  responderId: string;
  threadId?: number;
}

export interface RpcUiLogger {
  warn(message: string): void;
}

interface RpcUiBrokerOptions {
  callTelegram: TelegramCall;
  sendResponse(response: RpcExtensionUiResponse): void;
  getTarget(): RpcTelegramTarget | undefined;
  fallbackTarget(): RpcTelegramTarget | undefined;
  isAuthorized(target: RpcTelegramTarget): boolean;
  log: RpcUiLogger;
}

type UiKind = "select" | "confirm" | "input" | "editor" | "multi";

interface PendingUi {
  rpcId?: string;
  nonce: string;
  kind: UiKind;
  target: RpcTelegramTarget;
  messageId: number;
  values: string[];
  selected: Set<number>;
  resolve?: (value: string | string[] | boolean | undefined) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface AskOptions {
  title: string;
  message: string;
  options?: string[];
  multi?: boolean;
}

const callbackData = (pending: PendingUi, action: string): string => `rui:${pending.nonce}:${action}`;

/** Bridges every OMP RPC UI request to authenticated Telegram messages and callbacks. */
export class RpcUiBroker {
  readonly #options: RpcUiBrokerOptions;
  readonly #pendingByNonce = new Map<string, PendingUi>();
  readonly #pendingByRpcId = new Map<string, PendingUi>();
  readonly #statuses: Record<string, string> = {};
  readonly #widgets: Record<string, string[]> = {};
  #title = "OMP";
  #editorText = "";

  constructor(options: RpcUiBrokerOptions) {
    this.#options = options;
  }

  statusText(): string {
    const lines = [`Surface: ${this.#title}`];
    for (const [key, value] of Object.entries(this.#statuses)) lines.push(`${key}: ${value}`);
    for (const [key, value] of Object.entries(this.#widgets)) lines.push(`${key}: ${value.join(" | ")}`);
    if (this.#editorText) lines.push(`Suggested input: ${this.#editorText}`);
    return lines.join("\n");
  }

  async handle(request: RpcExtensionUiRequest): Promise<void> {
    if (request.method === "cancel") {
      await this.cancel(request.targetId);
      return;
    }
    if (request.method === "notify") {
      const target = this.#target();
      await this.#options.callTelegram("sendMessage", {
        chat_id: target.chatId,
        message_thread_id: target.threadId,
        text: request.message,
      });
      return;
    }
    if (request.method === "setStatus") {
      if (request.statusText) this.#statuses[request.statusKey] = request.statusText;
      else delete this.#statuses[request.statusKey];
      return;
    }
    if (request.method === "setWidget") {
      if (request.widgetLines) this.#widgets[request.widgetKey] = request.widgetLines;
      else delete this.#widgets[request.widgetKey];
      return;
    }
    if (request.method === "setTitle") {
      this.#title = request.title;
      return;
    }
    if (request.method === "set_editor_text") {
      this.#editorText = request.text;
      return;
    }
    if (request.method === "open_url") {
      const target = this.#target();
      const text = [request.instructions, "Open the secure login URL below."].filter(Boolean).join("\n\n");
      await this.#options.callTelegram("sendMessage", {
        chat_id: target.chatId,
        message_thread_id: target.threadId,
        text,
        reply_markup: { inline_keyboard: [[{ text: "Open URL", url: request.launchUrl ?? request.url }]] },
      });
      return;
    }

    const target = this.#target();
    if (request.method === "select") {
      await this.#createPending(
        {
          rpcId: request.id,
          kind: "select",
          target,
          values: request.options,
          title: request.title,
          message: request.options
            .map((option, index) => {
              const detail = request.optionDetails?.[index]?.description;
              return detail ? `${index + 1}. ${option}\n${detail}` : `${index + 1}. ${option}`;
            })
            .join("\n\n"),
        },
        request.timeout,
      );
      return;
    }
    if (request.method === "confirm") {
      await this.#createPending(
        {
          rpcId: request.id,
          kind: "confirm",
          target,
          values: ["Confirm", "Cancel"],
          title: request.title,
          message: request.message,
        },
        request.timeout,
      );
      return;
    }
    await this.#createPending(
      {
        rpcId: request.id,
        kind: request.method,
        target,
        values: [],
        title: request.title,
        message:
          request.method === "input"
            ? request.placeholder ?? "Reply to this message."
            : [request.prefill, "Reply to this message with the edited text."].filter(Boolean).join("\n\n"),
      },
      request.method === "input" ? request.timeout : undefined,
    );
  }

  ask(options: AskOptions, signal?: AbortSignal): Promise<string | string[] | boolean | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    const target = this.#target();
    const result = Promise.withResolvers<string | string[] | boolean | undefined>();
    let pending: PendingUi | undefined;
    let cancelled = false;
    const cancel = (): void => {
      cancelled = true;
      result.resolve(undefined);
      if (pending) void this.#finish(pending, undefined, true);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    void this.#createPending(
      {
        kind: options.options?.length ? (options.multi ? "multi" : "select") : "input",
        target,
        values: options.options ?? [],
        title: options.title,
        message: options.message,
        resolve: result.resolve,
      },
      undefined,
      signal,
    ).then(
      (created) => {
        pending = created;
        if (cancelled) void this.#finish(created, undefined, true);
      },
      (error: unknown) => {
        if (!cancelled) result.reject(error);
      },
    );
    return result.promise.finally(() => signal?.removeEventListener("abort", cancel));
  }

  async handleCallback(query: TgCallbackQuery): Promise<boolean> {
    const data = query.data;
    if (!data?.startsWith("rui:")) return false;
    const [, nonce, action] = data.split(":", 3);
    const pending = this.#pendingByNonce.get(nonce);
    if (!pending || !query.message) {
      await this.#answerCallback(query.id, "This control has expired.", true);
      return true;
    }
    if (!this.#matchesCallback(pending, query)) {
      await this.#answerCallback(query.id, "This control belongs to another conversation.", true);
      return true;
    }

    if (pending.kind === "multi") {
      if (action === "done") {
        await this.#answerCallback(query.id, "Saved");
        await this.#finish(pending, [...pending.selected].sort((a, b) => a - b).map((index) => pending.values[index]));
        return true;
      }
      if (action === "cancel") {
        await this.#answerCallback(query.id, "Cancelled");
        await this.#finish(pending, undefined, true);
        return true;
      }
      const index = Number(action);
      if (!Number.isSafeInteger(index) || index < 0 || index >= pending.values.length) {
        await this.#answerCallback(query.id, "Invalid option", true);
        return true;
      }
      if (pending.selected.has(index)) pending.selected.delete(index);
      else pending.selected.add(index);
      await this.#answerCallback(query.id, pending.selected.has(index) ? "Selected" : "Removed");
      await this.#options.callTelegram("editMessageReplyMarkup", {
        chat_id: pending.target.chatId,
        message_id: pending.messageId,
        reply_markup: this.#keyboard(pending),
      });
      return true;
    }

    if (pending.kind === "confirm") {
      await this.#answerCallback(query.id);
      await this.#finish(pending, action === "yes");
      return true;
    }
    const index = Number(action);
    if (!Number.isSafeInteger(index) || index < 0 || index >= pending.values.length) {
      await this.#answerCallback(query.id, "Invalid option", true);
      return true;
    }
    await this.#answerCallback(query.id);
    await this.#finish(pending, pending.values[index]);
    return true;
  }

  async handleMessage(message: TgMessage): Promise<boolean> {
    const repliedTo = message.reply_to_message?.message_id;
    if (repliedTo == null || !message.from) return false;
    const pending = [...this.#pendingByNonce.values()].find(
      (candidate) =>
        (candidate.kind === "input" || candidate.kind === "editor") &&
        candidate.messageId === repliedTo &&
        candidate.target.chatId === String(message.chat.id) &&
        candidate.target.threadId === (message.is_topic_message ? message.message_thread_id : undefined) &&
        candidate.target.responderId === String(message.from?.id),
    );
    if (!pending) return false;
    const value = message.text ?? message.caption;
    if (!value) return true;
    await this.#finish(pending, value);
    return true;
  }

  async cancel(rpcId: string): Promise<void> {
    const pending = this.#pendingByRpcId.get(rpcId);
    if (pending) await this.#finish(pending, undefined, true);
  }

  async shutdown(): Promise<void> {
    for (const pending of [...this.#pendingByNonce.values()]) await this.#finish(pending, undefined, true);
  }

  #target(): RpcTelegramTarget {
    const target = this.#options.getTarget() ?? this.#options.fallbackTarget();
    if (!target || !this.#options.isAuthorized(target)) throw new Error("No authorized Telegram target is available for OMP UI");
    return target;
  }

  async #createPending(
    input: {
      rpcId?: string;
      kind: UiKind;
      target: RpcTelegramTarget;
      values: string[];
      title: string;
      message: string;
      resolve?: PendingUi["resolve"];
    },
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<PendingUi> {
    if (input.rpcId) await this.cancel(input.rpcId);
    const pending: PendingUi = {
      rpcId: input.rpcId,
      nonce: randomBytes(9).toString("base64url"),
      kind: input.kind,
      target: input.target,
      messageId: 0,
      values: input.values,
      selected: new Set(),
      resolve: input.resolve,
    };
    signal?.throwIfAborted();
    const sent = await this.#options.callTelegram<{ message_id: number }>(
      "sendMessage",
      {
        chat_id: input.target.chatId,
        message_thread_id: input.target.threadId,
        text: [input.title, input.message].filter(Boolean).join("\n\n").slice(0, 4096),
        reply_markup:
          input.kind === "input" || input.kind === "editor"
            ? { force_reply: true, selective: true, input_field_placeholder: input.message.slice(0, 64) }
            : this.#keyboard(pending),
      },
      { signal },
    );
    pending.messageId = sent.message_id;
    this.#pendingByNonce.set(pending.nonce, pending);
    if (pending.rpcId) this.#pendingByRpcId.set(pending.rpcId, pending);
    if (timeout && timeout > 0) {
      pending.timer = setTimeout(() => void this.#finish(pending, undefined, true, true), timeout);
      pending.timer.unref?.();
    }
    return pending;
  }

  #keyboard(pending: PendingUi): Record<string, unknown> {
    if (pending.kind === "confirm") {
      return {
        inline_keyboard: [[{ text: "Confirm", callback_data: callbackData(pending, "yes") }, { text: "Cancel", callback_data: callbackData(pending, "no") }]],
      };
    }
    const rows = pending.values.map((value, index) => [
      {
        text: pending.kind === "multi" && pending.selected.has(index) ? `✓ ${value}` : value,
        callback_data: callbackData(pending, String(index)),
      },
    ]);
    if (pending.kind === "multi") {
      rows.push([
        { text: "Done", callback_data: callbackData(pending, "done") },
        { text: "Cancel", callback_data: callbackData(pending, "cancel") },
      ]);
    }
    return { inline_keyboard: rows };
  }

  #matchesCallback(pending: PendingUi, query: TgCallbackQuery): boolean {
    return (
      query.from.id === Number(pending.target.responderId) &&
      query.message?.chat.id === Number(pending.target.chatId) &&
      query.message?.message_id === pending.messageId &&
      (query.message?.is_topic_message ? query.message.message_thread_id : undefined) === pending.target.threadId
    );
  }

  async #answerCallback(id: string, text?: string, showAlert = false): Promise<void> {
    await this.#options.callTelegram("answerCallbackQuery", { callback_query_id: id, text, show_alert: showAlert }).catch(() => {});
  }

  async #finish(pending: PendingUi, value: string | string[] | boolean | undefined, cancelled = false, timedOut = false): Promise<void> {
    if (!this.#pendingByNonce.delete(pending.nonce)) return;
    if (pending.rpcId) this.#pendingByRpcId.delete(pending.rpcId);
    clearTimeout(pending.timer);
    await this.#options.callTelegram("editMessageReplyMarkup", {
      chat_id: pending.target.chatId,
      message_id: pending.messageId,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});

    if (pending.rpcId) {
      if (cancelled) this.#options.sendResponse({ type: "extension_ui_response", id: pending.rpcId, cancelled: true, timedOut });
      else if (pending.kind === "confirm") this.#options.sendResponse({ type: "extension_ui_response", id: pending.rpcId, confirmed: value === true });
      else this.#options.sendResponse({ type: "extension_ui_response", id: pending.rpcId, value: String(value ?? "") });
    }
    pending.resolve?.(cancelled ? undefined : value);
  }
}
