import { describe, expect, test } from "bun:test";
import type {
  ConversationAddress,
  DeliveryContext,
  OutboundContent,
  OutboundReceipt,
  UiRequest,
  UiResponse,
  UiResponseFor,
} from "./gateway-types";
import {
  executeGatewayHostTool,
  gatewayHostToolDefinitions,
  type GatewayDelivery,
  type GatewayHostToolContext,
} from "./gateway-tools";
import type { RpcHostToolCall } from "./rpc-protocol";
import type { GatewayAutomationControl } from "./gateway-scheduler";

const address: ConversationAddress = {
  transport: "test",
  account: "account-1",
  channel: "channel-1",
  thread: "thread-1",
};
const deliveryContext: DeliveryContext = {
  principal: { id: "principal-1", roles: ["operator"] },
  origin: address,
};
const sentReceipt: OutboundReceipt = { transport: "test", messageId: "outbound-1" };
const identity = { transport: "test", account: "account-1", subject: "operator-1" } as const;

interface DeliveryInvocation {
  readonly method: "send" | "react" | "presentUi";
  readonly address: ConversationAddress;
  readonly context: DeliveryContext;
  readonly signal: AbortSignal | undefined;
  readonly content?: OutboundContent;
  readonly receipt?: OutboundReceipt;
  readonly reaction?: { readonly emoji: string };
  readonly request?: UiRequest;
}

function hostToolCall(toolName: string, arguments_: unknown): RpcHostToolCall {
  return {
    type: "host_tool_call",
    id: "call-1",
    toolCallId: "tool-call-1",
    toolName,
    arguments: arguments_ as RpcHostToolCall["arguments"],
  };
}

function harness(initialUiResponse: UiResponse = { type: "input", cancelled: false, value: "typed answer" }, automation?: GatewayAutomationControl): {
  readonly context: GatewayHostToolContext;
  readonly invocations: DeliveryInvocation[];
  setUiResponse(response: UiResponse): void;
} {
  const invocations: DeliveryInvocation[] = [];
  let uiResponse = initialUiResponse;
  const delivery: GatewayDelivery = {
    async send(callAddress, content, context, signal) {
      invocations.push({ method: "send", address: callAddress, content, context, signal });
      return sentReceipt;
    },
    async update(_callAddress, receipt, _content, _context, _signal) {
      return receipt;
    },
    async react(callAddress, receipt, reaction, context, signal) {
      invocations.push({ method: "react", address: callAddress, receipt, reaction, context, signal });
    },
    async presentUi<Request extends UiRequest>(callAddress: ConversationAddress, request: Request, context: DeliveryContext, signal?: AbortSignal): Promise<UiResponseFor<Request>> {
      invocations.push({ method: "presentUi", address: callAddress, request, context, signal });
      return uiResponse as UiResponseFor<Request>;
    },
  };
  return {
    context: { delivery, address, deliveryContext, identity, ...(automation === undefined ? {} : { automation }) },
    invocations,
    setUiResponse(response) {
      uiResponse = response;
    },
  };
}

function expectDeliveryContext(invocation: DeliveryInvocation, signal: AbortSignal): void {
  expect(invocation.address).toBe(address);
  expect(invocation.context).toBe(deliveryContext);
  expect(invocation.signal).toBe(signal);
}

