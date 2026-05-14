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

  it("Ctrl+D exits on empty buffer, deletes forward otherwise", () => {
    const d = new InputDispatcher();
    expect(feed(d, [k("ctrl-d")])).toEqual([{ type: "exit" }]);
    feed(d, [{ type: "paste", text: "abc" }, k("home")]);
    expect(feed(d, [k("ctrl-d")])).toEqual([]);
    expect(d.state().buffer).toEqual(["bc"]);
    expect(d.state().col).toBe(0);
    feed(d, [k("ctrl-d"), k("ctrl-d")]);
    expect(d.state().buffer).toEqual([""]);
    // Now at end-of-buffer with empty content → exit again.
    expect(feed(d, [k("ctrl-d")])).toEqual([{ type: "exit" }]);
  });

  it("Ctrl+D at end of line joins with the next line", () => {
    const d = new InputDispatcher();
    feed(d, [ch("a"), k("alt-enter"), ch("b"), k("up")]);
    expect(d.state().buffer).toEqual(["a", "b"]);
    expect(d.state().row).toBe(0);
    expect(d.state().col).toBe(1);
    feed(d, [k("ctrl-d")]);
    expect(d.state().buffer).toEqual(["ab"]);
  });

  it("backspace at start of line joins with previous line", () => {
    const d = new InputDispatcher();
    feed(d, [ch("a"), k("alt-enter"), ch("b")]);
    expect(d.state().buffer).toEqual(["a", "b"]);
    // cursor is at end of "b" — move to start of current line, then backspace
    feed(d, [k("ctrl-a"), k("backspace")]);
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

  it("Up walks the queue newest-first before falling through to history", () => {
    const d = new InputDispatcher({ history: ["h1", "h2"] });
    d.setQueue(["q1", "q2", "q3"]);
    feed(d, [k("up")]);
    expect(d.state().buffer).toEqual(["q3"]);
    expect(d.state().queueIndex).toBe(2);
    feed(d, [k("up")]);
    expect(d.state().buffer).toEqual(["q2"]);
    expect(d.state().queueIndex).toBe(1);
    feed(d, [k("up")]);
    expect(d.state().buffer).toEqual(["q1"]);
    expect(d.state().queueIndex).toBe(0);
    feed(d, [k("up")]);
    expect(d.state().buffer).toEqual(["h2"]);
    expect(d.state().queueIndex).toBe(-1);
    expect(d.state().historyIndex).toBe(1);
    feed(d, [k("up")]);
    expect(d.state().buffer).toEqual(["h1"]);
  });

  it("Down reverses the Up walk through history then queue then draft", () => {
    const d = new InputDispatcher({ history: ["h1", "h2"] });
    d.setQueue(["q1", "q2"]);
    feed(d, [ch("d"), ch("r"), ch("a"), ch("f"), ch("t")]);
    feed(d, [k("up"), k("up"), k("up"), k("up")]);
    expect(d.state().buffer).toEqual(["h1"]);
    feed(d, [k("down")]);
    expect(d.state().buffer).toEqual(["h2"]);
    feed(d, [k("down")]);
    expect(d.state().buffer).toEqual(["q1"]);
    expect(d.state().queueIndex).toBe(0);
    feed(d, [k("down")]);
    expect(d.state().buffer).toEqual(["q2"]);
    expect(d.state().queueIndex).toBe(1);
    feed(d, [k("down")]);
    expect(d.state().buffer).toEqual(["draft"]);
    expect(d.state().queueIndex).toBe(-1);
  });

  it("Enter on an edited queue slot emits queue-edit, not send", () => {
    const d = new InputDispatcher();
    d.setQueue(["first", "second"]);
    feed(d, [k("up")]);
    expect(d.state().buffer).toEqual(["second"]);
    feed(d, [ch("!")]);
    expect(d.state().buffer).toEqual(["second!"]);
    expect(feed(d, [k("enter")])).toEqual([
      { type: "queue-edit", index: 1, text: "second!" },
    ]);
    expect(d.state().buffer).toEqual([""]);
    expect(d.state().queueIndex).toBe(-1);
  });

  it("Clearing the buffer while editing a queue slot emits queue-remove on Enter", () => {
    const d = new InputDispatcher();
    d.setQueue(["a", "b"]);
    feed(d, [k("up"), k("up")]);
    expect(d.state().buffer).toEqual(["a"]);
    expect(d.state().queueIndex).toBe(0);
    feed(d, [k("ctrl-u")]);
    expect(d.state().buffer).toEqual([""]);
    expect(feed(d, [k("enter")])).toEqual([{ type: "queue-remove", index: 0 }]);
    expect(d.state().queueIndex).toBe(-1);
  });

  it("Up restores into the saved draft when navigating then coming back", () => {
    const d = new InputDispatcher();
    d.setQueue(["only-queue"]);
    feed(d, [ch("h"), ch("i")]);
    feed(d, [k("up")]);
    expect(d.state().buffer).toEqual(["only-queue"]);
    feed(d, [k("down")]);
    expect(d.state().buffer).toEqual(["hi"]);
    expect(d.state().queueIndex).toBe(-1);
  });

  it("setQueue resets queueIndex only when the slot disappears", () => {
    const d = new InputDispatcher();
    d.setQueue(["a", "b", "c"]);
    feed(d, [k("up")]);
    expect(d.state().queueIndex).toBe(2);
    // Queue grows — the slot is still there.
    d.setQueue(["a", "b", "c", "d"]);
    expect(d.state().queueIndex).toBe(2);
    // Queue shrinks below the slot — reset.
    d.setQueue(["a"]);
    expect(d.state().queueIndex).toBe(-1);
  });

  it("Ctrl+C while editing a queued slot clears the text but keeps the slot", () => {
    const d = new InputDispatcher();
    d.setQueue(["queued"]);
    feed(d, [k("up")]);
    expect(d.state().buffer).toEqual(["queued"]);
    expect(d.state().queueIndex).toBe(0);
    // First ^C: clear text, stay on the slot so Enter can drop it.
    expect(feed(d, [k("ctrl-c")])).toEqual([]);
    expect(d.state().buffer).toEqual([""]);
    expect(d.state().queueIndex).toBe(0);
    // Enter on empty buffer + active slot removes the slot.
    expect(feed(d, [k("enter")])).toEqual([{ type: "queue-remove", index: 0 }]);
    expect(d.state().queueIndex).toBe(-1);
  });

  it("Home jumps to buffer start; pressing again emits scroll-to-top", () => {
    const d = new InputDispatcher();
    feed(d, [ch("a"), k("alt-enter"), ch("b"), ch("c")]);
    expect(d.state().row).toBe(1);
    expect(d.state().col).toBe(2);
    expect(feed(d, [k("home")])).toEqual([]);
    expect(d.state().row).toBe(0);
    expect(d.state().col).toBe(0);
    expect(feed(d, [k("home")])).toEqual([{ type: "scroll-to-top" }]);
  });

  it("End jumps to buffer end; pressing again emits scroll-to-bottom", () => {
    const d = new InputDispatcher();
    feed(d, [ch("a"), k("alt-enter"), ch("b"), ch("c"), k("home"), k("up")]);
    expect(d.state().row).toBe(0);
    expect(d.state().col).toBe(0);
    expect(feed(d, [k("end")])).toEqual([]);
    expect(d.state().row).toBe(1);
    expect(d.state().col).toBe(2);
    expect(feed(d, [k("end")])).toEqual([{ type: "scroll-to-bottom" }]);
  });

  it("Ctrl+A and Ctrl+E remain line-level (no scroll fallback)", () => {
    const d = new InputDispatcher();
    feed(d, [ch("a"), k("alt-enter"), ch("b"), ch("c")]);
    feed(d, [k("ctrl-a")]);
    expect(d.state().row).toBe(1);
    expect(d.state().col).toBe(0);
    // Ctrl+A again is still a no-op (line-local, no scroll effect).
    expect(feed(d, [k("ctrl-a")])).toEqual([]);
    feed(d, [k("ctrl-e")]);
    expect(d.state().col).toBe(2);
    expect(feed(d, [k("ctrl-e")])).toEqual([]);
  });

  it("Escape during a turn emits cancel with prefill=true", () => {
    const d = new InputDispatcher();
    d.setTurnRunning(true);
    expect(feed(d, [k("escape")])).toEqual([
      { type: "cancel", prefill: true },
    ]);
  });

  it("Escape outside a turn is a no-op", () => {
    const d = new InputDispatcher();
    expect(feed(d, [k("escape")])).toEqual([]);
    feed(d, [ch("h"), ch("i")]);
    expect(feed(d, [k("escape")])).toEqual([]);
    expect(d.state().buffer).toEqual(["hi"]);
  });

  it("setBuffer seeds the prompt and clears navigation state", () => {
    const d = new InputDispatcher({ history: ["old"] });
    d.setQueue(["q"]);
    feed(d, [k("up")]);
    expect(d.state().queueIndex).toBe(0);
    d.setBuffer("fresh draft");
    expect(d.state().buffer).toEqual(["fresh draft"]);
    expect(d.state().queueIndex).toBe(-1);
    expect(d.state().historyIndex).toBe(-1);
    expect(d.state().col).toBe(11);
  });

  it("Ctrl+C twice while editing a queue slot drops the slot and restores draft", () => {
    const d = new InputDispatcher();
    d.setQueue(["queued"]);
    feed(d, [ch("d"), ch("r"), ch("a"), ch("f"), ch("t")]);
    feed(d, [k("up")]);
    expect(d.state().buffer).toEqual(["queued"]);
    expect(d.state().queueIndex).toBe(0);
    // First ^C clears the text; queueIndex sticks.
    feed(d, [k("ctrl-c")]);
    expect(d.state().buffer).toEqual([""]);
    expect(d.state().queueIndex).toBe(0);
    // Second ^C exits queue edit mode and brings the draft back.
    expect(feed(d, [k("ctrl-c")])).toEqual([]);
    expect(d.state().buffer).toEqual(["draft"]);
    expect(d.state().queueIndex).toBe(-1);
  });
});
