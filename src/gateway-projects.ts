import type { ProjectDefinition, TaskExecutionContext } from "./execution-types";
import type { JsonValue } from "./gateway-store";
import type { ConversationAddress, InboundMessage, Principal } from "./gateway-types";
import { isRecord } from "./type-guards";

const CHECKPOINT_ADAPTER = "projects";
const BINDING_KEY_PREFIX = "binding:";
const SESSION_KEY_PREFIX = "session:";
const PROJECT_COMMAND = /^\/project(?:@[A-Za-z0-9_]+)?(?:\s+([^\s]+))?\s*$/i;
const PROJECT_COMMAND_PREFIX = /^\/project(?:@[A-Za-z0-9_]+)?(?:\s|$)/i;
const PROJECTS_COMMAND = /^\/projects(?:@[A-Za-z0-9_]+)?\s*$/i;
const SCOPE_COMMAND = /^\/scope(?:@[A-Za-z0-9_]+)?(?:\s+(read|work|network)(?:\s+([0-9]+))?)?\s*$/i;
const SCOPE_COMMAND_PREFIX = /^\/scope(?:@[A-Za-z0-9_]+)?(?:\s|$)/i;
const PROJECTS_COMMAND_PREFIX = /^\/projects(?:@[A-Za-z0-9_]+)?(?:\s|$)/i;

export interface GatewayProjectCheckpointStore {
  getCheckpoint(adapter: string, key: string): JsonValue | undefined;
  setCheckpoint(adapter: string, key: string, value: JsonValue): void;
}
export type GatewayProjectCommand =
  | { readonly kind: "list" }
  | { readonly kind: "show" }
  | { readonly kind: "select"; readonly projectId: string }
  | { readonly kind: "scope-show" }
  | { readonly kind: "scope-set"; readonly mode: GatewayProjectScopeMode; readonly minutes?: number }
  | { readonly kind: "usage" };

export interface GatewayProjectSelection {
  readonly context: TaskExecutionContext;
  readonly sessionFile?: string;
}

export type GatewayProjectResolution =
  | { readonly kind: "none" }
  | { readonly kind: "selected"; readonly selection: GatewayProjectSelection }
  | {
      readonly kind: "unavailable";
      readonly projectId: string;
      readonly reason: "unauthorized" | "removed" | "reconfigured" | "invalid" | "expired";
    };

interface StoredBinding {
  readonly projectId: string;
  readonly fingerprint: string;
}

interface StoredSession {
  readonly fingerprint: string;
  readonly sessionFile: string;
}

export interface GatewayProjectScopeClaim {
  readonly adapter: string;
  readonly key: string;
  readonly expectedValue: JsonValue;
}

export interface GatewayProjectTaskCapture {
  readonly resolution: GatewayProjectResolution;
  readonly scopeClaim?: GatewayProjectScopeClaim;
}

export type GatewayProjectScopeMode = "read" | "work" | "network";

interface StoredScope {
  readonly projectId: string;
  readonly fingerprint: string;
  readonly mode: GatewayProjectScopeMode;
  readonly policy: TaskExecutionContext["policy"];
  readonly maxDurationMs: number;
}

/**
 * Durable, principal-scoped project selection. Checkpoints deliberately retain
 * only a configured project id plus a fingerprint; workspaces and policies are
 * always recovered from the current server configuration.
 */
export class GatewayProjectRouter {
  readonly #projects: readonly ProjectDefinition[];
  readonly #store: GatewayProjectCheckpointStore;
  readonly #now: () => number;

  constructor(options: {
    readonly projects?: readonly ProjectDefinition[];
    readonly store: GatewayProjectCheckpointStore;
    readonly now?: () => number;
  }) {
    this.#projects = options.projects ?? [];
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
  }

