import { describe, it, expect, vi } from "vitest";
import { Session } from "./session.js";
import { HistoryStore } from "./history-store.js";
import { JsonRpcConnection } from "../acp/connection.js";
import {
  makeMockAgent,
  makeControlledStream,
} from "../__tests__/test-utils.js";

// Helper to create a client with controlled stream.
function makeClient(): {
  client: { clientId: string; connection: JsonRpcConnection };
  stream: ReturnType<typeof makeControlledStream>;
} {
  const stream = makeControlledStream();
  const conn = new JsonRpcConnection(stream);
  return {
    client: {
      clientId: `c_${Math.random().toString(36).slice(2, 8)}`,
      connection: conn,
    },
    stream,
  };
}

// Trigger a session/update notification via the mock agent and wait
// for it to be written to disk (recordAndBroadcast is fire-and-forget).
async function triggerUpdate(
  mock: ReturnType<typeof makeMockAgent>,
  update: Record<string, unknown>,
): Promise<void> {
  mock.triggerNotification("session/update", {
    sessionId: "agent-sess",
    update,
  });
  // Two setImmediates: one for the broadcast's pending appendFile to land,
  // one for the writeQueue.then() chain to settle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

function toolCallEntry(toolCallId: string, name = "read_file"): Record<string, unknown> {
  return { sessionUpdate: "tool_call", toolCallId, name, title: name };
}

function toolCallUpdateEntry(
  toolCallId: string,
  status: "completed" | "failed" | "in_progress",
): Record<string, unknown> {
  return { sessionUpdate: "tool_call_update", toolCallId, status };
}

function promptReceivedEntry(): Record<string, unknown> {
  return { sessionUpdate: "prompt_received" };
}

describe("Session.isQuiescedForSwap", () => {
  it("returns true for an idle session with no history", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_q1",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-q1",
      historyStore: store,
    });

    const result = await session.isQuiescedForSwap();
    expect(result).toBe(true);
  });

  it("returns true when history has only prompt_received (no tool calls)", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_q2",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-q2",
      historyStore: store,
    });

    await triggerUpdate(mock, promptReceivedEntry());

    const result = await session.isQuiescedForSwap();
    expect(result).toBe(true);
  });

  it("returns true when history has a completed tool call chain", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_q3",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-q3",
      historyStore: store,
    });

    await triggerUpdate(mock, promptReceivedEntry());
    await triggerUpdate(mock, toolCallEntry("tc-1", "read_file"));
    await triggerUpdate(mock, toolCallUpdateEntry("tc-1", "completed"));

    const result = await session.isQuiescedForSwap();
    expect(result).toBe(true);
  });

  it("returns true when history has a failed tool call chain", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_q4",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-q4",
      historyStore: store,
    });

    await triggerUpdate(mock, promptReceivedEntry());
    await triggerUpdate(mock, toolCallEntry("tc-2", "write_file"));
    await triggerUpdate(mock, toolCallUpdateEntry("tc-2", "failed"));

    const result = await session.isQuiescedForSwap();
    expect(result).toBe(true);
  });

  it("returns false when history has an open tool call (no terminal update)", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_q5",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-q5",
      historyStore: store,
    });

    await triggerUpdate(mock, promptReceivedEntry());
    await triggerUpdate(mock, toolCallEntry("tc-3", "edit_file"));
    // No terminal update — the tool call is still in progress.

    const result = await session.isQuiescedForSwap();
    expect(result).toBe(false);
  });

  it("returns false when history has an in_progress tool_call_update but no terminal status", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_q6",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-q6",
      historyStore: store,
    });

    await triggerUpdate(mock, promptReceivedEntry());
    await triggerUpdate(mock, toolCallEntry("tc-4", "run_command"));
    await triggerUpdate(mock, toolCallUpdateEntry("tc-4", "in_progress"));

    const result = await session.isQuiescedForSwap();
    expect(result).toBe(false);
  });

  it("returns true when history has multiple tool calls, all completed", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_q7",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-q7",
      historyStore: store,
    });

    await triggerUpdate(mock, promptReceivedEntry());
    await triggerUpdate(mock, toolCallEntry("tc-a", "read_file"));
    await triggerUpdate(mock, toolCallUpdateEntry("tc-a", "completed"));
    await triggerUpdate(mock, toolCallEntry("tc-b", "write_file"));
    await triggerUpdate(mock, toolCallUpdateEntry("tc-b", "completed"));

    const result = await session.isQuiescedForSwap();
    expect(result).toBe(true);
  });

  it("returns false when one of multiple tool calls is open", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_q8",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-q8",
      historyStore: store,
    });

    await triggerUpdate(mock, promptReceivedEntry());
    await triggerUpdate(mock, toolCallEntry("tc-c", "read_file"));
    await triggerUpdate(mock, toolCallUpdateEntry("tc-c", "completed"));
    await triggerUpdate(mock, toolCallEntry("tc-d", "edit_file"));
    // tc-d has no terminal update.

    const result = await session.isQuiescedForSwap();
    expect(result).toBe(false);
  });

  it("returns false during an in-flight prompt", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_q9",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-q9",
      historyStore: store,
    });

    // Use a deferred promise so the session/prompt request does not
    // resolve until we explicitly settle it — this keeps promptInFlight
    // true across our setImmediate yield.
    let promptResolve: () => void;
    const promptDeferred = new Promise<void>((r) => { promptResolve = r; });

    (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async (method: string, _params: unknown) => {
        if (method === "session/prompt") {
          await promptDeferred;
          return { stopReason: "end_turn" };
        }
        return undefined;
      },
    );

    const { client } = makeClient();
    session.attach(client, "full");

    // Start a prompt — this will set promptInFlight during drainQueue.
    const promptPromise = session.prompt(client.clientId, {
      prompt: [{ type: "text", text: "hello" }],
    });

    // Yield to let drainQueue pick up the entry and start runQueueEntry.
    // The deferred request keeps it in-flight.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const result = await session.isQuiescedForSwap();
    expect(result).toBe(false);

    // Clean up — resolve the deferred prompt so drainQueue finishes.
    promptResolve!();
    await promptPromise;
  });

  it("returns true after a completed tool call followed by text chunks", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_q10",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-q10",
      historyStore: store,
    });

    await triggerUpdate(mock, promptReceivedEntry());
    await triggerUpdate(mock, toolCallEntry("tc-10", "read_file"));
    await triggerUpdate(mock, toolCallUpdateEntry("tc-10", "completed"));
    await triggerUpdate(mock, { kind: "agent_message_chunk", content: { text: "done" } });

    const result = await session.isQuiescedForSwap();
    expect(result).toBe(true);
  });

  it("returns true when history has no tool_call entries at all", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_q11",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-q11",
      historyStore: store,
    });

    await triggerUpdate(mock, promptReceivedEntry());
    await triggerUpdate(mock, { kind: "agent_message_chunk", content: { text: "hello" } });

    const result = await session.isQuiescedForSwap();
    expect(result).toBe(true);
  });
});
