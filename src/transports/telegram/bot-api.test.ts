import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Poller,
  TgError,
  acquireLock,
  downloadFileBytes,
  isMissingThreadError,
  readLockOwner,
  releaseLock,
  startLockHeartbeat,
  tg,
  tgUpload,
  webhookConflictHint,
  withTelegramRetry,
} from "./bot-api";

const nativeFetch = globalThis.fetch;
const scratch: string[] = [];

afterEach(async () => {
  globalThis.fetch = nativeFetch;
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ompclaw-bot-api-"));
  scratch.push(path);
  return path;
}

describe("Telegram request helpers", () => {
  test("returns the result from a successful Bot API envelope", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, result: { id: 17 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await expect(tg<{ id: number }>("secret", "sendMessage", { chat_id: 42 })).resolves.toEqual({ id: 17 });
    expect(requests[0]?.url).toBe("https://api.telegram.org/botsecret/sendMessage");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ chat_id: 42 });
  });

  test("surfaces Telegram error metadata", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      ok: false,
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 2 },
    }), { status: 429 })) as typeof fetch;

    try {
      await tg("secret", "sendMessage");
      throw new Error("expected Telegram failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TgError);
      if (!(error instanceof TgError)) throw error;
      expect(error.code).toBe(429);
      expect(error.retryAfter).toBe(2);
    }
  });
  test("rejects malformed Bot API envelopes instead of treating them as success", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
    await expect(tg("secret", "sendMessage")).rejects.toThrow("malformed response");
  });


  test("recognizes the Bot API missing-topic variants", () => {
    expect(isMissingThreadError(new TgError("Bad Request: message thread not found", 400))).toBe(true);
    expect(isMissingThreadError(new TgError("Bad Request: TOPIC_ID_INVALID", 400))).toBe(true);
    expect(isMissingThreadError(new TgError("Forbidden", 403))).toBe(false);
  });

  test("retries bounded transient failures and preserves permanent errors", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withTelegramRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error("The socket connection was closed unexpectedly");
      return "delivered";
    }, { sleep: async (ms) => { waits.push(ms); } });

    expect(result).toBe("delivered");
    expect(waits).toEqual([500, 1_000]);
    await expect(withTelegramRetry(async () => { throw new TgError("Forbidden", 403); })).rejects.toThrow("Forbidden");
  });
  test("retries Bun connection failures as transient network errors", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const result = await withTelegramRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Unable to connect. Is the computer able to access the url?");
      return "connected";
    }, { sleep: async (ms) => { waits.push(ms); } });
    expect(result).toBe("connected");
    expect(waits).toEqual([500]);
  });
  test("retries the same timeout raised by the local request deadline", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const result = await withTelegramRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw new DOMException("Telegram request timed out", "TimeoutError");
      return "recovered";
    }, { sleep: async (ms) => { waits.push(ms); } });
    expect(result).toBe("recovered");
    expect(waits).toEqual([500]);
  });



  test("can cancel a requested retry wait", async () => {
    const controller = new AbortController();
    const sleeper = async () => {
      controller.abort(new Error("operator cancelled"));
    };
    await expect(withTelegramRetry(async () => {
      throw new TgError("rate limited", 429, 1);
    }, { sleep: sleeper, signal: controller.signal })).rejects.toThrow("operator cancelled");
  });

  test("uploads exact bytes and downloads exact bytes", async () => {
    const dir = await tempDir();
    const path = join(dir, "payload.bin");
    const payload = new Uint8Array([0, 1, 127, 128, 255]);
    await writeFile(path, payload);

    const bodies: FormData[] = [];
    let call = 0;
    globalThis.fetch = (async (_url, init) => {
      call += 1;
      if (call === 1) {
        if (!(init?.body instanceof FormData)) throw new Error("expected multipart form");
        bodies.push(init.body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
      }
      return new Response(payload, { status: 200 });
    }) as typeof fetch;

    await expect(tgUpload<{ message_id: number }>(
      "secret",
      "sendDocument",
      { chat_id: 42, caption: "artifact" },
      { field: "document", path },
    )).resolves.toEqual({ message_id: 9 });
    const document = bodies[0]?.get("document");
    expect(document).toBeInstanceOf(Blob);
    expect(await (document as Blob).arrayBuffer()).toEqual(payload.buffer);
    expect(bodies[0]?.get("chat_id")).toBe("42");
    await expect(downloadFileBytes("secret", "reports/payload.bin")).resolves.toEqual(payload);
  });
  test("uploads native media files with specific methods and fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ompclaw-media-upload-"));
    scratch.push(directory);
    const path = join(directory, "audio.mp3");
    await writeFile(path, new Uint8Array([1, 2, 3]));
    const urls: string[] = [];
    const fields: string[] = [];

    globalThis.fetch = (async (url, init) => {
      urls.push(String(url));
      if (init?.body instanceof FormData) {
        fields.push(Array.from(init.body.keys()).join(","));
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    }) as typeof fetch;

    await expect(tgUpload<{ message_id: number }>(
      "secret",
      "sendAudio",
      { chat_id: 123 },
      { field: "audio", path, filename: "audio.mp3" },
    )).resolves.toEqual({ message_id: 42 });
    expect(urls[0]).toBe("https://api.telegram.org/botsecret/sendAudio");
    expect(fields[0]).toContain("audio");
  });

  test("explains webhook conflicts when metadata is available", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      ok: true,
      result: { url: "https://example.invalid/hook", pending_update_count: 3 },
    }), { status: 200 })) as typeof fetch;
    await expect(webhookConflictHint("secret")).resolves.toContain("https://example.invalid/hook");
  });
});