  commandFor(message: InboundMessage): GatewayProjectCommand | undefined {
    const text = message.content.text?.trim();
    if (text === undefined || text.length === 0) return undefined;
    const scope = text.match(SCOPE_COMMAND);
    if (scope !== null) {
      const mode = scope[1]?.toLowerCase() as GatewayProjectScopeMode | undefined;
      const minutes = scope[2] === undefined ? undefined : Number(scope[2]);
      return mode === undefined
        ? { kind: "scope-show" }
        : { kind: "scope-set", mode, ...(minutes === undefined ? {} : { minutes }) };
    }
    if (SCOPE_COMMAND_PREFIX.test(text)) return { kind: "usage" };
    if (PROJECTS_COMMAND.test(text)) return { kind: "list" };
    if (PROJECTS_COMMAND_PREFIX.test(text)) return { kind: "usage" };
    const project = text.match(PROJECT_COMMAND);
    if (project !== null) {
      const projectId = project[1];
      return projectId === undefined ? { kind: "show" } : { kind: "select", projectId };
    }
    return PROJECT_COMMAND_PREFIX.test(text) ? { kind: "usage" } : undefined;
  }

  list(principal: Principal): readonly ProjectDefinition[] {
    return this.#projects.filter((project) => project.principals.includes(principal.id));
  }

