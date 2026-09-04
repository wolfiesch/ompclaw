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
import type { GatewayUpdateControl } from "./gateway-update";

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

function harness(
  initialUiResponse: UiResponse = { type: "input", cancelled: false, value: "typed answer" },
  automation?: GatewayAutomationControl,
  updates?: GatewayUpdateControl,
): {
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
    context: {
      delivery,
      address,
      deliveryContext,
      identity,
      ...(automation === undefined ? {} : { automation }),
      ...(updates === undefined ? {} : { updates }),
    },
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
    expect(gatewayHostToolDefinitions({ automation: true }).map((definition) => definition.name)).toEqual([
      "ompclaw_send",
      "ompclaw_react",
      "ompclaw_ask",
      "ompclaw_schedule_job",
      "ompclaw_watch",
      "ompclaw_update_job",
      "ompclaw_list_jobs",
      "ompclaw_set_job_enabled",
      "ompclaw_delete_job",
      "ompclaw_run_job",
    ]);
  });

  test("advertises updates only when transactional updates are enabled", () => {
    expect(gatewayHostToolDefinitions({ updates: true }).map((definition) => definition.name)).toEqual([
      "ompclaw_send",
      "ompclaw_react",
      "ompclaw_ask",
      "ompclaw_stage_update",
      "ompclaw_activate_update",
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

  test("watch creates a job with watch: name prefix and requesting address context, validated schedule, and deletes via existing job tools", async () => {
    let capturedContext: Parameters<GatewayAutomationControl["create"]>[1] | undefined;
    let capturedInput: Parameters<GatewayAutomationControl["create"]>[0] | undefined;
    let deletedId: string | undefined;
    let deletedPrincipal: string | undefined;
    const watchJob = {
      id: "watch-job-42",
      principalId: deliveryContext.principal.id,
      identity,
      address,
      name: "watch: PR 100 CI",
      prompt: "Check CI status and alert if failing",
      schedule: { kind: "cron", expression: "*/5 * * * *" } as const,
      enabled: true,
      nextRunAt: Date.parse("2026-08-31T09:05:00Z"),
      attemptCount: 0,
      successCount: 0,
      failureCount: 0,
      createdAt: Date.parse("2026-08-31T09:00:00Z"),
      updatedAt: Date.parse("2026-08-31T09:00:00Z"),
    };
    const automation: GatewayAutomationControl = {
      create(input, context) {
        capturedInput = input;
        capturedContext = context;
        return { ...watchJob, name: input.name, prompt: input.prompt };
      },
      update() {
        return watchJob;
      },
      remove(id, principalId) {
        deletedId = id;
        deletedPrincipal = principalId;
        return id === watchJob.id && principalId === deliveryContext.principal.id;
      },
      setEnabled() {
        return watchJob;
      },
      runNow() {
        return watchJob;
      },
      list(principalId) {
        return principalId === deliveryContext.principal.id ? [watchJob] : [];
      },
    };
    const { context } = harness(undefined, automation);

    // 1. Create watch job with everyMinutes
    const result = await executeGatewayHostTool(
      hostToolCall("ompclaw_watch", {
        name: "PR 100 CI",
        prompt: "Check CI status and alert if failing",
        everyMinutes: 5,
      }),
      context,
    );
    expect(result).toEqual({
      id: "watch-job-42",
      name: "watch: PR 100 CI",
      job: expect.stringContaining("watch: PR 100 CI"),
    });
    expect(capturedInput).toEqual({
      name: "watch: PR 100 CI",
      prompt: "Check CI status and alert if failing",
      cron: "*/5 * * * *",
    });
    expect(capturedContext).toEqual({ principal: deliveryContext.principal, identity, address });

    // Also supports "watch" toolName alias
    const aliasResult = await executeGatewayHostTool(
      hostToolCall("watch", {
        name: "PR 100 CI",
        prompt: "Check CI status and alert if failing",
        everyMinutes: 5,
      }),
      context,
    );
    expect(aliasResult).toEqual({
      id: "watch-job-42",
      name: "watch: PR 100 CI",
      job: expect.stringContaining("watch: PR 100 CI"),
    });

    // Preserves existing "watch: " prefix without doubling
    await executeGatewayHostTool(
      hostToolCall("ompclaw_watch", {
        name: "watch: already prefixed",
        prompt: "Check thing",
        everyMinutes: 1,
      }),
      context,
    );
    expect(capturedInput?.name).toBe("watch: already prefixed");

    // Supports cron and timezone
    await executeGatewayHostTool(
      hostToolCall("ompclaw_watch", {
        name: "custom cron watch",
        prompt: "Nightly watch",
        cron: "0 2 * * *",
        timezone: "UTC",
      }),
      context,
    );
    expect(capturedInput).toEqual({
      name: "watch: custom cron watch",
      prompt: "Nightly watch",
      cron: "0 2 * * *",
      timezone: "UTC",
    });

    // Verify list and deletion via existing job tools
    await expect(executeGatewayHostTool(hostToolCall("ompclaw_list_jobs", {}), context)).resolves.toEqual({
      jobs: [expect.stringContaining("watch-job-42")],
    });
    await expect(
      executeGatewayHostTool(hostToolCall("ompclaw_delete_job", { id: "watch-job-42" }), context),
    ).resolves.toEqual({ deleted: true });
    expect(deletedId).toBe("watch-job-42");
    expect(deletedPrincipal).toBe(deliveryContext.principal.id);

    // Exclusivity validation errors: both or neither everyMinutes and cron
    await expect(
      executeGatewayHostTool(
        hostToolCall("ompclaw_watch", {
          name: "both",
          prompt: "check",
          everyMinutes: 5,
          cron: "*/5 * * * *",
        }),
        context,
      ),
    ).rejects.toThrow("Specify exactly one of everyMinutes or cron");

    await expect(
      executeGatewayHostTool(
        hostToolCall("ompclaw_watch", {
          name: "neither",
          prompt: "check",
        }),
        context,
      ),
    ).rejects.toThrow("Specify exactly one of everyMinutes or cron");

    // Invalid everyMinutes
    await expect(
      executeGatewayHostTool(
        hostToolCall("ompclaw_watch", { name: "test", prompt: "check", everyMinutes: 0 }),
        context,
      ),
    ).rejects.toThrow("everyMinutes must be a positive integer");

    await expect(
      executeGatewayHostTool(
        hostToolCall("ompclaw_watch", { name: "test", prompt: "check", everyMinutes: -3 }),
        context,
      ),
    ).rejects.toThrow("everyMinutes must be a positive integer");

    await expect(
      executeGatewayHostTool(
        hostToolCall("ompclaw_watch", { name: "test", prompt: "check", everyMinutes: 2.5 }),
        context,
      ),
    ).rejects.toThrow("everyMinutes must be a positive integer");

    await expect(
      executeGatewayHostTool(
        hostToolCall("ompclaw_watch", { name: "test", prompt: "check", everyMinutes: 90 }),
        context,
      ),
    ).rejects.toThrow("everyMinutes must be between 1 and 60");

    // Invalid cron
    await expect(
      executeGatewayHostTool(
        hostToolCall("ompclaw_watch", { name: "test", prompt: "check", cron: "not-a-cron-expression" }),
        context,
      ),
    ).rejects.toThrow("Invalid cron schedule");

    // Invalid name
    await expect(
      executeGatewayHostTool(
        hostToolCall("ompclaw_watch", { name: "", prompt: "check", everyMinutes: 5 }),
        context,
      ),
    ).rejects.toThrow("name must not be empty");

    await expect(
      executeGatewayHostTool(
        hostToolCall("ompclaw_watch", { name: "   ", prompt: "check", everyMinutes: 5 }),
        context,
      ),
    ).rejects.toThrow("name must not be empty");

    await expect(
      executeGatewayHostTool(
        hostToolCall("ompclaw_watch", { name: "a".repeat(120), prompt: "check", everyMinutes: 5 }),
        context,
      ),
    ).rejects.toThrow("name must be at most 113 characters");

    // Invalid prompt
    await expect(
      executeGatewayHostTool(
        hostToolCall("ompclaw_watch", { name: "valid", prompt: "", everyMinutes: 5 }),
        context,
      ),
    ).rejects.toThrow("prompt must not be empty");

    await expect(
      executeGatewayHostTool(
        hostToolCall("ompclaw_watch", { name: "valid", prompt: "   ", everyMinutes: 5 }),
        context,
      ),
    ).rejects.toThrow("prompt must not be empty");

    await expect(
      executeGatewayHostTool(
        hostToolCall("ompclaw_watch", { name: "valid", prompt: "a".repeat(16_001), everyMinutes: 5 }),
        context,
      ),
    ).rejects.toThrow("16000 characters");

    // Invalid timezone
    await expect(
      executeGatewayHostTool(
        hostToolCall("ompclaw_watch", { name: "valid", prompt: "check", cron: "0 * * * *", timezone: "Fake/Timezone" }),
        context,
      ),
    ).rejects.toThrow("Invalid IANA timezone");

    // Gating: automation disabled
    const { context: disabledContext } = harness();
    await expect(
      executeGatewayHostTool(
        hostToolCall("ompclaw_watch", { name: "test", prompt: "check", everyMinutes: 5 }),
        disabledContext,
      ),
    ).rejects.toThrow("OmpClaw automation is disabled");
  });

  test("stages and arms updates only for an authenticated operator", async () => {
    const calls: string[] = [];
    const updates: GatewayUpdateControl = {
      async stage(commit) {
        calls.push(`stage:${commit}`);
        return {
          release: {
            id: "0.8.0-0123456789ab",
            commit: "0123456789abcdef0123456789abcdef01234567",
            version: "0.8.0",
            path: "/state/releases/0.8.0-0123456789ab",
          },
          reused: false,
        };
      },
      async arm(releaseId, origin) {
        calls.push(`arm:${releaseId}:${origin.principal.id}:${origin.address.channel}`);
        return { update: "armed" };
      },
      async commitArmed() {},
      async discardArmed() {},
    };
    const { context } = harness(undefined, undefined, updates);

    await expect(executeGatewayHostTool(
      hostToolCall("ompclaw_stage_update", { commit: "0123456789abcdef0123456789abcdef01234567" }),
      context,
    )).resolves.toEqual({ release: "0.8.0-0123456789ab", reused: false });
    await expect(executeGatewayHostTool(
      hostToolCall("ompclaw_activate_update", { release_id: "0.8.0-0123456789ab" }),
      context,
    )).resolves.toEqual({ update: "armed" });
    expect(calls).toEqual([
      "stage:0123456789abcdef0123456789abcdef01234567",
      "arm:0.8.0-0123456789ab:principal-1:channel-1",
    ]);

    const nonOperator = {
      ...context,
      deliveryContext: {
        ...context.deliveryContext,
        principal: { id: "principal-2", roles: [] },
      },
    };
    await expect(executeGatewayHostTool(
      hostToolCall("ompclaw_activate_update", { release_id: "0.8.0-0123456789ab" }),
      nonOperator,
    )).rejects.toThrow("operator role");
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
