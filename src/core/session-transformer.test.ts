import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Session } from "./session.js";
import { HistoryStore } from "./history-store.js";
import { makeMockAgent, makeControlledStream } from "../__tests__/test-utils.js";
import { JsonRpcConnection } from "../acp/connection.js";
import type { TransformerRef } from "./transformer-manager.js";
import type { AttachedClient } from "./session.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fakeTransformerConn(defaultResponse: unknown = { action: "continue" }) {
  const requests: Array<{ method: string; params: unknown }> = [];
  const notifications: Array<{ method: string; params: unknown }> = [];
  let response = defaultResponse;
  const conn = {
    request: vi.fn().mockImplementation(async (_m: string, p: unknown) => {
      requests.push({ method: _m, params: p });
      return response;
    }),
    notify: vi.fn().mockImplementation(async (method: string, params: unknown) => {
      notifications.push({ method, params });
    }),
    onRequest: vi.fn(),
    onNotification: vi.fn(),
    onClose: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as JsonRpcConnection;
  return {
    conn,
    requests,
    notifications,
    setResponse: (r: unknown) => { response = r; },
  };
}

function makeRef(
  name: string,
  intercepts: string[],
  conn: JsonRpcConnection,
): TransformerRef {
  return { name, intercepts: new Set(intercepts), connection: conn };
}

function makeClient(): { client: AttachedClient; stream: ReturnType<typeof makeControlledStream> } {
  const stream = makeControlledStream();
  const conn = new JsonRpcConnection(stream);
  return {
    client: { clientId: "c_test", connection: conn },
    stream,
  };
}

