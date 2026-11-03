import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JsonRpcConnection } from "../acp/connection.js";
import { JsonRpcErrorCodes } from "../acp/types-jsonrpc.js";
import { makeMockAgent, makeControlledStream } from "../__tests__/test-utils.js";
import {
  Session,
  isTransientAuthFailure,
  TRANSIENT_AUTH_RETRY_MS,
} from "./session.js";
import { HistoryStore } from "./history-store.js";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// Verbatim from a real incident: several agent processes shared one
// credential file, the access token expired, and the processes that lost
// the refresh lock failed their whole turn with this.
const OAUTH_TEXT =
  "Failed to refresh OAuth token: another Claude Code process is refreshing " +
  "it or exited mid-refresh. This is usually transient; retry in a minute, " +
  "and if it persists close other Claude Code processes or sign in again";

function oauthRefreshFailed(): Error {
  const err = new Error(`Internal error: ${OAUTH_TEXT}`) as Error & { code: number };
  err.code = JsonRpcErrorCodes.InternalError;
  return err;
}

function oauthInDetails(): Error {
  const err = new Error("Internal error") as Error & { code: number; data: unknown };
  err.code = JsonRpcErrorCodes.InternalError;
  err.data = { details: OAUTH_TEXT };
  return err;
}

function makeClient(): { clientId: string; connection: JsonRpcConnection } {
  return {
    clientId: `c_${Math.random().toString(36).slice(2, 8)}`,
    connection: new JsonRpcConnection(makeControlledStream()),
  };
}

function makeSession(opts: {
  agent: ReturnType<typeof makeMockAgent>["agent"];
  sessionId?: string;
}) {
  return new Session({
    sessionId: opts.sessionId ?? "hydra_auth_1",
    cwd: "/w",
    agentId: "a1",
    agent: opts.agent,
    upstreamSessionId: "u1",
    historyStore: new HistoryStore(),
  });
}

// A prompt-shaped mock failing `failures` times with `error`, then
// succeeding. `beforeThrow` runs on each failing attempt, so a test can
// have the agent emit a tool_call before the turn dies.
function makeFlakyAgent(opts: {
  failures: number;
  error: () => Error;
  beforeThrow?: (mock: ReturnType<typeof makeMockAgent>) => void;
}) {
  const mock = makeMockAgent({ agentId: "a1", cwd: "/w" });
  let promptCalls = 0;
  (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
    async (method: string) => {
      if (method === "session/prompt") {
        promptCalls += 1;
        if (promptCalls <= opts.failures) {
          opts.beforeThrow?.(mock);
          throw opts.error();
        }
        return { stopReason: "end_turn" };
      }
      return {};
    },
  );
  return { mock, promptCalls: () => promptCalls };
}

function emitToolCall(mock: ReturnType<typeof makeMockAgent>): void {
  mock.triggerNotification("session/update", {
    sessionId: "u1",
    update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Bash" },
  });
}

describe("isTransientAuthFailure", () => {
  it("matches the refresh failure on message", () => {
    expect(isTransientAuthFailure(oauthRefreshFailed())).toBe(true);
  });

  it("matches it in data.details too", () => {
    expect(isTransientAuthFailure(oauthInDetails())).toBe(true);
  });

  it("does not match an unrelated internal error", () => {
    const err = new Error("Internal error: rate limited") as Error & { code: number };
    err.code = JsonRpcErrorCodes.InternalError;
    expect(isTransientAuthFailure(err)).toBe(false);
  });

  it("does not match a lost upstream session", () => {
    // Handled by isUpstreamSessionLost's own reload path, not this one.
    const err = new Error(
      "Internal error: The Claude Agent session has ended. Please start a new session.",
    ) as Error & { code: number };
    err.code = JsonRpcErrorCodes.InternalError;
    expect(isTransientAuthFailure(err)).toBe(false);
  });

  it("ignores the same words under a non-InternalError code", () => {
    const err = new Error(OAUTH_TEXT) as Error & { code: number };
    err.code = JsonRpcErrorCodes.AuthRequired;
    expect(isTransientAuthFailure(err)).toBe(false);
  });

  it("ignores errors with no code", () => {
    expect(isTransientAuthFailure(new Error(OAUTH_TEXT))).toBe(false);
    expect(isTransientAuthFailure(undefined)).toBe(false);
  });
});

