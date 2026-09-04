import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listenForFirstTelegramUser,
  runGatewaySetupWizard,
  type TelegramApiCall,
  validateTelegramCredentials,
  writeGatewaySetupFiles,
} from "./gateway-setup";
import { acquireLock, releaseLock } from "./transports/telegram/bot-api";

const TOKEN = "123456:telegram-bot-token";
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function telegramApi(
  respond: (method: string, payload: Record<string, unknown> | undefined) => unknown,
): TelegramApiCall {
  return async <Result>(
    _token: string,
    method: string,
    payload?: Record<string, unknown>,
    _options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<Result> => respond(method, payload) as Result;
}

function humanUpdate(updateId: number, id = 42): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id, type: "private" },
      from: { id, is_bot: false, first_name: "Ada", username: "ada" },
      text: "pair me",
    },
  };
}

describe("Telegram setup credential validation", () => {
  test("rejects invalid getMe responses without exposing the token", async () => {
    const callTelegram = telegramApi((method) => {
      expect(method).toBe("getMe");
      throw new Error(`Unauthorized token ${TOKEN}`);
    });

    let message = "";
    try {
      await validateTelegramCredentials(TOKEN, { callTelegram });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Telegram token validation failed");
  });

  test("rejects a human getMe account", async () => {
    const callTelegram = telegramApi((method) => {
      expect(method).toBe("getMe");
      return { id: 100, is_bot: false, first_name: "Not a bot" };
    });

    await expect(validateTelegramCredentials(TOKEN, { callTelegram })).rejects.toThrow("bot account");
  });

  test("refuses an active webhook before long polling", async () => {
    const methods: string[] = [];
    const callTelegram = telegramApi((method) => {
      methods.push(method);
      if (method === "getMe") return { id: 100, is_bot: true, first_name: "OmpClaw", username: "ompclaw_bot" };
      if (method === "getWebhookInfo") return { url: "https://example.test/telegram" };
      throw new Error(`unexpected method ${method}`);
    });

    await expect(validateTelegramCredentials(TOKEN, { callTelegram })).rejects.toThrow("active webhook");
    expect(methods).toEqual(["getMe", "getWebhookInfo"]);
  });
});

describe("Gateway setup file writing", () => {
  test("writes token-free JSON and a mode-0600 literal environment file atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ompclaw-setup-"));
    scratch.push(directory);
    const configPath = join(directory, "config.json");
    const envFile = join(directory, "gateway.env");

    const files = writeGatewaySetupFiles({
      configPath,
      envFile,
      token: TOKEN,
      account: "primary",
      workspace: "/workspace/ompclaw",
    });

    expect(files).toEqual({ configPath, envFile });
    const [config, environment, configInfo, environmentInfo, entries] = await Promise.all([
      readFile(configPath, "utf8"),
      readFile(envFile, "utf8"),
      stat(configPath),
      stat(envFile),
      readdir(directory),
    ]);
    expect(config).not.toContain(TOKEN);
    expect(JSON.parse(config)).toEqual({
      workspace: "/workspace/ompclaw",
      transports: {
        telegram: {
          enabled: true,
          account: "primary",
          tokenEnv: "TELEGRAM_BOT_TOKEN",
          topicSessions: { enabled: false, createFromRoot: false },
        },
      },
    });
    expect(environment).toBe(`TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
    expect(configInfo.mode & 0o777).toBe(0o600);
    expect(environmentInfo.mode & 0o777).toBe(0o600);
    expect(entries.sort()).toEqual(["config.json", "gateway.env"]);
  });

  test("refuses to overwrite an existing setup file before writing either output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ompclaw-setup-existing-"));
    scratch.push(directory);
    const configPath = join(directory, "config.json");
    const envFile = join(directory, "gateway.env");
    await writeFile(configPath, "keep-config", "utf8");

    expect(() =>
      writeGatewaySetupFiles({
        configPath,
        envFile,
        token: TOKEN,
      }),
    ).toThrow(`setup config already exists: ${configPath}`);
    expect(await readFile(configPath, "utf8")).toBe("keep-config");
    await expect(readFile(envFile, "utf8")).rejects.toThrow();
  });
});

describe("temporary Telegram pairing discovery", () => {
  test("advances offsets and deduplicates updates before returning one human candidate", async () => {
    const polls: Record<string, unknown>[] = [];
    const calls: Array<{ method: string; payload: Record<string, unknown> | undefined }> = [];
    const batches: unknown[][] = [
      [
        {
          update_id: 40,
          message: {
            message_id: 40,
            chat: { id: 500, type: "private" },
            from: { id: 500, is_bot: true },
          },
        },
      ],
      [
        {
          update_id: 40,
          message: {
            message_id: 40,
            chat: { id: 500, type: "private" },
            from: { id: 500, is_bot: true },
          },
        },
        humanUpdate(41),
      ],
    ];
    const callTelegram = telegramApi((method, payload) => {
      calls.push({ method, payload });
      if (method === "getUpdates") {
        polls.push(payload ?? {});
        return batches.shift() ?? [];
      }
      if (method === "sendMessage") return { message_id: 99 };
      throw new Error(`unexpected method ${method}`);
    });

    const candidate = await listenForFirstTelegramUser({ token: TOKEN, callTelegram, timeoutMs: 1_000 });

    expect(candidate).toEqual({
      identity: { transport: "telegram", account: "default", subject: "42" },
      address: { transport: "telegram", account: "default", channel: "42" },
      displayLabel: "Ada (@ada)",
      updateId: 41,
    });
    expect(polls.map((payload) => payload.offset)).toEqual([-1, 41]);
    expect(calls.filter((call) => call.method === "sendMessage")).toEqual([
      {
        method: "sendMessage",
        payload: {
          chat_id: "42",
          text: "Your pairing request was received. Local approval is required before access is granted.",
        },
      },
    ]);
  });

  test("ignores messages queued before the listener becomes ready", async () => {
    const polls: Record<string, unknown>[] = [];
    const lines: string[] = [];
    const batches: unknown[][] = [[humanUpdate(10, 10)], [humanUpdate(11, 42)]];
    const callTelegram = telegramApi((method, payload) => {
      if (method === "getUpdates") {
        polls.push(payload ?? {});
        return batches.shift() ?? [];
      }
      if (method === "sendMessage") return { message_id: 99 };
      throw new Error(`unexpected method ${method}`);
    });

    const candidate = await listenForFirstTelegramUser({
      token: TOKEN,
      callTelegram,
      timeoutMs: 1_000,
      write: (line) => lines.push(line),
    });

    expect(candidate?.updateId).toBe(11);
    expect(polls.map((payload) => payload.offset)).toEqual([-1, 11]);
    expect(lines[0]).toBe("Telegram pairing listener ready; send the bot a direct message.");
  });

  test("ignores non-message, bot, topic, and non-private updates", async () => {
    const acknowledgements: Record<string, unknown>[] = [];
    let getUpdatesCalls = 0;
    const callTelegram = telegramApi((method, payload) => {
      if (method === "getUpdates") {
        getUpdatesCalls += 1;
        if (getUpdatesCalls === 1) return [];
        return [
          { update_id: 1, callback_query: { id: "callback" } },
          {
            update_id: 2,
            message: {
              message_id: 2,
              chat: { id: 9, type: "private" },
              from: { id: 9, is_bot: true },
            },
          },
          {
            update_id: 3,
            message: {
              message_id: 3,
              chat: { id: 42, type: "private" },
              from: { id: 42, is_bot: false },
              is_topic_message: true,
              message_thread_id: 8,
            },
          },
          {
            update_id: 4,
            message: {
              message_id: 4,
              chat: { id: -100, type: "supergroup" },
              from: { id: 42, is_bot: false },
            },
          },
          humanUpdate(5),
        ];
      }
      if (method === "sendMessage") {
        acknowledgements.push(payload ?? {});
        return { message_id: 99 };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const candidate = await listenForFirstTelegramUser({ token: TOKEN, callTelegram, timeoutMs: 1_000 });

    expect(candidate?.updateId).toBe(5);
    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]?.chat_id).toBe("42");
  });

  test("returns no candidate on timeout or caller abort", async () => {
    const neverCalled = telegramApi(() => {
      throw new Error("Telegram must not be called");
    });
    const timeout = await listenForFirstTelegramUser({ token: TOKEN, callTelegram: neverCalled, timeoutMs: 0 });
    const controller = new AbortController();
    controller.abort();
    const aborted = await listenForFirstTelegramUser({
      token: TOKEN,
      callTelegram: neverCalled,
      signal: controller.signal,
      timeoutMs: 1_000,
    });

    expect(timeout).toBeUndefined();
    expect(aborted).toBeUndefined();
  });

  test("refuses discovery while the account polling lock is held", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ompclaw-setup-lock-"));
    scratch.push(directory);
    const lockPath = join(directory, "telegram-default.poll.lock");
    const nonce = "setup-lock-test";
    expect(acquireLock(lockPath, { pid: process.pid, nonce, startedAt: Date.now() })).toEqual({ ok: true });
    try {
      await expect(
        listenForFirstTelegramUser({
          token: TOKEN,
          pollLockPath: lockPath,
          timeoutMs: 1_000,
          callTelegram: telegramApi(() => {
            throw new Error("Telegram must not be called without the poll lock");
          }),
        }),
      ).rejects.toThrow(`Telegram account is already being polled by process ${process.pid}`);
    } finally {
      releaseLock(lockPath, process.pid, nonce);
    }
  });
});

describe("interactive setup wizard", () => {
  test("keeps token out of its receipt and output while discovering no user", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ompclaw-setup-wizard-"));
    scratch.push(directory);
    const output: string[] = [];
    const methods: string[] = [];
    const callTelegram = telegramApi((method) => {
      methods.push(method);
      if (method === "getMe") return { id: 100, is_bot: true, first_name: "OmpClaw", username: "ompclaw_bot" };
      if (method === "getWebhookInfo") return { url: "", pending_update_count: 3 };
      throw new Error(`unexpected method ${method}`);
    });

    const receipt = await runGatewaySetupWizard({
      configPath: join(directory, "config.json"),
      envFile: join(directory, "gateway.env"),
      secrets: { readTelegramBotToken: () => TOKEN },
      write: (line) => output.push(line),
      callTelegram,
      discoveryTimeoutMs: 0,
    });

    expect(receipt).toMatchObject({
      configPath: join(directory, "config.json"),
      envFile: join(directory, "gateway.env"),
      bot: { id: 100, username: "ompclaw_bot", friendlyName: "OmpClaw", displayName: "@ompclaw_bot" },
    });
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
    expect(output.join("\n")).not.toContain(TOKEN);
    expect(output).toContain("Open your bot: https://t.me/ompclaw_bot");
    expect(await readFile(receipt.configPath, "utf8")).not.toContain(TOKEN);
    expect(methods).toEqual(["getMe", "getWebhookInfo", "setMyDescription", "setMyShortDescription", "setMyName"]);
  });
});
