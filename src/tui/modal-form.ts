// The shared state machine behind every modal that takes over the prompt
// area: ^O session options, the ^Q clarifier questions list, the title
// rename field, and the config-option choosers (model / mode / agent).
//
// Each of those used to own its own copy of "wrap the cursor on ↑/↓, jump
// on 1-9, cycle on ←/→, Esc closes and ^C discards". This module owns that
// vocabulary once and reports what happened; callers keep their domain
// logic (what a row means, what committing it does) and apply the result.
//
// Three row kinds cover every case:
//
//   select  a label with a cycling value. ←/→ steps the caller's ring,
//           Enter advances to the next row (^O and ^Q semantics).
//   choice  the row IS a value; Enter commits that one and the caller
//           closes. What a chooser (a model list) is made of.
//   text    an editable field backed by a LineEditor. Enter commits.
//
// Purity: everything is reported for the caller to apply, EXCEPT a text
// row's LineEditor, which is mutated in place: the editor is a mutable
// object the caller owns and hands in, and copying its undo stack per
// keystroke would be silly.

import type { KeyEvent, KeyName } from "./input.js";
import { LineEditor } from "./line-editor.js";
import type {
  FormClickTarget,
  FormHintAction,
  FormHintSpec,
  FormPromptSpec,
  FormRowSpec,
} from "./screen.js";

export type FormRow =
  | { id: string; kind: "select"; label: string; value: string }
  | {
      id: string;
      kind: "choice";
      label: string;
      // Trailing detail: the raw value behind a display name, a model's
      // provider, a config option's current setting.
      note?: string;
      // Marks the row that reflects the live setting, so a chooser can say
      // "this is what you're on" independently of where the cursor is.
      current?: boolean;
    }
  | { id: string; kind: "text"; label: string; editor: LineEditor };

export interface FormState {
  title: string;
  rows: FormRow[];
  // Index into `rows`. Callers may hand in a stale value (the row set can
  // shrink under them); every read clamps.
  cursor: number;
  // Footer segments. The ones carrying an action are click targets, so this
  // is a list rather than a string: the alternative is sniffing prose for
  // the word "Esc", which breaks the first time someone rewords a hint.
  hints: FormHintSpec[];
  // Total terminal rows the modal may occupy, title and hint included.
  // Undefined lets the renderer pick its default.
  maxRows?: number;
}

export type FormKeyResult =
  | { type: "noop" }
  // `viaDigit` distinguishes a 1-9 jump from an arrow move, which ^O needs:
  // there a digit both selects the row and steps its value.
  | { type: "row"; row: number; viaDigit?: boolean }
  | { type: "cycle"; row: number; delta: 1 | -1 }
  | { type: "edited"; row: number }
  // Enter on a choice or text row: the caller acts and usually closes.
  | { type: "commit"; row: number }
  // Enter on a select row: ^O's "step this row's value and move on".
  | { type: "advance"; row: number }
  | { type: "save"; row: number }
  | { type: "dismiss"; row: number }
  | { type: "close" }
  | { type: "cancel" };

// KeyName → the terminal-kit key names LineEditor.handleKey speaks.
// Enter / Escape / ^C are absent deliberately: they belong to the form, not
// to the field, so a text row can't swallow them. ^D is absent too, so it
// reaches the caller rather than exiting the TUI out from under a
// half-typed value.
const LINE_EDITOR_KEY_NAMES: Partial<Record<KeyName, string>> = {
  left: "LEFT",
  right: "RIGHT",
  home: "HOME",
  end: "END",
  backspace: "BACKSPACE",
  delete: "DELETE",
  "alt-backspace": "ALT_BACKSPACE",
  "alt-b": "ALT_B",
  "alt-f": "ALT_F",
  "ctrl-a": "CTRL_A",
  "ctrl-b": "CTRL_B",
  "ctrl-e": "CTRL_E",
  "ctrl-f": "CTRL_F",
  "ctrl-k": "CTRL_K",
  "ctrl-u": "CTRL_U",
  "ctrl-w": "CTRL_W",
  "ctrl-y": "CTRL_Y",
  "ctrl-underscore": "\x1f",
  "alt-underscore": "\x1b_",
};

// Apply one KeyEvent to a single-line editor. Returns whether the editor
// consumed it. Exported for the rare caller that drives a bare LineEditor.
export function applyLineEditorKey(editor: LineEditor, ev: KeyEvent): boolean {
  if (ev.type === "char") {
    editor.insertText(ev.ch);
    return true;
  }
  if (ev.type === "paste") {
    // Flattened: these are one-line fields, and a newline in one has
    // nowhere to render.
    editor.insertText(ev.text.replace(/[\r\n\t]+/g, " "));
    return true;
  }
  if (ev.type !== "key") {
    return false;
  }
  const mapped = LINE_EDITOR_KEY_NAMES[ev.name];
  return mapped !== undefined && editor.handleKey(mapped, false);
}

export function clampCursor(state: FormState): number {
  return Math.max(0, Math.min(state.cursor, state.rows.length - 1));
}

