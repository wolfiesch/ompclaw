import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  GatewayApplication,
  type GatewayApplicationStore,
  type GatewayCoreRuntime,
  type GatewayRuntime,
  type GatewaySchedulerRuntime,
} from "./gateway-app";
import { parseGatewayConfig, type GatewayConfig } from "./gateway-config";
import type { GatewayCoreOptions } from "./gateway-core";
import {
  GatewayStore,
  type AppendIngressFragmentInput,
  type ConversationBinding,
  type IngressCompositionRecord,
  type JsonValue,
  type ScheduledJob,
} from "./gateway-store";
import type {
  ConversationAddress,
  InboundMessage,
  Principal,
  TransportAdapter,
  TransportIdentity,
} from "./gateway-types";
import type { RpcGatewayRuntimeOptions } from "./rpc-runtime";
import { identityBind, migrateTelegram, principalAdd, telegramAllow } from "./rpc-cli";

const directories: string[] = [];
const FAST_INGRESS = { debounceMs: 1, mediaDebounceMs: 1, maxWaitMs: 1 } as const;

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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition was not met");
}

interface MemoryIngressComposition {
  readonly id: string;
  readonly groupKey: string;
  readonly address: InboundMessage["address"];
  readonly principalId: string;
  readonly createdAt: number;
  updatedAt: number;
  flushAt: number;
  readonly deadlineAt: number;
  readonly fragments: Array<{ readonly message: InboundMessage; readonly sortOrder: number }>;
}

class MemoryStore implements GatewayApplicationStore {
  readonly claims = new Set<string>();
  readonly pending = new Map<
    string,
    { readonly message: InboundMessage; readonly receivedAt: number; readonly scheduled: boolean }
  >();
  readonly checkpoint = new Map<string, JsonValue>();
  readonly bindings: ConversationBinding[] = [];
  readonly releases: string[] = [];
  readonly migrations = new Set<string>();
  readonly ingressCompositions = new Map<string, MemoryIngressComposition>();
  readonly updateCheckpointMigrations: string[] = [];
  closed = false;
  failBindings = 0;
  resolvedPrincipal: Principal | undefined = { id: "operator", roles: ["operator"] };

  close() {
    this.closed = true;
  }
  resolvePrincipal(identity: TransportIdentity): Principal | undefined {
    return identity.subject === "42" || identity.subject === "web-user" ? this.resolvedPrincipal : undefined;
  }

  getCheckpoint(adapterName: string, key: string) {
    return this.checkpoint.get(`${adapterName}/${key}`);
  }

  setCheckpoint(adapterName: string, key: string, value: JsonValue) {
    this.checkpoint.set(`${adapterName}/${key}`, value);
  }

  claimInboundMessage(message: InboundMessage, receivedAt: number, scheduled = false) {
    const key = `${message.address.transport}/${message.address.account}/${message.id}`;
    if (this.claims.has(key)) return false;
    this.claims.add(key);
    this.pending.set(key, { message, receivedAt, scheduled });
    return true;
  }

  completeInboundMessage(transport: string, account: string, messageId: string) {
    return this.pending.delete(`${transport}/${account}/${messageId}`);
  }

  listPendingInboundMessages() {
    return [...this.pending.values()];
  }

  releaseInboundMessage(transport: string, account: string, messageId: string) {
    const key = `${transport}/${account}/${messageId}`;
    this.releases.push(key);
    this.pending.delete(key);
    return this.claims.delete(key);
  }

  appendIngressFragment(input: AppendIngressFragmentInput): IngressCompositionRecord {
    let composition = [...this.ingressCompositions.values()].find(({ groupKey }) => groupKey === input.groupKey);
    if (composition === undefined) {
      composition = {
        id: input.compositionId,
        groupKey: input.groupKey,
        address: input.message.address,
        principalId: input.message.principal.id,
        createdAt: input.receivedAt,
        updatedAt: input.receivedAt,
        flushAt: Math.min(input.flushAt, input.deadlineAt),
        deadlineAt: input.deadlineAt,
        fragments: [],
      };
      this.ingressCompositions.set(composition.id, composition);
    }
    const index = composition.fragments.findIndex(({ message }) => message.id === input.message.id);
    if (index < 0) composition.fragments.push({ message: input.message, sortOrder: input.sortOrder });
    else if (input.message.edited)
      composition.fragments[index] = { message: input.message, sortOrder: input.sortOrder };
    composition.updatedAt = input.receivedAt;
    composition.flushAt = Math.min(input.flushAt, composition.deadlineAt);
    return this.#ingressRecord(composition);
  }
  getIngressComposition(id: string): IngressCompositionRecord | undefined {
    const composition = this.ingressCompositions.get(id);
    return composition === undefined ? undefined : this.#ingressRecord(composition);
  }

