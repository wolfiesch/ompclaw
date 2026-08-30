import type {
  ConversationAddress,
  DeliveryContext,
  UiRequest,
  UiResponse,
} from "./gateway-types";
import type { GatewayDelivery } from "./gateway-tools";
import type { RpcExtensionUiRequest, RpcExtensionUiResponse } from "./rpc-protocol";

export interface RpcUiLogger {
  warn(message: string): void;
}

export interface RpcGatewayUiTarget {
  readonly address: ConversationAddress;
  readonly deliveryContext: DeliveryContext;
}

export interface RpcGatewayUiBrokerOptions {
  readonly delivery: GatewayDelivery;
  readonly sendResponse: (response: RpcExtensionUiResponse) => void;
  readonly getTarget: () => RpcGatewayUiTarget | undefined;
  readonly log: RpcUiLogger;
}

interface PendingUi {
  readonly rpcId: string;
  readonly request: Exclude<RpcExtensionUiRequest, { method: "cancel" }>;
  readonly controller: AbortController;
  timer?: NodeJS.Timeout;
  timedOut: boolean;
}

/** Bridges OMP RPC UI requests to the active authenticated gateway delivery context. */
export class RpcGatewayUiBroker {
  readonly #options: RpcGatewayUiBrokerOptions;
  readonly #pendingByRpcId = new Map<string, PendingUi>();
  readonly #statuses: Record<string, string> = {};
  readonly #widgets: Record<string, string[]> = {};
  #title = "OMP";
  #editorText = "";

  constructor(options: RpcGatewayUiBrokerOptions) {
    this.#options = options;
  }

