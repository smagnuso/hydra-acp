import { describe, expect, it } from "vitest";
import type { InputDispatcher, KeyEvent, KeyName } from "./input.js";
import { LineEditor } from "./line-editor.js";
import {
  applyLineEditorKey,
  handleFormClick,
  handleFormKey,
  textForm,
  toFormSpec,
  type FormRow,
  type FormState,
} from "./modal-form.js";
import {
  Screen,
  clampFormWindow,
  formWindowStart,
  layoutFormHints,
  layoutFormRows,
  windowTextField,
  type FormHintSpec,
  type FormPromptSpec,
} from "./screen.js";
import { makeCaptureTerm } from "./bar/test-harness.js";

const key = (name: KeyName): KeyEvent => ({ type: "key", name });
const ch = (c: string): KeyEvent => ({ type: "char", ch: c });

function selects(...values: string[]): FormRow[] {
  return values.map((v, i) => ({
    id: `r${i}`,
    kind: "select",
    label: `Row ${i}`,
    value: v,
  }));
}

function choices(n: number, currentIdx = 0): FormRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `v${i}`,
    kind: "choice" as const,
    label: `value-${i}`,
    ...(i === currentIdx ? { current: true } : {}),
  }));
}

function form(rows: FormRow[], cursor = 0): FormState {
  return { title: "T", rows, cursor, hints: HINTS };
}

const HINTS: FormHintSpec[] = [
  { label: "↑/↓ row" },
  { label: "⏎ go", action: "commit" },
  { label: "s save", action: "save" },
  { label: "Esc close", action: "close" },
];

describe("handleFormKey navigation", () => {
  it("wraps row movement in both directions", () => {
    const f = form(selects("a", "b", "c"));
    expect(handleFormKey(f, key("down"))).toEqual({ type: "row", row: 1 });
    expect(handleFormKey({ ...f, cursor: 2 }, key("down"))).toEqual({
      type: "row",
      row: 0,
    });
    expect(handleFormKey(f, key("up"))).toEqual({ type: "row", row: 2 });
  });

  it("jumps on 1-9 and flags the digit so ^O can also step the value", () => {
    const f = form(selects("a", "b", "c"));
    expect(handleFormKey(f, ch("3"))).toEqual({
      type: "row",
      row: 2,
      viaDigit: true,
    });
    // Past the end of the list is a no-op, not a clamp to the last row.
    expect(handleFormKey(f, ch("7"))).toEqual({ type: "noop" });
  });

  it("sends Home/End to the ends, for lists too long to arrow through", () => {
    const f = form(choices(40), 20);
    expect(handleFormKey(f, key("home"))).toEqual({ type: "row", row: 0 });
    expect(handleFormKey(f, key("end"))).toEqual({ type: "row", row: 39 });
  });

  it("clamps a stale cursor rather than throwing", () => {
    const f = form(selects("a"), 9);
    expect(handleFormKey(f, key("enter"))).toEqual({ type: "advance", row: 0 });
  });

  it("reports nothing for an empty form", () => {
    expect(handleFormKey(form([]), key("enter"))).toEqual({ type: "noop" });
  });
});

describe("handleFormKey by row kind", () => {
  it("cycles select rows with ←/→ and advances on Enter", () => {
    const f = form(selects("a", "b"), 1);
    expect(handleFormKey(f, key("right"))).toEqual({
      type: "cycle",
      row: 1,
      delta: 1,
    });
    expect(handleFormKey(f, key("left"))).toEqual({
      type: "cycle",
      row: 1,
      delta: -1,
    });
    expect(handleFormKey(f, key("enter"))).toEqual({ type: "advance", row: 1 });
  });

  it("commits a choice row on Enter and ignores ←/→ there", () => {
    const f = form(choices(3), 2);
    expect(handleFormKey(f, key("enter"))).toEqual({ type: "commit", row: 2 });
    expect(handleFormKey(f, key("right"))).toEqual({ type: "noop" });
  });

  it("routes s and d as row hotkeys on non-text rows", () => {
    const f = form(selects("a", "b"), 1);
    expect(handleFormKey(f, ch("s"))).toEqual({ type: "save", row: 1 });
    expect(handleFormKey(f, ch("d"))).toEqual({ type: "dismiss", row: 1 });
  });

  it("Esc closes and ^C cancels, on every kind", () => {
    for (const rows of [selects("a"), choices(2), textForm(seed()).rows]) {
      const f = form(rows);
      expect(handleFormKey(f, key("escape"))).toEqual({ type: "close" });
      expect(handleFormKey(f, key("ctrl-c"))).toEqual({ type: "cancel" });
    }
  });

  it("treats a text row's keys as editing, including s/d and digits", () => {
    const f = textForm(seed("ab"));
    const editor = (f.rows[0] as { editor: LineEditor }).editor;
    expect(handleFormKey(f, ch("s"))).toEqual({ type: "edited", row: 0 });
    expect(handleFormKey(f, ch("7"))).toEqual({ type: "edited", row: 0 });
    expect(editor.text).toBe("abs7");
    // ←/→ move the caret rather than cycling a value.
    expect(handleFormKey(f, key("left"))).toEqual({ type: "edited", row: 0 });
    expect(editor.cursor).toBe(3);
    // ↑/↓ still belong to the form, so a mixed form stays navigable.
    expect(handleFormKey(f, key("down"))).toEqual({ type: "row", row: 0 });
    expect(handleFormKey(f, key("enter"))).toEqual({ type: "commit", row: 0 });
  });

  it("leaves ^D to the caller so detach still works mid-edit", () => {
    const f = textForm(seed("x"));
    expect(handleFormKey(f, key("ctrl-d"))).toEqual({ type: "noop" });
  });
});

