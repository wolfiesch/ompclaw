import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ConversationAddress, InboundMessage, Principal, TransportIdentity } from "./gateway-types";
import {
  isSemanticViewIdentifier,
  normalizeStoredSemanticView,
  type GatewaySemanticViewStore,
  type StoredSemanticView,
} from "./gateway-views";
import { isRecord } from "./type-guards";

export type { GatewaySemanticViewStore } from "./gateway-views";

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

export interface AppendIngressFragmentInput {
  readonly compositionId: string;
  readonly groupKey: string;
  readonly message: InboundMessage;
  readonly receivedAt: number;
  readonly flushAt: number;
  readonly deadlineAt: number;
  readonly sortOrder: number;
}

export interface IngressCompositionRecord {
  readonly id: string;
  readonly groupKey: string;
  readonly address: ConversationAddress;
  readonly principalId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly flushAt: number;
  readonly deadlineAt: number;
  readonly fragments: readonly InboundMessage[];
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
export type TurnTimelineEventKind =
  | "queued"
  | "started"
  | "tool_started"
  | "tool_completed"
  | "completed"
  | "stopped"
  | "failed"
  | "interrupted";

export interface TurnTimelineEvent {
  readonly turnId: string;
  readonly at: number;
  readonly kind: TurnTimelineEventKind;
  readonly text: string;
}

export interface GatewayTurnTimelineStore {
  appendTurnTimelineEvent(event: TurnTimelineEvent): void;
  listTurnTimelineEvents(turnId: string, limit?: number): TurnTimelineEvent[];
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

export type PairingRequestState = "pending" | "approved" | "rejected" | "expired" | "exhausted";

/**
 * Private pairing-request material. Code hash and salt must never be returned
 * from pairing service methods or rendered to an operator.
 */
export interface StoredPairingRequest {
  readonly identity: TransportIdentity;
  readonly address: ConversationAddress;
  readonly codeHash: string;
  readonly codeSalt: string;
  readonly state: PairingRequestState;
  readonly failedAttempts: number;
  readonly maxAttempts: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly resolvedAt?: number;
  readonly principalId?: string;
}

export interface StorePairingRequestInput {
  readonly identity: TransportIdentity;
  readonly address: ConversationAddress;
  readonly codeHash: string;
  readonly codeSalt: string;
  readonly maxAttempts: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type PairingResolution =
  | { readonly status: "approved"; readonly request: StoredPairingRequest }
  | {
      readonly status: "unavailable" | "expired" | "exhausted" | "identity-conflict";
      readonly request?: StoredPairingRequest;
    };

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

function validatePairingRequestInput(input: StorePairingRequestInput): void {
  validateIdentity(input.identity);
  validateAddress(input.address);
  if (input.identity.transport !== input.address.transport || input.identity.account !== input.address.account) {
    throw new Error("pairing identity and address must share transport and account");
  }
  if (!/^[a-f0-9]{64}$/i.test(input.codeHash)) throw new Error("pairing code hash must be a SHA-256 hex digest");
  if (!/^[a-f0-9]{32,}$/i.test(input.codeSalt) || input.codeSalt.length % 2 !== 0) {
    throw new Error("pairing code salt must be hexadecimal");
  }
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 5) {
    throw new Error("pairing maximum attempts must be between one and five");
  }
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new Error("pairing created timestamp must be a safe nonnegative integer");
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.createdAt) {
    throw new Error("pairing expiry must follow creation");
  }
}

const VALID_REPLY_MEDIA_KINDS: Record<string, true> = {
  photo: true,
  document: true,
  voice: true,
  audio: true,
  video: true,
  animation: true,
  sticker: true,
};

const VALID_REPLY_TARGET_KINDS: Record<string, true> = {
  task_card: true,
  decision: true,
  turn_result: true,
  interaction: true,
  user: true,
  external: true,
};

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
  if (value.replyContext !== undefined) {
    if (!isRecord(value.replyContext)) throw new Error("inbound message replyContext must be an object");
    requiredText(value.replyContext.messageId, "inbound message replyContext messageId");
    if (value.replyContext.author !== undefined && typeof value.replyContext.author !== "string") {
      throw new Error("inbound message replyContext author must be a string");
    }
    if (value.replyContext.text !== undefined && typeof value.replyContext.text !== "string") {
      throw new Error("inbound message replyContext text must be a string");
    }
    if (value.replyContext.quote !== undefined && typeof value.replyContext.quote !== "string") {
      throw new Error("inbound message replyContext quote must be a string");
    }
    if (value.replyContext.isBot !== undefined && typeof value.replyContext.isBot !== "boolean") {
      throw new Error("inbound message replyContext isBot must be boolean");
    }
    if (value.replyContext.chatTitle !== undefined && typeof value.replyContext.chatTitle !== "string") {
      throw new Error("inbound message replyContext chatTitle must be a string");
    }
    if (
      value.replyContext.mediaKind !== undefined &&
      (typeof value.replyContext.mediaKind !== "string" || !VALID_REPLY_MEDIA_KINDS[value.replyContext.mediaKind])
    ) {
      throw new Error("inbound message replyContext mediaKind is invalid");
    }
    if (value.replyContext.mediaName !== undefined && typeof value.replyContext.mediaName !== "string") {
      throw new Error("inbound message replyContext mediaName must be a string");
    }
    if (value.replyContext.isExternal !== undefined && typeof value.replyContext.isExternal !== "boolean") {
      throw new Error("inbound message replyContext isExternal must be boolean");
    }
    if (
      value.replyContext.targetKind !== undefined &&
      (typeof value.replyContext.targetKind !== "string" || !VALID_REPLY_TARGET_KINDS[value.replyContext.targetKind])
    ) {
      throw new Error("inbound message replyContext targetKind is invalid");
    }
    if (value.replyContext.targetId !== undefined && typeof value.replyContext.targetId !== "string") {
      throw new Error("inbound message replyContext targetId must be a string");
    }
    if (value.replyContext.targetSummary !== undefined && typeof value.replyContext.targetSummary !== "string") {
      throw new Error("inbound message replyContext targetSummary must be a string");
    }
  }
  if (value.composition !== undefined) {
    if (!isRecord(value.composition)) throw new Error("inbound message composition must be an object");
    if (value.composition.kind !== "text" && value.composition.kind !== "media") {
      throw new Error("inbound message composition kind is invalid");
    }
    if (value.composition.groupId !== undefined) {
      requiredText(value.composition.groupId, "inbound message composition groupId");
    }
    if (
      typeof value.composition.order !== "number" ||
      !Number.isSafeInteger(value.composition.order) ||
      value.composition.order < 0
    ) {
      throw new Error("inbound message composition order must be a nonnegative integer");
    }
  }
  if (value.sourceReceipt !== undefined) validateReceipt(value.sourceReceipt, "inbound message sourceReceipt");
  if (value.edited !== undefined && typeof value.edited !== "boolean") {
    throw new Error("inbound message edited must be boolean");
  }
}

