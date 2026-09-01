import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PAIRING_TTL_MS,
  GatewayPairingService,
  type PairingSecrets,
} from "./gateway-pairing";
import { GatewayStore } from "./gateway-store";
import type { ConversationAddress, TransportIdentity } from "./gateway-types";

const directories: string[] = [];
const now = 1_700_000_000_000;

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "ompclaw-pairing-"));
  directories.push(directory);
  return join(directory, "ompclaw.sqlite");
}

function pairingSecrets(...codes: string[]): PairingSecrets {
  let saltByte = 0;
  return {
    createCode: () => {
      const code = codes.shift();
      if (code === undefined) throw new Error("test pairing code queue exhausted");
      return code;
    },
    createSalt: () => new Uint8Array(16).fill(++saltByte),
  };
}

function identity(subject = "42"): TransportIdentity {
  return { transport: "telegram", account: "default", subject };
}

function address(subject = "42"): ConversationAddress {
  return { transport: "telegram", account: "default", channel: subject };
}

function service(store: GatewayStore, ...codes: string[]): GatewayPairingService {
  return new GatewayPairingService(store, { secrets: pairingSecrets(...codes) });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("GatewayPairingService", () => {
  test("persists only salted code hashes and returns safe request views", () => {
    const path = temporaryDatabase();
    const store = new GatewayStore(path);
    const pairing = service(store, "PAIRCODE");
    const result = pairing.request(identity(), address(), now);

    const database = new Database(path);
    const row = database
      .query("SELECT code_hash, code_salt FROM pairing_requests WHERE transport = 'telegram' AND account = 'default' AND subject = '42'")
      .get() as { code_hash: string; code_salt: string };
    database.close();

    expect(row.code_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.code_hash).not.toContain(result.code);
    expect(row.code_salt).toMatch(/^[a-f0-9]{32}$/);
    expect(result.request).not.toHaveProperty("codeHash");
    expect(result.request).not.toHaveProperty("codeSalt");
    expect(pairing.list(now)).toEqual([result.request]);
    store.close();
  });

  test("expires requests at the ten-minute deadline without creating bindings", () => {
    const store = new GatewayStore(temporaryDatabase());
    const pairing = service(store, "EXPIRES01");
    const result = pairing.request(identity(), address(), now);

    expect(pairing.list(now + DEFAULT_PAIRING_TTL_MS)).toEqual([
      expect.objectContaining({ state: "expired", expiresAt: result.request.expiresAt }),
    ]);
    expect(() => pairing.approve(result.code, undefined, now + DEFAULT_PAIRING_TTL_MS)).toThrow(
      "pairing code is invalid or unavailable",
    );
    expect(store.resolvePrincipal(identity())).toBeUndefined();
    store.close();
  });

  test("adds pairing storage when opening an existing gateway database", () => {
    const path = temporaryDatabase();
    const legacy = new Database(path);
    legacy.exec("CREATE TABLE principals (id TEXT PRIMARY KEY NOT NULL, roles_json TEXT NOT NULL)");
    legacy.close();

    const store = new GatewayStore(path);
    const pairing = service(store, "MIGRATE1");
    expect(pairing.request(identity(), address(), now).request).toEqual(expect.objectContaining({ state: "pending" }));
    expect(pairing.list(now)).toHaveLength(1);
    store.close();
  });

  test("exhausts a request after five failed code attempts", () => {
    const store = new GatewayStore(temporaryDatabase());
    const pairing = service(store, "CORRECT01");
    const result = pairing.request(identity(), address(), now);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() => pairing.approve("WRONG001", undefined, now + attempt + 1)).toThrow(
        "pairing code is invalid or unavailable",
      );
    }

    expect(pairing.list(now + 10)).toEqual([
      expect.objectContaining({ state: "exhausted", failedAttempts: 5 }),
    ]);
    expect(() => pairing.approve(result.code, undefined, now + 11)).toThrow("pairing code is invalid or unavailable");
    expect(store.resolvePrincipal(identity())).toBeUndefined();
    store.close();
  });

  test("rejects a matching request without binding its identity", () => {
    const store = new GatewayStore(temporaryDatabase());
    const pairing = service(store, "REJECT01");
    const result = pairing.request(identity(), address(), now);

    expect(pairing.reject(result.code, now + 1)).toEqual(expect.objectContaining({ state: "rejected" }));
    expect(store.resolvePrincipal(identity())).toBeUndefined();
    expect(() => pairing.approve(result.code, undefined, now + 2)).toThrow("pairing code is invalid or unavailable");
    store.close();
  });

  test("recovers pending requests after restart", () => {
    const path = temporaryDatabase();
    const first = new GatewayStore(path);
    const requested = service(first, "RECOVER1").request(identity(), address(), now);
    first.close();

    const restarted = new GatewayStore(path);
    const pairing = service(restarted);
    expect(pairing.list(now + 1)).toEqual([expect.objectContaining({ state: "pending", identity: identity() })]);
    expect(pairing.approve(requested.code, undefined, now + 2)).toEqual(
      expect.objectContaining({ state: "approved", principalId: "operator:telegram:default:42" }),
    );
    expect(restarted.resolvePrincipal(identity())).toEqual({ id: "operator:telegram:default:42", roles: ["operator"] });
    restarted.close();
  });

  test("renews an exact identity in place and invalidates the replaced code", () => {
    const store = new GatewayStore(temporaryDatabase());
    const pairing = service(store, "FIRST001", "SECOND01");
    const first = pairing.request(identity(), address(), now);
    const second = pairing.request(identity(), address(), now + 1);

    expect(pairing.list(now + 1)).toEqual([expect.objectContaining({ state: "pending", createdAt: now + 1 })]);
    expect(() => pairing.approve(first.code, undefined, now + 2)).toThrow("pairing code is invalid or unavailable");
    expect(pairing.approve(second.code, undefined, now + 3)).toEqual(expect.objectContaining({ state: "approved" }));
    expect(store.resolvePrincipal(identity())).toEqual({ id: "operator:telegram:default:42", roles: ["operator"] });
    store.close();
  });

  test("scopes approval to the exact transport identity", () => {
    const store = new GatewayStore(temporaryDatabase());
    const pairing = service(store, "ALICE001", "BOB00001");
    const alice = pairing.request(identity("100"), address("100"), now);
    pairing.request(identity("200"), address("200"), now);

    expect(pairing.approve(alice.code, undefined, now + 1)).toEqual(
      expect.objectContaining({ identity: identity("100"), principalId: "operator:telegram:default:100" }),
    );
    expect(store.resolvePrincipal(identity("100"))).toEqual({ id: "operator:telegram:default:100", roles: ["operator"] });
    expect(store.resolvePrincipal(identity("200"))).toBeUndefined();
    store.close();
  });

  test("fails closed for ambiguous codes and records failures without a binding", () => {
    const store = new GatewayStore(temporaryDatabase());
    const pairing = service(store, "SHARED01", "SHARED01");
    pairing.request(identity("100"), address("100"), now);
    pairing.request(identity("200"), address("200"), now);

    expect(() => pairing.approve("SHARED01", undefined, now + 1)).toThrow("pairing code is invalid or unavailable");
    expect(pairing.list(now + 1)).toEqual([
      expect.objectContaining({ identity: identity("100"), state: "pending", failedAttempts: 1 }),
      expect.objectContaining({ identity: identity("200"), state: "pending", failedAttempts: 1 }),
    ]);
    expect(store.resolvePrincipal(identity("100"))).toBeUndefined();
    expect(store.resolvePrincipal(identity("200"))).toBeUndefined();
    store.close();
  });

  test("rolls back principal creation when the exact identity is already bound elsewhere", () => {
    const path = temporaryDatabase();
    const store = new GatewayStore(path);
    store.upsertPrincipal({ id: "operator-existing", roles: ["operator"] });
    store.bindIdentity(identity(), "operator-existing");
    const pairing = service(store, "ATOMIC01");
    const result = pairing.request(identity(), address(), now);

    expect(() => pairing.approve(result.code, "operator-new", now + 1)).toThrow("pairing code is invalid or unavailable");
    expect(store.resolvePrincipal(identity())).toEqual({ id: "operator-existing", roles: ["operator"] });
    const database = new Database(path);
    expect(database.query("SELECT id FROM principals WHERE id = 'operator-new'").get()).toBeNull();
    database.close();
    expect(pairing.list(now + 1)).toEqual([expect.objectContaining({ state: "pending" })]);
    store.close();
  });

  test("rejects duplicate approval and code reuse after atomic approval", () => {
    const path = temporaryDatabase();
    const store = new GatewayStore(path);
    const pairing = service(store, "REUSE001");
    const result = pairing.request(identity(), address(), now);

    expect(pairing.approve(result.code, "operator-42", now + 1)).toEqual(
      expect.objectContaining({ state: "approved", principalId: "operator-42" }),
    );
    expect(() => pairing.approve(result.code, "operator-other", now + 2)).toThrow("pairing code is invalid or unavailable");
    expect(store.resolvePrincipal(identity())).toEqual({ id: "operator-42", roles: ["operator"] });
    const database = new Database(path);
    expect(database.query("SELECT id FROM principals WHERE id = 'operator-other'").get()).toBeNull();
    database.close();
    store.close();
  });

  test("clears persisted pairing requests without changing existing identity bindings", () => {
    const store = new GatewayStore(temporaryDatabase());
    const pairing = service(store, "CLEAR001", "CLEAR002");
    const first = pairing.request(identity("100"), address("100"), now);
    pairing.request(identity("200"), address("200"), now);
    pairing.approve(first.code, undefined, now + 1);

    expect(pairing.clear(now + 2)).toBe(2);
    expect(pairing.list(now + 2)).toEqual([]);
    expect(store.resolvePrincipal(identity("100"))).toEqual({ id: "operator:telegram:default:100", roles: ["operator"] });
    store.close();
  });
  test("queries only unconfirmed approvals for one transport account", () => {
    const store = new GatewayStore(temporaryDatabase());
    const pairing = service(store, "CONFIRM1", "CONFIRM2");
    const first = pairing.request(identity("100"), address("100"), now);
    const otherIdentity = { ...identity("200"), account: "other" };
    const otherAddress = { ...address("200"), account: "other" };
    const other = pairing.request(otherIdentity, otherAddress, now + 1);
    pairing.approve(first.code, undefined, now + 2);
    pairing.approve(other.code, undefined, now + 3);

    expect(store.listPendingPairingRequests("telegram", "default")).toEqual([]);
    expect(store.listPendingPairingRequests("telegram", "other")).toEqual([]);
    expect(pairing.listUnconfirmedApprovals("telegram", "default")).toEqual([
      expect.objectContaining({ identity: identity("100"), state: "approved" }),
    ]);
    expect(pairing.completeConfirmation(identity("100"), now + 4)).toBe(true);
    expect(pairing.completeConfirmation(identity("100"), now + 5)).toBe(false);
    expect(pairing.listUnconfirmedApprovals("telegram", "default")).toEqual([]);
    expect(pairing.listUnconfirmedApprovals("telegram", "other")).toEqual([
      expect.objectContaining({ identity: otherIdentity, state: "approved" }),
    ]);
    store.close();
  });

  test("bounds pending runtime challenges per transport account while allowing code rotation", () => {
    const store = new GatewayStore(temporaryDatabase());
    const pairing = service(store, "WSFIRST1", "FIRST001", "SECOND01", "THIRD001", "ROTATE01");
    const websocketIdentity = { ...identity("websocket"), transport: "websocket" };
    const websocketAddress = { ...address("websocket"), transport: "websocket" };

    expect(pairing.requestFromTransport(websocketIdentity, websocketAddress, now).status).toBe("created");
    expect(pairing.requestFromTransport(identity("100"), address("100"), now).status).toBe("created");
    expect(pairing.requestFromTransport(identity("200"), address("200"), now).status).toBe("created");
    expect(pairing.requestFromTransport(identity("300"), address("300"), now).status).toBe("created");
    expect(pairing.requestFromTransport(identity("400"), address("400"), now)).toEqual({ status: "capacity" });
    expect(store.listPendingPairingRequests("telegram", "default").map((request) => request.identity.subject)).toEqual([
      "100",
      "200",
      "300",
    ]);
    expect(store.listPendingPairingRequests("websocket", "default").map((request) => request.identity.subject)).toEqual([
      "websocket",
    ]);

    const rotated = pairing.requestFromTransport(identity("100"), address("100"), now + 1);
    expect(rotated).toEqual(
      expect.objectContaining({
        status: "created",
        result: expect.objectContaining({
          code: "ROTATE01",
          request: expect.objectContaining({ identity: identity("100"), createdAt: now + 1 }),
        }),
      }),
    );
    expect(pairing.list(now + 1)).toHaveLength(4);
    store.close();
  });

});
