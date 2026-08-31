import {
  type ConversationAddress,
  type DeliveryContext,
  type InboundEnvelope,
  type InboundMessage,
  type OutboundContent,
  type OutboundReceipt,
  type Reaction,
  type ResolveTransportIdentity,
  type TransportAdapter,
  type TransportCapability,
  type TransportIdentity,
  type UiRequest,
  type UiResponseFor,
  UnsupportedTransportCapabilityError,
} from "./gateway-types";

export type InboundHandler = (message: InboundMessage, signal?: AbortSignal) => void | Promise<void>;

export interface GatewayCoreOptions {
  readonly identityResolver: ResolveTransportIdentity;
  readonly onInbound: InboundHandler;
}

export class DuplicateTransportAdapterError extends Error {
  readonly name = "DuplicateTransportAdapterError";

  constructor(readonly transport: string) {
    super(`A transport adapter is already registered for ${transport}`);
  }
}

export class UnknownTransportAdapterError extends Error {
  readonly name = "UnknownTransportAdapterError";

  constructor(readonly transport: string) {
    super(`No transport adapter is registered for ${transport}`);
  }
}

export class UnknownTransportIdentityError extends Error {
  readonly name = "UnknownTransportIdentityError";

  constructor(readonly identity: TransportIdentity) {
    super(`No principal is resolved for ${identity.transport}/${identity.account}/${identity.subject}`);
  }
}
export class InvalidInboundEnvelopeIdError extends Error {
  readonly name = "InvalidInboundEnvelopeIdError";

  constructor(readonly id: unknown) {
    super("Inbound envelope id must be a non-empty string");
  }
}

export class InvalidInboundEnvelopeSentAtError extends Error {
  readonly name = "InvalidInboundEnvelopeSentAtError";

  constructor(readonly sentAt: unknown) {
    super("Inbound envelope sentAt must be a safe nonnegative integer");
  }
}

export class InboundIdentityAddressMismatchError extends Error {
  readonly name = "InboundIdentityAddressMismatchError";

  constructor(
    readonly identity: TransportIdentity,
    readonly address: ConversationAddress,
  ) {
    super(
      `Inbound identity ${identity.transport}/${identity.account} does not match address ${address.transport}/${address.account}`,
    );
  }
}

export class InboundReplyReceiptTransportMismatchError extends Error {
  readonly name = "InboundReplyReceiptTransportMismatchError";

  constructor(
    readonly expectedTransport: string,
    readonly actualTransport: string,
  ) {
    super(`Inbound reply receipt transport ${actualTransport} does not match address transport ${expectedTransport}`);
  }
}


export class InboundTransportMismatchError extends Error {
  readonly name = "InboundTransportMismatchError";

  constructor(
    readonly adapterId: string,
    readonly identityTransport: string,
    readonly addressTransport: string,
  ) {
    super(
      `Adapter ${adapterId} cannot deliver an envelope for identity transport ${identityTransport} and address transport ${addressTransport}`,
    );
  }
}

export class ReceiptTransportMismatchError extends Error {
  readonly name = "ReceiptTransportMismatchError";

  constructor(
    readonly expectedTransport: string,
    readonly actualTransport: string,
  ) {
    super(`Receipt transport ${actualTransport} does not match address transport ${expectedTransport}`);
  }
}
export class CrossOriginDeliveryError extends Error {
  readonly name = "CrossOriginDeliveryError";

  constructor(
    readonly origin: ConversationAddress,
    readonly address: ConversationAddress,
  ) {
    super(
      `Outbound address ${address.transport}/${address.account}/${address.channel}/${address.thread ?? ""} does not match delivery origin ${origin.transport}/${origin.account}/${origin.channel}/${origin.thread ?? ""}`,
    );
  }
}


export class OutboundContentTooLongError extends Error {
  readonly name = "OutboundContentTooLongError";

  constructor(
    readonly transport: string,
    readonly length: number,
    readonly maxLength: number,
  ) {
    super(`Outbound content for ${transport} is ${length} characters; maximum is ${maxLength}`);
  }
}

export class UnsupportedUiRequestError extends Error {
  readonly name = "UnsupportedUiRequestError";

  constructor(
    readonly transport: string,
    readonly requestType: UiRequest["type"],
  ) {
    super(`Transport ${transport} cannot present ${requestType} UI`);
  }
}

export class GatewayLifecycleError extends Error {
  readonly name = "GatewayLifecycleError";

  constructor(readonly operation: "register" | "start" | "stop", readonly state: GatewayState) {
    super(`Cannot ${operation} gateway while it is ${state}`);
  }
}

