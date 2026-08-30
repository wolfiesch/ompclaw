import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertRpcAccess, buildOmpChildEnv, buildOmpRpcArgv, loadLiteralEnvFile, parseRpcCliArgs } from "./rpc-config";
import { prepareInheritedHarness } from "./rpc-profile";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("RPC configuration", () => {
  test("parses the public CLI and builds a resumable RPC command", () => {
    const config = parseRpcCliArgs(
      [
        "doctor",
        "--cwd",
        "~/workspace",
        "--state-dir",
        "~/state",
        "--profile",
        "phone",
        "--model",
        "openai/gpt-5",
        "--config",
        "~/omp.json",
        "--omp-arg",
        "--plan-yolo",
      ],
      {},
    );
    expect(config.command).toBe("doctor");
    expect(config.cwd).toBe(join(homedir(), "workspace"));
    expect(config.stateDir).toBe(join(homedir(), "state"));
    expect(buildOmpRpcArgv(config, "/sessions/exact.jsonl")).toEqual([
      "omp",
      "--mode",
      "rpc-ui",
      "--cwd",
      join(homedir(), "workspace"),
      "--profile",
      "phone",
      "--no-title",
      "--resume",
      "/sessions/exact.jsonl",
      "--model",
      "openai/gpt-5",
      "--config",
      join(homedir(), "omp.json"),
      "--plan-yolo",
    ]);
  });

  test("loads literal environment values without overriding the process environment", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-telegram-env-"));
    directories.push(directory);
    const path = join(directory, ".env");
    writeFileSync(path, "# comment\nexport TELEGRAM_BOT_TOKEN='from-file'\nTELEGRAM_ALLOWED_USERS=123,456\nINVALID LINE\n", { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { TELEGRAM_BOT_TOKEN: "existing" };
    loadLiteralEnvFile(path, env);
    expect(env.TELEGRAM_BOT_TOKEN).toBe("existing");
    expect(env.TELEGRAM_ALLOWED_USERS).toBe("123,456");
  });

  test("rejects transport credential files with unsafe permissions or symlinks", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-telegram-env-security-"));
    directories.push(directory);
    const loose = join(directory, "loose.env");
    const link = join(directory, "linked.env");
    writeFileSync(loose, "TELEGRAM_BOT_TOKEN=secret\n", { mode: 0o644 });
    expect(() => loadLiteralEnvFile(loose, {})).toThrow("permissions must be 0600 or stricter");
    symlinkSync(loose, link);
    expect(() => loadLiteralEnvFile(link, {})).toThrow("regular file, not a symlink");
  });

  test("rejects shared group policy in the single-operator runtime", () => {
    expect(() => assertRpcAccess({ allowFrom: ["42"], groups: { "-100": { requireMention: false, allowFrom: [] } } })).toThrow(
      "private chats only",
    );
    expect(() => assertRpcAccess({ allowFrom: ["42", "43"], groups: {} })).toThrow("at most one paired");
    expect(() => assertRpcAccess({ allowFrom: ["42"], groups: {} })).not.toThrow();
  });

  test("strips transport credentials from the OMP child", () => {
    expect(
      buildOmpChildEnv({
        PATH: "/bin",
        TELEGRAM_BOT_TOKEN: "secret",
        TELEGRAM_ALLOWED_USERS: "123",
        OMP_TELEGRAM_RPC_ENV_FILE: "/secret/.env",
        OMP_TELEGRAM_STATE_DIR: "/secret/state",
      }),
    ).toEqual({ PATH: "/bin", OMP_TELEGRAM_RPC_CHILD: "1" });
  });

  test("passes an explicitly scoped auth broker token without its file path", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-telegram-broker-"));
    directories.push(directory);
    const path = join(directory, "auth-broker.token");
    writeFileSync(path, "broker-secret\n", { mode: 0o600 });
    expect(
      buildOmpChildEnv(
        { PATH: "/bin", OMP_TELEGRAM_RPC_AUTH_BROKER_TOKEN_FILE: path },
        { authBrokerTokenFile: path },
      ),
    ).toEqual({ PATH: "/bin", OMP_AUTH_BROKER_TOKEN: "broker-secret", OMP_TELEGRAM_RPC_CHILD: "1" });
  });

  test("inherits harness assets without sharing credentials or runtime state", () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-telegram-profile-"));
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
      const config = parseRpcCliArgs(["run", "--profile", "phone", "--inherit-harness"], {});
      const target = prepareInheritedHarness(config)!;
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

  test("rejects unknown flags and missing values", () => {
    expect(() => parseRpcCliArgs(["run", "--unknown"], {})).toThrow("Unknown option");
    expect(() => parseRpcCliArgs(["run", "--cwd"], {})).toThrow("requires a value");
  });
});
