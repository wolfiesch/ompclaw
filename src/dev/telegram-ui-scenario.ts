import {
  homeSemanticView,
  modelPageSemanticView,
  modelProviderSemanticView,
  moreSemanticView,
  scheduledJobDeleteConfirmSemanticView,
  scheduledJobDeleteSettledSemanticView,
  scheduledJobDetailSemanticView,
  scheduledJobsSemanticView,
  sessionChoiceSemanticView,
  taskSemanticView,
} from "../rpc-semantic-views";
import { renderDecisionCard, type TelegramCardRender } from "../transports/telegram/cards";
import { renderTelegramSemanticView } from "../transports/telegram/semantic-views";
import type { SemanticView } from "../gateway-views";

export interface TelegramUiScenario {
  readonly name: string;
  readonly text: string;
  readonly buttons: readonly (readonly string[])[];
}

function scenario(name: string, view: SemanticView): TelegramUiScenario {
  const rendered = renderTelegramSemanticView(view);
  return {
    name,
    text: rendered.text,
    buttons: rendered.replyMarkup.inline_keyboard.map((row) => row.map((button) => button.text)),
  };
}

function cardScenario(name: string, rendered: TelegramCardRender): TelegramUiScenario {
  return {
    name,
    text: rendered.text,
    buttons: rendered.inlineKeyboard.map((row) => row.map((button) => button.text)),
  };
}

