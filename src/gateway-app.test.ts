import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  GatewayApplication,
  type GatewayApplicationStore,
  type GatewayCoreRuntime,
  type GatewayRuntime,
  type GatewaySchedulerRuntime,
} from "./gateway-app";
import { parseGatewayConfig, type GatewayConfig } from "./gateway-config";
import type { GatewayCoreOptions } from "./gateway-core";
import { GatewayStore, type ConversationBinding, type JsonValue } from "./gateway-store";
import type { InboundMessage, Principal, TransportAdapter, TransportIdentity } from "./gateway-types";
import type { RpcGatewayRuntimeOptions } from "./rpc-runtime";
import { identityBind, migrateTelegram, principalAdd, telegramAllow } from "./rpc-cli";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function gatewayConfig(): GatewayConfig {
  const stateDir = mkdtempSync(join(tmpdir(), "ompclaw-app-"));
  directories.push(stateDir);
  return parseGatewayConfig({
    workspace: "/workspace/gateway",
    stateDir,
    transports: {
      telegram: { enabled: true, account: "bot", tokenEnv: "TELEGRAM_BOT_TOKEN" },
      websocket: {
        enabled: true,
        hostname: "127.0.0.1",
        port: 0,
        account: "web",
        credentials: [{ tokenEnv: "OMPCLAW_TEST_TOKEN", subject: "web-user", channel: "web-user" }],
      },
    },
  });
}

function adapter(id: string): TransportAdapter {
  return {
    id,
    capabilities: {
      streamingUpdates: true,
      buttons: true,
      multiSelect: true,
      textInput: true,
      attachments: true,
      reactions: true,
      threads: true,
      maxMessageLength: 4_096,
    },
    start() {},
    stop() {},
    async send() {
      return { transport: id, messageId: "outbound" };
    },
  };
}

function inbound(id: string): InboundMessage {
  return {
    id,
    sentAt: 1,
    identity: { transport: "telegram", account: "bot", subject: "42" },
    address: { transport: "telegram", account: "bot", channel: "42" },
    content: { text: "hello" },
    principal: { id: "operator", roles: ["operator"] },
  };
}

class MemoryStore implements GatewayApplicationStore {
  readonly claims = new Set<string>();
  readonly checkpoint = new Map<string, JsonValue>();
  readonly bindings: ConversationBinding[] = [];
  readonly releases: string[] = [];
  closed = false;

  close() {
    this.closed = true;
  }

  resolvePrincipal(identity: TransportIdentity): Principal | undefined {
    return identity.subject === "42" ? { id: "operator", roles: ["operator"] } : undefined;
  }

  getCheckpoint(adapterName: string, key: string) {
    return this.checkpoint.get(`${adapterName}/${key}`);
  }

  setCheckpoint(adapterName: string, key: string, value: JsonValue) {
    this.checkpoint.set(`${adapterName}/${key}`, value);
  }

  claimInboundMessage(transport: string, account: string, messageId: string) {
    const key = `${transport}/${account}/${messageId}`;
    if (this.claims.has(key)) return false;
    this.claims.add(key);
    return true;
  }

  releaseInboundMessage(transport: string, account: string, messageId: string) {
    const key = `${transport}/${account}/${messageId}`;
    this.releases.push(key);
    return this.claims.delete(key);
  }

  bindConversation(binding: ConversationBinding) {
    this.bindings.push(binding);
  }

  getConversationBinding(address: InboundMessage["address"]) {
    return this.bindings.findLast((binding) =>
      binding.address.transport === address.transport &&
      binding.address.account === address.account &&
      binding.address.channel === address.channel &&
      binding.address.thread === address.thread
    );
  }

  hasConversationBindingForSession(sessionPath: string) {
    return this.bindings.some((binding) => binding.ompSessionPath === sessionPath);
  }

  putPendingInteraction() {}

  deletePendingInteraction() {
    return false;
  }
}

function coreHarness(events: string[]) {
  let options: GatewayCoreOptions | undefined;
  const registered: string[] = [];
  const core: GatewayCoreRuntime = {
    register(value) {
      registered.push(value.id);
    },
    async start() {
      events.push("core-start");
    },
    async stop() {
      events.push("core-stop");
    },
    async send(address) {
      return { transport: address.transport, messageId: "outbound" };
    },
    async update(_address, receipt) {
      return receipt;
    },
    async react() {},
    async presentUi() {
      throw new Error("not used");
    },
  };
  return {
    core,
    registered,
    create(optionsValue: GatewayCoreOptions) {
      options = optionsValue;
      return core;
    },
    options() {
      if (options === undefined) throw new Error("core was not created");
      return options;
    },
  };
}

