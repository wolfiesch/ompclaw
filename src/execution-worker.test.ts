import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProjectExecutor } from "./execution-worker";
import type { ExecutionPolicy, ProjectDefinition, TaskExecutionContext } from "./execution-types";

const directories: string[] = [];
const restrictive: ExecutionPolicy = { write: false, commands: false, network: false, maxDurationMs: 60_000 };

function project(workspace: string, policy: ExecutionPolicy = restrictive): ProjectDefinition {
  return { id: "project", name: "Project", workspace, workerId: "local", principals: ["owner"], policy };
}

function context(workspace: string, policy: ExecutionPolicy = restrictive): TaskExecutionContext {
  return {
    projectId: "project",
    projectName: "Untrusted name is ignored",
    workspace,
    workerId: "local",
    policy,
    expiresAt: Date.now() + 30_000,
  };
}

function workspace(): string {
  const container = mkdtempSync(join(tmpdir(), "ompclaw-execution-"));
  const directory = join(container, "workspace");
  mkdirSync(directory);
  directories.push(container);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("project execution worker", () => {
  test("performs bounded workspace filesystem and artifact operations", async () => {
    const root = workspace();
    writeFileSync(join(root, "input.txt"), "initial");
    const writable = { ...restrictive, write: true };
    const executor = createProjectExecutor([project(root, writable)], []);

    await expect(
      executor.execute({
        context: context(root, writable),
        operation: { kind: "write", path: "result.txt", content: "changed" },
        approved: false,
      }),
    ).resolves.toMatchObject({ text: "Wrote result.txt", changedFiles: ["result.txt"] });
    await expect(
      executor.execute({
        context: context(root, writable),
        operation: { kind: "read", path: "result.txt" },
        approved: false,
      }),
    ).resolves.toEqual({ text: "changed" });
    await expect(
      executor.execute({ context: context(root, writable), operation: { kind: "list", path: "." }, approved: false }),
    ).resolves.toMatchObject({ text: expect.stringContaining("result.txt") });
    const artifact = await executor.execute({
      context: context(root, writable),
      operation: { kind: "artifact", path: "result.txt" },
      approved: false,
    });
    expect(artifact.artifact).toMatchObject({ name: "result.txt", size: 7 });
    expect(Buffer.from(artifact.artifactBase64!, "base64").toString("utf8")).toBe("changed");
  });

  test("performs typed nested operations without traversing nested symlinks", async () => {
    const root = workspace();
    const nested = join(root, "nested");
    const outside = join(root, "..", "outside-directory");
    mkdirSync(nested);
    mkdirSync(outside);
    writeFileSync(join(nested, "input.txt"), "nested input");
    writeFileSync(join(outside, "outside.txt"), "outside");
    symlinkSync(outside, join(root, "linked-directory"));
    symlinkSync(join(outside, "outside.txt"), join(nested, "linked-file.txt"));
    const writable = { ...restrictive, write: true };
    const executor = createProjectExecutor([project(root, writable)], []);

    await expect(
      executor.execute({
        context: context(root, writable),
        operation: { kind: "read", path: "nested/input.txt" },
        approved: false,
      }),
    ).resolves.toEqual({ text: "nested input" });
    await expect(
      executor.execute({
        context: context(root, writable),
        operation: { kind: "write", path: "nested/result.txt", content: "nested result" },
        approved: false,
      }),
    ).resolves.toMatchObject({ text: "Wrote nested/result.txt" });
    await expect(
      executor.execute({
        context: context(root, writable),
        operation: { kind: "artifact", path: "nested/result.txt" },
        approved: false,
      }),
    ).resolves.toMatchObject({ artifact: { path: "nested/result.txt" } });
    await expect(
      executor.execute({
        context: context(root, writable),
        operation: { kind: "list", path: "nested" },
        approved: false,
      }),
    ).resolves.toMatchObject({ text: expect.stringContaining("result.txt") });
    await expect(
      executor.execute({
        context: context(root, writable),
        operation: { kind: "read", path: "linked-directory/outside.txt" },
        approved: false,
      }),
    ).rejects.toThrow(/Symbolic links are not allowed|Path must name a directory/);
    await expect(
      executor.execute({
        context: context(root, writable),
        operation: { kind: "artifact", path: "nested/linked-file.txt" },
        approved: false,
      }),
    ).rejects.toThrow("Symbolic links are not allowed");
    await expect(
      executor.execute({
        context: context(root, writable),
        operation: { kind: "write", path: "linked-directory/rejected.txt", content: "no" },
        approved: false,
      }),
    ).rejects.toThrow(/Symbolic links are not allowed|Path must name a directory/);
  });

  test("rejects traversal, symlinks, sensitive execution paths, expired grants, and policy escalation", async () => {
    const root = workspace();
    const outside = join(root, "..", "outside.txt");
    writeFileSync(outside, "outside");
    writeFileSync(join(root, ".envrc"), "dangerous");
    symlinkSync(outside, join(root, "linked.txt"));
    const executor = createProjectExecutor([project(root)], []);

    await expect(
      executor.execute({
        context: context(root),
        operation: { kind: "read", path: "../outside.txt" },
        approved: false,
      }),
    ).rejects.toThrow("escapes the project workspace");
    await expect(
      executor.execute({ context: context(root), operation: { kind: "read", path: "linked.txt" }, approved: false }),
    ).rejects.toThrow("Symbolic links are not allowed");
    await expect(
      executor.execute({ context: context(root), operation: { kind: "read", path: ".envrc" }, approved: false }),
    ).rejects.toThrow("prohibited by project execution policy");
    await expect(
      executor.execute({
        context: { ...context(root), expiresAt: Date.now() - 1 },
        operation: { kind: "list", path: "." },
        approved: false,
      }),
    ).rejects.toThrow("Execution grant has expired");
    await expect(
      executor.execute({
        context: context(root, { ...restrictive, write: true }),
        operation: { kind: "write", path: "rejected.txt", content: "no" },
        approved: false,
      }),
    ).rejects.toThrow("Requested write policy exceeds configured project policy");
  });

  test("requires a Linux-isolated worker for commands and prevents writes outside the bound workspace", async () => {
    const root = workspace();
    const escaped = join(root, "..", "escaped.txt");
    const policy = { write: true, commands: true, network: false, maxDurationMs: 60_000 };
    const executor = createProjectExecutor([project(root, policy)], []);

    const outcome = await executor
      .execute({
        context: context(root, policy),
        operation: { kind: "run", command: "printf escaped > ../escaped.txt", writable: true, network: false },
        approved: true,
      })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );

    if ("error" in outcome) {
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toContain(
        process.platform === "linux"
          ? "Linux execution worker prerequisite unavailable"
          : "Linux-isolated execution worker",
      );
    } else {
      expect(outcome.result.check?.exitCode).not.toBe(0);
    }
    expect(existsSync(escaped)).toBe(false);
  });

  test.if(process.platform === "linux" && Bun.which("bwrap") !== null)(
    "masks protected workspace paths from Linux shell commands after parent renames",
    async () => {
      const root = workspace();
      const nested = join(root, "nested");
      mkdirSync(join(nested, ".git"), { recursive: true });
      writeFileSync(join(root, ".env"), "root secret");
      writeFileSync(join(root, ".env.local"), "local secret");
      writeFileSync(join(nested, ".env"), "nested secret");
      writeFileSync(join(nested, ".yarnrc.yml"), "nested config");
      writeFileSync(join(nested, ".git", "config"), "git config");
      const policy = { write: true, commands: true, network: false, maxDurationMs: 60_000 };
      const executor = createProjectExecutor([project(root, policy)], []);

      const result = await executor.execute({
        context: context(root, policy),
        operation: {
          kind: "run",
          command:
            'test ! -s .env && test ! -s .env.local && test ! -s nested/.env && test ! -s nested/.yarnrc.yml && test -z "$(ls -A nested/.git)" && if mv nested renamed; then test ! -s renamed/.env && test ! -s renamed/.yarnrc.yml; else test ! -s nested/.env && test ! -s nested/.yarnrc.yml; fi',
          writable: true,
          network: false,
        },
        approved: true,
      });

      expect(result.check?.exitCode).toBe(0);
    },
  );

  test.if(process.platform === "linux" && Bun.which("bwrap") !== null)(
    "serializes mutable shell commands before protected path scanning",
    async () => {
      const root = workspace();
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, "nested", ".env"), "secret");
      const policy = { write: true, commands: true, network: false, maxDurationMs: 60_000 };
      const executor = createProjectExecutor([project(root, policy)], []);

      const move = executor.execute({
        context: context(root, policy),
        operation: { kind: "run", command: "mv nested renamed", writable: true, network: false },
        approved: true,
      });
      const read = executor.execute({
        context: context(root, policy),
        operation: { kind: "run", command: "test ! -s renamed/.env", writable: false, network: false },
        approved: true,
      });

      await expect(move).resolves.toMatchObject({ check: { exitCode: 0 } });
      await expect(read).resolves.toMatchObject({ check: { exitCode: 0 } });
    },
  );

  test("filters protected changed paths from diffs and pins the configured work tree", async () => {
    const root = workspace();
    const redirected = join(root, "..", "redirected-worktree");
    mkdirSync(redirected);
    writeFileSync(join(root, "visible.txt"), "before\n");
    writeFileSync(join(root, ".env.local"), "before secret\n");
    execFileSync("git", ["-C", root, "init"]);
    execFileSync("git", ["-C", root, "add", "-f", "visible.txt", ".env.local"]);
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.email=worker-test@example.invalid",
      "-c",
      "user.name=Worker Test",
      "commit",
      "-m",
      "initial",
    ]);
    execFileSync("git", ["-C", root, "config", "core.worktree", redirected]);
    writeFileSync(join(root, "visible.txt"), "after\n");
    writeFileSync(join(root, ".env.local"), "after secret\n");
    const executor = createProjectExecutor([project(root)], []);

    const result = await executor.execute({ context: context(root), operation: { kind: "diff" }, approved: false });

    expect(result.text).toContain("+after");
    expect(result.text).not.toContain("after secret");
    expect(result.changedFiles).toEqual(["visible.txt"]);
  });

  test("filters protected sources in forced rename and copy diffs", async () => {
    const root = workspace();
    writeFileSync(join(root, ".env.rename"), "renamed secret\n");
    writeFileSync(join(root, ".env.copy"), "copied secret\n");
    execFileSync("git", ["-C", root, "init"]);
    execFileSync("git", ["-C", root, "add", "-f", ".env.rename", ".env.copy"]);
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.email=worker-test@example.invalid",
      "-c",
      "user.name=Worker Test",
      "commit",
      "-m",
      "initial",
    ]);
    execFileSync("git", ["-C", root, "config", "diff.renames", "false"]);
    renameSync(join(root, ".env.rename"), join(root, "renamed.txt"));
    copyFileSync(join(root, ".env.copy"), join(root, "copied.txt"));
    execFileSync("git", ["-C", root, "add", "-A"]);
    execFileSync("git", ["-C", root, "add", "-f", "renamed.txt", "copied.txt"]);
    const executor = createProjectExecutor([project(root)], []);

    const result = await executor.execute({ context: context(root), operation: { kind: "diff" }, approved: false });

    expect(result.text).not.toContain("renamed secret");
    expect(result.text).not.toContain("copied secret");
  });

  test("does not run shell commands without the correlated approval", async () => {
    const root = workspace();
    const policy = { write: false, commands: true, network: false, maxDurationMs: 60_000 };
    const executor = createProjectExecutor([project(root, policy)], []);
    await expect(
      executor.execute({
        context: context(root, policy),
        operation: { kind: "run", command: "true", writable: false, network: false },
        approved: false,
      }),
    ).rejects.toThrow("Shell commands require explicit approval");
  });

  test("uses strict non-forwarding SSH options and one JSONL request", async () => {
    const root = workspace();
    const bin = join(root, "bin");
    mkdirSync(bin);
    const argumentsFile = join(root, "ssh-arguments");
    const ssh = join(bin, "ssh");
    writeFileSync(
      ssh,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argumentsFile)}\nprintf '%s\\n' '{"ok":true,"result":{"text":"remote"}}'\n`,
    );
    chmodSync(ssh, 0o700);
    const knownHosts = join(root, "known_hosts");
    writeFileSync(knownHosts, "worker.example ssh-ed25519 AAAA\n");
    const remoteProject = { ...project("/remote/workspace"), workerId: "remote" };
    const executor = createProjectExecutor(
      [remoteProject],
      [
        {
          id: "remote",
          host: "operator@worker.example",
          command: ["ompclaw", "worker"],
          configFile: "~/.config/ompclaw-worker.json",
          knownHostsFile: knownHosts,
        },
      ],
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
    try {
      await expect(
        executor.execute({
          context: context("/remote/workspace"),
          operation: { kind: "list", path: "." },
          approved: false,
        }),
      ).resolves.toEqual({ text: "remote" });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    const argumentsObserved = readFileSync(argumentsFile, "utf8");
    expect(argumentsObserved).toContain("-T\n");
    expect(argumentsObserved).toContain("StrictHostKeyChecking=yes");
    expect(argumentsObserved).toContain("ForwardAgent=no");
    expect(argumentsObserved).toContain("ForwardX11=no");
    expect(argumentsObserved).toContain("ClearAllForwardings=yes");
  });

  test("remote worker resolves its own configured workspace and rejects escalated grants", async () => {
    const root = workspace();
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot);
    writeFileSync(join(projectRoot, "remote.txt"), "remote");
    const configFile = join(root, "worker.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        projects: [
          {
            id: "project",
            name: "Configured remotely",
            workspace: projectRoot,
            workerId: "local",
            principals: ["owner"],
            policy: restrictive,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const entry = join(root, "worker-entry.ts");
    writeFileSync(
      entry,
      `import { runExecutionWorker } from ${JSON.stringify(join(import.meta.dir, "execution-worker.ts"))};\nawait runExecutionWorker(process.argv[2]!);\n`,
    );
    const runWorker = async (request: object) => {
      const child = Bun.spawn([process.execPath, entry, configFile], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.write(`${JSON.stringify(request)}\n`);
      child.stdin.end();
      return { exitCode: await child.exited, output: await new Response(child.stdout).text() };
    };
    const request = {
      context: { ...context("/untrusted/coordinator/path"), projectName: "forged", workerId: "remote" },
      operation: { kind: "list", path: "." },
      approved: false,
    };
    await expect(runWorker(request)).resolves.toMatchObject({
      exitCode: 0,
      output: expect.stringContaining('"text":"remote.txt"'),
    });
    await expect(
      runWorker({
        ...request,
        context: { ...request.context, policy: { ...restrictive, write: true } },
      }),
    ).resolves.toMatchObject({
      exitCode: 1,
      output: expect.stringContaining("Requested write policy exceeds configured project policy"),
    });
  });
});
