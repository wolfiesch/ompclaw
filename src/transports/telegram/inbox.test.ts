import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  MAX_INBOUND_ATTACHMENT_BYTES,
  enforceInboxRetention,
  saveInboxAttachment,
} from "./inbox";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function inbox(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ompclaw-inbox-"));
  scratch.push(path);
  return path;
}

describe("Telegram attachment inbox", () => {
  test("stores bytes in a private file and never overwrites an existing name", async () => {
    const directory = await inbox();
    const path = await saveInboxAttachment(directory, {
      filename: "artifact.bin",
      bytes: new Uint8Array([1, 2, 255]),
    });
    expect(await readFile(path)).toEqual(Buffer.from([1, 2, 255]));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(saveInboxAttachment(directory, {
      filename: "artifact.bin",
      bytes: new Uint8Array([9]),
    })).rejects.toThrow();
    expect(await readFile(path)).toEqual(Buffer.from([1, 2, 255]));
  });

  test("rejects one attachment beyond the documented file limit", async () => {
    const directory = await inbox();
    const bytes = new Uint8Array(MAX_INBOUND_ATTACHMENT_BYTES + 1);
    await expect(saveInboxAttachment(directory, {
      filename: "oversized.bin",
      bytes,
    })).rejects.toThrow("too large");
  });

  test("removes expired files while retaining a protected path", async () => {
    const directory = await inbox();
    const expired = join(directory, "expired.txt");
    const protectedPath = join(directory, "protected.txt");
    const current = join(directory, "current.txt");
    await Promise.all([
      writeFile(expired, "old"),
      writeFile(protectedPath, "keep"),
      writeFile(current, "new"),
    ]);
    await Promise.all([
      utimes(expired, new Date(1_000), new Date(1_000)),
      utimes(protectedPath, new Date(1_000), new Date(1_000)),
      utimes(current, new Date(10_000), new Date(10_000)),
    ]);

    const result = await enforceInboxRetention(directory, {
      now: 12_000,
      ttlMs: 5_000,
      protectedPaths: new Set([protectedPath]),
    });
    expect(result.removedPaths.map((path) => basename(path))).toEqual(["expired.txt"]);
    await expect(stat(protectedPath)).resolves.toBeTruthy();
    await expect(stat(current)).resolves.toBeTruthy();
  });

  test("evicts the oldest unprotected files until the byte quota is met", async () => {
    const directory = await inbox();
    const oldest = join(directory, "a.bin");
    const middle = join(directory, "b.bin");
    const newest = join(directory, "c.bin");
    await writeFile(oldest, Buffer.alloc(4, 1));
    await writeFile(middle, Buffer.alloc(4, 2));
    await writeFile(newest, Buffer.alloc(4, 3));
    await utimes(oldest, new Date(1_000), new Date(1_000));
    await utimes(middle, new Date(2_000), new Date(2_000));
    await utimes(newest, new Date(3_000), new Date(3_000));

    const result = await enforceInboxRetention(directory, {
      now: 4_000,
      ttlMs: 10_000,
      maxBytes: 8,
    });
    expect(result.byteLength).toBe(8);
    expect(result.removedPaths.map((path) => basename(path))).toEqual(["a.bin"]);
    await expect(stat(oldest)).rejects.toThrow();
  });
});
