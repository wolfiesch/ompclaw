import { describe, expect, test } from "bun:test";
import {
  activityForFrame,
  activityForTool,
  assistantWelcome,
  autonomyText,
  parseSlashCommand,
  runtimeCommandMenu,
  runtimeHelp,
  summarizeMessage,
  valueText,
} from "./rpc-commands";

describe("rpc-commands", () => {
  test("parses slash command names and arguments", () => {
    expect(parseSlashCommand("/help")).toEqual({ name: "help", args: "" });
    expect(parseSlashCommand("/model openai/gpt-4o")).toEqual({ name: "model", args: "openai/gpt-4o" });
    expect(parseSlashCommand("/thinking high")).toEqual({ name: "thinking", args: "high" });
    expect(parseSlashCommand("not a command")).toBeUndefined();
    expect(parseSlashCommand(undefined)).toBeUndefined();
  });

  test("generates native command menu with optional RPC bash items", () => {
    const defaultMenu = runtimeCommandMenu(false);
    expect(defaultMenu.some((cmd) => cmd.command === "home")).toBe(true);
    expect(defaultMenu.some((cmd) => cmd.command === "shell")).toBe(false);

    const bashMenu = runtimeCommandMenu(true);
    expect(bashMenu.some((cmd) => cmd.command === "shell")).toBe(true);
    expect(bashMenu.some((cmd) => cmd.command === "abortbash")).toBe(true);
  });

  test("formats help text and welcome message", () => {
    const help = runtimeHelp(false);
    expect(help).toContain("/home - Open the control center");
    expect(help).toContain("/model - List or select provider/model");

    const welcome = assistantWelcome();
    expect(welcome).toContain("Hi. I’m your OMP assistant.");
    expect(welcome).toContain("/home - Open the control center");
  });

  test("formats autonomy display text", () => {
    const autopilot = autonomyText("autopilot");
    expect(autopilot).toContain("Autopilot");
    expect(autopilot).toContain("yolo");

    const review = autonomyText("review");
    expect(review).toContain("Review");
    expect(review).toContain("always-ask");
  });

  test("derives descriptive tool activity and frame descriptions", () => {
    expect(activityForTool("read")).toBe("Reviewing context");
    expect(activityForTool("edit")).toBe("Making changes");
    expect(activityForTool("bash")).toBe("Checking the result");
    expect(activityForTool("unknown")).toBe("Working");

    expect(activityForFrame({ intent: "Inspecting configuration" })).toBe("Inspecting configuration");
    expect(activityForFrame({ args: { i: "Running tests" } })).toBe("Running tests");
    expect(activityForFrame({ toolName: "read" })).toBe("Reviewing context");
  });

  test("summarizes messages and values", () => {
    expect(summarizeMessage({ role: "assistant", content: "Done" })).toBe("assistant: Done");
    expect(summarizeMessage({ role: "user", content: [{ type: "text", text: "Hello" }] })).toBe("user: Hello");
    expect(summarizeMessage("invalid")).toBe("");

    expect(valueText("plain")).toBe("plain");
    expect(valueText({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
  });
});
