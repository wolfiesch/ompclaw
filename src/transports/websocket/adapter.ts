import { createHash, timingSafeEqual } from "node:crypto";
import type {
  ConversationAddress,
  DeliveryContext,
  MessageAttachment,
  OutboundContent,
  OutboundReceipt,
  Principal,
  Reaction,
  TransportAdapter,
  TransportCapabilities,
  TransportIdentity,
  TransportStartContext,
  UiRequest,
  UiResponseFor,
} from "../../gateway-types";
import {
  InvalidWebSocketFrameError,
  WEBSOCKET_PROTOCOL_VERSION,
  WEBSOCKET_TRANSPORT_ID,
  type ClientFrame,
  type ServerErrorFrame,
  type ServerFrame,
  parseClientFrame,
  validateMaxMessageLength,
} from "./protocol";

const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_UI_TIMEOUT_MS = 60_000;
const MAX_CREDENTIAL_TOKEN_LENGTH = 4_096;
const MAX_OUTBOUND_RECEIPT_ID_LENGTH = 256;

export interface WebSocketTransportCredential {
  readonly token: string;
  readonly subject: string;
  readonly channel: string;
  readonly thread?: string;
}

export interface WebSocketTransportLogger {
  warn(message: string): void;
}

export interface WebSocketTransportOptions {
  readonly hostname: string;
  readonly port: number;
  readonly account: string;
  readonly credentials: readonly WebSocketTransportCredential[];
  readonly authTimeoutMs?: number;
  readonly uiTimeoutMs?: number;
  readonly maxMessageLength?: number;
  readonly logger?: WebSocketTransportLogger;
}

interface ConfiguredCredential {
  readonly tokenHash: Buffer;
  readonly identity: TransportIdentity;
  readonly origin: ConversationAddress;
  readonly originKey: string;
}

interface PendingUi {
  readonly requestId: string;
  readonly responseType: UiRequest["type"];
  readonly principalId: string;
  readonly resolve: (response: UiResponseFor<UiRequest>) => void;
  readonly reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  abortListener?: () => void;
  signal?: AbortSignal;
}

interface ConnectionState {
  phase: "pending" | "authenticating" | "ready" | "closed";
  readonly controller: AbortController;
  readonly pendingUi: Map<string, PendingUi>;
  authTimer?: NodeJS.Timeout;
  socket?: WebSocketConnection;
  credential?: ConfiguredCredential;
  principal?: Principal;
}

interface WebSocketConnection {
  readonly data: ConnectionState;
  send(data: string): number;
  close(code?: number, reason?: string): void;
}

interface RunningServer {
  readonly port: number;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

export class DuplicateWebSocketOriginError extends Error {
  readonly name = "DuplicateWebSocketOriginError";

  constructor(readonly origin: ConversationAddress) {
    super("multiple WebSocket credentials target the same conversation origin");
  }
}

export class DuplicateWebSocketTokenError extends Error {
  readonly name = "DuplicateWebSocketTokenError";

  constructor() {
    super("WebSocket credential tokens must be unique");
  }
}

export class WebSocketTransportDisconnectedError extends Error {
  readonly name = "WebSocketTransportDisconnectedError";

  constructor() {
    super("the authenticated WebSocket client is no longer connected");
  }
}

export class WebSocketDeliveryPrincipalMismatchError extends Error {
  readonly name = "WebSocketDeliveryPrincipalMismatchError";

  constructor() {
    super("the authenticated WebSocket principal does not match the delivery context");
  }
}

export class WebSocketUiTimeoutError extends Error {
  readonly name = "WebSocketUiTimeoutError";

