import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../../gateway-types";
import { TgError } from "./bot-api";
import { TelegramTransportAdapter } from "./adapter";
import { telegramDraftId } from "./delivery";
import { TELEGRAM_MAX_CHARS } from "./formatting";
import {
  TELEGRAM_TEST_ADDRESS as baseAddress,
  TELEGRAM_TEST_DELIVERY as delivery,
  TELEGRAM_TEST_OWNER as owner,
  createTelegramAdapterHarness as fixture,
  disposeTelegramAdapterHarnesses,
  flushTelegramTasks as flush,
  lastTelegramCall as sentMessage,
  telegramCallbackData as callbackData,
  telegramTestMessage as message,
} from "./test-harness";

const scratch: string[] = [];

afterEach(async () => {
  await disposeTelegramAdapterHarnesses();
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Telegram transport lifecycle", () => {
  test("advertises the full gateway surface, registers commands, and stops polling", async () => {
    const { adapter, calls, poller } = await fixture({
      commands: [{ command: "home", description: "Open control center" }],
    });
    expect(adapter.capabilities).toMatchObject({
      streamingUpdates: true,
      buttons: true,
      multiSelect: true,
      textInput: true,
      attachments: true,
      reactions: true,
      threads: true,
    });
    expect(adapter.capabilities.maxMessageLength).toBe(Number.MAX_SAFE_INTEGER);
    expect(calls[0]).toEqual({
      method: "setMyCommands",
      payload: { commands: [{ command: "home", description: "Open control center" }] },
    });
    expect(poller.started).toBe(true);
    await adapter.stop();
    expect(poller.stopped).toBe(true);
  });

  test("continues polling when command-menu registration fails", async () => {
    const { adapter, poller, warnings } = await fixture({
      commands: [{ command: "home", description: "Open control center" }],
      setCommandsError: new Error("menu unavailable"),
    });
    expect(poller.started).toBe(true);
    expect(warnings).toEqual([expect.stringContaining("command menu registration failed: menu unavailable")]);
    await adapter.stop();
  });

  test("removes its temporary state directory when startup fails", async () => {
    const prefix = "ompclaw adapter ";
    const entriesBefore = new Set(await readdir(tmpdir()));
    await expect(
      fixture({
        pendingAttachmentName: "startup-failure.bin",
        commands: [{ command: "home", description: "Open control center" }],
        setCommandsError: new TgError("Unauthorized", 401),
      }),
    ).rejects.toThrow("Unauthorized");
    const leakedPaths = (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith(prefix) && !entriesBefore.has(entry))
      .map((entry) => join(tmpdir(), entry));
    scratch.push(...leakedPaths);
    expect(leakedPaths).toEqual([]);
  });

  test("removes temporary state and unregisters when polling stop fails", async () => {
    const harness = await fixture();
    const stopError = new Error("poller stop failed");
    harness.poller.stop = () => {
      throw stopError;
    };

    const result = await harness.dispose().then(
      () => new Error("harness disposal unexpectedly resolved"),
      (error) => error,
    );
    expect(result).toBe(stopError);
    await expect(access(harness.stateDir)).rejects.toThrow();
    await expect(disposeTelegramAdapterHarnesses()).resolves.toBeUndefined();
  });

  test("preserves an undefined polling stop rejection", async () => {
    const harness = await fixture();
    harness.poller.stop = () => {
      throw undefined;
    };

    const result = await harness.dispose().then(
      () => ({ rejected: false, error: new Error("harness disposal unexpectedly resolved") }),
      (error) => ({ rejected: true, error }),
    );
    expect(result.rejected).toBe(true);
    expect(result.error).toBeUndefined();
    await expect(access(harness.stateDir)).rejects.toThrow();
    await expect(disposeTelegramAdapterHarnesses()).resolves.toBeUndefined();
  });

  test("waits for an in-flight polled update before shutdown completes", async () => {
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { adapter, poller } = await fixture({
      receive: async () => {
        entered = true;
        await gate;
      },
    });
    const update = poller.handle?.({ update_id: 99, message: message() });
    if (!update) throw new Error("poller did not capture its update handler");
    while (!entered) await flush();
    let stopped = false;
    const stopping = adapter.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    release();
    await Promise.all([update, stopping]);
    expect(stopped).toBe(true);
  });

  test("rejects a second starter when another process owns the account poll lock", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "ompclaw-adapter-lock-"));
    scratch.push(stateDir);
    const adapter = new TelegramTransportAdapter({
      token: "token",
      stateDir,
      store: {
        getCheckpoint: () => undefined,
        setCheckpoint: () => {},
        putPendingInteraction: () => {},
        deletePendingInteraction: () => {},
        listPendingInboundMessages: () => [],
        listPendingIngressCompositions: () => [],
      },
      api: { acquireLock: () => ({ ok: false, holder: 912 }) },
    });
    await expect(adapter.start({ receive: async () => {}, resolveIdentity: () => owner })).rejects.toThrow(
      "process 912",
    );
  });
});