describe("gateway host tools", () => {
  test("defines only the transport-neutral host tools without routing arguments", () => {
    const definitions = gatewayHostToolDefinitions();
    expect(definitions.map((definition) => definition.name)).toEqual(["ompclaw_send", "ompclaw_react", "ompclaw_ask"]);

    for (const definition of definitions) {
      const parameters = definition.parameters as { readonly properties: Record<string, unknown>; readonly additionalProperties: boolean };
      expect(parameters.additionalProperties).toBe(false);
      for (const routingArgument of ["address", "transport", "account", "channel", "thread", "destination", "chat_id"]) {
        expect(parameters.properties).not.toHaveProperty(routingArgument);
      }
    }
  });

  test("advertises automation tools only when durable scheduling is enabled", () => {
    expect(gatewayHostToolDefinitions(true).map((definition) => definition.name)).toEqual([
      "ompclaw_send",
      "ompclaw_react",
      "ompclaw_ask",
      "ompclaw_schedule_job",
      "ompclaw_update_job",
      "ompclaw_list_jobs",
      "ompclaw_set_job_enabled",
      "ompclaw_delete_job",
      "ompclaw_run_job",
    ]);
  });

  test("sends text and absolute local files as file URL attachments", async () => {
    const { context, invocations } = harness();
    const signal = new AbortController().signal;

    const result = await executeGatewayHostTool(
      hostToolCall("ompclaw_send", {
        text: "Sent from OMP",
        files: ["/tmp/quarterly report.txt", "/tmp/diagram.png"],
      }),
      context,
      signal,
    );

    expect(result).toEqual(sentReceipt);
    expect(invocations).toHaveLength(1);
    const invocation = invocations[0]!;
    expect(invocation).toMatchObject({
      method: "send",
      content: {
        text: "Sent from OMP",
        attachments: [
          { url: "file:///tmp/quarterly%20report.txt" },
          { url: "file:///tmp/diagram.png" },
        ],
      },
    });
    expectDeliveryContext(invocation, signal);
  });

  test("reacts through the active delivery context and returns a reaction receipt", async () => {
    const { context, invocations } = harness();
    const signal = new AbortController().signal;

    const result = await executeGatewayHostTool(
      hostToolCall("ompclaw_react", { message_id: "source-9", emoji: "👍" }),
      context,
      signal,
    );

    expect(result).toEqual({ reacted: true });
    expect(invocations).toHaveLength(1);
    const invocation = invocations[0]!;
    expect(invocation).toMatchObject({
      method: "react",
      receipt: { transport: "test", messageId: "source-9" },
      reaction: { emoji: "👍" },
    });
    expectDeliveryContext(invocation, signal);
  });

  test("maps free text, single-select, and multi-select UI responses", async () => {
    const { context, invocations, setUiResponse } = harness({ type: "input", cancelled: false, value: "free text" });
    const inputSignal = new AbortController().signal;

    await expect(
      executeGatewayHostTool(hostToolCall("ompclaw_ask", { question: "What should happen?" }), context, inputSignal),
    ).resolves.toEqual({ answer: "free text" });
    const inputInvocation = invocations.at(-1)!;
    expect(inputInvocation.request).toEqual({ type: "input", title: "OMP question", prompt: "What should happen?" });
    expectDeliveryContext(inputInvocation, inputSignal);

    setUiResponse({ type: "select", selected: ["Ship"] });
    const singleSignal = new AbortController().signal;
    await expect(
      executeGatewayHostTool(
        hostToolCall("ompclaw_ask", { title: "Release", question: "Choose one", options: ["Ship", "Hold"] }),
        context,
        singleSignal,
      ),
    ).resolves.toEqual({ answer: "Ship" });
    const singleInvocation = invocations.at(-1)!;
    expect(singleInvocation.request).toEqual({
      type: "select",
      title: "Release",
      options: [
        { value: "Ship", label: "Ship" },
        { value: "Hold", label: "Hold" },
      ],
    });
    expectDeliveryContext(singleInvocation, singleSignal);

    setUiResponse({ type: "select", selected: ["Green", "Blue"] });
    const multiSignal = new AbortController().signal;
    await expect(
      executeGatewayHostTool(
        hostToolCall("ompclaw_ask", { question: "Choose any", options: ["Green", "Blue"], multi: true }),
        context,
        multiSignal,
      ),
    ).resolves.toEqual({ answer: ["Green", "Blue"] });
    const multiInvocation = invocations.at(-1)!;
    expect(multiInvocation.request).toEqual({
      type: "select",
      title: "OMP question",
      options: [
        { value: "Green", label: "Green" },
        { value: "Blue", label: "Blue" },
      ],
      multiSelect: true,
    });
    expectDeliveryContext(multiInvocation, multiSignal);
  });

  test("binds scheduled jobs to the server-derived principal, identity, and conversation", async () => {
    let capturedContext: Parameters<GatewayAutomationControl["create"]>[1] | undefined;
    const job = {
      id: "job-1",
      principalId: deliveryContext.principal.id,
      identity,
      address,
      name: "daily report",
      prompt: "Summarize work",
      schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" } as const,
      enabled: true,
      nextRunAt: Date.parse("2026-08-31T09:00:00Z"),
      attemptCount: 0,
      successCount: 0,
      failureCount: 0,
      createdAt: Date.parse("2026-08-30T12:00:00Z"),
      updatedAt: Date.parse("2026-08-30T12:00:00Z"),
    };
    const automation: GatewayAutomationControl = {
      create(_input, context) {
        capturedContext = context;
        return job;
      },
      update() {
        return job;
      },
      remove(id, principalId) {
        return id === job.id && principalId === deliveryContext.principal.id;
      },
      setEnabled() {
        return job;
      },
      runNow() {
        return job;
      },
      list(principalId) {
        return principalId === deliveryContext.principal.id ? [job] : [];
      },
    };
    const { context } = harness(undefined, automation);

    await expect(executeGatewayHostTool(
      hostToolCall("ompclaw_schedule_job", {
        name: "daily report",
        prompt: "Summarize work",
        cron: "0 9 * * *",
        timezone: "UTC",
      }),
      context,
    )).resolves.toEqual({ job: expect.stringContaining("daily report") });
    expect(capturedContext).toEqual({ principal: deliveryContext.principal, identity, address });
    await expect(executeGatewayHostTool(hostToolCall("ompclaw_list_jobs", {}), context)).resolves.toEqual({
      jobs: [expect.stringContaining("job-1")],
    });
    await expect(executeGatewayHostTool(hostToolCall("ompclaw_delete_job", { id: "job-1" }), context)).resolves.toEqual({ deleted: true });
  });

  test("rejects unknown and malformed arguments before invoking delivery", async () => {
    const { context, invocations } = harness();
    const malformedCalls = [
      hostToolCall("ompclaw_send", {}),
      hostToolCall("ompclaw_send", { text: "", files: ["/tmp/valid"] }),
      hostToolCall("ompclaw_send", { files: ["relative.txt"] }),
      hostToolCall("ompclaw_send", { text: "hello", channel: "other-channel" }),
      hostToolCall("ompclaw_react", { message_id: 42, emoji: "👍" }),
      hostToolCall("ompclaw_react", { message_id: "source-1", emoji: "" }),
      hostToolCall("ompclaw_ask", { question: "Pick", options: [] }),
      hostToolCall("ompclaw_ask", { question: "Pick", multi: true }),
      hostToolCall("ompclaw_ask", { question: "Pick", account: "other-account" }),
      hostToolCall("unknown_tool", {}),
    ];

    for (const call of malformedCalls) {
      await expect(executeGatewayHostTool(call, context, new AbortController().signal)).rejects.toThrow();
    }
    expect(invocations).toEqual([]);
  });
});
