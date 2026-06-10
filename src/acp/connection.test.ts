import { describe, it, expect, vi } from "vitest";
import { JsonRpcConnection, ConnectionClosedError } from "./connection.js";
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

  it("falls through to setDefaultHandler when no specific method is registered", async () => {
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    const seen: Array<{ params: unknown; method: string }> = [];
    conn.setDefaultHandler(async (params, method) => {
      seen.push({ params, method });
      return { handled: method };
    });

    stream.emitMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "session/something_new",
      params: { sessionId: "x" },
    });
    await new Promise((r) => setImmediate(r));

    expect(seen).toEqual([
      { params: { sessionId: "x" }, method: "session/something_new" },
    ]);
    expect(stream.sent[0]).toMatchObject({
      id: 5,
      result: { handled: "session/something_new" },
    });
  });

  it("specific handler wins over default handler", async () => {
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    const defaultSpy = vi.fn();
    conn.setDefaultHandler(defaultSpy);
    conn.onRequest("ping", async () => ({ pong: true }));

    stream.emitMessage({ jsonrpc: "2.0", id: 1, method: "ping" });
    await new Promise((r) => setImmediate(r));

    expect(defaultSpy).not.toHaveBeenCalled();
    expect(stream.sent[0]).toMatchObject({ id: 1, result: { pong: true } });
  });

  it("notifies onClose handlers", () => {
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    const closeHandler = vi.fn();
    conn.onClose(closeHandler);

    stream.emitClose();

    expect(closeHandler).toHaveBeenCalled();
  });

  it("buffers notifications that arrive before onNotification subscribes", () => {
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);

    stream.emitMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: { tag: "early-1" },
    });
    stream.emitMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: { tag: "early-2" },
    });

    const handler = vi.fn();
    conn.onNotification("session/update", handler);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(
      1,
      { tag: "early-1" },
      "session/update",
    );
    expect(handler).toHaveBeenNthCalledWith(
      2,
      { tag: "early-2" },
      "session/update",
    );

    // Subsequent notifications go directly to the handler, not the buffer.
    stream.emitMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: { tag: "live" },
    });
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenLastCalledWith({ tag: "live" }, "session/update");
  });

  it("caps the per-method buffer so a chatty pre-subscribe sender can't OOM us", () => {
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);

    for (let i = 0; i < 100; i++) {
      stream.emitMessage({
        jsonrpc: "2.0",
        method: "x/spam",
        params: { i },
      });
    }
    const handler = vi.fn();
    conn.onNotification("x/spam", handler);

    expect(handler).toHaveBeenCalledTimes(64);
    // We keep the most-recent 64; the oldest 36 were evicted.
    expect(handler).toHaveBeenNthCalledWith(1, { i: 36 }, "x/spam");
    expect(handler).toHaveBeenLastCalledWith({ i: 99 }, "x/spam");
  });

  it("surfaces an error frame with an unknown id to orphan-error observers", async () => {
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    const orphan = vi.fn();
    conn.onOrphanError(orphan);

    // No pending request with id "nope" — this is a reply to an id-less
    // notification (e.g. session/cancel) that some agents answer with an
    // error frame.
    stream.emitMessage({
      jsonrpc: "2.0",
      id: "nope",
      error: { code: JsonRpcErrorCodes.MethodNotFound, message: "unsupported" },
    });
    await new Promise((r) => setImmediate(r));

    expect(orphan).toHaveBeenCalledWith({
      code: JsonRpcErrorCodes.MethodNotFound,
      message: "unsupported",
      data: undefined,
    });
  });

  it("throws ConnectionClosedError from requestWithId after close (no fake id sentinel)", async () => {
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    await conn.close();
    await expect(conn.request("ping")).rejects.toBeInstanceOf(
      ConnectionClosedError,
    );
  });

  it("routes a parse-error response (id=null) to orphan-error observers", async () => {
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    const orphan = vi.fn();
    conn.onOrphanError(orphan);

    stream.emitMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    } as unknown as JsonRpcRequest);
    await new Promise((r) => setImmediate(r));

    expect(orphan).toHaveBeenCalledWith({
      code: -32700,
      message: "parse error",
      data: undefined,
    });
  });

  it("surfaces an error frame with no id at all to orphan-error observers", async () => {
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    const orphan = vi.fn();
    conn.onOrphanError(orphan);

    stream.emitMessage({
      jsonrpc: "2.0",
      error: { code: -32601, message: "method not found" },
    } as unknown as JsonRpcRequest);
    await new Promise((r) => setImmediate(r));

    expect(orphan).toHaveBeenCalledWith({
      code: -32601,
      message: "method not found",
      data: undefined,
    });
  });
});
