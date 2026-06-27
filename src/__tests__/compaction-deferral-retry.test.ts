/**
 * Verifies onceIdle-based compaction swap dispatch:
 *   - When a session is non-quiesced at artifact time, an idle handler
 *     is parked instead of polling with a deferral cap.
 *   - When the session next quiesces, the parked handler reads the
 *     persisted artifact from disk (no re-summarization) and calls
 *     swapUpstream.
 *   - If history grew past the artifact's watermark during the wait,
 *     scheduleCompaction is invoked to refresh the synopsis rather than
 *     swapping with a stale artifact.
 *
 * The SynopsisCoordinator is mocked so we can capture the
 * onCompactionArtifact callback and drive it synchronously.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionSynopsis } from "../core/snapshot.js";

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

const WORK_CWD = mkdtempSync(path.join(os.tmpdir(), "hydra-test-onceidle-swap-"));

type StoreShape = {
  read: (id: string) => Promise<unknown>;
  write: (r: unknown) => Promise<void>;
};

type ManagerInternal = {
  store: StoreShape;
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

describe("compaction swap — onceIdle dispatch", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "hydra-test-home-onceidle-"));
    process.env.HOME = tmpHome;
    capturedOnArtifact = undefined;
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpHome, { recursive: true, force: true });
    } catch {
      // intentional
    }
  });

  it("parks an onceIdle handler when non-quiesced; swap fires at the next idle edge", async () => {
    const { manager, session, sessionId } = await buildManager();

    // First isQuiescedForSwap call (in dispatchCompactionSwap) → false:
    // forces the parking path. Subsequent calls (from inside the idle
    // handler) → true so the swap proceeds.
    const quiesceSpy = vi
      .spyOn(session, "isQuiescedForSwap")
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    const swapSpy = vi.spyOn(session, "swapUpstream").mockResolvedValue(undefined);

    const artifact = makeArtifact();

    // Mirror what the real coordinator would have done before firing
    // onCompactionArtifact: persist the artifact to the store.
    const store = (manager as unknown as ManagerInternal).store;
    const existingRecord = await store.read(sessionId);
    await store.write({
      ...(existingRecord as object),
      synopsis: artifact,
      summarizedThroughEntry: 3,
    });

    expect(capturedOnArtifact).toBeDefined();
    await capturedOnArtifact!(sessionId, artifact, 3);

    // No swap yet — parked on idle. scheduleCompaction not called either
    // (we did NOT grow history past the watermark).
    expect(swapSpy).not.toHaveBeenCalled();
    expect(capturedScheduleCompaction).not.toHaveBeenCalled();

    // Simulate the quiesce edge by directly calling the dispatch path
    // that the parked handler would have called. The Session.onceIdle
    // hook fires synchronously on its registered callback; the manager's
    // callback calls onIdleAttemptSwap.
    const internal = manager as unknown as {
      onIdleAttemptSwap: (id: string) => Promise<void>;
    };
    await internal.onIdleAttemptSwap(sessionId);

    expect(swapSpy).toHaveBeenCalledTimes(1);
    expect(capturedScheduleCompaction).not.toHaveBeenCalled();
    expect(quiesceSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("reschedules synopsis (no swap) when history grew past the artifact during the wait", async () => {
    const { manager, session, sessionId } = await buildManager();

    // Park first, then become quiesced.
    vi.spyOn(session, "isQuiescedForSwap")
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    const swapSpy = vi.spyOn(session, "swapUpstream").mockResolvedValue(undefined);

    const artifact = makeArtifact();
    const store = (manager as unknown as ManagerInternal).store;
    const existingRecord = await store.read(sessionId);
    await store.write({
      ...(existingRecord as object),
      synopsis: artifact,
      summarizedThroughEntry: 3,
    });

    await capturedOnArtifact!(sessionId, artifact, 3);

    // Inject growth past the watermark into the history store BEFORE
    // the idle handler runs.
    const internal = manager as unknown as {
      onIdleAttemptSwap: (id: string) => Promise<void>;
      histories: {
        load: (id: string) => Promise<unknown[]>;
      };
    };
    vi.spyOn(internal.histories, "load").mockResolvedValue(
      new Array(10).fill({ method: "session/update" }),
    );

    await internal.onIdleAttemptSwap(sessionId);

    // Swap is NOT called — instead a fresh synopsis run is scheduled.
    expect(swapSpy).not.toHaveBeenCalled();
    expect(capturedScheduleCompaction).toHaveBeenCalledTimes(1);
    expect(capturedScheduleCompaction).toHaveBeenCalledWith(sessionId);
  });
});
