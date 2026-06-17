import { describe, expect, it } from "vitest";
import { shouldCompactSession, estimateTokens } from "./compaction-heuristic.js";

const config = {
  contextFraction: 0.5,
  hardCeilingFraction: 0.85,
  absoluteFallback: 120_000,
  idleBeforePromptMs: 300_000,
  modelContextWindows: { "claude-opus-4-7": 200_000 },
};

const nowMs = 1_000_000;

function baseInput(overrides: Partial<import("./compaction-heuristic.js").CompactionHeuristicInput> = {}) {
  return {
    summarizedThroughEntry: 0,
    totalEntries: 100,
    unsummarizedChars: 0,
    compactionInFlight: false,
    currentModel: undefined,
    lastActivityMs: nowMs - 300_000,
    nowMs,
    config,
    ...overrides,
  };
}

describe("shouldCompactSession", () => {
  it("returns false when compactionInFlight is true regardless of utilization", () => {
    const input = baseInput({
      unsummarizedChars: 408_000, // well above hard ceiling
      compactionInFlight: true,
    });
    expect(shouldCompactSession(input)).toBe(false);
  });

  it("returns false when totalEntries is 0", () => {
    const input = baseInput({
      totalEntries: 0,
      unsummarizedChars: 408_000,
    });
    expect(shouldCompactSession(input)).toBe(false);
  });

  it("returns false when utilization exceeds contextFraction but idle time is too short", () => {
    // 240_000 chars = 60_000 tokens = exactly 50% of 120k absoluteFallback
    const input = baseInput({
      unsummarizedChars: 240_000,
      lastActivityMs: nowMs - 150_000, // idle only 2.5 min, below 5 min threshold
    });
    expect(shouldCompactSession(input)).toBe(false);
  });

  it("returns true when utilization exceeds contextFraction AND idle past TTL", () => {
    // 240_000 chars = 60_000 tokens = exactly 50% of 120k absoluteFallback
    const input = baseInput({
      unsummarizedChars: 240_000,
      lastActivityMs: nowMs - 300_000, // idle exactly 5 min
    });
    expect(shouldCompactSession(input)).toBe(true);
  });

  it("returns true when utilization exceeds hardCeilingFraction regardless of idle", () => {
    // 408_000 chars = 102_000 tokens = 85% of 120k absoluteFallback
    const input = baseInput({
      unsummarizedChars: 408_000,
      lastActivityMs: nowMs, // zero idle time
    });
    expect(shouldCompactSession(input)).toBe(true);
  });

  it("unknown model falls back to absoluteFallback", () => {
    // Unknown model → uses absoluteFallback (120_000).
    // 240_000 chars = 60_000 tokens = 50% of 120k = exactly contextFraction
    const input = baseInput({
      unsummarizedChars: 240_000,
      currentModel: "unknown-model-v9",
      lastActivityMs: nowMs - 300_000,
    });
    expect(shouldCompactSession(input)).toBe(true);
  });

  it("known model with custom context window uses that window for utilization", () => {
    // "claude-opus-4-7" has 200_000 window.
    // 200_000 chars = 50_000 tokens = 25% of 200k — below contextFraction (0.5)
    // Even with long idle, soft signal should NOT fire.
    const input = baseInput({
      unsummarizedChars: 200_000,
      currentModel: "claude-opus-4-7",
      lastActivityMs: nowMs - 600_000, // idle 10 min
    });
    expect(shouldCompactSession(input)).toBe(false);

    // 400_000 chars = 100_000 tokens = 50% of 200k — exactly contextFraction
    const input2 = baseInput({
      unsummarizedChars: 400_000,
      currentModel: "claude-opus-4-7",
      lastActivityMs: nowMs - 300_000,
    });
    expect(shouldCompactSession(input2)).toBe(true);
  });
});

describe("estimateTokens", () => {
  it("returns floor(chars / 4)", () => {
    expect(estimateTokens(400)).toBe(100);
    expect(estimateTokens(401)).toBe(100);
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(3)).toBe(0);
    expect(estimateTokens(7)).toBe(1);
  });
});
