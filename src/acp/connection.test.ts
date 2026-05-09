import { describe, it, expect, vi } from "vitest";
import { JsonRpcConnection } from "./connection.js";
import { JsonRpcErrorCodes, type JsonRpcRequest } from "./types.js";
import { makeControlledStream } from "../__tests__/test-utils.js";

describe("JsonRpcConnection", () => {
  it("delivers a request to a registered handler and returns the result", async () => {
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    conn.onRequest("ping", async (params) => {
      return { echoed: params };
    });

    const incoming: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "r1",
      method: "ping",
      params: { hello: "world" },
    };
    stream.emitMessage(incoming);
    await new Promise((r) => setImmediate(r));

    expect(stream.sent).toHaveLength(1);
    expect(stream.sent[0]).toMatchObject({
      jsonrpc: "2.0",
      id: "r1",
      result: { echoed: { hello: "world" } },
    });

    void conn;
  });

  it("returns MethodNotFound for unknown methods", async () => {
    const stream = makeControlledStream();
    new JsonRpcConnection(stream);

    stream.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "no.such.method",
    });
    await new Promise((r) => setImmediate(r));

    expect(stream.sent[0]).toMatchObject({
      id: 1,
      error: { code: JsonRpcErrorCodes.MethodNotFound },
    });
  });

  it("propagates handler errors with their code", async () => {
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    conn.onRequest("boom", async () => {
      const err = new Error("kaboom") as Error & { code: number };
      err.code = -32099;
      throw err;
    });

    stream.emitMessage({ jsonrpc: "2.0", id: 1, method: "boom" });
    await new Promise((r) => setImmediate(r));

    expect(stream.sent[0]).toMatchObject({
      id: 1,
      error: { code: -32099, message: "kaboom" },
    });
  });

  it("resolves a pending request when the response arrives", async () => {
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);

    const promise = conn.request<{ ok: true }>("compute", { x: 1 });
    await new Promise((r) => setImmediate(r));

    expect(stream.sent).toHaveLength(1);
    const sent = stream.sent[0]!;
    expect(sent).toMatchObject({ method: "compute", params: { x: 1 } });

    stream.emitMessage({
      jsonrpc: "2.0",
      id: (sent as JsonRpcRequest).id,
      result: { ok: true },
    });

    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("rejects pending requests when the stream closes", async () => {
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    const promise = conn.request("x");
    stream.emitClose(new Error("link reset"));
    await expect(promise).rejects.toThrow(/link reset/);
  });

  it("delivers notifications to handlers", () => {
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    const handler = vi.fn();
    conn.onNotification("update", handler);

    stream.emitMessage({
      jsonrpc: "2.0",
      method: "update",
      params: { foo: 1 },
    });

    expect(handler).toHaveBeenCalledWith({ foo: 1 }, "update");
  });

  it("notifies onClose handlers", () => {
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    const closeHandler = vi.fn();
    conn.onClose(closeHandler);

    stream.emitClose();

    expect(closeHandler).toHaveBeenCalled();
  });
});
