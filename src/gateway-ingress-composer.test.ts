import { describe, expect, test } from "bun:test";
import type { AppendIngressFragmentInput, IngressCompositionRecord } from "./gateway-store";
import {
  GatewayIngressComposer,
  type GatewayIngressComposerOptions,
  type GatewayIngressCompositionStore,
  type GatewayIngressTimer,
} from "./gateway-ingress-composer";
import type { ConversationAddress, InboundMessage, MessageAttachment } from "./gateway-types";

const principal = { id: "operator-42", roles: ["operator"] } as const;
const telegramIdentity = { transport: "telegram", account: "default", subject: "42" } as const;
const telegramAddress = { transport: "telegram", account: "default", channel: "42" } as const;

interface StoredFragment {
  readonly message: InboundMessage;
  readonly sortOrder: number;
}

interface StoredComposition {
  readonly id: string;
  readonly groupKey: string;
  readonly address: InboundMessage["address"];
  readonly principalId: string;
  readonly createdAt: number;
  updatedAt: number;
  flushAt: number;
  readonly deadlineAt: number;
  fragments: StoredFragment[];
}

class MemoryIngressStore implements GatewayIngressCompositionStore {
  readonly #compositionsById = new Map<string, StoredComposition>();
  readonly #compositionIdByGroup = new Map<string, string>();

  appendIngressFragment(input: AppendIngressFragmentInput): IngressCompositionRecord {
    const existingId = this.#compositionIdByGroup.get(input.groupKey);
    const composition = existingId === undefined ? undefined : this.#compositionsById.get(existingId);
    if (composition === undefined) {
      const created: StoredComposition = {
        id: input.compositionId,
        groupKey: input.groupKey,
        address: input.message.address,
        principalId: input.message.principal.id,
        createdAt: input.receivedAt,
        updatedAt: input.receivedAt,
        flushAt: Math.min(input.flushAt, input.deadlineAt),
        deadlineAt: input.deadlineAt,
        fragments: [{ message: input.message, sortOrder: input.sortOrder }],
      };
      this.#compositionsById.set(created.id, created);
      this.#compositionIdByGroup.set(created.groupKey, created.id);
      return this.#snapshot(created);
    }

    const fragmentIndex = composition.fragments.findIndex((fragment) => fragment.message.id === input.message.id);
    if (fragmentIndex >= 0 && !input.message.edited) return this.#snapshot(composition);
    if (fragmentIndex >= 0) {
      composition.fragments[fragmentIndex] = { message: input.message, sortOrder: input.sortOrder };
    } else {
      composition.fragments.push({ message: input.message, sortOrder: input.sortOrder });
    }
    composition.updatedAt = input.receivedAt;
    composition.flushAt = Math.min(input.flushAt, composition.deadlineAt);
    return this.#snapshot(composition);
  }
  getIngressComposition(id: string): IngressCompositionRecord | undefined {
    const composition = this.#compositionsById.get(id);
    return composition === undefined ? undefined : this.#snapshot(composition);
  }

  getIngressCompositionByGroupKey(groupKey: string): IngressCompositionRecord | undefined {
    const id = this.#compositionIdByGroup.get(groupKey);
    return id === undefined ? undefined : this.getIngressComposition(id);
  }

  getIngressCompositionByFragment(
    fragmentId: string,
    principalId: string,
    address: ConversationAddress,
  ): IngressCompositionRecord | undefined {
    const composition = [...this.#compositionsById.values()].find(
      (candidate) =>
        candidate.principalId === principalId &&
        candidate.address.transport === address.transport &&
        candidate.address.account === address.account &&
        candidate.address.channel === address.channel &&
        candidate.address.thread === address.thread &&
        candidate.fragments.some((fragment) => fragment.message.id === fragmentId),
    );
    return composition === undefined ? undefined : this.#snapshot(composition);
  }

