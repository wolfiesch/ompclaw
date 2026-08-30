import { describe, expect, test } from "bun:test";
import {
  CrossOriginDeliveryError,
  DuplicateTransportAdapterError,
  GatewayCore,
  InboundIdentityAddressMismatchError,
  InboundReplyReceiptTransportMismatchError,
  InvalidInboundEnvelopeIdError,
  InvalidInboundEnvelopeSentAtError,
  ReceiptTransportMismatchError,
  UnknownTransportIdentityError,
} from "./gateway-core";
import {
  type ConversationAddress,
  type DeliveryContext,
  type InboundEnvelope,
  type InboundMessage,
  type OutboundContent,
  type OutboundReceipt,
  type Principal,
  type ReceiveInbound,
  type ResolveTransportIdentity,
  type TransportAdapter,
  type TransportCapabilities,
  type UiRequest,
  type UiResponseFor,
  UnsupportedTransportCapabilityError,
} from "./gateway-types";

const FULL_CAPABILITIES: TransportCapabilities = {
  streamingUpdates: true,
  buttons: true,
  multiSelect: true,
  textInput: true,
  attachments: true,
  reactions: true,
  threads: true,
  maxMessageLength: 4_096,
};

const SERVER_PRINCIPAL: Principal = { id: "server-principal", roles: ["member"] };

function address(
  transport: string,
  overrides: Partial<Omit<ConversationAddress, "transport">> = {},
): ConversationAddress {
  return { transport, account: "account", channel: "channel", ...overrides };
}

function deliveryContext(origin: ConversationAddress): DeliveryContext {
  return { principal: SERVER_PRINCIPAL, origin };
}

function envelope(transport: string): InboundEnvelope {
  return {
    id: "inbound-message",
    sentAt: 1_700_000_000_000,
    identity: { transport, account: "account", subject: "subject" },
    address: address(transport),
    content: { text: "hello" },
  };
}

function adapter(
  id: string,
  capabilities: TransportCapabilities = FULL_CAPABILITIES,
): TransportAdapter {
  return {
    id,
    capabilities,
    start() {},
    stop() {},
    async send(
      _address: ConversationAddress,
      _content: OutboundContent,
      _context: DeliveryContext,
    ): Promise<OutboundReceipt> {
      return { transport: id, messageId: "message" };
    },
  };
}

function core(onInbound: (message: InboundMessage, signal?: AbortSignal) => void | Promise<void> = async () => {}): GatewayCore {
  return new GatewayCore({
    identityResolver: () => SERVER_PRINCIPAL,
    onInbound,
  });
}

