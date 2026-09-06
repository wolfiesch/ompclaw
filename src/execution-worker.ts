import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  ExecutionArtifact,
  ExecutionCheck,
  ExecutionOperation,
  ExecutionPolicy,
  ExecutionRequest,
  ExecutionResult,
  ProjectDefinition,
  ProjectExecutor,
  SshWorkerDefinition,
  TaskExecutionContext,
} from "./execution-types";
import { parseExecutionProjects } from "./gateway-config";
import { isRecord } from "./type-guards";
import {
  listWorkspaceDirectory,
  protectedWorkspacePaths,
  readWorkspaceFile,
  sensitiveWorkspacePath,
  writeWorkspaceFile,
} from "./execution-filesystem";

const MAX_TEXT_BYTES = 1_048_576;
const MAX_ARTIFACT_BYTES = 8 * 1_024 * 1_024;
const MAX_COMMAND_BYTES = 64 * 1_024;
const LOCAL_WORKER_ID = "local";

interface ProcessResult {
  readonly exitCode: number;
  readonly output: string;
}

interface RemoteResponse {
  readonly ok: boolean;
  readonly result?: ExecutionResult;
  readonly error?: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function string(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0, `${label} must be a non-empty string`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  assert(typeof value === "boolean", `${label} must be a boolean`);
  return value;
}

function number(value: unknown, label: string): number {
  assert(typeof value === "number" && Number.isFinite(value), `${label} must be a finite number`);
  return value;
}

function parsePolicy(value: unknown, label: string): ExecutionPolicy {
  assert(isRecord(value), `${label} must be an object`);
  const maxDurationMs = number(value.maxDurationMs, `${label}.maxDurationMs`);
  assert(maxDurationMs > 0, `${label}.maxDurationMs must be positive`);
  return {
    write: boolean(value.write, `${label}.write`),
    commands: boolean(value.commands, `${label}.commands`),
    network: boolean(value.network, `${label}.network`),
    maxDurationMs,
  };
}

function parseContext(value: unknown): TaskExecutionContext {
  assert(isRecord(value), "request.context must be an object");
  return {
    projectId: string(value.projectId, "request.context.projectId"),
    projectName: string(value.projectName, "request.context.projectName"),
    workspace: string(value.workspace, "request.context.workspace"),
    workerId: string(value.workerId, "request.context.workerId"),
    policy: parsePolicy(value.policy, "request.context.policy"),
    expiresAt: number(value.expiresAt, "request.context.expiresAt"),
  };
}

function parseOperation(value: unknown): ExecutionOperation {
  assert(isRecord(value), "request.operation must be an object");
  const kind = string(value.kind, "request.operation.kind");
  switch (kind) {
    case "list":
      return { kind, path: string(value.path, "request.operation.path") };
    case "read":
      return { kind, path: string(value.path, "request.operation.path") };
    case "write":
      return {
        kind,
        path: string(value.path, "request.operation.path"),
        content: string(value.content, "request.operation.content"),
      };
    case "run":
      return {
        kind,
        command: string(value.command, "request.operation.command"),
        writable: boolean(value.writable, "request.operation.writable"),
        network: boolean(value.network, "request.operation.network"),
      };
    case "diff":
      return { kind };
    case "artifact":
      return { kind, path: string(value.path, "request.operation.path") };
    default:
      throw new Error(`Unsupported execution operation: ${kind}`);
  }
}

function parseRequest(value: unknown): ExecutionRequest {
  assert(isRecord(value), "Worker request must be an object");
  return {
    context: parseContext(value.context),
    operation: parseOperation(value.operation),
    approved: boolean(value.approved, "request.approved"),
  };
}

function restrictivePolicy(requested: ExecutionPolicy, configured: ExecutionPolicy): ExecutionPolicy {
  assert(!requested.network || requested.commands, "Network policy requires command policy");
  assert(!requested.write || configured.write, "Requested write policy exceeds configured project policy");
  assert(!requested.commands || configured.commands, "Requested command policy exceeds configured project policy");
  assert(!requested.network || configured.network, "Requested network policy exceeds configured project policy");
  assert(requested.maxDurationMs <= configured.maxDurationMs, "Requested duration exceeds configured project policy");
  return requested;
}

function boundedText(buffer: Buffer, truncated: boolean): string {
  const suffix = truncated ? "\n[output truncated]" : "";
  return `${buffer.toString("utf8")}${suffix}`;
}

function collect(stream: NodeJS.ReadableStream, limit: number): Promise<{ buffer: Buffer; truncated: boolean }> {
  const collected = Promise.withResolvers<{ buffer: Buffer; truncated: boolean }>();
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  stream.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = limit - size;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    if (bytes.length > remaining) {
      chunks.push(bytes.subarray(0, remaining));
      size += remaining;
      truncated = true;
      return;
    }
    chunks.push(bytes);
    size += bytes.length;
  });
  stream.once("error", collected.reject);
  stream.once("end", () => collected.resolve({ buffer: Buffer.concat(chunks, size), truncated }));
  return collected.promise;
}