  listPendingIngressCompositions(): IngressCompositionRecord[] {
    return [...this.#compositionsById.values()].map((composition) => this.#snapshot(composition));
  }

  deleteIngressComposition(id: string): boolean {
    const composition = this.#compositionsById.get(id);
    if (composition === undefined) return false;
    this.#compositionsById.delete(id);
    this.#compositionIdByGroup.delete(composition.groupKey);
    return true;
  }

  #snapshot(composition: StoredComposition): IngressCompositionRecord {
    return {
      id: composition.id,
      groupKey: composition.groupKey,
      address: composition.address,
      principalId: composition.principalId,
      createdAt: composition.createdAt,
      updatedAt: composition.updatedAt,
      flushAt: composition.flushAt,
      deadlineAt: composition.deadlineAt,
      fragments: [...composition.fragments]
        .sort((left, right) => left.sortOrder - right.sortOrder || left.message.id.localeCompare(right.message.id))
        .map((fragment) => fragment.message),
    };
  }
}

interface ScheduledTimer {
  readonly handle: GatewayIngressTimer;
  readonly delayMs: number;
  cleared: boolean;
}

class FakeTimers {
  readonly scheduled: ScheduledTimer[] = [];

  setTimer = (_callback: () => void, delayMs: number): GatewayIngressTimer => {
    const handle = {} as GatewayIngressTimer;
    this.scheduled.push({ handle, delayMs, cleared: false });
    return handle;
  };

  clearTimer = (handle: GatewayIngressTimer): void => {
    const timer = this.scheduled.find((scheduled) => scheduled.handle === handle);
    if (timer !== undefined) timer.cleared = true;
  };

  activeDelays(): number[] {
    return this.scheduled.filter((timer) => !timer.cleared).map((timer) => timer.delayMs);
  }
}

function inbound(
  id: string,
  text: string | undefined,
  options: {
    readonly address?: InboundMessage["address"];
    readonly attachments?: readonly MessageAttachment[];
    readonly composition?: InboundMessage["composition"];
    readonly edited?: boolean;
    readonly replyContext?: InboundMessage["replyContext"];
    readonly replyTo?: InboundMessage["replyTo"];
    readonly sourceReceipt?: InboundMessage["sourceReceipt"];
    readonly transport?: string;
  } = {},
): InboundMessage {
  return {
    id,
    sentAt: 0,
    identity: {
      ...telegramIdentity,
      transport: options.transport ?? telegramIdentity.transport,
    },
    address: options.address ?? telegramAddress,
    content: {
      ...(text === undefined ? {} : { text }),
      ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
    },
    principal,
    ...(options.composition === undefined ? {} : { composition: options.composition }),
    ...(options.edited === undefined ? {} : { edited: options.edited }),
    ...(options.replyContext === undefined ? {} : { replyContext: options.replyContext }),
    ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
    ...(options.sourceReceipt === undefined ? {} : { sourceReceipt: options.sourceReceipt }),
  };
}

function composer(
  store: GatewayIngressCompositionStore,
  delivered: InboundMessage[],
  now: () => number,
  options: Partial<GatewayIngressComposerOptions> = {},
): GatewayIngressComposer {
  return new GatewayIngressComposer({
    ...options,
    store,
    deliver: async (message) => {
      delivered.push(message);
    },
    now,
    logger: { warn: () => {}, error: () => {} },
  });
}

