import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionSynopsis } from "./snapshot.js";
import { JsonRpcConnection } from "../acp/connection.js";
import {
  makeMockAgent,
  makeControlledStream,
} from "../__tests__/test-utils.js";

// Mock renderCompactionSeed completely so we can verify its call args.
// We import Session after this mock is set up (vi.mock is hoisted).
vi.mock("./compaction-seed.js", () => ({
  renderCompactionSeed: vi.fn().mockReturnValue("MOCKED_SEED_TEXT"),
}));

import { Session } from "./session.js";
import { HistoryStore } from "./history-store.js";

beforeEach(() => {
  vi.clearAllMocks();
});

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
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

function promptReceivedEntry(): Record<string, unknown> {
  return { sessionUpdate: "prompt_received" };
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

// Build a minimal synopsis artifact for compaction seed rendering.
function makeSynopsis(overrides?: Partial<SessionSynopsis>): SessionSynopsis {
  return {
    goal: "fix the login bug",
    outcome: "resolved by updating auth middleware",
    files_touched: ["src/auth/middleware.ts", "src/auth/handler.ts"],
    tools_used: ["read_file", "edit_file", "grep"],
    ...overrides,
  };
}

// Create a controlled mock for spawnReplacementAgent.
function makeSpawnMock(opts: {
  agentId?: string;
  initialModel?: string;
  initialMode?: string;
}) {
  const oldMock = makeMockAgent({ agentId: opts.agentId ?? "old-agent", cwd: "/w" });
  const newMock = makeMockAgent({ agentId: opts.agentId ?? "new-agent", cwd: "/w" });

  const spawnCalls: Array<{ agentId: string; cwd: string; mcpServers?: unknown[] }> = [];

  const spawnReplacementAgent = vi.fn().mockImplementation(async (params) => {
    spawnCalls.push({
      agentId: params.agentId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
    });
    return {
      agent: newMock.agent,
      upstreamSessionId: `fresh_${Math.random().toString(36).slice(2, 10)}`,
      initialModel: opts.initialModel,
      initialMode: opts.initialMode,
    };
  });

  return { spawnReplacementAgent, oldMock, newMock, spawnCalls };
}

describe("Session.swapUpstream", () => {
  it("throws when session is not quiesced (prompt in flight)", async () => {
    const mock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    const store = new HistoryStore();
    let promptResolve: () => void;
    const promptDeferred = new Promise<void>((r) => { promptResolve = r; });

    (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async (method: string) => {
        if (method === "session/prompt") {
          await promptDeferred;
          return { stopReason: "end_turn" };
        }
        return {};
      },
    );

    const session = new Session({
      sessionId: "hydra_swap_1",
      cwd: "/w",
      agentId: "a1",
      agent: mock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent: vi.fn().mockResolvedValue({
        agent: makeMockAgent().agent,
        upstreamSessionId: "fresh_placeholder",
      }),
    });

    const { client } = makeClient();
    session.attach(client, "full");

    // Start a prompt to set promptInFlight.
    const promptPromise = session.prompt(client.clientId, {
      prompt: [{ type: "text", text: "hello" }],
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    await expect(
      session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 }),
    ).rejects.toThrow("not quiesced for swap");

    promptResolve!();
    await promptPromise;
  });

  it("throws when there is an open tool call", async () => {
    const mock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_2",
      cwd: "/w",
      agentId: "a1",
      agent: mock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent: vi.fn().mockResolvedValue({
        agent: makeMockAgent().agent,
        upstreamSessionId: "fresh_placeholder",
      }),
    });

    await triggerUpdate(mock, promptReceivedEntry());
    await triggerUpdate(mock, toolCallEntry("tc-open", "edit_file"));

    await expect(
      session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 }),
    ).rejects.toThrow("not quiesced for swap");
  });

  it("throws when spawnReplacementAgent is not configured", async () => {
    const mock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_3",
      cwd: "/w",
      agentId: "a1",
      agent: mock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
    });

    await expect(
      session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 }),
    ).rejects.toThrow("agent spawning not configured");
  });

  it("emits lifecycle:agent.swap pre and post around the swap", async () => {
    const { spawnReplacementAgent, oldMock } = makeSpawnMock({ agentId: "a1" });
    const notifications: Array<{ method: string; params: unknown }> = [];
    const transformerConn = {
      request: vi.fn().mockResolvedValue({ action: "continue" }),
      notify: vi.fn().mockImplementation(async (m: string, p: unknown) => {
        notifications.push({ method: m, params: p });
      }),
      onRequest: vi.fn(),
      onNotification: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as JsonRpcConnection;

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_emit",
      cwd: "/w",
      agentId: "a1",
      agent: oldMock.agent,
      upstreamSessionId: "u_before",
      historyStore: store,
      spawnReplacementAgent,
      transformChain: [
        { name: "obs", intercepts: new Set(["lifecycle:agent.swap"]), connection: transformerConn },
      ],
    });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });
    await new Promise((r) => setImmediate(r));

    const swapEvents = notifications.filter(
      (n) => (n.params as { event: string }).event === "agent.swap",
    );
    expect(swapEvents).toHaveLength(2);
    const pre = (swapEvents[0]!.params as { payload: Record<string, unknown> }).payload;
    const post = (swapEvents[1]!.params as { payload: Record<string, unknown> }).payload;
    expect(pre.phase).toBe("pre");
    expect(pre.previousUpstreamSessionId).toBe("u_before");
    expect(post.phase).toBe("post");
    expect(post.previousUpstreamSessionId).toBe("u_before");
    expect(typeof post.upstreamSessionId).toBe("string");
    expect(post.upstreamSessionId).not.toBe("u_before");
  });

  it("spawns a fresh agent and swaps upstream on success", async () => {
    const { spawnReplacementAgent, oldMock, newMock, spawnCalls } = makeSpawnMock({
      agentId: "a1",
    });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_4",
      cwd: "/w",
      agentId: "a1",
      agent: oldMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
    });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });

    expect(spawnReplacementAgent).toHaveBeenCalledTimes(1);
    const spawnArg = spawnCalls[0]!;
    expect(spawnArg.agentId).toBe("a1");
    expect(spawnArg.cwd).toBe("/w");
    expect(spawnArg.mcpServers).toEqual([]);

    expect(oldMock.agent.kill).toHaveBeenCalledTimes(1);
    expect(session.agent).toBe(newMock.agent);
    expect(session.upstreamSessionId).not.toBe("u1");
    expect(session.upstreamSessionId.startsWith("fresh_")).toBe(true);
  });

  it("preserves hydra sessionId after swap", async () => {
    const { spawnReplacementAgent, oldMock } = makeSpawnMock({ agentId: "a1" });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_preserve_id",
      cwd: "/w",
      agentId: "a1",
      agent: oldMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
    });

    const beforeId = session.sessionId;

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });

    expect(session.sessionId).toBe(beforeId);
  });

  it("does not set parentSessionId after swap", async () => {
    const { spawnReplacementAgent, oldMock } = makeSpawnMock({ agentId: "a1" });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_no_parent",
      cwd: "/w",
      agentId: "a1",
      agent: oldMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
    });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });

    expect((session as unknown as Record<string, unknown>).parentSessionId).toBeUndefined();
  });

  it("swapIntoWorkspace puts the move note in the seed and keeps the session's synopsis", async () => {
    // Regression: the note used to be passed AS the artifact, cast to
    // SessionSynopsis with a `summary` field that type doesn't have. The
    // renderer emits no `summary`, so the note vanished and the seed
    // claimed a compaction while carrying no synopsis at all.
    const { spawnReplacementAgent, oldMock } = makeSpawnMock({ agentId: "a1" });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_ws_note",
      cwd: "/w",
      agentId: "a1",
      agent: oldMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
    });

    const synopsis = makeSynopsis();
    await session.swapIntoWorkspace({
      cwd: "/ws/feature",
      workspace: undefined,
      historyLength: 7,
      note: "Returned to the source tree at /w after merging the workspace.",
      synopsis,
    });

    const { renderCompactionSeed } = await import("./compaction-seed.js");
    const args = ((renderCompactionSeed as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ??
      {}) as { note?: string; framing?: string; synopsis?: unknown };
    expect(args.note).toContain("Returned to the source tree at /w");
    expect(args.synopsis).toBe(synopsis);
    // Nothing was summarized away, so the seed must not say otherwise.
    expect(args.framing).toBe("swap");
  });

  it("swaps with no artifact, rendering a synopsis-less seed", async () => {
    const { spawnReplacementAgent, oldMock } = makeSpawnMock({ agentId: "a1" });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_no_artifact",
      cwd: "/w",
      agentId: "a1",
      agent: oldMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
    });

    await session.swapUpstream({ tailK: 2, tailFloor: 2, newAgentId: "a2" });

    expect(spawnReplacementAgent).toHaveBeenCalledTimes(1);
    const { renderCompactionSeed } = await import("./compaction-seed.js");
    const args = ((renderCompactionSeed as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ??
      {}) as { synopsis?: unknown; tailFloor?: number };
    expect(args.synopsis).toBeUndefined();
    expect(args.tailFloor).toBe(2);
  });

  it("sends seed text via session/prompt on the fresh agent", async () => {
    const newMock = makeMockAgent({ agentId: "a1", cwd: "/w" });

    const spawnReplacementAgent = vi.fn().mockResolvedValue({
      agent: newMock.agent,
      upstreamSessionId: `fresh_${Math.random().toString(36).slice(2, 10)}`,
    });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_seed",
      cwd: "/w",
      agentId: "a1",
      agent: makeMockAgent().agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
    });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });

    // Verify spawn was called.
    expect(spawnReplacementAgent).toHaveBeenCalledTimes(1);

    // Verify renderCompactionSeed was called with correct arguments.
    const { renderCompactionSeed } = await import("./compaction-seed.js");
    expect(renderCompactionSeed).toHaveBeenCalledTimes(1);
    const callArgs = ((renderCompactionSeed as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? {}) as {
      synopsis: SessionSynopsis;
      tailK: number;
      tail: unknown[];
      title?: string;
    };
    expect(callArgs.synopsis.goal).toBe("fix the login bug");
    expect(callArgs.tailK).toBe(2);
    expect(Array.isArray(callArgs.tail)).toBe(true);
    expect(callArgs.title).toBeUndefined();
  });

  it("sends seed via fresh agent connection, not the old agent", async () => {
    const oldMock = makeMockAgent({ agentId: "old", cwd: "/w" });
    const newMock = makeMockAgent({ agentId: "new", cwd: "/w" });

    const spawnReplacementAgent = vi.fn().mockResolvedValue({
      agent: newMock.agent,
      upstreamSessionId: `fresh_${Math.random().toString(36).slice(2, 10)}`,
    });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_seed_connection",
      cwd: "/w",
      agentId: "a1",
      agent: oldMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
    });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 0 });

    const oldRequestCalls = (oldMock.agent.connection.request as ReturnType<typeof vi.fn>).mock.calls;
    const newRequestCalls = (newMock.agent.connection.request as ReturnType<typeof vi.fn>).mock.calls;

    const oldPromptCalls = oldRequestCalls.filter(
      (call) => call[0] === "session/prompt",
    );
    const newPromptCalls = newRequestCalls.filter(
      (call) => call[0] === "session/prompt",
    );

    expect(oldPromptCalls).toHaveLength(0);
    expect(newPromptCalls).toHaveLength(1);
    expect(newPromptCalls[0]?.[1]).toEqual(
      expect.objectContaining({
        sessionId: expect.stringMatching(/^fresh_/),
        prompt: [{ type: "text", text: "MOCKED_SEED_TEXT" }],
      }),
    );
  });

  it("includes tail turns in the seed text when tailK > 0", async () => {
    const oldMock = makeMockAgent({ agentId: "a1", cwd: "/w" });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_tail",
      cwd: "/w",
      agentId: "a1",
      agent: oldMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent: vi.fn().mockResolvedValue({
        agent: makeMockAgent({ agentId: "a1", cwd: "/w" }).agent,
        upstreamSessionId: `fresh_${Math.random().toString(36).slice(2, 10)}`,
      }),
    });

    // Add some history entries.
    await triggerUpdate(oldMock, promptReceivedEntry());
    await triggerUpdate(oldMock, {
      sessionUpdate: "agent_message_chunk",
      content: { text: "Let me check the logs" },
    });
    await triggerUpdate(oldMock, { sessionUpdate: "turn_complete" });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });

    // Verify renderCompactionSeed was called with history entries.
    const { renderCompactionSeed } = await import("./compaction-seed.js");
    expect(renderCompactionSeed).toHaveBeenCalledTimes(1);
    const callArgs = ((renderCompactionSeed as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? {}) as {
      synopsis: SessionSynopsis;
      tailK: number;
      tail: unknown[];
    };
    // History entries should be included in the tail.
    expect(callArgs.tailK).toBe(2);
    expect(Array.isArray(callArgs.tail)).toBe(true);
    expect(callArgs.tail.length).toBeGreaterThan(0);
  });

  it("suppresses the agent's seed-response and surfaces a synthetic 'Compaction completed.' instead", async () => {
    const { spawnReplacementAgent, oldMock } = makeSpawnMock({ agentId: "a1" });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_no_history",
      cwd: "/w",
      agentId: "a1",
      agent: oldMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
    });

    const notifications: Array<{ method: string; params: unknown }> = [];
    await session.attach(
      {
        clientId: "client-watch",
        connection: {
          notify: async (method: string, params: unknown): Promise<void> => {
            notifications.push({ method, params });
          },
        } as unknown as Parameters<typeof session.attach>[0]["connection"],
      },
      "none",
    );

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 0 });

    // history.jsonl must NOT pick up the seed response or the synthetic
    // "Compaction completed." notification. Recording the synthetic
    // would grow history length and trigger the catch-up loop into a
    // spurious second swap.
    const history = await store.load("hydra_swap_no_history");
    expect(history).toHaveLength(0);

    // The synthetic "Compaction completed." goes out to attached
    // clients via the warm session/update channel (broadcast-only).
    const chunkUpdate = notifications.find((n) => {
      if (n.method !== "session/update") {
        return false;
      }
      const update = (n.params as { update?: { sessionUpdate?: string; content?: { text?: string } } }).update;
      return (
        update?.sessionUpdate === "agent_message_chunk" &&
        update?.content?.text?.includes("Compaction completed.") === true
      );
    });
    expect(chunkUpdate).toBeDefined();
    const update = (chunkUpdate?.params as { update?: { _meta?: unknown } }).update;
    expect(update?._meta).toEqual({ "hydra-acp": { synthetic: true } });
  });

  it("restores model when old session had non-default model", async () => {
    const setModelCalls: Array<{ sessionId: string; modelId: string }> = [];
    const newMock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    (newMock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async (method: string, params: unknown) => {
        if (method === "session/set_model") {
          setModelCalls.push({
            sessionId: (params as { sessionId: string }).sessionId,
            modelId: (params as { modelId: string }).modelId,
          });
        }
        return {};
      },
    );

    const spawnReplacementAgent = vi.fn().mockResolvedValue({
      agent: newMock.agent,
      upstreamSessionId: "fresh_model_restore",
      initialModel: "gpt-4",
    });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_model",
      cwd: "/w",
      agentId: "a1",
      agent: newMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
      currentModel: "claude-opus-4",
    });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 0 });

    expect(setModelCalls).toHaveLength(1);
    expect(setModelCalls[0]!.modelId).toBe("claude-opus-4");
  });

  it("does not call set_model when model matches fresh agent default", async () => {
    const setModelCalls: Array<{ sessionId: string; modelId: string }> = [];
    const newMock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    (newMock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async (method: string, params: unknown) => {
        if (method === "session/set_model") {
          setModelCalls.push({
            sessionId: (params as { sessionId: string }).sessionId,
            modelId: (params as { modelId: string }).modelId,
          });
        }
        return {};
      },
    );

    const spawnReplacementAgent = vi.fn().mockResolvedValue({
      agent: newMock.agent,
      upstreamSessionId: "fresh_model_match",
      initialModel: "claude-opus-4",
    });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_model_match",
      cwd: "/w",
      agentId: "a1",
      agent: newMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
      currentModel: "claude-opus-4",
    });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 0 });

    expect(setModelCalls).toHaveLength(0);
  });

  it("restores mode when old session had non-default mode", async () => {
    const setModeCalls: Array<{ sessionId: string; modeId: string }> = [];
    const newMock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    (newMock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async (method: string, params: unknown) => {
        if (method === "session/set_mode") {
          setModeCalls.push({
            sessionId: (params as { sessionId: string }).sessionId,
            modeId: (params as { modeId: string }).modeId,
          });
        }
        return {};
      },
    );

    const spawnReplacementAgent = vi.fn().mockResolvedValue({
      agent: newMock.agent,
      upstreamSessionId: "fresh_mode_restore",
      initialMode: "default",
    });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_mode",
      cwd: "/w",
      agentId: "a1",
      agent: newMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
      currentMode: "plan",
    });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 0 });

    expect(setModeCalls).toHaveLength(1);
    expect(setModeCalls[0]!.modeId).toBe("plan");
  });

  it("does not call set_mode when mode matches fresh agent default", async () => {
    const setModeCalls: Array<{ sessionId: string; modeId: string }> = [];
    const newMock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    (newMock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async (method: string, params: unknown) => {
        if (method === "session/set_mode") {
          setModeCalls.push({
            sessionId: (params as { sessionId: string }).sessionId,
            modeId: (params as { modeId: string }).modeId,
          });
        }
        return {};
      },
    );

    const spawnReplacementAgent = vi.fn().mockResolvedValue({
      agent: newMock.agent,
      upstreamSessionId: "fresh_mode_match",
      initialMode: "plan",
    });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_mode_match",
      cwd: "/w",
      agentId: "a1",
      agent: newMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
      currentMode: "plan",
    });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 0 });

    expect(setModeCalls).toHaveLength(0);
  });

  it("uses provided title in seed text", async () => {
    const newMock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    const spawnReplacementAgent = vi.fn().mockResolvedValue({
      agent: newMock.agent,
      upstreamSessionId: "fresh_title",
    });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_title",
      cwd: "/w",
      agentId: "a1",
      agent: newMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
    });

    await session.swapUpstream({
      artifact: makeSynopsis(),
      title: "My custom title",
      tailK: 0,
    });

    // Verify renderCompactionSeed was called with the provided title.
    const { renderCompactionSeed } = await import("./compaction-seed.js");
    expect(renderCompactionSeed).toHaveBeenCalledTimes(1);
    const args = ((renderCompactionSeed as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? {}) as { title?: string };
    expect(args.title).toBe("My custom title");
  });

  it("uses '(untitled)' when no title is provided", async () => {
    const newMock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    const spawnReplacementAgent = vi.fn().mockResolvedValue({
      agent: newMock.agent,
      upstreamSessionId: "fresh_untitled",
    });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_untitled",
      cwd: "/w",
      agentId: "a1",
      agent: newMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
    });

    await session.swapUpstream({
      artifact: makeSynopsis(),
      tailK: 0,
    });

    // Verify renderCompactionSeed was called without a title.
    const { renderCompactionSeed } = await import("./compaction-seed.js");
    expect(renderCompactionSeed).toHaveBeenCalledTimes(1);
    const args = ((renderCompactionSeed as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? {}) as { title?: string };
    expect(args.title).toBeUndefined();
  });

  it("sets agentMeta and agentCapabilities from fresh spawn", async () => {
    const newMock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    const spawnReplacementAgent = vi.fn().mockResolvedValue({
      agent: newMock.agent,
      upstreamSessionId: "fresh_meta",
      agentMeta: { provider: "test-provider" },
      agentCapabilities: { experimental: {} },
    });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_meta",
      cwd: "/w",
      agentId: "a1",
      agent: newMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
    });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 0 });

    expect(session.agentMeta).toEqual({ provider: "test-provider" });
    expect(session.agentCapabilities).toEqual({ experimental: {} });
  });

  it("calls drainBuffered on fresh agent after model/mode restore", async () => {
    const drainCalls: string[] = [];
    const newMock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    vi.spyOn(newMock.agent.connection, "drainBuffered").mockImplementation(
      (method: string) => {
        drainCalls.push(method);
        return 0;
      },
    );

    const spawnReplacementAgent = vi.fn().mockResolvedValue({
      agent: newMock.agent,
      upstreamSessionId: "fresh_drain",
      initialModel: "gpt-4",
      initialMode: "default",
    });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_drain",
      cwd: "/w",
      agentId: "a1",
      agent: newMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
      currentModel: "claude-opus-4",
      currentMode: "plan",
    });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 0 });

    expect(drainCalls).toContain("session/update");
  });

  it("broadcasts compaction swap notification after swap", async () => {
    const newMock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    const spawnReplacementAgent = vi.fn().mockResolvedValue({
      agent: newMock.agent,
      upstreamSessionId: "fresh_broadcast",
    });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_broadcast",
      cwd: "/w",
      agentId: "a1",
      agent: newMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
    });

    const { client, stream } = makeClient();
    session.attach(client, "full");

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 0 });

    const sentMessages = stream.sent;
    let foundSwapNotification = false;
    for (const msg of sentMessages) {
      if ("method" in msg && typeof msg.method === "string" && msg.method === "session/update") {
        const m = msg as { method: string; params?: unknown };
        if (m.params && typeof m.params === "object") {
          const update = (m.params as { update?: { sessionUpdate?: string; phase?: string } }).update;
          if (update?.sessionUpdate === "hydra_compaction" && update?.phase === "swapped") {
            foundSwapNotification = true;
            break;
          }
        }
      }
    }
    expect(foundSwapNotification).toBe(true);
  });

  it("fails gracefully when set_model is rejected by agent", async () => {
    const newMock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    (newMock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async (method: string) => {
        if (method === "session/set_model") {
          throw new Error("model not supported");
        }
        return {};
      },
    );

    const spawnReplacementAgent = vi.fn().mockResolvedValue({
      agent: newMock.agent,
      upstreamSessionId: "fresh_fail_model",
      initialModel: "gpt-4",
    });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_fail_model",
      cwd: "/w",
      agentId: "a1",
      agent: newMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
      currentModel: "claude-opus-4",
    });

    await expect(
      session.swapUpstream({ artifact: makeSynopsis(), tailK: 0 }),
    ).resolves.not.toThrow();
  });

  it("fails gracefully when set_mode is rejected by agent", async () => {
    const newMock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    (newMock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async (method: string) => {
        if (method === "session/set_mode") {
          throw new Error("mode not supported");
        }
        return {};
      },
    );

    const spawnReplacementAgent = vi.fn().mockResolvedValue({
      agent: newMock.agent,
      upstreamSessionId: "fresh_fail_mode",
      initialMode: "default",
    });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_fail_mode",
      cwd: "/w",
      agentId: "a1",
      agent: newMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
      currentMode: "plan",
    });

    await expect(
      session.swapUpstream({ artifact: makeSynopsis(), tailK: 0 }),
    ).resolves.not.toThrow();
  });

  it("handles empty history gracefully when tailK > 0", async () => {
    const newMock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    const spawnReplacementAgent = vi.fn().mockResolvedValue({
      agent: newMock.agent,
      upstreamSessionId: "fresh_empty_history",
    });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_empty_hist",
      cwd: "/w",
      agentId: "a1",
      agent: newMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
    });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 5 });

    // Verify renderCompactionSeed was called with empty tail.
    const { renderCompactionSeed } = await import("./compaction-seed.js");
    expect(renderCompactionSeed).toHaveBeenCalledTimes(1);
    const args = ((renderCompactionSeed as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? {}) as { tailK: number; tail: unknown[] };
    expect(args.tailK).toBe(5);
    expect(Array.isArray(args.tail)).toBe(true);
    expect(args.tail.length).toBe(0);
  });

  it("calls agent change handlers with new upstream info", async () => {
    const agentChangeInfos: Array<{ agentId: string; upstreamSessionId: string }> = [];

    const newMock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    const spawnReplacementAgent = vi.fn().mockResolvedValue({
      agent: newMock.agent,
      upstreamSessionId: "fresh_notify",
    });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_notify",
      cwd: "/w",
      agentId: "a1",
      agent: newMock.agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
    });

    session.onAgentChange((info) => {
      agentChangeInfos.push(info);
    });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 0 });

    expect(agentChangeInfos).toHaveLength(1);
    expect(agentChangeInfos[0]!.agentId).toBe("a1");
    expect(agentChangeInfos[0]!.upstreamSessionId.startsWith("fresh_notify")).toBe(true);
  });

  it("passes mcpServers config to spawnReplacementAgent (not empty array)", async () => {
    const mcpServers = [{ name: "test-mcp", url: "http://x" }];
    const newMock = makeMockAgent({ agentId: "a1", cwd: "/w" });
    const spawnReplacementAgent = vi.fn().mockResolvedValue({
      agent: newMock.agent,
      upstreamSessionId: "fresh_mcp",
    });

    const store = new HistoryStore();
    const session = new Session({
      sessionId: "hydra_swap_mcp",
      cwd: "/w",
      agentId: "a1",
      agent: makeMockAgent({ agentId: "a1", cwd: "/w" }).agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
      mcpServers,
    });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 0 });

    expect(spawnReplacementAgent).toHaveBeenCalledTimes(1);
    const spawnArg = (spawnReplacementAgent.mock.calls[0] as [{ mcpServers: unknown[] }])[0];
    expect(spawnArg.mcpServers).toEqual(mcpServers);
  });

  it("logs a warning when historyStore.load throws during swap", async () => {
    const { spawnReplacementAgent } = makeSpawnMock({ agentId: "a1" });
    const warnSpy = vi.fn();
    const logger = { info: vi.fn(), warn: warnSpy };

    const store = new HistoryStore();
    // Succeed on the first call (quiesce check in openToolCallIdsInHistory),
    // then reject on the second call (the swap's historyStore.load).
    vi.spyOn(store, "load")
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => Promise.reject(new Error("disk read error")));

    const session = new Session({
      sessionId: "hydra_swap_log_warn",
      cwd: "/w",
      agentId: "a1",
      agent: makeMockAgent({ agentId: "a1", cwd: "/w" }).agent,
      upstreamSessionId: "u1",
      historyStore: store,
      spawnReplacementAgent,
      logger,
    });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("historyStore"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("disk read error"),
    );
  });

  it("clears per-life usage fields on swap (used/size/costAmount) but preserves cumulativeCost", async () => {
    const { spawnReplacementAgent, oldMock } = makeSpawnMock({ agentId: "a1" });
    const session = new Session({
      sessionId: "hydra_swap_usage_reset",
      cwd: "/w",
      agentId: "a1",
      agent: oldMock.agent,
      upstreamSessionId: "u1",
      spawnReplacementAgent,
      currentUsage: {
        used: 877_690,
        size: 1_000_000,
        costAmount: 12.5,
        costCurrency: "USD",
        cumulativeCost: 50,
      },
    });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });

    // Per-life context utilization resets so the status bar shows "0
    // tokens used" right after the swap. used MUST be the explicit
    // value 0 (not undefined) so the TUI's usage_update handler
    // refreshes the display — that handler only writes when the field
    // is defined-and-different. size is preserved (model context
    // window is intrinsic to agent+model, not per-life). The
    // currentUsage getter folds cumulativeCost into costAmount for
    // display (50 prior + 12.5 just-accumulated = 62.5).
    expect(session.currentUsage?.used).toBe(0);
    expect(session.currentUsage?.size).toBe(1_000_000);
    expect(session.currentUsage?.costAmount).toBe(62.5);
    expect(session.currentUsage?.costCurrency).toBe("USD");
  });
  // The reason recorded here is the only thing that distinguishes these
  // rotations after the fact: on disk a compaction, a workspace move and
  // an agent switch are the same shape. Getting it from the one place
  // that knows to the persistence layer is the whole feature.
  describe("rotation reason reaches the persistence handler", () => {
    const captureReason = async (
      run: (session: Session) => Promise<void>,
      init: { agentId: string } = { agentId: "a1" },
    ): Promise<string | undefined> => {
      const { spawnReplacementAgent, oldMock } = makeSpawnMock(init);
      const session = new Session({
        sessionId: `hydra_swap_reason_${init.agentId}`,
        cwd: "/w",
        agentId: init.agentId,
        agent: oldMock.agent,
        upstreamSessionId: "u1",
        historyStore: new HistoryStore(),
        spawnReplacementAgent,
      });
      let seen: string | undefined;
      session.onAgentChange((info) => {
        seen = info.reason;
      });
      await run(session);
      return seen;
    };

    it("labels a plain swap as a compaction", async () => {
      const reason = await captureReason((s) =>
        s.swapUpstream({ artifact: makeSynopsis(), tailK: 2 }),
      );
      expect(reason).toBe("compaction");
    });

    it("labels a cross-agent swap as an agent-swap, not a compaction", async () => {
      const reason = await captureReason((s) =>
        s.swapUpstream({ artifact: makeSynopsis(), tailK: 2, newAgentId: "a2" }),
      );
      expect(reason).toBe("agent-swap");
    });

    it("labels entering a workspace as workspace-enter", async () => {
      const reason = await captureReason((s) =>
        s.swapIntoWorkspace({
          cwd: "/ws/feature",
          workspace: {
            path: "/ws/feature",
            label: "feature",
            sourceCwd: "/w",
            provider: "git-worktree",
          },
          historyLength: 3,
          note: "entering",
          synopsis: makeSynopsis(),
        }),
      );
      expect(reason).toBe("workspace-enter");
    });

    it("labels leaving a workspace as workspace-leave", async () => {
      const reason = await captureReason((s) =>
        s.swapIntoWorkspace({
          cwd: "/w",
          workspace: undefined,
          historyLength: 3,
          note: "leaving",
          synopsis: makeSynopsis(),
        }),
      );
      expect(reason).toBe("workspace-leave");
    });
  });
});

