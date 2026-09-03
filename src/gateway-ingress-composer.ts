import type { AppendIngressFragmentInput, IngressCompositionRecord } from "./gateway-store";
import type { ConversationAddress, InboundMessage } from "./gateway-types";

export const DEFAULT_INGRESS_DEBOUNCE_MS = 800;
export const DEFAULT_INGRESS_MEDIA_DEBOUNCE_MS = 800;
export const DEFAULT_INGRESS_MAX_WAIT_MS = 5_000;

export type GatewayIngressTimer = NodeJS.Timeout;

export interface GatewayIngressCompositionStore {
  appendIngressFragment(input: AppendIngressFragmentInput): IngressCompositionRecord;
  getIngressComposition(id: string): IngressCompositionRecord | undefined;
  getIngressCompositionByGroupKey(groupKey: string): IngressCompositionRecord | undefined;
  getIngressCompositionByFragment(
    fragmentId: string,
    principalId: string,
    address: ConversationAddress,
  ): IngressCompositionRecord | undefined;
  listPendingIngressCompositions(): IngressCompositionRecord[];
  deleteIngressComposition(id: string): boolean;
}

export interface GatewayIngressComposerLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface GatewayIngressComposerOptions {
  readonly store: GatewayIngressCompositionStore;
  readonly deliver: (message: InboundMessage) => Promise<void>;
  readonly now?: () => number;
  readonly logger?: GatewayIngressComposerLogger;
  readonly debounceMs?: number;
  readonly mediaDebounceMs?: number;
  readonly maxWaitMs?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => GatewayIngressTimer;
  readonly clearTimer?: (timer: GatewayIngressTimer) => void;
}

/**
 * Durably coalesces related Telegram ingress before the application claims a turn.
 * Non-Telegram transports bypass it so their existing immediate semantics remain intact.
 */
export class GatewayIngressComposer {
  readonly #store: GatewayIngressCompositionStore;
  readonly #deliver: (message: InboundMessage) => Promise<void>;
  readonly #now: () => number;
  readonly #logger: GatewayIngressComposerLogger;
  readonly #debounceMs: number;
  readonly #mediaDebounceMs: number;
  readonly #maxWaitMs: number;
  readonly #setTimer: (callback: () => void, delayMs: number) => GatewayIngressTimer;
  readonly #clearTimer: (timer: GatewayIngressTimer) => void;
  readonly #retryAt = new Map<string, number>();
  readonly #flushing = new Map<string, Promise<boolean>>();
  readonly #accepting = new Map<string, Promise<void>>();
  #timer: GatewayIngressTimer | undefined;
  #started = false;

  constructor(options: GatewayIngressComposerOptions) {
    this.#store = options.store;
    this.#deliver = options.deliver;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger ?? console;
    this.#debounceMs = positiveInteger(options.debounceMs ?? DEFAULT_INGRESS_DEBOUNCE_MS, "ingress debounce");
    this.#mediaDebounceMs = positiveInteger(
      options.mediaDebounceMs ?? DEFAULT_INGRESS_MEDIA_DEBOUNCE_MS,
      "ingress media debounce",
    );
    this.#maxWaitMs = positiveInteger(options.maxWaitMs ?? DEFAULT_INGRESS_MAX_WAIT_MS, "ingress max wait");
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  /** Recover staged ingress and arm the nearest durable deadline. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#scheduleNext();
  }

  /** Cancel in-memory wakeups while leaving durable ingress fragments untouched. */
  stop(): void {
    this.#started = false;
    this.#cancelTimer();
  }