function seed(initial = ""): Parameters<typeof textForm>[0] {
  return { title: "Rename", id: "title", label: "title:", initial, hints: HINTS };
}

describe("applyLineEditorKey", () => {
  it("inserts characters and runs the readline set", () => {
    const ed = new LineEditor("foo bar");
    expect(applyLineEditorKey(ed, ch("!"))).toBe(true);
    expect(ed.text).toBe("foo bar!");
    expect(applyLineEditorKey(ed, key("ctrl-w"))).toBe(true);
    expect(ed.text).toBe("foo ");
    expect(applyLineEditorKey(ed, key("ctrl-a"))).toBe(true);
    expect(ed.cursor).toBe(0);
  });

  it("flattens a pasted newline into a space", () => {
    const ed = new LineEditor("");
    expect(applyLineEditorKey(ed, { type: "paste", text: "one\ntwo" })).toBe(true);
    expect(ed.text).toBe("one two");
  });

  it("declines the keys the form owns", () => {
    const ed = new LineEditor("x");
    for (const name of ["enter", "escape", "ctrl-c", "ctrl-d"] as KeyName[]) {
      expect(applyLineEditorKey(ed, key(name))).toBe(false);
    }
    expect(ed.text).toBe("x");
  });
});

describe("handleFormClick", () => {
  it("activates a select row: land on it, then step its value", () => {
    const f = form(selects("a", "b", "c"));
    expect(handleFormClick(f, { kind: "row", row: 2 })).toEqual([
      { type: "row", row: 2 },
      { type: "cycle", row: 2, delta: 1 },
    ]);
  });

  it("commits a choice row outright, the way the picker's list does", () => {
    const f = form(choices(4));
    expect(handleFormClick(f, { kind: "row", row: 3 })).toEqual([
      { type: "commit", row: 3 },
    ]);
  });

  it("only moves the cursor when the gesture was a wheel notch", () => {
    const f = form(choices(4));
    expect(handleFormClick(f, { kind: "row", row: 3, select: true })).toEqual([
      { type: "row", row: 3 },
    ]);
  });

  it("lands the caret where a text row was clicked", () => {
    const f = textForm(seed("hello world"));
    const editor = (f.rows[0] as { editor: LineEditor }).editor;
    expect(handleFormClick(f, { kind: "row", row: 0, caretOffset: 4 })).toEqual([
      { type: "row", row: 0 },
      { type: "edited", row: 0 },
    ]);
    expect(editor.cursor).toBe(4);
    // A click on the row's label, which carries no offset, just selects it.
    expect(handleFormClick(f, { kind: "row", row: 0 })).toEqual([
      { type: "row", row: 0 },
    ]);
    expect(editor.cursor).toBe(4);
  });

  it("maps hint words onto the same results their keys produce", () => {
    const sel = form(selects("a", "b"), 1);
    expect(handleFormClick(sel, { kind: "hint", action: "commit" })).toEqual([
      { type: "advance", row: 1 },
    ]);
    const cho = form(choices(3), 2);
    expect(handleFormClick(cho, { kind: "hint", action: "commit" })).toEqual([
      { type: "commit", row: 2 },
    ]);
    expect(handleFormClick(cho, { kind: "hint", action: "close" })).toEqual([
      { type: "close" },
    ]);
    expect(handleFormClick(cho, { kind: "hint", action: "cancel" })).toEqual([
      { type: "cancel" },
    ]);
    expect(handleFormClick(cho, { kind: "hint", action: "save" })).toEqual([
      { type: "save", row: 2 },
    ]);
    expect(handleFormClick(cho, { kind: "hint", action: "dismiss" })).toEqual([
      { type: "dismiss", row: 2 },
    ]);
  });

  it("ignores a click on a row that no longer exists", () => {
    expect(handleFormClick(form(choices(2)), { kind: "row", row: 9 })).toEqual([]);
  });
});

