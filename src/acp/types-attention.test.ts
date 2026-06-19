import { describe, it, expect } from "vitest";
import { AttentionFlagSchema, AttentionFlagArraySchema } from "./types-attention.js";

describe("AttentionFlagSchema", () => {
  it("parses a valid flag", () => {
    const input = {
      source: "claude-code",
      reason: "tool_use",
      raisedAt: 1700000000000,
      payload: { command: "ls" },
    };
    const result = AttentionFlagSchema.parse(input);
    expect(result).toEqual(input);
  });

  it("rejects missing required fields", () => {
    const inputs: unknown[] = [
      {},
      { source: "x" },
      { reason: "y", raisedAt: 1, payload: null },
      { source: "x", reason: "y" },
      { source: "x", reason: "y", payload: null },
      { reason: "y", raisedAt: 1, payload: null },
    ];
    for (const input of inputs) {
      const result = AttentionFlagSchema.safeParse(input);
      expect(result.success).toBe(false);
    }
  });

  it("rejects missing source, reason, or raisedAt", () => {
    const result1 = AttentionFlagSchema.safeParse({ reason: "y", raisedAt: 1, payload: null });
    expect(result1.success).toBe(false);
    const result2 = AttentionFlagSchema.safeParse({ source: "x", raisedAt: 1, payload: null });
    expect(result2.success).toBe(false);
    const result3 = AttentionFlagSchema.safeParse({ source: "x", reason: "y", payload: null });
    expect(result3.success).toBe(false);
  });

  it("rejects non-string source or reason", () => {
    const results = [
      AttentionFlagSchema.safeParse({ source: 42, reason: "y", raisedAt: 1, payload: null }),
      AttentionFlagSchema.safeParse({ source: "x", reason: [], raisedAt: 1, payload: null }),
      AttentionFlagSchema.safeParse({ source: null, reason: "y", raisedAt: 1, payload: null }),
    ];
    for (const result of results) {
      expect(result.success).toBe(false);
    }
  });

  it("rejects non-number raisedAt", () => {
    const results = [
      AttentionFlagSchema.safeParse({ source: "x", reason: "y", raisedAt: "now", payload: null }),
      AttentionFlagSchema.safeParse({ source: "x", reason: "y", raisedAt: true, payload: null }),
      AttentionFlagSchema.safeParse({ source: "x", reason: "y", raisedAt: null, payload: null }),
    ];
    for (const result of results) {
      expect(result.success).toBe(false);
    }
  });

  it("accepts arbitrary payload values", () => {
    const payloads = [null, 0, "", [], {}, true, false, { nested: { data: [1, 2] } }];
    for (const payload of payloads) {
      const result = AttentionFlagSchema.safeParse({
        source: "x",
        reason: "y",
        raisedAt: 1,
        payload,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.payload).toEqual(payload);
      }
    }
  });
});

describe("AttentionFlagArraySchema", () => {
  it("parses an array of valid flags", () => {
    const input = [
      { source: "a", reason: "r1", raisedAt: 1, payload: null },
      { source: "b", reason: "r2", raisedAt: 2, payload: { k: "v" } },
    ];
    const result = AttentionFlagArraySchema.parse(input);
    expect(result).toEqual(input);
  });

  it("rejects an array with an invalid flag", () => {
    const input = [
      { source: "a", reason: "r1", raisedAt: 1, payload: null },
      { source: 42, reason: "r2", raisedAt: 2, payload: null },
    ];
    const result = AttentionFlagArraySchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("accepts an empty array", () => {
    const result = AttentionFlagArraySchema.parse([]);
    expect(result).toEqual([]);
  });
});