function makeSession(chain: TransformerRef[] = [], idleEventTimeoutMs = 0) {
  const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
  // Default: agent responds to session/prompt with end_turn
  const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
  requestMock.mockResolvedValue({ stopReason: "end_turn" });
  const session = new Session({
    sessionId: "sess_test",
    cwd: "/work",
    agentId: "mock",
    agent: mock.agent,
    upstreamSessionId: "u1",
    transformChain: chain,
    idleEventTimeoutMs,
    historyStore: new HistoryStore(),
  });
  return { session, mock, requestMock };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// ── forwardRequest — chain dispatch ──────────────────────────────────────────

describe("Session transformer chain — forwardRequest", () => {
  it("calls the agent directly when chain is empty", async () => {
    const { session, requestMock } = makeSession();
    await session.forwardRequest("session/prompt", { sessionId: "sess_test", prompt: [] });
    expect(requestMock).toHaveBeenCalledWith("session/prompt", expect.anything());
  });

  it("calls transformer/message for matching intercept then calls agent", async () => {
    const t = fakeTransformerConn({ action: "continue" });
    const { session, requestMock } = makeSession([
      makeRef("t1", ["request:session/prompt"], t.conn),
    ]);
    await session.forwardRequest("session/prompt", { sessionId: "sess_test", prompt: [] });
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]!.method).toBe("transformer/message");
    expect((t.requests[0]!.params as { phase: string }).phase).toBe("request");
    expect(requestMock).toHaveBeenCalledWith("session/prompt", expect.anything());
  });

  it("skips transformer that does not declare the intercept", async () => {
    const t = fakeTransformerConn();
    const { session, requestMock } = makeSession([
      makeRef("t1", ["response:session/update"], t.conn), // wrong intercept
    ]);
    await session.forwardRequest("session/prompt", { sessionId: "sess_test", prompt: [] });
    expect(t.requests).toHaveLength(0);
    expect(requestMock).toHaveBeenCalled();
  });

  it("stop action returns default payload without calling agent", async () => {
    const t = fakeTransformerConn({ action: "stop" });
    const { session, requestMock } = makeSession([
      makeRef("t1", ["request:session/prompt"], t.conn),
    ]);
    const result = await session.forwardRequest("session/prompt", { sessionId: "sess_test", prompt: [] });
    expect(result).toEqual({ stopReason: "stopped" });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("stop action with payload uses the transformer's payload", async () => {
    const t = fakeTransformerConn({ action: "stop", payload: { stopReason: "custom" } });
    const { session, requestMock } = makeSession([
      makeRef("t1", ["request:session/prompt"], t.conn),
    ]);
    const result = await session.forwardRequest("session/prompt", { sessionId: "sess_test", prompt: [] });
    expect(result).toEqual({ stopReason: "custom" });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("stop on non-prompt method returns empty object by default", async () => {
    const t = fakeTransformerConn({ action: "stop" });
    const { session } = makeSession([
      makeRef("t1", ["request:session/set_model"], t.conn),
    ]);
    const result = await session.forwardRequest("session/set_model", { sessionId: "sess_test" });
    expect(result).toEqual({});
  });

  it("fail-open: transformer error does not block the request", async () => {
    const t = fakeTransformerConn();
    (t.conn.request as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const { session, requestMock } = makeSession([
      makeRef("t1", ["request:session/prompt"], t.conn),
    ]);
    const result = await session.forwardRequest("session/prompt", { sessionId: "sess_test", prompt: [] });
    expect(result).toEqual({ stopReason: "end_turn" });
    expect(requestMock).toHaveBeenCalled();
  });

  it("chain walks all transformers in order", async () => {
    const order: string[] = [];
    function trackingConn(name: string) {
      const c = fakeTransformerConn({ action: "continue" });
      (c.conn.request as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        order.push(name);
        return { action: "continue" };
      });
      return c.conn;
    }
    const { session } = makeSession([
      makeRef("t1", ["request:session/prompt"], trackingConn("t1")),
      makeRef("t2", ["request:session/prompt"], trackingConn("t2")),
      makeRef("t3", ["request:session/prompt"], trackingConn("t3")),
    ]);
    await session.forwardRequest("session/prompt", { sessionId: "sess_test", prompt: [] });
    expect(order).toEqual(["t1", "t2", "t3"]);
  });

  it("stop from first transformer skips remaining transformers", async () => {
    const t1 = fakeTransformerConn({ action: "stop" });
    const t2 = fakeTransformerConn({ action: "continue" });
    const { session, requestMock } = makeSession([
      makeRef("t1", ["request:session/prompt"], t1.conn),
      makeRef("t2", ["request:session/prompt"], t2.conn),
    ]);
    await session.forwardRequest("session/prompt", { sessionId: "sess_test", prompt: [] });
    expect(t2.requests).toHaveLength(0);
    expect(requestMock).not.toHaveBeenCalled();
  });
});

// ── runResponseChain — via agent notification ─────────────────────────────────

describe("Session transformer chain — response side", () => {
  it("continue passes the update through to clients", async () => {
    const t = fakeTransformerConn({ action: "continue" });
    const { session, mock } = makeSession([
      makeRef("t1", ["response:session/update"], t.conn),
    ]);
    const { client, stream } = makeClient();
    await session.attach(client, "none");

    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: { sessionUpdate: "assistant_message_chunk", content: { type: "text", text: "hi" } },
    });
    await flushMicrotasks();

    expect(t.requests).toHaveLength(1);
    expect(stream.sent.some((m) => m.method === "session/update")).toBe(true);
  });

  it("stop drops the update — no broadcast to clients", async () => {
    const t = fakeTransformerConn({ action: "stop" });
    const { session, mock } = makeSession([
      makeRef("t1", ["response:session/update"], t.conn),
    ]);
    const { client, stream } = makeClient();
    await session.attach(client, "none");

    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: { sessionUpdate: "assistant_message_chunk", content: { type: "text", text: "hi" } },
    });
    await flushMicrotasks();

    expect(t.requests).toHaveLength(1);
    const updates = stream.sent.filter(
      (m) => m.method === "session/update" &&
        (m.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ===
          "assistant_message_chunk",
    );
    expect(updates).toHaveLength(0);
  });

  it("response chain skips transformers that don't declare response intercept", async () => {
    const t = fakeTransformerConn({ action: "continue" });
    const { session, mock } = makeSession([
      makeRef("t1", ["request:session/prompt"], t.conn), // wrong side
    ]);
    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: { sessionUpdate: "assistant_message_chunk", content: { type: "text", text: "x" } },
    });
    await flushMicrotasks();
    expect(t.requests).toHaveLength(0);
  });
});

