import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Mock generateSynopsis so forkSession never spawns a real ephemeral agent.
// Default resolves to an empty synopsis — synthesis tests override with
// mockResolvedValue for the specific behavior they need.
vi.mock("./synopsis-agent.js", () => ({
  generateSynopsis: vi.fn(async () => undefined),
}));

import { generateSynopsis } from "./synopsis-agent.js";
import { SessionManager } from "./session-manager.js";
import { Registry, type RegistryAgent } from "./registry.js";
import { makeMockAgent, type MockAgentControls } from "../__tests__/test-utils.js";
import { Session } from "./session.js";

const mockGenerate = generateSynopsis as ReturnType<typeof vi.fn>;

function fakeRegistryAgent(id = "claude-code"): RegistryAgent {
  return { id, name: id, distribution: { npx: { package: id } } };
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

async function readMeta(sessionId: string): Promise<Record<string, unknown>> {
  const metaPath = path.join(
    process.env.HYDRA_ACP_HOME!,
    "sessions",
    sessionId,
    "meta.json",
  );
  return JSON.parse(await fs.readFile(metaPath, "utf8"));
}

async function readHistory(sessionId: string): Promise<unknown[]> {
  const histPath = path.join(
    process.env.HYDRA_ACP_HOME!,
    "sessions",
    sessionId,
    "history.jsonl",
  );
  const raw = await fs.readFile(histPath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function turnComplete(messageId: string): {
  method: string;
  params: unknown;
  recordedAt: number;
} {
  return {
    method: "session/update",
    params: {
      sessionId: "u_x",
      update: { sessionUpdate: "turn_complete", messageId, stopReason: "end_turn" },
    },
    recordedAt: 1,
  };
}

function bundleWith(opts: {
  lineageId: string;
  history: Array<{ method: string; params: unknown; recordedAt: number }>;
  currentModel?: string;
  title?: string;
}) {
  return {
    version: 1 as const,
    exportedAt: "2026-05-13T00:00:00.000Z",
    exportedFrom: { hydraVersion: "0.1.0", machine: "h" },
    session: {
      sessionId: "hydra_session_src",
      lineageId: opts.lineageId,
      agentId: "claude-code",
      cwd: process.cwd(),
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.currentModel !== undefined ? { currentModel: opts.currentModel } : {}),
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    },
    history: opts.history,
  };
}

describe("forkSession — synthesis mode (default)", () => {
  beforeEach(() => {
    mockGenerate.mockClear();
  });

  it("copies full parent history into fork's history.jsonl", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        throw new Error("spawner should not be called from forkSession");
      },
    );

    const parentHistoryLen = 5;
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_synthesis",
        history: Array.from({ length: parentHistoryLen }, (_, i) => turnComplete(`m_${i}`)),
      }),
    );

    mockGenerate.mockResolvedValue({
      title: "Synthesized fork title",
      synopsis: { goal: "do a thing", outcome: "done" },
    });

    const fork = await manager.forkSession(source.sessionId);

    expect(fork.forkedFromSessionId).toBe(source.sessionId);

    const forkHistory = await readHistory(fork.sessionId);
    expect(forkHistory.length).toBe(parentHistoryLen);

    // Verify the full history was copied (not sliced)
    for (let i = 0; i < parentHistoryLen; i++) {
      const entry = forkHistory[i] as { params: { update: { messageId: string } } };
      expect(entry.params.update.messageId).toBe(`m_${i}`);
    }
  });

  it("stamps record.synopsis and summarizedThroughEntry from generateSynopsis result", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        throw new Error("spawner should not be called from forkSession");
      },
    );

    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_synthesis_meta",
        history: [turnComplete("m_one"), turnComplete("m_two")],
      }),
    );

    const fixedSynopsis = { goal: "implement cache layer", outcome: null, open_threads: ["perf review"] };
    mockGenerate.mockResolvedValue({ title: "Cache implementation", synopsis: fixedSynopsis });

    // Stub mutateRecord so the background phase completes synchronously.
    const originalMutateRecord = (manager as unknown as { mutateRecord: (...a: unknown[]) => Promise<void> }).mutateRecord;
    let mutateResolve: (() => void) | undefined;
    const mutatePromise = new Promise<void>((resolve) => { mutateResolve = resolve; });
    (manager as unknown as { mutateRecord: (...a: unknown[]) => Promise<void> }).mutateRecord = async (...args: unknown[]) => {
      await originalMutateRecord.apply(manager, args);
      mutateResolve?.();
    };

    const fork = await manager.forkSession(source.sessionId);

    // Phase 1: forkSynthesisState is stamped immediately.
    let forkMeta = await readMeta(fork.sessionId);
    expect(forkMeta.forkSynthesisState).toBe("running");
    expect(forkMeta.summarizedThroughEntry).toBe(2);
    expect(forkMeta.synopsis).toBeUndefined();

    // Wait for the fire-and-forget to complete.
    await mutatePromise;

    forkMeta = await readMeta(fork.sessionId);
    expect(forkMeta.synopsis).toEqual(fixedSynopsis);
    expect(forkMeta.summarizedThroughEntry).toBe(2);
    expect(forkMeta.forkSynthesisState).toBeUndefined();
  });

  it("sets record.forkedFromSessionId on the fork", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        throw new Error("spawner should not be called from forkSession");
      },
    );

    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_forked_from",
        history: [turnComplete("m_one")],
      }),
    );

    mockGenerate.mockResolvedValue({ title: "x", synopsis: { goal: "g" } });

    const fork = await manager.forkSession(source.sessionId);
    const forkMeta = await readMeta(fork.sessionId);

    expect(forkMeta.forkedFromSessionId).toBe(source.sessionId);
  });
});