describe("Telegram typing", () => {
  test("sends a one-shot typing action to the conversation topic", async () => {
    const { adapter, calls } = await fixture();
    const address = { ...baseAddress, channel: "-100", thread: "19" };
    const context = { ...delivery, origin: address };

    await adapter.typing(address, context);

    expect(calls).toEqual([
      {
        method: "sendChatAction",
        payload: { chat_id: "-100", message_thread_id: 19, action: "typing" },
      },
    ]);
  });
});

describe("Telegram inbound conversion", () => {
  test("converts a private message into a principal-free gateway envelope", async () => {
    const { adapter, received, checkpoints } = await fixture();
    await adapter.handleUpdate({ update_id: 5, message: message() });
    expect(received).toEqual([
      {
        id: "telegram:primary:42:10",
        sentAt: 1_800_000_000_000,
        identity: { transport: "telegram", account: "primary", subject: "42" },
        address: baseAddress,
        content: { text: "hello" },
        composition: { kind: "text", order: 10 },
        sourceReceipt: { transport: "telegram", messageId: "10" },
        edited: false,
      },
    ]);
    expect(checkpoints.get("telegram\0update_id:primary")).toBe(5);
  });

  test("preserves topic, reply, composition, and edited-message metadata", async () => {
    const { adapter, received } = await fixture();
    await adapter.handleUpdate({
      update_id: 6,
      edited_message: message({
        message_id: 11,
        chat: { id: -100, type: "supergroup" },
        is_topic_message: true,
        message_thread_id: 19,
        media_group_id: "album-1",
        edit_date: 1_800_000_100,
        reply_to_message: message({ message_id: 3 }),
      }),
    });
    expect(received[0]).toMatchObject({
      address: { channel: "-100", thread: "19" },
      replyTo: { transport: "telegram", messageId: "3" },
      composition: { kind: "media", groupId: "album-1", order: 11 },
      edited: true,
    });
  });
  test("sets ordered media composition hints for every album fragment", async () => {
    const { adapter, received } = await fixture();
    await adapter.handleUpdate({
      update_id: 7,
      message: message({
        message_id: 12,
        text: undefined,
        media_group_id: "album-1",
        photo: [{ file_id: "photo-2", file_unique_id: "photo-stable-2", width: 1, height: 1 }],
      }),
    });
    await adapter.handleUpdate({
      update_id: 8,
      message: message({
        message_id: 13,
        text: undefined,
        media_group_id: "album-1",
        photo: [{ file_id: "photo-3", file_unique_id: "photo-stable-3", width: 1, height: 1 }],
      }),
    });
    expect(received.map((entry) => entry.composition)).toEqual([
      { kind: "media", groupId: "album-1", order: 12 },
      { kind: "media", groupId: "album-1", order: 13 },
    ]);
  });

  test("maps quoted reply author, bot status, and truncated text content", async () => {
    const { adapter, received } = await fixture();
    await adapter.handleUpdate({
      update_id: 9,
      message: message({
        message_id: 14,
        reply_to_message: message({
          message_id: 3,
          text: "x".repeat(1_001),
          from: { id: 9, first_name: "Ada", username: "ada", is_bot: false },
        }),
      }),
    });
    await adapter.handleUpdate({
      update_id: 10,
      message: message({
        message_id: 15,
        reply_to_message: message({
          message_id: 4,
          text: undefined,
          caption: "Quoted caption",
          from: { id: 10, username: "replybot", is_bot: true },
        }),
      }),
    });
    expect(received[0]?.replyContext).toEqual({
      messageId: "3",
      author: "Ada",
      text: "x".repeat(1_000),
      isBot: false,
    });
    expect(received[1]?.replyContext).toEqual({
      messageId: "4",
      author: "@replybot",
      text: "Quoted caption",
      isBot: true,
    });
  });

  test("answers identity help locally for an unresolved user", async () => {
    const { adapter, calls, received } = await fixture({ resolve: () => undefined });
    await adapter.handleUpdate({ update_id: 7, message: message({ from: { id: 99 }, text: "/whoami" }) });
    expect(received).toEqual([]);
    expect(sentMessage(calls).payload.text).toContain("99");
  });
  test("drops unresolved attachments before any Telegram download or gateway dispatch", async () => {
    const { adapter, calls, received } = await fixture({ resolve: () => undefined });
    await adapter.handleUpdate({
      update_id: 8,
      message: message({
        from: { id: 99 },
        text: undefined,
        document: { file_id: "remote", file_unique_id: "stable", file_name: "payload.bin", file_size: 3 },
      }),
    });
    expect(received).toEqual([]);
    expect(calls.some((entry) => entry.method === "getFile")).toBe(false);
  });

  test("downloads attachments into the private inbox before dispatch", async () => {
    const { adapter, received } = await fixture();
    await adapter.handleUpdate({
      update_id: 8,
      message: message({
        text: undefined,
        document: { file_id: "remote", file_unique_id: "stable", file_name: "../unsafe?.bin", file_size: 3 },
      }),
    });
    const attachment = received[0]?.content.attachments?.[0];
    expect(attachment?.name).toBe("unsafe_.bin");
    expect(attachment?.url.startsWith("file://")).toBe(true);
    if (!attachment) throw new Error("expected attachment");
    expect(await readFile(new URL(attachment.url))).toEqual(Buffer.from([4, 5, 6]));
  });

  test("retains queued attachments when file URLs contain encoded paths", async () => {
    const queuedName = "queued file.bin";
    const { adapter, stateDir } = await fixture({ pendingAttachmentName: queuedName });
    const queuedPath = join(stateDir, "inbox", "telegram", "primary", queuedName);
    await writeFile(queuedPath, "queued");
    await utimes(queuedPath, 0, 0);
    await adapter.handleUpdate({
      update_id: 9,
      message: message({
        text: undefined,
        document: { file_id: "remote", file_unique_id: "new", file_name: "new.bin", file_size: 3 },
      }),
    });
    expect(await readFile(queuedPath, "utf8")).toBe("queued");
  });

  test("retains staged ingress fragment attachments during inbox cleanup", async () => {
    const queuedName = "pending album.bin";
    const { adapter, stateDir } = await fixture({ pendingIngressAttachmentName: queuedName });
    const queuedPath = join(stateDir, "inbox", "telegram", "primary", queuedName);
    await writeFile(queuedPath, "queued");
    await utimes(queuedPath, 0, 0);
    await adapter.handleUpdate({
      update_id: 11,
      message: message({
        text: undefined,
        document: { file_id: "remote", file_unique_id: "newer", file_name: "new.bin", file_size: 3 },
      }),
    });
    expect(await readFile(queuedPath, "utf8")).toBe("queued");
  });

  test("adds voice transcription beside the saved attachment", async () => {
    const { adapter, received } = await fixture({ transcribe: true });
    await adapter.handleUpdate({
      update_id: 9,
      message: message({
        text: undefined,
        voice: { file_id: "voice", file_unique_id: "voice-stable", file_size: 3, mime_type: "audio/ogg" },
      }),
    });
    expect(received[0]?.content.text).toBe("[Voice transcript: voice transcript]");
    expect(received[0]?.content.attachments?.length).toBe(1);
  });

  test("reuses one forum topic when an authorized root message is retried", async () => {
    const { adapter, calls, received } = await fixture({ createTopicsFromRoot: true, failFirstReceive: true });
    const update = {
      update_id: 10,
      message: message({ chat: { id: -100, type: "supergroup", is_forum: true }, text: "Plan a release" }),
    } as const;
    await expect(adapter.handleUpdate(update)).rejects.toThrow("temporary receive failure");
    await adapter.handleUpdate(update);
    expect(calls.filter((entry) => entry.method === "createForumTopic")).toEqual([
      {
        method: "createForumTopic",
        payload: { chat_id: -100, name: "Plan a release" },
      },
    ]);
    expect(received.map((entry) => entry.address.thread)).toEqual(["77"]);
  });
});

