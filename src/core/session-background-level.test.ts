// The background-task LEVEL signal, and why it outranks edge inference.
//
// Everything hydra knew about background tasks before this came from edges
// it happened to observe: a tool call carrying run_in_background, a
// resumption it could attribute, a TaskStop. Every one of those is an
// ADD or a guess. None of them can report that a job ENDED, because the
// completion notification never crosses the ACP wire at all — claude-acp
// injects it into the model's context and tells nobody.
//
// So the set could only drift upward. The observable bug: arm a background
// job, prompt again inside its runtime, and the completion is absorbed by
// the live turn. No resumption fires, nothing discharges the entry, and the
// session reports BUSY for the rest of its life. Measured in the wild at
// 2h43m on a `sleep 120`.
//
// claude-acp's SDK publishes `background_tasks_changed`: the full live set
// on every membership change, REPLACE semantics. Hydra subscribes to that
// one subtype via `emitRawSDKMessages` and mirrors it. Absence from a
// payload is the ending signal that never existed before.
//
// Shape verified live against claude-agent-acp 0.70.0 / claude-agent-sdk
// 0.3.232, both the from-source build and the stock published one:
//   +8.91s  level n=1  ba2dkbfdg[local_bash] "Sleep 20 seconds then echo done"
//   +11.90s turn ended
//   +28.91s level n=0  (empty)   <- ~10ms after the process actually exited
import { describe, it, expect, vi } from "vitest";
import { Session, type AttachedClient } from "./session.js";
import { HistoryStore } from "./history-store.js";
import { JsonRpcConnection } from "../acp/connection.js";
import { makeControlledStream, makeMockAgent } from "../__tests__/test-utils.js";

function makeSession(sessionId = "sess_lvl", upstream = "u_agent") {
  const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
  const session = new Session({
    sessionId,
    cwd: "/work",
    agentId: "mock",
    agent: mock.agent,
    upstreamSessionId: upstream,
    historyStore: new HistoryStore(),
  });
  return { session, mock };
}

function makeClient(clientId = "c_lvl"): AttachedClient {
  return { clientId, connection: new JsonRpcConnection(makeControlledStream()) };
}

type LevelTask = { task_id: string; task_type?: string; description?: string };

// One `background_tasks_changed` payload, as claude-acp forwards it through
// its raw-SDK passthrough.
function level(
  mock: ReturnType<typeof makeMockAgent>,
  tasks: LevelTask[],
): void {
  mock.triggerNotification("_claude/sdkMessage", {
    sessionId: "u_agent",
    message: {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: tasks.map((t) => ({
        task_id: t.task_id,
        task_type: t.task_type ?? "local_bash",
        description: t.description ?? "",
      })),
      uuid: "11111111-1111-1111-1111-111111111111",
      session_id: "u_agent",
    },
  });
}

// A backgrounded Bash as the EDGE stream reports it. This is the arming
// hydra can see; it is the ending it cannot.
function armViaEdge(
  mock: ReturnType<typeof makeMockAgent>,
  toolCallId = "toolu_bg",
  description = "gibbon rebuild",
): void {
  mock.triggerNotification("session/update", {
    sessionId: "u_agent",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId,
      title: "Terminal",
      rawInput: { command: "ninja", description, run_in_background: true },
    },
  });
}

