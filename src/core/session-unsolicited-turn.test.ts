// Agent-initiated ("unsolicited") turns.
//
// Claude Code restarts itself when a background task finishes: it ends its
// turn, hydra's session/prompt resolves, and then the harness injects a
// synthetic <task-notification> and runs a whole new turn that no
// session/prompt asked for. claude-acp streams that turn as bare
// session/update notifications and emits no turn_complete when it ends.
//
// These cover the daemon-side compensation: turn content arriving with no
// prompt in flight opens a synthetic turn so the session stops reporting
// itself idle while the agent works.
import { describe, it, expect, vi, afterEach } from "vitest";
import { Session, armedTaskTtlMs, type AttachedClient } from "./session.js";
import { HistoryStore } from "./history-store.js";
import { JsonRpcConnection } from "../acp/connection.js";
import { makeControlledStream, makeMockAgent } from "../__tests__/test-utils.js";
import type { JsonRpcMessage } from "../acp/types.js";

function makeClient(): AttachedClient {
  return {
    clientId: `c_${Math.random().toString(36).slice(2, 8)}`,
    connection: new JsonRpcConnection(makeControlledStream()),
  };
}

function makeSession(sessionId = "sess_u", upstream = "u_agent") {
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

// Detection is gated on having seen a turn end, since the failure mode is
// the agent *resuming* after one. Most tests here therefore need a
// completed turn behind them before the interesting part starts.
async function makeSessionAfterOneTurn(): Promise<{
  session: Session;
  mock: ReturnType<typeof makeMockAgent>;
  client: AttachedClient;
  sent: JsonRpcMessage[];
}> {
  const { session, mock } = makeSession();
  const client = makeClient();
  await session.attach(client, "none");
  (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockResolvedValue({
    stopReason: "end_turn",
  });
  await session.prompt(client.clientId, {
    sessionId: "sess_u",
    prompt: [{ type: "text", text: "first turn" }],
  });
  await settleDrain();
  const sent: JsonRpcMessage[] = [];
  session.onBroadcast?.((entry) => {
    sent.push({ method: entry.method, params: entry.params } as JsonRpcMessage);
  });
  return { session, mock, client, sent };
}

// drainQueue resolves the caller's promise, then yields past the I/O phase
// before clearing promptInFlight in its finally. Anything asserting on
// post-turn state has to wait that out.
async function settleDrain(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// An ordinary piece of turn content, i.e. the kind of update that should
// only ever arrive inside a turn.
function agentChunk(
  mock: ReturnType<typeof makeMockAgent>,
  text = "working",
): void {
  mock.triggerNotification("session/update", {
    sessionId: "u_agent",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  });
}

function updatesOfKind(
  sent: ReadonlyArray<JsonRpcMessage>,
  kind: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const msg of sent) {
    if (!("method" in msg) || msg.method !== "session/update") continue;
    const params = msg.params as { update?: Record<string, unknown> } | undefined;
    if (params?.update?.sessionUpdate === kind) {
      out.push(params.update);
    }
  }
  return out;
}

function hydraMeta(update: Record<string, unknown>): Record<string, unknown> {
  const meta = update._meta as Record<string, unknown> | undefined;
  return (meta?.["hydra-acp"] as Record<string, unknown>) ?? {};
}

afterEach(() => {
  vi.useRealTimers();
});

describe("unsolicited turn detection", () => {
  it("opens a synthetic turn when turn content arrives with no prompt in flight", async () => {
    const { session, mock } = await makeSessionAfterOneTurn();
    expect(session.turnStartedAt).toBeUndefined();

    agentChunk(mock);

    expect(session.inUnsolicitedTurn).toBe(true);
    // The point of the whole exercise: the session reads BUSY, not idle.
    expect(session.turnStartedAt).toBeDefined();
  });

  it("ignores agent chatter before any turn has ended", () => {
    const { session, mock } = makeSession();
    agentChunk(mock);
    expect(session.inUnsolicitedTurn).toBe(false);
    expect(session.turnStartedAt).toBeUndefined();
  });

  it("broadcasts turn_started before the content that triggered it", async () => {
    const { session, mock, sent } = await makeSessionAfterOneTurn();

    agentChunk(mock);

    const kinds = sent
      .filter((m) => "method" in m && m.method === "session/update")
      .map((m) => {
        const p = (m as { params?: { update?: { sessionUpdate?: string } } }).params;
        return p?.update?.sessionUpdate;
      });
    expect(kinds).toEqual(["turn_started", "agent_message_chunk"]);

    const started = updatesOfKind(sent, "turn_started")[0]!;
    expect(hydraMeta(started).unsolicited).toBe(true);
  });

  it("does not open one for a turn hydra requested", async () => {
    const { session, mock } = makeSession();
    const client = makeClient();
    await session.attach(client, "none");
    let release: ((v: unknown) => void) | undefined;
    (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => {
        release = r;
      }),
    );
    const promptDone = session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "hi" }],
    });
    await new Promise((r) => setImmediate(r));

    agentChunk(mock);
    expect(session.inUnsolicitedTurn).toBe(false);

    release?.({ stopReason: "end_turn" });
    await promptDone;
  });

  it("does not open one for state-shaped updates", () => {
    const { session, mock } = makeSession();
    mock.triggerNotification("session/update", {
      sessionId: "u_agent",
      update: { sessionUpdate: "usage_update", used: 10, size: 100 },
    });
    mock.triggerNotification("session/update", {
      sessionId: "u_agent",
      update: { sessionUpdate: "current_mode_update", currentModeId: "default" },
    });
    expect(session.inUnsolicitedTurn).toBe(false);
    expect(session.turnStartedAt).toBeUndefined();
  });

  it("reports itself non-quiesced while one is open", async () => {
    const { session, mock } = await makeSessionAfterOneTurn();
    expect(session.isQuiescedSync()).toBe(true);
    agentChunk(mock);
    // Blocks the compaction swap and the transformer idle hook: swapping
    // the upstream out from under a working agent loses the work.
    expect(session.isQuiescedSync()).toBe(false);
    expect(await session.isQuiescedForSwap()).toBe(false);
  });
});