describe("GatewayCore", () => {
  test("rejects duplicate adapter IDs", () => {
    const gateway = core();
    gateway.register(adapter("telegram"));

    expect(() => gateway.register(adapter("telegram"))).toThrow(DuplicateTransportAdapterError);
  });

  test("rejects invalid inbound envelopes before resolving principals", async () => {
    let resolveCalls = 0;
    let handled = false;
    const gateway = new GatewayCore({
      identityResolver: () => {
        resolveCalls += 1;
        return SERVER_PRINCIPAL;
      },
      onInbound: async () => {
        handled = true;
      },
    });
    const valid = envelope("telegram");

    await expect(gateway.receive({ ...valid, id: "" })).rejects.toThrow(InvalidInboundEnvelopeIdError);
    await expect(gateway.receive({ ...valid, sentAt: -1 })).rejects.toThrow(InvalidInboundEnvelopeSentAtError);
    await expect(
      gateway.receive({ ...valid, identity: { ...valid.identity, transport: "slack" } }),
    ).rejects.toThrow(InboundIdentityAddressMismatchError);
    await expect(
      gateway.receive({ ...valid, identity: { ...valid.identity, account: "other-account" } }),
    ).rejects.toThrow(InboundIdentityAddressMismatchError);
    await expect(
      gateway.receive({ ...valid, replyTo: { transport: "slack", messageId: "parent" } }),
    ).rejects.toThrow(InboundReplyReceiptTransportMismatchError);

    expect(resolveCalls).toBe(0);
    expect(handled).toBe(false);
  });

  test("rejects unknown identities before invoking the inbound handler", async () => {
    const handled: Principal[] = [];
    const gateway = new GatewayCore({
      identityResolver: () => undefined,
      onInbound: async (message) => {
        handled.push(message.principal);
      },
    });

    await expect(gateway.receive(envelope("telegram"))).rejects.toThrow(UnknownTransportIdentityError);
    expect(handled).toEqual([]);
  });

  test("derives principals and forwards validated inbound metadata without accepting a client principal", async () => {
    let receive: ReceiveInbound | undefined;
    let received: InboundMessage | undefined;
    const gateway = core(async (message) => {
      received = message;
    });
    gateway.register({
      ...adapter("telegram"),
      start(context) {
        receive = context.receive;
      },
    });

    await gateway.start();
    const replyTo = { transport: "telegram", messageId: "parent" };
    const untrustedEnvelope = {
      ...envelope("telegram"),
      replyTo,
      edited: true,
      principal: { id: "forged", roles: ["admin"] },
    } as InboundEnvelope & { principal: Principal };
    await receive!(untrustedEnvelope);

    expect(received?.principal).toEqual(SERVER_PRINCIPAL);
    expect(received?.id).toBe(untrustedEnvelope.id);
    expect(received?.sentAt).toBe(untrustedEnvelope.sentAt);
    expect(received?.identity).toBe(untrustedEnvelope.identity);
    expect(received?.address).toBe(untrustedEnvelope.address);
    expect(received?.content).toBe(untrustedEnvelope.content);
    expect(received?.replyTo).toBe(replyTo);
    expect(received?.edited).toBe(true);
    await gateway.stop();
  });

  test("provides adapters the configured server-side identity resolver for asynchronous replies", async () => {
    const calls: Array<{ identity: { transport: string; account: string; subject: string }; signal?: AbortSignal }> = [];
    const resolver: ResolveTransportIdentity = async (identity, signal) => {
      calls.push({ identity, signal });
      return SERVER_PRINCIPAL;
    };
    let resolveIdentity: ResolveTransportIdentity | undefined;
    const gateway = new GatewayCore({
      identityResolver: resolver,
      onInbound: async () => {},
    });
    gateway.register({
      ...adapter("telegram"),
      start(context) {
        resolveIdentity = context.resolveIdentity;
      },
    });
    const controller = new AbortController();
    const identity = { transport: "telegram", account: "account", subject: "callback-subject" };

    await gateway.start();
    expect(resolveIdentity).toBe(resolver);
    await expect(resolveIdentity!(identity, controller.signal)).resolves.toBe(SERVER_PRINCIPAL);
    expect(calls).toEqual([{ identity, signal: controller.signal }]);
    await gateway.stop();
  });

  test("passes derived same-origin delivery context unchanged to the adapter", async () => {
    let receive: ReceiveInbound | undefined;
    let deliveredContext: DeliveryContext | undefined;
    let handlerContext: DeliveryContext | undefined;
    let gateway: GatewayCore;
    gateway = new GatewayCore({
      identityResolver: () => SERVER_PRINCIPAL,
      onInbound: async (message) => {
        const context: DeliveryContext = { principal: message.principal, origin: message.address };
        handlerContext = context;
        await gateway.send(message.address, { text: "reply" }, context);
      },
    });
    gateway.register({
      ...adapter("telegram"),
      start(context) {
        receive = context.receive;
      },
      async send(
        _address: ConversationAddress,
        _content: OutboundContent,
        context: DeliveryContext,
      ): Promise<OutboundReceipt> {
        deliveredContext = context;
        return { transport: "telegram", messageId: "reply" };
      },
    });

    await gateway.start();
    await receive!(envelope("telegram"));

    expect(deliveredContext).toBe(handlerContext);
    expect(deliveredContext).toEqual({
      principal: SERVER_PRINCIPAL,
      origin: address("telegram"),
    });
    await gateway.stop();
  });

  test("routes same-origin send, update, reactions, and UI to the address transport", async () => {
    const calls: string[] = [];
    const gateway = core();
    gateway.register({
      ...adapter("alpha"),
      async send(): Promise<OutboundReceipt> {
        throw new Error("alpha must not receive beta traffic");
      },
    });
    gateway.register({
      id: "beta",
      capabilities: FULL_CAPABILITIES,
      start() {},
      stop() {},
      async send(
        _address: ConversationAddress,
        _content: OutboundContent,
        _context: DeliveryContext,
      ): Promise<OutboundReceipt> {
        calls.push("send");
        return { transport: "beta", messageId: "message" };
      },
      async update(
        _address: ConversationAddress,
        receipt: OutboundReceipt,
        _content: OutboundContent,
        _context: DeliveryContext,
      ): Promise<OutboundReceipt> {
        calls.push("update");
        return receipt;
      },
      async react(
        _address: ConversationAddress,
        _receipt: OutboundReceipt,
        _reaction: { readonly emoji: string },
        _context: DeliveryContext,
      ): Promise<void> {
        calls.push("react");
      },
      async presentUi<Request extends UiRequest>(
        _address: ConversationAddress,
        request: Request,
        _context: DeliveryContext,
      ): Promise<UiResponseFor<Request>> {
        calls.push("ui");
        return { type: "confirm", confirmed: true } as UiResponseFor<Request>;
      },
    });

    const target = address("beta");
    const context = deliveryContext(target);
    const receipt = await gateway.send(target, { text: "hello" }, context);
    await gateway.update(target, receipt, { text: "updated" }, context);
    await gateway.react(target, receipt, { emoji: "👍" }, context);
    const response = await gateway.presentUi(
      target,
      { type: "confirm", title: "Confirm", message: "Proceed?" },
      context,
    );

    expect(receipt).toEqual({ transport: "beta", messageId: "message" });
    expect(response).toEqual({ type: "confirm", confirmed: true });
    expect(calls).toEqual(["send", "update", "react", "ui"]);
  });

  test("rejects every cross-origin delivery before calling adapters", async () => {
    const calls: string[] = [];
    const origin = address("telegram", { thread: "origin-thread" });
    const context = deliveryContext(origin);
    const receipt = { transport: "telegram", messageId: "message" };
    const gateway = core();
    gateway.register({
      id: "telegram",
      capabilities: FULL_CAPABILITIES,
      start() {},
      stop() {},
      async send(): Promise<OutboundReceipt> {
        calls.push("send");
        return receipt;
      },
      async update(): Promise<OutboundReceipt> {
        calls.push("update");
        return receipt;
      },
      async react(): Promise<void> {
        calls.push("react");
      },
      async presentUi<Request extends UiRequest>(): Promise<UiResponseFor<Request>> {
        calls.push("ui");
        return { type: "status", acknowledged: true } as UiResponseFor<Request>;
      },
    });

    const crossOriginAddresses = [
      { ...origin, account: "other-account" },
      { ...origin, channel: "other-channel" },
      { ...origin, thread: "other-thread" },
    ];
    for (const target of crossOriginAddresses) {
      await expect(gateway.send(target, { text: "send" }, context)).rejects.toThrow(CrossOriginDeliveryError);
      await expect(gateway.update(target, receipt, { text: "update" }, context)).rejects.toThrow(CrossOriginDeliveryError);
      await expect(gateway.react(target, receipt, { emoji: "👍" }, context)).rejects.toThrow(CrossOriginDeliveryError);
      await expect(gateway.presentUi(target, { type: "status", key: "state" }, context)).rejects.toThrow(
        CrossOriginDeliveryError,
      );
    }

    expect(calls).toEqual([]);
  });

  test("fails explicitly when a transport lacks update, reaction, or interactive UI capabilities", async () => {
    const calls: string[] = [];
    const gateway = core();
    gateway.register({
      id: "plain",
      capabilities: {
        ...FULL_CAPABILITIES,
        streamingUpdates: false,
        reactions: false,
        buttons: false,
      },
      start() {},
      stop() {},
      async send(
        _address: ConversationAddress,
        _content: OutboundContent,
        _context: DeliveryContext,
      ): Promise<OutboundReceipt> {
        return { transport: "plain", messageId: "message" };
      },
      async update(): Promise<OutboundReceipt> {
        calls.push("update");
        return { transport: "plain", messageId: "message" };
      },
      async react(): Promise<void> {
        calls.push("react");
      },
      async presentUi<Request extends UiRequest>(): Promise<UiResponseFor<Request>> {
        calls.push("ui");
        return { type: "confirm", confirmed: true } as UiResponseFor<Request>;
      },
    });
    const target = address("plain");
    const context = deliveryContext(target);
    const receipt = { transport: "plain", messageId: "message" };

    await expect(gateway.update(target, receipt, { text: "update" }, context)).rejects.toMatchObject<UnsupportedTransportCapabilityError>({
      capability: "streamingUpdates",
    });
    await expect(gateway.react(target, receipt, { emoji: "👍" }, context)).rejects.toMatchObject<UnsupportedTransportCapabilityError>({
      capability: "reactions",
    });
    await expect(
      gateway.presentUi(target, { type: "confirm", title: "Confirm", message: "Proceed?" }, context),
    ).rejects.toMatchObject<UnsupportedTransportCapabilityError>({ capability: "buttons" });
    expect(calls).toEqual([]);
  });

  test("presents display UI without interactive capabilities", async () => {
    let receivedRequest: UiRequest | undefined;
    const gateway = core();
    gateway.register({
      ...adapter("plain", { ...FULL_CAPABILITIES, buttons: false, textInput: false }),
      async presentUi<Request extends UiRequest>(
        _address: ConversationAddress,
        request: Request,
        _context: DeliveryContext,
      ): Promise<UiResponseFor<Request>> {
        receivedRequest = request;
        return { type: "status", acknowledged: true } as UiResponseFor<Request>;
      },
    });
    const target = address("plain");

    const response = await gateway.presentUi(target, { type: "status", key: "session", text: "ready" }, deliveryContext(target));

    expect(receivedRequest).toEqual({ type: "status", key: "session", text: "ready" });
    expect(response).toEqual({ type: "status", acknowledged: true });
  });

  test("rejects a receipt issued by another transport", async () => {
    let updated = false;
    const gateway = core();
    gateway.register({
      ...adapter("telegram"),
      async update(): Promise<OutboundReceipt> {
        updated = true;
        return { transport: "telegram", messageId: "message" };
      },
    });
    const target = address("telegram");

    await expect(
      gateway.update(target, { transport: "slack", messageId: "message" }, { text: "update" }, deliveryContext(target)),
    ).rejects.toThrow(ReceiptTransportMismatchError);
    expect(updated).toBe(false);
  });

  test("rejects reply receipts issued by another transport", async () => {
    let sent = false;
    const gateway = core();
    gateway.register({
      ...adapter("telegram"),
      async send(
        _address: ConversationAddress,
        _content: OutboundContent,
        _context: DeliveryContext,
      ): Promise<OutboundReceipt> {
        sent = true;
        return { transport: "telegram", messageId: "message" };
      },
    });
    const target = address("telegram");

    await expect(
      gateway.send(
        target,
        { text: "reply", replyTo: { transport: "slack", messageId: "parent" }, format: "markdown" },
        deliveryContext(target),
      ),
    ).rejects.toThrow(ReceiptTransportMismatchError);
    expect(sent).toBe(false);
  });

  test("stops successfully started adapters in reverse registration order", async () => {
    const events: string[] = [];
    const gateway = core();
    gateway.register({
      ...adapter("first"),
      async start(): Promise<void> {
        events.push("start:first");
      },
      async stop(): Promise<void> {
        events.push("stop:first");
      },
    });
    gateway.register({
      ...adapter("second"),
      async start(): Promise<void> {
        events.push("start:second");
      },
      async stop(): Promise<void> {
        events.push("stop:second");
      },
    });

    await gateway.start();
    await gateway.stop();

    expect(events).toEqual(["start:first", "start:second", "stop:second", "stop:first"]);
  });

  test("preserves abort signals for adapter start, inbound delivery, and outbound sends", async () => {
    let receive: ReceiveInbound | undefined;
    let startSignal: AbortSignal | undefined;
    let inboundSignal: AbortSignal | undefined;
    let outboundSignal: AbortSignal | undefined;
    const gateway = core(async (_message, signal) => {
      inboundSignal = signal;
    });
    gateway.register({
      ...adapter("telegram"),
      start(context) {
        receive = context.receive;
        startSignal = context.signal;
      },
      async send(
        _address: ConversationAddress,
        _content: OutboundContent,
        _context: DeliveryContext,
        signal?: AbortSignal,
      ): Promise<OutboundReceipt> {
        outboundSignal = signal;
        return { transport: "telegram", messageId: "message" };
      },
    });
    const startController = new AbortController();
    const inboundController = new AbortController();
    const outboundController = new AbortController();
    const target = address("telegram");

    await gateway.start(startController.signal);
    await receive!(envelope("telegram"), inboundController.signal);
    await gateway.send(target, { text: "hello" }, deliveryContext(target), outboundController.signal);

    expect(startSignal).toBe(startController.signal);
    expect(inboundSignal).toBe(inboundController.signal);
    expect(outboundSignal).toBe(outboundController.signal);
    await gateway.stop();
  });
});
