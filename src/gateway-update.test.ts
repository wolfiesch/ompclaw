import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GatewayUpdateCoordinator,
  MIN_GATEWAY_UPDATE_FREE_BYTES,
  currentGatewayRelease,
  gatewayUpdatePaths,
  readUpdateRequest,
  readUpdateResult,
  writeUpdateResult,
  withGatewayUpdateLock,
  type GatewayUpdateRelease,
} from "./gateway-update";
import { GatewayUpdateSupervisor, type ManagedGatewayProcess } from "./gateway-update-supervisor";
import type { GatewayDelivery } from "./gateway-tools";

const directories: string[] = [];
const originalReleaseId = process.env.OMPCLAW_RELEASE_ID;
const originalRequestId = process.env.OMPCLAW_UPDATE_REQUEST_ID;

const COMMIT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMMIT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ompclaw-update-"));
  directories.push(directory);
  return directory;
}

function createRelease(
  stateDir: string,
  id: string,
  commit: string,
  gatewayScript = "#!/bin/sh\nexit 0\n",
): GatewayUpdateRelease {
  const paths = gatewayUpdatePaths(stateDir);
  const path = join(paths.releases, id);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(path, "ompclaw"), gatewayScript, { mode: 0o700 });
  writeFileSync(join(path, "ompclaw-supervisor"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(join(path, "ompclaw"), 0o700);
  chmodSync(join(path, "ompclaw-supervisor"), 0o700);
  const release = { id, commit, version: id.split("-")[0]!, path };
  writeFileSync(join(path, "manifest.json"), `${JSON.stringify(release)}\n`, { mode: 0o600 });
  return release;
}


afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (originalReleaseId === undefined) delete process.env.OMPCLAW_RELEASE_ID;
  else process.env.OMPCLAW_RELEASE_ID = originalReleaseId;
  if (originalRequestId === undefined) delete process.env.OMPCLAW_UPDATE_REQUEST_ID;
  else process.env.OMPCLAW_UPDATE_REQUEST_ID = originalRequestId;
});

