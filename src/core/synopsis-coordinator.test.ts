import { describe, it, expect, vi, beforeEach } from "vitest";
import { SynopsisCoordinator } from "./synopsis-coordinator.js";
import type { SessionRecord } from "./session-store.js";
import type { SessionSynopsis } from "./snapshot.js";

// Tests use a thin in-memory shim for the deps the coordinator pulls
// from SessionManager so we don't have to spin a full daemon. The only
// expensive bit (generateSynopsis spawning a real subprocess) is replaced by
// mocking the synopsis-agent module inline below.
vi.mock("./synopsis-agent.js", () => ({
  generateCompaction: vi.fn(),
  generateSynopsis: vi.fn(),
}));
import { generateCompaction, generateSynopsis } from "./synopsis-agent.js";

const mockGenerate = generateSynopsis as ReturnType<typeof vi.fn>;
const mockCompaction = generateCompaction as ReturnType<typeof vi.fn>;

// Poll until `predicate` holds, instead of sleeping a fixed interval and
// hoping the async drain ran. A fixed sleep is flaky under a loaded
// parallel suite where the drain timer/microtask can slip past the
// window; polling waits exactly as long as needed (up to `timeoutMs`).
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeRecord(opts: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: 1,
    sessionId: "sess_test",
    upstreamSessionId: "u_test",
    agentId: "test-agent",
    cwd: "/w",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...opts,
  };
}

function makeStore(records: Map<string, SessionRecord>) {
  return {
    async read(id: string): Promise<SessionRecord | undefined> {
      return records.get(id);
    },
  } as never;
}

function makeHistories(histories: Map<string, unknown[]>) {
  return {
    async load(id: string): Promise<unknown[]> {
      // Return a copy so mutations to the backing array don't affect
      // previously loaded snapshots — mirrors loading from disk.
      return [...(histories.get(id) ?? [])];
    },
  } as never;
}

function makeRegistry(agent: unknown) {
  return {
    async getAgent(): Promise<unknown> {
      return agent;
    },
  } as never;
}

// Stub planSpawn since it normally hits the registry's install logic.
vi.mock("./registry.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./registry.js")>();
  return {
    ...orig,
    planSpawn: vi.fn(async () => ({
      command: "/bin/true",
      args: [],
      env: {},
      version: "test",
    })),
  };
});

