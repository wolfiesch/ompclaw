import { beforeEach, describe, expect, test } from "bun:test";
import { parseGatewayConfig } from "./gateway-config";
import { GatewayQuickLane } from "./gateway-quicklane";
import type { InboundMessage, UiRequest, UiResponseFor } from "./gateway-types";
import type { GatewayDelivery } from "./gateway-tools";
import type { OmpRpcClientOptions, RpcClient, RpcCommandInput, RpcFrameListener } from "./rpc-client";
import type { RpcRecord, RpcResponse } from "./rpc-protocol";

class FakeRpcClient implements RpcClient {
  static instances: FakeRpcClient[] = [];
  readonly options: OmpRpcClientOptions;
  readonly sent: RpcCommandInput[] = [];
  running = false;
  stopped = false;
  #frameListener: RpcFrameListener | undefined;
  #exitListener: ((error: Error) => void | Promise<void>) | undefined;

  constructor(options: OmpRpcClientOptions) {
    this.options = options;
    FakeRpcClient.instances.push(this);
  }

  onFrame(listener: RpcFrameListener): () => void {
    this.#frameListener = listener;
    return () => {
      this.#frameListener = undefined;
    };
  }

  onExit(listener: (error: Error) => void | Promise<void>): () => void {
    this.#exitListener = listener;
    return () => {
      this.#exitListener = undefined;
    };
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
  }

  async send(command: RpcCommandInput): Promise<RpcResponse> {
    this.sent.push(command);
    if (command.type === "get_state") {
      return {
        type: "response",
        command: command.type,
        success: true,
        data: { sessionId: "quick", isStreaming: false, isCompacting: false },
      };
    }
    return { type: "response", command: command.type, success: true, data: { agentInvoked: true } };
  }

  write(): void {}

  async emit(frame: RpcRecord): Promise<void> {
    await this.#frameListener?.(frame);
  }

  async exit(error: Error): Promise<void> {
    await this.#exitListener?.(error);
  }
}

interface DeliveryCall {
  readonly text?: string;
  readonly request?: UiRequest;
}

let calls: DeliveryCall[];

function delivery(): GatewayDelivery {
  return {
    async send(_address, content) {
      calls.push({ text: content.text });
      return { transport: "telegram", messageId: String(calls.length) };
    },
    async update(_address, receipt) {
      return receipt;
    },
    async finalize(_address, receipt) {
      return receipt === undefined ? [] : [receipt];
    },
    async react() {},
    async presentUi<Request extends UiRequest>(
      _address: InboundMessage["address"],
      request: Request,
    ): Promise<UiResponseFor<Request>> {
      calls.push({ request });
      return { type: request.type, acknowledged: true } as UiResponseFor<Request>;
    },
  };
}