describe("clampFormWindow", () => {
  // 40 rows, a 10-row window sitting at 5 (showing 5..14).
  const at5 = (selected: number): number =>
    clampFormWindow(5, 40, selected, 10);

  it("holds still for any row already in view", () => {
    // This is the hover case: the pointer can only be over a painted row,
    // so selecting one must never move the list.
    for (const row of [5, 9, 14]) {
      expect(at5(row)).toBe(5);
    }
  });

  it("scrolls by the minimum when the selection leaves the window", () => {
    expect(at5(15)).toBe(6);
    expect(at5(4)).toBe(4);
    // A jump (Home/End, a digit) brings the window with it.
    expect(at5(39)).toBe(30);
    expect(at5(0)).toBe(0);
  });

  it("never scrolls past either end", () => {
    expect(clampFormWindow(999, 40, 39, 10)).toBe(30);
    expect(clampFormWindow(-5, 40, 0, 10)).toBe(0);
  });

  it("pins to zero when everything fits", () => {
    expect(clampFormWindow(3, 6, 5, 10)).toBe(0);
  });
});

describe("layoutFormHints", () => {
  it("joins segments and reports 1-based spans for the clickable ones", () => {
    const { text, spans } = layoutFormHints(
      [
        { label: "↑/↓ row" },
        { label: "⏎ next", action: "commit" },
        { label: "Esc close", action: "close" },
      ],
      80,
    );
    expect(text).toBe("↑/↓ row · ⏎ next · Esc close");
    // The row is painted with one leading space, so column 1 is that space
    // and "↑/↓ row" starts at 2.
    expect(spans).toEqual([
      { start: 12, end: 17, action: "commit" },
      { start: 21, end: 29, action: "close" },
    ]);
    // Spans line up with where the text actually lands on screen.
    const painted = ` ${text}`;
    expect(painted.slice(11, 17)).toBe("⏎ next");
    expect(painted.slice(20, 29)).toBe("Esc close");
  });

  it("drops segments that would not fit rather than half-painting them", () => {
    const { text, spans } = layoutFormHints(
      [
        { label: "⏎ go", action: "commit" },
        { label: "Esc close", action: "close" },
      ],
      10,
    );
    expect(text).toBe("⏎ go");
    expect(spans).toEqual([{ start: 2, end: 5, action: "commit" }]);
  });
});

describe("toFormSpec", () => {
  it("reads text rows through their editor and drops absent fields", () => {
    const f = textForm(seed("hello"));
    expect(toFormSpec(f)).toEqual({
      title: "Rename",
      rows: [{ kind: "text", label: "title:", text: "hello", cursor: 5 }],
      selectedIndex: 0,
      hints: HINTS,
    });
  });

  it("carries note and current only when set", () => {
    const rows: FormRow[] = [
      { id: "a", kind: "choice", label: "Alpha", note: "a", current: true },
      { id: "b", kind: "choice", label: "Beta" },
    ];
    expect(toFormSpec(form(rows)).rows).toEqual([
      { kind: "choice", label: "Alpha", note: "a", current: true },
      { kind: "choice", label: "Beta" },
    ]);
  });
});

describe("formWindowStart", () => {
  it("stays at 0 while everything fits", () => {
    expect(formWindowStart(5, 4, 10)).toBe(0);
  });

  it("centres the cursor once the list overflows", () => {
    expect(formWindowStart(50, 25, 11)).toBe(20);
  });

  it("pins to the ends rather than scrolling past them", () => {
    expect(formWindowStart(50, 0, 11)).toBe(0);
    expect(formWindowStart(50, 1, 11)).toBe(0);
    expect(formWindowStart(50, 49, 11)).toBe(39);
    expect(formWindowStart(50, 45, 11)).toBe(39);
  });
});

