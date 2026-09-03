import { describe, expect, it } from "vitest";
import { buildChordTable, ChordMatcher } from "./chord.js";

function matcher(now?: () => number): ChordMatcher<string> {
  const table = buildChordTable([["ctrl-x", "ctrl-e", "ctrl-x-ctrl-e"]], 1000);
  return new ChordMatcher(table, now);
}

describe("ChordMatcher", () => {
  it("passes through a token that isn't a registered prefix", () => {
    const m = matcher();
    expect(m.feed("ctrl-a")).toEqual({ kind: "pass", token: "ctrl-a" });
    expect(m.isArmed).toBe(false);
  });

  it("arms on a prefix and resolves on its completion", () => {
    const m = matcher();
    expect(m.feed("ctrl-x")).toEqual({ kind: "armed" });
    expect(m.isArmed).toBe(true);
    expect(m.feed("ctrl-e")).toEqual({
      kind: "pass",
      token: "ctrl-x-ctrl-e",
    });
    expect(m.isArmed).toBe(false);
  });

  it("aborts on a non-matching completion, dropping both keys", () => {
    const m = matcher();
    m.feed("ctrl-x");
    expect(m.feed("ctrl-a")).toEqual({ kind: "aborted" });
    expect(m.isArmed).toBe(false);
    // The matcher is unarmed again — the next token is evaluated fresh.
    expect(m.feed("ctrl-e")).toEqual({ kind: "pass", token: "ctrl-e" });
  });

  it("aborts a stale chord once the timeout has elapsed", () => {
    let t = 0;
    const m = matcher(() => t);
    m.feed("ctrl-x");
    t = 5000;
    expect(m.feed("ctrl-e")).toEqual({ kind: "aborted" });
  });

  it("clear() drops a pending prefix without emitting anything", () => {
    const m = matcher();
    m.feed("ctrl-x");
    m.clear();
    expect(m.isArmed).toBe(false);
    expect(m.feed("ctrl-e")).toEqual({ kind: "pass", token: "ctrl-e" });
  });
});
