import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../core/session-manager.js";
import { SessionStore } from "../core/session-store.js";
import { Registry, type RegistryAgent } from "../core/registry.js";
import {
  makeMockAgent,
  makeControlledStream,
} from "./test-utils.js";
import { JsonRpcConnection } from "../acp/connection.js";
import type { SessionSynopsis } from "../core/snapshot.js";

vi.mock("../core/synopsis-agent.js", () => ({
  generateCompaction: vi.fn(),
  generateSynopsis: vi.fn(),
}));
import { generateCompaction } from "../core/synopsis-agent.js";

const mockCompaction = generateCompaction as ReturnType<typeof vi.fn>;

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

function makeArtifact(overrides?: Partial<SessionSynopsis>): SessionSynopsis {
  return {
    goal: "fix the login bug",
    outcome: "resolved by updating auth middleware",
    files_touched: ["src/auth/middleware.ts"],
    tools_used: ["read_file", "edit_file"],
    ...overrides,
  };
}

const WORK_CWD = mkdtempSync(path.join(os.tmpdir(), "hydra-test-uncompact-"));

describe("compaction uncompact — rollback", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "hydra-test-home-"));
    process.env.HOME = tmpHome;
    mockCompaction.mockReset();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpHome, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  });

  it("happy path: breadcrumb is written on swap, rollback restores previous upstream", async () => {
    let spawnCount = 0;
    const allAgents: ReturnType<typeof makeMockAgent>[] = [];

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
        allAgents.push(m);
        const reqMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        const idx = spawnCount;
        spawnCount++;
        if (idx === 0) {
          // Initial session spawn: session/new.
          reqMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockResolvedValueOnce({ sessionId: `upstream_initial_${idx}` });
        } else {
          // Compaction swap: session/new.
          reqMock.mockImplementation(async (method: string) => {
            if (method === "session/new") {
              return { sessionId: `upstream_post_compaction_${idx}` };
            }
            if (method === "session/load") {
              // Rollback: session/load restores the previous upstream.
              return { sessionId: `upstream_initial_0` };
            }
            return {};
          });
        }
        return m.agent;
      },
      undefined,
      { compaction: { tailK: 5 } },
    );

    const session = await manager.create({
      cwd: WORK_CWD,
      agentId: "claude-code",
    });
    const sessionId = session.sessionId;
    const originalUpstream = session.upstreamSessionId;

    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    await session.attach({ clientId: "c1", connection: conn }, "full");

    const firstAgentReq = allAgents[0]!.agent.connection.request as ReturnType<typeof vi.fn>;
    for (let i = 0; i < 3; i++) {
      firstAgentReq.mockResolvedValueOnce({ stopReason: "end_turn" });
      await session.prompt("c1", {
        prompt: [{ type: "text", text: `hello ${i}` }],
      });
    }
    await manager.flushHistoryWrites();

    mockCompaction.mockResolvedValue({ synopsis: makeArtifact() });

    (manager as unknown as { synopsisCoordinator: { scheduleCompaction: (id: string) => void } })
      .synopsisCoordinator.scheduleCompaction(sessionId);

    // Wait for the swap to complete.
    await waitFor(() => {
      const s = manager.get(sessionId);
      return !!s && s.upstreamSessionId !== originalUpstream;
    }, 10_000);

    const postSwapUpstream = manager.get(sessionId)!.upstreamSessionId;
    expect(postSwapUpstream).not.toBe(originalUpstream);

    // Breadcrumb should be present in meta.json.
    const store = new SessionStore();
    const record = await store.read(sessionId);
    expect(record?.rollbackBreadcrumb).toBeDefined();
    expect(record?.rollbackBreadcrumb?.previousUpstreamSessionId).toBe(originalUpstream);

    // Perform rollback.
    await manager.performUncompact(sessionId);

    // After rollback the session should be on a new upstream (session/load result).
    const rolledBack = manager.get(sessionId)!;
    expect(rolledBack.upstreamSessionId).not.toBe(postSwapUpstream);

    // Breadcrumb must be cleared from meta.json.
    await manager.flushMetaWrites();
    const recordAfter = await store.read(sessionId);
    expect(recordAfter?.rollbackBreadcrumb).toBeUndefined();

    // Synopsis must be cleared.
    expect(recordAfter?.synopsis).toBeUndefined();
  });

  it("guard: fails when no breadcrumb exists", async () => {
    let spawnCount = 0;

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
        const reqMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        spawnCount++;
        reqMock
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockResolvedValueOnce({ sessionId: `up_${spawnCount}` });
        return m.agent;
      },
      undefined,
      { compaction: { tailK: 5 } },
    );

    const session = await manager.create({ cwd: WORK_CWD, agentId: "claude-code" });

    await expect(manager.performUncompact(session.sessionId)).rejects.toThrow(
      /no rollback breadcrumb/i,
    );
  });

  it("guard: fails when session is not live (cold)", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      undefined,
      undefined,
      { compaction: { tailK: 5 } },
    );

    await expect(manager.performUncompact("nonexistent_session_id")).rejects.toThrow(
      /not live/i,
    );
  });

  it("guard: fails when compaction is in progress", async () => {
    let spawnCount = 0;

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
        const reqMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        spawnCount++;
        reqMock
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockResolvedValueOnce({ sessionId: `up_${spawnCount}` });
        return m.agent;
      },
      undefined,
      { compaction: { tailK: 5 } },
    );

    const session = await manager.create({ cwd: WORK_CWD, agentId: "claude-code" });

    // Inject a rollback breadcrumb AND a compactionState to simulate in-progress compaction.
    const mutateRecord = (manager as unknown as {
      mutateRecord: (id: string, fields: Record<string, unknown>) => Promise<void>;
    }).mutateRecord.bind(manager);

    await mutateRecord(session.sessionId, {
      rollbackBreadcrumb: {
        previousUpstreamSessionId: "old_upstream",
      },
      compactionState: {
        status: "running",
        requestedAt: Date.now(),
        iter: 1,
      },
    });

    await expect(manager.performUncompact(session.sessionId)).rejects.toThrow(
      /compaction is in progress/i,
    );
  });

  it("breadcrumb persisted to meta.json on swap", async () => {
    let spawnCount = 0;

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
        const reqMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        const idx = spawnCount++;
        if (idx === 0) {
          reqMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockResolvedValueOnce({ sessionId: `up_initial_${idx}` });
        } else {
          reqMock.mockImplementation(async (method: string) => {
            if (method === "session/new") {
              return { sessionId: `up_post_${idx}` };
            }
            return {};
          });
        }
        return m.agent;
      },
      undefined,
      { compaction: { tailK: 5 } },
    );

    const session = await manager.create({ cwd: WORK_CWD, agentId: "claude-code" });
    const sessionId = session.sessionId;
    const initialUpstream = session.upstreamSessionId;

    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    await session.attach({ clientId: "c1", connection: conn }, "full");

    const firstAgentReq = (manager.get(sessionId)!.agent as ReturnType<typeof makeMockAgent>["agent"]);
    const reqMock = firstAgentReq.connection.request as ReturnType<typeof vi.fn>;
    for (let i = 0; i < 3; i++) {
      reqMock.mockResolvedValueOnce({ stopReason: "end_turn" });
      await session.prompt("c1", { prompt: [{ type: "text", text: `msg ${i}` }] });
    }
    await manager.flushHistoryWrites();

    mockCompaction.mockResolvedValue({ synopsis: makeArtifact() });

    (manager as unknown as { synopsisCoordinator: { scheduleCompaction: (id: string) => void } })
      .synopsisCoordinator.scheduleCompaction(sessionId);

    await waitFor(() => {
      const s = manager.get(sessionId);
      return !!s && s.upstreamSessionId !== initialUpstream;
    }, 10_000);

    await manager.flushMetaWrites();

    const store = new SessionStore();
    const record = await store.read(sessionId);
    expect(record?.rollbackBreadcrumb).toBeDefined();
    expect(record?.rollbackBreadcrumb?.previousUpstreamSessionId).toBe(initialUpstream);
  });

  it("breadcrumb cleared when a new user prompt is dispatched", async () => {
    let spawnCount = 0;

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
        const reqMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        const idx = spawnCount++;
        if (idx === 0) {
          reqMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockResolvedValueOnce({ sessionId: `up_init_${idx}` });
        } else {
          reqMock.mockImplementation(async (method: string) => {
            if (method === "session/new") {
              return { sessionId: `up_post_${idx}` };
            }
            return {};
          });
        }
        return m.agent;
      },
      undefined,
      { compaction: { tailK: 5 } },
    );

    const session = await manager.create({ cwd: WORK_CWD, agentId: "claude-code" });
    const sessionId = session.sessionId;
    const initialUpstream = session.upstreamSessionId;

    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    await session.attach({ clientId: "c1", connection: conn }, "full");

    const firstReqMock = session.agent.connection.request as ReturnType<typeof vi.fn>;
    for (let i = 0; i < 3; i++) {
      firstReqMock.mockResolvedValueOnce({ stopReason: "end_turn" });
      await session.prompt("c1", { prompt: [{ type: "text", text: `msg ${i}` }] });
    }
    await manager.flushHistoryWrites();

    mockCompaction.mockResolvedValue({ synopsis: makeArtifact() });
    (manager as unknown as { synopsisCoordinator: { scheduleCompaction: (id: string) => void } })
      .synopsisCoordinator.scheduleCompaction(sessionId);

    await waitFor(() => {
      const s = manager.get(sessionId);
      return !!s && s.upstreamSessionId !== initialUpstream;
    }, 10_000);

    await manager.flushMetaWrites();

    // Verify breadcrumb is present.
    const store = new SessionStore();
    let record = await store.read(sessionId);
    expect(record?.rollbackBreadcrumb).toBeDefined();

    // Send a new user prompt to the post-compaction agent — this should clear the breadcrumb.
    const postSwapReqMock = session.agent.connection.request as ReturnType<typeof vi.fn>;
    postSwapReqMock.mockResolvedValueOnce({ stopReason: "end_turn" });
    await session.prompt("c1", { prompt: [{ type: "text", text: "new prompt after swap" }] });

    await manager.flushMetaWrites();

    record = await store.read(sessionId);
    expect(record?.rollbackBreadcrumb).toBeUndefined();
  });

  it("guard: concurrent rollback requests are rejected", async () => {
    let spawnCount = 0;

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
        const reqMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        spawnCount++;
        reqMock
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockResolvedValueOnce({ sessionId: `up_${spawnCount}` });
        return m.agent;
      },
      undefined,
      { compaction: { tailK: 5 } },
    );

    const session = await manager.create({ cwd: WORK_CWD, agentId: "claude-code" });
    const sessionId = session.sessionId;

    // Manually set rollbackLocks to simulate a concurrent rollback.
    (manager as unknown as { rollbackLocks: Set<string> }).rollbackLocks.add(sessionId);

    await expect(manager.performUncompact(sessionId)).rejects.toThrow(
      /rollback is already in progress/i,
    );
  });
});
