import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { wsToMessageStream } from "./ws-stream.js";
import type { JsonRpcMessage } from "./types.js";
import type { WebSocket } from "ws";

class FakeWs extends EventEmitter {
  send(_text: string, cb: (err?: Error) => void): void {
    cb();
  }
  close(): void {
    this.emit("close");
  }
}

describe("wsToMessageStream", () => {
  it("uses id: null on synthetic parse-error frames (JSON-RPC spec)", async () => {
    const ws = new FakeWs() as unknown as WebSocket;
    const stream = wsToMessageStream(ws);
    const received: JsonRpcMessage[] = [];
    stream.onMessage((m) => received.push(m));

    (ws as unknown as EventEmitter).emit("message", Buffer.from("not-json"), false);

    expect(received).toHaveLength(1);
    const frame = received[0] as { id: unknown; error: { code: number } };
    expect(frame.id).toBeNull();
    expect(frame.error.code).toBe(-32700);
  });
});