function killProcessTree(child: Pick<ChildProcess, "pid" | "kill">, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // A process can exit between the check and group signal.
    }
  }
  child.kill(signal);
}

async function runProcess(options: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new Error("Execution cancelled");
  assert(options.timeoutMs > 0, "Execution grant has expired");
  const child = spawn(options.executable, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = collect(child.stdout, MAX_TEXT_BYTES / 2);
  const stderr = collect(child.stderr, MAX_TEXT_BYTES / 2);
  const exit = Promise.withResolvers<number>();
  let termination: NodeJS.Signals | null = null;
  child.once("error", exit.reject);
  child.once("exit", (code, signal) => {
    termination = signal;
    exit.resolve(code ?? (signal === null ? 1 : 128));
  });
  let aborted = false;
  let forceKill: NodeJS.Timeout | undefined;
  const abort = () => {
    if (aborted) return;
    aborted = true;
    killProcessTree(child);
    forceKill = setTimeout(() => killProcessTree(child, "SIGKILL"), 1_000);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs);
  try {
    const [exitCode, capturedStdout, capturedStderr] = await Promise.all([exit.promise, stdout, stderr]);
    // The direct child can exit before ordinary background descendants. Terminate
    // its separate process group before issuing the execution receipt.
    killProcessTree(child);
    const output =
      [
        boundedText(capturedStdout.buffer, capturedStdout.truncated),
        boundedText(capturedStderr.buffer, capturedStderr.truncated),
      ]
        .filter(Boolean)
        .join("\n") || (termination === null ? "" : `Process terminated by ${termination}`);
    if (aborted) throw new Error(options.signal?.aborted ? "Execution cancelled" : "Execution timed out");
    return { exitCode, output };
  } finally {
    clearTimeout(timer);
    clearTimeout(forceKill);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function workspaceRoot(project: ProjectDefinition): Promise<string> {
  const root = await realpath(project.workspace);
  const info = await lstat(root);
  assert(
    info.isDirectory() && !info.isSymbolicLink(),
    `Configured workspace is not a real directory for project ${project.id}`,
  );
  return root;
}

async function gitEvidence(
  root: string,
  signal?: AbortSignal,
): Promise<{ revision?: string; changedFiles: readonly string[] }> {
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root,
    TMPDIR: root,
    LANG: "C.UTF-8",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
  };
  const gitOptions = [
    `--work-tree=${root}`,
    "-c",
    "core.pager=cat",
    "-c",
    "diff.external=",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.useBuiltinFSMonitor=false",
  ];
  try {
    const revision = await runProcess({
      executable: "git",
      args: [...gitOptions, "rev-parse", "HEAD"],
      cwd: root,
      env,
      timeoutMs: 10_000,
      signal,
    });
    if (revision.exitCode !== 0) return { changedFiles: [] };
    const changed = await runProcess({
      executable: "git",
      args: [...gitOptions, "diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "HEAD"],
      cwd: root,
      env,
      timeoutMs: 10_000,
      signal,
    });
    if (changed.exitCode !== 0) return { revision: revision.output.trim(), changedFiles: [] };
    return {
      revision: revision.output.trim(),
      changedFiles: changed.output.split("\0").filter((path) => path.length > 0 && !sensitiveWorkspacePath(path)),
    };
  } catch {
    return { changedFiles: [] };
  }
}

function sandboxExecutable(): string | undefined {
  if (process.platform !== "linux") return undefined;
  const candidates = process.env.PATH?.split(delimiter).map((directory) => join(directory, "bwrap")) ?? [];
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
async function protectedSandboxMounts(root: string, scratch: string): Promise<string[]> {
  const masks = join(scratch, "protected-workspace-paths");
  await mkdir(masks);
  const mounts: string[] = [];
  for (const [index, protectedPath] of protectedWorkspacePaths(root).entries()) {
    const source = join(masks, String(index));
    if (protectedPath.directory) await mkdir(source);
    else await writeFile(source, "", { mode: 0o600 });
    mounts.push("--ro-bind", source, join("/workspace", protectedPath.relative));
  }
  return mounts;
}

async function linuxSandboxArgs(
  root: string,
  scratch: string,
  operation: Extract<ExecutionOperation, { kind: "run" }>,
): Promise<string[]> {
  const runtimeRoots = ["/usr", "/bin", "/lib", "/lib64"].filter(existsSync);
  const runtimeEtcFiles = [
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/ld.so.cache",
    "/etc/localtime",
  ].filter(existsSync);
  const sslCertificates = "/etc/ssl/certs";
  const protectedMounts = await protectedSandboxMounts(root, scratch);
  return [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    ...(operation.network ? ["--share-net"] : []),
    "--tmpfs",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    ...runtimeRoots.flatMap((path) => ["--dir", path, "--ro-bind", path, path]),
    "--dir",
    "/etc",
    ...runtimeEtcFiles.flatMap((path) => ["--ro-bind", path, path]),
    ...(existsSync(sslCertificates) ? ["--dir", "/etc/ssl", "--ro-bind", sslCertificates, sslCertificates] : []),
    ...(operation.writable ? ["--bind", root, "/workspace"] : ["--ro-bind", root, "/workspace"]),
    ...protectedMounts,
    "--bind",
    scratch,
    "/tmp",
    "--remount-ro",
    "/",
    "--chdir",
    "/workspace",
    "/bin/sh",
    "-c",
    operation.command,
  ];
}

async function runSandboxed(
  root: string,
  context: TaskExecutionContext,
  operation: Extract<ExecutionOperation, { kind: "run" }>,
  signal?: AbortSignal,
): Promise<ExecutionCheck> {
  assert(context.policy.commands, "Shell commands are disabled by project policy");
  assert(Buffer.byteLength(operation.command) <= MAX_COMMAND_BYTES, "Command exceeds the maximum size");
  assert(!operation.writable || context.policy.write, "Writable command exceeds project policy");
  assert(!operation.network || context.policy.network, "Network command exceeds project policy");
  const executable = sandboxExecutable();
  if (!executable) {
    throw new Error(
      process.platform === "linux"
        ? "Linux execution worker prerequisite unavailable: install bubblewrap (bwrap) with unprivileged user namespaces enabled"
        : "Scoped shell commands require a Linux-isolated execution worker; use a configured Linux SSH worker",
    );
  }
  const scratch = await mkdtemp(join(tmpdir(), "ompclaw-exec-"));
  try {
    const remaining = Math.min(context.policy.maxDurationMs, context.expiresAt - Date.now());
    const result = await runProcess({
      executable,
      args: await linuxSandboxArgs(root, scratch, operation),
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: "/tmp",
        TMPDIR: "/tmp",
        LANG: "C.UTF-8",
      },
      timeoutMs: remaining,
      signal,
    });
    if (result.exitCode === 128 && result.output.startsWith("Process terminated by ")) {
      throw new Error(
        `Sandbox execution terminated before the command completed: ${result.output}. Verify the worker sandbox prerequisite and profile.`,
      );
    }
    return { command: operation.command, exitCode: result.exitCode, output: result.output };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function executeLocal(
  project: ProjectDefinition,
  context: TaskExecutionContext,
  operation: ExecutionOperation,
  approved: boolean,
  signal?: AbortSignal,
): Promise<ExecutionResult> {
  assert(context.expiresAt > Date.now(), "Execution grant has expired");
  const root = await workspaceRoot(project);
  switch (operation.kind) {
    case "list": {
      const { text } = listWorkspaceDirectory(root, operation.path);
      const bytes = Buffer.from(text, "utf8");
      return {
        text:
          bytes.length > MAX_TEXT_BYTES
            ? `${bytes.subarray(0, MAX_TEXT_BYTES).toString("utf8")}\n[output truncated]`
            : text,
      };
    }
    case "read": {
      const { bytes } = readWorkspaceFile(
        root,
        operation.path,
        MAX_TEXT_BYTES,
        `File exceeds read limit of ${MAX_TEXT_BYTES} bytes`,
      );
      return { text: bytes.toString("utf8") };
    }
    case "write": {
      assert(context.policy.write, "Writes are disabled by project policy");
      assert(Buffer.byteLength(operation.content) <= MAX_TEXT_BYTES, `Write exceeds limit of ${MAX_TEXT_BYTES} bytes`);
      const changed = writeWorkspaceFile(root, operation.path, operation.content);
      const evidence = await gitEvidence(root, signal);
      return {
        text: `Wrote ${changed}`,
        changedFiles: evidence.changedFiles.length > 0 ? evidence.changedFiles : [changed],
        ...(evidence.revision === undefined ? {} : { revision: evidence.revision }),
      };
    }
    case "run": {
      assert(approved, "Shell commands require explicit approval");
      const check = await runSandboxed(root, context, operation, signal);
      const evidence = await gitEvidence(root, signal);
      return {
        text: check.output,
        check,
        changedFiles: evidence.changedFiles,
        ...(evidence.revision === undefined ? {} : { revision: evidence.revision }),
      };
    }
    case "diff": {
      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: root,
        TMPDIR: root,
        LANG: "C.UTF-8",
        GIT_PAGER: "cat",
        PAGER: "cat",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
      };
      const remaining = Math.min(context.policy.maxDurationMs, context.expiresAt - Date.now());
      const candidatePaths = await runProcess({
        executable: "git",
        args: [
          `--work-tree=${root}`,
          "-c",
          "core.pager=cat",
          "-c",
          "diff.external=",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.useBuiltinFSMonitor=false",
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--find-renames",
          "--find-copies-harder",
          "-l0",
          "--name-status",
          "-z",
          "HEAD",
          "--",
        ],
        cwd: root,
        env,
        timeoutMs: remaining,
        signal,
      });
      assert(candidatePaths.exitCode === 0, `Git diff failed: ${candidatePaths.output}`);
      const changedFields = candidatePaths.output.split("\0");
      const visiblePaths: string[] = [];
      for (let index = 0; index < changedFields.length - 1; ) {
        const status = changedFields[index++]!;
        const firstPath = changedFields[index++]!;
        const secondPath = /^[RC]/.test(status) ? changedFields[index++]! : undefined;
        if (
          firstPath.length > 0 &&
          !sensitiveWorkspacePath(firstPath) &&
          (secondPath === undefined || (secondPath.length > 0 && !sensitiveWorkspacePath(secondPath)))
        ) {
          visiblePaths.push(secondPath ?? firstPath);
        }
      }
      let output = "";
      if (visiblePaths.length > 0) {
        const diff = await runProcess({
          executable: "git",
          args: [
            `--work-tree=${root}`,
            "-c",
            "core.pager=cat",
            "-c",
            "diff.external=",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.useBuiltinFSMonitor=false",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "HEAD",
            "--",
            ...visiblePaths,
          ],
          cwd: root,
          env,
          timeoutMs: remaining,
          signal,
        });
        assert(diff.exitCode === 0, `Git diff failed: ${diff.output}`);
        output = diff.output;
      }
      const evidence = await gitEvidence(root, signal);
      return {
        text: output,
        changedFiles: evidence.changedFiles,
        ...(evidence.revision === undefined ? {} : { revision: evidence.revision }),
      };
    }
    case "artifact": {
      const { relative: path, bytes } = readWorkspaceFile(
        root,
        operation.path,
        MAX_ARTIFACT_BYTES,
        `Artifact exceeds limit of ${MAX_ARTIFACT_BYTES} bytes`,
      );
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const artifact: ExecutionArtifact = {
        id: sha256.slice(0, 24),
        name: basename(path),
        path,
        size: bytes.length,
        sha256,
      };
      return { text: `Captured artifact ${artifact.name}`, artifact, artifactBase64: bytes.toString("base64") };
    }
  }
}

function resolveConfiguredContext(
  project: ProjectDefinition,
  incoming: TaskExecutionContext,
  workerId: string,
  requireWorkspaceMatch: boolean,
): TaskExecutionContext {
  assert(incoming.projectId === project.id, "Requested project is not configured for this worker");
  if (requireWorkspaceMatch)
    assert(incoming.workspace === project.workspace, "Requested workspace does not match configured project workspace");
  assert(incoming.expiresAt > Date.now(), "Execution grant has expired");
  assert(
    incoming.expiresAt <= Date.now() + project.policy.maxDurationMs,
    "Execution grant exceeds configured project duration",
  );
  return {
    projectId: project.id,
    projectName: project.name,
    workspace: project.workspace,
    workerId,
    policy: restrictivePolicy(incoming.policy, project.policy),
    expiresAt: incoming.expiresAt,
  };
}

function posixQuote(argument: string): string {
  return `'${argument.replace(/'/g, "'\\''")}'`;
}

function remoteConfigPath(path: string): string {
  return path.startsWith("~/") ? `"$HOME"/${posixQuote(path.slice(2))}` : posixQuote(path);
}

async function executeRemote(
  worker: SshWorkerDefinition,
  request: ExecutionRequest,
  signal?: AbortSignal,
): Promise<ExecutionResult> {
  assert(worker.command.length > 0, `SSH worker ${worker.id} has no command`);
  const knownHosts = lstatSync(worker.knownHostsFile);
  assert(
    knownHosts.isFile() && !knownHosts.isSymbolicLink(),
    `SSH worker ${worker.id} known_hosts must be a regular file`,
  );
  const remoteCommand = [...worker.command.map(posixQuote), "--config", remoteConfigPath(worker.configFile)].join(" ");
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${worker.knownHostsFile}`,
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    worker.host,
    remoteCommand,
  ];
  if (signal?.aborted) throw new Error("Execution cancelled");
  const timeoutMs = Math.min(request.context.policy.maxDurationMs, request.context.expiresAt - Date.now());
  assert(timeoutMs > 0, "Execution grant has expired");
  const child = spawn("ssh", args, {
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  child.stdin.end(
    `${JSON.stringify({ context: request.context, operation: request.operation, approved: request.approved })}\n`,
  );
  const stdout = collect(child.stdout, MAX_ARTIFACT_BYTES + MAX_TEXT_BYTES);
  const stderr = collect(child.stderr, MAX_TEXT_BYTES);
  const exit = Promise.withResolvers<number>();
  child.once("error", exit.reject);
  child.once("exit", (code, termination) => exit.resolve(code ?? (termination === null ? 1 : 128)));
  let aborted = false;
  let forceKill: NodeJS.Timeout | undefined;
  const abort = () => {
    if (aborted) return;
    aborted = true;
    killProcessTree(child);
    forceKill = setTimeout(() => killProcessTree(child, "SIGKILL"), 1_000);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const [exitCode, capturedStdout, capturedStderr] = await Promise.all([exit.promise, stdout, stderr]);
    if (aborted) throw new Error(signal?.aborted ? "Execution cancelled" : "Execution timed out");
    assert(!capturedStdout.truncated, "SSH worker response exceeds transfer limit");
    const lines = capturedStdout.buffer.toString("utf8").trim().split(/\r?\n/).filter(Boolean);
    if (exitCode !== 0 && lines.length === 1) {
      const failed = JSON.parse(lines[0]) as RemoteResponse;
      if (failed.ok === false) throw new Error(failed.error ?? "SSH worker rejected the request");
    }
    assert(exitCode === 0, `SSH worker failed: ${boundedText(capturedStderr.buffer, capturedStderr.truncated)}`);
    assert(lines.length === 1, "SSH worker returned an invalid response stream");
    const response = JSON.parse(lines[0]) as RemoteResponse;
    assert(response.ok === true && response.result !== undefined, response.error ?? "SSH worker rejected the request");
    return response.result;
  } finally {
    clearTimeout(timer);
    clearTimeout(forceKill);
    signal?.removeEventListener("abort", abort);
  }
}

/** Creates a coordinator-side executor. Every project and worker is server configured. */
export function createProjectExecutor(
  projects: readonly ProjectDefinition[],
  workers: readonly SshWorkerDefinition[],
): ProjectExecutor {
  const projectById = new Map<string, ProjectDefinition>();
  const workerById = new Map<string, SshWorkerDefinition>();
  for (const project of projects) {
    assert(!projectById.has(project.id), `Duplicate project id: ${project.id}`);
    projectById.set(project.id, project);
  }
  for (const worker of workers) {
    assert(!workerById.has(worker.id), `Duplicate SSH worker id: ${worker.id}`);
    workerById.set(worker.id, worker);
  }
  let queue = Promise.resolve();
  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = queue;
    const complete = Promise.withResolvers<void>();
    queue = complete.promise;
    await previous;
    try {
      return await operation();
    } finally {
      complete.resolve();
    }
  };
  return {
    execute(request, signal) {
      return serialize(async () => {
        if (signal?.aborted) throw new Error("Execution cancelled");
        const project = projectById.get(request.context.projectId);
        assert(project !== undefined, `Project is not configured: ${request.context.projectId}`);
        if (project.workerId === LOCAL_WORKER_ID) {
          const context = resolveConfiguredContext(project, request.context, LOCAL_WORKER_ID, true);
          return executeLocal(project, context, request.operation, request.approved, signal);
        }
        const worker = workerById.get(project.workerId);
        assert(worker !== undefined, `Project ${project.id} references unknown SSH worker ${project.workerId}`);
        const context = resolveConfiguredContext(project, request.context, worker.id, true);
        return executeRemote(worker, { ...request, context }, signal);
      });
    },
  };
}

function readPrivateWorkerConfig(path: string): unknown {
  const info = lstatSync(path);
  assert(info.isFile() && !info.isSymbolicLink(), "Worker config must be a regular file, not a symlink");
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    assert(uid === undefined || info.uid === uid, "Worker config must be owned by the current user");
    assert((info.mode & 0o077) === 0, "Worker config permissions must be 0600 or stricter");
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("Worker config must contain valid JSON");
  }
}

/** Handles exactly one JSON request for an operator-owned remote worker configuration. */
export async function runExecutionWorker(configPath: string): Promise<void> {
  const config = readPrivateWorkerConfig(configPath);
  assert(isRecord(config), "Worker config must be an object");
  assert(
    Object.keys(config).every((key) => key === "projects") && "projects" in config,
    "Worker config requires only a projects array",
  );
  const projects = parseExecutionProjects(config.projects, dirname(configPath));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  assert(projectById.size === projects.length, "Worker config contains duplicate project ids");
  for (const project of projects)
    assert(project.workerId === LOCAL_WORKER_ID, "Remote worker projects must use workerId local");
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let requestLine: string | undefined;
  for await (const line of input) {
    assert(requestLine === undefined, "Worker accepts exactly one request");
    requestLine = line;
  }
  assert(
    requestLine !== undefined && Buffer.byteLength(requestLine) <= MAX_COMMAND_BYTES + MAX_TEXT_BYTES,
    "Worker request is missing or exceeds its limit",
  );
  try {
    const request = parseRequest(JSON.parse(requestLine));
    const project = projectById.get(request.context.projectId);
    assert(project !== undefined, "Requested project is not configured for this worker");
    const context = resolveConfiguredContext(project, request.context, LOCAL_WORKER_ID, false);
    const result = await executeLocal(project, context, request.operation, request.approved);
    process.stdout.write(`${JSON.stringify({ ok: true, result: result satisfies ExecutionResult })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker request failed";
    process.stdout.write(`${JSON.stringify({ ok: false, error: message } satisfies RemoteResponse)}\n`);
    process.exitCode = 1;
  }
}