describe("unsolicited turn lifecycle", () => {
  it("closes after the silence deadline and reopens on later activity", async () => {
    const { session, mock, sent } = await makeSessionAfterOneTurn();
    vi.useFakeTimers();

    agentChunk(mock);
    expect(session.inUnsolicitedTurn).toBe(true);

    // Activity keeps pushing the deadline out.
    vi.advanceTimersByTime(60_000);
    agentChunk(mock, "still going");
    vi.advanceTimersByTime(60_000);
    expect(session.inUnsolicitedTurn).toBe(true);

    vi.advanceTimersByTime(31_000);
    expect(session.inUnsolicitedTurn).toBe(false);
    expect(session.turnStartedAt).toBeUndefined();

    const ended = updatesOfKind(sent, "turn_ended");
    expect(ended).toHaveLength(1);
    expect(hydraMeta(ended[0]!).reason).toBe("idle");
    expect(hydraMeta(ended[0]!).unsolicited).toBe(true);
    expect(ended[0]!.startedMessageId).toBe(
      updatesOfKind(sent, "turn_started")[0]!.messageId,
    );

    // A closed-too-early guess is self-healing: more content opens a fresh
    // turn rather than being swallowed.
    agentChunk(mock, "actually not done");
    expect(session.inUnsolicitedTurn).toBe(true);
    expect(updatesOfKind(sent, "turn_started")).toHaveLength(2);
  });

  it("never emits turn_complete, so clients' turn accounting is untouched", async () => {
    const { session, mock, sent } = await makeSessionAfterOneTurn();
    vi.useFakeTimers();
    agentChunk(mock);
    vi.advanceTimersByTime(120_000);
    expect(session.inUnsolicitedTurn).toBe(false);
    expect(updatesOfKind(sent, "turn_complete")).toHaveLength(0);
  });

  it("a requested prompt supersedes an open unsolicited turn", async () => {
    const { session, mock, client, sent } = await makeSessionAfterOneTurn();
    vi.useFakeTimers();

    agentChunk(mock);
    expect(session.inUnsolicitedTurn).toBe(true);

    // The prompt is held behind the running turn first (see the queue-hold
    // suite); let the quiet window lapse so it gets dispatched.
    const done = session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "hello" }],
    });
    await vi.advanceTimersByTimeAsync(50_000);
    await done;

    expect(session.inUnsolicitedTurn).toBe(false);
    const ended = updatesOfKind(sent, "turn_ended");
    expect(ended).toHaveLength(1);
    expect(hydraMeta(ended[0]!).reason).toBe("superseded");

    // turn_ended must land before prompt_received, so no client ever sees
    // two turns open at once.
    const order = sent
      .filter((m) => "method" in m && m.method === "session/update")
      .map((m) => {
        const p = (m as { params?: { update?: { sessionUpdate?: string } } }).params;
        return p?.update?.sessionUpdate;
      })
      .filter((k) => k === "turn_ended" || k === "prompt_received");
    expect(order).toEqual(["turn_ended", "prompt_received"]);
  });

  it("closes an open unsolicited turn when the session closes", async () => {
    const { session, mock, sent } = await makeSessionAfterOneTurn();
    agentChunk(mock);
    await session.close({ deleteRecord: false });

    const ended = updatesOfKind(sent, "turn_ended");
    expect(ended).toHaveLength(1);
    expect(hydraMeta(ended[0]!).reason).toBe("closed");
  });
});