describe("Telegram interactive UI", () => {
  test("settles a confirm request from its owning principal and clears persistence", async () => {
    const { adapter, calls, pending } = await fixture();
    const answer = adapter.presentUi(
      baseAddress,
      {
        type: "confirm",
        title: "Deploy",
        message: "Ship this build?",
        confirmLabel: "Ship",
        cancelLabel: "Wait",
      },
      delivery,
    );
    await flush();
    const prompt = sentMessage(calls);
    expect(pending.has("interaction-id")).toBe(true);
    await adapter.handleUpdate({
      update_id: 11,
      callback_query: {
        id: "callback-1",
        from: { id: 42 },
        data: callbackData(prompt, "Ship"),
        message: message({ message_id: Number(prompt.payload.chat_id) + 159 }),
      },
    });
    await expect(answer).resolves.toEqual({ type: "confirm", confirmed: true });
    expect(pending.size).toBe(0);
  });

  test("accepts text input only as a reply to the correlated prompt", async () => {
    const { adapter, calls } = await fixture();
    const answer = adapter.presentUi(
      baseAddress,
      {
        type: "input",
        title: "Release name",
        prompt: "Enter a name",
      },
      delivery,
    );
    await flush();
    const prompt = sentMessage(calls);
    const promptId = 201;
    expect(prompt.payload.reply_markup).toMatchObject({ force_reply: true });
    await adapter.handleUpdate({
      update_id: 12,
      message: message({
        message_id: 44,
        text: "Summer release",
        reply_to_message: message({ message_id: promptId }),
      }),
    });
    await expect(answer).resolves.toEqual({ type: "input", cancelled: false, value: "Summer release" });
  });

  test("maps a native running-task stop button back to /stop", async () => {
    const { adapter, calls, received } = await fixture();
    await adapter.presentUi(baseAddress, { type: "status", key: "Task", text: "Working\nDeploying" }, delivery);
    const card = sentMessage(calls);
    await adapter.handleUpdate({
      update_id: 13,
      callback_query: {
        id: "stop-1",
        from: { id: 42 },
        data: callbackData(card, "Stop"),
        message: message({ message_id: 201, media_group_id: "control-album" }),
      },
    });
    expect(received[0]).toMatchObject({ content: { text: "/stop" }, address: baseAddress });
    expect(received[0]?.composition).toBeUndefined();
  });

  test("passes status notification policy to control-card sends and new chunks", async () => {
    const { adapter, calls } = await fixture();
    await adapter.presentUi(
      baseAddress,
      {
        type: "status",
        key: "Task",
        text: "Working",
        notification: "silent",
      },
      delivery,
    );
    expect(sentMessage(calls).payload.disable_notification).toBe(true);

    calls.splice(0);
    await adapter.presentUi(
      baseAddress,
      {
        type: "status",
        key: "Task",
        text: "x".repeat(TELEGRAM_MAX_CHARS),
        notification: "silent",
      },
      delivery,
    );
    const newChunk = calls.find((entry) => entry.method === "sendMessage");
    expect(newChunk?.payload.disable_notification).toBe(true);

    const { adapter: defaultAdapter, calls: defaultCalls } = await fixture();
    await defaultAdapter.presentUi(
      baseAddress,
      {
        type: "status",
        key: "Task",
        text: "Idle",
        notification: "default",
      },
      delivery,
    );
    expect(sentMessage(defaultCalls).payload).not.toHaveProperty("disable_notification");
  });

  test("moves a multipart control card and its stop button as one mutable unit", async () => {
    const { adapter, calls, received } = await fixture();
    await adapter.presentUi(baseAddress, { type: "status", key: "Task", text: "Working" }, delivery);
    await adapter.presentUi(
      baseAddress,
      {
        type: "widget",
        key: "Details",
        lines: ["x".repeat(TELEGRAM_MAX_CHARS)],
      },
      delivery,
    );
    const sends = calls.filter((entry) => entry.method === "sendMessage");
    const final = sends.at(-1);
    if (!final) throw new Error("expected multipart control card");
    expect(sends.length).toBe(2);
    expect(calls.find((entry) => entry.method === "editMessageText")?.payload).toMatchObject({
      message_id: 201,
      reply_markup: { inline_keyboard: [] },
    });
    expect(callbackData(final, "Stop")).toBe("ompctl:stop");
    await adapter.handleUpdate({
      update_id: 15,
      callback_query: {
        id: "stop-multipart",
        from: { id: 42 },
        data: callbackData(final, "Stop"),
        message: message({ message_id: 202 }),
      },
    });
    expect(received[0]).toMatchObject({ content: { text: "/stop" }, address: baseAddress });
  });

  test("rejects a stop button click from a different authorized principal", async () => {
    const attacker: Principal = { id: "principal-attacker", roles: ["operator"] };
    const { adapter, calls, received } = await fixture({
      resolve: (subject) => (subject === "42" ? owner : attacker),
    });
    await adapter.presentUi(baseAddress, { type: "status", key: "Task", text: "Working\nDeploying" }, delivery);
    const card = sentMessage(calls);
    await adapter.handleUpdate({
      update_id: 14,
      callback_query: {
        id: "stop-attacker",
        from: { id: 99 },
        data: callbackData(card, "Stop"),
        message: message({ message_id: 201 }),
      },
    });
    expect(received).toEqual([]);
    expect(calls.findLast((entry) => entry.method === "answerCallbackQuery")?.payload).toMatchObject({
      show_alert: true,
    });
  });

  test("maps Telegram's native draft-stop update back to /stop", async () => {
    const { adapter, received } = await fixture();
    const receipt = await adapter.send(baseAddress, { text: "Working", transient: true }, delivery);
    const draftId = telegramDraftId(receipt);
    if (draftId === undefined) throw new Error("expected a Telegram draft receipt");
    await adapter.handleUpdate({
      update_id: 14,
      stopped_message_generation: {
        draft_id: draftId,
        chat: { id: 42, type: "private" },
      },
    });
    expect(received[0]).toMatchObject({
      content: { text: "/stop" },
      identity: { subject: "42" },
      address: baseAddress,
    });
    expect(received[0]?.composition).toBeUndefined();
  });
});
