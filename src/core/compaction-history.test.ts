import { describe, it, expect } from "vitest";
import {
  formatCompactionHistory,
  readCompactionHistory,
} from "./compaction-history.js";
import type { UpstreamGeneration } from "./session-store.js";

const gen = (
  over: Partial<UpstreamGeneration> & { upstreamSessionId: string },
): UpstreamGeneration => ({
  agentId: "claude-acp",
  ...over,
});

describe("readCompactionHistory", () => {
  it("treats the first generation as birth, not a rotation", () => {
    const h = readCompactionHistory([gen({ upstreamSessionId: "u1" })], 0);
    expect(h.rotations).toEqual([]);
    expect(h.compactions).toEqual([]);
    expect(h.unknownCount).toBe(0);
  });

  it("counts only entries recorded as compactions", () => {
    const h = readCompactionHistory(
      [
        gen({ upstreamSessionId: "u1" }),
        gen({ upstreamSessionId: "u2", reason: "compaction", startedAt: "2026-08-19T21:25:00Z" }),
        gen({ upstreamSessionId: "u3", reason: "workspace-enter" }),
        gen({ upstreamSessionId: "u4", reason: "compaction" }),
      ],
      100,
    );
    expect(h.rotations).toHaveLength(3);
    expect(h.compactions.map((c) => c.upstreamSessionId)).toEqual(["u2", "u4"]);
    expect(h.unknownCount).toBe(0);
  });

  // The whole point of the optional field: an old rotation could have
  // been anything, and both "count it" and "ignore it" tell a lie.
  it("reports reasonless rotations as unknown, not as compactions", () => {
    const h = readCompactionHistory(
      [
        gen({ upstreamSessionId: "u1" }),
        gen({ upstreamSessionId: "u2" }),
        gen({ upstreamSessionId: "u3" }),
      ],
      88,
    );
    expect(h.compactions).toEqual([]);
    expect(h.unknownCount).toBe(2);
  });

  it("infers agent-swap when the agent id changes", () => {
    const h = readCompactionHistory(
      [
        gen({ upstreamSessionId: "u1", agentId: "claude-acp" }),
        gen({ upstreamSessionId: "u2", agentId: "codex-acp" }),
      ],
      50,
    );
    expect(h.rotations[0]?.inferredReason).toBe("agent-swap");
    expect(h.unknownCount).toBe(0);
  });

  it("infers rollback when an upstream is re-entered", () => {
    const h = readCompactionHistory(
      [
        gen({ upstreamSessionId: "u1" }),
        gen({ upstreamSessionId: "u2" }),
        gen({ upstreamSessionId: "u1" }),
      ],
      50,
    );
    expect(h.rotations[1]?.inferredReason).toBe("rollback");
    // u2 is still genuinely unknown.
    expect(h.unknownCount).toBe(1);
  });

  // A watermark that never moved proves no swap ever summarized anything,
  // so these rotations need no lower-bound caveat.
  it("rules out compaction entirely when the watermark never moved", () => {
    const h = readCompactionHistory(
      [gen({ upstreamSessionId: "u1" }), gen({ upstreamSessionId: "u2" })],
      undefined,
    );
    expect(h.rotations[0]?.notCompaction).toBe(true);
    expect(h.unknownCount).toBe(0);
    expect(formatCompactionHistory(h)).toEqual([]);
  });

  it("never lets inference override a recorded reason", () => {
    const h = readCompactionHistory(
      [
        gen({ upstreamSessionId: "u1", agentId: "claude-acp" }),
        gen({ upstreamSessionId: "u2", agentId: "codex-acp", reason: "compaction" }),
      ],
      10,
    );
    expect(h.rotations[0]?.reason).toBe("compaction");
    expect(h.rotations[0]?.inferredReason).toBeUndefined();
    expect(h.compactions).toHaveLength(1);
  });
});

describe("formatCompactionHistory", () => {
  it("renders count, time, upstream id and cost", () => {
    const h = readCompactionHistory(
      [
        gen({ upstreamSessionId: "u1" }),
        gen({
          upstreamSessionId: "u2",
          reason: "compaction",
          startedAt: "2026-08-19T21:25:54.169Z",
          endedAt: "2026-08-19T21:28:29.589Z",
          cost: 59.73718749999999,
        }),
        gen({
          upstreamSessionId: "u3",
          reason: "compaction",
          startedAt: "2026-08-19T21:28:29.589Z",
        }),
      ],
      1200,
    );
    const lines = formatCompactionHistory(h);
    expect(lines[0]).toBe("Compacted 2 times:");
    expect(lines[1]).toBe("  2026-08-19T21:25Z  u2  $59.74");
    expect(lines[2]).toBe("  2026-08-19T21:28Z  u3  (current)");
  });

  it("singularizes a lone compaction", () => {
    const h = readCompactionHistory(
      [
        gen({ upstreamSessionId: "u1" }),
        gen({ upstreamSessionId: "u2", reason: "compaction", startedAt: "2026-08-19T21:25:00Z" }),
      ],
      5,
    );
    expect(formatCompactionHistory(h)[0]).toBe("Compacted 1 time:");
  });

  it("marks the count as a lower bound when unknowns are present", () => {
    const h = readCompactionHistory(
      [
        gen({ upstreamSessionId: "u1" }),
        gen({ upstreamSessionId: "u2" }),
        gen({ upstreamSessionId: "u3" }),
        gen({ upstreamSessionId: "u4", reason: "compaction", startedAt: "2026-08-19T21:25:00Z" }),
      ],
      600,
    );
    const lines = formatCompactionHistory(h);
    expect(lines[0]).toBe("Compacted 1 time:");
    expect(lines.at(-1)).toBe(
      "2 earlier rotations, cause not recorded; the count above is a lower bound.",
    );
  });

  // With no recorded compactions there is no count to qualify, so a
  // "lower bound" caveat would refer to a line that isn't there.
  it("phrases the caveat standalone when there is no count above it", () => {
    const h = readCompactionHistory(
      [
        gen({ upstreamSessionId: "u1" }),
        gen({ upstreamSessionId: "u2" }),
        gen({ upstreamSessionId: "u3" }),
      ],
      900,
    );
    const lines = formatCompactionHistory(h);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      "No compactions on record. 2 rotations predate reason tracking, " +
        "and any of them may have been a compaction.",
    );
    expect(lines[0]).not.toContain("above");
  });

  // A session that only ever compacted post-upgrade should not be
  // permanently caveated.
  it("omits the caveat when every rotation has a reason", () => {
    const h = readCompactionHistory(
      [
        gen({ upstreamSessionId: "u1" }),
        gen({ upstreamSessionId: "u2", reason: "compaction", startedAt: "2026-08-19T21:25:00Z" }),
      ],
      5,
    );
    expect(formatCompactionHistory(h).join("\n")).not.toContain("lower bound");
  });

  it("renders a back-filled entry with no startedAt rather than inventing one", () => {
    const h = readCompactionHistory(
      [
        gen({ upstreamSessionId: "u1" }),
        gen({ upstreamSessionId: "u2", reason: "compaction" }),
      ],
      5,
    );
    expect(formatCompactionHistory(h)[1]).toContain("unknown time");
  });
});

