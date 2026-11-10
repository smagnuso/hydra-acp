import { describe, expect, it } from "vitest";
import { parseElicitation } from "../acp/elicitation.js";
import { ElicitationList, createElicitationFlow, listEligible } from "./elicitation-list.js";
import { ElicitationWizard } from "./elicitation-form.js";
import type { KeyEvent } from "./input.js";

const key = (name: string): KeyEvent => ({ type: "key", name }) as KeyEvent;
const ch = (c: string): KeyEvent => ({ type: "char", ch: c }) as KeyEvent;

const db = [
  { const: "Postgres", title: "Postgres", description: "Full-featured server." },
  { const: "SQLite", title: "SQLite", description: "Embedded file." },
];
const lang = [
  { const: "Python", title: "Python" },
  { const: "Go", title: "Go" },
];

const form = (props: Record<string, unknown>, required: string[] = []): ReturnType<typeof parseElicitation> =>
  parseElicitation({
    mode: "form",
    message: "Lead-in",
    requestedSchema: { type: "object", required, properties: props },
  });

const two = (): ElicitationList =>
  new ElicitationList(
    form({
      a: { type: "string", title: "Database", description: "Which database?", oneOf: db },
      a_custom: { type: "string", title: "Other" },
      b: { type: "string", title: "Language", description: "Which language?", oneOf: lang },
    })!,
  );

describe("listEligible", () => {
  it("needs two or more questions that are all pick-one or yes/no", () => {
    expect(listEligible(form({ a: { type: "string", oneOf: db }, b: { type: "boolean" } })!)).toBe(true);
    expect(listEligible(form({ a: { type: "string", oneOf: db } })!)).toBe(false);
    expect(
      listEligible(form({ a: { type: "string", oneOf: db }, m: { type: "array", items: { anyOf: lang } } })!),
    ).toBe(false);
    expect(listEligible(form({ a: { type: "string", oneOf: db }, t: { type: "string" } })!)).toBe(false);
  });

  it("is chosen by createElicitationFlow, falling back to the wizard", () => {
    expect(createElicitationFlow(form({ a: { type: "string", oneOf: db }, b: { type: "string", oneOf: lang } })!)).toBeInstanceOf(
      ElicitationList,
    );
    expect(createElicitationFlow(form({ a: { type: "string", oneOf: db } })!)).toBeInstanceOf(ElicitationWizard);
  });
});

