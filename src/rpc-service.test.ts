import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildManagedServiceArguments,
  buildServiceArguments,
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
});
