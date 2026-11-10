import { describe, expect, it } from "vitest";
import { TextAnswerer, formatElicitationOutcome, formatElicitationQuestion } from "./elicitation-text.js";

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

const ask = (params: unknown): TextAnswerer => TextAnswerer.create(params)!;

describe("TextAnswerer", () => {
  it("answers a single select by number or label", () => {
    expect(ask(single()).reply("2")).toEqual({ type: "done", response: { action: "accept", content: { question_0: "Memcached" } } });
    expect(ask(single()).reply(" redis ")).toEqual({ type: "done", response: { action: "accept", content: { question_0: "Redis" } } });
  });

  it("uses the custom slot only when the form has one, else asks again", () => {
    expect(ask(single()).reply("valkey").type).toBe("retry");
    const withOther = single({ question_0_custom: { type: "string" } });
    expect(ask(withOther).reply("valkey")).toEqual({ type: "done", response: { action: "accept", content: { question_0_custom: "valkey" } } });
  });

  it("handles multi-select lists", () => {
    const multi = {
      mode: "form",
      message: "Pick",
      requestedSchema: { type: "object", properties: { m: { type: "array", items: { anyOf: opts } } } },
    };
    expect(ask(multi).reply("1, memcached")).toEqual({ type: "done", response: { action: "accept", content: { m: ["Redis", "Memcached"] } } });
    expect(ask(multi).reply("nope").type).toBe("retry");
  });

  it("walks several questions one after another, validating text fields", () => {
    const form = {
      mode: "form",
      message: "Setup",
      requestedSchema: {
        type: "object",
        required: ["name"],
        properties: {
          cache: { type: "string", title: "Cache", oneOf: opts },
          name: { type: "string", title: "Name", minLength: 3 },
          n: { type: "integer", title: "Count", minimum: 1 },
        },
      },
    };
    const a = ask(form);
    expect(a.prompt()).toContain("Question 1 of 3");
    expect(a.prompt()).toContain("Setup");
    expect(a.reply("1")).toMatchObject({ type: "next" });
    expect(a.reply("ab")).toMatchObject({ type: "retry" });
    expect(a.reply("abc")).toMatchObject({ type: "next" });
    expect(a.reply("skip")).toEqual({
      type: "done",
      response: { action: "accept", content: { cache: "Redis", name: "abc" } },
    });
  });

  it("will not skip a required question", () => {
    const form = {
      mode: "form",
      message: "x",
      requestedSchema: { type: "object", required: ["t"], properties: { t: { type: "string" } } },
    };
    expect(ask(form).reply("skip")).toEqual({ type: "done", response: { action: "accept", content: { t: "skip" } } });
  });
});

describe("formatting", () => {
  it("lists options and renders the answer", () => {
    expect(formatElicitationQuestion(single())).toContain("Redis / Memcached");
    expect(
      formatElicitationOutcome(single(), { action: "accept", content: { question_0: "Redis" } }, "tui"),
    ).toBe("**Answered by tui:** Which cache? Redis");
    expect(formatElicitationOutcome(single(), { action: "cancel" }, undefined)).toContain("Not answered");
    expect(formatElicitationOutcome(single(), { action: "cancel" }, "tui")).toBe(
      "**Dismissed by tui:** Which cache?",
    );
  });
});

describe("outcome lines", () => {
  it("covers decline, multi-question answers and unparseable forms", () => {
    expect(formatElicitationOutcome(single(), { action: "decline" }, "tui")).toBe(
      "**Skipped by tui:** Which cache?",
    );
    const two = {
      mode: "form",
      message: "Two",
      requestedSchema: {
        type: "object",
        properties: {
          a: { type: "string", title: "A", oneOf: opts },
          b: { type: "array", title: "B", items: { anyOf: opts } },
        },
      },
    };
    const text = formatElicitationOutcome(
      two,
      { action: "accept", content: { a: "Redis", b: ["Redis", "Memcached"] } },
      undefined,
    );
    expect(text).toContain("- A: Redis");
    expect(text).toContain("- B: Redis, Memcached");
    expect(formatElicitationOutcome({ mode: "url", message: "x" }, { action: "accept" }, "tui")).toBe(
      "**Answered by tui:** the agent's question",
    );
  });
});
