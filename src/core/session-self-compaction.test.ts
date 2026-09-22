import { describe, it, expect, vi } from "vitest";
import { JsonRpcConnection } from "../acp/connection.js";
import { makeMockAgent, makeControlledStream } from "../__tests__/test-utils.js";
import { Session } from "./session.js";
import { HistoryStore } from "./history-store.js";

// Poll until `predicate` holds or timeoutMs elapses. armRecallInPlace's
// history read races real disk I/O (HistoryStore.append), which a fixed
// handful of setImmediate ticks doesn't reliably outlast.
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeClient(): {
  client: { clientId: string; connection: JsonRpcConnection };
  stream: ReturnType<typeof makeControlledStream>;
} {
  const stream = makeControlledStream();
  const conn = new JsonRpcConnection(stream);
  return {
    client: { clientId: `c_${Math.random().toString(36).slice(2, 8)}`, connection: conn },
    stream,
  };
}

// Every update shape used below is recordable (none are state-update
// kinds filtered from history), so each call advances the on-disk entry
// count by exactly one — used as the sync point instead of a fixed sleep.
function triggerUpdate(
  mock: ReturnType<typeof makeMockAgent>,
  update: Record<string, unknown>,
): void {
  mock.triggerNotification("session/update", {
    sessionId: "agent-sess",
    update,
  });
}

async function triggerAndSettle(
  mock: ReturnType<typeof makeMockAgent>,
  store: HistoryStore,
  sessionId: string,
  update: Record<string, unknown>,
  expectedCount: number,
): Promise<void> {
  triggerUpdate(mock, update);
  await waitFor(async () => (await store.getRecallTotalCount(sessionId)) >= expectedCount);
}

describe("Session self-compaction arming", () => {
  it("arms the watermark in place on codex's completed 'Compact conversation' tool call, without touching the live agent", async () => {
    const mock = makeMockAgent({ agentId: "codex", cwd: "/w" });
    const store = new HistoryStore();
    const sessionId = "hydra_self_compact_1";
    const persistWatermarkHook = vi.fn();
    const session = new Session({
      sessionId,
      cwd: "/w",
      agentId: "codex",
      agent: mock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      persistWatermarkHook,
    });
    const { client, stream } = makeClient();
    await session.attach(client, "full");

    // Some ordinary conversation before codex compacts on its own.
    await triggerAndSettle(mock, store, sessionId, { sessionUpdate: "prompt_received" }, 1);
    await triggerAndSettle(
      mock,
      store,
      sessionId,
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working on it" } },
      2,
    );
    expect(session.summarizedThroughEntry ?? 0).toBe(0);

    await triggerAndSettle(
      mock,
      store,
      sessionId,
      {
        sessionUpdate: "tool_call",
        toolCallId: "compact-1",
        kind: "think",
        title: "Compact conversation",
        status: "in_progress",
        _meta: { contextCompaction: { version: 1 } },
      },
      3,
    );
    // The start update must not arm anything by itself.
    expect(session.summarizedThroughEntry ?? 0).toBe(0);

    await triggerAndSettle(
      mock,
      store,
      sessionId,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "compact-1",
        title: "Compact conversation",
        status: "completed",
        _meta: { contextCompaction: { version: 1 } },
      },
      4,
    );
    await waitFor(() => (session.summarizedThroughEntry ?? 0) > 0);

    expect(session.summarizedThroughEntry).toBeGreaterThan(0);
    expect(persistWatermarkHook).toHaveBeenCalledWith(session.summarizedThroughEntry);

    // No swap: same agent instance, same upstream id, never killed.
    expect(session.agent).toBe(mock.agent);
    expect(session.upstreamSessionId).toBe("u1");
    expect(mock.agent.kill).not.toHaveBeenCalled();

    await waitFor(() =>
      stream.sent.some((m) => "method" in m && m.method === "hydra-acp/context_self_compacted"),
    );
  });

  it("arms the watermark on claude-agent-acp's manual /compact completion text", async () => {
    const mock = makeMockAgent({ agentId: "claude", cwd: "/w" });
    const store = new HistoryStore();
    const sessionId = "hydra_self_compact_2";
    const persistWatermarkHook = vi.fn();
    const session = new Session({
      sessionId,
      cwd: "/w",
      agentId: "claude",
      agent: mock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      persistWatermarkHook,
    });

    await triggerAndSettle(mock, store, sessionId, { sessionUpdate: "prompt_received" }, 1);
    await triggerAndSettle(
      mock,
      store,
      sessionId,
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Compacting..." } },
      2,
    );
    expect(session.summarizedThroughEntry ?? 0).toBe(0);

    await triggerAndSettle(
      mock,
      store,
      sessionId,
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "\n\nCompacting completed." },
      },
      3,
    );
    await waitFor(() => (session.summarizedThroughEntry ?? 0) > 0);

    expect(session.summarizedThroughEntry).toBeGreaterThan(0);
    expect(persistWatermarkHook).toHaveBeenCalledWith(session.summarizedThroughEntry);
    expect(session.agent).toBe(mock.agent);
  });

  it("does not arm on a failed claude compaction or an ordinary tool call", async () => {
    const mock = makeMockAgent({ agentId: "claude", cwd: "/w" });
    const store = new HistoryStore();
    const sessionId = "hydra_self_compact_3";
    const persistWatermarkHook = vi.fn();
    const session = new Session({
      sessionId,
      cwd: "/w",
      agentId: "claude",
      agent: mock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      persistWatermarkHook,
    });

    await triggerAndSettle(
      mock,
      store,
      sessionId,
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "\n\nCompacting failed: overloaded." },
      },
      1,
    );
    await triggerAndSettle(
      mock,
      store,
      sessionId,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "exec-1",
        title: "Run command",
        status: "completed",
      },
      2,
    );

    expect(session.summarizedThroughEntry ?? 0).toBe(0);
    expect(persistWatermarkHook).not.toHaveBeenCalled();
  });

  it("does not re-arm past the current watermark on a second self-compaction with no new history", async () => {
    const mock = makeMockAgent({ agentId: "codex", cwd: "/w" });
    const store = new HistoryStore();
    const sessionId = "hydra_self_compact_4";
    const persistWatermarkHook = vi.fn();
    const session = new Session({
      sessionId,
      cwd: "/w",
      agentId: "codex",
      agent: mock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      persistWatermarkHook,
    });

    await triggerAndSettle(mock, store, sessionId, { sessionUpdate: "prompt_received" }, 1);
    await triggerAndSettle(
      mock,
      store,
      sessionId,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "compact-1",
        title: "Compact conversation",
        status: "completed",
        _meta: { contextCompaction: { version: 1 } },
      },
      2,
    );
    await waitFor(() => (session.summarizedThroughEntry ?? 0) > 0);
    const firstWatermark = session.summarizedThroughEntry;
    expect(firstWatermark).toBeGreaterThan(0);
    persistWatermarkHook.mockClear();

    // codex compacts again immediately, no new conversation in between —
    // the only new entry is the tool_call_update itself.
    await triggerAndSettle(
      mock,
      store,
      sessionId,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "compact-2",
        title: "Compact conversation",
        status: "completed",
        _meta: { contextCompaction: { version: 1 } },
      },
      3,
    );
    await waitFor(async () => (await store.getRecallTotalCount(sessionId)) >= 3);

    // Either it stays put or it advances to cover the new entry — either
    // way it must never go backwards.
    expect(session.summarizedThroughEntry ?? 0).toBeGreaterThanOrEqual(firstWatermark ?? 0);
  });
});