  constructor() {
    super("the WebSocket UI response timed out");
  }
}

/**
 * Authenticated v1 WebSocket transport. Credential metadata, not client frames,
 * determines every inbound identity and conversation address.
 */
export class WebSocketTransportAdapter implements TransportAdapter {
  readonly id = WEBSOCKET_TRANSPORT_ID;
  readonly capabilities: TransportCapabilities;
  readonly #hostname: string;
  readonly #requestedPort: number;
  readonly #credentials: readonly ConfiguredCredential[];
  readonly #credentialByOrigin = new Map<string, ConfiguredCredential>();
  readonly #connectionsByOrigin = new Map<string, ConnectionState>();
  readonly #connections = new Set<ConnectionState>();
  readonly #authTimeoutMs: number;
  readonly #uiTimeoutMs: number;
  readonly #maxMessageLength: number;
  readonly #logger?: WebSocketTransportLogger;
  #server?: RunningServer;
  #context?: TransportStartContext;
  #startAbortListener?: () => void;
  #stopping?: Promise<void>;
  #serverInitiatedClose = false;

  constructor(options: WebSocketTransportOptions) {
    assertNonEmptyString(options.hostname, "hostname");
    assertNonEmptyString(options.account, "account");
    if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new RangeError("port must be a safe integer between 0 and 65535");
    }
    if (!Array.isArray(options.credentials) || options.credentials.length === 0) {
      throw new TypeError("at least one WebSocket credential is required");
    }

    this.#hostname = options.hostname;
    this.#requestedPort = options.port;
    this.#authTimeoutMs = positiveTimeout(options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS, "authTimeoutMs");
    this.#uiTimeoutMs = positiveTimeout(options.uiTimeoutMs ?? DEFAULT_UI_TIMEOUT_MS, "uiTimeoutMs");
    this.#maxMessageLength = options.maxMessageLength ?? 4_096;
    validateMaxMessageLength(this.#maxMessageLength);
    this.#logger = options.logger;
    this.#credentials = options.credentials.map((credential) => this.#configureCredential(options.account, credential));
    this.capabilities = {
      streamingUpdates: true,
      buttons: true,
      multiSelect: true,
      textInput: true,
      attachments: true,
      reactions: true,
      threads: true,
      maxMessageLength: this.#maxMessageLength,
    };
  }

  get port(): number {
    if (this.#server === undefined) throw new Error("WebSocket transport is not started");
    return this.#server.port;
  }

  get url(): string {
    return `ws://${this.#hostname}:${this.port}`;
  }

  start(context: TransportStartContext): void {
    if (this.#server !== undefined || this.#stopping !== undefined) throw new Error("WebSocket transport is already started");
    throwIfAborted(context.signal);
    this.#serverInitiatedClose = false;
    this.#context = context;
    this.#server = Bun.serve<ConnectionState>({
      hostname: this.#hostname,
      port: this.#requestedPort,
      fetch: (request, server) => this.#fetch(request, server),
      websocket: {
        open: (socket) => this.#open(socket as unknown as WebSocketConnection),
        message: (socket, message) => {
          void this.#handleFrame(socket as unknown as WebSocketConnection, message as string | Buffer).catch(() => {
            this.#warn("WebSocket frame handling failed");
          });
        },
        close: (socket) => this.#close(socket.data),
      },
    }) as RunningServer;