describe("GatewayApplication", () => {
  test("starts runtime before core, registers each enabled transport, and stops in reverse", async () => {
    const events: string[] = [];
    const store = new MemoryStore();
    const core = coreHarness(events);
    const runtime: GatewayRuntime = {
      async start() {
        events.push("runtime-start");
      },
      async stop() {
        events.push("runtime-stop");
      },
      async handleInbound() {},
    };
    const app = new GatewayApplication({
      config: gatewayConfig(),
      secrets: { telegramToken: "telegram", webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }] },
      seams: {
        createStore: () => store,
        createCore: core.create,
        createRuntime: () => runtime,
        createTelegramAdapter: () => adapter("telegram"),
        createWebSocketAdapter: () => adapter("websocket"),
        acquireLock: () => {
          events.push("lock");
          return { ok: true };
        },
        startLockHeartbeat: () => {
          events.push("heartbeat");
          return () => events.push("heartbeat-stop");
        },
        releaseLock: () => events.push("unlock"),
      },
    });

    await app.start();
    expect(events).toEqual(["lock", "heartbeat", "runtime-start", "core-start"]);
    expect(core.registered).toEqual(["telegram", "websocket"]);
    expect(app.status()).toMatchObject({ state: "started", adapters: ["telegram", "websocket"] });

    await app.stop();
    await app.stop();
    expect(events).toEqual(["lock", "heartbeat", "runtime-start", "core-start", "core-stop", "runtime-stop", "heartbeat-stop", "unlock"]);
    expect(store.closed).toBe(true);
  });

  test("refuses a second process before opening its database", async () => {
    let createdStore = false;
    const app = new GatewayApplication({
      config: gatewayConfig(),
      secrets: { telegramToken: "telegram", webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }] },
      seams: {
        createStore: () => {
          createdStore = true;
          return new MemoryStore();
        },
        acquireLock: () => ({ ok: false, holder: 999 }),
      },
    });

    await expect(app.start()).rejects.toThrow("already running");
    expect(createdStore).toBe(false);
    expect(app.status().state).toBe("idle");
  });

  test("derives identity only through the store and checkpoints/binds a successful inbound turn", async () => {
    const events: string[] = [];
    const store = new MemoryStore();
    const core = coreHarness(events);
    let runtimeOptions: RpcGatewayRuntimeOptions | undefined;
    const app = new GatewayApplication({
      config: gatewayConfig(),
      secrets: { telegramToken: "telegram", webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }] },
      seams: {
        createStore: () => store,
        createCore: core.create,
        createRuntime: (options) => {
          runtimeOptions = options;
          return {
            async start() {
              options.onSessionState?.({ isStreaming: false, isCompacting: false, sessionId: "one", sessionFile: "/sessions/one" });
            },
            async stop() {},
            async handleInbound() {},
          };
        },
        createTelegramAdapter: () => adapter("telegram"),
        createWebSocketAdapter: () => adapter("websocket"),
        acquireLock: () => ({ ok: true }),
        startLockHeartbeat: () => () => {},
        releaseLock: () => {},
        now: () => 42,
      },
    });

    await app.start();
    expect(await core.options().identityResolver({ transport: "telegram", account: "bot", subject: "42" })).toEqual({ id: "operator", roles: ["operator"] });
    await core.options().onInbound(inbound("message-1"));

    expect(runtimeOptions?.sessionFile).toBeUndefined();
    expect(store.checkpoint.get("omp/session_file")).toBe("/sessions/one");
    expect(store.bindings).toEqual([{
      address: { transport: "telegram", account: "bot", channel: "42" },
      ompSessionPath: "/sessions/one",
      workspace: "/workspace/gateway",
    }]);
    await app.stop();
  });

  test("isolates topic sessions and switches the single RPC owner before each turn", async () => {
    const events: string[] = [];
    const store = new MemoryStore();
    const core = coreHarness(events);
    const config = parseGatewayConfig({
      workspace: "/workspace/gateway",
      stateDir: gatewayConfig().stateDir,
      transports: {
        telegram: {
          enabled: true,
          account: "bot",
          tokenEnv: "TELEGRAM_BOT_TOKEN",
          topicSessions: { enabled: true, createFromRoot: true },
        },
      },
    });
    let currentSession = "/sessions/root";
    let nextSession = 0;
    const handled: Array<{ readonly id: string; readonly session: string }> = [];
    const created: string[] = [];
    const switched: string[] = [];
    const firstTopicStarted = Promise.withResolvers<void>();
    const finishFirstTopic = Promise.withResolvers<void>();
    const app = new GatewayApplication({
      config,
      secrets: { telegramToken: "telegram", webSocketCredentials: [] },
      seams: {
        createStore: () => store,
        createCore: core.create,
        createRuntime: (options) => ({
          async start() {
            options.onSessionState?.({ isStreaming: false, isCompacting: false, sessionId: "root", sessionFile: currentSession });
          },
          async stop() {},
          async handleInbound(message) {
            handled.push({ id: message.id, session: currentSession });
            if (message.id === "topic-9-first") {
              firstTopicStarted.resolve();
              await finishFirstTopic.promise;
            }
          },
          async newSession(name) {
            created.push(name ?? "");
            currentSession = `/sessions/topic-${++nextSession}`;
            options.onSessionState?.({
              isStreaming: false,
              isCompacting: false,
              sessionId: `topic-${nextSession}`,
              sessionFile: currentSession,
            });
            return true;
          },
          async switchSession(sessionPath) {
            switched.push(sessionPath);
            currentSession = sessionPath;
            options.onSessionState?.({
              isStreaming: false,
              isCompacting: false,
              sessionId: sessionPath,
              sessionFile: sessionPath,
            });
            return true;
          },
          isBusy: () => false,
        }),
        createTelegramAdapter: () => adapter("telegram"),
        acquireLock: () => ({ ok: true }),
        startLockHeartbeat: () => () => {},
        releaseLock: () => {},
      },
    });
    const topicMessage = (id: string, thread: string, text: string): InboundMessage => ({
      ...inbound(id),
      address: { transport: "telegram", account: "bot", channel: "-1001", thread },
      content: { text },
    });

    await app.start();
    await core.options().onInbound(inbound("root-first"));
    const firstTopic = core.options().onInbound(topicMessage("topic-9-first", "9", "First topic request"));
    await firstTopicStarted.promise;
    const secondTopic = core.options().onInbound(topicMessage("topic-10-first", "10", "Second topic request"));
    await Promise.resolve();
    expect(created).toEqual(["First topic request"]);
    finishFirstTopic.resolve();
    await Promise.all([firstTopic, secondTopic]);
    await core.options().onInbound(topicMessage("topic-9-again", "9", "Continue the first topic"));
    await core.options().onInbound(inbound("root-again"));

    expect(switched).toEqual(["/sessions/topic-1", "/sessions/root"]);
    expect(handled).toEqual([
      { id: "root-first", session: "/sessions/root" },
      { id: "topic-9-first", session: "/sessions/topic-1" },
      { id: "topic-10-first", session: "/sessions/topic-2" },
      { id: "topic-9-again", session: "/sessions/topic-1" },
      { id: "root-again", session: "/sessions/root" },
    ]);
    expect(store.getConversationBinding(topicMessage("ignored", "9", "ignored").address)?.ompSessionPath).toBe("/sessions/topic-1");
    expect(store.getConversationBinding(topicMessage("ignored", "10", "ignored").address)?.ompSessionPath).toBe("/sessions/topic-2");
    await app.stop();
  });

  test("releases only a failed inbound claim so its exact id can be retried", async () => {
    const store = new MemoryStore();
    const core = coreHarness([]);
    let attempts = 0;
    const app = new GatewayApplication({
      config: gatewayConfig(),
      secrets: { telegramToken: "telegram", webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }] },
      seams: {
        createStore: () => store,
        createCore: core.create,
        createRuntime: (options) => ({
          async start() {
            options.onSessionState?.({ isStreaming: false, isCompacting: false, sessionId: "one", sessionFile: "/sessions/one" });
          },
          async stop() {},
          async handleInbound() {
            attempts += 1;
            if (attempts === 1) throw new Error("temporary OMP failure");
          },
        }),
        createTelegramAdapter: () => adapter("telegram"),
        createWebSocketAdapter: () => adapter("websocket"),
        acquireLock: () => ({ ok: true }),
        startLockHeartbeat: () => () => {},
        releaseLock: () => {},
      },
    });

    await app.start();
    await expect(core.options().onInbound(inbound("retry-me"))).rejects.toThrow("temporary OMP failure");
    expect(store.releases).toEqual(["telegram/bot/retry-me"]);
    expect(store.bindings).toEqual([]);
    await core.options().onInbound(inbound("retry-me"));
    expect(attempts).toBe(2);
    expect(store.bindings).toHaveLength(1);
    await app.stop();
  });

  test("rolls back started resources in reverse when core startup fails", async () => {
    const events: string[] = [];
    const store = new MemoryStore();
    const core = coreHarness(events);
    core.core.start = async () => {
      events.push("core-start");
      throw new Error("adapter failed");
    };
    const app = new GatewayApplication({
      config: gatewayConfig(),
      secrets: { telegramToken: "telegram", webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }] },
      seams: {
        createStore: () => store,
        createCore: core.create,
        createRuntime: () => ({ async start() { events.push("runtime-start"); }, async stop() { events.push("runtime-stop"); }, async handleInbound() {} }),
        createTelegramAdapter: () => adapter("telegram"),
        createWebSocketAdapter: () => adapter("websocket"),
        acquireLock: () => {
          events.push("lock");
          return { ok: true };
        },
        startLockHeartbeat: () => {
          events.push("heartbeat");
          return () => events.push("heartbeat-stop");
        },
        releaseLock: () => events.push("unlock"),
      },
    });

    await expect(app.start()).rejects.toThrow("adapter failed");
    expect(events).toEqual(["lock", "heartbeat", "runtime-start", "core-start", "core-stop", "runtime-stop", "heartbeat-stop", "unlock"]);
    expect(store.closed).toBe(true);
  });

  test("wires enabled automation into RPC and brackets it around transport availability", async () => {
    const events: string[] = [];
    const base = gatewayConfig();
    const config: GatewayConfig = {
      ...base,
      automation: { enabled: true, pollIntervalMs: 1_000, retryDelayMs: 15_000, maxAttempts: 3 },
    };
    const core = coreHarness(events);
    const scheduler: GatewaySchedulerRuntime = {
      start() {
        events.push("scheduler-start");
      },
      stop() {
        events.push("scheduler-stop");
      },
      create() {
        throw new Error("not used");
      },
      update() {
        throw new Error("not used");
      },
      remove() {
        return false;
      },
      setEnabled() {
        throw new Error("not used");
      },
      runNow() {
        throw new Error("not used");
      },
      list() {
        return [];
      },
    };
    let runtimeOptions: RpcGatewayRuntimeOptions | undefined;
    const app = new GatewayApplication({
      config,
      secrets: { telegramToken: "telegram", webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }] },
      seams: {
        createCore: core.create,
        createScheduler: () => scheduler,
        createRuntime: (options) => {
          runtimeOptions = options;
          return {
            async start() { events.push("runtime-start"); },
            async stop() { events.push("runtime-stop"); },
            async handleInbound() {},
          };
        },
        createTelegramAdapter: () => adapter("telegram"),
        createWebSocketAdapter: () => adapter("websocket"),
        acquireLock: () => ({ ok: true }),
        startLockHeartbeat: () => () => {},
        releaseLock: () => {},
      },
    });

    await app.start();
    expect(runtimeOptions?.automation).toBe(scheduler);
    expect(events).toEqual(["runtime-start", "core-start", "scheduler-start"]);
    await app.stop();
    expect(events).toEqual(["runtime-start", "core-start", "scheduler-start", "scheduler-stop", "core-stop", "runtime-stop"]);
  });

  test("exposes strictly validated SQLite management helpers", () => {
    const config = gatewayConfig();
    principalAdd(config, ["principal-a", "operator"]);
    identityBind(config, ["websocket", "web", "subject-a", "principal-a"]);
    expect(telegramAllow(config, ["12345"])).toBe("telegram:bot:12345");

    const accessPath = join(config.stateDir, "access.json");
    const rpcStatePath = join(config.stateDir, "rpc-state.json");
    writeFileSync(accessPath, JSON.stringify({ allowFrom: ["999"] }));
    writeFileSync(rpcStatePath, JSON.stringify({ sessionFile: "/sessions/legacy", lastUpdateId: 7 }));
    expect(migrateTelegram(config, [accessPath, rpcStatePath]).imported).toBe(true);

    const store = new GatewayStore(join(config.stateDir, "ompclaw.sqlite"));
    try {
      expect(store.resolvePrincipal({ transport: "websocket", account: "web", subject: "subject-a" })?.id).toBe("principal-a");
      expect(store.resolvePrincipal({ transport: "telegram", account: "bot", subject: "12345" })?.id).toBe("telegram:bot:12345");
      expect(store.getCheckpoint("telegram", "update_id")).toBe("7");
    } finally {
      store.close();
    }
  });
});
