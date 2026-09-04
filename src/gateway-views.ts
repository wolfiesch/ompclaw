import type { ConversationAddress, OutboundNotification } from "./gateway-types";
import { isRecord } from "./type-guards";

export type SemanticViewKind = "home" | "task" | "result" | "decision";

export type SemanticViewState = "active" | "waiting" | "completed" | "failed" | "cancelled";

export type SemanticViewActionStyle = "default" | "primary" | "danger";

export type SemanticViewSectionTone = "default" | "muted" | "success" | "warning" | "danger";

export interface SemanticViewActionInput {
  readonly title: string;
  readonly prompt: string;
  readonly command: string;
  /** A single opaque command argument supplied by the trusted semantic view. */
  readonly argument?: string;
}

export interface SemanticViewAction {
  readonly id: string;
  readonly label: string;
  readonly command?: string;
  readonly input?: SemanticViewActionInput;
  readonly style?: SemanticViewActionStyle;
  readonly enabled?: boolean;
}

export interface SemanticViewSection {
  readonly id: string;
  readonly label?: string;
  readonly text: string;
  readonly tone?: SemanticViewSectionTone;
}

export interface SemanticView {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: SemanticViewKind;
  readonly version: number;
  readonly state: SemanticViewState;
  readonly title: string;
  readonly summary?: string;
  readonly sections: readonly SemanticViewSection[];
  readonly actions: readonly SemanticViewAction[];
  readonly updatedAt: number;
  readonly notification?: OutboundNotification;
}

export interface SemanticViewReceipt {
  readonly messageId: string;
  readonly index: number;
}

export interface StoredSemanticView {
  readonly principalId: string;
  readonly address: ConversationAddress;
  readonly view: SemanticView;
  readonly contentHash: string;
  readonly receipts: readonly SemanticViewReceipt[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface GatewaySemanticViewStore {
  getSemanticView(address: ConversationAddress, viewId: string): StoredSemanticView | undefined;
  getSemanticViewByReceipt(address: ConversationAddress, messageId: string): StoredSemanticView | undefined;
  putSemanticView(record: StoredSemanticView): boolean;
  deleteSemanticView(address: ConversationAddress, viewId: string): boolean;
  listSemanticViews(address?: ConversationAddress): StoredSemanticView[];
}

export const SEMANTIC_VIEW_IDENTIFIER_MAX_LENGTH = 24;

const SEMANTIC_VIEW_IDENTIFIER = /^[A-Za-z0-9_-]{1,24}$/;
const CONTENT_HASH = /^[a-f0-9]{64}$/i;

function requiredText(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${context} must not be empty`);
}

function validateNonnegativeInteger(value: unknown, context: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${context} must be a safe nonnegative integer`);
  }
}

function validateConversationAddress(value: unknown): asserts value is ConversationAddress {
  if (!isRecord(value)) throw new Error("semantic view address must be an object");
  requiredText(value.transport, "semantic view address transport");
  requiredText(value.account, "semantic view address account");
  requiredText(value.channel, "semantic view address channel");
  if (value.thread !== undefined) requiredText(value.thread, "semantic view address thread");
}

export function isSemanticViewIdentifier(value: unknown): value is string {
  return typeof value === "string" && SEMANTIC_VIEW_IDENTIFIER.test(value);
}

function validateOpaqueIdentifier(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || !SEMANTIC_VIEW_IDENTIFIER.test(value)) {
    throw new Error(`${context} must be a ${SEMANTIC_VIEW_IDENTIFIER_MAX_LENGTH}-character opaque identifier`);
  }
}

