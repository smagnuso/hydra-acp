import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { ResilientWsStream } from "./resilient-ws.js";
import type { JsonRpcMessage } from "../acp/types.js";

interface ServerHandle {
  wss: WebSocketServer;
  port: number;
  connections: WebSocket[];
  close(): Promise<void>;
}

async function startServer(): Promise<ServerHandle> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    const connections: WebSocket[] = [];
    wss.on("connection", (ws) => {
      connections.push(ws);
    });
    wss.on("listening", () => {
      const addr = wss.address() as AddressInfo;
      resolve({
        wss,
        port: addr.port,
        connections,
        close: () =>
          new Promise<void>((r) => {
            for (const ws of connections) {
              try {
                ws.terminate();
              } catch {
                void 0;
              }
            }
            wss.close(() => r());
          }),
      });
    });
  });
}

describe("ResilientWsStream", () => {
  let server: ServerHandle;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it("connects on start and forwards messages bidirectionally", async () => {
    const stream = new ResilientWsStream({
      url: `ws://127.0.0.1:${server.port}`,
      subprotocols: [],
      log: () => undefined,
    });

    const received: JsonRpcMessage[] = [];
    stream.onMessage((m) => received.push(m));

    await stream.start();
    expect(server.connections).toHaveLength(1);

    server.connections[0]!.send(
      JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);

    await stream.send({ jsonrpc: "2.0", id: 1, method: "echo" });
    const wireFromClient: string[] = [];
    server.connections[0]!.on("message", (data) =>
      wireFromClient.push(data.toString("utf8")),
    );
    await stream.send({ jsonrpc: "2.0", id: 2, method: "second" });
    await new Promise((r) => setTimeout(r, 50));
    expect(
      wireFromClient.some((line) => line.includes("second")),
    ).toBe(true);

    await stream.close();
  });

  it("queues outbound messages sent before connect and flushes them on connect", async () => {
    const messages: string[] = [];
    server.wss.on("connection", (ws) => {
      ws.on("message", (data) => messages.push(data.toString("utf8")));
    });

    const stream = new ResilientWsStream({
      url: `ws://127.0.0.1:${server.port}`,
      subprotocols: [],
      log: () => undefined,
    });

    await stream.send({ jsonrpc: "2.0", id: 1, method: "queued1" });
    await stream.send({ jsonrpc: "2.0", id: 2, method: "queued2" });

    await stream.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("queued1");
    expect(messages[1]).toContain("queued2");

    await stream.close();
  });

  it("invokes onConnect with firstConnect=false on a reconnect", async () => {
    const calls: boolean[] = [];
    const stream = new ResilientWsStream({
      url: `ws://127.0.0.1:${server.port}`,
      subprotocols: [],
      log: () => undefined,
      onConnect: (firstConnect) => {
        calls.push(firstConnect);
      },
    });
    await stream.start();
    expect(calls).toEqual([true]);

    server.connections[0]!.terminate();
    await new Promise((r) => setTimeout(r, 600));
    expect(calls).toEqual([true, false]);

    await stream.close();
  });

  it("holds back routine send() until onConnect awaits a request response", async () => {
    // Server: respond to "session/attach" requests after a 200ms delay,
    // and record the order frames are received. Any other request gets
    // an immediate response.
    const wireOrder: string[] = [];
    server.wss.on("connection", (ws) => {
      ws.on("message", async (data) => {
        const msg = JSON.parse(data.toString("utf8")) as {
          id?: number | string;
          method?: string;
        };
        if (msg.method !== undefined) {
          wireOrder.push(msg.method);
        }
        if (msg.method === "session/attach") {
          await new Promise((r) => setTimeout(r, 200));
          ws.send(
            JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }),
          );
        }
      });
    });

    const stream = new ResilientWsStream({
      url: `ws://127.0.0.1:${server.port}`,
      subprotocols: [],
      log: () => undefined,
      onConnect: async (firstConnect) => {
        if (firstConnect) {
          return;
        }
        // Mimics replayAttach: send + await response on a single request.
        await stream.request({
          jsonrpc: "2.0",
          id: "resume-1",
          method: "session/attach",
          params: {},
        });
      },
    });
    await stream.start();
    expect(wireOrder).toEqual([]);

    // Drop the server connection to trigger reconnect; while onConnect is
    // running we'll fire a routine send() that should be held until the
    // gate releases.
    server.connections[0]!.terminate();
    await new Promise((r) => setTimeout(r, 50));
    // After reconnect WS opens but before onConnect resolves, send a
    // session/prompt. The gate should queue it; it must hit the wire
    // AFTER the attach response is observed.
    void stream.send({
      jsonrpc: "2.0",
      id: 7,
      method: "session/prompt",
      params: {},
    });
    await new Promise((r) => setTimeout(r, 600));

    // After both have travelled the wire the order must be attach then prompt.
    const idxAttach = wireOrder.indexOf("session/attach");
    const idxPrompt = wireOrder.indexOf("session/prompt");
    expect(idxAttach).toBeGreaterThanOrEqual(0);
    expect(idxPrompt).toBeGreaterThan(idxAttach);

    await stream.close();
  });
});
