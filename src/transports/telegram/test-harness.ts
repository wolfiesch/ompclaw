import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  IngressCompositionRecord,
  JsonValue,
  PendingInboundMessage,
  PendingInteraction,
} from "../../gateway-store";
import type { StoredSemanticView } from "../../gateway-views";
import type {
  ConversationAddress,
  DeliveryContext,
  InboundEnvelope,
  Principal,
  TransportStartContext,
} from "../../gateway-types";
import {
  TelegramTransportAdapter,
  type TelegramApiSeams,
  type TelegramPoller,
  type TelegramTransportAdapterOptions,
} from "./adapter";
import type { TgMessage, TgUpdate } from "./bot-api";

export interface TelegramApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

export const TELEGRAM_TEST_OWNER: Principal = { id: "principal-owner", roles: ["operator"] };
export const TELEGRAM_TEST_ADDRESS: ConversationAddress = {
  transport: "telegram",
  account: "primary",
  channel: "42",
};
export const TELEGRAM_TEST_DELIVERY: DeliveryContext = {
  principal: TELEGRAM_TEST_OWNER,
  origin: TELEGRAM_TEST_ADDRESS,
};

export class TelegramTestPoller implements TelegramPoller {
  started = false;
  stopped = false;
  handle?: (update: TgUpdate) => void | Promise<void>;

  start(_token: string, handle: (update: TgUpdate) => void | Promise<void>): void {
    this.started = true;
    this.handle = handle;
  }

  stop(): void {
    this.stopped = true;
  }

  async done(): Promise<void> {}
}

export interface FakeTelegramApiOptions {
  readonly setCommandsError?: Error;
  readonly reactionError?: Error;
  readonly transcribe?: boolean;
  readonly poller?: TelegramTestPoller;
  readonly pairingApprovalMonitorError?: Error;
}

export class FakeTelegramApi {
  readonly calls: TelegramApiCall[] = [];
  readonly poller: TelegramTestPoller;
  readonly seams: TelegramApiSeams;
  #messageId = 200;
  #pairingApprovalRun: (() => void | Promise<void>) | undefined;

