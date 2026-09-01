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

// A backgrounded Bash arming, as the edge stream reports it: a
// tool_call_update carrying rawInput.run_in_background.
function armBackgroundBashEntry(
  toolCallId: string,
  description = "long build",
): Record<string, unknown> {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    title: "Terminal",
    rawInput: { command: "ninja", description, run_in_background: true },
  };
}

// A Monitor (repeating watch) arming, as the edge stream reports it: the
// taskId rides _meta.claudeCode.toolResponse rather than rawInput.
function armMonitorEntry(
  toolCallId: string,
  taskId: string,
): Record<string, unknown> {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    title: "Monitor",
    _meta: { claudeCode: { toolName: "Monitor", toolResponse: { taskId } } },
  };
}

function backgroundTasksChangedLevel(
  tasks: Array<{ task_id: string; task_type?: string; description?: string }>,
): Record<string, unknown> {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: tasks.map((t) => ({
      task_id: t.task_id,
      task_type: t.task_type ?? "local_bash",
      description: t.description ?? "",
    })),
    uuid: "11111111-1111-1111-1111-111111111111",
    session_id: "agent-sess",
  };
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

describe("Session.quiesceBlocker", () => {
  it("names the open tool call rather than claiming the agent is working", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_qb1",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-qb1",
      historyStore: store,
    });

    await triggerUpdate(mock, promptReceivedEntry());
    await triggerUpdate(mock, toolCallEntry("tc-orphan", "read_file"));

    const blocker = await session.quiesceBlocker();
    // The distinction is the whole point: an orphaned chain is not a turn
    // in flight, and telling the user to wait for one is what made this
    // refusal read as a bug.
    expect(blocker).toContain("never reported a result");
    expect(blocker).not.toContain("still working");
  });

  it("returns undefined when nothing is blocking", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_qb2",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-qb2",
      historyStore: store,
    });

    await triggerUpdate(mock, promptReceivedEntry());
    await triggerUpdate(mock, toolCallEntry("tc-1", "read_file"));
    await triggerUpdate(mock, toolCallUpdateEntry("tc-1", "completed"));

    expect(await session.quiesceBlocker()).toBeUndefined();
  });
});

describe("Session.isQuiescedForSwap and pending one-shot background tasks", () => {
  it("blocks a swap while an edge-armed backgrounded Bash is still live", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_qbg1",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-qbg1",
      historyStore: store,
    });

    await triggerUpdate(mock, promptReceivedEntry());
    await triggerUpdate(mock, armBackgroundBashEntry("tc-bg1", "ninja rebuild"));

    expect(await session.isQuiescedForSwap()).toBe(false);
    const blocker = await session.quiesceBlocker();
    expect(blocker).toContain("ninja rebuild");
  });

  it("does not block a swap for a repeating Monitor watch, edge-sourced", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_qbg2",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-qbg2",
      historyStore: store,
    });

    await triggerUpdate(mock, promptReceivedEntry());
    await triggerUpdate(mock, armMonitorEntry("tc-mon1", "task-1"));

    // A repeating watch never discharges on its own, so gating on it would
    // stall a swap forever; it must not be a quiesce blocker.
    expect(await session.isQuiescedForSwap()).toBe(true);
  });

  it("blocks a swap while a level-sourced local_bash task is live", () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_qbg3",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-qbg3",
      historyStore: store,
    });

    mock.triggerNotification("_claude/sdkMessage", {
      sessionId: "u-qbg3",
      message: backgroundTasksChangedLevel([
        { task_id: "bg1", description: "sleep 20 then echo done" },
      ]),
    });

    return session.isQuiescedForSwap().then((quiesced) => {
      expect(quiesced).toBe(false);
    });
  });

  it("does not block a swap for an unrecognized level task_type", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_qbg4",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-qbg4",
      historyStore: store,
    });

    mock.triggerNotification("_claude/sdkMessage", {
      sessionId: "u-qbg4",
      message: backgroundTasksChangedLevel([
        { task_id: "bg1", task_type: "device_watch", description: "watching device" },
      ]),
    });

    // Only "local_bash" is verified one-shot; an unrecognized type (which
    // covers a real repeating Monitor whose level-layer type is unknown)
    // must fail open rather than risk stalling a swap forever.
    expect(await session.isQuiescedForSwap()).toBe(true);
  });

  it("unparks a swap waiter the moment the one-shot task discharges via TaskStop", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_qbg5",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-qbg5",
      historyStore: store,
    });

    await triggerUpdate(mock, promptReceivedEntry());
    await triggerUpdate(mock, armBackgroundBashEntry("tc-bg5", "long test run"));
    expect(await session.isQuiescedForSwap()).toBe(false);

    let fired = false;
    session.onceIdle(() => {
      fired = true;
    });
    // isQuiescedSync (onceIdle's cheap gate) doesn't look at background
    // tasks, so it already reads idle here; onceIdle only fires because
    // dispatchIdle is invoked, which callers re-verify via the strong
    // isQuiescedForSwap check before acting on.
    expect(fired).toBe(false);

    // TaskStop reports the id it cancelled via rawInput.task_id, matched
    // against the id harvested at arming time. Backgrounded Bash carries
    // its id in rawOutput prose rather than toolResponse.
    await triggerUpdate(mock, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-bg5",
      rawOutput: "Command running in background with ID: bashid123",
    });
    await triggerUpdate(mock, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-taskstop",
      title: "TaskStop",
      rawInput: { task_id: "bashid123" },
    });

    expect(fired).toBe(true);
    expect(await session.isQuiescedForSwap()).toBe(true);
  });
});

describe("cancelled turns close their own tool chain", () => {
  it("marks an abandoned tool call failed and leaves the session quiesced", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_qc1",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-qc1",
      historyStore: store,
    });
    const { client } = makeClient();
    await session.attach(client, "none");

    // A turn that fires a tool and is then interrupted: the agent owes no
    // terminal update for the call it abandoned, which is exactly the
    // shape that used to strand the chain.
    (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async (method: string) => {
        if (method !== "session/prompt") {
          return undefined;
        }
        mock.triggerNotification("session/update", {
          sessionId: "agent-sess",
          update: toolCallEntry("tc-cancelled", "execute"),
        });
        await new Promise((r) => setImmediate(r));
        return { stopReason: "cancelled" };
      },
    );

    await session.prompt(client.clientId, {
      sessionId: "hydra_session_qc1",
      prompt: [{ type: "text", text: "run something long" }],
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const history = await store.load("hydra_session_qc1");
    const terminal = history.filter((e) => {
      const u = (e.params as { update?: { sessionUpdate?: string; toolCallId?: string; status?: string } })
        .update;
      return (
        u?.sessionUpdate === "tool_call_update" &&
        u.toolCallId === "tc-cancelled" &&
        u.status === "failed"
      );
    });
    expect(terminal).toHaveLength(1);
    expect(await session.isQuiescedForSwap()).toBe(true);
  });

  it("lets ^C close a chain already stranded by an earlier turn", async () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_session_qc2",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u-qc2",
      historyStore: store,
    });
    const { client } = makeClient();
    await session.attach(client, "none");

    await triggerUpdate(mock, toolCallEntry("tc-stranded", "execute"));
    expect(await session.isQuiescedForSwap()).toBe(false);

    // Nothing is in flight, so the keystroke has no turn to interrupt.
    // Closing the orphan is the only thing left for it to do, and without
    // it the refusal has no user-side remedy at all.
    await session.cancel(client.clientId);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(await session.isQuiescedForSwap()).toBe(true);
  });
});
