import { describe, expect, it } from "vitest";
import type { Question } from "./clarifier-types.js";
import type { KeyEvent, KeyName } from "./input.js";
import {
  filterOpenQuestions,
  groupQuestions,
  getQuestionValueRing,
  buildAllQuestionsSpec,
  buildSaveDispatches,
  resolveQuestionDispatch,
  handleQuestionsKey,
  QUESTION_VALUE_DISMISS,
  CLARIFIER_QUESTION_ANSWER_METHOD,
  CLARIFIER_QUESTION_DISMISS_METHOD,
  type QuestionGroup,
} from "./app.js";

function q(overrides: Partial<Question> = {}): Question {
  const id = overrides.id ?? "q-1";
  return {
    id,
    question: overrides.question ?? `Need confirmation [${id}]?`,
    defaultAnswer: overrides.defaultAnswer ?? "Yes",
    askedAt: overrides.askedAt ?? Date.now(),
    status: overrides.status ?? "open",
    ...overrides,
  };
}

function key(name: KeyName): Extract<KeyEvent, { type: "key" }> {
  return { type: "key", name };
}

function toGroups(qs: Question[]): QuestionGroup[] {
  return groupQuestions(qs);
}

function falses(n: number): boolean[] {
  return new Array(n).fill(false);
}
function trues(n: number): boolean[] {
  return new Array(n).fill(true);
}

describe("filterOpenQuestions", () => {
  it("returns open and pending-delivery, excludes closed", () => {
    const all: Question[] = [
      q({ id: "a", status: "open" }),
      q({ id: "b", status: "pending-delivery" }),
      q({ id: "c", status: "closed" }),
      q({ id: "d", status: "open" }),
    ];
    expect(filterOpenQuestions(all).map((r) => r.id)).toEqual(["a", "b", "d"]);
  });

  it("returns empty array for empty input", () => {
    expect(filterOpenQuestions([])).toEqual([]);
  });
});

describe("getQuestionValueRing", () => {
  it("explicit options become the ring (no dismiss in it)", () => {
    expect(
      getQuestionValueRing(q({ defaultAnswer: "Yes", options: ["Yes", "No"] })),
    ).toEqual(["Yes", "No"]);
  });

  it("hoists defaultAnswer to index 0 when it's not options[0]", () => {
    expect(
      getQuestionValueRing(
        q({ defaultAnswer: "spaces", options: ["tabs", "spaces"] }),
      ),
    ).toEqual(["spaces", "tabs"]);
  });

  it("includes defaultAnswer up front even when it isn't in options", () => {
    expect(
      getQuestionValueRing(
        q({ defaultAnswer: "maybe", options: ["yes", "no"] }),
      ),
    ).toEqual(["maybe", "yes", "no"]);
  });

  it("free-text falls back to [defaultAnswer]", () => {
    expect(getQuestionValueRing(q({ defaultAnswer: "Proceed" }))).toEqual([
      "Proceed",
    ]);
  });
});

