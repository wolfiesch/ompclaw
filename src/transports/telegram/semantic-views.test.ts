import { describe, expect, test } from "bun:test";
import type { ConversationAddress, DeliveryContext, OutboundReceipt } from "../../gateway-types";
import type { GatewaySemanticViewStore } from "../../gateway-store";
import type { SemanticView, StoredSemanticView } from "../../gateway-views";
import { modelPageSemanticView, modelProviderSemanticView } from "../../rpc-semantic-views";
import {
  TelegramSemanticViewReconciler,
  decodeTelegramSemanticCallback,
  encodeTelegramSemanticCallback,
  hashTelegramSemanticMessage,
  renderTelegramSemanticView,
  type TelegramSemanticViewOutbound,
} from "./semantic-views";
import type { TelegramMessageOptions } from "./delivery";

const address: ConversationAddress = {
  transport: "telegram",
  account: "primary",
  channel: "42",
  thread: "7",
};
const context: DeliveryContext = {
  principal: { id: "owner", roles: ["operator"] },
  origin: address,
};

function semanticView(version = 1, title = "Gateway status"): SemanticView {
  return {
    schemaVersion: 1,
    id: "home",
    kind: "home",
    version,
    state: "active",
    title,
    summary: "One active session",
    sections: [
      { id: "activity", label: "Activity", text: "Waiting for input", tone: "muted" },
      { id: "health", label: "Health", text: "Connected", tone: "success" },
    ],
    actions: [
      { id: "resume", label: "Resume", style: "primary" },
      { id: "stop", label: "Stop", style: "danger" },
      { id: "later", label: "Later", enabled: false },
    ],
    updatedAt: version * 1_000,
    notification: "silent",
  };
}

class MemorySemanticViewStore implements GatewaySemanticViewStore {
  #records = new Map<string, StoredSemanticView>();

  getSemanticView(address: ConversationAddress, viewId: string): StoredSemanticView | undefined {
    return this.#records.get(this.#key(address, viewId));
  }

  putSemanticView(record: StoredSemanticView): boolean {
    const key = this.#key(record.address, record.view.id);
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      if (record.view.version < existing.view.version) return false;
      if (record.view.version === existing.view.version && record.contentHash !== existing.contentHash)
        throw new Error("semantic view conflict");
      if (JSON.stringify(record) === JSON.stringify(existing)) return false;
    }
    this.#records.set(key, record);
    return true;
  }

  deleteSemanticView(address: ConversationAddress, viewId: string): boolean {
    return this.#records.delete(this.#key(address, viewId));
  }

  listSemanticViews(address?: ConversationAddress): StoredSemanticView[] {
    const records = [...this.#records.values()];
    if (address === undefined) return records;
    return records.filter((record) => this.#key(record.address, record.view.id) === this.#key(address, record.view.id));
  }

  #key(value: ConversationAddress, viewId: string): string {
    return JSON.stringify([value.transport, value.account, value.channel, value.thread ?? null, viewId]);
  }
}

interface OutboundCall {
  readonly method: "send" | "replace";
  readonly text: string;
  readonly targets: readonly OutboundReceipt[];
  readonly spec: TelegramMessageOptions;
}

function outboundHarness(options: { readonly waitForFirstSend?: Promise<void> } = {}): {
  readonly outbound: TelegramSemanticViewOutbound;
  readonly calls: OutboundCall[];
} {
  const calls: OutboundCall[] = [];
  let nextMessageId = 100;
  const outbound: TelegramSemanticViewOutbound = {
    async sendMessages(_target, text, _context, spec) {
      calls.push({ method: "send", text, targets: [], spec });
      if (options.waitForFirstSend !== undefined && calls.length === 1) await options.waitForFirstSend;
      return [{ transport: "telegram", messageId: String(++nextMessageId) }];
    },
    async replaceMessages(_target, targets, text, _context, spec) {
      calls.push({ method: "replace", text, targets, spec });
      return targets;
    },
  };
  return { outbound, calls };
}

