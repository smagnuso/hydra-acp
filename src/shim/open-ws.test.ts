import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { openWs, WsConnectTimeoutError } from "./open-ws.js";

describe("openWs connect timeout", () => {
  let server: Server;
  let port: number;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      server = createServer((socket) => {
        // Accept the TCP connection but never speak HTTP — simulates a
        // daemon that opened the socket but never completes the upgrade.
        sockets.push(socket);
      });
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    for (const s of sockets) {
      s.destroy();
    }
    sockets.length = 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects with WsConnectTimeoutError when handshake never completes", async () => {
    const timeoutMs = 150;
    const start = Date.now();
    await expect(
      openWs(`ws://127.0.0.1:${port}`, [], timeoutMs),
    ).rejects.toBeInstanceOf(WsConnectTimeoutError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 20);
    expect(elapsed).toBeLessThan(timeoutMs + 2_000);
  });

  it("includes url and elapsed ms on the error", async () => {
    const url = `ws://127.0.0.1:${port}`;
    try {
      await openWs(url, [], 100);
      throw new Error("expected timeout");
    } catch (err) {
      expect(err).toBeInstanceOf(WsConnectTimeoutError);
      const e = err as WsConnectTimeoutError;
      expect(e.url).toBe(url);
      expect(e.elapsedMs).toBeGreaterThanOrEqual(80);
    }
  });
});
