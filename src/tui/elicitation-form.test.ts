import { describe, expect, it } from "vitest";
import { ElicitationWizard, parseElicitation } from "./elicitation-form.js";
import type { KeyEvent } from "./input.js";

const key = (name: string): KeyEvent => ({ type: "key", name }) as KeyEvent;
const ch = (c: string): KeyEvent => ({ type: "char", ch: c }) as KeyEvent;

const options = [
  { const: "Redis", title: "Redis", description: "fast" },
  { const: "Memcached", title: "Memcached" },
];

function askParams(extra: Record<string, unknown> = {}): unknown {
  return {
    mode: "form",
    sessionId: "s",
    message: "Which cache?",
    requestedSchema: {
      type: "object",
      properties: {
        question_0: { type: "string", oneOf: options },
        question_0_custom: { type: "string", title: "Other" },
      },
    },
    ...extra,
  };
}

describe("parseElicitation", () => {
  it("folds the _custom companion into its select", () => {
    const parsed = parseElicitation(askParams())!;
    expect(parsed.fields).toHaveLength(1);
    expect(parsed.fields[0]).toMatchObject({
      kind: "single",
      customKey: "question_0_custom",
    });
  });

  it("returns null for an unrenderable field", () => {
    const p = parseElicitation({
      mode: "form",
      message: "x",
      requestedSchema: { type: "object", properties: { a: { type: "object" } } },
    });
    expect(p).toBeNull();
  });

  it("returns null for url mode", () => {
    expect(parseElicitation({ mode: "url", message: "x" })).toBeNull();
  });
});

describe("ElicitationWizard", () => {
  it("accepts a picked option", () => {
    const w = new ElicitationWizard(parseElicitation(askParams())!);
    const out = w.handleKey(key("enter"));
    expect(out).toEqual({
      type: "done",
      response: { action: "accept", content: { question_0: "Redis" } },
    });
  });

  it("routes Other to a text page and stores the custom answer", () => {
    const w = new ElicitationWizard(parseElicitation(askParams())!);
    w.handleKey(key("down"));
    w.handleKey(key("down"));
    expect(w.handleKey(key("enter")).type).toBe("update");
    w.handleKey(ch("h"));
    w.handleKey(ch("i"));
    const out = w.handleKey(key("enter"));
    expect(out).toEqual({
      type: "done",
      response: { action: "accept", content: { question_0_custom: "hi" } },
    });
  });

  it("toggles a multi-select and finishes on Done", () => {
    const parsed = parseElicitation({
      mode: "form",
      message: "Pick",
      requestedSchema: {
        type: "object",
        properties: { m: { type: "array", items: { anyOf: options } } },
      },
    })!;
    const w = new ElicitationWizard(parsed);
    w.handleKey(key("enter"));
    w.handleKey(key("down"));
    w.handleKey(key("enter"));
    w.handleKey(key("down"));
    const out = w.handleKey(key("enter"));
    expect(out).toEqual({
      type: "done",
      response: { action: "accept", content: { m: ["Redis", "Memcached"] } },
    });
  });

  it("steps through several fields", () => {
    const parsed = parseElicitation({
      mode: "form",
      message: "Two",
      requestedSchema: {
        type: "object",
        required: ["a"],
        properties: {
          a: { type: "boolean", title: "Sure?" },
          b: { type: "integer", title: "How many" },
        },
      },
    })!;
    const w = new ElicitationWizard(parsed);
    expect(w.handleKey(key("enter")).type).toBe("update");
    w.handleKey(ch("x"));
    expect(w.handleKey(key("enter")).type).toBe("update");
    expect(w.form.title).toContain("not an integer");
    w.handleKey(key("backspace"));
    w.handleKey(ch("4"));
    expect(w.handleKey(key("enter"))).toEqual({
      type: "done",
      response: { action: "accept", content: { a: true, b: 4 } },
    });
  });

  it("maps d to decline and Esc to cancel", () => {
    const parsed = parseElicitation(askParams())!;
    expect(new ElicitationWizard(parsed).handleKey(ch("d"))).toEqual({
      type: "done",
      response: { action: "decline" },
    });
    expect(new ElicitationWizard(parsed).handleKey(key("escape"))).toEqual({
      type: "done",
      response: { action: "cancel" },
    });
  });
});

const wizardFor = (properties: Record<string, unknown>, required: string[] = []): ElicitationWizard =>
  new ElicitationWizard(
    parseElicitation({
      mode: "form",
      message: "m",
      requestedSchema: { type: "object", required, properties },
    })!,
  );

const typeText = (w: ElicitationWizard, text: string): void => {
  for (const c of text) {
    w.handleKey(ch(c));
  }
};

describe("ElicitationWizard defaults", () => {
  it("starts a select on its default option", () => {
    const w = wizardFor({ s: { type: "string", oneOf: options, default: "Memcached" } });
    expect(w.form.cursor).toBe(1);
    expect(w.handleKey(key("enter"))).toEqual({
      type: "done",
      response: { action: "accept", content: { s: "Memcached" } },
    });
  });

  it("pre-picks multi-select defaults", () => {
    const w = wizardFor({
      m: { type: "array", items: { anyOf: options }, default: ["Memcached"] },
    });
    w.handleKey(key("down"));
    w.handleKey(key("down"));
    expect(w.handleKey(key("enter"))).toEqual({
      type: "done",
      response: { action: "accept", content: { m: ["Memcached"] } },
    });
  });

  it("seeds a text field with its default", () => {
    const w = wizardFor({ t: { type: "string", default: "abc" } });
    expect(w.handleKey(key("enter"))).toEqual({
      type: "done",
      response: { action: "accept", content: { t: "abc" } },
    });
  });
});

describe("ElicitationWizard constraints", () => {
  it("enforces minLength and maxLength", () => {
    const w = wizardFor({ t: { type: "string", minLength: 3, maxLength: 4 } });
    typeText(w, "ab");
    expect(w.handleKey(key("enter")).type).toBe("update");
    expect(w.form.title).toContain("at least 3");
    typeText(w, "cde");
    w.handleKey(key("enter"));
    expect(w.form.title).toContain("at most 4");
  });

  it("enforces pattern and format", () => {
    const p = wizardFor({ t: { type: "string", pattern: "^[a-z]+$" } });
    typeText(p, "AB1");
    p.handleKey(key("enter"));
    expect(p.form.title).toContain("expected format");
    const f = wizardFor({ t: { type: "string", format: "email" } });
    typeText(f, "nope");
    f.handleKey(key("enter"));
    expect(f.form.title).toContain("not an email");
    const ok = wizardFor({ t: { type: "string", format: "date" } });
    typeText(ok, "2026-07-22");
    expect(ok.handleKey(key("enter")).type).toBe("done");
  });

  it("enforces numeric minimum and maximum", () => {
    const w = wizardFor({ n: { type: "number", minimum: 1, maximum: 5 } });
    typeText(w, "9");
    w.handleKey(key("enter"));
    expect(w.form.title).toContain("at most 5");
  });

  it("enforces multi-select minItems", () => {
    const w = wizardFor({ m: { type: "array", items: { anyOf: options }, minItems: 2 } });
    w.handleKey(key("enter"));
    w.handleKey(key("down"));
    w.handleKey(key("down"));
    expect(w.handleKey(key("enter")).type).toBe("update");
    expect(w.form.title).toContain("at least 2");
  });
});
