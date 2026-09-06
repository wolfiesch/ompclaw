import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ConversationAddress,
  InboundMessage,
  OutboundReceipt,
  Principal,
  TransportIdentity,
} from "./gateway-types";
import type {
  ExecutionOperation,
  ExecutionResult,
  ProjectExecutor,
  TaskEvidence,
  TaskExecutionContext,
} from "./execution-types";
import { executeGatewayHostTool, gatewayHostToolDefinitions, type GatewayDelivery } from "./gateway-tools";
import { ScheduledDispatchBusyError, type GatewayAutomationControl } from "./gateway-scheduler";
import type { GatewayUpdateControl } from "./gateway-update";
import type {
  GatewayCommandCatalogStore,
  GatewayPrincipalStore,
  GatewaySemanticViewStore,
  GatewayTurnLifecycleStore,
  GatewayTurnOutcomeStore,
  GatewayTurnTimelineStore,
  TurnLifecycle,
  TurnLifecycleState,
  TurnTimelineEventKind,
} from "./gateway-store";
import type { SemanticView } from "./gateway-views";
import {
  OmpRpcClient,
  RpcCommandError,
  type OmpRpcClientOptions,
  type RpcClient,
  type RpcCommandInput,
} from "./rpc-client";
import { type RpcRuntimeConfig, buildOmpChildEnv, buildOmpRpcArgv } from "./rpc-config";
import {
  type RpcExtensionUiRequest,
  type RpcHostToolCall,
  type RpcHostToolDefinition,
  type RpcRecord,
  type RpcResponse,
  type RpcSessionState,
  assistantText,
  finalAssistantText,
  isRpcExtensionUiRequest,
  isRpcHostToolCall,
  isRpcHostToolCancel,
  isRpcResponse,
} from "./rpc-protocol";
import { RpcGatewayUiBroker, type RpcGatewayUiTarget } from "./rpc-ui";
import {
  homeSemanticView,
  informationSemanticView,
  modelPageSemanticView,
  modelProviderSemanticView,
  moreSemanticView,
  scheduledJobDeleteConfirmSemanticView,
  scheduledJobDeleteSettledSemanticView,
  scheduledJobDetailSemanticView,
  scheduledJobsSemanticView,
  sessionChoiceSemanticView,
  taskHistorySemanticView,
  taskSemanticView,
  type TaskSemanticActivity,
  type TaskSemanticTodoPhase,
} from "./rpc-semantic-views";
import { isRecord } from "./type-guards";

import { CommandCatalog, type OmpAvailableCommand } from "./command-catalog";

import { formatPromptInput, type FormattedPromptInput } from "./rpc-prompt";
import {
  AUTONOMY_MODE_DESCRIPTIONS,
  AUTONOMY_MODE_LABELS,
  AUTONOMY_MODES,
  type AutonomyMode,
  CROSS_DELIVERY_COMMANDS,
  type ParsedCommand,
  SAME_DELIVERY_IMMEDIATE_COMMANDS,
  THINKING_LEVELS,
  activityForFrame,
  assistantWelcome,
  autonomyText,
  ompApprovalModeForAutonomy,
  parseAutonomyMode,
  parseSlashCommand,
  runtimeHelp,
  summarizeMessage,
  valueText,
} from "./rpc-commands";

export { runtimeCommandMenu, type RuntimeCommandMenuItem } from "./rpc-commands";
export interface RpcRuntimeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

type RpcRuntimeStore = GatewayTurnLifecycleStore &
  Partial<
    GatewayPrincipalStore &
      GatewayTurnOutcomeStore &
      Pick<GatewayCommandCatalogStore, "replaceOmpAvailableCommands"> &
      Pick<GatewaySemanticViewStore, "getSemanticView"> &
      GatewayTurnTimelineStore
  >;

export interface RpcGatewayRuntimeOptions {
  readonly config: RpcRuntimeConfig;
  readonly delivery: GatewayDelivery;
  readonly sessionFile?: string;
  readonly isQuickAskArmed?: (address: ConversationAddress) => boolean;
  readonly onSessionState?: (state: RpcSessionState) => void;
  readonly automation?: GatewayAutomationControl;
  readonly turnStore?: RpcRuntimeStore;
  readonly updates?: GatewayUpdateControl;
  readonly executor?: ProjectExecutor;
  /** Revalidates a durable project context against the current server configuration. */
  readonly authorizeExecution?: (context: TaskExecutionContext, principal: Principal) => boolean;
  /**
   * Resolves a stored project receipt against current server configuration and
   * the authenticated conversation without accepting client-selected scope.
   */
  readonly resolveExecution?: (
    stored: TaskExecutionContext,
    principal: Principal,
    address: ConversationAddress,
  ) => TaskExecutionContext | undefined;
  readonly now?: () => number;
  readonly readyTimeoutMs?: number;
  readonly createRpcClient?: (options: OmpRpcClientOptions) => RpcClient;
}

interface RuntimeStatus {
  state?: RpcSessionState;
  currentTool?: string;
  availableCommands: OmpAvailableCommand[];
  subagents: RpcRecord[];
  lastError?: string;
}

interface HostToolExecution {
  readonly controller: AbortController;
}

interface GatewayTurnTarget extends RpcGatewayUiTarget {
  readonly identity: TransportIdentity;
  readonly sourceReceipt?: OutboundReceipt;
}

interface ActiveTurnActivity extends TaskSemanticActivity {
  readonly toolName: string;
}

interface ActiveTurn extends GatewayTurnTarget {
  receipt?: OutboundReceipt;
  previewText?: string;
  finalText?: string;
  statusVisible?: boolean;
  lifecycle?: TurnLifecycle;
  activities: ActiveTurnActivity[];
  statusText?: string;
  statusUpdatedAt?: number;
  statusTimer?: NodeJS.Timeout;
  statusPending?: TurnLifecycle;
  statusQueued?: boolean;
  statusUrgent?: boolean;
  statusHeartbeat?: boolean;
  typingTimer?: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
  scheduledCompletion?: {
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  };
}

const require = createRequire(import.meta.url);
const packageVersion = (() => {
  try {
    const pkg = require("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
})();

const scopedExecutionHostTools: readonly RpcHostToolDefinition[] = [
  {
    name: "fs_list",
    label: "List project files",
    description: "List files within the selected project workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", minLength: 1 } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "fs_read",
    label: "Read project file",
    description: "Read a file within the selected project workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", minLength: 1 } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "fs_write",
    label: "Write project file",
    description: "Write a file within the selected project workspace when project policy permits it.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "cmd_run",
    label: "Run project command",
    description: "Run one approved command in the selected project sandbox.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1 },
        writable: { type: "boolean" },
        network: { type: "boolean" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "fs_diff",
    label: "Inspect project diff",
    description: "Read the actual Git diff for the selected project.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "artifact_store",
    label: "Collect project artifact",
    description: "Collect a bounded artifact from the selected project workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", minLength: 1 } },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

function taskTodoPhases(value: unknown): readonly TaskSemanticTodoPhase[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, phaseIndex) => {
    if (!isRecord(candidate) || !Array.isArray(candidate.tasks)) return [];
    const name =
      typeof candidate.name === "string" && candidate.name.trim().length > 0
        ? candidate.name.trim()
        : `Phase ${phaseIndex + 1}`;
    const tasks = candidate.tasks.flatMap((task) => {
      if (!isRecord(task) || typeof task.content !== "string" || task.content.trim().length === 0) return [];
      return [
        {
          content: task.content
            .replace(/[\u0000-\u001f\u007f]+/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
          status: typeof task.status === "string" ? task.status : "pending",
        },
      ];
    });
    return tasks.length === 0 ? [] : [{ name, tasks }];
  });
}

/** One persistent OMP RPC session served through authenticated gateway transports. */
export class RpcGatewayRuntime {
  readonly #options: RpcGatewayRuntimeOptions;
  readonly #log: RpcRuntimeLogger;
  readonly #viewVersions = new Map<string, number>();
  readonly #status: RuntimeStatus = { availableCommands: [], subagents: [] };
  #rpc: RpcClient | undefined;
  #ui: RpcGatewayUiBroker | undefined;
  #activeTurn: ActiveTurn | undefined;
  #sessionFile: string | undefined;
  readonly #baseProjectConfig: Readonly<Pick<RpcRuntimeConfig, "cwd" | "profile" | "sessionDir" | "resume" | "model">>;
  #execution: TaskExecutionContext | undefined;
  #projectContextApplied = false;
  #stopping = false;
  #recycling = false;
  #restartAttempt = 0;
  #restartTimer: NodeJS.Timeout | undefined;
  #promptQueue: Promise<void> = Promise.resolve();
  #frameQueue: Promise<void> = Promise.resolve();
  #turnCardQueue: Promise<void> = Promise.resolve();
  #conversationQueue: Promise<void> = Promise.resolve();
  #queuedConversationCount = 0;
  readonly #hostTools = new Map<string, HostToolExecution>();
  readonly #reactionQueues = new Map<string, Promise<void>>();
  readonly #idleWaiters = new Set<PromiseWithResolvers<void>>();
  static readonly #TURN_CARD_THROTTLE_MS = 1_250;
  static readonly #TURN_CARD_INITIAL_DELAY_MS = 2_000;
  static readonly #TURN_CARD_HEARTBEAT_MS = 45_000;
  static readonly #TYPING_REFRESH_MS = 4_000;

