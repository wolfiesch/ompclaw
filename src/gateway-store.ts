import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ConversationAddress, InboundMessage, Principal, TransportIdentity } from "./gateway-types";
import { isRecord } from "./type-guards";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface ConversationBinding {
  readonly address: ConversationAddress;
  readonly ompSessionPath: string;
  readonly workspace: JsonValue;
}

export interface PendingInteraction {
  readonly id: string;
  readonly address: ConversationAddress;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly createdAt: number;
  readonly expiresAt?: number;
}

export interface PendingInboundMessage {
  readonly message: InboundMessage;
  readonly receivedAt: number;
  readonly scheduled: boolean;
}

export type TurnLifecycleState = "queued" | "running" | "completed" | "stopped" | "failed" | "interrupted";

export interface TurnLifecycle {
  readonly id: string;
  readonly principalId: string;
  readonly address: ConversationAddress;
  readonly prompt: string;
  readonly state: TurnLifecycleState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly currentTool?: string;
  readonly finishedAt?: number;
  readonly error?: string;
}

export interface GatewayTurnLifecycleStore {
  putTurnLifecycle(turn: TurnLifecycle): void;
  interruptActiveTurns(interruptedAt: number): number;
  listTurnLifecycles(address: ConversationAddress, limit?: number): TurnLifecycle[];
}

export type ScheduledJobSchedule =
  | { readonly kind: "at"; readonly at: number }
  | { readonly kind: "cron"; readonly expression: string; readonly timezone?: string | undefined };

export interface ScheduledJob {
  readonly id: string;
  readonly principalId: string;
  readonly identity: TransportIdentity;
  readonly address: ConversationAddress;
  readonly name: string;
  readonly prompt: string;
  readonly schedule: ScheduledJobSchedule;
  readonly enabled: boolean;
  readonly nextRunAt?: number | undefined;
  readonly retryAt?: number | undefined;
  readonly attemptCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastRunAt?: number | undefined;
  readonly lastSuccessAt?: number | undefined;
  readonly lastError?: string | undefined;
}

export interface LegacyTelegramStateImportOptions {
  readonly accessPath: string;
  readonly rpcStatePath: string;
  readonly workspace: JsonValue;
}

export interface LegacyTelegramStateImportResult {
  readonly imported: boolean;
  readonly principal?: Principal;
  readonly binding?: ConversationBinding;
  readonly checkpointImported: boolean;
}

export const LEGACY_TELEGRAM_STATE_MIGRATION = "legacy-telegram-state-v1";
export const TELEGRAM_TOPIC_SESSION_MIGRATION = "telegram-topic-session-isolation-v1";

type SqlRow = Record<string, unknown>;


function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;

  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.values(value).every(isJsonValue);
}

function encodeJson(value: JsonValue, context: string): string {
  if (!isJsonValue(value)) throw new Error(`${context} must be a JSON value`);
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string") throw new Error(`${context} must be a JSON value`);
  return encoded;
}

function decodeJson(raw: unknown, context: string): JsonValue {
  if (typeof raw !== "string") throw new Error(`corrupt JSON stored for ${context}`);

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error(`corrupt JSON stored for ${context}`);
  }

  if (!isJsonValue(decoded)) throw new Error(`corrupt JSON stored for ${context}`);
  return decoded;
}

function storedString(row: SqlRow, column: string, context: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`corrupt stored ${context}: ${column} is not text`);
  return value;
}

function storedTimestamp(row: SqlRow, column: string, context: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`corrupt stored ${context}: ${column} is not an integer timestamp`);
  }
  return value;
}