describe("GatewayIngressComposer", () => {
  test("joins rapid text by conversation and keeps reply data from the final fragment", async () => {
    const store = new MemoryIngressStore();
    const delivered: InboundMessage[] = [];
    let now = 1_000;
    const ingress = composer(store, delivered, () => now);

    await ingress.accept(
      inbound("first", "First", {
        composition: { kind: "text", order: 1 },
        replyTo: { transport: "telegram", messageId: "target" },
        replyContext: { messageId: "target", text: "older" },
        sourceReceipt: { transport: "telegram", messageId: "first" },
      }),
    );
    now += 100;
    await ingress.accept(
      inbound("second", "Second", {
        composition: { kind: "text", order: 2 },
        replyTo: { transport: "telegram", messageId: "target" },
        replyContext: { messageId: "target", text: "newer" },
        sourceReceipt: { transport: "telegram", messageId: "second" },
      }),
    );

    expect(await ingress.flushDue(now + 799)).toBe(0);
    expect(await ingress.flushDue(now + 800)).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toEqual(
      expect.objectContaining({
        id: "first",
        content: { text: "First\n\nSecond" },
        sourceReceipt: { transport: "telegram", messageId: "second" },
        replyContext: { messageId: "target", text: "newer" },
      }),
    );
    expect(store.listPendingIngressCompositions()).toEqual([]);
  });

  test("never groups fragments from different conversations", async () => {
    const store = new MemoryIngressStore();
    const delivered: InboundMessage[] = [];
    let now = 0;
    const ingress = composer(store, delivered, () => now);

    await ingress.accept(inbound("one", "First", { composition: { kind: "text", order: 1 } }));
    await ingress.accept(
      inbound("two", "Second", {
        address: { ...telegramAddress, channel: "other" },
        composition: { kind: "text", order: 2 },
      }),
    );
    expect(delivered).toEqual([]);
    now += 800;
    expect(await ingress.flushDue()).toBe(2);
    expect(delivered.map((message) => [message.address.channel, message.content.text])).toEqual([
      ["42", "First"],
      ["other", "Second"],
    ]);
  });

  test("does not let a failed composition block another conversation", async () => {
    const store = new MemoryIngressStore();
    const delivered: InboundMessage[] = [];
    const ingress = new GatewayIngressComposer({
      store,
      now: () => 0,
      logger: { warn: () => {}, error: () => {} },
      deliver: async (message) => {
        if (message.address.channel === telegramAddress.channel) throw new Error("unavailable");
        delivered.push(message);
      },
    });

    await ingress.accept(inbound("blocked", "Pending", { composition: { kind: "text", order: 1 } }));
    const command = inbound("other-command", "/status", {
      address: { ...telegramAddress, channel: "other" },
      composition: { kind: "text", order: 2 },
    });
    await expect(ingress.accept(command)).resolves.toBeUndefined();

    expect(delivered).toEqual([command]);
    expect(store.listPendingIngressCompositions().map((record) => record.id)).toEqual(["blocked"]);
  });

  test("flushes an album in media order and caps an active burst at its original deadline", async () => {
    const store = new MemoryIngressStore();
    const delivered: InboundMessage[] = [];
    let now = 0;
    const ingress = composer(store, delivered, () => now);

    await ingress.accept(
      inbound("album-late", "Second", {
        attachments: [{ url: "https://example.test/second.jpg" }],
        composition: { kind: "media", groupId: "album", order: 2 },
      }),
    );
    now += 100;
    await ingress.accept(
      inbound("album-first", "Caption", {
        attachments: [{ url: "https://example.test/first.jpg" }],
        composition: { kind: "media", groupId: "album", order: 1 },
      }),
    );
    now += 700;
    for (let index = 0; index < 8; index += 1) {
      await ingress.accept(inbound(`burst-${index}`, `part-${index}`, { composition: { kind: "text", order: index } }));
      now += 700;
    }

    const burst = store.listPendingIngressCompositions().find((record) => record.fragments[0]?.id === "burst-0");
    expect(burst).toEqual(expect.objectContaining({ deadlineAt: 5_800, flushAt: 5_800 }));
    expect(await ingress.flushDue(5_799)).toBe(0);
    expect(await ingress.flushDue(5_800)).toBe(1);
    expect(delivered[0]?.content).toEqual({
      text: "Caption\n\nSecond",
      attachments: [{ url: "https://example.test/first.jpg" }, { url: "https://example.test/second.jpg" }],
    });
    expect(delivered[1]?.content.text).toBe(
      "part-0\n\npart-1\n\npart-2\n\npart-3\n\npart-4\n\npart-5\n\npart-6\n\npart-7",
    );
  });

  test("flushes staged text before an unchanged command and preserves ingress order", async () => {
    const store = new MemoryIngressStore();
    const delivered: InboundMessage[] = [];
    let now = 0;
    const ingress = composer(store, delivered, () => now);
    const command = inbound("command", "  /status", { composition: { kind: "text", order: 2 } });

    await ingress.accept(inbound("text", "Before command", { composition: { kind: "text", order: 1 } }));
    now += 50;
    await ingress.accept(command);
    await ingress.accept(inbound("after", "After command", { composition: { kind: "text", order: 3 } }));

    now += 800;
    await ingress.flushDue();
    expect(delivered).toHaveLength(3);
    expect(delivered.map((message) => message.id)).toEqual(["text", "command", "after"]);
    expect(delivered[1]).toBe(command);
  });

  test("bypasses composition for non-Telegram messages", async () => {
    const store = new MemoryIngressStore();
    const delivered: InboundMessage[] = [];
    const ingress = composer(store, delivered, () => 0);
    const websocket = inbound("socket", "Immediate", {
      address: { transport: "websocket", account: "local", channel: "client" },
      transport: "websocket",
    });

    await ingress.accept(websocket);
    expect(delivered).toEqual([websocket]);
    expect(store.listPendingIngressCompositions()).toEqual([]);
  });

  test("updates an edit only while its fragment remains staged", async () => {
    const store = new MemoryIngressStore();
    const delivered: InboundMessage[] = [];
    let now = 0;
    const ingress = composer(store, delivered, () => now);

    await ingress.accept(inbound("edited", "Original", { composition: { kind: "text", order: 1 } }));
    now = 100;
    await ingress.accept(inbound("edited", "Revised", { composition: { kind: "text", order: 1 }, edited: true }));

    now = 900;
    expect(await ingress.flushDue()).toBe(1);
    expect(delivered[0]?.content.text).toBe("Revised");
    await ingress.accept(inbound("edited", "Late edit", { composition: { kind: "text", order: 1 }, edited: true }));
    expect(delivered).toHaveLength(1);
    expect(store.listPendingIngressCompositions()).toEqual([]);
  });

  test("uses an explicit flush time as the retry schedule base", async () => {
    const store = new MemoryIngressStore();
    const delivered: InboundMessage[] = [];
    let attempts = 0;
    const ingress = new GatewayIngressComposer({
      store,
      now: () => 0,
      logger: { warn: () => {}, error: () => {} },
      deliver: async (message) => {
        attempts += 1;
        if (attempts === 1) throw new Error("unavailable");
        delivered.push(message);
      },
    });

    await ingress.accept(inbound("retry", "Retry", { composition: { kind: "text", order: 1 } }));
    expect(await ingress.flushDue(800)).toBe(0);
    expect(store.listPendingIngressCompositions()).toHaveLength(1);
    expect(await ingress.flushDue(1_599)).toBe(0);
    expect(await ingress.flushDue(1_600)).toBe(1);
    expect(delivered.map((message) => message.id)).toEqual(["retry"]);
    expect(store.listPendingIngressCompositions()).toEqual([]);
  });

  test("does not delete a row or duplicate a delivery while a flush is still resolving", async () => {
    const store = new MemoryIngressStore();
    let now = 0;
    let attempts = 0;
    const delivery = Promise.withResolvers<void>();
    const ingress = new GatewayIngressComposer({
      store,
      now: () => now,
      logger: { warn: () => {}, error: () => {} },
      deliver: async () => {
        attempts += 1;
        await delivery.promise;
      },
    });

    await ingress.accept(inbound("pending", "Hold", { composition: { kind: "text", order: 1 } }));
    now = 800;
    const first = ingress.flushDue();
    const second = ingress.flushDue();
    expect(attempts).toBe(1);
    expect(store.listPendingIngressCompositions()).toHaveLength(1);

    delivery.resolve();
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(attempts).toBe(1);
    expect(store.listPendingIngressCompositions()).toEqual([]);
  });

  test("stops wakeups without deleting staged rows and schedules them after restart", async () => {
    const store = new MemoryIngressStore();
    const initialTimers = new FakeTimers();
    const initialDelivered: InboundMessage[] = [];
    let now = 0;
    const initial = composer(store, initialDelivered, () => now, initialTimers);

    initial.start();
    await initial.accept(inbound("restart", "Persist me", { composition: { kind: "text", order: 1 } }));
    expect(initialTimers.activeDelays()).toEqual([800]);
    initial.stop();
    expect(initialTimers.activeDelays()).toEqual([]);
    expect(store.listPendingIngressCompositions()).toHaveLength(1);

    now = 100;
    const restartTimers = new FakeTimers();
    const restartedDelivered: InboundMessage[] = [];
    const restarted = composer(store, restartedDelivered, () => now, restartTimers);
    restarted.start();
    expect(restartTimers.activeDelays()).toEqual([700]);

    now = 800;
    expect(await restarted.flushDue()).toBe(1);
    expect(restartedDelivered.map((message) => message.id)).toEqual(["restart"]);
    expect(store.listPendingIngressCompositions()).toEqual([]);
  });
});
