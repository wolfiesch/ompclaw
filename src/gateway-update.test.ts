import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GatewayUpdateCoordinator,
  currentGatewayRelease,
  gatewayUpdatePaths,
  readUpdateRequest,
  readUpdateResult,
  writeUpdateResult,
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

  test("supervisor switches to a candidate only after its readiness marker", async () => {
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
        if (release.id === candidate.id && requestId !== undefined) {
          writeFileSync(join(gatewayUpdatePaths(stateDir).ready, `${requestId}.json`), "{}\n");
        }
        const process: ManagedGatewayProcess = {
          exitCode: null,
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

    expect(readUpdateResult(gatewayUpdatePaths(stateDir).result)).toMatchObject({
      status: "succeeded",
      releaseId: candidate.id,
      previousReleaseId: previous.id,
    });
    expect(currentGatewayRelease(gatewayUpdatePaths(stateDir)).id).toBe(candidate.id);
  });

  test("relaunches a current candidate with its request after supervisor recovery", async () => {
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

    expect(spawns).toEqual([
      `${candidate.id}:none`,
      `${candidate.id}:${request.id}`,
    ]);
    expect(readUpdateResult(gatewayUpdatePaths(stateDir).result)?.status).toBe("succeeded");
    expect(currentGatewayRelease(gatewayUpdatePaths(stateDir)).id).toBe(candidate.id);
  });

  test("supervisor rolls back a candidate that never becomes ready", async () => {
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
          exitCode: release.id === candidate.id ? 1 : null,
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

    const result = readUpdateResult(gatewayUpdatePaths(stateDir).result);
    expect(result).toMatchObject({
      status: "rolled_back",
      releaseId: candidate.id,
      previousReleaseId: previous.id,
    });
    expect(currentGatewayRelease(gatewayUpdatePaths(stateDir)).id).toBe(previous.id);
  });
});