function requiredText(value: unknown, context: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${context} must not be empty`);
}

function validateIdentity(identity: TransportIdentity): void {
  requiredText(identity.transport, "transport identity transport");
  requiredText(identity.account, "transport identity account");
  requiredText(identity.subject, "transport identity subject");
}

function validateAddress(address: ConversationAddress): void {
  requiredText(address.transport, "conversation address transport");
  requiredText(address.account, "conversation address account");
  requiredText(address.channel, "conversation address channel");
  if (address.thread !== undefined) requiredText(address.thread, "conversation address thread");
}

function validateReceipt(value: unknown, context: string): void {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  requiredText(value.transport, `${context} transport`);
  requiredText(value.messageId, `${context} messageId`);
}

function validateInboundMessage(value: unknown): asserts value is InboundMessage {
  if (!isRecord(value)) throw new Error("inbound message must be an object");
  requiredText(value.id, "inbound message id");
  if (typeof value.sentAt !== "number" || !Number.isSafeInteger(value.sentAt) || value.sentAt < 0) {
    throw new Error("inbound message sentAt must be a safe nonnegative integer");
  }

  const identity = value.identity;
  if (!isRecord(identity)) throw new Error("inbound message identity must be an object");
  requiredText(identity.transport, "inbound message identity transport");
  requiredText(identity.account, "inbound message identity account");
  requiredText(identity.subject, "inbound message identity subject");

  const address = value.address;
  if (!isRecord(address)) throw new Error("inbound message address must be an object");
  requiredText(address.transport, "inbound message address transport");
  requiredText(address.account, "inbound message address account");
  requiredText(address.channel, "inbound message address channel");
  if (address.thread !== undefined) requiredText(address.thread, "inbound message address thread");
  if (identity.transport !== address.transport || identity.account !== address.account) {
    throw new Error("inbound message identity and address must share transport and account");
  }

  const content = value.content;
  if (!isRecord(content)) throw new Error("inbound message content must be an object");
  if (content.text !== undefined && typeof content.text !== "string") {
    throw new Error("inbound message content text must be a string");
  }
  if (content.attachments !== undefined) {
    if (!Array.isArray(content.attachments)) throw new Error("inbound message attachments must be an array");
    for (const attachment of content.attachments) {
      if (!isRecord(attachment)) throw new Error("inbound message attachment must be an object");
      requiredText(attachment.url, "inbound message attachment url");
      if (attachment.name !== undefined && typeof attachment.name !== "string") {
        throw new Error("inbound message attachment name must be a string");
      }
      if (attachment.mediaType !== undefined && typeof attachment.mediaType !== "string") {
        throw new Error("inbound message attachment mediaType must be a string");
      }
    }
  }

  const principal = value.principal;
  if (!isRecord(principal)) throw new Error("inbound message principal must be an object");
  requiredText(principal.id, "inbound message principal id");
  if (!Array.isArray(principal.roles) || !principal.roles.every((role) => typeof role === "string")) {
    throw new Error("inbound message principal roles must be an array of strings");
  }
  if (value.replyTo !== undefined) validateReceipt(value.replyTo, "inbound message replyTo");
  if (value.sourceReceipt !== undefined) validateReceipt(value.sourceReceipt, "inbound message sourceReceipt");
  if (value.edited !== undefined && typeof value.edited !== "boolean") {
    throw new Error("inbound message edited must be boolean");
  }
}

function databasePath(path: string): string {
  requiredText(path, "database path");
  return resolve(path);
}

function createPrivateDatabasePath(path: string): void {
  const parent = dirname(path);
  const parentExisted = existsSync(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });

  // POSIX mode bits are not meaningful on Windows. Do not mutate an existing
  // parent directory, which may legitimately be shared with another app.
  if (!parentExisted && process.platform !== "win32") chmodSync(parent, 0o700);
}

function restrictNewDatabase(path: string): void {
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function decodePrincipal(row: SqlRow): Principal {
  const roles = decodeJson(row.roles_json, "principal roles");
  if (!Array.isArray(roles) || !roles.every((role) => typeof role === "string")) {
    throw new Error("corrupt JSON stored for principal roles");
  }
  return { id: storedString(row, "id", "principal"), roles };
}

function decodeConversationBinding(row: SqlRow): ConversationBinding {
  const thread = storedString(row, "thread", "conversation binding");
  return {
    address: {
      transport: storedString(row, "transport", "conversation binding"),
      account: storedString(row, "account", "conversation binding"),
      channel: storedString(row, "channel", "conversation binding"),
      ...(thread === "" ? {} : { thread }),
    },
    ompSessionPath: storedString(row, "omp_session_path", "conversation binding"),
    workspace: decodeJson(row.workspace_json, "conversation binding workspace"),
  };
}

function decodePendingInteraction(row: SqlRow): PendingInteraction {
  const expiresAt = row.expires_at;
  if (expiresAt !== null && (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt))) {
    throw new Error("corrupt stored pending interaction: expires_at is not an integer timestamp");
  }

  const thread = storedString(row, "thread", "pending interaction");
  return {
    id: storedString(row, "id", "pending interaction"),
    address: {
      transport: storedString(row, "transport", "pending interaction"),
      account: storedString(row, "account", "pending interaction"),
      channel: storedString(row, "channel", "pending interaction"),
      ...(thread === "" ? {} : { thread }),
    },
    kind: storedString(row, "kind", "pending interaction"),
    payload: decodeJson(row.payload_json, "pending interaction payload"),
    createdAt: storedTimestamp(row, "created_at", "pending interaction"),
    ...(expiresAt === null ? {} : { expiresAt }),
  };
}

function optionalStoredTimestamp(row: SqlRow, column: string, context: string): number | undefined {
  const value = row[column];
  if (value === null) return undefined;
  return storedTimestamp(row, column, context);
}

function storedCount(row: SqlRow, column: string, context: string): number {
  const value = storedTimestamp(row, column, context);
  if (value < 0) throw new Error(`corrupt stored ${context}: ${column} is negative`);
  return value;
}

function decodeScheduledJob(row: SqlRow): ScheduledJob {
  const context = "scheduled job";
  const thread = storedString(row, "thread", context);
  const schedule = decodeJson(row.schedule_json, `${context} schedule`);
  if (!isRecord(schedule) || (schedule.kind !== "at" && schedule.kind !== "cron")) {
    throw new Error("corrupt JSON stored for scheduled job schedule");
  }
  if (schedule.kind === "at") {
    if (typeof schedule.at !== "number" || !Number.isSafeInteger(schedule.at)) {
      throw new Error("corrupt JSON stored for scheduled job schedule");
    }
  } else if (
    typeof schedule.expression !== "string" ||
    schedule.expression.length === 0 ||
    (schedule.timezone !== undefined && typeof schedule.timezone !== "string")
  ) {
    throw new Error("corrupt JSON stored for scheduled job schedule");
  }

  const enabled = row.enabled;
  if (enabled !== 0 && enabled !== 1) throw new Error("corrupt stored scheduled job: enabled is not boolean");
  const lastError = row.last_error;
  if (lastError !== null && typeof lastError !== "string") {
    throw new Error("corrupt stored scheduled job: last_error is not text");
  }

  return {
    id: storedString(row, "id", context),
    principalId: storedString(row, "principal_id", context),
    identity: {
      transport: storedString(row, "transport", context),
      account: storedString(row, "account", context),
      subject: storedString(row, "subject", context),
    },
    address: {
      transport: storedString(row, "transport", context),
      account: storedString(row, "account", context),
      channel: storedString(row, "channel", context),
      ...(thread === "" ? {} : { thread }),
    },
    name: storedString(row, "name", context),
    prompt: storedString(row, "prompt", context),
    schedule: schedule as unknown as ScheduledJobSchedule,
    enabled: enabled === 1,
    ...(optionalStoredTimestamp(row, "next_run_at", context) === undefined
      ? {}
      : { nextRunAt: optionalStoredTimestamp(row, "next_run_at", context) }),
    ...(optionalStoredTimestamp(row, "retry_at", context) === undefined
      ? {}
      : { retryAt: optionalStoredTimestamp(row, "retry_at", context) }),
    attemptCount: storedCount(row, "attempt_count", context),
    successCount: storedCount(row, "success_count", context),
    failureCount: storedCount(row, "failure_count", context),
    createdAt: storedTimestamp(row, "created_at", context),
    updatedAt: storedTimestamp(row, "updated_at", context),
    ...(optionalStoredTimestamp(row, "last_run_at", context) === undefined
      ? {}
      : { lastRunAt: optionalStoredTimestamp(row, "last_run_at", context) }),
    ...(optionalStoredTimestamp(row, "last_success_at", context) === undefined
      ? {}
      : { lastSuccessAt: optionalStoredTimestamp(row, "last_success_at", context) }),
    ...(lastError === null ? {} : { lastError }),
  };
}

function decodeTurnLifecycle(row: SqlRow): TurnLifecycle {
  const context = "turn lifecycle";
  const state = storedString(row, "state", context);
  if (!["queued", "running", "completed", "stopped", "failed", "interrupted"].includes(state)) {
    throw new Error("corrupt stored turn lifecycle: invalid state");
  }
  const thread = storedString(row, "thread", context);
  const currentTool = row.current_tool;
  const error = row.error;
  if (currentTool !== null && typeof currentTool !== "string") {
    throw new Error("corrupt stored turn lifecycle: current_tool is not text");
  }
  if (error !== null && typeof error !== "string") {
    throw new Error("corrupt stored turn lifecycle: error is not text");
  }
  const finishedAt = optionalStoredTimestamp(row, "finished_at", context);
  return {
    id: storedString(row, "id", context),
    principalId: storedString(row, "principal_id", context),
    address: {
      transport: storedString(row, "transport", context),
      account: storedString(row, "account", context),
      channel: storedString(row, "channel", context),
      ...(thread === "" ? {} : { thread }),
    },
    prompt: storedString(row, "prompt", context),
    state: state as TurnLifecycleState,
    createdAt: storedTimestamp(row, "created_at", context),
    updatedAt: storedTimestamp(row, "updated_at", context),
    ...(currentTool === null ? {} : { currentTool }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(error === null ? {} : { error }),
  };
}

function validateTurnLifecycle(turn: TurnLifecycle): void {
  requiredText(turn.id, "turn lifecycle id");
  requiredText(turn.principalId, "turn lifecycle principal");
  validateAddress(turn.address);
  requiredText(turn.prompt, "turn lifecycle prompt");
  if (!["queued", "running", "completed", "stopped", "failed", "interrupted"].includes(turn.state)) {
    throw new Error("turn lifecycle state is invalid");
  }
  for (const [label, value] of [
    ["created", turn.createdAt],
    ["updated", turn.updatedAt],
    ["finished", turn.finishedAt],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`turn lifecycle ${label} timestamp must be a safe nonnegative integer`);
    }
  }
  if (turn.currentTool !== undefined) requiredText(turn.currentTool, "turn lifecycle current tool");
  if (turn.error !== undefined) requiredText(turn.error, "turn lifecycle error");
}

const TURN_LIFECYCLE_FIELDS = [
  "id",
  "principal_id",
  "transport",
  "account",
  "channel",
  "thread",
  "prompt",
  "state",
  "current_tool",
  "created_at",
  "updated_at",
  "finished_at",
  "error",
].join(", ");

const SCHEDULED_JOB_FIELDS = [
  "id",
  "principal_id",
  "transport",
  "account",
  "subject",
  "channel",
  "thread",
  "name",
  "prompt",
  "schedule_json",
  "enabled",
  "next_run_at",
  "retry_at",
  "attempt_count",
  "success_count",
  "failure_count",
  "created_at",
  "updated_at",
  "last_run_at",
  "last_success_at",
  "last_error",
].join(", ");

function validateScheduledJob(job: ScheduledJob): void {
  requiredText(job.id, "scheduled job id");
  requiredText(job.principalId, "scheduled job principal");
  validateIdentity(job.identity);
  validateAddress(job.address);
  if (job.identity.transport !== job.address.transport || job.identity.account !== job.address.account) {
    throw new Error("scheduled job identity and address must use the same transport account");
  }
  requiredText(job.name, "scheduled job name");
  requiredText(job.prompt, "scheduled job prompt");
  if (job.schedule.kind === "at") {
    if (!Number.isSafeInteger(job.schedule.at)) throw new Error("scheduled job time must be an integer timestamp");
  } else {
    requiredText(job.schedule.expression, "scheduled job cron expression");
    if (job.schedule.timezone !== undefined) requiredText(job.schedule.timezone, "scheduled job timezone");
  }

  for (const [label, value] of [
    ["next run", job.nextRunAt],
    ["retry", job.retryAt],
    ["created", job.createdAt],
    ["updated", job.updatedAt],
    ["last run", job.lastRunAt],
    ["last success", job.lastSuccessAt],
  ] as const) {
    if (value !== undefined && !Number.isSafeInteger(value)) {
      throw new Error(`scheduled job ${label} must be an integer timestamp`);
    }
  }
  for (const [label, value] of [
    ["attempt count", job.attemptCount],
    ["success count", job.successCount],
    ["failure count", job.failureCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`scheduled job ${label} must be a non-negative integer`);
  }
  if (job.lastError !== undefined) requiredText(job.lastError, "scheduled job last error");
}

function parseLegacyState(path: string, label: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`could not read legacy ${label}: ${String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`legacy ${label} contains invalid JSON`);
  }

  if (!isRecord(parsed)) throw new Error(`legacy ${label} must contain a JSON object`);
  return parsed;
}

