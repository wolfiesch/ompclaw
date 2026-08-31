import { join, resolve } from "node:path";
import { acquireLock, releaseLock, startLockHeartbeat } from "./api";
import {
  gatewayRpcRuntimeConfig,
  resolveGatewaySecrets,
  type GatewayConfig,
  type GatewaySecrets,
} from "./gateway-config";
import { GatewayCore, type GatewayCoreOptions } from "./gateway-core";
import type { GatewayDelivery } from "./gateway-tools";
import {
  GatewayScheduler,
  ScheduledDispatchBusyError,
  type GatewayAutomationControl,
  type GatewayScheduledJobStore,
  type GatewaySchedulerOptions,
} from "./gateway-scheduler";
import {
  GatewayStore,
  type ConversationBinding,
  type GatewayTurnLifecycleStore,
  type JsonValue,
  type ScheduledJob,
} from "./gateway-store";
import type { InboundMessage, Principal, TransportAdapter, TransportIdentity } from "./gateway-types";
import { RpcGatewayRuntime, runtimeCommandMenu, type RpcGatewayRuntimeOptions } from "./rpc-runtime";
import type { RpcSessionState } from "./rpc-protocol";
import { prepareInheritedHarness, prepareLearningOverlay } from "./rpc-profile";
import { TelegramTransportAdapter, type TelegramTransportAdapterOptions } from "./transports/telegram/adapter";
import { WebSocketTransportAdapter, type WebSocketTransportOptions } from "./transports/websocket/adapter";

export interface GatewayApplicationStore extends Partial<GatewayScheduledJobStore>, Partial<GatewayTurnLifecycleStore> {
  close(): void;
  resolvePrincipal(identity: TransportIdentity): Principal | undefined;
  getCheckpoint(adapter: string, key: string): JsonValue | undefined;
  setCheckpoint(adapter: string, key: string, value: JsonValue): void;
  claimInboundMessage(transport: string, account: string, messageId: string, receivedAt: number): boolean;
  releaseInboundMessage(transport: string, account: string, messageId: string): boolean;
  bindConversation(binding: ConversationBinding): void;
  getConversationBinding(address: InboundMessage["address"]): ConversationBinding | undefined;
  getSharedConversationSessionPath?(): string | undefined;
  migrateTelegramTopicSessions?(account: string): number;
  putPendingInteraction: GatewayStore["putPendingInteraction"];
  deletePendingInteraction: GatewayStore["deletePendingInteraction"];
}

export interface GatewayRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleInbound(message: InboundMessage): Promise<void>;
  handleScheduled?(message: InboundMessage): Promise<void>;
  isBusy?(): boolean;
  waitUntilIdle?(): Promise<void>;
  newSession?(name?: string): Promise<boolean>;
  switchSession?(sessionPath: string): Promise<boolean>;
}

export type GatewayCoreRuntime = GatewayDelivery & Pick<GatewayCore, "register" | "start" | "stop">;
export interface GatewaySchedulerRuntime extends GatewayAutomationControl {
  start(): void;
  stop(): void;
}

export interface GatewayApplicationSeams {
  readonly createStore?: (path: string) => GatewayApplicationStore;
  readonly createCore?: (options: GatewayCoreOptions) => GatewayCoreRuntime;
  readonly createRuntime?: (options: RpcGatewayRuntimeOptions) => GatewayRuntime;
  readonly createTelegramAdapter?: (options: TelegramTransportAdapterOptions) => TransportAdapter;
  readonly createWebSocketAdapter?: (options: WebSocketTransportOptions) => TransportAdapter;
  readonly createScheduler?: (options: GatewaySchedulerOptions) => GatewaySchedulerRuntime;
  readonly acquireLock?: (path: string) => { readonly ok: true } | { readonly ok: false; readonly holder: number };
  readonly releaseLock?: (path: string) => void;
  readonly startLockHeartbeat?: (path: string) => () => void;
  readonly now?: () => number;
}

export interface GatewayApplicationOptions {
  readonly config: GatewayConfig;
  /** Test-only seam; production resolves configured env names during start. */
  readonly secrets?: GatewaySecrets;
  readonly seams?: GatewayApplicationSeams;
}

export type GatewayApplicationState = "idle" | "starting" | "started" | "stopping";

