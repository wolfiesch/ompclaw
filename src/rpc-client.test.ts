import { afterEach, describe, expect, test } from "bun:test";
import { OmpRpcClient, type RpcCommandError } from "./rpc-client";

const clients: OmpRpcClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

function mockRpcScript(): string {
  return `
const readline = require("node:readline");
console.log(JSON.stringify({type:"ready",protocolVersion:1,supportedProtocolVersions:[1,2],maxFrameBytes:1048576,maxReassembledFrameBytes:1048576}));
const lines = readline.createInterface({input: process.stdin});
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "negotiate_protocol") {
    console.log(JSON.stringify({type:"response",id:command.id,command:command.type,success:true,data:{protocolVersion:2}}));
    return;
  }
  if (command.type === "fail") {
    console.log(JSON.stringify({type:"response",id:command.id,command:command.type,success:false,error:"expected failure",code:"TEST"}));
    return;
  }
  console.log(JSON.stringify({type:"agent_start"}));
  const response = {type:"response",id:command.id,command:command.type,success:true,data:{sessionId:"mock-session",isStreaming:false,isCompacting:false}};
  const bytes = Buffer.from(JSON.stringify(response));
  const split = Math.floor(bytes.length / 2);
  [bytes.subarray(0, split), bytes.subarray(split)].forEach((part, index) => console.log(JSON.stringify({type:"rpc_chunk",chunkId:"reply",index,count:2,byteLength:bytes.length,data:part.toString("base64")})));
});
`;
}

describe("OmpRpcClient", () => {
  test("negotiates protocol v2 and reassembles chunked responses", async () => {
    const client = new OmpRpcClient({ argv: [process.execPath, "-e", mockRpcScript()], cwd: process.cwd(), env: process.env });
    clients.push(client);
    client.onFrame(() => new Promise<void>(() => {}));
    await client.start();
    expect(client.protocolVersion).toBe(2);
    const response = await client.send({ type: "get_state" });
    expect(response.data).toMatchObject({ sessionId: "mock-session", isStreaming: false });
  });

  test("returns typed command errors", async () => {
    const client = new OmpRpcClient({ argv: [process.execPath, "-e", mockRpcScript()], cwd: process.cwd(), env: process.env });
    clients.push(client);
    await client.start();
    await expect(client.send({ type: "fail" })).rejects.toEqual(expect.objectContaining<RpcCommandError>({
      name: "RpcCommandError",
      message: "expected failure",
      command: "fail",
      code: "TEST",
    }));
  });
});
