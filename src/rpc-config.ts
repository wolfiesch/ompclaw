import { lstatSync, readFileSync } from "node:fs";

export interface RpcRuntimeConfig {
  cwd: string;
  stateDir: string;
  profile: string;
  ompCommand: string;
  model?: string;
  resume?: string;
  sessionDir?: string;
  configFiles: string[];
  ompArgs: string[];
  authBrokerTokenFile?: string;
  allowRpcBash: boolean;
  inheritHarness: boolean;
  autoRestart: boolean;
  busyInputMode: "steer" | "followup";
}

export function buildOmpRpcArgv(config: RpcRuntimeConfig, resume = config.resume): string[] {
  const argv = [config.ompCommand, "--mode", "rpc-ui", "--cwd", config.cwd, "--profile", config.profile, "--no-title"];
  if (resume) argv.push("--resume", resume);
  if (config.model) argv.push("--model", config.model);
  if (config.sessionDir) argv.push("--session-dir", config.sessionDir);
  for (const file of config.configFiles) argv.push("--config", file);
  argv.push(...config.ompArgs);
  return argv;
}

function readPrivateFile(path: string, label: string): string {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file, not a symlink`);
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid != null && info.uid !== uid) throw new Error(`${label} must be owned by the current user`);
    if ((info.mode & 0o077) !== 0) throw new Error(`${label} permissions must be 0600 or stricter`);
  }
  return readFileSync(path, "utf8");
}

/** OMP gets the normal harness environment without the Telegram transport token. */
export function buildOmpChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  config?: Pick<RpcRuntimeConfig, "authBrokerTokenFile">,
): Record<string, string | undefined> {
  const childEnv: Record<string, string | undefined> = { ...env };
  delete childEnv.TELEGRAM_BOT_TOKEN;
  if (config?.authBrokerTokenFile) {
    childEnv.OMP_AUTH_BROKER_TOKEN = readPrivateFile(config.authBrokerTokenFile, "Auth broker token file").trim();
    if (!childEnv.OMP_AUTH_BROKER_TOKEN) throw new Error("Auth broker token file is empty");
  }
  return childEnv;
}
/** Load literal KEY=VALUE pairs. Existing process variables always win. */
export function loadLiteralEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  const content = readPrivateFile(path, "Environment file");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const split = normalized.indexOf("=");
    if (split <= 0) continue;
    const key = normalized.slice(0, split).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || env[key] !== undefined) continue;
    let value = normalized.slice(split + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}
