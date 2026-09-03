import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripGatewaySecretsFromChildEnv } from "./gateway-config";
import { AUTONOMY_MODES, buildOmpChildEnv, buildOmpRpcArgv, loadLiteralEnvFile, parseAutonomyMode, type RpcRuntimeConfig } from "./rpc-config";
import { prepareInheritedHarness, prepareLearningOverlay } from "./rpc-profile";

const directories: string[] = [];

function runtimeConfig(overrides: Partial<RpcRuntimeConfig> = {}): RpcRuntimeConfig {
  return {
    cwd: "/workspace",
    stateDir: "/state",
    profile: "gateway",
    ompCommand: "omp",
    configFiles: [],
    ompArgs: [],
    autonomyMode: "inherit",
    allowRpcBash: false,
    inheritHarness: false,
    autoRestart: true,
    busyInputMode: "steer",
    ...overrides,
  };
}

function makeRemovable(path: string): void {
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (!info.isDirectory()) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) makeRemovable(join(path, entry));
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    makeRemovable(directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("RPC configuration", () => {
  test("builds the exact resumable OMP RPC argv", () => {
    const config = runtimeConfig({
      cwd: "/workspace/ompclaw",
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
      "/workspace/ompclaw",
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

  for (const [autonomyMode, approvalMode] of [
    ["autopilot", "yolo"],
    ["balanced", "write"],
    ["review", "always-ask"],
  ] as const) {
    test(`adds the ${approvalMode} approval mode before raw arguments`, () => {
      expect(buildOmpRpcArgv(runtimeConfig({
        autonomyMode,
        ompArgs: ["--color", "never"],
      }))).toEqual([
        "omp",
        "--mode",
        "rpc-ui",
        "--cwd",
        "/workspace",
        "--profile",
        "gateway",
        "--no-title",
        "--approval-mode",
        approvalMode,
        "--color",
        "never",
      ]);
    });
  }

  test("rejects raw approval mode arguments alongside explicit autonomy", () => {
    for (const autonomyMode of ["autopilot", "balanced", "review"] as const) {
      for (const ompArgs of [["--approval-mode", "write"], ["--approval-mode=write"]]) {
        expect(() => buildOmpRpcArgv(runtimeConfig({ autonomyMode, ompArgs })))
          .toThrow("Explicit autonomyMode conflicts with --approval-mode in ompArgs");
      }
    }
  });

  test("rejects unknown runtime autonomy modes", () => {
    expect(() => buildOmpRpcArgv(runtimeConfig({
      autonomyMode: "unknown" as unknown as RpcRuntimeConfig["autonomyMode"],
    }))).toThrow("Unsupported autonomy mode: unknown. Supported values: inherit, autopilot, balanced, review");
  });
  test("parses valid autonomy modes and rejects unknown strings", () => {
    expect(AUTONOMY_MODES).toEqual(["autopilot", "balanced", "review", "inherit"]);
    expect(parseAutonomyMode("inherit")).toBe("inherit");
    expect(parseAutonomyMode("autopilot")).toBe("autopilot");
    expect(parseAutonomyMode("balanced")).toBe("balanced");
    expect(parseAutonomyMode("review")).toBe("review");
    expect(parseAutonomyMode("unknown")).toBeUndefined();
    expect(parseAutonomyMode(undefined)).toBeUndefined();
  });

  test("keeps raw approval mode arguments under inherited autonomy", () => {
    expect(buildOmpRpcArgv(runtimeConfig({
      ompArgs: ["--approval-mode", "write"],
    }))).toEqual([
      "omp",
      "--mode",
      "rpc-ui",
      "--cwd",
      "/workspace",
      "--profile",
      "gateway",
      "--no-title",
      "--approval-mode",
      "write",
    ]);
  });

  test("strips Telegram, gateway, and WebSocket credentials from the OMP child", () => {
    const childEnv = stripGatewaySecretsFromChildEnv(
      buildOmpChildEnv({
        PATH: "/bin",
        TELEGRAM_BOT_TOKEN: "telegram-secret",
        OMPCLAW_TELEGRAM_TOKEN: "gateway-secret",
        OMP_GATEWAY_TELEGRAM_TOKEN: "renamed-secret",
        GATEWAY_AUTHORIZATION: "gateway-authorization",
        OMP_TRANSPORT_TOKEN: "transport-secret",
        OMP_WEBSOCKET_TOKEN: "omp-websocket-secret",
        WEBSOCKET_TOKEN: "websocket-secret",
      }),
    );

    expect(childEnv).toEqual({ PATH: "/bin" });
  });

  test("loads literal environment values without overriding inherited values", () => {
    const directory = mkdtempSync(join(tmpdir(), "ompclaw-env-"));
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
    const directory = mkdtempSync(join(tmpdir(), "ompclaw-env-security-"));
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
    const directory = mkdtempSync(join(tmpdir(), "ompclaw-broker-"));
    directories.push(directory);
    const path = join(directory, "auth-broker.token");
    writeFileSync(path, "broker-secret\n", { mode: 0o600 });

    const childEnv = stripGatewaySecretsFromChildEnv(
      buildOmpChildEnv(
        {
          PATH: "/bin",
          TELEGRAM_BOT_TOKEN: "telegram-secret",
          OMPCLAW_AUTH_BROKER_TOKEN_FILE: path,
        },
        { authBrokerTokenFile: path },
      ),
    );

    expect(childEnv).toEqual({ PATH: "/bin", OMP_AUTH_BROKER_TOKEN: "broker-secret" });
  });

  test("materializes experimental learning in OmpClaw-owned state only when enabled", () => {
    const directory = mkdtempSync(join(tmpdir(), "ompclaw-learning-"));
    directories.push(directory);
    expect(prepareLearningOverlay({
      stateDir: directory,
      learning: { enabled: false, autoCapture: false, minToolCalls: 5, memoryModel: "online" },
    })).toBeUndefined();

    const path = prepareLearningOverlay({
      stateDir: directory,
      learning: { enabled: true, autoCapture: true, minToolCalls: 7, memoryModel: "qwen3-1.7b" },
    })!;
    expect(lstatSync(path).mode & 0o077).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      memory: { backend: "mnemopi" },
      mnemopi: {
        dbPath: join(directory, "memory", "mnemopi.sqlite"),
        bank: "gateway",
        scoping: "global",
        autoRecall: true,
        autoRetain: true,
      },
      autolearn: { enabled: true, autoContinue: true, minToolCalls: 7 },
      providers: { memoryModel: "qwen3-1.7b" },
    });
  });

  test("accepts gateway runtime config for inherited harness assets without credentials or runtime state", () => {
    const directory = mkdtempSync(join(tmpdir(), "ompclaw-profile-"));
    directories.push(directory);
    const source = join(directory, "agent");
    mkdirSync(join(source, "skills"), { recursive: true });
    mkdirSync(join(source, "skills", "shared-skill"));
    writeFileSync(join(source, "skills", "shared-skill", "SKILL.md"), "desktop v1");
    writeFileSync(join(source, "skills", "shared-skill", ".env"), "SKILL_SECRET=value");
    mkdirSync(join(source, "skills", "shared-skill", "node_modules"));
    writeFileSync(join(source, "skills", "shared-skill", "node_modules", "dependency.js"), "ignored");
    mkdirSync(join(source, "skills", "shared-skill", "logs"));
    writeFileSync(join(source, "skills", "shared-skill", "logs", "runtime.log"), "ignored");
    mkdirSync(join(source, "skills", "shared-skill", "data", "browser_profile_old"), { recursive: true });
    writeFileSync(join(source, "skills", "shared-skill", "data", "browser_profile_old", "RunningChromeVersion"), "volatile");
    mkdirSync(join(source, "skills", "shared-skill", "data", "browser_profile_cft146"));
    writeFileSync(join(source, "skills", "shared-skill", "data", "browser_profile_cft146", "Cookies"), "volatile");
    writeFileSync(join(source, "skills", "shared-skill", "data", "fixture.json"), "{}");
    const linkedSkill = join(directory, "linked-skill");
    mkdirSync(linkedSkill);
    writeFileSync(join(linkedSkill, "SKILL.md"), "linked desktop skill");
    symlinkSync(linkedSkill, join(source, "skills", "linked-skill"), "dir");
    symlinkSync(join(directory, "temporarily-missing-skill"), join(source, "skills", "missing-skill"), "dir");
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
      expect(readlinkSync(join(target, "skills"))).not.toBe(join(source, "skills"));
      expect(readFileSync(join(target, "skills", "shared-skill", "SKILL.md"), "utf8")).toBe("desktop v1");
      expect(lstatSync(join(target, "skills", "shared-skill", "SKILL.md")).mode & 0o222).toBe(0);
      expect(existsSync(join(target, "skills", "shared-skill", ".env"))).toBe(false);
      expect(existsSync(join(target, "skills", "shared-skill", "node_modules"))).toBe(false);
      expect(existsSync(join(target, "skills", "shared-skill", "logs"))).toBe(false);
      expect(existsSync(join(target, "skills", "shared-skill", "data", "browser_profile_old"))).toBe(false);
      expect(readFileSync(join(target, "skills", "shared-skill", "data", "fixture.json"), "utf8")).toBe("{}");
      expect(readFileSync(join(target, "skills", "linked-skill", "SKILL.md"), "utf8")).toBe("linked desktop skill");
      expect(lstatSync(join(target, "skills", "linked-skill")).isSymbolicLink()).toBe(false);
      expect(existsSync(join(target, "skills", "missing-skill"))).toBe(false);
      expect(existsSync(join(target, "skills", "shared-skill", "data", "browser_profile_cft146"))).toBe(false);
      mkdirSync(join(target, "managed-skills"), { recursive: true });
      writeFileSync(join(target, "managed-skills", "gateway-skill.md"), "gateway only");
      writeFileSync(join(source, "skills", "shared-skill", "SKILL.md"), "desktop v2");
      chmodSync(join(source, "AGENTS.md"), 0o600);
      writeFileSync(join(source, "AGENTS.md"), "rules v2");
      prepareInheritedHarness(runtimeConfig({ profile: "phone", inheritHarness: true }));
      expect(readFileSync(join(target, "skills", "shared-skill", "SKILL.md"), "utf8")).toBe("desktop v2");
      expect(readFileSync(join(target, "managed-skills", "gateway-skill.md"), "utf8")).toBe("gateway only");
      expect(lstatSync(join(target, "AGENTS.md")).mode & 0o222).toBe(0);
      expect(readFileSync(join(target, "AGENTS.md"), "utf8")).toBe("rules v2");
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
