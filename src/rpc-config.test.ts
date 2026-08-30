import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripGatewaySecretsFromChildEnv } from "./gateway-config";
import { buildOmpChildEnv, buildOmpRpcArgv, loadLiteralEnvFile, type RpcRuntimeConfig } from "./rpc-config";
import { prepareInheritedHarness } from "./rpc-profile";

const directories: string[] = [];

function runtimeConfig(overrides: Partial<RpcRuntimeConfig> = {}): RpcRuntimeConfig {
  return {
    cwd: "/workspace",
    stateDir: "/state",
    profile: "gateway",
    ompCommand: "omp",
    configFiles: [],
    ompArgs: [],
    allowRpcBash: false,
    inheritHarness: false,
    autoRestart: true,
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("RPC configuration", () => {
  test("builds the exact resumable OMP RPC argv", () => {
    const config = runtimeConfig({
      cwd: "/workspace/omp-gateway",
      profile: "production",
      ompCommand: "/opt/omp/bin/omp",
      resume: "/sessions/default.jsonl",
      model: "example/model-v1",
      sessionDir: "/sessions",
      configFiles: ["/config/base.json", "/config/production.json"],
      ompArgs: ["--plan-yolo", "--color", "never"],
    });

    expect(buildOmpRpcArgv(config, "/sessions/exact.jsonl")).toEqual([
      "/opt/omp/bin/omp",
      "--mode",
      "rpc-ui",
      "--cwd",
      "/workspace/omp-gateway",
      "--profile",
      "production",
      "--no-title",
      "--resume",
      "/sessions/exact.jsonl",
      "--model",
      "example/model-v1",
      "--session-dir",
      "/sessions",
      "--config",
      "/config/base.json",
      "--config",
      "/config/production.json",
      "--plan-yolo",
      "--color",
      "never",
    ]);
  });

  test("strips Telegram, gateway, and WebSocket credentials from the OMP child", () => {
    const childEnv = stripGatewaySecretsFromChildEnv(
      buildOmpChildEnv({
        PATH: "/bin",
        TELEGRAM_BOT_TOKEN: "telegram-secret",
        OMP_GATEWAY_TELEGRAM_TOKEN: "gateway-secret",
        GATEWAY_AUTHORIZATION: "gateway-authorization",
        OMP_TRANSPORT_TOKEN: "transport-secret",
        OMP_WEBSOCKET_TOKEN: "omp-websocket-secret",
        WEBSOCKET_TOKEN: "websocket-secret",
      }),
    );

    expect(childEnv).toEqual({ PATH: "/bin" });
  });

  test("loads literal environment values without overriding inherited values", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-gateway-env-"));
    directories.push(directory);
    const path = join(directory, ".env");
    writeFileSync(
      path,
      "# comment\nexport FROM_FILE='literal value'\nALREADY=from-file\nEXPANSION=$HOME\nINVALID LINE\n",
      { mode: 0o600 },
    );
    const env: NodeJS.ProcessEnv = { ALREADY: "inherited" };

    loadLiteralEnvFile(path, env);

    expect(env).toEqual({ FROM_FILE: "literal value", ALREADY: "inherited", EXPANSION: "$HOME" });
  });

  test("rejects non-private or non-regular environment files", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-gateway-env-security-"));
    directories.push(directory);
    const loose = join(directory, "loose.env");
    const link = join(directory, "linked.env");
    const notFile = join(directory, "not-file");
    writeFileSync(loose, "TOKEN=secret\n", { mode: 0o644 });
    symlinkSync(loose, link);
    mkdirSync(notFile);

    if (process.platform !== "win32") {
      expect(() => loadLiteralEnvFile(loose, {})).toThrow("permissions must be 0600 or stricter");
    }
    expect(() => loadLiteralEnvFile(link, {})).toThrow("regular file, not a symlink");
    expect(() => loadLiteralEnvFile(notFile, {})).toThrow("regular file, not a symlink");
  });

  test("injects a private auth broker token without exposing its source path", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-gateway-broker-"));
    directories.push(directory);
    const path = join(directory, "auth-broker.token");
    writeFileSync(path, "broker-secret\n", { mode: 0o600 });

    const childEnv = stripGatewaySecretsFromChildEnv(
      buildOmpChildEnv(
        {
          PATH: "/bin",
          TELEGRAM_BOT_TOKEN: "telegram-secret",
          OMP_GATEWAY_AUTH_BROKER_TOKEN_FILE: path,
        },
        { authBrokerTokenFile: path },
      ),
    );

    expect(childEnv).toEqual({ PATH: "/bin", OMP_AUTH_BROKER_TOKEN: "broker-secret" });
  });

  test("accepts gateway runtime config for inherited harness assets without credentials or runtime state", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-gateway-profile-"));
    directories.push(directory);
    const source = join(directory, "agent");
    mkdirSync(join(source, "skills"), { recursive: true });
    mkdirSync(join(source, "extensions"));
    mkdirSync(join(source, "hooks"));
    writeFileSync(join(source, "AGENTS.md"), "rules");
    writeFileSync(join(source, ".env"), "SECRET=value");
    writeFileSync(join(source, "agent.db"), "runtime");
    const previous = process.env.OMP_HOME;
    process.env.OMP_HOME = directory;
    try {
      const target = prepareInheritedHarness(runtimeConfig({ profile: "phone", inheritHarness: true }))!;
      expect(lstatSync(join(target, "skills")).isSymbolicLink()).toBe(true);
      expect(existsSync(join(target, "AGENTS.md"))).toBe(true);
      expect(existsSync(join(target, "extensions"))).toBe(false);
      expect(existsSync(join(target, "hooks"))).toBe(false);
      expect(existsSync(join(target, ".env"))).toBe(false);
      expect(existsSync(join(target, "agent.db"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OMP_HOME;
      else process.env.OMP_HOME = previous;
    }
  });
});
