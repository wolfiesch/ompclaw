import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TgError } from "./api";
import type { ConversationAddress, DeliveryContext } from "./gateway-types";
import { Outbound, type TelegramCall, type TelegramUpload } from "./outbound";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const address: ConversationAddress = { transport: "telegram", account: "default", channel: "42" };
const topicAddress: ConversationAddress = { ...address, channel: "-100123", thread: "77" };
const delivery = (origin: ConversationAddress = address): DeliveryContext => ({
  principal: { id: "operator-42", roles: ["operator"] },
  origin,
});

function outbound(
  call: TelegramCall,
  upload?: TelegramUpload,
  authorizeAddress = (target: ConversationAddress, context: DeliveryContext) => target.channel === context.origin.channel,
): Outbound {
  return new Outbound({ token: "test-token", authorizeAddress, callTelegram: call, uploadTelegram: upload });
}

test("uses MarkdownV2 but retries unformatted text if Telegram rejects parsing", async () => {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  let first = true;
  const send = outbound(async (method, payload) => {
    calls.push({ method, payload: payload ?? {} });
    if (first) {
      first = false;
      throw new TgError("can't parse entities", 400);
    }
    return { message_id: 10 };
  });

  await expect(send.send(address, { text: "**bold**", format: "markdown" }, delivery())).resolves.toEqual({
    transport: "telegram",
    messageId: "10",
  });
  expect(calls).toEqual([
    expect.objectContaining({ method: "sendMessage", payload: expect.objectContaining({ parse_mode: "MarkdownV2" }) }),
    expect.objectContaining({ method: "sendMessage", payload: expect.objectContaining({ text: "**bold**" }) }),
  ]);
  expect(calls[1].payload.parse_mode).toBeUndefined();
});

test("chunks long Markdown delivery within Telegram's maximum message length", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const send = outbound(async (_method, payload) => {
    calls.push(payload ?? {});
    return { message_id: calls.length };
  });

  const receipt = await send.send(address, { text: "word ".repeat(1_200), format: "markdown" }, delivery());

  expect(receipt.messageId).toBe("1");
  expect(calls).toHaveLength(2);
  expect(calls.every((payload) => String(payload.text).length <= 4096)).toBe(true);
  expect(calls.every((payload) => payload.parse_mode === "MarkdownV2")).toBe(true);
});

test("validates local files and uploads photos and documents to the authorized topic", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-gateway-outbound-"));
  temporaryPaths.push(root);
  const photo = join(root, "image.png");
  const document = join(root, "report.pdf");
  await Promise.all([writeFile(photo, "png"), writeFile(document, "pdf")]);
  const uploads: Array<{ method: string; fields: Record<string, string | number | undefined>; file: { path: string } }> = [];
  const send = outbound(
    async () => ({ message_id: 99 }),
    async (method, fields, file) => {
      uploads.push({ method, fields, file });
      return { message_id: uploads.length };
    },
  );

  await send.send(
    topicAddress,
    {
      attachments: [
        { url: pathToFileURL(photo).href, name: "screenshot.png", mediaType: "image/png" },
        { url: pathToFileURL(document).href, name: "report.pdf", mediaType: "application/pdf" },
      ],
    },
    delivery(topicAddress),
  );

  expect(uploads).toEqual([
    expect.objectContaining({ method: "sendPhoto", fields: expect.objectContaining({ chat_id: "-100123", message_thread_id: 77 }) }),
    expect.objectContaining({ method: "sendDocument", fields: expect.objectContaining({ chat_id: "-100123", message_thread_id: 77 }) }),
  ]);
  await expect(
    send.send(address, { attachments: [{ url: "https://example.test/not-local" }] }, delivery()),
  ).rejects.toThrow("file://");
});

test("returns string receipts for updates and consumes them for reactions", async () => {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const send = outbound(async (method, payload) => {
    calls.push({ method, payload: payload ?? {} });
    return true;
  });
  const receipt = { transport: "telegram" as const, messageId: "15" };

  await expect(send.update(address, receipt, { text: "changed" }, delivery())).resolves.toEqual(receipt);
  await expect(send.react(address, receipt, { emoji: "👍" }, delivery())).resolves.toBeUndefined();

  expect(calls).toEqual([
    expect.objectContaining({ method: "editMessageText", payload: expect.objectContaining({ chat_id: "42", message_id: 15, text: "changed" }) }),
    expect.objectContaining({ method: "setMessageReaction", payload: expect.objectContaining({ chat_id: "42", message_id: 15, reaction: [{ type: "emoji", emoji: "👍" }] }) }),
  ]);
});

test("does not let an outbound caller override the authorized delivery address", async () => {
  const send = outbound(async () => ({ message_id: 1 }));
  await expect(send.send({ ...address, channel: "different" }, { text: "nope" }, delivery())).rejects.toThrow("authorized");
});