  select(message: InboundMessage, projectId: string): GatewayProjectResolution {
    const project = this.#projectById(projectId);
    if (project === undefined) return { kind: "unavailable", projectId, reason: "removed" };
    if (!project.principals.includes(message.principal.id)) {
      return { kind: "unavailable", projectId, reason: "unauthorized" };
    }

    const binding: StoredBinding = { projectId: project.id, fingerprint: projectFingerprint(project) };
    this.#store.setCheckpoint(CHECKPOINT_ADAPTER, this.#bindingKey(message.principal, message.address), {
      projectId: binding.projectId,
      fingerprint: binding.fingerprint,
    });
    return this.#selection(project, binding, message.principal, message.address);
  }

  resolve(message: InboundMessage): GatewayProjectResolution {
    const value = this.#store.getCheckpoint(CHECKPOINT_ADAPTER, this.#bindingKey(message.principal, message.address));
    if (value === undefined) return { kind: "none" };
    const binding = parseBinding(value);
    if (binding === undefined) return { kind: "unavailable", projectId: "unknown", reason: "invalid" };

    const project = this.#projectById(binding.projectId);
    if (project === undefined) return { kind: "unavailable", projectId: binding.projectId, reason: "removed" };
    if (!project.principals.includes(message.principal.id)) {
      return { kind: "unavailable", projectId: binding.projectId, reason: "unauthorized" };
    }
    if (binding.fingerprint !== projectFingerprint(project)) {
      return { kind: "unavailable", projectId: binding.projectId, reason: "reconfigured" };
    }
    return this.#selection(project, binding, message.principal, message.address);
  }

  captureTask(message: InboundMessage): GatewayProjectTaskCapture {
    const resolution = this.resolve(message);
    if (resolution.kind !== "selected") return { resolution };
    const scopeRecord = this.#scopeRecord(message, resolution.selection.context.projectId);
    if (scopeRecord === undefined) return { resolution };
    const { context } = resolution.selection;
    return {
      resolution: {
        kind: "selected",
        selection: {
          ...resolution.selection,
          context: {
            ...context,
            policy: { ...scopeRecord.scope.policy, maxDurationMs: scopeRecord.scope.maxDurationMs },
            expiresAt: this.#now() + scopeRecord.scope.maxDurationMs,
          },
        },
      },
      scopeClaim: {
        adapter: CHECKPOINT_ADAPTER,
        key: this.#scopeKey(message.principal, message.address),
        expectedValue: scopeRecord.value,
      },
    };
  }

  prepareTask(message: InboundMessage): GatewayProjectResolution {
    return this.captureTask(message).resolution;
  }

  renewExecution(
    stored: TaskExecutionContext,
    principal: Principal,
    address: ConversationAddress,
  ): TaskExecutionContext | undefined {
    const binding = this.#bindingFor(principal, address);
    if (binding === undefined || binding.projectId !== stored.projectId) return undefined;
    const project = this.#projectById(stored.projectId);
    if (
      project === undefined ||
      !project.principals.includes(principal.id) ||
      binding.fingerprint !== projectFingerprint(project) ||
      !matchesProjectContext(stored, project)
    ) {
      return undefined;
    }
    const refreshed = this.#selection(project, binding, principal, address);
    return refreshed.kind === "selected" ? refreshed.selection.context : undefined;
  }

  authorizeExecution(context: TaskExecutionContext, principal: Principal): boolean {
    if (context.expiresAt <= this.#now()) return false;
    const project = this.#projectById(context.projectId);
    if (project?.principals.includes(principal.id) !== true) return false;
    return matchesProjectContext(context, project);
  }

  setNextScope(
    message: InboundMessage,
    mode: GatewayProjectScopeMode,
    minutes?: number,
  ): { readonly text: string } | GatewayProjectResolution {
    const resolution = this.resolve(message);
    if (resolution.kind !== "selected") return resolution;
    const project = this.#projectById(resolution.selection.context.projectId);
    if (project === undefined) return { kind: "unavailable", projectId: "unknown", reason: "removed" };
    const policy =
      mode === "read"
        ? { write: false, commands: false, network: false, maxDurationMs: project.policy.maxDurationMs }
        : mode === "work"
          ? { ...project.policy, network: false }
          : project.policy;
    if (mode === "network" && !project.policy.network) {
      return { text: `Project ${project.id} does not allow network scope.` };
    }
    if (minutes !== undefined && (!Number.isSafeInteger(minutes) || minutes < 1)) {
      return { text: "Scope duration must be a positive whole number of minutes." };
    }
    const maxDurationMs = minutes === undefined ? project.policy.maxDurationMs : minutes * 60_000;
    if (maxDurationMs > project.policy.maxDurationMs) {
      return { text: `Scope duration cannot exceed ${Math.floor(project.policy.maxDurationMs / 60_000)} minute(s).` };
    }
    const binding = this.#bindingFor(message.principal, message.address);
    if (binding === undefined) return { kind: "unavailable", projectId: project.id, reason: "invalid" };
    const scopedPolicy = { ...policy, maxDurationMs };
    this.#store.setCheckpoint(CHECKPOINT_ADAPTER, this.#scopeKey(message.principal, message.address), {
      projectId: project.id,
      fingerprint: binding.fingerprint,
      mode,
      policy: scopedPolicy,
      maxDurationMs,
    });
    return { text: `Next task scope: ${mode} (${Math.ceil(maxDurationMs / 60_000)} minute(s) maximum).` };
  }

  scopeStatus(message: InboundMessage): string {
    const resolution = this.resolve(message);
    if (resolution.kind !== "selected") return formatProjectResolution(resolution);
    const maximum = Math.ceil(resolution.selection.context.policy.maxDurationMs / 60_000);
    const scope = this.#scopeRecord(message, resolution.selection.context.projectId)?.scope;
    if (scope === undefined) {
      return `Current project grant: default (${maximum} minute(s) maximum). Next task grant: default; it expires ${maximum} minute(s) after acceptance.`;
    }
    const nextMaximum = Math.ceil(scope.maxDurationMs / 60_000);
    return `Current project grant: default (${maximum} minute(s) maximum). Next task grant: ${scope.mode}; it expires ${nextMaximum} minute(s) after acceptance.`;
  }

  resolveCaptured(message: InboundMessage): GatewayProjectResolution {
    const context = message.execution;
    if (context === undefined) return this.resolve(message);
    if (context.expiresAt <= this.#now()) {
      return { kind: "unavailable", projectId: context.projectId, reason: "expired" };
    }

    const binding = this.#bindingFor(message.principal, message.address);
    if (binding === undefined || binding.projectId !== context.projectId) {
      return { kind: "unavailable", projectId: context.projectId, reason: "reconfigured" };
    }
    const project = this.#projectById(context.projectId);
    if (project === undefined) return { kind: "unavailable", projectId: context.projectId, reason: "removed" };
    if (!project.principals.includes(message.principal.id)) {
      return { kind: "unavailable", projectId: context.projectId, reason: "unauthorized" };
    }
    if (binding.fingerprint !== projectFingerprint(project) || !matchesProjectContext(context, project)) {
      return { kind: "unavailable", projectId: context.projectId, reason: "reconfigured" };
    }

    const storedSession = parseSession(
      this.#store.getCheckpoint(CHECKPOINT_ADAPTER, this.#sessionKey(message.principal, message.address, project.id)),
    );
    if (storedSession !== undefined && storedSession.fingerprint !== binding.fingerprint) {
      return { kind: "unavailable", projectId: context.projectId, reason: "reconfigured" };
    }
    return {
      kind: "selected",
      selection: {
        context,
        ...(storedSession === undefined ? {} : { sessionFile: storedSession.sessionFile }),
      },
    };
  }

  checkpointSession(message: InboundMessage, selection: GatewayProjectSelection, sessionFile: string): void {
    if (sessionFile.length === 0) throw new Error("Project session checkpoint must be a non-empty string");
    const binding = this.#bindingFor(message.principal, message.address);
    if (binding === undefined || binding.projectId !== selection.context.projectId) {
      throw new Error("Project binding changed before its session could be checkpointed");
    }
    const project = this.#projectById(binding.projectId);
    if (project === undefined || binding.fingerprint !== projectFingerprint(project)) {
      throw new Error("Project configuration changed before its session could be checkpointed");
    }
    this.#store.setCheckpoint(
      CHECKPOINT_ADAPTER,
      this.#sessionKey(message.principal, message.address, binding.projectId),
      {
        fingerprint: binding.fingerprint,
        sessionFile,
      },
    );
  }

  #selection(
    project: ProjectDefinition,
    binding: StoredBinding,
    principal: Principal,
    address: ConversationAddress,
  ): GatewayProjectResolution {
    const storedSession = parseSession(
      this.#store.getCheckpoint(CHECKPOINT_ADAPTER, this.#sessionKey(principal, address, project.id)),
    );
    if (storedSession !== undefined && storedSession.fingerprint !== binding.fingerprint) {
      return { kind: "unavailable", projectId: project.id, reason: "reconfigured" };
    }
    return {
      kind: "selected",
      selection: {
        context: {
          projectId: project.id,
          projectName: project.name,
          workspace: project.workspace,
          workerId: project.workerId,
          policy: project.policy,
          ...(project.model === undefined ? {} : { model: project.model }),
          expiresAt: this.#now() + project.policy.maxDurationMs,
        },
        ...(storedSession === undefined ? {} : { sessionFile: storedSession.sessionFile }),
      },
    };
  }
  #scopeRecord(
    message: InboundMessage,
    projectId: string,
  ): { readonly scope: StoredScope; readonly value: JsonValue } | undefined {
    const value = this.#store.getCheckpoint(CHECKPOINT_ADAPTER, this.#scopeKey(message.principal, message.address));
    if (value === undefined) return undefined;
    const scope = parseScope(value);
    if (scope === undefined || scope.projectId !== projectId) return undefined;
    const binding = this.#bindingFor(message.principal, message.address);
    if (binding === undefined || binding.fingerprint !== scope.fingerprint) return undefined;
    return { scope, value };
  }

  #bindingFor(principal: Principal, address: ConversationAddress): StoredBinding | undefined {
    return parseBinding(this.#store.getCheckpoint(CHECKPOINT_ADAPTER, this.#bindingKey(principal, address)));
  }

  #projectById(projectId: string): ProjectDefinition | undefined {
    const matches = this.#projects.filter((project) => project.id === projectId);
    return matches.length === 1 ? matches[0] : undefined;
  }

  #bindingKey(principal: Principal, address: ConversationAddress): string {
    return `${BINDING_KEY_PREFIX}${scopeKey(principal, address)}`;
  }

  #scopeKey(principal: Principal, address: ConversationAddress): string {
    return `scope:${scopeKey(principal, address)}`;
  }
  #sessionKey(principal: Principal, address: ConversationAddress, projectId: string): string {
    return `${SESSION_KEY_PREFIX}${scopeKey(principal, address)}:${encodeURIComponent(projectId)}`;
  }
}

