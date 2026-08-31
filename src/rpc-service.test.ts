import { describe, expect, test } from "bun:test";
import { renderSystemdUnit } from "./rpc-service";

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
});
