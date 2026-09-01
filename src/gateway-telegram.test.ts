import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayApplication, type GatewayRuntime } from "./gateway-app";
import { parseGatewayConfig } from "./gateway-config";
import { GatewayPairingService } from "./gateway-pairing";
import { GatewayStore } from "./gateway-store";
import type { InboundMessage } from "./gateway-types";
import type { RpcGatewayRuntimeOptions } from "./rpc-runtime";
import { TelegramTransportAdapter } from "./transports/telegram/adapter";
import { FakeTelegramApi, TELEGRAM_TEST_OWNER, telegramTestMessage } from "./transports/telegram/test-harness";

const scratch: string[] = [];
const telegramIdentity = { transport: "telegram", account: "primary", subject: "42" } as const;

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class ScenarioStore extends GatewayStore {
  constructor(
    path: string,
    readonly completedInbound: () => void,
  ) {
    super(path);
  }

  override completeInboundMessage(transport: string, account: string, messageId: string): boolean {
    const completed = super.completeInboundMessage(transport, account, messageId);
    if (completed) this.completedInbound();
    return completed;
  }
}

interface GatewayTelegramScenario {
  readonly app: GatewayApplication;
  readonly api: FakeTelegramApi;
  readonly adapter: TelegramTransportAdapter;
  readonly handled: InboundMessage[];
  readonly handledTurn: Promise<void>;
  readonly store: ScenarioStore;
}

async function scenario(authorized = true): Promise<GatewayTelegramScenario> {
  const stateDir = await mkdtemp(join(tmpdir(), "ompclaw-gateway-telegram-"));
  scratch.push(stateDir);
  const config = parseGatewayConfig({
    workspace: stateDir,
    stateDir,
    transports: {
      telegram: {
        enabled: true,
        account: "primary",
        tokenEnv: "TELEGRAM_BOT_TOKEN",
      },
    },
  });
  const api = new FakeTelegramApi();
  const handled: InboundMessage[] = [];
  const inboundCompleted = Promise.withResolvers<void>();
  let adapter: TelegramTransportAdapter | undefined;
  let store: ScenarioStore | undefined;

  const app = new GatewayApplication({
    config,
    secrets: { telegramToken: "test-token", webSocketCredentials: [] },
    seams: {
      ingressComposer: { debounceMs: 1, mediaDebounceMs: 1, maxWaitMs: 1 },
      createStore: (path) => {
        store = new ScenarioStore(path, inboundCompleted.resolve);
        if (authorized) {
          store.upsertPrincipal(TELEGRAM_TEST_OWNER);
          store.bindIdentity(telegramIdentity, TELEGRAM_TEST_OWNER.id);
        }
        return store;
      },
      createTelegramAdapter: (options) => {
        adapter = new TelegramTransportAdapter({ ...options, api: api.seams });
        return adapter;
      },
      createRuntime: (options: RpcGatewayRuntimeOptions): GatewayRuntime => ({
        async start() {
          options.onSessionState?.({
            isStreaming: false,
            isCompacting: false,
            sessionId: "telegram-harness",
            sessionFile: "/sessions/telegram-harness.jsonl",
          });
        },
        async stop() { },
        canHandleInboundImmediately: () => true,
        async handleInbound(message) {
          handled.push(message);
          const context = { principal: message.principal, origin: message.address };
          const receipt = await options.delivery.send(message.address, { text: "Working", format: "text" }, context);
          await options.delivery.update(
            message.address,
            receipt,
            { text: `Done: ${message.content.text}`, format: "text" },
            context,
          );
        },
      }),
      acquireLock: () => ({ ok: true }),
      releaseLock: () => { },
      startLockHeartbeat: () => () => { },
      now: Date.now,
    },
  });
  await app.start();
  if (!adapter || !store) throw new Error("gateway Telegram harness did not initialize");
  return { app, api, adapter, handled, handledTurn: inboundCompleted.promise, store };
}

describe("Gateway Telegram scenario harness", () => {
  test("round-trips an authenticated update through the real adapter, core, store, and delivery path", async () => {
    const harness = await scenario();
    await harness.adapter.handleUpdate({ update_id: 50, message: telegramTestMessage({ text: "ship it" }) });
    await harness.handledTurn;

    expect(harness.handled).toEqual([
      expect.objectContaining({
        id: "telegram:primary:42:10",
        identity: telegramIdentity,
        principal: TELEGRAM_TEST_OWNER,
        content: { text: "ship it" },
      }),
    ]);
    expect(harness.api.calls.filter(({ method }) => method === "sendMessage" || method === "editMessageText")).toEqual([
      {
        method: "sendMessage",
        payload: expect.objectContaining({ chat_id: "42", text: "Working" }),
      },
      {
        method: "editMessageText",
        payload: expect.objectContaining({ chat_id: "42", text: "Done: ship it" }),
      },
    ]);
    expect(harness.store.getCheckpoint("telegram", "update_id:primary")).toBe(50);
    expect(harness.store.listPendingInboundMessages()).toEqual([]);
    expect(harness.store.getConversationBinding(harness.handled[0]!.address)?.ompSessionPath).toBe(
      "/sessions/telegram-harness.jsonl",
    );
    await harness.app.stop();
  });

  test("pairs an unbound private sender locally before dispatching the next message", async () => {
    const harness = await scenario(false);
    await harness.adapter.handleUpdate({ update_id: 51, message: telegramTestMessage({ text: "first task" }) });

    expect(harness.handled).toEqual([]);
    const challenge = harness.api.calls.findLast(({ method }) => method === "sendMessage");
    const code = /Pairing code: ([A-Z0-9]+)/.exec(String(challenge?.payload.text))[1];
    expect(code).toHaveLength(8);

    expect(new GatewayPairingService(harness.store).approve(code, undefined, 1_800_000_000_001)).toEqual(
      expect.objectContaining({ state: "approved", identity: telegramIdentity }),
    );
    await harness.api.flushPairingApprovals();
    expect(harness.api.last("sendMessage").payload.text).toBe("Paired. Send your first task.");

    await harness.adapter.handleUpdate({ update_id: 52, message: telegramTestMessage({ text: "second task" }) });
    await harness.handledTurn;
    expect(harness.handled).toEqual([
      expect.objectContaining({
        identity: telegramIdentity,
        principal: expect.objectContaining({ roles: ["operator"] }),
        content: { text: "second task" },
      }),
    ]);
    expect(harness.store.getCheckpoint("telegram", "update_id:primary")).toBe(52);
    await harness.app.stop();
  });
});
