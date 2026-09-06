import { describe, expect, test } from "bun:test";
import type { TaskEvidence, TaskExecutionContext } from "./execution-types";
import { validateSemanticView, type SemanticView } from "./gateway-views";
import type { TurnLifecycle } from "./gateway-store";
import { homeSemanticView, moreSemanticView, taskHistorySemanticView, taskSemanticView } from "./rpc-semantic-views";
import type { AutonomyMode } from "./rpc-config";
import { renderTelegramSemanticView } from "./transports/telegram/semantic-views";

const NOW = 5_000;

function lifecycle(overrides: Partial<TurnLifecycle> = {}): TurnLifecycle {
  return {
    id: "task-1",
    principalId: "operator-42",
    address: { transport: "telegram", account: "default", channel: "42" },
    prompt: "Deploy the service",
    state: "completed",
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

const execution: TaskExecutionContext = {
  projectId: "ompclaw",
  projectName: "OmpClaw",
  workspace: "/srv/ompclaw",
  workerId: "build-box",
  policy: { write: true, commands: true, network: false, maxDurationMs: 3_600_000 },
  expiresAt: 4_000,
};

const evidence: TaskEvidence = {
  projectId: "ompclaw",
  host: "build-box.local",
  revision: "c627370d9b2f",
  changedFiles: ["src/a.ts", "src/b.ts"],
  checks: [
    { command: "bun test", exitCode: 0, output: "42 pass" },
    { command: "bun run lint", exitCode: 1, output: "1 error" },
  ],
  artifacts: [
    {
      id: "art-1",
      name: "report.txt",
      path: "/srv/ompclaw/.ompclaw/artifacts/report.txt",
      size: 2048,
      sha256: "a".repeat(64),
    },
  ],
};

describe("legacy task cards", () => {
  test("completed cards without execution evidence stay unchanged", () => {
    const view: SemanticView = taskSemanticView(lifecycle(), [], 7, [], false, false, NOW);
    validateSemanticView(view);
    expect(view.sections.map((section) => section.id)).toEqual(["progress"]);
    expect(view.actions.map((action) => action.command)).toEqual(["/result task-1", undefined, undefined]);
  });

  test("failed cards keep retry as the legacy recovery affordance", () => {
    const view = taskSemanticView(
      lifecycle({ state: "failed", error: "boom", finishedAt: 2_000 }),
      [],
      8,
      [],
      false,
      false,
      NOW,
    );
    validateSemanticView(view);
    expect(view.actions.map((action) => action.command)).toEqual([
      "/result task-1",
      undefined,
      undefined,
      "/task_retry task-1",
      "/task_details task-1",
      "/tasks",
      "/new",
    ]);
    expect(view.actions.some((action) => action.command?.startsWith("/task_recover"))).toBe(false);
    expect(view.sections.some((section) => section.id === "project")).toBe(false);
  });
});

describe("evidence-backed task cards", () => {
  test("renders project identity from recorded execution and host from evidence only", () => {
    const view = taskSemanticView(lifecycle({ execution, evidence }), [], 9, [], false, false, NOW);
    validateSemanticView(view);
    expect(view.sections.find((section) => section.id === "project")).toEqual({
      id: "project",
      label: "Project",
      text: "OmpClaw (ompclaw) · host build-box.local",
      tone: "default",
    });
    const withoutEvidence = taskSemanticView(lifecycle({ execution }), [], 10, [], false, false, NOW);
    expect(withoutEvidence.sections.find((section) => section.id === "project")?.text).toBe(
      "OmpClaw (ompclaw) · worker build-box",
    );
  });

  test("renders receipts as facts without claiming verification", () => {
    const view = taskSemanticView(lifecycle({ execution, evidence }), [], 11, [], false, false, NOW);
    validateSemanticView(view);
    expect(view.sections).toEqual(
      expect.arrayContaining([
        {
          id: "changes",
          label: "Changes",
          text: "Revision c627370d9b2f\n• src/a.ts\n• src/b.ts",
          tone: "default",
        },
        {
          id: "checks",
          label: "Command receipts",
          text: "✓ bun test · exit 0\n⚠ bun run lint · exit 1",
          tone: "default",
        },
        { id: "artifacts", label: "Artifacts", text: "• report.txt · 2.0 KB", tone: "default" },
      ]),
    );
    expect(view.title).toBe("✅ Completed · 1s");
  });

  test("gates diff and artifact downloads on recorded evidence", () => {
    const view = taskSemanticView(lifecycle({ execution, evidence }), [], 12, [], false, false, NOW);
    expect(view.actions.map((action) => action.command)).toContain("/task_diff task-1");
    expect(view.actions.map((action) => action.command)).toContain("/task_artifact task-1 art-1");

    const sparse = taskSemanticView(
      lifecycle({ execution, evidence: { ...evidence, changedFiles: [], artifacts: [] } }),
      [],
      13,
      [],
      false,
      false,
      NOW,
    );
    validateSemanticView(sparse);
    expect(sparse.actions.some((action) => action.command?.startsWith("/task_artifact"))).toBe(false);
    expect(sparse.actions.map((action) => action.command)).toContain("/task_diff task-1");
    expect(sparse.sections.some((section) => section.id === "artifacts")).toBe(false);
  });

  test("running scoped cards show identity and receipts but no downloads or recovery", () => {
    const view = taskSemanticView(lifecycle({ state: "running", execution, evidence }), [], 14, [], false, false, NOW);
    validateSemanticView(view);
    expect(view.kind).toBe("task");
    expect(view.actions.map((action) => action.id)).toEqual(["steer", "followup", "stop"]);
    expect(view.sections.some((section) => section.id === "project")).toBe(true);
    expect(view.sections.some((section) => section.id === "checks")).toBe(true);
    expect(view.actions.some((action) => action.command === "/task_diff task-1")).toBe(false);
    expect(view.actions.some((action) => action.command?.startsWith("/task_recover"))).toBe(false);
  });
});

describe("scoped recovery controls", () => {
  test("interrupted scoped tasks offer separate inspect/continue/restart", () => {
    const view = taskSemanticView(
      lifecycle({
        state: "interrupted",
        error: "OMP restarted",
        execution,
        evidence,
        recoveryOf: "task-0",
      }),
      [],
      15,
      [],
      false,
      false,
      NOW,
    );
    validateSemanticView(view);
    const recover = view.actions.filter((action) => action.command?.startsWith("/task_recover"));
    expect(recover.map((action) => action.command)).toEqual([
      "/task_recover task-1 inspect",
      "/task_recover task-1 continue",
      "/task_recover task-1 restart",
    ]);
    expect(recover.find((action) => action.id === "recover_restart")?.style).toBe("danger");
    expect(view.actions.some((action) => action.command === "/task_retry task-1")).toBe(false);
    expect(view.sections).toEqual(
      expect.arrayContaining([
        { id: "recovery", label: "Recovery", text: "Recovered from task task-0.", tone: "muted" },
      ]),
    );
  });
});

describe("grant expiry", () => {
  test("unfinished scoped tasks surface expired authorization", () => {
    const view = taskSemanticView(lifecycle({ state: "running", execution }), [], 16, [], false, false, NOW);
    validateSemanticView(view);
    expect(view.sections).toEqual(
      expect.arrayContaining([
        {
          id: "expired",
          label: "Authorization",
          text: "Project authorization expired — recovery needs a new grant.",
          tone: "warning",
        },
      ]),
    );
  });

  test("unexpired grants and completed receipts never show expiry", () => {
    const running = taskSemanticView(
      lifecycle({ state: "running", execution: { ...execution, expiresAt: 9_000 } }),
      [],
      17,
      [],
      false,
      false,
      NOW,
    );
    expect(running.sections.some((section) => section.id === "expired")).toBe(false);
    const done = taskSemanticView(lifecycle({ execution }), [], 18, [], false, false, NOW);
    expect(done.sections.some((section) => section.id === "expired")).toBe(false);
  });
});

describe("evidence bounds", () => {
  test("bounds files, command receipts, and artifact buttons", () => {
    const bigEvidence: TaskEvidence = {
      projectId: "ompclaw",
      host: "build-box.local",
      changedFiles: Array.from({ length: 40 }, (_, index) => `src/${index}.ts`),
      checks: Array.from({ length: 10 }, (_, index) => ({ command: `cmd ${index}`, exitCode: index % 2, output: "x" })),
      artifacts: Array.from({ length: 5 }, (_, index) => ({
        id: `art-${index}`,
        name: `file-${index}.bin`,
        path: `out/${index}`,
        size: 1024 * 1024,
        sha256: "a".repeat(64),
      })),
    };
    const view = taskSemanticView(lifecycle({ execution, evidence: bigEvidence }), [], 19, [], false, false, NOW);
    validateSemanticView(view);
    const changes = view.sections.find((section) => section.id === "changes")!.text.split("\n");
    expect(changes).toHaveLength(7);
    expect(changes.at(-1)).toBe("+34 more files");
    expect(view.sections.find((section) => section.id === "checks")!.text.split("\n")).toEqual([
      "+7 earlier commands",
      "⚠ cmd 7 · exit 1",
      "✓ cmd 8 · exit 0",
      "⚠ cmd 9 · exit 1",
    ]);
    expect(view.actions.filter((action) => action.id.startsWith("artifact"))).toHaveLength(3);
    expect(
      view.sections
        .find((section) => section.id === "artifacts")!
        .text.split("\n")
        .at(-1),
    ).toBe("+2 more artifacts");
  });

  test("truncates overlong evidence lines deterministically", () => {
    const view = taskSemanticView(
      lifecycle({
        execution,
        evidence: {
          ...evidence,
          changedFiles: ["x".repeat(200)],
          checks: [{ command: "y".repeat(200), exitCode: 0, output: "" }],
          artifacts: [{ ...evidence.artifacts[0]!, name: "z".repeat(100) }],
        },
      }),
      [],
      20,
      [],
      false,
      false,
      NOW,
    );
    validateSemanticView(view);
    expect(view.sections.find((section) => section.id === "changes")!.text.split("\n")[1]).toBe(`• ${"x".repeat(95)}…`);
    expect(view.sections.find((section) => section.id === "checks")!.text.split("\n")[0]).toBe(
      `✓ ${"y".repeat(63)}… · exit 0`,
    );
    expect(view.actions.find((action) => action.id === "artifact0")!.label).toBe(`⬇️ ${"z".repeat(23)}…`);
  });
});

describe("history and home projections", () => {
  test("history routes scoped entries to recover and legacy entries to retry", () => {
    const view = taskHistorySemanticView(
      [
        { lifecycle: lifecycle({ id: "task-a", state: "failed", error: "x", execution, evidence }), events: [] },
        { lifecycle: lifecycle({ id: "task-b", state: "failed", error: "y" }), events: [] },
      ],
      NOW,
      NOW,
    );
    validateSemanticView(view);
    expect(
      view.actions.filter((action) => action.command?.includes("task_recover")).map((action) => action.command),
    ).toEqual(["/task_recover task-a inspect"]);
    expect(
      view.actions.filter((action) => action.command?.includes("task_retry")).map((action) => action.command),
    ).toEqual(["/task_retry task-b"]);
    expect(view.sections[0]?.text).toContain("Project · OmpClaw · host build-box.local");
    expect(view.sections[1]?.text).not.toContain("Project ·");
  });

  test("home card carries project identity only when the input supports it", () => {
    const base = {
      autonomyMode: "balanced" as AutonomyMode,
      autonomyLabel: "Balanced",
      version: NOW,
      updatedAt: NOW,
    };
    const busy = homeSemanticView({
      ...base,
      activeTask: { title: "Deploy", startedAt: 1_000 },
      execution,
      evidence,
    });
    validateSemanticView(busy);
    expect(busy.sections[0]).toEqual({
      id: "project",
      label: "Project",
      text: "OmpClaw (ompclaw) · host build-box.local",
      tone: "default",
    });
    const idle = homeSemanticView({ ...base, execution });
    validateSemanticView(idle);
    expect(idle.sections[0]).toEqual({
      id: "project",
      label: "Project",
      text: "OmpClaw (ompclaw) · worker build-box",
      tone: "default",
    });
    const plain = homeSemanticView(base);
    expect(plain.sections.some((section) => section.id === "project")).toBe(false);
    expect(plain.sections.find((section) => section.id === "workspace")).toMatchObject({
      label: "Workspace",
      text: "Default workspace; no project task is selected.",
    });
  });
  test("more card separates chat history from the agent session", () => {
    const view = moreSemanticView({
      autonomyMode: "balanced" as AutonomyMode,
      autonomyLabel: "Balanced",
      version: NOW,
      updatedAt: NOW,
    });
    validateSemanticView(view);
    const history = view.sections.find((section) => section.id === "history");
    expect(history?.label).toBe("History");
    expect(history?.text).toContain("Telegram history");
    expect(history?.text).toContain("/new");
  });
});

describe("telegram semantic pipeline", () => {
  test("evidence cards render through the existing Telegram actions", () => {
    const view = taskSemanticView(lifecycle({ execution, evidence }), [], 21, [], false, false, NOW);
    validateSemanticView(view);
    const spec = renderTelegramSemanticView(view);
    expect(spec.text).toContain("OmpClaw (ompclaw) · host build-box.local");
    expect(spec.text).toContain("✓ bun test · exit 0");
    expect(spec.text).toContain("⚠ bun run lint · exit 1");
    const labels = spec.replyMarkup.inline_keyboard.flat().map((button) => button.text);
    expect(labels).toContain("🪶 View diff");
    expect(labels).toContain("⬇️ report.txt");
    expect(renderTelegramSemanticView(view)).toEqual(spec);
    expect(taskSemanticView(lifecycle({ execution, evidence }), [], 21, [], false, false, NOW)).toEqual(view);
  });
});
