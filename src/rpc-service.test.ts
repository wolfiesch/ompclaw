import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseGatewayConfig } from "./gateway-config";
import { gatewayUpdatePaths } from "./gateway-update";
import {
  buildManagedServiceArguments,
  buildServiceArguments,
  prepareServiceArguments,
  renderSystemdUnit,
  replaceFileAtomically,
} from "./rpc-service";

describe("systemd service generation", () => {
  test("escapes WorkingDirectory without quoting the absolute path", () => {
    const unit = renderSystemdUnit(
      {
        workspace: "/home/user/Omp Claw%workspace",
        stateDir: "/home/user/.omp/agent/ompclaw",
      },
      ["/home/user/.bun/bin/ompclaw", "run", "--config", "/home/user/Omp Claw/config.json"],
    );

    expect(unit).toContain("WorkingDirectory=/home/user/Omp\\x20Claw\\x25workspace\n");
    expect(unit).not.toContain('WorkingDirectory="');
    expect(unit).toContain(
      'ExecStart="/home/user/.bun/bin/ompclaw" "run" "--config" "/home/user/Omp Claw/config.json"\n',
    );
  });

  test("uses the package executable without relying on PATH", () => {
    const args = buildServiceArguments({
      configPath: "/home/user/.config/ompclaw/config.json",
      envFile: "/home/user/.config/ompclaw/ompclaw.env",
    });

    expect(isAbsolute(args[0]!)).toBe(true);
    expect(args[0]).toEndWith("/src/rpc-cli.ts");
    expect(args.slice(1)).toEqual([
      "run",
      "--config",
      "/home/user/.config/ompclaw/config.json",
      "--env-file",
      "/home/user/.config/ompclaw/ompclaw.env",
    ]);
  });

  test("runs update-enabled services through the external supervisor", () => {
    const args = buildManagedServiceArguments({
      stateDir: "/home/user/.omp/agent/ompclaw",
      updates: {
        enabled: true,
        repository: "/home/user/Projects/ompclaw",
        healthTimeoutMs: 45_000,
      },
    }, {
      configPath: "/home/user/.config/ompclaw/config.json",
      envFile: "/home/user/.config/ompclaw/ompclaw.env",
    });

    expect(args).toEqual([
      "/home/user/.omp/agent/ompclaw/updates/ompclaw-supervisor",
      "--state-dir",
      "/home/user/.omp/agent/ompclaw",
      "--config",
      "/home/user/.config/ompclaw/config.json",
      "--env-file",
      "/home/user/.config/ompclaw/ompclaw.env",
      "--health-timeout-ms",
      "45000",
    ]);
  });

  test("replaces an existing supervisor through an atomic rename", () => {
    const directory = mkdtempSync(join(tmpdir(), "ompclaw-service-"));
    try {
      const source = join(directory, "candidate");
      const destination = join(directory, "ompclaw-supervisor");
      writeFileSync(source, "candidate");
      writeFileSync(destination, "active");

      replaceFileAtomically(source, destination, 0o700);

      expect(readFileSync(destination, "utf8")).toBe("candidate");
      expect(statSync(destination).mode & 0o777).toBe(0o700);
      expect(readdirSync(directory).sort()).toEqual(["candidate", "ompclaw-supervisor"]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("blocks service bootstrap while an update activation is pending", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ompclaw-service-pending-"));
    try {
      const stateDir = join(directory, "state");
      const updatePaths = gatewayUpdatePaths(stateDir);
      mkdirSync(join(stateDir, "updates"), { recursive: true });
      writeFileSync(updatePaths.request, JSON.stringify({
        schema: 1,
        id: "pending-request",
        status: "committed",
        candidate: {
          id: "0.9.0-candidate",
          commit: "b".repeat(40),
          version: "0.9.0",
          path: join(updatePaths.releases, "0.9.0-candidate"),
        },
        previous: {
          id: "0.8.0-previous",
          commit: "a".repeat(40),
          version: "0.8.0",
          path: join(updatePaths.releases, "0.8.0-previous"),
        },
        origin: {
          address: { transport: "telegram", account: "bot", channel: "42" },
          principal: { id: "operator-42", roles: ["operator"] },
        },
        requestedAt: "2026-09-01T00:00:00.000Z",
        committedAt: "2026-09-01T00:00:01.000Z",
      }));
      const config = parseGatewayConfig({
        workspace: directory,
        stateDir,
        updates: { enabled: true, repository: directory },
      });

      await expect(prepareServiceArguments(config, {
        configPath: join(directory, "config.json"),
        envFile: join(directory, "ompclaw.env"),
      })).rejects.toThrow("while update pending-request is committed");

      expect(readdirSync(updatePaths.releases)).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
