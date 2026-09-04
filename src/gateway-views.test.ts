import { describe, expect, test } from "bun:test";
import {
  normalizeSemanticView,
  normalizeStoredSemanticView,
  validateSemanticView,
  type SemanticView,
  type StoredSemanticView,
} from "./gateway-views";
import {
  scheduledJobDeleteConfirmSemanticView,
  scheduledJobDetailSemanticView,
  scheduledJobsSemanticView,
  sessionChoiceSemanticView,
  taskHistorySemanticView,
  taskSemanticView,
} from "./rpc-semantic-views";

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

  test("keeps prompt-backed actions bounded to simple gateway slash commands", () => {
    const view = semanticView({
      actions: [
        {
          id: "steer",
          label: "Add instruction",
          input: { title: "Steer", prompt: "Reply with an instruction.", command: "/steer" },
        },
      ],
    });
    expect(normalizeSemanticView(view).actions[0]).toMatchObject({
      input: { title: "Steer", prompt: "Reply with an instruction.", command: "/steer" },
    });
    expect(() =>
      validateSemanticView(
        semanticView({
          actions: [
            {
              id: "unsafe",
              label: "Unsafe",
              input: { title: "Unsafe", prompt: "No.", command: "/steer now" },
            },
          ],
        }),
      ),
    ).toThrow("simple slash command");
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

describe("runtime semantic projections", () => {
  test("builds a single-message setting page with current selection and navigation", () => {
    const view = sessionChoiceSemanticView({
      title: "Choose reasoning depth",
      summary: "Applies to this session.",
      choices: [
        { id: "low", label: "Low", command: "/thinking low" },
        { id: "high", label: "High", command: "/thinking high", selected: true },
      ],
      version: 7,
      updatedAt: 100,
    });

    validateSemanticView(view);
    expect(view).toMatchObject({
      id: "home",
      kind: "decision",
      state: "waiting",
      sections: [{ id: "current", text: "High" }],
    });
    expect(view.actions).toEqual([
      { id: "choose0", label: "Low", command: "/thinking low", style: "default" },
      { id: "choose1", label: "✓ High", command: "/thinking high", style: "primary" },
      { id: "back", label: "Back to Home", command: "/home" },
    ]);
  });

  test("projects scheduled jobs into actionable cards", () => {
    const job = {
      id: "job-1",
      principalId: "operator-42",
      identity: { transport: "telegram", account: "default", subject: "42" },
      address: { transport: "telegram", account: "default", channel: "42" },
      name: "Morning brief",
      prompt: "Summarize updates",
      schedule: { kind: "cron" as const, expression: "0 9 * * *", timezone: "America/Los_Angeles" },
      enabled: true,
      nextRunAt: 200,
      attemptCount: 0,
      successCount: 2,
      failureCount: 0,
      createdAt: 10,
      updatedAt: 100,
    };
    const view = scheduledJobsSemanticView([job], 7, 100);

    validateSemanticView(view);
    expect(view.sections[0]).toMatchObject({
      label: "🟢 Morning brief",
      text: expect.stringContaining("Next:"),
    });
    expect(view.actions.map(({ command }) => command)).toEqual([
      "/job job-1",
      undefined,
      "/home",
    ]);

    const detail = scheduledJobDetailSemanticView(job, 8, 100);
    validateSemanticView(detail);
    expect(detail.actions.map(({ command }) => command)).toEqual([
      "/job_run job-1",
      "/job_pause job-1",
      undefined,
      "/job_delete_confirm job-1",
      "/schedules",
    ]);

    const confirm = scheduledJobDeleteConfirmSemanticView(job, 9, 100);
    validateSemanticView(confirm);
    expect(confirm.actions.map(({ command }) => command)).toEqual([
      "/job_delete job-1",
      "/job job-1",
    ]);
  });

  test("projects task steering and recovery into durable cards", () => {
    const lifecycle = {
      id: "task-1",
      principalId: "operator-42",
      address: { transport: "telegram", account: "default", channel: "42" },
      prompt: "Deploy the service",
      state: "interrupted" as const,
      createdAt: 10,
      updatedAt: 20,
      finishedAt: 20,
      error: "OMP restarted",
    };
    const active = taskSemanticView({ ...lifecycle, state: "running", finishedAt: undefined }, [], 7);
    expect(active.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "steer", input: expect.objectContaining({ command: "/steer" }) }),
        expect.objectContaining({ id: "followup", input: expect.objectContaining({ command: "/followup" }) }),
      ]),
    );
    const failed = taskSemanticView({ ...lifecycle, state: "failed" }, [], 8);
    expect(failed.sections).toEqual(
      expect.arrayContaining([
        {
          id: "error",
          label: "What happened",
          text: "The OMP session was interrupted.",
          tone: "danger",
        },
      ]),
    );
    expect(failed.sections.map((section) => section.text).join("\n")).not.toContain("Use /status");
    expect(failed.actions.map((action) => action.command)).toEqual([
      "/task_retry task-1",
      "/task_details task-1",
      "/tasks",
      "/new",
    ]);
    const detailed = taskSemanticView({ ...lifecycle, state: "failed" }, [], 9, [], false, true);
    expect(detailed.sections).toEqual(
      expect.arrayContaining([{ id: "details", label: "Details", text: "OMP restarted", tone: "muted" }]),
    );
    expect(detailed.actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "details", command: "/task_details task-1 hide" })]),
    );
    const timeline = taskHistorySemanticView(
      [{ lifecycle, events: [{ turnId: "task-1", at: 10, kind: "queued", text: "Task received" }] }],
      8,
      20,
    );
    validateSemanticView(timeline);
    expect(timeline.actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "/task_retry task-1" })]),
    );
    expect(timeline.sections[0]?.text).toContain("Task received");
  });
});
