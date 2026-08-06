import { describe, expect, it } from "vitest";
import {
  shouldCompactSession,
  estimateTokens,
  estimateContextChars,
} from "./compaction-heuristic.js";

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

  it("returns true when AGENT-REPORTED utilization exceeds hardCeilingFraction regardless of idle", () => {
    const input = baseInput({
      agentReportedUsed: 85_000,
      agentReportedSize: 100_000,
      lastActivityMs: nowMs, // zero idle time
    });
    expect(shouldCompactSession(input)).toBe(true);
  });

  it("does NOT let an ESTIMATE bypass the idle gate, however large", () => {
    // Agents that send no usage_update (Cursor) fall to the char estimate
    // against a possibly-wrong context window. That combination used to trip
    // the hard ceiling on every attach — 10x over the ceiling here — which
    // trained the prompt to be ignored. Weak evidence must clear the soft
    // rule, idle signal included.
    const input = baseInput({
      unsummarizedChars: 4_080_000,
      lastActivityMs: nowMs, // zero idle time
    });
    expect(shouldCompactSession(input)).toBe(false);
    // Same session, once idle: the soft rule fires as before.
    expect(
      shouldCompactSession(
        baseInput({
          unsummarizedChars: 4_080_000,
          lastActivityMs: nowMs - 300_000,
        }),
      ),
    ).toBe(true);
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

describe("estimateContextChars", () => {
  const entry = (update: Record<string, unknown>) => ({
    method: "session/update",
    params: { sessionId: "s", update },
  });

  it("counts message and thought text, not the streaming envelope", () => {
    // Three chunks of 4 chars each. The envelope (sessionUpdate, messageId,
    // …) is many times that and must not be counted — this is the whole
    // reason a delta-heavy agent read as near-full after one turn.
    const chars = estimateContextChars([
      entry({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "aaaa" },
        messageId: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      entry({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "bbbb" },
        messageId: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
      entry({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "cccc" },
        messageId: "m_cccccccccccccccccccccccccc",
      }),
    ]);
    expect(chars).toBe(12);
  });

  it("ignores protocol-only updates", () => {
    expect(
      estimateContextChars([
        entry({ sessionUpdate: "turn_complete", stopReason: "end_turn" }),
        entry({ sessionUpdate: "usage_update", used: 1000, size: 200_000 }),
        entry({ sessionUpdate: "prompt_received" }),
      ]),
    ).toBe(0);
  });

  it("counts a tool call's largest snapshot once, not once per update", () => {
    // tool_call_update re-sends the whole payload on every status ping;
    // summing them counted a single file read four times over.
    const big = "x".repeat(1000);
    const chars = estimateContextChars([
      entry({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read" }),
      entry({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" }),
      entry({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        rawOutput: { content: big },
      }),
      entry({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        rawOutput: { content: big },
      }),
    ]);
    // 1000 for the payload; "Read" (4) came on a smaller snapshot and loses
    // to the max rather than adding to it.
    expect(chars).toBe(1000);
  });

  it("sums distinct tool calls", () => {
    const chars = estimateContextChars([
      entry({ sessionUpdate: "tool_call", toolCallId: "t1", rawInput: { command: "aaaaa" } }),
      entry({ sessionUpdate: "tool_call", toolCallId: "t2", rawInput: { command: "bbbbb" } }),
    ]);
    expect(chars).toBe(10);
  });

  it("counts a blob reference as the content it stands for", () => {
    // History loaded in "references" mode swaps big strings for refs. A ref
    // stringifies to ~100 chars whether it points at 2 KB or 2 MB, so the
    // estimate would otherwise depend on how the caller loaded the history.
    const chars = estimateContextChars([
      entry({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        rawOutput: { content: { __hydraBlob: "abc", bytes: 61_016 } },
      }),
    ]);
    expect(chars).toBe(61_016);
  });

  it("counts ACP content blocks and wrappers", () => {
    const chars = estimateContextChars([
      entry({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        content: [
          { type: "content", content: { type: "text", text: "12345" } },
          { type: "text", text: "678" },
        ],
      }),
    ]);
    expect(chars).toBe(8);
  });

  it("tolerates malformed entries", () => {
    expect(
      estimateContextChars([
        {},
        { params: null },
        { params: { update: null } },
        { params: { update: { sessionUpdate: "agent_message_chunk" } } },
      ]),
    ).toBe(0);
  });
});

describe("estimateContextChars diff blocks", () => {
  it("counts both sides of an edit diff, not its type/path keys", () => {
    const chars = estimateContextChars([
      {
        params: {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "t1",
            content: [
              {
                type: "diff",
                path: "/a/very/long/path/that/should/not/count.ts",
                oldText: "aaa",
                newText: "bbbbb",
              },
            ],
          },
        },
      },
    ]);
    expect(chars).toBe(8);
  });
});