export interface GatewayApplicationStatus {
  readonly state: GatewayApplicationState;
  readonly lockPath: string;
  readonly adapters: readonly string[];
  readonly sessionFile?: string;
}

/**
 * One process owns one OMP RPC session. Transport adapters are deliberately
 * downstream of that session: no poller or server can accept traffic first.
 */
export class GatewayApplication {
  readonly #config: GatewayConfig;
  readonly #providedSecrets?: GatewaySecrets;
  readonly #seams: GatewayApplicationSeams;
  readonly #lockPath: string;
  readonly #databasePath: string;
  #state: GatewayApplicationState = "idle";
  #store: GatewayApplicationStore | undefined;
  #core: GatewayCoreRuntime | undefined;
  #runtime: GatewayRuntime | undefined;
  #scheduler: GatewaySchedulerRuntime | undefined;
  #releaseHeartbeat: (() => void) | undefined;
  #adapters: TransportAdapter[] = [];
  #sessionFile: string | undefined;
  #sharedSessionFile: string | undefined;
  #inboundTail: Promise<void> = Promise.resolve();

  constructor(options: GatewayApplicationOptions) {
    this.#config = options.config;
    this.#providedSecrets = options.secrets;
    this.#seams = options.seams ?? {};
    this.#lockPath = resolve(options.config.stateDir, "ompclaw.lock");
    this.#databasePath = resolve(options.config.stateDir, "ompclaw.sqlite");
  }

