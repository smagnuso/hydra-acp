import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionSynopsis } from "./snapshot.js";
import { makeMockAgent } from "../__tests__/test-utils.js";

vi.mock("./compaction-seed.js", () => ({
  renderCompactionSeed: vi.fn().mockReturnValue("MOCKED_SEED_TEXT"),
}));

import { Session } from "./session.js";
import { HistoryStore } from "./history-store.js";

beforeEach(() => {
  vi.clearAllMocks();
});

function makeSynopsis(): SessionSynopsis {
  return {
    goal: "g",
    outcome: "o",
    files_touched: [],
    tools_used: [],
  };
}

// Drive a usage_update through the agent so the session's costAmount is
// set the same way a real agent sets it.
async function reportCost(
  mock: ReturnType<typeof makeMockAgent>,
  amount: number,
): Promise<void> {
  mock.triggerNotification("session/update", {
    sessionId: "agent-sess",
    update: {
      sessionUpdate: "usage_update",
      used: 1000,
      size: 200000,
      cost: { amount, currency: "USD" },
    },
  });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// A spawn mock that hands back a distinct upstream id per call so each
// rotation lands on a new generation.
function makeRotatingSpawn(agentId: string) {
  const mocks: Array<ReturnType<typeof makeMockAgent>> = [];
  let n = 0;
  const spawnReplacementAgent = vi.fn().mockImplementation(async () => {
    n += 1;
    const m = makeMockAgent({ agentId, cwd: "/w" });
    mocks.push(m);
    return { agent: m.agent, upstreamSessionId: `u_gen${n}` };
  });
  return { spawnReplacementAgent, mocks };
}

type AgentChange = {
  agentId: string;
  upstreamSessionId: string;
  retiredCost?: number;
};

function makeSession(agentId = "a1") {
  const oldMock = makeMockAgent({ agentId, cwd: "/w" });
  const { spawnReplacementAgent, mocks } = makeRotatingSpawn(agentId);
  const session = new Session({
    sessionId: "hydra_gencost",
    cwd: "/w",
    agentId,
    agent: oldMock.agent,
    upstreamSessionId: "u_origin",
    historyStore: new HistoryStore(),
    spawnReplacementAgent,
  });
  const changes: AgentChange[] = [];
  session.onAgentChange((info) => changes.push(info));
  return { session, oldMock, mocks, changes };
}

describe("generation cost stamping on rotation", () => {
  it("reports the retiring upstream's spend as retiredCost on agentChange", async () => {
    const { session, oldMock, changes } = makeSession();

    await reportCost(oldMock, 36.783942760000016);
    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });

    expect(changes).toHaveLength(1);
    expect(changes[0]!.upstreamSessionId).toBe("u_gen1");
    expect(changes[0]!.retiredCost).toBeCloseTo(36.783942760000016, 10);
  });

  it("conserves the lifetime total across a rotation", async () => {
    const { session, oldMock } = makeSession();

    await reportCost(oldMock, 34.2847);
    const before = session.currentUsage?.costAmount;
    expect(before).toBeCloseTo(34.2847, 6);

    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });

    // The collapsed view still shows the full lifetime spend: the amount
    // moved from costAmount into cumulativeCost, it did not vanish and it
    // did not double.
    expect(session.currentUsage?.costAmount).toBeCloseTo(34.2847, 6);
  });

  it("banks each generation exactly once across repeated rotations", async () => {
    const { session, oldMock, mocks, changes } = makeSession();

    await reportCost(oldMock, 10);
    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });

    await reportCost(mocks[0]!, 5);
    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });

    expect(changes.map((c) => c.retiredCost)).toEqual([10, 5]);
    // 10 + 5 banked, nothing accrued on the third generation yet.
    expect(session.currentUsage?.costAmount).toBeCloseTo(15, 6);
  });

  it("does not re-report a stale retiredCost when the retiring generation spent nothing", async () => {
    const { session, oldMock, changes } = makeSession();

    await reportCost(oldMock, 36.78);
    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });
    expect(changes[0]!.retiredCost).toBeCloseTo(36.78, 6);

    // Rotate again immediately. The generation we just landed on never
    // reported any usage, so there is nothing to retire. Re-emitting the
    // previous figure would attribute $36.78 of spend to a generation
    // that spent $0 and inflate that upstream in any per-generation
    // report.
    await session.swapUpstream({ artifact: makeSynopsis(), tailK: 2 });

    expect(changes).toHaveLength(2);
    expect(changes[1]!.retiredCost).toBeUndefined();
    // The lifetime total is unaffected either way.
    expect(session.currentUsage?.costAmount).toBeCloseTo(36.78, 6);
  });
});
