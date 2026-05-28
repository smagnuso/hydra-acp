import { describe, it, expect, vi, beforeEach } from "vitest";
import { SynopsisCoordinator } from "./synopsis-coordinator.js";
import type { SessionRecord } from "./session-store.js";
import type { SessionSynopsis } from "./snapshot.js";

// Tests use a thin in-memory shim for the deps the coordinator pulls
// from SessionManager so we don't have to spin a full daemon. The only
// expensive bit (generateSynopsis spawning a real subprocess) is replaced by
// mocking the synopsis-agent module inline below.
vi.mock("./synopsis-agent.js", () => ({
  generateSynopsis: vi.fn(),
}));
import { generateSynopsis } from "./synopsis-agent.js";

const mockGenerate = generateSynopsis as ReturnType<typeof vi.fn>;

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
      return histories.get(id) ?? [];
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
    // Let drain pick it up.
    await new Promise((r) => setTimeout(r, 10));
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
});
