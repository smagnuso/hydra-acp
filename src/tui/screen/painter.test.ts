import { describe, expect, it } from "vitest";
import type { Terminal } from "terminal-kit";
import { RowPainter } from "./painter.js";

interface Op {
  op: string;
  args: unknown[];
}

// Recording mock: callable (term("text")) and chainable, logging every
// call so a test can assert the exact escape-sequence choreography —
// which matters here because the whole sidebar design rests on the left
// region NOT emitting eraseLineAfter.
function makeTerm(width = 100, height = 40): { term: Terminal; ops: Op[] } {
  const ops: Op[] = [];
  const handler: ProxyHandler<(...args: unknown[]) => unknown> = {
    apply: (_t, _this, args) => {
      ops.push({ op: "write", args });
      return term;
    },
    get(_target, prop) {
      if (prop === "width") return width;
      if (prop === "height") return height;
      // Plain function, not re-proxied: re-using `handler` here would
      // route the call through its apply trap and log every method as a
      // "write".
      return (...args: unknown[]) => {
        ops.push({ op: String(prop), args });
        return term;
      };
    },
  };
  const term = new Proxy(
    function noop() {} as (...args: unknown[]) => unknown,
    handler,
  ) as unknown as Terminal;
  return { term, ops };
}

describe("RowPainter", () => {
  it("skips a row whose signature is unchanged", () => {
    const { term, ops } = makeTerm();
    const p = new RowPainter(term);
    p.paintRow(3, "sig", () => term("hello"));
    const first = ops.length;
    expect(first).toBeGreaterThan(0);
    p.paintRow(3, "sig", () => term("hello"));
    expect(ops.length).toBe(first);
    p.paintRow(3, "other", () => term("hello"));
    expect(ops.length).toBeGreaterThan(first);
  });

  it("ignores rows outside the terminal", () => {
    const { term, ops } = makeTerm(100, 10);
    const p = new RowPainter(term);
    p.paintRow(0, "s", () => term("x"));
    p.paintRow(11, "s", () => term("x"));
    expect(ops).toHaveLength(0);
  });

  // Two regions occupy the same row once the sidebar is visible. A single
  // row-keyed cache would thrash — each pass would evict the other's
  // signature and both would repaint on every frame.
  it("caches regions on one row independently", () => {
    const { term, ops } = makeTerm();
    const p = new RowPainter(term);
    p.paintRow(5, "content-a", () => term("left"), { erase: false });
    p.paintRow(5, "sidebar-a", () => term("right"), {
      region: "sidebar",
      column: 80,
    });
    const after = ops.length;
    // Neither pass invalidated the other, so a second identical frame
    // emits nothing at all.
    p.paintRow(5, "content-a", () => term("left"), { erase: false });
    p.paintRow(5, "sidebar-a", () => term("right"), {
      region: "sidebar",
      column: 80,
    });
    expect(ops.length).toBe(after);

    // Changing only the sidebar repaints only the sidebar.
    p.paintRow(5, "content-a", () => term("left"), { erase: false });
    p.paintRow(5, "sidebar-b", () => term("right2"), {
      region: "sidebar",
      column: 80,
    });
    const writes = ops.slice(after).filter((o) => o.op === "write");
    expect(writes.map((w) => w.args[0])).toEqual(["right2"]);
  });

  it("omits eraseLineAfter for a region that shares its row", () => {
    const { term, ops } = makeTerm();
    const p = new RowPainter(term);
    p.paintRow(2, "s", () => term("left"), { erase: false });
    expect(ops.some((o) => o.op === "eraseLineAfter")).toBe(false);
    // The rightmost region keeps the erase so trailing leftovers clear.
    p.paintRow(2, "s2", () => term("right"), {
      region: "sidebar",
      column: 80,
    });
    expect(ops.filter((o) => o.op === "eraseLineAfter")).toHaveLength(1);
  });

  it("moves to the region's column, defaulting to column 1", () => {
    const { term, ops } = makeTerm();
    const p = new RowPainter(term);
    p.paintRow(4, "s", () => term("x"));
    p.paintRow(4, "s", () => term("y"), { region: "sidebar", column: 81 });
    const moves = ops.filter((o) => o.op === "moveTo").map((o) => o.args);
    expect(moves).toEqual([
      [1, 4],
      [81, 4],
    ]);
  });

  it("paints, then resets style, then erases — in that order", () => {
    const { term, ops } = makeTerm();
    const p = new RowPainter(term);
    p.paintRow(1, "s", () => term("body"));
    const seq = ops.map((o) => o.op);
    expect(seq).toEqual(["moveTo", "write", "styleReset", "eraseLineAfter"]);
  });

  it("drops every region's cache on resize", () => {
    const { term, ops } = makeTerm();
    const p = new RowPainter(term);
    p.paintRow(1, "s", () => term("a"));
    p.paintRow(1, "s", () => term("b"), { region: "sidebar", column: 80 });
    expect(p.ensureSize(100, 40)).toBe(true);
    const after = ops.length;
    p.paintRow(1, "s", () => term("a"));
    p.paintRow(1, "s", () => term("b"), { region: "sidebar", column: 80 });
    expect(ops.length).toBeGreaterThan(after);
  });
});

describe("RowPainter.invalidate", () => {
  it("forces the next paint of that region's row to emit", () => {
    const { term, ops } = makeTerm();
    const p = new RowPainter(term);
    p.paintRow(5, "sig", () => term("a"), { region: "sidebar", column: 80 });
    const after = ops.length;
    p.paintRow(5, "sig", () => term("a"), { region: "sidebar", column: 80 });
    expect(ops.length).toBe(after);
    p.invalidate("sidebar", 5);
    p.paintRow(5, "sig", () => term("a"), { region: "sidebar", column: 80 });
    expect(ops.length).toBeGreaterThan(after);
  });

  it("leaves other regions and rows alone", () => {
    const { term, ops } = makeTerm();
    const p = new RowPainter(term);
    p.paintRow(5, "sig", () => term("left"));
    p.paintRow(6, "sig", () => term("x"), { region: "sidebar", column: 80 });
    p.invalidate("sidebar", 5);
    const after = ops.length;
    p.paintRow(5, "sig", () => term("left"));
    p.paintRow(6, "sig", () => term("x"), { region: "sidebar", column: 80 });
    expect(ops.length).toBe(after);
  });

  it("reports whether a row was actually emitted", () => {
    const { term } = makeTerm();
    const p = new RowPainter(term);
    expect(p.paintRow(1, "a", () => term("x"))).toBe(true);
    expect(p.paintRow(1, "a", () => term("x"))).toBe(false);
    expect(p.paintRow(1, "b", () => term("x"))).toBe(true);
    // Out-of-bounds rows are not emitted.
    expect(p.paintRow(999, "a", () => term("x"))).toBe(false);
  });
});
