import { type AutonomyMode, ompApprovalModeForAutonomy } from "./rpc-config";
import type { RpcRecord } from "./rpc-protocol";
import { isRecord } from "./type-guards";

export interface RuntimeCommandMenuItem {
  readonly command: string;
  readonly description: string;
}

export type RuntimeCommandGroup = "Everyday" | "Session" | "Work" | "Advanced";

export interface RuntimeCommandDefinition extends RuntimeCommandMenuItem {
  readonly group?: RuntimeCommandGroup;
  readonly native?: boolean;
}

export const RUNTIME_COMMANDS: readonly RuntimeCommandDefinition[] = [
  { command: "start", description: "What this assistant can do", group: "Everyday", native: true },
  { command: "home", description: "Open the control center", group: "Everyday", native: true },
  { command: "status", description: "Show session and runtime details", group: "Everyday", native: true },
  { command: "stop", description: "Stop the current response", group: "Everyday", native: true },
  { command: "new", description: "Start a fresh chat", group: "Everyday", native: true },
  { command: "steer", description: "Correct the current response", group: "Everyday" },
  { command: "followup", description: "Add work after the current response", group: "Everyday" },
  { command: "compact", description: "Compact context with optional focus", group: "Session" },
  { command: "model", description: "List or select provider/model", group: "Session" },
  { command: "permissions", description: "Show or set permissions mode", group: "Session" },
  { command: "autonomy", description: "Show or set autonomy policy", group: "Session" },
  { command: "thinking", description: "Show or set reasoning level", group: "Session" },
  { command: "fast", description: "Show or toggle fast mode", group: "Session" },
  { command: "queue", description: "Inspect or tune queue behavior", group: "Session" },
  { command: "stats", description: "Show session statistics", group: "Session" },
  { command: "todos", description: "Show the current todo phases", group: "Work" },
  { command: "tasks", description: "Show recent persisted task lifecycle", group: "Work", native: true },
  { command: "result", description: "Show a persisted task result", group: "Work", native: true },
  { command: "subagents", description: "Show active and recent subagents", group: "Work" },
  { command: "schedules", description: "List durable scheduled jobs", group: "Work" },
  { command: "schedule", description: "Show schedule details", group: "Work" },
  { command: "jobs", description: "List durable scheduled jobs", group: "Work" },
  { command: "job", description: "Show schedule details", group: "Work" },
  { command: "job_pause", description: "Pause a scheduled job by ID", group: "Work" },
  { command: "job_resume", description: "Resume a scheduled job by ID", group: "Work" },
  { command: "job_run", description: "Run a scheduled job now by ID", group: "Work" },
  { command: "job_delete", description: "Delete a scheduled job by ID", group: "Work" },
  { command: "job_delete_confirm", description: "Confirm deletion of a scheduled job", group: "Work" },
  { command: "commands", description: "List OMP slash commands", group: "Advanced" },
  { command: "history", description: "Show recent conversation messages", group: "Session" },
  { command: "branch", description: "List branch points or branch by entry ID", group: "Advanced" },
  { command: "name", description: "Set the session name", group: "Session" },
  { command: "handoff", description: "Hand context to a fresh session", group: "Advanced" },
  { command: "switch", description: "Switch to an exact session path", group: "Advanced" },
  { command: "export", description: "Export and send the session HTML", group: "Advanced" },
  { command: "retry", description: "Show, toggle, or stop automatic retry", group: "Session" },
  { command: "autocompact", description: "Toggle automatic compaction", group: "Session" },
  { command: "more", description: "Show more session controls and status", group: "Session" },
  { command: "login", description: "Show or start provider login", group: "Advanced" },
  { command: "help", description: "Show all gateway commands", native: true },
];

/** Commands worth publishing through a transport's compact native command menu. */
export function runtimeCommandMenu(allowRpcBash = false): RuntimeCommandMenuItem[] {
  const commands: RuntimeCommandMenuItem[] = RUNTIME_COMMANDS.filter(({ native }) => native === true).map(
    ({ command, description }) => ({ command, description }),
  );
  if (allowRpcBash) {
    commands.push(
      { command: "shell", description: "Execute an OMP RPC bash command" },
      { command: "abortbash", description: "Abort the active RPC bash command" },
    );
  }
  return commands;
}

export const CROSS_DELIVERY_COMMANDS = new Set([
  "start",
  "help",
  "status",
  "more",
  "stop",
  "tasks",
  "result",
  "todos",
  "jobs",
  "job",
  "schedules",
  "schedule",
  "permissions",
]);

export const SAME_DELIVERY_IMMEDIATE_COMMANDS = new Set([
  "start",
  "help",
  "status",
  "more",
  "stop",
  "tasks",
  "result",
  "todos",
  "jobs",
  "job",
  "schedules",
  "schedule",
  "permissions",
  "job_delete_confirm",
  "steer",
  "followup",
  "abortbash",
]);

export interface ParsedCommand {
  readonly name: string;
  readonly args: string;
}

export function parseSlashCommand(text: string | undefined): ParsedCommand | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?\s*$/i.exec(text ?? "");
  if (!match) return undefined;
  return { name: match[1].toLowerCase(), args: match[2]?.trim() ?? "" };
}

export const THINKING_LEVELS: Readonly<Record<string, true>> = {
  inherit: true,
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  auto: true,
};

export { AUTONOMY_MODES, type AutonomyMode, ompApprovalModeForAutonomy, parseAutonomyMode } from "./rpc-config";

export const AUTONOMY_MODE_LABELS: Readonly<Record<AutonomyMode, string>> = {
  inherit: "Inherited",
  autopilot: "Autopilot",
  balanced: "Balanced",
  review: "Review",
};