describe("transactional gateway updates", () => {
  test("rejects a new release before build when staging space is below the minimum", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    const stateDir = join(root, "state");
    mkdirSync(repository, { recursive: true });
    const commands: string[][] = [];
    const coordinator = new GatewayUpdateCoordinator({
      config: { enabled: true, repository, healthTimeoutMs: 30_000 },
      stateDir,
      getAvailableBytes: () => MIN_GATEWAY_UPDATE_FREE_BYTES - 1024n * 1024n * 1024n,
      runCommand: async (argv) => {
        commands.push([...argv]);
        if (argv[1] === "rev-parse") return COMMIT_B;
        if (argv[1] === "show") return JSON.stringify({ version: "0.9.2" });
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      },
    });

    await expect(coordinator.stage(COMMIT_B)).rejects.toThrow(
      "3.0 GiB available, 4.0 GiB required",
    );
    expect(commands).toHaveLength(2);
  });

  test("reuses an existing release without requiring staging headroom", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    const stateDir = join(root, "state");
    mkdirSync(repository, { recursive: true });
    const existing = createRelease(stateDir, "0.9.2-bbbbbbbbbbbb", COMMIT_B);
    const coordinator = new GatewayUpdateCoordinator({
      config: { enabled: true, repository, healthTimeoutMs: 30_000 },
      stateDir,
      getAvailableBytes: () => {
        throw new Error("disk check must not run for an existing release");
      },
      runCommand: async (argv) => {
        if (argv[1] === "rev-parse") return COMMIT_B;
        if (argv[1] === "show") return JSON.stringify({ version: "0.9.2" });
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      },
    });

    const result = await coordinator.stage(COMMIT_B);
    expect(result.reused).toBe(true);
    expect(result.release).toMatchObject({
      id: existing.id,
      commit: existing.commit,
      version: existing.version,
    });
  });

  test("arms an inactive release and commits only after the turn", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    const stateDir = join(root, "state");
    mkdirSync(repository, { recursive: true });
    const coordinator = new GatewayUpdateCoordinator({
      config: { enabled: true, repository, healthTimeoutMs: 30_000 },
      stateDir,
    });
    const previous = createRelease(stateDir, "0.7.0-aaaaaaaaaaaa", COMMIT_A);
    const candidate = createRelease(stateDir, "0.8.0-bbbbbbbbbbbb", COMMIT_B);
    coordinator.bootstrap(previous);

    await coordinator.arm(candidate.id, {
      address: { transport: "telegram", account: "default", channel: "42" },
      principal: { id: "operator-42", roles: ["operator"] },
    });
    expect(readUpdateRequest(coordinator.paths.request)?.status).toBe("armed");
    expect(currentGatewayRelease(coordinator.paths).id).toBe(previous.id);

    await coordinator.commitArmed();
    expect(readUpdateRequest(coordinator.paths.request)?.status).toBe("committed");
    expect(currentGatewayRelease(coordinator.paths).id).toBe(previous.id);
  });

  test("serializes activation with service update operations", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    const stateDir = join(root, "state");
    mkdirSync(repository, { recursive: true });
    const coordinator = new GatewayUpdateCoordinator({
      config: { enabled: true, repository, healthTimeoutMs: 30_000 },
      stateDir,
    });
    const previous = createRelease(stateDir, "0.7.0-aaaaaaaaaaaa", COMMIT_A);
    const candidate = createRelease(stateDir, "0.8.0-bbbbbbbbbbbb", COMMIT_B);
    coordinator.bootstrap(previous);

    await withGatewayUpdateLock(coordinator.paths.lock, async () => {
      await expect(coordinator.arm(candidate.id, {
        address: { transport: "telegram", account: "default", channel: "42" },
        principal: { id: "operator-42", roles: ["operator"] },
      })).rejects.toThrow("Another OmpClaw update operation is running");
    });

    expect(readUpdateRequest(coordinator.paths.request)).toBeUndefined();
  });

  test("discards an armed release when the activation turn is not delivered", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    const stateDir = join(root, "state");
    mkdirSync(repository, { recursive: true });
    const coordinator = new GatewayUpdateCoordinator({
      config: { enabled: true, repository, healthTimeoutMs: 30_000 },
      stateDir,
    });
    const previous = createRelease(stateDir, "0.7.0-aaaaaaaaaaaa", COMMIT_A);
    const candidate = createRelease(stateDir, "0.8.0-bbbbbbbbbbbb", COMMIT_B);
    coordinator.bootstrap(previous);

    await coordinator.arm(candidate.id, {
      address: { transport: "telegram", account: "default", channel: "42" },
      principal: { id: "operator-42", roles: ["operator"] },
    });
    await coordinator.discardArmed();

    expect(readUpdateRequest(coordinator.paths.request)).toBeUndefined();
    expect(currentGatewayRelease(coordinator.paths).id).toBe(previous.id);
  });

  test("rejects activation outside a supervisor-managed gateway process", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    const stateDir = join(root, "state");
    mkdirSync(repository, { recursive: true });
    let supervisorManaged = false;
    const coordinator = new GatewayUpdateCoordinator({
      config: { enabled: true, repository, healthTimeoutMs: 30_000 },
      stateDir,
      activationEnabled: () => supervisorManaged,
    });
    const previous = createRelease(stateDir, "0.7.0-aaaaaaaaaaaa", COMMIT_A);
    const candidate = createRelease(stateDir, "0.8.0-bbbbbbbbbbbb", COMMIT_B);
    coordinator.bootstrap(previous);

    await expect(coordinator.arm(candidate.id, {
      address: { transport: "telegram", account: "default", channel: "42" },
      principal: { id: "operator-42", roles: ["operator"] },
    })).rejects.toThrow("requires a supervisor-managed gateway process");
    expect(readUpdateRequest(coordinator.paths.request)).toBeUndefined();
    supervisorManaged = true;
    await coordinator.arm(candidate.id, {
      address: { transport: "telegram", account: "default", channel: "42" },
      principal: { id: "operator-42", roles: ["operator"] },
    });
    expect(readUpdateRequest(coordinator.paths.request)?.status).toBe("armed");
  });

  test("explains how to bootstrap a missing current release", () => {
    const paths = gatewayUpdatePaths(temporaryDirectory());

    expect(() => currentGatewayRelease(paths)).toThrow("run ompclaw service-install");
  });

  test("marks a candidate ready and reports supervisor success once", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    const stateDir = join(root, "state");
    mkdirSync(repository, { recursive: true });
    const coordinator = new GatewayUpdateCoordinator({
      config: { enabled: true, repository, healthTimeoutMs: 30_000 },
      stateDir,
    });
    const previous = createRelease(stateDir, "0.7.0-aaaaaaaaaaaa", COMMIT_A);
    const candidate = createRelease(stateDir, "0.8.0-bbbbbbbbbbbb", COMMIT_B);
    coordinator.bootstrap(previous);
    await coordinator.arm(candidate.id, {
      address: { transport: "telegram", account: "default", channel: "42" },
      principal: { id: "operator-42", roles: ["operator"] },
    });
    await coordinator.commitArmed();
    const request = readUpdateRequest(coordinator.paths.request)!;
    process.env.OMPCLAW_RELEASE_ID = candidate.id;
    process.env.OMPCLAW_UPDATE_REQUEST_ID = request.id;
    writeFileSync(join(coordinator.paths.ready, `${request.id}.json`), "existing readiness marker");
    writeUpdateResult(coordinator.paths.result, {
      schema: 1,
      requestId: request.id,
      status: "succeeded",
      releaseId: candidate.id,
      previousReleaseId: previous.id,
      completedAt: new Date().toISOString(),
    });

    const sent: string[] = [];
    const delivery: GatewayDelivery = {
      async send(_address, content) {
        sent.push(content.text ?? "");
        return { transport: "telegram", messageId: "1" };
      },
      async update(_address, receipt) {
        return receipt;
      },
      async finalize() {
        return [];
      },
      async react() {},
      async presentUi() {
        throw new Error("not used");
      },
    };
    await coordinator.reconcile(delivery);
    coordinator.stop();

    expect(sent).toEqual([`OmpClaw update ${candidate.id} is active.`]);
    expect(readUpdateRequest(coordinator.paths.request)?.status).toBe("notified");
  });

  test("hands off to the candidate supervisor only after gateway readiness", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    const stateDir = join(root, "state");
    mkdirSync(repository, { recursive: true });
    const coordinator = new GatewayUpdateCoordinator({
      config: { enabled: true, repository, healthTimeoutMs: 30_000 },
      stateDir,
    });
    const previous = createRelease(stateDir, "0.7.0-aaaaaaaaaaaa", COMMIT_A);
    const candidate = createRelease(stateDir, "0.8.0-bbbbbbbbbbbb", COMMIT_B);
    coordinator.bootstrap(previous);
    await coordinator.arm(candidate.id, {
      address: { transport: "telegram", account: "default", channel: "42" },
      principal: { id: "operator-42", roles: ["operator"] },
    });
    await coordinator.commitArmed();

    const supervisor = new GatewayUpdateSupervisor({
      stateDir,
      configPath: join(root, "config.json"),
      envFile: join(root, "ompclaw.env"),
      healthTimeoutMs: 500,
    }, {
      spawnRelease(release, requestId) {
        if (release.id === candidate.id && requestId !== undefined) {
          writeFileSync(join(gatewayUpdatePaths(stateDir).ready, `${requestId}.json`), "{}\n");
        }
        const process: ManagedGatewayProcess = {
          exitCode: null,
          signalCode: null,
          kill() {
            process.exitCode = 0;
            return true;
          },
          once(_event, listener) {
            listener();
          },
        };
        return process;
      },
    });
    await supervisor.run();

    expect(supervisor.replacementRequested).toBe(true);
    expect(readUpdateResult(gatewayUpdatePaths(stateDir).result)).toBeUndefined();
    expect(readUpdateRequest(gatewayUpdatePaths(stateDir).request)?.status).toBe("committed");
    expect(currentGatewayRelease(gatewayUpdatePaths(stateDir)).id).toBe(candidate.id);
  });

  test("candidate supervisor verifies its gateway before recording success", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    const stateDir = join(root, "state");
    mkdirSync(repository, { recursive: true });
    const coordinator = new GatewayUpdateCoordinator({
      config: { enabled: true, repository, healthTimeoutMs: 30_000 },
      stateDir,
    });
    const previous = createRelease(stateDir, "0.7.0-aaaaaaaaaaaa", COMMIT_A);
    const candidate = createRelease(stateDir, "0.8.0-bbbbbbbbbbbb", COMMIT_B);
    coordinator.bootstrap(previous);
    await coordinator.arm(candidate.id, {
      address: { transport: "telegram", account: "default", channel: "42" },
      principal: { id: "operator-42", roles: ["operator"] },
    });
    await coordinator.commitArmed();
    const request = readUpdateRequest(coordinator.paths.request)!;
    coordinator.bootstrap(candidate);

    const spawns: string[] = [];
    const resultReady = Promise.withResolvers<void>();
    const supervisor = new GatewayUpdateSupervisor({
      stateDir,
      configPath: join(root, "config.json"),
      envFile: join(root, "ompclaw.env"),
      healthTimeoutMs: 500,
    }, {
      onResult(result) {
        if (result.status === "succeeded") resultReady.resolve();
      },
      spawnRelease(release, requestId) {
        spawns.push(`${release.id}:${requestId ?? "none"}`);
        if (requestId !== undefined) {
          writeFileSync(join(gatewayUpdatePaths(stateDir).ready, `${requestId}.json`), "{}\n");
        }
        const process: ManagedGatewayProcess = {
          exitCode: null,
          signalCode: null,
          kill() {
            process.exitCode = 0;
            return true;
          },
          once(_event, listener) {
            listener();
          },
        };
        return process;
      },
    });
    const running = supervisor.run();
    await resultReady.promise;
    supervisor.stop();
    await running;
    expect(supervisor.replacementRequested).toBe(false);

    expect(spawns).toEqual([
      `${candidate.id}:none`,
      `${candidate.id}:${request.id}`,
    ]);
    expect(readUpdateResult(gatewayUpdatePaths(stateDir).result)?.status).toBe("succeeded");
    expect(currentGatewayRelease(gatewayUpdatePaths(stateDir)).id).toBe(candidate.id);
  });

  test("preserves a committed update when stopped during candidate readiness", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    const stateDir = join(root, "state");
    mkdirSync(repository, { recursive: true });
    const coordinator = new GatewayUpdateCoordinator({
      config: { enabled: true, repository, healthTimeoutMs: 30_000 },
      stateDir,
    });
    const previous = createRelease(stateDir, "0.7.0-aaaaaaaaaaaa", COMMIT_A);
    const candidate = createRelease(stateDir, "0.8.0-bbbbbbbbbbbb", COMMIT_B);
    coordinator.bootstrap(previous);
    await coordinator.arm(candidate.id, {
      address: { transport: "telegram", account: "default", channel: "42" },
      principal: { id: "operator-42", roles: ["operator"] },
    });
    await coordinator.commitArmed();

    const candidateStarted = Promise.withResolvers<void>();
    const supervisor = new GatewayUpdateSupervisor({
      stateDir,
      configPath: join(root, "config.json"),
      envFile: join(root, "ompclaw.env"),
      healthTimeoutMs: 500,
    }, {
      spawnRelease(_release, requestId) {
        if (requestId !== undefined) candidateStarted.resolve();
        const process: ManagedGatewayProcess = {
          exitCode: null,
          signalCode: null,
          kill() {
            process.exitCode = 0;
            return true;
          },
          once(_event, listener) {
            listener();
          },
        };
        return process;
      },
    });
    const running = supervisor.run();
    await candidateStarted.promise;
    supervisor.stop();
    await running;

    expect(readUpdateResult(gatewayUpdatePaths(stateDir).result)).toBeUndefined();
    expect(readUpdateRequest(gatewayUpdatePaths(stateDir).request)?.status).toBe("committed");
    expect(currentGatewayRelease(gatewayUpdatePaths(stateDir)).id).toBe(previous.id);
    expect(supervisor.replacementRequested).toBe(false);
  });

  test("supervisor restores the previous current link when recovered candidate fails", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    const stateDir = join(root, "state");
    mkdirSync(repository, { recursive: true });
    const coordinator = new GatewayUpdateCoordinator({
      config: { enabled: true, repository, healthTimeoutMs: 30_000 },
      stateDir,
    });
    const previous = createRelease(stateDir, "0.7.0-aaaaaaaaaaaa", COMMIT_A);
    const candidate = createRelease(stateDir, "0.8.0-bbbbbbbbbbbb", COMMIT_B);
    coordinator.bootstrap(previous);
    await coordinator.arm(candidate.id, {
      address: { transport: "telegram", account: "default", channel: "42" },
      principal: { id: "operator-42", roles: ["operator"] },
    });
    await coordinator.commitArmed();
    coordinator.bootstrap(candidate);

    const resultReady = Promise.withResolvers<void>();
    const supervisor = new GatewayUpdateSupervisor({
      stateDir,
      configPath: join(root, "config.json"),
      envFile: join(root, "ompclaw.env"),
      healthTimeoutMs: 500,
    }, {
      onResult(result) {
        if (result.status === "rolled_back") resultReady.resolve();
      },
      spawnRelease(release) {
        const process: ManagedGatewayProcess = {
          exitCode: null,
          signalCode: release.id === candidate.id ? "SIGKILL" : null,
          kill() {
            process.exitCode = 0;
            return true;
          },
          once(_event, listener) {
            listener();
          },
        };
        return process;
      },
    });
    const running = supervisor.run();
    await resultReady.promise;
    supervisor.stop();
    await running;
    expect(supervisor.replacementRequested).toBe(true);

    const result = readUpdateResult(gatewayUpdatePaths(stateDir).result);
    expect(result).toMatchObject({
      status: "rolled_back",
      releaseId: candidate.id,
      previousReleaseId: previous.id,
    });
    expect(currentGatewayRelease(gatewayUpdatePaths(stateDir)).id).toBe(previous.id);
  });
});
