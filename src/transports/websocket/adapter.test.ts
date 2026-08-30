import { afterEach, describe, expect, test } from "bun:test";
import type {
  ConversationAddress,
  DeliveryContext,
  InboundEnvelope,
  Principal,
  TransportIdentity,
  UiRequest,
  UiResponse,
} from "../../gateway-types";
import {
  DuplicateWebSocketOriginError,
  WebSocketTransportAdapter,
  WebSocketTransportDisconnectedError,
  WebSocketUiTimeoutError,
  type WebSocketTransportCredential,
} from "./adapter";

const ACCOUNT = "gateway-account";
const CREDENTIALS: readonly WebSocketTransportCredential[] = [
  { token: "first-token", subject: "first-subject", channel: "first-channel" },
  { token: "second-token", subject: "second-subject", channel: "second-channel", thread: "thread-2" },
];

const transports: WebSocketTransportAdapter[] = [];
const CLEANUP_TIMEOUT_MS = 2_000;

interface HarnessOptions {
  readonly credentials?: readonly WebSocketTransportCredential[];
  readonly authTimeoutMs?: number;
  readonly uiTimeoutMs?: number;
  readonly maxMessageLength?: number;
  readonly resolveIdentity?: (identity: TransportIdentity, signal?: AbortSignal) => Promise<Principal | undefined> | Principal | undefined;
}

interface Harness {
  readonly transport: WebSocketTransportAdapter;
  readonly inbound: readonly InboundEnvelope[];
  nextInbound(): Promise<InboundEnvelope>;
  context(channel: string, subject?: string, thread?: string): DeliveryContext;
}

function harness(options: HarnessOptions = {}): Harness {
  const inbound: InboundEnvelope[] = [];
  const waiting: Array<(message: InboundEnvelope) => void> = [];
  const transport = new WebSocketTransportAdapter({
    hostname: "127.0.0.1",
    port: 0,
    account: ACCOUNT,
    credentials: options.credentials ?? CREDENTIALS,
    authTimeoutMs: options.authTimeoutMs ?? 500,
    uiTimeoutMs: options.uiTimeoutMs ?? 500,
    maxMessageLength: options.maxMessageLength ?? 4_096,
  });
  transports.push(transport);
  transport.start({
    resolveIdentity: options.resolveIdentity ?? ((identity) => ({ id: `principal:${identity.subject}`, roles: ["member"] })),
    receive: async (message) => {
      const waiter = waiting.shift();
      if (waiter === undefined) inbound.push(message);
      else waiter(message);
    },
  });

  return {
    transport,
    inbound,
    nextInbound: () => {
      const message = inbound.shift();
      if (message !== undefined) return Promise.resolve(message);
      return new Promise<InboundEnvelope>((resolve) => waiting.push(resolve));
    },
    context: (channel, subject = "first-subject", thread) => ({
      principal: { id: `principal:${subject}`, roles: ["member"] },
      origin: {
        transport: "websocket",
        account: ACCOUNT,
        channel,
        ...(thread === undefined ? {} : { thread }),
      },
    }),
  };
}

class Client {
  readonly #socket: WebSocket;
  readonly #frames: unknown[] = [];
  readonly #waiters: Array<(frame: unknown) => void> = [];
  readonly #opened: Promise<void>;
  readonly #closed: Promise<void>;