  constructor(options: RpcGatewayRuntimeOptions, logger: RpcRuntimeLogger = console) {
    this.#options = options;
    this.#log = logger;
    this.#sessionFile = options.sessionFile;
    this.#baseProjectConfig = {
      cwd: options.config.cwd,
      profile: options.config.profile,
      sessionDir: options.config.sessionDir,
      resume: options.config.resume,
      model: options.config.model,
    };
    this.#execution = options.config.execution;
  }

  async start(): Promise<void> {
    if (this.#rpc) throw new Error("RPC gateway runtime is already started");
    this.#stopping = false;
    await this.#applyProjectContext(this.#execution, this.#sessionFile);
    this.#options.turnStore?.interruptActiveTurns(this.#now());
    try {
      await this.#startRpc();
      await this.#recoverPendingTurnOutcomes();
      this.#log.info(`[ompclaw rpc] OMP ${this.#status.state?.sessionId ?? "session"} started`);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    this.#ui?.shutdown();
    this.#ui = undefined;
    this.#abortHostTools();
    const stopped = new Error("OMP runtime stopped");
    await this.#setTurnLifecycle("interrupted", { error: stopped.message });
    const active = this.#activeTurn;
    if (active) this.#stopTurnPresentation(active);
    this.#activeTurn = undefined;
    active?.scheduledCompletion?.reject(stopped);
    this.#failIdleWaiters(stopped);
    const rpc = this.#rpc;
    this.#rpc = undefined;
    await rpc?.stop();
    await this.#frameQueue;
    await this.#turnCardQueue;
  }
  #abortHostTools(): void {
    for (const execution of this.#hostTools.values()) execution.controller.abort();
    this.#hostTools.clear();
  }

  async handleInbound(message: InboundMessage): Promise<void> {
    const delivery = this.#deliveryFor(message);
    const scopedError = this.#scopedInboundError(message);
    if (scopedError !== undefined) {
      await this.#send(delivery, scopedError);
      return;
    }
    const parsed = parseSlashCommand(message.content.text);
    const active = this.#activeTurn;
    const sameActiveConversation = active !== undefined && this.#sameDelivery(active, delivery);
    if (sameActiveConversation && parsed === undefined) {
      return this.#deliverBusyInput(message, delivery);
    }
    const differentConversation = active !== undefined && !sameActiveConversation;
    if (differentConversation && parsed && CROSS_DELIVERY_COMMANDS.has(parsed.name)) {
      if (await this.#handleCommand(delivery, parsed.name, parsed.args)) return;
    }
    if (differentConversation || (active === undefined && this.#queuedConversationCount > 0)) {
      await this.#send(delivery, "Queued. This request has not started; it will run after earlier work finishes.");
      return this.#enqueueConversation(message, delivery, parsed);
    }

    if (parsed && (await this.#handleCommand(delivery, parsed.name, parsed.args))) return;

    await this.#startTurn(delivery, message);
    const prompt = this.#promptQueue.then(() => this.#deliverPrompt(message, delivery));
    this.#promptQueue = prompt.catch(() => {});
    return prompt;
  }

  isBusy(): boolean {
    return this.#currentTurnBusy() || this.#queuedConversationCount > 0;
  }

  canHandleInboundImmediately(message: InboundMessage): boolean {
    const parsed = parseSlashCommand(message.content.text);
    const active = this.#activeTurn;
    if (parsed === undefined) {
      return active !== undefined && this.#sameDelivery(active, this.#deliveryFor(message));
    }
    if (active !== undefined && this.#sameDelivery(active, this.#deliveryFor(message))) {
      return (
        SAME_DELIVERY_IMMEDIATE_COMMANDS.has(parsed.name) &&
        (parsed.name !== "abortbash" || this.#options.config.allowRpcBash)
      );
    }
    return CROSS_DELIVERY_COMMANDS.has(parsed.name);
  }

  isActiveConversation(message: InboundMessage): boolean {
    const active = this.#activeTurn;
    return active !== undefined && this.#sameDelivery(active, this.#deliveryFor(message));
  }

  async notifyInboundQueued(message: InboundMessage): Promise<void> {
    await this.#send(
      this.#deliveryFor(message),
      "Queued. This request has not started; it will run after earlier work finishes.",
    );
  }

  async waitUntilIdle(): Promise<void> {
    if (!this.#rpc?.running) throw new Error("OMP RPC is not running");
    do {
      await this.#waitUntilCurrentTurnIdle();
      await this.#conversationQueue;
    } while (this.#currentTurnBusy() || this.#queuedConversationCount > 0);
  }

  #currentTurnBusy(): boolean {
    return this.#activeTurn !== undefined || this.#status.state?.isStreaming === true;
  }

  async #waitUntilCurrentTurnIdle(): Promise<void> {
    if (!this.#rpc?.running) throw new Error("OMP RPC is not running");
    if (!this.#currentTurnBusy()) return;
    const waiter = Promise.withResolvers<void>();
    this.#idleWaiters.add(waiter);
    if (!this.#currentTurnBusy()) {
      this.#idleWaiters.delete(waiter);
      return;
    }
    try {
      await waiter.promise;
    } finally {
      this.#idleWaiters.delete(waiter);
    }
  }
  #enqueueConversation(
    message: InboundMessage,
    delivery: GatewayTurnTarget,
    parsed: ParsedCommand | undefined,
  ): Promise<void> {
    this.#queuedConversationCount += 1;
    const queued = this.#conversationQueue.then(async () => {
      await this.#waitUntilCurrentTurnIdle();
      if (parsed && (await this.#handleCommand(delivery, parsed.name, parsed.args))) return;
      await this.#startTurn(delivery, message);
      await this.#deliverPrompt(message, delivery);
    });
    const settled = queued.finally(() => {
      this.#queuedConversationCount -= 1;
    });
    this.#conversationQueue = settled.catch(async (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.#status.lastError = `Queued request failed: ${detail}`;
      await this.#send(
        delivery,
        "I couldn't start that queued request. Your original message is still here—send it again when you're ready.",
      ).catch(() => undefined);
    });
    return settled;
  }

  async newSession(name?: string): Promise<boolean> {
    const data = await this.#requestData<{ cancelled: boolean }>({ type: "new_session" });
    if (!data.cancelled) {
      this.#abortHostTools();
      this.#activeTurn = undefined;
    }
    if (!data.cancelled && name !== undefined) {
      await this.#sendRpc({ type: "set_session_name", name });
    }
    await this.#refreshStateRequired();
    return !data.cancelled;
  }

  /**
   * Selects the server-derived project execution context before its next prompt.
   * A saved session is accepted only while its owning project context is active.
   */
  async selectProject(context: TaskExecutionContext | undefined, sessionFile?: string): Promise<void> {
    if (sessionFile !== undefined && context === undefined) {
      throw new Error("A saved project session requires its selected project context");
    }
    if (this.isBusy()) throw new Error("Cannot switch project while a task is in progress");
    if (context?.expiresAt !== undefined && context.expiresAt <= this.#now()) {
      throw new Error(`Project ${context.projectName} execution grant has expired`);
    }
    if (
      this.#projectContextApplied &&
      this.#sameExecutionContext(this.#execution, context) &&
      this.#sessionFile === sessionFile &&
      this.#options.config.execution === context
    ) {
      return;
    }

    await this.#applyProjectContext(context, sessionFile);
    if (!this.#rpc) return;

    this.#recycling = true;
    clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    try {
      const oldRpc = this.#rpc;
      this.#rpc = undefined;
      this.#ui?.shutdown();
      this.#ui = undefined;
      this.#abortHostTools();
      await oldRpc.stop();
      await this.#frameQueue;
      await this.#startRpc();
    } finally {
      this.#recycling = false;
    }
  }

  async #applyProjectContext(context: TaskExecutionContext | undefined, sessionFile?: string): Promise<void> {
    const config = this.#options.config;
    this.#execution = context;
    config.execution = context;
    this.#sessionFile = sessionFile;
    if (context === undefined) {
      config.cwd = this.#baseProjectConfig.cwd;
      config.profile = this.#baseProjectConfig.profile;
      config.sessionDir = this.#baseProjectConfig.sessionDir;
      config.resume = this.#baseProjectConfig.resume;
      config.model = this.#baseProjectConfig.model;
      this.#projectContextApplied = true;
      return;
    }

    const projectKey = context.projectId.replace(/[^A-Za-z0-9._-]/g, "_");
    const sessionDir = join(config.stateDir, "project-sessions", projectKey);
    config.cwd = context.workerId === "local" ? context.workspace : sessionDir;
    config.profile = `${this.#baseProjectConfig.profile}-${projectKey}`;
    config.sessionDir = sessionDir;
    config.resume = undefined;
    config.model = context.model ?? this.#baseProjectConfig.model;
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    this.#projectContextApplied = true;
  }

  #sameExecutionContext(left: TaskExecutionContext | undefined, right: TaskExecutionContext | undefined): boolean {
    return (
      left?.projectId === right?.projectId &&
      left?.workspace === right?.workspace &&
      left?.workerId === right?.workerId &&
      left?.model === right?.model &&
      left?.expiresAt === right?.expiresAt &&
      left?.policy.write === right?.policy.write &&
      left?.policy.commands === right?.policy.commands &&
      left?.policy.network === right?.policy.network &&
      left?.policy.maxDurationMs === right?.policy.maxDurationMs
    );
  }

  async switchSession(sessionPath: string): Promise<boolean> {
    const data = await this.#requestData<{ cancelled: boolean }>({ type: "switch_session", sessionPath });
    this.#activeTurn = undefined;
    await this.#refreshStateRequired();
    return !data.cancelled;
  }

  async setSessionName(name: string): Promise<void> {
    await this.#sendRpc({ type: "set_session_name", name });
    await this.#refreshStateRequired();
  }
  get autonomyMode(): AutonomyMode {
    return this.#options.config.autonomyMode;
  }

  async setAutonomyMode(mode: AutonomyMode): Promise<void> {
    if (this.#currentTurnBusy()) {
      throw new Error("Cannot change autonomy mode while a turn is in progress");
    }
    if (mode === this.#options.config.autonomyMode) return;

    this.#recycling = true;
    clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    try {
      const oldRpc = this.#rpc;
      this.#rpc = undefined;
      this.#ui?.shutdown();
      this.#ui = undefined;
      this.#abortHostTools();
      await oldRpc?.stop();
      await this.#frameQueue;

      this.#options.config.autonomyMode = mode;
      await this.#startRpc();
      const approval = ompApprovalModeForAutonomy(mode);
      this.#log.info(`[ompclaw rpc] Autonomy switched to ${mode}${approval ? ` (--approval-mode ${approval})` : ""}`);
    } finally {
      this.#recycling = false;
    }
  }

  /** Queue a scheduler-owned prompt and resolve only after its terminal OMP event. */
  async handleScheduled(message: InboundMessage): Promise<void> {
    if (this.isBusy()) throw new ScheduledDispatchBusyError("OMP is serving another turn");
    if (!this.#rpc?.running) throw new Error("OMP RPC is not running");
    const completion = Promise.withResolvers<void>();
    void completion.promise.catch(() => undefined);
    const delivery = this.#deliveryFor(message);
    await this.#startTurn(delivery, message, {
      resolve: () => completion.resolve(),
      reject: (error) => completion.reject(error),
    });
    const prompt = this.#promptQueue.then(() => this.#deliverPrompt(message, delivery));
    this.#promptQueue = prompt.catch(() => {});
    await prompt;
    if (this.#activeTurn && this.#sameDelivery(this.#activeTurn, delivery)) await completion.promise;
  }

  async statusText(): Promise<string> {
    await this.#refreshState();
    const state = this.#status.state;
    if (!state)
      return `OmpClaw v${packageVersion}\nOMP offline${this.#status.lastError ? `\n${this.#status.lastError}` : ""}`;
    const model = `${state.model?.provider ?? "?"}/${state.model?.id ?? "?"}`;
    const context =
      state.contextUsage?.percent != null
        ? `${(state.contextUsage.percent * (state.contextUsage.percent <= 1 ? 100 : 1)).toFixed(1)}%`
        : "unknown";
    return [
      `OmpClaw v${packageVersion}`,
      `OMP: ${state.isStreaming ? "streaming" : state.isCompacting ? "compacting" : "idle"}`,
      `Session: ${state.sessionName ?? state.sessionId}`,
      `Workspace: ${this.#execution ? `${this.#execution.projectName} (${this.#execution.workspace})` : "default (no project task)"}`,
      `Model: ${model}`,
      `Thinking: ${state.thinkingLevel ?? "inherit"}`,
      `Fast: ${state.fastModeEnabled ? "on" : "off"}${state.fastModeActive ? " (active)" : ""}`,
      `Messages: ${state.messageCount ?? "?"} (${state.queuedMessageCount ?? 0} queued)`,
      "History: chat messages stay; /new resets agent context only",
      `Context: ${context}`,
      `Activity: ${this.#status.currentTool ?? "none"}`,
      `Subagents: ${this.#status.subagents.length}`,
      this.#ui?.statusText() ?? "",
      this.#status.lastError ? `Last error: ${this.#status.lastError}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  async #startRpc(): Promise<void> {
    const config = this.#options.config;
    if (this.#execution !== undefined && this.#options.executor === undefined) {
      throw new Error(`Project ${this.#execution.projectName} cannot start without a scoped execution executor`);
    }
    const argv = buildOmpRpcArgv(config, this.#sessionFile ?? config.resume);
    const childEnv = buildOmpChildEnv(process.env, config);
    for (const key of Object.keys(childEnv)) {
      if (
        key.startsWith("GATEWAY_") ||
        key.startsWith("OMPCLAW_") ||
        key.startsWith("OMP_GATEWAY_") ||
        key.startsWith("OMP_TRANSPORT_") ||
        key.startsWith("OMP_WEBSOCKET_") ||
        key.startsWith("WEBSOCKET_")
      )
        delete childEnv[key];
    }
    const clientOptions = {
      argv,
      cwd: config.cwd,
      env: childEnv,
      ...(this.#options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: this.#options.readyTimeoutMs }),
    };
    const rpc = this.#options.createRpcClient
      ? this.#options.createRpcClient(clientOptions)
      : new OmpRpcClient(clientOptions);
    rpc.onFrame((frame) => {
      const handled = this.#frameQueue.then(() => this.#handleRpcFrame(frame));
      this.#frameQueue = handled.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.#status.lastError = message;
        this.#log.error(`[ompclaw rpc] frame handler failed: ${message}`);
      });
    });
    rpc.onExit((error) => this.#handleRpcExit(error));
    this.#rpc = rpc;
    this.#ui = new RpcGatewayUiBroker({
      delivery: this.#options.delivery,
      sendResponse: (response) => this.#rpc?.write(response),
      getTarget: () => this.#activeTurn,
      log: this.#log,
    });
    await rpc.start();
    await rpc.send({ type: "set_subagent_subscription", level: "progress" });
    await rpc.send({
      type: "set_host_tools",
      tools:
        this.#execution === undefined
          ? gatewayHostToolDefinitions({
              automation: this.#options.automation !== undefined,
              updates: this.#options.updates !== undefined,
            })
          : scopedExecutionHostTools,
    });
    const state = await this.#requestData<RpcSessionState & { readonly dumpTools?: unknown }>({ type: "get_state" });
    if (this.#execution !== undefined) this.#validateScopedToolInventory(state.dumpTools);
    this.#status.state = state;
    this.#persistSession(state);
    this.#restartAttempt = 0;
    try {
      await this.#refreshAvailableCommands();
    } catch (error) {
      this.#log.warn(
        `[ompclaw rpc] Unable to refresh available commands: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #handleRpcExit(error: Error): Promise<void> {
    if (this.#stopping || this.#recycling) return;
    this.#rpc = undefined;
    this.#status.lastError = error.message;
    this.#ui?.shutdown();
    this.#ui = undefined;
    this.#abortHostTools();
    const active = this.#activeTurn;
    if (active) this.#stopTurnPresentation(active);
    this.#activeTurn = undefined;
    try {
      await this.#options.updates?.discardArmed();
    } catch (discardError) {
      this.#log.error(
        `[ompclaw update] failed to discard armed update after RPC exit: ${discardError instanceof Error ? discardError.message : String(discardError)}`,
      );
    }
    this.#failIdleWaiters(error);
    if (active) {
      active.scheduledCompletion?.reject(error);
      const outcome = this.#options.config.autoRestart ? "OmpClaw is restarting it." : "OmpClaw will remain offline.";
      await this.#send(
        active,
        `OMP stopped unexpectedly. ${outcome}\n\nThe task card now has recovery controls.`,
      ).catch(() => {});
    }
    if (!this.#options.config.autoRestart) return;
    const delays = [1_000, 2_000, 5_000, 10_000, 30_000];
    const delay = delays[Math.min(this.#restartAttempt++, delays.length - 1)];
    clearTimeout(this.#restartTimer);
    this.#restartTimer = setTimeout(() => {
      void this.#startRpc().catch((cause: unknown) => {
        const next = cause instanceof Error ? cause : new Error(String(cause));
        void this.#handleRpcExit(next);
      });
    }, delay);
    this.#restartTimer.unref?.();
  }

  async #handleRpcFrame(frame: RpcRecord): Promise<void> {
    if (isRpcExtensionUiRequest(frame)) {
      await this.#ui?.handle(frame as RpcExtensionUiRequest);
      return;
    }
    if (isRpcHostToolCall(frame)) {
      void this.#handleHostToolCall(frame as RpcHostToolCall);
      return;
    }
    if (isRpcHostToolCancel(frame)) {
      this.#hostTools.get(frame.targetId)?.controller.abort();
      return;
    }
    if (isRpcResponse(frame) && !frame.success) {
      const detail = frame.error ?? "unknown error";
      this.#status.lastError = `${frame.command}: ${detail}`;
      this.#log.warn(`[ompclaw rpc] ${frame.command} failed: ${detail}`);
      await this.#sendRuntimeMessage(
        "OMP couldn't complete that operation. The current task card has recovery controls when an action is available.",
      );
      return;
    }
    if (frame.type === "available_commands_update" && Array.isArray(frame.commands)) {
      this.#setAvailableCommands(frame.commands);
      return;
    }
    if (frame.type === "subagent_lifecycle" || frame.type === "subagent_progress") {
      const payload = isRecord(frame.payload) ? frame.payload : frame;
      const id =
        typeof payload.id === "string"
          ? payload.id
          : typeof payload.subagentId === "string"
            ? payload.subagentId
            : undefined;
      if (id) {
        const index = this.#status.subagents.findIndex((entry) => entry.id === id || entry.subagentId === id);
        if (index >= 0) this.#status.subagents[index] = payload;
        else this.#status.subagents.push(payload);
      }
      return;
    }
    if (frame.type === "agent_start") {
      if (this.#status.state) this.#status.state.isStreaming = true;
      await this.#setTurnLifecycle("running");
      this.#recordTurnTimeline("started", "Agent started");
      const active = this.#activeTurn;
      if (active) this.#startTypingHeartbeat(active);
      return;
    }
    if (frame.type === "tool_execution_start") {
      const activity = activityForFrame(frame);
      const toolName = typeof frame.toolName === "string" ? frame.toolName : "tool";
      this.#status.currentTool = activity;
      const active = this.#activeTurn;
      if (active) active.activities.push({ toolName, text: activity, state: "active" });
      this.#recordTurnTimeline("tool_started", activity);
      await this.#setTurnLifecycle("running", { currentTool: activity });
      return;
    }
    if (frame.type === "tool_execution_end") {
      const toolName = typeof frame.toolName === "string" ? frame.toolName : "tool";
      this.#status.currentTool = undefined;
      const active = this.#activeTurn;
      const activityIndex = active?.activities.findLastIndex(
        (activity) => activity.toolName === toolName && activity.state === "active",
      );
      if (active && activityIndex !== undefined && activityIndex >= 0) {
        const activity = active.activities[activityIndex]!;
        active.activities[activityIndex] = { ...activity, state: "completed" };
        this.#recordTurnTimeline("tool_completed", activity.text);
      }
      if (toolName === "todo") {
        try {
          await this.#refreshStateRequired();
        } catch (error) {
          this.#log.warn(
            `[ompclaw rpc] Unable to refresh todo state: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      await this.#setTurnLifecycle("running", { clearCurrentTool: true });
      return;
    }
    if (frame.type === "message_end") {
      await this.#deliverAssistantPreview(assistantText(frame.message));
      return;
    }
    if (frame.type === "message_update" || frame.type === "turn_end") {
      await this.#deliverAssistantPreview(assistantText(frame.message));
      return;
    }
    if (frame.type === "command_output" && typeof frame.text === "string") {
      await this.#sendRuntimeMessage(frame.text);
      return;
    }
    if (frame.type === "prompt_result" && frame.agentInvoked === false) {
      this.#abortHostTools();
      await this.#setTurnLifecycle("completed");
      const active = this.#activeTurn;
      this.#activeTurn = undefined;
      if (this.#status.state) this.#status.state.isStreaming = false;
      this.#wakeIdleWaiters();
      active?.scheduledCompletion?.resolve();
      await this.#refreshState();
      this.#queueSourceReaction(active, "👍");
      return;
    }
    if (frame.type === "agent_end" && frame.isTerminal !== false) {
      const active = this.#activeTurn;
      this.#abortHostTools();
      const terminalState = this.#terminalState(frame.messages);
      const terminalText = finalAssistantText(frame.messages);
      const visibleTerminalText =
        terminalText || active?.previewText || this.#missingTerminalSummaryText(terminalState);
      let finalDelivered = false;
      try {
        await this.#finalizeAssistantText(visibleTerminalText, terminalState);
        finalDelivered = terminalText.trim().length > 0;
        await this.#setTurnLifecycle(terminalState);
        active?.scheduledCompletion?.resolve();
      } catch (error) {
        await this.#setTurnLifecycle("failed", { error: error instanceof Error ? error.message : String(error) });
        active?.scheduledCompletion?.reject(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        if (active) this.#stopTurnPresentation(active);
        this.#activeTurn = undefined;
        if (this.#status.state) this.#status.state.isStreaming = false;
        try {
          try {
            if (finalDelivered && terminalState === "completed") await this.#options.updates?.commitArmed();
            else await this.#options.updates?.discardArmed();
          } catch (error) {
            this.#log.error(
              `[ompclaw update] failed to finalize armed update: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          await this.#refreshState();
        } finally {
          this.#wakeIdleWaiters();
          this.#queueSourceReaction(
            active,
            terminalState === "failed" ? "👎" : terminalState === "stopped" ? "👌" : "👍",
          );
        }
      }
      return;
    }
    if (
      frame.type === "model_changed" ||
      frame.type === "thinking_level_changed" ||
      frame.type === "session_info_update"
    ) {
      await this.#refreshState();
    }
  }

  async #deliverPrompt(message: InboundMessage, delivery: RpcGatewayUiTarget): Promise<void> {
    const rpc = this.#rpc;
    if (!rpc?.running) {
      await this.#setTurnLifecycle("interrupted", { error: "OMP RPC is restarting" });
      await this.#send(delivery, "OMP is restarting. Try again in a moment.");
      this.#clearActiveDelivery(delivery);
      return;
    }
    const input = await this.#promptInput(message);
    const command: RpcCommandInput = {
      type: "prompt",
      message: input.prompt,
      ...(input.images.length ? { images: input.images } : {}),
    };
    try {
      const response = await rpc.send(command);
      if (isRecord(response.data) && response.data.agentInvoked === false) {
        const active = this.#activeTurn;
        await this.#setTurnLifecycle("completed");
        this.#clearActiveDelivery(delivery, true);
        await this.#refreshState();
        this.#queueSourceReaction(active, "👍");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#status.lastError = `Prompt failed: ${detail}`;
      await this.#setTurnLifecycle("failed", { error: detail });
      this.#clearActiveDelivery(delivery);
      await this.#send(delivery, "That task's recovery card is ready below.").catch(() => {});
      throw error;
    }
  }

  async #deliverBusyInput(message: InboundMessage, delivery: GatewayTurnTarget): Promise<void> {
    const mode = this.#options.config.busyInputMode;
    this.#queueSourceReaction(delivery, "👀");
    try {
      const input = await this.#promptInput(message);
      await this.#sendRpc({
        type: mode === "followup" ? "follow_up" : "steer",
        message: input.prompt,
        ...(input.images.length > 0 ? { images: input.images } : {}),
      });
      this.#queueSourceReaction(delivery, "👍");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#status.lastError = `${mode === "followup" ? "Follow-up" : "Correction"} failed: ${detail}`;
      this.#queueSourceReaction(delivery, "👎");
      await this.#send(
        delivery,
        `I couldn't queue that ${mode === "followup" ? "follow-up" : "correction"}. Your original message is still here—send it again when you're ready.`,
      ).catch(() => {});
      throw error;
    }
  }

  #promptInput(message: InboundMessage): Promise<FormattedPromptInput> {
    return formatPromptInput(message, (warning) => this.#log.warn(warning));
  }

  async #handleCommand(delivery: GatewayTurnTarget, name: string, args: string): Promise<boolean> {
    const reply = async (text: string): Promise<void> => {
      await this.#send(delivery, text);
    };
    if (
      this.#execution !== undefined &&
      [
        "bash",
        "shell",
        "abortbash",
        "login",
        "handoff",
        "switch",
        "export",
        "autonomy",
        "permissions",
        "retry",
        "schedule_create",
        "schedules",
        "schedule",
        "jobs",
        "job",
        "job_edit",
        "job_pause",
        "job_resume",
        "job_run",
        "job_delete",
        "job_delete_confirm",
      ].includes(name)
    ) {
      await reply("That runtime control is unavailable for scoped project tasks.");
      return true;
    }
    try {
      if (name === "start") await reply(assistantWelcome());
      else if (name === "help") await reply(runtimeHelp(this.#options.config.allowRpcBash));
      else if (name === "home") await this.#homeCommand(delivery);
      else if (name === "more") await this.#moreCommand(delivery);
      else if (name === "status") {
        const now = this.#now();
        await this.#presentSemanticView(
          delivery,
          informationSemanticView("Session status", await this.statusText(), now, now),
        );
      } else if (name === "stop") {
        await this.#sendRpc({ type: "abort" });
        await reply("Stop requested.");
      } else if (name === "new") {
        const created = await this.newSession();
        await reply(
          created
            ? "New session started. This chat keeps its history; the agent now starts with fresh context."
            : "New session cancelled.",
        );
      } else if (name === "steer" || name === "followup") {
        if (!args) await reply(`Usage: /${name} <message>`);
        else {
          await this.#sendRpc({ type: name === "steer" ? "steer" : "follow_up", message: args });
          await reply(name === "steer" ? "Correction queued." : "Follow-up queued.");
        }
      } else if (name === "compact") {
        await this.#sendRpc({ type: "compact", ...(args ? { customInstructions: args } : {}) }, 120_000);
        await this.#refreshState();
        await reply("Compaction complete.");
      } else if (name === "model") await this.#modelCommand(delivery, args, reply);
      else if (name === "autonomy" || name === "permissions") await this.#autonomyCommand(delivery, args, reply, name);
      else if (name === "thinking") await this.#thinkingCommand(delivery, args, reply);
      else if (name === "fast")
        await this.#booleanCommand(delivery, "set_fast_mode", args, this.#status.state?.fastModeEnabled, reply);
      else if (name === "autocompact")
        await this.#booleanCommand(
          delivery,
          "set_auto_compaction",
          args,
          this.#status.state?.autoCompactionEnabled,
          reply,
        );
      else if (name === "retry") await this.#retryCommand(args, reply);
      else if (name === "queue") await this.#queueCommand(args, reply);
      else if (name === "tasks") await this.#tasksCommand(delivery);
      else if (name === "task_diff") await this.#taskDiffCommand(delivery, args, reply);
      else if (name === "task_artifact") await this.#taskArtifactCommand(delivery, args, reply);
      else if (name === "task_retry") await this.#taskRetryCommand(delivery, args, reply);
      else if (name === "task_recover") await this.#taskRecoverCommand(delivery, args, reply);
      else if (name === "task_continue" || name === "task_revise")
        await this.#taskContinuationCommand(delivery, args, name === "task_revise" ? "revise" : "continue", reply);
      else if (name === "result") await this.#resultCommand(delivery, args, reply);
      else if (name === "task_details") await this.#taskDetailsCommand(delivery, args, reply);
      else if (name === "stats") await reply(valueText(await this.#requestData({ type: "get_session_stats" })));
      else if (name === "todos") await reply(this.#todosText());
      else if (name === "subagents") await this.#subagentsCommand(reply);
      else if (name === "commands") await this.#commandsCommand(reply);
      else if (name === "jobs" || name === "schedules") await this.#jobsCommand(delivery, reply);
      else if (name === "job" || name === "schedule") await this.#jobDetailCommand(delivery, args.trim(), reply);
      else if (name === "job_delete_confirm") await this.#jobDeleteConfirmCommand(delivery, args.trim(), reply);
      else if (name === "schedule_create") {
        if (args.trim()) {
          await this.handleInbound({
            id: `cmd-${this.#now()}`,
            sentAt: this.#now(),
            identity: delivery.identity,
            principal: delivery.deliveryContext.principal,
            address: delivery.address,
            content: { text: args.trim() },
          });
        } else {
          await reply("Usage: /schedule_create <instructions>");
        }
      } else if (name === "job_edit") {
        const parts = args.trim().split(/\s+/);
        const id = parts[0];
        const instruction = parts.slice(1).join(" ");
        if (id && instruction) {
          await this.handleInbound({
            id: `cmd-${this.#now()}`,
            sentAt: this.#now(),
            identity: delivery.identity,
            principal: delivery.deliveryContext.principal,
            address: delivery.address,
            content: { text: `Update scheduled job ${id}: ${instruction}` },
          });
        } else {
          await reply("Usage: /job_edit <job id> <instructions>");
        }
      } else if (name === "job_pause" || name === "job_resume" || name === "job_run" || name === "job_delete") {
        const automation = this.#options.automation;
        if (automation === undefined) await reply("OmpClaw automation is disabled.");
        else if (!args) await reply(`Usage: /${name} <job id>`);
        else {
          const principalId = delivery.deliveryContext.principal.id;
          const jobId = args.trim();
          if (name === "job_delete") {
            const job = automation.list(principalId).find((j) => j.id === jobId);
            const jobName = job?.name ?? jobId;
            if (!automation.remove(jobId, principalId)) {
              await reply(`Scheduled job ${jobId} was not found.`);
              return true;
            }
            const now = this.#now();
            await this.#presentSemanticView(delivery, scheduledJobDeleteSettledSemanticView(jobName, now, now));
          } else if (name === "job_run") {
            automation.runNow(jobId, principalId);
            await this.#jobDetailCommand(delivery, jobId, reply);
          } else {
            automation.setEnabled(jobId, principalId, name === "job_resume");
            await this.#jobDetailCommand(delivery, jobId, reply);
          }
        }
      } else if (name === "history") await this.#historyCommand(args, reply);
      else if (name === "branch") await this.#branchCommand(args, reply);
      else if (name === "name") {
        if (!args) await reply("Usage: /name <session name>");
        else {
          await this.setSessionName(args);
          await reply(`Session named ${args}.`);
        }
      } else if (name === "handoff") {
        const data = await this.#requestData<{ savedPath?: string } | null>(
          { type: "handoff", ...(args ? { customInstructions: args } : {}) },
          120_000,
        );
        this.#activeTurn = undefined;
        await this.#refreshState();
        await reply(data?.savedPath ? `Handoff created: ${data.savedPath}` : "Handoff complete.");
      } else if (name === "switch") {
        if (!args) await reply("Usage: /switch <exact session path>");
        else {
          const switched = await this.switchSession(args);
          await reply(switched ? "Session switched." : "Session switch cancelled.");
        }
      } else if (name === "export") await this.#exportCommand(delivery, reply);
      else if (name === "login") await this.#loginCommand(delivery, args, reply);
      else if (name === "shell" && this.#options.config.allowRpcBash) {
        if (!args) await reply("Usage: /shell <command>");
        else await reply(valueText(await this.#requestData({ type: "bash", command: args }, 10 * 60_000)));
      } else if (name === "abortbash" && this.#options.config.allowRpcBash) {
        await this.#sendRpc({ type: "abort_bash" });
        await reply("RPC bash abort requested.");
      } else {
        if (this.#execution !== undefined) {
          await reply("That command is unavailable for scoped project tasks.");
          return true;
        }
        const available = this.#status.availableCommands.some((command) => command.name === name);
        if (!available) return false;
        this.#activate(delivery);
        const response = await this.#sendRpc({ type: "prompt", message: `/${name}${args ? ` ${args}` : ""}` });
        if (isRecord(response.data) && response.data.agentInvoked === false) {
          this.#clearActiveDelivery(delivery, true);
          await this.#refreshState();
        }
      }
    } catch (error) {
      const message =
        error instanceof RpcCommandError ? error.message : error instanceof Error ? error.message : String(error);
      this.#status.lastError = `${name}: ${message}`;
      this.#log.warn(`[ompclaw rpc] ${name} command failed: ${message}`);
      await reply("That command failed. It was not applied, so you can try it again.");
    }
    return true;
  }

  async #homeCommand(delivery: GatewayTurnTarget): Promise<void> {
    await this.#refreshState();
    const now = this.#now();
    const active = this.#activeTurn;
    const isStreaming = this.#status.state?.isStreaming === true;
    const isBusy = active !== undefined || isStreaming;
    const activeTask = isBusy
      ? {
          title: active?.lifecycle?.prompt ?? this.#status.state?.sessionName?.trim() ?? "Active task",
          startedAt: active?.lifecycle?.createdAt ?? now,
          currentStep: active?.activities?.findLast?.((a) => a.state === "active")?.text ?? this.#status.currentTool,
        }
      : undefined;

    await this.#presentSemanticView(
      delivery,
      homeSemanticView({
        state: this.#status.state,
        autonomyMode: this.#options.config.autonomyMode,
        autonomyLabel: AUTONOMY_MODE_LABELS[this.#options.config.autonomyMode],
        activeTask,
        quickAskArmed: isBusy && this.#options.isQuickAskArmed?.(delivery.address) === true,
        execution: active?.lifecycle?.execution,
        evidence: active?.lifecycle?.evidence,
        version: now,
        updatedAt: now,
      }),
    );
  }

  async showHome(message: InboundMessage): Promise<void> {
    await this.#homeCommand(this.#deliveryFor(message));
  }

  async #moreCommand(delivery: GatewayTurnTarget): Promise<void> {
    await this.#refreshState();
    const now = this.#now();
    await this.#presentSemanticView(
      delivery,
      moreSemanticView({
        state: this.#status.state,
        autonomyMode: this.#options.config.autonomyMode,
        autonomyLabel: AUTONOMY_MODE_LABELS[this.#options.config.autonomyMode],
        version: now,
        updatedAt: now,
      }),
    );
  }

  async #jobsCommand(delivery: GatewayTurnTarget, reply: (text: string) => Promise<void>): Promise<void> {
    const automation = this.#options.automation;
    if (automation === undefined) {
      await reply("OmpClaw automation is disabled.");
      return;
    }
    const now = this.#now();
    await this.#presentSemanticView(
      delivery,
      scheduledJobsSemanticView(automation.list(delivery.deliveryContext.principal.id), now, now),
    );
  }

  async #jobDetailCommand(
    delivery: GatewayTurnTarget,
    id: string,
    reply: (text: string) => Promise<void>,
  ): Promise<void> {
    const automation = this.#options.automation;
    if (automation === undefined) {
      await reply("OmpClaw automation is disabled.");
      return;
    }
    const principalId = delivery.deliveryContext.principal.id;
    const job = automation.list(principalId).find((j) => j.id === id);
    if (!job) {
      await reply(`Scheduled job ${id} was not found.`);
      return;
    }
    const now = this.#now();
    await this.#presentSemanticView(delivery, scheduledJobDetailSemanticView(job, now, now));
  }

  async #jobDeleteConfirmCommand(
    delivery: GatewayTurnTarget,
    id: string,
    reply: (text: string) => Promise<void>,
  ): Promise<void> {
    const automation = this.#options.automation;
    if (automation === undefined) {
      await reply("OmpClaw automation is disabled.");
      return;
    }
    const principalId = delivery.deliveryContext.principal.id;
    const job = automation.list(principalId).find((j) => j.id === id);
    if (!job) {
      await reply(`Scheduled job ${id} was not found.`);
      return;
    }
    const now = this.#now();
    await this.#presentSemanticView(delivery, scheduledJobDeleteConfirmSemanticView(job, now, now));
  }

  async #modelCommand(
    delivery: GatewayTurnTarget,
    args: string,
    reply: (text: string) => Promise<void>,
  ): Promise<void> {
    const selection = args.trim();
    const command = selection.split(/\s+/);
    const current =
      this.#status.state?.model?.provider !== undefined && this.#status.state.model.id !== undefined
        ? { provider: this.#status.state.model.provider, id: this.#status.state.model.id }
        : undefined;
    if (selection.length === 0 || command[0] === "provider" || command[0] === "page") {
      const data = await this.#requestData<{ models: Array<{ provider?: string; id?: string }> }>({
        type: "get_available_models",
      });
      const models = data.models.filter(
        (model): model is { provider: string; id: string } =>
          typeof model.provider === "string" &&
          model.provider.length > 0 &&
          typeof model.id === "string" &&
          model.id.length > 0,
      );
      const now = this.#now();
      if (selection.length === 0) {
        await this.#presentSemanticView(
          delivery,
          modelProviderSemanticView({
            models,
            ...(current === undefined ? {} : { current }),
            version: now,
            updatedAt: now,
          }),
        );
        return;
      }
      const encodedProvider = command[1];
      if (encodedProvider === undefined || command.length !== (command[0] === "page" ? 3 : 2)) {
        await reply("Usage: /model <provider>/<model-id>");
        return;
      }
      let provider: string;
      try {
        provider = decodeURIComponent(encodedProvider);
      } catch {
        await reply("That model provider is not available.");
        return;
      }
      const page = command[0] === "page" ? Number(command[2]) : 0;
      if (!Number.isSafeInteger(page) || page < 0 || !models.some((model) => model.provider === provider)) {
        await reply("That model provider is not available.");
        return;
      }
      await this.#presentSemanticView(
        delivery,
        modelPageSemanticView({
          models,
          ...(current === undefined ? {} : { current }),
          provider,
          page,
          pageSize: 8,
          version: now,
          updatedAt: now,
        }),
      );
      return;
    }
    if (command[0] === "select") {
      const encodedProvider = command[1];
      const encodedModel = command[2];
      if (encodedProvider === undefined || encodedModel === undefined || command.length !== 3) {
        await reply("Usage: /model <provider>/<model-id>");
        return;
      }
      try {
        await this.#sendRpc({
          type: "set_model",
          provider: decodeURIComponent(encodedProvider),
          modelId: decodeURIComponent(encodedModel),
        });
      } catch {
        await reply("That model is not available.");
        return;
      }
    } else {
      const split = selection.indexOf("/");
      if (split <= 0 || split === selection.length - 1) {
        await reply("Usage: /model <provider>/<model-id>");
        return;
      }
      await this.#sendRpc({
        type: "set_model",
        provider: selection.slice(0, split),
        modelId: selection.slice(split + 1),
      });
    }
    await this.#refreshState();
    await this.#homeCommand(delivery);
  }

  async #autonomyCommand(
    delivery: GatewayTurnTarget,
    args: string,
    reply: (text: string) => Promise<void>,
    commandName = "permissions",
  ): Promise<void> {
    const selection = args.trim();
    const isPermissions = commandName === "permissions";
    const commandPrefix = isPermissions ? "/permissions" : "/autonomy";
    const label = isPermissions ? "Permissions" : "Autonomy";
    if (!selection) {
      const current = this.#options.config.autonomyMode;
      const now = this.#now();
      await this.#presentSemanticView(
        delivery,
        sessionChoiceSemanticView({
          title: isPermissions ? "Choose permissions mode" : "Choose autonomy mode",
          summary: "Governs whether OMP requests tool approval or runs autonomously.",
          choices: AUTONOMY_MODES.map((mode) => ({
            id: mode,
            label: AUTONOMY_MODE_LABELS[mode],
            description: AUTONOMY_MODE_DESCRIPTIONS[mode],
            command: `${commandPrefix} ${mode}`,
            selected: mode === current,
          })),
          version: now,
          updatedAt: now,
        }),
      );
      return;
    }
    if (selection === "info" || selection === "status") {
      const now = this.#now();
      await this.#presentSemanticView(
        delivery,
        informationSemanticView(label, autonomyText(this.#options.config.autonomyMode, label), now, now),
      );
      return;
    }
    const mode = parseAutonomyMode(selection);
    if (!mode) {
      await reply(`Unknown autonomy mode. Use: ${AUTONOMY_MODES.join(", ")}`);
      return;
    }
    if (this.#currentTurnBusy()) {
      await reply("Wait for the current turn to finish before changing autonomy mode.");
      return;
    }
    if (mode === this.#options.config.autonomyMode) {
      await reply(`${label} is already set to ${AUTONOMY_MODE_LABELS[mode]} (${mode}).`);
      return;
    }
    await this.setAutonomyMode(mode);
    await reply(`${label} switched to ${AUTONOMY_MODE_LABELS[mode]} (${mode}).`);
    await this.#homeCommand(delivery);
  }

  async #thinkingCommand(
    delivery: GatewayTurnTarget,
    args: string,
    reply: (text: string) => Promise<void>,
  ): Promise<void> {
    const selection = args;
    if (!selection) {
      const current = this.#status.state?.thinkingLevel ?? "inherit";
      const now = this.#now();
      await this.#presentSemanticView(
        delivery,
        sessionChoiceSemanticView({
          title: "Choose reasoning depth",
          summary: "Higher levels spend more time on difficult decisions and code.",
          choices: Object.keys(THINKING_LEVELS).map((level) => ({
            id: level,
            label: level === "xhigh" ? "Extra high" : `${level[0]?.toUpperCase()}${level.slice(1)}`,
            command: `/thinking ${level}`,
            selected: level === current,
          })),
          version: now,
          updatedAt: now,
        }),
      );
      return;
    }
    if (!THINKING_LEVELS[selection]) {
      await reply(`Unknown level. Use: ${Object.keys(THINKING_LEVELS).join(", ")}`);
      return;
    }
    await this.#sendRpc({ type: "set_thinking_level", level: selection });
    await this.#refreshState();
    await this.#homeCommand(delivery);
  }

  async #booleanCommand(
    delivery: GatewayTurnTarget,
    command: "set_fast_mode" | "set_auto_compaction",
    args: string,
    current: boolean | undefined,
    reply: (text: string) => Promise<void>,
  ): Promise<void> {
    const selection = args;
    if (!selection || selection === "toggle") {
      const next = !current;
      await this.#sendRpc({ type: command, enabled: next });
      await this.#refreshState();
      if (command === "set_auto_compaction") {
        await this.#moreCommand(delivery);
      } else {
        await this.#homeCommand(delivery);
      }
      return;
    }
    if (selection !== "on" && selection !== "off") {
      await reply(`Usage: /${command === "set_fast_mode" ? "fast" : "autocompact"} <on|off>`);
      return;
    }
    await this.#sendRpc({ type: command, enabled: selection === "on" });
    await this.#refreshState();
    if (command === "set_auto_compaction") {
      await this.#moreCommand(delivery);
    } else {
      await this.#homeCommand(delivery);
    }
  }

  async #retryCommand(args: string, reply: (text: string) => Promise<void>): Promise<void> {
    if (args === "stop") {
      await this.#sendRpc({ type: "abort_retry" });
      await reply("Retry abort requested.");
    } else if (args === "on" || args === "off") {
      await this.#sendRpc({ type: "set_auto_retry", enabled: args === "on" });
      await reply(`Automatic retry ${args}.`);
    } else await reply("Usage: /retry <on|off|stop>");
  }

  async #queueCommand(args: string, reply: (text: string) => Promise<void>): Promise<void> {
    const state = this.#status.state;
    if (!args) {
      await reply(
        `Inbound while busy: OMP configured behavior\nSteering: ${String(state?.steeringMode ?? "?")}\nFollow-up: ${String(state?.followUpMode ?? "?")}\nInterrupt: ${String(state?.interruptMode ?? "?")}`,
      );
      return;
    }
    const [kind, mode] = args.split(/\s+/, 2);
    if (kind === "steering" && (mode === "all" || mode === "one-at-a-time"))
      await this.#sendRpc({ type: "set_steering_mode", mode });
    else if (kind === "follow" && (mode === "all" || mode === "one-at-a-time"))
      await this.#sendRpc({ type: "set_follow_up_mode", mode });
    else if (kind === "interrupt" && (mode === "immediate" || mode === "wait"))
      await this.#sendRpc({ type: "set_interrupt_mode", mode });
    else {
      await reply("Usage: /queue [steering all|one-at-a-time | follow all|one-at-a-time | interrupt immediate|wait]");
      return;
    }
    await this.#refreshState();
    await reply("Queue mode updated.");
  }

  async #subagentsCommand(reply: (text: string) => Promise<void>): Promise<void> {
    const data = await this.#requestData<{ subagents: RpcRecord[] }>({ type: "get_subagents" });
    this.#status.subagents = data.subagents;
    if (data.subagents.length === 0) await reply("No tracked subagents.");
    else
      await reply(
        data.subagents
          .map(
            (agent) =>
              `#${String(agent.index ?? "?")} ${String(agent.agent ?? "agent")} — ${String(agent.status ?? "unknown")}${agent.task ? `\n${String(agent.task)}` : ""}`,
          )
          .join("\n\n"),
      );
  }

  async #commandsCommand(reply: (text: string) => Promise<void>): Promise<void> {
    await this.#refreshAvailableCommands();
    const catalog = new CommandCatalog({
      ompCommands: this.#status.availableCommands,
      allowRpcBash: this.#options.config.allowRpcBash,
    });
    const lines = catalog
      .groups()
      .flatMap((group) => [
        group.name,
        ...group.entries.map((command) => `/${command.name}${command.description ? ` — ${command.description}` : ""}`),
        "",
      ]);
    await reply(lines.join("\n").trimEnd());
  }

  async #historyCommand(args: string, reply: (text: string) => Promise<void>): Promise<void> {
    const requested = Number(args || 12);
    const count = Number.isSafeInteger(requested) ? Math.max(1, Math.min(requested, 50)) : 12;
    const data = await this.#requestData<{ messages: unknown[] }>({ type: "get_messages" }, 120_000);
    const lines = data.messages.map(summarizeMessage).filter(Boolean).slice(-count);
    await reply(lines.length ? lines.join("\n\n") : "No messages in this session.");
  }

  async #branchCommand(args: string, reply: (text: string) => Promise<void>): Promise<void> {
    if (args) {
      const data = await this.#requestData<{ text: string; cancelled: boolean }>({ type: "branch", entryId: args });
      this.#activeTurn = undefined;
      await this.#refreshState();
      await reply(data.cancelled ? "Branch cancelled." : `Branched from: ${data.text}`);
      return;
    }
    const data = await this.#requestData<{ messages: Array<{ entryId: string; text: string }> }>({
      type: "get_branch_messages",
    });
    await reply(
      data.messages
        .slice(-25)
        .map((entry) => `${entry.entryId}\n${entry.text.slice(0, 180)}`)
        .join("\n\n") || "No branch points available.",
    );
  }

  async #exportCommand(delivery: RpcGatewayUiTarget, reply: (text: string) => Promise<void>): Promise<void> {
    const directory = join(this.#options.config.stateDir, "exports");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const data = await this.#requestData<{ path: string }>(
      { type: "export_html", outputPath: join(directory, `omp-${Date.now()}.html`) },
      120_000,
    );
    await this.#options.delivery.send(
      delivery.address,
      { attachments: [{ url: pathToFileURL(data.path).href }], format: "text" },
      delivery.deliveryContext,
    );
    await reply("Session export attached.");
  }

  async #loginCommand(
    delivery: GatewayTurnTarget,
    args: string,
    reply: (text: string) => Promise<void>,
  ): Promise<void> {
    if (!args) {
      const data = await this.#requestData<{
        providers: Array<{ id: string; name: string; available: boolean; authenticated: boolean }>;
      }>({ type: "get_login_providers" });
      await reply(
        data.providers
          .map(
            (provider) =>
              `${provider.id} — ${provider.authenticated ? "authenticated" : provider.available ? "available" : "unavailable"}`,
          )
          .join("\n"),
      );
      return;
    }
    const activatesDelivery = !this.#activeTurn;
    if (activatesDelivery) this.#activate(delivery);
    try {
      await reply(`Starting ${args} login.Follow the secure URL prompt.`);
      await this.#requestData({ type: "login", providerId: args }, 10 * 60_000);
      await reply(`${args} login complete.`);
    } finally {
      if (activatesDelivery) this.#clearActiveDelivery(delivery);
    }
  }

  #todosText(): string {
    const phases = this.#status.state?.todoPhases;
    if (!Array.isArray(phases) || phases.length === 0) return "No active todos.";
    return phases.map(valueText).join("\n\n");
  }

  async #refreshAvailableCommands(): Promise<void> {
    const data = await this.#requestData<{ commands?: unknown }>({ type: "get_available_commands" });
    if (!Array.isArray(data.commands)) throw new Error("OMP returned an invalid command catalog");
    this.#setAvailableCommands(data.commands);
  }

  #setAvailableCommands(commands: readonly unknown[]): void {
    const available: OmpAvailableCommand[] = [];
    for (const candidate of commands) {
      if (!isRecord(candidate) || typeof candidate.name !== "string") continue;
      available.push({
        name: candidate.name,
        ...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
        ...(typeof candidate.source === "string" ? { source: candidate.source } : {}),
      });
    }
    this.#status.availableCommands = available;
    this.#options.turnStore?.replaceOmpAvailableCommands?.(available);
  }

  async #refreshStateRequired(): Promise<RpcSessionState> {
    if (!this.#rpc?.running) throw new Error("OMP RPC is offline");
    const state = await this.#requestData<RpcSessionState>({ type: "get_state" });
    this.#status.state = state;
    this.#persistSession(state);
    this.#wakeIdleWaiters();
    return state;
  }

  async #refreshState(): Promise<void> {
    if (!this.#rpc?.running) return;
    try {
      await this.#refreshStateRequired();
    } catch (error) {
      this.#status.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  #persistSession(state: RpcSessionState): void {
    if (state.sessionFile) this.#sessionFile = state.sessionFile;
    try {
      this.#options.onSessionState?.(state);
    } catch (error) {
      this.#log.warn(
        `[ompclaw rpc] Session state callback failed: ${error instanceof Error ? error.message : String(error)} `,
      );
    }
  }

  async #sendRpc(command: RpcCommandInput, timeoutMs?: number): Promise<RpcResponse> {
    const rpc = this.#rpc;
    if (!rpc?.running) throw new Error("OMP RPC is offline");
    return rpc.send(command, timeoutMs);
  }

  async #requestData<T = RpcRecord>(command: RpcCommandInput, timeoutMs?: number): Promise<T> {
    const response = await this.#sendRpc(command, timeoutMs);
    return response.data as T;
  }

  #deliveryFor(message: InboundMessage): GatewayTurnTarget {
    return {
      address: message.address,
      deliveryContext: { principal: message.principal, origin: message.address },
      identity: message.identity,
      ...(message.sourceReceipt === undefined ? {} : { sourceReceipt: message.sourceReceipt }),
    };
  }

  #activate(delivery: GatewayTurnTarget | ActiveTurn): void {
    if (!this.#activeTurn) {
      this.#activeTurn = {
        ...delivery,
        activities: "activities" in delivery ? [...delivery.activities] : [],
      };
    }
  }

  #clearActiveDelivery(delivery: RpcGatewayUiTarget, terminal = false): void {
    if (!this.#activeTurn || !this.#sameDelivery(this.#activeTurn, delivery)) return;
    this.#stopTurnPresentation(this.#activeTurn);
    this.#activeTurn = undefined;
    if (terminal && this.#status.state) this.#status.state.isStreaming = false;
    this.#wakeIdleWaiters();
  }

  #wakeIdleWaiters(): void {
    if (this.#currentTurnBusy()) return;
    for (const waiter of this.#idleWaiters) waiter.resolve();
    this.#idleWaiters.clear();
  }

  #failIdleWaiters(error: Error): void {
    for (const waiter of this.#idleWaiters) waiter.reject(error);
    this.#idleWaiters.clear();
  }

  #sameDelivery(left: RpcGatewayUiTarget, right: RpcGatewayUiTarget): boolean {
    return (
      left.deliveryContext.principal.id === right.deliveryContext.principal.id &&
      this.#sameAddress(left.address, right.address)
    );
  }

  #sameAddress(left: ConversationAddress, right: ConversationAddress): boolean {
    return (
      left.transport === right.transport &&
      left.account === right.account &&
      left.channel === right.channel &&
      left.thread === right.thread
    );
  }

  #scopedInboundError(message: InboundMessage): string | undefined {
    const selected = this.#execution;
    if (selected === undefined) {
      return message.execution === undefined
        ? undefined
        : "Select the authorized project before sending a project task.";
    }
    if (message.execution === undefined || !this.#sameExecutionContext(selected, message.execution)) {
      return "This project task is not bound to the active authorized project.";
    }
    if (message.execution.expiresAt <= this.#now()) {
      return `Project ${message.execution.projectName} execution grant has expired.`;
    }
    if (this.#options.authorizeExecution?.(message.execution, message.principal) === false) {
      return "This project is no longer authorized for this conversation.";
    }
    if (message.content.text?.trimStart().startsWith("!")) {
      return "Direct runtime commands are unavailable for scoped project tasks. Use the project execution tools.";
    }
    return undefined;
  }

  #validateScopedToolInventory(inventory: unknown): void {
    if (!Array.isArray(inventory)) {
      throw new Error("Scoped project mode requires OMP tool inventory support; upgrade OMP before enabling projects");
    }
    const registered = new Set(scopedExecutionHostTools.map((tool) => tool.name));
    const active = new Set<string>();
    for (const tool of inventory) {
      if (!isRecord(tool) || typeof tool.name !== "string") {
        throw new Error("Scoped project mode received an invalid OMP tool inventory");
      }
      active.add(tool.name);
    }
    if (active.size !== registered.size || [...active].some((name) => !registered.has(name))) {
      throw new Error("Scoped project mode detected an unapproved native or extension tool; refusing to start");
    }
  }
  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #recordTurnTimeline(kind: TurnTimelineEventKind, text: string): void {
    const turn = this.#activeTurn?.lifecycle;
    if (!turn) return;
    try {
      this.#options.turnStore?.appendTurnTimelineEvent?.({
        turnId: turn.id,
        at: this.#now(),
        kind,
        text: text.slice(0, 1_000),
      });
    } catch (error) {
      this.#log.warn(
        `[ompclaw rpc] Unable to persist task timeline: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #startTurn(
    delivery: GatewayTurnTarget,
    message: InboundMessage,
    scheduledCompletion?: ActiveTurn["scheduledCompletion"],
  ): Promise<void> {
    if (this.#activeTurn) return;
    const now = this.#now();
    const prompt =
      (message.content.text ?? message.content.attachments?.[0]?.name ?? "Attachment")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240) || "Message";
    const recoveryMatch = /^task-(?:continue|revise|restart):(.+):\d+$/.exec(message.id);
    const lifecycle: TurnLifecycle = {
      id: message.id,
      principalId: message.principal.id,
      address: message.address,
      prompt,
      state: "queued",
      createdAt: now,
      updatedAt: now,
      request: message,
      ...(this.#sessionFile === undefined ? {} : { sessionFile: this.#sessionFile }),
      ...(message.execution === undefined ? {} : { execution: message.execution }),
      ...(recoveryMatch === null ? {} : { recoveryOf: recoveryMatch[1]! }),
    };
    this.#options.turnStore?.putTurnLifecycle(lifecycle);
    this.#activeTurn = {
      ...delivery,
      lifecycle,
      activities: [],
      ...(scheduledCompletion === undefined ? {} : { scheduledCompletion }),
    };
    this.#recordTurnTimeline("queued", "Task received");
    this.#queueSourceReaction(this.#activeTurn, "👀");
    this.#startTypingHeartbeat(this.#activeTurn);
    this.#startTaskHeartbeat(this.#activeTurn);
  }

  async #setTurnLifecycle(
    state: TurnLifecycleState,
    change: {
      readonly currentTool?: string;
      readonly clearCurrentTool?: boolean;
      readonly error?: string;
    } = {},
  ): Promise<void> {
    const active = this.#activeTurn;
    const current = active?.lifecycle;
    if (!active || !current) return;
    const now = this.#now();
    const terminal = state === "completed" || state === "stopped" || state === "failed" || state === "interrupted";
    const updated: TurnLifecycle = {
      ...current,
      state,
      updatedAt: now,
      ...(change.currentTool === undefined ? {} : { currentTool: change.currentTool }),
      ...(change.clearCurrentTool === true || terminal ? { currentTool: undefined } : {}),
      ...(terminal ? { finishedAt: now } : {}),
      ...(change.error === undefined ? {} : { error: change.error.slice(0, 1_000) }),
    };
    active.lifecycle = updated;
    this.#options.turnStore?.putTurnLifecycle(updated);
    if (terminal) {
      const text =
        state === "failed"
          ? `Task failed${change.error ? `: ${change.error.slice(0, 240)}` : ""}`
          : state === "interrupted"
            ? `Task interrupted${change.error ? `: ${change.error.slice(0, 240)}` : ""}`
            : state === "stopped"
              ? "Task stopped"
              : "Task completed";
      this.#recordTurnTimeline(state, text);
    }
    if (state === "queued") return;
    if (terminal && !active.statusVisible && state !== "failed" && state !== "interrupted") {
      clearTimeout(active.statusTimer);
      active.statusTimer = undefined;
      active.statusPending = undefined;
      active.statusUrgent = false;
      return;
    }
    this.#queueTurnCard(active, updated, terminal);
  }

  #queueTurnCard(active: ActiveTurn, lifecycle: TurnLifecycle, urgent = false, heartbeat = false): void {
    active.statusPending = lifecycle;
    active.statusUrgent = active.statusUrgent === true || urgent;
    active.statusHeartbeat = active.statusHeartbeat === true || heartbeat;
    if (urgent && active.statusTimer !== undefined) {
      clearTimeout(active.statusTimer);
      active.statusTimer = undefined;
    }
    if (active.statusQueued || active.statusTimer !== undefined) return;
    const delay =
      active.statusUrgent === true
        ? 0
        : active.statusUpdatedAt === undefined
          ? RpcGatewayRuntime.#TURN_CARD_INITIAL_DELAY_MS
          : Math.max(0, RpcGatewayRuntime.#TURN_CARD_THROTTLE_MS - (this.#now() - active.statusUpdatedAt));
    if (delay === 0) {
      this.#enqueueTurnCard(active);
      return;
    }
    active.statusTimer = setTimeout(() => {
      active.statusTimer = undefined;
      this.#enqueueTurnCard(active);
    }, delay);
    active.statusTimer.unref?.();
  }

  #enqueueTurnCard(active: ActiveTurn): void {
    if (active.statusQueued) return;
    active.statusQueued = true;
    this.#turnCardQueue = this.#turnCardQueue.then(async () => {
      active.statusQueued = false;
      const lifecycle = active.statusPending;
      const heartbeat = active.statusHeartbeat === true;
      active.statusPending = undefined;
      active.statusUrgent = false;
      active.statusHeartbeat = false;
      if (lifecycle !== undefined) await this.#renderTurnCard(active, lifecycle, heartbeat);
      if (active.statusPending !== undefined) {
        this.#queueTurnCard(
          active,
          active.statusPending,
          Boolean(active.statusUrgent),
          Boolean(active.statusHeartbeat),
        );
      }
    });
  }

  async #renderTurnCard(active: ActiveTurn, lifecycle: TurnLifecycle, heartbeat = false): Promise<void> {
    try {
      await this.#presentSemanticView(
        active,
        taskSemanticView(
          lifecycle,
          active.activities,
          lifecycle.updatedAt,
          taskTodoPhases(this.#status.state?.todoPhases),
          heartbeat,
          false,
          this.#now(),
        ),
      );
      active.statusVisible = true;
      active.statusUpdatedAt = this.#now();
    } catch (error) {
      this.#log.warn(
        `[ompclaw rpc] Unable to render task lifecycle: ${error instanceof Error ? error.message : String(error)} `,
      );
    }
  }

  async #presentSemanticView(delivery: GatewayTurnTarget, view: SemanticView): Promise<void> {
    const key = JSON.stringify([
      delivery.address.transport,
      delivery.address.account,
      delivery.address.channel,
      delivery.address.thread ?? "",
      view.id,
    ]);
    const storedVersion = this.#options.turnStore?.getSemanticView?.(delivery.address, view.id)?.view.version;
    const localVersion = this.#viewVersions.get(key);
    const version = Math.max(view.version, (storedVersion ?? -1) + 1, (localVersion ?? -1) + 1);
    this.#viewVersions.set(key, version);
    await this.#options.delivery.presentUi(
      delivery.address,
      { type: "semantic_view", view: { ...view, version } },
      delivery.deliveryContext,
    );
  }

  async #tasksCommand(delivery: GatewayTurnTarget): Promise<void> {
    const turns = this.#options.turnStore?.listTurnLifecycles(delivery.address, 20) ?? [];
    const now = this.#now();
    await this.#presentSemanticView(
      delivery,
      taskHistorySemanticView(
        turns.map((lifecycle) => ({
          lifecycle,
          events: this.#options.turnStore?.listTurnTimelineEvents?.(lifecycle.id, 6) ?? [],
        })),
        now,
        now,
      ),
    );
  }

  #ownedTask(delivery: GatewayTurnTarget, id: string): TurnLifecycle | undefined {
    return this.#options.turnStore
      ?.listTurnLifecycles(delivery.address, 100)
      .find((candidate) => candidate.id === id && candidate.principalId === delivery.deliveryContext.principal.id);
  }

  async #resultCommand(
    delivery: GatewayTurnTarget,
    args: string,
    reply: (text: string) => Promise<void>,
  ): Promise<void> {
    const id = args.trim();
    if (!id) {
      await reply("Usage: /result <task-id>");
      return;
    }
    const task = this.#ownedTask(delivery, id);
    const outcome = this.#options.turnStore?.getTurnOutcome?.(id);
    if (task === undefined || outcome === undefined || outcome.principalId !== delivery.deliveryContext.principal.id) {
      await reply("That task result is no longer available.");
      return;
    }
    await this.#options.delivery.send(
      delivery.address,
      {
        text: outcome.text,
        format: "markdown",
        ...(outcome.replyTo === undefined ? {} : { replyTo: outcome.replyTo }),
      },
      delivery.deliveryContext,
    );
  }

  async #taskDetailsCommand(
    delivery: GatewayTurnTarget,
    args: string,
    reply: (text: string) => Promise<void>,
  ): Promise<void> {
    const [id, mode, ...extra] = args.trim().split(/\s+/);
    if (id === undefined || (mode !== undefined && mode !== "hide") || extra.length > 0) {
      await reply("That task is no longer available.");
      return;
    }
    const task = this.#ownedTask(delivery, id);
    if (task === undefined) {
      await reply("That task is no longer available.");
      return;
    }
    if (task.error === undefined) {
      await reply("No additional error details are available for this task.");
      return;
    }
    const now = this.#now();
    await this.#presentSemanticView(delivery, taskSemanticView(task, [], now, [], false, mode !== "hide", this.#now()));
  }

  async #taskRetryCommand(
    delivery: GatewayTurnTarget,
    id: string,
    reply: (text: string) => Promise<void>,
  ): Promise<void> {
    const previous = this.#ownedTask(delivery, id);
    if (previous === undefined) {
      await reply("That task is no longer available in this conversation.");
      return;
    }
    if (previous.state !== "failed" && previous.state !== "interrupted" && previous.state !== "stopped") {
      await reply("Only stopped, failed, or interrupted tasks can be recovered.");
      return;
    }
    if (previous.request === undefined) {
      await reply("This legacy task has no complete request envelope, so retrying it would be unsafe.");
      return;
    }
    await reply(`Choose an explicit recovery mode: /task_recover ${previous.id} inspect|continue|restart`);
  }

  async #taskDiffCommand(
    delivery: GatewayTurnTarget,
    id: string,
    reply: (text: string) => Promise<void>,
  ): Promise<void> {
    const task = this.#ownedTask(delivery, id.trim());
    if (task?.execution === undefined || task.evidence === undefined) {
      await reply("That task has no authorized execution receipt to inspect.");
      return;
    }
    const context = this.#options.resolveExecution?.(
      task.execution,
      delivery.deliveryContext.principal,
      delivery.address,
    );
    const executor = this.#options.executor;
    if (context === undefined || executor === undefined) {
      await reply("That task's project scope is no longer authorized.");
      return;
    }
    const result = await executor.execute({ context, operation: { kind: "diff" }, approved: true });
    await reply(result.text);
  }

  async #taskArtifactCommand(
    delivery: GatewayTurnTarget,
    args: string,
    reply: (text: string) => Promise<void>,
  ): Promise<void> {
    const [taskId, artifactId, extra] = args.trim().split(/\s+/);
    if (taskId === undefined || artifactId === undefined || extra !== undefined) {
      await reply("Usage: /task_artifact <task-id> <artifact-id>");
      return;
    }
    const task = this.#ownedTask(delivery, taskId);
    const artifact = task?.evidence?.artifacts.find((candidate) => candidate.id === artifactId);
    if (task?.execution === undefined || artifact === undefined) {
      await reply("That artifact is no longer available for this task.");
      return;
    }
    const context = this.#options.resolveExecution?.(
      task.execution,
      delivery.deliveryContext.principal,
      delivery.address,
    );
    const executor = this.#options.executor;
    if (context === undefined || executor === undefined) {
      await reply("That task's project scope is no longer authorized.");
      return;
    }
    const result = await executor.execute({
      context,
      operation: { kind: "artifact", path: artifact.path },
      approved: true,
    });
    const received = result.artifact;
    if (
      received === undefined ||
      received.id !== artifact.id ||
      received.sha256 !== artifact.sha256 ||
      received.size !== artifact.size ||
      typeof result.artifactBase64 !== "string"
    ) {
      throw new Error("Artifact receipt verification failed");
    }
    const bytes = Buffer.from(result.artifactBase64, "base64");
    if (bytes.byteLength !== artifact.size || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
      throw new Error("Artifact receipt size or hash verification failed");
    }
    const taskStagingKey = createHash("sha256").update(task.id).digest("hex");
    const artifactStagingKey = createHash("sha256").update(artifact.id).digest("hex");
    const stagingDirectory = join(this.#options.config.stateDir, "task-artifacts", taskStagingKey);
    const stagedPath = join(stagingDirectory, `${artifactStagingKey}.artifact`);
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    await chmod(stagingDirectory, 0o700);
    await writeFile(stagedPath, bytes, { mode: 0o600 });
    await chmod(stagedPath, 0o600);
    await this.#options.delivery.send(
      delivery.address,
      {
        text: `Artifact: ${artifact.name}`,
        attachments: [
          {
            url: pathToFileURL(stagedPath).toString(),
            name: artifact.name,
            ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
          },
        ],
        format: "text",
      },
      delivery.deliveryContext,
    );
  }

  async #taskRecoverCommand(
    delivery: GatewayTurnTarget,
    args: string,
    reply: (text: string) => Promise<void>,
  ): Promise<void> {
    const [id, mode, extra] = args.trim().split(/\s+/);
    if (id === undefined || !["inspect", "continue", "restart"].includes(mode ?? "") || extra !== undefined) {
      await reply("Usage: /task_recover <task-id> <inspect|continue|restart>");
      return;
    }
    const previous = this.#ownedTask(delivery, id);
    if (previous === undefined) {
      await reply("That task is no longer available in this conversation.");
      return;
    }
    if (mode === "inspect") {
      await reply(
        `Task ${previous.id}\nState: ${previous.state}\nProject: ${previous.execution?.projectName ?? "legacy"}\nHost: ${previous.evidence?.host ?? previous.execution?.workerId ?? "n/a"}\n${previous.error ? `Error: ${previous.error}` : "No error detail recorded."}`,
      );
      return;
    }
    if (mode === "continue") {
      await this.#taskContinuationCommand(
        delivery,
        `${previous.id} Continue from the last safe point.`,
        "continue",
        reply,
      );
      return;
    }
    if (this.#currentTurnBusy() || previous.request === undefined) {
      await reply(
        previous.request === undefined
          ? "This legacy task has no complete request envelope, so restarting it would be unsafe."
          : "Wait for the current task to finish before restarting another task.",
      );
      return;
    }
    const storedExecution = previous.execution;
    const execution =
      storedExecution === undefined
        ? undefined
        : this.#options.resolveExecution?.(storedExecution, delivery.deliveryContext.principal, delivery.address);
    if (storedExecution !== undefined && execution === undefined) {
      await reply(
        "This project task's scope has expired or is no longer authorized. Select or renew the project explicitly.",
      );
      return;
    }
    const approval = await this.#options.delivery.presentUi(
      delivery.address,
      {
        type: "confirm",
        title: `Restart task — ${execution?.projectName ?? "legacy"} on ${execution?.workerId ?? "local"}`,
        message:
          "Restart can repeat side effects that may already have started. Continue only if you intend to run the original request again.",
        confirmLabel: "Restart task",
        cancelLabel: "Cancel",
      },
      delivery.deliveryContext,
    );
    if (!approval.confirmed) {
      await reply("Task restart was not approved.");
      return;
    }
    if (execution !== undefined) await this.selectProject(execution, previous.sessionFile);
    await this.handleInbound({
      ...previous.request,
      id: `task-restart:${previous.id}:${this.#now()}`,
      sentAt: this.#now(),
      principal: delivery.deliveryContext.principal,
      execution,
      edited: false,
    });
  }

  async #taskContinuationCommand(
    delivery: GatewayTurnTarget,
    args: string,
    mode: "continue" | "revise",
    reply: (text: string) => Promise<void>,
  ): Promise<void> {
    const [id, ...instructionParts] = args.trim().split(/\s+/);
    const instruction = instructionParts.join(" ").trim();
    if (id === undefined || instruction.length === 0) {
      await reply(`Usage: /task_${mode} <task-id> <message>`);
      return;
    }
    const previous = this.#ownedTask(delivery, id);
    if (previous === undefined) {
      await reply("That task is no longer available in this conversation.");
      return;
    }
    if (this.#currentTurnBusy()) {
      await reply("Wait for the current task to finish before continuing another task.");
      return;
    }
    if (previous.request === undefined) {
      await reply("This legacy task has no complete request envelope, so continuation would be unsafe.");
      return;
    }
    const storedExecution = previous.execution;
    const execution =
      storedExecution === undefined
        ? undefined
        : this.#options.resolveExecution?.(storedExecution, delivery.deliveryContext.principal, delivery.address);
    if (storedExecution !== undefined && execution === undefined) {
      await reply(
        "This project task's scope has expired or is no longer authorized. Select or renew the project explicitly.",
      );
      return;
    }
    if (execution !== undefined) await this.selectProject(execution, previous.sessionFile);
    const outcome = this.#options.turnStore?.getTurnOutcome?.(previous.id);
    const priorResult =
      mode === "revise" ? `\n\nPrevious result:\n${outcome?.text ?? "No final result was recorded."}` : "";
    await this.handleInbound({
      ...previous.request,
      id: `task-${mode}:${previous.id}:${this.#now()}`,
      sentAt: this.#now(),
      principal: delivery.deliveryContext.principal,
      execution,
      content: {
        ...previous.request.content,
        text: `${mode === "continue" ? "Continue" : "Revise"} this prior task. Full original request:\n${previous.request.content.text ?? ""}${priorResult}\n\nNew instruction:\n${instruction}`,
      },
      edited: false,
    });
  }

  #missingTerminalSummaryText(state: "completed" | "stopped" | "failed"): string {
    if (state === "stopped")
      return "The task stopped before OMP produced a final summary. Use /tasks for recovery controls.";
    if (state === "failed")
      return "The task failed before OMP produced a final summary. Its task card has recovery controls.";
    return "The task completed, but OMP produced no final summary. Ask for a summary of the completed work.";
  }

  #terminalState(messages: unknown): "completed" | "stopped" | "failed" {
    if (!Array.isArray(messages)) return "completed";
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (!isRecord(message) || message.role !== "assistant") continue;
      if (message.stopReason === "aborted") return "stopped";
      if (message.stopReason === "error") return "failed";
    }
    return "completed";
  }

  #queueSourceReaction(delivery: GatewayTurnTarget | undefined, emoji: string): void {
    if (!delivery?.sourceReceipt) return;
    const key = JSON.stringify([
      delivery.address.transport,
      delivery.address.account,
      delivery.address.channel,
      delivery.address.thread ?? "",
      delivery.sourceReceipt.transport,
      delivery.sourceReceipt.messageId,
    ]);
    const previous = this.#reactionQueues.get(key);
    const queued =
      previous === undefined
        ? this.#reactToSource(delivery, emoji)
        : previous.then(() => this.#reactToSource(delivery, emoji));
    this.#reactionQueues.set(key, queued);
    void queued.finally(() => {
      if (this.#reactionQueues.get(key) === queued) this.#reactionQueues.delete(key);
    });
  }

  async #recoverPendingTurnOutcomes(): Promise<void> {
    const store = this.#options.turnStore;
    if (
      store === undefined ||
      typeof store.listPendingTurnOutcomes !== "function" ||
      typeof store.getPrincipal !== "function" ||
      typeof store.recordTurnOutcomeAttempt !== "function" ||
      typeof store.markTurnOutcomeDelivered !== "function"
    ) {
      return;
    }
    for (const outcome of store.listPendingTurnOutcomes()) {
      const principal: Principal | undefined = store.getPrincipal(outcome.principalId);
      if (principal === undefined) {
        this.#log.warn(`[ompclaw rpc] Unable to recover outcome ${outcome.turnId}: principal no longer exists`);
        continue;
      }
      try {
        store.recordTurnOutcomeAttempt(outcome.turnId, this.#now());
        await this.#options.delivery.send(
          outcome.address,
          {
            text: outcome.text,
            format: "markdown",
            ...(outcome.replyTo === undefined ? {} : { replyTo: outcome.replyTo }),
          },
          { principal, origin: outcome.address },
        );
        store.markTurnOutcomeDelivered(outcome.turnId, this.#now());
      } catch (error) {
        this.#log.warn(
          `[ompclaw rpc] Unable to recover outcome ${outcome.turnId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async #reactToSource(delivery: GatewayTurnTarget | undefined, emoji: string): Promise<void> {
    if (!delivery?.sourceReceipt) return;
    try {
      await this.#options.delivery.react(delivery.address, delivery.sourceReceipt, { emoji }, delivery.deliveryContext);
    } catch (error) {
      this.#log.warn(
        `[ompclaw rpc] Unable to update source reaction: ${error instanceof Error ? error.message : String(error)} `,
      );
    }
  }

  async #send(delivery: RpcGatewayUiTarget, text: string): Promise<void> {
    await this.#options.delivery.send(delivery.address, { text, format: "text" }, delivery.deliveryContext);
  }

  async #sendRuntimeMessage(text: string): Promise<void> {
    if (this.#activeTurn) await this.#send(this.#activeTurn, text);
  }

  async #deliverAssistantPreview(text: string): Promise<void> {
    const active = this.#activeTurn;
    if (!active || text.trim().length === 0 || active.previewText === text) return;
    const content = { text, format: "text" as const, transient: true };
    if (active.receipt) {
      active.receipt = await this.#options.delivery.update(
        active.address,
        active.receipt,
        content,
        active.deliveryContext,
      );
    } else {
      active.receipt = await this.#options.delivery.send(active.address, content, active.deliveryContext);
    }
    active.previewText = text;
  }

  async #finalizeAssistantText(
    text: string,
    state: Extract<TurnLifecycleState, "completed" | "stopped" | "failed">,
  ): Promise<boolean> {
    const active = this.#activeTurn;
    const lifecycle = active?.lifecycle;
    if (!active || !lifecycle || text.trim().length === 0 || active.finalText === text) return false;
    const now = this.#now();
    this.#options.turnStore?.putTurnOutcome?.({
      turnId: lifecycle.id,
      principalId: lifecycle.principalId,
      address: lifecycle.address,
      state,
      text,
      createdAt: now,
      attemptCount: 0,
      ...(active.sourceReceipt === undefined ? {} : { replyTo: active.sourceReceipt }),
    });
    this.#options.turnStore?.recordTurnOutcomeAttempt?.(lifecycle.id, now);
    const receipts = await this.#options.delivery.finalize(
      active.address,
      active.receipt,
      { text, format: "markdown", ...(active.sourceReceipt === undefined ? {} : { replyTo: active.sourceReceipt }) },
      active.deliveryContext,
    );
    active.receipt = receipts[0] ?? active.receipt;
    this.#options.turnStore?.markTurnOutcomeDelivered?.(lifecycle.id, this.#now());
    active.previewText = text;
    active.finalText = text;
    return true;
  }

  #startTypingHeartbeat(active: ActiveTurn): void {
    if (active.typingTimer !== undefined || this.#options.delivery.typing === undefined) return;
    const pulse = (): void => {
      if (this.#activeTurn !== active) return;
      void this.#options.delivery.typing?.(active.address, active.deliveryContext).catch((error: unknown) => {
        this.#log.warn(
          `[ompclaw rpc] Unable to refresh typing status: ${error instanceof Error ? error.message : String(error)} `,
        );
      });
    };
    pulse();
    active.typingTimer = setInterval(pulse, RpcGatewayRuntime.#TYPING_REFRESH_MS);
    active.typingTimer.unref?.();
  }

  #startTaskHeartbeat(active: ActiveTurn): void {
    const pulse = (): void => {
      if (this.#activeTurn !== active || active.lifecycle === undefined) return;
      if (active.lifecycle.state === "queued" || active.lifecycle.state === "running") {
        this.#queueTurnCard(active, { ...active.lifecycle, updatedAt: this.#now() }, false, true);
      }
      active.heartbeatTimer = setTimeout(pulse, RpcGatewayRuntime.#TURN_CARD_HEARTBEAT_MS);
      active.heartbeatTimer.unref?.();
    };
    active.heartbeatTimer = setTimeout(pulse, RpcGatewayRuntime.#TURN_CARD_HEARTBEAT_MS);
    active.heartbeatTimer.unref?.();
  }

  #stopTurnPresentation(active: ActiveTurn): void {
    clearInterval(active.typingTimer);
    active.typingTimer = undefined;
    clearTimeout(active.heartbeatTimer);
    active.heartbeatTimer = undefined;
    clearTimeout(active.statusTimer);
    active.statusTimer = undefined;
  }
  async #handleHostToolCall(call: RpcHostToolCall): Promise<void> {
    const rpc = this.#rpc;
    const active = this.#activeTurn;
    if (!rpc) return;
    const controller = new AbortController();
    this.#hostTools.set(call.id, { controller });
    try {
      if (!active) throw new Error("No active delivery context is available for host tools");
      const result =
        active.lifecycle?.execution === undefined
          ? await executeGatewayHostTool(
              call,
              {
                delivery: this.#options.delivery,
                address: active.address,
                deliveryContext: active.deliveryContext,
                identity: active.identity,
                automation: this.#options.automation,
                updates: this.#options.updates,
              },
              controller.signal,
            )
          : await this.#executeScopedHostTool(call, active, controller.signal);
      if (!controller.signal.aborted) {
        rpc.write({
          type: "host_tool_result",
          id: call.id,
          result: { content: [{ type: "text", text: valueText(result) }] },
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        rpc.write({
          type: "host_tool_result",
          id: call.id,
          isError: true,
          result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] },
        });
      }
    } finally {
      this.#hostTools.delete(call.id);
    }
  }

  #assertScopedExecutionActive(context: TaskExecutionContext, active: ActiveTurn, signal: AbortSignal): void {
    if (signal.aborted || this.#activeTurn !== active) {
      throw new Error("The project operation is no longer active");
    }
    if (
      active.lifecycle?.principalId !== active.deliveryContext.principal.id ||
      active.lifecycle.execution === undefined ||
      !this.#sameExecutionContext(context, active.lifecycle.execution) ||
      !this.#sameExecutionContext(context, this.#execution) ||
      context.expiresAt <= this.#now()
    ) {
      throw new Error("The project execution grant is no longer active");
    }
    if (this.#options.authorizeExecution?.(context, active.deliveryContext.principal) === false) {
      throw new Error("The selected project is no longer authorized");
    }
  }

  async #executeScopedHostTool(
    call: RpcHostToolCall,
    active: ActiveTurn,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    const context = active.lifecycle?.execution;
    const executor = this.#options.executor;
    if (context === undefined || executor === undefined) throw new Error("Scoped project execution is unavailable");
    this.#assertScopedExecutionActive(context, active, signal);
    const text = (name: string): string => {
      const value = call.arguments[name];
      if (typeof value !== "string" || value.length === 0) throw new Error(`${call.toolName} requires ${name}`);
      return value;
    };
    const flag = (name: string): boolean => {
      const value = call.arguments[name];
      if (value === undefined) return false;
      if (typeof value !== "boolean") throw new Error(`${call.toolName} ${name} must be boolean`);
      return value;
    };
    let operation: ExecutionOperation;
    switch (call.toolName) {
      case "fs_list":
        operation = { kind: "list", path: text("path") };
        break;
      case "fs_read":
        operation = { kind: "read", path: text("path") };
        break;
      case "fs_write":
        if (!context.policy.write) throw new Error("Project policy does not allow writing files");
        operation = { kind: "write", path: text("path"), content: text("content") };
        break;
      case "cmd_run": {
        if (!context.policy.commands) throw new Error("Project policy does not allow commands");
        const writable = flag("writable");
        const network = flag("network");
        if (writable && !context.policy.write) throw new Error("Project policy does not allow writable commands");
        if (network && !context.policy.network) throw new Error("Project policy does not allow network access");
        const command = text("command");
        const approval = await this.#options.delivery.presentUi(
          active.address,
          {
            type: "confirm",
            title: `Run command — ${context.projectName} on ${context.workerId}`,
            message: `${command}\n\nProject: ${context.projectName}\nHost: ${context.workerId}\nWritable: ${writable ? "yes" : "no"}\nNetwork: ${network ? "yes" : "no"}`,
            confirmLabel: "Run command",
            cancelLabel: "Deny",
          },
          active.deliveryContext,
          signal,
        );
        if (!approval.confirmed) throw new Error("Command was not approved");
        this.#assertScopedExecutionActive(context, active, signal);
        operation = { kind: "run", command, writable, network };
        break;
      }
      case "fs_diff":
        operation = { kind: "diff" };
        break;
      case "artifact_store":
        operation = { kind: "artifact", path: text("path") };
        break;
      default:
        throw new Error(`Scoped project tool ${call.toolName} is not available`);
    }
    const result = await executor.execute({ context, operation, approved: true }, signal);
    this.#recordExecutionEvidence(active, context, result);
    return result;
  }

  #recordExecutionEvidence(active: ActiveTurn, context: TaskExecutionContext, result: ExecutionResult): void {
    const lifecycle = active.lifecycle;
    if (lifecycle === undefined) return;
    const existing = lifecycle.evidence;
    const revision = result.revision ?? existing?.revision;
    const receivedArtifact = result.artifact;
    const artifact =
      receivedArtifact === undefined
        ? undefined
        : {
            id: receivedArtifact.id,
            name: receivedArtifact.name,
            path: receivedArtifact.path,
            ...(receivedArtifact.mediaType === undefined ? {} : { mediaType: receivedArtifact.mediaType }),
            size: receivedArtifact.size,
            sha256: receivedArtifact.sha256,
          };
    const evidence: TaskEvidence = {
      projectId: context.projectId,
      host: context.workerId,
      ...(revision === undefined ? {} : { revision }),
      changedFiles: [...new Set([...(existing?.changedFiles ?? []), ...(result.changedFiles ?? [])])],
      checks: result.check === undefined ? (existing?.checks ?? []) : [...(existing?.checks ?? []), result.check],
      artifacts:
        artifact === undefined
          ? (existing?.artifacts ?? [])
          : [
              ...(existing?.artifacts ?? []).filter((existingArtifact) => existingArtifact.id !== artifact.id),
              artifact,
            ],
    };
    const updated = { ...lifecycle, updatedAt: this.#now(), evidence };
    active.lifecycle = updated;
    this.#options.turnStore?.putTurnLifecycle(updated);
  }
}