function message(id: string, text: string): InboundMessage {
  return {
    id,
    sentAt: 1_700_000_000_000,
    identity: { transport: "telegram", account: "bot", subject: "42" },
    address: { transport: "telegram", account: "bot", channel: "42" },
    principal: { id: "operator", roles: ["operator"] },
    content: { text },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition was not met");
}

function quickLane(enabled = true): GatewayQuickLane {
  return new GatewayQuickLane({
    config: parseGatewayConfig({ quickLane: { enabled } }, "/workspace"),
    delivery: delivery(),
    createRpcClient: (options) => new FakeRpcClient(options),
  });
}

beforeEach(() => {
  FakeRpcClient.instances = [];
  calls = [];
});

describe("GatewayQuickLane", () => {
  test("starts lazily for an explicit quick request and delivers a separate answer", async () => {
    const lane = quickLane();
    const inbound = message("quick-1", "/quick What is 2 + 2?");
    const route = lane.routeFor(inbound);
    if (route?.kind !== "query") throw new Error("expected quick query route");

    const handled = lane.handle(inbound, route);
    await waitFor(() => FakeRpcClient.instances.length === 1);
    const rpc = FakeRpcClient.instances[0]!;
    await waitFor(() => rpc.sent.filter((command) => command.type === "prompt").length === 1);
    await rpc.emit({ type: "agent_end", messages: [{ role: "assistant", content: "Four." }] });
    await handled;

    expect(calls).toEqual([{ text: "⚡ Four." }]);
    expect(rpc.options.argv).toContain("ompclaw.quick");
  });

  test("processes queued quick requests in FIFO order", async () => {
    const lane = quickLane();
    const first = message("quick-1", "/quick first");
    const second = message("quick-2", "/quick second");
    const firstRoute = lane.routeFor(first);
    const secondRoute = lane.routeFor(second);
    if (firstRoute?.kind !== "query" || secondRoute?.kind !== "query") throw new Error("expected quick query routes");

    const firstHandled = lane.handle(first, firstRoute);
    const secondHandled = lane.handle(second, secondRoute);
    await waitFor(() => FakeRpcClient.instances.length === 1);
    const rpc = FakeRpcClient.instances[0]!;
    await waitFor(() => rpc.sent.filter((command) => command.type === "prompt").length === 1);
    await rpc.emit({ type: "agent_end", messages: [{ role: "assistant", content: "first answer" }] });
    await waitFor(() => rpc.sent.filter((command) => command.type === "prompt").length === 2);
    await rpc.emit({ type: "agent_end", messages: [{ role: "assistant", content: "second answer" }] });
    await Promise.all([firstHandled, secondHandled]);

    expect(calls).toEqual([{ text: "⚡ first answer" }, { text: "⚡ second answer" }]);
  });

  test("arms one plain-text quick question and clears the busy-card state", async () => {
    const lane = quickLane();
    const arm = message("arm", "/quick-arm");
    const armRoute = lane.routeFor(arm);
    if (armRoute?.kind !== "arm") throw new Error("expected arm route");
    await lane.handle(arm, armRoute);
    const question = message("question", "unrelated question");
    const questionRoute = lane.routeFor(question);
    if (questionRoute?.kind !== "query") throw new Error("expected armed query route");

    const handled = lane.handle(question, questionRoute);
    await waitFor(() => FakeRpcClient.instances.length === 1);
    const rpc = FakeRpcClient.instances[0]!;
    await waitFor(() => rpc.sent.filter((command) => command.type === "prompt").length === 1);
    await rpc.emit({ type: "agent_end", messages: [{ role: "assistant", content: "answer" }] });
    await handled;

    expect(calls[0]?.request).toMatchObject({
      type: "status",
      key: "quick-ask",
      text: "⚡ Quick ask armed — send your question",
    });
    expect(calls[1]?.request).toMatchObject({ type: "status", key: "quick-ask" });
    expect(calls[2]).toEqual({ text: "⚡ answer" });
  });

  test("does not start a child while disabled", async () => {
    const lane = quickLane(false);
    const inbound = message("disabled", "/quick answer this");
    const route = lane.routeFor(inbound);
    if (route?.kind !== "disabled") throw new Error("expected disabled route");
    await lane.handle(inbound, route);

    expect(FakeRpcClient.instances).toHaveLength(0);
    expect(calls).toEqual([{ text: "⚡ Quick ask is disabled." }]);
  });

  test("stops the lazy child during gateway shutdown", async () => {
    const lane = quickLane();
    const inbound = message("stop", "/quick answer this");
    const route = lane.routeFor(inbound);
    if (route?.kind !== "query") throw new Error("expected quick route");
    const handled = lane.handle(inbound, route);
    await waitFor(() => FakeRpcClient.instances.length === 1);
    const rpc = FakeRpcClient.instances[0]!;
    await waitFor(() => rpc.sent.filter((command) => command.type === "prompt").length === 1);
    await lane.stop();
    await expect(handled).rejects.toThrow("Quick OMP session stopped");
    expect(rpc.stopped).toBe(true);
  });
});