    if (context.signal !== undefined) {
      this.#startAbortListener = () => {
        void this.stop();
      };
      context.signal.addEventListener("abort", this.#startAbortListener, { once: true });
    }
  }

  stop(): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping;
    const server = this.#server;
    if (server === undefined) return Promise.resolve();

    this.#server = undefined;
    if (this.#context?.signal !== undefined && this.#startAbortListener !== undefined) {
      this.#context.signal.removeEventListener("abort", this.#startAbortListener);
    }
    this.#startAbortListener = undefined;
    this.#context = undefined;

    const stopping = server.stop(true);
    void stopping.catch(() => undefined);
    for (const connection of [...this.#connections]) {
      this.#close(connection);
    }

    // Bun 1.3.14 bug #36223 leaves stop() pending after any server-side WebSocket close.
    const completed = this.#serverInitiatedClose ? Promise.resolve() : stopping;
    this.#stopping = completed;
    void completed.then(
      () => {
        if (this.#stopping === completed) this.#stopping = undefined;
      },
      () => {
        if (this.#stopping === completed) this.#stopping = undefined;
      },
    );
    return completed;
  }

  async send(
    address: ConversationAddress,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    const connection = this.#deliveryConnection(address, context, signal);
    assertOutboundContent(content, this.#maxMessageLength);
    const receipt: OutboundReceipt = { transport: this.id, messageId: crypto.randomUUID() };
    this.#sendRequired(connection, { type: "message", messageId: receipt.messageId, content });
    return receipt;
  }

  async update(
    address: ConversationAddress,
    receipt: OutboundReceipt,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    const connection = this.#deliveryConnection(address, context, signal);
    assertReceipt(receipt, this.id);
    assertOutboundContent(content, this.#maxMessageLength);
    this.#sendRequired(connection, { type: "update", messageId: receipt.messageId, content });
    return receipt;
  }

  async react(
    address: ConversationAddress,
    receipt: OutboundReceipt,
    reaction: Reaction,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<void> {
    const connection = this.#deliveryConnection(address, context, signal);
    assertReceipt(receipt, this.id);
    assertNonEmptyString(reaction.emoji, "reaction.emoji");
    if (reaction.emoji.length > this.#maxMessageLength) {
      throw new RangeError("reaction.emoji exceeds maxMessageLength");
    }
    this.#sendRequired(connection, { type: "reaction", messageId: receipt.messageId, emoji: reaction.emoji });
  }

  presentUi<Request extends UiRequest>(
    address: ConversationAddress,
    request: Request,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<UiResponseFor<Request>> {
    let response: Promise<UiResponseFor<Request>>;
    try {
      const connection = this.#deliveryConnection(address, context, signal);
      const requestId = crypto.randomUUID();

      response = new Promise<UiResponseFor<Request>>((resolve, reject) => {
        const pending: PendingUi = {
          requestId,
          responseType: request.type,
          principalId: context.principal.id,
          resolve: resolve as (response: UiResponseFor<UiRequest>) => void,
          reject,
          timeout: setTimeout(() => {
            this.#sendError(connection, "ui_timeout", "UI response timed out");
            this.#rejectPending(connection, pending, new WebSocketUiTimeoutError());
          }, this.#uiTimeoutMs),
          signal,
        };
        if (signal !== undefined) {
          pending.abortListener = () => {
            this.#rejectPending(connection, pending, abortError(signal));
          };
          signal.addEventListener("abort", pending.abortListener, { once: true });
        }
        connection.pendingUi.set(requestId, pending);

        if (!this.#sendFrame(connection, { type: "ui_request", requestId, request })) {
          this.#rejectPending(connection, pending, new WebSocketTransportDisconnectedError());
        }
      });
    } catch (error) {
      response = Promise.reject(error);
    }
    void response.catch(() => undefined);
    return response;

  }
  #configureCredential(account: string, credential: WebSocketTransportCredential): ConfiguredCredential {
    assertNonEmptyString(credential.token, "credential.token");
    if (credential.token.length > MAX_CREDENTIAL_TOKEN_LENGTH) {
      throw new RangeError("credential.token is too long");
    }
    assertNonEmptyString(credential.subject, "credential.subject");
    assertNonEmptyString(credential.channel, "credential.channel");
    if (credential.thread !== undefined) assertNonEmptyString(credential.thread, "credential.thread");

    const origin: ConversationAddress = {
      transport: this.id,
      account,
      channel: credential.channel,
      ...(credential.thread === undefined ? {} : { thread: credential.thread }),
    };
    const configured: ConfiguredCredential = {
      tokenHash: tokenHash(credential.token),
      identity: { transport: this.id, account, subject: credential.subject },
      origin,
      originKey: originKey(origin),
    };
    if (this.#credentialByOrigin.has(configured.originKey)) throw new DuplicateWebSocketOriginError(origin);
    for (const existing of this.#credentialByOrigin.values()) {
      if (timingSafeEqual(existing.tokenHash, configured.tokenHash)) throw new DuplicateWebSocketTokenError();
    }
    this.#credentialByOrigin.set(configured.originKey, configured);
    return configured;
  }

  #fetch(request: Request, server: { upgrade(request: Request, options: { data: ConnectionState }): boolean }): Response | undefined {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") {
      return Response.json({ status: "ok" });
    }
    if (url.pathname === "/" && request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return server.upgrade(request, {
        data: { phase: "pending", controller: new AbortController(), pendingUi: new Map<string, PendingUi>() },
      })
        ? undefined
        : new Response("WebSocket upgrade failed", { status: 400 });
    }
    return new Response("Not found", { status: 404 });
  }


  #open(socket: WebSocketConnection): void {
    const connection = socket.data;
    connection.socket = socket;
    if (this.#server === undefined) {
      this.#close(connection);
      socket.close(1001, "transport stopped");
      return;
    }
    this.#connections.add(connection);
    connection.authTimer = setTimeout(() => {
      this.#terminate(connection, "auth_timeout", "authentication timed out", 1008);
    }, this.#authTimeoutMs);
  }

  async #handleFrame(socket: WebSocketConnection, raw: string | Buffer): Promise<void> {
    const connection = socket.data;
    if (connection.phase === "closed") return;

    let frame: ClientFrame;
    try {
      frame = parseClientFrame(raw, this.#maxMessageLength);
    } catch (error) {
      const parsed = error instanceof InvalidWebSocketFrameError ? error : undefined;
      this.#sendError(connection, parsed?.code ?? "invalid_frame", "invalid client frame");
      if (connection.phase !== "ready") this.#closeAfterError(connection);
      return;
    }

    if (connection.phase !== "ready") {
      if (connection.phase !== "pending" || frame.type !== "authenticate") {
        this.#sendError(connection, "authentication_required", "authenticate before sending other frames");
        this.#closeAfterError(connection);
        return;
      }
      await this.#authenticate(connection, frame);
      return;
    }

    if (frame.type === "authenticate") {
      this.#sendError(connection, "invalid_frame", "client is already authenticated");
      return;
    }
    if (frame.type === "message") {
      await this.#receiveMessage(connection, frame);
      return;
    }
    await this.#receiveUiResponse(connection, frame);
  }

  async #authenticate(connection: ConnectionState, frame: Extract<ClientFrame, { type: "authenticate" }>): Promise<void> {
    connection.phase = "authenticating";
    const credential = this.#credentialForToken(frame.token);
    if (credential === undefined) {
      this.#terminate(connection, "unauthorized", "authentication failed", 1008);
      return;
    }
    if (this.#connectionsByOrigin.has(credential.originKey)) {
      this.#terminate(connection, "duplicate_connection", "origin already has a live connection", 1008);
      return;
    }

    const context = this.#context;
    if (context === undefined) {
      this.#terminate(connection, "transport_stopped", "transport stopped", 1001);
      return;
    }

    let principal: Principal | undefined;
    try {
      principal = await context.resolveIdentity(credential.identity, connection.controller.signal);
    } catch {
      this.#warn("WebSocket identity resolution failed");
      this.#terminate(connection, "unauthorized", "authentication failed", 1008);
      return;
    }
    if (!this.#connections.has(connection)) return;
    if (principal === undefined) {
      this.#terminate(connection, "unauthorized", "authentication failed", 1008);
      return;
    }
    if (this.#connectionsByOrigin.has(credential.originKey)) {
      this.#terminate(connection, "duplicate_connection", "origin already has a live connection", 1008);
      return;
    }

    connection.credential = credential;
    connection.principal = principal;
    clearTimeout(connection.authTimer);
    connection.authTimer = undefined;
    connection.phase = "ready";
    this.#connectionsByOrigin.set(credential.originKey, connection);
    this.#sendFrame(connection, { type: "ready", protocolVersion: WEBSOCKET_PROTOCOL_VERSION });
  }

  #credentialForToken(token: string): ConfiguredCredential | undefined {
    const candidateHash = tokenHash(token);
    let matching: ConfiguredCredential | undefined;
    for (const credential of this.#credentials) {
      if (timingSafeEqual(candidateHash, credential.tokenHash) && matching === undefined) matching = credential;
    }
    return matching;
  }

  async #receiveMessage(connection: ConnectionState, frame: Extract<ClientFrame, { type: "message" }>): Promise<void> {
    const credential = connection.credential;
    const context = this.#context;
    if (credential === undefined || context === undefined || connection.phase !== "ready") return;

    try {
      await context.receive(
        {
          id: `${credential.originKey}:${frame.id}`,
          sentAt: Date.now(),
          identity: credential.identity,
          address: credential.origin,
          content: {
            ...(frame.text === undefined ? {} : { text: frame.text }),
            ...(frame.attachments === undefined ? {} : { attachments: frame.attachments }),
          },
        },
        connection.controller.signal,
      );
    } catch {
      this.#warn("WebSocket inbound message was rejected");
      this.#sendError(connection, "message_rejected", "message could not be accepted");
    }
  }

  async #receiveUiResponse(connection: ConnectionState, frame: Extract<ClientFrame, { type: "ui_response" }>): Promise<void> {
    const pending = connection.pendingUi.get(frame.requestId);
    if (pending === undefined) {
      this.#sendError(connection, "ui_request_not_found", "UI request is stale or unknown");
      return;
    }
    const credential = connection.credential;
    const context = this.#context;
    if (credential === undefined || context === undefined) return;

    let principal: Principal | undefined;
    try {
      principal = await context.resolveIdentity(credential.identity, connection.controller.signal);
    } catch {
      this.#warn("WebSocket UI identity resolution failed");
      this.#sendError(connection, "ui_principal_mismatch", "UI response principal does not match the request");
      return;
    }
    if (connection.phase !== "ready" || principal?.id !== pending.principalId) {
      this.#sendError(connection, "ui_principal_mismatch", "UI response principal does not match the request");
      return;
    }
    if (frame.response.type !== pending.responseType) {
      this.#sendError(connection, "ui_response_mismatch", "UI response type does not match the request");
      return;
    }
    this.#resolvePending(connection, pending, frame.response);
  }

  #deliveryConnection(address: ConversationAddress, context: DeliveryContext, signal?: AbortSignal): ConnectionState {
    throwIfAborted(signal);
    if (!sameOrigin(address, context.origin)) {
      throw new Error("delivery address must match the delivery context origin");
    }
    const connection = this.#connectionsByOrigin.get(originKey(address));
    if (connection === undefined || connection.phase !== "ready") throw new WebSocketTransportDisconnectedError();
    if (connection.principal?.id !== context.principal.id) throw new WebSocketDeliveryPrincipalMismatchError();
    return connection;
  }

  #sendFrame(connection: ConnectionState, frame: ServerFrame): boolean {
    if (connection.phase === "closed" || connection.socket === undefined) return false;
    try {
      return connection.socket.send(JSON.stringify(frame)) >= 0;
    } catch {
      return false;
    }
  }

  #sendRequired(connection: ConnectionState, frame: ServerFrame): void {
    if (this.#sendFrame(connection, frame)) return;
    this.#close(connection);
    throw new WebSocketTransportDisconnectedError();
  }

  #sendError(connection: ConnectionState, code: string, message: string): void {
    const frame: ServerErrorFrame = { type: "error", code, message };
    this.#sendFrame(connection, frame);
  }

  #closeAfterError(connection: ConnectionState): void {
    queueMicrotask(() => {
      if (connection.phase === "closed") return;
      const socket = connection.socket;
      this.#close(connection);
      if (socket !== undefined) {
        this.#serverInitiatedClose = true;
        socket.close(1008, "protocol error");
      }
    });
  }

  #terminate(connection: ConnectionState, code: string, message: string, closeCode: number): void {
    const socket = connection.socket;
    this.#sendError(connection, code, message);
    this.#close(connection);
    if (socket !== undefined) {
      this.#serverInitiatedClose = true;
      socket.close(closeCode, message);
    }
  }

  #close(connection: ConnectionState): void {
    if (connection.phase === "closed") return;
    connection.phase = "closed";
    clearTimeout(connection.authTimer);
    connection.authTimer = undefined;
    connection.controller.abort();
    this.#connections.delete(connection);
    if (connection.credential !== undefined && this.#connectionsByOrigin.get(connection.credential.originKey) === connection) {
      this.#connectionsByOrigin.delete(connection.credential.originKey);
    }
    for (const pending of [...connection.pendingUi.values()]) {
      this.#rejectPending(connection, pending, new WebSocketTransportDisconnectedError());
    }
  }

  #resolvePending(connection: ConnectionState, pending: PendingUi, response: UiResponseFor<UiRequest>): void {
    this.#removePending(connection, pending);
    pending.resolve(response);
  }

  #rejectPending(connection: ConnectionState, pending: PendingUi, error: Error): void {
    if (!connection.pendingUi.has(pending.requestId)) return;
    this.#removePending(connection, pending);
    pending.reject(error);
  }

  #removePending(connection: ConnectionState, pending: PendingUi): void {
    connection.pendingUi.delete(pending.requestId);
    clearTimeout(pending.timeout);
    if (pending.signal !== undefined && pending.abortListener !== undefined) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
  }

  #warn(message: string): void {
    this.#logger?.warn(message);
  }
}

