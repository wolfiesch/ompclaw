import { createHash } from "node:crypto";
import type { ConversationAddress, DeliveryContext, OutboundNotification, OutboundReceipt } from "../../gateway-types";
import type { GatewaySemanticViewStore } from "../../gateway-store";
import {
  type SemanticView,
  type SemanticViewReceipt,
  type StoredSemanticView,
  validateSemanticView,
} from "../../gateway-views";
import type { TelegramMessageOptions } from "./delivery";

type TelegramSemanticViewStore = Pick<GatewaySemanticViewStore, "getSemanticView" | "putSemanticView">;

const CALLBACK_PREFIX = "s1";
const CALLBACK_MAX_BYTES = 64;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9_-]{1,24}$/;

export interface TelegramSemanticInlineButton {
  readonly text: string;
  readonly callback_data: string;
}

export type TelegramSemanticReplyMarkup = Readonly<{
  readonly inline_keyboard: readonly (readonly TelegramSemanticInlineButton[])[];
}> &
  Record<string, unknown>;

export interface TelegramSemanticMessageSpec {
  readonly text: string;
  readonly plainFallbackText: string;
  readonly replyMarkup: TelegramSemanticReplyMarkup;
  readonly notification: OutboundNotification | undefined;
}

export interface TelegramSemanticCallback {
  readonly schemaVersion: 1;
  readonly viewId: string;
  readonly viewVersion: number;
  readonly actionId: string;
}

export interface TelegramSemanticViewOutbound {
  sendMessages(
    address: ConversationAddress,
    text: string,
    context: DeliveryContext,
    options: TelegramMessageOptions,
    signal?: AbortSignal,
  ): Promise<readonly OutboundReceipt[]>;
  replaceMessages(
    address: ConversationAddress,
    targets: readonly OutboundReceipt[],
    text: string,
    context: DeliveryContext,
    options: TelegramMessageOptions,
    signal?: AbortSignal,
  ): Promise<readonly OutboundReceipt[]>;
}

function assertOpaqueIdentifier(value: string, label: string): void {
  if (!OPAQUE_IDENTIFIER.test(value))
    throw new Error(`${label} must contain 1-24 ASCII letters, digits, underscores, or hyphens`);
}

function assertSemanticVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Semantic view version must be a safe nonnegative integer");
}

function assertCallback(value: TelegramSemanticCallback): void {
  if (value.schemaVersion !== 1) throw new Error("Unsupported semantic callback schema version");
  assertOpaqueIdentifier(value.viewId, "Semantic callback view id");
  assertOpaqueIdentifier(value.actionId, "Semantic callback action id");
  assertSemanticVersion(value.viewVersion);
}

function sectionText(view: SemanticView): readonly string[] {
  const sections: string[] = [view.title];
  if (view.summary !== undefined) sections.push(view.summary);
  for (const section of view.sections) {
    const prefix = section.tone === "success" ? "✅ " : section.tone === "danger" ? "⚠️ " : "";
    const text = `${prefix}${section.text}`;
    sections.push(section.label === undefined ? text : `${section.label}\n${text}`);
  }
  return sections;
}

/**
 * Encodes callback payloads in a compact canonical form:
 * `s1.<view-id>.<base36-version>.<action-id>`.
 */
export function encodeTelegramSemanticCallback(value: TelegramSemanticCallback): string {
  assertCallback(value);
  const encoded = `${CALLBACK_PREFIX}.${value.viewId}.${value.viewVersion.toString(36)}.${value.actionId}`;
  if (Buffer.byteLength(encoded, "utf8") > CALLBACK_MAX_BYTES)
    throw new Error("Telegram semantic callback exceeds the 64-byte limit");
  return encoded;
}

export function decodeTelegramSemanticCallback(value: string): TelegramSemanticCallback {
  if (Buffer.byteLength(value, "utf8") > CALLBACK_MAX_BYTES)
    throw new Error("Telegram callback exceeds the 64-byte limit");
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== CALLBACK_PREFIX) throw new Error("Invalid Telegram semantic callback");

  const [, viewId, encodedVersion, actionId] = parts;
  if (viewId === undefined || encodedVersion === undefined || actionId === undefined)
    throw new Error("Invalid Telegram semantic callback");
  if (!/^(?:0|[1-9a-z][0-9a-z]*)$/.test(encodedVersion)) throw new Error("Invalid Telegram semantic callback version");

  const viewVersion = Number.parseInt(encodedVersion, 36);
  const callback: TelegramSemanticCallback = {
    schemaVersion: 1,
    viewId,
    viewVersion,
    actionId,
  };
  assertCallback(callback);
  if (viewVersion.toString(36) !== encodedVersion) throw new Error("Invalid Telegram semantic callback version");
  return callback;
}

function telegramActionRows(view: SemanticView): TelegramSemanticInlineButton[][] {
  const rows: TelegramSemanticInlineButton[][] = [];
  let row: TelegramSemanticInlineButton[] = [];
  const flush = (): void => {
    if (row.length === 0) return;
    rows.push(row);
    row = [];
  };
  for (const action of view.actions) {
    if (action.enabled === false) continue;
    const button = {
      text: action.style === "danger" && !action.label.startsWith("🛑") ? `⚠️ ${action.label}` : action.label,
      callback_data: encodeTelegramSemanticCallback({
        schemaVersion: view.schemaVersion,
        viewId: view.id,
        viewVersion: view.version,
        actionId: action.id,
      }),
    };
    if (action.style === "danger" || action.command === "/home") {
      flush();
      rows.push([button]);
      continue;
    }
    row.push(button);
    if (row.length === 2) flush();
  }
  flush();
  return rows;
}

