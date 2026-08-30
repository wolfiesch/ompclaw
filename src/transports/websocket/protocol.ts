import type { MessageAttachment, OutboundContent, UiRequest, UiResponse } from "../../gateway-types";
import { isRecord } from "../../type-guards";

export const WEBSOCKET_PROTOCOL_VERSION = 1;
export const WEBSOCKET_TRANSPORT_ID = "websocket";

const MAX_CLIENT_MESSAGE_ID_LENGTH = 256;
const MAX_REQUEST_ID_LENGTH = 256;
const MAX_ATTACHMENT_COUNT = 32;
const MAX_ATTACHMENT_URL_LENGTH = 8_192;
const MAX_ATTACHMENT_NAME_LENGTH = 1_024;
const MAX_ATTACHMENT_MEDIA_TYPE_LENGTH = 256;
const MAX_TOKEN_LENGTH = 4_096;
const MAX_SELECT_VALUES = 256;

export interface AuthenticateFrame {
  readonly type: "authenticate";
  readonly token: string;
}

export interface ClientMessageFrame {
  readonly type: "message";
  readonly id: string;
  readonly text?: string;
  readonly attachments?: readonly MessageAttachment[];
}

export interface UiResponseFrame {
  readonly type: "ui_response";
  readonly requestId: string;
  readonly response: UiResponse;
}

export type ClientFrame = AuthenticateFrame | ClientMessageFrame | UiResponseFrame;

export interface ReadyFrame {
  readonly type: "ready";
  readonly protocolVersion: typeof WEBSOCKET_PROTOCOL_VERSION;
}

export interface ServerMessageFrame {
  readonly type: "message";
  readonly messageId: string;
  readonly content: OutboundContent;
}

export interface ServerUpdateFrame {
  readonly type: "update";
  readonly messageId: string;
  readonly content: OutboundContent;
}

export interface ServerReactionFrame {
  readonly type: "reaction";
  readonly messageId: string;
  readonly emoji: string;
}

export interface ServerUiRequestFrame {
  readonly type: "ui_request";
  readonly requestId: string;
  readonly request: UiRequest;
}

export interface ServerErrorFrame {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
}

export type ServerFrame =
  | ReadyFrame
  | ServerMessageFrame
  | ServerUpdateFrame
  | ServerReactionFrame
  | ServerUiRequestFrame
  | ServerErrorFrame;

export class InvalidWebSocketFrameError extends Error {
  readonly name = "InvalidWebSocketFrameError";

  constructor(readonly code: "invalid_frame" | "payload_too_large", message: string) {
    super(message);
  }
}

/**
 * Parses an exact v1 client frame. The byte limit applies before JSON parsing so
 * malformed peers cannot make the server allocate an unbounded object graph.
 */
export function parseClientFrame(raw: string | Buffer, maxMessageLength: number): ClientFrame {
  const byteLength = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
  if (byteLength > maxFrameBytes(maxMessageLength)) {
    throw new InvalidWebSocketFrameError("payload_too_large", "frame exceeds the configured payload limit");
  }

  if (typeof raw !== "string") {
    throw new InvalidWebSocketFrameError("invalid_frame", "binary frames are not supported");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InvalidWebSocketFrameError("invalid_frame", "frame is not valid JSON");
  }

  if (!isRecord(value) || typeof value.type !== "string") {
    throw new InvalidWebSocketFrameError("invalid_frame", "frame must be an object with a type");
  }

  switch (value.type) {
    case "authenticate":
      return { type: "authenticate", token: boundedString(value.token, "token", MAX_TOKEN_LENGTH, false) };
    case "message":
      return parseMessageFrame(value, maxMessageLength);
    case "ui_response":
      return parseUiResponseFrame(value, maxMessageLength);
    default:
      throw new InvalidWebSocketFrameError("invalid_frame", "unknown frame type");
  }
}

export function maxFrameBytes(maxMessageLength: number): number {
  validateMaxMessageLength(maxMessageLength);
  // Message text is bounded by maxMessageLength. The rest accommodates the
  // protocol envelope and a bounded attachment/UI-response collection.
  return Math.max(1_024, maxMessageLength * 8 + 16_384);
}

export function validateMaxMessageLength(maxMessageLength: number): void {
  if (!Number.isSafeInteger(maxMessageLength) || maxMessageLength < 1 || maxMessageLength > 1_000_000) {
    throw new RangeError("maxMessageLength must be a safe integer between 1 and 1,000,000");
  }
}

