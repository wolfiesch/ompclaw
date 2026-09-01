import { tg, type TgMessage, type TgUser } from "../transports/telegram/bot-api";

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

export interface TelegramCanaryReceipt {
  readonly bot: string;
  readonly chatId: string;
  readonly messageId: number;
  readonly marker: string;
  readonly cleanedUp: boolean;
}

export interface TelegramCanaryOptions extends TelegramCanaryConfig {
  readonly api?: typeof tg;
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

export async function runTelegramCanary(options: TelegramCanaryOptions): Promise<TelegramCanaryReceipt> {
  const api = options.api ?? tg;
  const bot = await api<TgUser>(options.token, "getMe");
  if (bot.is_bot !== true || !bot.username) throw new Error("Telegram getMe did not return a bot username");
  const webhook = await api<{ readonly url?: string }>(options.token, "getWebhookInfo");
  if (webhook.url?.trim()) {
    throw new Error("test bot has a webhook configured; remove it before running the long-poll canary");
  }

  const marker = `ompclaw-canary-${(options.now ?? Date.now)()}`;
  const sent = await api<TgMessage>(options.token, "sendMessage", {
    chat_id: options.chatId,
    text: `OmpClaw Telegram canary\n${marker}\nStarting live transport checks`,
    disable_notification: true,
  });
  await api<boolean>(options.token, "sendChatAction", {
    chat_id: options.chatId,
    action: "typing",
  });
  await api<TgMessage | boolean>(options.token, "editMessageText", {
    chat_id: options.chatId,
    message_id: sent.message_id,
    text: `OmpClaw Telegram canary passed\n${marker}\nBot: @${bot.username}`,
    reply_markup: {
      inline_keyboard: [[{ text: "Open OmpClaw", url: "https://github.com/wolfiesch/ompclaw" }]],
    },
  });
  if (options.cleanup) {
    await api<boolean>(options.token, "deleteMessage", {
      chat_id: options.chatId,
      message_id: sent.message_id,
    });
  }
  return {
    bot: `@${bot.username}`,
    chatId: options.chatId,
    messageId: sent.message_id,
    marker,
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