  getIngressCompositionByGroupKey(groupKey: string): IngressCompositionRecord | undefined {
    const composition = [...this.ingressCompositions.values()].find((candidate) => candidate.groupKey === groupKey);
    return composition === undefined ? undefined : this.#ingressRecord(composition);
  }

  getIngressCompositionByFragment(
    fragmentId: string,
    principalId: string,
    address: ConversationAddress,
  ): IngressCompositionRecord | undefined {
    const composition = [...this.ingressCompositions.values()].find(
      (candidate) =>
        candidate.principalId === principalId &&
        candidate.address.transport === address.transport &&
        candidate.address.account === address.account &&
        candidate.address.channel === address.channel &&
        candidate.address.thread === address.thread &&
        candidate.fragments.some((fragment) => fragment.message.id === fragmentId),
    );
    return composition === undefined ? undefined : this.#ingressRecord(composition);
  }

  listPendingIngressCompositions(): IngressCompositionRecord[] {
    return [...this.ingressCompositions.values()].map((composition) => this.#ingressRecord(composition));
  }

  deleteIngressComposition(id: string): boolean {
    return this.ingressCompositions.delete(id);
  }

  #ingressRecord(composition: MemoryIngressComposition): IngressCompositionRecord {
    return {
      id: composition.id,
      groupKey: composition.groupKey,
      address: composition.address,
      principalId: composition.principalId,
      createdAt: composition.createdAt,
      updatedAt: composition.updatedAt,
      flushAt: composition.flushAt,
      deadlineAt: composition.deadlineAt,
      fragments: [...composition.fragments]
        .sort((left, right) => left.sortOrder - right.sortOrder || left.message.id.localeCompare(right.message.id))
        .map(({ message }) => message),
    };
  }

  bindConversation(binding: ConversationBinding) {
    if (this.failBindings > 0) {
      this.failBindings -= 1;
      throw new Error("temporary binding failure");
    }
    this.bindings.push(binding);
  }

  getConversationBinding(address: InboundMessage["address"]) {
    return this.bindings.findLast(
      (binding) =>
        binding.address.transport === address.transport &&
        binding.address.account === address.account &&
        binding.address.channel === address.channel &&
        binding.address.thread === address.thread,
    );
  }

  getSharedConversationSessionPath() {
    return this.bindings.findLast((binding) => binding.address.thread === undefined)?.ompSessionPath;
  }

  migrateTelegramTopicSessions(account: string) {
    if (this.migrations.has(account)) return 0;
    this.migrations.add(account);
    let removed = 0;
    for (let index = this.bindings.length - 1; index >= 0; index--) {
      const address = this.bindings[index].address;
      if (address.transport !== "telegram" || address.account !== account || address.thread === undefined) continue;
      this.bindings.splice(index, 1);
      removed++;
    }
    return removed;
  }