describe("forkSession — synthesis with synopsis failure (graceful degrade)", () => {
  beforeEach(() => {
    mockGenerate.mockClear();
  });

  it("fork still succeeds when generateSynopsis returns undefined; full history copied", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        throw new Error("spawner should not be called from forkSession");
      },
    );

    // 2 turn_complete entries + 1 extra entry past the last turn_complete.
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_synthesis_fail",
        history: [
          turnComplete("m_one"),
          turnComplete("m_two"),
          { method: "session/update", params: { update: { sessionUpdate: "message_sent", messageId: "m_extra" } }, recordedAt: 1 },
        ],
      }),
    );

    // generateSynopsis returns undefined — simulates parse failure / timeout
    mockGenerate.mockResolvedValue(undefined);

    const fork = await manager.forkSession(source.sessionId);

    // Fork must always succeed even if synthesis fails (invariant #3)
    expect(fork.forkedFromSessionId).toBe(source.sessionId);

    // In two-phase mode: full history always copied, summarizedThroughEntry
    // stamped in phase 1 so recall MCP mint fires immediately.
    const forkMeta = await readMeta(fork.sessionId);
    expect(forkMeta.synopsis).toBeUndefined();
    expect(forkMeta.summarizedThroughEntry).toBe(3);
    expect(forkMeta.forkSynthesisState).toBe("running");

    // Full history (3 entries), NOT sliced — synthesis mode always copies all.
    const forkHistory = await readHistory(fork.sessionId);
    expect(forkHistory.length).toBe(3);
  });

  it("synthesis fork with opts.forkAt + synopsis failure — full history copied", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        throw new Error("spawner should not be called from forkSession");
      },
    );

    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_forkat_fail",
        history: [
          turnComplete("m_one"),
          turnComplete("m_two"),
          turnComplete("m_three"),
        ],
      }),
    );

    // generateSynopsis fails — in two-phase mode, full history is always
    // copied regardless of synopsis outcome.
    mockGenerate.mockResolvedValue(undefined);

    const fork = await manager.forkSession(source.sessionId, { forkAt: "m_two" });

    expect(fork.forkedFromSessionId).toBe(source.sessionId);

    const forkMeta = await readMeta(fork.sessionId);
    expect(forkMeta.synopsis).toBeUndefined();
    // forkAt is silently ignored in synthesis mode — full history always copied.
    expect(forkMeta.summarizedThroughEntry).toBe(3);
    expect(forkMeta.forkSynthesisState).toBe("running");

    // Full history (3 entries), NOT sliced to forkAt.
    const forkHistory = await readHistory(fork.sessionId);
    expect(forkHistory.length).toBe(3);
  });

  it("synthesis fork with opts.forkAt that does not resolve + synopsis failure — full history copied", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        throw new Error("spawner should not be called from forkSession");
      },
    );

    // 3 entries where only the first two are turn_complete; m_nonexistent won't resolve.
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_forkat_miss",
        history: [
          turnComplete("m_one"),
          turnComplete("m_two"),
          { method: "session/update", params: { update: { sessionUpdate: "message_sent", messageId: "m_extra" } }, recordedAt: 1 },
        ],
      }),
    );

    // generateSynopsis fails; forkAt="m_nonexistent" does not exist in source.
    mockGenerate.mockResolvedValue(undefined);

    const fork = await manager.forkSession(source.sessionId, { forkAt: "m_nonexistent" });

    // Should NOT throw — synopsis failure is always graceful degrade.
    expect(fork.forkedFromSessionId).toBe(source.sessionId);

    // In two-phase mode: full history always copied regardless of synopsis outcome.
    const forkMeta = await readMeta(fork.sessionId);
    expect(forkMeta.synopsis).toBeUndefined();
    expect(forkMeta.summarizedThroughEntry).toBe(3);
    expect(forkMeta.forkSynthesisState).toBe("running");

    // Full history (3 entries), NOT sliced.
    const forkHistory = await readHistory(fork.sessionId);
    expect(forkHistory.length).toBe(3);
  });

  it("fork still succeeds when generateSynopsis throws", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        throw new Error("spawner should not be called from forkSession");
      },
    );

    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_synthesis_throw",
        history: [turnComplete("m_one")],
      }),
    );

    mockGenerate.mockRejectedValue(new Error("spawn failed"));

    const fork = await manager.forkSession(source.sessionId);

    expect(fork.forkedFromSessionId).toBe(source.sessionId);
    const forkMeta = await readMeta(fork.sessionId);
    expect(forkMeta.synopsis).toBeUndefined();
  });
});

