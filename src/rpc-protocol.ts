import { isRecord } from "./type-guards";

export type RpcRecord = Record<string, unknown>;

export interface RpcCommand extends RpcRecord {
  type: string;
  id?: string;
}

export interface RpcResponse extends RpcRecord {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

export interface RpcReadyFrame extends RpcRecord {
  type: "ready";
  protocolVersion: number;
  supportedProtocolVersions?: number[];
  maxFrameBytes?: number;
  maxReassembledFrameBytes?: number;
}

export interface RpcChunkFrame extends RpcRecord {
  type: "rpc_chunk";
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

export interface RpcImageContent extends RpcRecord {
  type: "image";
  data: string;
  mimeType: string;
}

export interface RpcSessionState extends RpcRecord {
  model?: { provider?: string; id?: string };
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  fastModeEnabled?: boolean;
  fastModeActive?: boolean;
  tokensPerSecond?: number | null;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  queuedMessageCount?: number;
  contextUsage?: { tokens?: number; contextWindow?: number; percent?: number };
  todoPhases?: unknown[];
}

export type RpcExtensionUiRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      optionDetails?: Array<{ description?: string }>;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
      promptStyle?: boolean;
    }
  | { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText?: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
  | {
      type: "extension_ui_request";
      id: string;
      method: "open_url";
      url: string;
      launchUrl?: string;
      instructions?: string;
    };

export type RpcExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

export interface RpcHostToolCall extends RpcRecord {
  type: "host_tool_call";
  id: string;
  toolCallId: string;
  toolName: string;
  arguments: RpcRecord;
}

export interface RpcHostToolCancel extends RpcRecord {
  type: "host_tool_cancel";
  id: string;
  targetId: string;
}

export interface RpcHostToolDefinition extends RpcRecord {
  name: string;
  label?: string;
  description: string;
  parameters: RpcRecord;
  hidden?: boolean;
  loadMode?: "essential" | "discoverable";
}

export type RpcInboundFrame =
  | RpcCommand
  | RpcExtensionUiResponse
  | { type: "host_tool_update"; id: string; partialResult: unknown }
  | { type: "host_tool_result"; id: string; result: unknown; isError?: boolean }
  | { type: "host_uri_result"; id: string; [key: string]: unknown };


export function isRpcResponse(value: unknown): value is RpcResponse {
  return (
    isRecord(value) &&
    value.type === "response" &&
    typeof value.command === "string" &&
    typeof value.success === "boolean" &&
    (value.id === undefined || typeof value.id === "string")
  );
}

export function isRpcReady(value: unknown): value is RpcReadyFrame {
  return isRecord(value) && value.type === "ready" && typeof value.protocolVersion === "number";
}

export function isRpcExtensionUiRequest(value: unknown): value is RpcExtensionUiRequest {
  return (
    isRecord(value) &&
    value.type === "extension_ui_request" &&
    typeof value.id === "string" &&
    typeof value.method === "string"
  );
}

export function isRpcHostToolCall(value: unknown): value is RpcHostToolCall {
  return (
    isRecord(value) &&
    value.type === "host_tool_call" &&
    typeof value.id === "string" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    isRecord(value.arguments)
  );
}

export function isRpcHostToolCancel(value: unknown): value is RpcHostToolCancel {
  return isRecord(value) && value.type === "host_tool_cancel" && typeof value.targetId === "string";
}

function decodeBase64Strict(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array();
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid RPC chunk base64");
  }
  return Buffer.from(value, "base64");
}

interface ChunkSequence {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  chunks: Uint8Array[];
  receivedBytes: number;
}

/** Lossless protocol-v2 chunk reassembly with the invariants required by OMP RPC. */
export class RpcFrameDecoder {
  #sequence: ChunkSequence | undefined;
  #maxBytes: number;

  constructor(maxBytes = 64 * 1024 * 1024) {
    this.#maxBytes = maxBytes;
  }

  setMaxBytes(maxBytes: number): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid RPC reassembly limit");
    this.#maxBytes = maxBytes;
  }

  reset(): void {
    this.#sequence = undefined;
  }

  push(frame: unknown): unknown | undefined {
    if (!isRecord(frame) || frame.type !== "rpc_chunk") {
      if (this.#sequence) throw new Error("RPC chunk sequence was interrupted");
      return frame;
    }

    const chunk = frame as unknown as RpcChunkFrame;
    if (
      typeof chunk.chunkId !== "string" ||
      chunk.chunkId.length === 0 ||
      !Number.isSafeInteger(chunk.index) ||
      !Number.isSafeInteger(chunk.count) ||
      !Number.isSafeInteger(chunk.byteLength) ||
      chunk.index < 0 ||
      chunk.count <= 0 ||
      chunk.index >= chunk.count ||
      chunk.byteLength < 0 ||
      chunk.byteLength > this.#maxBytes ||
      typeof chunk.data !== "string"
    ) {
      throw new Error("Invalid RPC chunk metadata");
    }

    if (!this.#sequence) {
      if (chunk.index !== 0) throw new Error("RPC chunk sequence did not start at index 0");
      this.#sequence = {
        chunkId: chunk.chunkId,
        count: chunk.count,
        byteLength: chunk.byteLength,
        nextIndex: 0,
        chunks: [],
        receivedBytes: 0,
      };
    }

    const sequence = this.#sequence;
    if (
      sequence.chunkId !== chunk.chunkId ||
      sequence.count !== chunk.count ||
      sequence.byteLength !== chunk.byteLength ||
      sequence.nextIndex !== chunk.index
    ) {
      this.#sequence = undefined;
      throw new Error("RPC chunk sequence was interleaved or out of order");
    }

    const bytes = decodeBase64Strict(chunk.data);
    sequence.receivedBytes += bytes.byteLength;
    if (sequence.receivedBytes > sequence.byteLength || sequence.receivedBytes > this.#maxBytes) {
      this.#sequence = undefined;
      throw new Error("RPC chunk sequence exceeded its declared size");
    }
    sequence.chunks.push(bytes);
    sequence.nextIndex += 1;
    if (sequence.nextIndex !== sequence.count) return undefined;

    this.#sequence = undefined;
    if (sequence.receivedBytes !== sequence.byteLength) throw new Error("RPC chunk sequence length mismatch");
    const joined = Buffer.concat(sequence.chunks.map((part) => Buffer.from(part)), sequence.receivedBytes);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(joined);
    const decoded: unknown = JSON.parse(text);
    if (!isRecord(decoded)) throw new Error("Reassembled RPC frame is not an object");
    return decoded;
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is RpcRecord => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("");
}

/** Visible assistant text only. Thinking and tool-call blocks never reach Telegram. */
export function assistantText(message: unknown): string {
  if (!isRecord(message) || message.role !== "assistant") return "";
  return textFromContent(message.content);
}

export function finalAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = assistantText(messages[i]);
    if (text.trim().length > 0) return text;
  }
  return "";
}
