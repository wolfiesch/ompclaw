import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ConversationAddress, Principal, TransportIdentity } from "./gateway-types";
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

      CREATE TABLE IF NOT EXISTS migration_markers (
        marker TEXT PRIMARY KEY NOT NULL,
        completed_at INTEGER NOT NULL
      );
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

  claimInboundMessage(transport: string, account: string, messageId: string, receivedAt: number): boolean {
    requiredText(transport, "inbound message transport");
    requiredText(account, "inbound message account");
    requiredText(messageId, "inbound message id");
    if (!Number.isSafeInteger(receivedAt)) {
      throw new Error("inbound message receivedAt must be an integer timestamp");
    }

    const result = this.#database
      .query(
        `INSERT INTO inbound_messages (transport, account, message_id, received_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(transport, account, message_id) DO NOTHING`,
      )
      .run(transport, account, messageId, receivedAt);
    return result.changes > 0;
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

    return this.#database.query("DELETE FROM inbound_messages WHERE received_at < ?").run(before).changes;
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
      if (lastUpdateId !== undefined) this.setCheckpoint("telegram", "update_id", String(lastUpdateId));
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