describe("forkSession — verbatim mode preserves today's behavior", () => {
  beforeEach(() => {
    mockGenerate.mockClear();
  });

  it("sliced history per forkAt with no synopsis call and no summarizedThroughEntry stamp", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        throw new Error("spawner should not be called from forkSession");
      },
    );

    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_verbatim",
        history: [
          turnComplete("m_one"),
          turnComplete("m_two"),
          turnComplete("m_three"),
        ],
      }),
    );

    const fork = await manager.forkSession(source.sessionId, { forkAt: "m_two", mode: "verbatim" });

    // generateSynopsis must NOT be called in verbatim mode
    expect(mockGenerate).not.toHaveBeenCalled();

    // History is sliced at forkAt (2 entries: m_one + m_two)
    const forkHistory = await readHistory(fork.sessionId);
    expect(forkHistory.length).toBe(2);

    // No synopsis stamp in verbatim mode
    const forkMeta = await readMeta(fork.sessionId);
    expect(forkMeta.synopsis).toBeUndefined();
    expect(forkMeta.summarizedThroughEntry).toBeUndefined();
  });

  it("forkAt is ignored (silently) in synthesis mode — full history always copied", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        throw new Error("spawner should not be called from forkSession");
      },
    );

    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_forkat_ignored",
        history: [turnComplete("m_one"), turnComplete("m_two")],
      }),
    );

    mockGenerate.mockResolvedValue({ title: "x", synopsis: { goal: "g" } });

    // forkAt is provided but should be silently ignored in synthesis mode
    const fork = await manager.forkSession(source.sessionId, { forkAt: "m_one" });

    // Full history copied despite forkAt hint
    const forkHistory = await readHistory(fork.sessionId);
    expect(forkHistory.length).toBe(2);

    const forkMeta = await readMeta(fork.sessionId);
    // summarizedThroughEntry = full parent history length, not the forkAt-sliced count
    expect(forkMeta.summarizedThroughEntry).toBe(2);
  });
});

