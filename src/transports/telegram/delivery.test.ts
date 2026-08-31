import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TgError } from "./bot-api";
import { Outbound, telegramDraftId } from "./delivery";
import { TELEGRAM_MAX_CHARS } from "./formatting";
import type { ConversationAddress, DeliveryContext } from "../../gateway-types";

interface TelegramInvocation {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

const address: ConversationAddress = {
  transport: "telegram",
  account: "primary",
  channel: "42",
  thread: "7",
};
const context: DeliveryContext = {
  principal: { id: "owner", roles: ["operator"] },
  origin: address,
};
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function harness(call?: (method: string, payload: Record<string, unknown>) => Promise<unknown>) {
  const calls: TelegramInvocation[] = [];
  const uploads: Array<TelegramInvocation & { readonly file: { readonly field: string; readonly path: string; readonly filename?: string } }> = [];
  let messageId = 100;
  const outbound = new Outbound({
    token: "token",
    account: "primary",
    authorizeAddress: (target, delivery) => target.channel === delivery.origin.channel,
    nextDraftId: () => 71,
    callTelegram: async (method, payload = {}) => {
      calls.push({ method, payload });
      return call?.(method, payload) ?? (method === "sendMessageDraft" ? true : { message_id: ++messageId });
    },
    uploadTelegram: async (method, fields, file) => {
      uploads.push({ method, payload: fields, file });
      return { message_id: ++messageId };
    },
  });
  return { outbound, calls, uploads };
}

describe("Telegram outbound delivery", () => {
  test("streams with native drafts and sends only the final persistent message", async () => {
    const { outbound, calls } = harness();
    const preview = await outbound.send(address, { text: "working", transient: true }, context);
    expect(telegramDraftId(preview)).toBe(71);
    await expect(outbound.update(address, preview, { text: "still working", transient: true }, context)).resolves.toEqual(preview);
    const final = await outbound.finalize(address, preview, { text: "done" }, context);

    expect(calls.map((entry) => entry.method)).toEqual(["sendMessageDraft", "sendMessageDraft", "sendMessage"]);
    expect(calls[0]?.payload).toMatchObject({ chat_id: "42", message_thread_id: 7, can_stop: true, text: "working" });
    expect(calls[1]?.payload).toMatchObject({ chat_id: "42", message_thread_id: 7, can_stop: true, text: "still working" });
    expect(final).toEqual([{ transport: "telegram", messageId: "101" }]);
    expect(calls[2]?.payload).toMatchObject({ chat_id: "42", message_thread_id: 7, text: "done" });
  });

  test("falls back to a typing placeholder when native empty drafts are unavailable", async () => {
    const { outbound, calls } = harness(async (method) => {
      if (method === "sendMessageDraft") throw new TgError("Bad Request: method not supported", 400);
      if (method === "sendChatAction") return true;
      return { message_id: 9 };
    });
    const preview = await outbound.send(address, { text: "", transient: true }, context);
    expect(preview.messageId).toBe("typing:71");
    await expect(outbound.finalize(address, preview, { text: "complete" }, context)).resolves.toEqual([
      { transport: "telegram", messageId: "9" },
    ]);
    expect(calls.map((entry) => entry.method)).toEqual(["sendMessageDraft", "sendChatAction", "sendMessage"]);
  });

  test("chunks long text, replies once, and returns the first receipt", async () => {
    const { outbound, calls } = harness();
    const receipt = await outbound.send(address, {
      text: `first paragraph\n\n${"x".repeat(4_300)}`,
      replyTo: { transport: "telegram", messageId: "12" },
    }, context);
    const sends = calls.filter((entry) => entry.method === "sendMessage");
    expect(sends.length).toBeGreaterThan(1);
    expect(sends[0]?.payload.reply_to_message_id).toBe(12);
    expect(sends.slice(1).every((entry) => entry.payload.reply_to_message_id === undefined)).toBe(true);
    expect(receipt).toEqual({ transport: "telegram", messageId: "101" });
  });

  test("chunks direct UI text and keeps controls on the final message", async () => {
    const { outbound, calls } = harness();
    const replyMarkup = { inline_keyboard: [[{ text: "Approve", callback_data: "approve" }]] };
    const receipt = await outbound.sendMessage(
      address,
      "x".repeat(TELEGRAM_MAX_CHARS + 200),
      context,
      {
        replyTo: { transport: "telegram", messageId: "12" },
        replyMarkup,
      },
    );
    const sends = calls.filter((entry) => entry.method === "sendMessage");
    expect(sends.length).toBeGreaterThan(1);
    expect(sends.every((entry) => String(entry.payload.text).length <= TELEGRAM_MAX_CHARS)).toBe(true);
    expect(sends[0]?.payload.reply_to_message_id).toBe(12);
    expect(sends.slice(1).every((entry) => entry.payload.reply_to_message_id === undefined)).toBe(true);
    expect(sends.slice(0, -1).every((entry) => entry.payload.reply_markup === undefined)).toBe(true);
    expect(sends.at(-1)?.payload.reply_markup).toEqual(replyMarkup);
    expect(receipt.messageId).toBe(String(100 + sends.length));
  });

  test("replaces every chunk of a mutable direct message and removes stale chunks", async () => {
    const { outbound, calls } = harness();
    const replyMarkup = { inline_keyboard: [[{ text: "Stop", callback_data: "stop" }]] };
    const initial = await outbound.sendMessages(
      address,
      "x".repeat(TELEGRAM_MAX_CHARS + 200),
      context,
      { replyMarkup },
    );
    expect(initial).toHaveLength(2);
    calls.splice(0);

    const compact = await outbound.replaceMessages(address, initial, "updated", context, { replyMarkup });
    expect(compact).toEqual([{ transport: "telegram", messageId: "101" }]);
    expect(calls).toEqual([
      {
        method: "editMessageText",
        payload: {
          chat_id: "42",
          message_thread_id: 7,
          message_id: 101,
          text: "updated",
          reply_markup: replyMarkup,
        },
      },
      {
        method: "deleteMessage",
        payload: {
          chat_id: "42",
          message_thread_id: 7,
          message_id: 102,
        },
      },
    ]);
  });

  test("retries malformed Markdown once as plain text", async () => {
    let send = 0;
    const { outbound, calls } = harness(async (method) => {
      if (method !== "sendMessage") return true;
      send += 1;
      if (send === 1) throw new TgError("Bad Request: can't parse entities", 400);
      return { message_id: 55 };
    });
    await expect(outbound.send(address, { text: "**hello**", format: "markdown" }, context)).resolves.toEqual({
      transport: "telegram",
      messageId: "55",
    });
    expect(calls[0]?.payload.parse_mode).toBe("MarkdownV2");
    expect(calls[1]?.payload.parse_mode).toBeUndefined();
    expect(calls[1]?.payload.text).toBe("**hello**");
  });

  test("uploads image and document attachments from local file URLs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ompclaw-delivery-"));
    scratch.push(directory);
    const image = join(directory, "photo.png");
    const report = join(directory, "report.txt");
    await writeFile(image, "png");
    await writeFile(report, "report");
    const { outbound, uploads } = harness();

    const receipt = await outbound.send(address, {
      attachments: [
        { url: pathToFileURL(image).href, name: "shot.png", mediaType: "image/png" },
        { url: pathToFileURL(report).href, name: "report.txt", mediaType: "text/plain" },
      ],
    }, context);
    expect(uploads.map((entry) => [entry.method, entry.file.field, entry.file.filename])).toEqual([
      ["sendPhoto", "photo", "shot.png"],
      ["sendDocument", "document", "report.txt"],
    ]);
    expect(receipt.messageId).toBe("101");
  });

  test("edits persistent messages and tolerates unchanged final text", async () => {
    const target = { transport: "telegram", messageId: "23" } as const;
    const { outbound, calls } = harness(async (method) => {
      if (method === "editMessageText") throw new TgError("Bad Request: message is not modified", 400);
      return true;
    });
    await expect(outbound.finalize(address, target, { text: "same" }, context)).resolves.toEqual([target]);
    expect(calls[0]).toMatchObject({ method: "editMessageText", payload: { message_id: 23 } });
  });

  test("sets reactions and reply markup through authenticated Telegram calls", async () => {
    const { outbound, calls } = harness();
    const target = { transport: "telegram", messageId: "31" } as const;
    await outbound.react(address, target, { emoji: "👍" }, context);
    await outbound.setReplyMarkup(address, target, { inline_keyboard: [] }, context);
    expect(calls.map((entry) => entry.method)).toEqual(["setMessageReaction", "editMessageReplyMarkup"]);
  });

  test("rejects cross-account, cross-transport, and unauthorized targets", async () => {
    const { outbound } = harness();
    await expect(outbound.send({ ...address, account: "other" }, { text: "x" }, context)).rejects.toThrow("another account");
    await expect(outbound.send({ ...address, transport: "email" }, { text: "x" }, context)).rejects.toThrow("Telegram address");
    await expect(outbound.send({ ...address, channel: "99" }, { text: "x" }, context)).rejects.toThrow("not authorized");
  });
});
