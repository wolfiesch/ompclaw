import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PairingRequestView } from "../../gateway-pairing";
import type { PendingInteraction } from "../../gateway-store";
import type { Principal } from "../../gateway-types";
import type { SemanticView } from "../../gateway-views";
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
  TelegramTestPoller,
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
      payload: {
        commands: [{ command: "home", description: "Open control center" }],
        scope: { type: "all_private_chats" },
      },
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

  test("stops polling when pairing approval monitor startup fails", async () => {
    const poller = new TelegramTestPoller();
    await expect(
      fixture({
        poller,
        pairingApprovalMonitorError: new Error("monitor unavailable"),
        pairing: {
          requestFromTransport: () => ({ status: "capacity" as const }),
          listUnconfirmedApprovals: () => [],
          completeConfirmation: () => false,
        },
      }),
    ).rejects.toThrow("monitor unavailable");
    expect(poller.started).toBe(true);
    expect(poller.stopped).toBe(true);
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
        listPendingInteractions: () => [],
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


describe("Telegram command catalog", () => {
  test("registers compact private and group-scoped native menus", async () => {
    const { calls } = await fixture({
      commands: [
        { command: "start", description: "Start" },
        { command: "home", description: "Home" },
        { command: "help", description: "Help" },
        { command: "status", description: "Status" },
        { command: "stop", description: "Stop" },
        { command: "new", description: "New conversation" },
      ],
    });

    expect(calls.filter((call) => call.method === "setMyCommands")).toEqual([
      {
        method: "setMyCommands",
        payload: {
          commands: [
            { command: "start", description: "Start" },
            { command: "home", description: "Home" },
            { command: "help", description: "Help" },
            { command: "status", description: "Status" },
            { command: "stop", description: "Stop" },
            { command: "new", description: "New conversation" },
          ],
          scope: { type: "all_private_chats" },
        },
      },
      {
        method: "setMyCommands",
        payload: {
          commands: [
            { command: "help", description: "Help" },
            { command: "status", description: "Status" },
            { command: "stop", description: "Stop" },
            { command: "new", description: "New conversation" },
            { command: "start", description: "Start" },
          ],
          scope: { type: "all_group_chats" },
        },
      },
    ]);
  });

  test("answers authorized inline queries with ranked command results and argument previews", async () => {
    const { adapter, api } = await fixture({
      ompCommands: [{ name: "format", description: "Format a response", source: "skill" }],
      recentCommands: ["format"],
    });

    await adapter.handleUpdate({
      update_id: 90,
      inline_query: { id: "inline-1", from: { id: 42 }, query: "f --json", offset: "" },
    });

    const answer = api.last("answerInlineQuery");
    expect(answer.payload).toMatchObject({
      inline_query_id: "inline-1",
      cache_time: 0,
      is_personal: true,
    });
    if (!Array.isArray(answer.payload.results)) throw new Error("expected inline results");
    expect(answer.payload.results[0]).toMatchObject({
      type: "article",
      id: "format",
      title: "/format",
      description: "Format a response\nArguments: --json",
      input_message_content: { message_text: "/format --json" },
    });
  });

  test("fails closed for unauthorized inline queries", async () => {
    const { adapter, api, received } = await fixture({
      ompCommands: [{ name: "private-skill", description: "Private automation", source: "skill" }],
      resolve: () => undefined,
    });

    await adapter.handleUpdate({
      update_id: 91,
      inline_query: { id: "inline-unauthorized", from: { id: 99 }, query: "private", offset: "" },
    });

    expect(api.last("answerInlineQuery").payload).toMatchObject({
      inline_query_id: "inline-unauthorized",
      results: [],
    });
    expect(received).toEqual([]);
  });

  test("renders grouped catalog listings and routes search-card selections through ingress", async () => {
    const { adapter, calls, commandUsage, received } = await fixture({
      ompCommands: [{ name: "deploy", description: "Ship the current branch", source: "skill" }],
    });

    await adapter.handleUpdate({ update_id: 92, message: message({ text: "/commands" }) });
    expect(sentMessage(calls).payload.text).toContain("Everyday");
    expect(received).toEqual([]);

    await adapter.handleUpdate({ update_id: 93, message: message({ message_id: 11, text: "/commands deploy" }) });
    const card = sentMessage(calls);
    expect(card.payload.text).toContain("Command search");
    expect(card.payload.text).toContain("/deploy");

    await adapter.handleUpdate({
      update_id: 94,
      callback_query: {
        id: "catalog-pick",
        from: { id: 42 },
        data: callbackData(card, "/deploy"),
        message: message({ message_id: 202, text: "Command search" }),
      },
    });

    expect(received).toEqual([
      expect.objectContaining({
        content: { text: "/deploy" },
        id: "telegram:primary:command-catalog:94",
      }),
    ]);
    expect(commandUsage).toEqual(["deploy"]);
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
      author: "Ada (@ada)",
      text: "x".repeat(1_000),
      isBot: false,
      isExternal: false,
    });
    expect(received[1]?.replyContext).toEqual({
      messageId: "4",
      author: "@replybot",
      text: "Quoted caption",
      isBot: true,
      isExternal: false,
    });
  });

  test("extracts quotes and synthesizes media descriptors for captionless replies", async () => {
    const { adapter, received } = await fixture();
    await adapter.handleUpdate({
      update_id: 11,
      message: message({
        message_id: 20,
        quote: { text: "quoted slice of message", position: 42, is_manual: true },
        reply_to_message: message({
          message_id: 5,
          text: "Full original text",
          from: { id: 11, first_name: "Bob", last_name: "Builder", is_bot: false },
        }),
      }),
    });
    await adapter.handleUpdate({
      update_id: 12,
      message: message({
        message_id: 21,
        reply_to_message: message({
          message_id: 6,
          text: undefined,
          photo: [{ file_id: "p1", file_unique_id: "u1", width: 100, height: 100 }],
        }),
      }),
    });
    await adapter.handleUpdate({
      update_id: 13,
      message: message({
        message_id: 22,
        reply_to_message: message({
          message_id: 7,
          text: undefined,
          caption: "Check this invoice",
          document: { file_id: "d1", file_unique_id: "u2", file_name: "invoice.pdf" },
        }),
      }),
    });
    await adapter.handleUpdate({
      update_id: 14,
      message: message({
        message_id: 23,
        reply_to_message: message({
          message_id: 8,
          text: undefined,
          voice: { file_id: "v1", file_unique_id: "u3" },
        }),
      }),
    });
    expect(received[0]?.replyContext).toEqual({
      messageId: "5",
      author: "Bob Builder",
      text: "Full original text",
      quote: "quoted slice of message",
      isBot: false,
      isExternal: false,
    });
    expect(received[1]?.replyContext).toEqual({
      messageId: "6",
      author: "Wolfgang",
      text: "[Photo]",
      mediaKind: "photo",
      isExternal: false,
    });
    expect(received[2]?.replyContext).toEqual({
      messageId: "7",
      author: "Wolfgang",
      text: "[Document: invoice.pdf] Check this invoice",
      mediaKind: "document",
      mediaName: "invoice.pdf",
      isExternal: false,
    });
    expect(received[3]?.replyContext).toEqual({
      messageId: "8",
      author: "Wolfgang",
      text: "[Voice note]",
      mediaKind: "voice",
      isExternal: false,
    });
  });
  test("extracts external reply context and origin metadata", async () => {
    const { adapter, received } = await fixture();
    await adapter.handleUpdate({
      update_id: 15,
      message: message({
        message_id: 30,
        reply_to_message: undefined,
        external_reply: {
          origin: {
            type: "user",
            date: 1_700_000,
            sender_user: { id: 99, first_name: "Carol", username: "carol_dev", is_bot: false },
          },
          chat: { id: -100, type: "supergroup", title: "External Group" },
          message_id: 55,
          document: { file_id: "doc1", file_unique_id: "u9", file_name: "patch.diff" },
          quote: { text: "diff --git a/foo b/foo" },
        },
      }),
    });
    expect(received[0]?.replyContext).toEqual({
      messageId: "55",
      author: "Carol (@carol_dev)",
      text: "[Document: patch.diff]",
      quote: "diff --git a/foo b/foo",
      chatTitle: "External Group",
      mediaKind: "document",
      mediaName: "patch.diff",
      isBot: false,
      isExternal: true,
    });
  });

  test("correlates replies to semantic view task cards and decision cards", async () => {
    const { adapter, received, semanticViews } = await fixture();
    const address = { transport: "telegram", account: "primary", channel: "42" } as const;
    semanticViews.set(["telegram", "primary", "42", "", "task-build-1"].join("\0"), {
      principalId: "operator-42",
      address,
      view: {
        schemaVersion: 1,
        id: "task-build-1",
        kind: "task",
        version: 1,
        state: "active",
        title: "Build Pipeline",
        summary: "Running integration tests",
      },
      contentHash: "a".repeat(64),
      receipts: [{ messageId: "123", index: 0 }],
      createdAt: 100,
      updatedAt: 100,
    });

    await adapter.handleUpdate({
      update_id: 16,
      message: message({
        message_id: 31,
        reply_to_message: message({
          message_id: 123,
          from: { id: 10, username: "ompclawbot", is_bot: true },
          text: "Build Pipeline\nRunning integration tests",
        }),
        text: "stop this task",
      }),
    });

    expect(received[0]?.replyContext).toEqual({
      messageId: "123",
      author: "@ompclawbot",
      text: "Build Pipeline\nRunning integration tests",
      isBot: true,
      isExternal: false,
      targetKind: "task_card",
      targetId: "task-build-1",
      targetSummary: "Build Pipeline: Running integration tests",
    });
  });

  test("pairs an unresolved private sender without dispatching the inbound task", async () => {
    const requests: PairingRequestView[] = [];
    let pairedPrincipal: Principal | undefined;
    let confirmationsCompleted = 0;
    const pairing = {
      requestFromTransport: (
        identity: PairingRequestView["identity"],
        address: PairingRequestView["address"],
        createdAt: number,
      ) => {
        const request: PairingRequestView = {
          identity,
          address,
          state: "pending",
          failedAttempts: 0,
          maxAttempts: 5,
          createdAt,
          expiresAt: createdAt + 600_000,
        };
        requests.splice(0, requests.length, request);
        return { status: "created" as const, result: { code: "ABCD2345", request } };
      },
      listUnconfirmedApprovals: () => requests.filter((request) => request.state === "approved"),
      completeConfirmation: (identity: PairingRequestView["identity"]) => {
        const index = requests.findIndex(
          (request) =>
            request.identity.transport === identity.transport &&
            request.identity.account === identity.account &&
            request.identity.subject === identity.subject,
        );
        if (index < 0) return false;
        requests.splice(index, 1);
        confirmationsCompleted += 1;
        return true;
      },
    };
    const harness = await fixture({
      pairing,
      resolve: () => pairedPrincipal,
    });

    await harness.adapter.handleUpdate({
      update_id: 7,
      message: message({ from: { id: 99 }, text: "hello" }),
    });

    expect(harness.received).toEqual([]);
    expect(sentMessage(harness.calls).payload.text).toContain("Pairing code: ABCD2345");
    expect(sentMessage(harness.calls).payload.text).toContain("ompclaw pairing-approve ABCD2345");

    pairedPrincipal = { id: "operator:telegram:primary:99", roles: ["operator"] };
    requests[0] = {
      ...requests[0]!,
      state: "approved",
      resolvedAt: 1_800_000_000_001,
      principalId: pairedPrincipal.id,
    };
    await harness.flushPairingApprovals();
    expect(sentMessage(harness.calls).payload.text).toBe("Paired. Send your first task.");

    expect(confirmationsCompleted).toBe(1);
    const confirmationCount = harness.calls.filter(
      (entry) => entry.method === "sendMessage" && entry.payload.text === "Paired. Send your first task.",
    ).length;
    await harness.flushPairingApprovals();
    expect(confirmationsCompleted).toBe(1);
    expect(
      harness.calls.filter(
        (entry) => entry.method === "sendMessage" && entry.payload.text === "Paired. Send your first task.",
      ),
    ).toHaveLength(confirmationCount);
  });

  test("keeps unresolved group senders silent when runtime pairing is enabled", async () => {
    let pairingRequests = 0;
    const { adapter, calls, received } = await fixture({
      resolve: () => undefined,
      pairing: {
        requestFromTransport: () => {
          pairingRequests += 1;
          return { status: "capacity" as const };
        },
        listUnconfirmedApprovals: () => [],
        completeConfirmation: () => false,
      },
    });
    await adapter.handleUpdate({
      update_id: 7,
      message: message({ from: { id: 99 }, text: "hello", chat: { id: -100, type: "group" } }),
    });
    expect(pairingRequests).toBe(0);
    expect(received).toEqual([]);
    expect(calls.some((entry) => entry.method === "sendMessage")).toBe(false);
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
    const { adapter, calls, received } = await fixture({ transcribe: true });
    await adapter.handleUpdate({
      update_id: 9,
      message: message({
        text: undefined,
        voice: { file_id: "voice", file_unique_id: "voice-stable", file_size: 3, mime_type: "audio/ogg" },
      }),
    });
    expect(received[0]?.content.text).toBe("[Voice transcript: voice transcript]");
    expect(received[0]?.content.attachments?.length).toBe(1);
    expect(calls.find((call) => call.method === "setMessageReaction")?.payload).toEqual({
      chat_id: 42,
      message_id: 10,
      reaction: [{ type: "emoji", emoji: "👀" }],
    });
  });

  test("acknowledges a video note with a message when reactions are unavailable", async () => {
    const { adapter, calls, received } = await fixture({
      transcribe: true,
      reactionError: new Error("reactions disabled"),
    });
    await adapter.handleUpdate({
      update_id: 12,
      message: message({
        text: undefined,
        video_note: { file_id: "video-note", file_unique_id: "video-stable", file_size: 3 },
      }),
    });

    expect(calls.find((call) => call.method === "sendMessage")?.payload).toMatchObject({
      chat_id: 42,
      text: "Received. Transcribing your voice note now.",
    });
    expect(received[0]?.content.text).toBe("[Voice transcript: voice transcript]");
    expect(received[0]?.content.attachments?.[0]?.mediaType).toBe("video/mp4");
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
    expect(calls.findLast((call) => call.method === "editMessageText")?.payload.text).toContain("✅ Approved");
  });

  test("renders a numbered clarification card and captures an other reply", async () => {
    const { adapter, calls } = await fixture();
    const answer = adapter.presentUi(
      baseAddress,
      {
        type: "select",
        presentation: "decision",
        title: "Clarify the target",
        options: [
          { value: "staging", label: "Staging", description: "Use the staging environment." },
          { value: "production", label: "Production", description: "Use the production environment." },
        ],
      },
      delivery,
    );
    await flush();
    const prompt = sentMessage(calls);
    expect(prompt.payload.text).toContain("1. Staging\nUse the staging environment.");
    expect(callbackData(prompt, "Other answer")).toContain(":other");
    await adapter.handleUpdate({
      update_id: 12,
      callback_query: {
        id: "other",
        from: { id: 42 },
        data: callbackData(prompt, "Other answer"),
        message: message({ message_id: 201 }),
      },
    });
    await adapter.handleUpdate({
      update_id: 13,
      message: message({
        message_id: 44,
        text: "Use the canary environment.",
        reply_to_message: message({ message_id: 201 }),
      }),
    });
    await expect(answer).resolves.toEqual({ type: "select", selected: ["Use the canary environment."] });
  });

  test("replays persisted provider and model pickers on their original receipts", async () => {
    const now = 1_800_000_000_000;
    const interaction = (
      id: string,
      title: string,
      options: readonly { readonly value: string; readonly label: string }[],
      page: number,
      messageId: string,
    ): PendingInteraction => ({
      id,
      address: baseAddress,
      kind: "select",
      payload: {
        schemaVersion: 1,
        principalId: owner.id,
        request: { title, options, multiple: false },
        selected: [],
        page,
        awaitingAnswer: false,
        promptMessageId: messageId,
      },
      createdAt: now,
      expiresAt: now + 10_000,
    });
    const { adapter, calls, pending } = await fixture({
      pendingInteractions: [
        interaction(
          "provider-page",
          "Choose a provider",
          [
            { value: "openai", label: "OpenAI · 2" },
            { value: "anthropic", label: "Anthropic · 1" },
          ],
          0,
          "201",
        ),
        interaction(
          "model-page",
          "OpenAI models",
          Array.from({ length: 10 }, (_, index) => ({ value: `gpt-5-${index + 1}`, label: `GPT-5 ${index + 1}` })),
          1,
          "202",
        ),
      ],
    });
    const modelMarkup = calls.find(
      (call) => call.method === "editMessageReplyMarkup" && call.payload.message_id === 202,
    );
    const providerMarkup = calls.find(
      (call) => call.method === "editMessageReplyMarkup" && call.payload.message_id === 201,
    );
    if (modelMarkup === undefined || providerMarkup === undefined) throw new Error("expected replayed picker markup");

    await adapter.handleUpdate({
      update_id: 30,
      callback_query: {
        id: "previous-page",
        from: { id: 42 },
        data: callbackData(modelMarkup, "← Prev"),
        message: message({ message_id: 202 }),
      },
    });
    const refreshedModelMarkup = calls.findLast((call) => call.method === "editMessageReplyMarkup");
    if (refreshedModelMarkup === undefined) throw new Error("expected refreshed model picker markup");
    expect(callbackData(refreshedModelMarkup, "GPT-5 1")).toContain("ompui");

    const pickProvider = callbackData(providerMarkup, "OpenAI · 2");
    await adapter.handleUpdate({
      update_id: 31,
      callback_query: {
        id: "pick-provider",
        from: { id: 42 },
        data: pickProvider,
        message: message({ message_id: 201 }),
      },
    });
    await adapter.handleUpdate({
      update_id: 32,
      callback_query: {
        id: "pick-provider-again",
        from: { id: 42 },
        data: pickProvider,
        message: message({ message_id: 201 }),
      },
    });
    expect(pending.has("provider-page")).toBe(false);
    expect(calls.findLast((call) => call.method === "answerCallbackQuery")?.payload.text).toContain("expired");
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

  test("routes a versioned semantic action from its owning principal", async () => {
    const { adapter, calls, received } = await fixture();
    const view: SemanticView = {
      schemaVersion: 1,
      id: "home",
      kind: "home",
      version: 1,
      state: "waiting",
      title: "Control center",
      summary: "Ready",
      sections: [{ id: "status", label: "Status", text: "Idle" }],
      actions: [{ id: "status", label: "Status", command: "/status" }],
      updatedAt: 1,
    };
    await adapter.presentUi(baseAddress, { type: "semantic_view", view }, delivery);
    const card = sentMessage(calls);
    expect(callbackData(card, "Status")).toBe("s1.home.1.status");

    await adapter.handleUpdate({
      update_id: 16,
      callback_query: {
        id: "semantic-status",
        from: { id: 42 },
        data: callbackData(card, "Status"),
        message: message({ message_id: 201 }),
      },
    });

    expect(received[0]).toMatchObject({ content: { text: "/status" }, address: baseAddress });
  });

  test("routes a semantic prompt action through a correlated instruction reply", async () => {
    const { adapter, calls, received } = await fixture();
    const view: SemanticView = {
      schemaVersion: 1,
      id: "task-1",
      kind: "task",
      version: 1,
      state: "active",
      title: "Working",
      sections: [],
      actions: [
        {
          id: "steer",
          label: "Add instruction",
          input: { title: "Steer task", prompt: "Reply with a correction.", command: "/steer" },
        },
      ],
      updatedAt: 1,
    };
    await adapter.presentUi(baseAddress, { type: "semantic_view", view }, delivery);
    const card = sentMessage(calls);
    await adapter.handleUpdate({
      update_id: 17,
      callback_query: {
        id: "semantic-steer",
        from: { id: 42 },
        data: callbackData(card, "Add instruction"),
        message: message({ message_id: 201 }),
      },
    });
    await flush();
    await adapter.handleUpdate({
      update_id: 18,
      message: message({
        message_id: 44,
        text: "Use the staging environment.",
        reply_to_message: message({ message_id: 202 }),
      }),
    });
    await flush();
    expect(received).toEqual([expect.objectContaining({ content: { text: "/steer Use the staging environment." } })]);
  });

  test("refreshes a stale semantic callback without dispatching its action", async () => {
    const { adapter, calls, received } = await fixture();
    const initial: SemanticView = {
      schemaVersion: 1,
      id: "home",
      kind: "home",
      version: 1,
      state: "waiting",
      title: "Control center",
      summary: "Old state",
      sections: [{ id: "status", label: "Status", text: "Idle" }],
      actions: [{ id: "status", label: "Status", command: "/status" }],
      updatedAt: 1,
    };
    await adapter.presentUi(baseAddress, { type: "semantic_view", view: initial }, delivery);
    const staleCallback = callbackData(sentMessage(calls), "Status");
    await adapter.presentUi(
      baseAddress,
      { type: "semantic_view", view: { ...initial, version: 2, summary: "Current state", updatedAt: 2 } },
      delivery,
    );
    calls.splice(0);

    await adapter.handleUpdate({
      update_id: 17,
      callback_query: {
        id: "semantic-stale",
        from: { id: 42 },
        data: staleCallback,
        message: message({ message_id: 201 }),
      },
    });

    expect(received).toEqual([]);
    expect(calls.find((entry) => entry.method === "editMessageText")?.payload.text).toContain("Current state");
    expect(calls.findLast((entry) => entry.method === "answerCallbackQuery")?.payload.text).toBe(
      "Updated to the latest controls.",
    );
  });

  test("rejects a semantic action from another authorized principal", async () => {
    const attacker: Principal = { id: "principal-attacker", roles: ["operator"] };
    const { adapter, calls, received } = await fixture({
      resolve: (subject) => (subject === "42" ? owner : attacker),
    });
    const view: SemanticView = {
      schemaVersion: 1,
      id: "home",
      kind: "home",
      version: 1,
      state: "waiting",
      title: "Control center",
      summary: "Ready",
      sections: [],
      actions: [{ id: "status", label: "Status", command: "/status" }],
      updatedAt: 1,
    };
    await adapter.presentUi(baseAddress, { type: "semantic_view", view }, delivery);
    const card = sentMessage(calls);

    await adapter.handleUpdate({
      update_id: 18,
      callback_query: {
        id: "semantic-attacker",
        from: { id: 99 },
        data: callbackData(card, "Status"),
        message: message({ message_id: 201 }),
      },
    });

    expect(received).toEqual([]);
    expect(calls.findLast((entry) => entry.method === "answerCallbackQuery")?.payload).toMatchObject({
      text: "This control belongs to another user.",
      show_alert: true,
    });
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
