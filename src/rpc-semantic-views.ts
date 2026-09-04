import { createHash } from "node:crypto";
import type { AutonomyMode } from "./rpc-config";
import type { RpcSessionState } from "./rpc-protocol";
import type { ScheduledJob, TurnLifecycle, TurnTimelineEvent } from "./gateway-store";
import type { SemanticView, SemanticViewState } from "./gateway-views";

const MAX_SUMMARY_CHARS = 512;
const MAX_ACTIVITY_ITEMS = 4;

export interface TaskSemanticActivity {
  readonly text: string;
  readonly state: "active" | "completed";
}

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

function elapsedText(startedAt: number, endedAt: number): string {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function taskTitle(lifecycle: TurnLifecycle, heartbeat: boolean): string {
  const elapsed = elapsedText(lifecycle.createdAt, lifecycle.finishedAt ?? lifecycle.updatedAt);
  if (lifecycle.state === "queued") return "🔵 Queued";
  if (lifecycle.state === "running") return `${heartbeat ? "⏳ Still working" : "🟡 Working"} · ${elapsed}`;
  if (lifecycle.state === "completed") return `✅ Completed · ${elapsed}`;
  if (lifecycle.state === "failed") return `⚠️ Failed · ${elapsed}`;
  if (lifecycle.state === "stopped") return `⏹ Stopped · ${elapsed}`;
  return `⚠️ Interrupted · ${elapsed}`;
}

export function taskSemanticView(
  lifecycle: TurnLifecycle,
  activities: readonly TaskSemanticActivity[],
  version: number,
  todoPhases: readonly TaskSemanticTodoPhase[] = [],
  heartbeat = false,
): SemanticView {
  const terminal =
    lifecycle.state === "completed" ||
    lifecycle.state === "failed" ||
    lifecycle.state === "stopped" ||
    lifecycle.state === "interrupted";
  const activityLines = activities
    .slice(-MAX_ACTIVITY_ITEMS)
    .map((activity) => ({ ...activity, text: activity.text.trim() }))
    .filter((activity) => activity.text.length > 0);
  const completedCount = activities.filter((activity) => activity.state === "completed").length;
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
  const collapsedSuccess = lifecycle.state === "completed";
  return {
    schemaVersion: 1,
    id: `task_${createHash("sha256").update(lifecycle.id).digest("hex").slice(0, 19)}`,
    kind: terminal ? "result" : "task",
    version,
    state: taskState(lifecycle.state),
    title: taskTitle(lifecycle, heartbeat),
    summary: boundedSummary(lifecycle.prompt),
    sections: [
      ...(collapsedSuccess
        ? [
            {
              id: "progress",
              label: "Progress",
              text: `${completedCount} ${completedCount === 1 ? "action" : "actions"} completed`,
              tone: "success" as const,
            },
          ]
        : [
            ...todoSections,
            ...(activityLines.length === 0
              ? []
              : [
                  {
                    id: "activity",
                    label: "Recent activity",
                    text: activityLines
                      .map((activity) => `${activity.state === "completed" ? "✓" : "→"} ${activity.text}`)
                      .join("\n"),
                    tone: "muted" as const,
                  },
                ]),
          ]),
      ...(lifecycle.error === undefined
        ? []
        : [{ id: "error", label: "Error", text: "Use /status for details.", tone: "danger" as const }]),
    ],
    actions: terminal
      ? []
      : [
          {
            id: "steer",
            label: "✏️ Add instruction",

            input: {
              title: "Steer this task",
              prompt: "Reply with the correction or instruction to apply now.",
              command: "/steer",
            },
          },
          {
            id: "followup",
            label: "➕ Add follow-up",
            input: {
              title: "Queue a follow-up",
              prompt: "Reply with work to do after this task finishes.",
              command: "/followup",
            },
          },
          { id: "stop", label: "🛑 Stop", command: "/stop", style: "danger", enabled: true },
        ],
    updatedAt: lifecycle.updatedAt,
    notification: "silent",
  };
}
export interface TaskHistoryEntry {
  readonly lifecycle: TurnLifecycle;
  readonly events: readonly TurnTimelineEvent[];
}

function taskHistoryState(state: TurnLifecycle["state"]): string {
  if (state === "queued") return "Queued";
  if (state === "running") return "Working";
  if (state === "completed") return "Completed";
  if (state === "stopped") return "Stopped";
  if (state === "failed") return "Failed";
  return "Interrupted";
}

export function taskHistorySemanticView(
  entries: readonly TaskHistoryEntry[],
  version: number,
  updatedAt: number,
): SemanticView {
  const visible = entries.slice(0, 8);
  return {
    schemaVersion: 1,
    id: "tasks",
    kind: "task",
    version,
    state: entries.some((entry) => entry.lifecycle.state === "queued" || entry.lifecycle.state === "running")
      ? "active"
      : "waiting",
    title: "Task timeline",
    summary:
      entries.length === 0
        ? "No persisted tasks for this conversation."
        : `${entries.length} recent task${entries.length === 1 ? "" : "s"}`,
    sections: visible.map((entry, index) => {
      const eventLines = entry.events.slice(-3).map((event) => `• ${event.text}`);
      return {
        id: `task${index}`,
        label: `${taskHistoryState(entry.lifecycle.state)} · ${boundedSummary(entry.lifecycle.prompt).slice(0, 80)}`,
        text:
          [
            entry.lifecycle.currentTool ? `Current activity · ${entry.lifecycle.currentTool}` : undefined,
            ...eventLines,
            entry.lifecycle.error ? `Recovery · ${boundedSummary(entry.lifecycle.error)}` : undefined,
          ]
            .filter((line): line is string => line !== undefined)
            .join("\n") || "No recorded activity.",
        tone:
          entry.lifecycle.state === "completed"
            ? ("success" as const)
            : entry.lifecycle.state === "failed" || entry.lifecycle.state === "interrupted"
              ? ("danger" as const)
              : ("default" as const),
      };
    }),
    actions: [
      ...visible.flatMap((entry, index) =>
        entry.lifecycle.state === "failed" ||
        entry.lifecycle.state === "interrupted" ||
        entry.lifecycle.state === "stopped"
          ? [
              {
                id: `retry${index}`,
                label: `Retry · ${boundedSummary(entry.lifecycle.prompt).slice(0, 32)}`,
                command: `/task_retry ${entry.lifecycle.id}`,
                style: "primary" as const,
              },
            ]
          : [],
      ),
      { id: "back", label: "Back to Home", command: "/home" },
    ],
    updatedAt,
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

export interface AvailableModel {
  readonly provider: string;
  readonly id: string;
}

export interface ModelProviderSemanticViewInput {
  readonly models: readonly AvailableModel[];
  readonly current?: AvailableModel;
  readonly version: number;
  readonly updatedAt: number;
}

export interface ModelPageSemanticViewInput extends ModelProviderSemanticViewInput {
  readonly provider: string;
  readonly page: number;
  readonly pageSize: number;
}

function modelDisplayName(id: string): string {
  return id
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => (part.toLowerCase() === "gpt" ? "GPT" : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`))
    .join(" ");
}

export function modelProviderSemanticView(input: ModelProviderSemanticViewInput): SemanticView {
  const providers: Array<{ readonly provider: string; readonly count: number }> = [];
  for (const model of [...input.models].sort((left, right) => left.provider.localeCompare(right.provider))) {
    const last = providers.at(-1);
    if (last?.provider === model.provider) {
      providers[providers.length - 1] = { provider: last.provider, count: last.count + 1 };
    } else {
      providers.push({ provider: model.provider, count: 1 });
    }
  }
  const current =
    input.current === undefined ? "Unknown" : `${input.current.provider} · ${modelDisplayName(input.current.id)}`;
  return {
    schemaVersion: 1,
    id: "model",
    kind: "decision",
    version: input.version,
    state: "waiting",
    title: "🤖 Model",
    summary: `Current: ${current}`,
    sections: [{ id: "choose", text: "Choose a provider." }],
    actions: [
      ...providers.map(({ provider, count }, index) => ({
        id: `provider${index}`,
        label: `${input.current?.provider === provider ? "✓ " : ""}${provider} · ${count}`,
        command: `/model provider ${encodeURIComponent(provider)}`,
        style: input.current?.provider === provider ? ("primary" as const) : ("default" as const),
      })),
      { id: "cancel", label: "Cancel", command: "/home" },
    ],
    updatedAt: input.updatedAt,
  };
}

export function modelPageSemanticView(input: ModelPageSemanticViewInput): SemanticView {
  const providerModels = input.models
    .filter((model) => model.provider === input.provider)
    .sort((left, right) => left.id.localeCompare(right.id));
  const pageCount = Math.max(1, Math.ceil(providerModels.length / input.pageSize));
  const page = Math.max(0, Math.min(pageCount - 1, input.page));
  const visible = providerModels.slice(page * input.pageSize, (page + 1) * input.pageSize);
  const current = input.current?.provider === input.provider ? modelDisplayName(input.current.id) : "None";
  const encodedProvider = encodeURIComponent(input.provider);
  return {
    schemaVersion: 1,
    id: "model",
    kind: "decision",
    version: input.version,
    state: "waiting",
    title: `🤖 ${input.provider} models ${page + 1}/${pageCount}`,
    summary: `Current: ${current}`,
    sections: visible.map((model, index) => ({
      id: `model${index}`,
      label: modelDisplayName(model.id),
      text: model.id,
      tone:
        input.current?.provider === model.provider && input.current.id === model.id
          ? ("success" as const)
          : ("muted" as const),
    })),
    actions: [
      ...visible.map((model, index) => ({
        id: `choose${index}`,
        label: `${input.current?.provider === model.provider && input.current.id === model.id ? "✓ " : ""}${modelDisplayName(model.id)}`,
        command: `/model select ${encodedProvider} ${encodeURIComponent(model.id)}`,
        style:
          input.current?.provider === model.provider && input.current.id === model.id
            ? ("primary" as const)
            : ("default" as const),
      })),
      { id: "back", label: "← Back", command: "/model" },
      ...(page + 1 < pageCount
        ? [{ id: "next", label: "Next →", command: `/model page ${encodedProvider} ${page + 1}` }]
        : []),
      ...(page > 0 ? [{ id: "previous", label: "← Prev", command: `/model page ${encodedProvider} ${page - 1}` }] : []),
      { id: "cancel", label: "Cancel", command: "/home" },
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
  const statusEmoji = state?.isStreaming ? "🟡" : state?.isCompacting ? "🟣" : "🟢";
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
    title: `${statusEmoji} OmpClaw · ${status}`,
    summary: session,
    sections: [
      { id: "session", label: "Session", text: [contextText, queueText].filter(Boolean).join(" · ") || "Ready" },
      { id: "model", label: "Model", text: model },
      { id: "mode", label: "Mode", text: `${input.autonomyLabel} · ${state?.thinkingLevel ?? "inherit"}` },
      {
        id: "controls",
        label: "Controls",
        text: `Fast ${state?.fastModeEnabled ? "on" : "off"} · Auto-compact ${state?.autoCompactionEnabled ? "on" : "off"}`,
        tone: "muted",
      },
    ],
    actions: [
      { id: "status", label: "📊 Status", command: "/status" },
      { id: "model", label: "🤖 Model", command: "/model" },
      { id: "autonomy", label: "🛡 Autonomy", command: "/autonomy" },
      { id: "thinking", label: "🧠 Reasoning", command: "/thinking" },
      { id: "fast", label: "⚡ Fast mode", command: "/fast" },
      { id: "autocompact", label: "🗜 Auto-compact", command: "/autocompact" },
      { id: "tasks", label: "📋 Tasks", command: "/tasks" },
      { id: "jobs", label: "🗓 Jobs", command: "/jobs" },
      { id: "new", label: "✨ New session", command: "/new", style: "primary" },
      ...(state?.isStreaming ? [{ id: "stop", label: "🛑 Stop", command: "/stop", style: "danger" as const }] : []),
    ],
    updatedAt: input.updatedAt,
  };
}