function originKey(origin: ConversationAddress): string {
  return JSON.stringify([origin.transport, origin.account, origin.channel, origin.thread ?? null]);
}

function sameOrigin(left: ConversationAddress, right: ConversationAddress): boolean {
  return (
    left.transport === right.transport &&
    left.account === right.account &&
    left.channel === right.channel &&
    left.thread === right.thread
  );
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function assertReceipt(receipt: OutboundReceipt, transport: string): void {
  if (receipt.transport !== transport) throw new TypeError("receipt transport does not match the WebSocket transport");
  assertNonEmptyString(receipt.messageId, "receipt.messageId");
  if (receipt.messageId.length > MAX_OUTBOUND_RECEIPT_ID_LENGTH) {
    throw new RangeError("receipt.messageId is too long");
  }
}

function assertOutboundContent(content: OutboundContent, maxMessageLength: number): void {
  if (content.text !== undefined) {
    if (typeof content.text !== "string" || content.text.length > maxMessageLength) {
      throw new RangeError("outbound text exceeds maxMessageLength");
    }
  }
  if (content.attachments !== undefined) {
    if (!Array.isArray(content.attachments) || content.attachments.length > 32) {
      throw new TypeError("outbound attachments must be a bounded array");
    }
    for (const attachment of content.attachments) assertAttachment(attachment, maxMessageLength);
  }
}

function assertAttachment(attachment: MessageAttachment, maxMessageLength: number): void {
  assertNonEmptyString(attachment.url, "attachment.url");
  if (attachment.url.length > 8_192) throw new RangeError("attachment.url is too long");
  if (attachment.name !== undefined && (typeof attachment.name !== "string" || attachment.name.length > maxMessageLength)) {
    throw new RangeError("attachment.name exceeds maxMessageLength");
  }
  if (attachment.mediaType !== undefined && (typeof attachment.mediaType !== "string" || attachment.mediaType.length > 256)) {
    throw new RangeError("attachment.mediaType is too long");
  }
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

function positiveTimeout(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000) {
    throw new RangeError(`${name} must be a safe integer between 1 and 3,600,000`);
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}
