import { createHash } from "node:crypto";
import type { AutonomyMode } from "./rpc-config";
import type { RpcSessionState } from "./rpc-protocol";
import type { ScheduledJob } from "./gateway-store";
import type { TurnLifecycle } from "./gateway-store";
import type { SemanticView, SemanticViewState } from "./gateway-views";

const MAX_SUMMARY_CHARS = 512;
const MAX_ACTIVITY_ITEMS = 8;

export interface TaskSemanticTodo {
  readonly content: string;
  readonly status: string;
}

export interface TaskSemanticTodoPhase {
  readonly name: string;
  readonly tasks: readonly TaskSemanticTodo[];
}

export interface HomeSemanticViewInput {
  readonly state?: RpcSessionState;
  readonly autonomyMode: AutonomyMode;
  readonly autonomyLabel: string;
  readonly version: number;
  readonly updatedAt: number;
}

function boundedSummary(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= MAX_SUMMARY_CHARS) return normalized;
  return `${normalized.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`;
}

function taskState(state: TurnLifecycle["state"]): SemanticViewState {
  if (state === "queued" || state === "running") return "active";
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";
  return "cancelled";
}

function taskLabel(state: TurnLifecycle["state"]): string {
  if (state === "queued") return "Queued";
  if (state === "running") return "Working";
  if (state === "completed") return "Completed";
  if (state === "failed") return "Failed";
  if (state === "stopped") return "Stopped";
  return "Interrupted";
}

export function taskSemanticView(
  lifecycle: TurnLifecycle,
  activities: readonly string[],
  version: number,
  todoPhases: readonly TaskSemanticTodoPhase[] = [],
): SemanticView {
  const terminal =
    lifecycle.state === "completed" ||
    lifecycle.state === "failed" ||
    lifecycle.state === "stopped" ||
    lifecycle.state === "interrupted";
  const activityLines = activities
    .slice(-MAX_ACTIVITY_ITEMS)
    .map((activity) => activity.trim())
    .filter(Boolean);
  const todoSections = todoPhases.map((phase, index) => ({
    id: `todo_${index}`,
    label: phase.name,
    text: phase.tasks
      .map((todo) => {
        const marker =
          todo.status === "completed"
            ? "✓"
            : todo.status === "in_progress"
              ? "●"
              : todo.status === "blocked"
                ? "!"
                : todo.status === "cancelled"
                  ? "×"
                  : "○";
        return `${marker} ${todo.content}`;
      })
      .join("\n"),
    tone: "default" as const,
  }));
  return {
    schemaVersion: 1,
    id: `task_${createHash("sha256").update(lifecycle.id).digest("hex").slice(0, 19)}`,
    kind: terminal ? "result" : "task",
    version,
    state: taskState(lifecycle.state),
    title: terminal ? "Task result" : "Task",
    summary: boundedSummary(lifecycle.prompt),
    sections: [
      {
        id: "status",
        label: "Status",
        text: taskLabel(lifecycle.state),
        tone: lifecycle.state === "failed" ? "danger" : lifecycle.state === "completed" ? "success" : "default",
      },
      ...todoSections,
      ...(activityLines.length === 0
        ? []
        : [
            {
              id: "activity",
              label: "Activity",
              text: activityLines.map((activity) => `• ${activity}`).join("\n"),
              tone: "muted" as const,
            },
          ]),
      ...(lifecycle.error === undefined
        ? []
        : [{ id: "error", label: "Error", text: "Use /status for details.", tone: "danger" as const }]),
    ],
    actions: terminal ? [] : [{ id: "stop", label: "Stop", command: "/stop", style: "danger", enabled: true }],
    updatedAt: lifecycle.updatedAt,
    notification: "silent",
  };
}

export interface SessionChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly command: string;
  readonly selected?: boolean;
}

export interface SessionChoiceSemanticViewInput {
  readonly title: string;
  readonly summary: string;
  readonly choices: readonly SessionChoice[];
  readonly version: number;
  readonly updatedAt: number;
}

export function sessionChoiceSemanticView(input: SessionChoiceSemanticViewInput): SemanticView {
  const selected = input.choices.find((choice) => choice.selected);
  return {
    schemaVersion: 1,
    id: "home",
    kind: "decision",
    version: input.version,
    state: "waiting",
    title: input.title,
    summary: input.summary,
    sections: [
      {
        id: "current",
        label: "Current",
        text: selected?.label ?? "Inherited from the active OMP session",
        tone: "muted",
      },
      ...input.choices
        .filter((choice) => choice.description !== undefined)
        .map((choice, index) => ({
          id: `choice${index}`,
          label: choice.label,
          text: choice.description!,
          tone: choice.selected ? ("success" as const) : ("muted" as const),
        })),
    ],
    actions: [
      ...input.choices.map((choice, index) => ({
        id: `choose${index}`,
        label: `${choice.selected ? "✓ " : ""}${choice.label}`,
        command: choice.command,
        style: choice.selected ? ("primary" as const) : ("default" as const),
      })),
      { id: "back", label: "Back to Home", command: "/home" },
    ],
    updatedAt: input.updatedAt,
  };
}

