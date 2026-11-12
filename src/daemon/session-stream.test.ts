import { describe, it, expect } from "vitest";
import { SessionStreamDiff } from "./session-stream.js";

const row = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  sessionId,
  updatedAt: "2026-01-01T00:00:00Z",
  busy: false,
  ...extra,
});

describe("SessionStreamDiff", () => {
  it("sends everything first, then only changed rows", () => {
    const d = new SessionStreamDiff(false);
    expect(d.next([row("a"), row("b")], [], 1)?.sessions).toHaveLength(2);
    expect(d.next([row("a"), row("b")], [], 2)).toBeNull();
    const frame = d.next([row("a", { busy: true }), row("b")], [], 3);
    expect(frame?.sessions.map((s) => s.sessionId)).toEqual(["a"]);
    expect(frame?.cursor).toBe(3);
  });

  it("ignores updatedAt alone", () => {
    const d = new SessionStreamDiff(false);
    d.next([row("a")], [], 1);
    expect(d.next([row("a", { updatedAt: "2026-02-02T00:00:00Z" })], [], 2)).toBeNull();
  });

  it("warm-only: a row that disappears is reported as removed once", () => {
    const d = new SessionStreamDiff(true);
    d.next([row("a"), row("b")], [], 1);
    expect(d.next([row("a")], [], 2)?.removed).toEqual(["b"]);
    expect(d.next([row("a")], [], 3)).toBeNull();
  });

  it("unfiltered: trusts the store's deleted list, not absence", () => {
    const d = new SessionStreamDiff(false);
    d.next([row("a"), row("b")], [], 1);
    expect(d.next([row("a")], [], 2)).toBeNull();
    expect(d.next([row("a")], ["b"], 3)?.removed).toEqual(["b"]);
  });

  it("does not report a deletion of an id it never sent", () => {
    const d = new SessionStreamDiff(false);
    d.next([row("a")], [], 1);
    expect(d.next([row("a")], ["zzz"], 2)).toBeNull();
  });
});