  private constructor(url: string) {
    this.#socket = new WebSocket(url);
    const opened = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    this.#opened = opened.promise;
    this.#closed = closed.promise;
    this.#socket.onopen = () => opened.resolve();
    this.#socket.onclose = () => closed.resolve();
    this.#socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data));
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#frames.push(frame);
      else waiter(frame);
    };
  }

  static async connect(url: string): Promise<Client> {
    const client = new Client(url);
    await client.#opened;
    clients.push(client);
    return client;
  }

  send(frame: unknown): void {
    this.#socket.send(JSON.stringify(frame));
  }

    // This is a real socket-event watchdog; fake clocks cannot drive Bun's WebSocket client.
  async nextFrame(timeoutMs = 500): Promise<Record<string, unknown>> {
    const existing = this.#frames.shift();
    if (existing !== undefined) return existing as Record<string, unknown>;
    const deferred = Promise.withResolvers<unknown>();
    this.#waiters.push(deferred.resolve);
    const timeout = setTimeout(() => deferred.reject(new Error("timed out waiting for server frame")), timeoutMs);
    try {
      return (await deferred.promise) as Record<string, unknown>;
    } finally {
      clearTimeout(timeout);
      const index = this.#waiters.indexOf(deferred.resolve);
      if (index !== -1) this.#waiters.splice(index, 1);
    }
  }

  async expectNoFrame(timeoutMs = 25): Promise<void> {
    await expect(this.nextFrame(timeoutMs)).rejects.toThrow("timed out waiting for server frame");
  }

  // This is a real socket-close watchdog; fake clocks cannot drive Bun's WebSocket client.
  async closed(timeoutMs = CLEANUP_TIMEOUT_MS): Promise<void> {
    const timeout = Promise.withResolvers<void>();
    const timer = setTimeout(() => timeout.reject(new Error("timed out waiting for client disconnect")), timeoutMs);
    try {
      await Promise.race([this.#closed, timeout.promise]);
    } finally {
      clearTimeout(timer);
    }

  }
  close(): void {
    this.#socket.close();
  }

  terminate(): void {
    if (this.#socket.readyState !== WebSocket.CLOSED) this.#socket.terminate();
  }
}

const clients: Client[] = [];

// These are real socket-event watchdogs; fake clocks cannot drive Bun's WebSocket runtime.
async function withinWebSocketDeadline<T>(operation: Promise<T>, message: string): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(message)), CLEANUP_TIMEOUT_MS);
  try {
    return await Promise.race([operation, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function expectConnectionFailure(url: string): Promise<void> {
  const result = Promise.withResolvers<void>();
  const socket = new WebSocket(url);
  socket.onopen = () => result.reject(new Error("stopped WebSocket transport accepted a connection"));
  socket.onerror = () => result.resolve();
  socket.onclose = () => result.resolve();
  try {
    await withinWebSocketDeadline(result.promise, "stopped WebSocket transport accepted no connection result");
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
}

afterEach(async () => {
  const activeClients = clients.splice(0);
  const activeTransports = transports.splice(0);
  for (const client of activeClients) client.terminate();

  await withinWebSocketDeadline(
    Promise.all(activeClients.map((client) => client.closed())),
    "timed out closing WebSocket clients during cleanup",
  );
  await withinWebSocketDeadline(
    Promise.all(activeTransports.map((transport) => transport.stop())),
    "timed out stopping WebSocket transport during cleanup",
  );
});

async function authenticatedClient(transport: WebSocketTransportAdapter, token = "first-token"): Promise<Client> {
  const client = await Client.connect(transport.url);
  client.send({ type: "authenticate", token });
  await expect(client.nextFrame()).resolves.toEqual({ type: "ready", protocolVersion: 1 });
  return client;
}

function firstAddress(): ConversationAddress {
  return { transport: "websocket", account: ACCOUNT, channel: "first-channel" };
}

describe("WebSocketTransportAdapter", () => {
  test("serves health without credentials and returns 404 for other HTTP routes", async () => {
    const { transport } = harness();

    const health = await fetch(`http://127.0.0.1:${transport.port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    const unknown = await fetch(`http://127.0.0.1:${transport.port}/other`);
    expect(unknown.status).toBe(404);
  });

  test("rejects duplicate configured origins", () => {
    expect(
      () =>
        new WebSocketTransportAdapter({
          hostname: "127.0.0.1",
          port: 0,
          account: ACCOUNT,
          credentials: [
            { token: "one", subject: "subject-one", channel: "shared" },
            { token: "two", subject: "subject-two", channel: "shared" },
          ],
        }),
    ).toThrow(DuplicateWebSocketOriginError);
  });

  test("authenticates, resolves identity, and delivers origin-scoped inbound messages with server time", async () => {

    const { transport, nextInbound } = harness();
    const client = await authenticatedClient(transport);
    const before = Date.now();

    client.send({
      type: "message",
      id: "client-message",
      text: "hello",
      attachments: [{ url: "https://example.test/file.txt", name: "file.txt", mediaType: "text/plain" }],
    });

    const message = await nextInbound();
    expect(message).toMatchObject({
      identity: { transport: "websocket", account: ACCOUNT, subject: "first-subject" },
      address: firstAddress(),
      content: {
        text: "hello",
        attachments: [{ url: "https://example.test/file.txt", name: "file.txt", mediaType: "text/plain" }],
      },
    });
    expect(message.id).toContain("client-message");
    expect(message.sentAt).toBeGreaterThanOrEqual(before);
    expect(message.sentAt).toBeLessThanOrEqual(Date.now());

    const second = await authenticatedClient(transport, "second-token");
    second.send({ type: "message", id: "client-message", text: "from second origin" });
    const secondMessage = await nextInbound();
    expect(secondMessage.address).toEqual({
      transport: "websocket",
      account: ACCOUNT,
      channel: "second-channel",
      thread: "thread-2",
    });
    expect(secondMessage.id).not.toBe(message.id);

    client.close();
    second.close();
  });

  test("rejects an invalid token without echoing it", async () => {
    const { transport } = harness();
    const client = await Client.connect(transport.url);
    client.send({ type: "authenticate", token: "not-a-real-token" });

    const frame = await client.nextFrame();
    expect(frame).toEqual({ type: "error", code: "unauthorized", message: "authentication failed" });
    await client.closed();
  });

  test("rejects client-supplied identity and address fields", async () => {
    const { transport, inbound } = harness();
    const client = await authenticatedClient(transport);
    client.send({
      type: "message",
      id: "spoof-attempt",
      text: "hello",
      identity: { transport: "telegram", account: "other", subject: "attacker" },
      address: { transport: "telegram", account: "other", channel: "other" },
    });

    expect(await client.nextFrame()).toEqual({ type: "error", code: "invalid_frame", message: "invalid client frame" });
    expect(inbound).toEqual([]);
    client.close();
  });

  test("rejects a second live connection for an authenticated origin", async () => {
    const { transport } = harness();
    const first = await authenticatedClient(transport);
    const second = await Client.connect(transport.url);
    second.send({ type: "authenticate", token: "first-token" });

    expect(await second.nextFrame()).toEqual({
      type: "error",
      code: "duplicate_connection",
      message: "origin already has a live connection",
    });
    await second.closed();
    first.close();
  });

  test("routes messages, updates, and reactions only to the exact authenticated origin", async () => {
    const { transport, context } = harness();
    const first = await authenticatedClient(transport, "first-token");
    const second = await authenticatedClient(transport, "second-token");
    const firstContext = context("first-channel");
    const receipt = await transport.send(firstAddress(), { text: "initial" }, firstContext);

    expect(await first.nextFrame()).toEqual({ type: "message", messageId: receipt.messageId, content: { text: "initial" } });
    await second.expectNoFrame();

    await transport.update(firstAddress(), receipt, { text: "streamed" }, firstContext);
    expect(await first.nextFrame()).toEqual({ type: "update", messageId: receipt.messageId, content: { text: "streamed" } });

    await transport.react(firstAddress(), receipt, { emoji: "👍" }, firstContext);
    expect(await first.nextFrame()).toEqual({ type: "reaction", messageId: receipt.messageId, emoji: "👍" });
    await second.expectNoFrame();
    first.close();
    second.close();
  });

  test("round-trips every UI response type", async () => {
    const { transport, context } = harness();
    const client = await authenticatedClient(transport);
    const delivery = context("first-channel");
    const cases: readonly { readonly request: UiRequest; readonly response: UiResponse }[] = [
      { request: { type: "confirm", title: "Confirm", message: "Continue?" }, response: { type: "confirm", confirmed: true } },
      {
        request: { type: "select", title: "Select", options: [{ value: "one", label: "One" }] },
        response: { type: "select", selected: ["one"] },
      },
      { request: { type: "input", title: "Input" }, response: { type: "input", cancelled: false, value: "value" } },
      { request: { type: "editor", title: "Editor", initialValue: "" }, response: { type: "editor", cancelled: true } },
      { request: { type: "notify", message: "Notice" }, response: { type: "notify", acknowledged: true } },
      { request: { type: "open_url", url: "https://example.test" }, response: { type: "open_url", opened: true } },
      { request: { type: "status", key: "state" }, response: { type: "status", acknowledged: true } },
      { request: { type: "widget", key: "widget" }, response: { type: "widget", acknowledged: true } },
      { request: { type: "title", title: "Title" }, response: { type: "title", acknowledged: true } },
      { request: { type: "editor_text", text: "Editor text" }, response: { type: "editor_text", acknowledged: true } },
    ];

    for (const item of cases) {
      const result = transport.presentUi(firstAddress(), item.request, delivery);
      const request = await client.nextFrame();
      expect(request.type).toBe("ui_request");
      expect(request.request).toEqual(item.request);
      client.send({ type: "ui_response", requestId: request.requestId, response: item.response });
      await expect(result).resolves.toEqual(item.response);
    }
    client.close();
  });

  test("rejects wrong and stale UI responses without resolving the active request", async () => {
    const { transport, context } = harness();
    const client = await authenticatedClient(transport);
    const result = transport.presentUi(firstAddress(), { type: "confirm", title: "Confirm", message: "Continue?" }, context("first-channel"));
    const request = await client.nextFrame();

    client.send({ type: "ui_response", requestId: request.requestId, response: { type: "select", selected: [] } });
    expect(await client.nextFrame()).toEqual({
      type: "error",
      code: "ui_response_mismatch",
      message: "UI response type does not match the request",
    });

    client.send({ type: "ui_response", requestId: request.requestId, response: { type: "confirm", confirmed: true } });
    await expect(result).resolves.toEqual({ type: "confirm", confirmed: true });

    client.send({ type: "ui_response", requestId: request.requestId, response: { type: "confirm", confirmed: true } });
    expect(await client.nextFrame()).toEqual({
      type: "error",
      code: "ui_request_not_found",
      message: "UI request is stale or unknown",
    });
    client.close();
  });

  test("times out unauthenticated clients", async () => {
    const { transport } = harness({ authTimeoutMs: 20 });
    const client = await Client.connect(transport.url);
    // This intentionally exercises the server's real authentication deadline.

    expect(await client.nextFrame(250)).toEqual({
      type: "error",
      code: "auth_timeout",
      message: "authentication timed out",
    });
    await client.closed();
  });

  test("times out pending UI responses", async () => {
    const { transport, context } = harness({ uiTimeoutMs: 20 });
    const client = await authenticatedClient(transport);
    const result = transport.presentUi(
      firstAddress(),
      { type: "confirm", title: "Confirm", message: "Continue?" },
      context("first-channel"),
    );
    await client.nextFrame();
    // This intentionally exercises the server's real UI-response deadline.
    await expect(result).rejects.toBeInstanceOf(WebSocketUiTimeoutError);
    expect(await client.nextFrame(250)).toEqual({
      type: "error",
      code: "ui_timeout",
      message: "UI response timed out",
    });
    client.close();
  });

  test("enforces the configured payload limit", async () => {
    const { transport } = harness({ maxMessageLength: 8 });
    const client = await authenticatedClient(transport);
    client.send({ type: "message", id: "message", text: "123456789" });

    expect(await client.nextFrame()).toEqual({ type: "error", code: "payload_too_large", message: "invalid client frame" });
    client.close();
  });

  test("rejects aborted UI delivery and closes promptly when stopped", async () => {
    const { transport, context } = harness();
    const client = await authenticatedClient(transport);
    const url = transport.url;
    const controller = new AbortController();
    const aborted = transport.presentUi(
      firstAddress(),
      { type: "input", title: "Input" },
      context("first-channel"),
      controller.signal,
    );
    await client.nextFrame();
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

    const pending = transport.presentUi(
      firstAddress(),
      { type: "confirm", title: "Confirm", message: "Continue?" },
      context("first-channel"),
    );
    await client.nextFrame();
    await withinWebSocketDeadline(transport.stop(), "timed out stopping WebSocket transport");
    await expect(pending).rejects.toBeInstanceOf(WebSocketTransportDisconnectedError);
    await client.closed();
    await expectConnectionFailure(url);
  });
});
