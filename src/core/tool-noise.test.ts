import { describe, expect, it } from "vitest";
import { isGuardianReviewToolCall } from "./tool-noise.js";

describe("isGuardianReviewToolCall", () => {
  it("matches codex-acp's guardian_assessment: toolCallId prefix", () => {
    expect(
      isGuardianReviewToolCall("guardian_assessment:756523bd-fa16", undefined),
    ).toBe(true);
  });

  it("matches the literal 'Guardian Review' title", () => {
    expect(isGuardianReviewToolCall(undefined, "Guardian Review")).toBe(true);
  });

  it("rejects an ordinary tool call", () => {
    expect(isGuardianReviewToolCall("exec-2b37c925", "Run command")).toBe(
      false,
    );
    expect(isGuardianReviewToolCall(undefined, undefined)).toBe(false);
  });

  // "guardian_assessment" is codex-acp's own prefix, not a generic
  // substring match — a toolCallId that merely mentions guardian
  // elsewhere shouldn't trip this.
  it("requires the prefix to be at the start of the id", () => {
    expect(
      isGuardianReviewToolCall("exec-mentions-guardian_assessment:x", undefined),
    ).toBe(false);
  });
});