// Layer 2: while the agent is mid-way through a turn it started by itself,
// promoting the next user prompt drops it onto a running agent. Hold it.
describe("queue hold during an unsolicited turn", () => {
  function queueEvents(
    sent: JsonRpcMessage[],
    method: string,
  ): Array<Record<string, unknown>> {
    return sent
      .filter((m) => "method" in m && m.method === method)
      .map((m) => (m as { params: Record<string, unknown> }).params);
  }

  // Queue notifications bypass recordAndBroadcast, so onBroadcast doesn't
  // see them; capture them off the attached client's stream instead.
  async function setup(): Promise<{
    session: Session;
    mock: ReturnType<typeof makeMockAgent>;
    client: AttachedClient;
    wire: JsonRpcMessage[];
  }> {
    const { session, mock } = makeSession();
    const stream = makeControlledStream();
    const client: AttachedClient = {
      clientId: `c_${Math.random().toString(36).slice(2, 8)}`,
      connection: new JsonRpcConnection(stream),
    };
    await session.attach(client, "none");
    (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockResolvedValue({
      stopReason: "end_turn",
    });
    await session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "first turn" }],
    });
    await settleDrain();
    return { session, mock, client, wire: stream.sent };
  }

  it("holds a prompt until the agent goes quiet, then dispatches it", async () => {
    const { session, mock, client, wire } = await setup();
    vi.useFakeTimers();
    agentChunk(mock);

    const done = session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "held one" }],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const held = queueEvents(wire, "hydra-acp/prompt_queue/held");
    expect(held).toHaveLength(1);
    expect(held[0]!.reason).toBe("agent_resumed");
    // Still waiting: the agent hasn't been quiet long enough.
    expect(queueEvents(wire, "hydra-acp/prompt_queue/released")).toHaveLength(0);

    // A long thinking pause must not release: claude-acp forwards no
    // thought chunks, so silence here is indistinguishable from finishing.
    await vi.advanceTimersByTimeAsync(40_000);
    agentChunk(mock, "back from thinking");
    await vi.advanceTimersByTimeAsync(40_000);
    expect(queueEvents(wire, "hydra-acp/prompt_queue/released")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(6_000);
    await done;
    const released = queueEvents(wire, "hydra-acp/prompt_queue/released");
    expect(released).toHaveLength(1);
    expect(released[0]!.reason).toBe("quiet");
  });

  it("gives up and dispatches at the cap when the agent never stops", async () => {
    const { session, mock, client, wire } = await setup();
    vi.useFakeTimers();
    agentChunk(mock);

    const done = session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "held one" }],
    });
    // A chatty agent: never quiet for 20s, so only the cap can end this.
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      agentChunk(mock, `chunk ${i}`);
    }
    await done;
    const released = queueEvents(wire, "hydra-acp/prompt_queue/released");
    expect(released).toHaveLength(1);
    expect(released[0]!.reason).toBe("cap");
    expect(released[0]!.heldMs as number).toBeGreaterThanOrEqual(180_000);
  });

  it("releases early when the turn closes on its own", async () => {
    const { session, mock, client, wire } = await setup();
    vi.useFakeTimers();
    agentChunk(mock);
    // Silence closes the unsolicited turn at 90s, but the quiet window is
    // shorter, so this releases on quiet well before that.
    const done = session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "held one" }],
    });
    await vi.advanceTimersByTimeAsync(50_000);
    await done;
    expect(queueEvents(wire, "hydra-acp/prompt_queue/released")[0]!.reason)
      .toBe("quiet");
    expect(session.inUnsolicitedTurn).toBe(false);
  });

  it("does not hold when no unsolicited turn is open", async () => {
    const { session, client, wire } = await setup();
    await session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "ordinary" }],
    });
    expect(queueEvents(wire, "hydra-acp/prompt_queue/held")).toHaveLength(0);
  });

  it("leaves a held prompt cancellable", async () => {
    const { session, mock, client, wire } = await setup();
    vi.useFakeTimers();
    agentChunk(mock);

    const done = session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "never mind" }],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const held = queueEvents(wire, "hydra-acp/prompt_queue/held");
    expect(held).toHaveLength(1);

    // The entry is still in the queue while held, so a bored user can pull
    // it back rather than being stuck watching a chip they can't touch.
    const messageId = held[0]!.messageId as string;
    expect(session.cancelQueuedPrompt(messageId)).toMatchObject({
      cancelled: true,
    });
    // The hold notices promptly rather than sitting out the whole quiet
    // window; otherwise the queue stays shut behind a dead entry.
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(done).resolves.toMatchObject({ stopReason: "cancelled" });
    expect(queueEvents(wire, "hydra-acp/prompt_queue/released")[0]!.reason)
      .toBe("cancelled");
  });
});