function legacyTelegramOperator(access: Record<string, unknown>): string {
  const allowed = access.allowFrom;
  if (!Array.isArray(allowed)) throw new Error("legacy access state does not contain an allowFrom array");

  const numericOperators = [...new Set(allowed.filter((value): value is string => typeof value === "string" && /^\d+$/.test(value)))];
  if (numericOperators.length !== 1) {
    throw new Error("legacy access state must contain exactly one numeric Telegram operator");
  }
  return numericOperators[0]!;
}

function legacySessionPath(rpcState: Record<string, unknown>): string {
  const path = typeof rpcState.sessionPath === "string" ? rpcState.sessionPath : rpcState.sessionFile;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("legacy rpc state does not contain a session path");
  }
  return path;
}

function legacyUpdateId(rpcState: Record<string, unknown>): number | undefined {
  if (!("lastUpdateId" in rpcState)) return undefined;
  const value = rpcState.lastUpdateId;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("legacy rpc state has an invalid lastUpdateId");
  }
  return value;
}

/**
 * Durable, transport-neutral gateway state. Principal resolution deliberately
 * accepts only a transport identity; callers cannot supply their own Principal.
 */
export class GatewayStore {
  readonly #database: Database;

  constructor(path: string) {
    const resolvedPath = databasePath(path);
    const databaseExisted = existsSync(resolvedPath);
    createPrivateDatabasePath(resolvedPath);
    this.#database = new Database(resolvedPath, { create: true });
    if (!databaseExisted) restrictNewDatabase(resolvedPath);

    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;

      CREATE TABLE IF NOT EXISTS principals (
        id TEXT PRIMARY KEY NOT NULL,
        roles_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transport_identities (
        transport TEXT NOT NULL,
        account TEXT NOT NULL,
        subject TEXT NOT NULL,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
        PRIMARY KEY (transport, account, subject)
      );

      CREATE TABLE IF NOT EXISTS conversation_bindings (
        transport TEXT NOT NULL,
        account TEXT NOT NULL,
        channel TEXT NOT NULL,
        thread TEXT NOT NULL,
        omp_session_path TEXT NOT NULL,
        workspace_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (transport, account, channel, thread)
      );

      CREATE TABLE IF NOT EXISTS adapter_checkpoints (
        adapter TEXT NOT NULL,
        checkpoint_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (adapter, checkpoint_key)
      );

      CREATE TABLE IF NOT EXISTS pending_ui_interactions (
        id TEXT PRIMARY KEY NOT NULL,
        transport TEXT NOT NULL,
        account TEXT NOT NULL,
        channel TEXT NOT NULL,
        thread TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS inbound_messages (
        transport TEXT NOT NULL,
        account TEXT NOT NULL,
        message_id TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (transport, account, message_id)
      );

      CREATE INDEX IF NOT EXISTS inbound_messages_received_at
        ON inbound_messages (received_at);

      CREATE TABLE IF NOT EXISTS pending_inbound_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        transport TEXT NOT NULL,
        account TEXT NOT NULL,
        message_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        scheduled INTEGER NOT NULL DEFAULT 0 CHECK (scheduled IN (0, 1)),
        UNIQUE (transport, account, message_id),
        FOREIGN KEY (transport, account, message_id)
          REFERENCES inbound_messages (transport, account, message_id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
        transport TEXT NOT NULL,
        account TEXT NOT NULL,
        subject TEXT NOT NULL,
        channel TEXT NOT NULL,
        thread TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        next_run_at INTEGER,
        retry_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_run_at INTEGER,
        last_success_at INTEGER,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS scheduled_jobs_due
        ON scheduled_jobs (enabled, retry_at, next_run_at);

      CREATE TABLE IF NOT EXISTS turn_lifecycles (
        id TEXT PRIMARY KEY NOT NULL,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
        transport TEXT NOT NULL,
        account TEXT NOT NULL,
        channel TEXT NOT NULL,
        thread TEXT NOT NULL,
        prompt TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'stopped', 'failed', 'interrupted')),
        current_tool TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS turn_lifecycles_address_created
        ON turn_lifecycles (transport, account, channel, thread, created_at DESC);

      CREATE TABLE IF NOT EXISTS migration_markers (
        marker TEXT PRIMARY KEY NOT NULL,
        completed_at INTEGER NOT NULL
      );
    `);
    const pendingInboundColumns = this.#database
      .query("PRAGMA table_info(pending_inbound_messages)")
      .all() as SqlRow[];
    if (!pendingInboundColumns.some((row) => row.name === "scheduled")) {
      this.#database.exec(
        "ALTER TABLE pending_inbound_messages ADD COLUMN scheduled INTEGER NOT NULL DEFAULT 0 CHECK (scheduled IN (0, 1))",
      );
    }
  }

  close(): void {
    this.#database.close();
  }

  upsertPrincipal(principal: Principal): void {
    requiredText(principal.id, "principal id");
    if (!principal.roles.every((role) => typeof role === "string" && role.length > 0)) {
      throw new Error("principal roles must be non-empty strings");
    }

    this.#database
      .query(
        `INSERT INTO principals (id, roles_json)
         VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET roles_json = excluded.roles_json`,
      )
      .run(principal.id, encodeJson(principal.roles, "principal roles"));
  }

  bindIdentity(identity: TransportIdentity, principalId: string): void {
    validateIdentity(identity);
    requiredText(principalId, "principal id");

    const existing = this.#database
      .query(
        `SELECT principal_id
         FROM transport_identities
         WHERE transport = ? AND account = ? AND subject = ?`,
      )
      .get(identity.transport, identity.account, identity.subject) as SqlRow | null;

    if (existing !== null) {
      const existingPrincipalId = storedString(existing, "principal_id", "transport identity");
      if (existingPrincipalId !== principalId) {
        throw new Error("transport identity is already bound to a different principal");
      }
      return;
    }

    try {
      this.#database
        .query(
          `INSERT INTO transport_identities (transport, account, subject, principal_id)
           VALUES (?, ?, ?, ?)`,
        )
        .run(identity.transport, identity.account, identity.subject, principalId);
    } catch (error) {
      const bound = this.#database
        .query(
          `SELECT principal_id
           FROM transport_identities
           WHERE transport = ? AND account = ? AND subject = ?`,
        )
        .get(identity.transport, identity.account, identity.subject) as SqlRow | null;
      if (bound !== null && storedString(bound, "principal_id", "transport identity") !== principalId) {
        throw new Error("transport identity is already bound to a different principal");
      }
      throw error;
    }
  }

  resolvePrincipal(identity: TransportIdentity): Principal | undefined {
    validateIdentity(identity);
    const row = this.#database
      .query(
        `SELECT principals.id, principals.roles_json
         FROM transport_identities
         JOIN principals ON principals.id = transport_identities.principal_id
         WHERE transport_identities.transport = ?
           AND transport_identities.account = ?
           AND transport_identities.subject = ?`,
      )
      .get(identity.transport, identity.account, identity.subject) as SqlRow | null;

    return row === null ? undefined : decodePrincipal(row);
  }

  bindConversation(binding: ConversationBinding): void {
    validateAddress(binding.address);
    requiredText(binding.ompSessionPath, "OMP session path");
    const workspace = encodeJson(binding.workspace, "conversation workspace");
    const thread = binding.address.thread ?? "";

    this.#database
      .query(
        `INSERT INTO conversation_bindings
           (transport, account, channel, thread, omp_session_path, workspace_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(transport, account, channel, thread) DO UPDATE SET
           omp_session_path = excluded.omp_session_path,
           workspace_json = excluded.workspace_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        binding.address.transport,
        binding.address.account,
        binding.address.channel,
        thread,
        binding.ompSessionPath,
        workspace,
        Date.now(),
      );
  }

  getConversationBinding(address: ConversationAddress): ConversationBinding | undefined {
    validateAddress(address);
    const row = this.#database
      .query(
        `SELECT transport, account, channel, thread, omp_session_path, workspace_json
         FROM conversation_bindings
         WHERE transport = ? AND account = ? AND channel = ? AND thread = ?`,
      )
      .get(address.transport, address.account, address.channel, address.thread ?? "") as SqlRow | null;

    return row === null ? undefined : decodeConversationBinding(row);
  }


  getSharedConversationSessionPath(): string | undefined {
    const row = this.#database
      .query(
        `SELECT omp_session_path
         FROM conversation_bindings
         WHERE thread = ''
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get() as SqlRow | null;
    return row === null ? undefined : storedString(row, "omp_session_path", "conversation binding");
  }

  setCheckpoint(adapter: string, key: string, value: JsonValue): void {
    requiredText(adapter, "adapter");
    requiredText(key, "checkpoint key");

    this.#database
      .query(
        `INSERT INTO adapter_checkpoints (adapter, checkpoint_key, value_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(adapter, checkpoint_key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(adapter, key, encodeJson(value, "checkpoint value"), Date.now());
  }

  getCheckpoint(adapter: string, key: string): JsonValue | undefined {
    requiredText(adapter, "adapter");
    requiredText(key, "checkpoint key");
    const row = this.#database
      .query(
        `SELECT value_json
         FROM adapter_checkpoints
         WHERE adapter = ? AND checkpoint_key = ?`,
      )
      .get(adapter, key) as SqlRow | null;

    return row === null ? undefined : decodeJson(row.value_json, "adapter checkpoint");
  }

  migrateTelegramUpdateCheckpoint(account: string): boolean {
    requiredText(account, "Telegram account");
    if (account !== "default") return false;
    return this.#transaction(() => {
      const scopedKey = `update_id:${account}`;
      const scoped = this.getCheckpoint("telegram", scopedKey);
      const legacy = this.getCheckpoint("telegram", "update_id");
      if (scoped !== undefined) {
        if (typeof scoped !== "number" || !Number.isSafeInteger(scoped) || scoped < 0) {
          throw new Error(`Telegram checkpoint ${scopedKey} must be a non-negative integer`);
        }
        if (legacy !== undefined) {
          this.#database.query("DELETE FROM adapter_checkpoints WHERE adapter = 'telegram' AND checkpoint_key = 'update_id'").run();
        }
        return false;
      }
      if (legacy === undefined) return false;
      const migrated = typeof legacy === "number"
        ? legacy
        : typeof legacy === "string" && /^\d+$/.test(legacy)
          ? Number(legacy)
          : Number.NaN;
      if (!Number.isSafeInteger(migrated) || migrated < 0) {
        throw new Error("legacy Telegram update checkpoint must be a non-negative integer");
      }
      this.setCheckpoint("telegram", scopedKey, migrated);
      this.#database.query("DELETE FROM adapter_checkpoints WHERE adapter = 'telegram' AND checkpoint_key = 'update_id'").run();
      return true;
    });
  }

  claimInboundMessage(message: InboundMessage, receivedAt: number, scheduled = false): boolean {
    validateInboundMessage(message);
    if (!Number.isSafeInteger(receivedAt)) {
      throw new Error("inbound message receivedAt must be an integer timestamp");
    }
    const { transport, account } = message.address;

    return this.#transaction(() => {
      const result = this.#database
        .query(
          `INSERT INTO inbound_messages (transport, account, message_id, received_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(transport, account, message_id) DO NOTHING`,
        )
        .run(transport, account, message.id, receivedAt);
      if (result.changes === 0) return false;

      this.#database
        .query(
          `INSERT INTO pending_inbound_messages
             (transport, account, message_id, payload_json, received_at, scheduled)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          transport,
          account,
          message.id,
          encodeJson(message as unknown as JsonValue, "inbound message"),
          receivedAt,
          scheduled ? 1 : 0,
        );
      return true;
    });
  }

  completeInboundMessage(transport: string, account: string, messageId: string): boolean {
    requiredText(transport, "inbound message transport");
    requiredText(account, "inbound message account");
    requiredText(messageId, "inbound message id");
    return this.#database
      .query(
        `DELETE FROM pending_inbound_messages
         WHERE transport = ? AND account = ? AND message_id = ?`,
      )
      .run(transport, account, messageId).changes > 0;
  }

  listPendingInboundMessages(): PendingInboundMessage[] {
    const rows = this.#database
      .query(
        `SELECT payload_json, received_at, scheduled
         FROM pending_inbound_messages
         ORDER BY sequence ASC`,
      )
      .all() as SqlRow[];
    return rows.map((row) => {
      const message = decodeJson(row.payload_json, "pending inbound message");
      validateInboundMessage(message);
      if (row.scheduled !== 0 && row.scheduled !== 1) {
        throw new Error("corrupt stored pending inbound message: scheduled is not boolean");
      }
      return {
        message,
        receivedAt: storedTimestamp(row, "received_at", "pending inbound message"),
        scheduled: row.scheduled === 1,
      };
    });
  }

  releaseInboundMessage(transport: string, account: string, messageId: string): boolean {
    requiredText(transport, "inbound message transport");
    requiredText(account, "inbound message account");
    requiredText(messageId, "inbound message id");

    return this.#database
      .query(
        `DELETE FROM inbound_messages
         WHERE transport = ? AND account = ? AND message_id = ?`,
      )
      .run(transport, account, messageId).changes > 0;
  }

  pruneInboundMessages(before: number): number {
    if (!Number.isSafeInteger(before)) {
      throw new Error("inbound message prune before must be an integer timestamp");
    }

    return this.#transaction(() => {
      const pendingGuard = `
        NOT EXISTS (
          SELECT 1 FROM pending_inbound_messages AS pending
          WHERE pending.transport = inbound.transport
            AND pending.account = inbound.account
            AND pending.message_id = inbound.message_id
        )`;
      const row = this.#database
        .query(`
          SELECT COUNT(*) AS message_count
          FROM inbound_messages AS inbound
          WHERE inbound.received_at < ? AND ${pendingGuard}
        `)
        .get(before) as SqlRow;
      const count = storedCount(row, "message_count", "inbound message prune count");
      this.#database.query(`
        DELETE FROM inbound_messages AS inbound
        WHERE inbound.received_at < ? AND ${pendingGuard}
      `).run(before);
      return count;
    });
  }

  putTurnLifecycle(turn: TurnLifecycle): void {
    validateTurnLifecycle(turn);
    this.#database
      .query(
        `INSERT INTO turn_lifecycles (
           id, principal_id, transport, account, channel, thread, prompt, state,
           current_tool, created_at, updated_at, finished_at, error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           principal_id = excluded.principal_id,
           transport = excluded.transport,
           account = excluded.account,
           channel = excluded.channel,
           thread = excluded.thread,
           prompt = excluded.prompt,
           state = excluded.state,
           current_tool = excluded.current_tool,
           updated_at = excluded.updated_at,
           finished_at = excluded.finished_at,
           error = excluded.error`,
      )
      .run(
        turn.id,
        turn.principalId,
        turn.address.transport,
        turn.address.account,
        turn.address.channel,
        turn.address.thread ?? "",
        turn.prompt,
        turn.state,
        turn.currentTool ?? null,
        turn.createdAt,
        turn.updatedAt,
        turn.finishedAt ?? null,
        turn.error ?? null,
      );
  }

  interruptActiveTurns(interruptedAt: number): number {
    if (!Number.isSafeInteger(interruptedAt) || interruptedAt < 0) {
      throw new Error("turn lifecycle interrupted timestamp must be a safe nonnegative integer");
    }
    return this.#database
      .query(
        `UPDATE turn_lifecycles
         SET state = 'interrupted', current_tool = NULL, updated_at = ?, finished_at = ?
         WHERE state IN ('queued', 'running')`,
      )
      .run(interruptedAt, interruptedAt).changes;
  }

  listTurnLifecycles(address: ConversationAddress, limit = 10): TurnLifecycle[] {
    validateAddress(address);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("turn lifecycle limit must be an integer from 1 to 100");
    }
    const rows = this.#database
      .query(
        `SELECT ${TURN_LIFECYCLE_FIELDS}
         FROM turn_lifecycles
         WHERE transport = ? AND account = ? AND channel = ? AND thread = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(address.transport, address.account, address.channel, address.thread ?? "", limit) as SqlRow[];
    return rows.map(decodeTurnLifecycle);
  }

  putPendingInteraction(interaction: PendingInteraction): void {
    requiredText(interaction.id, "pending interaction id");
    validateAddress(interaction.address);
    requiredText(interaction.kind, "pending interaction kind");
    if (!Number.isSafeInteger(interaction.createdAt)) {
      throw new Error("pending interaction createdAt must be an integer timestamp");
    }
    if (interaction.expiresAt !== undefined && !Number.isSafeInteger(interaction.expiresAt)) {
      throw new Error("pending interaction expiresAt must be an integer timestamp");
    }

    this.#database
      .query(
        `INSERT INTO pending_ui_interactions
           (id, transport, account, channel, thread, kind, payload_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           transport = excluded.transport,
           account = excluded.account,
           channel = excluded.channel,
           thread = excluded.thread,
           kind = excluded.kind,
           payload_json = excluded.payload_json,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      )
      .run(
        interaction.id,
        interaction.address.transport,
        interaction.address.account,
        interaction.address.channel,
        interaction.address.thread ?? "",
        interaction.kind,
        encodeJson(interaction.payload, "pending interaction payload"),
        interaction.createdAt,
        interaction.expiresAt ?? null,
      );
  }

  getPendingInteraction(id: string): PendingInteraction | undefined {
    requiredText(id, "pending interaction id");
    const row = this.#database
      .query(
        `SELECT id, transport, account, channel, thread, kind, payload_json, created_at, expires_at
         FROM pending_ui_interactions
         WHERE id = ?`,
      )
      .get(id) as SqlRow | null;

    return row === null ? undefined : decodePendingInteraction(row);
  }

  listPendingInteractions(address?: ConversationAddress): PendingInteraction[] {
    const fields = "id, transport, account, channel, thread, kind, payload_json, created_at, expires_at";
    const order = "ORDER BY created_at ASC, id ASC";

    if (address === undefined) {
      const rows = this.#database.query(`SELECT ${fields} FROM pending_ui_interactions ${order}`).all() as SqlRow[];
      return rows.map(decodePendingInteraction);
    }

    validateAddress(address);
    const rows = this.#database
      .query(
        `SELECT ${fields}
         FROM pending_ui_interactions
         WHERE transport = ? AND account = ? AND channel = ? AND thread = ?
         ${order}`,
      )
      .all(address.transport, address.account, address.channel, address.thread ?? "") as SqlRow[];
    return rows.map(decodePendingInteraction);
  }

  deletePendingInteraction(id: string): boolean {
    requiredText(id, "pending interaction id");
    const result = this.#database.query("DELETE FROM pending_ui_interactions WHERE id = ?").run(id);
    return result.changes > 0;
  }

  deleteExpiredPendingInteractions(now: number): number {
    if (!Number.isSafeInteger(now)) {
      throw new Error("pending interaction expiry now must be an integer timestamp");
    }

    return this.#database
      .query("DELETE FROM pending_ui_interactions WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .run(now).changes;
  }

  createScheduledJob(job: ScheduledJob): void {
    validateScheduledJob(job);
    this.#database
      .query(
        `INSERT INTO scheduled_jobs (
          id, principal_id, transport, account, subject, channel, thread,
          name, prompt, schedule_json, enabled, next_run_at, retry_at,
          attempt_count, success_count, failure_count, created_at, updated_at,
          last_run_at, last_success_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.principalId,
        job.identity.transport,
        job.identity.account,
        job.identity.subject,
        job.address.channel,
        job.address.thread ?? "",
        job.name,
        job.prompt,
        encodeJson(job.schedule, "scheduled job schedule"),
        job.enabled ? 1 : 0,
        job.nextRunAt ?? null,
        job.retryAt ?? null,
        job.attemptCount,
        job.successCount,
        job.failureCount,
        job.createdAt,
        job.updatedAt,
        job.lastRunAt ?? null,
        job.lastSuccessAt ?? null,
        job.lastError ?? null,
      );
  }

  updateScheduledJob(job: ScheduledJob): boolean {
    validateScheduledJob(job);
    const result = this.#database
      .query(
        `UPDATE scheduled_jobs SET
          transport = ?, account = ?, subject = ?, channel = ?, thread = ?,
          name = ?, prompt = ?, schedule_json = ?, enabled = ?,
          next_run_at = ?, retry_at = ?, attempt_count = ?,
          success_count = ?, failure_count = ?, updated_at = ?,
          last_run_at = ?, last_success_at = ?, last_error = ?
         WHERE id = ? AND principal_id = ?`,
      )
      .run(
        job.identity.transport,
        job.identity.account,
        job.identity.subject,
        job.address.channel,
        job.address.thread ?? "",
        job.name,
        job.prompt,
        encodeJson(job.schedule, "scheduled job schedule"),
        job.enabled ? 1 : 0,
        job.nextRunAt ?? null,
        job.retryAt ?? null,
        job.attemptCount,
        job.successCount,
        job.failureCount,
        job.updatedAt,
        job.lastRunAt ?? null,
        job.lastSuccessAt ?? null,
        job.lastError ?? null,
        job.id,
        job.principalId,
      );
    return result.changes > 0;
  }

  getScheduledJob(id: string, principalId?: string): ScheduledJob | undefined {
    requiredText(id, "scheduled job id");
    if (principalId !== undefined) requiredText(principalId, "scheduled job principal");
    const row = principalId === undefined
      ? this.#database.query(`SELECT ${SCHEDULED_JOB_FIELDS} FROM scheduled_jobs WHERE id = ?`).get(id)
      : this.#database
        .query(`SELECT ${SCHEDULED_JOB_FIELDS} FROM scheduled_jobs WHERE id = ? AND principal_id = ?`)
        .get(id, principalId);
    return row === null ? undefined : decodeScheduledJob(row as SqlRow);
  }

  listScheduledJobs(principalId?: string): ScheduledJob[] {
    if (principalId !== undefined) requiredText(principalId, "scheduled job principal");
    const rows = principalId === undefined
      ? this.#database.query(`SELECT ${SCHEDULED_JOB_FIELDS} FROM scheduled_jobs ORDER BY created_at ASC, id ASC`).all()
      : this.#database
        .query(`SELECT ${SCHEDULED_JOB_FIELDS} FROM scheduled_jobs WHERE principal_id = ? ORDER BY created_at ASC, id ASC`)
        .all(principalId);
    return (rows as SqlRow[]).map(decodeScheduledJob);
  }

  listDueScheduledJobs(now: number, limit = 16): ScheduledJob[] {
    if (!Number.isSafeInteger(now)) throw new Error("scheduled job due time must be an integer timestamp");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) {
      throw new Error("scheduled job due limit must be an integer between 1 and 128");
    }
    const rows = this.#database
      .query(
        `SELECT ${SCHEDULED_JOB_FIELDS}
         FROM scheduled_jobs
         WHERE enabled = 1
           AND next_run_at IS NOT NULL
           AND COALESCE(retry_at, next_run_at) <= ?
         ORDER BY COALESCE(retry_at, next_run_at) ASC, created_at ASC
         LIMIT ?`,
      )
      .all(now, limit) as SqlRow[];
    return rows.map(decodeScheduledJob);
  }

  deleteScheduledJob(id: string, principalId: string): boolean {
    requiredText(id, "scheduled job id");
    requiredText(principalId, "scheduled job principal");
    return this.#database
      .query("DELETE FROM scheduled_jobs WHERE id = ? AND principal_id = ?")
      .run(id, principalId).changes > 0;
  }

  importLegacyTelegramState(options: LegacyTelegramStateImportOptions): LegacyTelegramStateImportResult {
    if (this.#hasMigration(LEGACY_TELEGRAM_STATE_MIGRATION)) {
      return { imported: false, checkpointImported: false };
    }

    requiredText(options.accessPath, "legacy access path");
    requiredText(options.rpcStatePath, "legacy rpc state path");
    if (!isJsonValue(options.workspace)) throw new Error("legacy workspace must be a JSON value");

    // These are the only two legacy files read. In particular, the old .env
    // token file is never opened or copied.
    const access = parseLegacyState(options.accessPath, "access state");
    const rpcState = parseLegacyState(options.rpcStatePath, "rpc state");
    const operator = legacyTelegramOperator(access);
    const ompSessionPath = legacySessionPath(rpcState);
    const lastUpdateId = legacyUpdateId(rpcState);
    const principal: Principal = { id: `telegram:default:${operator}`, roles: ["operator"] };
    const identity: TransportIdentity = { transport: "telegram", account: "default", subject: operator };
    const binding: ConversationBinding = {
      address: { transport: "telegram", account: "default", channel: operator },
      ompSessionPath,
      workspace: options.workspace,
    };

    return this.#transaction(() => {
      if (this.#hasMigration(LEGACY_TELEGRAM_STATE_MIGRATION)) {
        return { imported: false, checkpointImported: false };
      }

      this.upsertPrincipal(principal);
      this.bindIdentity(identity, principal.id);
      this.bindConversation(binding);
      if (lastUpdateId !== undefined) this.setCheckpoint("telegram", "update_id:default", lastUpdateId);
      this.#database
        .query("INSERT INTO migration_markers (marker, completed_at) VALUES (?, ?)")
        .run(LEGACY_TELEGRAM_STATE_MIGRATION, Date.now());

      return {
        imported: true,
        principal,
        binding,
        checkpointImported: lastUpdateId !== undefined,
      };
    });
  }

  migrateTelegramTopicSessions(account: string): number {
    requiredText(account, "Telegram account");
    const marker = `${TELEGRAM_TOPIC_SESSION_MIGRATION}:${account}`;
    return this.#transaction(() => {
      if (this.#hasMigration(marker)) return 0;

      const current = this.getCheckpoint("omp", "session_file");
      const currentWasTopic = typeof current === "string" && this.#database
        .query(
          `SELECT 1
           FROM conversation_bindings
           WHERE transport = 'telegram' AND account = ? AND thread <> '' AND omp_session_path = ?
           LIMIT 1`,
        )
        .get(account, current) !== null;
      const currentWasShared = typeof current === "string" && this.#database
        .query("SELECT 1 FROM conversation_bindings WHERE thread = '' AND omp_session_path = ? LIMIT 1")
        .get(current) !== null;
      const sharedRow = this.#database
        .query(
          `SELECT omp_session_path
           FROM conversation_bindings
           WHERE thread = ''
           ORDER BY updated_at ASC, rowid ASC
           LIMIT 1`,
        )
        .get() as SqlRow | null;
      const shared = sharedRow === null ? undefined : storedString(sharedRow, "omp_session_path", "conversation binding");
      const removed = this.#database
        .query("DELETE FROM conversation_bindings WHERE transport = 'telegram' AND account = ? AND thread <> ''")
        .run(account).changes;

      if (shared !== undefined) {
        this.#database
          .query("UPDATE conversation_bindings SET omp_session_path = ? WHERE thread = ''")
          .run(shared);
        this.setCheckpoint("omp", "shared_session_file", shared);
        if (currentWasTopic || currentWasShared) this.setCheckpoint("omp", "session_file", shared);
      } else if (currentWasTopic && this.#database
        .query("SELECT 1 FROM conversation_bindings WHERE omp_session_path = ? LIMIT 1")
        .get(current) === null) {
        for (const key of ["session_file", "shared_session_file"]) {
          if (this.getCheckpoint("omp", key) !== current) continue;
          this.#database
            .query("DELETE FROM adapter_checkpoints WHERE adapter = 'omp' AND checkpoint_key = ?")
            .run(key);
        }
      }

      this.#database
        .query("INSERT INTO migration_markers (marker, completed_at) VALUES (?, ?)")
        .run(marker, Date.now());
      return removed;
    });
  }

  #hasMigration(marker: string): boolean {
    return this.#database.query("SELECT 1 FROM migration_markers WHERE marker = ?").get(marker) !== null;
  }

  #transaction<Result>(work: () => Result): Result {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // If BEGIN failed or SQLite already rolled back, retain the original error.
      }
      throw error;
    }
  }
}
