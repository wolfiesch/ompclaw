import { describe, expect, test } from "bun:test";
import { telegramUiScenarios } from "./telegram-ui-scenario";

describe("Telegram UI scenario golden", () => {
  test("renders the mobile control surfaces deterministically", () => {
    expect(telegramUiScenarios()).toEqual([
      {
        name: "home",
        text: [
          "🟢 OmpClaw · Idle",
          "",
          "Release planning",
          "",
          "Session",
          "25% context",
          "",
          "Model",
          "openai/gpt-5",
          "",
          "Mode",
          "Balanced · high",
          "",
          "Controls",
          "Fast off · Auto-compact on",
        ].join("\n"),
        buttons: [
          ["📊 Status", "🤖 Model"],
          ["🛡 Autonomy", "🧠 Reasoning"],
          ["⚡ Fast mode", "🗜 Auto-compact"],
          ["📋 Tasks", "🗓 Jobs"],
          ["✨ New session"],
        ],
      },
      {
        name: "reasoning",
        text: [
          "Choose reasoning depth",
          "",
          "Higher levels spend more time on difficult decisions and code.",
          "",
          "Current",
          "High",
        ].join("\n"),
        buttons: [["Low", "Medium"], ["✓ High", "Extra high"], ["Back to Home"]],
      },
      {
        name: "jobs",
        text: [
          "Scheduled jobs",
          "",
          "1 job",
          "",
          "Morning brief",
          "Active",
          "Cron · 0 9 * * * · America/Los_Angeles",
          "Next · 2023-11-14T23:13:20.000Z",
        ].join("\n"),
        buttons: [
          ["Pause · Morning brief", "Run now · Morning brief"],
          ["⚠️ Delete · Morning brief"],
          ["Back to Home"],
        ],
      },
      {
        name: "active-task",
        text: [
          "🟡 Working · 30s",
          "",
          "Prepare the release",
          "",
          "Release",
          "✓ Confirm package contents",
          "● Run release checks",
          "○ Publish package",
          "",
          "Recent activity",
          "✓ Checking release gates",
          "→ Running focused tests",
        ].join("\n"),
        buttons: [["✏️ Add instruction", "➕ Add follow-up"], ["🛑 Stop"]],
      },
    ]);
  });
});