  statusText(): string {
    const lines = [`Surface: ${this.#title}`];
    for (const [key, value] of Object.entries(this.#statuses)) lines.push(`${key}: ${value}`);
    for (const [key, value] of Object.entries(this.#widgets)) lines.push(`${key}: ${value.join(" | ")}`);
    if (this.#editorText) lines.push(`Suggested input: ${this.#editorText}`);
    return lines.join("\n");
  }

  async handle(request: RpcExtensionUiRequest): Promise<void> {
    if (request.method === "cancel") {
      this.cancel(request.targetId);
      return;
    }

    this.#rememberDisplayState(request);
    const target = this.#options.getTarget();
    if (!target) {
      this.#logMissingTarget(request);
      return;
    }

    this.cancel(request.id);
    const pending: PendingUi = {
      rpcId: request.id,
      request: request,
      controller: new AbortController(),
      timedOut: false,
    };
    this.#pendingByRpcId.set(pending.rpcId, pending);
    const timeout = this.#timeoutFor(request);
    if (timeout != null) {
      pending.timer = setTimeout(() => {
        pending.timedOut = true;
        this.cancel(pending.rpcId);
      }, timeout);
      pending.timer.unref?.();
    }
    void this.#present(pending, target);
  }

  cancel(rpcId: string): void {
    const pending = this.#pendingByRpcId.get(rpcId);
    if (!pending || !this.#pendingByRpcId.delete(rpcId)) return;
    clearTimeout(pending.timer);
    pending.controller.abort();
    this.#sendCancelled(pending);
  }

  shutdown(): void {
    for (const rpcId of [...this.#pendingByRpcId.keys()]) this.cancel(rpcId);
  }

  async #present(pending: PendingUi, target: RpcGatewayUiTarget): Promise<void> {
    try {
      const response = await this.#options.delivery.presentUi(
        target.address,
        this.#toGatewayRequest(pending.request),
        target.deliveryContext,
        pending.controller.signal,
      );
      if (!this.#pendingByRpcId.delete(pending.rpcId)) return;
      clearTimeout(pending.timer);
      this.#sendResponse(pending.request, response);
    } catch (error) {
      if (!this.#pendingByRpcId.delete(pending.rpcId)) return;
      clearTimeout(pending.timer);
      if (pending.controller.signal.aborted) return;
      this.#options.log.warn(`[gateway rpc] UI ${pending.request.method} failed: ${error instanceof Error ? error.message : String(error)}`);
      this.#sendCancelled(pending);
    }
  }

  #toGatewayRequest(request: Exclude<RpcExtensionUiRequest, { method: "cancel" }>): UiRequest {
    switch (request.method) {
      case "select":
        return {
          type: "select",
          title: request.title,
          options: request.options.map((value, index) => {
            const description = request.optionDetails?.[index]?.description;
            return { value, label: value, ...(description ? { description } : {}) };
          }),
        };
      case "confirm":
        return { type: "confirm", title: request.title, message: request.message };
      case "input":
        return {
          type: "input",
          title: request.title,
          ...(request.placeholder ? { prompt: request.placeholder, placeholder: request.placeholder } : {}),
        };
      case "editor":
        return { type: "editor", title: request.title, initialValue: request.prefill ?? "" };
      case "notify":
        return { type: "notify", message: request.message, ...(request.notifyType ? { level: request.notifyType } : {}) };
      case "setStatus":
        return { type: "status", key: request.statusKey, ...(request.statusText ? { text: request.statusText } : {}) };
      case "setWidget":
        return {
          type: "widget",
          key: request.widgetKey,
          ...(request.widgetLines ? { lines: request.widgetLines } : {}),
          ...(request.widgetPlacement ? { placement: request.widgetPlacement } : {}),
        };
      case "setTitle":
        return { type: "title", title: request.title };
      case "set_editor_text":
        return { type: "editor_text", text: request.text };
      case "open_url":
        return { type: "open_url", url: request.launchUrl ?? request.url, ...(request.instructions ? { label: request.instructions } : {}) };
    }
  }

  #sendResponse(request: RpcExtensionUiRequest, response: UiResponse): void {
    switch (request.method) {
      case "select":
        if (response.type === "select") this.#options.sendResponse({ type: "extension_ui_response", id: request.id, value: response.selected[0] ?? "" });
        return;
      case "confirm":
        if (response.type === "confirm") this.#options.sendResponse({ type: "extension_ui_response", id: request.id, confirmed: response.confirmed });
        return;
      case "input":
      case "editor":
        if (response.type === request.method) {
          if (response.cancelled) this.#options.sendResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
          else this.#options.sendResponse({ type: "extension_ui_response", id: request.id, value: response.value });
        }
        return;
      default:
        return;
    }
  }

  #sendCancelled(pending: PendingUi): void {
    if (pending.request.method === "select" || pending.request.method === "confirm" || pending.request.method === "input" || pending.request.method === "editor") {
      this.#options.sendResponse({
        type: "extension_ui_response",
        id: pending.rpcId,
        cancelled: true,
        ...(pending.timedOut ? { timedOut: true } : {}),
      });
    }
  }

  #rememberDisplayState(request: Exclude<RpcExtensionUiRequest, { method: "cancel" }>): void {
    if (request.method === "setStatus") {
      if (request.statusText) this.#statuses[request.statusKey] = request.statusText;
      else delete this.#statuses[request.statusKey];
    } else if (request.method === "setWidget") {
      if (request.widgetLines) this.#widgets[request.widgetKey] = request.widgetLines;
      else delete this.#widgets[request.widgetKey];
    } else if (request.method === "setTitle") this.#title = request.title;
    else if (request.method === "set_editor_text") this.#editorText = request.text;
  }

  #timeoutFor(request: Exclude<RpcExtensionUiRequest, { method: "cancel" }>): number | undefined {
    return "timeout" in request && typeof request.timeout === "number" && request.timeout > 0 ? request.timeout : undefined;
  }

  #logMissingTarget(request: Exclude<RpcExtensionUiRequest, { method: "cancel" }>): void {
    if (
      request.method === "setStatus"
      || request.method === "setWidget"
      || request.method === "setTitle"
      || request.method === "set_editor_text"
    ) return;
    this.#options.log.warn(`[gateway rpc] Cannot present ${request.method}: no active delivery context`);
    if (request.method === "select" || request.method === "confirm" || request.method === "input" || request.method === "editor") {
      this.#options.sendResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
    }
  }
}