function validateIngressFragmentInput(input: AppendIngressFragmentInput): void {
  requiredText(input.compositionId, "ingress composition id");
  requiredText(input.groupKey, "ingress composition group key");
  validateInboundMessage(input.message);
  for (const [label, value] of [
    ["received", input.receivedAt],
    ["flush", input.flushAt],
    ["deadline", input.deadlineAt],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`ingress composition ${label} timestamp must be a safe nonnegative integer`);
    }
  }
  if (input.deadlineAt < input.receivedAt) {
    throw new Error("ingress composition deadline must not precede receipt");
  }
  if (input.flushAt < input.receivedAt || input.flushAt > input.deadlineAt) {
    throw new Error("ingress composition flush timestamp must be between receipt and deadline");
  }
  if (!Number.isSafeInteger(input.sortOrder) || input.sortOrder < 0) {
    throw new Error("ingress fragment sort order must be a nonnegative integer");
  }
}

function decodeIngressComposition(row: SqlRow, fragments: readonly InboundMessage[]): IngressCompositionRecord {
  const context = "ingress composition";
  const thread = storedString(row, "thread", context);
  const address: ConversationAddress = {
    transport: storedString(row, "transport", context),
    account: storedString(row, "account", context),
    channel: storedString(row, "channel", context),
    ...(thread === "" ? {} : { thread }),
  };
  validateAddress(address);

  const record: IngressCompositionRecord = {
    id: storedString(row, "id", context),
    groupKey: storedString(row, "group_key", context),
    address,
    principalId: storedString(row, "principal_id", context),
    createdAt: storedTimestamp(row, "created_at", context),
    updatedAt: storedTimestamp(row, "updated_at", context),
    flushAt: storedTimestamp(row, "flush_at", context),
    deadlineAt: storedTimestamp(row, "deadline_at", context),
    fragments,
  };
  requiredText(record.id, "stored ingress composition id");
  requiredText(record.groupKey, "stored ingress composition group key");
  requiredText(record.principalId, "stored ingress composition principal");
  if (record.createdAt < 0 || record.updatedAt < 0 || record.flushAt < 0 || record.deadlineAt < 0) {
    throw new Error("corrupt stored ingress composition: timestamps must be nonnegative");
  }
  if (record.updatedAt < record.createdAt) {
    throw new Error("corrupt stored ingress composition: updated timestamp precedes creation");
  }
  if (record.flushAt > record.deadlineAt) {
    throw new Error("corrupt stored ingress composition: flush timestamp exceeds deadline");
  }
  if (record.fragments.length === 0) throw new Error("corrupt stored ingress composition: no fragments");

  for (const fragment of record.fragments) {
    validateInboundMessage(fragment);
    const fragmentAddress = fragment.address;
    if (
      fragment.principal.id !== record.principalId ||
      fragmentAddress.transport !== record.address.transport ||
      fragmentAddress.account !== record.address.account ||
      fragmentAddress.channel !== record.address.channel ||
      fragmentAddress.thread !== record.address.thread
    ) {
      throw new Error("corrupt stored ingress composition: fragment does not belong to composition");
    }
  }
  return record;
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

function decodeStoredPairingRequest(row: SqlRow): StoredPairingRequest {
  const context = "pairing request";
  const state = storedString(row, "state", context);
  if (
    state !== "pending" &&
    state !== "approved" &&
    state !== "rejected" &&
    state !== "expired" &&
    state !== "exhausted"
  ) {
    throw new Error("corrupt stored pairing request: state is invalid");
  }

  const thread = storedString(row, "thread", context);
  const identity: TransportIdentity = {
    transport: storedString(row, "transport", context),
    account: storedString(row, "account", context),
    subject: storedString(row, "subject", context),
  };
  const address: ConversationAddress = {
    transport: identity.transport,
    account: identity.account,
    channel: storedString(row, "channel", context),
    ...(thread === "" ? {} : { thread }),
  };
  const request: StoredPairingRequest = {
    identity,
    address,
    codeHash: storedString(row, "code_hash", context),
    codeSalt: storedString(row, "code_salt", context),
    state,
    failedAttempts: storedCount(row, "failed_attempts", context),
    maxAttempts: storedCount(row, "max_attempts", context),
    createdAt: storedTimestamp(row, "created_at", context),
    expiresAt: storedTimestamp(row, "expires_at", context),
    ...(row.resolved_at === null ? {} : { resolvedAt: storedTimestamp(row, "resolved_at", context) }),
    ...(row.principal_id === null ? {} : { principalId: storedString(row, "principal_id", context) }),
  };
  validatePairingRequestInput({
    identity: request.identity,
    address: request.address,
    codeHash: request.codeHash,
    codeSalt: request.codeSalt,
    maxAttempts: request.maxAttempts,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  });
  if (request.failedAttempts > request.maxAttempts) {
    throw new Error("corrupt stored pairing request: failed attempts exceed maximum");
  }
  if (request.state === "pending" && (request.resolvedAt !== undefined || request.principalId !== undefined)) {
    throw new Error("corrupt stored pairing request: pending request is resolved");
  }
  if (request.state === "approved" && (request.resolvedAt === undefined || request.principalId === undefined)) {
    throw new Error("corrupt stored pairing request: approved request lacks principal");
  }
  return request;
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

function decodeTurnTimelineEvent(row: SqlRow): TurnTimelineEvent {
  const context = "turn timeline event";
  const kind = storedString(row, "kind", context);
  if (!["queued", "started", "tool_started", "tool_completed", "completed", "stopped", "failed", "interrupted"].includes(kind)) {
    throw new Error("corrupt turn timeline event: invalid kind");
  }
  return {
    turnId: storedString(row, "turn_id", context),
    at: storedTimestamp(row, "occurred_at", context),
    kind: kind as TurnTimelineEventKind,
    text: storedString(row, "text", context),
  };
}

function encodeSemanticViewJson(value: unknown, context: string): string {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string") throw new Error(`${context} must be JSON-serializable`);
  return encoded;
}

function decodeStoredSemanticView(row: SqlRow): StoredSemanticView {
  const context = "semantic view";
  const thread = storedString(row, "thread", context);
  const viewId = storedString(row, "view_id", context);
  const view = decodeJson(row.view_json, `${context} definition`);
  const receipts = decodeJson(row.receipts_json, `${context} receipts`);

  let record: StoredSemanticView;
  try {
    record = normalizeStoredSemanticView({
      principalId: storedString(row, "principal_id", context),
      address: {
        transport: storedString(row, "transport", context),
        account: storedString(row, "account", context),
        channel: storedString(row, "channel", context),
        ...(thread === "" ? {} : { thread }),
      },
      view,
      contentHash: storedString(row, "content_hash", context),
      receipts,
      createdAt: storedTimestamp(row, "created_at", context),
      updatedAt: storedTimestamp(row, "updated_at", context),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`corrupt stored semantic view: ${message}`);
  }

  if (record.view.id !== viewId) throw new Error("corrupt stored semantic view: view id does not match storage key");
  return record;
}

function sameStoredSemanticView(left: StoredSemanticView, right: StoredSemanticView): boolean {
  return (
    left.principalId === right.principalId &&
    left.address.transport === right.address.transport &&
    left.address.account === right.address.account &&
    left.address.channel === right.address.channel &&
    left.address.thread === right.address.thread &&
    left.contentHash === right.contentHash &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    JSON.stringify(left.view) === JSON.stringify(right.view) &&
    JSON.stringify(left.receipts) === JSON.stringify(right.receipts)
  );
}

const SEMANTIC_VIEW_FIELDS = [
  "transport",
  "account",
  "channel",
  "thread",
  "view_id",
  "principal_id",
  "view_json",
  "content_hash",
  "receipts_json",
  "created_at",
  "updated_at",
].join(", ");

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

function validateTurnTimelineEvent(event: TurnTimelineEvent): void {
  requiredText(event.turnId, "turn timeline event turn id");
  requiredText(event.text, "turn timeline event text");
  if (
    !["queued", "started", "tool_started", "tool_completed", "completed", "stopped", "failed", "interrupted"].includes(
      event.kind,
    )
  ) {
    throw new Error("turn timeline event kind is invalid");
  }
  if (!Number.isSafeInteger(event.at) || event.at < 0) {
    throw new Error("turn timeline event timestamp must be a safe nonnegative integer");
  }
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

const PAIRING_REQUEST_FIELDS = [
  "transport",
  "account",
  "subject",
  "channel",
  "thread",
  "code_hash",
  "code_salt",
  "state",
  "failed_attempts",
  "max_attempts",
  "created_at",
  "expires_at",
  "resolved_at",
  "principal_id",
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
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`scheduled job ${label} must be a non-negative integer`);
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

  const numericOperators = [
    ...new Set(allowed.filter((value): value is string => typeof value === "string" && /^\d+$/.test(value))),
  ];
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
export class GatewayStore implements GatewaySemanticViewStore {
  readonly #database: Database;

  constructor(path: string) {
    const resolvedPath = databasePath(path);
    const databaseExisted = existsSync(resolvedPath);
    createPrivateDatabasePath(resolvedPath);
    this.#database = new Database(resolvedPath, { create: true });
    if (!databaseExisted) restrictNewDatabase(resolvedPath);

    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
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

      CREATE TABLE IF NOT EXISTS pairing_requests (
        transport TEXT NOT NULL,
        account TEXT NOT NULL,
        subject TEXT NOT NULL,
        channel TEXT NOT NULL,
        thread TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        code_salt TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'expired', 'exhausted')),
        failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        resolved_at INTEGER,
        confirmation_delivered_at INTEGER,
        principal_id TEXT REFERENCES principals(id) ON DELETE RESTRICT,
        PRIMARY KEY (transport, account, subject),
        CHECK (expires_at > created_at)
      );

      CREATE INDEX IF NOT EXISTS pairing_requests_state_expiry
        ON pairing_requests (state, expires_at);

      CREATE INDEX IF NOT EXISTS pairing_requests_pending_account
        ON pairing_requests (transport, account, created_at, subject)
        WHERE state = 'pending';

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

      CREATE TABLE IF NOT EXISTS ingress_compositions (
        id TEXT PRIMARY KEY NOT NULL,
        group_key TEXT NOT NULL UNIQUE,
        principal_id TEXT NOT NULL,
        transport TEXT NOT NULL,
        account TEXT NOT NULL,
        channel TEXT NOT NULL,
        thread TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        flush_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ingress_compositions_flush_at
        ON ingress_compositions (flush_at, created_at, id);

      CREATE TABLE IF NOT EXISTS ingress_fragments (
        composition_id TEXT NOT NULL REFERENCES ingress_compositions(id) ON DELETE CASCADE,
        fragment_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (composition_id, fragment_id)
      );

      CREATE INDEX IF NOT EXISTS ingress_fragments_composition_order
        ON ingress_fragments (composition_id, sort_order, fragment_id);

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

      CREATE TABLE IF NOT EXISTS turn_timeline_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL REFERENCES turn_lifecycles(id) ON DELETE CASCADE,
        occurred_at INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('queued', 'started', 'tool_started', 'tool_completed', 'completed', 'stopped', 'failed', 'interrupted')),
        text TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS turn_timeline_events_turn_recent
        ON turn_timeline_events (turn_id, id DESC);

      CREATE TABLE IF NOT EXISTS semantic_views (
        transport TEXT NOT NULL,
        account TEXT NOT NULL,
        channel TEXT NOT NULL,
        thread TEXT NOT NULL,
        view_id TEXT NOT NULL,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
        view_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        receipts_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (transport, account, channel, thread, view_id)
      );

      CREATE INDEX IF NOT EXISTS semantic_views_address_updated
        ON semantic_views (transport, account, channel, thread, updated_at, view_id);

      CREATE TABLE IF NOT EXISTS migration_markers (
        marker TEXT PRIMARY KEY NOT NULL,
        completed_at INTEGER NOT NULL
      );
    `);
    const pendingInboundColumns = this.#database.query("PRAGMA table_info(pending_inbound_messages)").all() as SqlRow[];
    if (!pendingInboundColumns.some((row) => row.name === "scheduled")) {
      this.#database.exec(
        "ALTER TABLE pending_inbound_messages ADD COLUMN scheduled INTEGER NOT NULL DEFAULT 0 CHECK (scheduled IN (0, 1))",
      );
    }
    const pairingColumns = this.#database.query("PRAGMA table_info(pairing_requests)").all() as SqlRow[];
    if (!pairingColumns.some((row) => row.name === "confirmation_delivered_at")) {
      this.#database.exec("ALTER TABLE pairing_requests ADD COLUMN confirmation_delivered_at INTEGER");
    }
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS pairing_requests_unconfirmed_approval
        ON pairing_requests (transport, account, created_at)
        WHERE state = 'approved' AND confirmation_delivered_at IS NULL
    `);
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

  upsertPairingRequest(input: StorePairingRequestInput): StoredPairingRequest {
    validatePairingRequestInput(input);
    const thread = input.address.thread ?? "";

    return this.#transaction(() => {
      this.#database
        .query(
          `INSERT INTO pairing_requests (
             transport, account, subject, channel, thread, code_hash, code_salt,
             state, failed_attempts, max_attempts, created_at, expires_at, resolved_at, principal_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, NULL, NULL)
           ON CONFLICT(transport, account, subject) DO UPDATE SET
             channel = excluded.channel,
             thread = excluded.thread,
             code_hash = excluded.code_hash,
             code_salt = excluded.code_salt,
             state = 'pending',
             failed_attempts = 0,
             max_attempts = excluded.max_attempts,
             created_at = excluded.created_at,
             expires_at = excluded.expires_at,
             resolved_at = NULL,
             confirmation_delivered_at = NULL,
             principal_id = NULL`,
        )
        .run(
          input.identity.transport,
          input.identity.account,
          input.identity.subject,
          input.address.channel,
          thread,
          input.codeHash,
          input.codeSalt,
          input.maxAttempts,
          input.createdAt,
          input.expiresAt,
        );
      const request = this.#readPairingRequest(input.identity);
      if (request === undefined) throw new Error("pairing request was not stored");
      return request;
    });
  }

  listPairingRequests(): StoredPairingRequest[] {
    const rows = this.#database
      .query(
        `SELECT ${PAIRING_REQUEST_FIELDS} FROM pairing_requests ORDER BY created_at ASC, transport ASC, account ASC, subject ASC`,
      )
      .all() as SqlRow[];
    return rows.map(decodeStoredPairingRequest);
  }

  listPendingPairingRequests(transport: string, account: string): StoredPairingRequest[] {
    requiredText(transport, "pending pairing transport");
    requiredText(account, "pending pairing account");
    const rows = this.#database
      .query(
        `SELECT ${PAIRING_REQUEST_FIELDS}
       FROM pairing_requests
       WHERE transport = ? AND account = ? AND state = 'pending'
       ORDER BY created_at ASC, subject ASC`,
      )
      .all(transport, account) as SqlRow[];
    return rows.map(decodeStoredPairingRequest);
  }

  listUnconfirmedPairingApprovals(transport: string, account: string): StoredPairingRequest[] {
    requiredText(transport, "pairing confirmation transport");
    requiredText(account, "pairing confirmation account");
    const rows = this.#database
      .query(
        `SELECT ${PAIRING_REQUEST_FIELDS}
       FROM pairing_requests
       WHERE transport = ? AND account = ? AND state = 'approved' AND confirmation_delivered_at IS NULL
       ORDER BY created_at ASC, subject ASC`,
      )
      .all(transport, account) as SqlRow[];
    return rows.map(decodeStoredPairingRequest);
  }

  completePairingConfirmation(identity: TransportIdentity, now: number): boolean {
    validateIdentity(identity);
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("pairing confirmation timestamp must be a safe nonnegative integer");
    }
    return (
      this.#database
        .query(
          `UPDATE pairing_requests
        SET confirmation_delivered_at = ?
        WHERE transport = ? AND account = ? AND subject = ?
          AND state = 'approved' AND confirmation_delivered_at IS NULL`,
        )
        .run(now, identity.transport, identity.account, identity.subject).changes === 1
    );
  }

  expirePairingRequests(now: number): number {
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("pairing expiry timestamp must be a safe nonnegative integer");
    return this.#expirePairingRequests(now);
  }

  recordPairingFailures(identities: readonly TransportIdentity[], now: number): number {
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("pairing failure timestamp must be a safe nonnegative integer");
    const uniqueIdentities: TransportIdentity[] = [];
    for (const identity of identities) {
      validateIdentity(identity);
      if (
        !uniqueIdentities.some(
          (candidate) =>
            candidate.transport === identity.transport &&
            candidate.account === identity.account &&
            candidate.subject === identity.subject,
        )
      ) {
        uniqueIdentities.push(identity);
      }
    }

    return this.#transaction(() => {
      this.#expirePairingRequests(now);
      let changed = 0;
      for (const identity of uniqueIdentities) {
        changed += this.#database
          .query(
            `UPDATE pairing_requests
             SET failed_attempts = failed_attempts + 1,
                 state = CASE WHEN failed_attempts + 1 >= max_attempts THEN 'exhausted' ELSE 'pending' END,
                 resolved_at = CASE WHEN failed_attempts + 1 >= max_attempts THEN ? ELSE NULL END
             WHERE transport = ? AND account = ? AND subject = ?
               AND state = 'pending' AND expires_at > ?`,
          )
          .run(now, identity.transport, identity.account, identity.subject, now).changes;
      }
      return changed;
    });
  }

  approvePairingRequest(identity: TransportIdentity, principalId: string, now: number): PairingResolution {
    validateIdentity(identity);
    requiredText(principalId, "pairing principal id");
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("pairing approval timestamp must be a safe nonnegative integer");

    return this.#transaction(() => {
      const request = this.#readPairingRequest(identity);
      if (request === undefined || request.state !== "pending")
        return { status: "unavailable", ...(request === undefined ? {} : { request }) };
      if (request.expiresAt <= now) {
        this.#database
          .query(
            `UPDATE pairing_requests
             SET state = 'expired', resolved_at = ?
             WHERE transport = ? AND account = ? AND subject = ? AND state = 'pending'`,
          )
          .run(now, identity.transport, identity.account, identity.subject);
        const expired = this.#readPairingRequest(identity);
        if (expired === undefined) throw new Error("pairing request disappeared while expiring");
        return { status: "expired", request: expired };
      }
      if (request.failedAttempts >= request.maxAttempts) {
        this.#database
          .query(
            `UPDATE pairing_requests
             SET state = 'exhausted', resolved_at = ?
             WHERE transport = ? AND account = ? AND subject = ? AND state = 'pending'`,
          )
          .run(now, identity.transport, identity.account, identity.subject);
        const exhausted = this.#readPairingRequest(identity);
        if (exhausted === undefined) throw new Error("pairing request disappeared while exhausting");
        return { status: "exhausted", request: exhausted };
      }

      const binding = this.#database
        .query(
          `SELECT principal_id FROM transport_identities
           WHERE transport = ? AND account = ? AND subject = ?`,
        )
        .get(identity.transport, identity.account, identity.subject) as SqlRow | null;
      if (binding !== null && storedString(binding, "principal_id", "transport identity") !== principalId) {
        return { status: "identity-conflict", request };
      }

      const principal = this.#database
        .query("SELECT id, roles_json FROM principals WHERE id = ?")
        .get(principalId) as SqlRow | null;
      const existingRoles = principal === null ? [] : decodePrincipal(principal).roles;
      const roles = existingRoles.includes("operator") ? existingRoles : [...existingRoles, "operator"];
      this.upsertPrincipal({ id: principalId, roles });
      this.bindIdentity(identity, principalId);
      this.#database
        .query(
          `UPDATE pairing_requests
           SET state = 'approved', resolved_at = ?, principal_id = ?
           WHERE transport = ? AND account = ? AND subject = ? AND state = 'pending'`,
        )
        .run(now, principalId, identity.transport, identity.account, identity.subject);
      const approved = this.#readPairingRequest(identity);
      if (approved === undefined || approved.state !== "approved") {
        throw new Error("pairing request was not approved");
      }
      return { status: "approved", request: approved };
    });
  }

  rejectPairingRequest(identity: TransportIdentity, now: number): PairingResolution {
    validateIdentity(identity);
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("pairing rejection timestamp must be a safe nonnegative integer");

    return this.#transaction(() => {
      const request = this.#readPairingRequest(identity);
      if (request === undefined || request.state !== "pending")
        return { status: "unavailable", ...(request === undefined ? {} : { request }) };
      if (request.expiresAt <= now) {
        this.#database
          .query(
            `UPDATE pairing_requests
             SET state = 'expired', resolved_at = ?
             WHERE transport = ? AND account = ? AND subject = ? AND state = 'pending'`,
          )
          .run(now, identity.transport, identity.account, identity.subject);
        const expired = this.#readPairingRequest(identity);
        if (expired === undefined) throw new Error("pairing request disappeared while expiring");
        return { status: "expired", request: expired };
      }

      this.#database
        .query(
          `UPDATE pairing_requests
           SET state = 'rejected', resolved_at = ?
           WHERE transport = ? AND account = ? AND subject = ? AND state = 'pending'`,
        )
        .run(now, identity.transport, identity.account, identity.subject);
      const rejected = this.#readPairingRequest(identity);
      if (rejected === undefined || rejected.state !== "rejected") {
        throw new Error("pairing request was not rejected");
      }
      return { status: "unavailable", request: rejected };
    });
  }

  clearPairingRequests(now: number): number {
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("pairing clear timestamp must be a safe nonnegative integer");
    return this.#transaction(() => {
      this.#expirePairingRequests(now);
      return this.#database.query("DELETE FROM pairing_requests").run().changes;
    });
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
          this.#database
            .query("DELETE FROM adapter_checkpoints WHERE adapter = 'telegram' AND checkpoint_key = 'update_id'")
            .run();
        }
        return false;
      }
      if (legacy === undefined) return false;
      const migrated =
        typeof legacy === "number"
          ? legacy
          : typeof legacy === "string" && /^\d+$/.test(legacy)
            ? Number(legacy)
            : Number.NaN;
      if (!Number.isSafeInteger(migrated) || migrated < 0) {
        throw new Error("legacy Telegram update checkpoint must be a non-negative integer");
      }
      this.setCheckpoint("telegram", scopedKey, migrated);
      this.#database
        .query("DELETE FROM adapter_checkpoints WHERE adapter = 'telegram' AND checkpoint_key = 'update_id'")
        .run();
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
    return (
      this.#database
        .query(
          `DELETE FROM pending_inbound_messages
         WHERE transport = ? AND account = ? AND message_id = ?`,
        )
        .run(transport, account, messageId).changes > 0
    );
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

  appendIngressFragment(input: AppendIngressFragmentInput): IngressCompositionRecord {
    validateIngressFragmentInput(input);
    const message = input.message;

    return this.#transaction(() => {
      const existingRow = this.#database
        .query("SELECT id FROM ingress_compositions WHERE group_key = ?")
        .get(input.groupKey) as SqlRow | null;
      let composition: IngressCompositionRecord | undefined;
      let compositionId = input.compositionId;
      let deadlineAt = input.deadlineAt;

      if (existingRow === null) {
        const { address } = message;
        this.#database
          .query(
            `INSERT INTO ingress_compositions (
               id, group_key, principal_id, transport, account, channel, thread,
               created_at, updated_at, flush_at, deadline_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            compositionId,
            input.groupKey,
            message.principal.id,
            address.transport,
            address.account,
            address.channel,
            address.thread ?? "",
            input.receivedAt,
            input.receivedAt,
            Math.min(input.flushAt, input.deadlineAt),
            deadlineAt,
          );
      } else {
        compositionId = storedString(existingRow, "id", "ingress composition");
        composition = this.#readIngressComposition(compositionId);
        deadlineAt = composition.deadlineAt;
        const compositionAddress = composition.address;
        if (
          composition.principalId !== message.principal.id ||
          compositionAddress.transport !== message.address.transport ||
          compositionAddress.account !== message.address.account ||
          compositionAddress.channel !== message.address.channel ||
          compositionAddress.thread !== message.address.thread
        ) {
          throw new Error("ingress fragment does not match its existing composition");
        }
      }

      const existingFragment = this.#database
        .query("SELECT 1 FROM ingress_fragments WHERE composition_id = ? AND fragment_id = ?")
        .get(compositionId, message.id);
      if (existingFragment !== null && message.edited !== true) {
        return composition ?? this.#readIngressComposition(compositionId);
      }

      const payload = encodeJson(message as unknown as JsonValue, "ingress fragment");
      if (existingFragment === null) {
        this.#database
          .query(
            `INSERT INTO ingress_fragments (composition_id, fragment_id, sort_order, payload_json)
             VALUES (?, ?, ?, ?)`,
          )
          .run(compositionId, message.id, input.sortOrder, payload);
      } else {
        this.#database
          .query(
            `UPDATE ingress_fragments
             SET sort_order = ?, payload_json = ?
             WHERE composition_id = ? AND fragment_id = ?`,
          )
          .run(input.sortOrder, payload, compositionId, message.id);
      }

      this.#database
        .query(
          `UPDATE ingress_compositions
           SET updated_at = MAX(updated_at, ?), flush_at = ?
           WHERE id = ?`,
        )
        .run(input.receivedAt, Math.min(input.flushAt, deadlineAt), compositionId);

      return this.#readIngressComposition(compositionId);
    });
  }
  getIngressComposition(id: string): IngressCompositionRecord | undefined {
    requiredText(id, "ingress composition id");
    const row = this.#database.query("SELECT id FROM ingress_compositions WHERE id = ?").get(id) as SqlRow | null;
    return row === null ? undefined : this.#readIngressComposition(id);
  }

  getIngressCompositionByGroupKey(groupKey: string): IngressCompositionRecord | undefined {
    requiredText(groupKey, "ingress composition group key");
    const row = this.#database
      .query("SELECT id FROM ingress_compositions WHERE group_key = ?")
      .get(groupKey) as SqlRow | null;
    return row === null ? undefined : this.#readIngressComposition(storedString(row, "id", "ingress composition"));
  }

  getIngressCompositionByFragment(
    fragmentId: string,
    principalId: string,
    address: ConversationAddress,
  ): IngressCompositionRecord | undefined {
    requiredText(fragmentId, "ingress fragment id");
    requiredText(principalId, "ingress composition principal id");
    validateAddress(address);
    const row = this.#database
      .query(
        `SELECT composition.id
         FROM ingress_compositions AS composition
         INNER JOIN ingress_fragments AS fragment ON fragment.composition_id = composition.id
         WHERE fragment.fragment_id = ?
           AND composition.principal_id = ?
           AND composition.transport = ?
           AND composition.account = ?
           AND composition.channel = ?
           AND composition.thread = ?
         LIMIT 1`,
      )
      .get(
        fragmentId,
        principalId,
        address.transport,
        address.account,
        address.channel,
        address.thread ?? "",
      ) as SqlRow | null;
    return row === null ? undefined : this.#readIngressComposition(storedString(row, "id", "ingress composition"));
  }

  listPendingIngressCompositions(): IngressCompositionRecord[] {
    const rows = this.#database
      .query(
        `SELECT id
         FROM ingress_compositions
         ORDER BY flush_at ASC, created_at ASC, id ASC`,
      )
      .all() as SqlRow[];
    return rows.map((row) => this.#readIngressComposition(storedString(row, "id", "ingress composition")));
  }

  deleteIngressComposition(id: string): boolean {
    requiredText(id, "ingress composition id");
    return this.#database.query("DELETE FROM ingress_compositions WHERE id = ?").run(id).changes > 0;
  }

  releaseInboundMessage(transport: string, account: string, messageId: string): boolean {
    requiredText(transport, "inbound message transport");
    requiredText(account, "inbound message account");
    requiredText(messageId, "inbound message id");

    return (
      this.#database
        .query(
          `DELETE FROM inbound_messages
         WHERE transport = ? AND account = ? AND message_id = ?`,
        )
        .run(transport, account, messageId).changes > 0
    );
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
      this.#database
        .query(`
        DELETE FROM inbound_messages AS inbound
        WHERE inbound.received_at < ? AND ${pendingGuard}
      `)
        .run(before);
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

  appendTurnTimelineEvent(event: TurnTimelineEvent): void {
    validateTurnTimelineEvent(event);
    this.#database
      .query(
        `INSERT INTO turn_timeline_events (turn_id, occurred_at, kind, text)
         VALUES (?, ?, ?, ?)`,
      )
      .run(event.turnId, event.at, event.kind, event.text.slice(0, 1_000));
  }

  listTurnTimelineEvents(turnId: string, limit = 8): TurnTimelineEvent[] {
    requiredText(turnId, "turn timeline event turn id");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("turn timeline event limit must be an integer from 1 to 100");
    }
    const rows = this.#database
      .query(
        `SELECT turn_id, occurred_at, kind, text
         FROM turn_timeline_events
         WHERE turn_id = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(turnId, limit) as SqlRow[];
    return rows.map(decodeTurnTimelineEvent).reverse();
  }

  getSemanticView(address: ConversationAddress, viewId: string): StoredSemanticView | undefined {
    validateAddress(address);
    if (!isSemanticViewIdentifier(viewId)) throw new Error("semantic view id must be a bounded opaque identifier");
    return this.#readSemanticView(address, viewId);
  }

  getSemanticViewByReceipt(address: ConversationAddress, messageId: string): StoredSemanticView | undefined {
    validateAddress(address);
    requiredText(messageId, "receipt messageId");
    const views = this.listSemanticViews(address);
    return views.find((entry) => entry.receipts.some((receipt) => receipt.messageId === messageId));
  }

  putSemanticView(record: StoredSemanticView): boolean {
    const candidate = normalizeStoredSemanticView(record);
    return this.#transaction(() => {
      const principal = this.#database.query("SELECT 1 FROM principals WHERE id = ?").get(candidate.principalId);
      if (principal === null) throw new Error("semantic view principal does not exist");

      const current = this.#readSemanticView(candidate.address, candidate.view.id);
      if (current === undefined) {
        this.#database
          .query(
            `INSERT INTO semantic_views (
              transport, account, channel, thread, view_id, principal_id,
              view_json, content_hash, receipts_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            candidate.address.transport,
            candidate.address.account,
            candidate.address.channel,
            candidate.address.thread ?? "",
            candidate.view.id,
            candidate.principalId,
            encodeSemanticViewJson(candidate.view, "semantic view definition"),
            candidate.contentHash,
            encodeSemanticViewJson(candidate.receipts, "semantic view receipts"),
            candidate.createdAt,
            candidate.updatedAt,
          );
        return true;
      }

      if (current.principalId !== candidate.principalId) {
        throw new Error("semantic view is already owned by a different principal");
      }
      if (current.createdAt !== candidate.createdAt) {
        throw new Error("semantic view creation timestamp cannot change");
      }
      if (candidate.view.version < current.view.version) return false;
      if (candidate.view.version === current.view.version && candidate.contentHash !== current.contentHash) {
        throw new Error("semantic view has conflicting content at the same version");
      }
      if (sameStoredSemanticView(current, candidate)) return false;

      this.#database
        .query(
          `UPDATE semantic_views
           SET view_json = ?, content_hash = ?, receipts_json = ?, updated_at = ?
           WHERE transport = ? AND account = ? AND channel = ? AND thread = ? AND view_id = ?`,
        )
        .run(
          encodeSemanticViewJson(candidate.view, "semantic view definition"),
          candidate.contentHash,
          encodeSemanticViewJson(candidate.receipts, "semantic view receipts"),
          candidate.updatedAt,
          candidate.address.transport,
          candidate.address.account,
          candidate.address.channel,
          candidate.address.thread ?? "",
          candidate.view.id,
        );
      return true;
    });
  }

  deleteSemanticView(address: ConversationAddress, viewId: string): boolean {
    validateAddress(address);
    if (!isSemanticViewIdentifier(viewId)) throw new Error("semantic view id must be a bounded opaque identifier");
    return (
      this.#database
        .query(
          `DELETE FROM semantic_views
           WHERE transport = ? AND account = ? AND channel = ? AND thread = ? AND view_id = ?`,
        )
        .run(address.transport, address.account, address.channel, address.thread ?? "", viewId).changes > 0
    );
  }

  listSemanticViews(address?: ConversationAddress): StoredSemanticView[] {
    if (address === undefined) {
      const rows = this.#database
        .query(`SELECT ${SEMANTIC_VIEW_FIELDS} FROM semantic_views ORDER BY created_at ASC, view_id ASC`)
        .all() as SqlRow[];
      return rows.map(decodeStoredSemanticView);
    }

    validateAddress(address);
    const rows = this.#database
      .query(
        `SELECT ${SEMANTIC_VIEW_FIELDS}
         FROM semantic_views
         WHERE transport = ? AND account = ? AND channel = ? AND thread = ?
         ORDER BY created_at ASC, view_id ASC`,
      )
      .all(address.transport, address.account, address.channel, address.thread ?? "") as SqlRow[];
    return rows.map(decodeStoredSemanticView);
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
    const row =
      principalId === undefined
        ? this.#database.query(`SELECT ${SCHEDULED_JOB_FIELDS} FROM scheduled_jobs WHERE id = ?`).get(id)
        : this.#database
            .query(`SELECT ${SCHEDULED_JOB_FIELDS} FROM scheduled_jobs WHERE id = ? AND principal_id = ?`)
            .get(id, principalId);
    return row === null ? undefined : decodeScheduledJob(row as SqlRow);
  }

  listScheduledJobs(principalId?: string): ScheduledJob[] {
    if (principalId !== undefined) requiredText(principalId, "scheduled job principal");
    const rows =
      principalId === undefined
        ? this.#database
            .query(`SELECT ${SCHEDULED_JOB_FIELDS} FROM scheduled_jobs ORDER BY created_at ASC, id ASC`)
            .all()
        : this.#database
            .query(
              `SELECT ${SCHEDULED_JOB_FIELDS} FROM scheduled_jobs WHERE principal_id = ? ORDER BY created_at ASC, id ASC`,
            )
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
    return (
      this.#database.query("DELETE FROM scheduled_jobs WHERE id = ? AND principal_id = ?").run(id, principalId)
        .changes > 0
    );
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
      const currentWasTopic =
        typeof current === "string" &&
        this.#database
          .query(
            `SELECT 1
           FROM conversation_bindings
           WHERE transport = 'telegram' AND account = ? AND thread <> '' AND omp_session_path = ?
           LIMIT 1`,
          )
          .get(account, current) !== null;
      const currentWasShared =
        typeof current === "string" &&
        this.#database
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
      const shared =
        sharedRow === null ? undefined : storedString(sharedRow, "omp_session_path", "conversation binding");
      const removed = this.#database
        .query("DELETE FROM conversation_bindings WHERE transport = 'telegram' AND account = ? AND thread <> ''")
        .run(account).changes;

      if (shared !== undefined) {
        this.#database.query("UPDATE conversation_bindings SET omp_session_path = ? WHERE thread = ''").run(shared);
        this.setCheckpoint("omp", "shared_session_file", shared);
        if (currentWasTopic || currentWasShared) this.setCheckpoint("omp", "session_file", shared);
      } else if (
        currentWasTopic &&
        this.#database.query("SELECT 1 FROM conversation_bindings WHERE omp_session_path = ? LIMIT 1").get(current) ===
          null
      ) {
        for (const key of ["session_file", "shared_session_file"]) {
          if (this.getCheckpoint("omp", key) !== current) continue;
          this.#database.query("DELETE FROM adapter_checkpoints WHERE adapter = 'omp' AND checkpoint_key = ?").run(key);
        }
      }

      this.#database
        .query("INSERT INTO migration_markers (marker, completed_at) VALUES (?, ?)")
        .run(marker, Date.now());
      return removed;
    });
  }

  #readPairingRequest(identity: TransportIdentity): StoredPairingRequest | undefined {
    const row = this.#database
      .query(
        `SELECT ${PAIRING_REQUEST_FIELDS}
         FROM pairing_requests
         WHERE transport = ? AND account = ? AND subject = ?`,
      )
      .get(identity.transport, identity.account, identity.subject) as SqlRow | null;
    return row === null ? undefined : decodeStoredPairingRequest(row);
  }

  #expirePairingRequests(now: number): number {
    return this.#database
      .query(
        `UPDATE pairing_requests
         SET state = 'expired', resolved_at = ?
         WHERE state = 'pending' AND expires_at <= ?`,
      )
      .run(now, now).changes;
  }

  #readSemanticView(address: ConversationAddress, viewId: string): StoredSemanticView | undefined {
    const row = this.#database
      .query(
        `SELECT ${SEMANTIC_VIEW_FIELDS}
         FROM semantic_views
         WHERE transport = ? AND account = ? AND channel = ? AND thread = ? AND view_id = ?`,
      )
      .get(address.transport, address.account, address.channel, address.thread ?? "", viewId) as SqlRow | null;
    return row === null ? undefined : decodeStoredSemanticView(row);
  }

  #readIngressComposition(id: string): IngressCompositionRecord {
    const row = this.#database
      .query(
        `SELECT id, group_key, principal_id, transport, account, channel, thread,
                created_at, updated_at, flush_at, deadline_at
         FROM ingress_compositions
         WHERE id = ?`,
      )
      .get(id) as SqlRow | null;
    if (row === null) throw new Error(`missing ingress composition ${id}`);

    const fragments = (
      this.#database
        .query(
          `SELECT payload_json
         FROM ingress_fragments
         WHERE composition_id = ?
         ORDER BY sort_order ASC, fragment_id ASC`,
        )
        .all(id) as SqlRow[]
    ).map((fragment) => {
      const message = decodeJson(fragment.payload_json, "ingress fragment");
      validateInboundMessage(message);
      return message;
    });
    return decodeIngressComposition(row, fragments);
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
