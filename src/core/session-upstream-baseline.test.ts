// A task whose end the agent never reports (opencode's backgrounded shell)
// is cleared only when the agent's own updatedAt moves past the value read
// at the last turn end, as the periodic agent sync observes it.
import { describe, it, expect, vi } from "vitest";
import { Session } from "./session.js";
import { HistoryStore } from "./history-store.js";
import { makeMockAgent } from "../__tests__/test-utils.js";

const BASELINE = "2026-10-16T07:29:12.502Z";
const LATER = "2026-10-16T07:40:00.000Z";

function makeSession(listResult: () => unknown) {
  const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
  const request = mock.agent.connection.request as unknown as ReturnType<
    typeof vi.fn
  >;
  request.mockImplementation(async (method: string) =>
    method === "session/list" ? listResult() : undefined
  );
  const session = new Session({
    sessionId: "hydra_session_ub",
    cwd: "/w",
    agentId: "mock",
    agent: mock.agent,
    upstreamSessionId: "u_agent",
    historyStore: new HistoryStore(),
  });
  return { mock, session };
}

async function trigger(
  mock: ReturnType<typeof makeMockAgent>,
  update: Record<string, unknown>,
): Promise<void> {
  mock.triggerNotification("session/update", {
    sessionId: "agent-sess",
    update,
  });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

const armOpencodeShell = {
  sessionUpdate: "tool_call_update",
  toolCallId: "tc-oc",
  status: "completed",
  title: "cmake --build out",
  rawInput: { command: "cmake --build out", background: true },
  rawOutput: { metadata: { status: "running", shellID: "sh_1" } },
};

const armClaudeBash = {
  sessionUpdate: "tool_call_update",
  toolCallId: "tc-claude",
  title: "Terminal",
  rawInput: { command: "ninja", description: "build", run_in_background: true },
};

async function endTurn(session: Session): Promise<void> {
  (session as unknown as {
    broadcastTurnComplete(c: string, r: unknown, m?: string): void;
  }).broadcastTurnComplete("some_client", { stopReason: "end_turn" }, "m_1");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

const listing = (updatedAt: string) => () => ({
  sessions: [
    { sessionId: "other", updatedAt: "2026-10-16T09:00:00.000Z" },
    { sessionId: "u_agent", updatedAt },
  ],
});

describe("Session.noteUpstreamUpdatedAt", () => {
  it("clears an end-unobservable task when the agent updated the session after the turn ended", async () => {
    const { mock, session } = makeSession(listing(BASELINE));
    await trigger(mock, armOpencodeShell);
    await endTurn(session);
    expect(session.armedBackgroundTasks).toHaveLength(1);

    session.noteUpstreamUpdatedAt(LATER);
    expect(session.armedBackgroundTasks).toEqual([]);
  });

  it("keeps the task when updatedAt has not moved", async () => {
    const { mock, session } = makeSession(listing(BASELINE));
    await trigger(mock, armOpencodeShell);
    await endTurn(session);

    session.noteUpstreamUpdatedAt(BASELINE);
    session.noteUpstreamUpdatedAt("2026-10-16T07:00:00.000Z");
    expect(session.armedBackgroundTasks).toHaveLength(1);
  });

  it("clears nothing when no baseline could be read", async () => {
    const { mock, session } = makeSession(() => {
      throw new Error("method not found");
    });
    await trigger(mock, armOpencodeShell);
    await endTurn(session);

    session.noteUpstreamUpdatedAt(LATER);
    expect(session.armedBackgroundTasks).toHaveLength(1);
  });

  it("clears nothing when the session is absent from the listing", async () => {
    const { mock, session } = makeSession(() => ({
      sessions: [{ sessionId: "other", updatedAt: BASELINE }],
    }));
    await trigger(mock, armOpencodeShell);
    await endTurn(session);

    session.noteUpstreamUpdatedAt(LATER);
    expect(session.armedBackgroundTasks).toHaveLength(1);
  });

  it("leaves tasks that report their own end alone", async () => {
    const { mock, session } = makeSession(listing(BASELINE));
    await trigger(mock, armClaudeBash);
    await endTurn(session);
    const listCalls = (mock.agent.connection.request as unknown as ReturnType<
      typeof vi.fn
    >).mock.calls.filter(([m]) => m === "session/list");
    expect(listCalls).toHaveLength(0);

    session.noteUpstreamUpdatedAt(LATER);
    expect(session.armedBackgroundTasks).toHaveLength(1);
  });

  it("ignores an update seen while an agent-initiated turn is open", async () => {
    const { mock, session } = makeSession(listing(BASELINE));
    await trigger(mock, armOpencodeShell);
    await endTurn(session);
    (session as unknown as { unsolicitedTurn: unknown }).unsolicitedTurn = {
      messageId: "m_u",
      startedAt: Date.now(),
    };

    session.noteUpstreamUpdatedAt(LATER);
    expect(session.armedBackgroundTasks).toHaveLength(1);
  });

  it("clears only the end-unobservable task when both kinds are armed", async () => {
    const { mock, session } = makeSession(listing(BASELINE));
    await trigger(mock, armClaudeBash);
    await trigger(mock, armOpencodeShell);
    await endTurn(session);

    session.noteUpstreamUpdatedAt(LATER);
    expect(session.armedBackgroundTasks.map((t) => t.toolCallId)).toEqual([
      "tc-claude",
    ]);
  });

  it("publishes endUnobservable on the armed list, and only for such tasks", async () => {
    const { mock, session } = makeSession(listing(BASELINE));
    await trigger(mock, armClaudeBash);
    await trigger(mock, armOpencodeShell);

    const byId = new Map(
      session.armedBackgroundTasks.map((t) => [t.toolCallId, t]),
    );
    expect(byId.get("tc-oc")?.endUnobservable).toBe(true);
    expect(byId.get("tc-claude")).not.toHaveProperty("endUnobservable");
  });
});
