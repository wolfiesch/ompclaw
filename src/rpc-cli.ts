#!/usr/bin/env bun
import { existsSync } from "node:fs";
import {
  loadAccess,
  resolveToken,
  pruneExpired,
  saveAccess,
} from "./access";
import { tg } from "./api";
import { OmpRpcClient } from "./rpc-client";
import {
  activateRpcStateDir,
  bootstrapAccessFromEnv,
  buildOmpChildEnv,
  buildOmpRpcArgv,
  loadLiteralEnvFile,
  loadPersistedRpcState,
  parseRpcCliArgs,
  type RpcRuntimeConfig,
} from "./rpc-config";
import { prepareInheritedHarness } from "./rpc-profile";
import { RpcTelegramRuntime } from "./rpc-runtime";
import { installRpcService, uninstallRpcService } from "./rpc-service";
import type { RpcSessionState } from "./rpc-protocol";

const HELP = `omp-telegram-rpc — persistent Telegram frontend for OMP RPC

Usage:
  omp-telegram-rpc run [options]
  omp-telegram-rpc doctor [options]
  omp-telegram-rpc pair <code> [options]
  omp-telegram-rpc allow <numeric-user-id> [options]
  omp-telegram-rpc remove <numeric-user-id> [options]
  omp-telegram-rpc service-install --env-file <path> [options]
  omp-telegram-rpc service-uninstall

Options:
  --cwd <path>              OMP workspace (default: current directory)
  --state-dir <path>        Isolated transport state
  --profile <name>          Dedicated OMP profile (default: telegram)
  --omp <path>              OMP executable (default: omp)
  --model <provider/id>     Initial OMP model
  --resume <session.jsonl>  Resume an exact session
  --session-dir <path>      Override OMP session storage
  --config <path>           Add an OMP config file (repeatable)
  --omp-arg <value>         Pass an additional OMP flag (repeatable)
  --env-file <path>         Literal KEY=VALUE file containing TELEGRAM_BOT_TOKEN
  --auth-broker-token-file <path>
                            Read a broker token into the OMP child environment
  --inherit-harness         Seed the profile with skills/rules/config from default OMP
  --allow-rpc-bash          Expose the privileged /shell command
  --no-auto-restart         Keep OMP offline after a child crash

Security defaults:
  Numeric Telegram IDs only; one operator; exact-session single writer; RPC bash off;
  bot credentials stripped from the OMP child; interactive confirmations bridged to Telegram.
`;

function envFileFromArgs(argv: string[]): string | undefined {
  const index = argv.indexOf("--env-file");
  if (index >= 0) {
    const value = argv[index + 1];
    if (!value) throw new Error("--env-file requires a value");
    return value;
  }
  return process.env.OMP_TELEGRAM_RPC_ENV_FILE;
}

function requireNumericId(value: string | undefined): string {
  if (!value || !/^\d+$/.test(value)) throw new Error("A numeric Telegram user ID is required");
  return value;
}

async function doctor(config: RpcRuntimeConfig): Promise<void> {
  const token = resolveToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const bot = await tg<{ id: number; username?: string }>(token, "getMe");
  const webhook = await tg<{ url?: string; pending_update_count?: number }>(token, "getWebhookInfo");
  if (webhook.url) throw new Error(`Telegram webhook is configured at ${webhook.url}; long polling requires deleteWebhook first`);

  const persisted = loadPersistedRpcState();
  const client = new OmpRpcClient({
    argv: buildOmpRpcArgv(config, config.resume ?? persisted.sessionFile),
    cwd: config.cwd,
    env: buildOmpChildEnv(process.env, config),
  });
  try {
    await client.start();
    const response = await client.send({ type: "get_state" });
    const state = response.data as RpcSessionState;
    const access = loadAccess();
    console.log(`Telegram: @${bot.username ?? bot.id}`);
    console.log(`Webhook: none (${webhook.pending_update_count ?? 0} updates pending)`);
    console.log(`Access: ${access.allowFrom.length ? access.allowFrom.join(", ") : "not paired"}`);
    console.log(`OMP RPC: protocol v${client.protocolVersion}`);
    console.log(`Session: ${state.sessionName ?? state.sessionId}`);
    console.log(`Model: ${state.model?.provider ?? "?"}/${state.model?.id ?? "?"}`);
    console.log("Doctor: ready");
  } finally {
    await client.stop();
  }
}

async function run(config: RpcRuntimeConfig): Promise<void> {
  const runtime = new RpcTelegramRuntime(config);
  await runtime.start();
  const stopped = Promise.withResolvers<void>();
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void runtime.stop().then(stopped.resolve, stopped.reject);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await stopped.promise;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const requestedEnvFile = envFileFromArgs(argv);
  if (requestedEnvFile) {
    if (!existsSync(requestedEnvFile)) throw new Error(`Environment file not found: ${requestedEnvFile}`);
    loadLiteralEnvFile(requestedEnvFile);
  }
  const config = parseRpcCliArgs(argv);
  prepareInheritedHarness(config);
  activateRpcStateDir(config);
  bootstrapAccessFromEnv();

  if (config.command === "help") {
    console.log(HELP);
    return;
  }
  if (config.command === "doctor") {
    await doctor(config);
    return;
  }
  if (config.command === "pair") {
    const code = config.commandArg?.trim().toLowerCase();
    if (!code) throw new Error("A pairing code is required");
    const access = loadAccess();
    if (pruneExpired(access)) saveAccess(access);
    const entry = access.pending[code];
    if (!entry) throw new Error("Pairing code is invalid or expired");
    const currentOwner = access.allowFrom.length === 1 ? access.allowFrom[0] : undefined;
    if (access.allowFrom.length > 0 && currentOwner !== entry.senderId) {
      throw new Error(`Another Telegram user is already paired (${currentOwner ?? "ambiguous access state"})`);
    }
    saveAccess({ ...access, enabled: true, dmPolicy: "allowlist", allowFrom: [entry.senderId], pending: {} });
    await tg(resolveToken(), "sendMessage", { chat_id: entry.chatId, text: "Paired. Normal messages now reach your OMP RPC session; use /help for controls." }).catch(() => {});
    console.log(`Paired Telegram user ${entry.senderId}`);
    return;
  }
  if (config.command === "allow") {
    const userId = requireNumericId(config.commandArg);
    const access = loadAccess();
    saveAccess({ ...access, enabled: true, dmPolicy: "allowlist", allowFrom: [userId] });
    console.log(`Allowed Telegram user ${userId}`);
    return;
  }
  if (config.command === "remove") {
    const userId = requireNumericId(config.commandArg);
    const access = loadAccess();
    saveAccess({ ...access, allowFrom: access.allowFrom.filter((id) => id !== userId) });
    console.log(`Removed Telegram user ${userId}`);
    return;
  }
  if (config.command === "service-install") {
    if (!config.envFile) throw new Error("service-install requires --env-file so the bot token remains available after login or reboot");
    const result = installRpcService(config);
    console.log(`Installed and started ${result.manager} service: ${result.path}`);
    return;
  }
  if (config.command === "service-uninstall") {
    const result = uninstallRpcService();
    console.log(`Stopped and removed ${result.manager} service: ${result.path}`);
    return;
  }
  await run(config);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