type GatewayState = "idle" | "starting" | "started" | "stopping";

/**
 * In-process transport coordinator. Addresses contain the exact registered
 * transport ID; no aliases or client-provided principals are accepted here.
 */
export class GatewayCore {
  readonly #identityResolver: ResolveTransportIdentity;
  readonly #onInbound: InboundHandler;
  readonly #adapters = new Map<string, TransportAdapter>();
  #startedAdapters: TransportAdapter[] = [];
  #state: GatewayState = "idle";

  constructor(options: GatewayCoreOptions) {
    this.#identityResolver = options.identityResolver;
    this.#onInbound = options.onInbound;
  }

  register(adapter: TransportAdapter): void {
    if (this.#state !== "idle") throw new GatewayLifecycleError("register", this.#state);
    if (this.#adapters.has(adapter.id)) throw new DuplicateTransportAdapterError(adapter.id);
    this.#adapters.set(adapter.id, adapter);
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#state === "started") return;
    if (this.#state !== "idle") throw new GatewayLifecycleError("start", this.#state);

    this.#state = "starting";
    const started: TransportAdapter[] = [];
    try {
      for (const adapter of this.#adapters.values()) {
        await adapter.start({
          resolveIdentity: this.#identityResolver,
          receive: (envelope, inboundSignal) => this.#receiveFrom(adapter.id, envelope, inboundSignal ?? signal),
          signal,
        });
        started.push(adapter);
      }
      this.#startedAdapters = started;
      this.#state = "started";
    } catch (error) {
      await this.#stopInReverse(started);
      this.#startedAdapters = [];
      this.#state = "idle";
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#state === "idle") return;
    if (this.#state !== "started") throw new GatewayLifecycleError("stop", this.#state);

    this.#state = "stopping";
    const error = await this.#stopInReverse(this.#startedAdapters);
    this.#startedAdapters = [];
    this.#state = "idle";
    if (error !== undefined) throw error;
  }

  async receive(envelope: InboundEnvelope, signal?: AbortSignal): Promise<void> {
    this.#assertInboundEnvelope(envelope);
    await this.#receiveValidated(envelope, signal);
  }

  async send(
    address: ConversationAddress,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    this.#assertDeliveryOrigin(context, address);
    const adapter = this.#adapterFor(address);
    this.#assertAddressSupported(adapter, address);
    this.#assertContentSupported(adapter, address, content);
    return adapter.send(address, content, context, signal);
  }

  async update(
    address: ConversationAddress,
    receipt: OutboundReceipt,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt> {
    this.#assertDeliveryOrigin(context, address);
    const adapter = this.#adapterFor(address);
    this.#assertReceiptTransport(address, receipt);
    this.#assertAddressSupported(adapter, address);
    this.#assertContentSupported(adapter, address, content);
    this.#requireCapability(adapter, "streamingUpdates", adapter.update !== undefined);
    return adapter.update!(address, receipt, content, context, signal);
  }
  async finalize(
    address: ConversationAddress,
    receipt: OutboundReceipt | undefined,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<readonly OutboundReceipt[]> {
    this.#assertDeliveryOrigin(context, address);
    const adapter = this.#adapterFor(address);
    if (receipt !== undefined) this.#assertReceiptTransport(address, receipt);
    this.#assertAddressSupported(adapter, address);
    this.#assertContentSupported(adapter, address, content);
    return adapter.finalize(address, receipt, content, context, signal);
  }


  async react(
    address: ConversationAddress,
    receipt: OutboundReceipt,
    reaction: Reaction,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#assertDeliveryOrigin(context, address);
    const adapter = this.#adapterFor(address);
    this.#assertReceiptTransport(address, receipt);
    this.#assertAddressSupported(adapter, address);
    this.#requireCapability(adapter, "reactions", adapter.react !== undefined);
    await adapter.react!(address, receipt, reaction, context, signal);
  }

  async presentUi<Request extends UiRequest>(
    address: ConversationAddress,
    request: Request,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<UiResponseFor<Request>> {
    this.#assertDeliveryOrigin(context, address);
    const adapter = this.#adapterFor(address);
    this.#assertAddressSupported(adapter, address);
    this.#assertUiCapabilities(adapter, request);
    if (adapter.presentUi === undefined) throw new UnsupportedUiRequestError(adapter.id, request.type);
    return adapter.presentUi(address, request, context, signal);
  }

  #adapterFor(address: ConversationAddress): TransportAdapter {
    const adapter = this.#adapters.get(address.transport);
    if (adapter === undefined) throw new UnknownTransportAdapterError(address.transport);
    return adapter;
  }

  async #receiveFrom(adapterId: string, envelope: InboundEnvelope, signal?: AbortSignal): Promise<void> {
    this.#assertInboundEnvelope(envelope);
    if (envelope.identity.transport !== adapterId || envelope.address.transport !== adapterId) {
      throw new InboundTransportMismatchError(adapterId, envelope.identity.transport, envelope.address.transport);
    }
    await this.#receiveValidated(envelope, signal);
  }

  async #receiveValidated(envelope: InboundEnvelope, signal?: AbortSignal): Promise<void> {
    const principal = await this.#identityResolver(envelope.identity, signal);
    if (principal === undefined) throw new UnknownTransportIdentityError(envelope.identity);

    const { id, sentAt, identity, address, content, replyTo, edited } = envelope;
    await this.#onInbound(
      {
        id,
        sentAt,
        identity,
        address,
        content,
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(edited === undefined ? {} : { edited }),
        principal,
      },
      signal,
    );
  }

  #assertReceiptTransport(address: ConversationAddress, receipt: OutboundReceipt): void {
    if (receipt.transport !== address.transport) {
      throw new ReceiptTransportMismatchError(address.transport, receipt.transport);
    }
  }
  #assertInboundEnvelope(envelope: InboundEnvelope): void {
    if (typeof envelope.id !== "string" || envelope.id.length === 0) {
      throw new InvalidInboundEnvelopeIdError(envelope.id);
    }
    if (
      typeof envelope.sentAt !== "number" ||
      !Number.isSafeInteger(envelope.sentAt) ||
      envelope.sentAt < 0
    ) {
      throw new InvalidInboundEnvelopeSentAtError(envelope.sentAt);
    }
    if (
      envelope.identity.transport !== envelope.address.transport ||
      envelope.identity.account !== envelope.address.account
    ) {
      throw new InboundIdentityAddressMismatchError(envelope.identity, envelope.address);
    }
    if (envelope.replyTo !== undefined && envelope.replyTo.transport !== envelope.address.transport) {
      throw new InboundReplyReceiptTransportMismatchError(envelope.address.transport, envelope.replyTo.transport);
    }
  }

  #assertDeliveryOrigin(context: DeliveryContext, address: ConversationAddress): void {
    if (
      context.origin.transport !== address.transport ||
      context.origin.account !== address.account ||
      context.origin.channel !== address.channel ||
      context.origin.thread !== address.thread
    ) {
      throw new CrossOriginDeliveryError(context.origin, address);
    }
  }


  #assertAddressSupported(adapter: TransportAdapter, address: ConversationAddress): void {
    if (address.thread !== undefined) this.#requireCapability(adapter, "threads");
  }

