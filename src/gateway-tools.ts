import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { Cron } from "croner";
import {
  formatScheduledJob,
  type GatewayAutomationControl,
  type ScheduledJobContext,
} from "./gateway-scheduler";
import type { GatewayUpdateControl } from "./gateway-update";
import type {
  ConversationAddress,
  DeliveryContext,
  MessageAttachment,
  OutboundContent,
  OutboundReceipt,
  Reaction,
  TransportIdentity,
  UiRequest,
  UiResponseFor,
} from "./gateway-types";
import type { RpcHostToolCall, RpcHostToolDefinition, RpcRecord } from "./rpc-protocol";

/** Transport-neutral delivery surface used by OMP host tools. */
export interface GatewayDelivery {
  send(
    address: ConversationAddress,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt>;
  typing?(
    address: ConversationAddress,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<void>;
  update(
    address: ConversationAddress,
    receipt: OutboundReceipt,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt>;
  finalize(
    address: ConversationAddress,
    receipt: OutboundReceipt | undefined,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<readonly OutboundReceipt[]>;
  react(
    address: ConversationAddress,
    receipt: OutboundReceipt,
    reaction: Reaction,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<void>;
  presentUi<Request extends UiRequest>(
    address: ConversationAddress,
    request: Request,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<UiResponseFor<Request>>;
}

export interface GatewayHostToolContext {
  readonly delivery: GatewayDelivery;
  readonly address: ConversationAddress;
  readonly deliveryContext: DeliveryContext;
  readonly identity: TransportIdentity;
  readonly automation?: GatewayAutomationControl;
  readonly updates?: GatewayUpdateControl;
}

const gatewayHostTools: readonly RpcHostToolDefinition[] = [
  {
    name: "ompclaw_send",
    label: "Send message",
    description: "Send text and optional absolute local files to the active conversation.",
    loadMode: "essential",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1 },
        files: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1, pattern: "^/" },
        },
      },
      anyOf: [{ required: ["text"] }, { required: ["files"] }],
      additionalProperties: false,
    },
  },
  {
    name: "ompclaw_react",
    label: "React to message",
    description: "React to a message in the active conversation.",
    loadMode: "discoverable",
    parameters: {
      type: "object",
      properties: {
        message_id: { type: "string", minLength: 1 },
        emoji: { type: "string", minLength: 1 },
      },
      required: ["message_id", "emoji"],
      additionalProperties: false,
    },
  },
  {
    name: "ompclaw_ask",
    label: "Ask operator",
    description: "Ask the active operator a free-text, single-select, or multi-select question.",
    loadMode: "essential",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        question: { type: "string", minLength: 1 },
        options: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
        multi: { type: "boolean" },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
];

const automationHostTools: readonly RpcHostToolDefinition[] = [
  {
    name: "ompclaw_schedule_job",
    label: "Schedule unattended job",
    description: "Create a durable one-shot or cron job that runs in this gateway and reports to the active conversation.",
    loadMode: "essential",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        prompt: { type: "string", minLength: 1, maxLength: 16_000 },
        at: { type: "string", minLength: 1, description: "ISO 8601 date-time for a one-shot job." },
        cron: { type: "string", minLength: 1, maxLength: 256, description: "Cron expression for a recurring job." },
        timezone: { type: "string", minLength: 1, maxLength: 128, description: "IANA timezone for a cron job." },
      },
      required: ["name", "prompt"],
      oneOf: [{ required: ["at"], not: { required: ["cron"] } }, { required: ["cron"], not: { required: ["at"] } }],
      additionalProperties: false,
    },
  },
  {
    name: "ompclaw_watch",
    label: "Watch recurring task",
    description: "Create a recurring check-and-notify job that runs in this gateway and reports to the active conversation.",
    loadMode: "essential",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120, description: "Short label for what is being watched." },
        prompt: { type: "string", minLength: 1, maxLength: 16_000, description: "Recurring check instruction and notify criteria." },
        everyMinutes: { type: "integer", minimum: 1, maximum: 60, description: "Run interval in minutes (1-60)." },
        cron: { type: "string", minLength: 1, maxLength: 256, description: "Cron expression for a recurring watch schedule." },
        timezone: { type: "string", minLength: 1, maxLength: 128, description: "IANA timezone for a cron schedule." },
      },
      required: ["name", "prompt"],
      oneOf: [
        { required: ["everyMinutes"], not: { required: ["cron"] } },
        { required: ["cron"], not: { required: ["everyMinutes"] } },
      ],
      additionalProperties: false,
    },
  },
  {
    name: "ompclaw_update_job",
    label: "Update scheduled job",
    description: "Update a durable job owned by the active principal. Supplying at or cron replaces its schedule.",
    loadMode: "discoverable",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, maxLength: 128 },
        name: { type: "string", minLength: 1, maxLength: 120 },
        prompt: { type: "string", minLength: 1, maxLength: 16_000 },
        at: { type: "string", minLength: 1 },
        cron: { type: "string", minLength: 1, maxLength: 256 },
        timezone: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "ompclaw_list_jobs",
    label: "List scheduled jobs",
    description: "List durable jobs owned by the active principal, including schedules, next runs, and failures.",
    loadMode: "essential",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ompclaw_set_job_enabled",
    label: "Enable or disable job",
    description: "Enable or disable a durable job owned by the active principal.",
    loadMode: "discoverable",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, maxLength: 128 },
        enabled: { type: "boolean" },
      },
      required: ["id", "enabled"],
      additionalProperties: false,
    },
  },
  {
    name: "ompclaw_delete_job",
    label: "Delete scheduled job",
    description: "Permanently delete a durable job owned by the active principal.",
    loadMode: "discoverable",
    parameters: {
      type: "object",
      properties: { id: { type: "string", minLength: 1, maxLength: 128 } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "ompclaw_run_job",
    label: "Run scheduled job now",
    description: "Queue a durable job owned by the active principal to run as soon as the current turn finishes.",
    loadMode: "discoverable",
    parameters: {
      type: "object",
      properties: { id: { type: "string", minLength: 1, maxLength: 128 } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

const updateHostTools: readonly RpcHostToolDefinition[] = [
  {
    name: "ompclaw_stage_update",
    label: "Stage OmpClaw update",
    description: "Build and verify one exact OmpClaw Git commit as an inactive versioned release. This does not restart the gateway.",
    loadMode: "discoverable",
    parameters: {
      type: "object",
      properties: {
        commit: { type: "string", minLength: 7, maxLength: 64 },
      },
      required: ["commit"],
      additionalProperties: false,
    },
  },
  {
    name: "ompclaw_activate_update",
    label: "Activate OmpClaw update",
    description: "Arm a staged release for activation after the current response is delivered. Use only after the operator explicitly requests activation.",
    loadMode: "discoverable",
    parameters: {
      type: "object",
      properties: {
        release_id: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["release_id"],
      additionalProperties: false,
    },
  },
];

export interface GatewayHostToolOptions {
  readonly automation?: boolean;
  readonly updates?: boolean;
}

export function gatewayHostToolDefinitions(options: GatewayHostToolOptions = {}): RpcHostToolDefinition[] {
  const tools = [
    ...gatewayHostTools,
    ...(options.automation ? automationHostTools : []),
    ...(options.updates ? updateHostTools : []),
  ];
  return tools.map((tool) => ({ ...tool }));
}

export async function executeGatewayHostTool(
  call: RpcHostToolCall,
  context: GatewayHostToolContext,
  signal?: AbortSignal,
): Promise<unknown> {
  switch (call.toolName) {
    case "ompclaw_send":
      return executeSend(call.arguments, context, signal);
    case "ompclaw_react":
      return executeReact(call.arguments, context, signal);
    case "ompclaw_ask":
      return executeAsk(call.arguments, context, signal);
    case "ompclaw_schedule_job":
      return executeScheduleJob(call.arguments, context);
    case "ompclaw_watch":
    case "watch":
      return executeWatch(call.arguments, context);
    case "ompclaw_update_job":
      return executeUpdateJob(call.arguments, context);
    case "ompclaw_list_jobs":
      return executeListJobs(call.arguments, context);
    case "ompclaw_set_job_enabled":
      return executeSetJobEnabled(call.arguments, context);
    case "ompclaw_delete_job":
      return executeDeleteJob(call.arguments, context);
    case "ompclaw_run_job":
      return executeRunJob(call.arguments, context);
    case "ompclaw_stage_update":
      return executeStageUpdate(call.arguments, context, signal);
    case "ompclaw_activate_update":
      return executeActivateUpdate(call.arguments, context);
    default:
      throw new Error(`Unknown host tool: ${call.toolName}`);
  }
}

async function executeSend(
  arguments_: unknown,
  context: GatewayHostToolContext,
  signal?: AbortSignal,
): Promise<OutboundReceipt> {
  const argumentsRecord = parseArguments(arguments_, ["text", "files"]);
  const text = optionalNonEmptyString(argumentsRecord, "text");
  const files = optionalAbsoluteFiles(argumentsRecord, "files");
  if (text === undefined && files === undefined) {
    throw new Error("ompclaw_send requires text or files");
  }

  const content: OutboundContent = {
    ...(text === undefined ? {} : { text }),
    ...(files === undefined ? {} : { attachments: files }),
  };
  return context.delivery.send(context.address, content, context.deliveryContext, signal);
}

async function executeReact(
  arguments_: unknown,
  context: GatewayHostToolContext,
  signal?: AbortSignal,
): Promise<{ reacted: true }> {
  const argumentsRecord = parseArguments(arguments_, ["message_id", "emoji"]);
  const messageId = requiredNonEmptyString(argumentsRecord, "message_id");
  const emoji = requiredNonEmptyString(argumentsRecord, "emoji");
  const receipt: OutboundReceipt = { transport: context.address.transport, messageId };
  await context.delivery.react(context.address, receipt, { emoji }, context.deliveryContext, signal);
  return { reacted: true };
}

async function executeAsk(
  arguments_: unknown,
  context: GatewayHostToolContext,
  signal?: AbortSignal,
): Promise<{ answer: string | readonly string[] | undefined }> {
  const argumentsRecord = parseArguments(arguments_, ["title", "question", "options", "multi"]);
  const title = optionalString(argumentsRecord, "title") ?? "OMP question";
  const question = requiredNonEmptyString(argumentsRecord, "question");
  const options = optionalOptions(argumentsRecord, "options");
  const multi = optionalBoolean(argumentsRecord, "multi");
  if (options === undefined && multi !== undefined) {
    throw new Error("ompclaw_ask multi requires options");
  }

  if (options === undefined) {
    const response = await context.delivery.presentUi(
      context.address,
      { type: "input", title, prompt: question },
      context.deliveryContext,
      signal,
    );
    return { answer: response.cancelled ? undefined : response.value };
  }

  const response = await context.delivery.presentUi(
    context.address,
    {
      type: "select",
      title,
      options: options.map((option) => ({ value: option, label: option })),
      ...(multi === true ? { multiSelect: true } : {}),
    },
    context.deliveryContext,
    signal,
  );
  return { answer: multi === true ? response.selected : response.selected[0] };
}

function executeScheduleJob(arguments_: unknown, context: GatewayHostToolContext): { job: string } {
  const automation = requireAutomation(context);
  const argumentsRecord = parseArguments(arguments_, ["name", "prompt", "at", "cron", "timezone"]);
  const job = automation.create({
    name: requiredNonEmptyString(argumentsRecord, "name"),
    prompt: requiredNonEmptyString(argumentsRecord, "prompt"),
    ...(optionalNonEmptyString(argumentsRecord, "at") === undefined ? {} : { at: optionalNonEmptyString(argumentsRecord, "at") }),
    ...(optionalNonEmptyString(argumentsRecord, "cron") === undefined ? {} : { cron: optionalNonEmptyString(argumentsRecord, "cron") }),
    ...(optionalNonEmptyString(argumentsRecord, "timezone") === undefined ? {} : { timezone: optionalNonEmptyString(argumentsRecord, "timezone") }),
  }, scheduledContext(context));
  return { job: formatScheduledJob(job) };
}

function executeWatch(
  arguments_: unknown,
  context: GatewayHostToolContext,
): { id: string; name: string; job: string } {
  const automation = requireAutomation(context);
  const argumentsRecord = parseArguments(arguments_, ["name", "prompt", "everyMinutes", "cron", "timezone"]);

  const rawName = requiredNonEmptyString(argumentsRecord, "name").trim();
  if (rawName.length === 0) {
    throw new Error("name must not be empty");
  }
  const name = rawName.startsWith("watch: ") ? rawName : `watch: ${rawName}`;
  if (name.length > 120) {
    throw new Error("name must be at most 113 characters");
  }

  const prompt = requiredNonEmptyString(argumentsRecord, "prompt");
  if (prompt.trim().length === 0) {
    throw new Error("prompt must not be empty");
  }
  if (prompt.length > 16_000) {
    throw new Error("job prompt must be a non-empty string of at most 16000 characters");
  }

  const everyMinutes = optionalPositiveInteger(argumentsRecord, "everyMinutes");
  const cron = optionalNonEmptyString(argumentsRecord, "cron");

  if ((everyMinutes === undefined) === (cron === undefined)) {
    throw new Error("Specify exactly one of everyMinutes or cron");
  }

  const timezone = optionalNonEmptyString(argumentsRecord, "timezone");
  if (timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    } catch {
      throw new Error(`Invalid IANA timezone ${timezone}`);
    }
  }

  const cronExpression = everyMinutes !== undefined ? `*/${everyMinutes} * * * *` : cron!;
  try {
    new Cron(cronExpression, { paused: true, ...(timezone === undefined ? {} : { timezone }) });
  } catch (error) {
    throw new Error(`Invalid cron schedule: ${error instanceof Error ? error.message : String(error)}`);
  }

  const job = automation.create(
    {
      name,
      prompt,
      cron: cronExpression,
      ...(timezone === undefined ? {} : { timezone }),
    },
    scheduledContext(context),
  );

  return {
    id: job.id,
    name: job.name,
    job: formatScheduledJob(job),
  };
}

function executeUpdateJob(arguments_: unknown, context: GatewayHostToolContext): { job: string } {
  const automation = requireAutomation(context);
  const argumentsRecord = parseArguments(arguments_, ["id", "name", "prompt", "at", "cron", "timezone"]);
  const job = automation.update({
    id: requiredNonEmptyString(argumentsRecord, "id"),
    ...(optionalNonEmptyString(argumentsRecord, "name") === undefined ? {} : { name: optionalNonEmptyString(argumentsRecord, "name") }),
    ...(optionalNonEmptyString(argumentsRecord, "prompt") === undefined ? {} : { prompt: optionalNonEmptyString(argumentsRecord, "prompt") }),
    ...(optionalNonEmptyString(argumentsRecord, "at") === undefined ? {} : { at: optionalNonEmptyString(argumentsRecord, "at") }),
    ...(optionalNonEmptyString(argumentsRecord, "cron") === undefined ? {} : { cron: optionalNonEmptyString(argumentsRecord, "cron") }),
    ...(optionalNonEmptyString(argumentsRecord, "timezone") === undefined ? {} : { timezone: optionalNonEmptyString(argumentsRecord, "timezone") }),
  }, scheduledContext(context));
  return { job: formatScheduledJob(job) };
}

function executeListJobs(arguments_: unknown, context: GatewayHostToolContext): { jobs: readonly string[] } {
  parseArguments(arguments_, []);
  return {
    jobs: requireAutomation(context).list(context.deliveryContext.principal.id).map(formatScheduledJob),
  };
}

function executeSetJobEnabled(arguments_: unknown, context: GatewayHostToolContext): { job: string } {
  const argumentsRecord = parseArguments(arguments_, ["id", "enabled"]);
  const enabled = optionalBoolean(argumentsRecord, "enabled");
  if (enabled === undefined) throw new Error("enabled is required");
  const job = requireAutomation(context).setEnabled(
    requiredNonEmptyString(argumentsRecord, "id"),
    context.deliveryContext.principal.id,
    enabled,
  );
  return { job: formatScheduledJob(job) };
}

function executeDeleteJob(arguments_: unknown, context: GatewayHostToolContext): { deleted: boolean } {
  const argumentsRecord = parseArguments(arguments_, ["id"]);
  return {
    deleted: requireAutomation(context).remove(
      requiredNonEmptyString(argumentsRecord, "id"),
      context.deliveryContext.principal.id,
    ),
  };
}

function executeRunJob(arguments_: unknown, context: GatewayHostToolContext): { job: string } {
  const argumentsRecord = parseArguments(arguments_, ["id"]);
  const job = requireAutomation(context).runNow(
    requiredNonEmptyString(argumentsRecord, "id"),
    context.deliveryContext.principal.id,
  );
  return { job: formatScheduledJob(job) };
}

async function executeStageUpdate(
  arguments_: unknown,
  context: GatewayHostToolContext,
  signal?: AbortSignal,
): Promise<{ release: string; reused: boolean }> {
  const updates = requireUpdates(context);
  requireOperator(context);
  const argumentsRecord = parseArguments(arguments_, ["commit"]);
  const staged = await updates.stage(requiredNonEmptyString(argumentsRecord, "commit"), signal);
  return { release: staged.release.id, reused: staged.reused };
}

async function executeActivateUpdate(
  arguments_: unknown,
  context: GatewayHostToolContext,
): Promise<{ update: string }> {
  const updates = requireUpdates(context);
  requireOperator(context);
  const argumentsRecord = parseArguments(arguments_, ["release_id"]);
  return updates.arm(requiredNonEmptyString(argumentsRecord, "release_id"), {
    address: context.address,
    principal: context.deliveryContext.principal,
  });
}

function requireUpdates(context: GatewayHostToolContext): GatewayUpdateControl {
  if (context.updates === undefined) throw new Error("OmpClaw transactional updates are disabled");
  return context.updates;
}

function requireOperator(context: GatewayHostToolContext): void {
  if (!context.deliveryContext.principal.roles.includes("operator")) {
    throw new Error("OmpClaw updates require the operator role");
  }
}

function requireAutomation(context: GatewayHostToolContext): GatewayAutomationControl {
  if (context.automation === undefined) throw new Error("OmpClaw automation is disabled");
  return context.automation;
}

function scheduledContext(context: GatewayHostToolContext): ScheduledJobContext {
  return {
    principal: context.deliveryContext.principal,
    identity: context.identity,
    address: context.address,
  };
}

function parseArguments(value: unknown, allowedKeys: readonly string[]): RpcRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Host tool arguments must be an object");
  }
  const argumentsRecord = value as RpcRecord;
  for (const key of Object.keys(argumentsRecord)) {
    if (!allowedKeys.includes(key)) throw new Error(`Unknown host tool argument: ${key}`);
  }
  return argumentsRecord;
}

function optionalString(argumentsRecord: RpcRecord, key: string): string | undefined {
  if (!Object.hasOwn(argumentsRecord, key)) return undefined;
  const value = argumentsRecord[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function optionalNonEmptyString(argumentsRecord: RpcRecord, key: string): string | undefined {
  const value = optionalString(argumentsRecord, key);
  if (value !== undefined && value.length === 0) throw new Error(`${key} must not be empty`);
  return value;
}

function requiredNonEmptyString(argumentsRecord: RpcRecord, key: string): string {
  const value = optionalNonEmptyString(argumentsRecord, key);
  if (value === undefined) throw new Error(`${key} is required`);
  return value;
}

function optionalAbsoluteFiles(argumentsRecord: RpcRecord, key: string): readonly MessageAttachment[] | undefined {
  if (!Object.hasOwn(argumentsRecord, key)) return undefined;
  const value = argumentsRecord[key];
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${key} must be a non-empty array`);
  return value.map((file) => {
    if (typeof file !== "string" || file.length === 0 || !isAbsolute(file)) {
      throw new Error(`${key} must contain absolute local paths`);
    }
    return { url: pathToFileURL(file).href };
  });
}

function optionalOptions(argumentsRecord: RpcRecord, key: string): readonly string[] | undefined {
  if (!Object.hasOwn(argumentsRecord, key)) return undefined;
  const value = argumentsRecord[key];
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${key} must be a non-empty array`);
  return value.map((option) => {
    if (typeof option !== "string" || option.length === 0) throw new Error(`${key} must contain non-empty strings`);
    return option;
  });
}

function optionalBoolean(argumentsRecord: RpcRecord, key: string): boolean | undefined {
  if (!Object.hasOwn(argumentsRecord, key)) return undefined;
  const value = argumentsRecord[key];
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function optionalPositiveInteger(argumentsRecord: RpcRecord, key: string): number | undefined {
  if (!Object.hasOwn(argumentsRecord, key) || argumentsRecord[key] === undefined) return undefined;
  const value = argumentsRecord[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  if (value > 60) {
    throw new Error(`${key} must be between 1 and 60 (use cron for longer schedules)`);
  }
  return value;
}