  status(): GatewayApplicationStatus {
    return {
      state: this.#state,
      lockPath: this.#lockPath,
      adapters: this.#adapters.map((adapter) => adapter.id),
      ...(this.#sessionFile === undefined ? {} : { sessionFile: this.#sessionFile }),
    };
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#state === "started") return;
    if (this.#state !== "idle") throw new Error(`OmpClaw application cannot start while ${this.#state}`);
    this.#state = "starting";

    let lockHeld = false;
    try {
      const lock = (this.#seams.acquireLock ?? acquireLock)(this.#lockPath);
      if (!lock.ok) throw new Error(`OmpClaw is already running in process ${lock.holder}`);
      lockHeld = true;
      this.#releaseHeartbeat = (this.#seams.startLockHeartbeat ?? startLockHeartbeat)(this.#lockPath);

      const store = (this.#seams.createStore ?? ((path: string) => new GatewayStore(path)))(this.#databasePath);
      this.#store = store;
      const telegram = this.#config.transports.telegram;
      const topicSessions = telegram?.enabled === true && telegram.topicSessions.enabled;
      if (topicSessions) store.migrateTelegramTopicSessions?.(telegram.account);
      const checkpoint = store.getCheckpoint("omp", "session_file");
      if (checkpoint !== undefined && (typeof checkpoint !== "string" || checkpoint.length === 0)) {
        throw new Error("OMP session checkpoint must be a non-empty string");
      }
      const sharedCheckpoint = topicSessions ? store.getCheckpoint("omp", "shared_session_file") : undefined;
      if (sharedCheckpoint !== undefined && (typeof sharedCheckpoint !== "string" || sharedCheckpoint.length === 0)) {
        throw new Error("OMP shared session checkpoint must be a non-empty string");
      }
      this.#sharedSessionFile = sharedCheckpoint ?? (topicSessions ? store.getSharedConversationSessionPath?.() : undefined);
      this.#sessionFile = checkpoint ?? this.#sharedSessionFile;
      const core = (this.#seams.createCore ?? ((options: GatewayCoreOptions) => new GatewayCore(options)))({
        identityResolver: (identity) => store.resolvePrincipal(identity),
        onInbound: (message) => this.#handleInbound(message),
      });
      this.#core = core;

      const secrets = this.#providedSecrets ?? resolveGatewaySecrets(this.#config);
      this.#adapters = this.#createAdapters(store, secrets);
      for (const adapter of this.#adapters) core.register(adapter);

      let scheduler: GatewaySchedulerRuntime | undefined;
      if (this.#config.automation.enabled) {
        const scheduledStore = requireScheduledStore(store);
        scheduler = (this.#seams.createScheduler ?? ((options: GatewaySchedulerOptions) => new GatewayScheduler(options)))({
          store: scheduledStore,
          dispatch: (job, scheduledFor) => this.#dispatchScheduledJob(job, scheduledFor),
          enabled: true,
          pollIntervalMs: this.#config.automation.pollIntervalMs,
          retryDelayMs: this.#config.automation.retryDelayMs,
          maxAttempts: this.#config.automation.maxAttempts,
          ...(this.#seams.now === undefined ? {} : { now: this.#seams.now }),
          onPermanentFailure: (job, error) => this.#notifyScheduledFailure(job, error),
        });
        this.#scheduler = scheduler;
      }

      let rpcConfig = gatewayRpcRuntimeConfig(this.#config);
      prepareInheritedHarness(rpcConfig);
      const learningOverlay = prepareLearningOverlay(this.#config);
      if (learningOverlay !== undefined) rpcConfig = { ...rpcConfig, configFiles: [...rpcConfig.configFiles, learningOverlay] };

      const runtime = (this.#seams.createRuntime ?? ((options: RpcGatewayRuntimeOptions) => new RpcGatewayRuntime(options)))({
        config: rpcConfig,
        delivery: core,
        sessionFile: this.#sessionFile,
        onSessionState: (session) => this.#recordSessionState(session),
        ...(scheduler === undefined ? {} : { automation: scheduler }),
        ...(isTurnLifecycleStore(store) ? { turnStore: store } : {}),
      });
      this.#runtime = runtime;

      // OMP starts before the core makes a transport reachable.
      await runtime.start();
      if (topicSessions && this.#sharedSessionFile === undefined) this.#sharedSessionFile = this.#sessionFile;
      this.#checkpointSession();
      this.#checkpointSharedSession();
      await core.start(signal);
      scheduler?.start();
      this.#state = "started";
    } catch (error) {
      await this.#rollbackStart(lockHeld);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#state === "idle") return;
    if (this.#state === "stopping") return;
    if (this.#state === "starting") throw new Error("OmpClaw application cannot stop while starting");
    this.#state = "stopping";
    const error = await this.#stopResources();
    this.#state = "idle";
    if (error !== undefined) throw error;
  }

  #createAdapters(store: GatewayApplicationStore, secrets: GatewaySecrets): TransportAdapter[] {
    const adapters: TransportAdapter[] = [];
    const telegram = this.#config.transports.telegram;
    if (telegram?.enabled) {
      if (secrets.telegramToken === undefined) throw new Error("Telegram token was not resolved");
      adapters.push((this.#seams.createTelegramAdapter ?? ((options: TelegramTransportAdapterOptions) => new TelegramTransportAdapter(options)))({
        token: secrets.telegramToken,
        account: telegram.account,
        stateDir: this.#config.stateDir,
        store,
        commands: runtimeCommandMenu(this.#config.omp.allowRpcBash),
        createTopicsFromRoot: telegram.topicSessions.enabled && telegram.topicSessions.createFromRoot,
        ...(telegram.transcribeCommand === undefined ? {} : { transcribeCommand: telegram.transcribeCommand }),
      }));
    }

    const websocket = this.#config.transports.websocket;
    if (websocket?.enabled) {
      if (secrets.webSocketCredentials.length !== websocket.credentials.length) {
        throw new Error("WebSocket credential resolution does not match configured credentials");
      }
      adapters.push((this.#seams.createWebSocketAdapter ?? ((options: WebSocketTransportOptions) => new WebSocketTransportAdapter(options)))({
        hostname: websocket.hostname,
        port: websocket.port,
        account: websocket.account,
        credentials: secrets.webSocketCredentials,
      }));
    }
    return adapters;
  }

  async #handleInbound(message: InboundMessage): Promise<void> {
    await this.#serializeInbound(() => this.#processInbound(message, false));
  }

  async #serializeInbound(operation: () => Promise<void>): Promise<void> {
    const previous = this.#inboundTail;
    let release: (() => void) | undefined;
    this.#inboundTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await operation();
    } finally {
      release?.();
    }
  }

  async #processInbound(message: InboundMessage, scheduled: boolean): Promise<void> {
    const store = this.#requireStore();
    const runtime = this.#requireRuntime();
    const { transport, account } = message.address;
    if (scheduled) store.releaseInboundMessage(transport, account, message.id);
    if (!store.claimInboundMessage(transport, account, message.id, (this.#seams.now ?? Date.now)())) return;

    try {
      const topicSessions = this.#config.transports.telegram?.topicSessions.enabled === true;
      if (topicSessions) await this.#selectConversationSession(store, runtime, message);
      if (scheduled && runtime.handleScheduled !== undefined) await runtime.handleScheduled(message);
      else await runtime.handleInbound(message);
      const sessionFile = this.#sessionFile;
      if (sessionFile === undefined) throw new Error("OMP runtime did not report its current session file");
      store.bindConversation({
        address: message.address,
        ompSessionPath: sessionFile,
        workspace: this.#config.workspace,
      });
      if (topicSessions && !this.#isTopicAddress(message.address)) this.#sharedSessionFile = sessionFile;
      this.#checkpointSession();
      this.#checkpointSharedSession();
    } catch (error) {
      store.releaseInboundMessage(transport, account, message.id);
      throw error;
    }
  }

  async #selectConversationSession(
    store: GatewayApplicationStore,
    runtime: GatewayRuntime,
    message: InboundMessage,
  ): Promise<void> {
    const binding = store.getConversationBinding(message.address);
    const currentSession = this.#sessionFile;
    if (binding !== undefined) {
      if (binding.ompSessionPath === currentSession) return;
      if (runtime.switchSession === undefined) throw new Error("OMP runtime does not support conversation session switching");
      await this.#waitUntilSessionMutable(runtime, "switch conversation sessions");
      const switched = await runtime.switchSession(binding.ompSessionPath);
      if (!switched) throw new Error(`OMP cancelled the session switch for ${binding.ompSessionPath}`);
      return;
    }

    if (!this.#isTopicAddress(message.address)) {
      const sharedSession = this.#sharedSessionFile ?? store.getSharedConversationSessionPath?.();
      if (sharedSession === undefined || sharedSession === currentSession) return;
      if (runtime.switchSession === undefined) throw new Error("OMP runtime does not support conversation session switching");
      await this.#waitUntilSessionMutable(runtime, "switch to the shared session");
      const switched = await runtime.switchSession(sharedSession);
      if (!switched) throw new Error(`OMP cancelled the session switch for ${sharedSession}`);
      return;
    }

    if (this.#sharedSessionFile === undefined && currentSession !== undefined) {
      this.#sharedSessionFile = currentSession;
      this.#checkpointSharedSession();
    }
    if (runtime.newSession === undefined) throw new Error("OMP runtime does not support per-conversation sessions");
    await this.#waitUntilSessionMutable(runtime, "create a conversation session");
    const created = await runtime.newSession(this.#sessionName(message));
    if (!created) throw new Error("OMP cancelled conversation session creation");
  }

  async #waitUntilSessionMutable(runtime: GatewayRuntime, action: string): Promise<void> {
    if (!runtime.isBusy?.()) return;
    if (runtime.waitUntilIdle === undefined) throw new Error(`OMP is busy and cannot ${action}`);
    await runtime.waitUntilIdle();
  }

  #isTopicAddress(address: InboundMessage["address"]): boolean {
    return address.transport === "telegram" && address.thread !== undefined;
  }

  #sessionName(message: InboundMessage): string {
    const source = message.content.text ?? message.content.attachments?.[0]?.name;
    if (source !== undefined) {
      const normalized = source.replace(/\s+/g, " ").trim();
      if (normalized.length > 0) return [...normalized].slice(0, 80).join("");
    }
    const thread = message.address.thread === undefined ? "" : ` topic ${message.address.thread}`;
    return `Telegram ${message.address.channel}${thread}`;
  }

  async #dispatchScheduledJob(job: ScheduledJob, scheduledFor: number): Promise<void> {
    const runtime = this.#requireRuntime();
    if (runtime.isBusy?.()) throw new ScheduledDispatchBusyError("OMP is serving another turn");
    const principal = this.#requireStore().resolvePrincipal(job.identity);
    if (principal === undefined || principal.id !== job.principalId) {
      throw new Error(`Scheduled job ${job.id} no longer has an authorized principal`);
    }
    await this.#serializeInbound(() => this.#processInbound({
      id: `scheduled:${job.id}:${scheduledFor}`,
      sentAt: scheduledFor,
      identity: job.identity,
      principal,
      address: job.address,
      content: {
        text: [
          `Scheduled job "${job.name}" is due (job ${job.id}, scheduled ${new Date(scheduledFor).toISOString()}).`,
          "Execute this unattended task now and report the result to this conversation:",
          job.prompt,
        ].join("\n\n"),
      },
    }, true));
  }

