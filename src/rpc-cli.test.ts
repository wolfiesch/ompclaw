import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  doctor,
  executeGatewayCommand,
  loadGatewayCliConfig,
  pairingApprove,
  pairingClear,
  pairingList,
  pairingListen,
  parseGatewayCliArgs,
} from "./rpc-cli";

const directories: string[] = [];
const originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (originalTelegramToken === undefined) {
    delete process.env.TELEGRAM_BOT_TOKEN;
  } else {
    process.env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
  }
});

function fixture(): { configPath: string; envFile: string } {
  const directory = mkdtempSync(join(tmpdir(), "ompclaw-cli-"));
  directories.push(directory);
  const configPath = join(directory, "config.json");
  const envFile = join(directory, "ompclaw.env");
  writeFileSync(
    configPath,
    JSON.stringify({
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
    }),
  );
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

describe("gateway pairing commands", () => {
  test("discovers, lists, approves, and clears a pairing request without listing its code", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ompclaw-pairing-cli-"));
    directories.push(directory);
    const stateDir = join(directory, "state");
    mkdirSync(stateDir);
    const configPath = join(directory, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        workspace: directory,
        stateDir,
        transports: {
          telegram: { enabled: true, account: "default", tokenEnv: "TELEGRAM_BOT_TOKEN" },
        },
      }),
    );
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const config = loadGatewayCliConfig(parseGatewayCliArgs(["pairing-list", "--config", configPath]));
    const now = 1_000;

    const created = await pairingListen(config, [], {
      now: () => now,
      listenForFirstTelegramUser: async () => ({
        identity: { transport: "telegram", account: "default", subject: "42" },
        address: { transport: "telegram", account: "default", channel: "42" },
        displayLabel: "Alice (@alice)",
        updateId: 7,
      }),
    });
    expect(created.code).toMatch(/^[A-Z0-9-]+$/);
    expect(created.candidate.displayLabel).toBe("Alice (@alice)");
    expect(pairingList(config, [], { now: () => now })).toEqual([
      expect.objectContaining({
        state: "pending",
        identity: { transport: "telegram", account: "default", subject: "42" },
      }),
    ]);
    expect(JSON.stringify(pairingList(config, [], { now: () => now }))).not.toContain(created.code);

    const approved = pairingApprove(config, [created.code, "operator:alice"], { now: () => now + 1 });
    expect(approved).toMatchObject({ state: "approved", principalId: "operator:alice" });
    expect(pairingClear(config, [], { now: () => now + 2 })).toBe(1);
    expect(pairingList(config, [], { now: () => now + 2 })).toEqual([]);
  });

  test("prints a POSIX-safe approval command for a custom pairing config", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ompclaw-pairing-listen-cli-"));
    directories.push(directory);
    const hostileDirectory = join(directory, "space ' $; path");
    mkdirSync(hostileDirectory);
    const stateDir = join(hostileDirectory, "state");
    mkdirSync(stateDir);
    const configPath = join(hostileDirectory, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        workspace: directory,
        stateDir,
        transports: {
          telegram: { enabled: true, account: "default", tokenEnv: "TELEGRAM_BOT_TOKEN" },
        },
      }),
    );
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const args = parseGatewayCliArgs(["pairing-listen", "--config", configPath]);
    const config = loadGatewayCliConfig(args);
    const lines: string[] = [];

    await executeGatewayCommand(args, config, {
      write: (line) => lines.push(line),
      listenForFirstTelegramUser: async () => ({
        identity: { transport: "telegram", account: "default", subject: "42" },
        address: { transport: "telegram", account: "default", channel: "42" },
        displayLabel: "Alice",
        updateId: 1,
      }),
    });

    const approval = lines.find((line) => line.startsWith("Approve locally (POSIX shell): "));
    expect(approval).toBeDefined();
    const command = approval!.slice("Approve locally (POSIX shell): ".length);
    const parsed = Bun.spawnSync(["/bin/sh", "-c", `set -- ${command}; printf '%s\\n' "$@"`]);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout.toString().trim().split("\n")).toEqual([
      "ompclaw",
      "pairing-approve",
      expect.any(String),
      "--config",
      configPath,
    ]);
  });

  test("setup prints a POSIX-safe local approval command and completes doctor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ompclaw-setup-cli-"));
    directories.push(directory);
    const hostileDirectory = join(directory, "space ' $; path");
    mkdirSync(hostileDirectory);
    const stateDir = join(hostileDirectory, "state");
    mkdirSync(stateDir);
    const configPath = join(hostileDirectory, "config.json");
    const envFile = join(hostileDirectory, "ompclaw.env");
    const lines: string[] = [];

    await executeGatewayCommand(
      parseGatewayCliArgs(["setup", "--config", configPath, "--env-file", envFile]),
      undefined,
      {
        write: (line) => lines.push(line),
        runSetupWizard: async () => {
          writeFileSync(
            configPath,
            JSON.stringify({
              workspace: directory,
              stateDir,
              transports: {
                telegram: { enabled: true, account: "default", tokenEnv: "TELEGRAM_BOT_TOKEN" },
              },
            }),
          );
          writeFileSync(envFile, "TELEGRAM_BOT_TOKEN=test-token\n", { mode: 0o600 });
          return {
            configPath,
            envFile,
            bot: { id: 1, username: "test_bot", displayName: "@test_bot" },
            discovery: {
              identity: { transport: "telegram", account: "default", subject: "42" },
              address: { transport: "telegram", account: "default", channel: "42" },
              displayLabel: "Alice",
              updateId: 1,
            },
          };
        },
        callTelegram: async (_token, method) => {
          if (method === "getMe") return { id: 1, username: "test_bot" };
          return { url: "", pending_update_count: 0 };
        },
        createDoctorRpc: () => ({
          protocolVersion: 1,
          start: async () => {},
          stop: async () => {},
          send: async () => ({
            type: "response",
            command: "get_state",
            success: true,
            data: { sessionId: "session-1", sessionName: "Setup Session" },
          }),
        }),
      },
    );

    expect(lines).toContain("Doctor: ready");
    expect(lines).toContain("Pairing request from Alice (Telegram user 42).");
    const approval = lines.find((line) => line.startsWith("Approve locally (POSIX shell): "));
    expect(approval).toBeDefined();
    const command = approval!.slice("Approve locally (POSIX shell): ".length);
    const parsed = Bun.spawnSync(["/bin/sh", "-c", `set -- ${command}; printf '%s\\n' "$@"`]);
    expect(parsed.exitCode).toBe(0);
    const args = parsed.stdout.toString().trim().split("\n");
    expect(args).toEqual(["ompclaw", "pairing-approve", expect.any(String), "--config", configPath]);
  });
});

describe("gateway doctor", () => {
  test("reports actionable update storage failure before starting OMP", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ompclaw-doctor-"));
    directories.push(directory);
    const configPath = join(directory, "config.json");
    const stateDir = join(directory, "state");
    writeFileSync(
      configPath,
      JSON.stringify({
        workspace: directory,
        stateDir,
        transports: {},
        updates: {
          enabled: true,
          repository: directory,
          healthTimeoutMs: 30_000,
        },
      }),
    );
    const config = loadGatewayCliConfig(parseGatewayCliArgs(["doctor", "--config", configPath]));
    const lines: string[] = [];

    await expect(
      doctor(config, {
        getAvailableBytes: () => 3n * 1024n * 1024n * 1024n,
        write: (line) => lines.push(line),
        createDoctorRpc: () => {
          throw new Error("OMP must not start after a failed storage preflight");
        },
      }),
    ).rejects.toThrow(
      `Transactional update staging requires 4.0 GiB free at ${stateDir}; 3.0 GiB is available. Free disk space or move stateDir, then retry`,
    );
    expect(lines).toEqual([`Update storage: 3.0 GiB free at ${stateDir} (4.0 GiB staging minimum)`]);
  });
});
