import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  GatewayScheduler,
  ScheduledDispatchBusyError,
  formatFriendlyNextRun,
  formatHumanSchedule,
  formatScheduledJob,
  friendlyTimezoneName,
  humanizeCron,
} from "./gateway-scheduler";
import { GatewayStore } from "./gateway-store";

const directories: string[] = [];
const identity = { transport: "telegram", account: "default", subject: "42" } as const;
const address = { transport: "telegram", account: "default", channel: "42" } as const;
const principal = { id: "operator-42", roles: ["operator"] } as const;

function temporaryStore(): { path: string; store: GatewayStore } {
  const directory = mkdtempSync(join(tmpdir(), "ompclaw-scheduler-"));
  directories.push(directory);
  const path = join(directory, "ompclaw.sqlite");
  const store = new GatewayStore(path);
  store.upsertPrincipal(principal);
  return { path, store };
}

function context() {
  return { principal, identity, address };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("GatewayScheduler", () => {
  test("validates schedules and keeps jobs scoped to their principal", () => {
    const { store } = temporaryStore();
    let now = Date.parse("2026-08-30T12:00:00Z");
    const scheduler = new GatewayScheduler({
      store,
      dispatch: async () => {},
      enabled: true,
      pollIntervalMs: 1_000,
      retryDelayMs: 1_000,
      maxAttempts: 3,
      now: () => now,
    });

    expect(() => scheduler.create({ name: "bad", prompt: "no offset", at: "2026-08-30T13:00:00" }, context())).toThrow("explicit UTC offset");
    expect(() => scheduler.create({ name: "bad", prompt: "two schedules", at: "2026-08-30T13:00:00Z", cron: "0 * * * *" }, context())).toThrow("exactly one");
    expect(() => scheduler.create({ name: "bad", prompt: "bad zone", cron: "0 * * * *", timezone: "Mars/Olympus" }, context())).toThrow("Invalid IANA timezone");

    const job = scheduler.create({ name: "daily", prompt: "Summarize work", cron: "0 9 * * *", timezone: "America/Los_Angeles" }, context());
    expect(job.nextRunAt).toBeGreaterThan(now);
    expect(scheduler.list(principal.id).map((entry) => entry.id)).toEqual([job.id]);
    expect(scheduler.list("another-principal")).toEqual([]);
    expect(() => scheduler.update({ id: job.id, timezone: "UTC" }, context())).not.toThrow();
    expect(() => scheduler.update({ id: job.id, at: "2026-08-31T12:00:00Z", timezone: "UTC" }, context())).toThrow("timezone is only valid with cron");
    expect(() => scheduler.setEnabled(job.id, "another-principal", false)).toThrow("not found");

    const paused = scheduler.setEnabled(job.id, principal.id, false);
    expect(paused.enabled).toBe(false);
    now += 1_000;
    const renamed = scheduler.update({ id: job.id, name: "daily report" }, context());
    expect(renamed.enabled).toBe(false);
    store.close();
  });

  test("dispatches a one-shot once and persists completion", async () => {
    const { store } = temporaryStore();
    let now = Date.parse("2026-08-30T12:00:00Z");
    const dispatched: string[] = [];
    const scheduler = new GatewayScheduler({
      store,
      dispatch: async (job) => { dispatched.push(job.id); },
      enabled: true,
      pollIntervalMs: 1_000,
      retryDelayMs: 1_000,
      maxAttempts: 3,
      now: () => now,
    });
    const job = scheduler.create({ name: "once", prompt: "Run once", at: "2026-08-30T12:00:01Z" }, context());

    await scheduler.runDue();
    expect(dispatched).toEqual([]);
    now += 1_000;
    await scheduler.runDue();
    await scheduler.runDue();

    expect(dispatched).toEqual([job.id]);
    expect(scheduler.get(job.id, principal.id)).toEqual(expect.objectContaining({
      enabled: false,
      attemptCount: 0,
      successCount: 1,
      failureCount: 0,
      lastRunAt: now,
      lastSuccessAt: now,
    }));
    store.close();
  });

  test("defers busy runs without consuming retries and disables permanent failures", async () => {
    const { store } = temporaryStore();
    let now = Date.parse("2026-08-30T12:00:00Z");
    let dispatches = 0;
    const permanent: string[] = [];
    const scheduler = new GatewayScheduler({
      store,
      dispatch: async () => {
        dispatches += 1;
        if (dispatches === 1) throw new ScheduledDispatchBusyError("busy");
        throw new Error("provider unavailable");
      },
      enabled: true,
      pollIntervalMs: 1_000,
      retryDelayMs: 1_000,
      maxAttempts: 2,
      now: () => now,
      onPermanentFailure: async (job) => { permanent.push(job.id); },
    });
    const job = scheduler.create({ name: "retry", prompt: "Retry me", at: "2026-08-30T12:00:00Z" }, context());

    await scheduler.runDue();
    expect(scheduler.get(job.id, principal.id)).toEqual(expect.objectContaining({ attemptCount: 0, failureCount: 0, retryAt: now + 1_000 }));
    now += 1_000;
    await scheduler.runDue();
    expect(scheduler.get(job.id, principal.id)).toEqual(expect.objectContaining({ attemptCount: 1, failureCount: 0, retryAt: now + 1_000 }));
    now += 1_000;
    await scheduler.runDue();

    expect(scheduler.get(job.id, principal.id)).toEqual(expect.objectContaining({
      enabled: false,
      attemptCount: 0,
      failureCount: 1,
      lastError: "provider unavailable",
    }));
    expect(permanent).toEqual([job.id]);
    store.close();
  });

  test("recovers a due job from SQLite after restart", async () => {
    const { path, store } = temporaryStore();
    let now = Date.parse("2026-08-30T12:00:00Z");
    const first = new GatewayScheduler({
      store,
      dispatch: async () => {},
      enabled: true,
      pollIntervalMs: 1_000,
      retryDelayMs: 1_000,
      maxAttempts: 3,
      now: () => now,
    });
    const job = first.create({ name: "restart", prompt: "Survive restart", at: "2026-08-30T12:00:01Z" }, context());
    store.close();

    now += 1_000;
    const restartedStore = new GatewayStore(path);
    const dispatched: string[] = [];
    const restarted = new GatewayScheduler({
      store: restartedStore,
      dispatch: async (due) => { dispatched.push(due.id); },
      enabled: true,
      pollIntervalMs: 1_000,
      retryDelayMs: 1_000,
      maxAttempts: 3,
      now: () => now,
    });
    await restarted.runDue();

    expect(dispatched).toEqual([job.id]);
    expect(restarted.get(job.id, principal.id)?.successCount).toBe(1);
    restartedStore.close();
  });
});

describe("humanized schedule formatting", () => {
  test("formats common cron patterns into human-readable text", () => {
    expect(humanizeCron("0 9 * * *")).toBe("Every day at 9:00 AM");
    expect(humanizeCron("30 14 * * *")).toBe("Every day at 2:30 PM");
    expect(humanizeCron("0 0 * * *")).toBe("Every day at 12:00 AM");
    expect(humanizeCron("0 9 * * 1")).toBe("Every Monday at 9:00 AM");
    expect(humanizeCron("0 9 * * 5")).toBe("Every Friday at 9:00 AM");
    expect(humanizeCron("0 9 * * 1-5")).toBe("Every weekday at 9:00 AM");
    expect(humanizeCron("*/30 * * * *")).toBe("Every 30 minutes");
    expect(humanizeCron("*/5 * * * *")).toBe("Every 5 minutes");
    expect(humanizeCron("0 * * * *")).toBe("Every hour");
    expect(humanizeCron("0 */2 * * *")).toBe("Every 2 hours");
  });

  test("falls back to raw expression for exotic crons", () => {
    expect(humanizeCron("23 4 1,15 * 2")).toBe("23 4 1,15 * 2");
    expect(humanizeCron("0 0 1 1 *")).toBe("0 0 1 1 *");
  });

  test("formats friendly timezone names", () => {
    expect(friendlyTimezoneName("America/Los_Angeles")).toBe("Pacific");
    expect(friendlyTimezoneName("America/New_York")).toBe("Eastern");
    expect(friendlyTimezoneName("UTC")).toBe("UTC");
    expect(friendlyTimezoneName(undefined)).toBeUndefined();
  });

  test("formats human schedule with timezone", () => {
    expect(formatHumanSchedule({ kind: "cron", expression: "0 9 * * *", timezone: "America/Los_Angeles" })).toBe(
      "Every day at 9:00 AM (Pacific)",
    );
    expect(formatHumanSchedule({ kind: "cron", expression: "23 4 1,15 * 2", timezone: "America/Los_Angeles" })).toBe(
      "23 4 1,15 * 2 (Pacific)",
    );
  });

  test("formats friendly relative next runs and scheduled job strings", () => {
    const now = Date.parse("2026-09-03T16:00:00Z"); // 9:00 AM PDT
    expect(formatFriendlyNextRun(undefined, now, undefined, false)).toBe("Paused");
    expect(formatFriendlyNextRun(undefined, now, undefined, true)).toBe("None scheduled");
    expect(formatFriendlyNextRun(now + 45 * 60_000, now, "America/Los_Angeles")).toBe("in 45 min");
    expect(formatFriendlyNextRun(now + 3 * 3600_000, now, "America/Los_Angeles")).toBe("Today at 12:00 PM Pacific");
    expect(formatFriendlyNextRun(now + 24 * 3600_000, now, "America/Los_Angeles")).toBe("Tomorrow at 9:00 AM Pacific");

    const job = {
      id: "job-1",
      principalId: "p-1",
      identity: { transport: "telegram" as const, account: "default", subject: "42" },
      address: { transport: "telegram" as const, account: "default", channel: "42" },
      name: "report",
      prompt: "daily summary",
      schedule: { kind: "cron" as const, expression: "0 9 * * *", timezone: "America/Los_Angeles" },
      enabled: true,
      nextRunAt: now + 3600_000,
      attemptCount: 0,
      successCount: 1,
      failureCount: 0,
      createdAt: now - 86400_000,
      updatedAt: now,
    };
    expect(formatScheduledJob(job, now)).toContain("report");
    expect(formatScheduledJob(job, now)).toContain("Every day at 9:00 AM (Pacific)");
  });
});
