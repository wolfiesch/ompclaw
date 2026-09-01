import { describe, expect, test } from "bun:test";
import { telegramUiScenarios } from "./telegram-ui-scenario";

describe("Telegram UI scenario golden", () => {
  test("renders the mobile control surfaces deterministically", () => {
    expect(telegramUiScenarios()).toEqual([
      {
        name: "home",
        text: [
          "OmpClaw control center",
          "[waiting]",
          "",
          "Release planning",
          "",
          "Session",
          "Idle · 25% context",
          "",
          "Model",
          "openai/gpt-5",
          "",
          "Autonomy",
          "Balanced",
          "",
          "Reasoning",
          "high",
          "",
          "Fast mode",
          "[muted] Off",
          "",
          "Auto-compaction",
          "[muted] On",
        ].join("\n"),
        buttons: [
          ["Status", "Model"],
          ["Autonomy", "Reasoning"],
          ["Fast mode", "Auto-compaction"],
          ["Tasks", "Scheduled jobs"],
          ["New session"],
        ],
      },
      {
        name: "reasoning",
        text: [
          "Choose reasoning depth",
          "[waiting]",
          "",
          "Higher levels spend more time on difficult decisions and code.",
          "",
          "Current",
          "[muted] High",
        ].join("\n"),
        buttons: [["Low", "Medium"], ["✓ High", "Extra high"], ["Back to Home"]],
      },
      {
        name: "jobs",
        text: [
          "Scheduled jobs",
          "[waiting]",
          "",
          "1 job",
          "",
          "Morning brief",
          "Active",
          "Cron · 0 9 * * * · America/Los_Angeles",
          "Next · 2023-11-14T23:13:20.000Z",
        ].join("\n"),
        buttons: [["Pause · Morning brief", "Run now · Morning brief"], ["! Delete · Morning brief"], ["Back to Home"]],
      },
      {
        name: "active-task",
        text: [
          "Task",
          "[active]",
          "",
          "Prepare the release",
          "",
          "Status",
          "Working",
          "",
          "Release",
          "✓ Confirm package contents",
          "● Run release checks",
          "○ Publish package",
          "",
          "Activity",
          "[muted] • Checking release gates",
          "• Running focused tests",
        ].join("\n"),
        buttons: [["! Stop"]],
      },
    ]);
  });
});