export function formatProjectList(projects: readonly ProjectDefinition[]): string {
  if (projects.length === 0) return "No projects are authorized for this account.";
  return [
    "Projects:",
    ...projects.map((project) => `• ${project.id} — ${project.name}`),
    "",
    "Use /project <id> to select a project.",
  ].join("\n");
}

export function formatProjectResolution(resolution: GatewayProjectResolution): string {
  if (resolution.kind === "none") return "No project is selected. Use /projects to see available projects.";
  if (resolution.kind === "selected") {
    const { projectId, projectName } = resolution.selection.context;
    return `Project selected: ${projectName} (${projectId}).`;
  }
  switch (resolution.reason) {
    case "unauthorized":
      return `Project ${resolution.projectId} is no longer authorized for this account. Use /projects to choose an available project.`;
    case "removed":
      return `Project ${resolution.projectId} is no longer configured. Use /projects to choose an available project.`;
    case "reconfigured":
      return `Project ${resolution.projectId} changed and must be selected again. Use /projects to choose it.`;
    case "invalid":
      return "The saved project selection is invalid. Use /projects to choose a project.";
    case "expired":
      return `Project ${resolution.projectId} selection expired before this request could run. Send the request again.`;
  }
}

function scopeKey(principal: Principal, address: ConversationAddress): string {
  return encodeURIComponent(
    JSON.stringify([principal.id, address.transport, address.account, address.channel, address.thread ?? null]),
  );
}

