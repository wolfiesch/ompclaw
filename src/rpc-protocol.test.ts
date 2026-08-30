import { describe, expect, test } from "bun:test";
import { RpcFrameDecoder, finalAssistantText } from "./rpc-protocol";

function chunks(value: unknown, split: number): Array<Record<string, unknown>> {
  const bytes = Buffer.from(JSON.stringify(value));
  const parts = [bytes.subarray(0, split), bytes.subarray(split)];
  return parts.map((part, index) => ({
    type: "rpc_chunk",
    chunkId: "sequence",
    index,
    count: parts.length,
    byteLength: bytes.byteLength,
    data: part.toString("base64"),
  }));
}

describe("RpcFrameDecoder", () => {
  test("passes ordinary frames through and reassembles UTF-8 chunks", () => {
    const decoder = new RpcFrameDecoder();
    const ordinary = { type: "response", success: true };
    expect(decoder.push(ordinary)).toEqual(ordinary);

    const frame = { type: "message_update", text: "hello π Telegram" };
    const encoded = chunks(frame, 17);
    expect(decoder.push(encoded[0])).toBeUndefined();
    expect(decoder.push(encoded[1])).toEqual(frame);
  });

  test("rejects out-of-order, interrupted, malformed, and oversized sequences", () => {
    const frame = { type: "response", data: "large payload" };
    const encoded = chunks(frame, 10);

    expect(() => new RpcFrameDecoder().push(encoded[1])).toThrow("index 0");
    const interrupted = new RpcFrameDecoder();
    interrupted.push(encoded[0]);
    expect(() => interrupted.push({ type: "notice" })).toThrow("interrupted");

    const malformed = { ...encoded[0], data: "not-base64" };
    expect(() => new RpcFrameDecoder().push(malformed)).toThrow("base64");
    expect(() => new RpcFrameDecoder(2).push(encoded[0])).toThrow("metadata");
  });
});

test("finalAssistantText returns the last visible assistant text", () => {
  expect(
    finalAssistantText([
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "toolResult", content: "ignored" },
      { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "final" }] },
    ]),
  ).toBe("final");
});
