import { beforeEach, describe, expect, test } from "bun:test";
import type { TgCallbackQuery, TgMessage } from "./api";
import type { TelegramCall } from "./control";
import type { RpcExtensionUiResponse } from "./rpc-protocol";
import { RpcUiBroker, type RpcTelegramTarget } from "./rpc-ui";

interface TelegramInvocation {
  method: string;
  payload: Record<string, unknown>;
}

let calls: TelegramInvocation[];
let responses: RpcExtensionUiResponse[];
let nextMessageId: number;
let messageSent: ReturnType<typeof Promise.withResolvers<void>>;
const target: RpcTelegramTarget = { chatId: "42", chatType: "private", responderId: "42" };

beforeEach(() => {
  calls = [];
  responses = [];
  nextMessageId = 100;
  messageSent = Promise.withResolvers<void>();
});

function broker(): RpcUiBroker {
  const callTelegram: TelegramCall = async <T>(method: string, payload: Record<string, unknown>): Promise<T> => {
    calls.push({ method, payload });
    if (method === "sendMessage") messageSent.resolve();
    return (method === "sendMessage" ? { message_id: ++nextMessageId } : {}) as T;
  };
  return new RpcUiBroker({
    callTelegram,
    sendResponse: (response) => responses.push(response),
    getTarget: () => target,
    fallbackTarget: () => undefined,
    isAuthorized: (candidate) => candidate.chatId === "42" && candidate.responderId === "42",
    log: { warn: () => {} },
  });
}

function callbackData(row: number, column: number): string {
  const markup = calls.findLast((call) => call.method === "sendMessage")?.payload.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  return markup.inline_keyboard[row][column].callback_data;
}

function callback(data: string, from = 42): TgCallbackQuery {
  return {
    id: `callback-${from}`,
    from: { id: from },
    data,
    message: { message_id: nextMessageId, chat: { id: 42, type: "private" } },
  };
}

describe("RpcUiBroker", () => {
  test("bridges confirmation approval and denial as confirmed booleans", async () => {
    const ui = broker();
    await ui.handle({ type: "extension_ui_request", id: "confirm-1", method: "confirm", title: "Run tool?", message: "Review command" });
    await ui.handleCallback(callback(callbackData(0, 1)));
    expect(responses).toEqual([{ type: "extension_ui_response", id: "confirm-1", confirmed: false }]);

    await ui.handle({ type: "extension_ui_request", id: "confirm-2", method: "confirm", title: "Run tool?", message: "Review command" });
    await ui.handleCallback(callback(callbackData(0, 0)));
    expect(responses.at(-1)).toEqual({ type: "extension_ui_response", id: "confirm-2", confirmed: true });
  });

  test("rejects callbacks from another Telegram user", async () => {
    const ui = broker();
    await ui.handle({ type: "extension_ui_request", id: "confirm", method: "confirm", title: "Approve", message: "Sensitive" });
    await ui.handleCallback(callback(callbackData(0, 0), 99));
    expect(responses).toEqual([]);
    expect(calls.at(-1)).toMatchObject({ method: "answerCallbackQuery", payload: { show_alert: true } });
  });

  test("correlates free-text input to the force-reply message and operator", async () => {
    const ui = broker();
    await ui.handle({ type: "extension_ui_request", id: "input", method: "input", title: "Value", placeholder: "Type it" });
    const message: TgMessage = {
      message_id: 102,
      date: 1,
      text: "the answer",
      chat: { id: 42, type: "private" },
      from: { id: 42 },
      reply_to_message: { message_id: 101, date: 1, chat: { id: 42, type: "private" } },
    };
    expect(await ui.handleMessage(message)).toBe(true);
    expect(responses).toEqual([{ type: "extension_ui_response", id: "input", value: "the answer" }]);
  });

  test("supports multi-select questions for host tools", async () => {
    const ui = broker();
    const answer = ui.ask({ title: "Select", message: "Pick", options: ["A", "B"], multi: true });
    await messageSent.promise;
    await ui.handleCallback(callback(callbackData(0, 0)));
    await ui.handleCallback(callback(callbackData(2, 0)));
    expect(await answer).toEqual(["A"]);
  });

  test("removes a host-tool question when the RPC call is cancelled", async () => {
    const ui = broker();
    const controller = new AbortController();
    const answer = ui.ask({ title: "Select", message: "Pick", options: ["A", "B"] }, controller.signal);
    await messageSent.promise;
    const staleCallback = callbackData(0, 0);
    controller.abort();
    expect(await answer).toBeUndefined();
    expect(calls.some((call) => call.method === "editMessageReplyMarkup")).toBe(true);
    await ui.handleCallback(callback(staleCallback));
    expect(calls.at(-1)).toMatchObject({
      method: "answerCallbackQuery",
      payload: { text: "This control has expired.", show_alert: true },
    });
  });

  test("aborts a host-tool question while Telegram sendMessage is in flight", async () => {
    const started = Promise.withResolvers<void>();
    let sendSignal: AbortSignal | undefined;
    const callTelegram: TelegramCall = async <T>(
      method: string,
      payload: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<T> => {
      calls.push({ method, payload });
      if (method !== "sendMessage") return {} as T;
      sendSignal = options?.signal;
      started.resolve();
      return await new Promise<T>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    };
    const ui = new RpcUiBroker({
      callTelegram,
      sendResponse: (response) => responses.push(response),
      getTarget: () => target,
      fallbackTarget: () => undefined,
      isAuthorized: (candidate) => candidate.chatId === "42" && candidate.responderId === "42",
      log: { warn: () => {} },
    });
    const controller = new AbortController();
    const answer = ui.ask({ title: "Select", message: "Pick", options: ["A", "B"] }, controller.signal);
    await started.promise;
    controller.abort();
    expect(await answer).toBeUndefined();
    expect(sendSignal?.aborted).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["sendMessage"]);
  });
});
