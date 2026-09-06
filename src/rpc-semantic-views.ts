import { createHash } from "node:crypto";
import { formatFriendlyNextRun, formatHumanSchedule } from "./gateway-scheduler";
import type { AutonomyMode } from "./rpc-config";
import type { RpcSessionState } from "./rpc-protocol";
import type { ScheduledJob, TurnLifecycle, TurnTimelineEvent } from "./gateway-store";
import type { ExecutionArtifact, ExecutionCheck, TaskEvidence, TaskExecutionContext } from "./execution-types";
import type { SemanticView, SemanticViewAction, SemanticViewSection, SemanticViewState } from "./gateway-views";

const MAX_SUMMARY_CHARS = 512;
const MAX_ACTIVITY_ITEMS = 4;
const MAX_FAILURE_DETAIL_CHARS = 480;
const MAX_EVIDENCE_FILES = 6;
const MAX_EVIDENCE_CHECKS = 3;
const MAX_EVIDENCE_ARTIFACTS = 3;
const MAX_EVIDENCE_LINE_CHARS = 96;
const MAX_RECEIPT_COMMAND_CHARS = 64;
const MAX_IDENTITY_CHARS = 80;
const MAX_ARTIFACT_NAME_CHARS = 48;
const MAX_ARTIFACT_LABEL_CHARS = 24;

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

export interface HomeActiveTask {
  readonly title: string;
  readonly currentStep?: string;
  readonly startedAt: number;
  readonly taskId?: string;
}

export interface HomeSemanticViewInput {
  readonly state?: RpcSessionState;
  readonly autonomyMode: AutonomyMode;
  readonly autonomyLabel: string;
  readonly activeTask?: HomeActiveTask;
  readonly quickAskArmed?: boolean;
  readonly execution?: TaskExecutionContext;
  readonly evidence?: TaskEvidence;
  readonly version: number;
  readonly updatedAt: number;
}

function boundedSummary(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= MAX_SUMMARY_CHARS) return normalized;
  return `${normalized.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`;
}

