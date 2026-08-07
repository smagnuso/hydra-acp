/**
 * End-to-end test for per-generation cost stamping across a compaction
 * swap. Covers the full wiring that no unit test reaches:
 *
 *   accumulateAndResetCost (banks costAmount, records retiringGenerationCost)
 *     -> notifyAgentChange (emits retiredCost)
 *       -> SessionManager.persistAgentChange
 *         -> appendUpstreamGeneration (stamps cost on the retiring entry)
 *           -> meta.json
 *
 * The invariant under test: the retiring generation's spend is durable on
 * disk, and the lifetime total is conserved exactly across the rotation
 * (moved from costAmount into cumulativeCost, neither lost nor doubled).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../core/session-manager.js";
import { Registry, type RegistryAgent } from "../core/registry.js";
import { makeMockAgent, makeControlledStream } from "./test-utils.js";
import { JsonRpcConnection } from "../acp/connection.js";
import type { SessionSynopsis } from "../core/snapshot.js";
import type { SessionRecord } from "../core/session-store.js";

vi.mock("../core/synopsis-agent.js", () => ({
  generateCompaction: vi.fn(),
  generateSynopsis: vi.fn(),
}));
import { generateCompaction } from "../core/synopsis-agent.js";

const mockCompaction = generateCompaction as ReturnType<typeof vi.fn>;

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out");
    }
    await new Promise((r) => setTimeout(r, 30));
  }
}

function fakeRegistry(): Registry {
  const agent: RegistryAgent = {
    id: "claude-code",
    name: "claude-code",
    distribution: { npx: { package: "claude-code" } },
  };
  return {
    async getAgent(id: string) {
      return id === "claude-code" ? agent : undefined;
    },
    async load() {
      return { version: "0", agents: [agent] };
    },
    async refresh() {
      return { version: "0", agents: [agent] };
    },
  } as unknown as Registry;
}

function makeArtifact(): SessionSynopsis {
  return {
    goal: "fix cost accounting",
    outcome: "split ledger",
    files_touched: ["src/core/session.ts"],
    tools_used: ["read_file"],
  };
}

const WORK_CWD = mkdtempSync(path.join(os.tmpdir(), "hydra-test-gencost-"));

// The real figures observed on the session that motivated this test, so
// the float arithmetic under test is the arithmetic that actually ran.
const RETIRED_SPEND = 36.783942760000016;
const PRIOR_CUMULATIVE = 100.2254;

describe("generation cost stamping e2e", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "hydra-test-gencost-home-"));
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

  it(
    "stamps the retiring generation's cost into meta.json and conserves the lifetime total",
    async () => {
      let spawnCount = 0;
      const oldAgents: ReturnType<typeof makeMockAgent>[] = [];

      const manager = new SessionManager(
        fakeRegistry(),
        () => {
          const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
          const reqMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
          if (spawnCount === 0) {
            oldAgents.push(m);
            reqMock
              .mockResolvedValueOnce({ protocolVersion: 1 })
              .mockResolvedValueOnce({ sessionId: `u_initial_${spawnCount++}` });
            return m.agent;
          }
          reqMock.mockImplementation(async (method: string) => {
            if (method === "session/new") {
              return { sessionId: `fresh_${spawnCount++}` };
            }
            return {};
          });
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

      // Give the session a prior banked total, as a session that has
      // already rotated once would have. This is what makes the
      // conservation assertion meaningful: a bug that overwrites rather
      // than adds would still pass with a zero starting balance.
      (
        session as unknown as { cumulativeCost: number }
      ).cumulativeCost = PRIOR_CUMULATIVE;

      const oldReqMock = oldAgents[0]!.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      const prompts = ["a", "b", "c", "d"];
      for (const text of prompts) {
        oldReqMock.mockResolvedValueOnce({ stopReason: "end_turn" });
        await session.prompt("c1", { prompt: [{ type: "text", text }] });
      }

      // The retiring agent reports its lifetime spend.
      oldAgents[0]!.triggerNotification("session/update", {
        sessionId: originalUpstream,
        update: {
          sessionUpdate: "usage_update",
          used: 26840,
          size: 200000,
          cost: { amount: RETIRED_SPEND, currency: "USD" },
        },
      });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const lifetimeBefore = session.currentUsage?.costAmount;
      expect(lifetimeBefore).toBeCloseTo(PRIOR_CUMULATIVE + RETIRED_SPEND, 8);

      await manager.flushHistoryWrites();

      mockCompaction.mockResolvedValue({ synopsis: makeArtifact() });
      (
        manager as unknown as {
          synopsisCoordinator: { scheduleCompaction: (id: string) => void };
        }
      ).synopsisCoordinator.scheduleCompaction(sessionId);

      await waitFor(() => {
        const current = manager.get(sessionId);
        return !!current && current.upstreamSessionId !== originalUpstream;
      }, 15_000);

      const swapped = manager.get(sessionId)!;
      await manager.flushMetaWrites();

      const store = (
        manager as unknown as {
          store: { read: (id: string) => Promise<SessionRecord | undefined> };
        }
      ).store;
      const record = await store.read(sessionId);
      expect(record).toBeDefined();

      // --- the retiring generation carries its spend, on disk ---
      const gens = record!.upstreamGenerations ?? [];
      expect(gens.length).toBeGreaterThanOrEqual(2);
      const retiring = gens.find(
        (g) => g.upstreamSessionId === originalUpstream,
      );
      expect(retiring).toBeDefined();
      expect(retiring!.cost).toBeCloseTo(RETIRED_SPEND, 10);
      expect(retiring!.endedAt).toBeDefined();

      // --- the new generation is open, with no cost yet ---
      const current = gens[gens.length - 1]!;
      expect(current.upstreamSessionId).toBe(swapped.upstreamSessionId);
      expect(current.upstreamSessionId).toMatch(/^fresh_/);
      expect(current.cost).toBeUndefined();
      expect(current.startedAt).toBeDefined();
      expect(current.endedAt).toBeUndefined();

      // --- the split ledger banked exactly, and only once ---
      const persistedUsage = record!.currentUsage ?? {};
      expect(persistedUsage.cumulativeCost).toBeCloseTo(
        PRIOR_CUMULATIVE + RETIRED_SPEND,
        8,
      );
      // costAmount is the NEW generation's spend, which is nothing yet.
      expect(persistedUsage.costAmount ?? 0).toBe(0);

      // --- the collapsed lifetime view is unchanged by the rotation ---
      expect(swapped.currentUsage?.costAmount).toBeCloseTo(lifetimeBefore!, 8);

      await manager.flushHistoryWrites();
    },
    30_000,
  );
});