// ── Response chain — additional coverage ──────────────────────────────────────

describe("Session transformer chain — response chain additional", () => {
  it("stop in response chain prevents subsequent transformers from being called", async () => {
    const t1 = fakeTransformerConn({ action: "stop" });
    const t2 = fakeTransformerConn({ action: "continue" });
    const { session, mock } = makeSession([
      makeRef("t1", ["response:session/update"], t1.conn),
      makeRef("t2", ["response:session/update"], t2.conn),
    ]);
    const { client } = makeClient();
    await session.attach(client, "none");
    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: { sessionUpdate: "assistant_message_chunk", content: { type: "text", text: "x" } },
    });
    await flushMicrotasks();
    expect(t1.requests).toHaveLength(1);
    expect(t2.requests).toHaveLength(0);
  });

  it("response-side processing parks a claim and discharge resolves it", async () => {
    let capturedToken = "";
    const t = fakeTransformerConn();
    (t.conn.request as ReturnType<typeof vi.fn>).mockImplementation(
      (_m: string, params: unknown) => {
        capturedToken = (params as { token: string }).token;
        return Promise.resolve({ action: "processing" });
      },
    );

    const { session, mock } = makeSession([
      makeRef("t1", ["response:session/update"], t.conn),
    ]);
    const { client, stream } = makeClient();
    await session.attach(client, "none");

    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: { sessionUpdate: "assistant_message_chunk", content: { type: "text", text: "x" } },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(capturedToken).toBeTruthy();

    // Before discharge: update not yet broadcast.
    const chunksBefore = stream.sent.filter(
      (m) => (m.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ===
        "assistant_message_chunk",
    );
    expect(chunksBefore).toHaveLength(0);

    // Discharge resolves the parked chain — snapshot interceptors and broadcast run.
    session.dischargeClaim(capturedToken, undefined);
    await flushMicrotasks();
  });

  it("emitToChain response side re-enters runResponseChain after the emitter", async () => {
    const t1 = fakeTransformerConn({ action: "continue" });
    const t2 = fakeTransformerConn({ action: "continue" });
    const { session } = makeSession([
      makeRef("t1", ["response:session/update"], t1.conn),
      makeRef("t2", ["response:session/update"], t2.conn),
    ]);
    const { client } = makeClient();
    await session.attach(client, "none");

    await session.emitToChain("t1", "session/update", {
      sessionId: "sess_test",
      update: { sessionUpdate: "assistant_message_chunk", content: { type: "text", text: "y" } },
    });
    await flushMicrotasks();

    // t1 emitted — skipped; t2 should receive the message.
    expect(t1.requests).toHaveLength(0);
    expect(t2.requests).toHaveLength(1);
  });
});

// ── Loop prevention + emitToChain ─────────────────────────────────────────────

describe("Session transformer chain — loop prevention", () => {
  it("emitToChain skips the emitting transformer itself", async () => {
    const t1 = fakeTransformerConn({ action: "continue" });
    const t2 = fakeTransformerConn({ action: "continue" });
    const { session, requestMock } = makeSession([
      makeRef("t1", ["request:session/prompt"], t1.conn),
      makeRef("t2", ["request:session/prompt"], t2.conn),
    ]);
    await session.emitToChain("t1", "session/prompt", { sessionId: "sess_test", prompt: [] });
    // t1 emitted — it should be skipped; t2 should be called
    expect(t1.requests).toHaveLength(0);
    expect(t2.requests).toHaveLength(1);
    expect(requestMock).toHaveBeenCalled();
  });

  it("emitToChain from last transformer in chain goes straight to agent", async () => {
    const t1 = fakeTransformerConn({ action: "continue" });
    const t2 = fakeTransformerConn({ action: "continue" });
    const { session, requestMock } = makeSession([
      makeRef("t1", ["request:session/prompt"], t1.conn),
      makeRef("t2", ["request:session/prompt"], t2.conn),
    ]);
    await session.emitToChain("t2", "session/prompt", { sessionId: "sess_test", prompt: [] });
    expect(t1.requests).toHaveLength(0);
    expect(t2.requests).toHaveLength(0);
    expect(requestMock).toHaveBeenCalled();
  });
});