// Defect from a live incident: one `/hydra compact` that swapped twice
// left the breadcrumb aimed at the upstream the FIRST swap created: an
// already-compacted 80k seed, while still presenting itself as a
// rollback to pre-compaction state. Session's job is to report the runId
// on every swap; SessionManager.persistRollbackBreadcrumb does the
// pinning with it.
describe("rollback breadcrumb across a multi-swap run", () => {
  const makeSession = (
    sessionId: string,
    onCompactionSwapHook: (c: { previousUpstreamSessionId: string; runId?: string }) => void,
  ): Session => {
    const { spawnReplacementAgent, oldMock } = makeSpawnMock({ agentId: "a1" });
    return new Session({
      sessionId,
      cwd: "/w",
      agentId: "a1",
      agent: oldMock.agent,
      upstreamSessionId: "u_pre",
      historyStore: new HistoryStore(),
      spawnReplacementAgent,
      onCompactionSwapHook,
    });
  };

  it("carries the runId onto the breadcrumb", async () => {
    const crumbs: Array<{ previousUpstreamSessionId: string; runId?: string }> = [];
    const session = makeSession("hydra_swap_bc_runid", (c) => crumbs.push(c));

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2, runId: "run1" });

    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]!.previousUpstreamSessionId).toBe("u_pre");
    expect(crumbs[0]!.runId).toBe("run1");
  });

  it("reports the same runId on a second swap, so the pin can be held", async () => {
    const crumbs: Array<{ previousUpstreamSessionId: string; runId?: string }> = [];
    const session = makeSession("hydra_swap_bc_two", (c) => crumbs.push(c));

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2, runId: "run1" });
    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2, runId: "run1" });

    expect(crumbs).toHaveLength(2);
    // The second swap's "previous" IS the upstream the first swap just
    // created. This is the value that must not overwrite the pin.
    expect(crumbs[1]!.previousUpstreamSessionId).not.toBe("u_pre");
    expect(crumbs[1]!.previousUpstreamSessionId.startsWith("fresh_")).toBe(true);
    expect(crumbs[1]!.runId).toBe("run1");
  });

  it("omits runId when the swap is not part of a run", async () => {
    const crumbs: Array<{ previousUpstreamSessionId: string; runId?: string }> = [];
    const session = makeSession("hydra_swap_bc_norun", (c) => crumbs.push(c));

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });

    expect(crumbs[0]!.runId).toBeUndefined();
  });
});