function validateSemanticViewAction(value: unknown, context: string): asserts value is SemanticViewAction {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  validateOpaqueIdentifier(value.id, `${context} id`);
  requiredText(value.label, `${context} label`);
  if (value.command !== undefined) requiredText(value.command, `${context} command`);
  if (value.input !== undefined) {
    if (!isRecord(value.input)) throw new Error(`${context} input must be an object`);
    requiredText(value.input.title, `${context} input title`);
    requiredText(value.input.prompt, `${context} input prompt`);
    requiredText(value.input.command, `${context} input command`);
    if (!/^\/[a-z][a-z_]*$/.test(value.input.command)) {
      throw new Error(`${context} input command must be a simple slash command`);
    }
    if (
      value.input.argument !== undefined &&
      (typeof value.input.argument !== "string" || !/^[A-Za-z0-9:_-]{1,256}$/.test(value.input.argument))
    ) {
      throw new Error(`${context} input argument must be a single opaque token`);
    }
  }
  if (value.command !== undefined && value.input !== undefined) {
    throw new Error(`${context} cannot define both command and input`);
  }
  if (value.style !== undefined && value.style !== "default" && value.style !== "primary" && value.style !== "danger") {
    throw new Error(`${context} style is invalid`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error(`${context} enabled must be boolean`);
  }
}

function validateSemanticViewSection(value: unknown, context: string): asserts value is SemanticViewSection {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  validateOpaqueIdentifier(value.id, `${context} id`);
  if (typeof value.text !== "string") throw new Error(`${context} text must be a string`);
  if (value.label !== undefined) requiredText(value.label, `${context} label`);
  if (
    value.tone !== undefined &&
    value.tone !== "default" &&
    value.tone !== "muted" &&
    value.tone !== "success" &&
    value.tone !== "warning" &&
    value.tone !== "danger"
  ) {
    throw new Error(`${context} tone is invalid`);
  }
}

function validateSemanticViewReceipt(value: unknown, context: string): asserts value is SemanticViewReceipt {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  validateOpaqueIdentifier(value.messageId, `${context} message id`);
  validateNonnegativeInteger(value.index, `${context} index`);
}

/** Validates an untrusted semantic view before rendering or persistence. */
export function validateSemanticView(value: unknown): asserts value is SemanticView {
  if (!isRecord(value)) throw new Error("semantic view must be an object");
  if (value.schemaVersion !== 1) throw new Error("semantic view schemaVersion must be 1");
  validateOpaqueIdentifier(value.id, "semantic view id");
  if (value.kind !== "home" && value.kind !== "task" && value.kind !== "result" && value.kind !== "decision") {
    throw new Error("semantic view kind is invalid");
  }
  validateNonnegativeInteger(value.version, "semantic view version");
  if (
    value.state !== "active" &&
    value.state !== "waiting" &&
    value.state !== "completed" &&
    value.state !== "failed" &&
    value.state !== "cancelled"
  ) {
    throw new Error("semantic view state is invalid");
  }
  requiredText(value.title, "semantic view title");
  if (value.summary !== undefined && typeof value.summary !== "string") {
    throw new Error("semantic view summary must be a string");
  }
  if (!Array.isArray(value.sections)) throw new Error("semantic view sections must be an array");
  const sectionIds = new Set<string>();
  for (const [index, section] of value.sections.entries()) {
    validateSemanticViewSection(section, `semantic view section ${index}`);
    if (sectionIds.has(section.id)) throw new Error("semantic view section ids must be unique");
    sectionIds.add(section.id);
  }
  if (!Array.isArray(value.actions)) throw new Error("semantic view actions must be an array");
  const actionIds = new Set<string>();
  for (const [index, action] of value.actions.entries()) {
    validateSemanticViewAction(action, `semantic view action ${index}`);
    if (actionIds.has(action.id)) throw new Error("semantic view action ids must be unique");
    actionIds.add(action.id);
  }
  validateNonnegativeInteger(value.updatedAt, "semantic view updatedAt");
  if (value.notification !== undefined && value.notification !== "default" && value.notification !== "silent") {
    throw new Error('semantic view notification must be "default" or "silent"');
  }
}

/** Validates the durable record that binds a semantic view to a principal and address. */
export function validateStoredSemanticView(value: unknown): asserts value is StoredSemanticView {
  if (!isRecord(value)) throw new Error("stored semantic view must be an object");
  requiredText(value.principalId, "stored semantic view principal id");
  validateConversationAddress(value.address);
  validateSemanticView(value.view);
  if (typeof value.contentHash !== "string" || !CONTENT_HASH.test(value.contentHash)) {
    throw new Error("stored semantic view content hash must be a SHA-256 hex digest");
  }
  if (!Array.isArray(value.receipts)) throw new Error("stored semantic view receipts must be an array");
  const receiptIndexes = new Set<number>();
  const receiptMessageIds = new Set<string>();
  for (const [index, receipt] of value.receipts.entries()) {
    validateSemanticViewReceipt(receipt, `semantic view receipt ${index}`);
    if (receiptIndexes.has(receipt.index)) throw new Error("semantic view receipt indexes must be unique");
    if (receiptMessageIds.has(receipt.messageId)) throw new Error("semantic view receipt message ids must be unique");
    receiptIndexes.add(receipt.index);
    receiptMessageIds.add(receipt.messageId);
  }
  validateNonnegativeInteger(value.createdAt, "stored semantic view createdAt");
  validateNonnegativeInteger(value.updatedAt, "stored semantic view updatedAt");
  if (value.updatedAt < value.createdAt) {
    throw new Error("stored semantic view updatedAt must not precede createdAt");
  }
}

/**
 * Returns an owned, canonical copy. Optional fields whose value is undefined
 * are omitted so encode/decode preserves their optional-field semantics.
 */
export function normalizeSemanticView(value: unknown): SemanticView {
  validateSemanticView(value);
  return {
    schemaVersion: 1,
    id: value.id,
    kind: value.kind,
    version: value.version,
    state: value.state,
    title: value.title,
    ...(value.summary === undefined ? {} : { summary: value.summary }),
    sections: value.sections.map((section) => ({
      id: section.id,
      ...(section.label === undefined ? {} : { label: section.label }),
      text: section.text,
      ...(section.tone === undefined ? {} : { tone: section.tone }),
    })),
    actions: value.actions.map((action) => ({
      id: action.id,
      label: action.label,
      ...(action.command === undefined ? {} : { command: action.command }),
      ...(action.input === undefined
        ? {}
        : {
            input: {
              title: action.input.title,
              prompt: action.input.prompt,
              command: action.input.command,
            },
          }),
      ...(action.style === undefined ? {} : { style: action.style }),
      ...(action.enabled === undefined ? {} : { enabled: action.enabled }),
    })),
    updatedAt: value.updatedAt,
    ...(value.notification === undefined ? {} : { notification: value.notification }),
  };
}

/** Returns an owned, canonical copy suitable for durable storage. */
export function normalizeStoredSemanticView(value: unknown): StoredSemanticView {
  validateStoredSemanticView(value);
  const address = value.address;
  return {
    principalId: value.principalId,
    address: {
      transport: address.transport,
      account: address.account,
      channel: address.channel,
      ...(address.thread === undefined ? {} : { thread: address.thread }),
    },
    view: normalizeSemanticView(value.view),
    contentHash: value.contentHash,
    receipts: value.receipts.map((receipt) => ({ messageId: receipt.messageId, index: receipt.index })),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
