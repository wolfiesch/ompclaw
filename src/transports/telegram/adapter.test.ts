import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PendingInteraction } from "../../gateway-store";
import type {
  ConversationAddress,
  DeliveryContext,
  InboundEnvelope,
  Principal,
  TransportStartContext,
} from "../../gateway-types";
import type { TgMessage, TgUpdate } from "./bot-api";
import { TelegramTransportAdapter, type TelegramPoller } from "./adapter";
import { telegramDraftId } from "./delivery";

interface ApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

const owner: Principal = { id: "principal-owner", roles: ["operator"] };
const baseAddress: ConversationAddress = {
  transport: "telegram",
  account: "primary",
  channel: "42",
};
const delivery: DeliveryContext = { principal: owner, origin: baseAddress };
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class TestPoller implements TelegramPoller {
  started = false;
  stopped = false;
  handle?: (update: TgUpdate) => void | Promise<void>;

  start(_token: string, handle: (update: TgUpdate) => void | Promise<void>): void {
    this.started = true;
    this.handle = handle;
  }
  stop(): void {
    this.stopped = true;
  }
  async done(): Promise<void> {}
}

async function fixture(options: {
  readonly resolve?: (subject: string) => Principal | undefined;
  readonly commands?: readonly { readonly command: string; readonly description: string }[];
  readonly transcribe?: boolean;
  readonly createTopicsFromRoot?: boolean;
  readonly failFirstReceive?: boolean;
  readonly receive?: (message: InboundEnvelope) => Promise<void>;
} = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "ompclaw-adapter-"));
  scratch.push(stateDir);
  const calls: ApiCall[] = [];
  const received: InboundEnvelope[] = [];
  const checkpoints = new Map<string, unknown>();
  const pending = new Map<string, PendingInteraction>();
  const poller = new TestPoller();
  let messageId = 200;
  const key = (adapter: string, checkpoint: string): string => `${adapter}\0${checkpoint}`;
  const adapter = new TelegramTransportAdapter({
    token: "token",
    account: "primary",
    stateDir,
    commands: options.commands,
    createTopicsFromRoot: options.createTopicsFromRoot,
    store: {
      getCheckpoint: (adapterId, checkpoint) => checkpoints.get(key(adapterId, checkpoint)),
      setCheckpoint: (adapterId, checkpoint, value) => { checkpoints.set(key(adapterId, checkpoint), value); },
      putPendingInteraction: (interaction) => { pending.set(interaction.id, interaction); },
      deletePendingInteraction: (id) => { pending.delete(id); },
      listPendingInboundMessages: () => [],
    },
    api: {
      poller,
      acquireLock: () => ({ ok: true }),
      releaseLock: () => {},
      startLockHeartbeat: () => () => {},
      now: () => 1_800_000_000_000,
      randomId: () => "interaction-id",
      callTelegram: async (method, payload = {}) => {
        calls.push({ method, payload });
        if (method === "sendMessageDraft") return true;
        if (method === "getFile") return { file_path: "uploads/file.bin" };
        if (method === "createForumTopic") return { message_thread_id: 77 };
        if (method === "sendMessage") return { message_id: ++messageId };
        return true;
      },
      downloadFileBytes: async () => new Uint8Array([4, 5, 6]),
      ...(options.transcribe ? { transcribe: async () => "voice transcript" } : {}),
    },
    ...(options.transcribe ? { transcribeCommand: ["speech-to-text"] } : {}),
    uiTimeoutMs: 10_000,
  });
  let receiveAttempt = 0;
  const context: TransportStartContext = {
    receive: async (message) => {
      receiveAttempt += 1;
      if (options.failFirstReceive && receiveAttempt === 1) throw new Error("temporary receive failure");
      await options.receive?.(message);
      received.push(message);
    },
    resolveIdentity: (identity) => options.resolve?.(identity.subject) ?? (identity.subject === "42" ? owner : undefined),
  };
  await adapter.start(context);
  return { adapter, calls, checkpoints, pending, poller, received, stateDir };
}

