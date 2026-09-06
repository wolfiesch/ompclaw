import { describe, expect, test } from "bun:test";
import { GatewayProjectRouter, formatProjectResolution, type GatewayProjectCheckpointStore } from "./gateway-projects";
import type { JsonValue } from "./gateway-store";
import type { InboundMessage, Principal } from "./gateway-types";

const operator: Principal = { id: "operator", roles: ["operator"] };
const guest: Principal = { id: "guest", roles: ["guest"] };

class MemoryCheckpoints implements GatewayProjectCheckpointStore {
  readonly values = new Map<string, JsonValue>();

  getCheckpoint(adapter: string, key: string): JsonValue | undefined {
    return this.values.get(`${adapter}\u0000${key}`);
  }

  setCheckpoint(adapter: string, key: string, value: JsonValue): void {
    this.values.set(`${adapter}\u0000${key}`, value);
  }
}

function message(id: string, principal: Principal = operator, text = "work"): InboundMessage {
  return {
    id,
    sentAt: 1,
    identity: { transport: "telegram", account: "bot", subject: principal.id },
    address: { transport: "telegram", account: "bot", channel: principal.id },
    content: { text },
    principal,
  };
}

function router(store = new MemoryCheckpoints(), now = () => 1_000): GatewayProjectRouter {
  return new GatewayProjectRouter({
    store,
    now,
    projects: [
      {
        id: "alpha",
        name: "Alpha",
        workspace: "/srv/alpha",
        workerId: "local",
        principals: ["operator"],
        policy: { write: true, commands: true, network: true, maxDurationMs: 600_000 },
        model: "project-model",
      },
      {
        id: "beta",
        name: "Beta",
        workspace: "/srv/beta",
        workerId: "local",
        principals: ["operator"],
        policy: { write: false, commands: false, network: false, maxDurationMs: 60_000 },
      },
    ],
  });
}

describe("GatewayProjectRouter", () => {
  test("keeps distinct conversations on their own configured project session after restart", () => {
    const store = new MemoryCheckpoints();
    const first = router(store);
    const alpha = message("select-alpha", operator, "/project alpha");
    const beta = {
      ...message("select-beta", operator, "/project beta"),
      address: { transport: "telegram", account: "bot", channel: "other" },
    };
    const alphaSelection = first.select(alpha, "alpha");
    const betaSelection = first.select(beta, "beta");
    expect(alphaSelection.kind).toBe("selected");
    expect(betaSelection.kind).toBe("selected");
    if (alphaSelection.kind !== "selected" || betaSelection.kind !== "selected") throw new Error("selection failed");
    first.checkpointSession(alpha, alphaSelection.selection, "/sessions/alpha.jsonl");
    first.checkpointSession(beta, betaSelection.selection, "/sessions/beta.jsonl");

    const restarted = router(store);
    const resumedAlpha = restarted.resolve(message("alpha-work"));
    const resumedBeta = restarted.resolve({ ...message("beta-work"), address: beta.address });
    expect(resumedAlpha).toMatchObject({
      kind: "selected",
      selection: {
        context: { projectId: "alpha", workspace: "/srv/alpha", model: "project-model" },
        sessionFile: "/sessions/alpha.jsonl",
      },
    });
    expect(resumedBeta).toMatchObject({
      kind: "selected",
      selection: { context: { projectId: "beta", workspace: "/srv/beta" }, sessionFile: "/sessions/beta.jsonl" },
    });
  });

  test("refuses an unauthorized or reconfigured persisted binding", () => {
    const store = new MemoryCheckpoints();
    const initial = router(store);
    const request = message("select", operator, "/project alpha");
    expect(initial.select(request, "alpha").kind).toBe("selected");
    expect(
      initial.resolve({ ...request, principal: guest, identity: { ...request.identity, subject: guest.id } }),
    ).toMatchObject({ kind: "none" });

    const changed = new GatewayProjectRouter({
      store,
      projects: [
        {
          id: "alpha",
          name: "Alpha",
          workspace: "/other",
          workerId: "local",
          principals: ["operator"],
          policy: { write: true, commands: true, network: true, maxDurationMs: 600_000 },
        },
      ],
    });
    const resolution = changed.resolve(message("after-reconfigure"));
    expect(resolution).toMatchObject({ kind: "unavailable", projectId: "alpha", reason: "reconfigured" });
    expect(formatProjectResolution(resolution)).toContain("must be selected again");
  });

  test("makes queued task context immutable across a later project rebind", () => {
    const projects = router();
    const selection = message("select", operator, "/project alpha");
    expect(projects.select(selection, "alpha").kind).toBe("selected");
    const capture = projects.captureTask(message("queued"));
    expect(capture.resolution.kind).toBe("selected");
    if (capture.resolution.kind !== "selected") throw new Error("capture failed");
    const queued = { ...message("queued"), execution: capture.resolution.selection.context };
    expect(projects.select(selection, "beta").kind).toBe("selected");
    expect(projects.resolveCaptured(queued)).toMatchObject({
      kind: "unavailable",
      projectId: "alpha",
      reason: "reconfigured",
    });
  });

  test("narrows scope once without escalation and leaves queued scope immutable", () => {
    const store = new MemoryCheckpoints();
    const projects = router(store);
    const selected = message("select", operator, "/project alpha");
    expect(projects.select(selected, "alpha").kind).toBe("selected");
    expect(projects.setNextScope(selected, "read", 5)).toEqual({
      text: "Next task scope: read (5 minute(s) maximum).",
    });
    const capture = projects.captureTask(message("scoped"));
    expect(capture.scopeClaim).toBeDefined();
    expect(capture.resolution).toMatchObject({
      kind: "selected",
      selection: { context: { policy: { write: false, commands: false, network: false, maxDurationMs: 300_000 } } },
    });
    expect(projects.setNextScope(selected, "network", 11)).toEqual({
      text: "Scope duration cannot exceed 10 minute(s).",
    });
    expect(projects.scopeStatus(selected)).toContain("Next task grant: read");
  });

  test("fails closed when a captured task grant expires", () => {
    const store = new MemoryCheckpoints();
    let now = 1_000;
    const projects = router(store, () => now);
    const selected = message("select", operator, "/project alpha");
    projects.select(selected, "alpha");
    const captured = projects.captureTask(message("queued"));
    if (captured.resolution.kind !== "selected") throw new Error("capture failed");
    now = captured.resolution.selection.context.expiresAt;
    expect(
      projects.resolveCaptured({ ...message("queued"), execution: captured.resolution.selection.context }),
    ).toMatchObject({ kind: "unavailable", reason: "expired" });
  });
});
