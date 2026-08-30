import { afterEach, describe, expect, test, vi } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TgMessage, TgUpdate } from "../../api";
import type { JsonValue, PendingInteraction } from "../../gateway-store";
import type { ConversationAddress, DeliveryContext, InboundEnvelope, Principal, TransportStartContext } from "../../gateway-types";
import { TelegramTransportAdapter, type TelegramPoller } from "./adapter";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const privateAddress: ConversationAddress = { transport: "telegram", account: "default", channel: "42" };
const topicAddress: ConversationAddress = { transport: "telegram", account: "default", channel: "-1001", thread: "9" };
const owner: Principal = { id: "principal-42", roles: ["operator"] };

interface TelegramApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
  readonly responseMessageId?: number;
}

type CallWaiter = (call: TelegramApiCall, index: number) => void;

class MemoryStore {
  readonly checkpoints = new Map<string, JsonValue>();
  readonly pending = new Map<string, PendingInteraction>();
  readonly writes: Array<{ adapter: string; key: string; value: JsonValue }> = [];
  readonly #pendingWaiters = new Set<(interaction: PendingInteraction) => void>();

  getCheckpoint(adapter: string, key: string): JsonValue | undefined {
    return this.checkpoints.get(`${adapter}:${key}`);
  }

  setCheckpoint(adapter: string, key: string, value: JsonValue): void {
    this.writes.push({ adapter, key, value });
    this.checkpoints.set(`${adapter}:${key}`, value);
  }

  putPendingInteraction(interaction: PendingInteraction): void {
    this.pending.set(interaction.id, interaction);
    for (const resolve of this.#pendingWaiters) resolve(interaction);
    this.#pendingWaiters.clear();
  }

  deletePendingInteraction(id: string): boolean {
    return this.pending.delete(id);
  }

  waitForPending(): Promise<PendingInteraction> {
    const pending = this.pending.values().next().value;
    if (pending !== undefined) return Promise.resolve(pending);
    const deferred = Promise.withResolvers<PendingInteraction>();
    this.#pendingWaiters.add(deferred.resolve);
    return deferred.promise;
  }
}

function poller(): TelegramPoller & { handler?: (update: TgUpdate) => Promise<void> | void; stopped: boolean } {
  return {
    stopped: false,
    start(_token, handler) {
      this.handler = handler;
    },
    stop() {
      this.stopped = true;
    },
    done: async () => {},
  };
}

async function fixture(options: {
  readonly receive?: (message: InboundEnvelope) => Promise<void> | void;
  readonly resolveIdentity?: TransportStartContext["resolveIdentity"];
  readonly transcribe?: boolean;
  readonly uiTimeoutMs?: number;
} = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "omp-gateway-telegram-"));
  temporaryPaths.push(stateDir);
  const calls: TelegramApiCall[] = [];
  const store = new MemoryStore();
  const fakePoller = poller();
  let nextMessageId = 100;
  const received: InboundEnvelope[] = [];
  const callWaiters = new Set<CallWaiter>();
  const waitForCall = (fromIndex: number, predicate: (call: TelegramApiCall) => boolean): Promise<TelegramApiCall> => {
    const existing = calls.slice(fromIndex).find(predicate);
    if (existing) return Promise.resolve(existing);
    const deferred = Promise.withResolvers<TelegramApiCall>();
    const waiter: CallWaiter = (call, index) => {
      if (index < fromIndex || !predicate(call)) return;
      callWaiters.delete(waiter);
      deferred.resolve(call);
    };
    callWaiters.add(waiter);
    return deferred.promise;
  };
  const adapter = new TelegramTransportAdapter({
    token: "bot-token",
    stateDir,
    store,
    uiTimeoutMs: options.uiTimeoutMs,
    transcribeCommand: options.transcribe ? ["not-used", "{file}"] : undefined,
    api: {
      poller: fakePoller,
      callTelegram: async (method, payload) => {
        const call: TelegramApiCall = { method, payload: payload ?? {} };
        const callIndex = calls.push(call) - 1;
        for (const waiter of callWaiters) waiter(call, callIndex);
        if (method === "getFile") return { file_path: `private/${payload?.file_id}.ogg` };
        const responseMessageId = nextMessageId++;
        call.responseMessageId = responseMessageId;
        return { message_id: responseMessageId };
      },
      downloadFileBytes: async () => new Uint8Array([1, 2, 3]),
      transcribe: async () => "spoken words",
      acquireLock: () => ({ ok: true }),
      releaseLock: () => {},
      startLockHeartbeat: () => () => {},
      now: () => 1_700_000_000_000,
      randomId: () => "test-interaction",
    },
  });
  const context: TransportStartContext = {
    receive: async (message) => {
      received.push(message);
      await options.receive?.(message);
    },
    resolveIdentity: options.resolveIdentity ?? ((identity) => (identity.subject === "42" ? owner : undefined)),
  };
  await adapter.start(context);
  return { adapter, calls, context, fakePoller, received, stateDir, store, waitForCall };
}

