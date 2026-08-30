import { beforeEach, describe, expect, test } from "bun:test";
import type {
  ConversationAddress,
  DeliveryContext,
  UiRequest,
  UiResponse,
  UiResponseFor,
} from "./gateway-types";
import type { GatewayDelivery } from "./gateway-tools";
import type { RpcExtensionUiResponse } from "./rpc-protocol";
import { RpcGatewayUiBroker } from "./rpc-ui";

interface Presentation {
  readonly address: ConversationAddress;
  readonly context: DeliveryContext;
  readonly request: UiRequest;
  readonly signal?: AbortSignal;
}

let presentations: Presentation[];
let responses: RpcExtensionUiResponse[];
let present: <Request extends UiRequest>(request: Request, signal?: AbortSignal) => Promise<UiResponseFor<Request>>;

const address: ConversationAddress = { transport: "test", account: "account", channel: "channel" };
const deliveryContext: DeliveryContext = {
  principal: { id: "operator", roles: ["owner"] },
  origin: address,
};

beforeEach(() => {
  presentations = [];
  responses = [];
  present = async <Request extends UiRequest>(request: Request): Promise<UiResponseFor<Request>> => {
    const responseByType: Record<UiRequest["type"], UiResponse> = {
      confirm: { type: "confirm", confirmed: true },
      select: { type: "select", selected: ["one"] },
      input: { type: "input", cancelled: false, value: "typed" },
      editor: { type: "editor", cancelled: false, value: "edited" },
      notify: { type: "notify", acknowledged: true },
      open_url: { type: "open_url", opened: true },
      status: { type: "status", acknowledged: true },
      widget: { type: "widget", acknowledged: true },
      title: { type: "title", acknowledged: true },
      editor_text: { type: "editor_text", acknowledged: true },
    };
    return responseByType[request.type] as UiResponseFor<Request>;
  };
});

function broker(hasTarget = true, warnings: string[] = []): RpcGatewayUiBroker {
  const delivery: GatewayDelivery = {
    send: async () => ({ transport: "test", messageId: "send" }),
    update: async (_address, receipt) => receipt,
    react: async () => {},
    presentUi: async <Request extends UiRequest>(
      requestedAddress: ConversationAddress,
      request: Request,
      context: DeliveryContext,
      signal?: AbortSignal,
    ): Promise<UiResponseFor<Request>> => {
      presentations.push({ address: requestedAddress, context, request, signal });
      return present(request, signal);
    },
  };
  return new RpcGatewayUiBroker({
    delivery,
    sendResponse: (response) => responses.push(response),
    getTarget: () => hasTarget ? { address, deliveryContext } : undefined,
    log: { warn: (message) => warnings.push(message) },
  });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("RpcGatewayUiBroker", () => {
  test("converts interactive RPC UI requests and responses through the active delivery context", async () => {
    const ui = broker();

    await ui.handle({ type: "extension_ui_request", id: "select", method: "select", title: "Choose", options: ["one", "two"], optionDetails: [{ description: "first" }] });
    await ui.handle({ type: "extension_ui_request", id: "confirm", method: "confirm", title: "Continue", message: "Proceed?" });
    await ui.handle({ type: "extension_ui_request", id: "input", method: "input", title: "Value", placeholder: "Type it" });
    await ui.handle({ type: "extension_ui_request", id: "editor", method: "editor", title: "Edit", prefill: "before" });
    await settle();

    expect(presentations.map((presentation) => presentation.request)).toEqual([
      { type: "select", title: "Choose", options: [{ value: "one", label: "one", description: "first" }, { value: "two", label: "two" }] },
      { type: "confirm", title: "Continue", message: "Proceed?" },
      { type: "input", title: "Value", prompt: "Type it", placeholder: "Type it" },
      { type: "editor", title: "Edit", initialValue: "before" },
    ]);
    expect(presentations.every((presentation) => presentation.address === address && presentation.context === deliveryContext)).toBe(true);
    expect(responses).toEqual([
      { type: "extension_ui_response", id: "select", value: "one" },
      { type: "extension_ui_response", id: "confirm", confirmed: true },
      { type: "extension_ui_response", id: "input", value: "typed" },
      { type: "extension_ui_response", id: "editor", value: "edited" },
    ]);
  });

  test("converts every display RPC UI method to a typed gateway UI request", async () => {
    const ui = broker();

    await ui.handle({ type: "extension_ui_request", id: "notify", method: "notify", message: "Saved", notifyType: "warning" });
    await ui.handle({ type: "extension_ui_request", id: "status", method: "setStatus", statusKey: "mode", statusText: "working" });
    await ui.handle({ type: "extension_ui_request", id: "widget", method: "setWidget", widgetKey: "queue", widgetLines: ["one", "two"], widgetPlacement: "belowEditor" });
    await ui.handle({ type: "extension_ui_request", id: "title", method: "setTitle", title: "Focused" });
    await ui.handle({ type: "extension_ui_request", id: "editor-text", method: "set_editor_text", text: "suggestion" });
    await ui.handle({ type: "extension_ui_request", id: "open", method: "open_url", url: "https://example.test", launchUrl: "https://secure.example.test", instructions: "Authenticate" });
    await settle();

    expect(presentations.map((presentation) => presentation.request)).toEqual([
      { type: "notify", message: "Saved", level: "warning" },
      { type: "status", key: "mode", text: "working" },
      { type: "widget", key: "queue", lines: ["one", "two"], placement: "belowEditor" },
      { type: "title", title: "Focused" },
      { type: "editor_text", text: "suggestion" },
      { type: "open_url", url: "https://secure.example.test", label: "Authenticate" },
    ]);
    expect(ui.statusText()).toContain("Surface: Focused\nmode: working\nqueue: one | two\nSuggested input: suggestion");
    expect(responses).toEqual([]);
  });

  test("cancels an in-flight presentation and reports RPC cancellation", async () => {
    const ui = broker();
    const started = Promise.withResolvers<void>();
    let presentationSignal: AbortSignal | undefined;
    present = async <Request extends UiRequest>(_request: Request, signal?: AbortSignal): Promise<UiResponseFor<Request>> => {
      presentationSignal = signal;
      started.resolve();
      return await new Promise<UiResponseFor<Request>>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };

    await ui.handle({ type: "extension_ui_request", id: "pending", method: "input", title: "Input" });
    await started.promise;
    await ui.handle({ type: "extension_ui_request", id: "cancel", method: "cancel", targetId: "pending" });
    await settle();

    expect(presentationSignal?.aborted).toBe(true);
    expect(responses).toEqual([{ type: "extension_ui_response", id: "pending", cancelled: true }]);
  });
  test("retains display state quietly and cancels interactive requests without an active delivery", async () => {
    const warnings: string[] = [];
    const ui = broker(false, warnings);

    await ui.handle({ type: "extension_ui_request", id: "widget", method: "setWidget", widgetKey: "queue", widgetLines: ["one"] });
    await ui.handle({ type: "extension_ui_request", id: "confirm", method: "confirm", title: "Continue", message: "Proceed?" });
    await ui.handle({ type: "extension_ui_request", id: "notify", method: "notify", message: "Saved" });

    expect(ui.statusText()).toContain("queue: one");
    expect(responses).toEqual([{ type: "extension_ui_response", id: "confirm", cancelled: true }]);
    expect(warnings).toEqual([
      "[gateway rpc] Cannot present confirm: no active delivery context",
      "[gateway rpc] Cannot present notify: no active delivery context",
    ]);
  });

});