export function informationSemanticView(
  title: string,
  summary: string,
  version: number,
  updatedAt: number,
): SemanticView {
  return {
    schemaVersion: 1,
    id: "home",
    kind: "decision",
    version,
    state: "waiting",
    title,
    summary,
    sections: [],
    actions: [{ id: "back", label: "Back to Home", command: "/home" }],
    updatedAt,
  };
}

function jobSchedule(job: ScheduledJob): string {
  if (job.schedule.kind === "at") return `Once · ${new Date(job.schedule.at).toISOString()}`;
  return `Cron · ${job.schedule.expression}${job.schedule.timezone ? ` · ${job.schedule.timezone}` : ""}`;
}

export function scheduledJobsSemanticView(
  jobs: readonly ScheduledJob[],
  version: number,
  updatedAt: number,
): SemanticView {
  const visible = jobs.slice(0, 20);
  return {
    schemaVersion: 1,
    id: "home",
    kind: "decision",
    version,
    state: "waiting",
    title: "Scheduled jobs",
    summary:
      jobs.length === 0
        ? "No scheduled jobs"
        : `${jobs.length} job${jobs.length === 1 ? "" : "s"}${jobs.length > visible.length ? ` · showing ${visible.length}` : ""}`,
    sections: visible.map((job, index) => ({
      id: `job${index}`,
      label: job.name,
      text: [
        job.enabled ? "Active" : "Paused",
        jobSchedule(job),
        job.nextRunAt === undefined ? undefined : `Next · ${new Date(job.nextRunAt).toISOString()}`,
        job.lastError === undefined ? undefined : `Last error · ${boundedSummary(job.lastError)}`,
      ]
        .filter(Boolean)
        .join("\n"),
      tone: job.lastError === undefined ? (job.enabled ? "default" : "muted") : "danger",
    })),
    actions: [
      ...visible.flatMap((job, index) => [
        {
          id: `${job.enabled ? "pause" : "resume"}${index}`,
          label: `${job.enabled ? "Pause" : "Resume"} · ${boundedSummary(job.name).slice(0, 32)}`,
          command: `/${job.enabled ? "job_pause" : "job_resume"} ${job.id}`,
        },
        {
          id: `run${index}`,
          label: `Run now · ${boundedSummary(job.name).slice(0, 32)}`,
          command: `/job_run ${job.id}`,
          style: "primary" as const,
        },
        {
          id: `delete${index}`,
          label: `Delete · ${boundedSummary(job.name).slice(0, 32)}`,
          command: `/job_delete ${job.id}`,
          style: "danger" as const,
        },
      ]),
      { id: "back", label: "Back to Home", command: "/home" },
    ],
    updatedAt,
  };
}

export function homeSemanticView(input: HomeSemanticViewInput): SemanticView {
  const state = input.state;
  const model = `${state?.model?.provider ?? "?"}/${state?.model?.id ?? "?"}`;
  const session = state?.sessionName?.trim() || state?.sessionId || "Starting";
  const status = state?.isStreaming ? "Running" : state?.isCompacting ? "Compacting" : "Idle";
  const context = state?.contextUsage?.percent;
  const contextText =
    typeof context === "number" && Number.isFinite(context) ? `${Math.round(context)}% context` : undefined;
  const queueText = typeof state?.queuedMessageCount === "number" ? `${state.queuedMessageCount} queued` : undefined;
  return {
    schemaVersion: 1,
    id: "home",
    kind: "home",
    version: input.version,
    state: state?.isStreaming || state?.isCompacting ? "active" : "waiting",
    title: "OmpClaw control center",
    summary: session,
    sections: [
      { id: "session", label: "Session", text: [status, contextText, queueText].filter(Boolean).join(" · ") },
      { id: "model", label: "Model", text: model },
      { id: "autonomy", label: "Autonomy", text: input.autonomyLabel },
      { id: "reasoning", label: "Reasoning", text: state?.thinkingLevel ?? "inherit" },
      { id: "fast", label: "Fast mode", text: state?.fastModeEnabled ? "On" : "Off", tone: "muted" },
      { id: "compaction", label: "Auto-compaction", text: state?.autoCompactionEnabled ? "On" : "Off", tone: "muted" },
    ],
    actions: [
      { id: "status", label: "Status", command: "/status" },
      { id: "model", label: "Model", command: "/model" },
      { id: "autonomy", label: "Autonomy", command: "/autonomy" },
      { id: "thinking", label: "Reasoning", command: "/thinking" },
      { id: "fast", label: "Fast mode", command: "/fast" },
      { id: "autocompact", label: "Auto-compaction", command: "/autocompact" },
      { id: "tasks", label: "Tasks", command: "/tasks" },
      { id: "jobs", label: "Scheduled jobs", command: "/jobs" },
      { id: "new", label: "New session", command: "/new", style: "primary" },
      ...(state?.isStreaming ? [{ id: "stop", label: "Stop", command: "/stop", style: "danger" as const }] : []),
    ],
    updatedAt: input.updatedAt,
  };
}