function message(overrides: Partial<TgMessage> = {}): TgMessage {
  return {
    message_id: 7,
    date: 1_700_000_000,
    text: "hello",
    chat: { id: 42, type: "private" },
    from: { id: 42 },
    ...overrides,
  };
}

function replyMessage(messageId: number): TgMessage {
  return message({ message_id: messageId });
}

function delivery(origin: ConversationAddress): DeliveryContext {
  return { principal: owner, origin };
}

function inlineKeyboard(payload: Record<string, unknown>): Array<Array<Record<string, unknown>>> {
  const markup = payload.reply_markup;
  if (!markup || typeof markup !== "object" || !("inline_keyboard" in markup) || !Array.isArray(markup.inline_keyboard)) {
    throw new Error("expected an inline Telegram keyboard");
  }
  if (!markup.inline_keyboard.every((row) => Array.isArray(row))) throw new Error("expected inline keyboard rows");
  return markup.inline_keyboard as Array<Array<Record<string, unknown>>>;
}

function callbackData(payload: Record<string, unknown>): string {
  const firstButton = inlineKeyboard(payload)[0]?.[0];
  if (!firstButton || typeof firstButton.callback_data !== "string") throw new Error("expected a callback button");
  return firstButton.callback_data;
}

describe("TelegramTransportAdapter inbound conversion", () => {
  test("converts private and topic messages into principal-free envelopes", async () => {
    const { adapter, received } = await fixture();
    await adapter.handleUpdate({ update_id: 1, message: message({ reply_to_message: replyMessage(4) }) });
    await adapter.handleUpdate({
      update_id: 2,
      message: message({ message_id: 8, chat: { id: -1001, type: "supergroup" }, is_topic_message: true, message_thread_id: 9 }),
    });

    expect(received).toEqual([
      expect.objectContaining({
        id: "telegram:default:42:7",
        sentAt: 1_700_000_000_000,
        identity: { transport: "telegram", account: "default", subject: "42" },
        address: privateAddress,
        replyTo: { transport: "telegram", messageId: "4" },
      }),
      expect.objectContaining({
        address: topicAddress,
        id: "telegram:default:-1001:8",
      }),
    ]);
    await adapter.stop();
  });

  test("checkpoints only completed updates and ignores their replay", async () => {
    const receiveFinished = Promise.withResolvers<void>();
    const { adapter, received, store } = await fixture({ receive: () => receiveFinished.promise });
    const inFlight = adapter.handleUpdate({ update_id: 8, message: message() });
    await Promise.resolve();
    expect(store.writes).toEqual([]);
    receiveFinished.resolve();
    await inFlight;
    await adapter.handleUpdate({ update_id: 8, message: message() });

    expect(store.writes).toEqual([{ adapter: "telegram", key: "update_id", value: 8 }]);
    expect(received).toHaveLength(1);
    await adapter.stop();
  });

  test("does not advance a checkpoint past an earlier failed update", async () => {
    let failFirst = true;
    const { adapter, store } = await fixture({
      receive: (envelope) => {
        if (envelope.id.endsWith(":8") && failFirst) throw new Error("temporary receiver failure");
      },
    });
    await expect(adapter.handleUpdate({ update_id: 8, message: message({ message_id: 8 }) })).rejects.toThrow("temporary receiver failure");
    await adapter.handleUpdate({ update_id: 9, message: message({ message_id: 9 }) });
    expect(store.writes).toEqual([]);

    failFirst = false;
    await adapter.handleUpdate({ update_id: 8, message: message({ message_id: 8 }) });
    expect(store.writes).toEqual([{ adapter: "telegram", key: "update_id", value: 9 }]);
    await adapter.stop();
  });

  test("downloads supported media into the bounded private inbox and transcribes voice", async () => {
    const { adapter, received, stateDir } = await fixture({ transcribe: true });
    await adapter.handleUpdate({
      update_id: 1,
      message: message({ text: undefined, voice: { file_id: "voice-file", file_unique_id: "voice-unique", mime_type: "audio/ogg", file_size: 3 } }),
    });

    const envelope = received[0];
    expect(envelope.content.text).toBe("[Voice transcript: spoken words]");
    expect(envelope.content.attachments).toEqual([
      expect.objectContaining({ name: "voice-voice-unique.ogg", mediaType: "audio/ogg", url: expect.stringMatching(/^file:\/\//) }),
    ]);
    expect(envelope.content.attachments?.[0].url).toContain(`${stateDir}/inbox/`);
    await adapter.stop();
  });


  test("stores every supported Telegram media kind as a private file attachment", async () => {
    const { adapter, received } = await fixture();
    const variants: readonly Partial<TgMessage>[] = [
      { photo: [{ file_id: "photo", file_unique_id: "photo-unique", width: 100, height: 100, file_size: 3 }] },
      { document: { file_id: "document", file_unique_id: "document-unique", file_name: "notes.txt", mime_type: "text/plain", file_size: 3 } },
      { audio: { file_id: "audio", file_unique_id: "audio-unique", file_name: "song.mp3", mime_type: "audio/mpeg", file_size: 3 } },
      { video: { file_id: "video", file_unique_id: "video-unique", file_name: "clip.mp4", mime_type: "video/mp4", file_size: 3 } },
      { voice: { file_id: "voice", file_unique_id: "voice-unique", mime_type: "audio/ogg", file_size: 3 } },
      { video_note: { file_id: "video-note", file_unique_id: "video-note-unique", file_size: 3 } },
      { sticker: { file_id: "sticker", file_unique_id: "sticker-unique", file_size: 3 } },
    ];
    for (const [index, media] of variants.entries()) {
      await adapter.handleUpdate({ update_id: index + 1, message: message({ ...media, message_id: index + 1 }) });
    }

    expect(received.map((envelope) => envelope.content.attachments?.[0])).toEqual([
      expect.objectContaining({ name: "photo-photo-unique.jpg", mediaType: "image/jpeg", url: expect.stringMatching(/^file:\/\//) }),
      expect.objectContaining({ name: "notes.txt", mediaType: "text/plain", url: expect.stringMatching(/^file:\/\//) }),
      expect.objectContaining({ name: "song.mp3", mediaType: "audio/mpeg", url: expect.stringMatching(/^file:\/\//) }),
      expect.objectContaining({ name: "clip.mp4", mediaType: "video/mp4", url: expect.stringMatching(/^file:\/\//) }),
      expect.objectContaining({ name: "voice-voice-unique.ogg", mediaType: "audio/ogg", url: expect.stringMatching(/^file:\/\//) }),
      expect.objectContaining({ name: "video-note-video-note-unique.mp4", mediaType: "video/mp4", url: expect.stringMatching(/^file:\/\//) }),
      expect.objectContaining({ name: "sticker-sticker-unique.webp", mediaType: "image/webp", url: expect.stringMatching(/^file:\/\//) }),
    ]);
    await adapter.stop();
  });
  test("gives unknown users only safe identity guidance for /start and /whoami", async () => {
    const { adapter, calls, received } = await fixture({ resolveIdentity: () => undefined });
    await adapter.handleUpdate({ update_id: 1, message: message({ text: "/whoami" }) });
    await adapter.handleUpdate({ update_id: 2, message: message({ text: "ordinary message" }) });

    expect(received).toHaveLength(1);
    expect(received[0].content.text).toBe("ordinary message");
    expect(calls).toContainEqual(
      expect.objectContaining({ method: "sendMessage", payload: expect.objectContaining({ text: expect.stringContaining("user_id: 42") }) }),
    );
    await adapter.stop();
  });
});

describe("TelegramTransportAdapter UI", () => {
  test("presents every UI request class using messages, controls, replies, and bounded surface edits", async () => {
    const { adapter, calls, store, waitForCall } = await fixture();
    await expect(adapter.presentUi(privateAddress, { type: "notify", message: "notice" }, delivery(privateAddress))).resolves.toEqual({ type: "notify", acknowledged: true });

    const openUrlFrom = calls.length;
    const openUrlCall = waitForCall(openUrlFrom, (call) => call.method === "sendMessage");
    const openUrl = adapter.presentUi(privateAddress, { type: "open_url", url: "https://example.test", label: "Open" }, delivery(privateAddress));
    const openUrlMessage = await openUrlCall;
    await expect(openUrl).resolves.toEqual({ type: "open_url", opened: true });
    expect(inlineKeyboard(openUrlMessage.payload)).toEqual([[{ text: "Open", url: "https://example.test" }]]);

    await expect(adapter.presentUi(privateAddress, { type: "status", key: "state", text: "ready" }, delivery(privateAddress))).resolves.toEqual({ type: "status", acknowledged: true });
    await expect(adapter.presentUi(privateAddress, { type: "widget", key: "agents", lines: ["one", "two"] }, delivery(privateAddress))).resolves.toEqual({ type: "widget", acknowledged: true });
    await expect(adapter.presentUi(privateAddress, { type: "title", title: "Review" }, delivery(privateAddress))).resolves.toEqual({ type: "title", acknowledged: true });
    const displayFrom = calls.length;
    const displayCall = waitForCall(displayFrom, (call) => call.method === "editMessageText");
    const display = adapter.presentUi(privateAddress, { type: "editor_text", text: "draft".repeat(2_000) }, delivery(privateAddress));
    const boundedSurface = await displayCall;
    await expect(display).resolves.toEqual({ type: "editor_text", acknowledged: true });
    expect(boundedSurface.payload.reply_markup).toBeUndefined();
    expect(String(boundedSurface.payload.text).length).toBeLessThanOrEqual(4_096);

    const confirmFrom = calls.length;
    const confirmStored = store.waitForPending();
    const confirmCall = waitForCall(confirmFrom, (call) => call.method === "sendMessage");
    const confirm = adapter.presentUi(privateAddress, { type: "confirm", title: "Proceed", message: "Continue?" }, delivery(privateAddress));
    const confirmMessage = await confirmCall;
    await confirmStored;
    await adapter.handleUpdate({
      update_id: 11,
      callback_query: {
        id: "confirm-callback",
        from: { id: 42 },
        data: callbackData(confirmMessage.payload),
        message: { message_id: confirmMessage.responseMessageId!, chat: { id: 42, type: "private" } },
      },
    });
    await expect(confirm).resolves.toEqual({ type: "confirm", confirmed: true });

    const selectFrom = calls.length;
    const selectStored = store.waitForPending();
    const selectCall = waitForCall(selectFrom, (call) => call.method === "sendMessage");
    const select = adapter.presentUi(privateAddress, { type: "select", title: "Pick", options: [{ value: "a", label: "A" }] }, delivery(privateAddress));
    const selectMessage = await selectCall;
    await selectStored;
    await adapter.handleUpdate({
      update_id: 12,
      callback_query: {
        id: "select-callback",
        from: { id: 42 },
        data: callbackData(selectMessage.payload),
        message: { message_id: selectMessage.responseMessageId!, chat: { id: 42, type: "private" } },
      },
    });
    await expect(select).resolves.toEqual({ type: "select", selected: ["a"] });

    const multiFrom = calls.length;
    const multiStored = store.waitForPending();
    const multiCall = waitForCall(multiFrom, (call) => call.method === "sendMessage");
    const multi = adapter.presentUi(privateAddress, { type: "select", title: "Pick", multiSelect: true, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }, delivery(privateAddress));
    const multiMessage = await multiCall;
    await multiStored;
    const multiData = callbackData(multiMessage.payload);
    const multiMessageId = multiMessage.responseMessageId!;
    await adapter.handleUpdate({ update_id: 13, callback_query: { id: "multi-choice", from: { id: 42 }, data: multiData, message: { message_id: multiMessageId, chat: { id: 42, type: "private" } } } });
    await adapter.handleUpdate({ update_id: 14, callback_query: { id: "multi-done", from: { id: 42 }, data: multiData.replace(/:0$/, ":done"), message: { message_id: multiMessageId, chat: { id: 42, type: "private" } } } });
    await expect(multi).resolves.toEqual({ type: "select", selected: ["a"] });

    const inputFrom = calls.length;
    const inputStored = store.waitForPending();
    const inputCall = waitForCall(inputFrom, (call) => call.method === "sendMessage");
    const input = adapter.presentUi(privateAddress, { type: "input", title: "Input", prompt: "Reply" }, delivery(privateAddress));
    const inputMessage = await inputCall;
    await inputStored;
    expect(inputMessage.payload.reply_markup).toEqual(expect.objectContaining({ force_reply: true, selective: true }));
    await adapter.handleUpdate({ update_id: 15, message: message({ message_id: 300, text: "answer", reply_to_message: replyMessage(inputMessage.responseMessageId!) }) });
    await expect(input).resolves.toEqual({ type: "input", cancelled: false, value: "answer" });

    const editorFrom = calls.length;
    const editorStored = store.waitForPending();
    const editorCall = waitForCall(editorFrom, (call) => call.method === "sendMessage");
    const editor = adapter.presentUi(privateAddress, { type: "editor", title: "Edit", initialValue: "before" }, delivery(privateAddress));
    const editorMessage = await editorCall;
    await editorStored;
    expect(editorMessage.payload.reply_markup).toEqual(expect.objectContaining({ force_reply: true, selective: true }));
    await adapter.handleUpdate({ update_id: 16, message: message({ message_id: 301, text: "after", reply_to_message: replyMessage(editorMessage.responseMessageId!) }) });
    await expect(editor).resolves.toEqual({ type: "editor", cancelled: false, value: "after" });
    await adapter.stop();
  });

  test("rejects a resolved-but-wrong responder without settling the interaction", async () => {
    const { adapter, calls, store, waitForCall } = await fixture({ resolveIdentity: (identity) => (identity.subject === "42" ? owner : { id: "principal-9", roles: ["operator"] }) });
    const promptFrom = calls.length;
    const promptStored = store.waitForPending();
    const promptCall = waitForCall(promptFrom, (call) => call.method === "sendMessage");
    const response = adapter.presentUi(privateAddress, { type: "confirm", title: "Proceed", message: "Continue?" }, delivery(privateAddress));
    const prompt = await promptCall;
    await promptStored;
    await adapter.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "wrong",
        from: { id: 9 },
        data: callbackData(prompt.payload),
        message: { message_id: prompt.responseMessageId!, chat: { id: 42, type: "private" } },
      },
    });
    expect(store.pending.size).toBe(1);
    await adapter.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "right",
        from: { id: 42 },
        data: callbackData(prompt.payload),
        message: { message_id: prompt.responseMessageId!, chat: { id: 42, type: "private" } },
      },
    });
    await expect(response).resolves.toEqual({ type: "confirm", confirmed: true });
    expect(store.pending.size).toBe(0);
    expect(calls).toContainEqual(expect.objectContaining({ method: "answerCallbackQuery", payload: expect.objectContaining({ show_alert: true }) }));
    await adapter.stop();
  });

  test("cancels pending UI for aborts, timeouts, and shutdown while deleting store state", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, store } = await fixture({ uiTimeoutMs: 5 });
      const controller = new AbortController();
      const abortedStored = store.waitForPending();
      const aborted = adapter.presentUi(privateAddress, { type: "input", title: "Input" }, delivery(privateAddress), controller.signal);
      await abortedStored;
      expect(store.pending.size).toBe(1);
      controller.abort();
      await expect(aborted).resolves.toEqual({ type: "input", cancelled: true });
      expect(store.pending.size).toBe(0);

      const timeoutStored = store.waitForPending();
      const timeout = adapter.presentUi(privateAddress, { type: "editor", title: "Editor", initialValue: "x" }, delivery(privateAddress));
      await timeoutStored;
      vi.advanceTimersByTime(5);
      await expect(timeout).resolves.toEqual({ type: "editor", cancelled: true });
      expect(store.pending.size).toBe(0);

      const stoppedStored = store.waitForPending();
      const stopped = adapter.presentUi(privateAddress, { type: "confirm", title: "Confirm", message: "x" }, delivery(privateAddress));
      await stoppedStored;
      expect(store.pending.size).toBe(1);
      await adapter.stop();
      await expect(stopped).resolves.toEqual({ type: "confirm", confirmed: false });
      expect(store.pending.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