describe("Telegram semantic views", () => {
  test("renders stable text, controls, and content hashes", () => {
    const first = renderTelegramSemanticView(semanticView());
    const second = renderTelegramSemanticView(semanticView());

    expect(first).toEqual({
      text: "Gateway status\n\nOne active session\n\nActivity\nWaiting for input\n\nHealth\n✅ Connected",
      plainFallbackText: "Gateway status\n\nOne active session\n\nActivity\nWaiting for input\n\nHealth\n✅ Connected",
      replyMarkup: {
        inline_keyboard: [
          [{ text: "Resume", callback_data: "s1.home.1.resume" }],
          [{ text: "⚠️ Stop", callback_data: "s1.home.1.stop" }],
        ],
      },
      notification: "silent",
    });
    expect(hashTelegramSemanticMessage(first)).toBe(hashTelegramSemanticMessage(second));
    expect(hashTelegramSemanticMessage(first)).toHaveLength(64);
  });

  test("renders the provider hierarchy and a paginated model card", () => {
    const models = [
      { provider: "OpenAI", id: "gpt-5" },
      { provider: "OpenAI", id: "gpt-5-mini" },
      { provider: "Anthropic", id: "claude-sonnet-4" },
    ] as const;
    const provider = renderTelegramSemanticView(
      modelProviderSemanticView({
        models,
        current: { provider: "OpenAI", id: "gpt-5" },
        version: 1,
        updatedAt: 1,
      }),
    );
    const page = renderTelegramSemanticView(
      modelPageSemanticView({
        models,
        current: { provider: "OpenAI", id: "gpt-5" },
        provider: "OpenAI",
        page: 0,
        pageSize: 1,
        version: 2,
        updatedAt: 2,
      }),
    );

    expect(provider.text).toContain("Choose a provider.");
    expect(provider.replyMarkup.inline_keyboard.flat().map((button) => button.text)).toContain("✓ OpenAI · 2");
    expect(page.text).toContain("🤖 OpenAI models 1/2");
    expect(page.text).toContain("gpt-5");
    expect(page.replyMarkup.inline_keyboard.flat().map((button) => button.text)).toContain("Next →");
  });

  test("encodes bounded canonical callbacks and rejects malformed input", () => {
    const callback = encodeTelegramSemanticCallback({
      schemaVersion: 1,
      viewId: "v".repeat(24),
      viewVersion: Number.MAX_SAFE_INTEGER,
      actionId: "a".repeat(24),
    });

    expect(Buffer.byteLength(callback, "utf8")).toBe(64);
    expect(decodeTelegramSemanticCallback(callback)).toEqual({
      schemaVersion: 1,
      viewId: "v".repeat(24),
      viewVersion: Number.MAX_SAFE_INTEGER,
      actionId: "a".repeat(24),
    });
    expect(() => decodeTelegramSemanticCallback("s1.home.01.resume")).toThrow("version");
    expect(() => decodeTelegramSemanticCallback("s1.home.1.not/valid")).toThrow("action id");
    expect(() => decodeTelegramSemanticCallback("s1.home.1.resume.extra")).toThrow("Invalid");
  });

  test("serializes concurrent updates for one address and view", async () => {
    let releaseFirstSend: (() => void) | undefined;
    const firstSend = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    let firstSendStarted: (() => void) | undefined;
    const sendStarted = new Promise<void>((resolve) => {
      firstSendStarted = resolve;
    });
    const { outbound, calls } = outboundHarness({ waitForFirstSend: firstSend });
    const originalSend = outbound.sendMessages;
    const delayedOutbound: TelegramSemanticViewOutbound = {
      ...outbound,
      async sendMessages(...args) {
        firstSendStarted?.();
        return originalSend(...args);
      },
    };
    const store = new MemorySemanticViewStore();
    const reconciler = new TelegramSemanticViewReconciler(store, delayedOutbound, () => 10);

    const initial = reconciler.reconcile(address, "owner", semanticView(1), context);
    await sendStarted;
    const updated = reconciler.reconcile(address, "owner", semanticView(2, "Updated gateway status"), context);
    expect(calls).toHaveLength(1);

    releaseFirstSend?.();
    await expect(Promise.all([initial, updated])).resolves.toEqual([
      [{ messageId: "101", index: 0 }],
      [{ messageId: "101", index: 0 }],
    ]);
    expect(calls.map((call) => call.method)).toEqual(["send", "replace"]);
    expect(store.getSemanticView(address, "home")?.view.version).toBe(2);
  });

  test("does not call Telegram for identical duplicate or stale views", async () => {
    const { outbound, calls } = outboundHarness();
    const store = new MemorySemanticViewStore();
    const reconciler = new TelegramSemanticViewReconciler(store, outbound, () => 10);
    const original = await reconciler.reconcile(address, "owner", semanticView(2), context);
    calls.splice(0);

    await expect(reconciler.reconcile(address, "owner", semanticView(2), context)).resolves.toEqual(original);
    await expect(reconciler.reconcile(address, "owner", semanticView(1, "Stale title"), context)).resolves.toEqual(
      original,
    );
    expect(calls).toEqual([]);
  });

  test("rejects equal-version content conflicts before invoking Telegram", async () => {
    const { outbound, calls } = outboundHarness();
    const store = new MemorySemanticViewStore();
    const reconciler = new TelegramSemanticViewReconciler(store, outbound, () => 10);
    await reconciler.reconcile(address, "owner", semanticView(1), context);
    calls.splice(0);

    await expect(reconciler.reconcile(address, "owner", semanticView(1, "Conflicting title"), context)).rejects.toThrow(
      "conflicting content",
    );
    expect(calls).toEqual([]);
  });

  test("sends an initial view and edits its stored receipt for newer content", async () => {
    const { outbound, calls } = outboundHarness();
    const store = new MemorySemanticViewStore();
    const reconciler = new TelegramSemanticViewReconciler(store, outbound, () => 10);

    await reconciler.reconcile(address, "owner", semanticView(1), context);
    await reconciler.reconcile(address, "owner", semanticView(2, "Updated gateway status"), context);

    expect(calls.map((call) => call.method)).toEqual(["send", "replace"]);
    expect(calls[1]?.targets).toEqual([{ transport: "telegram", messageId: "101" }]);
    expect(store.getSemanticView(address, "home")).toMatchObject({
      view: { version: 2, title: "Updated gateway status" },
      receipts: [{ messageId: "101", index: 0 }],
    });
  });

  test("refreshes current receipts without changing the semantic version", async () => {
    const { outbound, calls } = outboundHarness();
    const store = new MemorySemanticViewStore();
    const reconciler = new TelegramSemanticViewReconciler(store, outbound, () => 10);
    await reconciler.reconcile(address, "owner", semanticView(1), context);
    calls.splice(0);

    await expect(reconciler.refresh(address, "home", context)).resolves.toEqual([{ messageId: "101", index: 0 }]);
    expect(calls.map((call) => call.method)).toEqual(["replace"]);
    expect(store.getSemanticView(address, "home")?.view.version).toBe(1);
  });
});
