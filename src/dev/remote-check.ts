import { resolve } from "node:path";

const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REMOTE_DIRECTORY_PATTERN = /^\/tmp\/ompclaw-check\.[A-Za-z0-9]+$/;
const REMOTE_PREFIX = "/tmp/ompclaw-check.XXXXXX";

export interface RemoteCheckConfig {
  readonly host: string;
}

export interface RemoteCheckReceipt {
  readonly host: string;
  readonly architecture: string;
  readonly bunVersion: string;
}

interface RunOptions {
  readonly cwd?: string;
  readonly capture?: boolean;
}

async function run(command: readonly string[], options: RunOptions = {}): Promise<string> {
  const child = Bun.spawn([...command], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdin: "ignore",
    stdout: options.capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const output = options.capture && child.stdout
    ? await new Response(child.stdout).text()
    : "";
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command[0]} exited with status ${exitCode}`);
  return output.trim();
}

export function remoteCheckConfig(args: readonly string[] = process.argv.slice(2)): RemoteCheckConfig {
  if (args.length !== 2 || args[0] !== "--host") {
    throw new Error("usage: bun run test:remote -- --host <ssh-host>");
  }
  const host = args[1]!;
  if (!HOST_PATTERN.test(host)) {
    throw new Error("SSH host must be an opaque host alias containing only letters, digits, dots, underscores, or hyphens");
  }
  return { host };
}

export function assertRemoteCheckDirectory(path: string): string {
  if (!REMOTE_DIRECTORY_PATTERN.test(path)) {
    throw new Error(`refusing unsafe remote test directory: ${path}`);
  }
  return path;
}

export async function runRemoteCheck(config: RemoteCheckConfig): Promise<RemoteCheckReceipt> {
  if (!HOST_PATTERN.test(config.host)) throw new Error("invalid SSH host alias");
  const repository = resolve(import.meta.dir, "../..");
  const architecture = await run(["ssh", config.host, "uname -m"], { capture: true });
  const bunVersion = await run(["ssh", config.host, "bun --version"], { capture: true });
  const remoteDirectory = assertRemoteCheckDirectory(
    await run(["ssh", config.host, `mktemp -d ${REMOTE_PREFIX}`], { capture: true }),
  );

  try {
    await run([
      "rsync",
      "--archive",
      "--delete",
      "--exclude=.git/",
      "--exclude=node_modules/",
      "--exclude=.env*",
      "--exclude=bun.lock",
      "--exclude=*.sqlite*",
      "--exclude=*.jsonl",
      `${repository}/`,
      `${config.host}:${remoteDirectory}/`,
    ]);
    const cleanEnvironment = "env -u TELEGRAM_BOT_TOKEN -u OMPCLAW_TEST_TELEGRAM_TOKEN -u OMPCLAW_TEST_TELEGRAM_CHAT_ID";
    await run([
      "ssh",
      config.host,
      `cd ${remoteDirectory} && ${cleanEnvironment} bun install --no-save --ignore-scripts && ${cleanEnvironment} bun run check`,
    ]);
  } finally {
    await run(["ssh", config.host, `rm -rf -- ${remoteDirectory}`]);
  }

  return { host: config.host, architecture, bunVersion };
}

if (import.meta.main) {
  try {
    const receipt = await runRemoteCheck(remoteCheckConfig());
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
