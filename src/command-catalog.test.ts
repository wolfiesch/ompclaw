import { describe, expect, test } from "bun:test";
import { CommandCatalog } from "./command-catalog";

describe("CommandCatalog", () => {
  test("normalizes gateway, OMP, and skill commands without overriding gateway routing", () => {
    const catalog = new CommandCatalog({
      ompCommands: [
        { name: "/deploy", description: "Ship the current branch", source: "skill" },
        { name: "status", description: "OMP status", source: "builtin" },
        { name: "not valid", description: "Ignored", source: "extension" },
      ],
    });

    expect(catalog.find("deploy")).toEqual({
      name: "deploy",
      description: "Ship the current branch",
      source: "skill",
      visibility: "authorization-required",
      group: "Skills",
    });
    expect(catalog.find("status")).toMatchObject({
      source: "gateway",
      visibility: "authorization-required",
    });
    expect(catalog.find("not valid")).toBeUndefined();
  });

  test("ranks prefix matches before name and description matches while promoting recent commands", () => {
    const catalog = new CommandCatalog({
      ompCommands: [
        { name: "modulate", description: "Tune output", source: "extension" },
        { name: "inspect", description: "View model status", source: "builtin" },
        { name: "viewmodel", description: "View the selected provider", source: "builtin" },
      ],
    });

    expect(catalog.search("model", ["modulate"]).slice(0, 4).map((entry) => entry.name)).toEqual([
      "model",
      "viewmodel",
      "inspect",
    ]);
    expect(catalog.search("mod", ["modulate"]).slice(0, 2).map((entry) => entry.name)).toEqual([
      "modulate",
      "model",
    ]);
  });

  test("marks all discoverable commands as authorization-required", () => {
    const catalog = new CommandCatalog({
      ompCommands: [{ name: "private-skill", description: "Private automation", source: "skill" }],
    });

    expect(catalog.entries().every((entry) => entry.visibility === "authorization-required")).toBe(true);
  });
});