// The incident that motivated runIds: one `/hydra compact` swapped twice
// because a background turn grew history under iteration 1. Counting
// swaps tells the user they compacted twice when they typed the command
// once.
describe("multi-swap runs", () => {
  const twoSwapRun = [
    gen({ upstreamSessionId: "u_pre" }),
    gen({
      upstreamSessionId: "u_mid",
      reason: "compaction",
      runId: "run1",
      startedAt: "2026-08-19T22:06:56.172Z",
      endedAt: "2026-08-19T22:08:13.736Z",
      cost: 2,
    }),
    gen({
      upstreamSessionId: "u_final",
      reason: "compaction",
      runId: "run1",
      startedAt: "2026-08-19T22:08:13.736Z",
      cost: 3,
    }),
  ];

  it("counts two swaps of one run as one compaction", () => {
    const h = readCompactionHistory(twoSwapRun, 11646);
    expect(h.compactions).toHaveLength(2);
    expect(h.runs).toHaveLength(1);
    expect(formatCompactionHistory(h)[0]).toBe("Compacted 1 time:");
  });

  it("reports the run by its final upstream and first swap time", () => {
    const h = readCompactionHistory(twoSwapRun, 11646);
    const run = h.runs[0]!;
    // The intermediate upstream lived 77 seconds and is already
    // superseded, so pointing the user at it would be pointing at a
    // dead end.
    expect(run.upstreamSessionId).toBe("u_final");
    expect(run.at).toBe("2026-08-19T22:06:56.172Z");
    expect(run.swaps).toBe(2);
    expect(run.cost).toBe(5);
    expect(run.current).toBe(true);
  });

  it("shows the swap count so the extra rotation is not hidden", () => {
    const lines = formatCompactionHistory(readCompactionHistory(twoSwapRun, 11646));
    expect(lines[1]).toContain("(2 swaps)");
    expect(lines[1]).toContain("u_final");
  });

  it("keeps distinct runs separate", () => {
    const h = readCompactionHistory(
      [
        gen({ upstreamSessionId: "u0" }),
        gen({ upstreamSessionId: "u1", reason: "compaction", runId: "runA", startedAt: "2026-08-19T10:00:00Z" }),
        gen({ upstreamSessionId: "u2", reason: "compaction", runId: "runB", startedAt: "2026-08-19T11:00:00Z" }),
      ],
      500,
    );
    expect(h.runs).toHaveLength(2);
    expect(formatCompactionHistory(h)[0]).toBe("Compacted 2 times:");
  });

  // Pre-runId entries have nothing to group on. Merging them would
  // under-count, which hides exactly what the user is asking about.
  it("treats reasonless-runId compactions as separate runs", () => {
    const h = readCompactionHistory(
      [
        gen({ upstreamSessionId: "u0" }),
        gen({ upstreamSessionId: "u1", reason: "compaction", startedAt: "2026-08-19T10:00:00Z" }),
        gen({ upstreamSessionId: "u2", reason: "compaction", startedAt: "2026-08-19T11:00:00Z" }),
      ],
      500,
    );
    expect(h.runs).toHaveLength(2);
    expect(h.runs.every((r) => r.swaps === 1)).toBe(true);
  });

  // Same id reappearing after an unrelated run must not fuse the two.
  it("only merges consecutive swaps", () => {
    const h = readCompactionHistory(
      [
        gen({ upstreamSessionId: "u0" }),
        gen({ upstreamSessionId: "u1", reason: "compaction", runId: "runA", startedAt: "2026-08-19T10:00:00Z" }),
        gen({ upstreamSessionId: "u2", reason: "compaction", runId: "runB", startedAt: "2026-08-19T11:00:00Z" }),
        gen({ upstreamSessionId: "u3", reason: "compaction", runId: "runA", startedAt: "2026-08-19T12:00:00Z" }),
      ],
      500,
    );
    expect(h.runs).toHaveLength(3);
  });
});
