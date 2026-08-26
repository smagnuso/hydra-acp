import { describe, it, expect, vi, beforeEach } from "vitest";
import { JsonRpcConnection } from "../acp/connection.js";
import { JsonRpcErrorCodes } from "../acp/types-jsonrpc.js";
import { makeMockAgent, makeControlledStream } from "../__tests__/test-utils.js";
import { Session, isUpstreamSessionLost } from "./session.js";
import { HistoryStore } from "./history-store.js";

beforeEach(() => {
  vi.clearAllMocks();
});

function makeClient(): { clientId: string; connection: JsonRpcConnection } {
  return {
    clientId: `c_${Math.random().toString(36).slice(2, 8)}`,
    connection: new JsonRpcConnection(makeControlledStream()),
  };
}

// The two shapes claude-agent-acp produces for "I lost that session", as
// they arrive on this side of the wire.
function evictedFromMap(): Error {
  // `throw new Error("Session not found")` — ACP wraps an unexpected throw
  // as InternalError and puts the text in data.details.
  const err = new Error("Internal error") as Error & {
    code: number;
    data: unknown;
  };
  err.code = JsonRpcErrorCodes.InternalError;
  err.data = { details: "Session not found" };
  return err;
}

function queryStreamEnded(): Error {
  // RequestError.internalError(undefined, SESSION_ENDED_MESSAGE) — the text
  // is appended to the message and there is no data.
  const err = new Error(
    "Internal error: The Claude Agent session has ended. Please start a new session.",
  ) as Error & { code: number };
  err.code = JsonRpcErrorCodes.InternalError;
  return err;
}

// A prompt-shaped mock whose session/prompt fails `failures` times with
// `error`, then succeeds.
function makeFlakyAgent(opts: { failures: number; error: () => Error }) {
  const mock = makeMockAgent({ agentId: "a1", cwd: "/w" });
  let promptCalls = 0;
  (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
    async (method: string) => {
      if (method === "session/prompt") {
        promptCalls += 1;
        if (promptCalls <= opts.failures) {
          throw opts.error();
        }
        return { stopReason: "end_turn" };
      }
      return {};
    },
  );
  return { mock, promptCalls: () => promptCalls };
}

function makeSession(opts: {
  agent: ReturnType<typeof makeMockAgent>["agent"];
  loadExistingAgentSession?: ReturnType<typeof vi.fn>;
  sessionId?: string;
}) {
  return new Session({
    sessionId: opts.sessionId ?? "hydra_lost_1",
    cwd: "/w",
    agentId: "a1",
    agent: opts.agent,
    upstreamSessionId: "u1",
    historyStore: new HistoryStore(),
    ...(opts.loadExistingAgentSession
      ? { loadExistingAgentSession: opts.loadExistingAgentSession }
      : {}),
  });
}

describe("isUpstreamSessionLost", () => {
  it("matches a session evicted from the agent's map (data.details)", () => {
    expect(isUpstreamSessionLost(evictedFromMap())).toBe(true);
  });

  it("matches an ended query stream (text on message)", () => {
    expect(isUpstreamSessionLost(queryStreamEnded())).toBe(true);
  });

  it("does not match a turn killed mid-flight by process death", () => {
    // That prompt may already have run tools, so it must not be retried.
    const err = new Error(
      "Internal error: The Claude Agent process exited unexpectedly. Please start a new session.",
    ) as Error & { code: number };
    err.code = JsonRpcErrorCodes.InternalError;
    expect(isUpstreamSessionLost(err)).toBe(false);
  });

  it("does not match Hydra's own -32001 SessionNotFound", () => {
    // Same words, different condition: raised before the agent is consulted.
    const err = new Error("session hydra_x not found") as Error & { code: number };
    err.code = JsonRpcErrorCodes.SessionNotFound;
    expect(isUpstreamSessionLost(err)).toBe(false);
  });

  it("does not match an unrelated internal error", () => {
    const err = new Error(
      "Internal error: You've hit your session limit",
    ) as Error & { code: number; data: unknown };
    err.code = JsonRpcErrorCodes.InternalError;
    err.data = { errorKind: "rate_limit" };
    expect(isUpstreamSessionLost(err)).toBe(false);
  });

  it("ignores errors with no code", () => {
    expect(isUpstreamSessionLost(new Error("Session not found"))).toBe(false);
    expect(isUpstreamSessionLost(undefined)).toBe(false);
  });
});

