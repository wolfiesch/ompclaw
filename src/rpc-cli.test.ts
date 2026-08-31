import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadGatewayCliConfig, parseGatewayCliArgs } from "./rpc-cli";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): { configPath: string; envFile: string } {
  const directory = mkdtempSync(join(tmpdir(), "ompclaw-cli-"));
  directories.push(directory);
  const configPath = join(directory, "config.json");
  const envFile = join(directory, "ompclaw.env");
  writeFileSync(configPath, JSON.stringify({
    workspace: directory,
    stateDir: join(directory, "state"),
    transports: {
      telegram: { enabled: true, account: "default", tokenEnv: "TELEGRAM_BOT_TOKEN" },
      websocket: {
        enabled: true,
        hostname: "127.0.0.1",
        port: 0,
        account: "local",
        credentials: [{ tokenEnv: "OMPCLAW_WS_TOKEN", subject: "operator", channel: "local" }],
      },
    },
  }));
  return { configPath, envFile };
}

describe("gateway CLI environment loading", () => {
  test("copies only configured transport credentials from a private env file", () => {
    const { configPath, envFile } = fixture();
    writeFileSync(
      envFile,
      "TELEGRAM_BOT_TOKEN=telegram-secret\nOMPCLAW_WS_TOKEN=websocket-secret\nUNRELATED_SECRET=must-not-load\n",
      { mode: 0o600 },
    );
    const env: NodeJS.ProcessEnv = {};

    const config = loadGatewayCliConfig(
      parseGatewayCliArgs(["doctor", "--config", configPath, "--env-file", envFile]),
      env,
    );

    expect(config.workspace).toBe(dirname(configPath));
    expect(env).toEqual({
      TELEGRAM_BOT_TOKEN: "telegram-secret",
      OMPCLAW_WS_TOKEN: "websocket-secret",
    });
  });

  test("rejects an env file missing a configured credential instead of using ambient state", () => {
    const { configPath, envFile } = fixture();
    writeFileSync(envFile, "TELEGRAM_BOT_TOKEN=telegram-secret\nUNRELATED_SECRET=unused\n", { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { OMPCLAW_WS_TOKEN: "ambient-secret" };
    const args = parseGatewayCliArgs(["run", "--config", configPath, "--env-file", envFile]);

    expect(() => loadGatewayCliConfig(args, env)).toThrow(
      "Environment file does not define required gateway credential OMPCLAW_WS_TOKEN",
    );
    expect(env).toEqual({ OMPCLAW_WS_TOKEN: "ambient-secret" });
  });
});