/** Deterministic mobile UI fixtures. No Telegram credentials or network access required. */
export function telegramUiScenarios(): readonly TelegramUiScenario[] {
  const version = 1_700_000_000_000;
  const address = { transport: "telegram", account: "primary", channel: "42" } as const;
  return [
    scenario(
      "home",
      homeSemanticView({
        state: {
          sessionId: "session-42",
          sessionName: "Release planning",
          isStreaming: false,
          isCompacting: false,
          model: { provider: "openai", id: "gpt-5" },
          thinkingLevel: "high",
          fastModeEnabled: false,
          autoCompactionEnabled: true,
          contextUsage: { tokens: 32_000, contextWindow: 128_000, percent: 25 },
        },
        autonomyMode: "balanced",
        autonomyLabel: "Balanced",
        version,
        updatedAt: version,
      }),
    ),
    scenario(
      "home-busy",
      homeSemanticView({
        state: {
          sessionId: "session-42",
          sessionName: "Release planning",
          isStreaming: true,
          isCompacting: false,
        },
        activeTask: {
          title: "Prepare the release",
          startedAt: version - 35_000,
          currentStep: "Running focused tests",
        },
        autonomyMode: "balanced",
        autonomyLabel: "Balanced",
        version,
        updatedAt: version,
      }),
    ),
    scenario(
      "more",
      moreSemanticView({
        state: {
          sessionId: "session-42",
          sessionName: "Release planning",
          isStreaming: false,
          isCompacting: false,
          model: { provider: "openai", id: "gpt-5" },
          thinkingLevel: "high",
          fastModeEnabled: false,
          autoCompactionEnabled: true,
          contextUsage: { tokens: 32_000, contextWindow: 128_000, percent: 25 },
          queuedMessageCount: 0,
        },
        autonomyMode: "balanced",
        autonomyLabel: "Balanced",
        version,
        updatedAt: version,
      }),
    ),
    scenario(
      "reasoning",
      sessionChoiceSemanticView({
        title: "Choose reasoning depth",
        summary: "Higher levels spend more time on difficult decisions and code.",
        choices: [
          { id: "low", label: "Low", command: "/thinking low" },
          { id: "medium", label: "Medium", command: "/thinking medium" },
          { id: "high", label: "High", command: "/thinking high", selected: true },
          { id: "xhigh", label: "Extra high", command: "/thinking xhigh" },
        ],
        version,
        updatedAt: version,
      }),
    ),
    scenario(
      "model-providers",
      modelProviderSemanticView({
        models: [
          { provider: "OpenAI", id: "gpt-5" },
          { provider: "OpenAI", id: "gpt-5-mini" },
          { provider: "Anthropic", id: "claude-sonnet-4" },
        ],
        current: { provider: "OpenAI", id: "gpt-5" },
        version,
        updatedAt: version,
      }),
    ),
    scenario(
      "model-page-1",
      modelPageSemanticView({
        models: Array.from({ length: 10 }, (_, index) => ({
          provider: "OpenAI",
          id: `gpt-5-${index + 1}`,
        })),
        current: { provider: "OpenAI", id: "gpt-5-1" },
        provider: "OpenAI",
        page: 0,
        pageSize: 8,
        version,
        updatedAt: version,
      }),
    ),
    scenario(
      "model-page-2-selected",
      modelPageSemanticView({
        models: Array.from({ length: 10 }, (_, index) => ({
          provider: "OpenAI",
          id: `gpt-5-${index + 1}`,
        })),
        current: { provider: "OpenAI", id: "gpt-5-9" },
        provider: "OpenAI",
        page: 1,
        pageSize: 8,
        version: version + 1,
        updatedAt: version + 1,
      }),
    ),
    scenario(
      "schedules-list",
      scheduledJobsSemanticView(
        [
          {
            id: "morning-brief",
            principalId: "operator",
            identity: { transport: "telegram", account: "primary", subject: "42" },
            address,
            name: "Morning brief",
            prompt: "Summarize overnight changes",
            schedule: { kind: "cron", expression: "0 9 * * *", timezone: "America/Los_Angeles" },
            enabled: true,
            nextRunAt: version + 3_600_000,
            attemptCount: 0,
            successCount: 4,
            failureCount: 0,
            createdAt: version - 86_400_000,
            updatedAt: version,
          },
          {
            id: "exotic-sync",
            principalId: "operator",
            identity: { transport: "telegram", account: "primary", subject: "42" },
            address,
            name: "Exotic sync",
            prompt: "Sync mid-month stats",
            schedule: { kind: "cron", expression: "23 4 1,15 * 2", timezone: "America/Los_Angeles" },
            enabled: false,
            nextRunAt: undefined,
            attemptCount: 1,
            successCount: 1,
            failureCount: 1,
            lastError: "Gateway unavailable",
            createdAt: version - 86_400_000,
            updatedAt: version,
          },
        ],
        version,
        version,
      ),
    ),
    scenario(
      "schedule-detail",
      scheduledJobDetailSemanticView(
        {
          id: "morning-brief",
          principalId: "operator",
          identity: { transport: "telegram", account: "primary", subject: "42" },
          address,
          name: "Morning brief",
          prompt: "Summarize overnight changes",
          schedule: { kind: "cron", expression: "0 9 * * *", timezone: "America/Los_Angeles" },
          enabled: true,
          nextRunAt: version + 3_600_000,
          attemptCount: 0,
          successCount: 4,
          failureCount: 0,
          createdAt: version - 86_400_000,
          updatedAt: version,
        },
        version,
        version,
      ),
    ),
    scenario(
      "schedule-detail-exotic",
      scheduledJobDetailSemanticView(
        {
          id: "exotic-sync",
          principalId: "operator",
          identity: { transport: "telegram", account: "primary", subject: "42" },
          address,
          name: "Exotic sync",
          prompt: "Sync mid-month stats",
          schedule: { kind: "cron", expression: "23 4 1,15 * 2", timezone: "America/Los_Angeles" },
          enabled: false,
          nextRunAt: undefined,
          attemptCount: 1,
          successCount: 1,
          failureCount: 1,
          lastError: "Gateway unavailable",
          createdAt: version - 86_400_000,
          updatedAt: version,
        },
        version,
        version,
      ),
    ),
    scenario(
      "schedule-delete-confirm",
      scheduledJobDeleteConfirmSemanticView(
        {
          id: "morning-brief",
          principalId: "operator",
          identity: { transport: "telegram", account: "primary", subject: "42" },
          address,
          name: "Morning brief",
          prompt: "Summarize overnight changes",
          schedule: { kind: "cron", expression: "0 9 * * *", timezone: "America/Los_Angeles" },
          enabled: true,
          nextRunAt: version + 3_600_000,
          attemptCount: 0,
          successCount: 4,
          failureCount: 0,
          createdAt: version - 86_400_000,
          updatedAt: version,
        },
        version,
        version,
      ),
    ),
    scenario(
      "schedule-delete-settled",
      scheduledJobDeleteSettledSemanticView("Morning brief", version, version),
    ),
    scenario(
      "active-task",
      taskSemanticView(
        {
          id: "turn-1",
          principalId: "operator",
          address,
          prompt: "Prepare the release",
          state: "running",
          currentTool: "bash",
          createdAt: version - 30_000,
          updatedAt: version,
        },
        [
          { text: "Checking release gates", state: "completed" },
          { text: "Running focused tests", state: "active" },
        ],
        version,
        [
          {
            name: "Release",
            tasks: [
              { content: "Confirm package contents", status: "completed" },
              { content: "Run release checks", status: "in_progress" },
              { content: "Publish package", status: "pending" },
            ],
          },
        ],
      ),
    ),
    scenario(
      "failed-task",
      taskSemanticView(
        {
          id: "turn-failed",
          principalId: "operator",
          address,
          prompt: "Deploy the release",
          state: "failed",
          createdAt: version - 30_000,
          updatedAt: version,
          finishedAt: version,
          error: "Provider socket timed out\n    at transport.send (rpc.ts:44)",
        },
        [{ text: "Deploying the selected build", state: "active" }],
        version,
      ),
    ),
    scenario(
      "failed-task-details",
      taskSemanticView(
        {
          id: "turn-failed",
          principalId: "operator",
          address,
          prompt: "Deploy the release",
          state: "failed",
          createdAt: version - 30_000,
          updatedAt: version,
          finishedAt: version,
          error: "Provider socket timed out\n    at transport.send (rpc.ts:44)",
        },
        [{ text: "Deploying the selected build", state: "active" }],
        version + 1,
        [],
        false,
        true,
      ),
    ),
    cardScenario(
      "decision-approved",
      renderDecisionCard(
        {
          title: "Approve deployment",
          preview: "Deploy the selected build?",
          choices: [],
          state: "approved",
          settledLabel: "✅ Approved once",
        },
        (action) => action,
      ),
    ),
    cardScenario(
      "decision-denied",
      renderDecisionCard(
        {
          title: "Approve deployment",
          preview: "Deploy the selected build?",
          choices: [],
          state: "denied",
        },
        (action) => action,
      ),
    ),
    cardScenario(
      "decision-expired",
      renderDecisionCard(
        {
          title: "Approve deployment",
          preview: "Deploy the selected build?",
          choices: [],
          state: "expired",
        },
        (action) => action,
      ),
    ),
  ];
}

if (import.meta.main) console.log(JSON.stringify(telegramUiScenarios(), null, 2));
