import { createHash } from "node:crypto";
import type { AutonomyMode } from "./rpc-config";
import type { RpcSessionState } from "./rpc-protocol";
import type { TurnLifecycle } from "./gateway-store";
import type { SemanticView, SemanticViewState } from "./gateway-views";

const MAX_SUMMARY_CHARS = 512;
const MAX_ACTIVITY_ITEMS = 8;

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
