import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireLock, releaseLock, startLockHeartbeat } from "./transports/telegram/bot-api";
import {
  gatewayRpcRuntimeConfig,
  resolveGatewaySecrets,
  type GatewayConfig,
  type GatewaySecrets,
} from "./gateway-config";
import { GatewayCore, type GatewayCoreOptions } from "./gateway-core";
import {
  GatewayIngressComposer,
  type GatewayIngressComposerOptions,
  type GatewayIngressCompositionStore,
} from "./gateway-ingress-composer";
import {
  GatewayProjectRouter,
  formatProjectList,
  formatProjectResolution,
  type GatewayProjectCommand,
  type GatewayProjectSelection,
} from "./gateway-projects";
import { GatewayPairingService, type GatewayPairingPersistence } from "./gateway-pairing";
import {
  GatewayQuickLane,
  QuickLaneStoppedError,
  type GatewayQuickLaneHandleResult,
  type GatewayQuickLaneOptions,
  type GatewayQuickLaneRoute,
} from "./gateway-quicklane";
import type { GatewayDelivery } from "./gateway-tools";
import {
  GatewayScheduler,
  ScheduledDispatchBusyError,
  type GatewayAutomationControl,
  type GatewayScheduledJobStore,
  type GatewaySchedulerOptions,
} from "./gateway-scheduler";
import {
  type InboundCheckpointClaim,
  GatewayStore,
  type ConversationBinding,
  type GatewayCommandCatalogStore,
  type GatewayTurnLifecycleStore,
  type JsonValue,
  type ScheduledJob,
  type TurnLifecycle,
  type TurnTimelineEvent,
} from "./gateway-store";
import type { ConversationAddress, InboundMessage, Principal, TransportAdapter, TransportIdentity } from "./gateway-types";
import { RpcGatewayRuntime, runtimeCommandMenu, type RpcGatewayRuntimeOptions } from "./rpc-runtime";
import { createProjectExecutor } from "./execution-worker";
import type { RpcSessionState } from "./rpc-protocol";
import { prepareInheritedHarness, prepareLearningOverlay } from "./rpc-profile";
import { GatewayUpdateCoordinator, currentGatewayRelease, gatewayUpdatePaths } from "./gateway-update";
import { TelegramTransportAdapter, type TelegramTransportAdapterOptions } from "./transports/telegram/adapter";
import { WebSocketTransportAdapter, type WebSocketTransportOptions } from "./transports/websocket/adapter";

export interface GatewayApplicationStore
  extends GatewayIngressCompositionStore,
    GatewayPairingPersistence,
    Partial<GatewayScheduledJobStore>,
    Partial<GatewayTurnLifecycleStore> {
  close(): void;
  resolvePrincipal(identity: TransportIdentity): Principal | undefined;
  getCheckpoint(adapter: string, key: string): JsonValue | undefined;
  setCheckpoint(adapter: string, key: string, value: JsonValue): void;
  claimInboundMessage: GatewayStore["claimInboundMessage"];
  completeInboundMessage: GatewayStore["completeInboundMessage"];
  listPendingInboundMessages: GatewayStore["listPendingInboundMessages"];
  releaseInboundMessage: GatewayStore["releaseInboundMessage"];
  bindConversation(binding: ConversationBinding): void;
  getConversationBinding(address: InboundMessage["address"]): ConversationBinding | undefined;
  getSharedConversationSessionPath?(): string | undefined;
  migrateTelegramTopicSessions?(account: string): number;
  claimInboundMessageConsumingCheckpoint?: (
    message: InboundMessage,
    receivedAt: number,
    checkpoint: InboundCheckpointClaim,
    scheduled?: boolean,
  ) => "claimed" | "duplicate" | "checkpoint_changed";
  migrateTelegramUpdateCheckpoint?(account: string): boolean;
  putPendingInteraction: GatewayStore["putPendingInteraction"];
  deletePendingInteraction: GatewayStore["deletePendingInteraction"];
  listPendingInteractions: GatewayStore["listPendingInteractions"];
  getSemanticView: GatewayStore["getSemanticView"];
  putSemanticView: GatewayStore["putSemanticView"];
  getTurnLifecycle?(turnId: string): TurnLifecycle | undefined;
  listTurnTimelineEvents?(turnId: string, limit?: number): TurnTimelineEvent[];
  getSemanticViewByReceipt: GatewayStore["getSemanticViewByReceipt"];
  listOmpAvailableCommands?: GatewayCommandCatalogStore["listOmpAvailableCommands"];
  recordCommandUsage?: GatewayCommandCatalogStore["recordCommandUsage"];
  listRecentCommandUsage?: GatewayCommandCatalogStore["listRecentCommandUsage"];
  replaceOmpAvailableCommands?: GatewayCommandCatalogStore["replaceOmpAvailableCommands"];
}