describe("windowTextField", () => {
  it("returns the whole field with room for the caret past the end", () => {
    expect(windowTextField("abc", 3, 10)).toEqual({
      field: "abc",
      caretOffset: 3,
      fieldStart: 0,
    });
  });

  it("scrolls under the caret once the text outgrows the room", () => {
    const text = "0123456789abcdefghij";
    expect(windowTextField(text, text.length, 6)).toEqual({
      field: "fghij",
      caretOffset: 5,
      // The field scrolled, so a click at its first column is text[15].
      fieldStart: 15,
    });
    expect(windowTextField(text, 0, 6)).toEqual({
      field: "012345",
      caretOffset: 0,
      fieldStart: 0,
    });
  });

  it("measures in cells, not code units", () => {
    expect(windowTextField("日本語", 3, 20).caretOffset).toBe(6);
  });

  it("yields nothing when there is no room at all", () => {
    expect(windowTextField("abc", 1, 0)).toEqual({
      field: "",
      caretOffset: 0,
      fieldStart: 0,
    });
  });
});

describe("layoutFormRows", () => {
  const spec = (rows: FormPromptSpec["rows"], selectedIndex = 0): FormPromptSpec => ({
    title: "T",
    rows,
    selectedIndex,
    hints: HINTS,
  });

  it("marks the cursor row and aligns values past the widest label", () => {
    const rows = layoutFormRows(
      spec(
        [
          { kind: "select", label: "Tools", value: "expanded" },
          { kind: "select", label: "File updates", value: "diff" },
        ],
        1,
      ),
      60,
      0,
      10,
    );
    // Unselected rows pay for the cursor column so the numbers line up.
    expect(rows[0]!.body).toBe("   1. Tools         expanded");
    expect(rows[1]!.body).toBe(" ❯ 2. File updates  diff");
    expect(rows[1]!.selected).toBe(true);
  });

  it("dots the current choice, independent of the cursor", () => {
    const rows = layoutFormRows(
      spec(
        [
          { kind: "choice", label: "opus", note: "claude-opus-5", current: true },
          { kind: "choice", label: "sonnet" },
        ],
        1,
      ),
      60,
      0,
      10,
    );
    expect(rows[0]!.body).toContain("• opus");
    expect(rows[1]!.body).toContain("  sonnet");
  });

  it("numbers rows by absolute index so a scrolled window stays honest", () => {
    const rows = layoutFormRows(
      spec(choices(30).map((r) => ({ kind: "choice" as const, label: r.label })), 20),
      60,
      15,
      5,
    );
    expect(rows).toHaveLength(5);
    // The dot column is reserved on non-current rows, so labels align.
    expect(rows[0]!.body).toBe("   16.   value-15");
    expect(rows[0]!.index).toBe(15);
  });

  it("drops numbering for a lone row", () => {
    const rows = layoutFormRows(
      spec([{ kind: "text", label: "title:", text: "hi", cursor: 2 }]),
      60,
      0,
      10,
    );
    expect(rows[0]!.prefix).toBe(" ❯ title: ");
    expect(rows[0]!.field).toBe("hi");
    expect(rows[0]!.caretCol).toBe(13);
  });
});

