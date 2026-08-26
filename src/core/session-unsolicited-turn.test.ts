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
import {
  Session,
  isRepeatingArming,
  type AttachedClient,
} from "./session.js";
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

// The notification that authoritatively ends a cycle: claude-acp emits a
// usage_update at every SDK `result` and stamps it with the lane that
// produced it. An autonomous kind is "the model finished something it
// started on its own".
//
// Shape verified on the live wire against claude-acp 0.69.0 /
// claude-agent-sdk 0.3.232:
//   _meta={"_claude/origin":{"kind":"task-notification"}}
function autonomousTerminal(
  mock: ReturnType<typeof makeMockAgent>,
  kind = "task-notification",
): void {
  mock.triggerNotification("session/update", {
    sessionId: "u_agent",
    update: {
      sessionUpdate: "usage_update",
      used: 4321,
      _meta: { "_claude/origin": { kind } },
    },
  });
}

// The same carrier for a turn the user asked for. Observed as
// {"kind":"human"} on every user turn's terminal, and it must never end an
// agent-initiated turn.
function humanTerminal(mock: ReturnType<typeof makeMockAgent>): void {
  autonomousTerminal(mock, "human");
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
    expect(kinds).toEqual(["_hydra_turn_started", "agent_message_chunk"]);

    const started = updatesOfKind(sent, "_hydra_turn_started")[0]!;
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
  // No fake timers anywhere in this suite, deliberately: nothing about an
  // unsolicited turn's lifetime is time-based any more. It ends when the
  // agent says it has.
  it("closes on the agent's terminal signal, and reopens on later activity", async () => {
    const { session, mock, sent } = await makeSessionAfterOneTurn();

    agentChunk(mock);
    expect(session.inUnsolicitedTurn).toBe(true);

    // Content alone never ends it, however much of it arrives. The old
    // silence deadline made this a race against the clock; now it isn't one.
    agentChunk(mock, "still going");
    agentChunk(mock, "and more");
    expect(session.inUnsolicitedTurn).toBe(true);

    autonomousTerminal(mock);
    expect(session.inUnsolicitedTurn).toBe(false);
    expect(session.turnStartedAt).toBeUndefined();

    const ended = updatesOfKind(sent, "_hydra_turn_ended");
    expect(ended).toHaveLength(1);
    expect(hydraMeta(ended[0]!).reason).toBe("completed");
    expect(hydraMeta(ended[0]!).unsolicited).toBe(true);
    expect(ended[0]!.startedMessageId).toBe(
      updatesOfKind(sent, "_hydra_turn_started")[0]!.messageId,
    );

    // A second background task wakes it again: fresh turn, not a resumption
    // of the closed one.
    agentChunk(mock, "woken again");
    expect(session.inUnsolicitedTurn).toBe(true);
    expect(updatesOfKind(sent, "_hydra_turn_started")).toHaveLength(2);
  });

  it("does not end on a user-lane terminal", async () => {
    const { session, mock, sent } = await makeSessionAfterOneTurn();
    agentChunk(mock);
    expect(session.inUnsolicitedTurn).toBe(true);

    // {"kind":"human"} terminates the user's own turns and rides the same
    // carrier. Treating it as an end signal would close every agent-initiated
    // turn the moment any user turn finished.
    humanTerminal(mock);
    expect(session.inUnsolicitedTurn).toBe(true);
    expect(updatesOfKind(sent, "_hydra_turn_ended")).toHaveLength(0);

    autonomousTerminal(mock);
    expect(session.inUnsolicitedTurn).toBe(false);
  });

  it("ignores a usage_update carrying no origin at all", async () => {
    const { session, mock } = await makeSessionAfterOneTurn();
    agentChunk(mock);
    // Older claude-acp builds, and hydra's own per-boundary snapshots, send
    // usage_update with no _claude/origin. Those must not end the turn.
    mock.triggerNotification("session/update", {
      sessionId: "u_agent",
      update: { sessionUpdate: "usage_update", used: 99 },
    });
    expect(session.inUnsolicitedTurn).toBe(true);
  });

  it("never emits turn_complete, so clients' turn accounting is untouched", async () => {
    const { session, mock, sent } = await makeSessionAfterOneTurn();
    agentChunk(mock);
    autonomousTerminal(mock);
    expect(session.inUnsolicitedTurn).toBe(false);
    expect(updatesOfKind(sent, "turn_complete")).toHaveLength(0);
  });

  it("is ended by cancel, so ^C is not a no-op on an agent-initiated turn", async () => {
    const { session, mock, client, sent } = await makeSessionAfterOneTurn();
    agentChunk(mock);
    expect(session.inUnsolicitedTurn).toBe(true);

    // Measured before this worked: the agent published its terminal at T+2s,
    // the cancel landed at T+5s, and the turn stayed open until the silence
    // deadline at T+92s. The keystroke did nothing at all.
    await session.cancel(client.clientId);

    expect(session.inUnsolicitedTurn).toBe(false);
    expect(session.turnStartedAt).toBeUndefined();
    const ended = updatesOfKind(sent, "_hydra_turn_ended");
    expect(ended).toHaveLength(1);
    expect(hydraMeta(ended[0]!).reason).toBe("cancelled");
  });

  it("orders turn_ended before the prompt that was waiting on it", async () => {
    const { session, mock, client, sent } = await makeSessionAfterOneTurn();

    agentChunk(mock);
    expect(session.inUnsolicitedTurn).toBe(true);

    // The prompt is held behind the running turn (see the queue-hold suite)
    // and released by the agent's terminal, not by a deadline.
    const done = session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "hello" }],
    });
    await new Promise((r) => setImmediate(r));
    autonomousTerminal(mock);
    await done;

    expect(session.inUnsolicitedTurn).toBe(false);
    const ended = updatesOfKind(sent, "_hydra_turn_ended");
    expect(ended).toHaveLength(1);
    // "completed", not "superseded": the agent finished it, the prompt just
    // happened to be waiting. Nothing was cut short.
    expect(hydraMeta(ended[0]!).reason).toBe("completed");

    // turn_ended must land before prompt_received, so no client ever sees
    // two turns open at once.
    const order = sent
      .filter((m) => "method" in m && m.method === "session/update")
      .map((m) => {
        const p = (m as { params?: { update?: { sessionUpdate?: string } } }).params;
        return p?.update?.sessionUpdate;
      })
      .filter((k) => k === "_hydra_turn_ended" || k === "prompt_received");
    expect(order).toEqual(["_hydra_turn_ended", "prompt_received"]);
  });

  it("closes an open unsolicited turn when the session closes", async () => {
    const { session, mock, sent } = await makeSessionAfterOneTurn();
    agentChunk(mock);
    await session.close({ deleteRecord: false });

    const ended = updatesOfKind(sent, "_hydra_turn_ended");
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

  it("holds a prompt until the agent publishes its terminal, then dispatches", async () => {
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
    expect(queueEvents(wire, "hydra-acp/prompt_queue/released")).toHaveLength(0);

    // Time alone changes nothing now. This used to release at 45s of quiet,
    // which meant a thinking pause could be mistaken for the end of the turn.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(queueEvents(wire, "hydra-acp/prompt_queue/released")).toHaveLength(0);

    autonomousTerminal(mock);
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    const released = queueEvents(wire, "hydra-acp/prompt_queue/released");
    expect(released).toHaveLength(1);
    expect(released[0]!.reason).toBe("turn_ended");
  });

  it("never dispatches into a turn that is still running", async () => {
    const { session, mock, client, wire } = await setup();
    vi.useFakeTimers();
    agentChunk(mock);

    void session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "held one" }],
    });
    // A chatty agent that never publishes a terminal. There used to be a
    // 180s cap here that gave up and dispatched anyway; in production that
    // injected a prompt into a live turn and its session/prompt response was
    // never returned, wedging the session BUSY for 12 minutes until the user
    // killed it by hand. Holding forever is the correct failure: the entry
    // stays cancellable, and cancel closes the turn.
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      agentChunk(mock, `chunk ${i}`);
    }
    expect(queueEvents(wire, "hydra-acp/prompt_queue/released")).toHaveLength(0);
    expect(session.inUnsolicitedTurn).toBe(true);
  });

  it("releases when the turn is cancelled out from under it", async () => {
    const { session, mock, client, wire } = await setup();
    vi.useFakeTimers();
    agentChunk(mock);
    const done = session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "held one" }],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queueEvents(wire, "hydra-acp/prompt_queue/released")).toHaveLength(0);

    // The escape hatch for an agent that never publishes a terminal.
    await session.cancel(client.clientId);
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(queueEvents(wire, "hydra-acp/prompt_queue/released")[0]!.reason)
      .toBe("turn_ended");
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