describe("seedFromFork — unit test", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
  });

  it("calls renderCompactionSeed with correct args and uses suppress-and-record path", async () => {
    // seedFromFork builds the seed via renderCompactionSeed then sends it as
    // session/prompt via internalPromptCapture (suppress-broadcast). We verify
    // the behavior end-to-end: the prompt sent to the agent contains the
    // compaction seed structure and does not pollute fork history.

    // Create source session with history and title
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        throw new Error("spawner should not be called from forkSession");
      },
    );

    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_seed_from_fork",
        history: [turnComplete("m_one"), turnComplete("m_two"), turnComplete("m_three")],
        title: "Research thread",
      }),
    );

    mockGenerate.mockResolvedValue({
      title: "Synthesized research",
      synopsis: { goal: "research options", outcome: "picked A", open_threads: ["review"] },
    });

    // Stub mutateRecord so the background phase completes synchronously.
    const originalMutateRecord = (manager as unknown as { mutateRecord: (...a: unknown[]) => Promise<void> }).mutateRecord;
    let mutateResolve: (() => void) | undefined;
    const mutatePromise = new Promise<void>((resolve) => { mutateResolve = resolve; });
    (manager as unknown as { mutateRecord: (...a: unknown[]) => Promise<void> }).mutateRecord = async (...args: unknown[]) => {
      await originalMutateRecord.apply(manager, args);
      mutateResolve?.();
    };

    const fork = await manager.forkSession(source.sessionId);

    // Phase 1: forkSynthesisState stamped immediately.
    let forkMeta = await readMeta(fork.sessionId);
    expect(forkMeta.forkSynthesisState).toBe("running");
    expect(forkMeta.summarizedThroughEntry).toBe(3);
    expect(forkMeta.synopsis).toBeUndefined();

    // Wait for background phase to complete.
    await mutatePromise;

    forkMeta = await readMeta(fork.sessionId);

    // Verify meta.json has the synthesis artifacts (after background completes)
    expect(forkMeta.forkedFromSessionId).toBe(source.sessionId);
    expect((forkMeta.synopsis as Record<string, unknown>)?.goal).toBe("research options");
    expect((forkMeta.synopsis as Record<string, unknown>)?.outcome).toBe("picked A");
    expect(forkMeta.summarizedThroughEntry).toBe(3);
    expect(forkMeta.forkSynthesisState).toBeUndefined();

    // Now resurrect the fork — this triggers doResurrectFromImport which dispatches
    // to seedFromFork when forkedFromSessionId + synopsis are present.
    const resumeParams = await manager.loadFromDisk(fork.sessionId);
    expect(resumeParams?.forkedFromSessionId).toBe(source.sessionId);

    const mocks: MockAgentControls[] = [];
    const resurrectMgr = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: process.cwd() });
        mocks.push(m);
        const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        requestMock
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockResolvedValueOnce({ sessionId: "u_resurrected" });
        return m.agent;
      },
    );

    const resumedSession = await resurrectMgr.resurrect(resumeParams!);
    expect(resumedSession.sessionId).toBe(fork.sessionId);

    // Attach a client — this triggers seedFromFork (fire-and-forget via void + .catch)
    const { JsonRpcConnection } = await import("../acp/connection.js");
    const { makeControlledStream } = await import("../__tests__/test-utils.js");
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    await resumedSession.attach({ clientId: "c1", connection: conn }, "full");

    // seedFromFork runs asynchronously after attach. Wait for the prompt queue to drain.
    await new Promise((r) => setTimeout(r, 50));

    const requestMock = mocks[0]!.agent.connection.request as ReturnType<typeof vi.fn>;

    // Verify a session/prompt was sent (the compaction seed)
    const promptCalls = requestMock.mock.calls.filter(
      (c: unknown[]) => c[0] === "session/prompt",
    );
    expect(promptCalls.length).toBeGreaterThan(0);

    // Extract the prompt text from the first session/prompt call
    const firstPromptCall = promptCalls[0] as [string, { prompt?: Array<{ text: string }> }];
    const promptText = firstPromptCall[1]?.prompt?.[0]?.text;

    expect(promptText).toBeDefined();
    // The seed text should contain the compaction header (renderCompactionSeed output)
    expect(promptText).toContain("--- begin prior session compaction ---");
    expect(promptText).toContain("--- end prior session compaction ---");
    // Should include the synopsis content
    expect(promptText).toContain("[Goal] research options");
    expect(promptText).toContain("[Outcome] picked A");
    // Should have the closing note (seedFromFork suppresses broadcast)
    expect(promptText).toContain("Hydra has compacted earlier conversation");
    expect(promptText).toContain("Reply with the single word 'OK'");

    // Verify the fork's history.jsonl was NOT polluted by the seed prompt
    // (internalPromptCapture prevents recording)
    const forkHistoryAfter = await readHistory(fork.sessionId);
    expect(forkHistoryAfter.length).toBe(3); // Same as before — no extra entries
  });
});

// ── Two-phase fork tests ────────────────────────────────────────────────