  #assertContentSupported(adapter: TransportAdapter, address: ConversationAddress, content: OutboundContent): void {
    if (content.replyTo !== undefined) this.#assertReceiptTransport(address, content.replyTo);
    if (content.attachments !== undefined && content.attachments.length > 0) {
      this.#requireCapability(adapter, "attachments");
    }
    if (content.text !== undefined && content.text.length > adapter.capabilities.maxMessageLength) {
      throw new OutboundContentTooLongError(adapter.id, content.text.length, adapter.capabilities.maxMessageLength);
    }
  }

  #assertUiCapabilities(adapter: TransportAdapter, request: UiRequest): void {
    switch (request.type) {
      case "confirm":
      case "open_url":
        this.#requireCapability(adapter, "buttons");
        return;
      case "select":
        this.#requireCapability(adapter, "buttons");
        if (request.multiSelect === true) this.#requireCapability(adapter, "multiSelect");
        return;
      case "input":
      case "editor":
        this.#requireCapability(adapter, "textInput");
        return;
      case "notify":
      case "status":
      case "widget":
      case "title":
      case "editor_text":
        return;
    }
  }

  #requireCapability(adapter: TransportAdapter, capability: TransportCapability, implemented = true): void {
    if (!implemented || !adapter.capabilities[capability]) {
      throw new UnsupportedTransportCapabilityError(adapter.id, capability);
    }
  }

  async #stopInReverse(adapters: readonly TransportAdapter[]): Promise<unknown> {
    let firstError: unknown;
    for (let index = adapters.length - 1; index >= 0; index -= 1) {
      try {
        await adapters[index]!.stop();
      } catch (error) {
        firstError ??= error;
      }
    }
    return firstError;
  }
}

export { UnsupportedTransportCapabilityError } from "./gateway-types";