  constructor(options: FakeTelegramApiOptions = {}) {
    this.poller = options.poller ?? new TelegramTestPoller();
    this.seams = {
      poller: this.poller,
      acquireLock: () => ({ ok: true }),
      releaseLock: () => {},
      startLockHeartbeat: () => () => {},
      now: () => 1_800_000_000_000,
      randomId: () => "interaction-id",
      startPairingApprovalMonitor: (run) => {
        if (options.pairingApprovalMonitorError) throw options.pairingApprovalMonitorError;
        this.#pairingApprovalRun = run;
        run();
        return () => {
          if (this.#pairingApprovalRun === run) this.#pairingApprovalRun = undefined;
        };
      },
      callTelegram: async (method, payload = {}) => {
        this.calls.push({ method, payload });
        if (method === "setMyCommands" && options.setCommandsError) throw options.setCommandsError;
        if (method === "setMessageReaction" && options.reactionError) throw options.reactionError;
        if (method === "sendMessageDraft") return true;
        if (method === "getFile") return { file_path: "uploads/file.bin" };
        if (method === "createForumTopic") return { message_thread_id: 77 };
        if (method === "sendMessage") return { message_id: ++this.#messageId };
        return true;
      },
      downloadFileBytes: async () => new Uint8Array([4, 5, 6]),
      ...(options.transcribe ? { transcribe: async () => "voice transcript" } : {}),
    };
  }

  last(method: string): TelegramApiCall {
    const call = this.calls.findLast((entry) => entry.method === method);
    if (!call) throw new Error(`expected ${method} call`);
    return call;
  }

  async flushPairingApprovals(): Promise<void> {
    await this.#pairingApprovalRun?.();
  }
}

export interface TelegramAdapterHarnessOptions extends FakeTelegramApiOptions {
  readonly resolve?: (subject: string) => Principal | undefined;
  readonly commands?: readonly { readonly command: string; readonly description: string }[];
  readonly transcribe?: boolean;
  readonly createTopicsFromRoot?: boolean;
  readonly failFirstReceive?: boolean;
  readonly pendingIngressAttachmentName?: string;
  readonly pendingAttachmentName?: string;
  readonly receive?: (message: InboundEnvelope) => Promise<void>;
  readonly pairing?: TelegramTransportAdapterOptions["pairing"];
  readonly pendingInteractions?: readonly PendingInteraction[];
}

export interface TelegramAdapterHarness {
  readonly adapter: TelegramTransportAdapter;
  readonly api: FakeTelegramApi;
  readonly calls: TelegramApiCall[];
  readonly checkpoints: Map<string, JsonValue>;
  readonly pending: Map<string, PendingInteraction>;
  readonly poller: TelegramTestPoller;
  readonly semanticViews: Map<string, StoredSemanticView>;
  readonly received: InboundEnvelope[];
  readonly stateDir: string;
  readonly warnings: string[];
  dispose(): Promise<void>;
  flushPairingApprovals(): Promise<void>;
}

const activeHarnesses = new Set<TelegramAdapterHarness>();

export async function createTelegramAdapterHarness(
  options: TelegramAdapterHarnessOptions = {},
): Promise<TelegramAdapterHarness> {
  const retainsPendingAttachment =
    options.pendingAttachmentName !== undefined || options.pendingIngressAttachmentName !== undefined;
  const stateDir = await mkdtemp(join(tmpdir(), retainsPendingAttachment ? "ompclaw adapter " : "ompclaw-adapter-"));
  const inboxDir = join(stateDir, "inbox", "telegram", "primary");
  const received: InboundEnvelope[] = [];
  const checkpoints = new Map<string, JsonValue>();
  const pending = new Map<string, PendingInteraction>(
    (options.pendingInteractions ?? []).map((interaction) => [interaction.id, interaction]),
  );
  const semanticViews = new Map<string, StoredSemanticView>();
  const semanticKey = (address: ConversationAddress, viewId: string): string =>
    JSON.stringify([address.transport, address.account, address.channel, address.thread ?? "", viewId]);
  const pendingInbound: PendingInboundMessage[] =
    options.pendingAttachmentName === undefined
      ? []
      : [
          {
            message: {
              id: "pending-message",
              sentAt: 1_800_000_000_000,
              identity: { transport: "telegram", account: "primary", subject: "42" },
              address: TELEGRAM_TEST_ADDRESS,
              content: {
                attachments: [
                  {
                    url: pathToFileURL(join(inboxDir, options.pendingAttachmentName)).href,
                  },
                ],
              },
              principal: TELEGRAM_TEST_OWNER,
            },
            receivedAt: 1_800_000_000_000,
            scheduled: false,
          },
        ];
  const pendingIngress: IngressCompositionRecord[] =
    options.pendingIngressAttachmentName === undefined
      ? []
      : [
          {
            id: "pending-composition",
            groupKey: "telegram:42:pending-album",
            address: TELEGRAM_TEST_ADDRESS,
            principalId: TELEGRAM_TEST_OWNER.id,
            createdAt: 1_800_000_000_000,
            updatedAt: 1_800_000_000_000,
            flushAt: 1_800_000_000_800,
            deadlineAt: 1_800_000_005_000,
            fragments: [
              {
                id: "pending-fragment",
                sentAt: 1_800_000_000_000,
                identity: { transport: "telegram", account: "primary", subject: "42" },
                address: TELEGRAM_TEST_ADDRESS,
                content: {
                  attachments: [
                    {
                      url: pathToFileURL(join(inboxDir, options.pendingIngressAttachmentName)).href,
                    },
                  ],
                },
                principal: TELEGRAM_TEST_OWNER,
                composition: { kind: "media", groupId: "pending-album", order: 9 },
              },
            ],
          },
        ];
  const warnings: string[] = [];
  const api = new FakeTelegramApi(options);
  const key = (adapter: string, checkpoint: string): string => `${adapter}\0${checkpoint}`;
  const adapter = new TelegramTransportAdapter({
    token: "token",
    account: "primary",
    stateDir,
    commands: options.commands,
    createTopicsFromRoot: options.createTopicsFromRoot,
    pairing: options.pairing,
    store: {
      getCheckpoint: (adapterId, checkpoint) => checkpoints.get(key(adapterId, checkpoint)),
      setCheckpoint: (adapterId, checkpoint, value) => {
        checkpoints.set(key(adapterId, checkpoint), value);
      },
      putPendingInteraction: (interaction) => {
        pending.set(interaction.id, interaction);
      },
      deletePendingInteraction: (id) => pending.delete(id),
      listPendingInteractions: () => [...pending.values()],
      listPendingInboundMessages: () => pendingInbound,
      listPendingIngressCompositions: () => pendingIngress,
      getSemanticView: (address, viewId) => semanticViews.get(semanticKey(address, viewId)),
      getSemanticViewByReceipt: (address, messageId) => {
        for (const view of semanticViews.values()) {
          if (
            view.address.transport === address.transport &&
            view.address.account === address.account &&
            view.address.channel === address.channel &&
            view.address.thread === address.thread &&
            view.receipts.some((receipt) => receipt.messageId === messageId)
          ) {
            return view;
          }
        }
        return undefined;
      },
      putSemanticView: (record) => {
        semanticViews.set(semanticKey(record.address, record.view.id), record);
        return true;
      },
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message) => {
        warnings.push(message);
      },
      error: () => {},
    },
    api: api.seams,
    ...(options.transcribe ? { transcribeCommand: ["speech-to-text"] } : {}),
    uiTimeoutMs: 10_000,
  });
  let receiveAttempt = 0;
  const context: TransportStartContext = {
    receive: async (message) => {
      receiveAttempt += 1;
      if (options.failFirstReceive && receiveAttempt === 1) throw new Error("temporary receive failure");
      await options.receive?.(message);
      received.push(message);
    },
    resolveIdentity: (identity) =>
      options.resolve?.(identity.subject) ?? (identity.subject === "42" ? TELEGRAM_TEST_OWNER : undefined),
  };
  try {
    await adapter.start(context);
  } catch (error) {
    await rm(stateDir, { recursive: true, force: true });
    throw error;
  }

  const harness: TelegramAdapterHarness = {
    adapter,
    api,
    calls: api.calls,
    checkpoints,
    pending,
    poller: api.poller,
    received,
    semanticViews,
    stateDir,
    warnings,
    flushPairingApprovals: () => api.flushPairingApprovals(),
    async dispose() {
      let stopError: unknown;
      let didStopThrow = false;
      try {
        await adapter.stop();
      } catch (error) {
        didStopThrow = true;
        stopError = error;
      }
      activeHarnesses.delete(harness);
      let cleanupError: unknown;
      let didCleanupThrow = false;
      try {
        await rm(stateDir, { recursive: true, force: true });
      } catch (error) {
        didCleanupThrow = true;
        cleanupError = error;
      }
      if (didStopThrow) throw stopError;
      if (didCleanupThrow) throw cleanupError;
    },
  };
  activeHarnesses.add(harness);
  return harness;
}

export async function disposeTelegramAdapterHarnesses(): Promise<void> {
  await Promise.all([...activeHarnesses].map((harness) => harness.dispose()));
}

export function telegramTestMessage(overrides: Partial<TgMessage> = {}): TgMessage {
  return {
    message_id: 10,
    date: 1_800_000_000,
    chat: { id: 42, type: "private" },
    from: { id: 42, first_name: "Wolfgang" },
    text: "hello",
    ...overrides,
  };
}

export function lastTelegramCall(calls: readonly TelegramApiCall[], method = "sendMessage"): TelegramApiCall {
  const call = calls.findLast((entry) => entry.method === method);
  if (!call) throw new Error(`expected ${method} call`);
  return call;
}

export function telegramCallbackData(call: TelegramApiCall, label: string): string {
  const markup = call.payload.reply_markup;
  if (
    markup === null ||
    typeof markup !== "object" ||
    !("inline_keyboard" in markup) ||
    !Array.isArray(markup.inline_keyboard)
  ) {
    throw new Error("expected inline keyboard");
  }
  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row)) continue;
    for (const button of row) {
      if (
        button !== null &&
        typeof button === "object" &&
        "text" in button &&
        button.text === label &&
        "callback_data" in button &&
        typeof button.callback_data === "string"
      )
        return button.callback_data;
    }
  }
  throw new Error(`missing button ${label}`);
}

export async function flushTelegramTasks(): Promise<void> {
  await Bun.sleep(0);
}
