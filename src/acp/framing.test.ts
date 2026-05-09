import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { ndjsonStreamFromStdio } from "./framing.js";
import type { JsonRpcMessage } from "./types.js";

function makeStream() {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const stream = ndjsonStreamFromStdio(stdout, stdin);
  return { stdout, stdin, stream };
}

describe("ndjsonStreamFromStdio", () => {
  it("parses a single JSON-RPC line", async () => {
    const { stdout, stream } = makeStream();
    const received: JsonRpcMessage[] = [];
    stream.onMessage((m) => received.push(m));

    stdout.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
  });

  it("buffers partial lines until a newline arrives", async () => {
    const { stdout, stream } = makeStream();
    const received: JsonRpcMessage[] = [];
    stream.onMessage((m) => received.push(m));

    stdout.write('{"jsonrpc":"2.0",');
    await new Promise((r) => setImmediate(r));
    expect(received).toHaveLength(0);

    stdout.write('"id":2,"method":"pong"}\n');
    await new Promise((r) => setImmediate(r));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ id: 2, method: "pong" });
  });

  it("splits multiple messages on a single chunk", async () => {
    const { stdout, stream } = makeStream();
    const received: JsonRpcMessage[] = [];
    stream.onMessage((m) => received.push(m));

    stdout.write(
      '{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n',
    );
    await new Promise((r) => setImmediate(r));

    expect(received.map((m) => "method" in m && m.method)).toEqual(["a", "b"]);
  });

  it("ignores blank lines", async () => {
    const { stdout, stream } = makeStream();
    const received: JsonRpcMessage[] = [];
    stream.onMessage((m) => received.push(m));

    stdout.write('\n\n{"jsonrpc":"2.0","id":1,"method":"x"}\n\n');
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(1);
  });

  it("emits a parse-error message for malformed JSON", async () => {
    const { stdout, stream } = makeStream();
    const received: JsonRpcMessage[] = [];
    stream.onMessage((m) => received.push(m));

    stdout.write("not-json\n");
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      error: expect.objectContaining({ code: -32700 }),
    });
  });

  it("writes outbound messages with a trailing newline", async () => {
    const { stdin, stream } = makeStream();
    const writes: string[] = [];
    stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));

    await stream.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    await new Promise((r) => setImmediate(r));

    expect(writes.join("")).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
    );
  });

  it("notifies close handlers when stdout ends", async () => {
    const { stdout, stream } = makeStream();
    let closed = false;
    stream.onClose(() => {
      closed = true;
    });

    stdout.end();
    await new Promise((r) => setImmediate(r));

    expect(closed).toBe(true);
  });

  it("rejects send on a closed stream", async () => {
    const { stream } = makeStream();
    await stream.close();
    await expect(
      stream.send({ jsonrpc: "2.0", id: 1, method: "x" }),
    ).rejects.toThrow(/closed/);
  });
});