describe("ElicitationList", () => {
  it("shows one select row per question, unanswered at first", () => {
    const l = two();
    expect(l.form.rows.map((r) => (r.kind === "select" ? [r.label, r.value] : null))).toEqual([
      ["Database", "-"],
      ["Language", "-"],
    ]);
    expect(l.form.title).toBe("Which database?");
  });

  it("cycles an answer, shows the option description, and walks down with Enter", () => {
    const l = two();
    l.handleKey(key("right"));
    expect(l.form.rows[0]).toMatchObject({ value: "Postgres" });
    expect(l.form.title).toContain("Full-featured server.");
    l.handleKey(key("enter"));
    expect(l.form.cursor).toBe(1);
    expect(l.form.title).toBe("Which language?");
  });

  it("submits on Enter at the last row, leaving unanswered optional questions out", () => {
    const l = two();
    l.handleKey(key("right"));
    l.handleKey(key("right"));
    l.handleKey(key("enter"));
    l.handleKey(key("right"));
    l.handleKey(key("right"));
    expect(l.handleKey(key("enter"))).toEqual({
      type: "done",
      response: { action: "accept", content: { a: "SQLite", b: "Go" } },
    });
  });

  it("submits early with s and omits what was not answered", () => {
    const l = two();
    l.handleKey(key("right"));
    expect(l.handleKey(ch("s"))).toEqual({
      type: "done",
      response: { action: "accept", content: { a: "Postgres" } },
    });
  });

  it("will not submit with a required question unanswered", () => {
    const l = new ElicitationList(
      form(
        { a: { type: "string", oneOf: db }, b: { type: "string", oneOf: lang } },
        ["b"],
      )!,
    );
    l.handleKey(ch("s"));
    expect(l.form.title).toContain("required");
    expect(l.form.cursor).toBe(1);
  });

  it("takes a typed Other answer", () => {
    const l = two();
    l.handleKey(key("left"));
    expect(l.form.rows[0]).toMatchObject({ value: "Other..." });
    expect(l.handleKey(key("enter")).type).toBe("update");
    expect(l.form.rows[0]!.kind).toBe("text");
    for (const c of "Valkey") {
      l.handleKey(ch(c));
    }
    l.handleKey(key("enter"));
    expect(l.form.rows[0]).toMatchObject({ value: "Other: Valkey" });
    expect(l.handleKey(ch("s"))).toEqual({
      type: "done",
      response: { action: "accept", content: { a_custom: "Valkey" } },
    });
  });

  it("Esc inside the Other text goes back to the list", () => {
    const l = two();
    l.handleKey(key("left"));
    l.handleKey(key("enter"));
    expect(l.handleKey(key("escape")).type).toBe("update");
    expect(l.form.rows).toHaveLength(2);
  });

  it("d declines and Esc cancels", () => {
    expect(two().handleKey(ch("d"))).toEqual({ type: "done", response: { action: "decline" } });
    expect(two().handleKey(key("escape"))).toEqual({ type: "done", response: { action: "cancel" } });
  });

  it("starts on a default and sends yes/no as a boolean", () => {
    const l = new ElicitationList(
      form({
        a: { type: "string", oneOf: db, default: "SQLite" },
        ok: { type: "boolean", title: "Sure?", default: true },
      })!,
    );
    expect(l.form.rows[0]).toMatchObject({ value: "SQLite" });
    expect(l.handleKey(ch("s"))).toEqual({
      type: "done",
      response: { action: "accept", content: { a: "SQLite", ok: true } },
    });
  });

  it("a click on a row cycles it", () => {
    const l = two();
    l.handleClick({ kind: "row", row: 1 });
    expect(l.form.rows[1]).toMatchObject({ value: "Python" });
  });
});

describe("ElicitationList notes", () => {
  it("n adds a note that travels beside the pick", () => {
    const l = two();
    l.handleKey(key("right"));
    expect(l.handleKey(ch("n")).type).toBe("update");
    expect(l.form.rows[0]!.kind).toBe("text");
    expect(l.form.title).toContain("add a note to your pick");
    for (const c of "needs WAL") {
      l.handleKey(ch(c));
    }
    l.handleKey(key("enter"));
    expect(l.form.rows[0]).toMatchObject({ value: "Postgres (+ note: needs WAL)" });
    expect(l.handleKey(ch("s"))).toEqual({
      type: "done",
      response: { action: "accept", content: { a: "Postgres", a_custom: "needs WAL" } },
    });
  });

  it("a note on an unanswered row becomes its own answer", () => {
    const l = two();
    l.handleKey(ch("n"));
    expect(l.form.title).toContain("type your own answer");
    for (const c of "Valkey") {
      l.handleKey(ch(c));
    }
    l.handleKey(key("enter"));
    expect(l.form.rows[0]).toMatchObject({ value: "Other: Valkey" });
  });

  it("n does nothing on a question with no free-text slot", () => {
    const l = two();
    l.handleKey(key("down"));
    expect(l.handleKey(ch("n")).type).toBe("noop");
    expect(l.form.rows[1]!.kind).toBe("select");
  });

  it("advertises the note key only when some question has a free-text slot", () => {
    expect(two().form.hints.some((h) => h.label.startsWith("n note"))).toBe(true);
    const plain = new ElicitationList(
      form({ a: { type: "string", oneOf: db }, b: { type: "string", oneOf: lang } })!,
    );
    expect(plain.form.hints.some((h) => h.label.startsWith("n note"))).toBe(false);
  });
});
