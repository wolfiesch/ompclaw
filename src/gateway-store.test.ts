import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GatewayStore, type AppendIngressFragmentInput } from "./gateway-store";
import type { ConversationAddress, InboundMessage } from "./gateway-types";
import type { SemanticViewState, StoredSemanticView } from "./gateway-views";

const directories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "ompclaw-store-"));
  directories.push(directory);
  return join(directory, "ompclaw.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const telegramOwner = { transport: "telegram", account: "default", subject: "42" } as const;
const ownerAddress = { transport: "telegram", account: "default", channel: "42" } as const;

interface SemanticViewRecordOptions {
  readonly address?: ConversationAddress;
  readonly principalId?: string;
  readonly id?: string;
  readonly version?: number;
  readonly state?: SemanticViewState;
  readonly contentHash?: string;
  readonly receipts?: StoredSemanticView["receipts"];
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

function semanticViewRecord(options: SemanticViewRecordOptions = {}): StoredSemanticView {
  const {
    address = ownerAddress,
    principalId = "operator-42",
    id = "task-1",
    version = 0,
    state = "active",
    contentHash = "a".repeat(64),
    receipts = [{ messageId: "100", index: 0 }],
    createdAt = 100,
    updatedAt = 100,
  } = options;
  return {
    principalId,
    address,
    view: {
      schemaVersion: 1,
      id,
      kind: "task",
      version,
      state,
      title: "Deploy semantic views",
      sections: [{ id: "progress", text: "Persisting the view", tone: "warning" }],
      actions: [{ id: "cancel", label: "Cancel", command: "/cancel", style: "danger", enabled: true }],
      updatedAt,
    },
    contentHash,
    receipts,
    createdAt,
    updatedAt,
  };
}

function claimedInbound(id: string, transport = "telegram", account = "default"): InboundMessage {
  return {
    id,
    sentAt: 1,
    identity: { transport, account, subject: "42" },
    address: { transport, account, channel: "42" },
    content: { text: id },
    principal: { id: "operator-42", roles: ["operator"] },
  };
}

interface StagedIngressOptions {
  readonly text?: string;
  readonly attachments?: InboundMessage["content"]["attachments"];
  readonly order?: number;
  readonly edited?: boolean;
  readonly replyContext?: InboundMessage["replyContext"];
}

function stagedIngress(id: string, options: StagedIngressOptions = {}): InboundMessage {
  const { text = id, attachments, order = 1, edited, replyContext } = options;
  return {
    ...claimedInbound(id),
    sentAt: order,
    content: {
      text,
      ...(attachments === undefined ? {} : { attachments }),
    },
    composition: { kind: "text", order },
    ...(edited === true ? { edited: true } : {}),
    ...(replyContext === undefined ? {} : { replyContext }),
  };
}

function appendIngressFragment(
  store: GatewayStore,
  message: InboundMessage,
  overrides: Partial<Omit<AppendIngressFragmentInput, "message">> = {},
) {
  return store.appendIngressFragment({
    compositionId: "composition-1",
    groupKey: "telegram:default:operator-42:42:text",
    receivedAt: 100,
    flushAt: 500,
    deadlineAt: 1_000,
    sortOrder: message.composition?.order ?? 0,
    ...overrides,
    message,
  });
}

describe("GatewayStore", () => {
  test("persists principals, identity mappings, conversation bindings, checkpoints, and pending interactions across restart", () => {
    const path = temporaryDatabase();
    const first = new GatewayStore(path);
    first.upsertPrincipal({ id: "operator-42", roles: ["operator"] });
    first.bindIdentity(telegramOwner, "operator-42");
    first.bindConversation({
      address: ownerAddress,
      ompSessionPath: "/sessions/42.jsonl",
      workspace: { root: "/work/project" },
    });
    first.setCheckpoint("telegram", "update_id", "100");
    first.putPendingInteraction({
      id: "approve-42",
      address: ownerAddress,
      kind: "confirm",
      payload: { question: "Ship it?" },
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_060_000,
    });
    first.close();

    const restarted = new GatewayStore(path);
    expect(restarted.resolvePrincipal(telegramOwner)).toEqual({ id: "operator-42", roles: ["operator"] });
    expect(restarted.getConversationBinding(ownerAddress)).toEqual({
      address: ownerAddress,
      ompSessionPath: "/sessions/42.jsonl",
      workspace: { root: "/work/project" },
    });
    expect(restarted.getCheckpoint("telegram", "update_id")).toBe("100");
    expect(restarted.getPendingInteraction("approve-42")).toEqual({
      id: "approve-42",
      address: ownerAddress,
      kind: "confirm",
      payload: { question: "Ship it?" },
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_060_000,
    });
    restarted.close();
  });

  test("rejects an identity owned by another principal", () => {
    const store = new GatewayStore(temporaryDatabase());
    store.upsertPrincipal({ id: "operator-42", roles: ["operator"] });
    store.upsertPrincipal({ id: "operator-7", roles: ["operator"] });
    store.bindIdentity(telegramOwner, "operator-42");

    expect(() => store.bindIdentity(telegramOwner, "operator-7")).toThrow("different principal");
    store.close();
  });

  test("resolves principals exclusively through stored transport identities", () => {
    const store = new GatewayStore(temporaryDatabase());
    store.upsertPrincipal({ id: "operator-42", roles: ["operator", "admin"] });

    expect(store.resolvePrincipal(telegramOwner)).toBeUndefined();
    store.bindIdentity(telegramOwner, "operator-42");
    expect(store.resolvePrincipal(telegramOwner)).toEqual({ id: "operator-42", roles: ["operator", "admin"] });
    expect(store.resolvePrincipal({ ...telegramOwner, subject: "43" })).toBeUndefined();
    store.close();
  });

  test("looks up bindings by the complete transport, account, channel, and thread address", () => {
    const store = new GatewayStore(temporaryDatabase());
    const threadedAddress = { ...ownerAddress, thread: "topic-9" } as const;
    store.bindConversation({ address: ownerAddress, ompSessionPath: "/sessions/dm.jsonl", workspace: "dm-workspace" });
    store.bindConversation({
      address: threadedAddress,
      ompSessionPath: "/sessions/topic.jsonl",
      workspace: "topic-workspace",
    });

    expect(store.getConversationBinding(ownerAddress)?.ompSessionPath).toBe("/sessions/dm.jsonl");
    expect(store.getConversationBinding(threadedAddress)?.ompSessionPath).toBe("/sessions/topic.jsonl");
    expect(store.getConversationBinding({ ...ownerAddress, account: "other" })).toBeUndefined();
    store.close();
  });

  test("resets ambiguous topic bindings once while preserving the shared session", () => {
    const store = new GatewayStore(temporaryDatabase());
    const topic = { ...ownerAddress, thread: "topic-9" } as const;
    const otherAccountTopic = { ...topic, account: "other" } as const;
    store.bindConversation({ address: ownerAddress, ompSessionPath: "/sessions/shared.jsonl", workspace: "/work" });
    const accidentalRoot = { transport: "websocket", account: "web", channel: "credential" } as const;
    store.bindConversation({
      address: accidentalRoot,
      ompSessionPath: "/sessions/accidental.jsonl",
      workspace: "/work",
    });
    store.bindConversation({ address: topic, ompSessionPath: "/sessions/topic.jsonl", workspace: "/work" });
    store.bindConversation({ address: otherAccountTopic, ompSessionPath: "/sessions/other.jsonl", workspace: "/work" });
    store.setCheckpoint("omp", "session_file", "/sessions/topic.jsonl");
    store.setCheckpoint("omp", "shared_session_file", "/sessions/shared.jsonl");

    expect(store.migrateTelegramTopicSessions("default")).toBe(1);
    expect(store.getConversationBinding(topic)).toBeUndefined();
    expect(store.getConversationBinding(otherAccountTopic)?.ompSessionPath).toBe("/sessions/other.jsonl");
    expect(store.getConversationBinding(accidentalRoot)?.ompSessionPath).toBe("/sessions/shared.jsonl");
    expect(store.getSharedConversationSessionPath()).toBe("/sessions/shared.jsonl");
    expect(store.getCheckpoint("omp", "session_file")).toBe("/sessions/shared.jsonl");
    expect(store.getCheckpoint("omp", "shared_session_file")).toBe("/sessions/shared.jsonl");

    store.bindConversation({ address: topic, ompSessionPath: "/sessions/new-topic.jsonl", workspace: "/work" });
    expect(store.migrateTelegramTopicSessions("default")).toBe(0);
    expect(store.getConversationBinding(topic)?.ompSessionPath).toBe("/sessions/new-topic.jsonl");
    store.close();
  });

  test("overwrites an adapter checkpoint at its composite adapter and key", () => {
    const store = new GatewayStore(temporaryDatabase());
    store.setCheckpoint("telegram", "update_id", "100");
    store.setCheckpoint("telegram", "update_id", "101");
    store.setCheckpoint("discord", "update_id", "4");

    expect(store.getCheckpoint("telegram", "update_id")).toBe("101");
    expect(store.getCheckpoint("discord", "update_id")).toBe("4");
    expect(store.getCheckpoint("telegram", "missing")).toBeUndefined();
    store.close();
  });

  test("migrates the legacy Telegram checkpoint to the account-scoped numeric key", () => {
    const store = new GatewayStore(temporaryDatabase());
    store.setCheckpoint("telegram", "update_id", "314");

    expect(store.migrateTelegramUpdateCheckpoint("default")).toBe(true);
    expect(store.getCheckpoint("telegram", "update_id:default")).toBe(314);
    expect(store.getCheckpoint("telegram", "update_id")).toBeUndefined();
    expect(store.migrateTelegramUpdateCheckpoint("default")).toBe(false);
    store.close();
  });

  test("persists OMP command discovery and caps per-principal command recency", () => {
    const path = temporaryDatabase();
    const first = new GatewayStore(path);
    first.upsertPrincipal({ id: "operator-42", roles: ["operator"] });
    first.replaceOmpAvailableCommands([
      { name: "deploy", description: "Ship the current branch", source: "skill" },
      { name: "/inspect", description: "Inspect a task", source: "builtin" },
      { name: "not a command", description: "Ignored" },
    ]);
    for (let index = 0; index < 21; index += 1) {
      first.recordCommandUsage("operator-42", `skill-${index}`, index);
    }
    first.close();

    const restarted = new GatewayStore(path);
    expect(restarted.listOmpAvailableCommands()).toEqual([
      { name: "deploy", description: "Ship the current branch", source: "skill" },
      { name: "inspect", description: "Inspect a task", source: "builtin" },
    ]);
    const recent = restarted.listRecentCommandUsage("operator-42");
    expect(recent).toHaveLength(20);
    expect(recent[0]).toBe("skill-20");
    expect(recent).not.toContain("skill-0");
    restarted.close();
  });

  test("supports the pending interaction lifecycle", () => {
    const store = new GatewayStore(temporaryDatabase());
    const pending = {
      id: "choose-model",
      address: { ...ownerAddress, thread: "topic-1" },
      kind: "select",
      payload: { options: ["fast", "careful"] },
      createdAt: 1_700_000_000_000,
    } as const;
    store.putPendingInteraction(pending);

    expect(store.getPendingInteraction(pending.id)).toEqual(pending);
    expect(store.deletePendingInteraction(pending.id)).toBe(true);
    expect(store.getPendingInteraction(pending.id)).toBeUndefined();
    expect(store.deletePendingInteraction(pending.id)).toBe(false);
    store.close();
  });

  test("durably claims inbound messages once across restart, account scope, and repeated contenders", () => {
    const path = temporaryDatabase();
    const first = new GatewayStore(path);
    const contender = new GatewayStore(path);

    expect(first.claimInboundMessage(claimedInbound("update-1"), 100, true)).toBe(true);
    expect(contender.claimInboundMessage(claimedInbound("update-1"), 101)).toBe(false);
    const repeatedClaims = Array.from({ length: 16 }, (_, index) =>
      (index % 2 === 0 ? first : contender).claimInboundMessage(claimedInbound("update-2"), 102),
    );
    expect(repeatedClaims.filter(Boolean)).toHaveLength(1);
    expect(first.claimInboundMessage(claimedInbound("update-1", "telegram", "other-account"), 103)).toBe(true);
    expect(first.claimInboundMessage(claimedInbound("update-1", "websocket"), 104)).toBe(true);
    expect(first.listPendingInboundMessages().map(({ message }) => message.id)).toEqual([
      "update-1",
      "update-2",
      "update-1",
      "update-1",
    ]);
    expect(first.listPendingInboundMessages().map(({ scheduled }) => scheduled)).toEqual([true, false, false, false]);
    contender.close();
    first.close();

    const restarted = new GatewayStore(path);
    expect(restarted.claimInboundMessage(claimedInbound("update-1"), 105)).toBe(false);
    expect(restarted.claimInboundMessage(claimedInbound("update-1", "telegram", "other-account"), 106)).toBe(false);
    expect(restarted.claimInboundMessage(claimedInbound("update-1", "websocket"), 107)).toBe(false);
    expect(restarted.claimInboundMessage(claimedInbound("update-3"), 108)).toBe(true);
    expect(restarted.listPendingInboundMessages()).toHaveLength(5);
    expect(restarted.listPendingInboundMessages()[0]?.scheduled).toBe(true);
    expect(restarted.completeInboundMessage("telegram", "default", "update-1")).toBe(true);
    expect(restarted.completeInboundMessage("telegram", "default", "update-1")).toBe(false);
    expect(restarted.listPendingInboundMessages().map(({ message }) => message.id)).toEqual([
      "update-2",
      "update-1",
      "update-1",
      "update-3",
    ]);
    restarted.close();
  });

  test("releases only failed inbound claims so deliveries can retry", () => {
    const store = new GatewayStore(temporaryDatabase());

    expect(store.claimInboundMessage(claimedInbound("failed-handler"), 100)).toBe(true);
    expect(store.claimInboundMessage(claimedInbound("failed-handler", "telegram", "other-account"), 100)).toBe(true);
    expect(store.claimInboundMessage(claimedInbound("failed-handler", "websocket"), 100)).toBe(true);

    expect(store.releaseInboundMessage("telegram", "default", "failed-handler")).toBe(true);
    expect(store.releaseInboundMessage("telegram", "default", "failed-handler")).toBe(false);
    expect(store.claimInboundMessage(claimedInbound("failed-handler"), 101)).toBe(true);
    expect(store.claimInboundMessage(claimedInbound("failed-handler", "telegram", "other-account"), 101)).toBe(false);
    expect(store.claimInboundMessage(claimedInbound("failed-handler", "websocket"), 101)).toBe(false);
    store.close();
  });

  test("prunes only completed inbound messages strictly before the cutoff", () => {
    const store = new GatewayStore(temporaryDatabase());
    expect(store.claimInboundMessage(claimedInbound("pending-old"), 98)).toBe(true);
    expect(store.claimInboundMessage(claimedInbound("before"), 99)).toBe(true);
    expect(store.claimInboundMessage(claimedInbound("at-cutoff"), 100)).toBe(true);
    expect(store.claimInboundMessage(claimedInbound("after"), 101)).toBe(true);
    expect(store.completeInboundMessage("telegram", "default", "before")).toBe(true);
    expect(store.completeInboundMessage("telegram", "default", "at-cutoff")).toBe(true);
    expect(store.completeInboundMessage("telegram", "default", "after")).toBe(true);

    expect(store.pruneInboundMessages(100)).toBe(1);
    expect(store.claimInboundMessage(claimedInbound("before"), 102)).toBe(true);
    expect(store.claimInboundMessage(claimedInbound("pending-old"), 102)).toBe(false);
    expect(store.claimInboundMessage(claimedInbound("at-cutoff"), 103)).toBe(false);
    expect(store.claimInboundMessage(claimedInbound("after"), 104)).toBe(false);
    expect(store.listPendingInboundMessages().map(({ message }) => message.id)).toContain("pending-old");
    expect(store.pruneInboundMessages(101)).toBe(1);
    expect(store.claimInboundMessage(claimedInbound("at-cutoff"), 105)).toBe(true);
    store.close();
  });

  test("lists pending interactions in creation order and filters by the complete address", () => {
    const store = new GatewayStore(temporaryDatabase());
    const threadedAddress = { ...ownerAddress, thread: "topic-1" } as const;
    const otherAccountAddress = { ...ownerAddress, account: "other-account" } as const;
    store.putPendingInteraction({ id: "later", address: ownerAddress, kind: "confirm", payload: null, createdAt: 2 });
    store.putPendingInteraction({ id: "bravo", address: ownerAddress, kind: "confirm", payload: null, createdAt: 1 });
    store.putPendingInteraction({ id: "alpha", address: ownerAddress, kind: "confirm", payload: null, createdAt: 1 });
    store.putPendingInteraction({
      id: "threaded",
      address: threadedAddress,
      kind: "confirm",
      payload: null,
      createdAt: 0,
    });
    store.putPendingInteraction({
      id: "other-account",
      address: otherAccountAddress,
      kind: "confirm",
      payload: null,
      createdAt: 0,
    });

    expect(store.listPendingInteractions().map((interaction) => interaction.id)).toEqual([
      "other-account",
      "threaded",
      "alpha",
      "bravo",
      "later",
    ]);
    expect(store.listPendingInteractions(ownerAddress).map((interaction) => interaction.id)).toEqual([
      "alpha",
      "bravo",
      "later",
    ]);
    expect(store.listPendingInteractions(threadedAddress).map((interaction) => interaction.id)).toEqual(["threaded"]);
    expect(store.listPendingInteractions({ ...ownerAddress, account: "missing" })).toEqual([]);
    store.close();
  });

  test("deletes expired pending interactions through the expiry boundary only", () => {
    const store = new GatewayStore(temporaryDatabase());
    store.putPendingInteraction({
      id: "expired",
      address: ownerAddress,
      kind: "confirm",
      payload: null,
      createdAt: 1,
      expiresAt: 99,
    });
    store.putPendingInteraction({
      id: "at-boundary",
      address: ownerAddress,
      kind: "confirm",
      payload: null,
      createdAt: 1,
      expiresAt: 100,
    });
    store.putPendingInteraction({
      id: "future",
      address: ownerAddress,
      kind: "confirm",
      payload: null,
      createdAt: 1,
      expiresAt: 101,
    });
    store.putPendingInteraction({
      id: "no-expiry",
      address: ownerAddress,
      kind: "confirm",
      payload: null,
      createdAt: 1,
    });

    expect(store.deleteExpiredPendingInteractions(100)).toBe(2);
    expect(store.listPendingInteractions().map((interaction) => interaction.id)).toEqual(["future", "no-expiry"]);
    expect(store.deleteExpiredPendingInteractions(100)).toBe(0);
    store.close();
  });

  test("rejects malformed inbound deduplication and pending query inputs", () => {
    const store = new GatewayStore(temporaryDatabase());

    expect(() => store.claimInboundMessage(null as never, 1)).toThrow("inbound message must be an object");
    expect(() =>
      store.claimInboundMessage(
        {
          ...claimedInbound("update-1"),
          address: { transport: "", account: "default", channel: "42" },
        },
        1,
      ),
    ).toThrow("address transport");
    expect(() =>
      store.claimInboundMessage(
        {
          ...claimedInbound("update-1"),
          identity: { transport: "telegram", account: "", subject: "42" },
          address: { transport: "telegram", account: "", channel: "42" },
        },
        1,
      ),
    ).toThrow("identity account");
    expect(() => store.claimInboundMessage({ ...claimedInbound("update-1"), id: "" }, 1)).toThrow("inbound message id");
    expect(() => store.claimInboundMessage(claimedInbound("update-1"), 1.5)).toThrow("receivedAt");
    expect(() => store.pruneInboundMessages(Number.MAX_SAFE_INTEGER + 1)).toThrow("prune before");
    expect(() => store.releaseInboundMessage("", "default", "update-1")).toThrow("inbound message transport");
    expect(() => store.releaseInboundMessage(null as never, "default", "update-1")).toThrow(
      "inbound message transport",
    );
    expect(() => store.releaseInboundMessage("telegram", "", "update-1")).toThrow("inbound message account");
    expect(() => store.releaseInboundMessage("telegram", "default", "")).toThrow("inbound message id");
    expect(() => store.listPendingInteractions({ ...ownerAddress, channel: "" })).toThrow(
      "conversation address channel",
    );
    expect(() => store.deleteExpiredPendingInteractions(Number.NaN)).toThrow("expiry now");
    store.close();
  });

  test("rejects corrupt stored JSON instead of returning unvalidated state", () => {
    const path = temporaryDatabase();
    const store = new GatewayStore(path);
    store.upsertPrincipal({ id: "operator-42", roles: ["operator"] });
    store.bindIdentity(telegramOwner, "operator-42");
    store.putPendingInteraction({
      id: "corrupt-pending",
      address: ownerAddress,
      kind: "confirm",
      payload: null,
      createdAt: 1,
    });
    store.close();

    const database = new Database(path);
    database.exec("UPDATE principals SET roles_json = '{'; UPDATE pending_ui_interactions SET payload_json = '{'");
    database.close();

    const reopened = new GatewayStore(path);
    expect(() => reopened.resolvePrincipal(telegramOwner)).toThrow("corrupt JSON");
    expect(() => reopened.listPendingInteractions()).toThrow("corrupt JSON");
    reopened.close();
  });

  test("persists and scopes durable scheduled jobs across restart", () => {
    const path = temporaryDatabase();
    const first = new GatewayStore(path);
    first.upsertPrincipal({ id: "operator-42", roles: ["operator"] });
    first.upsertPrincipal({ id: "operator-7", roles: ["operator"] });
    first.createScheduledJob({
      id: "job-42",
      principalId: "operator-42",
      identity: telegramOwner,
      address: ownerAddress,
      name: "daily summary",
      prompt: "Summarize the latest work.",
      schedule: { kind: "cron", expression: "0 9 * * *", timezone: "America/Los_Angeles" },
      enabled: true,
      nextRunAt: 1_800_000_000_000,
      attemptCount: 0,
      successCount: 0,
      failureCount: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    expect(first.listDueScheduledJobs(1_799_999_999_999)).toEqual([]);
    first.close();

    const restarted = new GatewayStore(path);
    expect(restarted.getScheduledJob("job-42", "operator-7")).toBeUndefined();
    expect(restarted.listScheduledJobs("operator-42")).toEqual([
      expect.objectContaining({
        id: "job-42",
        identity: telegramOwner,
        address: ownerAddress,
        schedule: { kind: "cron", expression: "0 9 * * *", timezone: "America/Los_Angeles" },
      }),
    ]);
    expect(restarted.listDueScheduledJobs(1_800_000_000_000).map((job) => job.id)).toEqual(["job-42"]);
    const job = restarted.getScheduledJob("job-42", "operator-42")!;
    expect(
      restarted.updateScheduledJob({
        ...job,
        enabled: false,
        successCount: 1,
        lastRunAt: 1_800_000_000_000,
        updatedAt: 1_800_000_000_001,
      }),
    ).toBe(true);
    expect(restarted.listDueScheduledJobs(1_900_000_000_000)).toEqual([]);
    expect(restarted.deleteScheduledJob("job-42", "operator-7")).toBe(false);
    expect(restarted.deleteScheduledJob("job-42", "operator-42")).toBe(true);
    restarted.close();
  });

  test("persists task lifecycle transitions and interrupts unfinished turns after restart", () => {
    const path = temporaryDatabase();
    const first = new GatewayStore(path);
    first.upsertPrincipal({ id: "operator-42", roles: ["operator"] });
    first.putTurnLifecycle({
      id: "turn-running",
      principalId: "operator-42",
      address: ownerAddress,
      prompt: "Inspect the deployment",
      state: "running",
      currentTool: "bash",
      createdAt: 100,
      updatedAt: 200,
    });
    first.appendTurnTimelineEvent({
      turnId: "turn-running",
      at: 150,
      kind: "queued",
      text: "Task received",
    });
    first.appendTurnTimelineEvent({
      turnId: "turn-running",
      at: 200,
      kind: "tool_started",
      text: "Running tests",
    });
    first.putTurnLifecycle({
      id: "turn-complete",
      principalId: "operator-42",
      address: { ...ownerAddress, thread: "topic-1" },
      prompt: "Summarize the release",
      state: "completed",
      createdAt: 300,
      updatedAt: 400,
      finishedAt: 400,
    });
    first.putTurnOutcome({
      turnId: "turn-complete",
      principalId: "operator-42",
      address: { ...ownerAddress, thread: "topic-1" },
      state: "completed",
      text: "Release summary",
      createdAt: 400,
      attemptCount: 0,
      replyTo: { transport: "telegram", messageId: "request-42" },
    });
    first.close();

    const restarted = new GatewayStore(path);
    expect(restarted.interruptActiveTurns(500)).toBe(1);
    expect(restarted.listTurnLifecycles(ownerAddress)).toEqual([
      {
        id: "turn-running",
        principalId: "operator-42",
        address: ownerAddress,
        prompt: "Inspect the deployment",
        state: "interrupted",
        createdAt: 100,
        updatedAt: 500,
        finishedAt: 500,
      },
    ]);
    expect(restarted.listTurnTimelineEvents("turn-running")).toEqual([
      { turnId: "turn-running", at: 150, kind: "queued", text: "Task received" },
      { turnId: "turn-running", at: 200, kind: "tool_started", text: "Running tests" },
    ]);
    expect(restarted.listTurnLifecycles({ ...ownerAddress, thread: "topic-1" })).toEqual([
      expect.objectContaining({ id: "turn-complete", state: "completed" }),
    ]);
    expect(restarted.listPendingTurnOutcomes()).toEqual([
      {
        turnId: "turn-complete",
        principalId: "operator-42",
        address: { ...ownerAddress, thread: "topic-1" },
        state: "completed",
        text: "Release summary",
        createdAt: 400,
        attemptCount: 0,
        replyTo: { transport: "telegram", messageId: "request-42" },
      },
    ]);
    restarted.recordTurnOutcomeAttempt("turn-complete", 550);
    expect(restarted.markTurnOutcomeDelivered("turn-complete", 600)).toBe(true);
    expect(restarted.getTurnOutcome("turn-complete")).toMatchObject({
      attemptCount: 1,
      lastAttemptAt: 550,
      deliveredAt: 600,
    });
    expect(restarted.listPendingTurnOutcomes()).toEqual([]);
    restarted.close();
  });

  test("imports legacy Telegram state once without ingesting a token or changing the source files", () => {
    const databasePath = temporaryDatabase();
    const directory = dirname(databasePath);
    const accessPath = join(directory, "access.json");
    const rpcStatePath = join(directory, "rpc-state.json");
    const sourceToken = "must-never-enter-the-store";
    writeFileSync(accessPath, JSON.stringify({ allowFrom: ["42"], token: sourceToken }));
    writeFileSync(rpcStatePath, JSON.stringify({ sessionFile: "/sessions/exact.jsonl", lastUpdateId: 314 }));
    const accessBefore = readFileSync(accessPath, "utf8");
    const rpcBefore = readFileSync(rpcStatePath, "utf8");
    const workspace = { root: "/workspace/exact", label: "legacy" } as const;
    const store = new GatewayStore(databasePath);

    expect(store.importLegacyTelegramState({ accessPath, rpcStatePath, workspace })).toEqual({
      imported: true,
      principal: { id: "telegram:default:42", roles: ["operator"] },
      binding: {
        address: ownerAddress,
        ompSessionPath: "/sessions/exact.jsonl",
        workspace,
      },
      checkpointImported: true,
    });
    expect(store.resolvePrincipal(telegramOwner)).toEqual({ id: "telegram:default:42", roles: ["operator"] });
    expect(store.getConversationBinding(ownerAddress)).toEqual({
      address: ownerAddress,
      ompSessionPath: "/sessions/exact.jsonl",
      workspace,
    });
    expect(store.getCheckpoint("telegram", "update_id:default")).toBe(314);
    expect(readFileSync(accessPath, "utf8")).toBe(accessBefore);
    expect(readFileSync(rpcStatePath, "utf8")).toBe(rpcBefore);

    rmSync(accessPath);
    rmSync(rpcStatePath);
    expect(store.importLegacyTelegramState({ accessPath, rpcStatePath, workspace })).toEqual({
      imported: false,
      checkpointImported: false,
    });
    store.close();

    const database = new Database(databasePath);
    const storedRows = database
      .query(
        "SELECT roles_json, workspace_json, value_json FROM principals LEFT JOIN conversation_bindings ON 1 = 1 LEFT JOIN adapter_checkpoints ON 1 = 1",
      )
      .all();
    expect(JSON.stringify(storedRows)).not.toContain(sourceToken);
    database.close();
  });

  test("persists pending ingress compositions with complete messages across restart", () => {
    const path = temporaryDatabase();
    const first = new GatewayStore(path);
    const fragment = stagedIngress("fragment-restart", {
      text: "Photo caption",
      order: 7,
      attachments: [{ url: "file:///private/photo.jpg", name: "photo.jpg", mediaType: "image/jpeg" }],
      replyContext: { messageId: "reply-7", author: "@alice", text: "Please inspect this", isBot: false },
    });
    const saved = appendIngressFragment(first, fragment, {
      compositionId: "composition-restart",
      groupKey: "telegram:default:operator-42:42:text:reply-7",
      receivedAt: 100,
      flushAt: 900,
      deadlineAt: 5_000,
      sortOrder: 7,
    });
    expect(saved.fragments).toEqual([fragment]);
    first.close();

    const restarted = new GatewayStore(path);
    expect(restarted.listPendingIngressCompositions()).toEqual([saved]);
    expect(restarted.getIngressComposition("composition-restart")).toEqual(saved);
    expect(restarted.getIngressCompositionByGroupKey("telegram:default:operator-42:42:text:reply-7")).toEqual(saved);
    expect(restarted.getIngressCompositionByFragment(fragment.id, fragment.principal.id, fragment.address)).toEqual(
      saved,
    );
    expect(
      restarted.getIngressCompositionByFragment(fragment.id, fragment.principal.id, {
        ...fragment.address,
        channel: "other",
      }),
    ).toBeUndefined();
    restarted.close();
  });

  test("leaves non-edit ingress duplicates unchanged", () => {
    const store = new GatewayStore(temporaryDatabase());
    const fragment = stagedIngress("fragment-duplicate", { text: "original", order: 2 });
    const saved = appendIngressFragment(store, fragment, {
      compositionId: "composition-original",
      groupKey: "telegram:default:operator-42:42:text",
      receivedAt: 100,
      flushAt: 500,
      deadlineAt: 1_000,
      sortOrder: 2,
    });

    expect(
      appendIngressFragment(store, fragment, {
        compositionId: "composition-ignored",
        receivedAt: 300,
        flushAt: 900,
        deadlineAt: 2_000,
        sortOrder: 99,
      }),
    ).toEqual(saved);
    expect(store.listPendingIngressCompositions()).toEqual([saved]);
    store.close();
  });

  test("upserts only the matching staged ingress fragment when it is edited", () => {
    const store = new GatewayStore(temporaryDatabase());
    const firstFragment = stagedIngress("fragment-one", { text: "before edit", order: 2 });
    const secondFragment = stagedIngress("fragment-two", { text: "unchanged", order: 3 });
    appendIngressFragment(store, firstFragment, { receivedAt: 100, flushAt: 500, deadlineAt: 1_000, sortOrder: 2 });
    appendIngressFragment(store, secondFragment, { receivedAt: 200, flushAt: 600, deadlineAt: 1_000, sortOrder: 3 });

    const editedFragment = stagedIngress("fragment-one", { text: "after edit", order: 1, edited: true });
    const updated = appendIngressFragment(store, editedFragment, {
      receivedAt: 300,
      flushAt: 700,
      deadlineAt: 2_000,
      sortOrder: 1,
    });

    expect(updated).toMatchObject({
      id: "composition-1",
      createdAt: 100,
      updatedAt: 300,
      flushAt: 700,
      deadlineAt: 1_000,
    });
    expect(updated.fragments).toEqual([editedFragment, secondFragment]);
    store.close();
  });

  test("orders ingress fragments by sort order and stable fragment id", () => {
    const store = new GatewayStore(temporaryDatabase());
    appendIngressFragment(store, stagedIngress("fragment-b", { order: 20 }), { sortOrder: 20 });
    appendIngressFragment(store, stagedIngress("fragment-c", { order: 10 }), { sortOrder: 10 });
    const record = appendIngressFragment(store, stagedIngress("fragment-a", { order: 10 }), { sortOrder: 10 });

    expect(record.fragments.map((fragment) => fragment.id)).toEqual(["fragment-a", "fragment-c", "fragment-b"]);
    store.close();
  });

  test("preserves the first ingress deadline and clamps later flushes to it", () => {
    const store = new GatewayStore(temporaryDatabase());
    const first = appendIngressFragment(store, stagedIngress("fragment-first", { order: 1 }), {
      receivedAt: 100,
      flushAt: 500,
      deadlineAt: 500,
      sortOrder: 1,
    });
    const second = appendIngressFragment(store, stagedIngress("fragment-second", { order: 2 }), {
      receivedAt: 200,
      flushAt: 800,
      deadlineAt: 2_000,
      sortOrder: 2,
    });

    expect(first).toMatchObject({ flushAt: 500, deadlineAt: 500 });
    expect(second).toMatchObject({ flushAt: 500, deadlineAt: 500 });
    store.close();
  });

  test("cascades ingress fragments when deleting a composition", () => {
    const path = temporaryDatabase();
    const store = new GatewayStore(path);
    appendIngressFragment(store, stagedIngress("fragment-cascade"));

    expect(store.deleteIngressComposition("composition-1")).toBe(true);
    expect(store.deleteIngressComposition("composition-1")).toBe(false);
    store.close();

    const database = new Database(path);
    const row = database.query("SELECT COUNT(*) AS count FROM ingress_fragments").get() as { count: number };
    expect(row.count).toBe(0);
    database.close();
  });

  test("rejects negative ingress ordering values", () => {
    const store = new GatewayStore(temporaryDatabase());
    const negativeComposition = stagedIngress("negative-composition");

    expect(() =>
      appendIngressFragment(store, {
        ...negativeComposition,
        composition: { kind: "text", order: -1 },
      }),
    ).toThrow("inbound message composition order must be a nonnegative integer");
    expect(() =>
      appendIngressFragment(store, stagedIngress("negative-sort"), {
        sortOrder: -1,
      }),
    ).toThrow("ingress fragment sort order must be a nonnegative integer");
    store.close();
  });
  test("rejects ingress flush timestamps outside receipt and deadline", () => {
    const store = new GatewayStore(temporaryDatabase());
    expect(() =>
      appendIngressFragment(store, stagedIngress("flush-before-receipt"), {
        receivedAt: 100,
        flushAt: 99,
        deadlineAt: 1_000,
      }),
    ).toThrow("ingress composition flush timestamp must be between receipt and deadline");
    expect(() =>
      appendIngressFragment(store, stagedIngress("flush-after-deadline"), {
        receivedAt: 100,
        flushAt: 1_001,
        deadlineAt: 1_000,
      }),
    ).toThrow("ingress composition flush timestamp must be between receipt and deadline");
    store.close();
  });

  test("rejects corrupt persisted ingress fragments", () => {
    const path = temporaryDatabase();
    const first = new GatewayStore(path);
    const fragment = stagedIngress("fragment-corrupt", {
      replyContext: { messageId: "reply-1", author: "@alice", text: "trusted only as content", isBot: false },
    });
    appendIngressFragment(first, fragment);
    first.close();

    const database = new Database(path);
    database
      .query("UPDATE ingress_fragments SET payload_json = ? WHERE composition_id = ? AND fragment_id = ?")
      .run(
        JSON.stringify({ ...fragment, composition: { kind: "text", order: "not-an-integer" } }),
        "composition-1",
        "fragment-corrupt",
      );
    database.close();

    const restarted = new GatewayStore(path);
    expect(() => restarted.listPendingIngressCompositions()).toThrow(
      "inbound message composition order must be a nonnegative integer",
    );
    restarted.close();
  });

  test("persists semantic views across restart with exact optional fields", () => {
    const path = temporaryDatabase();
    const first = new GatewayStore(path);
    first.upsertPrincipal({ id: "operator-42", roles: ["operator"] });
    const record = semanticViewRecord({ receipts: [] });
    const recordWithUndefinedOptionals: StoredSemanticView = {
      ...record,
      view: { ...record.view, summary: undefined, notification: undefined },
    };

    expect(first.putSemanticView(recordWithUndefinedOptionals)).toBe(true);
    first.close();

    const restarted = new GatewayStore(path);
    expect(restarted.getSemanticView(ownerAddress, "task-1")).toEqual(record);
    restarted.close();
  });

  test("isolates semantic views by the complete conversation address and lists deterministically", () => {
    const store = new GatewayStore(temporaryDatabase());
    const topic = { ...ownerAddress, thread: "topic-1" } as const;
    store.upsertPrincipal({ id: "operator-42", roles: ["operator"] });
    store.upsertPrincipal({ id: "operator-7", roles: ["operator"] });

    expect(store.putSemanticView(semanticViewRecord({ id: "task-1", createdAt: 100 }))).toBe(true);
    expect(
      store.putSemanticView(
        semanticViewRecord({
          id: "task-1",
          address: topic,
          principalId: "operator-7",
          contentHash: "b".repeat(64),
          createdAt: 101,
          updatedAt: 101,
        }),
      ),
    ).toBe(true);

    expect(store.getSemanticView(topic, "task-1")?.principalId).toBe("operator-7");
    expect(store.getSemanticView({ ...ownerAddress, account: "other" }, "task-1")).toBeUndefined();
    expect(store.listSemanticViews(ownerAddress).map((record) => record.address.thread)).toEqual([undefined]);
    expect(store.listSemanticViews(topic).map((record) => record.principalId)).toEqual(["operator-7"]);
    expect(store.listSemanticViews().map((record) => record.address.thread)).toEqual([undefined, "topic-1"]);
    store.close();
  });

  test("enforces monotonic semantic-view versions and equal-version hash conflicts", () => {
    const store = new GatewayStore(temporaryDatabase());
    store.upsertPrincipal({ id: "operator-42", roles: ["operator"] });
    const initial = semanticViewRecord();

    expect(store.putSemanticView(initial)).toBe(true);
    expect(store.putSemanticView(initial)).toBe(false);
    expect(store.putSemanticView(semanticViewRecord({ version: 1, updatedAt: 101 }))).toBe(true);
    expect(
      store.putSemanticView(
        semanticViewRecord({
          version: 1,
          receipts: [{ messageId: "101", index: 0 }],
          updatedAt: 102,
        }),
      ),
    ).toBe(true);
    expect(store.getSemanticView(ownerAddress, "task-1")?.receipts).toEqual([{ messageId: "101", index: 0 }]);
    expect(store.putSemanticView(initial)).toBe(false);
    expect(() =>
      store.putSemanticView(
        semanticViewRecord({
          version: 1,
          contentHash: "b".repeat(64),
          updatedAt: 101,
        }),
      ),
    ).toThrow("conflicting content at the same version");
    expect(store.getSemanticView(ownerAddress, "task-1")?.view.version).toBe(1);
    store.close();
  });

  test("rejects invalid semantic records and address ownership changes", () => {
    const store = new GatewayStore(temporaryDatabase());
    store.upsertPrincipal({ id: "operator-42", roles: ["operator"] });
    store.upsertPrincipal({ id: "operator-7", roles: ["operator"] });

    expect(() =>
      store.putSemanticView(
        semanticViewRecord({
          id: "not/a-safe-id",
        }),
      ),
    ).toThrow("opaque identifier");
    expect(() =>
      store.putSemanticView(
        semanticViewRecord({
          contentHash: "not-a-digest",
        }),
      ),
    ).toThrow("SHA-256");
    expect(() => store.putSemanticView(semanticViewRecord({ principalId: "missing-principal" }))).toThrow(
      "principal does not exist",
    );

    expect(store.putSemanticView(semanticViewRecord())).toBe(true);
    expect(() => store.putSemanticView(semanticViewRecord({ principalId: "operator-7" }))).toThrow(
      "owned by a different principal",
    );
    store.close();
  });

  test("rejects corrupt stored semantic view JSON", () => {
    const path = temporaryDatabase();
    const first = new GatewayStore(path);
    first.upsertPrincipal({ id: "operator-42", roles: ["operator"] });
    first.putSemanticView(semanticViewRecord());
    first.close();

    const database = new Database(path);
    database
      .query(
        `UPDATE semantic_views
         SET view_json = ?
         WHERE transport = ? AND account = ? AND channel = ? AND thread = ? AND view_id = ?`,
      )
      .run("{", ownerAddress.transport, ownerAddress.account, ownerAddress.channel, "", "task-1");
    database.close();

    const restarted = new GatewayStore(path);
    expect(() => restarted.getSemanticView(ownerAddress, "task-1")).toThrow(
      "corrupt JSON stored for semantic view definition",
    );
    restarted.close();
  });

  test("deletes semantic views only at their addressed key", () => {
    const store = new GatewayStore(temporaryDatabase());
    const topic = { ...ownerAddress, thread: "topic-1" } as const;
    store.upsertPrincipal({ id: "operator-42", roles: ["operator"] });
    store.putSemanticView(semanticViewRecord());
    store.putSemanticView(
      semanticViewRecord({
        address: topic,
        contentHash: "b".repeat(64),
        createdAt: 101,
        updatedAt: 101,
      }),
    );

    expect(store.deleteSemanticView(ownerAddress, "task-1")).toBe(true);
    expect(store.deleteSemanticView(ownerAddress, "task-1")).toBe(false);
    expect(store.getSemanticView(topic, "task-1")).toBeDefined();
    expect(store.listSemanticViews().map((record) => record.address.thread)).toEqual(["topic-1"]);
    store.close();
  });
  test("looks up semantic views by receipt message id within an address", () => {
    const store = new GatewayStore(temporaryDatabase());
    const topic = { ...ownerAddress, thread: "topic-1" } as const;
    store.upsertPrincipal({ id: "operator-42", roles: ["operator"] });
    store.putSemanticView(
      semanticViewRecord({
        id: "task-1",
        receipts: [{ messageId: "msg-101", index: 0 }],
      }),
    );
    store.putSemanticView(
      semanticViewRecord({
        id: "task-2",
        address: topic,
        receipts: [{ messageId: "msg-102", index: 0 }],
      }),
    );

    expect(store.getSemanticViewByReceipt(ownerAddress, "msg-101")?.view.id).toBe("task-1");
    expect(store.getSemanticViewByReceipt(ownerAddress, "msg-102")).toBeUndefined();
    expect(store.getSemanticViewByReceipt(topic, "msg-102")?.view.id).toBe("task-2");
    expect(store.getSemanticViewByReceipt(ownerAddress, "missing")).toBeUndefined();
    store.close();
  });

  test("initializes SQLite with WAL mode and enforces foreign keys", () => {
    const path = temporaryDatabase();
    const store = new GatewayStore(path);
    const database = new Database(path);
    const journalMode = database.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(journalMode.journal_mode.toLowerCase()).toBe("wal");
    database.close();
    expect(() => store.bindIdentity(telegramOwner, "nonexistent-principal")).toThrow(/FOREIGN KEY/i);
    store.close();
  });
});
