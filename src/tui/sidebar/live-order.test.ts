import { describe, expect, it } from "vitest";
import { sortLiveSessions } from "./gadgets.js";

const row = (id: string, o: Partial<{ blocked: boolean; busy: boolean; armed: boolean }> = {}) => ({
  id,
  blocked: false,
  busy: false,
  armed: false,
  ...o,
});

describe("sortLiveSessions", () => {
  it("orders by state, then by id, whatever order the daemon listed them in", () => {
    const a = [row("c"), row("a"), row("b", { busy: true })];
    const b = [row("a"), row("b", { busy: true }), row("c")];
    const ids = (l: typeof a) => sortLiveSessions(l, (e) => e.id).map((e) => e.id);
    expect(ids(a)).toEqual(["b", "a", "c"]);
    expect(ids(b)).toEqual(["b", "a", "c"]);
  });
});