// The third session state: the agent handed the turn back and is idle,
// but a watch it started is still pending, so it can restart itself.
describe("armed background tasks", () => {
  async function armDuringTurn(
    arming: Record<string, unknown>,
  ): Promise<{
    session: Session;
    mock: ReturnType<typeof makeMockAgent>;
    client: AttachedClient;
  }> {
    const { session, mock, client } = await makeSessionAfterOneTurn();
    (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        mock.triggerNotification("session/update", {
          sessionId: "u_agent",
          update: arming,
        });
        return { stopReason: "end_turn" };
      },
    );
    await session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "kick off a build" }],
    });
    await settleDrain();
    return { session, mock, client };
  }

  it("counts a backgrounded Bash after the turn hands back", async () => {
    const { session } = await armDuringTurn({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_bg",
      title: "Terminal",
      rawInput: { command: "ninja", description: "gibbon rebuild", run_in_background: true },
    });
    // Idle, but not finished.
    expect(session.turnStartedAt).toBeUndefined();
    expect(session.armedBackgroundTasks).toEqual([
      { label: "gibbon rebuild" },
    ]);
  });

  it("keeps a task id that a later update does not repeat", async () => {
    // The id and the backgrounded-ness arrive on different updates:
    // Monitor reports a taskId, Bash reports run_in_background, and
    // either can come first. Re-arming rebuilds the entry from the
    // current update alone, so an id already learned has to be carried
    // forward or a later plain progress update erases it, and with it
    // the only handle TaskStop has on the job.
    // All three inside ONE turn. Delivered afterwards they would each
    // open an unsolicited turn, whose attribution clears the armed entry,
    // and the test would be measuring that instead.
    const { session, mock } = makeSession();
    const client: AttachedClient = {
      clientId: "c_mixed",
      connection: new JsonRpcConnection(makeControlledStream()),
    };
    await session.attach(client, "none");
    (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        const metas: Array<Record<string, unknown> | undefined> = [
          undefined,
          { toolResponse: { taskId: "bg_1" } },
          undefined,
        ];
        for (const [i, meta] of metas.entries()) {
          mock.triggerNotification("session/update", {
            sessionId: "u_agent",
            update: {
              sessionUpdate: i === 0 ? "tool_call" : "tool_call_update",
              toolCallId: "toolu_mixed",
              title: "Terminal",
              rawInput: { command: "ninja", run_in_background: true },
              ...(meta !== undefined ? { _meta: { claudeCode: meta } } : {}),
            },
          });
        }
        return { stopReason: "end_turn" };
      },
    );
    await session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "kick off a build" }],
    });
    await settleDrain();

    expect(session.armedBackgroundTasks).toEqual([
      { label: "Terminal", taskId: "bg_1" },
    ]);
  });

  it("counts a Monitor and carries its taskId", async () => {
    const { session } = await armDuringTurn({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_mon",
      title: "Monitor",
      _meta: {
        claudeCode: { toolResponse: { taskId: "bgzem17m0", timeoutMs: 2400000 } },
      },
    });
    expect(session.armedBackgroundTasks).toEqual([
      { label: "Monitor", taskId: "bgzem17m0" },
    ]);
  });

  it("stops counting one once the agent wakes up for it", async () => {
    const { session, mock } = await armDuringTurn({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_bg",
      title: "Terminal",
      rawInput: { command: "ninja", run_in_background: true },
    });
    expect(session.armedBackgroundTasks).toHaveLength(1);
    agentChunk(mock, "build finished");
    expect(session.inUnsolicitedTurn).toBe(true);
    expect(session.armedBackgroundTasks).toHaveLength(0);
  });

  // Verbatim shape of sZNwrE44KnLbCN0u, which showed a false BUSY for 28
  // minutes: a job backgrounded first, then a Monitor armed to watch it, so
  // the resumption could only be attributed to the Monitor. Clearing just
  // the attributed one stranded the job entry until its 30-minute TTL,
  // because lastBackgroundTask only holds the most recent arming.
  it("clears a task the resumption could not be attributed to", async () => {
    const { session, mock, client } = await makeSessionAfterOneTurn();
    (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        // The job.
        mock.triggerNotification("session/update", {
          sessionId: "u_agent",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "toolu_vitest",
            title: "Terminal",
            rawInput: {
              command: "vitest run",
              description: "Run the full test suite",
              run_in_background: true,
            },
          },
        });
        // Then a Monitor watching for it, which overwrites the attribution
        // slot and makes the job entry unreachable.
        mock.triggerNotification("session/update", {
          sessionId: "u_agent",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "toolu_monitor",
            title: "Monitor",
            _meta: {
              claudeCode: {
                toolResponse: { taskId: "bnrcts5np", timeoutMs: 900_000 },
              },
            },
          },
        });
        return { stopReason: "end_turn" };
      },
    );
    await session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "run the suite in the background" }],
    });
    await settleDrain();
    expect(session.armedBackgroundTasks).toHaveLength(2);

    agentChunk(mock, "suite finished, 4794 passing");
    expect(session.inUnsolicitedTurn).toBe(true);
    // Both gone, not just the Monitor.
    expect(session.armedBackgroundTasks).toEqual([]);
    expect(session.armedSince).toBeUndefined();
  });

  // Real timers on purpose. Expiry is timer-driven now rather than swept
  // on read, so a task armed before vi.useFakeTimers() has already
  // scheduled a real timeout that advanceTimersByTime will never fire.
  // A short real timeoutMs exercises the actual path in ~80ms.
  it("expires on the agent's own timeout so the badge can't stick", async () => {
    const { session } = await armDuringTurn({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_mon",
      title: "Monitor",
      _meta: { claudeCode: { toolResponse: { taskId: "t1", timeoutMs: 50 } } },
    });
    expect(session.armedBackgroundTasks).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 120));
    expect(session.armedBackgroundTasks).toHaveLength(0);
    expect(session.armedSince).toBeUndefined();
  });

  it("pushes armed_tasks_updated on arm and again on expiry", async () => {
    const { session, mock } = makeSession();
    const stream = makeControlledStream();
    const client: AttachedClient = {
      clientId: "c_armed",
      connection: new JsonRpcConnection(stream),
    };
    await session.attach(client, "none");
    (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        mock.triggerNotification("session/update", {
          sessionId: "u_agent",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "toolu_mon",
            title: "Monitor",
            rawInput: { description: "device run" },
            _meta: {
              claudeCode: { toolResponse: { taskId: "t1", timeoutMs: 50 } },
            },
          },
        });
        return { stopReason: "end_turn" };
      },
    );
    await session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "start it" }],
    });
    await settleDrain();
    await new Promise((r) => setTimeout(r, 120));

    const pushes = stream.sent
      .filter(
        (m) =>
          "method" in m && m.method === "hydra-acp/session/armed_tasks_updated",
      )
      .map((m) => (m as { params: Record<string, unknown> }).params);
    // Armed, then gone. The second one is the whole point: a user who
    // walked away has to learn the job they were told about is over.
    expect(pushes.map((p) => p.count)).toEqual([1, 0]);
    expect(typeof pushes[0]!.since).toBe("number");
    expect(pushes[1]!.since).toBeUndefined();
  });

  // One tool call emits several updates on the wire (a real Monitor sent
  // seven), and each carries the arming signal. Re-arming an entry already
  // counted leaves count and since unchanged, so clients must hear it once.
  it("pushes once when one tool call arms across several updates", async () => {
    const { session, mock } = makeSession();
    const stream = makeControlledStream();
    const client: AttachedClient = {
      clientId: "c_dedup",
      connection: new JsonRpcConnection(stream),
    };
    await session.attach(client, "none");
    (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        for (let i = 0; i < 3; i++) {
          mock.triggerNotification("session/update", {
            sessionId: "u_agent",
            update: {
              sessionUpdate: i === 0 ? "tool_call" : "tool_call_update",
              toolCallId: "toolu_bg",
              title: "Terminal",
              rawInput: { command: "ninja", run_in_background: true },
            },
          });
        }
        return { stopReason: "end_turn" };
      },
    );
    await session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "build it" }],
    });
    await settleDrain();

    const pushes = stream.sent.filter(
      (m) =>
        "method" in m && m.method === "hydra-acp/session/armed_tasks_updated",
    );
    expect(pushes).toHaveLength(1);
    expect(session.armedBackgroundTasks).toHaveLength(1);
  });

  it("pushes once even when the clock ticks between updates", async () => {
    // The deterministic form of the test above, which was flaky rather
    // than wrong: three updates for one tool call, but with the clock
    // advancing between them.
    //
    // Nothing here races. The loop is synchronous and single threaded, so
    // the only varying input was Date.now(). Arming used to overwrite
    // armedAt on every update, and the dedup key includes armedSince, so
    // whether the updates coalesced depended on whether they landed
    // inside the same millisecond. Fast machine, one push; loaded
    // machine, one push per update. Forcing the tick makes the bug
    // reproduce every time.
    const { session, mock } = makeSession();
    const stream = makeControlledStream();
    const client: AttachedClient = {
      clientId: "c_tick",
      connection: new JsonRpcConnection(stream),
    };
    await session.attach(client, "none");

    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      clock += 25;
      return clock;
    });
    try {
      (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          for (let i = 0; i < 3; i++) {
            mock.triggerNotification("session/update", {
              sessionId: "u_agent",
              update: {
                sessionUpdate: i === 0 ? "tool_call" : "tool_call_update",
                toolCallId: "toolu_tick",
                title: "Terminal",
                rawInput: { command: "ninja", run_in_background: true },
              },
            });
          }
          return { stopReason: "end_turn" };
        },
      );
      await session.prompt(client.clientId, {
        sessionId: "sess_u",
        prompt: [{ type: "text", text: "build it" }],
      });
      await settleDrain();
    } finally {
      nowSpy.mockRestore();
    }

    const pushes = stream.sent.filter(
      (m) => "method" in m && m.method === "hydra-acp/session/armed_tasks_updated",
    );
    expect(pushes).toHaveLength(1);
    // And the elapsed clock still reads from when the job STARTED. This is
    // the user-visible half: a task reporting progress for minutes must
    // not keep looking like it just began.
    const since = (pushes[0] as { params?: { since?: number } }).params?.since;
    expect(session.armedSince).toBe(since);
  });

  // A real TaskStop happens INSIDE a turn (the agent decides to cancel a
  // watch while working), not as unsolicited activity. Delivering it out
  // of turn would open an unsolicited turn, whose own attribution clears
  // the armed entry, and the test would pass without exercising TaskStop
  // at all.
  async function stopDuringTurn(
    session: Session,
    mock: ReturnType<typeof makeMockAgent>,
    client: AttachedClient,
    taskId: string,
  ): Promise<void> {
    (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        mock.triggerNotification("session/update", {
          sessionId: "u_agent",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "toolu_stop",
            title: "TaskStop",
            rawInput: { task_id: taskId },
            _meta: { claudeCode: { toolName: "TaskStop" } },
          },
        });
        return { stopReason: "end_turn" };
      },
    );
    await session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "never mind, stop that" }],
    });
    await settleDrain();
  }

  it("stops counting one the agent explicitly kills with TaskStop", async () => {
    const { session, mock, client } = await armDuringTurn({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_mon",
      title: "Monitor",
      _meta: { claudeCode: { toolResponse: { taskId: "bk8zd9dly" } } },
    });
    expect(session.armedBackgroundTasks).toHaveLength(1);
    await stopDuringTurn(session, mock, client, "bk8zd9dly");
    expect(session.armedBackgroundTasks).toHaveLength(0);
  });

  // A backgrounded Bash never sets toolResponse.taskId; its id exists only
  // in the rawOutput prose. Before that was parsed, such an entry carried no
  // id and TaskStop could never match it, so this path was dead for the
  // commonest kind of background task. rawOutput here is verbatim.
  it("clears a backgrounded Bash via TaskStop, keyed off its rawOutput id", async () => {
    const { session, mock, client } = await armDuringTurn({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_bg",
      title: "Terminal",
      status: "completed",
      rawInput: { command: "vitest run", run_in_background: true },
      rawOutput:
        "Command running in background with ID: b17okg6jd. Output is being " +
        "written to: /tmp/claude-1000/-home-smagnuson/tasks/b17okg6jd.output",
    });
    expect(session.armedBackgroundTasks).toEqual([
      { label: "Terminal", taskId: "b17okg6jd" },
    ]);
    await stopDuringTurn(session, mock, client, "b17okg6jd");
    expect(session.armedBackgroundTasks).toHaveLength(0);
  });

  it("ignores a TaskStop for some other task", async () => {
    const { session, mock, client } = await armDuringTurn({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_mon",
      title: "Monitor",
      _meta: { claudeCode: { toolResponse: { taskId: "keep_me" } } },
    });
    await stopDuringTurn(session, mock, client, "someone_else");
    expect(session.armedBackgroundTasks).toHaveLength(1);
  });

  // The agent's own timeoutMs answers "how long might this watch run", not
  // "how long should we keep claiming a wakeup is coming". A job killed by a
  // bare pkill produces no TaskStop and no notification, so the ceiling is
  // the only thing that ever clears it.
  it("caps a long agent timeout, honours a short one, defaults when absent", () => {
    // An hour was asked for; 15 minutes is the most we honour.
    expect(armedTaskTtlMs(60 * 60 * 1000)).toBe(15 * 60 * 1000);
    expect(armedTaskTtlMs(90_000)).toBe(90_000);
    // No timeout reported (every backgrounded Bash): default, itself capped.
    expect(armedTaskTtlMs(undefined)).toBe(15 * 60 * 1000);
    // Junk from the wire falls back rather than producing a NaN deadline.
    expect(armedTaskTtlMs(0)).toBe(15 * 60 * 1000);
    expect(armedTaskTtlMs(-5)).toBe(15 * 60 * 1000);
    expect(armedTaskTtlMs("900000")).toBe(15 * 60 * 1000);
  });

  it("does not count ordinary foreground tool calls", async () => {
    const { session } = await armDuringTurn({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_fg",
      title: "Terminal",
      rawInput: { command: "ls" },
    });
    expect(session.armedBackgroundTasks).toEqual([]);
  });
});

