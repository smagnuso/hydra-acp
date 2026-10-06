// Session's read state: turn ends move lastTurnEndedAt (pinning an unset
// readAt first), setRead moves readAt, and neither touches updatedAt.
import { describe, expect, it } from "vitest";
import { Session } from "./session.js";
import { HistoryStore } from "./history-store.js";
import type { SessionReadState } from "./read-state.js";
import { makeMockAgent } from "../__tests__/test-utils.js";

function makeSession(init: { createdAt?: number; lastTurnEndedAt?: number; readAt?: number } = {}) {
  const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
  return new Session({
    sessionId: "sess_read",
    cwd: "/work",
    agentId: "mock",
    agent: mock.agent,
    upstreamSessionId: "u_agent",
    historyStore: new HistoryStore(),
    ...init,
  });
}

function endTurn(session: Session): void {
  (session as unknown as {
    broadcastTurnComplete(originatorClientId: string, response: unknown, promptMessageId?: string): void;
  }).broadcastTurnComplete("some_client", { stopReason: "end_turn" }, "m_1");
}

function endUnsolicitedTurn(session: Session): void {
  const internals = session as unknown as {
    unsolicitedTurn: { messageId: string; startedAt: number } | undefined;
    closeUnsolicitedTurn(reason: "completed"): void;
  };
  internals.unsolicitedTurn = { messageId: "m_u", startedAt: Date.now() };
  internals.closeUnsolicitedTurn("completed");
}

describe("Session read state", () => {
  it("reads as read before any turn has ended", () => {
    const session = makeSession();
    expect(session.unread).toBe(false);
    expect(session.readAt).toBeUndefined();
  });

  it("pins an unset readAt to createdAt when the first turn ends, so that turn is unread", () => {
    const session = makeSession({ createdAt: 1_000 });
    endTurn(session);
    expect(session.readAt).toBe(1_000);
    expect(session.lastTurnEndedAt).toBeGreaterThan(1_000);
    expect(session.unread).toBe(true);
  });

  it("pins an unset readAt to the previous turn's end, from a record that predates readAt", () => {
    const session = makeSession({ createdAt: 1_000, lastTurnEndedAt: 5_000 });
    endTurn(session);
    expect(session.readAt).toBe(5_000);
    expect(session.unread).toBe(true);
  });

  it("counts a turn the agent started by itself", () => {
    const session = makeSession({ createdAt: 1_000 });
    endUnsolicitedTurn(session);
    expect(session.unread).toBe(true);
  });

  it("marks read and unread, notifying handlers without moving updatedAt", () => {
    const session = makeSession({ createdAt: 1_000 });
    endTurn(session);
    const seen: SessionReadState[] = [];
    session.onReadStateChange((state) => seen.push(state));
    const updatedAt = session.updatedAt;

    session.setRead(true);
    expect(session.unread).toBe(false);
    session.setRead(true);
    session.setRead(false);
    expect(session.unread).toBe(true);
    expect(session.readAt).toBe((session.lastTurnEndedAt ?? 0) - 1);

    expect(seen).toHaveLength(2);
    expect(session.updatedAt).toBe(updatedAt);
  });

  it("stays read through a turn that ends before the session is marked read again", () => {
    const session = makeSession({ createdAt: 1_000 });
    endTurn(session);
    session.setRead(true, (session.lastTurnEndedAt ?? 0) + 10_000);
    expect(session.unread).toBe(false);
  });
});