function parseMessageFrame(value: Record<string, unknown>, maxMessageLength: number): ClientMessageFrame {
  assertExactKeys(value, ["type", "id", "text", "attachments"]);
  const id = boundedString(value.id, "id", Math.min(maxMessageLength, MAX_CLIENT_MESSAGE_ID_LENGTH), false);
  const text = value.text === undefined ? undefined : boundedString(value.text, "text", maxMessageLength, true);
  const attachments = value.attachments === undefined ? undefined : parseAttachments(value.attachments, maxMessageLength);
  if (text === undefined && attachments === undefined) {
    throw new InvalidWebSocketFrameError("invalid_frame", "message requires text or attachments");
  }
  return {
    type: "message",
    id,
    ...(text === undefined ? {} : { text }),
    ...(attachments === undefined ? {} : { attachments }),
  };
}

function parseUiResponseFrame(value: Record<string, unknown>, maxMessageLength: number): UiResponseFrame {
  assertExactKeys(value, ["type", "requestId", "response"]);
  return {
    type: "ui_response",
    requestId: boundedString(value.requestId, "requestId", MAX_REQUEST_ID_LENGTH, false),
    response: parseUiResponse(value.response, maxMessageLength),
  };
}

function parseAttachments(value: unknown, maxMessageLength: number): readonly MessageAttachment[] {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENT_COUNT) {
    throw new InvalidWebSocketFrameError("invalid_frame", "attachments must be a bounded array");
  }

  return value.map((attachment) => {
    if (!isRecord(attachment)) throw new InvalidWebSocketFrameError("invalid_frame", "attachment must be an object");
    assertExactKeys(attachment, ["url", "name", "mediaType"]);
    const url = boundedString(attachment.url, "attachment.url", MAX_ATTACHMENT_URL_LENGTH, false);
    const name =
      attachment.name === undefined
        ? undefined
        : boundedString(attachment.name, "attachment.name", Math.min(maxMessageLength, MAX_ATTACHMENT_NAME_LENGTH), true);
    const mediaType =
      attachment.mediaType === undefined
        ? undefined
        : boundedString(attachment.mediaType, "attachment.mediaType", MAX_ATTACHMENT_MEDIA_TYPE_LENGTH, true);
    return { url, ...(name === undefined ? {} : { name }), ...(mediaType === undefined ? {} : { mediaType }) };
  });
}

function parseUiResponse(value: unknown, maxMessageLength: number): UiResponse {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new InvalidWebSocketFrameError("invalid_frame", "response must be an object with a type");
  }

  switch (value.type) {
    case "confirm":
      assertExactKeys(value, ["type", "confirmed"]);
      if (typeof value.confirmed !== "boolean") invalid("response.confirmed must be a boolean");
      return { type: "confirm", confirmed: value.confirmed };
    case "select": {
      assertExactKeys(value, ["type", "selected"]);
      if (!Array.isArray(value.selected) || value.selected.length > MAX_SELECT_VALUES) {
        invalid("response.selected must be a bounded array");
      }
      return {
        type: "select",
        selected: value.selected.map((selected) => boundedString(selected, "response.selected", maxMessageLength, true)),
      };
    }
    case "input":
      return parseTextResponse(value, "input", maxMessageLength);
    case "editor":
      return parseTextResponse(value, "editor", maxMessageLength);
    case "notify":
    case "status":
    case "widget":
    case "title":
    case "editor_text":
      assertExactKeys(value, ["type", "acknowledged"]);
      if (value.acknowledged !== true) invalid("response.acknowledged must be true");
      return { type: value.type, acknowledged: true };
    case "open_url":
      assertExactKeys(value, ["type", "opened"]);
      if (typeof value.opened !== "boolean") invalid("response.opened must be a boolean");
      return { type: "open_url", opened: value.opened };
    default:
      invalid("unknown UI response type");
  }
}

function parseTextResponse(
  value: Record<string, unknown>,
  type: "input" | "editor",
  maxMessageLength: number,
): UiResponse {
  assertExactKeys(value, ["type", "cancelled", "value"]);
  if (typeof value.cancelled !== "boolean") invalid("response.cancelled must be a boolean");
  if (value.cancelled) {
    if (value.value !== undefined) invalid("cancelled responses must not include a value");
    return { type, cancelled: true };
  }
  return { type, cancelled: false, value: boundedString(value.value, "response.value", maxMessageLength, true) };
}

function boundedString(value: unknown, field: string, maxLength: number, allowEmpty: boolean): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new InvalidWebSocketFrameError("invalid_frame", `${field} must be a ${allowEmpty ? "string" : "non-empty string"}`);
  }
  if (value.length > maxLength) {
    throw new InvalidWebSocketFrameError("payload_too_large", `${field} exceeds the configured payload limit`);
  }
  return value;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new InvalidWebSocketFrameError("invalid_frame", "frame contains unsupported fields");
  }
}

function invalid(message: string): never {
  throw new InvalidWebSocketFrameError("invalid_frame", message);
}