describe("forkSession — two-phase fork (fast return)", () => {
  beforeEach(() => { mockGenerate.mockResolvedValue({ title: "x", synopsis: { goal: "g" } }); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns immediately with running state before synopsis generation starts", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => { throw new Error("spawner should not be called"); },
    );

    const source = await manager.importBundle(
      bundleWith({ lineageId: "lin_fast_return", history: [turnComplete("m_one"), turnComplete("m_two")] }),
    );

    // Phase 1 state is present immediately after forkSession returns.
    const fork = await manager.forkSession(source.sessionId);
    expect(fork.forkedFromSessionId).toBe(source.sessionId);

    let forkMeta = await readMeta(fork.sessionId);
    expect(forkMeta.forkSynthesisState).toBe("running");
    expect(forkMeta.summarizedThroughEntry).toBe(2);
    expect(forkMeta.synopsis).toBeUndefined();

    // Poll for background phase completion via vi.waitFor.
    await vi.waitFor(
      async () => {
        forkMeta = await readMeta(fork.sessionId);
        if (forkMeta.forkSynthesisState !== undefined) {
          throw new Error(`Still running: forkSynthesisState=${forkMeta.forkSynthesisState}`);
        }
      },
      { timeout: 5000, interval: 50 },
    );

    expect(forkMeta.synopsis).toEqual({ goal: "g" });
    expect(forkMeta.forkSynthesisState).toBeUndefined();
  });
});

describe("forkSession — two-phase fork (background success)", () => {
  beforeEach(() => { mockGenerate.mockResolvedValue({ title: "x", synopsis: { goal: "g" } }); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("background phase sets synopsis and clears forkSynthesisState on success", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => { throw new Error("spawner should not be called"); },
    );

    const source = await manager.importBundle(
      bundleWith({ lineageId: "lin_bg_success", history: [turnComplete("m_one"), turnComplete("m_two")] }),
    );

    const fork = await manager.forkSession(source.sessionId);
    expect(fork.forkedFromSessionId).toBe(source.sessionId);

    // Phase 1: running state stamped immediately.
    let meta = await readMeta(fork.sessionId);
    expect(meta.forkSynthesisState).toBe("running");
    expect(meta.summarizedThroughEntry).toBe(2);
    expect(meta.synopsis).toBeUndefined();

    // Use vi.waitFor to poll for background phase completion since the
    // fire-and-forget async IIFE may take multiple microtask cycles.
    await vi.waitFor(
      async () => {
        meta = await readMeta(fork.sessionId);
        if (meta.forkSynthesisState !== undefined) {
          throw new Error(`Still running: forkSynthesisState=${meta.forkSynthesisState}`);
        }
      },
      { timeout: 5000, interval: 50 },
    );

    expect(meta.synopsis).toEqual({ goal: "g" });
    expect(meta.forkSynthesisState).toBeUndefined();
  });
});

describe("forkSession — two-phase fork (attach without synopsis)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("attaching before background completes skips seeding but does not fail", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => { throw new Error("spawner should not be called"); },
    );

    const source = await manager.importBundle(
      bundleWith({ lineageId: "lin_attach_no_synopsis", history: [turnComplete("m_one"), turnComplete("m_two")] }),
    );

    // Defer synopsis generation so background stays pending.
    let deferredResolve: (value: undefined) => void;
    const deferred = new Promise<undefined>(resolve => { deferredResolve = resolve; });
    mockGenerate.mockReturnValue(deferred);

    vi.useFakeTimers();

    const fork = await manager.forkSession(source.sessionId);

    // Phase 1 state present, no synopsis yet.
    let meta = await readMeta(fork.sessionId);
    expect(meta.forkSynthesisState).toBe("running");
    expect(meta.synopsis).toBeUndefined();

    // Resurrect the fork and attach — should skip seeding since synopsis isn't set.
    const resumeParams = await manager.loadFromDisk(fork.sessionId);
    const mocks: MockAgentControls[] = [];
    const resurrectMgr = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: process.cwd() });
        mocks.push(m);
        const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        requestMock.mockResolvedValueOnce({ protocolVersion: 1 }).mockResolvedValueOnce({ sessionId: "u_res" });
        return m.agent;
      },
    );

    const resumedSession = await resurrectMgr.resurrect(resumeParams!);

    // Attach a client — should NOT trigger seedFromFork since synopsis is undefined.
    const { JsonRpcConnection } = await import("../acp/connection.js");
    const { makeControlledStream } = await import("../__tests__/test-utils.js");
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    await resumedSession.attach({ clientId: "c1", connection: conn }, "full");

    // With fake timers, background phase stays pending (deferred not resolved).
    // No session/prompt calls — seeding was skipped.
    const requestMock = mocks[0]!.agent.connection.request as ReturnType<typeof vi.fn>;
    const promptCalls = requestMock.mock.calls.filter((c: unknown[]) => c[0] === "session/prompt");
    expect(promptCalls.length).toBe(0);

    // Resolve background so state is clean.
    deferredResolve!(undefined);
    vi.advanceTimersByTime(100);

    vi.useRealTimers();
  });
});

