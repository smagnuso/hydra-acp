import { describe, expect, it } from "vitest";

import { FOCUS_IN, FOCUS_OUT } from "./ansi.js";
import { FocusTracker } from "./focus-tracker.js";

describe("FocusTracker", () => {
  it("strips markers and reports state changes", () => {
    const t = new FocusTracker();
    expect(t.consume(`a${FOCUS_OUT}b`)).toEqual({ text: "ab", changed: true });
    expect(t.focused).toBe(false);
    expect(t.consume("x")).toEqual({ text: "x", changed: false });
    expect(t.consume(`${FOCUS_IN}y`)).toEqual({ text: "y", changed: true });
    expect(t.focused).toBe(true);
  });

  it("drops button events while unfocused or just after a focus gain", () => {
    const t = new FocusTracker();
    t.consume(FOCUS_OUT);
    expect(t.shouldDropButtonEvent()).toBe(true);
    t.consume(FOCUS_IN);
    expect(t.shouldDropButtonEvent()).toBe(true);
    expect(t.shouldDropButtonEvent(Date.now() + 500)).toBe(false);
  });

  it("does not drop clicks right after our own copy", () => {
    const t = new FocusTracker();
    t.noteOwnCopy();
    t.consume(FOCUS_OUT);
    t.consume(FOCUS_IN);
    expect(t.shouldDropButtonEvent()).toBe(false);
    expect(t.shouldDropButtonEvent(Date.now() + 2000)).toBe(false);
    t.consume(FOCUS_OUT);
    expect(t.shouldDropButtonEvent(Date.now() + 2000)).toBe(true);
  });
});
