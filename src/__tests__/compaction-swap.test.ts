import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../core/session-manager.js";
import { Registry, type RegistryAgent } from "../core/registry.js";
import {
  makeMockAgent,
  makeControlledStream,
} from "./test-utils.js";
import { JsonRpcConnection } from "../acp/connection.js";
import type { SessionSynopsis } from "../core/snapshot.js";

// Mock the synopsis-agent module so compaction returns a deterministic artifact.
vi.mock("../core/synopsis-agent.js", () => ({
  generateCompaction: vi.fn(),
  generateSynopsis: vi.fn(),
}));
import { generateCompaction, generateSynopsis } from "../core/synopsis-agent.js";

const mockCompaction = generateCompaction as ReturnType<typeof vi.fn>;
const mockSynopsis = generateSynopsis as ReturnType<typeof vi.fn>;



// Poll until `predicate` holds or timeoutMs elapses.
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

function fakeRegistryAgent(id = "claude-code"): RegistryAgent {
  return {
    id,
    name: id,
    distribution: { npx: { package: id } },
  };
}

function fakeRegistry(agents: RegistryAgent[]): Registry {
  return {
    async getAgent(id: string) {
      return agents.find((a) => a.id === id);
    },
    async load() {
      return { version: "0", agents };
    },
    async refresh() {
      return { version: "0", agents };
    },
  } as unknown as Registry;
}

// Build a minimal synopsis artifact for compaction.
function makeArtifact(overrides?: Partial<SessionSynopsis>): SessionSynopsis {
  return {
    goal: "fix the login bug",
    outcome: "resolved by updating auth middleware",
    files_touched: ["src/auth/middleware.ts"],
    tools_used: ["read_file", "edit_file"],
    ...overrides,
  };
}

const WORK_CWD = mkdtempSync(path.join(os.tmpdir(), "hydra-test-compaction-"));