// The status bar read 0/1.0M straight after a compaction: the cost reset
// writes used:0 before the seed runs, and the seeded agent's own report
// was captured for a log line and then dropped on the floor.
describe("context figure after a compaction swap", () => {
  it("adopts the seeded agent's reported context instead of leaving the reset 0", async () => {
    const { spawnReplacementAgent, oldMock, newMock } = makeSpawnMock({ agentId: "a1" });
    // The fresh agent reports its post-seed context while the seed
    // prompt is in flight, as claude-acp does.
    (newMock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
      async (method: string) => {
        if (method === "session/prompt") {
          newMock.triggerNotification("session/update", {
            sessionId: "agent-sess",
            update: { sessionUpdate: "usage_update", used: 80_340, size: 1_000_000 },
          });
          return { stopReason: "end_turn" };
        }
        return {};
      },
    );

    const session = new Session({
      sessionId: "hydra_swap_seed_usage",
      cwd: "/w",
      agentId: "a1",
      agent: oldMock.agent,
      upstreamSessionId: "u1",
      historyStore: new HistoryStore(),
      spawnReplacementAgent,
      currentUsage: { used: 973_659, size: 1_000_000 },
    });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });

    expect(session.currentUsage?.used).toBe(80_340);
    expect(session.currentUsage?.size).toBe(1_000_000);
  });

  it("leaves the reset 0 when the seeded agent reports nothing", async () => {
    const { spawnReplacementAgent, oldMock } = makeSpawnMock({ agentId: "a1" });
    const session = new Session({
      sessionId: "hydra_swap_seed_no_usage",
      cwd: "/w",
      agentId: "a1",
      agent: oldMock.agent,
      upstreamSessionId: "u1",
      historyStore: new HistoryStore(),
      spawnReplacementAgent,
      currentUsage: { used: 973_659, size: 1_000_000 },
    });

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });

    // No invented figure: 0 is honest when the agent hasn't said.
    expect(session.currentUsage?.used).toBe(0);
  });
});