describe("Screen form prompt", () => {
  function render(
    spec: FormPromptSpec,
    height = 24,
  ): { screen: Screen; row(n: number): string; promptRows: number } {
    const cap = makeCaptureTerm(80, height);
    const dispatcher = {
      state: () => ({
        buffer: [""],
        row: 0,
        col: 0,
        planMode: false,
        historyIndex: 0,
        queueIndex: 0,
        attachments: [],
        historySearchQuery: null,
      }),
    } as unknown as InputDispatcher;
    const screen = new Screen({
      term: cap.term,
      dispatcher,
      onKey: () => {},
      repaintThrottleMs: 0,
      progressIndicator: false,
      mouse: false,
    });
    const priv = screen as unknown as {
      started: boolean;
      promptRows(): number;
      drawPrompt(): void;
      painter: { clearCache(): void };
    };
    priv.started = true;
    screen.setFormPrompt(spec);
    cap.reset();
    priv.painter.clearCache();
    priv.drawPrompt();
    return { screen, row: (n) => cap.row(n), promptRows: priv.promptRows() };
  }

  it("paints a one-row text form as title, field and hint", () => {
    const r = render({
      title: "Rename session",
      rows: [{ kind: "text", label: "title:", text: "new name", cursor: 8 }],
      selectedIndex: 0,
      hints: [
        { label: "⏎ save", action: "commit" },
        { label: "Esc cancel", action: "close" },
      ],
    });
    expect(r.promptRows).toBe(3);
    // The bottom rule and the sessionbar sit below the modal.
    expect(r.row(20).trimEnd()).toBe(" ⚙ Rename session");
    expect(r.row(21).trimEnd()).toBe(" ❯ title: new name");
    expect(r.row(22).trimEnd()).toBe(" ⏎ save · Esc cancel");
  });

  it("scrolls a long chooser and counts position in the title", () => {
    const rows: FormPromptSpec["rows"] = Array.from({ length: 40 }, (_, i) => ({
      kind: "choice",
      label: `model-${i}`,
    }));
    const r = render({
      title: "Model",
      rows,
      selectedIndex: 30,
      hints: HINTS,
      maxRows: 8,
    });
    // title + 6 rows + hint
    expect(r.promptRows).toBe(8);
    // Squashed: the dot and label columns pad, which isn't what's under test.
    const squashed = (n: number): string => r.row(n).replace(/\s+/g, " ").trim();
    expect(squashed(15)).toContain("⚙ Model (31/40)");
    // Window of 6 centred on index 30 → 28..33, not truncated at the tenth.
    expect(squashed(16)).toBe("29. model-28");
    expect(squashed(18)).toBe("❯ 31. model-30");
    expect(squashed(21)).toBe("34. model-33");
  });

  it("reserves rows for the list rather than overflowing the screen", () => {
    const rows: FormPromptSpec["rows"] = Array.from({ length: 3 }, (_, i) => ({
      kind: "select",
      label: `r${i}`,
      value: "v",
    }));
    const r = render({ title: "T", rows, selectedIndex: 0, hints: HINTS });
    expect(r.promptRows).toBe(5);
  });

  it("hit-tests rows, hint words and the field, and claims its own region", () => {
    const rows: FormPromptSpec["rows"] = [
      { kind: "select", label: "Tools", value: "collapsed" },
      { kind: "select", label: "Theme", value: "matrix" },
    ];
    const r = render({
      title: "Session options",
      rows,
      selectedIndex: 0,
      hints: [
        { label: "↑/↓ row" },
        { label: "⏎ next", action: "commit" },
        { label: "Esc close", action: "close" },
      ],
    });
    // At height 24 with two rows: 19 title, 20-21 rows, 22 hint.
    expect(r.screen.isFormCell(18)).toBe(false);
    expect(r.screen.isFormCell(19)).toBe(true);
    expect(r.screen.isFormCell(22)).toBe(true);
    expect(r.screen.isFormCell(23)).toBe(false);
    // The title row is inside the region but not a target.
    expect(r.screen.formHitAt(3, 19)).toBe(null);
    expect(r.screen.formHitAt(6, 20)).toEqual({ kind: "row", row: 0 });
    expect(r.screen.formHitAt(6, 21)).toEqual({ kind: "row", row: 1 });
    // The inert legend is not clickable; the two action words are.
    const hintRow = r.row(22);
    expect(r.screen.formHitAt(hintRow.indexOf("↑/↓") + 1, 22)).toBe(null);
    expect(r.screen.formHitAt(hintRow.indexOf("⏎ next") + 1, 22)).toEqual({
      kind: "hint",
      action: "commit",
    });
    expect(r.screen.formHitAt(hintRow.indexOf("Esc close") + 2, 22)).toEqual({
      kind: "hint",
      action: "close",
    });
  });

  it("resolves a click inside a scrolled text field to a text offset", () => {
    const text = "0123456789abcdefghij";
    const r = render({
      title: "Rename session",
      rows: [{ kind: "text", label: "t:", text, cursor: text.length }],
      selectedIndex: 0,
      hints: [],
    });
    const row = r.row(21);
    // " ❯ t: " is 6 columns, so the field starts at column 7 and, with the
    // whole value fitting in 80 columns, column 7 is text[0].
    expect(row).toContain(" ❯ t: 0123456789abcdefghij");
    expect(r.screen.formHitAt(7, 21)).toEqual({
      kind: "row",
      row: 0,
      caretOffset: 0,
    });
    expect(r.screen.formHitAt(12, 21)).toEqual({
      kind: "row",
      row: 0,
      caretOffset: 5,
    });
    // A click on the label selects the row without moving the caret.
    expect(r.screen.formHitAt(2, 21)).toEqual({ kind: "row", row: 0 });
  });
});