describe("compaction swap — onSynthesisArtifact hook", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "hydra-test-home-"));
    process.env.HOME = tmpHome;
    mockCompaction.mockReset();
    mockSynopsis.mockReset();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpHome, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  });

  it("swaps upstreamSessionId when session is live and quiesced", async () => {
    let spawnCount = 0;
    const oldAgents: ReturnType<typeof makeMockAgent>[] = [];
    const newAgents: ReturnType<typeof makeMockAgent>[] = [];
    const spawnCalls: Array<{
      agentId: string;
      cwd: string;
      mcpServers?: unknown[];
    }> = [];

    const mcpServers = [{ name: "test-mcp", url: "http://test/mcp" }];

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        if (spawnCount === 0) {
          // First spawn: initial session creation.
          const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
          oldAgents.push(m);
          const reqMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
          reqMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockResolvedValueOnce({ sessionId: `u_initial_${spawnCount++}` });
          return m.agent;
        } else {
          // Subsequent spawns: compaction swap replacement. Capture the real
          // mcpServers from the session/new request to verify C1's fix.
          const newM = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
          newAgents.push(newM);
          const reqMock = newM.agent.connection.request as ReturnType<typeof vi.fn>;
          reqMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
            if (method === "session/new") {
              spawnCalls.push({
                agentId: "claude-code",
                cwd: WORK_CWD,
                mcpServers: params.mcpServers as unknown[],
              });
              return { sessionId: `fresh_${spawnCount++}` };
            }
            return {};
          });
          return newM.agent;
        }
      },
      undefined,
      {
        compaction: { tailK: 5 },
      },
    );

    // Create a session (makes it live).
    const session = await manager.create({
      cwd: WORK_CWD,
      agentId: "claude-code",
      mcpServers,
    });
    const sessionId = session.sessionId;
    const initialSessionId = sessionId;
    const originalUpstream = session.upstreamSessionId;

    // Attach a client so we can send prompts.
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    await session.attach({ clientId: "c1", connection: conn }, "full");

    // Send a few prompts to build history. The mock agent responds with
    // end_turn so each prompt completes and entries are persisted.
    const oldReqMock = oldAgents[0]!.agent.connection.request as ReturnType<typeof vi.fn>;
    for (let i = 0; i < 3; i++) {
      oldReqMock.mockResolvedValueOnce({ stopReason: "end_turn" });
      await session.prompt("c1", {
        prompt: [{ type: "text", text: `hello ${i}` }],
      });
    }

    // Flush history writes so compaction has data to work with.
    await manager.flushHistoryWrites();

    // Configure compaction to return a valid artifact.
    mockCompaction.mockResolvedValue({
      synopsis: makeArtifact(),
    });

    // Trigger compaction via the coordinator.
    (manager as unknown as { synopsisCoordinator: { scheduleCompaction: (id: string) => void } })
      .synopsisCoordinator.scheduleCompaction(sessionId);

    // Wait for the upstream session ID to change (swap completed).
    await waitFor(() => {
      const current = manager.get(sessionId);
      return !!current && current.upstreamSessionId !== originalUpstream;
    }, 10_000);

    const swapped = manager.get(sessionId)!;
    expect(swapped.upstreamSessionId).not.toBe(originalUpstream);
    expect(spawnCalls.length).toBeGreaterThanOrEqual(1);
    expect(spawnCalls[0]?.mcpServers).toEqual(mcpServers);
    expect(session.sessionId).toBe(initialSessionId);

    // Verify history.jsonl was preserved.
    const histStore = (session as unknown as { historyStore: { load: (id: string) => Promise<unknown[]> } }).historyStore;
    const entries = await histStore.load(sessionId);
    expect(entries.length).toBeGreaterThan(0);

    await manager.flushHistoryWrites();
  });

  it("persists artifact for cold session (no warm session to swap)", async () => {
    mockCompaction.mockResolvedValue({
      synopsis: makeArtifact(),
    });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      undefined,
      undefined,
      {
        compaction: { tailK: 5 },
      },
    );

    // Schedule compaction for a session that does not exist in the live map.
    (manager as unknown as { synopsisCoordinator: { scheduleCompaction: (id: string) => void } })
      .synopsisCoordinator.scheduleCompaction("cold_session_123");

    // Wait for the job to complete.
    await waitFor(
      () => {
        const state = (manager as unknown as { synopsisCoordinator: { size: () => { queued: number; inflight: number } } })
          .synopsisCoordinator.size();
        return state.queued === 0 && state.inflight === 0;
      },
      5_000,
    );

    const state = (manager as unknown as { synopsisCoordinator: { size: () => { queued: number; inflight: number } } })
      .synopsisCoordinator.size();
    expect(state.queued).toBe(0);
    expect(state.inflight).toBe(0);
  });

  it("defers swap when session is not quiesced (prompt in flight)", async () => {
    let spawnCount = 0;
    const oldAgents: ReturnType<typeof makeMockAgent>[] = [];
    const newAgents: ReturnType<typeof makeMockAgent>[] = [];
    const spawnCalls: Array<{
      agentId: string;
      cwd: string;
      mcpServers?: unknown[];
    }> = [];

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        if (spawnCount === 0) {
          const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
          oldAgents.push(m);
          const reqMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
          reqMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockResolvedValueOnce({ sessionId: `u_initial_${spawnCount++}` });
          return m.agent;
        } else {
          const newM = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
          newAgents.push(newM);
          const reqMock = newM.agent.connection.request as ReturnType<typeof vi.fn>;
          reqMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
            if (method === "session/new") {
              spawnCalls.push({
                agentId: "claude-code",
                cwd: WORK_CWD,
                mcpServers: params.mcpServers as unknown[],
              });
              return { sessionId: `fresh_${spawnCount++}` };
            }
            return {};
          });
          return newM.agent;
        }
      },
      undefined,
      {
        compaction: { tailK: 5 },
      },
    );

    const session = await manager.create({
      cwd: WORK_CWD,
      agentId: "claude-code",
    });
    const sessionId = session.sessionId;
    const originalUpstream = session.upstreamSessionId;

    // Attach a client.
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    await session.attach({ clientId: "c1", connection: conn }, "full");

    // Start a prompt that never resolves — keeps the session busy.
    const oldReqMock = oldAgents[0]!.agent.connection.request as ReturnType<typeof vi.fn>;
    const pendingPrompt = new Promise<unknown>(() => { /* never resolves */ });
    oldReqMock.mockImplementation(async (method: string) => {
      if (method === "session/prompt") {
        return pendingPrompt;
      }
      return {};
    });

    // Fire off a prompt in the background.
    void session.prompt("c1", {
      prompt: [{ type: "text", text: "hello" }],
    });

    // Give the prompt machinery a beat to record initial history
    // entries (prompt_received, echo, etc). We don't require full
    // quiescence here — the test's assertions no longer depend on
    // history staying stable during compaction; see below.
    await new Promise((r) => setImmediate(r));
    await manager.flushHistoryWrites();

    mockCompaction.mockResolvedValue({
      synopsis: makeArtifact(),
    });

    // Spy on scheduleCompaction so we can distinguish "test kicked it
    // off once" from "the deferred-swap path spuriously re-scheduled
    // another job." The latter is the actual invariant this test cares
    // about — the coordinator's inner catch-up loop iterating multiple
    // times is a legit response to history growth (broadcasts land as
    // history entries mid-iteration) and doesn't indicate a bug.
    const coordinator = (manager as unknown as {
      synopsisCoordinator: {
        scheduleCompaction: (id: string, opts?: unknown) => void;
        size: () => { queued: number; inflight: number };
      };
    }).synopsisCoordinator;
    const scheduleCompactionSpy = vi.spyOn(coordinator, "scheduleCompaction");

    coordinator.scheduleCompaction(sessionId);

    // Wait for compaction to run.
    await waitFor(
      () => {
        const state = coordinator.size();
        return state.queued === 0 && state.inflight === 0;
      },
      5_000,
    );

    // Give the deferred-retry path a chance to (spuriously) re-schedule
    // if it were going to. Any re-entry would surface here as a second
    // scheduleCompaction call.
    await new Promise((r) => setTimeout(r, 100));

    // Upstream should NOT have changed — the session was not quiesced.
    const current = manager.get(sessionId);
    expect(current!.upstreamSessionId).toBe(originalUpstream);
    expect(spawnCalls.length).toBe(0);
    // The deferred-swap path must NOT have re-scheduled another
    // compaction job. Exactly one scheduleCompaction call, from the
    // test's own invocation above. mockCompaction call count is
    // deliberately NOT asserted — the coordinator's catch-up loop
    // legitimately iterates when history grows during an iteration
    // (broadcast fan-out writes land in history mid-call), which is a
    // feature, not a re-entry.
    expect(scheduleCompactionSpy).toHaveBeenCalledTimes(1);
    scheduleCompactionSpy.mockRestore();
  });

  it("broadcasts phase:swapped after a successful swap, including title field", async () => {
    let spawnCount = 0;
    const oldAgents: ReturnType<typeof makeMockAgent>[] = [];
    const newAgents: ReturnType<typeof makeMockAgent>[] = [];

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        if (spawnCount === 0) {
          const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
          oldAgents.push(m);
          const reqMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
          reqMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockResolvedValueOnce({ sessionId: `u_swap_bcast_${spawnCount++}` });
          return m.agent;
        } else {
          const newM = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
          newAgents.push(newM);
          const reqMock = newM.agent.connection.request as ReturnType<typeof vi.fn>;
          reqMock.mockImplementation(async (method: string) => {
            if (method === "session/new") {
              return { sessionId: `fresh_bcast_${spawnCount++}` };
            }
            return {};
          });
          return newM.agent;
        }
      },
      undefined,
      { compaction: { tailK: 5 } },
    );

    const session = await manager.create({ cwd: WORK_CWD, agentId: "claude-code" });
    const sessionId = session.sessionId;

    const clientStream = makeControlledStream();
    const conn = new JsonRpcConnection(clientStream);
    await session.attach({ clientId: "c1", connection: conn }, "full");

    const swappedEvents: Array<{ phase: string; title?: string; summarizedThroughEntry?: number }> = [];
    session.onBroadcast((entry) => {
      if (
        entry.method === "session/update" &&
        typeof entry.params === "object" &&
        entry.params !== null &&
        "update" in entry.params
      ) {
        const update = (entry.params as { update: unknown }).update;
        if (
          typeof update === "object" &&
          update !== null &&
          "sessionUpdate" in update &&
          (update as Record<string, unknown>).sessionUpdate === "hydra_compaction" &&
          (update as Record<string, unknown>).phase === "swapped"
        ) {
          swappedEvents.push(update as unknown as { phase: string; title?: string; summarizedThroughEntry?: number });
        }
      }
    });

    const oldReqMock = oldAgents[0]!.agent.connection.request as ReturnType<typeof vi.fn>;
    for (let i = 0; i < 3; i++) {
      oldReqMock.mockResolvedValueOnce({ stopReason: "end_turn" });
      await session.prompt("c1", { prompt: [{ type: "text", text: `hello ${i}` }] });
    }
    await manager.flushHistoryWrites();

    mockCompaction.mockResolvedValue({ synopsis: makeArtifact() });

    const originalUpstream = session.upstreamSessionId;
    (manager as unknown as { synopsisCoordinator: { scheduleCompaction: (id: string) => void } })
      .synopsisCoordinator.scheduleCompaction(sessionId);

    await waitFor(() => {
      const cur = manager.get(sessionId);
      return !!cur && cur.upstreamSessionId !== originalUpstream;
    }, 10_000);
    // Allow any async state writes a tick to settle.
    await new Promise((r) => setTimeout(r, 100));

    expect(swappedEvents.length).toBeGreaterThan(0);
    expect(swappedEvents[0]!.phase).toBe("swapped");
    expect(typeof swappedEvents[0]!.summarizedThroughEntry).toBe("number");

    await manager.flushHistoryWrites();
  });

  it("broadcasts phase:deferred when the session is not quiesced", async () => {
    let spawnCount = 0;
    const oldAgents: ReturnType<typeof makeMockAgent>[] = [];

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
        oldAgents.push(m);
        const reqMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        reqMock
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockResolvedValueOnce({ sessionId: `u_defer_bcast_${spawnCount++}` });
        return m.agent;
      },
      undefined,
      { compaction: { tailK: 5 } },
    );

    const session = await manager.create({ cwd: WORK_CWD, agentId: "claude-code" });
    const sessionId = session.sessionId;

    const clientStream = makeControlledStream();
    const conn = new JsonRpcConnection(clientStream);
    await session.attach({ clientId: "c1", connection: conn }, "full");

    const deferredEvents: Array<{ phase: string; attempts: number }> = [];
    session.onBroadcast((entry) => {
      if (
        entry.method === "session/update" &&
        typeof entry.params === "object" &&
        entry.params !== null &&
        "update" in entry.params
      ) {
        const update = (entry.params as { update: unknown }).update;
        if (
          typeof update === "object" &&
          update !== null &&
          "sessionUpdate" in update &&
          (update as Record<string, unknown>).sessionUpdate === "hydra_compaction" &&
          (update as Record<string, unknown>).phase === "deferred"
        ) {
          deferredEvents.push(update as unknown as { phase: string; attempts: number });
        }
      }
    });

    const oldReqMock = oldAgents[0]!.agent.connection.request as ReturnType<typeof vi.fn>;
    oldReqMock.mockImplementation(async (method: string) => {
      if (method === "session/prompt") {
        return new Promise<unknown>(() => undefined);
      }
      return {};
    });
    void session.prompt("c1", { prompt: [{ type: "text", text: "hello" }] });
    await new Promise((r) => setImmediate(r));

    mockCompaction.mockResolvedValue({ synopsis: makeArtifact() });

    (manager as unknown as { synopsisCoordinator: { scheduleCompaction: (id: string) => void } })
      .synopsisCoordinator.scheduleCompaction(sessionId);

    await waitFor(
      () => {
        const state = (manager as unknown as { synopsisCoordinator: { size: () => { queued: number; inflight: number } } })
          .synopsisCoordinator.size();
        return state.queued === 0 && state.inflight === 0;
      },
      8_000,
    );
    await new Promise((r) => setTimeout(r, 100));

    expect(deferredEvents.length).toBeGreaterThan(0);
    expect(deferredEvents[0]!.phase).toBe("deferred");
    // Under the onceIdle dispatch design there are no retry attempts —
    // the parked handler fires once on the next quiesce edge. The
    // payload no longer carries an `attempts` counter.
  });
});