  migrateTelegramUpdateCheckpoint(account: string) {
    this.updateCheckpointMigrations.push(account);
    return false;
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
      secrets: {
        telegramToken: "telegram",
        webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }],
      },
      seams: {
        ingressComposer: FAST_INGRESS,
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
    expect(events).toEqual([
      "lock",
      "heartbeat",
      "runtime-start",
      "core-start",
      "core-stop",
      "runtime-stop",
      "heartbeat-stop",
      "unlock",
    ]);
    expect(store.closed).toBe(true);
  });

  test("refuses a second process before opening its database", async () => {
    let createdStore = false;
    const app = new GatewayApplication({
      config: gatewayConfig(),
      secrets: {
        telegramToken: "telegram",
        webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }],
      },
      seams: {
        ingressComposer: FAST_INGRESS,
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
      secrets: {
        telegramToken: "telegram",
        webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }],
      },
      seams: {
        ingressComposer: FAST_INGRESS,
        createStore: () => store,
        createCore: core.create,
        createRuntime: (options) => {
          runtimeOptions = options;
          return {
            async start() {
              options.onSessionState?.({
                isStreaming: false,
                isCompacting: false,
                sessionId: "one",
                sessionFile: "/sessions/one",
              });
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
        now: Date.now,
      },
    });

    await app.start();
    expect(store.updateCheckpointMigrations).toEqual(["bot"]);
    expect(await core.options().identityResolver({ transport: "telegram", account: "bot", subject: "42" })).toEqual({
      id: "operator",
      roles: ["operator"],
    });
    await core.options().onInbound(inbound("message-1"));
    await waitFor(() => store.bindings.length === 1);

    expect(runtimeOptions?.sessionFile).toBeUndefined();
    expect(store.checkpoint.get("omp/session_file")).toBe("/sessions/one");
    expect(store.bindings).toEqual([
      {
        address: { transport: "telegram", account: "bot", channel: "42" },
        ompSessionPath: "/sessions/one",
        workspace: "/workspace/gateway",
      },
    ]);
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
    let busy = false;
    const handled: Array<{ readonly id: string; readonly session: string }> = [];
    const created: string[] = [];
    const switched: string[] = [];
    const firstTopicStarted = Promise.withResolvers<void>();
    const finishFirstTopic = Promise.withResolvers<void>();
    const app = new GatewayApplication({
      config,
      secrets: { telegramToken: "telegram", webSocketCredentials: [] },
      seams: {
        ingressComposer: FAST_INGRESS,
        createStore: () => store,
        createCore: core.create,
        createRuntime: (options) => ({
          async start() {
            options.onSessionState?.({
              isStreaming: false,
              isCompacting: false,
              sessionId: "root",
              sessionFile: currentSession,
            });
          },
          async stop() {},
          async handleInbound(message) {
            handled.push({ id: message.id, session: currentSession });
            if (message.id === "topic-9-first") {
              busy = true;
              firstTopicStarted.resolve();
            }
          },
          async waitUntilIdle() {
            await finishFirstTopic.promise;
            busy = false;
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
          isBusy: () => busy,
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
    const otherRoot = { ...inbound("root-other"), address: { transport: "telegram", account: "bot", channel: "84" } };
    const webRoot: InboundMessage = {
      ...inbound("web-root"),
      identity: { transport: "websocket", account: "web", subject: "web-user" },
      address: { transport: "websocket", account: "web", channel: "web-user" },
    };

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
    await core.options().onInbound(otherRoot);
    await core.options().onInbound(webRoot);
    await core.options().onInbound(inbound("root-again"));
    await waitFor(() => handled.length === 7);

    expect(created).toEqual(["First topic request", "Second topic request"]);
    expect(switched).toEqual(expect.arrayContaining(["/sessions/root", "/sessions/topic-1"]));
    expect(handled).toEqual(
      expect.arrayContaining([
        { id: "root-first", session: "/sessions/root" },
        { id: "topic-9-first", session: "/sessions/topic-1" },
        { id: "topic-10-first", session: "/sessions/topic-2" },
        { id: "topic-9-again", session: "/sessions/topic-1" },
        { id: "web-root", session: "/sessions/root" },
        { id: "root-other", session: "/sessions/root" },
        { id: "root-again", session: "/sessions/root" },
      ]),
    );
    expect(store.getConversationBinding(topicMessage("ignored", "9", "ignored").address)?.ompSessionPath).toBe(
      "/sessions/topic-1",
    );
    expect(store.getConversationBinding(topicMessage("ignored", "10", "ignored").address)?.ompSessionPath).toBe(
      "/sessions/topic-2",
    );
    await app.stop();
  });

  test("does not rebind an active topic when an immediate control overlaps a session switch", async () => {
    const store = new MemoryStore();
    const core = coreHarness([]);
    const base = gatewayConfig();
    const config = parseGatewayConfig({
      ...base,
      transports: {
        telegram: {
          enabled: true,
          account: "bot",
          tokenEnv: "TELEGRAM_BOT_TOKEN",
          topicSessions: { enabled: true, createFromRoot: true },
        },
      },
    });
    const handled: string[] = [];
    const app = new GatewayApplication({
      config,
      secrets: { telegramToken: "telegram", webSocketCredentials: [] },
      seams: {
        ingressComposer: FAST_INGRESS,
        createStore: () => store,
        createCore: core.create,
        createRuntime: (options) => ({
          async start() {
            options.onSessionState?.({
              isStreaming: false,
              isCompacting: false,
              sessionId: "topic-a",
              sessionFile: "/sessions/topic-a",
            });
          },
          async stop() {},
          async handleInbound(message) {
            handled.push(message.id);
            options.onSessionState?.({
              isStreaming: false,
              isCompacting: false,
              sessionId: "topic-c",
              sessionFile: "/sessions/topic-c",
            });
          },
          canHandleInboundImmediately: () => true,
          isActiveConversation: () => true,
        }),
        createTelegramAdapter: () => adapter("telegram"),
        acquireLock: () => ({ ok: true }),
        startLockHeartbeat: () => () => {},
        releaseLock: () => {},
      },
    });
    const topicB: InboundMessage = {
      ...inbound("topic-b-status"),
      address: { transport: "telegram", account: "bot", channel: "-1001", thread: "20" },
      content: { text: "/status" },
    };

    await app.start();
    store.bindConversation({
      address: topicB.address,
      ompSessionPath: "/sessions/topic-a",
      workspace: "/workspace/gateway",
    });
    await core.options().onInbound(topicB);
    await waitFor(() => store.pending.size === 0);
    expect(handled).toEqual(["topic-b-status"]);
    expect(store.getConversationBinding(topicB.address)?.ompSessionPath).toBe("/sessions/topic-a");
    await app.stop();
  });

  test("retains a failed inbound claim and retries it without Telegram redelivery", async () => {
    const store = new MemoryStore();
    const core = coreHarness([]);
    let attempts = 0;
    const errors: unknown[] = [];
    const app = new GatewayApplication({
      config: gatewayConfig(),
      secrets: {
        telegramToken: "telegram",
        webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }],
      },
      seams: {
        ingressComposer: FAST_INGRESS,
        createStore: () => store,
        createCore: core.create,
        createRuntime: (options) => ({
          async start() {
            options.onSessionState?.({
              isStreaming: false,
              isCompacting: false,
              sessionId: "one",
              sessionFile: "/sessions/one",
            });
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
        inboundRetryDelayMs: 1,
        onInboundDispatchError: (_message, error) => errors.push(error),
      },
    });

    await app.start();
    await core.options().onInbound(inbound("retry-me"));
    await waitFor(() => attempts === 2);
    expect(errors).toHaveLength(1);
    expect(store.releases).toEqual([]);
    expect(store.pending.size).toBe(0);
    expect(store.claims).toContain("telegram/bot/retry-me");
    expect(store.bindings).toHaveLength(1);
    await core.options().onInbound(inbound("retry-me"));
    await Bun.sleep(5);
    expect(attempts).toBe(2);
    await app.stop();
  });

  test("retries bookkeeping without dispatching a successful prompt twice", async () => {
    const store = new MemoryStore();
    store.failBindings = 1;
    const core = coreHarness([]);
    let dispatches = 0;
    const errors: unknown[] = [];
    const app = new GatewayApplication({
      config: gatewayConfig(),
      secrets: {
        telegramToken: "telegram",
        webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }],
      },
      seams: {
        ingressComposer: FAST_INGRESS,
        createStore: () => store,
        createCore: core.create,
        createRuntime: (options) => ({
          async start() {
            options.onSessionState?.({
              isStreaming: false,
              isCompacting: false,
              sessionId: "one",
              sessionFile: "/sessions/one",
            });
          },
          async stop() {},
          async handleInbound() {
            dispatches += 1;
          },
        }),
        createTelegramAdapter: () => adapter("telegram"),
        createWebSocketAdapter: () => adapter("websocket"),
        acquireLock: () => ({ ok: true }),
        startLockHeartbeat: () => () => {},
        releaseLock: () => {},
        inboundRetryDelayMs: 1,
        onInboundDispatchError: (_message, error) => errors.push(error),
      },
    });

    await app.start();
    await core.options().onInbound(inbound("completion-retry"));
    await waitFor(() => dispatches === 1 && store.pending.size === 0);
    expect(dispatches).toBe(1);
    expect(errors).toHaveLength(1);
    expect(store.bindings).toHaveLength(1);
    await app.stop();
  });

  test("lets later queued work pass a permanently failing inbound message", async () => {
    const store = new MemoryStore();
    const core = coreHarness([]);
    const handled: string[] = [];
    const errors: unknown[] = [];
    const app = new GatewayApplication({
      config: gatewayConfig(),
      secrets: {
        telegramToken: "telegram",
        webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }],
      },
      seams: {
        ingressComposer: FAST_INGRESS,
        createStore: () => store,
        createCore: core.create,
        createRuntime: (options) => ({
          async start() {
            options.onSessionState?.({
              isStreaming: false,
              isCompacting: false,
              sessionId: "one",
              sessionFile: "/sessions/one",
            });
          },
          async stop() {},
          async handleInbound(message) {
            if (message.id === "poison") throw new Error("permanent dispatch failure");
            handled.push(message.id);
          },
        }),
        createTelegramAdapter: () => adapter("telegram"),
        createWebSocketAdapter: () => adapter("websocket"),
        acquireLock: () => ({ ok: true }),
        startLockHeartbeat: () => () => {},
        releaseLock: () => {},
        inboundRetryDelayMs: 500,
        onInboundDispatchError: (_message, error) => errors.push(error),
      },
    });

    await app.start();
    await core.options().onInbound({ ...inbound("poison"), content: { text: "/poison" } });
    await core.options().onInbound({ ...inbound("healthy"), content: { text: "/healthy" } });
    await waitFor(() => handled.includes("healthy"));
    expect(errors).toHaveLength(1);
    expect(store.pending.has("telegram/bot/poison")).toBe(true);
    expect(store.pending.has("telegram/bot/healthy")).toBe(false);
    await app.stop();
  });

  test("acknowledges a queued conversation without blocking transport receipt", async () => {
    const store = new MemoryStore();
    const core = coreHarness([]);
    const firstStarted = Promise.withResolvers<void>();
    const finishFirst = Promise.withResolvers<void>();
    const handled: string[] = [];
    const queued: string[] = [];
    let busy = false;
    const app = new GatewayApplication({
      config: gatewayConfig(),
      secrets: {
        telegramToken: "telegram",
        webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }],
      },
      seams: {
        ingressComposer: FAST_INGRESS,
        createStore: () => store,
        createCore: core.create,
        createRuntime: (options) => ({
          async start() {
            options.onSessionState?.({
              isStreaming: false,
              isCompacting: false,
              sessionId: "one",
              sessionFile: "/sessions/one",
            });
          },
          async stop() {},
          async handleInbound(message) {
            handled.push(message.id);
            if (message.id === "first") {
              busy = true;
              firstStarted.resolve();
              await finishFirst.promise;
              busy = false;
            }
          },
          isBusy: () => busy,
          async waitUntilIdle() {
            await finishFirst.promise;
          },
          async notifyInboundQueued(message) {
            queued.push(message.id);
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
    await core.options().onInbound({ ...inbound("first"), content: { text: "/first" } });
    await firstStarted.promise;
    await core.options().onInbound({ ...inbound("second"), content: { text: "/second" } });
    expect(handled).toEqual(["first"]);
    expect(queued).toEqual(["second"]);
    expect(store.pending.size).toBe(2);

    finishFirst.resolve();
    await waitFor(() => handled.length === 2 && store.pending.size === 0);
    expect(handled).toEqual(["first", "second"]);
    await app.stop();
  });

  test("replays persisted inbound work when the gateway starts", async () => {
    const store = new MemoryStore();
    const recovered: InboundMessage = {
      ...inbound("recovered"),
      principal: { id: "operator", roles: ["stale-admin"] },
    };
    expect(store.claimInboundMessage(recovered, 1)).toBe(true);
    const core = coreHarness([]);
    const handled: Array<{ readonly id: string; readonly roles: readonly string[] }> = [];
    const app = new GatewayApplication({
      config: gatewayConfig(),
      secrets: {
        telegramToken: "telegram",
        webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }],
      },
      seams: {
        ingressComposer: FAST_INGRESS,
        createStore: () => store,
        createCore: core.create,
        createRuntime: (options) => ({
          async start() {
            options.onSessionState?.({
              isStreaming: false,
              isCompacting: false,
              sessionId: "one",
              sessionFile: "/sessions/one",
            });
          },
          async stop() {},
          async handleInbound(message) {
            handled.push({ id: message.id, roles: message.principal.roles });
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
    await waitFor(() => handled.length === 1);
    expect(handled).toEqual([{ id: "recovered", roles: ["operator"] }]);
    expect(store.pending.size).toBe(0);
    expect(store.claims).toContain("telegram/bot/recovered");
    await app.stop();
  });

  test("re-evaluates immediate controls while replaying durable input", async () => {
    const store = new MemoryStore();
    const first = { ...inbound("recovered-prompt"), content: { text: "Build this" } };
    const stop = { ...inbound("recovered-stop"), content: { text: "/stop" } };
    expect(store.claimInboundMessage(first, 1)).toBe(true);
    expect(store.claimInboundMessage(stop, 2)).toBe(true);
    const core = coreHarness([]);
    const idle = Promise.withResolvers<void>();
    const handled: string[] = [];
    let busy = false;
    const app = new GatewayApplication({
      config: gatewayConfig(),
      secrets: {
        telegramToken: "telegram",
        webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }],
      },
      seams: {
        ingressComposer: FAST_INGRESS,
        createStore: () => store,
        createCore: core.create,
        createRuntime: (options) => ({
          async start() {
            options.onSessionState?.({
              isStreaming: false,
              isCompacting: false,
              sessionId: "one",
              sessionFile: "/sessions/one",
            });
          },
          async stop() {},
          async handleInbound(message) {
            handled.push(message.id);
            if (message.id === first.id) busy = true;
            if (message.id === stop.id) {
              busy = false;
              idle.resolve();
            }
          },
          isBusy: () => busy,
          canHandleInboundImmediately: (message) => busy && message.content.text === "/stop",
          async waitUntilIdle() {
            await idle.promise;
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
    await waitFor(() => handled.length === 2 && store.pending.size === 0);
    expect(handled).toEqual([first.id, stop.id]);
    await app.stop();
  });

  test("revalidates authorization after waiting for an active turn", async () => {
    const store = new MemoryStore();
    const core = coreHarness([]);
    const waiting = Promise.withResolvers<void>();
    const idle = Promise.withResolvers<void>();
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    let dispatches = 0;
    const app = new GatewayApplication({
      config: gatewayConfig(),
      secrets: {
        telegramToken: "telegram",
        webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }],
      },
      seams: {
        ingressComposer: FAST_INGRESS,
        createStore: () => store,
        createCore: core.create,
        createRuntime: (options) => ({
          async start() {
            options.onSessionState?.({
              isStreaming: false,
              isCompacting: false,
              sessionId: "one",
              sessionFile: "/sessions/one",
            });
          },
          async stop() {},
          async handleInbound() {
            dispatches += 1;
          },
          isBusy: () => true,
          async waitUntilIdle() {
            waiting.resolve();
            await idle.promise;
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
    await core.options().onInbound(inbound("revoked-while-waiting"));
    await waiting.promise;
    store.resolvedPrincipal = undefined;
    idle.resolve();
    await waitFor(() => store.pending.size === 0);
    expect(dispatches).toBe(0);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("identity authorization changed"));
    warning.mockRestore();
    await app.stop();
  });

  test("discards recovered work after its transport identity is revoked", async () => {
    const store = new MemoryStore();
    expect(store.claimInboundMessage(inbound("revoked"), 1)).toBe(true);
    store.resolvedPrincipal = undefined;
    const core = coreHarness([]);
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    let dispatches = 0;
    const app = new GatewayApplication({
      config: gatewayConfig(),
      secrets: {
        telegramToken: "telegram",
        webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }],
      },
      seams: {
        ingressComposer: FAST_INGRESS,
        createStore: () => store,
        createCore: core.create,
        createRuntime: (options) => ({
          async start() {
            options.onSessionState?.({
              isStreaming: false,
              isCompacting: false,
              sessionId: "one",
              sessionFile: "/sessions/one",
            });
          },
          async stop() {},
          async handleInbound() {
            dispatches += 1;
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
    await waitFor(() => store.pending.size === 0);
    expect(dispatches).toBe(0);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("identity authorization changed"));
    warning.mockRestore();
    await app.stop();
  });

  test("reconciles recovered scheduled work through the scheduler attempt lifecycle", async () => {
    const base = gatewayConfig();
    const config: GatewayConfig = {
      ...base,
      automation: { enabled: true, pollIntervalMs: 1_000, retryDelayMs: 15_000, maxAttempts: 3 },
    };
    const store = new GatewayStore(join(config.stateDir, "ompclaw.sqlite"));
    store.upsertPrincipal({ id: "operator", roles: ["operator"] });
    store.bindIdentity({ transport: "telegram", account: "bot", subject: "42" }, "operator");
    const scheduledFor = 1_000;
    const job: ScheduledJob = {
      id: "scheduled-job",
      principalId: "operator",
      identity: { transport: "telegram", account: "bot", subject: "42" },
      address: { transport: "telegram", account: "bot", channel: "42" },
      name: "Recovered job",
      prompt: "Finish the recovered work",
      schedule: { kind: "at", at: scheduledFor },
      enabled: true,
      nextRunAt: scheduledFor,
      attemptCount: 0,
      successCount: 0,
      failureCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    store.createScheduledJob(job);
    expect(
      store.claimInboundMessage(
        {
          ...inbound(`scheduled:${job.id}:${scheduledFor}`),
          sentAt: scheduledFor,
        },
        1,
        true,
      ),
    ).toBe(true);
    const core = coreHarness([]);
    const scheduled: string[] = [];
    const interactive: string[] = [];
    const app = new GatewayApplication({
      config,
      secrets: {
        telegramToken: "telegram",
        webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }],
      },
      seams: {
        ingressComposer: FAST_INGRESS,
        createStore: () => store,
        createCore: core.create,
        createRuntime: (options) => ({
          async start() {
            options.onSessionState?.({
              isStreaming: false,
              isCompacting: false,
              sessionId: "scheduled",
              sessionFile: "/sessions/scheduled",
            });
          },
          async stop() {},
          async handleInbound(message) {
            interactive.push(message.id);
          },
          async handleScheduled(message) {
            scheduled.push(message.id);
          },
          isBusy: () => false,
        }),
        createTelegramAdapter: () => adapter("telegram"),
        createWebSocketAdapter: () => adapter("websocket"),
        acquireLock: () => ({ ok: true }),
        startLockHeartbeat: () => () => {},
        releaseLock: () => {},
        now: () => 2_000,
      },
    });

    await app.start();
    await waitFor(() => store.getScheduledJob(job.id)?.successCount === 1);
    expect(scheduled).toEqual([`scheduled:${job.id}:${scheduledFor}`]);
    expect(interactive).toEqual([]);
    expect(store.listPendingInboundMessages()).toEqual([]);
    await app.stop();
  });

  test("rolls back started resources in reverse when core startup fails", async () => {
    const events: string[] = [];
    const store = new MemoryStore();
    const core = coreHarness(events);
    expect(store.claimInboundMessage(inbound("recovered-during-start"), 1)).toBe(true);
    let dispatches = 0;
    core.core.start = async () => {
      events.push("core-start");
      throw new Error("adapter failed");
    };
    const app = new GatewayApplication({
      config: gatewayConfig(),
      secrets: {
        telegramToken: "telegram",
        webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }],
      },
      seams: {
        ingressComposer: FAST_INGRESS,
        createStore: () => store,
        createCore: core.create,
        createRuntime: () => ({
          async start() {
            events.push("runtime-start");
          },
          async stop() {
            events.push("runtime-stop");
          },
          async handleInbound() {
            dispatches += 1;
          },
        }),
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
    expect(events).toEqual([
      "lock",
      "heartbeat",
      "runtime-start",
      "core-start",
      "core-stop",
      "runtime-stop",
      "heartbeat-stop",
      "unlock",
    ]);
    expect(store.closed).toBe(true);
    expect(dispatches).toBe(0);
    expect(store.pending.has("telegram/bot/recovered-during-start")).toBe(true);
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
      secrets: {
        telegramToken: "telegram",
        webSocketCredentials: [{ token: "web", subject: "web-user", channel: "web-user" }],
      },
      seams: {
        ingressComposer: FAST_INGRESS,
        createCore: core.create,
        createScheduler: () => scheduler,
        createRuntime: (options) => {
          runtimeOptions = options;
          return {
            async start() {
              events.push("runtime-start");
            },
            async stop() {
              events.push("runtime-stop");
            },
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
    expect(events).toEqual([
      "runtime-start",
      "core-start",
      "scheduler-start",
      "scheduler-stop",
      "core-stop",
      "runtime-stop",
    ]);
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
      expect(store.resolvePrincipal({ transport: "websocket", account: "web", subject: "subject-a" })?.id).toBe(
        "principal-a",
      );
      expect(store.resolvePrincipal({ transport: "telegram", account: "bot", subject: "12345" })?.id).toBe(
        "telegram:bot:12345",
      );
      expect(store.getCheckpoint("telegram", "update_id:default")).toBe(7);
    } finally {
      store.close();
    }
  });
});
