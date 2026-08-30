import { accessSync, constants, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { RpcRuntimeConfig } from "./rpc-config";

export interface ServiceInstallResult {
  path: string;
  manager: "launchd" | "systemd";
}

const SERVICE_NAME = "com.omp.telegram.rpc";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function resolveCommand(command: string): string {
  if (command.includes("/")) return command;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching.
    }
  }
  return command;
}

function servicePath(config: RpcRuntimeConfig): string {
  return [...new Set([dirname(process.execPath), dirname(resolveCommand(config.ompCommand)), ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)])].join(delimiter);
}

function serviceArguments(config: RpcRuntimeConfig): string[] {
  const entry = fileURLToPath(new URL("./rpc-cli.ts", import.meta.url));
  const omp = resolveCommand(config.ompCommand);
  const args = [process.execPath, entry, "run", "--cwd", config.cwd, "--state-dir", config.stateDir, "--profile", config.profile, "--omp", omp];
  if (config.envFile) args.push("--env-file", config.envFile);
  if (config.authBrokerTokenFile) args.push("--auth-broker-token-file", config.authBrokerTokenFile);
  if (config.model) args.push("--model", config.model);
  if (config.resume) args.push("--resume", config.resume);
  if (config.sessionDir) args.push("--session-dir", config.sessionDir);
  for (const file of config.configFiles) args.push("--config", file);
  for (const arg of config.ompArgs) args.push("--omp-arg", arg);
  if (config.inheritHarness) args.push("--inherit-harness");
  if (config.allowRpcBash) args.push("--allow-rpc-bash");
  if (!config.autoRestart) args.push("--no-auto-restart");
  return args;
}

const MANAGER_RETRY_WAIT = new Int32Array(new SharedArrayBuffer(4));

function runManager(executable: string, args: string[], retries = 0): void {
  let failure = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = spawnSync(executable, args, { encoding: "utf8" });
    if (result.status === 0) return;
    failure = (result.stderr || result.stdout).trim();
    if (attempt < retries) Atomics.wait(MANAGER_RETRY_WAIT, 0, 0, 100);
  }
  throw new Error(`${executable} ${args.join(" ")} failed: ${failure}`);
}

export function installRpcService(config: RpcRuntimeConfig): ServiceInstallResult {
  const args = serviceArguments(config);
  const logs = join(config.stateDir, "logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });

  if (process.platform === "darwin") {
    const path = join(homedir(), "Library", "LaunchAgents", `${SERVICE_NAME}.plist`);
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(servicePath(config))}</string></dict>
  <key>Label</key><string>${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>${args.map((arg) => `\n    <string>${xml(arg)}</string>`).join("")}\n  </array>
  <key>WorkingDirectory</key><string>${xml(config.cwd)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(join(logs, "stdout.log"))}</string>
  <key>ExitTimeOut</key><integer>15</integer>
  <key>StandardErrorPath</key><string>${xml(join(logs, "stderr.log"))}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
    writeFileSync(path, plist, { mode: 0o644 });
    const domain = `gui/${process.getuid?.() ?? 0}`;
    spawnSync("launchctl", ["bootout", "--wait", `${domain}/${SERVICE_NAME}`], { encoding: "utf8", timeout: 10_000 });
    runManager("launchctl", ["bootstrap", domain, path], 20);
    runManager("launchctl", ["enable", `${domain}/${SERVICE_NAME}`]);
    return { path, manager: "launchd" };
  }

  if (process.platform === "linux") {
    const dir = join(homedir(), ".config", "systemd", "user");
    const path = join(dir, "omp-telegram-rpc.service");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const unit = `[Unit]
Description=OMP Telegram RPC bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${config.cwd}
ExecStart=${args.map(systemdQuote).join(" ")}
Environment=${systemdQuote(`PATH=${servicePath(config)}`)}
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${config.stateDir} ${config.cwd}

[Install]
WantedBy=default.target
`;
    writeFileSync(path, unit, { mode: 0o600 });
    runManager("systemctl", ["--user", "daemon-reload"]);
    runManager("systemctl", ["--user", "enable", "--now", "omp-telegram-rpc.service"]);
    return { path, manager: "systemd" };
  }

  throw new Error(`Service installation is not supported on ${process.platform}`);
}

export function uninstallRpcService(): ServiceInstallResult {
  if (process.platform === "darwin") {
    const path = join(homedir(), "Library", "LaunchAgents", `${SERVICE_NAME}.plist`);
    const domain = `gui/${process.getuid?.() ?? 0}`;
    spawnSync("launchctl", ["bootout", `${domain}/${SERVICE_NAME}`], { encoding: "utf8" });
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { path, manager: "launchd" };
  }
  if (process.platform === "linux") {
    const path = join(homedir(), ".config", "systemd", "user", "omp-telegram-rpc.service");
    spawnSync("systemctl", ["--user", "disable", "--now", "omp-telegram-rpc.service"], { encoding: "utf8" });
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    runManager("systemctl", ["--user", "daemon-reload"]);
    return { path, manager: "systemd" };
  }
  throw new Error(`Service removal is not supported on ${process.platform}`);
}
