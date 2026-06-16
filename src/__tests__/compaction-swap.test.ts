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
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
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

describe("compaction swap — onCompactionArtifact hook", () => {
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
          // Subsequent spawns: compaction swap replacement.
          const newM = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
          newAgents.push(newM);
          const reqMock = newM.agent.connection.request as ReturnType<typeof vi.fn>;
          reqMock.mockResolvedValue({ sessionId: `fresh_${spawnCount++}` });
          spawnCalls.push({
            agentId: "claude-code",
            cwd: WORK_CWD,
            mcpServers: [],
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
    });
    const sessionId = session.sessionId;
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

    // Verify history.jsonl was preserved.
    const histStore = (session as unknown as { historyStore: { load: (id: string) => Promise<unknown[]> } }).historyStore;
    const entries = await histStore.load(sessionId);
    expect(entries.length).toBeGreaterThan(0);

    await manager.flushHistoryWrites();
  });

  it("persists artifact for cold session (no live session to swap)", async () => {
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
          reqMock.mockResolvedValue({ sessionId: `fresh_${spawnCount++}` });
          spawnCalls.push({
            agentId: "claude-code",
            cwd: WORK_CWD,
            mcpServers: [],
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

    // Give it a tick to start processing.
    await new Promise((r) => setImmediate(r));

    // Configure compaction and trigger it.
    mockCompaction.mockResolvedValue({
      synopsis: makeArtifact(),
    });

    (manager as unknown as { synopsisCoordinator: { scheduleCompaction: (id: string) => void } })
      .synopsisCoordinator.scheduleCompaction(sessionId);

    // Wait for compaction to run.
    await waitFor(
      () => {
        const state = (manager as unknown as { synopsisCoordinator: { size: () => { queued: number; inflight: number } } })
          .synopsisCoordinator.size();
        return state.queued === 0 && state.inflight === 0;
      },
      5_000,
    );

    // Upstream should NOT have changed — the session was not quiesced.
    const current = manager.get(sessionId);
    expect(current!.upstreamSessionId).toBe(originalUpstream);
    expect(spawnCalls.length).toBe(0);
  });
});