function message(overrides: Partial<TgMessage> = {}): TgMessage {
  return {
    message_id: 10,
    date: 1_800_000_000,
    chat: { id: 42, type: "private" },
    from: { id: 42, first_name: "Wolfgang" },
    text: "hello",
    ...overrides,
  };
}

function sentMessage(calls: readonly ApiCall[]): ApiCall {
  const call = calls.findLast((entry) => entry.method === "sendMessage");
  if (!call) throw new Error("expected sendMessage call");
  return call;
}

function callbackData(call: ApiCall, label: string): string {
  const markup = call.payload.reply_markup;
  if (markup === null || typeof markup !== "object" || !("inline_keyboard" in markup) || !Array.isArray(markup.inline_keyboard)) {
    throw new Error("expected inline keyboard");
  }
  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row)) continue;
    for (const button of row) {
      if (button !== null && typeof button === "object" && "text" in button && button.text === label
          && "callback_data" in button && typeof button.callback_data === "string") return button.callback_data;
    }
  }
  throw new Error(`missing button ${label}`);
}

async function flush(): Promise<void> {
  await Bun.sleep(0);
}

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

  test("waits for an in-flight polled update before shutdown completes", async () => {
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
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
    const stopping = adapter.stop().then(() => { stopped = true; });
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
      },
      api: { acquireLock: () => ({ ok: false, holder: 912 }) },
    });
    await expect(adapter.start({ receive: async () => {}, resolveIdentity: () => owner })).rejects.toThrow("process 912");
  });
});

describe("Telegram inbound conversion", () => {
  test("converts a private message into a principal-free gateway envelope", async () => {
    const { adapter, received, checkpoints } = await fixture();
    await adapter.handleUpdate({ update_id: 5, message: message() });
    expect(received).toEqual([{
      id: "telegram:primary:42:10",
      sentAt: 1_800_000_000_000,
      identity: { transport: "telegram", account: "primary", subject: "42" },
      address: baseAddress,
      content: { text: "hello" },
      sourceReceipt: { transport: "telegram", messageId: "10" },
      edited: false,
    }]);
    expect(checkpoints.get("telegram\0update_id:primary")).toBe(5);
  });

  test("preserves topic, reply, and edited-message metadata", async () => {
    const { adapter, received } = await fixture();
    await adapter.handleUpdate({
      update_id: 6,
      edited_message: message({
        message_id: 11,
        chat: { id: -100, type: "supergroup" },
        is_topic_message: true,
        message_thread_id: 19,
        reply_to_message: message({ message_id: 3 }),
      }),
    });
    expect(received[0]).toMatchObject({
      address: { channel: "-100", thread: "19" },
      replyTo: { transport: "telegram", messageId: "3" },
      edited: true,
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
    expect(calls.filter((entry) => entry.method === "createForumTopic")).toEqual([{
      method: "createForumTopic",
      payload: { chat_id: -100, name: "Plan a release" },
    }]);
    expect(received.map((entry) => entry.address.thread)).toEqual(["77"]);
  });
});

describe("Telegram interactive UI", () => {
  test("settles a confirm request from its owning principal and clears persistence", async () => {
    const { adapter, calls, pending } = await fixture();
    const answer = adapter.presentUi(baseAddress, {
      type: "confirm",
      title: "Deploy",
      message: "Ship this build?",
      confirmLabel: "Ship",
      cancelLabel: "Wait",
    }, delivery);
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
    const answer = adapter.presentUi(baseAddress, {
      type: "input",
      title: "Release name",
      prompt: "Enter a name",
    }, delivery);
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
        message: message({ message_id: 201 }),
      },
    });
    expect(received[0]).toMatchObject({ content: { text: "/stop" }, address: baseAddress });
  });

  test("rejects a stop button click from a different authorized principal", async () => {
    const attacker: Principal = { id: "principal-attacker", roles: ["operator"] };
    const { adapter, calls, received } = await fixture({
      resolve: (subject) => subject === "42" ? owner : attacker,
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
  });
});