export const AUTONOMY_MODE_DESCRIPTIONS: Readonly<Record<AutonomyMode, string>> = {
  autopilot: "Full auto-approval for uninterrupted tool execution",
  balanced: "Auto-approves reads; prompts before file writes and commands",
  review: "Prompts before every tool execution",
  inherit: "Preserves OMP's approval configuration without gateway override",
};

export function autonomyText(mode: AutonomyMode, header = "Permissions"): string {
  const approvalMode = ompApprovalModeForAutonomy(mode);
  return [
    `${header}: ${AUTONOMY_MODE_LABELS[mode]} (${mode})`,
    `OMP approval mode: ${approvalMode ?? "inherited (OmpClaw adds no autonomy override; omp.args still apply)"}`,
    "This affects tool approval prompts, not genuine user decisions.",
    "Use /autonomy <mode> to switch modes at runtime.",
  ].join("\n");
}

export function runtimeHelp(allowRpcBash: boolean): string {
  const groups: readonly RuntimeCommandGroup[] = ["Everyday", "Session", "Work", "Advanced"];
  const lines = ["Send a message, voice note, photo, or file whenever you like."];
  for (const group of groups) {
    lines.push(
      "",
      group,
      ...RUNTIME_COMMANDS.filter((entry) => entry.group === group).map(
        ({ command, description }) => `/${command} - ${description}`,
      ),
    );
  }
  if (allowRpcBash) {
    lines.push(
      "",
      "RPC shell",
      "/shell - Execute an OMP RPC bash command",
      "/abortbash - Abort the active RPC bash command",
    );
  }
  lines.push("", "Other available OMP slash commands are passed through to the session.");
  return lines.join("\n");
}

export function assistantWelcome(): string {
  return [
    "Hi. I’m your OMP assistant.",
    "",
    "Send me a message, voice note, photo, or file. I can use your configured OMP tools and skills, keep this conversation across restarts, and ask for approval when an action needs it.",
    "",
    "Quick controls",
    "/home - Open the control center",
    "/stop - Stop the current response",
    "/new - Start a fresh chat",
    "/status - Show technical session details",
    "/help - Show every command",
  ].join("\n");
}

export function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function summarizeMessage(message: unknown): string {
  if (!isRecord(message)) return "";
  const role = typeof message.role === "string" ? message.role : "message";
  const content = message.content;
  if (typeof content === "string") return `${role}: ${content}`;
  if (!Array.isArray(content)) return "";
  const text = content
    .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => String((block as RpcRecord).text))
    .join("");
  return text ? `${role}: ${text}` : "";
}

interface ToolActivity {
  readonly emoji: string;
  readonly label: string;
}

function toolActivity(toolName: string): ToolActivity {
  const name = toolName.toLowerCase();
  if (/(?:browser|web)/.test(name)) return { emoji: "🌐", label: "Browsing the web" };
  if (/(?:memory|mnemopi|retain|remember|recall)/.test(name)) return { emoji: "🧠", label: "Updating memory" };
  if (/(?:read|grep|glob|search|lsp)/.test(name)) return { emoji: "📖", label: "Reviewing context" };
  if (/(?:edit|write|resolve|patch|ast)/.test(name)) return { emoji: "✍️", label: "Making changes" };
  if (/(?:test|check|diagnostic|debug)/.test(name)) return { emoji: "🧪", label: "Checking the result" };
  if (/(?:bash|eval)/.test(name)) return { emoji: "🖥️", label: "Running a command" };
  if (/todo/.test(name)) return { emoji: "📋", label: "Updating the plan" };
  if (/(?:task|agent|hub)/.test(name)) return { emoji: "🧭", label: "Coordinating the work" };
  if (/(?:ask|confirm)/.test(name)) return { emoji: "✋", label: "Waiting for your input" };
  return { emoji: "⚙️", label: "Working" };
}

export function activityForTool(toolName: string): string {
  const activity = toolActivity(toolName);
  return `${activity.emoji} ${activity.label}`;
}
function safePathPreview(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const segments = value.replace(/\\/g, "/").split("/").filter(Boolean);
  const projectRoot = segments.findLastIndex((segment) => ["src", "docs", "test", "tests"].includes(segment));
  const preview = projectRoot >= 0 ? segments.slice(projectRoot).join("/") : segments.at(-1);
  return preview === undefined || preview.length === 0 ? undefined : preview.slice(0, 80);
}

function safeHostPreview(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).hostname || undefined;
  } catch {
    return undefined;
  }
}

function safeToolPreview(toolName: string, args: RpcRecord | undefined): string | undefined {
  const name = toolName.toLowerCase();
  if (/(?:browser|web)/.test(name)) return safeHostPreview(args?.url);
  if (/(?:read|grep|glob|edit|write|resolve|patch|ast|lsp)/.test(name))
    return safePathPreview(args?.path ?? args?.file);
  return undefined;
}

export function conciseActivity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return undefined;
  return text.slice(0, 120);
}

export function activityForFrame(frame: RpcRecord): string {
  const toolName = typeof frame.toolName === "string" ? frame.toolName : undefined;
  if (toolName === undefined) {
    return (
      conciseActivity(frame.intent) ??
      conciseActivity(isRecord(frame.args) ? frame.args.i : undefined) ??
      activityForTool("tool")
    );
  }
  const preview = safeToolPreview(toolName, isRecord(frame.args) ? frame.args : undefined);
  return preview === undefined ? activityForTool(toolName) : `${activityForTool(toolName)} · ${preview}`;
}
