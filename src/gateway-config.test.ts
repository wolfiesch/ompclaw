import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  expandGatewayPath,
  gatewayRpcRuntimeConfig,
  loadGatewayConfig,
  parseGatewayConfig,
  resolveGatewaySecrets,
  stripGatewaySecretsFromChildEnv,
} from "./gateway-config";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("gateway config", () => {
  test("uses safe standalone defaults and expands home-relative paths", () => {
    const config = parseGatewayConfig({}, "/workspace/current");
    expect(config.workspace).toBe("/workspace/current");
    expect(config.profile).toBe("ompclaw");
    expect(config.stateDir).toMatch(/\.omp\/agent\/ompclaw$/);
    expect(expandGatewayPath("~/state", "/workspace/current")).toMatch(/state$/);
  });

  test("defaults autonomy to inherit", () => {
    expect(parseGatewayConfig({}).omp.autonomyMode).toBe("inherit");
  });

  for (const args of [
    ["--approval-mode", "always-ask"],
    ["--approval-mode=always-ask"],
  ]) {
    test(`allows raw ${args[0]} approval arguments under default inherit autonomy`, () => {
      const config = parseGatewayConfig({ omp: { args } });

      expect(config.omp).toMatchObject({ autonomyMode: "inherit", args });
    });
  }

  test("defaults busy input mode to steer and forwards an explicit override to RPC", () => {
    expect(parseGatewayConfig({}).omp.busyInputMode).toBe("steer");

    const config = parseGatewayConfig({ omp: { busyInputMode: "followup" } });
    expect(gatewayRpcRuntimeConfig(config).busyInputMode).toBe("followup");

    expect(() => parseGatewayConfig({ omp: { busyInputMode: "queue" } }))
      .toThrow('omp.busyInputMode must be "steer" or "followup"');
  });

  test("rejects invalid autonomy modes with the config path", () => {
    expect(() => parseGatewayConfig({ omp: { autonomyMode: "unattended" } }))
      .toThrow('omp.autonomyMode must be "inherit", "autopilot", "balanced", or "review"');
  });

  for (const autonomyMode of ["inherit", "autopilot", "balanced", "review"] as const) {
    test(`parses ${autonomyMode} autonomy and forwards it to RPC`, () => {
      const config = parseGatewayConfig({ omp: { autonomyMode } });

      expect(gatewayRpcRuntimeConfig(config).autonomyMode).toBe(autonomyMode);
    });
  }

  for (const autonomyMode of ["autopilot", "balanced", "review"] as const) {
    for (const args of [
      ["--approval-mode", "always-ask"],
      ["--approval-mode=always-ask"],
    ]) {
      test(`rejects ${autonomyMode} autonomy with raw ${args[0]}`, () => {
        expect(() => parseGatewayConfig({ omp: { autonomyMode, args } }))
          .toThrow("omp.autonomyMode conflicts with --approval-mode in omp.args");
      });
    }
  }

  test("keeps unattended automation opt-in and validates bounded runtime controls", () => {
    expect(parseGatewayConfig({}).automation).toEqual({
      enabled: false,
      pollIntervalMs: 1_000,
      retryDelayMs: 15_000,
      maxAttempts: 3,
    });
    expect(parseGatewayConfig({
      automation: { enabled: true, pollIntervalMs: 2_000, retryDelayMs: 30_000, maxAttempts: 5 },
    }).automation).toEqual({
      enabled: true,
      pollIntervalMs: 2_000,
      retryDelayMs: 30_000,
      maxAttempts: 5,
    });
    expect(() => parseGatewayConfig({ automation: { enabled: true, maxAttempts: 11 } })).toThrow("between 1 and 10");
    expect(() => parseGatewayConfig({ automation: { enabled: true, unknown: true } })).toThrow("unknown key unknown");
  });

  test("keeps transactional updates opt-in with a fixed repository", () => {
    expect(parseGatewayConfig({}, "/workspace/current").updates).toEqual({
      enabled: false,
      healthTimeoutMs: 30_000,
    });
    expect(parseGatewayConfig({
      updates: {
        enabled: true,
        repository: "../ompclaw",
        healthTimeoutMs: 45_000,
      },
    }, "/workspace/current").updates).toEqual({
      enabled: true,
      repository: "/workspace/ompclaw",
      healthTimeoutMs: 45_000,
    });
    expect(() => parseGatewayConfig({ updates: { enabled: true } })).toThrow("repository is required");
    expect(() => parseGatewayConfig({ updates: { enabled: true, repository: "/repo", unknown: true } })).toThrow("unknown key unknown");
  });

  test("keeps experimental learning opt-in with an explicit memory model", () => {
    expect(parseGatewayConfig({}).learning).toEqual({
      enabled: false,
      autoCapture: false,
      minToolCalls: 5,
      memoryModel: "online",
    });
    expect(parseGatewayConfig({
      learning: { enabled: true, autoCapture: true, minToolCalls: 9, memoryModel: "lfm2-1.2b" },
    }).learning).toEqual({
      enabled: true,
      autoCapture: true,
      minToolCalls: 9,
      memoryModel: "lfm2-1.2b",
    });
    expect(() => parseGatewayConfig({ learning: { enabled: true, memoryModel: "unknown" } })).toThrow("supported OMP memory model");
  });

  test("rejects unknown keys and literal transport tokens", () => {
    expect(() => parseGatewayConfig({ unexpected: true })).toThrow("unknown key unexpected");
    expect(() => parseGatewayConfig({
      transports: { telegram: { enabled: true, account: "default", token: "secret" } },
    })).toThrow("unknown key token");
  });

  test("keeps forum topic sessions opt-in and rejects implicit root topic creation", () => {
    const telegram = (topicSessions?: unknown) => parseGatewayConfig({
      transports: {
        telegram: {
          enabled: true,
          account: "default",
          tokenEnv: "TELEGRAM_BOT_TOKEN",
          ...(topicSessions === undefined ? {} : { topicSessions }),
        },
      },
    }).transports.telegram?.topicSessions;

    expect(telegram()).toEqual({ enabled: false, createFromRoot: false });
    expect(telegram({ enabled: true, createFromRoot: true })).toEqual({ enabled: true, createFromRoot: true });
    expect(() => telegram({ enabled: false, createFromRoot: true })).toThrow("requires topicSessions.enabled");
    expect(() => telegram({ enabled: true, unknown: true })).toThrow("unknown key unknown");
  });

  test("accepts stdout and Whisper-style Telegram transcription commands", () => {
    const telegram = (transcribeCommand: unknown) => parseGatewayConfig({
      transports: {
        telegram: {
          enabled: true,
          account: "default",
          tokenEnv: "TELEGRAM_BOT_TOKEN",
          transcribeCommand,
        },
      },
    }).transports.telegram;

    expect(telegram(["transcribe", "{file}"])?.transcribeCommand).toEqual(["transcribe", "{file}"]);
    expect(telegram(["whisper", "{file}", "--output_dir", "{outputDir}"])?.transcribeCommand).toEqual([
      "whisper",
      "{file}",
      "--output_dir",
      "{outputDir}",
    ]);
    expect(() => telegram(["transcribe"])).toThrow("{file}");
  });

  test("accepts only credential environment names and never serializes their values", () => {
    const config = parseGatewayConfig({
      workspace: "~/workspace",
      stateDir: "~/state",
      transports: {
        telegram: { enabled: true, account: "bot", tokenEnv: "TELEGRAM_BOT_TOKEN" },
        websocket: {
          enabled: true,
          hostname: "127.0.0.1",
          port: 7788,
          account: "web",
          credentials: [{ tokenEnv: "OMPCLAW_WEB_TOKEN", subject: "alice", channel: "alice" }],
        },
      },
    }, "/work");
    const secrets = resolveGatewaySecrets(config, {
      TELEGRAM_BOT_TOKEN: "telegram-secret",
      OMPCLAW_WEB_TOKEN: "web-secret",
    });

    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain("telegram-secret");
    expect(serialized).not.toContain("web-secret");
    expect(secrets).toEqual({
      telegramToken: "telegram-secret",
      webSocketCredentials: [{ token: "web-secret", subject: "alice", channel: "alice" }],
    });
    expect(() => parseGatewayConfig({
      transports: {
        websocket: {
          enabled: true,
          hostname: "127.0.0.1",
          port: 1,
          account: "web",
          credentials: [{ tokenEnv: "WEBSOCKET_TOKEN", subject: "alice", channel: "alice" }],
        }
      },
    })).toThrow("OMPCLAW_");
  });

  test("loads only bounded regular JSON config documents", () => {
    const directory = mkdtempSync(join(tmpdir(), "ompclaw-config-"));
    directories.push(directory);
    const path = join(directory, "gateway.json");
    writeFileSync(path, JSON.stringify({ profile: "gateway-test" }), { mode: 0o600 });

    expect(loadGatewayConfig({ path, cwd: directory }).profile).toBe("gateway-test");
  });

  test("strips every gateway transport credential from the OMP child environment", () => {
    const child = stripGatewaySecretsFromChildEnv({
      PATH: "/bin",
      TELEGRAM_BOT_TOKEN: "telegram-secret",
      OMPCLAW_WEB_TOKEN: "web-secret",
      OMP_GATEWAY_WEB_TOKEN: "renamed-secret",
      GATEWAY_LEGACY_TOKEN: "legacy-secret",
      OMP_TRANSPORT_TOKEN: "transport-secret",
    });
    expect(child).toEqual({ PATH: "/bin" });
  });
});
