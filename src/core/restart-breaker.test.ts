import { describe, it, expect } from "vitest";
import {
  FATAL_EXIT_CODE,
  RestartBreaker,
  type BreakerDecision,
} from "./restart-breaker.js";

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function trippedReason(d: BreakerDecision): string | undefined {
  return typeof d === "object" ? d.tripped : undefined;
}

describe("RestartBreaker", () => {
  it("returns 'restart' for an ordinary non-fatal exit", () => {
    const b = new RestartBreaker();
    expect(b.recordExit(1, "x", "extension")).toBe("restart");
    expect(b.tripped).toBeUndefined();
  });

  it("trips immediately on FATAL_EXIT_CODE regardless of history", () => {
    const b = new RestartBreaker();
    const decision = b.recordExit(FATAL_EXIT_CODE, "archiver", "extension");
    expect(trippedReason(decision)).toContain("code 78");
    expect(trippedReason(decision)).toContain("extensions start archiver");
    expect(b.tripped).toBeDefined();
  });

  it("trips after maxFailures+1 non-fatal exits inside the window", () => {
    const c = clock();
    const b = new RestartBreaker({
      windowMs: 1_000,
      maxFailuresInWindow: 2,
      now: c.now,
    });
    expect(b.recordExit(1, "t", "transformer")).toBe("restart");
    expect(b.recordExit(1, "t", "transformer")).toBe("restart");
    // Third exit inside the window is the one that crosses the threshold.
    const decision = b.recordExit(1, "t", "transformer");
    expect(trippedReason(decision)).toContain("crash loop");
    expect(trippedReason(decision)).toContain("transformers start t");
  });

  it("does NOT trip when exits are spaced out beyond the window", () => {
    const c = clock();
    const b = new RestartBreaker({
      windowMs: 1_000,
      maxFailuresInWindow: 2,
      now: c.now,
    });
    expect(b.recordExit(1, "x", "extension")).toBe("restart");
    c.advance(1_500);
    expect(b.recordExit(1, "x", "extension")).toBe("restart");
    c.advance(1_500);
    expect(b.recordExit(1, "x", "extension")).toBe("restart");
    c.advance(1_500);
    // Old entries have fallen out of the window each time.
    expect(b.recordExit(1, "x", "extension")).toBe("restart");
    expect(b.tripped).toBeUndefined();
  });

  it("a null exit code (signaled exit) counts toward the rolling window", () => {
    const c = clock();
    const b = new RestartBreaker({
      windowMs: 1_000,
      maxFailuresInWindow: 1,
      now: c.now,
    });
    expect(b.recordExit(null, "x", "extension")).toBe("restart");
    const decision = b.recordExit(null, "x", "extension");
    expect(trippedReason(decision)).toContain("crash loop");
  });

  it("reset() clears both the window and the tripped flag", () => {
    const b = new RestartBreaker({ windowMs: 1_000, maxFailuresInWindow: 0 });
    b.recordExit(1, "x", "extension");
    expect(b.tripped).toBeDefined();
    b.reset();
    expect(b.tripped).toBeUndefined();
    // After reset, the very next non-fatal exit is restart-eligible again
    // (with maxFailuresInWindow=0, however, the FIRST exit already exceeds
    // the threshold — so this is more about confirming history is wiped).
    expect(b.recordExit(1, "x", "extension")).not.toBe("restart");
    // ...and trips fresh.
    expect(b.tripped).toBeDefined();
  });
});
