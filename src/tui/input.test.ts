import { describe, expect, it } from "vitest";
import {
  InputDispatcher,
  type InputEffect,
  type KeyEvent,
  type KeyName,
} from "./input.js";

function feed(d: InputDispatcher, events: KeyEvent[]): InputEffect[] {
  const out: InputEffect[] = [];
  for (const e of events) {
    out.push(...d.feed(e));
  }
  return out;
}

function ch(s: string): KeyEvent {
  return { type: "char", ch: s };
}

function k(name: KeyName): KeyEvent {
  return { type: "key", name };
}

describe("InputDispatcher", () => {
  it("inserts characters and tracks cursor", () => {
    const d = new InputDispatcher();
    feed(d, [ch("h"), ch("i")]);
    const s = d.state();
    expect(s.buffer).toEqual(["hi"]);
    expect(s.row).toBe(0);
    expect(s.col).toBe(2);
  });

  it("Enter on non-empty buffer emits send + clears", () => {
    const d = new InputDispatcher();
    feed(d, [ch("h"), ch("i")]);
    const effects = feed(d, [k("enter")]);
    expect(effects).toEqual([{ type: "send", text: "hi", planMode: false }]);
    expect(d.state().buffer).toEqual([""]);
  });

  it("Enter on empty buffer is a no-op", () => {
    const d = new InputDispatcher();
    expect(feed(d, [k("enter")])).toEqual([]);
  });

  it("Alt+Enter inserts a newline mid-buffer; Enter sends multi-line", () => {
    const d = new InputDispatcher();
    feed(d, [ch("a"), k("alt-enter"), ch("b")]);
    expect(d.state().buffer).toEqual(["a", "b"]);
    const out = feed(d, [k("enter")]);
    expect(out).toEqual([{ type: "send", text: "a\nb", planMode: false }]);
  });

  it("Shift-Tab toggles plan mode and emits redraw", () => {
    const d = new InputDispatcher();
    expect(feed(d, [k("shift-tab")])).toEqual([
      { type: "plan-toggle", on: true },
      { type: "redraw-banner" },
    ]);
    expect(d.state().planMode).toBe(true);
    expect(feed(d, [k("shift-tab")])).toEqual([
      { type: "plan-toggle", on: false },
      { type: "redraw-banner" },
    ]);
  });

  it("Ctrl+P emits switch-session", () => {
    const d = new InputDispatcher();
    expect(feed(d, [k("ctrl-p")])).toEqual([{ type: "switch-session" }]);
  });

  it("Enter while plan mode on sends with planMode: true", () => {
    const d = new InputDispatcher({ planMode: true });
    feed(d, [ch("x")]);
    expect(feed(d, [k("enter")])).toEqual([
      { type: "send", text: "x", planMode: true },
    ]);
  });

  it("Up at row 0 walks back through history", () => {
    const d = new InputDispatcher({ history: ["one", "two"] });
    feed(d, [k("up")]);
    expect(d.state().buffer).toEqual(["two"]);
    feed(d, [k("up")]);
    expect(d.state().buffer).toEqual(["one"]);
    // Already at oldest — further Up is a no-op
    feed(d, [k("up")]);
    expect(d.state().buffer).toEqual(["one"]);
  });

  it("Down past newest restores the in-progress draft", () => {
    const d = new InputDispatcher({ history: ["old"] });
    feed(d, [ch("d"), ch("r"), ch("a"), ch("f"), ch("t")]);
    feed(d, [k("up")]);
    expect(d.state().buffer).toEqual(["old"]);
    feed(d, [k("down")]);
    expect(d.state().buffer).toEqual(["draft"]);
  });

  it("multi-line history entry round-trips", () => {
    const d = new InputDispatcher({ history: ["line1\nline2"] });
    feed(d, [k("up")]);
    expect(d.state().buffer).toEqual(["line1", "line2"]);
    expect(d.state().row).toBe(1);
  });

  it("Up moves cursor within multi-line buffer before walking history", () => {
    const d = new InputDispatcher();
    feed(d, [ch("a"), k("alt-enter"), ch("b")]);
    expect(d.state().row).toBe(1);
    feed(d, [k("up")]);
    expect(d.state().row).toBe(0);
    // History has zero entries, so further Up is a no-op
    feed(d, [k("up")]);
    expect(d.state().row).toBe(0);
  });

  it("Ctrl+C with empty buffer (no turn) exits", () => {
    const d = new InputDispatcher();
    expect(feed(d, [k("ctrl-c")])).toEqual([{ type: "exit" }]);
  });

  it("Ctrl+C with text clears buffer (no exit)", () => {
    const d = new InputDispatcher();
    feed(d, [ch("h"), ch("i")]);
    expect(feed(d, [k("ctrl-c")])).toEqual([]);
    expect(d.state().buffer).toEqual([""]);
  });

  it("Ctrl+C while turn running with empty buffer emits cancel", () => {
    const d = new InputDispatcher();
    d.setTurnRunning(true);
    expect(feed(d, [k("ctrl-c")])).toEqual([{ type: "cancel" }]);
  });

  it("Ctrl+C with text clears buffer even while turn running (no cancel)", () => {
    const d = new InputDispatcher();
    d.setTurnRunning(true);
    feed(d, [ch("h"), ch("i")]);
    expect(feed(d, [k("ctrl-c")])).toEqual([]);
    expect(d.state().buffer).toEqual([""]);
    // Now that the buffer is empty, the next ^C reaches the cancel path.
    expect(feed(d, [k("ctrl-c")])).toEqual([{ type: "cancel" }]);
  });

  it("Enter while turn running still emits send (caller queues)", () => {
    const d = new InputDispatcher();
    feed(d, [ch("h"), ch("i")]);
    d.setTurnRunning(true);
    expect(feed(d, [k("enter")])).toEqual([
      { type: "send", text: "hi", planMode: false },
    ]);
    expect(d.state().buffer).toEqual([""]);
  });

  it("Ctrl+D exits when buffer empty, no-op otherwise", () => {
    const d = new InputDispatcher();
    expect(feed(d, [k("ctrl-d")])).toEqual([{ type: "exit" }]);
    feed(d, [ch("x")]);
    expect(feed(d, [k("ctrl-d")])).toEqual([]);
  });

  it("backspace at start of line joins with previous line", () => {
    const d = new InputDispatcher();
    feed(d, [ch("a"), k("alt-enter"), ch("b")]);
    expect(d.state().buffer).toEqual(["a", "b"]);
    // cursor is at end of "b" — move home, then backspace
    feed(d, [k("home"), k("backspace")]);
    expect(d.state().buffer).toEqual(["ab"]);
    expect(d.state().row).toBe(0);
    expect(d.state().col).toBe(1);
  });

  it("paste of multi-line text splits into rows", () => {
    const d = new InputDispatcher();
    feed(d, [{ type: "paste", text: "alpha\nbeta\ngamma" }]);
    expect(d.state().buffer).toEqual(["alpha", "beta", "gamma"]);
    expect(d.state().row).toBe(2);
    expect(d.state().col).toBe(5);
  });

  it("setHistory resets history navigation", () => {
    const d = new InputDispatcher({ history: ["a"] });
    feed(d, [k("up")]);
    expect(d.state().buffer).toEqual(["a"]);
    d.setHistory(["a", "b"]);
    expect(d.state().historyIndex).toBe(-1);
    feed(d, [k("up")]);
    expect(d.state().buffer).toEqual(["b"]);
  });

  it("ctrl-w deletes the previous word", () => {
    const d = new InputDispatcher();
    feed(d, [ch("h"), ch("e"), ch("l"), ch("l"), ch("o"), ch(" "), ch("w"), ch("o"), ch("r"), ch("l"), ch("d")]);
    feed(d, [k("ctrl-w")]);
    expect(d.state().buffer).toEqual(["hello "]);
    expect(d.state().col).toBe(6);
  });

  it("ctrl-w skips trailing whitespace before deleting the word", () => {
    const d = new InputDispatcher();
    feed(d, [{ type: "paste", text: "hello world  " }]);
    feed(d, [k("ctrl-w")]);
    expect(d.state().buffer).toEqual(["hello "]);
  });

  it("ctrl-y yanks back what ctrl-w just killed", () => {
    const d = new InputDispatcher();
    feed(d, [{ type: "paste", text: "hello world" }]);
    feed(d, [k("ctrl-w")]);
    expect(d.state().buffer).toEqual(["hello "]);
    feed(d, [k("ctrl-y")]);
    expect(d.state().buffer).toEqual(["hello world"]);
    expect(d.state().col).toBe(11);
  });

  it("ctrl-y yanks back what ctrl-u just killed", () => {
    const d = new InputDispatcher();
    feed(d, [{ type: "paste", text: "the quick brown fox" }]);
    feed(d, [k("ctrl-u")]);
    expect(d.state().buffer).toEqual([""]);
    feed(d, [k("ctrl-y")]);
    expect(d.state().buffer).toEqual(["the quick brown fox"]);
  });

  it("ctrl-y on an empty kill buffer is a no-op", () => {
    const d = new InputDispatcher();
    feed(d, [k("ctrl-y")]);
    expect(d.state().buffer).toEqual([""]);
  });

  it("ctrl-y can paste at the cursor mid-buffer", () => {
    const d = new InputDispatcher();
    feed(d, [{ type: "paste", text: "abcdef" }]);
    feed(d, [k("ctrl-u")]);
    feed(d, [{ type: "paste", text: "xy" }]);
    feed(d, [k("left")]);
    feed(d, [k("ctrl-y")]);
    expect(d.state().buffer).toEqual(["xabcdefy"]);
    expect(d.state().col).toBe(7);
  });
});
