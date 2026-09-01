import { describe, expect, test } from "bun:test";
import {
  normalizeSemanticView,
  normalizeStoredSemanticView,
  validateSemanticView,
  type SemanticView,
  type StoredSemanticView,
} from "./gateway-views";

function semanticView(overrides: Partial<SemanticView> = {}): SemanticView {
  return {
    schemaVersion: 1,
    id: "home-1",
    kind: "home",
    version: 0,
    state: "active",
    title: "OmpClaw",
    sections: [{ id: "status", text: "Ready" }],
    actions: [{ id: "refresh", label: "Refresh" }],
    updatedAt: 100,
    ...overrides,
  };
}

function storedSemanticView(overrides: Partial<StoredSemanticView> = {}): StoredSemanticView {
  return {
    principalId: "operator-42",
    address: { transport: "telegram", account: "default", channel: "42" },
    view: semanticView(),
    contentHash: "a".repeat(64),
    receipts: [{ messageId: "100", index: 0 }],
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

describe("semantic views", () => {
  test("canonicalizes optional fields without dropping explicit false action state", () => {
    const normalized = normalizeSemanticView({
      ...semanticView({
        summary: undefined,
        sections: [{ id: "status", label: undefined, text: "Ready", tone: "success" }],
        actions: [{ id: "refresh", label: "Refresh", command: undefined, enabled: false }],
        notification: undefined,
      }),
      ignored: "not persisted",
    });

    expect(normalized).toEqual({
      schemaVersion: 1,
      id: "home-1",
      kind: "home",
      version: 0,
      state: "active",
      title: "OmpClaw",
      sections: [{ id: "status", text: "Ready", tone: "success" }],
      actions: [{ id: "refresh", label: "Refresh", enabled: false }],
      updatedAt: 100,
    });
    expect("summary" in normalized).toBe(false);
    expect("label" in normalized.sections[0]!).toBe(false);
    expect("command" in normalized.actions[0]!).toBe(false);
    expect("notification" in normalized).toBe(false);
  });

  test("rejects unsafe identifiers, invalid versions, and ambiguous actions", () => {
    expect(() => validateSemanticView(semanticView({ id: "home view" }))).toThrow("opaque identifier");
    expect(() => validateSemanticView(semanticView({ version: -1 }))).toThrow("safe nonnegative integer");
    expect(() =>
      validateSemanticView(
        semanticView({
          actions: [
            { id: "refresh", label: "Refresh" },
            { id: "refresh", label: "Refresh again" },
          ],
        }),
      ),
    ).toThrow("action ids must be unique");
  });

  test("rejects malformed durable records before persistence", () => {
    expect(() =>
      normalizeStoredSemanticView(
        storedSemanticView({
          receipts: [
            { messageId: "100", index: 0 },
            { messageId: "101", index: 0 },
          ],
        }),
      ),
    ).toThrow("receipt indexes must be unique");
    expect(() => normalizeStoredSemanticView(storedSemanticView({ contentHash: "not-a-digest" }))).toThrow("SHA-256");
    expect(() => normalizeStoredSemanticView(storedSemanticView({ createdAt: 101, updatedAt: 100 }))).toThrow(
      "updatedAt must not precede createdAt",
    );
  });
});
