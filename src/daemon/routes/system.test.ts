import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerSystemRoutes } from "./system.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("POST /v1/daemon/shutdown", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  // The real daemon sets authIdentity in its bearer hook; a header stands in.
  function build(requestShutdown?: () => void): FastifyInstance {
    const instance = Fastify();
    instance.addHook("onRequest", async (request) => {
      const id = request.headers["x-identity"];
      request.authIdentity = typeof id === "string" ? id : undefined;
    });
    registerSystemRoutes(instance, "2026-01-01T00:00:00Z", requestShutdown);
    app = instance;
    return instance;
  }

  const post = (instance: FastifyInstance, identity?: string) =>
    instance.inject({
      method: "POST",
      url: "/v1/daemon/shutdown",
      headers: identity === undefined ? {} : { "x-identity": identity },
    });

  it("accepts the service token, replies 202, then starts the shutdown", async () => {
    let called = 0;
    const instance = build(() => {
      called += 1;
    });
    const res = await post(instance, "service");
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "shutting-down" });
    // After the reply, not before: shutdown closes the HTTP server.
    expect(called).toBe(0);
    await sleep(150);
    expect(called).toBe(1);
  });

  it("refuses a session token and does not shut down", async () => {
    let called = 0;
    const instance = build(() => {
      called += 1;
    });
    const res = await post(instance, "session-record-1");
    expect(res.statusCode).toBe(403);
    await sleep(150);
    expect(called).toBe(0);
  });

  it("refuses a script token", async () => {
    let called = 0;
    const instance = build(() => {
      called += 1;
    });
    const res = await post(instance, "script:abc");
    expect(res.statusCode).toBe(403);
    await sleep(150);
    expect(called).toBe(0);
  });

  it("refuses a request with no identity", async () => {
    const instance = build(() => undefined);
    expect((await post(instance)).statusCode).toBe(403);
  });

  it("reports 501 for a daemon embedded in another process", async () => {
    const instance = build();
    const res = await post(instance, "service");
    expect(res.statusCode).toBe(501);
  });

  it("leaves GET /v1/system working", async () => {
    const instance = build();
    const res = await instance.inject({ method: "GET", url: "/v1/system" });
    expect(res.statusCode).toBe(200);
  });
});
