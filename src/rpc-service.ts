import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { GatewayConfig } from "./gateway-config";
import { GatewayUpdateCoordinator, gatewayUpdatePaths } from "./gateway-update";

export interface ServiceInstallResult {
  path: string;
  manager: "launchd" | "systemd";
}

export interface GatewayServicePaths {
  readonly configPath: string;
  readonly envFile: string;
}

const SERVICE_NAME = "com.ompclaw";
const SYSTEMD_UNIT = "ompclaw.service";
const GATEWAY_COMMAND = resolve(import.meta.dir, "rpc-cli.ts");

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function systemdPath(value: string): string {
  let escaped = "";
  for (const byte of Buffer.from(value)) {
    const safe =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x2f ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x3a ||
      byte === 0x5f;
    escaped += safe ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return escaped;
}


export function resolveGatewayServicePaths(
  configPath: string | undefined,
  envFile: string | undefined,
): GatewayServicePaths {
  return {
    configPath: requireAbsoluteRegularFile(configPath, "--config"),
    envFile: requireAbsoluteRegularFile(envFile, "--env-file", 0o600),
  };
}

function requireAbsoluteRegularFile(value: string | undefined, flag: string, mode?: number): string {
  if (value === undefined) throw new Error(`service-install requires ${flag}`);
  if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  const path = resolve(value);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${flag} must be a regular file, not a symlink`);
  if (mode !== undefined && (info.mode & 0o777) !== mode) {
    throw new Error(`${flag} must have mode ${mode.toString(8)}`);
  }
  return path;
}

function servicePath(program: string): string {
  const programDirectory = program.includes("/") ? dirname(program) : undefined;
  return [...new Set([
    dirname(process.execPath),
    ...(programDirectory === undefined ? [] : [programDirectory]),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
  ])].join(delimiter);
}

export function buildServiceArguments(paths: GatewayServicePaths): string[] {
  return [GATEWAY_COMMAND, "run", "--config", paths.configPath, "--env-file", paths.envFile];
}

export function buildManagedServiceArguments(
  config: Pick<GatewayConfig, "stateDir" | "updates">,
  paths: GatewayServicePaths,
): string[] {
  return [
    join(gatewayUpdatePaths(config.stateDir).root, "ompclaw-supervisor"),
    "--state-dir",
    config.stateDir,
    "--config",
    paths.configPath,
    "--env-file",
    paths.envFile,
    "--health-timeout-ms",
    String(config.updates.healthTimeoutMs),
  ];
}

export function replaceFileAtomically(source: string, destination: string, mode: number): void {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, mode);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function prepareServiceArguments(
  config: GatewayConfig,
  paths: GatewayServicePaths,
): Promise<string[]> {
  if (!config.updates.enabled) return buildServiceArguments(paths);
  const updates = new GatewayUpdateCoordinator({ config: config.updates, stateDir: config.stateDir });
  const staged = await updates.stage("HEAD");
  const supervisorPath = join(updates.paths.root, "ompclaw-supervisor");
  replaceFileAtomically(join(staged.release.path, "ompclaw-supervisor"), supervisorPath, 0o700);
  updates.bootstrap(staged.release);
  return buildManagedServiceArguments(config, paths);
}

export function renderSystemdUnit(
  config: Pick<GatewayConfig, "workspace" | "stateDir">,
  args: readonly string[],
): string {
  return `[Unit]
Description=OmpClaw authenticated OMP gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdPath(config.workspace)}
ExecStart=${args.map(systemdQuote).join(" ")}
Environment=${systemdQuote(`PATH=${servicePath(args[0]!)}`)}
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${systemdQuote(config.stateDir)} ${systemdQuote(config.workspace)}

[Install]
WantedBy=default.target
`;
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

export async function installRpcService(
  config: GatewayConfig,
  configPath: string,
  envFile: string,
): Promise<ServiceInstallResult> {
  const paths = resolveGatewayServicePaths(configPath, envFile);
  const args = await prepareServiceArguments(config, paths);
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
  <dict><key>PATH</key><string>${xml(servicePath(args[0]!))}</string></dict>
  <key>Label</key><string>${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>${args.map((arg) => `\n    <string>${xml(arg)}</string>`).join("")}\n  </array>
  <key>WorkingDirectory</key><string>${xml(config.workspace)}</string>
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
    const path = join(dir, SYSTEMD_UNIT);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const unit = renderSystemdUnit(config, args);
    writeFileSync(path, unit, { mode: 0o600 });
    runManager("systemctl", ["--user", "daemon-reload"]);
    runManager("systemctl", ["--user", "enable", SYSTEMD_UNIT]);
    runManager("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
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
    const path = join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);
    spawnSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], { encoding: "utf8" });
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