describe("forkSession — two-phase fork (mutateRecord failure tolerance)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("phase 2 error does not crash the fork — background failure tolerance", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => { throw new Error("spawner should not be called"); },
    );

    const source = await manager.importBundle(
      bundleWith({ lineageId: "lin_mutate_fail", history: [turnComplete("m_one"), turnComplete("m_two")] }),
    );

    // Make generateSynopsis throw in the background phase.
    mockGenerate.mockRejectedValue(new Error("synthesis service unavailable"));

    const fork = await manager.forkSession(source.sessionId);
    expect(fork.forkedFromSessionId).toBe(source.sessionId);

    // Phase 1 should have succeeded.
    let meta = await readMeta(fork.sessionId);
    expect(meta.forkSynthesisState).toBe("running");
    expect(meta.summarizedThroughEntry).toBe(2);

    // Wait for background phase to attempt and fail — error is caught gracefully.
    await vi.waitFor(
      async () => {
        meta = await readMeta(fork.sessionId);
        if (meta.forkSynthesisState !== undefined) {
          throw new Error(`Still running: forkSynthesisState=${meta.forkSynthesisState}`);
        }
      },
      { timeout: 5000, interval: 50 },
    );

    // Synopsis is NOT set because generation failed.
    expect(meta.synopsis).toBeUndefined();
  });
});

describe("forkSession — two-phase fork (background failure)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("phase 2 clears running state and preserves history on synopsis generation failure", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => { throw new Error("spawner should not be called"); },
    );

    const source = await manager.importBundle(
      bundleWith({ lineageId: "lin_bg_fail", history: [turnComplete("m_one"), turnComplete("m_two")] }),
    );

    // Make generateSynopsis throw.
    mockGenerate.mockRejectedValue(new Error("synthesis service unavailable"));

    const fork = await manager.forkSession(source.sessionId);
    expect(fork.forkedFromSessionId).toBe(source.sessionId);

    // Phase 1: running state stamped immediately.
    let meta = await readMeta(fork.sessionId);
    expect(meta.forkSynthesisState).toBe("running");
    expect(meta.summarizedThroughEntry).toBe(2);

    // Wait for background phase to attempt and fail using vi.waitFor.
    await vi.waitFor(
      async () => {
        meta = await readMeta(fork.sessionId);
        expect(meta.forkSynthesisState).toBeUndefined();
      },
      { timeout: 5000, interval: 10 },
    );

    // Synopsis is NOT set because generation failed.
    expect(meta.synopsis).toBeUndefined();
    // History still intact — background failure doesn't corrupt data.
    const history = await readHistory(fork.sessionId);
    expect(history.length).toBe(2);
  });
});

describe("forkSession — two-phase fork (immediately after return)", () => {
  beforeEach(() => { mockGenerate.mockResolvedValue({ title: "x", synopsis: { goal: "g" } }); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("phase 1 state is present immediately after forkSession returns", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => { throw new Error("spawner should not be called"); },
    );

    const source = await manager.importBundle(
      bundleWith({ lineageId: "lin_immediate", history: [turnComplete("m_one"), turnComplete("m_two")] }),
    );

    const fork = await manager.forkSession(source.sessionId);
    expect(fork.forkedFromSessionId).toBe(source.sessionId);

    // Phase 1 state is present immediately.
    let meta = await readMeta(fork.sessionId);
    expect(meta.forkSynthesisState).toBe("running");
    expect(meta.summarizedThroughEntry).toBe(2);
    expect(meta.synopsis).toBeUndefined();

    // Poll for background phase completion via vi.waitFor.
    await vi.waitFor(
      async () => {
        meta = await readMeta(fork.sessionId);
        if (meta.forkSynthesisState !== undefined) {
          throw new Error(`Still running: forkSynthesisState=${meta.forkSynthesisState}`);
        }
      },
      { timeout: 5000, interval: 50 },
    );

    expect(meta.synopsis).toEqual({ goal: "g" });
    expect(meta.forkSynthesisState).toBeUndefined();
  });
});
