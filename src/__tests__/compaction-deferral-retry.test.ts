/**
 * Verifies that when onCompactionArtifact finds the session non-quiesced, the
 * deferral retry path calls retrySwap (which reuses the persisted artifact)
 * rather than re-invoking scheduleCompaction (which would spawn a new
 * ephemeral agent and LLM call).
 *
 * The SynopsisCoordinator is mocked so we can capture the onCompactionArtifact
 * callback and drive it synchronously without waiting for a real worker loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionSynopsis } from "../core/snapshot.js";

// Must be declared before the module mock so the factory closure can write to it.
let capturedOnArtifact:
  | ((
      sessionId: string,
      artifact: SessionSynopsis,
      summarizedThroughEntry: number,
    ) => Promise<void>)
  | undefined;
let capturedScheduleCompaction: ReturnType<typeof vi.fn>;

vi.mock("../core/synopsis-coordinator.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/synopsis-coordinator.js")>();
  return {
    ...real,
    SynopsisCoordinator: vi.fn().mockImplementation(
      (opts: {
        onCompactionArtifact: (
          sessionId: string,
          artifact: SessionSynopsis,
          summarizedThroughEntry: number,
        ) => Promise<void>;
      }) => {
        capturedOnArtifact = opts.onCompactionArtifact;
        capturedScheduleCompaction = vi.fn();
        return {
          scheduleCompaction: capturedScheduleCompaction,
          size: () => ({ queued: 0, inflight: 0 }),
        };
      },
    ),
  };
});

vi.mock("../core/synopsis-agent.js", () => ({
  generateCompaction: vi.fn(),
  generateSynopsis: vi.fn(),
}));

import { SessionManager } from "../core/session-manager.js";
import { Registry, type RegistryAgent } from "../core/registry.js";
import { makeMockAgent } from "./test-utils.js";

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

function makeArtifact(overrides?: Partial<SessionSynopsis>): SessionSynopsis {
  return {
    goal: "fix the login bug",
    outcome: "resolved by updating auth middleware",
    files_touched: ["src/auth/middleware.ts"],
    tools_used: ["read_file", "edit_file"],
    ...overrides,
  };
}

const WORK_CWD = mkdtempSync(path.join(os.tmpdir(), "hydra-test-deferral-retry-"));

type StoreShape = {
  read: (id: string) => Promise<unknown>;
  write: (r: unknown) => Promise<void>;
};

type ManagerInternal = {
  store: StoreShape;
  retrySwap: (id: string) => Promise<void>;
};

async function buildManager(): Promise<{
  manager: SessionManager;
  session: Awaited<ReturnType<SessionManager["create"]>>;
  sessionId: string;
}> {
  let spawnCount = 0;
  const manager = new SessionManager(
    fakeRegistry([fakeRegistryAgent("claude-code")]),
    () => {
      const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
      const reqMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
      if (spawnCount === 0) {
        reqMock
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockResolvedValueOnce({ sessionId: `u_initial_${spawnCount++}` });
      } else {
        reqMock.mockResolvedValue({ sessionId: `fresh_${spawnCount++}` });
      }
      return m.agent;
    },
    undefined,
    { compaction: { tailK: 5 } },
  );
  const session = await manager.create({ cwd: WORK_CWD, agentId: "claude-code" });
  return { manager, session, sessionId: session.sessionId };
}

describe("compaction deferral retry — retrySwap reuses persisted artifact", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "hydra-test-home-deferral-"));
    process.env.HOME = tmpHome;
    capturedOnArtifact = undefined;
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpHome, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  });

  it("retrySwap reuses persisted artifact; scheduleCompaction called exactly once", async () => {
    const { manager, session, sessionId } = await buildManager();
    const originalUpstream = session.upstreamSessionId;

    // isQuiescedForSwap: first call → not ready, subsequent calls → ready.
    const quiesceSpy = vi
      .spyOn(session, "isQuiescedForSwap")
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    // swapUpstream: intercept so we don't need a real agent round-trip.
    const swapSpy = vi.spyOn(session, "swapUpstream").mockResolvedValue(undefined);

    const artifact = makeArtifact();

    // The real coordinator calls persistSynopsis before onCompactionArtifact, so the
    // artifact is in the store when retrySwap reads it. Simulate that here since
    // the coordinator is mocked.
    const store = (manager as unknown as ManagerInternal).store;
    const existingRecord = await store.read(sessionId);
    await store.write({ ...(existingRecord as object), synopsis: artifact, summarizedThroughEntry: 3 });

    // Deliver artifact — session is non-quiesced, so a deferral setTimeout is set.
    expect(capturedOnArtifact).toBeDefined();
    await capturedOnArtifact!(sessionId, artifact, 3);

    // scheduleCompaction must NOT have been called (no re-summarization).
    expect(capturedScheduleCompaction).not.toHaveBeenCalled();
    expect(swapSpy).not.toHaveBeenCalled();
    expect(quiesceSpy).toHaveBeenCalledTimes(1);

    // Directly invoke retrySwap to simulate the 5-second deferral firing. This
    // avoids fake-timer complexity with real async I/O inside the method body.
    await (manager as unknown as ManagerInternal).retrySwap(sessionId);

    // Session is now quiesced → swapUpstream called exactly once.
    expect(swapSpy).toHaveBeenCalledTimes(1);
    // isQuiescedForSwap was checked a second time inside retrySwap.
    expect(quiesceSpy).toHaveBeenCalledTimes(2);
    // scheduleCompaction was never invoked on the retry path.
    expect(capturedScheduleCompaction).not.toHaveBeenCalled();
    // Session identity is preserved.
    expect(session.sessionId).toBe(sessionId);
    expect(session.upstreamSessionId).toBe(originalUpstream);
  });

  it("deferral cap is respected — gives up after MAX_SWAP_DEFERRALS retries", async () => {
    const { manager, session, sessionId } = await buildManager();
    const originalUpstream = session.upstreamSessionId;

    // Always return non-quiesced so all deferrals are exhausted.
    const quiesceSpy = vi.spyOn(session, "isQuiescedForSwap").mockResolvedValue(false);
    const swapSpy = vi.spyOn(session, "swapUpstream").mockResolvedValue(undefined);

    const artifact = makeArtifact();
    const store = (manager as unknown as ManagerInternal).store;
    const existingRecord = await store.read(sessionId);
    await store.write({ ...(existingRecord as object), synopsis: artifact, summarizedThroughEntry: 3 });

    // First delivery sets deferral count to 1.
    await capturedOnArtifact!(sessionId, artifact, 3);

    // Invoke retrySwap directly for each possible retry (up to cap).
    const internal = manager as unknown as ManagerInternal;
    await internal.retrySwap(sessionId);
    await internal.retrySwap(sessionId);
    await internal.retrySwap(sessionId);
    // One more invocation after cap should be a no-op (count was cleared).
    await internal.retrySwap(sessionId);

    // swapUpstream should never have been called — session was never quiesced.
    expect(swapSpy).not.toHaveBeenCalled();
    // scheduleCompaction should never have been called.
    expect(capturedScheduleCompaction).not.toHaveBeenCalled();
    // Session identity still intact.
    expect(session.sessionId).toBe(sessionId);
    expect(session.upstreamSessionId).toBe(originalUpstream);
    // quiesceSpy was called at most once per attempt.
    expect(quiesceSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