  async #notifyScheduledFailure(job: ScheduledJob, error: Error): Promise<void> {
    const principal = this.#requireStore().resolvePrincipal(job.identity);
    const core = this.#core;
    if (principal === undefined || principal.id !== job.principalId || core === undefined) return;
    await core.send(
      job.address,
      { text: `Scheduled job "${job.name}" failed after ${this.#config.automation.maxAttempts} attempts: ${error.message}`, format: "text" },
      { principal, origin: job.address },
    );
  }

  #recordSessionState(state: RpcSessionState): void {
    if (typeof state.sessionFile === "string" && state.sessionFile.length > 0) this.#sessionFile = state.sessionFile;
  }

  #checkpointSession(): void {
    if (this.#sessionFile !== undefined) this.#requireStore().setCheckpoint("omp", "session_file", this.#sessionFile);
  }

  #checkpointSharedSession(): void {
    if (this.#sharedSessionFile !== undefined) {
      this.#requireStore().setCheckpoint("omp", "shared_session_file", this.#sharedSessionFile);
    }
  }

  async #rollbackStart(lockHeld: boolean): Promise<void> {
    await this.#stopResources(lockHeld);
    this.#state = "idle";
  }

  async #stopResources(lockHeld = true): Promise<unknown> {
    let firstError: unknown;
    const remember = (error: unknown): void => { firstError ??= error; };

    const scheduler = this.#scheduler;
    this.#scheduler = undefined;
    if (scheduler !== undefined) {
      try {
        scheduler.stop();
      } catch (error) {
        remember(error);
      }
    }

    const core = this.#core;
    this.#core = undefined;
    if (core !== undefined) {
      try {
        await core.stop();
      } catch (error) {
        remember(error);
      }
    }

    const runtime = this.#runtime;
    this.#runtime = undefined;
    if (runtime !== undefined) {
      try {
        await runtime.stop();
      } catch (error) {
        remember(error);
      }
    }

    const store = this.#store;
    this.#store = undefined;
    if (store !== undefined) {
      try {
        store.close();
      } catch (error) {
        remember(error);
      }
    }

    try {
      this.#releaseHeartbeat?.();
    } catch (error) {
      remember(error);
    }
    this.#releaseHeartbeat = undefined;
    if (lockHeld) {
      try {
        (this.#seams.releaseLock ?? releaseLock)(this.#lockPath);
      } catch (error) {
        remember(error);
      }
    }

    this.#adapters = [];
    this.#sessionFile = undefined;
    this.#sharedSessionFile = undefined;
    return firstError;
  }

  #requireStore(): GatewayApplicationStore {
    if (this.#store === undefined) throw new Error("OmpClaw store is not started");
    return this.#store;
  }

  #requireRuntime(): GatewayRuntime {
    if (this.#runtime === undefined) throw new Error("OmpClaw runtime is not started");
    return this.#runtime;
  }
}

export function gatewayDatabasePath(config: Pick<GatewayConfig, "stateDir">): string {
  return join(config.stateDir, "ompclaw.sqlite");
}

function requireScheduledStore(store: GatewayApplicationStore): GatewayScheduledJobStore {
  const methods = [
    "createScheduledJob",
    "updateScheduledJob",
    "getScheduledJob",
    "listScheduledJobs",
    "listDueScheduledJobs",
    "deleteScheduledJob",
  ] as const;
  for (const method of methods) {
    if (typeof store[method] !== "function") throw new Error(`OmpClaw store does not support automation method ${method}`);
  }
  return store as GatewayScheduledJobStore;
}

function isTurnLifecycleStore(store: GatewayApplicationStore): store is GatewayApplicationStore & GatewayTurnLifecycleStore {
  return (
    typeof store.putTurnLifecycle === "function" &&
    typeof store.interruptActiveTurns === "function" &&
    typeof store.listTurnLifecycles === "function"
  );
}
