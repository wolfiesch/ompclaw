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
import { GatewayStore, type ConversationBinding, type JsonValue } from "./gateway-store";
import type { InboundMessage, Principal, TransportAdapter, TransportIdentity } from "./gateway-types";
import { RpcGatewayRuntime, type RpcGatewayRuntimeOptions } from "./rpc-runtime";
import type { RpcSessionState } from "./rpc-protocol";
import { TelegramTransportAdapter, type TelegramTransportAdapterOptions } from "./transports/telegram/adapter";
import { WebSocketTransportAdapter, type WebSocketTransportOptions } from "./transports/websocket/adapter";

export interface GatewayApplicationStore {
  close(): void;
  resolvePrincipal(identity: TransportIdentity): Principal | undefined;
  getCheckpoint(adapter: string, key: string): JsonValue | undefined;
  setCheckpoint(adapter: string, key: string, value: JsonValue): void;
  claimInboundMessage(transport: string, account: string, messageId: string, receivedAt: number): boolean;
  releaseInboundMessage(transport: string, account: string, messageId: string): boolean;
  bindConversation(binding: ConversationBinding): void;
  putPendingInteraction: GatewayStore["putPendingInteraction"];
  deletePendingInteraction: GatewayStore["deletePendingInteraction"];
}

export interface GatewayRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleInbound(message: InboundMessage): Promise<void>;
}

export type GatewayCoreRuntime = GatewayDelivery & Pick<GatewayCore, "register" | "start" | "stop">;

export interface GatewayApplicationSeams {
  readonly createStore?: (path: string) => GatewayApplicationStore;
  readonly createCore?: (options: GatewayCoreOptions) => GatewayCoreRuntime;
  readonly createRuntime?: (options: RpcGatewayRuntimeOptions) => GatewayRuntime;
  readonly createTelegramAdapter?: (options: TelegramTransportAdapterOptions) => TransportAdapter;
  readonly createWebSocketAdapter?: (options: WebSocketTransportOptions) => TransportAdapter;
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
  #releaseHeartbeat: (() => void) | undefined;
  #adapters: TransportAdapter[] = [];
  #sessionFile: string | undefined;

  constructor(options: GatewayApplicationOptions) {
    this.#config = options.config;
    this.#providedSecrets = options.secrets;
    this.#seams = options.seams ?? {};
    this.#lockPath = resolve(options.config.stateDir, "gateway.lock");
    this.#databasePath = resolve(options.config.stateDir, "gateway.sqlite");
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
    if (this.#state !== "idle") throw new Error(`Gateway application cannot start while ${this.#state}`);
    this.#state = "starting";

    let lockHeld = false;
    try {
      const lock = (this.#seams.acquireLock ?? acquireLock)(this.#lockPath);
      if (!lock.ok) throw new Error(`Gateway is already running in process ${lock.holder}`);
      lockHeld = true;
      this.#releaseHeartbeat = (this.#seams.startLockHeartbeat ?? startLockHeartbeat)(this.#lockPath);

      const store = (this.#seams.createStore ?? ((path: string) => new GatewayStore(path)))(this.#databasePath);
      this.#store = store;
      const checkpoint = store.getCheckpoint("omp", "session_file");
      if (checkpoint !== undefined && (typeof checkpoint !== "string" || checkpoint.length === 0)) {
        throw new Error("OMP session checkpoint must be a non-empty string");
      }
      this.#sessionFile = checkpoint;

      const core = (this.#seams.createCore ?? ((options: GatewayCoreOptions) => new GatewayCore(options)))({
        identityResolver: (identity) => store.resolvePrincipal(identity),
        onInbound: (message) => this.#handleInbound(message),
      });
      this.#core = core;

      const secrets = this.#providedSecrets ?? resolveGatewaySecrets(this.#config);
      this.#adapters = this.#createAdapters(store, secrets);
      for (const adapter of this.#adapters) core.register(adapter);

      const runtime = (this.#seams.createRuntime ?? ((options: RpcGatewayRuntimeOptions) => new RpcGatewayRuntime(options)))({
        config: gatewayRpcRuntimeConfig(this.#config),
        delivery: core,
        sessionFile: this.#sessionFile,
        onSessionState: (session) => this.#recordSessionState(session),
      });
      this.#runtime = runtime;

      // OMP starts before the core makes a transport reachable.
      await runtime.start();
      this.#checkpointSession();
      await core.start(signal);
      this.#state = "started";
    } catch (error) {
      await this.#rollbackStart(lockHeld);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#state === "idle") return;
    if (this.#state === "stopping") return;
    if (this.#state === "starting") throw new Error("Gateway application cannot stop while starting");
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
    const store = this.#requireStore();
    const runtime = this.#requireRuntime();
    const { transport, account } = message.address;
    if (!store.claimInboundMessage(transport, account, message.id, (this.#seams.now ?? Date.now)())) return;

    try {
      await runtime.handleInbound(message);
      const sessionFile = this.#sessionFile;
      if (sessionFile === undefined) throw new Error("OMP runtime did not report its current session file");
      store.bindConversation({
        address: message.address,
        ompSessionPath: sessionFile,
        workspace: this.#config.workspace,
      });
      this.#checkpointSession();
    } catch (error) {
      // A failed turn has no durable dedupe or session/binding checkpoint, so its
      // exact upstream ID can be retried by the adapter.
      store.releaseInboundMessage(transport, account, message.id);
      throw error;
    }
  }

  #recordSessionState(state: RpcSessionState): void {
    if (typeof state.sessionFile === "string" && state.sessionFile.length > 0) this.#sessionFile = state.sessionFile;
  }

  #checkpointSession(): void {
    if (this.#sessionFile !== undefined) this.#requireStore().setCheckpoint("omp", "session_file", this.#sessionFile);
  }

  async #rollbackStart(lockHeld: boolean): Promise<void> {
    await this.#stopResources(lockHeld);
    this.#state = "idle";
  }

  async #stopResources(lockHeld = true): Promise<unknown> {
    let firstError: unknown;
    const remember = (error: unknown): void => { firstError ??= error; };

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
    return firstError;
  }

  #requireStore(): GatewayApplicationStore {
    if (this.#store === undefined) throw new Error("Gateway store is not started");
    return this.#store;
  }

  #requireRuntime(): GatewayRuntime {
    if (this.#runtime === undefined) throw new Error("Gateway runtime is not started");
    return this.#runtime;
  }
}

export function gatewayDatabasePath(config: Pick<GatewayConfig, "stateDir">): string {
  return join(config.stateDir, "gateway.sqlite");
}