describe("Session prompt recovery when the agent loses the upstream session", () => {
  it("reloads the SAME upstream id and retries the prompt once", async () => {
    const { mock, promptCalls } = makeFlakyAgent({
      failures: 1,
      error: evictedFromMap,
    });
    const freshMock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    (freshMock.agent.connection.request as ReturnType<typeof vi.fn>)
      .mockImplementation(async (method: string) =>
        method === "session/prompt" ? { stopReason: "end_turn" } : {},
      );

    const loadExistingAgentSession = vi
      .fn()
      .mockImplementation(async (upstreamId: string) => ({
        agent: freshMock.agent,
        upstreamSessionId: upstreamId,
      }));

    const session = makeSession({
      agent: mock.agent,
      loadExistingAgentSession,
    });
    const client = makeClient();
    session.attach(client, "full");

    const result = await session.prompt(client.clientId, {
      prompt: [{ type: "text", text: "hello" }],
    });

    expect(result).toEqual({ stopReason: "end_turn" });
    // Resumed, not re-created: same id back into session/load.
    expect(loadExistingAgentSession).toHaveBeenCalledTimes(1);
    expect(loadExistingAgentSession.mock.calls[0]?.[0]).toBe("u1");
    expect(session.upstreamSessionId).toBe("u1");
    // The failed send landed on the old agent; the retry on the new one.
    expect(promptCalls()).toBe(1);
  });

  it("recovers from an ended query stream too", async () => {
    const { mock } = makeFlakyAgent({ failures: 1, error: queryStreamEnded });
    const freshMock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    (freshMock.agent.connection.request as ReturnType<typeof vi.fn>)
      .mockImplementation(async (method: string) =>
        method === "session/prompt" ? { stopReason: "end_turn" } : {},
      );
    const loadExistingAgentSession = vi.fn().mockImplementation(async (id: string) => ({
      agent: freshMock.agent,
      upstreamSessionId: id,
    }));

    const session = makeSession({
      agent: mock.agent,
      loadExistingAgentSession,
      sessionId: "hydra_lost_2",
    });
    const client = makeClient();
    session.attach(client, "full");

    await expect(
      session.prompt(client.clientId, { prompt: [{ type: "text", text: "hi" }] }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(loadExistingAgentSession).toHaveBeenCalledTimes(1);
  });

  it("retries at most once — a second loss propagates", async () => {
    const { mock } = makeFlakyAgent({ failures: 2, error: evictedFromMap });
    // Reload hands back an agent that has ALSO lost the session.
    const loadExistingAgentSession = vi.fn().mockImplementation(async (id: string) => ({
      agent: mock.agent,
      upstreamSessionId: id,
    }));

    const session = makeSession({
      agent: mock.agent,
      loadExistingAgentSession,
      sessionId: "hydra_lost_3",
    });
    const client = makeClient();
    session.attach(client, "full");

    await expect(
      session.prompt(client.clientId, { prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toThrow("Internal error");
    expect(loadExistingAgentSession).toHaveBeenCalledTimes(1);
  });

  it("does not reload for an unrelated prompt failure", async () => {
    const mock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async (method: string) => {
        if (method === "session/prompt") {
          const err = new Error("Internal error: rate limited") as Error & {
            code: number;
          };
          err.code = JsonRpcErrorCodes.InternalError;
          throw err;
        }
        return {};
      },
    );
    const loadExistingAgentSession = vi.fn();

    const session = makeSession({
      agent: mock.agent,
      loadExistingAgentSession,
      sessionId: "hydra_lost_4",
    });
    const client = makeClient();
    session.attach(client, "full");

    await expect(
      session.prompt(client.clientId, { prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toThrow("rate limited");
    expect(loadExistingAgentSession).not.toHaveBeenCalled();
  });

  it("propagates the loss when no reload hook is configured", async () => {
    const { mock } = makeFlakyAgent({ failures: 1, error: evictedFromMap });
    const session = makeSession({ agent: mock.agent, sessionId: "hydra_lost_5" });
    const client = makeClient();
    session.attach(client, "full");

    await expect(
      session.prompt(client.clientId, { prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toThrow("Internal error");
  });
});
