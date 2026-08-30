import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  expandGatewayPath,
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
    expect(config.profile).toBe("gateway");
    expect(config.stateDir).toMatch(/\.omp\/agent\/gateway$/);
    expect(expandGatewayPath("~/state", "/workspace/current")).toMatch(/state$/);
  });

  test("rejects unknown keys and literal transport tokens", () => {
    expect(() => parseGatewayConfig({ unexpected: true })).toThrow("unknown key unexpected");
    expect(() => parseGatewayConfig({
      transports: { telegram: { enabled: true, account: "default", token: "secret" } },
    })).toThrow("unknown key token");
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
          credentials: [{ tokenEnv: "OMP_GATEWAY_WEB_TOKEN", subject: "alice", channel: "alice" }],
        },
      },
    }, "/work");
    const secrets = resolveGatewaySecrets(config, {
      TELEGRAM_BOT_TOKEN: "telegram-secret",
      OMP_GATEWAY_WEB_TOKEN: "web-secret",
    });

    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain("telegram-secret");
    expect(serialized).not.toContain("web-secret");
    expect(secrets).toEqual({
      telegramToken: "telegram-secret",
      webSocketCredentials: [{ token: "web-secret", subject: "alice", channel: "alice" }],
    });
    expect(() => parseGatewayConfig({
      transports: { websocket: {
        enabled: true,
        hostname: "127.0.0.1",
        port: 1,
        account: "web",
        credentials: [{ tokenEnv: "WEBSOCKET_TOKEN", subject: "alice", channel: "alice" }],
      } },
    })).toThrow("OMP_GATEWAY_");
  });

  test("loads only bounded regular JSON config documents", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-gateway-config-"));
    directories.push(directory);
    const path = join(directory, "gateway.json");
    writeFileSync(path, JSON.stringify({ profile: "gateway-test" }), { mode: 0o600 });

    expect(loadGatewayConfig({ path, cwd: directory }).profile).toBe("gateway-test");
  });

  test("strips every gateway transport credential from the OMP child environment", () => {
    const child = stripGatewaySecretsFromChildEnv({
      PATH: "/bin",
      TELEGRAM_BOT_TOKEN: "telegram-secret",
      OMP_GATEWAY_WEB_TOKEN: "web-secret",
      GATEWAY_LEGACY_TOKEN: "legacy-secret",
      OMP_TRANSPORT_TOKEN: "transport-secret",
    });
    expect(child).toEqual({ PATH: "/bin" });
  });
});