describe("Session prompt recovery from a transient auth failure", () => {
  it("waits out the refresh window, then retries the prompt once", async () => {
    vi.useFakeTimers();
    const { mock, promptCalls } = makeFlakyAgent({
      failures: 1,
      error: oauthRefreshFailed,
    });
    const session = makeSession({ agent: mock.agent });
    const client = makeClient();
    session.attach(client, "full");

    const pending = session.prompt(client.clientId, {
      prompt: [{ type: "text", text: "let's scan" }],
    });

    // Still waiting: the retry must not fire before the window elapses,
    // or it just burns the single attempt on a lock that is still held.
    await vi.advanceTimersByTimeAsync(TRANSIENT_AUTH_RETRY_MS - 1);
    expect(promptCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ stopReason: "end_turn" });
    expect(promptCalls()).toBe(2);
  });

  it("retries at most once — a second failure propagates", async () => {
    vi.useFakeTimers();
    const { mock, promptCalls } = makeFlakyAgent({
      failures: 2,
      error: oauthRefreshFailed,
    });
    const session = makeSession({ agent: mock.agent, sessionId: "hydra_auth_2" });
    const client = makeClient();
    session.attach(client, "full");

    const pending = session.prompt(client.clientId, {
      prompt: [{ type: "text", text: "hi" }],
    });
    const assertion = expect(pending).rejects.toThrow("Failed to refresh OAuth token");
    await vi.advanceTimersByTimeAsync(TRANSIENT_AUTH_RETRY_MS);
    await assertion;
    expect(promptCalls()).toBe(2);
  });

  it("does NOT retry a turn that already ran a tool", async () => {
    vi.useFakeTimers();
    // Same transient error, but the turn got far enough to run a tool, so
    // re-sending could repeat that tool's side effect.
    const { mock, promptCalls } = makeFlakyAgent({
      failures: 1,
      error: oauthRefreshFailed,
      beforeThrow: emitToolCall,
    });
    const session = makeSession({ agent: mock.agent, sessionId: "hydra_auth_3" });
    const client = makeClient();
    session.attach(client, "full");

    const pending = session.prompt(client.clientId, {
      prompt: [{ type: "text", text: "hi" }],
    });
    const assertion = expect(pending).rejects.toThrow("Failed to refresh OAuth token");
    await vi.advanceTimersByTimeAsync(TRANSIENT_AUTH_RETRY_MS);
    await assertion;
    expect(promptCalls()).toBe(1);
  });

  it("does not retry an unrelated prompt failure", async () => {
    vi.useFakeTimers();
    const { promptCalls, mock } = makeFlakyAgent({
      failures: 1,
      error: () => {
        const err = new Error("Internal error: rate limited") as Error & { code: number };
        err.code = JsonRpcErrorCodes.InternalError;
        return err;
      },
    });
    const session = makeSession({ agent: mock.agent, sessionId: "hydra_auth_4" });
    const client = makeClient();
    session.attach(client, "full");

    const pending = session.prompt(client.clientId, {
      prompt: [{ type: "text", text: "hi" }],
    });
    const assertion = expect(pending).rejects.toThrow("rate limited");
    await vi.advanceTimersByTimeAsync(TRANSIENT_AUTH_RETRY_MS);
    await assertion;
    expect(promptCalls()).toBe(1);
  });
});

describe("Session records the agent's error on turn_complete", () => {
  it("stores the prompt failure text verbatim", async () => {
    const { mock } = makeFlakyAgent({
      failures: 1,
      error: () => new Error("content flagged by provider"),
    });
    const session = makeSession({ agent: mock.agent, sessionId: "hydra_err_1" });
    const client = makeClient();
    session.attach(client, "full");

    await expect(
      session.prompt(client.clientId, { prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toThrow("content flagged by provider");

    const snap = await session.getHistorySnapshot();
    const turn = snap
      .map((e) => (e.params as { update?: Record<string, unknown> }).update)
      .find((u) => u?.sessionUpdate === "turn_complete");
    expect(turn).toMatchObject({
      stopReason: "error",
      errorMessage: "content flagged by provider",
    });
  });
});
