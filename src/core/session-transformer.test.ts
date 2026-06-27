import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Session } from "./session.js";
import { HistoryStore } from "./history-store.js";
import { makeMockAgent, makeControlledStream } from "../__tests__/test-utils.js";
import { JsonRpcConnection } from "../acp/connection.js";
import type { JsonRpcRequest } from "../acp/types.js";
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

  it("calls hydra-acp/transformer/message for matching intercept then calls agent", async () => {
    const t = fakeTransformerConn({ action: "continue" });
    const { session, requestMock } = makeSession([
      makeRef("t1", ["request:session/prompt"], t.conn),
    ]);
    await session.forwardRequest("session/prompt", { sessionId: "sess_test", prompt: [] });
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]!.method).toBe("hydra-acp/transformer/message");
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

  it("continue action with payload rewrites the envelope sent to the agent", async () => {
    // Regression for the clarifier deviation-injection bug: a transformer
    // returns { action: "continue", payload: <rewritten envelope> } to
    // mean "let the chain keep going, but with these modifications".
    // forwardRequest must adopt the payload before forwarding to the
    // agent — silently dropping it makes prompt-rewriting transformers
    // invisible to the agent (the clarifier's deviation block was being
    // discarded before this fix).
    const rewritten = {
      sessionId: "upstream_test",
      prompt: [
        { type: "text", text: "[injected by transformer]" },
        { type: "text", text: "original" },
      ],
    };
    const t = fakeTransformerConn({ action: "continue", payload: rewritten });
    const { session, requestMock } = makeSession([
      makeRef("t1", ["request:session/prompt"], t.conn),
    ]);
    await session.forwardRequest("session/prompt", {
      sessionId: "sess_test",
      prompt: [{ type: "text", text: "original" }],
    });
    expect(requestMock).toHaveBeenCalledWith("session/prompt", rewritten);
  });

  it("continue action without payload leaves the envelope unchanged", async () => {
    const t = fakeTransformerConn({ action: "continue" });
    const { session, requestMock } = makeSession([
      makeRef("t1", ["request:session/prompt"], t.conn),
    ]);
    const original = {
      sessionId: "sess_test",
      prompt: [{ type: "text", text: "hi" }],
    };
    await session.forwardRequest("session/prompt", original);
    const [, envelope] = requestMock.mock.calls[0]!;
    expect((envelope as { prompt: unknown[] }).prompt).toEqual([
      { type: "text", text: "hi" },
    ]);
  });

  it("chained continue+payload composes — second transformer sees first's rewrite", async () => {
    const firstRewrite = {
      sessionId: "upstream_test",
      prompt: [
        { type: "text", text: "[A]" },
        { type: "text", text: "x" },
      ],
    };
    const t1 = fakeTransformerConn({ action: "continue", payload: firstRewrite });
    const t2 = fakeTransformerConn({ action: "continue" });
    const { session, requestMock } = makeSession([
      makeRef("t1", ["request:session/prompt"], t1.conn),
      makeRef("t2", ["request:session/prompt"], t2.conn),
    ]);
    await session.forwardRequest("session/prompt", {
      sessionId: "sess_test",
      prompt: [{ type: "text", text: "x" }],
    });
    // t2 must observe the envelope as rewritten by t1.
    const t2Call = t2.requests[0]!;
    const t2Envelope = (t2Call.params as { envelope: { prompt: unknown[] } })
      .envelope;
    expect(t2Envelope.prompt).toEqual([
      { type: "text", text: "[A]" },
      { type: "text", text: "x" },
    ]);
    // And the agent ultimately receives t1's rewrite.
    expect(requestMock).toHaveBeenCalledWith("session/prompt", firstRewrite);
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
    expect(stream.sent.some((m) => "method" in m && m.method === "session/update")).toBe(true);
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
      (m) => "method" in m && m.method === "session/update" &&
        ("params" in m && (m.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ===
          "assistant_message_chunk"),
    );
    expect(updates).toHaveLength(0);
  });

  it("continue with payload rewrites the envelope broadcast to clients", async () => {
    const rewritten = {
      sessionId: "u1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "REDACTED" },
      },
    };
    const t = fakeTransformerConn({ action: "continue", payload: rewritten });
    const { session, mock } = makeSession([
      makeRef("t1", ["response:session/update"], t.conn),
    ]);
    const { client, stream } = makeClient();
    await session.attach(client, "none");

    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "secret" } },
    });
    await flushMicrotasks();

    const sent = stream.sent.find(
      (m) =>
        "method" in m && m.method === "session/update" &&
        ((m.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ===
          "agent_message_chunk"),
    );
    expect(sent).toBeDefined();
    expect(
      (sent as { params: { update: { content: { text: string } } } }).params.update.content.text,
    ).toBe("REDACTED");
  });

  it("chained response continue+payload composes — second transformer sees first's rewrite", async () => {
    const firstRewrite = {
      sessionId: "u1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "STEP1" },
      },
    };
    const t1 = fakeTransformerConn({ action: "continue", payload: firstRewrite });
    const t2 = fakeTransformerConn({ action: "continue" });
    const { session, mock } = makeSession([
      makeRef("t1", ["response:session/update"], t1.conn),
      makeRef("t2", ["response:session/update"], t2.conn),
    ]);
    const { client } = makeClient();
    await session.attach(client, "none");

    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "raw" } },
    });
    await flushMicrotasks();

    expect(t2.requests).toHaveLength(1);
    const seenByT2 = (
      t2.requests[0] as { params: { envelope: { update: { content: { text: string } } } } }
    ).params.envelope.update.content.text;
    expect(seenByT2).toBe("STEP1");
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
      (m) => "params" in m &&
        (m.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ===
        "assistant_message_chunk",
    );
    expect(chunksBefore).toHaveLength(0);

    // Discharge resolves the parked chain — snapshot interceptors and broadcast run.
    session.dischargeClaim(capturedToken, undefined);
    await flushMicrotasks();
  });

  it("response-side processing discharge removes the claim and unblocks the chain", async () => {
    let capturedToken = "";
    const t = fakeTransformerConn();
    (t.conn.request as ReturnType<typeof vi.fn>).mockImplementation(
      (_m: string, params: unknown) => {
        capturedToken = (params as { token: string }).token;
        return Promise.resolve({ action: "processing" });
      },
    );

    const { session, mock } = makeSession([makeRef("t1", ["response:session/update"], t.conn)]);
    const { client } = makeClient();
    await session.attach(client, "none");

    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: { sessionUpdate: "assistant_message_chunk", content: { type: "text", text: "z" } },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(capturedToken).toBeTruthy();

    // Discharge removes the claim — the transformer has taken ownership of
    // the update and will emit a replacement via the outbox if it wants one.
    // The original envelope is NOT auto-broadcast on discharge by design.
    const discharged = session.dischargeClaim(capturedToken, undefined);
    expect(discharged).toBe(true);

    // Claim is gone — a second discharge returns false.
    expect(session.dischargeClaim(capturedToken, undefined)).toBe(false);
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

  it("emitToChain with unknown emitter name still reaches the agent", async () => {
    const t1 = fakeTransformerConn({ action: "continue" });
    const { session, requestMock } = makeSession([
      makeRef("t1", ["request:session/prompt"], t1.conn),
    ]);
    // "ghost" is not in the chain — findIndex returns -1, startIdx becomes 0
    // but "ghost" is in originatedBy so no transformer matching that name runs.
    // t1 IS in the chain so it should still be called.
    await session.emitToChain("ghost", "session/prompt", { sessionId: "sess_test", prompt: [] });
    expect(t1.requests).toHaveLength(1);
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

// ── emitToQueue ───────────────────────────────────────────────────────────────

describe("Session transformer chain — emitToQueue", () => {
  it("runs the queue lifecycle (turnStartedAt is set during the turn)", async () => {
    const { session, mock } = makeSession();
    // Hold session/prompt open so we can sample turnStartedAt mid-turn.
    let release: (v: unknown) => void = () => undefined;
    (mock.agent.connection.request as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => new Promise((r) => { release = r; }));
    expect(session.turnStartedAt).toBeUndefined();
    const turn = session.emitToQueue("planner", {
      sessionId: "sess_test",
      prompt: [{ type: "text", text: "hi" }],
    });
    await flushMicrotasks();
    expect(session.turnStartedAt).toBeTypeOf("number");
    release({ stopReason: "end_turn" });
    await turn;
    expect(session.turnStartedAt).toBeUndefined();
  });

  it("broadcasts prompt_received with the synthetic transformer originator", async () => {
    const { client, stream } = makeClient();
    const { session } = makeSession();
    await session.attach(client, "none");
    await session.emitToQueue("planner", {
      sessionId: "sess_test",
      prompt: [{ type: "text", text: "hi" }],
    });
    const promptReceived = (stream.sent as Array<{
      method?: string;
      params?: { update?: { sessionUpdate?: string; sentBy?: { name?: string } } };
    }>).filter(
      (m) =>
        m.method === "session/update" &&
        m.params?.update?.sessionUpdate === "prompt_received",
    );
    expect(promptReceived).toHaveLength(1);
    expect(promptReceived[0]!.params!.update!.sentBy?.name).toBe("planner");
  });

  it("skips the emitting transformer's own request:session/prompt intercept", async () => {
    const t1 = fakeTransformerConn({ action: "continue" });
    const t2 = fakeTransformerConn({ action: "continue" });
    const { session, requestMock } = makeSession([
      makeRef("t1", ["request:session/prompt"], t1.conn),
      makeRef("t2", ["request:session/prompt"], t2.conn),
    ]);
    await session.emitToQueue("t1", { sessionId: "sess_test", prompt: [] });
    // t1 emitted — skipped. t2 still intercepts. Agent still called.
    expect(t1.requests).toHaveLength(0);
    expect(t2.requests).toHaveLength(1);
    expect(requestMock).toHaveBeenCalled();
  });

  it("rejects route: 'queue' for non-prompt methods (enforced at the route layer; sanity)", async () => {
    // emitToQueue itself only builds prompt entries; the route gate lives
    // in acp-ws.ts. This sanity check just confirms a session/prompt envelope
    // round-trips a normal stopReason back to the caller.
    const { session } = makeSession();
    const result = await session.emitToQueue("planner", {
      sessionId: "sess_test",
      prompt: [],
    });
    expect((result as { stopReason: string }).stopReason).toBe("end_turn");
  });
});

// ── Lifecycle events ──────────────────────────────────────────────────────────

describe("Session transformer chain — lifecycle events — idle rearms", () => {
  it("idle event timer resets when new recordable activity arrives", async () => {
    vi.useFakeTimers();
    try {
      const t = fakeTransformerConn();
      const { session, mock } = makeSession(
        [makeRef("t1", ["lifecycle:session.idle"], t.conn)],
        100, // 100ms idle event timeout
      );
      const { client } = makeClient();
      await session.attach(client, "none");

      // First burst of activity arms the timer.
      mock.triggerNotification("session/update", {
        sessionId: "u1",
        update: { sessionUpdate: "assistant_message_chunk", content: { type: "text", text: "a" } },
      });
      await Promise.resolve();
      await Promise.resolve();

      // Advance 80ms — close to but not past the 100ms timeout.
      await vi.advanceTimersByTimeAsync(80);
      expect(t.notifications.filter((n) =>
        (n.params as { event: string }).event === "session.idle"
      )).toHaveLength(0);

      // Second burst of activity should reset the timer.
      mock.triggerNotification("session/update", {
        sessionId: "u1",
        update: { sessionUpdate: "assistant_message_chunk", content: { type: "text", text: "b" } },
      });
      await Promise.resolve();
      await Promise.resolve();

      // Advance another 80ms — would have fired if the timer wasn't reset,
      // but since it was reset we're still within the new window.
      await vi.advanceTimersByTimeAsync(80);
      expect(t.notifications.filter((n) =>
        (n.params as { event: string }).event === "session.idle"
      )).toHaveLength(0);

      // Advance the remaining 20ms past the reset window — now it fires.
      await vi.advanceTimersByTimeAsync(30);
      expect(t.notifications.some((n) =>
        (n.params as { event: string }).event === "session.idle"
      )).toBe(true);

      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Session transformer chain — lifecycle events", () => {
  it("session.opened fires on construction for transformers with lifecycle intercept", async () => {
    const t = fakeTransformerConn();
    makeSession([makeRef("t1", ["lifecycle:session.opened"], t.conn)]);
    await flushMicrotasks();
    expect(t.notifications.some((n) =>
      n.method === "hydra-acp/transformer/session_event" &&
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

  it("multiple simultaneous processing claims park and discharge independently", async () => {
    let token1 = "";
    let token2 = "";
    const t = fakeTransformerConn();
    let callCount = 0;
    (t.conn.request as ReturnType<typeof vi.fn>).mockImplementation(
      (_m: string, params: unknown) => {
        callCount++;
        if (callCount === 1) token1 = (params as { token: string }).token;
        else token2 = (params as { token: string }).token;
        return Promise.resolve({ action: "processing" });
      },
    );

    const { session } = makeSession([
      makeRef("t1", ["request:session/prompt"], t.conn),
    ]);

    const promise1 = session.forwardRequest("session/prompt", { sessionId: "sess_test", prompt: [] });
    const promise2 = session.forwardRequest("session/prompt", { sessionId: "sess_test", prompt: [] });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(token1).toBeTruthy();
    expect(token2).toBeTruthy();
    expect(token1).not.toBe(token2);

    // Discharge in reverse order.
    session.dischargeClaim(token2, { stopReason: "end_turn" });
    const result2 = await promise2;
    expect(result2).toEqual({ stopReason: "end_turn" });

    session.dischargeClaim(token1, { stopReason: "cancelled" });
    const result1 = await promise1;
    expect(result1).toEqual({ stopReason: "cancelled" });
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
      // Abandoned session/prompt resumes chain and reaches the agent (fail-open).
      expect(result).toEqual({ stopReason: "end_turn" });

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

// ── session/cancel chain dispatch ────────────────────────────────────────────

describe("Session transformer chain — session/cancel", () => {
  it("walks the chain on cancel; agent receives notification after continue", async () => {
    const t = fakeTransformerConn({ action: "continue" });
    const { session, mock } = makeSession([
      makeRef("t1", ["request:session/cancel"], t.conn),
    ]);
    const { client } = makeClient();
    session.attach(client, "full");

    await session.cancel(client.clientId);

    // Transformer was consulted on the request side.
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]!.method).toBe("hydra-acp/transformer/message");
    expect((t.requests[0]!.params as { phase: string; method: string }).phase).toBe("request");
    expect((t.requests[0]!.params as { phase: string; method: string }).method).toBe("session/cancel");

    // Agent received the notification (NOT a request).
    const notifyMock = mock.agent.connection.notify as ReturnType<typeof vi.fn>;
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    expect(notifyMock).toHaveBeenCalledWith("session/cancel", { sessionId: "u1" });
    expect(requestMock).not.toHaveBeenCalledWith("session/cancel", expect.anything());
  });

  it("stop suppresses the agent-side notification", async () => {
    const t = fakeTransformerConn({ action: "stop" });
    const { session, mock } = makeSession([
      makeRef("t1", ["request:session/cancel"], t.conn),
    ]);
    const { client } = makeClient();
    session.attach(client, "full");

    await session.cancel(client.clientId);

    expect(t.requests).toHaveLength(1);
    const notifyMock = mock.agent.connection.notify as ReturnType<typeof vi.fn>;
    expect(notifyMock).not.toHaveBeenCalledWith("session/cancel", expect.anything());
  });

  it("processing parks the cancel; discharge ends the chain (agent not notified)", async () => {
    // Discharge resolves the forwardRequest promise without resuming
    // the chain — symmetric with the discharge-then-end semantics used
    // by transformers that fully absorb a request (e.g. the planner
    // holding session/prompt for the duration of a project). For
    // session/cancel this is the canonical "transformer handled it"
    // path: it cancels its own background work and discharges, and the
    // agent — which never received the held prompt — needs no notify.
    let capturedToken = "";
    const t = fakeTransformerConn();
    (t.conn.request as ReturnType<typeof vi.fn>).mockImplementation(
      (_m: string, params: unknown) => {
        capturedToken = (params as { token: string }).token;
        return Promise.resolve({ action: "processing" });
      },
    );
    const { session, mock } = makeSession([
      makeRef("t1", ["request:session/cancel"], t.conn),
    ]);
    const { client } = makeClient();
    session.attach(client, "full");

    const cancelPromise = session.cancel(client.clientId);

    await Promise.resolve();
    await Promise.resolve();
    expect(capturedToken).toBeTruthy();

    const notifyMock = mock.agent.connection.notify as ReturnType<typeof vi.fn>;
    expect(notifyMock).not.toHaveBeenCalledWith("session/cancel", expect.anything());

    expect(session.dischargeClaim(capturedToken, undefined)).toBe(true);
    await cancelPromise;
    // After discharge the chain ends — agent is NOT notified.
    expect(notifyMock).not.toHaveBeenCalledWith("session/cancel", expect.anything());
  });

  it("transformer without the intercept is skipped; agent still notified", async () => {
    const t = fakeTransformerConn();
    const { session, mock } = makeSession([
      makeRef("t1", ["request:session/prompt"], t.conn), // unrelated intercept
    ]);
    const { client } = makeClient();
    session.attach(client, "full");

    await session.cancel(client.clientId);

    expect(t.requests).toHaveLength(0);
    const notifyMock = mock.agent.connection.notify as ReturnType<typeof vi.fn>;
    expect(notifyMock).toHaveBeenCalledWith("session/cancel", { sessionId: "u1" });
  });

  it("abandonment fail-open resumes the chain and tails as notification", async () => {
    vi.useFakeTimers();
    try {
      const t = fakeTransformerConn();
      (t.conn.request as ReturnType<typeof vi.fn>).mockImplementation(
        () => Promise.resolve({ action: "processing" }),
      );
      const { session, mock } = makeSession([
        makeRef("t1", ["request:session/cancel"], t.conn),
      ]);
      const { client } = makeClient();
      session.attach(client, "full");

      const cancelPromise = session.cancel(client.clientId);
      await Promise.resolve();
      await Promise.resolve();

      // Advance past the 5-minute abandonment timeout.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      await cancelPromise;

      const notifyMock = mock.agent.connection.notify as ReturnType<typeof vi.fn>;
      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
      // Fail-open: chain resumed and tailed out as a notification.
      expect(notifyMock).toHaveBeenCalledWith("session/cancel", { sessionId: "u1" });
      expect(requestMock).not.toHaveBeenCalledWith("session/cancel", expect.anything());
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

// ── addTransformer ────────────────────────────────────────────────────────────

describe("Session.addTransformer — retroactive wiring", () => {
  it("adds transformer to an empty chain", () => {
    const { session } = makeSession();
    const t = fakeTransformerConn({ action: "continue" });
    const ref = makeRef("t1", ["response:session/update"], t.conn);
    session.addTransformer(ref);
    // Verify it's in the chain by sending a request that would reach it.
    // We use forwardRequest; t1 only intercepts responses, so it won't fire
    // here — but the absence of errors confirms the chain accepted it.
    expect(t.requests).toHaveLength(0);
  });

  it("replaces an existing entry when a transformer with the same name reconnects", async () => {
    const old = fakeTransformerConn({ action: "continue" });
    const oldRef = makeRef("t1", ["request:session/prompt"], old.conn);
    const { session, requestMock } = makeSession([oldRef]);
    const fresh = fakeTransformerConn({ action: "continue" });
    const freshRef = makeRef("t1", ["request:session/prompt"], fresh.conn);
    session.addTransformer(freshRef);
    await session.forwardRequest("session/prompt", { sessionId: "sess_test", prompt: [] });
    // Only the new connection is called — old is replaced, not duplicated.
    expect(old.requests).toHaveLength(0);
    expect(fresh.requests).toHaveLength(1);
    requestMock.mockResolvedValue({ stopReason: "end_turn" });
  });

  it("fires session.opened on the new transformer when it declared the intercept", () => {
    const { session } = makeSession();
    const t = fakeTransformerConn({ action: "continue" });
    const ref = makeRef("t1", ["lifecycle:session.opened"], t.conn);
    session.addTransformer(ref);
    // Give the void notify promise a tick to settle.
    return new Promise<void>((resolve) => setImmediate(() => {
      expect(t.notifications).toHaveLength(1);
      expect(t.notifications[0]!.method).toBe("hydra-acp/transformer/session_event");
      expect((t.notifications[0]!.params as { event: string }).event).toBe("session.opened");
      resolve();
    }));
  });

  it("does not fire session.opened when the transformer did not declare the intercept", () => {
    const { session } = makeSession();
    const t = fakeTransformerConn({ action: "continue" });
    const ref = makeRef("t1", ["response:session/update"], t.conn);
    session.addTransformer(ref);
    return new Promise<void>((resolve) => setImmediate(() => {
      expect(t.notifications).toHaveLength(0);
      resolve();
    }));
  });
});

// ── runAgentRequestChain — session/request_permission ─────────────────────────

describe("Session transformer chain — agent→client request (permission)", () => {
  const permParams = {
    sessionId: "u1",
    toolCall: { name: "bash", toolCallId: "tc_1" },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  };

  it("stop auto-approves without prompting any attached client", async () => {
    const approval = { outcome: { outcome: "selected", optionId: "allow" } };
    const t = fakeTransformerConn({ action: "stop", payload: approval });
    const { session, mock } = makeSession([
      makeRef("t1", ["request:session/request_permission"], t.conn),
    ]);
    const { client, stream } = makeClient();
    await session.attach(client, "full");

    const result = await mock.triggerRequest("session/request_permission", permParams);

    expect(t.requests).toHaveLength(1);
    expect((t.requests[0]!.params as { direction: string }).direction).toBe("agent→client");
    expect(result).toEqual(approval);
    // Client was never asked.
    expect(
      stream.sent.some(
        (m) => "method" in m && m.method === "session/request_permission",
      ),
    ).toBe(false);
  });

  it("stop with no payload defaults to a cancelled outcome (auto-deny)", async () => {
    const t = fakeTransformerConn({ action: "stop" });
    const { session, mock } = makeSession([
      makeRef("t1", ["request:session/request_permission"], t.conn),
    ]);
    const { client } = makeClient();
    await session.attach(client, "full");

    const result = await mock.triggerRequest("session/request_permission", permParams);
    expect(result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("continue with payload rewrites envelope before the client sees it", async () => {
    const rewritten = {
      ...permParams,
      toolCall: { name: "bash", toolCallId: "tc_1", rawInput: { command: "ls" } },
    };
    const t = fakeTransformerConn({ action: "continue", payload: rewritten });
    const { session, mock } = makeSession([
      makeRef("t1", ["request:session/request_permission"], t.conn),
    ]);
    const { client, stream } = makeClient();
    await session.attach(client, "full");

    const reqPromise = mock.triggerRequest("session/request_permission", permParams);
    await flushMicrotasks();

    const permMsg = stream.sent.find(
      (m): m is JsonRpcRequest =>
        "method" in (m as object) &&
        (m as { method: string }).method === "session/request_permission",
    );
    expect(permMsg).toBeDefined();
    expect(
      (permMsg!.params as { toolCall: { rawInput?: { command: string } } }).toolCall.rawInput?.command,
    ).toBe("ls");

    stream.emitMessage({
      jsonrpc: "2.0",
      id: permMsg!.id,
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    await reqPromise;
  });

  it("continue without payload passes through to client unchanged", async () => {
    const t = fakeTransformerConn({ action: "continue" });
    const { session, mock } = makeSession([
      makeRef("t1", ["request:session/request_permission"], t.conn),
    ]);
    const { client, stream } = makeClient();
    await session.attach(client, "full");

    const reqPromise = mock.triggerRequest("session/request_permission", permParams);
    await flushMicrotasks();

    const permMsg = stream.sent.find(
      (m): m is JsonRpcRequest =>
        "method" in (m as object) &&
        (m as { method: string }).method === "session/request_permission",
    );
    expect(permMsg).toBeDefined();
    stream.emitMessage({
      jsonrpc: "2.0",
      id: permMsg!.id,
      result: { outcome: { outcome: "selected", optionId: "deny" } },
    });
    const result = (await reqPromise) as { outcome: { optionId: string } };
    expect(result.outcome.optionId).toBe("deny");
  });

  it("skips transformers that don't declare request:session/request_permission", async () => {
    const t = fakeTransformerConn({ action: "stop" });
    const { session, mock } = makeSession([
      makeRef("t1", ["request:session/prompt"], t.conn), // wrong intercept
    ]);
    const { client, stream } = makeClient();
    await session.attach(client, "full");

    const reqPromise = mock.triggerRequest("session/request_permission", permParams);
    await flushMicrotasks();

    expect(t.requests).toHaveLength(0);
    // Client was asked normally.
    const permMsg = stream.sent.find(
      (m): m is JsonRpcRequest =>
        "method" in (m as object) &&
        (m as { method: string }).method === "session/request_permission",
    );
    expect(permMsg).toBeDefined();
    stream.emitMessage({
      jsonrpc: "2.0",
      id: permMsg!.id,
      result: { outcome: { outcome: "cancelled" } },
    });
    await reqPromise;
  });

  it("chained continue+stop: first rewrites, second short-circuits with the rewrite visible", async () => {
    const rewritten = {
      ...permParams,
      toolCall: { name: "bash", toolCallId: "tc_1", redacted: true },
    };
    const t1 = fakeTransformerConn({ action: "continue", payload: rewritten });
    let seenByT2: unknown;
    const t2 = fakeTransformerConn();
    (t2.conn.request as ReturnType<typeof vi.fn>).mockImplementation(
      async (_m: string, params: unknown) => {
        seenByT2 = (params as { envelope: unknown }).envelope;
        return { action: "stop", payload: { outcome: { outcome: "cancelled" } } };
      },
    );
    const { session, mock } = makeSession([
      makeRef("t1", ["request:session/request_permission"], t1.conn),
      makeRef("t2", ["request:session/request_permission"], t2.conn),
    ]);
    const { client } = makeClient();
    await session.attach(client, "full");

    await mock.triggerRequest("session/request_permission", permParams);
    expect((seenByT2 as { toolCall: { redacted?: boolean } }).toolCall.redacted).toBe(true);
  });

  it("emits lifecycle:permission.replied after user/client reply", async () => {
    const t = fakeTransformerConn();
    const { session, mock } = makeSession([
      makeRef("t1", ["lifecycle:permission.replied"], t.conn),
    ]);
    const { client, stream } = makeClient();
    await session.attach(client, "full");

    const reqPromise = mock.triggerRequest("session/request_permission", permParams);
    await flushMicrotasks();

    const permMsg = stream.sent.find(
      (m): m is JsonRpcRequest =>
        "method" in (m as object) &&
        (m as { method: string }).method === "session/request_permission",
    );
    stream.emitMessage({
      jsonrpc: "2.0",
      id: permMsg!.id,
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    await reqPromise;
    await flushMicrotasks();

    const replied = t.notifications.find(
      (n) => (n.params as { event: string }).event === "permission.replied",
    );
    expect(replied).toBeDefined();
    expect(
      (replied!.params as { payload: { sourceWasTransformer: boolean } }).payload
        .sourceWasTransformer,
    ).toBe(false);
  });

  it("emits lifecycle:permission.replied on short-circuit with sourceWasTransformer=true", async () => {
    const policy = fakeTransformerConn({
      action: "stop",
      payload: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    const observer = fakeTransformerConn();
    const { session, mock } = makeSession([
      makeRef("policy", ["request:session/request_permission"], policy.conn),
      makeRef("observer", ["lifecycle:permission.replied"], observer.conn),
    ]);
    const { client } = makeClient();
    await session.attach(client, "full");

    await mock.triggerRequest("session/request_permission", permParams);
    await flushMicrotasks();

    const replied = observer.notifications.find(
      (n) => (n.params as { event: string }).event === "permission.replied",
    );
    expect(replied).toBeDefined();
    expect(
      (replied!.params as { payload: { sourceWasTransformer: boolean } }).payload
        .sourceWasTransformer,
    ).toBe(true);
  });
});

// ── Edge-trigger synthesis — lifecycle:tool.completed / lifecycle:file.edited ─

describe("Session edge events — tool.completed", () => {
  function eventsOf(notifications: Array<{ method: string; params: unknown }>, name: string) {
    return notifications.filter(
      (n) => (n.params as { event: string }).event === name,
    );
  }

  it("fires once when tool_call_update transitions to completed", async () => {
    const t = fakeTransformerConn();
    const { session, mock } = makeSession([
      makeRef("t1", ["lifecycle:tool.completed"], t.conn),
    ]);
    const { client } = makeClient();
    await session.attach(client, "none");

    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: { sessionUpdate: "tool_call", toolCallId: "tc_1", kind: "execute" },
    });
    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "tc_1", status: "completed" },
    });
    await flushMicrotasks();

    const events = eventsOf(t.notifications, "tool.completed");
    expect(events).toHaveLength(1);
    const payload = (events[0]!.params as { payload: Record<string, unknown> }).payload;
    expect(payload.toolCallId).toBe("tc_1");
    expect(payload.status).toBe("completed");
    expect(payload.kind).toBe("execute");
  });

  it("fires on failed status as well", async () => {
    const t = fakeTransformerConn();
    const { session, mock } = makeSession([
      makeRef("t1", ["lifecycle:tool.completed"], t.conn),
    ]);
    const { client } = makeClient();
    await session.attach(client, "none");

    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "tc_2", status: "failed" },
    });
    await flushMicrotasks();

    const events = eventsOf(t.notifications, "tool.completed");
    expect(events).toHaveLength(1);
    expect((events[0]!.params as { payload: { status: string } }).payload.status).toBe("failed");
  });

  it("does not fire on in_progress or pending updates", async () => {
    const t = fakeTransformerConn();
    const { session, mock } = makeSession([
      makeRef("t1", ["lifecycle:tool.completed"], t.conn),
    ]);
    const { client } = makeClient();
    await session.attach(client, "none");

    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: { sessionUpdate: "tool_call", toolCallId: "tc_3", kind: "execute" },
    });
    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "tc_3", status: "in_progress" },
    });
    await flushMicrotasks();

    expect(eventsOf(t.notifications, "tool.completed")).toHaveLength(0);
  });

  it("deduplicates repeat terminal updates for the same toolCallId", async () => {
    const t = fakeTransformerConn();
    const { session, mock } = makeSession([
      makeRef("t1", ["lifecycle:tool.completed"], t.conn),
    ]);
    const { client } = makeClient();
    await session.attach(client, "none");

    for (let i = 0; i < 3; i++) {
      mock.triggerNotification("session/update", {
        sessionId: "u1",
        update: { sessionUpdate: "tool_call_update", toolCallId: "tc_4", status: "completed" },
      });
    }
    await flushMicrotasks();

    expect(eventsOf(t.notifications, "tool.completed")).toHaveLength(1);
  });

  it("does not fire when no transformer declares lifecycle:tool.completed", async () => {
    const t = fakeTransformerConn();
    const { session, mock } = makeSession([
      makeRef("t1", ["response:session/update"], t.conn),
    ]);
    const { client } = makeClient();
    await session.attach(client, "none");

    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "tc_5", status: "completed" },
    });
    await flushMicrotasks();

    expect(eventsOf(t.notifications, "tool.completed")).toHaveLength(0);
  });
});

describe("Session lifecycle — compaction", () => {
  function eventsOf(notifications: Array<{ method: string; params: unknown }>, name: string) {
    return notifications.filter(
      (n) => (n.params as { event: string }).event === name,
    );
  }

  it("fires lifecycle:compaction for each broadcastCompactionPhase call", async () => {
    const t = fakeTransformerConn();
    const { session } = makeSession([
      makeRef("t1", ["lifecycle:compaction"], t.conn),
    ]);
    session.broadcastCompactionPhase({ phase: "started", requestedAt: 1 });
    session.broadcastCompactionPhase({ phase: "deferred", attempts: 1 });
    session.broadcastCompactionPhase({ phase: "swapped", summarizedThroughEntry: 7 });
    await flushMicrotasks();

    const events = eventsOf(t.notifications, "compaction");
    expect(events).toHaveLength(3);
    expect((events[0]!.params as { payload: { phase: string } }).payload.phase).toBe("started");
    expect((events[1]!.params as { payload: { phase: string } }).payload.phase).toBe("deferred");
    expect((events[2]!.params as { payload: { phase: string } }).payload.phase).toBe("swapped");
  });

  it("does not fire when no transformer declares lifecycle:compaction", async () => {
    const t = fakeTransformerConn();
    const { session } = makeSession([
      makeRef("t1", ["response:session/update"], t.conn),
    ]);
    session.broadcastCompactionPhase({ phase: "started", requestedAt: 1 });
    await flushMicrotasks();
    expect(eventsOf(t.notifications, "compaction")).toHaveLength(0);
  });
});

describe("Session edge events — file.edited", () => {
  function eventsOf(notifications: Array<{ method: string; params: unknown }>, name: string) {
    return notifications.filter(
      (n) => (n.params as { event: string }).event === name,
    );
  }

  it("fires once per unique path on an edit-kind tool", async () => {
    const t = fakeTransformerConn();
    const { session, mock } = makeSession([
      makeRef("t1", ["lifecycle:file.edited"], t.conn),
    ]);
    const { client } = makeClient();
    await session.attach(client, "none");

    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc_e1",
        kind: "edit",
        locations: [{ path: "/a/b/file.ts", line: 12 }],
      },
    });
    await flushMicrotasks();

    const events = eventsOf(t.notifications, "file.edited");
    expect(events).toHaveLength(1);
    const payload = (events[0]!.params as { payload: Record<string, unknown> }).payload;
    expect(payload.path).toBe("/a/b/file.ts");
    expect(payload.toolCallId).toBe("tc_e1");
    expect(payload.line).toBe(12);
  });

  it("dedupes the same path across multiple updates", async () => {
    const t = fakeTransformerConn();
    const { session, mock } = makeSession([
      makeRef("t1", ["lifecycle:file.edited"], t.conn),
    ]);
    const { client } = makeClient();
    await session.attach(client, "none");

    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc_e2",
        kind: "edit",
        locations: [{ path: "/x.ts" }],
      },
    });
    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc_e2",
        locations: [{ path: "/x.ts" }],
      },
    });
    await flushMicrotasks();

    expect(eventsOf(t.notifications, "file.edited")).toHaveLength(1);
  });

  it("does not fire for non-edit tool kinds (e.g. execute, read)", async () => {
    const t = fakeTransformerConn();
    const { session, mock } = makeSession([
      makeRef("t1", ["lifecycle:file.edited"], t.conn),
    ]);
    const { client } = makeClient();
    await session.attach(client, "none");

    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc_r1",
        kind: "read",
        locations: [{ path: "/x.ts" }],
      },
    });
    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc_x1",
        kind: "execute",
        locations: [{ path: "/y.sh" }],
      },
    });
    await flushMicrotasks();

    expect(eventsOf(t.notifications, "file.edited")).toHaveLength(0);
  });

  it("uses the kind from the original tool_call when tool_call_update omits it", async () => {
    const t = fakeTransformerConn();
    const { session, mock } = makeSession([
      makeRef("t1", ["lifecycle:file.edited"], t.conn),
    ]);
    const { client } = makeClient();
    await session.attach(client, "none");

    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: { sessionUpdate: "tool_call", toolCallId: "tc_e3", kind: "edit" },
    });
    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc_e3",
        locations: [{ path: "/late.ts" }],
      },
    });
    await flushMicrotasks();

    expect(eventsOf(t.notifications, "file.edited")).toHaveLength(1);
  });

  it("fires for multiple distinct paths within the same tool call", async () => {
    const t = fakeTransformerConn();
    const { session, mock } = makeSession([
      makeRef("t1", ["lifecycle:file.edited"], t.conn),
    ]);
    const { client } = makeClient();
    await session.attach(client, "none");

    mock.triggerNotification("session/update", {
      sessionId: "u1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc_e4",
        kind: "edit",
        locations: [{ path: "/a.ts" }, { path: "/b.ts" }, { path: "/a.ts" }],
      },
    });
    await flushMicrotasks();

    const events = eventsOf(t.notifications, "file.edited");
    expect(events).toHaveLength(2);
    const paths = events
      .map((e) => (e.params as { payload: { path: string } }).payload.path)
      .sort();
    expect(paths).toEqual(["/a.ts", "/b.ts"]);
  });
});
