import { describe, expect, test } from "bun:test";
import { runTelegramCanary, telegramCanaryConfig, type TelegramCanaryOptions } from "./telegram-canary";

const token = "123456789:abcdefghijklmnopqrstuvwxyz";
const env = {
  OMPCLAW_TEST_TELEGRAM_TOKEN: token,
  OMPCLAW_TEST_TELEGRAM_CHAT_ID: "42",
};

describe("Telegram live canary", () => {
  test("requires a dedicated test credential and numeric chat id", () => {
    expect(() => telegramCanaryConfig({}, [])).toThrow("OMPCLAW_TEST_TELEGRAM_TOKEN is required");
    expect(() => telegramCanaryConfig({ ...env, TELEGRAM_BOT_TOKEN: token }, [])).toThrow("use a dedicated test bot");
    expect(() => telegramCanaryConfig({ ...env, OMPCLAW_TEST_TELEGRAM_CHAT_ID: "chat" }, [])).toThrow(
      "must be a numeric Telegram chat id",
    );
    expect(() => telegramCanaryConfig(env, ["--unknown"])).toThrow("unknown Telegram canary argument");
    expect(telegramCanaryConfig(env, ["--delete"])).toEqual({ token, chatId: "42", cleanup: true });
  });

  test("checks every handset surface through the real Bot API contracts", async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const uploads: Array<{
      method: string;
      fields: Readonly<Record<string, string | number | undefined>>;
      field: string;
      filename: string;
    }> = [];
    let messageId = 98;
    const api: NonNullable<TelegramCanaryOptions["api"]> = async (_token, method, payload = {}) => {
      calls.push({ method, payload });
      if (method === "getMe") return { id: 1, is_bot: true, username: "ompclaw_test_bot" } as never;
      if (method === "getWebhookInfo") return { url: "" } as never;
      if (method === "sendMessage") return { message_id: ++messageId } as never;
      return true as never;
    };
    const upload: NonNullable<TelegramCanaryOptions["upload"]> = async (_token, method, fields, file) => {
      uploads.push({ method, fields, field: file.field, filename: file.path.split("/").at(-1) ?? "" });
      return { message_id: ++messageId } as never;
    };

    await expect(
      runTelegramCanary({
        token,
        chatId: "42",
        cleanup: true,
        api,
        upload,
        now: () => 1_800_000_000_000,
      }),
    ).resolves.toEqual({
      bot: "@ompclaw_test_bot",
      chatId: "42",
      messageIds: [99, 100, 101, 102, 103, 104, 105, 106, 107],
      marker: "ompclaw-canary-1800000000000",
      surfaces: ["home", "decisions", "quick-lane", "watches", "schedules", "media", "voice"],
      cleanedUp: true,
    });
    expect(calls.map(({ method }) => method)).toEqual([
      "getMe",
      "getWebhookInfo",
      "sendMessage",
      "sendChatAction",
      "sendMessage",
      "sendMessage",
      "sendMessage",
      "sendMessage",
      "sendMessage",
      "editMessageText",
      ...Array.from({ length: 9 }, () => "deleteMessage"),
    ]);
    expect(calls.filter(({ method }) => method === "sendMessage").map(({ payload }) => payload.text)).toEqual([
      expect.stringContaining("Starting seven surface checks"),
      expect.stringContaining("CANARY · home"),
      expect.stringContaining("CANARY · decisions"),
      expect.stringContaining("CANARY · quick-lane"),
      expect.stringContaining("CANARY · watches"),
      expect.stringContaining("CANARY · schedules"),
    ]);
    expect(calls.filter(({ method }) => method === "deleteMessage").map(({ payload }) => payload.message_id)).toEqual([
      107, 106, 105, 104, 103, 102, 101, 100, 99,
    ]);
    expect(uploads).toEqual([
      expect.objectContaining({ method: "sendPhoto", field: "photo", filename: "canary.png" }),
      expect.objectContaining({ method: "sendDocument", field: "document", filename: "canary.txt" }),
      expect.objectContaining({ method: "sendVoice", field: "voice", filename: "canary-voice.ogg" }),
    ]);
  });

  test("refuses a webhook-conflicted bot before sending a message", async () => {
    const methods: string[] = [];
    const api: NonNullable<TelegramCanaryOptions["api"]> = async (_token, method) => {
      methods.push(method);
      if (method === "getMe") return { id: 1, is_bot: true, username: "ompclaw_test_bot" } as never;
      return { url: "https://example.test/hook" } as never;
    };

    await expect(runTelegramCanary({ token, chatId: "42", cleanup: false, api })).rejects.toThrow(
      "has a webhook configured",
    );
    expect(methods).toEqual(["getMe", "getWebhookInfo"]);
  });
});
