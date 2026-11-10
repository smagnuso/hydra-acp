import { describe, expect, it } from "vitest";
import { answerFromText, formatElicitationOutcome, formatElicitationQuestion } from "./elicitation-text.js";

const opts = [
  { const: "Redis", title: "Redis" },
  { const: "Memcached", title: "Memcached" },
];
const single = (extra: Record<string, unknown> = {}): unknown => ({
  mode: "form",
  message: "Which cache?",
  requestedSchema: {
    type: "object",
    properties: { question_0: { type: "string", oneOf: opts }, ...extra },
  },
});

describe("answerFromText", () => {
  it("matches an option by number or label", () => {
    expect(answerFromText(single(), "2")).toEqual({ action: "accept", content: { question_0: "Memcached" } });
    expect(answerFromText(single(), " redis ")).toEqual({ action: "accept", content: { question_0: "Redis" } });
  });

  it("falls back to the custom slot only when the form has one", () => {
    expect(answerFromText(single(), "valkey")).toBeNull();
    const withOther = single({ question_0_custom: { type: "string" } });
    expect(answerFromText(withOther, "valkey")).toEqual({ action: "accept", content: { question_0_custom: "valkey" } });
  });

  it("handles multi-select lists", () => {
    const multi = {
      mode: "form",
      message: "Pick",
      requestedSchema: { type: "object", properties: { m: { type: "array", items: { anyOf: opts } } } },
    };
    expect(answerFromText(multi, "1, memcached")).toEqual({ action: "accept", content: { m: ["Redis", "Memcached"] } });
    expect(answerFromText(multi, "nope")).toBeNull();
  });

  it("refuses multi-question and text forms", () => {
    const two = {
      mode: "form",
      message: "x",
      requestedSchema: { type: "object", properties: { a: { type: "string", oneOf: opts }, b: { type: "string", oneOf: opts } } },
    };
    expect(answerFromText(two, "1")).toBeNull();
    const text = { mode: "form", message: "x", requestedSchema: { type: "object", properties: { t: { type: "string" } } } };
    expect(answerFromText(text, "hello")).toBeNull();
  });
});

describe("formatting", () => {
  it("lists options and renders the answer", () => {
    expect(formatElicitationQuestion(single())).toContain("Redis / Memcached");
    expect(
      formatElicitationOutcome(single(), { action: "accept", content: { question_0: "Redis" } }, "tui"),
    ).toBe("**Answered by tui:** Which cache? Redis");
    expect(formatElicitationOutcome(single(), { action: "cancel" }, undefined)).toContain("Not answered");
  });
});
