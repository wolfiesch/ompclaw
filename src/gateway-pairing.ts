import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PairingRequestState, StoredPairingRequest } from "./gateway-store";
import type { GatewayStore } from "./gateway-store";
import type { ConversationAddress, TransportIdentity } from "./gateway-types";

export const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1_000;
export const MAX_PAIRING_ATTEMPTS = 5;

export type { PairingRequestState };

/** A pairing request without authentication material. */
export interface PairingRequest {
 readonly identity: TransportIdentity;
 readonly address: ConversationAddress;
 readonly state: PairingRequestState;
 readonly failedAttempts: number;
 readonly maxAttempts: number;
 readonly createdAt: number;
 readonly expiresAt: number;
 readonly resolvedAt?: number;
 readonly principalId?: string;
}

/** A safe request representation for local setup and operator UIs. */
export type PairingRequestView = PairingRequest;

export interface PairingRequestInput {
 readonly identity: TransportIdentity;
 readonly address: ConversationAddress;
 readonly now?: number;
}

export interface PairingRequestResult {
 readonly request: PairingRequest;
 /** Present only at request creation; never persisted or returned from list/resolve methods. */
 readonly code: string;
}

export interface PairingSecrets {
 createCode(): string;
 createSalt(): Uint8Array;
}

export interface GatewayPairingServiceOptions {
 readonly ttlMs?: number;
 readonly maxAttempts?: number;
 readonly secrets?: PairingSecrets;
 readonly principalIdForIdentity?: (identity: TransportIdentity) => string;
}

function requiredText(value: unknown, context: string): asserts value is string {
 if (typeof value !== "string" || value.length === 0) throw new Error(`${context} must not be empty`);
}

function pairingNow(now: number): number {
 if (!Number.isSafeInteger(now) || now < 0) throw new Error("pairing timestamp must be a safe nonnegative integer");
 return now;
}

function validateIdentityAndAddress(identity: TransportIdentity, address: ConversationAddress): void {
 requiredText(identity.transport, "pairing identity transport");
 requiredText(identity.account, "pairing identity account");
 requiredText(identity.subject, "pairing identity subject");
 requiredText(address.transport, "pairing address transport");
 requiredText(address.account, "pairing address account");
 requiredText(address.channel, "pairing address channel");
 if (address.thread !== undefined) requiredText(address.thread, "pairing address thread");
 if (identity.transport !== address.transport || identity.account !== address.account) {
  throw new Error("pairing identity and address must share transport and account");
 }
}

function pairingCode(value: unknown): string | undefined {
 if (typeof value !== "string" || value.length === 0 || value.length > 128) return undefined;
 return value;
}

function pairingSalt(value: Uint8Array): string {
 if (!(value instanceof Uint8Array) || value.byteLength < 16) {
  throw new Error("pairing salt must contain at least 16 cryptographically random bytes");
 }
 return Buffer.from(value).toString("hex");
}

function hashCode(salt: string, code: string): string {
 return createHash("sha256")
  .update(Buffer.from(salt, "hex"))
  .update(code, "utf8")
  .digest("hex");
}