  async accept(message: InboundMessage): Promise<void> {
    if (message.identity.transport !== "telegram") {
      await this.#deliver(message);
      return;
    }

    const queueKey = JSON.stringify([
      message.principal.id,
      message.address.transport,
      message.address.account,
      message.address.channel,
      message.address.thread ?? null,
    ]);
    const previous = this.#accepting.get(queueKey) ?? Promise.resolve();
    const accepted = previous.catch(() => undefined).then(() => this.#acceptTelegram(message));
    this.#accepting.set(queueKey, accepted);
    try {
      await accepted;
    } finally {
      if (this.#accepting.get(queueKey) === accepted) this.#accepting.delete(queueKey);
    }
  }

  async #acceptTelegram(message: InboundMessage): Promise<void> {
    const receivedAt = this.#now();
    const openEditedFragment = message.edited ? this.#findCompositionByFragment(message) : undefined;
    if (message.edited && openEditedFragment === undefined) return;
    if (!message.edited && isCommand(message)) {
      const flushed = await this.#flushConversation(message.principal.id, message.address);
      if (!flushed) throw new Error("Cannot deliver a command before earlier ingress messages");
      await this.#deliver(message);
      return;
    }

    let groupKey = compositionGroupKey(message);
    let current = openEditedFragment ?? this.#findCompositionByGroupKey(groupKey);
    if (current !== undefined) {
      groupKey = current.groupKey;
      const activeFlush = this.#flushing.get(current.id);
      if (activeFlush !== undefined) {
        await activeFlush;
        if (message.edited) {
          current = this.#findCompositionByFragment(message);
          if (current === undefined) return;
          groupKey = current.groupKey;
        }
      }
    }

    const flushed = await this.#flushOtherCompositions(message.principal.id, message.address, groupKey);
    if (!flushed) throw new Error("Cannot stage ingress before earlier ingress messages are delivered");

    const hint = message.composition;
    const debounceMs = hint?.kind === "media" ? this.#mediaDebounceMs : this.#debounceMs;
    const input: AppendIngressFragmentInput = {
      compositionId: message.id,
      groupKey,
      message,
      receivedAt,
      flushAt: receivedAt + debounceMs,
      deadlineAt: receivedAt + this.#maxWaitMs,
      sortOrder: hint?.order ?? receivedAt,
    };
    this.#store.appendIngressFragment(input);
    if (current !== undefined) this.#retryAt.delete(current.id);
    this.#scheduleNext();
  }

  /** Flush every persisted composition whose debounce or retry deadline has elapsed. */
  async flushDue(now = this.#now()): Promise<number> {
    let delivered = 0;
    const due = this.#store
      .listPendingIngressCompositions()
      .filter((record) => this.#dueAt(record) <= now)
      .sort(compareCompositions);

    for (const record of due) {
      if (await this.#flushComposition(record, now)) delivered += 1;
    }
    this.#scheduleNext();
    return delivered;
  }

  async #flushConversation(principalId: string, address: ConversationAddress): Promise<boolean> {
    const records = this.#store
      .listPendingIngressCompositions()
      .filter((record) => record.principalId === principalId && sameAddress(record.address, address))
      .sort(compareCompositions);

    for (const record of records) {
      if (!(await this.#flushComposition(record))) return false;
    }
    return true;
  }

  async #flushOtherCompositions(principalId: string, address: ConversationAddress, groupKey: string): Promise<boolean> {
    const records = this.#store
      .listPendingIngressCompositions()
      .filter(
        (record) =>
          record.groupKey !== groupKey && record.principalId === principalId && sameAddress(record.address, address),
      )
      .sort(compareCompositions);

    for (const record of records) {
      if (!(await this.#flushComposition(record))) return false;
    }
    return true;
  }

  #flushComposition(record: IngressCompositionRecord, retryBaseAt?: number): Promise<boolean> {
    const active = this.#flushing.get(record.id);
    if (active !== undefined) return active;

    const flush = this.#deliverComposition(record, retryBaseAt).finally(() => {
      this.#flushing.delete(record.id);
      this.#scheduleNext();
    });
    this.#flushing.set(record.id, flush);
    return flush;
  }

  async #deliverComposition(record: IngressCompositionRecord, retryBaseAt?: number): Promise<boolean> {
    const current = this.#findComposition(record.id);
    if (current === undefined) return true;

    try {
      await this.#deliver(composeMessage(current));
      this.#store.deleteIngressComposition(current.id);
      this.#retryAt.delete(current.id);
      return true;
    } catch (error) {
      const retryDelayMs =
        current.fragments.at(-1)?.composition?.kind === "media" ? this.#mediaDebounceMs : this.#debounceMs;
      this.#retryAt.set(current.id, (retryBaseAt ?? this.#now()) + retryDelayMs);
      this.#logger.warn(`Ingress composition ${current.id} delivery failed: ${errorMessage(error)}`);
      return false;
    }
  }

  #findComposition(id: string): IngressCompositionRecord | undefined {
    return this.#store.getIngressComposition(id);
  }