// What happens when the hold above is bypassed and the prompt lands on an
// agent already mid-flight in a lane it started by itself.
//
// claude-acp then owes exactly one SDK result for both, and stamps it with
// the lane that STARTED the work — so it arrives as an autonomous terminal,
// not as the session/prompt response, and nothing settles the prompt.
// Observed on session wmXi2gvvkacPLd1V: the agent streamed its entire final
// answer at 14:16:04 and the turn stayed open until a human cancelled it at
// 14:18:13, with the session reading BUSY throughout.
describe("salvaging a superseded turn's terminal", () => {
  async function setup(): Promise<{
    session: Session;
    mock: ReturnType<typeof makeMockAgent>;
    client: AttachedClient;
    sent: JsonRpcMessage[];
  }> {
    return makeSessionAfterOneTurn();
  }

  // An agent that accepts session/prompt and never answers it.
  function neverResponds(mock: ReturnType<typeof makeMockAgent>): void {
    (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<never>(() => {}),
    );
  }

  // Reproduce the bypass: an internal housekeeping entry at the head of the
  // queue with the user prompt landing behind it in the SAME drain pass,
  // which is the production ordering (the two were 1ms apart on disk). The
  // hold only guards user heads, so the internal entry clears the unsolicited
  // turn and the prompt behind it finds nothing left to wait on. This is
  // defect (2), reproduced rather than fixed — the salvage must cope either
  // way.
  //
  // Nothing is awaited between the two enqueues on purpose: drainQueue yields
  // past a setImmediate before touching the head, so both entries are in the
  // queue by the time it starts.
  function supersedeThenPrompt(
    session: Session,
    mock: ReturnType<typeof makeMockAgent>,
    client: AttachedClient,
    text = "follow-up",
  ): Promise<unknown> {
    agentChunk(mock);
    neverResponds(mock);
    void (
      session as unknown as {
        enqueuePrompt(l: string, task: () => Promise<unknown>): Promise<unknown>;
      }
    ).enqueuePrompt("test:housekeeping", async () => ({ ok: true }));
    return session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text }],
    });
  }

  it("settles the prompt on the agent's autonomous terminal", async () => {
    const { session, mock, client } = await setup();
    const done = supersedeThenPrompt(
      session,
      mock,
      client,
      "I do not understand your suggestion",
    );
    await settleDrain();
    expect(session.inUnsolicitedTurn).toBe(false);

    autonomousTerminal(mock);
    await expect(done).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it("marks the salvaged turn_complete so it is visible in history", async () => {
    const { session, mock, client, sent } = await setup();
    const done = supersedeThenPrompt(session, mock, client);
    await settleDrain();
    autonomousTerminal(mock);
    await done;
    await settleDrain();

    // turn_complete is recorded to history; the agent's usage_update that
    // triggered the salvage is filtered out by STATE_UPDATE_KINDS. So this
    // marker is the only on-disk trace a salvage ever happened.
    const completes = updatesOfKind(sent, "turn_complete");
    const salvaged = hydraMeta(completes.at(-1)!).salvaged as
      | Record<string, unknown>
      | undefined;
    expect(salvaged).toMatchObject({ reason: "autonomous_terminal" });
  });

  it("leaves the session idle afterwards rather than wedged BUSY", async () => {
    const { session, mock, client } = await setup();
    const done = supersedeThenPrompt(session, mock, client);
    await settleDrain();
    autonomousTerminal(mock);
    await done;
    await settleDrain();

    expect(session.turnStartedAt).toBeUndefined();
    expect(session.inUnsolicitedTurn).toBe(false);
  });

  it("does not salvage an ordinary turn that never superseded anything", async () => {
    const { session, mock, client } = await setup();
    vi.useFakeTimers();
    neverResponds(mock);
    let settled = false;
    void session
      .prompt(client.clientId, {
        sessionId: "sess_u",
        prompt: [{ type: "text", text: "ordinary" }],
      })
      .then(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(1_000);

    // An agent running a peer or subagent lane alongside a user prompt emits
    // one of these too. Settling the user's turn on it would be a worse bug
    // than the wedge, so the salvage stays gated on an actual supersede.
    autonomousTerminal(mock);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
  });

  it("does not carry the arming into a later drain pass", async () => {
    const { session, mock, client } = await setup();
    agentChunk(mock);
    void (
      session as unknown as {
        enqueuePrompt(l: string, task: () => Promise<unknown>): Promise<unknown>;
      }
    ).enqueuePrompt("test:housekeeping", async () => ({ ok: true }));
    await settleDrain();
    expect(session.inUnsolicitedTurn).toBe(false);

    vi.useFakeTimers();
    neverResponds(mock);
    let settled = false;
    void session
      .prompt(client.clientId, {
        sessionId: "sess_u",
        prompt: [{ type: "text", text: "much later" }],
      })
      .then(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(1_000);
    autonomousTerminal(mock);
    await vi.advanceTimersByTimeAsync(60_000);

    // The housekeeping entry's drain pass ended before this prompt was even
    // enqueued, so there is no supersede for it to inherit. An agent still
    // working that lane would have opened a fresh unsolicited turn, and the
    // queue hold covers the prompt from there.
    expect(settled).toBe(false);
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
    // toolCallId is published so a client can annotate the very tool block
    // that armed this, rather than guessing which one it belongs to.
    expect(session.armedBackgroundTasks).toMatchObject([
      { toolCallId: "toolu_bg", label: "gibbon rebuild" },
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

    expect(session.armedBackgroundTasks).toMatchObject([
      { toolCallId: "toolu_mixed", label: "Terminal", taskId: "bg_1" },
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
    expect(session.armedBackgroundTasks).toMatchObject([
      { toolCallId: "toolu_mon", label: "Monitor", taskId: "bgzem17m0" },
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
  // the attributed one would strand the job entry permanently, because
  // lastBackgroundTask only holds the most recent arming.
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
    // The one-shot goes, even though the resumption was attributed to the
    // Monitor. The Monitor itself stays: it fires per occurrence, so its
    // notification says the watch is alive, not that it is finished.
    expect(session.armedBackgroundTasks).toMatchObject([
      { toolCallId: "toolu_monitor", label: "Monitor", taskId: "bnrcts5np" },
    ]);
    expect(session.armedSince).toBeDefined();
  });

  // Verbatim shape of VHvFZxwYjpsF3scF, which reported armedTasks: 0 while
  // six Monitors were plainly running.
  //
  // Clearing on the first firing is PERMANENT for a Monitor, because nothing
  // ever re-arms it: the whole tool call finishes within ~2s of arming (seven
  // updates ending in status "completed", which is the tool returning, not
  // the watch ending), and the watch's later events arrive as plain agent
  // activity with no further tool_call_update for that toolCallId. So every
  // later firing found an empty set and the badge never came back.
  //
  // Note persistent: false on a watch that fired repeatedly — all six were,
  // so persistent is not the discriminator. The tool kind is.
  it("keeps a repeating watch armed across the resumption it causes", async () => {
    const monitorArming = {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_mon",
      title: "Monitor",
      _meta: {
        claudeCode: {
          toolName: "Monitor",
          toolResponse: {
            taskId: "b4atttz8a",
            timeoutMs: 2_700_000,
            persistent: false,
          },
        },
      },
    };
    const { session, mock } = await armDuringTurn(monitorArming);
    expect(session.armedBackgroundTasks).toHaveLength(1);
    const armedAt = session.armedSince;
    expect(armedAt).toBeDefined();

    // First event: the watch reports progress, which wakes the session.
    agentChunk(mock, "elapsed_steps=120");
    expect(session.inUnsolicitedTurn).toBe(true);
    expect(session.armedBackgroundTasks).toMatchObject([
      { toolCallId: "toolu_mon", label: "Monitor", taskId: "b4atttz8a" },
    ]);

    // A duplicate arming update, which is how the tool call's own seven
    // updates arrive, must not restart the "running Xs" clock either: it
    // reads from armedSince, so resetting it would show a watch that had
    // been going for minutes as though it had just begun.
    mock.triggerNotification("session/update", {
      sessionId: "u_agent",
      update: monitorArming,
    });
    expect(session.armedBackgroundTasks).toMatchObject([
      { toolCallId: "toolu_mon", label: "Monitor", taskId: "b4atttz8a" },
    ]);
    expect(session.armedSince).toBe(armedAt);
  });

  // A repeating watch has no expiry at all now. It leaves the set only on an
  // authoritative signal (TaskStop), never on a clock. The three ceilings
  // that used to bound it were guesses at a duration hydra cannot observe,
  // and they failed in both directions: a real 45-minute device watch went
  // dark 15 minutes in, while a watch killed by a bare `pkill` kept claiming
  // a wakeup for the rest of the hour.
  // Real timers on purpose, and a short reported timeoutMs, so this exercises
  // the real path. Fake timers could not prove absence here: a timer armed
  // before vi.useFakeTimers() is never advanced by it, so the assertion would
  // hold whether or not an expiry still existed.
  it("does not age out a repeating watch, however long it runs", async () => {
    const { session, mock } = await armDuringTurn({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_mon",
      title: "Monitor",
      _meta: {
        claudeCode: {
          toolName: "Monitor",
          toolResponse: { taskId: "t1", timeoutMs: 50 },
        },
      },
    });
    agentChunk(mock, "one event");
    expect(session.armedBackgroundTasks).toHaveLength(1);
    const armedAt = session.armedSince;

    // Well past the 50ms the agent named. This is the exact assertion the
    // old expiry test made, inverted.
    await new Promise((r) => setTimeout(r, 120));
    expect(session.armedBackgroundTasks).toHaveLength(1);
    // The "running Xs" clock still reads from the original arming.
    expect(session.armedSince).toBe(armedAt);
  });

  it("tells a repeating watch from a one-shot", () => {
    // A real Monitor: tool identity, plus the toolResponse.taskId shape.
    expect(isRepeatingArming(
      "Monitor",
      { toolName: "Monitor", toolResponse: { taskId: "b4atttz8a" } },
      {},
    )).toBe(true);
    // Its late sparse update, carrying neither a title nor a toolName.
    expect(isRepeatingArming(
      undefined,
      { toolResponse: { taskId: "b4atttz8a" } },
      undefined,
    )).toBe(true);
    // A real backgrounded Bash, whose id lives in rawOutput prose and never
    // in toolResponse.
    expect(isRepeatingArming(
      "Terminal",
      { toolName: "Bash" },
      { command: "vitest run", run_in_background: true },
    )).toBe(false);
    // run_in_background vetoes, so the mixed fixture above reads as the
    // one-shot it is rather than acquiring a Monitor's exits.
    expect(isRepeatingArming(
      "Terminal",
      { toolResponse: { taskId: "bg_1" } },
      { command: "ninja", run_in_background: true },
    )).toBe(false);
    // An ordinary foreground call is neither, though nothing arms it anyway.
    expect(isRepeatingArming("Terminal", undefined, { command: "ls" }))
      .toBe(false);
  });

  it("pushes armed_tasks_updated on arm and again when it is discharged", async () => {
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
    // Discharged by the agent saying so, not by a clock running out.
    await stopDuringTurn(session, mock, client, "t1");

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
    expect(session.armedBackgroundTasks).toMatchObject([
      { toolCallId: "toolu_bg", label: "Terminal", taskId: "b17okg6jd" },
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

  // The agent's timeoutMs answers "how long might this watch run", which was
  // never the question hydra needed answered, so it is no longer read at all.
  // A one-shot's exits are the resumption it causes and TaskStop; nothing
  // else, and no clock.
  it("ignores the agent's reported timeout entirely", async () => {
    const { session } = await armDuringTurn({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_bg2",
      title: "Terminal",
      rawInput: { command: "sleep 1", run_in_background: true },
      _meta: {
        claudeCode: { toolResponse: { taskId: "bg_ttl", timeoutMs: 50 } },
      },
    });
    expect(session.armedBackgroundTasks).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 120));
    expect(session.armedBackgroundTasks).toHaveLength(1);
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
    return updatesOfKind(sent, "_hydra_turn_started");
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
    const started = updatesOfKind(sent, "_hydra_turn_started");
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

// pendingSteerDetach is armed before the `_session/steering` forward and
// consumed by openUnsolicitedTurn. Nothing else clears it on the
// startedNewTurn path -- so if the detached turn never reaches
// openUnsolicitedTurn, the flag survives and marks whatever agent-initiated
// turn comes next as steer-caused.
describe("the steer detach flag outliving the turn it was armed for", () => {
  it("does not mark a later agent-initiated turn as steer-caused", async () => {
    const { session, mock, client } = await makeSessionAfterOneTurn();
    mock.agent.steeringSupported = true;

    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    let settleTurn: (() => void) | undefined;
    let steeredTurnPending = true;
    requestMock.mockImplementation((method: string) => {
      if (method === "session/prompt") {
        if (!steeredTurnPending) {
          return Promise.resolve({ stopReason: "end_turn" });
        }
        steeredTurnPending = false;
        return new Promise((resolve) => {
          settleTurn = () => resolve({ stopReason: "end_turn" });
        });
      }
      if (method === "_session/steering") {
        return Promise.resolve({ outcome: "startedNewTurn" });
      }
      return Promise.resolve({});
    });

    void session.prompt(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "the turn being steered" }],
    });
    await new Promise((r) => setImmediate(r));

    await session.steer(client.clientId, {
      sessionId: "sess_u",
      prompt: [{ type: "text", text: "actually, do X instead" }],
    });

    // The detached turn runs and ends inside the window where hydra still
    // has its own prompt in flight, so noteAgentActivity folds its output
    // into that turn and openUnsolicitedTurn -- the only consumer of the
    // flag -- never runs.
    agentChunk(mock, "doing X instead");
    humanTerminal(mock);

    settleTurn?.();
    await settleDrain();
    expect(session.inUnsolicitedTurn).toBe(false);

    // Later, a background task wakes the agent. A genuine agent-initiated
    // turn, nothing to do with the steer.
    agentChunk(mock, "background task finished");
    expect(session.inUnsolicitedTurn).toBe(true);

    // An unrelated user turn's terminal must not end it -- the invariant
    // "does not end on a user-lane terminal" rests on.
    humanTerminal(mock);
    expect(session.inUnsolicitedTurn).toBe(true);
  });
});