describe("groupQuestions", () => {
  it("collapses identical question text into a single group", () => {
    const groups = groupQuestions([
      q({ id: "a", question: "Same?" }),
      q({ id: "b", question: "Same?" }),
      q({ id: "c", question: "Different?" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.ids).toEqual(["a", "b"]);
    expect(groups[1]!.ids).toEqual(["c"]);
  });
});

describe("buildAllQuestionsSpec", () => {
  it("renders ring[0] (= defaultAnswer) with no dedup count", () => {
    const groups = toGroups([
      q({ id: "a", question: "First?", defaultAnswer: "yes", options: ["yes", "no"] }),
      q({ id: "b", question: "First?", defaultAnswer: "yes", options: ["yes", "no"] }),
      q({ id: "c", question: "Second?", defaultAnswer: "later" }),
    ]);
    const spec = buildAllQuestionsSpec(groups, [0, 0], falses(2), 0);
    expect(spec.title).toBe("Open questions (2)");
    expect(spec.options).toEqual([
      { label: "First?", value: "yes" },
      { label: "Second?", value: "later" },
    ]);
  });

  it("shows 'dismiss' value when row is in dismiss-mode", () => {
    const groups = toGroups([q({ id: "a", options: ["yes", "no"] })]);
    const spec = buildAllQuestionsSpec(groups, [0], [true], 0);
    expect(spec.options[0]!.value).toBe(QUESTION_VALUE_DISMISS);
    expect(spec.options[0]!.label).toBe(groups[0]!.representative.question);
  });

  it("truncates long question text with ellipsis", () => {
    const long = "A".repeat(80);
    const groups = toGroups([q({ question: long })]);
    const spec = buildAllQuestionsSpec(groups, [0], falses(1), 0, 20);
    expect(spec.options[0]!.label).toHaveLength(20);
    expect(spec.options[0]!.label.endsWith("…")).toBe(true);
  });

  it("clamps selectedIndex into valid range", () => {
    const groups = toGroups([q({ id: "x" })]);
    expect(buildAllQuestionsSpec(groups, [0], falses(1), -5).selectedIndex).toBe(0);
    expect(buildAllQuestionsSpec(groups, [0], falses(1), 99).selectedIndex).toBe(0);
  });
});

describe("resolveQuestionDispatch", () => {
  it("dispatches answer for a regular value", () => {
    expect(resolveQuestionDispatch("Yes", q({ id: "q-42" }), "s-1")).toEqual({
      type: "answer",
      method: CLARIFIER_QUESTION_ANSWER_METHOD,
      params: { sessionId: "s-1", questionId: "q-42", answer: "Yes" },
    });
  });

  it("dispatches dismiss for the dismiss sentinel", () => {
    expect(
      resolveQuestionDispatch(QUESTION_VALUE_DISMISS, q({ id: "q-99" }), "s-2"),
    ).toEqual({
      type: "dismiss",
      method: CLARIFIER_QUESTION_DISMISS_METHOD,
      params: { sessionId: "s-2", questionId: "q-99" },
    });
  });
});

describe("buildSaveDispatches", () => {
  it("skips untouched rows", () => {
    const groups = toGroups([q({ id: "a", options: ["yes", "no"] })]);
    expect(
      buildSaveDispatches(groups, [1], falses(1), falses(1), "s"),
    ).toEqual([]);
  });

  it("touched + not dismissed → answer for every id in group", () => {
    const groups = toGroups([
      q({ id: "a1", question: "Dup?", defaultAnswer: "yes", options: ["yes", "no"] }),
      q({ id: "a2", question: "Dup?", defaultAnswer: "yes", options: ["yes", "no"] }),
    ]);
    expect(groups).toHaveLength(1);
    const out = buildSaveDispatches(groups, [1], trues(1), falses(1), "s");
    expect(out).toHaveLength(2);
    expect(out.every((a) => a.type === "answer")).toBe(true);
    expect(out.map((a) => a.params.questionId)).toEqual(["a1", "a2"]);
    expect(
      out.every((a) => (a as { params: { answer: string } }).params.answer === "no"),
    ).toBe(true);
  });

  it("touched + dismissed → dismiss for every id in group, ignores selectedValues", () => {
    const groups = toGroups([
      q({ id: "x1", question: "Drop?", options: ["yes", "no"] }),
      q({ id: "x2", question: "Drop?", options: ["yes", "no"] }),
    ]);
    const out = buildSaveDispatches(groups, [1], trues(1), trues(1), "s");
    expect(out).toHaveLength(2);
    expect(out.every((a) => a.type === "dismiss")).toBe(true);
  });

  it("mixed touched / dismissed / untouched rows", () => {
    const groups = toGroups([
      q({ id: "a", options: ["yes", "no"] }),
      q({ id: "b", options: ["x", "y"] }),
      q({ id: "c", options: ["1", "2"] }),
    ]);
    // a: touched, value 1 ("no") — answer
    // b: untouched — skipped
    // c: touched + dismissed — dismiss
    const out = buildSaveDispatches(
      groups,
      [1, 0, 0],
      [true, false, true],
      [false, false, true],
      "s",
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.type).toBe("answer");
    expect(out[0]!.params.questionId).toBe("a");
    expect(out[1]!.type).toBe("dismiss");
    expect(out[1]!.params.questionId).toBe("c");
  });
});

describe("handleQuestionsKey — navigation", () => {
  const groups = toGroups([q({ id: "a" }), q({ id: "b" }), q({ id: "c" })]);
  const sel = [0, 0, 0];
  const t = falses(3);
  const d = falses(3);

  it("moves selected row down", () => {
    expect(handleQuestionsKey(key("down"), true, groups, sel, t, d, 0, "s"))
      .toEqual({ type: "row", selectedRow: 1 });
  });

  it("clamps row movement at bottom", () => {
    expect(handleQuestionsKey(key("down"), true, groups, sel, t, d, 2, "s"))
      .toEqual({ type: "row", selectedRow: 2 });
  });

  it("clamps row movement at top", () => {
    expect(handleQuestionsKey(key("up"), true, groups, sel, t, d, 0, "s"))
      .toEqual({ type: "row", selectedRow: 0 });
  });

  it("jumps to row N for digit chars 1-9", () => {
    expect(
      handleQuestionsKey({ type: "char", ch: "2" }, true, groups, sel, t, d, 0, "s"),
    ).toEqual({ type: "row", selectedRow: 1 });
  });

  it("ignores digit chars beyond groups.length", () => {
    expect(
      handleQuestionsKey({ type: "char", ch: "9" }, true, groups, sel, t, d, 0, "s"),
    ).toEqual({ type: "noop" });
  });
});

describe("handleQuestionsKey — value cycling", () => {
  it("right cycles forward in the answer ring", () => {
    const groups = toGroups([q({ id: "a", options: ["x", "y", "z"] })]);
    const result = handleQuestionsKey(
      key("right"), true, groups, [0], falses(1), falses(1), 0, "s",
    );
    expect(result).toEqual({ type: "cycle", selectedRow: 0, newValueIndex: 1 });
  });

  it("left wraps to the last ring entry", () => {
    const groups = toGroups([
      q({ id: "a", defaultAnswer: "x", options: ["x", "y", "z"] }),
    ]);
    const result = handleQuestionsKey(
      key("left"), true, groups, [0], falses(1), falses(1), 0, "s",
    );
    expect(result).toEqual({ type: "cycle", selectedRow: 0, newValueIndex: 2 });
  });

  it("Enter no longer cycles — it saves", () => {
    const groups = toGroups([q({ id: "a", options: ["x", "y"] })]);
    const result = handleQuestionsKey(
      key("enter"), true, groups, [0], falses(1), falses(1), 0, "s",
    );
    expect(result.type).toBe("save");
  });
});

describe("handleQuestionsKey — dismiss toggle", () => {
  it("`d` returns dismiss-toggle for the current row", () => {
    const groups = toGroups([q({ id: "a" }), q({ id: "b" })]);
    const result = handleQuestionsKey(
      { type: "char", ch: "d" }, true, groups, [0, 0], falses(2), falses(2), 1, "s",
    );
    expect(result).toEqual({ type: "dismiss-toggle", selectedRow: 1 });
  });

  it("capital `D` works too", () => {
    const groups = toGroups([q({ id: "a" })]);
    const result = handleQuestionsKey(
      { type: "char", ch: "D" }, true, groups, [0], falses(1), falses(1), 0, "s",
    );
    expect(result.type).toBe("dismiss-toggle");
  });
});

describe("handleQuestionsKey — save and discard", () => {
  it("Esc emits save with dispatches only for touched rows", () => {
    const groups = toGroups([
      q({ id: "a", options: ["yes", "no"] }),
      q({ id: "b", defaultAnswer: "later" }),
    ]);
    const result = handleQuestionsKey(
      key("escape"), true, groups, [1, 0], [true, false], falses(2), 0, "sess",
    );
    expect(result.type).toBe("save");
    if (result.type === "save") {
      expect(result.dispatches).toHaveLength(1);
      expect(result.dispatches[0]!.params.sessionId).toBe("sess");
      expect(result.dispatches[0]!.type).toBe("answer");
    }
  });

  it("Enter is an alias of Esc for save", () => {
    const groups = toGroups([q({ id: "a", options: ["yes", "no"] })]);
    const r1 = handleQuestionsKey(
      key("enter"), true, groups, [1], [true], falses(1), 0, "s",
    );
    const r2 = handleQuestionsKey(
      key("escape"), true, groups, [1], [true], falses(1), 0, "s",
    );
    expect(r1).toEqual(r2);
  });

  it("^Q also saves", () => {
    const groups = toGroups([q({ id: "a" })]);
    expect(
      handleQuestionsKey(
        key("ctrl-q"), true, groups, [0], falses(1), falses(1), 0, "s",
      ).type,
    ).toBe("save");
  });

  it("save with no touched rows emits empty dispatches", () => {
    const groups = toGroups([q({ id: "a", options: ["x", "y"] })]);
    const result = handleQuestionsKey(
      key("escape"), true, groups, [1], falses(1), falses(1), 0, "s",
    );
    if (result.type === "save") {
      expect(result.dispatches).toEqual([]);
    } else {
      throw new Error("expected save");
    }
  });

  it("save fans dismiss action out across deduped group", () => {
    const groups = toGroups([
      q({ id: "x1", question: "Q?" }),
      q({ id: "x2", question: "Q?" }),
    ]);
    const result = handleQuestionsKey(
      key("escape"), true, groups, [0], trues(1), trues(1), 0, "s",
    );
    if (result.type === "save") {
      expect(result.dispatches).toHaveLength(2);
      expect(result.dispatches.every((a) => a.type === "dismiss")).toBe(true);
    } else {
      throw new Error("expected save");
    }
  });

  it("^C discards", () => {
    const groups = toGroups([q({ id: "a" })]);
    expect(
      handleQuestionsKey(
        key("ctrl-c"), true, groups, [0], falses(1), falses(1), 0, "s",
      ),
    ).toEqual({ type: "discard" });
  });
});

describe("handleQuestionsKey — guards", () => {
  it("returns noop when modal not active", () => {
    expect(
      handleQuestionsKey(
        key("escape"), false, toGroups([q()]), [0], falses(1), falses(1), 0, "s",
      ),
    ).toEqual({ type: "noop" });
  });

  it("returns noop when groups is null", () => {
    expect(
      handleQuestionsKey(key("escape"), true, null, [], [], [], 0, "s"),
    ).toEqual({ type: "noop" });
  });

  it("returns noop when no groups", () => {
    expect(
      handleQuestionsKey(key("escape"), true, [], [], [], [], 0, "s"),
    ).toEqual({ type: "noop" });
  });
});
