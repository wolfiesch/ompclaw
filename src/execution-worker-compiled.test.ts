import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.if(process.platform === "darwin" || process.platform === "linux")(
  "compiled worker performs filesystem operations without a source checkout asset path",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ompclaw-compiled-worker-"));
    try {
      const workspace = join(directory, "workspace");
      await mkdir(workspace);
      await writeFile(join(workspace, "proof.txt"), "compiled worker proof");
      const policy = { write: false, commands: false, network: false, maxDurationMs: 60_000 };
      const configFile = join(directory, "worker.json");
      await writeFile(
        configFile,
        JSON.stringify({
          projects: [{ id: "proof", name: "Proof", workspace, workerId: "local", principals: ["proof"], policy }],
        }),
        { mode: 0o600 },
      );
      const executable = join(directory, "ompclaw");
      const build = Bun.spawn(
        [process.execPath, "build", join(import.meta.dir, "rpc-cli.ts"), "--compile", "--outfile", executable],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [buildExit, buildError] = await Promise.all([
        build.exited,
        new Response(build.stderr).text(),
        new Response(build.stdout).text(),
      ]);
      expect(buildExit, buildError).toBe(0);
      const request = {
        context: {
          projectId: "proof",
          projectName: "Proof",
          workspace: "/untrusted/coordinator/path",
          workerId: "remote",
          policy,
          expiresAt: Date.now() + 60_000,
        },
        operation: { kind: "list", path: "." },
        approved: false,
      };
      const worker = Bun.spawn([executable, "worker", "--config", configFile], {
        cwd: directory,
        stdin: new Blob([`${JSON.stringify(request)}\n`]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, output, error] = await Promise.all([
        worker.exited,
        new Response(worker.stdout).text(),
        new Response(worker.stderr).text(),
      ]);
      expect(exitCode, output + error).toBe(0);
      expect(JSON.parse(output)).toMatchObject({ ok: true, result: { text: "proof.txt" } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