export interface GatewayRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleInbound(message: InboundMessage): Promise<void>;
  handleScheduled?(message: InboundMessage): Promise<void>;
  isBusy?(): boolean;
  waitUntilIdle?(): Promise<void>;
  canHandleInboundImmediately?(message: InboundMessage): boolean;
  isActiveConversation?(message: InboundMessage): boolean;
  notifyInboundQueued?(message: InboundMessage): Promise<void>;
  newSession?(name?: string): Promise<boolean>;
  switchSession?(sessionPath: string): Promise<boolean>;
  selectProject?(context: InboundMessage["execution"], sessionFile?: string): Promise<void>;
  showHome?(message: InboundMessage): Promise<void>;
}

export interface GatewayQuickLaneRuntime {
  routeFor(message: InboundMessage): GatewayQuickLaneRoute | undefined;
  handle(message: InboundMessage, route: GatewayQuickLaneRoute): Promise<GatewayQuickLaneHandleResult>;
  stop(): Promise<void>;
  isArmed(address: ConversationAddress): boolean;
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
  readonly createQuickLane?: (options: GatewayQuickLaneOptions) => GatewayQuickLaneRuntime;
  readonly createTelegramAdapter?: (options: TelegramTransportAdapterOptions) => TransportAdapter;
  readonly createWebSocketAdapter?: (options: WebSocketTransportOptions) => TransportAdapter;
  readonly createScheduler?: (options: GatewaySchedulerOptions) => GatewaySchedulerRuntime;
  /**
   * Test seam for deterministic ingress composition timing. Production uses
   * the composer's defaults.
   */
  readonly ingressComposer?: Omit<GatewayIngressComposerOptions, "store" | "deliver" | "now">;
  readonly acquireLock?: (path: string) => { readonly ok: true } | { readonly ok: false; readonly holder: number };
  readonly releaseLock?: (path: string) => void;
  readonly startLockHeartbeat?: (path: string) => () => void;
  readonly now?: () => number;
  readonly inboundRetryDelayMs?: number;
  readonly onInboundDispatchError?: (message: InboundMessage, error: unknown) => void;
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

interface PendingInboundCompletion {
  readonly sessionFile: string;
  readonly associateSession: boolean;
  readonly updateSharedSession: boolean;
  readonly projectSelection?: GatewayProjectSelection;
}

/**
 * One process owns the main OMP RPC session and an optional lazy quick-answer
 * session. Transport adapters remain downstream of both RPC children.
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
  #quickLane: GatewayQuickLaneRuntime | undefined;
  #scheduler: GatewaySchedulerRuntime | undefined;
  #ingressComposer: GatewayIngressComposer | undefined;
  #updates: GatewayUpdateCoordinator | undefined;
  #releaseHeartbeat: (() => void) | undefined;
  #adapters: TransportAdapter[] = [];
  #sessionFile: string | undefined;
  #sharedSessionFile: string | undefined;
  #projects: GatewayProjectRouter | undefined;
  #dispatchTail: Promise<void> = Promise.resolve();
  #dispatchReady: Promise<void> = Promise.resolve();
  #releaseDispatchReady: (() => void) | undefined;
  #dispatchAbort: AbortController | undefined;
  #pendingDispatches = new Map<string, Promise<void>>();
  #pendingInboundCompletions = new Map<string, PendingInboundCompletion>();
  #inboundRetryDelays = new Map<string, number>();
  #queuedInboundCount = 0;

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
    this.#dispatchTail = Promise.resolve();
    this.#pendingDispatches.clear();
    this.#queuedInboundCount = 0;
    this.#dispatchAbort = new AbortController();
    this.#dispatchReady = new Promise<void>((resolve) => {
      this.#releaseDispatchReady = resolve;
    });

    let lockHeld = false;
    try {
      const lock = (this.#seams.acquireLock ?? acquireLock)(this.#lockPath);
      if (!lock.ok) throw new Error(`OmpClaw is already running in process ${lock.holder}`);
      lockHeld = true;
      this.#releaseHeartbeat = (this.#seams.startLockHeartbeat ?? startLockHeartbeat)(this.#lockPath);
      const store = (this.#seams.createStore ?? ((path: string) => new GatewayStore(path)))(this.#databasePath);
      this.#store = store;
      const projectsConfigured = (this.#config.projects?.length ?? 0) > 0;
      this.#projects = projectsConfigured
        ? new GatewayProjectRouter({
            projects: this.#config.projects,
            store,
            ...(this.#seams.now === undefined ? {} : { now: this.#seams.now }),
          })
        : undefined;
      const telegram = this.#config.transports.telegram;
      if (telegram?.enabled) store.migrateTelegramUpdateCheckpoint?.(telegram.account);
      const topicSessions = !projectsConfigured && telegram?.enabled === true && telegram.topicSessions.enabled;
      if (topicSessions) store.migrateTelegramTopicSessions?.(telegram.account);
      const checkpoint = projectsConfigured ? undefined : store.getCheckpoint("omp", "session_file");
      if (checkpoint !== undefined && (typeof checkpoint !== "string" || checkpoint.length === 0)) {
        throw new Error("OMP session checkpoint must be a non-empty string");
      }
      const sharedCheckpoint = topicSessions ? store.getCheckpoint("omp", "shared_session_file") : undefined;
      if (sharedCheckpoint !== undefined && (typeof sharedCheckpoint !== "string" || sharedCheckpoint.length === 0)) {
        throw new Error("OMP shared session checkpoint must be a non-empty string");
      }
      this.#sharedSessionFile =
        sharedCheckpoint ?? (topicSessions ? store.getSharedConversationSessionPath?.() : undefined);
      this.#sessionFile = checkpoint ?? this.#sharedSessionFile;
      const core = (this.#seams.createCore ?? ((options: GatewayCoreOptions) => new GatewayCore(options)))({
        identityResolver: (identity) => store.resolvePrincipal(identity),
        onInbound: (message) => this.#acceptInbound(message),
      });
      this.#core = core;
      this.#quickLane = (
        this.#seams.createQuickLane ?? ((options: GatewayQuickLaneOptions) => new GatewayQuickLane(options))
      )({
        config: this.#config,
        delivery: core,
        readyTimeoutMs: this.#config.updates.healthTimeoutMs,
      });

      const secrets = this.#providedSecrets ?? resolveGatewaySecrets(this.#config);
      this.#adapters = this.#createAdapters(store, secrets);
      for (const adapter of this.#adapters) core.register(adapter);

      let scheduler: GatewaySchedulerRuntime | undefined;
      if (this.#config.automation.enabled) {
        const scheduledStore = requireScheduledStore(store);
        scheduler = (
          this.#seams.createScheduler ?? ((options: GatewaySchedulerOptions) => new GatewayScheduler(options))
        )({
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
      if (learningOverlay !== undefined)
        rpcConfig = { ...rpcConfig, configFiles: [...rpcConfig.configFiles, learningOverlay] };
      const executor = projectsConfigured
        ? createProjectExecutor(this.#config.projects ?? [], this.#config.workers ?? [])
        : undefined;
      const updates = this.#config.updates.enabled
        ? new GatewayUpdateCoordinator({
            config: this.#config.updates,
            stateDir: this.#config.stateDir,
            activationEnabled: () => isSupervisorManagedUpdateProcess(this.#config.stateDir),
          })
        : undefined;
      await updates?.discardArmed();
      this.#updates = updates;
      const runtime = (
        this.#seams.createRuntime ?? ((options: RpcGatewayRuntimeOptions) => new RpcGatewayRuntime(options))
      )({
        config: rpcConfig,
        delivery: core,
        sessionFile: this.#sessionFile,
        isQuickAskArmed: (address) => this.#quickLane?.isArmed(address) === true,
        onSessionState: (session) => this.#recordSessionState(session),
        ...(scheduler === undefined ? {} : { automation: scheduler }),
        ...(updates === undefined ? {} : { updates }),
        readyTimeoutMs: this.#config.updates.healthTimeoutMs,
        ...(isTurnLifecycleStore(store) ? { turnStore: store } : {}),
        ...(executor === undefined ? {} : { executor }),
        ...(this.#projects === undefined
          ? {}
          : {
              resolveExecution: (stored, principal, address) =>
                this.#projects?.renewExecution(stored, principal, address),
            }),
        ...(this.#projects === undefined
          ? {}
          : {
              authorizeExecution: (context, principal) =>
                this.#projects?.authorizeExecution(context, principal) === true,
            }),
      });
      this.#runtime = runtime;
      this.#ingressComposer = new GatewayIngressComposer({
        ...(this.#seams.ingressComposer ?? {}),
        ...(this.#seams.now === undefined ? {} : { now: this.#seams.now }),
        store,
        deliver: (message) => this.#handleInbound(message),
      });

      // OMP starts before the core makes a transport reachable.
      await runtime.start();
      if (topicSessions && this.#sharedSessionFile === undefined) this.#sharedSessionFile = this.#sessionFile;
      this.#checkpointSession();
      this.#checkpointSharedSession();
      this.#ingressComposer.start();
      for (const pending of store.listPendingInboundMessages()) {
        if (pending.scheduled) continue;
        const lifecycle = store.getTurnLifecycle?.(pending.message.id);
        const timeline = store.listTurnTimelineEvents?.(pending.message.id, 1) ?? [];
        if (
          lifecycle?.state === "queued" ||
          lifecycle?.state === "running" ||
          lifecycle?.state === "interrupted" ||
          timeline.length > 0
        ) {
          if (
            !store.completeInboundMessage(
              pending.message.address.transport,
              pending.message.address.account,
              pending.message.id,
            )
          ) {
            throw new Error(`Interrupted inbound ${pending.message.id} disappeared during startup reconciliation`);
          }
          continue;
        }
        this.#schedulePendingInbound(pending.message, false);
      }
      await core.start(signal);
      this.#state = "started";
      this.#releaseDispatchReady?.();
      this.#releaseDispatchReady = undefined;
      scheduler?.start();
      void updates?.reconcile(core).catch((error: unknown) => {
        console.error(
          `[ompclaw update] reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
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
      adapters.push(
        (
          this.#seams.createTelegramAdapter ??
          ((options: TelegramTransportAdapterOptions) => new TelegramTransportAdapter(options))
        )({
          token: secrets.telegramToken,
          account: telegram.account,
          stateDir: this.#config.stateDir,
          store,
          pairing: new GatewayPairingService(store),
          commands: runtimeCommandMenu(this.#config.omp.allowRpcBash),
          allowRpcBash: this.#config.omp.allowRpcBash,
          createTopicsFromRoot: telegram.topicSessions.enabled && telegram.topicSessions.createFromRoot,
          ...(telegram.transcribeCommand === undefined ? {} : { transcribeCommand: telegram.transcribeCommand }),
        }),
      );
    }

    const websocket = this.#config.transports.websocket;
    if (websocket?.enabled) {
      if (secrets.webSocketCredentials.length !== websocket.credentials.length) {
        throw new Error("WebSocket credential resolution does not match configured credentials");
      }
      adapters.push(
        (
          this.#seams.createWebSocketAdapter ??
          ((options: WebSocketTransportOptions) => new WebSocketTransportAdapter(options))
        )({
          hostname: websocket.hostname,
          port: websocket.port,
          account: websocket.account,
          credentials: secrets.webSocketCredentials,
        }),
      );
    }
    return adapters;
  }

  async #acceptInbound(message: InboundMessage): Promise<void> {
    const composer = this.#ingressComposer;
    if (composer === undefined) throw new Error("Ingress composer is not started");
    await composer.accept(message);
  }

  async #handleInbound(message: InboundMessage): Promise<void> {
    const store = this.#requireStore();
    const runtime = this.#requireRuntime();
    const router = this.#projects;
    let queuedMessage = message;
    let scopeClaim: InboundCheckpointClaim | undefined;
    const principal = store.resolvePrincipal(message.identity);
    if (router !== undefined && principal !== undefined && principal.id === message.principal.id) {
      const authorizedMessage = { ...message, principal };
      if (router.commandFor(authorizedMessage) === undefined) {
        const capture = router.captureTask(authorizedMessage);
        if (capture.resolution.kind === "unavailable") {
          await this.#requireCore().send(
            authorizedMessage.address,
            { text: formatProjectResolution(capture.resolution), format: "text" },
            { principal, origin: authorizedMessage.address },
          );
          return;
        }
        if (capture.resolution.kind === "selected") {
          queuedMessage = { ...authorizedMessage, execution: capture.resolution.selection.context };
          scopeClaim = capture.scopeClaim;
        }
      }
    }
    const receivedAt = (this.#seams.now ?? Date.now)();
    if (scopeClaim === undefined) {
      if (!store.claimInboundMessage(queuedMessage, receivedAt)) return;
    } else {
      if (store.claimInboundMessageConsumingCheckpoint === undefined) {
        throw new Error("Gateway store does not support atomic scoped task claims");
      }
      const result = store.claimInboundMessageConsumingCheckpoint(queuedMessage, receivedAt, scopeClaim);
      if (result !== "claimed") return;
    }

    const projectCommand = router?.commandFor(queuedMessage);
    const projectScoped =
      queuedMessage.execution !== undefined ||
      (router !== undefined && router.resolveCaptured(queuedMessage).kind !== "none");
    const quickRoute =
      projectCommand === undefined && !projectScoped ? this.#quickLane?.routeFor(queuedMessage) : undefined;
    const immediate = quickRoute !== undefined || runtime.canHandleInboundImmediately?.(queuedMessage) === true;
    const delayed = !immediate && (this.#queuedInboundCount > 0 || runtime.isBusy?.() === true);
    const ready =
      delayed && runtime.notifyInboundQueued !== undefined
        ? runtime.notifyInboundQueued(queuedMessage).catch((error) => {
            this.#reportInboundDispatchError(queuedMessage, error);
          })
        : Promise.resolve();
    this.#schedulePendingInbound(queuedMessage, immediate, ready);
    await ready;
  }

  #schedulePendingInbound(message: InboundMessage, immediate: boolean, ready: Promise<void> = Promise.resolve()): void {
    const key = this.#inboundKey(message);
    if (this.#pendingDispatches.has(key)) return;

    let work: Promise<void>;
    if (immediate) {
      work = ready.then(() => this.#retryPendingInbound(message, true));
    } else {
      this.#queuedInboundCount += 1;
      work = this.#dispatchTail
        .then(() => ready)
        .then(() => this.#retryPendingInbound(message, false))
        .finally(() => {
          this.#queuedInboundCount -= 1;
        });
      this.#dispatchTail = work.catch(() => undefined);
    }
    this.#pendingDispatches.set(key, work);
    void work
      .finally(() => {
        if (this.#pendingDispatches.get(key) === work) this.#pendingDispatches.delete(key);
      })
      .catch(() => undefined);
  }

  async #retryPendingInbound(message: InboundMessage, immediate: boolean): Promise<void> {
    await this.#dispatchReady;
    if (this.#state !== "starting" && this.#state !== "started") return;
    const key = this.#inboundKey(message);
    try {
      await this.#dispatchPendingInbound(message, immediate, false);
      this.#pendingInboundCompletions.delete(key);
      this.#inboundRetryDelays.delete(key);
    } catch (error) {
      this.#reportInboundDispatchError(message, error);
      if (this.#state !== "starting" && this.#state !== "started") return;
      const retryDelay = this.#inboundRetryDelays.get(key) ?? this.#seams.inboundRetryDelayMs ?? 1_000;
      this.#inboundRetryDelays.set(key, Math.min(retryDelay * 2, 15_000));
      void delay(retryDelay, undefined, { signal: this.#dispatchAbort?.signal })
        .then(() => {
          if (this.#state === "starting" || this.#state === "started") {
            this.#schedulePendingInbound(message, immediate);
          }
        })
        .catch(() => undefined);
    }
  }

  async #dispatchPendingInbound(message: InboundMessage, immediate: boolean, scheduled: boolean): Promise<void> {
    const store = this.#requireStore();
    const runtime = this.#requireRuntime();
    const key = this.#inboundKey(message);
    const quickLane = this.#quickLane;
    const requestedQuickRoute = scheduled ? undefined : quickLane?.routeFor(message);
    const principal = this.#resolvePendingPrincipal(store, message);
    if (principal === undefined) return;
    let authorizedMessage: InboundMessage = { ...message, principal };
    const router = this.#projects;
    const projectCommand = scheduled ? undefined : router?.commandFor(authorizedMessage);
    if (projectCommand !== undefined && router !== undefined) {
      await this.#respondToProjectCommand(router, authorizedMessage, projectCommand);
      if (!store.completeInboundMessage(message.address.transport, message.address.account, message.id)) {
        throw new Error(`Project command ${message.id} disappeared before completion`);
      }
      return;
    }

    const projectResolution = router?.resolveCaptured(authorizedMessage);
    if (router !== undefined && projectResolution?.kind === "none") {
      await this.#requireCore().send(
        authorizedMessage.address,
        { text: "Choose an authorized project with /projects before sending work.", format: "text" },
        { principal, origin: authorizedMessage.address },
      );
      if (!store.completeInboundMessage(message.address.transport, message.address.account, message.id)) {
        throw new Error(`Unbound project request ${message.id} disappeared before completion`);
      }
      return;
    }
    if (projectResolution?.kind === "unavailable") {
      await this.#requireCore().send(
        authorizedMessage.address,
        { text: formatProjectResolution(projectResolution), format: "text" },
        { principal, origin: authorizedMessage.address },
      );
      if (!store.completeInboundMessage(message.address.transport, message.address.account, message.id)) {
        throw new Error(`Unavailable project request ${message.id} disappeared before completion`);
      }
      return;
    }
    const projectSelection = projectResolution?.kind === "selected" ? projectResolution.selection : undefined;
    if (projectSelection !== undefined && requestedQuickRoute !== undefined && requestedQuickRoute.kind !== "query") {
      await this.#requireCore().send(
        authorizedMessage.address,
        {
          text: "Quick ask is unavailable while a project is selected. Send the project request directly.",
          format: "text",
        },
        { principal, origin: authorizedMessage.address },
      );
      if (!store.completeInboundMessage(message.address.transport, message.address.account, message.id)) {
        throw new Error(`Scoped quick request ${message.id} disappeared before completion`);
      }
      return;
    }
    const quickRoute = projectSelection === undefined ? requestedQuickRoute : undefined;
    if (quickRoute !== undefined && quickLane !== undefined) {
      try {
        const result = await quickLane.handle(authorizedMessage, quickRoute);
        if (result.armChanged) await runtime.showHome?.(authorizedMessage);
      } catch (error) {
        if (!(error instanceof QuickLaneStoppedError) || this.#state !== "stopping") throw error;
        // Quick turns deliberately do not survive gateway shutdown or replay on restart.
        if (!store.completeInboundMessage(message.address.transport, message.address.account, message.id)) {
          throw new Error(`Interrupted quick inbound message ${message.id} disappeared before completion`);
        }
        console.warn(`[ompclaw quick] dropped interrupted quick request ${message.id} during gateway shutdown`);
        return;
      }
      if (!store.completeInboundMessage(message.address.transport, message.address.account, message.id)) {
        throw new Error(`Quick inbound message ${message.id} disappeared before completion`);
      }
      return;
    }

    let completion = this.#pendingInboundCompletions.get(key);
    if (completion === undefined) {
      const dispatchImmediately =
        projectSelection === undefined &&
        (immediate || (!scheduled && runtime.canHandleInboundImmediately?.(message) === true));
      if (!dispatchImmediately) await this.#waitUntilSessionMutable(runtime, "dispatch the next queued conversation");
      const currentPrincipal = this.#resolvePendingPrincipal(store, message);
      if (currentPrincipal === undefined) return;
      authorizedMessage = { ...authorizedMessage, principal: currentPrincipal };

      const topicSessions =
        this.#projects === undefined && this.#config.transports.telegram?.topicSessions.enabled === true;
      const associateSession = projectSelection === undefined && (!topicSessions || !dispatchImmediately);
      if (projectSelection !== undefined) {
        if (runtime.selectProject === undefined) throw new Error("OMP runtime does not support project selection");
        await runtime.selectProject(projectSelection.context, projectSelection.sessionFile);
        if (requestedQuickRoute?.kind === "query") {
          authorizedMessage = {
            ...authorizedMessage,
            content: { ...authorizedMessage.content, text: requestedQuickRoute.prompt },
          };
        }
      } else if (topicSessions && !dispatchImmediately) {
        await this.#selectConversationSession(store, runtime, authorizedMessage);
        const currentPrincipal = this.#resolvePendingPrincipal(store, message);
        if (currentPrincipal === undefined) return;
        authorizedMessage = { ...authorizedMessage, principal: currentPrincipal };
      }
      if (scheduled && runtime.handleScheduled !== undefined) await runtime.handleScheduled(authorizedMessage);
      else await runtime.handleInbound(authorizedMessage);

      const sessionFile = this.#sessionFile;
      if (sessionFile === undefined) throw new Error("OMP runtime did not report its current session file");
      completion = {
        sessionFile,
        associateSession,
        updateSharedSession: topicSessions && !this.#isTopicAddress(message.address) && associateSession,
        ...(projectSelection === undefined ? {} : { projectSelection }),
      };
      this.#pendingInboundCompletions.set(key, completion);
    }

    if (completion.projectSelection !== undefined) {
      if (router === undefined) throw new Error("Project selection completed without a project router");
      router.checkpointSession(message, completion.projectSelection, completion.sessionFile);
    } else if (completion.associateSession) {
      store.bindConversation({
        address: message.address,
        ompSessionPath: completion.sessionFile,
        workspace: this.#config.workspace,
      });
    }
    if (completion.updateSharedSession) {
      this.#sharedSessionFile = completion.sessionFile;
      store.setCheckpoint("omp", "shared_session_file", completion.sessionFile);
    }
    if (this.#projects === undefined && this.#sessionFile === completion.sessionFile) {
      store.setCheckpoint("omp", "session_file", completion.sessionFile);
    }
    if (!store.completeInboundMessage(message.address.transport, message.address.account, message.id)) {
      throw new Error(`Pending inbound message ${message.id} disappeared before completion`);
    }
    this.#pendingInboundCompletions.delete(key);
  }

  async #respondToProjectCommand(
    router: GatewayProjectRouter,
    message: InboundMessage,
    command: GatewayProjectCommand,
  ): Promise<void> {
    const core = this.#requireCore();
    let text: string;
    switch (command.kind) {
      case "list": {
        const projects = router.list(message.principal);
        const current = router.resolve(message);
        const response = await core.presentUi(
          message.address,
          {
            type: "select",
            presentation: "picker",
            title:
              current.kind === "selected" ? `Projects — current: ${current.selection.context.projectName}` : "Projects",
            options: projects.map((project) => ({
              value: `/project ${project.id}`,
              label: project.name,
              description: `${project.id} · host ${project.workerId}${current.kind === "selected" && current.selection.context.projectId === project.id ? " · current" : ""}`,
            })),
          },
          { principal: message.principal, origin: message.address },
        );
        const selected = response.type === "select" ? response.selected[0] : undefined;
        const selectedCommand =
          selected === undefined
            ? undefined
            : router.commandFor({ ...message, content: { ...message.content, text: selected } });
        text =
          selectedCommand?.kind === "select"
            ? formatProjectResolution(router.select(message, selectedCommand.projectId))
            : formatProjectList(projects);
        break;
      }
      case "show":
        text = formatProjectResolution(router.resolve(message));
        break;
      case "select":
        text = formatProjectResolution(router.select(message, command.projectId));
        break;
      case "scope-show":
        text = router.scopeStatus(message);
        break;
      case "scope-set": {
        const result = router.setNextScope(message, command.mode, command.minutes);
        text = "text" in result ? result.text : formatProjectResolution(result);
        break;
      }
      case "usage":
        text = "Usage: /projects, /project <id>, or /scope [read|work|network] [minutes]";
        break;
    }
    await core.send(
      message.address,
      { text, format: "text" },
      { principal: message.principal, origin: message.address },
    );
  }
  #resolvePendingPrincipal(store: GatewayApplicationStore, message: InboundMessage): Principal | undefined {
    const principal = store.resolvePrincipal(message.identity);
    if (principal !== undefined && principal.id === message.principal.id) return principal;
    if (!store.completeInboundMessage(message.address.transport, message.address.account, message.id)) {
      throw new Error(`Unauthorized pending inbound message ${message.id} disappeared before rejection`);
    }
    console.warn(
      `[ompclaw] discarded pending inbound ${message.address.transport}/${message.address.account}/${message.id}; identity authorization changed`,
    );
    return undefined;
  }

  #inboundKey(message: InboundMessage): string {
    return `${message.address.transport}\u0000${message.address.account}\u0000${message.id}`;
  }

  #reportInboundDispatchError(message: InboundMessage, error: unknown): void {
    if (this.#seams.onInboundDispatchError !== undefined) {
      this.#seams.onInboundDispatchError(message, error);
      return;
    }
    console.warn(
      `[ompclaw] inbound ${message.address.transport}/${message.address.account}/${message.id} dispatch failed; retrying:`,
      error,
    );
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
      if (runtime.switchSession === undefined)
        throw new Error("OMP runtime does not support conversation session switching");
      await this.#waitUntilSessionMutable(runtime, "switch conversation sessions");
      const switched = await runtime.switchSession(binding.ompSessionPath);
      if (!switched) throw new Error(`OMP cancelled the session switch for ${binding.ompSessionPath}`);
      return;
    }

    if (!this.#isTopicAddress(message.address)) {
      const sharedSession = this.#sharedSessionFile ?? store.getSharedConversationSessionPath?.();
      if (sharedSession === undefined || sharedSession === currentSession) return;
      if (runtime.switchSession === undefined)
        throw new Error("OMP runtime does not support conversation session switching");
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
    if (runtime.isBusy?.() || this.#queuedInboundCount > 0) {
      throw new ScheduledDispatchBusyError("OMP is serving another turn");
    }
    const store = this.#requireStore();
    const principal = store.resolvePrincipal(job.identity);
    if (principal === undefined || principal.id !== job.principalId) {
      throw new Error(`Scheduled job ${job.id} no longer has an authorized principal`);
    }
    const message: InboundMessage = {
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
    };
    store.releaseInboundMessage(message.address.transport, message.address.account, message.id);
    if (!store.claimInboundMessage(message, (this.#seams.now ?? Date.now)(), true)) return;
    try {
      await this.#dispatchPendingInbound(message, false, true);
    } catch (error) {
      store.releaseInboundMessage(message.address.transport, message.address.account, message.id);
      throw error;
    }
  }

  async #notifyScheduledFailure(job: ScheduledJob, error: Error): Promise<void> {
    const principal = this.#requireStore().resolvePrincipal(job.identity);
    const core = this.#core;
    if (principal === undefined || principal.id !== job.principalId || core === undefined) return;
    await core.send(
      job.address,
      {
        text: `Scheduled job "${job.name}" failed after ${this.#config.automation.maxAttempts} attempts: ${error.message}`,
        format: "text",
      },
      { principal, origin: job.address },
    );
  }

  #recordSessionState(state: RpcSessionState): void {
    if (typeof state.sessionFile === "string" && state.sessionFile.length > 0) this.#sessionFile = state.sessionFile;
  }

  #checkpointSession(): void {
    if (this.#projects === undefined && this.#sessionFile !== undefined) {
      this.#requireStore().setCheckpoint("omp", "session_file", this.#sessionFile);
    }
  }

  #checkpointSharedSession(): void {
    if (this.#sharedSessionFile !== undefined) {
      this.#requireStore().setCheckpoint("omp", "shared_session_file", this.#sharedSessionFile);
    }
  }
  async #rollbackStart(lockHeld: boolean): Promise<void> {
    this.#state = "stopping";
    await this.#stopResources(lockHeld);
    this.#state = "idle";
  }

  async #stopResources(lockHeld = true): Promise<unknown> {
    let firstError: unknown;
    const remember = (error: unknown): void => {
      firstError ??= error;
    };
    this.#dispatchAbort?.abort();
    this.#dispatchAbort = undefined;
    this.#releaseDispatchReady?.();
    this.#releaseDispatchReady = undefined;

    const scheduler = this.#scheduler;
    this.#scheduler = undefined;
    if (scheduler !== undefined) {
      try {
        scheduler.stop();
      } catch (error) {
        remember(error);
      }
    }

    const quickLane = this.#quickLane;
    this.#quickLane = undefined;
    if (quickLane !== undefined) {
      try {
        await quickLane.stop();
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
    const ingressComposer = this.#ingressComposer;
    this.#ingressComposer = undefined;
    if (ingressComposer !== undefined) {
      try {
        ingressComposer.stop();
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

    const pendingDispatches = [...this.#pendingDispatches.values()];
    if (pendingDispatches.length > 0) await Promise.allSettled(pendingDispatches);
    this.#pendingDispatches.clear();
    this.#dispatchTail = Promise.resolve();
    this.#queuedInboundCount = 0;
    this.#pendingInboundCompletions.clear();
    this.#inboundRetryDelays.clear();

    this.#updates?.stop();
    this.#updates = undefined;

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

  #requireCore(): GatewayCoreRuntime {
    if (this.#core === undefined) throw new Error("OmpClaw core is not started");
    return this.#core;
  }

  #requireRuntime(): GatewayRuntime {
    if (this.#runtime === undefined) throw new Error("OmpClaw runtime is not started");
    return this.#runtime;
  }
}

export function gatewayDatabasePath(config: Pick<GatewayConfig, "stateDir">): string {
  return join(config.stateDir, "ompclaw.sqlite");
}

function isSupervisorManagedUpdateProcess(stateDir: string): boolean {
  const releaseId = process.env.OMPCLAW_RELEASE_ID;
  if (releaseId === undefined) return false;
  try {
    return currentGatewayRelease(gatewayUpdatePaths(stateDir)).id === releaseId;
  } catch {
    return false;
  }
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
    if (typeof store[method] !== "function")
      throw new Error(`OmpClaw store does not support automation method ${method}`);
  }
  return store as GatewayScheduledJobStore;
}

function isTurnLifecycleStore(
  store: GatewayApplicationStore,
): store is GatewayApplicationStore & GatewayTurnLifecycleStore {
  return (
    typeof store.putTurnLifecycle === "function" &&
    typeof store.interruptActiveTurns === "function" &&
    typeof store.listTurnLifecycles === "function"
  );
}