// A swap kills the process that owned any armed background work. Both
// discharge paths (a resumption, or a TaskStop tool call) require that
// process, so an arming surviving the swap can never leave the map: the
// session reports "◐ waiting" with a climbing timer forever, for work
// nothing is doing.
describe("armed background tasks across a rotation", () => {
  const armMonitor = async (
    mock: ReturnType<typeof makeMockAgent>,
    toolCallId = "toolu_mon",
  ): Promise<void> => {
    await triggerUpdate(mock, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      title: "Monitor",
      rawInput: { description: "validation harness completion" },
      _meta: { claudeCode: { toolResponse: { taskId: `bg_${toolCallId}` } } },
    });
  };

  const makeArmedSession = async (
    sessionId: string,
  ): Promise<{ session: Session; oldMock: ReturnType<typeof makeMockAgent> }> => {
    const { spawnReplacementAgent, oldMock } = makeSpawnMock({ agentId: "a1" });
    const session = new Session({
      sessionId,
      cwd: "/w",
      agentId: "a1",
      agent: oldMock.agent,
      upstreamSessionId: "u1",
      historyStore: new HistoryStore(),
      spawnReplacementAgent,
    });
    await armMonitor(oldMock);
    expect(session.armedBackgroundTasks).toHaveLength(1);
    return { session, oldMock };
  };

  it("drops armings when compaction replaces the agent", async () => {
    const { session } = await makeArmedSession("hydra_swap_armed_compact");

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });

    expect(session.armedBackgroundTasks).toHaveLength(0);
    // The clock behind the TUI's "running Xs" readout has to go with it.
    expect(session.armedSince).toBeUndefined();
  });

  it("drops armings on a cross-agent switch", async () => {
    const { session } = await makeArmedSession("hydra_swap_armed_agent");

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2, newAgentId: "a2" });

    expect(session.armedBackgroundTasks).toHaveLength(0);
  });

  it("drops armings on workspace start", async () => {
    const { session } = await makeArmedSession("hydra_swap_armed_ws_start");

    await session.swapIntoWorkspace({
      cwd: "/ws/feature",
      workspace: {
        path: "/ws/feature",
        label: "feature",
        sourceCwd: "/w",
        provider: "git-worktree",
      },
      historyLength: 3,
      note: "entering",
      synopsis: makeSynopsis(),
    });

    expect(session.armedBackgroundTasks).toHaveLength(0);
  });

  // `stop` / `detach` / `discard` all funnel through leaveWorkspace, which
  // is the same swapIntoWorkspace call with no workspace.
  it("drops armings on workspace stop", async () => {
    const { session } = await makeArmedSession("hydra_swap_armed_ws_stop");

    await session.swapIntoWorkspace({
      cwd: "/w",
      workspace: undefined,
      historyLength: 3,
      note: "returning to the source tree",
      synopsis: makeSynopsis(),
    });

    expect(session.armedBackgroundTasks).toHaveLength(0);
    expect(session.armedSince).toBeUndefined();
  });

  // Every rotation kills through one choke point, so a path added later
  // cannot forget the discard half. Asserted behaviourally: the agent is
  // dead AND the map is empty, for each rotation kind.
  it("kills the old agent and clears armings together, on every rotation", async () => {
    const kinds: Array<[string, (s: Session) => Promise<unknown>]> = [
      ["compaction", (s) => s.swapUpstream({ artifact: makeSynopsis(), tailK: 2 })],
      ["agent-swap", (s) => s.swapUpstream({ artifact: makeSynopsis(), tailK: 2, newAgentId: "a2" })],
      [
        "workspace",
        (s) =>
          s.swapIntoWorkspace({
            cwd: "/ws/x",
            workspace: undefined,
            historyLength: 2,
            note: "n",
            synopsis: makeSynopsis(),
          }),
      ],
      ["restart", (s) => (s as unknown as { respawnAgent(): Promise<void> }).respawnAgent()],
    ];
    for (const [kind, run] of kinds) {
      const { session, oldMock } = await makeArmedSession(`hydra_rotation_${kind}`);
      await run(session);
      expect(oldMock.agent.kill, kind).toHaveBeenCalled();
      expect(session.armedBackgroundTasks, kind).toHaveLength(0);
    }
  });

  it("tells attached clients the tasks stopped, by name", async () => {
    const { session } = await makeArmedSession("hydra_swap_armed_notify");
    const { client, stream } = makeClient();
    session.attach(client, "full");

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });
    await new Promise((r) => setImmediate(r));

    const texts = stream.sent
      .map((m) => m as { method?: string; params?: unknown })
      .filter((m) => m.method === "session/update")
      .map((m) => {
        const u = (m.params as { update?: { content?: { text?: string } } }).update;
        return u?.content?.text ?? "";
      })
      .join("");
    expect(texts).toContain("Compaction completed.");
    // The label, not just a count: it is the difference between "a monitor
    // reported" and "a monitor was killed mid-watch".
    expect(texts).toContain("validation harness completion");
    expect(texts).toContain("Stopped 1 background task(s)");
  });

  it("says nothing about background tasks when none were armed", async () => {
    const { spawnReplacementAgent, oldMock } = makeSpawnMock({ agentId: "a1" });
    const session = new Session({
      sessionId: "hydra_swap_armed_none",
      cwd: "/w",
      agentId: "a1",
      agent: oldMock.agent,
      upstreamSessionId: "u1",
      historyStore: new HistoryStore(),
      spawnReplacementAgent,
    });
    const { client, stream } = makeClient();
    session.attach(client, "full");

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });
    await new Promise((r) => setImmediate(r));

    const texts = stream.sent
      .map((m) => m as { method?: string; params?: unknown })
      .filter((m) => m.method === "session/update")
      .map((m) => {
        const u = (m.params as { update?: { content?: { text?: string } } }).update;
        return u?.content?.text ?? "";
      })
      .join("");
    expect(texts).toContain("Compaction completed.");
    expect(texts).not.toContain("background task");
  });

  // /hydra restart and forceCancel both kill and respawn. The transcript
  // replay restores what was SAID; nothing restores what was running.
  it("drops armings when the agent is restarted in place", async () => {
    const { session } = await makeArmedSession("hydra_swap_armed_restart");

    await (session as unknown as { respawnAgent(): Promise<void> }).respawnAgent();

    expect(session.armedBackgroundTasks).toHaveLength(0);
    expect(session.armedSince).toBeUndefined();
  });
});