describe("unsolicited turn attribution", () => {
  // The real sequence: the agent arms a background task inside a turn
  // hydra asked for, that turn ends legitimately, and the agent then wakes
  // itself up when the task finishes. The resumption should say what woke
  // it rather than appearing from nowhere.
  async function armThenResume(
    arming: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>> {
    const { session, mock, client, sent } = await makeSessionAfterOneTurn();

    (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        mock.triggerNotification("session/update", {
          sessionId: "u_agent",
          update: arming,
        });
        return { stopReason: "end_turn" };
      },
    );
    await session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "kick off a build" }],
    });
    await settleDrain();
    expect(session.inUnsolicitedTurn).toBe(false);

    agentChunk(mock, "build finished");
    return updatesOfKind(sent, "turn_started");
  }

  it("labels the turn with a backgrounded Bash", async () => {
    const started = await armThenResume({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_bg1",
      title: "Terminal",
      rawInput: {
        command: "ninja -C build",
        description: "gibbon rebuild",
        run_in_background: true,
      },
    });
    expect(started).toHaveLength(1);
    expect(hydraMeta(started[0]!).cause).toEqual({
      toolCallId: "toolu_bg1",
      label: "gibbon rebuild",
    });
  });

  // Regression, from a live resumption that came out as "background task".
  // A Monitor reports its taskId on a late, sparse update carrying neither
  // title nor rawInput; the description arrived earlier under the same
  // toolCallId. Reading only the arming update loses it.
  it("borrows a Monitor's description from its earlier updates", async () => {
    const { session, mock, client, sent } = await makeSessionAfterOneTurn();
    (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        // Verbatim shape of the 17:01:40-17:01:42 sequence on the wire.
        for (const update of [
          {
            sessionUpdate: "tool_call",
            toolCallId: "toolu_mon",
            title: "Monitor",
            _meta: { claudeCode: { toolName: "Monitor" } },
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "toolu_mon",
            title: "Monitor",
            rawInput: { description: "validation harness completion" },
            _meta: { claudeCode: { toolName: "Monitor" } },
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "toolu_mon",
            _meta: {
              claudeCode: {
                toolName: "Monitor",
                toolResponse: { taskId: "bgzem17m0", timeoutMs: 2400000 },
              },
            },
          },
        ]) {
          mock.triggerNotification("session/update", {
            sessionId: "u_agent",
            update,
          });
        }
        return { stopReason: "end_turn" };
      },
    );
    await session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "start the validation run" }],
    });
    await settleDrain();

    agentChunk(mock, "validation runs complete");
    const started = updatesOfKind(sent, "turn_started");
    expect(started).toHaveLength(1);
    expect(hydraMeta(started[0]!).cause).toEqual({
      toolCallId: "toolu_mon",
      label: "validation harness completion",
    });
  });

  it("labels the turn with a Monitor, keyed off its taskId", async () => {
    const started = await armThenResume({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_mon1",
      title: "Monitor",
      _meta: { claudeCode: { toolResponse: { taskId: "b43a9f8fv" } } },
    });
    expect(started).toHaveLength(1);
    // No description on this shape, so it falls back to the tool title.
    expect(hydraMeta(started[0]!).cause).toEqual({
      toolCallId: "toolu_mon1",
      label: "Monitor",
    });
  });

  it("omits the cause when no background task was ever armed", async () => {
    const started = await armThenResume({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_fg1",
      title: "Terminal",
      rawInput: { command: "ls" },
    });
    expect(started).toHaveLength(1);
    expect(hydraMeta(started[0]!).cause).toBeUndefined();
  });
});
