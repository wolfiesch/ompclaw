import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ConversationAddress,
  DeliveryContext,
  MessageAttachment,
  OutboundContent,
  OutboundReceipt,
  Reaction,
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
  update(
    address: ConversationAddress,
    receipt: OutboundReceipt,
    content: OutboundContent,
    context: DeliveryContext,
    signal?: AbortSignal,
  ): Promise<OutboundReceipt>;
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
}

const gatewayHostTools: readonly RpcHostToolDefinition[] = [
  {
    name: "gateway_send",
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
    name: "gateway_react",
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
    name: "gateway_ask",
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

export function gatewayHostToolDefinitions(): RpcHostToolDefinition[] {
  return gatewayHostTools.map((tool) => ({ ...tool }));
}

export async function executeGatewayHostTool(
  call: RpcHostToolCall,
  context: GatewayHostToolContext,
  signal?: AbortSignal,
): Promise<unknown> {
  switch (call.toolName) {
    case "gateway_send":
      return executeSend(call.arguments, context, signal);
    case "gateway_react":
      return executeReact(call.arguments, context, signal);
    case "gateway_ask":
      return executeAsk(call.arguments, context, signal);
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
    throw new Error("gateway_send requires text or files");
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
    throw new Error("gateway_ask multi requires options");
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
