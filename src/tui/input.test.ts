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
    expect(effects).toEqual([
      { type: "send", text: "hi", planMode: false, attachments: [] },
    ]);
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
    expect(out).toEqual([
      { type: "send", text: "a\nb", planMode: false, attachments: [] },
    ]);
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

  it("Ctrl+G emits show-help without mutating the buffer", () => {
    const d = new InputDispatcher();
    feed(d, [ch("h"), ch("i")]);
    expect(feed(d, [k("ctrl-g")])).toEqual([{ type: "show-help" }]);
    expect(d.state().buffer).toEqual(["hi"]);
  });

  it("Enter while plan mode on sends with planMode: true", () => {
    const d = new InputDispatcher({ planMode: true });
    feed(d, [ch("x")]);
    expect(feed(d, [k("enter")])).toEqual([
      { type: "send", text: "x", planMode: true, attachments: [] },
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
      { type: "send", text: "hi", planMode: false, attachments: [] },
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

  it("alt-b walks back to the start of the previous word", () => {
    const d = new InputDispatcher();
    feed(d, [{ type: "paste", text: "hello world" }]);
    expect(d.state().col).toBe(11);
    feed(d, [k("alt-b")]);
    expect(d.state().col).toBe(6);
    feed(d, [k("alt-b")]);
    expect(d.state().col).toBe(0);
    feed(d, [k("alt-b")]);
    expect(d.state().col).toBe(0);
  });

  it("alt-b skips trailing whitespace before walking back through the word", () => {
    const d = new InputDispatcher();
    feed(d, [{ type: "paste", text: "hello world  " }]);
    feed(d, [k("alt-b")]);
    expect(d.state().col).toBe(6);
  });

  it("alt-f walks forward to the end of the next word", () => {
    const d = new InputDispatcher();
    feed(d, [{ type: "paste", text: "hello world" }, k("home")]);
    expect(d.state().col).toBe(0);
    feed(d, [k("alt-f")]);
    expect(d.state().col).toBe(5);
    feed(d, [k("alt-f")]);
    expect(d.state().col).toBe(11);
    feed(d, [k("alt-f")]);
    expect(d.state().col).toBe(11);
  });

  it("alt-f skips leading whitespace before walking forward through the word", () => {
    const d = new InputDispatcher();
    feed(d, [{ type: "paste", text: "  hello world" }, k("home")]);
    feed(d, [k("alt-f")]);
    expect(d.state().col).toBe(7);
  });

  it("alt-b crosses to the previous line when at column 0", () => {
    const d = new InputDispatcher();
    feed(d, [ch("a"), k("alt-enter"), ch("b"), k("ctrl-a")]);
    expect(d.state()).toMatchObject({ row: 1, col: 0 });
    feed(d, [k("alt-b")]);
    expect(d.state()).toMatchObject({ row: 0, col: 1 });
  });

  it("alt-f crosses to the next line when at end of current line", () => {
    const d = new InputDispatcher();
    feed(d, [ch("a"), k("alt-enter"), ch("b"), k("up")]);
    expect(d.state()).toMatchObject({ row: 0, col: 1 });
    feed(d, [k("alt-f")]);
    expect(d.state()).toMatchObject({ row: 1, col: 0 });
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

  it("ctrl-u at col=0 swallows the previous line and the newline", () => {
    const d = new InputDispatcher();
    feed(d, [
      { type: "paste", text: "first\nsecond\nthird" },
      k("home"),
    ]);
    expect(d.state()).toMatchObject({
      buffer: ["first", "second", "third"],
      row: 0,
      col: 0,
    });
    feed(d, [k("end"), k("down")]);
    // Land at start of "third"
    feed(d, [k("ctrl-a")]);
    expect(d.state()).toMatchObject({ row: 2, col: 0 });
    feed(d, [k("ctrl-u")]);
    expect(d.state().buffer).toEqual(["first", "third"]);
    expect(d.state()).toMatchObject({ row: 1, col: 0 });
    feed(d, [k("ctrl-u")]);
    expect(d.state().buffer).toEqual(["third"]);
    expect(d.state()).toMatchObject({ row: 0, col: 0 });
    feed(d, [k("ctrl-u")]);
    expect(d.state().buffer).toEqual(["third"]);
  });

  it("ctrl-u still kills to start-of-line when there is content before cursor", () => {
    const d = new InputDispatcher();
    feed(d, [{ type: "paste", text: "abc\ndef" }]);
    expect(d.state()).toMatchObject({ row: 1, col: 3 });
    feed(d, [k("ctrl-u")]);
    expect(d.state().buffer).toEqual(["abc", ""]);
    expect(d.state()).toMatchObject({ row: 1, col: 0 });
    // Second press: current line is empty, so collapse it (don't slurp
    // the prev line's contents). Cursor lands at end of "abc".
    feed(d, [k("ctrl-u")]);
    expect(d.state().buffer).toEqual(["abc"]);
    expect(d.state()).toMatchObject({ row: 0, col: 3 });
    // Third press: now col>0 again, kills "abc".
    feed(d, [k("ctrl-u")]);
    expect(d.state().buffer).toEqual([""]);
    expect(d.state()).toMatchObject({ row: 0, col: 0 });
  });

  it("ctrl-k on an empty current line collapses it instead of slurping the next line", () => {
    const d = new InputDispatcher();
    feed(d, [{ type: "paste", text: "abc\ndef" }, k("home"), k("ctrl-a")]);
    // Cursor at start of "abc".
    expect(d.state()).toMatchObject({ row: 0, col: 0 });
    feed(d, [k("ctrl-k")]);
    expect(d.state().buffer).toEqual(["", "def"]);
    expect(d.state()).toMatchObject({ row: 0, col: 0 });
    // Empty current line — second ^K should drop the empty line, NOT
    // also kill "def".
    feed(d, [k("ctrl-k")]);
    expect(d.state().buffer).toEqual(["def"]);
    expect(d.state()).toMatchObject({ row: 0, col: 0 });
  });

  it("ctrl-u on an empty current line collapses it instead of slurping the previous line", () => {
    const d = new InputDispatcher();
    feed(d, [{ type: "paste", text: "abc\ndef" }]);
    feed(d, [k("ctrl-u")]);
    expect(d.state().buffer).toEqual(["abc", ""]);
    expect(d.state()).toMatchObject({ row: 1, col: 0 });
    // Empty current line — second ^U should drop the empty line, NOT
    // also kill "abc". Cursor lands at end of the previous line.
    feed(d, [k("ctrl-u")]);
    expect(d.state().buffer).toEqual(["abc"]);
    expect(d.state()).toMatchObject({ row: 0, col: 3 });
  });

  it("ctrl-k at end-of-line swallows the next line and the newline", () => {
    const d = new InputDispatcher();
    feed(d, [
      { type: "paste", text: "first\nsecond\nthird" },
      k("home"),
    ]);
    feed(d, [k("ctrl-e")]);
    expect(d.state()).toMatchObject({ row: 0, col: 5 });
    feed(d, [k("ctrl-k")]);
    expect(d.state().buffer).toEqual(["first", "third"]);
    expect(d.state()).toMatchObject({ row: 0, col: 5 });
    feed(d, [k("ctrl-k")]);
    expect(d.state().buffer).toEqual(["first"]);
    expect(d.state()).toMatchObject({ row: 0, col: 5 });
    feed(d, [k("ctrl-k")]);
    expect(d.state().buffer).toEqual(["first"]);
  });

  it("ctrl-k still kills to end-of-line when there is content after cursor", () => {
    const d = new InputDispatcher();
    feed(d, [
      { type: "paste", text: "abc\ndef" },
      k("home"),
      k("right"),
    ]);
    expect(d.state()).toMatchObject({ row: 0, col: 1 });
    feed(d, [k("ctrl-k")]);
    expect(d.state().buffer).toEqual(["a", "def"]);
    expect(d.state()).toMatchObject({ row: 0, col: 1 });
  });

  it("ctrl-y restores a cross-line ctrl-u kill", () => {
    const d = new InputDispatcher();
    feed(d, [{ type: "paste", text: "foo\nbar" }, k("ctrl-a")]);
    expect(d.state()).toMatchObject({ row: 1, col: 0 });
    feed(d, [k("ctrl-u")]);
    expect(d.state().buffer).toEqual(["bar"]);
    feed(d, [k("ctrl-y")]);
    expect(d.state().buffer).toEqual(["foo", "bar"]);
  });

  it("ctrl-y restores a cross-line ctrl-k kill", () => {
    const d = new InputDispatcher();
    feed(d, [{ type: "paste", text: "foo\nbar" }, k("home")]);
    feed(d, [k("ctrl-e")]);
    expect(d.state()).toMatchObject({ row: 0, col: 3 });
    feed(d, [k("ctrl-k")]);
    expect(d.state().buffer).toEqual(["foo"]);
    feed(d, [k("ctrl-y")]);
    expect(d.state().buffer).toEqual(["foo", "bar"]);
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
      { type: "queue-edit", index: 1, text: "second!", attachments: [] },
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

  it("Ctrl+C while editing a queued slot removes the slot and restores the draft in one step", () => {
    const d = new InputDispatcher();
    d.setQueue(["queued"]);
    feed(d, [ch("d"), ch("r"), ch("a"), ch("f"), ch("t")]);
    feed(d, [k("up")]);
    expect(d.state().buffer).toEqual(["queued"]);
    expect(d.state().queueIndex).toBe(0);
    // Single ^C: emit queue-remove for the edited slot AND restore
    // the original draft. No two-step (clear-then-enter) required.
    expect(feed(d, [k("ctrl-c")])).toEqual([
      { type: "queue-remove", index: 0 },
    ]);
    expect(d.state().queueIndex).toBe(-1);
    expect(d.state().buffer).toEqual(["draft"]);
  });

  it("Ctrl+C drops the slot even if the user edited its text first", () => {
    const d = new InputDispatcher();
    d.setQueue(["queued"]);
    feed(d, [k("up"), ch("!")]);
    expect(d.state().buffer).toEqual(["queued!"]);
    expect(feed(d, [k("ctrl-c")])).toEqual([
      { type: "queue-remove", index: 0 },
    ]);
    expect(d.state().queueIndex).toBe(-1);
    expect(d.state().buffer).toEqual([""]);
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

  it("Ctrl+C after dropping a queued slot exits cleanly (no double-fire)", () => {
    const d = new InputDispatcher();
    d.setQueue(["queued"]);
    feed(d, [ch("d"), ch("r"), ch("a"), ch("f"), ch("t")]);
    feed(d, [k("up")]);
    expect(d.state().buffer).toEqual(["queued"]);
    expect(d.state().queueIndex).toBe(0);
    // First ^C removes the slot and brings draft back in one shot.
    expect(feed(d, [k("ctrl-c")])).toEqual([
      { type: "queue-remove", index: 0 },
    ]);
    expect(d.state().buffer).toEqual(["draft"]);
    expect(d.state().queueIndex).toBe(-1);
    // Second ^C clears the restored draft (now a fresh-text layer).
    expect(feed(d, [k("ctrl-c")])).toEqual([]);
    expect(d.state().buffer).toEqual([""]);
  });

  it("Ctrl+R with empty buffer engages history search with empty query (no auto-load)", () => {
    const d = new InputDispatcher({ history: ["old", "mid", "new"] });
    expect(feed(d, [k("ctrl-r")])).toEqual([]);
    // Buffer stays empty — search is engaged but no entry is loaded
    // yet; the next typed char will start filtering.
    expect(d.state().buffer).toEqual([""]);
    expect(d.state().historySearchQuery).toBe("");
    // Typing 'n' now finds the entry containing 'n' and loads it.
    feed(d, [ch("n")]);
    expect(d.state().buffer).toEqual(["new"]);
    expect(d.state().historySearchQuery).toBe("n");
  });

  it("Ctrl+R with buffer text filters history by substring", () => {
    const d = new InputDispatcher({
      history: ["git pull", "git commit", "git push", "npm test"],
    });
    feed(d, [ch("p"), ch("u"), ch("s"), ch("h")]);
    feed(d, [k("ctrl-r")]);
    expect(d.state().buffer).toEqual(["git push"]);
  });

  it("Ctrl+R case-insensitive match", () => {
    const d = new InputDispatcher({ history: ["Deploy Prod", "rebuild"] });
    feed(d, [ch("d"), ch("e"), ch("p"), ch("l")]);
    feed(d, [k("ctrl-r")]);
    expect(d.state().buffer).toEqual(["Deploy Prod"]);
  });

  it("Ctrl+R then Escape restores the original draft", () => {
    const d = new InputDispatcher({ history: ["git pull", "git push"] });
    feed(d, [ch("g"), ch("i"), ch("t")]);
    feed(d, [k("ctrl-r")]);
    expect(d.state().buffer).toEqual(["git push"]);
    expect(feed(d, [k("escape")])).toEqual([]);
    expect(d.state().buffer).toEqual(["git"]);
  });

  it("Ctrl+R then Enter submits the matched history entry", () => {
    const d = new InputDispatcher({ history: ["git push"] });
    feed(d, [ch("g"), ch("i"), ch("t")]);
    feed(d, [k("ctrl-r")]);
    expect(d.state().buffer).toEqual(["git push"]);
    expect(feed(d, [k("enter")])).toEqual([
      { type: "send", text: "git push", planMode: false, attachments: [] },
    ]);
  });

  it("Ctrl+R with no history match escalates to scrollback search", () => {
    const d = new InputDispatcher({ history: ["git pull"] });
    feed(d, [ch("z"), ch("z"), ch("z")]);
    const effects = feed(d, [k("ctrl-r")]);
    expect(effects).toEqual([{ type: "escalate-search", query: "zzz" }]);
    // Buffer untouched — escalating means the user keeps their typed
    // text so cancelling scrollback search lands them back here.
    expect(d.state().buffer).toEqual(["zzz"]);
  });

  it("Ctrl+R with empty buffer + empty history engages search; typing escalates on first miss", () => {
    const d = new InputDispatcher();
    expect(feed(d, [k("ctrl-r")])).toEqual([]);
    expect(d.state().historySearchQuery).toBe("");
    // Typing with no history finds nothing → escalates to scrollback.
    expect(feed(d, [ch("x")])).toEqual([
      { type: "escalate-search", query: "x" },
    ]);
  });

  it("Ctrl+R past the oldest match escalates with the original query", () => {
    const d = new InputDispatcher({ history: ["git pull"] });
    feed(d, [ch("g"), ch("i"), ch("t")]);
    feed(d, [k("ctrl-r")]);
    expect(d.state().buffer).toEqual(["git pull"]);
    // Already at oldest — next ^R falls through to scrollback search.
    const effects = feed(d, [k("ctrl-r")]);
    expect(effects).toEqual([{ type: "escalate-search", query: "git" }]);
    // Restored to original draft so cancel returns to "git", not "git pull".
    expect(d.state().buffer).toEqual(["git"]);
  });

  it("backspacing query to empty restores the saved draft and stays in search", () => {
    const d = new InputDispatcher({ history: ["one"] });
    feed(d, [ch("o")]);
    feed(d, [k("ctrl-r")]);
    expect(d.state().buffer).toEqual(["one"]);
    feed(d, [k("backspace")]);
    // Empty query → draft "o" comes back; still in search mode so
    // typing keeps filtering.
    expect(d.state().buffer).toEqual(["o"]);
    expect(d.state().historySearchQuery).toBe("");
    // Past-oldest ^R with empty query is a no-op (don't escalate empty).
    expect(feed(d, [k("ctrl-r")])).toEqual([]);
  });

  it("typing in search mode extends the query and re-searches", () => {
    const d = new InputDispatcher({
      history: ["git pull", "git push origin", "npm test"],
    });
    feed(d, [ch("n")]);
    feed(d, [k("ctrl-r")]);
    expect(d.state().buffer).toEqual(["npm test"]);
    feed(d, [k("backspace"), ch("g")]);
    expect(d.state().buffer).toEqual(["git push origin"]);
    feed(d, [ch("i"), ch("t"), ch(" "), ch("p"), ch("u"), ch("l")]);
    expect(d.state().buffer).toEqual(["git pull"]);
  });

  it("typing extends the query until no match, then escalates", () => {
    const d = new InputDispatcher({ history: ["git push"] });
    feed(d, [ch("g"), ch("i"), ch("t")]);
    feed(d, [k("ctrl-r")]);
    expect(d.state().buffer).toEqual(["git push"]);
    const effects = feed(d, [ch("z")]);
    expect(effects).toEqual([{ type: "escalate-search", query: "gitz" }]);
    expect(d.state().buffer).toEqual(["git"]);
  });

  it("backspace in search mode shrinks the query and re-searches", () => {
    const d = new InputDispatcher({
      history: ["git pull", "git push", "git commit"],
    });
    // Query "git pu" matches "git push" (newer) and "git pull" (older).
    feed(d, [ch("g"), ch("i"), ch("t"), ch(" "), ch("p"), ch("u")]);
    feed(d, [k("ctrl-r")]);
    expect(d.state().buffer).toEqual(["git push"]);
    feed(d, [k("backspace"), k("backspace"), k("backspace")]);
    // Query now "git", newest match is "git commit".
    expect(d.state().buffer).toEqual(["git commit"]);
  });

  it("backspace shrinking until no match escalates", () => {
    const d2 = new InputDispatcher({ history: ["git push"] });
    feed(d2, [ch("g"), ch("i"), ch("t")]);
    feed(d2, [k("ctrl-r")]);
    expect(d2.state().buffer).toEqual(["git push"]);
    const effects = feed(d2, [ch("z")]);
    expect(effects[0]).toEqual({ type: "escalate-search", query: "gitz" });
  });

  it("backspacing through the query restores the draft, then cancels search on next backspace", () => {
    const d = new InputDispatcher({ history: ["onelongmatch"] });
    feed(d, [ch("o"), ch("n"), ch("e")]);
    feed(d, [k("ctrl-r")]);
    expect(d.state().buffer).toEqual(["onelongmatch"]);
    expect(d.state().historySearchQuery).toBe("one");
    feed(d, [k("backspace"), k("backspace"), k("backspace")]);
    // Query empty → buffer reverts to the saved draft; search still
    // engaged so further typing would build a new query.
    expect(d.state().buffer).toEqual(["one"]);
    expect(d.state().historySearchQuery).toBe("");
    // Another backspace at empty query cancels search (still leaves
    // the draft in place).
    expect(feed(d, [k("backspace")])).toEqual([]);
    expect(d.state().buffer).toEqual(["one"]);
    expect(d.state().historySearchQuery).toBe(null);
  });

  it("Ctrl+C in history search cancels the search (no exit) and restores the draft", () => {
    const d = new InputDispatcher({ history: ["git push"] });
    feed(d, [ch("g"), ch("i"), ch("t")]);
    feed(d, [k("ctrl-r")]);
    expect(d.state().buffer).toEqual(["git push"]);
    expect(d.state().historySearchQuery).toBe("git");
    // Empty-query case: ^r with no chars typed yet still engages search.
    const d2 = new InputDispatcher({ history: ["git push"] });
    feed(d2, [k("ctrl-r")]);
    expect(d2.state().historySearchQuery).toBe("");
    expect(feed(d2, [k("ctrl-c")])).toEqual([]);
    expect(d2.state().historySearchQuery).toBe(null);
    expect(d2.state().buffer).toEqual([""]);
    // With a query: ^c peels the search, draft is restored, no exit.
    expect(feed(d, [k("ctrl-c")])).toEqual([]);
    expect(d.state().historySearchQuery).toBe(null);
    expect(d.state().buffer).toEqual(["git"]);
    // Next ^c on the (now empty after clearing the draft text) buffer
    // follows the normal ladder — here the draft has text so it clears it.
    expect(feed(d, [k("ctrl-c")])).toEqual([]);
    expect(d.state().buffer).toEqual([""]);
    // Final ^c on an empty draft with no turn running exits.
    expect(feed(d, [k("ctrl-c")])).toEqual([{ type: "exit" }]);
  });

  it("Enter in search mode submits the matched entry (history clears search state)", () => {
    const d = new InputDispatcher({ history: ["git push"] });
    feed(d, [ch("g"), ch("i"), ch("t")]);
    feed(d, [k("ctrl-r")]);
    expect(d.state().buffer).toEqual(["git push"]);
    expect(feed(d, [k("enter")])).toEqual([
      { type: "send", text: "git push", planMode: false, attachments: [] },
    ]);
  });

  it("arrow key in search mode exits keeping the match and processes the arrow", () => {
    const d = new InputDispatcher({ history: ["git push"] });
    feed(d, [ch("g")]);
    feed(d, [k("ctrl-r")]);
    expect(d.state().buffer).toEqual(["git push"]);
    feed(d, [k("home")]);
    // home moved cursor to start of the matched line; buffer kept.
    expect(d.state().buffer).toEqual(["git push"]);
    expect(d.state().col).toBe(0);
  });

  it("Ctrl+S in history search walks forward toward newer matches", () => {
    const d = new InputDispatcher({
      history: ["git pull", "git push", "git commit"],
    });
    feed(d, [ch("g"), ch("i"), ch("t")]);
    feed(d, [k("ctrl-r")]);
    // cursor=0, newest match
    expect(d.state().buffer).toEqual(["git commit"]);
    feed(d, [k("ctrl-r")]);
    expect(d.state().buffer).toEqual(["git push"]);
    feed(d, [k("ctrl-r")]);
    expect(d.state().buffer).toEqual(["git pull"]);
    // Walk forward
    feed(d, [k("ctrl-s")]);
    expect(d.state().buffer).toEqual(["git push"]);
    feed(d, [k("ctrl-s")]);
    expect(d.state().buffer).toEqual(["git commit"]);
    // No wrap at the newest match
    feed(d, [k("ctrl-s")]);
    expect(d.state().buffer).toEqual(["git commit"]);
  });

  it("Ctrl+S outside history search is a no-op", () => {
    const d = new InputDispatcher({ history: ["one"] });
    expect(feed(d, [k("ctrl-s")])).toEqual([]);
    expect(d.state().buffer).toEqual([""]);
  });

  describe("attachments", () => {
    const att = (name: string) => ({
      mimeType: "image/png",
      data: "AAAA",
      name,
      sizeBytes: 3,
    });

    it("Ctrl+V emits attachment-request without mutating the buffer", () => {
      const d = new InputDispatcher();
      feed(d, [ch("h"), ch("i")]);
      expect(feed(d, [k("ctrl-v")])).toEqual([
        { type: "attachment-request", source: "clipboard" },
      ]);
      expect(d.state().buffer).toEqual(["hi"]);
    });

    it("addAttachment appends and state exposes the list", () => {
      const d = new InputDispatcher();
      d.addAttachment(att("a.png"));
      d.addAttachment(att("b.png"));
      expect(d.state().attachments.map((a) => a.name)).toEqual([
        "a.png",
        "b.png",
      ]);
    });

    it("removeAttachment drops the slot; out-of-range is a no-op", () => {
      const d = new InputDispatcher();
      d.addAttachment(att("a.png"));
      d.addAttachment(att("b.png"));
      d.removeAttachment(0);
      expect(d.state().attachments.map((a) => a.name)).toEqual(["b.png"]);
      d.removeAttachment(99);
      expect(d.state().attachments.map((a) => a.name)).toEqual(["b.png"]);
    });

    it("Enter snapshots attachments into send effect and clears them", () => {
      const d = new InputDispatcher();
      d.addAttachment(att("a.png"));
      feed(d, [ch("h"), ch("i")]);
      const out = feed(d, [k("enter")]);
      expect(out).toEqual([
        {
          type: "send",
          text: "hi",
          planMode: false,
          attachments: [att("a.png")],
        },
      ]);
      expect(d.state().attachments).toEqual([]);
    });

    it("Enter with attachments-only (no text) still emits send", () => {
      const d = new InputDispatcher();
      d.addAttachment(att("a.png"));
      const out = feed(d, [k("enter")]);
      expect(out).toEqual([
        {
          type: "send",
          text: "",
          planMode: false,
          attachments: [att("a.png")],
        },
      ]);
    });

    it("Queue-edit carries attachments alongside the edited text", () => {
      const d = new InputDispatcher();
      d.setQueue(["queued"]);
      feed(d, [k("up")]);
      d.addAttachment(att("a.png"));
      feed(d, [ch("!")]);
      const out = feed(d, [k("enter")]);
      expect(out).toEqual([
        {
          type: "queue-edit",
          index: 0,
          text: "queued!",
          attachments: [att("a.png")],
        },
      ]);
    });

    it("Ctrl+C with attachments and empty text clears them (peel layer 1)", () => {
      const d = new InputDispatcher();
      d.addAttachment(att("a.png"));
      const out = feed(d, [k("ctrl-c")]);
      expect(out).toEqual([]);
      expect(d.state().attachments).toEqual([]);
    });

    it("Up walks history snapshotting attachments; Down restores them", () => {
      const d = new InputDispatcher({ history: ["one"] });
      d.addAttachment(att("a.png"));
      feed(d, [ch("d"), ch("r"), ch("a"), ch("f"), ch("t")]);
      feed(d, [k("up")]);
      expect(d.state().buffer).toEqual(["one"]);
      expect(d.state().attachments).toEqual([]);
      feed(d, [k("down")]);
      expect(d.state().buffer).toEqual(["draft"]);
      expect(d.state().attachments).toEqual([att("a.png")]);
    });

    it("setBuffer with attachments seeds both", () => {
      const d = new InputDispatcher();
      d.setBuffer("restored", [att("a.png")]);
      expect(d.state().buffer).toEqual(["restored"]);
      expect(d.state().attachments).toEqual([att("a.png")]);
    });

    it("attachment-paths KeyEvent is dispatcher no-op", () => {
      const d = new InputDispatcher();
      feed(d, [ch("h")]);
      const out = d.feed({
        type: "attachment-paths",
        paths: ["/tmp/cat.png"],
      });
      expect(out).toEqual([]);
      expect(d.state().buffer).toEqual(["h"]);
      expect(d.state().attachments).toEqual([]);
    });
  });
});
