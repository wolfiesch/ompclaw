import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GatewayStore } from "./gateway-store";

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

describe("GatewayStore", () => {
  test("persists principals, identity mappings, conversation bindings, checkpoints, and pending interactions across restart", () => {
    const path = temporaryDatabase();
    const first = new GatewayStore(path);
    first.upsertPrincipal({ id: "operator-42", roles: ["operator"] });
    first.bindIdentity(telegramOwner, "operator-42");
    first.bindConversation({ address: ownerAddress, ompSessionPath: "/sessions/42.jsonl", workspace: { root: "/work/project" } });
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
    store.bindConversation({ address: threadedAddress, ompSessionPath: "/sessions/topic.jsonl", workspace: "topic-workspace" });

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
    store.bindConversation({ address: accidentalRoot, ompSessionPath: "/sessions/accidental.jsonl", workspace: "/work" });
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

    expect(first.claimInboundMessage("telegram", "default", "update-1", 100)).toBe(true);
    expect(contender.claimInboundMessage("telegram", "default", "update-1", 101)).toBe(false);
    const repeatedClaims = Array.from({ length: 16 }, (_, index) =>
      (index % 2 === 0 ? first : contender).claimInboundMessage("telegram", "default", "update-2", 102),
    );
    expect(repeatedClaims.filter(Boolean)).toHaveLength(1);
    expect(first.claimInboundMessage("telegram", "other-account", "update-1", 103)).toBe(true);
    expect(first.claimInboundMessage("websocket", "default", "update-1", 104)).toBe(true);
    contender.close();
    first.close();

    const restarted = new GatewayStore(path);
    expect(restarted.claimInboundMessage("telegram", "default", "update-1", 105)).toBe(false);
    expect(restarted.claimInboundMessage("telegram", "other-account", "update-1", 106)).toBe(false);
    expect(restarted.claimInboundMessage("websocket", "default", "update-1", 107)).toBe(false);
    expect(restarted.claimInboundMessage("telegram", "default", "update-3", 108)).toBe(true);
    restarted.close();
  });

  test("releases only failed inbound claims so deliveries can retry", () => {
    const store = new GatewayStore(temporaryDatabase());

    expect(store.claimInboundMessage("telegram", "default", "failed-handler", 100)).toBe(true);
    expect(store.claimInboundMessage("telegram", "other-account", "failed-handler", 100)).toBe(true);
    expect(store.claimInboundMessage("websocket", "default", "failed-handler", 100)).toBe(true);

    expect(store.releaseInboundMessage("telegram", "default", "failed-handler")).toBe(true);
    expect(store.releaseInboundMessage("telegram", "default", "failed-handler")).toBe(false);
    expect(store.claimInboundMessage("telegram", "default", "failed-handler", 101)).toBe(true);
    expect(store.claimInboundMessage("telegram", "other-account", "failed-handler", 101)).toBe(false);
    expect(store.claimInboundMessage("websocket", "default", "failed-handler", 101)).toBe(false);
    store.close();
  });

  test("prunes only inbound messages received strictly before the cutoff", () => {
    const store = new GatewayStore(temporaryDatabase());
    expect(store.claimInboundMessage("telegram", "default", "before", 99)).toBe(true);
    expect(store.claimInboundMessage("telegram", "default", "at-cutoff", 100)).toBe(true);
    expect(store.claimInboundMessage("telegram", "default", "after", 101)).toBe(true);

    expect(store.pruneInboundMessages(100)).toBe(1);
    expect(store.claimInboundMessage("telegram", "default", "before", 102)).toBe(true);
    expect(store.claimInboundMessage("telegram", "default", "at-cutoff", 103)).toBe(false);
    expect(store.claimInboundMessage("telegram", "default", "after", 104)).toBe(false);
    expect(store.pruneInboundMessages(101)).toBe(1);
    expect(store.claimInboundMessage("telegram", "default", "at-cutoff", 105)).toBe(true);
    store.close();
  });

  test("lists pending interactions in creation order and filters by the complete address", () => {
    const store = new GatewayStore(temporaryDatabase());
    const threadedAddress = { ...ownerAddress, thread: "topic-1" } as const;
    const otherAccountAddress = { ...ownerAddress, account: "other-account" } as const;
    store.putPendingInteraction({ id: "later", address: ownerAddress, kind: "confirm", payload: null, createdAt: 2 });
    store.putPendingInteraction({ id: "bravo", address: ownerAddress, kind: "confirm", payload: null, createdAt: 1 });
    store.putPendingInteraction({ id: "alpha", address: ownerAddress, kind: "confirm", payload: null, createdAt: 1 });
    store.putPendingInteraction({ id: "threaded", address: threadedAddress, kind: "confirm", payload: null, createdAt: 0 });
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
    expect(store.listPendingInteractions(ownerAddress).map((interaction) => interaction.id)).toEqual(["alpha", "bravo", "later"]);
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

    expect(() => store.claimInboundMessage("", "default", "update-1", 1)).toThrow("inbound message transport");
    expect(() => store.claimInboundMessage(null as never, "default", "update-1", 1)).toThrow("inbound message transport");
    expect(() => store.claimInboundMessage("telegram", "", "update-1", 1)).toThrow("inbound message account");
    expect(() => store.claimInboundMessage("telegram", "default", "", 1)).toThrow("inbound message id");
    expect(() => store.claimInboundMessage("telegram", "default", "update-1", 1.5)).toThrow("receivedAt");
    expect(() => store.pruneInboundMessages(Number.MAX_SAFE_INTEGER + 1)).toThrow("prune before");
    expect(() => store.releaseInboundMessage("", "default", "update-1")).toThrow("inbound message transport");
    expect(() => store.releaseInboundMessage(null as never, "default", "update-1")).toThrow("inbound message transport");
    expect(() => store.releaseInboundMessage("telegram", "", "update-1")).toThrow("inbound message account");
    expect(() => store.releaseInboundMessage("telegram", "default", "")).toThrow("inbound message id");
    expect(() => store.listPendingInteractions({ ...ownerAddress, channel: "" })).toThrow("conversation address channel");
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
    expect(restarted.updateScheduledJob({
      ...job,
      enabled: false,
      successCount: 1,
      lastRunAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_001,
    })).toBe(true);
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
    expect(restarted.listTurnLifecycles({ ...ownerAddress, thread: "topic-1" })).toEqual([
      expect.objectContaining({ id: "turn-complete", state: "completed" }),
    ]);
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
    expect(store.getCheckpoint("telegram", "update_id")).toBe("314");
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
    const storedRows = database.query("SELECT roles_json, workspace_json, value_json FROM principals LEFT JOIN conversation_bindings ON 1 = 1 LEFT JOIN adapter_checkpoints ON 1 = 1").all();
    expect(JSON.stringify(storedRows)).not.toContain(sourceToken);
    database.close();
  });
});