// Process one key against a form. Owner-specific hotkeys (^O closing the
// options modal, ^Q saving the questions modal) are the caller's to
// intercept BEFORE this runs; everything reaching here is form vocabulary.
export function handleFormKey(state: FormState, ev: KeyEvent): FormKeyResult {
  const rows = state.rows;
  if (rows.length === 0) {
    return { type: "noop" };
  }
  const cursor = clampCursor(state);
  const row = rows[cursor]!;
  const wrap = (next: number): number => (next + rows.length) % rows.length;
  // Form-level keys first: they mean the same thing on every row kind, and
  // a text row must not read Enter or Esc as literal input.
  if (ev.type === "key") {
    switch (ev.name) {
      case "enter":
        return row.kind === "select"
          ? { type: "advance", row: cursor }
          : { type: "commit", row: cursor };
      case "escape":
        return { type: "close" };
      case "ctrl-c":
        return { type: "cancel" };
      case "up":
        return { type: "row", row: wrap(cursor - 1) };
      case "down":
        return { type: "row", row: wrap(cursor + 1) };
      default:
        break;
    }
  }
  if (row.kind === "text") {
    // Everything else is editing. Note this claims digits and `s`/`d`,
    // which are row hotkeys on the other kinds. On a field they're just
    // characters, which is what the user typing them means.
    return applyLineEditorKey(row.editor, ev)
      ? { type: "edited", row: cursor }
      : { type: "noop" };
  }
  if (ev.type === "char") {
    if (/^[1-9]$/.test(ev.ch)) {
      const idx = Number.parseInt(ev.ch, 10) - 1;
      return idx < rows.length
        ? { type: "row", row: idx, viaDigit: true }
        : { type: "noop" };
    }
    if (ev.ch === "s" || ev.ch === "S") {
      return { type: "save", row: cursor };
    }
    if (ev.ch === "d" || ev.ch === "D") {
      return { type: "dismiss", row: cursor };
    }
    return { type: "noop" };
  }
  if (ev.type !== "key") {
    return { type: "noop" };
  }
  switch (ev.name) {
    case "left":
      return row.kind === "select"
        ? { type: "cycle", row: cursor, delta: -1 }
        : { type: "noop" };
    case "right":
      return row.kind === "select"
        ? { type: "cycle", row: cursor, delta: 1 }
        : { type: "noop" };
    // Cheap long-list navigation: with a 50-model chooser, ↑/↓ and the
    // 1-9 jumps only reach so far.
    case "home":
      return { type: "row", row: 0 };
    case "end":
      return { type: "row", row: rows.length - 1 };
    default:
      return { type: "noop" };
  }
}

// Project a form onto the render spec. Text rows read their editor here,
// which is why the screen never sees a LineEditor.
export function toFormSpec(state: FormState): FormPromptSpec {
  const rows: FormRowSpec[] = state.rows.map((r) => {
    if (r.kind === "text") {
      return {
        kind: "text",
        label: r.label,
        text: r.editor.text,
        cursor: r.editor.cursor,
      };
    }
    if (r.kind === "choice") {
      return {
        kind: "choice",
        label: r.label,
        ...(r.note !== undefined ? { note: r.note } : {}),
        ...(r.current === true ? { current: true } : {}),
      };
    }
    return { kind: "select", label: r.label, value: r.value };
  });
  return {
    title: state.title,
    rows,
    selectedIndex: clampCursor(state),
    hints: state.hints,
    ...(state.maxRows !== undefined ? { maxRows: state.maxRows } : {}),
  };
}

// Translate a mouse gesture into the same result vocabulary a keypress
// produces, so the caller has exactly one place that applies form outcomes.
//
// Clicking a row ACTIVATES it, which means something different per kind:
// stepping a select row's value (what a 1-9 jump does on ^O), committing a
// choice row (what Enter does, and what clicking a row in the session
// picker has always done), or landing the caret in a text field. A wheel
// notch arrives with `select` and only moves the cursor.
export function handleFormClick(
  state: FormState,
  target: FormClickTarget,
): FormKeyResult[] {
  if (target.kind === "hint") {
    return [hintResult(state, target.action)];
  }
  const row = state.rows[target.row];
  if (row === undefined) {
    return [];
  }
  const move: FormKeyResult = { type: "row", row: target.row };
  if (target.select === true) {
    return [move];
  }
  if (row.kind === "text") {
    if (target.caretOffset === undefined) {
      return [move];
    }
    row.editor.setCursor(target.caretOffset);
    return [move, { type: "edited", row: target.row }];
  }
  if (row.kind === "choice") {
    return [{ type: "commit", row: target.row }];
  }
  // Land on the row first: a hint or a later result acting on "the selected
  // row" has to see the row the user actually clicked.
  return [move, { type: "cycle", row: target.row, delta: 1 }];
}

function hintResult(state: FormState, action: FormHintAction): FormKeyResult {
  const cursor = clampCursor(state);
  switch (action) {
    case "commit":
      return state.rows[cursor]?.kind === "select"
        ? { type: "advance", row: cursor }
        : { type: "commit", row: cursor };
    case "close":
      return { type: "close" };
    case "cancel":
      return { type: "cancel" };
    case "save":
      return { type: "save", row: cursor };
    case "dismiss":
      return { type: "dismiss", row: cursor };
  }
}

// Convenience for the one-field forms (title rename): a single text row
// seeded from `initial`.
export function textForm(opts: {
  title: string;
  id: string;
  label: string;
  initial: string;
  hints: FormHintSpec[];
}): FormState {
  return {
    title: opts.title,
    rows: [
      {
        id: opts.id,
        kind: "text",
        label: opts.label,
        editor: new LineEditor(opts.initial),
      },
    ],
    cursor: 0,
    hints: opts.hints,
  };
}