describe("SynopsisCoordinator", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    mockCompaction.mockReset();
  });

  it("schedules and runs a single job on the happy path", async () => {
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const histories = new Map([[record.sessionId, [{}, {}, {}]]]);
    const persistedTitles: Array<{ id: string; title: string }> = [];
    const persistedSynopses: Array<{
      id: string;
      synopsis: SessionSynopsis;
      through: number;
    }> = [];
    const synopsis: SessionSynopsis = { goal: "ship it" };
    mockGenerate.mockResolvedValue({
      title: "Ship the thing",
      synopsis,
    });

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(histories),
      
      persistTitle: async (id, title) => {
        persistedTitles.push({ id, title });
      },
      persistSynopsis: async (id, s, through) => {
        persistedSynopses.push({ id, synopsis: s, through });
      },
    });
    coord.schedule(record.sessionId);
    await coord.flush(5_000);

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(persistedTitles).toEqual([
      { id: record.sessionId, title: "Ship the thing" },
    ]);
    expect(persistedSynopses).toHaveLength(1);
    expect(persistedSynopses[0]!.synopsis.goal).toBe("ship it");
    expect(persistedSynopses[0]!.through).toBe(3);
  });

  it("dedups: scheduling the same session twice runs generateSynopsis once", async () => {
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const histories = new Map([[record.sessionId, [{}]]]);
    mockGenerate.mockResolvedValue({ title: "t", synopsis: { goal: "g" } });

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(histories),
      
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
    });
    coord.schedule(record.sessionId);
    coord.schedule(record.sessionId);
    coord.schedule(record.sessionId);
    await coord.flush(5_000);

    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("skips when summarizedThroughEntry >= history.length", async () => {
    const record = makeRecord({ summarizedThroughEntry: 5 });
    const records = new Map([[record.sessionId, record]]);
    const histories = new Map([[record.sessionId, [{}, {}, {}, {}, {}]]]);

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(histories),
      
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
    });
    coord.schedule(record.sessionId);
    await coord.flush(5_000);

    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("runs first-time job (no offset) regardless of history length", async () => {
    const record = makeRecord({ summarizedThroughEntry: undefined });
    const records = new Map([[record.sessionId, record]]);
    const histories = new Map([[record.sessionId, []]]);
    mockGenerate.mockResolvedValue({ title: "t", synopsis: { goal: "g" } });

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(histories),
      
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
    });
    coord.schedule(record.sessionId);
    await coord.flush(5_000);

    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("bounds concurrency", async () => {
    const records = new Map<string, SessionRecord>();
    const histories = new Map<string, unknown[]>();
    for (const id of ["s1", "s2", "s3", "s4"]) {
      records.set(id, makeRecord({ sessionId: id }));
      histories.set(id, [{}, {}]);
    }
    let inflight = 0;
    let maxInflight = 0;
    mockGenerate.mockImplementation(async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 30));
      inflight -= 1;
      return { synopsis: { goal: "g" } };
    });

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(histories),
      
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
      maxConcurrent: 2,
    });
    coord.schedule("s1");
    coord.schedule("s2");
    coord.schedule("s3");
    coord.schedule("s4");
    await coord.flush(5_000);

    expect(maxInflight).toBeLessThanOrEqual(2);
    expect(mockGenerate).toHaveBeenCalledTimes(4);
  });

  it("does not persist on generateSynopsis parse failure (undefined return)", async () => {
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const histories = new Map([[record.sessionId, [{}]]]);
    const persistedSynopses: unknown[] = [];
    mockGenerate.mockResolvedValue(undefined);

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(histories),
      
      persistTitle: async () => undefined,
      persistSynopsis: async (id, s, t) => {
        persistedSynopses.push({ id, s, t });
      },
    });
    coord.schedule(record.sessionId);
    await coord.flush(5_000);

    expect(persistedSynopses).toHaveLength(0);
  });

  it("shutdown() stops accepting new schedules and waits for in-flight", async () => {
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const histories = new Map([[record.sessionId, [{}]]]);
    let resolveSyn: ((v: unknown) => void) | undefined;
    mockGenerate.mockImplementation(
      () =>
        new Promise((r) => {
          resolveSyn = r;
        }),
    );

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(histories),
      
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
    });
    coord.schedule(record.sessionId);
    // Wait until the job has progressed past runOne's pre-generate awaits
    // and actually entered generateSynopsis (so `resolveSyn` is wired up).
    // Polling beats a fixed sleep, which is flaky under a loaded suite:
    // too short and the job is still mid-await with resolveSyn undefined,
    // so resolveSyn?.() below no-ops and shutdown() hangs to the timeout.
    await waitFor(() => mockGenerate.mock.calls.length === 1);
    expect(coord.size().inflight).toBe(1);

    const shutdownPromise = coord.shutdown();
    // Schedules after shutdown are no-ops.
    coord.schedule("another");
    expect(coord.size().queued).toBe(0);

    // Settle the in-flight job; shutdown should now complete.
    resolveSyn?.({ synopsis: { goal: "g" } });
    await shutdownPromise;
    expect(coord.size().inflight).toBe(0);
  });

  it("flush returns within the timeout when work is stuck", async () => {
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const histories = new Map([[record.sessionId, [{}]]]);
    mockGenerate.mockImplementation(() => new Promise(() => undefined));

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(histories),
      
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
    });
    coord.schedule(record.sessionId);
    const start = Date.now();
    await coord.flush(200);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2000);
  });

  it("skips when the record is missing", async () => {
    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(new Map()),
      histories: makeHistories(new Map()),
      
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
    });
    coord.schedule("vanished");
    await coord.flush(1_000);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("skips when the agent is not in the registry", async () => {
    const record = makeRecord({ agentId: "unknown-agent" });
    const records = new Map([[record.sessionId, record]]);
    const histories = new Map([[record.sessionId, [{}]]]);
    const noAgentRegistry = {
      async getAgent(): Promise<unknown> {
        return undefined;
      },
    } as never;

    const coord = new SynopsisCoordinator({
      registry: noAgentRegistry,
      store: makeStore(records),
      histories: makeHistories(histories),
      
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
    });
    coord.schedule(record.sessionId);
    await coord.flush(1_000);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("scheduling compaction before title for same session results in one compaction job", async () => {
    // scheduleCompaction adds to queue first, then schedule sees compaction is queued and returns.
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const histories = new Map([[record.sessionId, [{}, {}, {}]]]);
    mockGenerate.mockResolvedValue({ title: "t", synopsis: { goal: "g" } });
    mockCompaction.mockResolvedValue({ synopsis: { goal: "compacted" } });

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(histories),
      
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
    });
    coord.scheduleCompaction(record.sessionId);
    coord.schedule(record.sessionId);
    await coord.flush(5_000);

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockCompaction).toHaveBeenCalledTimes(1);
  });

  it("scheduling compaction then title for same session runs one compaction job", async () => {
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const histories = new Map([[record.sessionId, [{}, {}, {}]]]);
    mockGenerate.mockResolvedValue({ title: "t", synopsis: { goal: "g" } });
    mockCompaction.mockResolvedValue({ synopsis: { goal: "compacted" } });

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(histories),
      
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
    });
    coord.scheduleCompaction(record.sessionId);
    coord.schedule(record.sessionId);
    await coord.flush(5_000);

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockCompaction).toHaveBeenCalledTimes(1);
  });

  it("title persistTitle is not called when a compaction job runs", async () => {
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const histories = new Map([[record.sessionId, [{}, {}, {}]]]);
    const persistedTitles: string[] = [];
    mockCompaction.mockResolvedValue({ synopsis: { goal: "compacted" } });

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(histories),
      
      persistTitle: async (id, title) => {
        persistedTitles.push(title);
      },
      persistSynopsis: async () => undefined,
    });
    coord.scheduleCompaction(record.sessionId);
    await coord.flush(5_000);

    expect(persistedTitles).toHaveLength(0);
  });

  it("onSynthesisArtifact fires with the right args", async () => {
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const histories = new Map([[record.sessionId, [{}, {}, {}]]]);
    const compactionArtifacts: Array<{
      sessionId: string;
      artifact: SessionSynopsis;
      through: number;
    }> = [];

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(histories),
      
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
      onSynthesisArtifact: async (sid, artifact, through) => {
        compactionArtifacts.push({ sessionId: sid, artifact, through });
      },
    });
    mockCompaction.mockResolvedValue({ synopsis: { goal: "compacted", outcome: "done" } });
    coord.scheduleCompaction(record.sessionId);
    await coord.flush(5_000);

    expect(compactionArtifacts).toHaveLength(1);
    expect(compactionArtifacts[0]!.sessionId).toBe(record.sessionId);
    expect(compactionArtifacts[0]!.artifact.goal).toBe("compacted");
    expect(compactionArtifacts[0]!.through).toBe(3);
  });

  it("onSynthesisArtifact is not called for title jobs", async () => {
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const histories = new Map([[record.sessionId, [{}, {}, {}]]]);
    let compactionCalled = false;

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(histories),
      
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
      onSynthesisArtifact: async () => {
        compactionCalled = true;
      },
    });
    mockGenerate.mockResolvedValue({ title: "t", synopsis: { goal: "g" } });
    coord.schedule(record.sessionId);
    await coord.flush(5_000);

    expect(compactionCalled).toBe(false);
  });

  it("compaction catch-up loop iterates when history grows between iterations", async () => {
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const state: { history: unknown[]; iterations: number } = { history: [{}, {}], iterations: 0 };
    const compactionArtifacts: SessionSynopsis[] = [];

    mockCompaction.mockImplementation(async () => {
      state.iterations++;
      if (state.iterations === 1) {
        state.history.push({}, {});
        return { synopsis: { goal: "round 1" } };
      }
      return { synopsis: { goal: "round 2" } };
    });

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(new Map([[record.sessionId, state.history]])),
      
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
      onSynthesisArtifact: async (sid, artifact, through) => {
        compactionArtifacts.push(artifact);
      },
    });
    coord.scheduleCompaction(record.sessionId);
    await coord.flush(5_000);

    expect(mockCompaction).toHaveBeenCalledTimes(2);
    expect(compactionArtifacts).toHaveLength(2);
    expect(compactionArtifacts[0]!.goal).toBe("round 1");
    expect(compactionArtifacts[1]!.goal).toBe("round 2");
  });

  it("compaction loop exits when converged (no new history)", async () => {
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const sharedHistory: unknown[] = [{}, {}, {}];

    mockCompaction.mockResolvedValue({ synopsis: { goal: "compact" } });

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(new Map([[record.sessionId, sharedHistory]])),
      
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
    });
    coord.scheduleCompaction(record.sessionId);
    await coord.flush(5_000);

    expect(mockCompaction).toHaveBeenCalledTimes(1);
  });

  it("circuit-breaker fires when maxIterations hit without producing artifact, persisting status=failed with the failure reason", async () => {
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const state: { history: unknown[]; iterations: number } = { history: [{}, {}, {}], iterations: 0 };

    // Every call invokes onFailure with a reason and returns undefined,
    // growing history to keep the loop alive until maxIterations.
    mockCompaction.mockImplementation(async (opts: { onFailure?: (r: string) => void }) => {
      state.iterations++;
      state.history.push({});
      opts.onFailure?.("agent returned unparseable JSON (preview)");
      return undefined;
    });

    const warnings: string[] = [];
    const stateChanges: Array<unknown> = [];
    const broadcasts: Array<{ phase: unknown; error?: unknown }> = [];
    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(new Map([[record.sessionId, state.history]])),

      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
      compactionMaxIterations: 2,
      onCompactionStateChange: async (_id, s) => {
        stateChanges.push(s);
      },
      broadcastHydraCompaction: (_id, payload) => {
        broadcasts.push(payload as { phase: unknown; error?: unknown });
      },
      logger: {
        warn: (msg: string) => warnings.push(msg),
        info: () => undefined,
      },
    });
    coord.scheduleCompaction(record.sessionId);
    await coord.flush(5_000);

    // Log proof that the circuit breaker actually fired.
    expect(warnings.some((w) => w.includes("maxIterations") && w.includes("without producing artifact"))).toBe(true);

    // Terminal failed state is persisted with the failure reason from onFailure.
    const finalState = stateChanges[stateChanges.length - 1] as { status?: unknown; lastError?: unknown };
    expect(finalState?.status).toBe("failed");
    expect(finalState?.lastError).toContain("unparseable JSON");

    // failed phase is broadcast for the TUI's status indicator.
    const failedBroadcast = broadcasts.find((b) => b.phase === "failed");
    expect(failedBroadcast).toBeDefined();
    expect(failedBroadcast?.error).toContain("unparseable JSON");
  });

  it("compaction loop respects compactionMaxIterations=1", async () => {
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const sharedHistory: unknown[] = [{}, {}, {}];

    mockCompaction.mockResolvedValue({ synopsis: { goal: "single" } });

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(new Map([[record.sessionId, sharedHistory]])),
      
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
      compactionMaxIterations: 1,
    });
    coord.scheduleCompaction(record.sessionId);
    await coord.flush(5_000);

    expect(mockCompaction).toHaveBeenCalledTimes(1);
  });

  it("compaction loop continues on failed iteration and fires hook with latest artifact", async () => {
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const state: { history: unknown[]; iterations: number } = { history: [{}, {}], iterations: 0 };
    const compactionArtifacts: SessionSynopsis[] = [];

    mockCompaction.mockImplementation(async () => {
      state.iterations++;
      if (state.iterations === 1) {
        // First iteration succeeds, grows history.
        state.history.push({}, {});
        return { synopsis: { goal: "round 1" } };
      }
      // Subsequent iterations fail (no parseable result). Do not grow history.
      return undefined;
    });

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(new Map([[record.sessionId, state.history]])),
      
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
      onSynthesisArtifact: async (sid, artifact, through) => {
        compactionArtifacts.push(artifact);
      },
    });
    coord.scheduleCompaction(record.sessionId);
    await coord.flush(5_000);

    expect(mockCompaction).toHaveBeenCalledTimes(2);
    // First iteration persisted; second returned undefined so hook not called again.
    expect(compactionArtifacts).toHaveLength(1);
    expect(compactionArtifacts[0]!.goal).toBe("round 1");
  });

  it("onCompactionStateChange fires requested → running(iter) during happy-path compaction", async () => {
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const sharedHistory: unknown[] = [{}, {}, {}];

    mockCompaction.mockResolvedValue({ synopsis: { goal: "done" } });

    const stateChanges: Array<{ status: string; iter?: number }> = [];
    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(new Map([[record.sessionId, sharedHistory]])),
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
      onCompactionStateChange: async (_sid, state) => {
        stateChanges.push({ status: state.status, iter: state.iter });
      },
    });
    coord.scheduleCompaction(record.sessionId);
    await coord.flush(5_000);

    // First call must be requested (no iter).
    expect(stateChanges[0]?.status).toBe("requested");
    expect(stateChanges[0]?.iter).toBeUndefined();
    // At least one running transition must have been recorded.
    const runningEntries = stateChanges.filter((s) => s.status === "running");
    expect(runningEntries.length).toBeGreaterThan(0);
    // The coordinator never fires swap_pending / swap_deferred — those are session-manager's job.
    const otherEntries = stateChanges.filter(
      (s) => s.status !== "requested" && s.status !== "running",
    );
    expect(otherEntries).toHaveLength(0);
  });

  it("broadcastHydraCompaction fires phase:started then phase:iteration in order", async () => {
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const sharedHistory: unknown[] = [{}, {}, {}];

    mockCompaction.mockResolvedValue({ synopsis: { goal: "done" } });

    const broadcasts: Array<{ phase: string; iter?: number; historyLen?: number }> = [];
    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(new Map([[record.sessionId, sharedHistory]])),
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
      broadcastHydraCompaction: (_sid, payload) => {
        if (payload.phase === "started") {
          broadcasts.push({ phase: "started" });
        } else if (payload.phase === "iteration") {
          broadcasts.push({ phase: "iteration", iter: payload.iter, historyLen: payload.historyLen });
        }
      },
    });
    coord.scheduleCompaction(record.sessionId);
    await coord.flush(5_000);

    expect(broadcasts[0]?.phase).toBe("started");
    const iterations = broadcasts.filter((b) => b.phase === "iteration");
    expect(iterations.length).toBeGreaterThan(0);
    expect(iterations[0]?.iter).toBe(1);
    expect(iterations[0]?.historyLen).toBe(sharedHistory.length);
  });

  it("compaction job uses compactionAgent when set, ignores synopsisAgent", async () => {
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const histories = new Map([[record.sessionId, [{}, {}, {}]]]);
    mockCompaction.mockResolvedValue({ synopsis: { goal: "compact" } });

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "test-agent" }),
      store: makeStore(records),
      histories: makeHistories(histories),
      
      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
      synopsisAgent: "synopsis-override",
      compactionAgent: "compaction-only",
    });
    coord.scheduleCompaction(record.sessionId);
    await coord.flush(5_000);

    const call = mockCompaction.mock.calls[0]?.[0];
    expect(call?.agentId).toBe("compaction-only");
  });

  it("compaction job falls back to the session's own agent when compactionAgent is unset (does NOT inherit synopsisAgent)", async () => {
    const record = makeRecord();
    const records = new Map([[record.sessionId, record]]);
    const histories = new Map([[record.sessionId, [{}, {}, {}]]]);
    mockCompaction.mockResolvedValue({ synopsis: { goal: "compact" } });

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: record.agentId }),
      store: makeStore(records),
      histories: makeHistories(histories),

      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
      // synopsisAgent is set (title regen would use it), but compaction
      // must NOT inherit it — it falls through directly to record.agentId.
      synopsisAgent: "synopsis-only-for-titles",
    });
    coord.scheduleCompaction(record.sessionId);
    await coord.flush(5_000);

    const call = mockCompaction.mock.calls[0]?.[0];
    expect(call?.agentId).toBe(record.agentId);
    expect(call?.agentId).not.toBe("synopsis-only-for-titles");
  });

  it("compaction job does NOT inherit synopsisModel when compactionModel is unset", async () => {
    const record = makeRecord({ currentModel: "session-current-model" });
    const records = new Map([[record.sessionId, record]]);
    const histories = new Map([[record.sessionId, [{}, {}, {}]]]);
    mockCompaction.mockResolvedValue({ synopsis: { goal: "compact" } });

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: record.agentId }),
      store: makeStore(records),
      histories: makeHistories(histories),

      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
      // synopsisModel is set (title regen would use it), but compaction
      // must NOT inherit it. With no compactionAgent override the
      // compaction model falls through to record.currentModel.
      synopsisModel: "title-only-haiku",
    });
    coord.scheduleCompaction(record.sessionId);
    await coord.flush(5_000);

    const call = mockCompaction.mock.calls[0]?.[0];
    expect(call?.modelId).toBe("session-current-model");
    expect(call?.modelId).not.toBe("title-only-haiku");
  });

  it("compaction job uses record.currentModel when compactionModel is unset AND no compactionAgent override", async () => {
    const record = makeRecord({ currentModel: "opus-from-session" });
    const records = new Map([[record.sessionId, record]]);
    const histories = new Map([[record.sessionId, [{}, {}, {}]]]);
    mockCompaction.mockResolvedValue({ synopsis: { goal: "compact" } });

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: record.agentId }),
      store: makeStore(records),
      histories: makeHistories(histories),

      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
    });
    coord.scheduleCompaction(record.sessionId);
    await coord.flush(5_000);

    const call = mockCompaction.mock.calls[0]?.[0];
    expect(call?.modelId).toBe("opus-from-session");
  });

  it("compaction job does NOT inherit record.currentModel when compactionAgent IS overridden", async () => {
    const record = makeRecord({ currentModel: "model-only-on-session-agent" });
    const records = new Map([[record.sessionId, record]]);
    const histories = new Map([[record.sessionId, [{}, {}, {}]]]);
    mockCompaction.mockResolvedValue({ synopsis: { goal: "compact" } });

    const coord = new SynopsisCoordinator({
      registry: makeRegistry({ id: "different-agent" }),
      store: makeStore(records),
      histories: makeHistories(histories),

      persistTitle: async () => undefined,
      persistSynopsis: async () => undefined,
      // compactionAgent is explicitly different — the session's model
      // id is meaningless to it, so model falls through to undefined
      // (agent default) instead of cross-injecting.
      compactionAgent: "different-agent",
    });
    coord.scheduleCompaction(record.sessionId);
    await coord.flush(5_000);

    const call = mockCompaction.mock.calls[0]?.[0];
    expect(call?.modelId).toBeUndefined();
  });
});