async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("background-task level signal", () => {
  it("reports the agent's live set once a level arrives", () => {
    const { session, mock } = makeSession();
    level(mock, [
      { task_id: "bg_a", description: "Sleep 20 seconds then echo done" },
    ]);
    expect(session.armedBackgroundTasks).toMatchObject([
      { taskId: "bg_a", label: "Sleep 20 seconds then echo done", taskType: "local_bash" },
    ]);
    expect(session.armedSince).toBeGreaterThan(0);
  });

  // THE regression test. Reproduces the exact wild failure: a job ends while
  // the agent is busy with a user turn, so no resumption is available to
  // discharge it. Before the level, this session reported BUSY forever.
  it("clears a finished task even with a prompt in flight", async () => {
    const { session, mock } = makeSession();
    const client = makeClient();
    await session.attach(client, "none");

    armViaEdge(mock, "toolu_sleep", "Let ON arm accumulate compiles");
    level(mock, [{ task_id: "bzp0vr45k", description: "Let ON arm accumulate compiles" }]);
    expect(session.armedBackgroundTasks).toHaveLength(1);

    // A user turn is running when the job exits, which is precisely what
    // starves openUnsolicitedTurn of its trigger.
    (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        level(mock, []);
        return { stopReason: "end_turn" };
      },
    );
    await session.prompt(client.clientId, {
      sessionId: "sess_lvl",
      prompt: [{ type: "text", text: "unrelated question" }],
    });
    await settle();

    expect(session.armedBackgroundTasks).toEqual([]);
    expect(session.armedSince).toBeUndefined();
  });

  it("outranks a stale edge entry the old inference stranded", () => {
    const { session, mock } = makeSession();
    armViaEdge(mock, "toolu_ghost", "a job that already died");
    expect(session.armedBackgroundTasks).toHaveLength(1);
    // The agent says nothing is running. It owns the processes, so it wins.
    level(mock, []);
    expect(session.armedBackgroundTasks).toEqual([]);
    expect(session.armedSince).toBeUndefined();
  });

  it("holds the start time steady across unrelated membership changes", () => {
    const { session, mock } = makeSession();
    level(mock, [{ task_id: "bg_long" }]);
    const first = session.armedSince;
    expect(first).toBeGreaterThan(0);
    // A second job starting must not restage the first one's clock, or the
    // "running for" readout resets to zero on every unrelated change.
    level(mock, [{ task_id: "bg_long" }, { task_id: "bg_new" }]);
    expect(session.armedSince).toBe(first);
    expect(session.armedBackgroundTasks).toHaveLength(2);
  });

  it("falls back to edge inference for an agent that never sends a level", () => {
    const { session, mock } = makeSession();
    armViaEdge(mock, "toolu_oc", "opencode has no level");
    // No level has ever arrived, so the edge map is all there is and its
    // toolCallId attribution survives.
    expect(session.armedBackgroundTasks).toMatchObject([
      { toolCallId: "toolu_oc", label: "opencode has no level" },
    ]);
  });

  // Updating internal state is only half the job: a client that already
  // painted "◐ running" is push-driven and will keep painting it until the
  // daemon says otherwise. The ending has to reach the wire.
  it("tells attached clients when the level moves, including down to zero", () => {
    const { session, mock } = makeSession();
    const client = makeClient();
    const notify = vi.spyOn(client.connection, "notify").mockResolvedValue(undefined);
    void session.attach(client, "none");
    notify.mockClear();

    level(mock, [{ task_id: "bg_x", description: "long job" }]);
    level(mock, []);

    const armed = notify.mock.calls
      .filter(([method]) => method === "hydra-acp/session/armed_tasks_updated")
      .map(([, params]) => params as { count?: number });
    expect(armed.map((p) => p.count)).toEqual([1, 0]);
  });

  it("stays quiet when a level repeats the same membership", () => {
    const { session, mock } = makeSession();
    const client = makeClient();
    const notify = vi.spyOn(client.connection, "notify").mockResolvedValue(undefined);
    void session.attach(client, "none");
    level(mock, [{ task_id: "bg_same" }]);
    notify.mockClear();

    // A membership-neutral republish must not re-broadcast: the dedup key is
    // the id set plus `since`, and firstSeen is held steady, so this
    // collapses to no change rather than restarting every client's clock.
    level(mock, [{ task_id: "bg_same" }]);
    const armed = notify.mock.calls.filter(
      ([method]) => method === "hydra-acp/session/armed_tasks_updated",
    );
    expect(armed).toEqual([]);
  });

  it("ignores raw SDK messages of any other subtype", () => {
    const { session, mock } = makeSession();
    armViaEdge(mock, "toolu_keep", "still armed");
    mock.triggerNotification("_claude/sdkMessage", {
      sessionId: "u_agent",
      message: { type: "system", subtype: "commands_changed", commands: [] },
    });
    // Must not be mistaken for an empty level and clear the edge entry.
    expect(session.armedBackgroundTasks).toMatchObject([
      { toolCallId: "toolu_keep", label: "still armed" },
    ]);
  });

  it("stamps a per-task since from both sources", () => {
    const { session: edgeSession, mock: edgeMock } = makeSession("s_edge");
    armViaEdge(edgeMock, "toolu_a", "edge job");
    const edge = edgeSession.armedBackgroundTasks;
    expect(edge).toHaveLength(1);
    expect(typeof edge[0]!.since).toBe("number");

    const { session, mock } = makeSession("s_lvl");
    level(mock, [{ task_id: "bg_1", description: "level job" }]);
    const lvl = session.armedBackgroundTasks;
    expect(typeof lvl[0]!.since).toBe("number");
    // The aggregate must be the minimum of the per-entry stamps, or a client
    // rendering both would show a task older than the session's own clock.
    expect(session.armedSince).toBe(lvl[0]!.since);
  });

  it("broadcasts a same-size swap that leaves count and since unmoved", async () => {
    const { session, mock } = makeSession();
    const client = makeClient();
    const notify = vi.spyOn(client.connection, "notify").mockResolvedValue(undefined);
    void session.attach(client, "none");

    // A is the oldest and stays put, so `since` never moves. B leaves as C
    // arrives, so the count never moves either. Only membership changed.
    // A count-keyed dedup drops this silently and every client keeps
    // rendering the finished B while C stays invisible.
    level(mock, [{ task_id: "A" }, { task_id: "B" }]);
    notify.mockClear();
    level(mock, [{ task_id: "A" }, { task_id: "C" }]);

    const armed = notify.mock.calls.filter(
      ([method]) => method === "hydra-acp/session/armed_tasks_updated",
    );
    expect(armed).toHaveLength(1);
    const ids = (armed[0]![1] as { tasks: Array<{ taskId?: string }> }).tasks
      .map((t) => t.taskId)
      .sort();
    expect(ids).toEqual(["A", "C"]);
  });

  it("does not rebroadcast when only the payload's ordering changes", () => {
    const { session, mock } = makeSession();
    const client = makeClient();
    const notify = vi.spyOn(client.connection, "notify").mockResolvedValue(undefined);
    void session.attach(client, "none");
    level(mock, [{ task_id: "A" }, { task_id: "B" }]);
    notify.mockClear();

    // Neither source promises a stable iteration order, so a reshuffle is
    // not a change and must not restart every client's render.
    level(mock, [{ task_id: "B" }, { task_id: "A" }]);
    expect(
      notify.mock.calls.filter(
        ([method]) => method === "hydra-acp/session/armed_tasks_updated",
      ),
    ).toEqual([]);
  });
});