export function renderTelegramSemanticView(view: SemanticView): TelegramSemanticMessageSpec {
  validateSemanticView(view);
  const inline_keyboard = telegramActionRows(view);
  const text = sectionText(view).join("\n\n");

  return {
    text,
    plainFallbackText: text,
    replyMarkup: { inline_keyboard },
    notification: view.notification,
  };
}

/** Hashes only the Telegram-visible semantic content in a stable field order. */
export function hashTelegramSemanticMessage(spec: TelegramSemanticMessageSpec): string {
  const serialized = JSON.stringify([
    spec.text,
    spec.plainFallbackText,
    spec.replyMarkup.inline_keyboard.map((row) => row.map((button) => [button.text, button.callback_data])),
    spec.notification ?? null,
  ]);
  return createHash("sha256").update(serialized).digest("hex");
}

function addressKey(address: ConversationAddress, viewId: string): string {
  return JSON.stringify([address.transport, address.account, address.channel, address.thread ?? null, viewId]);
}

function outboundReceipts(receipts: readonly SemanticViewReceipt[]): readonly OutboundReceipt[] {
  return [...receipts]
    .sort((left, right) => left.index - right.index)
    .map((receipt) => ({ transport: "telegram", messageId: receipt.messageId }));
}

function semanticReceipts(receipts: readonly OutboundReceipt[]): readonly SemanticViewReceipt[] {
  return receipts.map((receipt, index) => {
    if (receipt.transport !== "telegram") throw new Error("Semantic Telegram delivery returned a non-Telegram receipt");
    return { messageId: receipt.messageId, index };
  });
}

export class TelegramSemanticViewReconciler {
  readonly #store: TelegramSemanticViewStore;
  readonly #outbound: TelegramSemanticViewOutbound;
  readonly #now: () => number;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(store: TelegramSemanticViewStore, outbound: TelegramSemanticViewOutbound, now: () => number = Date.now) {
    this.#store = store;
    this.#outbound = outbound;
    this.#now = now;
  }

  reconcile(
    address: ConversationAddress,
    principalId: string,
    view: SemanticView,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<readonly SemanticViewReceipt[]> {
    validateSemanticView(view);
    return this.#serialize(addressKey(address, view.id), () =>
      this.#reconcile(address, principalId, view, context, signal),
    );
  }

  refresh(
    address: ConversationAddress,
    viewId: string,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<readonly SemanticViewReceipt[] | undefined> {
    assertOpaqueIdentifier(viewId, "Semantic view id");
    return this.#serialize(addressKey(address, viewId), () => this.#refresh(address, viewId, context, signal));
  }

  async #reconcile(
    address: ConversationAddress,
    principalId: string,
    view: SemanticView,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<readonly SemanticViewReceipt[]> {
    signal?.throwIfAborted();
    const spec = renderTelegramSemanticView(view);
    const contentHash = hashTelegramSemanticMessage(spec);
    const current = this.#store.getSemanticView(address, view.id);

    if (current !== undefined) {
      if (view.version < current.view.version) return current.receipts;
      if (view.version === current.view.version) {
        if (contentHash === current.contentHash) return current.receipts;
        throw new Error(`Semantic view ${view.id} has conflicting content at version ${view.version}`);
      }
    }

    const receipts = await this.#deliver(address, current?.receipts ?? [], spec, context, signal);
    const timestamp = this.#timestamp();
    const record: StoredSemanticView = {
      principalId,
      address,
      view,
      contentHash,
      receipts,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.#store.putSemanticView(record);
    return receipts;
  }

  async #refresh(
    address: ConversationAddress,
    viewId: string,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<readonly SemanticViewReceipt[] | undefined> {
    signal?.throwIfAborted();
    const current = this.#store.getSemanticView(address, viewId);
    if (current === undefined) return undefined;

    const spec = renderTelegramSemanticView(current.view);
    const receipts = await this.#deliver(address, current.receipts, spec, context, signal);
    const record: StoredSemanticView = {
      ...current,
      contentHash: hashTelegramSemanticMessage(spec),
      receipts,
      updatedAt: this.#timestamp(),
    };
    this.#store.putSemanticView(record);
    return receipts;
  }

  async #deliver(
    address: ConversationAddress,
    previous: readonly SemanticViewReceipt[],
    spec: TelegramSemanticMessageSpec,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<readonly SemanticViewReceipt[]> {
    const targets = outboundReceipts(previous);
    const receipts =
      targets.length === 0
        ? await this.#outbound.sendMessages(address, spec.text, context, spec, signal)
        : await this.#outbound.replaceMessages(address, targets, spec.text, context, spec, signal);
    return semanticReceipts(receipts);
  }

  #serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#queues.set(key, gate);

    return previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        release?.();
        if (this.#queues.get(key) === gate) this.#queues.delete(key);
      });
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Semantic view clock must return a safe nonnegative integer");
    return value;
  }
}