function projectFingerprint(project: ProjectDefinition): string {
  return JSON.stringify([
    project.id,
    project.name,
    project.workspace,
    project.workerId,
    project.principals,
    project.policy.write,
    project.policy.commands,
    project.policy.network,
    project.policy.maxDurationMs,
    project.model ?? null,
  ]);
}

function parseBinding(value: JsonValue | undefined): StoredBinding | undefined {
  if (!isRecord(value) || typeof value.projectId !== "string" || typeof value.fingerprint !== "string")
    return undefined;
  return { projectId: value.projectId, fingerprint: value.fingerprint };
}

function parseSession(value: JsonValue | undefined): StoredSession | undefined {
  if (!isRecord(value) || typeof value.fingerprint !== "string" || typeof value.sessionFile !== "string")
    return undefined;
  if (value.sessionFile.length === 0) return undefined;
  return { fingerprint: value.fingerprint, sessionFile: value.sessionFile };
}

function parseScope(value: JsonValue | undefined): StoredScope | undefined {
  if (!isRecord(value) || typeof value.projectId !== "string" || typeof value.fingerprint !== "string")
    return undefined;
  if (value.mode !== "read" && value.mode !== "work" && value.mode !== "network") return undefined;
  if (!isRecord(value.policy) || typeof value.maxDurationMs !== "number") return undefined;
  const policy = value.policy;
  if (
    typeof policy.write !== "boolean" ||
    typeof policy.commands !== "boolean" ||
    typeof policy.network !== "boolean" ||
    typeof policy.maxDurationMs !== "number" ||
    !Number.isSafeInteger(value.maxDurationMs) ||
    value.maxDurationMs < 1 ||
    policy.maxDurationMs !== value.maxDurationMs
  ) {
    return undefined;
  }
  return {
    projectId: value.projectId,
    fingerprint: value.fingerprint,
    mode: value.mode,
    policy: {
      write: policy.write,
      commands: policy.commands,
      network: policy.network,
      maxDurationMs: policy.maxDurationMs,
    },
    maxDurationMs: value.maxDurationMs,
  };
}

function matchesProjectContext(context: TaskExecutionContext, project: ProjectDefinition): boolean {
  return (
    context.projectId === project.id &&
    context.projectName === project.name &&
    context.workspace === project.workspace &&
    context.workerId === project.workerId &&
    (context.model ?? undefined) === project.model &&
    (!context.policy.write || project.policy.write) &&
    (!context.policy.commands || project.policy.commands) &&
    (!context.policy.network || project.policy.network) &&
    context.policy.maxDurationMs <= project.policy.maxDurationMs
  );
}