function failureDetail(error: string | undefined): string | undefined {
  if (error === undefined) return undefined;
  const normalized = error
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) return undefined;
  return normalized.length <= MAX_FAILURE_DETAIL_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_FAILURE_DETAIL_CHARS - 1).trimEnd()}…`;
}

function failureSummary(error: string | undefined): string {
  const detail = failureDetail(error)?.toLowerCase() ?? "";
  if (/abort|interrupt|restart/.test(detail)) return "The OMP session was interrupted.";
  if (/timed? out|timeout/.test(detail)) return "The task took longer than expected.";
  if (/network|connection|socket|econn|enotfound/.test(detail)) return "The connection to OMP was interrupted.";
  if (/permission|forbidden|not.authorized|unauthor/.test(detail))
    return "OmpClaw did not have permission to finish this task.";
  if (/unavailable|provider/.test(detail)) return "The OMP service was unavailable.";
  return "This task could not finish.";
}

function boundedLine(value: string, max = MAX_EVIDENCE_LINE_CHARS): string {
  const normalized = value.trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function projectIdentity(execution: TaskExecutionContext, evidence?: TaskEvidence): string {
  const target = evidence?.host !== undefined ? `host ${evidence.host}` : `worker ${execution.workerId}`;
  return boundedLine(`${execution.projectName} (${execution.projectId}) · ${target}`, MAX_IDENTITY_CHARS);
}

function humanSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function changedFilesText(files: readonly string[]): string | undefined {
  if (files.length === 0) return undefined;
  const lines = files.slice(0, MAX_EVIDENCE_FILES).map((file) => `• ${boundedLine(file)}`);
  const remaining = files.length - lines.length;
  if (remaining > 0) lines.push(`+${remaining} more file${remaining === 1 ? "" : "s"}`);
  return lines.join("\n");
}

function commandReceiptsText(checks: readonly ExecutionCheck[]): string | undefined {
  if (checks.length === 0) return undefined;
  const lines = checks
    .slice(-MAX_EVIDENCE_CHECKS)
    .map(
      (check) =>
        `${check.exitCode === 0 ? "✓" : "⚠"} ${boundedLine(check.command, MAX_RECEIPT_COMMAND_CHARS)} · exit ${check.exitCode}`,
    );
  const omitted = checks.length - lines.length;
  if (omitted > 0) lines.unshift(`+${omitted} earlier command${omitted === 1 ? "" : "s"}`);
  return lines.join("\n");
}

function artifactsText(artifacts: readonly ExecutionArtifact[]): string {
  const lines = artifacts
    .slice(0, MAX_EVIDENCE_ARTIFACTS)
    .map((artifact) => `• ${boundedLine(artifact.name, MAX_ARTIFACT_NAME_CHARS)} · ${humanSize(artifact.size)}`);
  const remaining = artifacts.length - lines.length;
  if (remaining > 0) lines.push(`+${remaining} more artifact${remaining === 1 ? "" : "s"}`);
  return lines.join("\n");
}

function evidenceSections(evidence: TaskEvidence): readonly SemanticViewSection[] {
  const sections: SemanticViewSection[] = [];
  const changeLines = [
    evidence.revision === undefined
      ? undefined
      : `Revision ${boundedLine(evidence.revision, MAX_RECEIPT_COMMAND_CHARS)}`,
    changedFilesText(evidence.changedFiles),
  ].filter((line): line is string => line !== undefined);
  if (changeLines.length > 0) {
    sections.push({ id: "changes", label: "Changes", text: changeLines.join("\n"), tone: "default" });
  }
  const receipts = commandReceiptsText(evidence.checks);
  if (receipts !== undefined) {
    sections.push({ id: "checks", label: "Command receipts", text: receipts, tone: "default" });
  }
  if (evidence.artifacts.length > 0) {
    sections.push({ id: "artifacts", label: "Artifacts", text: artifactsText(evidence.artifacts), tone: "default" });
  }
  return sections;
}

function evidenceTerminalActions(taskId: string, evidence: TaskEvidence): readonly SemanticViewAction[] {
  const actions: SemanticViewAction[] = [];
  if (evidence.changedFiles.length > 0 || evidence.revision !== undefined) {
    actions.push({ id: "diff", label: "🪶 View diff", command: `/task_diff ${taskId}` });
  }
  evidence.artifacts.slice(0, MAX_EVIDENCE_ARTIFACTS).forEach((artifact, index) => {
    actions.push({
      id: `artifact${index}`,
      label: `⬇️ ${boundedLine(artifact.name, MAX_ARTIFACT_LABEL_CHARS)}`,
      command: `/task_artifact ${taskId} ${artifact.id}`,
    });
  });
  return actions;
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
  detailsExpanded = false,
  now: number = Date.now(),
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
  const failure = lifecycle.state === "failed" || lifecycle.error !== undefined;
  const detail = failureDetail(lifecycle.error);
  const scoped = lifecycle.execution !== undefined;
  const recoveryActions = failure
    ? scoped
      ? [
          { id: "recover_inspect", label: "🔎 Inspect", command: `/task_recover ${lifecycle.id} inspect` },
          { id: "recover_continue", label: "▶️ Continue", command: `/task_recover ${lifecycle.id} continue` },
          {
            id: "recover_restart",
            label: "↻ Restart",
            command: `/task_recover ${lifecycle.id} restart`,
            style: "danger" as const,
          },
        ]
      : [{ id: "retry", label: "↻ Recover", command: `/task_retry ${lifecycle.id}`, style: "primary" as const }]
    : [];
  const recoverySupport = failure
    ? [
        {
          id: "details",
          label: detailsExpanded ? "Hide details" : "🔍 View details",
          command: `/task_details ${lifecycle.id}${detailsExpanded ? " hide" : ""}`,
        },
        { id: "tasks", label: "📋 Open task", command: "/tasks" },
        { id: "fresh", label: "✨ New session", command: "/new" },
      ]
    : [];
  const terminalActions = [
    { id: "result", label: "📄 View result", command: `/result ${lifecycle.id}`, style: "primary" as const },
    {
      id: "continue",
      label: "➕ Continue",
      input: {
        title: "Continue this task",
        prompt: "Reply with the work to do next.",
        command: "/task_continue",
        argument: lifecycle.id,
      },
    },
    {
      id: "revise",
      label: "✏️ Revise",
      input: {
        title: "Revise this result",
        prompt: "Reply with what should change.",
        command: "/task_revise",
        argument: lifecycle.id,
      },
    },
    ...(lifecycle.evidence !== undefined ? evidenceTerminalActions(lifecycle.id, lifecycle.evidence) : []),
    ...recoveryActions,
    ...recoverySupport,
  ];
  const identitySections: readonly SemanticViewSection[] =
    lifecycle.execution === undefined
      ? []
      : [
          {
            id: "project",
            label: "Project",
            text: projectIdentity(lifecycle.execution, lifecycle.evidence),
            tone: "default",
          },
        ];
  const receiptSections: readonly SemanticViewSection[] =
    lifecycle.evidence === undefined ? [] : evidenceSections(lifecycle.evidence);
  const recoverySections: readonly SemanticViewSection[] = [
    ...(lifecycle.recoveryOf === undefined
      ? []
      : [
          {
            id: "recovery",
            label: "Recovery",
            text: `Recovered from task ${boundedLine(lifecycle.recoveryOf, 48)}.`,
            tone: "muted" as const,
          },
        ]),
    ...(lifecycle.execution !== undefined && lifecycle.state !== "completed" && now > lifecycle.execution.expiresAt
      ? [
          {
            id: "expired",
            label: "Authorization",
            text: "Project authorization expired — recovery needs a new grant.",
            tone: "warning" as const,
          },
        ]
      : []),
  ];
  return {
    schemaVersion: 1,
    id: `task_${createHash("sha256").update(lifecycle.id).digest("hex").slice(0, 19)}`,
    kind: terminal ? "result" : "task",
    version,
    state: taskState(lifecycle.state),
    title: taskTitle(lifecycle, heartbeat),
    summary: boundedSummary(lifecycle.prompt),
    sections: [
      ...identitySections,
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
      ...receiptSections,
      ...recoverySections,
      ...(failure
        ? [{ id: "error", label: "What happened", text: failureSummary(lifecycle.error), tone: "danger" as const }]
        : []),
      ...(detailsExpanded && detail !== undefined
        ? [{ id: "details", label: "Details", text: detail, tone: "muted" as const }]
        : []),
    ],
    actions: terminal
      ? terminalActions
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
      const execution = entry.lifecycle.execution;
      const host = entry.lifecycle.evidence?.host;
      return {
        id: `task${index}`,
        label: `${taskHistoryState(entry.lifecycle.state)} · ${boundedSummary(entry.lifecycle.prompt).slice(0, 80)}`,
        text:
          [
            execution === undefined
              ? undefined
              : `Project · ${boundedLine(execution.projectName, 48)}${
                  host === undefined ? "" : ` · host ${boundedLine(host, 48)}`
                }`,
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
                id: entry.lifecycle.execution === undefined ? `retry${index}` : `recover${index}`,
                label: `Recover · ${boundedSummary(entry.lifecycle.prompt).slice(0, 32)}`,
                command:
                  entry.lifecycle.execution === undefined
                    ? `/task_retry ${entry.lifecycle.id}`
                    : `/task_recover ${entry.lifecycle.id} inspect`,
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

export function modelDisplayName(id: string): string {
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

export function friendlyModelName(model?: { provider?: string; id?: string }): string {
  if (!model?.id) return model?.provider ?? "Unknown model";
  const name = modelDisplayName(model.id);
  return name.replace(/\bGPT (\d+)\b/g, "GPT-$1");
}

export function reasoningLabel(level?: string): string {
  if (!level || level === "inherit") return "Inherited reasoning";
  if (level === "off") return "Reasoning off";
  if (level === "xhigh") return "Extra high reasoning";
  return `${level[0]?.toUpperCase()}${level.slice(1)} reasoning`;
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
    title: "🗓 Schedules",
    summary:
      jobs.length === 0
        ? "No scheduled jobs"
        : `${jobs.length} schedule${jobs.length === 1 ? "" : "s"}${jobs.length > visible.length ? ` · showing ${visible.length}` : ""}`,
    sections: visible.map((job, index) => {
      const timezone = job.schedule.kind === "cron" ? job.schedule.timezone : undefined;
      return {
        id: `job${index}`,
        label: `${job.enabled ? "🟢" : "⏸"} ${job.name}`,
        text: [
          `Next: ${formatFriendlyNextRun(job.nextRunAt, updatedAt, timezone, job.enabled)}`,
          job.lastError === undefined ? undefined : `Last error: ${boundedSummary(job.lastError)}`,
        ]
          .filter(Boolean)
          .join("\n"),
        tone: job.lastError === undefined ? (job.enabled ? "default" : "muted") : "danger",
      };
    }),
    actions: [
      ...visible.map((job, index) => ({
        id: `job${index}`,
        label: boundedSummary(job.name).slice(0, 32),
        command: `/job ${job.id}`,
      })),
      {
        id: "create",
        label: "Create schedule",
        input: {
          title: "Create schedule",
          prompt: "Reply with what you want to schedule (e.g. 'Every morning at 9am summarize PRs').",
          command: "/schedule_create",
        },
      },
      { id: "home", label: "← Home", command: "/home" },
    ],
    updatedAt,
  };
}

export function scheduledJobDetailSemanticView(job: ScheduledJob, version: number, updatedAt: number): SemanticView {
  return {
    schemaVersion: 1,
    id: "home",
    kind: "decision",
    version,
    state: "waiting",
    title: `${job.enabled ? "🟢" : "⏸"} ${job.name}`,
    summary: job.prompt ? boundedSummary(job.prompt) : "Schedule details",
    sections: [
      { id: "schedule", label: "Schedule", text: formatHumanSchedule(job.schedule) },
      {
        id: "next",
        label: "Next run",
        text: formatFriendlyNextRun(
          job.nextRunAt,
          updatedAt,
          job.schedule.kind === "cron" ? job.schedule.timezone : undefined,
          job.enabled,
        ),
      },
      {
        id: "status",
        label: "Status",
        text: `${job.enabled ? "Active" : "Paused"} · ${job.successCount} succeeded, ${job.failureCount} failed`,
      },
      ...(job.lastError === undefined
        ? []
        : [{ id: "error", label: "Last error", text: boundedSummary(job.lastError), tone: "danger" as const }]),
    ],
    actions: [
      { id: "run", label: "Run now", command: `/job_run ${job.id}`, style: "primary" as const },
      {
        id: job.enabled ? "pause" : "resume",
        label: job.enabled ? "Pause" : "Resume",
        command: `/${job.enabled ? "job_pause" : "job_resume"} ${job.id}`,
      },
      {
        id: "edit",
        label: "Edit",
        input: {
          title: `Edit ${job.name}`,
          prompt: "Reply with the updated schedule instructions or cron expression.",
          command: "/job_edit",
        },
      },
      { id: "delete", label: "Delete", command: `/job_delete_confirm ${job.id}`, style: "danger" as const },
      { id: "back", label: "← Back", command: "/schedules" },
    ],
    updatedAt,
  };
}

export function scheduledJobDeleteConfirmSemanticView(
  job: ScheduledJob,
  version: number,
  updatedAt: number,
): SemanticView {
  return {
    schemaVersion: 1,
    id: "home",
    kind: "decision",
    version,
    state: "waiting",
    title: "Delete schedule?",
    summary: `Delete "${job.name}" permanently?`,
    sections: [
      {
        id: "warning",
        text: "This schedule will be permanently deleted.",
        tone: "danger",
      },
    ],
    actions: [
      { id: "delete", label: "Delete schedule", command: `/job_delete ${job.id}`, style: "danger" as const },
      { id: "cancel", label: "Cancel", command: `/job ${job.id}` },
    ],
    updatedAt,
  };
}

export function scheduledJobDeleteSettledSemanticView(
  jobName: string,
  version: number,
  updatedAt: number,
): SemanticView {
  return {
    schemaVersion: 1,
    id: "home",
    kind: "decision",
    version,
    state: "completed",
    title: "Delete schedule?",
    summary: `"${jobName}" has been deleted.`,
    sections: [{ id: "settled", text: "✅ Deleted", tone: "success" as const }],
    actions: [
      { id: "schedules", label: "🗓 Schedules", command: "/schedules" },
      { id: "home", label: "Back to Home", command: "/home" },
    ],
    updatedAt,
  };
}

export function homeSemanticView(input: HomeSemanticViewInput): SemanticView {
  const state = input.state;
  const isBusy = input.activeTask !== undefined || state?.isStreaming === true;
  if (isBusy) {
    const startedAt = input.activeTask?.startedAt ?? input.updatedAt;
    const elapsed = elapsedText(startedAt, input.updatedAt);
    const title = input.activeTask?.title || state?.sessionName?.trim() || "Active task";
    return {
      schemaVersion: 1,
      id: "home",
      kind: "home",
      version: input.version,
      state: "active",
      title: `🟡 Working · ${elapsed}`,
      summary: title,
      sections: [
        ...(input.execution === undefined
          ? []
          : [
              {
                id: "project",
                label: "Project",
                text: projectIdentity(input.execution, input.evidence),
                tone: "default" as const,
              },
            ]),
        ...(input.activeTask?.currentStep ? [{ id: "step", text: input.activeTask.currentStep }] : []),
      ],
      actions: [
        { id: "tasks", label: "📋 Open task", command: "/tasks" },
        {
          id: "quick-arm",
          label: input.quickAskArmed ? "⚡ Quick ask armed — send your question" : "⚡ Quick ask",
          command: "/quick-arm",
        },
        { id: "stop", label: "🛑 Stop", command: "/stop", style: "danger" as const },
      ],
      updatedAt: input.updatedAt,
    };
  }

  const session = state?.sessionName?.trim() || state?.sessionId || "New session";
  const modelName = friendlyModelName(state?.model);
  const reasoning = reasoningLabel(state?.thinkingLevel);
  return {
    schemaVersion: 1,
    id: "home",
    kind: "home",
    version: input.version,
    state: "waiting",
    title: "🟢 Ready",
    summary: session,
    sections: [
      ...(input.execution === undefined
        ? [
            {
              id: "workspace",
              label: "Workspace",
              text: "Default workspace; no project task is selected.",
              tone: "muted" as const,
            },
          ]
        : [
            {
              id: "project",
              label: "Project",
              text: projectIdentity(input.execution, input.evidence),
              tone: "default" as const,
            },
          ]),
      {
        id: "settings",
        text: `${modelName} · ${reasoning}\nPermissions: ${input.autonomyLabel}`,
      },
    ],
    actions: [
      { id: "new", label: "✨ New session", command: "/new", style: "primary" as const },
      { id: "model", label: "🤖 Model", command: "/model" },
      { id: "permissions", label: "🛡 Permissions", command: "/permissions" },
      { id: "thinking", label: "🧠 Reasoning", command: "/thinking" },
      { id: "tasks", label: "📋 Tasks", command: "/tasks" },
      { id: "schedules", label: "🗓 Schedules", command: "/schedules" },
      { id: "fast", label: state?.fastModeEnabled ? "⚡ Fast: On" : "⚡ Fast: Off", command: "/fast" },
      { id: "more", label: "⚙️ More", command: "/more" },
    ],
    updatedAt: input.updatedAt,
  };
}

export function moreSemanticView(input: HomeSemanticViewInput): SemanticView {
  const state = input.state;
  const session = state?.sessionName?.trim() || state?.sessionId || "New session";
  const context = state?.contextUsage?.percent;
  const contextPercent =
    typeof context === "number" && Number.isFinite(context) ? `${Math.round(context)}% context` : "Context: unknown";
  const tokens = state?.contextUsage?.tokens;
  const contextWindow = state?.contextUsage?.contextWindow;
  const contextDetails =
    tokens != null && contextWindow != null
      ? ` (${tokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens)`
      : "";
  const queueText = `${state?.queuedMessageCount ?? 0} queued`;
  return {
    schemaVersion: 1,
    id: "home",
    kind: "decision",
    version: input.version,
    state: "waiting",
    title: "⚙️ More",
    summary: session,
    sections: [
      { id: "context", label: "Context", text: `${contextPercent}${contextDetails}` },
      {
        id: "history",
        label: "History",
        text: "This chat keeps its Telegram history; /new starts a fresh agent session here.",
      },
      { id: "autocompact", label: "Auto-compact", text: state?.autoCompactionEnabled ? "Enabled" : "Disabled" },
      { id: "queue", label: "Queue", text: queueText },
      { id: "session", label: "Session ID", text: state?.sessionId ?? "None" },
    ],
    actions: [
      {
        id: "autocompact",
        label: state?.autoCompactionEnabled ? "🗜 Auto-compact: On" : "🗜 Auto-compact: Off",
        command: "/autocompact",
      },
      { id: "home", label: "← Home", command: "/home" },
    ],
    updatedAt: input.updatedAt,
  };
}