  #findCompositionByGroupKey(groupKey: string): IngressCompositionRecord | undefined {
    return this.#store.getIngressCompositionByGroupKey(groupKey);
  }

  #findCompositionByFragment(message: InboundMessage): IngressCompositionRecord | undefined {
    return this.#store.getIngressCompositionByFragment(message.id, message.principal.id, message.address);
  }

  #dueAt(record: IngressCompositionRecord): number {
    return this.#retryAt.get(record.id) ?? Math.min(record.flushAt, record.deadlineAt);
  }

  #scheduleNext(): void {
    if (!this.#started) return;
    this.#cancelTimer();

    let nextDueAt: number | undefined;
    for (const record of this.#store.listPendingIngressCompositions()) {
      if (this.#flushing.has(record.id)) continue;
      const dueAt = this.#dueAt(record);
      if (nextDueAt === undefined || dueAt < nextDueAt) nextDueAt = dueAt;
    }
    if (nextDueAt === undefined) return;

    const delayMs = Math.max(0, nextDueAt - this.#now());
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      void this.flushDue().catch((error: unknown) => {
        this.#logger.error(`Ingress composer flush failed: ${errorMessage(error)}`);
      });
    }, delayMs);
  }

  #cancelTimer(): void {
    if (this.#timer === undefined) return;
    this.#clearTimer(this.#timer);
    this.#timer = undefined;
  }
}

function compositionGroupKey(message: InboundMessage): string {
  const hint = message.composition;
  return JSON.stringify([
    message.principal.id,
    message.address.transport,
    message.address.account,
    message.address.channel,
    message.address.thread ?? null,
    hint?.kind ?? "text",
    hint?.groupId ?? null,
    message.replyTo?.transport ?? null,
    message.replyTo?.messageId ?? null,
    message.replyContext?.messageId ?? null,
  ]);
}

function composeMessage(record: IngressCompositionRecord): InboundMessage {
  const fragments = [...record.fragments].sort(compareFragments);
  const first = fragments[0];
  const last = fragments.at(-1);
  if (first === undefined || last === undefined) throw new Error(`Ingress composition ${record.id} has no fragments`);
  if (fragments.length === 1 && first.id === record.id) return first;

  const textParts = fragments
    .map((fragment) => fragment.content.text)
    .filter((text): text is string => text !== undefined && text.length > 0);
  const attachments = fragments.flatMap((fragment) => fragment.content.attachments ?? []);
  const replyContext =
    last.replyContext ?? fragments.findLast((fragment) => fragment.replyContext !== undefined)?.replyContext;
  return {
    ...last,
    id: record.id,
    content: {
      ...(textParts.length === 0 ? {} : { text: textParts.join("\n\n") }),
      ...(attachments.length === 0 ? {} : { attachments }),
    },
    ...(replyContext === undefined ? {} : { replyContext }),
  };
}

function compareCompositions(left: IngressCompositionRecord, right: IngressCompositionRecord): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function compareFragments(left: InboundMessage, right: InboundMessage): number {
  return (left.composition?.order ?? 0) - (right.composition?.order ?? 0) || left.id.localeCompare(right.id);
}

function sameAddress(left: ConversationAddress, right: ConversationAddress): boolean {
  return (
    left.transport === right.transport &&
    left.account === right.account &&
    left.channel === right.channel &&
    left.thread === right.thread
  );
}

function isCommand(message: InboundMessage): boolean {
  return message.content.text?.trim().startsWith("/") ?? false;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
