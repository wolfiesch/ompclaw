import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDecisionCard } from "../transports/telegram/cards";
import { tg, tgUpload, type TgMessage, type TgUser } from "../transports/telegram/bot-api";
import { telegramUiScenarios, type TelegramUiScenario } from "./telegram-ui-scenario";

const TEST_TOKEN_ENV = "OMPCLAW_TEST_TELEGRAM_TOKEN";
const TEST_CHAT_ENV = "OMPCLAW_TEST_TELEGRAM_CHAT_ID";
const PRODUCTION_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";
const TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/;
const CHAT_PATTERN = /^-?\d+$/;

export interface TelegramCanaryConfig {
  readonly token: string;
  readonly chatId: string;
  readonly cleanup: boolean;
}

export type TelegramCanarySurface = "home" | "decisions" | "quick-lane" | "watches" | "schedules" | "media";

export interface TelegramCanaryReceipt {
  readonly bot: string;
  readonly chatId: string;
  readonly messageIds: readonly number[];
  readonly marker: string;
  readonly surfaces: readonly TelegramCanarySurface[];
  readonly cleanedUp: boolean;
}

export interface TelegramCanaryOptions extends TelegramCanaryConfig {
  readonly api?: typeof tg;
  readonly upload?: typeof tgUpload;
  readonly now?: () => number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function telegramCanaryConfig(
  env: NodeJS.ProcessEnv = process.env,
  args: readonly string[] = process.argv.slice(2),
): TelegramCanaryConfig {
  const unknown = args.filter((argument) => argument !== "--delete");
  if (unknown.length > 0) throw new Error(`unknown Telegram canary argument: ${unknown[0]}`);
  const token = required(env, TEST_TOKEN_ENV);
  const chatId = required(env, TEST_CHAT_ENV);
  if (!TOKEN_PATTERN.test(token)) throw new Error(`${TEST_TOKEN_ENV} is not a valid Telegram bot token`);
  if (!CHAT_PATTERN.test(chatId)) throw new Error(`${TEST_CHAT_ENV} must be a numeric Telegram chat id`);
  if (env[PRODUCTION_TOKEN_ENV]?.trim() === token) {
    throw new Error(`${TEST_TOKEN_ENV} must not equal ${PRODUCTION_TOKEN_ENV}; use a dedicated test bot`);
  }
  return { token, chatId, cleanup: args.includes("--delete") };
}
function canaryKeyboard(rows: TelegramUiScenario["buttons"]): {
  readonly inline_keyboard: readonly (readonly { readonly text: string; readonly callback_data: string }[])[];
} {
  return {
    inline_keyboard: rows.map((row) => row.map((text) => ({ text, callback_data: "ompclaw-canary:noop" }))),
  };
}

function requiredScenario(name: string): TelegramUiScenario {
  const fixture = telegramUiScenarios().find((scenario) => scenario.name === name);
  if (fixture === undefined) throw new Error(`Telegram canary UI fixture is missing: ${name}`);
  return fixture;
}

function decisionScenario(): TelegramUiScenario {
  const rendered = renderDecisionCard(
    {
      title: "Canary approval",
      preview: "Approve the representative OmpClaw action?",
      choices: [
        { id: "approve", label: "Approve once" },
        { id: "deny", label: "Deny" },
      ],
      state: "active",
    },
    (action) => action,
  );
  return {
    name: "decision",
    text: rendered.text,
    buttons: rendered.inlineKeyboard.map((row) => row.map((button) => button.text)),
  };
}

const CANARY_SURFACES: readonly TelegramCanarySurface[] = [
  "home",
  "decisions",
  "quick-lane",
  "watches",
  "schedules",
  "media",
];

const CANARY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export async function runTelegramCanary(options: TelegramCanaryOptions): Promise<TelegramCanaryReceipt> {
  const api = options.api ?? tg;
  const upload = options.upload ?? tgUpload;
  const bot = await api<TgUser>(options.token, "getMe");
  if (bot.is_bot !== true || !bot.username) throw new Error("Telegram getMe did not return a bot username");
  const webhook = await api<{ readonly url?: string }>(options.token, "getWebhookInfo");
  if (webhook.url?.trim()) {
    throw new Error("test bot has a webhook configured; remove it before running the long-poll canary");
  }

  const marker = `ompclaw-canary-${(options.now ?? Date.now)()}`;
  const messageIds: number[] = [];
  const sendMessage = async (
    surface: Exclude<TelegramCanarySurface, "media">,
    content: TelegramUiScenario,
  ): Promise<void> => {
    const sent = await api<TgMessage>(options.token, "sendMessage", {
      chat_id: options.chatId,
      text: `CANARY · ${surface}\n\n${content.text}`,
      disable_notification: true,
      reply_markup: canaryKeyboard(content.buttons),
    });
    messageIds.push(sent.message_id);
  };

  const status = await api<TgMessage>(options.token, "sendMessage", {
    chat_id: options.chatId,
    text: `OmpClaw handset canary\n${marker}\nStarting six surface checks. Buttons are visual fixtures.`,
    disable_notification: true,
  });
  messageIds.push(status.message_id);
  await api<boolean>(options.token, "sendChatAction", {
    chat_id: options.chatId,
    action: "typing",
  });

  await sendMessage("home", requiredScenario("home"));
  await sendMessage("decisions", decisionScenario());
  await sendMessage("quick-lane", requiredScenario("home-busy"));
  await sendMessage("watches", {
    name: "watch",
    text: ["👀 Watch update", "", "PR 100 CI", "", "All required checks are passing."].join("\n"),
    buttons: [["Pause watch", "Run now"], ["Delete watch"]],
  });
  await sendMessage("schedules", requiredScenario("schedules-list"));

  const directory = await mkdtemp(join(tmpdir(), "ompclaw-telegram-canary-"));
  try {
    const photoPath = join(directory, "canary.png");
    const documentPath = join(directory, "canary.txt");
    await Promise.all([
      writeFile(photoPath, CANARY_PNG),
      writeFile(documentPath, `OmpClaw Telegram media canary\n${marker}\n`),
    ]);
    const photo = await upload<TgMessage>(
      options.token,
      "sendPhoto",
      { chat_id: options.chatId, caption: "CANARY · media photo", disable_notification: 1 },
      { field: "photo", path: photoPath },
    );
    const document = await upload<TgMessage>(
      options.token,
      "sendDocument",
      { chat_id: options.chatId, caption: "CANARY · media document", disable_notification: 1 },
      { field: "document", path: documentPath },
    );
    messageIds.push(photo.message_id, document.message_id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  await api<TgMessage | boolean>(options.token, "editMessageText", {
    chat_id: options.chatId,
    message_id: status.message_id,
    text: [
      "OmpClaw handset canary passed",
      marker,
      `Bot: @${bot.username}`,
      `Surfaces: ${CANARY_SURFACES.join(", ")}`,
    ].join("\n"),
  });
  if (options.cleanup) {
    for (const messageId of [...messageIds].reverse()) {
      await api<boolean>(options.token, "deleteMessage", {
        chat_id: options.chatId,
        message_id: messageId,
      });
    }
  }
  return {
    bot: `@${bot.username}`,
    chatId: options.chatId,
    messageIds,
    marker,
    surfaces: CANARY_SURFACES,
    cleanedUp: options.cleanup,
  };
}

if (import.meta.main) {
  try {
    const receipt = await runTelegramCanary(telegramCanaryConfig());
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
