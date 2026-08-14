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
import { Session, type AttachedClient } from "./session.js";
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