describe("single-poller lock", () => {
  test("records ownership, rejects a live contender, and releases only for its owner", async () => {
    const dir = await tempDir();
    const lock = join(dir, "poll.lock");
    const first = acquireLock(lock, { pid: process.pid, nonce: "first" });
    expect(first).toEqual({ ok: true });
    expect(readLockOwner(lock)).toMatchObject({ pid: process.pid, nonce: "first" });
    expect(acquireLock(lock, { pid: process.pid, nonce: "second" })).toMatchObject({ ok: false, holder: process.pid });

    releaseLock(lock, process.pid, "second");
    expect(await stat(lock)).toBeTruthy();
    releaseLock(lock, process.pid, "first");
    await expect(stat(lock)).rejects.toThrow();
  });
  test("allows exactly one live process to claim a free lock", async () => {
    const directory = await tempDir();
    const lock = join(directory, "race.lock");
    const results = join(directory, "results");
    await mkdir(results);
    const worker = join(import.meta.dir, "bot-api-lock-worker.ts");
    const contenders = Array.from({ length: 6 }, (_, index) =>
      Bun.spawn([process.execPath, worker, lock, results, String(index)], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
      }));
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await readdir(results)).length === contenders.length) break;
        await Bun.sleep(10);
      }
      const outcomes = await Promise.all(
        (await readdir(results)).map((name) => readFile(join(results, name), "utf8")),
      );
      expect(outcomes.filter((value) => value === "claimed")).toHaveLength(1);
      expect(outcomes.filter((value) => value === "busy")).toHaveLength(contenders.length - 1);
    } finally {
      for (const contender of contenders) contender.stdin.end();
      await Promise.all(contenders.map((contender) => contender.exited));
    }
  });


  test("refreshes the ownership heartbeat without replacing the owner", async () => {
    const dir = await tempDir();
    const lock = join(dir, "poll.lock");
    expect(acquireLock(lock, { pid: process.pid, nonce: "pulse" }).ok).toBe(true);
    const before = readLockOwner(lock);
    const stop = startLockHeartbeat(lock, process.pid, 5, "pulse");
    await Bun.sleep(20);
    stop();
    const after = readLockOwner(lock);
    expect(after).toMatchObject({ pid: before?.pid, nonce: before?.nonce });
    expect(after?.heartbeatAt).toBeGreaterThan(before?.heartbeatAt ?? 0);
    releaseLock(lock, process.pid, "pulse");
  });
});

describe("long poller", () => {
  test("delivers updates serially and advances the next offset", async () => {
    const offsets: number[] = [];
    const allowed: string[][] = [];
    const handled: number[] = [];
    const poller = new Poller();
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      offsets.push(Number(body.offset));
      allowed.push(body.allowed_updates);
      return new Response(JSON.stringify({
        ok: true,
        result: [{ update_id: 4 }, { update_id: 7 }],
      }), { status: 200 });
    }) as typeof fetch;

    poller.start("secret", async (update) => {
      handled.push(update.update_id);
      if (handled.length === 2) poller.stop();
    });
    await poller.done();

    expect(handled).toEqual([4, 7]);
    expect(offsets).toEqual([0]);
    expect(allowed).toEqual([["message", "edited_message", "callback_query", "stopped_message_generation"]]);
  });
});