function hashesMatch(expectedHash: string, salt: string, code: string): boolean {
 const actual = Buffer.from(hashCode(salt, code), "hex");
 const expected = Buffer.from(expectedHash, "hex");
 return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function viewOf(request: StoredPairingRequest): PairingRequestView {
 return {
  identity: request.identity,
  address: request.address,
  state: request.state,
  failedAttempts: request.failedAttempts,
  maxAttempts: request.maxAttempts,
  createdAt: request.createdAt,
  expiresAt: request.expiresAt,
  ...(request.resolvedAt === undefined ? {} : { resolvedAt: request.resolvedAt }),
  ...(request.principalId === undefined ? {} : { principalId: request.principalId }),
 };
}

function defaultCode(): string {
 const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
 return Array.from(randomBytes(8), (byte) => alphabet[byte & 31]).join("");
}

const defaultSecrets: PairingSecrets = {
 createCode: defaultCode,
 createSalt: () => randomBytes(16),
};

/**
 * Durable pairing persistence with code verification contained behind this
 * boundary so code salts and hashes cannot escape into setup or UI layers.
 */
export class GatewayPairingStore {
 readonly #store: GatewayStore;

 constructor(store: GatewayStore) {
  this.#store = store;
 }

 create(
  identity: TransportIdentity,
  address: ConversationAddress,
  code: string,
  salt: Uint8Array,
  maxAttempts: number,
  now: number,
  ttlMs: number,
 ): PairingRequest {
  validateIdentityAndAddress(identity, address);
  const checkedCode = pairingCode(code);
  if (checkedCode === undefined) throw new Error("pairing code is malformed");
  const createdAt = pairingNow(now);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > DEFAULT_PAIRING_TTL_MS) {
   throw new Error("pairing TTL must be between one millisecond and ten minutes");
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_PAIRING_ATTEMPTS) {
   throw new Error("pairing maximum attempts must be between one and five");
  }
  const expiresAt = createdAt + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) throw new Error("pairing expiry timestamp must be a safe integer");
  const codeSalt = pairingSalt(salt);
  return viewOf(
   this.#store.upsertPairingRequest({
    identity,
    address,
    codeHash: hashCode(codeSalt, checkedCode),
    codeSalt,
    maxAttempts,
    createdAt,
    expiresAt,
   }),
  );
 }

 list(now: number): PairingRequestView[] {
  this.#store.expirePairingRequests(pairingNow(now));
  return this.#store.listPairingRequests().map(viewOf);
 }

 approve(
  code: string,
  principalIdOrResolver: string | ((identity: TransportIdentity) => string),
  now: number,
 ): PairingRequestView {
  const request = this.#resolveCode(code, pairingNow(now));
  const principalId =
   typeof principalIdOrResolver === "string"
    ? principalIdOrResolver
    : principalIdOrResolver(request.identity);
  requiredText(principalId, "pairing principal id");
  const resolution = this.#store.approvePairingRequest(request.identity, principalId, now);
  if (resolution.status !== "approved") throw new Error("pairing code is invalid or unavailable");
  return viewOf(resolution.request);
 }

 reject(code: string, now: number): PairingRequestView {
  const request = this.#resolveCode(code, pairingNow(now));
  const resolution = this.#store.rejectPairingRequest(request.identity, now);
  if (resolution.request === undefined || resolution.request.state !== "rejected") {
   throw new Error("pairing code is invalid or unavailable");
  }
  return viewOf(resolution.request);
 }

 clear(now: number): number {
  return this.#store.clearPairingRequests(pairingNow(now));
 }

 #resolveCode(code: unknown, now: number): StoredPairingRequest {
  this.#store.expirePairingRequests(now);
  const pending = this.#store.listPairingRequests().filter((request) => request.state === "pending");
  const checkedCode = pairingCode(code);
  if (checkedCode === undefined) {
   this.#store.recordPairingFailures(pending.map((request) => request.identity), now);
   throw new Error("pairing code is invalid or unavailable");
  }

  const matches = pending.filter((request) => hashesMatch(request.codeHash, request.codeSalt, checkedCode));
  if (matches.length !== 1) {
   this.#store.recordPairingFailures((matches.length === 0 ? pending : matches).map((request) => request.identity), now);
   throw new Error("pairing code is invalid or unavailable");
  }
  return matches[0];
 }
}

export class GatewayPairingService {
 readonly #store: GatewayPairingStore;
 readonly #ttlMs: number;
 readonly #maxAttempts: number;
 readonly #secrets: PairingSecrets;
 readonly #principalIdForIdentity: (identity: TransportIdentity) => string;

 constructor(store: GatewayStore | GatewayPairingStore, options: GatewayPairingServiceOptions = {}) {
  this.#store = store instanceof GatewayPairingStore ? store : new GatewayPairingStore(store);
  this.#ttlMs = options.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
  this.#maxAttempts = options.maxAttempts ?? MAX_PAIRING_ATTEMPTS;
  this.#secrets = options.secrets ?? defaultSecrets;
  this.#principalIdForIdentity = options.principalIdForIdentity ?? defaultPrincipalId;

  if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1 || this.#ttlMs > DEFAULT_PAIRING_TTL_MS) {
   throw new Error("pairing TTL must be between one millisecond and ten minutes");
  }
  if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1 || this.#maxAttempts > MAX_PAIRING_ATTEMPTS) {
   throw new Error("pairing maximum attempts must be between one and five");
  }
 }

 request(identity: TransportIdentity, address: ConversationAddress, now = Date.now()): PairingRequestResult {
  const code = this.#secrets.createCode();
  return {
   request: this.#store.create(identity, address, code, this.#secrets.createSalt(), this.#maxAttempts, now, this.#ttlMs),
   code,
  };
 }

 list(now = Date.now()): PairingRequestView[] {
  return this.#store.list(now);
 }

 approve(code: string, principalId?: string, now = Date.now()): PairingRequestView {
  return this.#store.approve(code, principalId ?? this.#principalIdForIdentity, now);
 }
 reject(code: string, now = Date.now()): PairingRequestView {
  return this.#store.reject(code, now);
 }

 clear(now = Date.now()): number {
  return this.#store.clear(now);
 }
}

export function defaultPrincipalId(identity: TransportIdentity): string {
 requiredText(identity.transport, "pairing identity transport");
 requiredText(identity.account, "pairing identity account");
 requiredText(identity.subject, "pairing identity subject");
 return `operator:${encodeURIComponent(identity.transport)}:${encodeURIComponent(identity.account)}:${encodeURIComponent(identity.subject)}`;
}
