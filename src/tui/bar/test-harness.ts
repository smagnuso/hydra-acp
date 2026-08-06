// Capturing terminal mock for bar-row golden tests.
//
// The three chrome rows funnel all of their output through either
// `term(text)` (raw spacer runs) or `paint()` → `term.noFormat(styled)`.
// Both land here; ANSI is stripped so the golden strings compare on
// visible glyphs alone, which is what the layout engine is responsible
// for. Colour/token selection is asserted separately.

import type { Terminal } from "terminal-kit";

const ANSI = /\u001b\[[0-9;]*m/g;

export interface CaptureTerm {
  term: Terminal;
  rows: Map<number, string>;
  row(n: number): string;
  reset(): void;
}

export function makeCaptureTerm(width: number, height: number): CaptureTerm {
  const rows = new Map<number, string>();
  let current = 1;

  const append = (text: string): void => {
    rows.set(current, (rows.get(current) ?? "") + text.replace(ANSI, ""));
  };

  const handler: ProxyHandler<(...args: unknown[]) => unknown> = {
    apply(_t, _this, args) {
      const first = args[0];
      if (typeof first === "string") append(first);
      return term;
    },
    get(_target, prop) {
      if (prop === "width") return width;
      if (prop === "height") return height;
      if (prop === "moveTo") {
        return (_x: number, y: number) => {
          current = y;
          return term;
        };
      }
      if (prop === "noFormat") {
        return (s: string) => {
          append(s);
          return term;
        };
      }
      if (prop === "on" || prop === "off") return () => undefined;
      return new Proxy(() => term, handler);
    },
  };

  const term = new Proxy(
    function noop() {} as (...args: unknown[]) => unknown,
    handler,
  ) as unknown as Terminal;

  return {
    term,
    rows,
    row: (n: number) => rows.get(n) ?? "",
    reset: () => {
      rows.clear();
      current = 1;
    },
  };
}