// ── Lifecycle events ──────────────────────────────────────────────────────────

describe("Session transformer chain — lifecycle events", () => {
  it("session.opened fires on construction for transformers with lifecycle intercept", async () => {
    const t = fakeTransformerConn();
    makeSession([makeRef("t1", ["lifecycle:session.opened"], t.conn)]);
    await flushMicrotasks();
    expect(t.notifications.some((n) =>
      n.method === "transformer/session_event" &&
      (n.params as { event: string }).event === "session.opened"
    )).toBe(true);
  });

  it("session.opened does not fire to transformers without that intercept", async () => {
    const t = fakeTransformerConn();
    makeSession([makeRef("t1", ["request:session/prompt"], t.conn)]);
    await flushMicrotasks();
    expect(t.notifications).toHaveLength(0);
  });

  it("session.closed fires in markClosed", async () => {
    const t = fakeTransformerConn();
    const { session } = makeSession([makeRef("t1", ["lifecycle:session.closed"], t.conn)]);
    await session.close();
    await flushMicrotasks();
    expect(t.notifications.some((n) =>
      (n.params as { event: string }).event === "session.closed"
    )).toBe(true);
  });

  it("session.idle fires after the idle event timer expires", async () => {
    vi.useFakeTimers();
    try {
      const t = fakeTransformerConn();
      const { session, mock } = makeSession(
        [makeRef("t1", ["lifecycle:session.idle"], t.conn)],
        50, // 50ms idle event timeout
      );
      const { client } = makeClient();
      await session.attach(client, "none");
      // Trigger recordable activity to arm the idle event timer.
      mock.triggerNotification("session/update", {
        sessionId: "u1",
        update: { sessionUpdate: "assistant_message_chunk", content: { type: "text", text: "x" } },
      });
      // Flush microtasks without setImmediate — fake timers also freeze setImmediate.
      await Promise.resolve();
      await Promise.resolve();

      expect(t.notifications.filter((n) =>
        (n.params as { event: string }).event === "session.idle"
      )).toHaveLength(0);

      // Advance past the idle event timeout; advanceTimersByTimeAsync also drains microtasks.
      await vi.advanceTimersByTimeAsync(100);

      expect(t.notifications.some((n) =>
        (n.params as { event: string }).event === "session.idle"
      )).toBe(true);
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Processing claims ─────────────────────────────────────────────────────────

describe("Session transformer chain — processing claims", () => {
  it("dischargeClaim resolves the pending processing promise", async () => {
    let capturedToken = "";
    const t = fakeTransformerConn();
    (t.conn.request as ReturnType<typeof vi.fn>).mockImplementation(
      (_m: string, params: unknown) => {
        capturedToken = (params as { token: string }).token;
        return Promise.resolve({ action: "processing" });
      },
    );

    const { session } = makeSession([
      makeRef("t1", ["request:session/prompt"], t.conn),
    ]);

    const promise = session.forwardRequest("session/prompt", { sessionId: "sess_test", prompt: [] });

    // Drain microtasks: (1) mock Promise resolves, (2) forwardRequest continuation runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(capturedToken).toBeTruthy();

    const discharged = session.dischargeClaim(capturedToken, { stopReason: "end_turn" });
    expect(discharged).toBe(true);
    const result = await promise;
    expect(result).toEqual({ stopReason: "end_turn" });
  });

  it("dischargeClaim returns false for an unknown token", () => {
    const { session } = makeSession();
    expect(session.dischargeClaim("unknown_token", {})).toBe(false);
  });

  it("keepAliveClaim returns false for an unknown token", () => {
    const { session } = makeSession();
    expect(session.keepAliveClaim("unknown_token")).toBe(false);
  });

  it("abandonment timer fires: promise resolves with stop payload and claim is removed", async () => {
    vi.useFakeTimers();
    try {
      let capturedToken = "";
      const t = fakeTransformerConn();
      (t.conn.request as ReturnType<typeof vi.fn>).mockImplementation(
        (_m: string, params: unknown) => {
          capturedToken = (params as { token: string }).token;
          return Promise.resolve({ action: "processing" });
        },
      );

      const { session } = makeSession([
        makeRef("t1", ["request:session/prompt"], t.conn),
      ]);

      const promise = session.forwardRequest("session/prompt", {
        sessionId: "sess_test",
        prompt: [],
      });

      // Drain microtasks without setImmediate (frozen by fake timers).
      await Promise.resolve();
      await Promise.resolve();
      expect(capturedToken).toBeTruthy();

      // Advance past the 5-minute abandonment timeout.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

      const result = await promise;
      // Abandoned session/prompt resolves with the default stop payload.
      expect(result).toEqual({ stopReason: "stopped" });

      // Claim has been removed — discharge returns false.
      expect(session.dischargeClaim(capturedToken, { stopReason: "end_turn" })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keepAliveClaim resets the abandonment deadline", async () => {
    vi.useFakeTimers();
    try {
      let capturedToken = "";
      const t = fakeTransformerConn();
      (t.conn.request as ReturnType<typeof vi.fn>).mockImplementation(
        (_m: string, params: unknown) => {
          capturedToken = (params as { token: string }).token;
          return Promise.resolve({ action: "processing" });
        },
      );

      const { session } = makeSession([
        makeRef("t1", ["request:session/prompt"], t.conn),
      ]);

      const promise = session.forwardRequest("session/prompt", {
        sessionId: "sess_test",
        prompt: [],
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(capturedToken).toBeTruthy();

      // Advance to just before the default 5-minute timeout — claim still live.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      expect(session.dischargeClaim(capturedToken, {})).toBe(true);
      // Re-park for the keep-alive test.
      (t.conn.request as ReturnType<typeof vi.fn>).mockImplementation(
        (_m: string, params: unknown) => {
          capturedToken = (params as { token: string }).token;
          return Promise.resolve({ action: "processing" });
        },
      );
      // (discharge resolved the original promise — start a fresh claim)
      const promise2 = session.forwardRequest("session/prompt", {
        sessionId: "sess_test",
        prompt: [],
      });
      await Promise.resolve();
      await Promise.resolve();

      // Reset the timer to 10s (becomes 15s with the 1.5× multiplier).
      expect(session.keepAliveClaim(capturedToken, 10_000)).toBe(true);

      // Advance past the original remaining timeout (1 min) but within the new 15s window.
      await vi.advanceTimersByTimeAsync(10_000);
      // Claim still alive — discharge succeeds.
      expect(session.dischargeClaim(capturedToken, { stopReason: "end_turn" })).toBe(true);
      await promise2;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── parentSessionId ───────────────────────────────────────────────────────────

describe("Session — parentSessionId", () => {
  it("stores parentSessionId when provided in SessionInit", () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
    const session = new Session({
      sessionId: "child_sess",
      cwd: "/work",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u_child",
      parentSessionId: "parent_sess_xyz",
    });
    expect(session.parentSessionId).toBe("parent_sess_xyz");
  });

  it("parentSessionId is undefined when not provided", () => {
    const { session } = makeSession();
    expect(session.parentSessionId).toBeUndefined();
  });
});
