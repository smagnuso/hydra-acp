import { describe, expect, it, vi } from "vitest";
import {
  buildProbeSequence,
  hasCprReport,
  isAmbiguousWide,
  parseCprReports,
  probeAmbiguousWidth,
  PROBE_GLYPHS,
  scrubCprReports,
  widthsFromReports,
} from "./width-probe.js";

describe("buildProbeSequence", () => {
  // N glyphs need N+1 measurements: one baseline plus one after each glyph, so
  // the deltas can be attributed pairwise.
  it("brackets every glyph with a cursor position query", () => {
    expect(buildProbeSequence(["a", "b"])).toBe(
      "\n\r\u001b[6n" + "a\u001b[6n" + "b\u001b[6n" + "\r\u001b[K",
    );
  });

  // Batched rather than one round trip per glyph: terminals answer CPRs in
  // order, so the whole table costs a single wait.
  it("asks once per glyph in a single sequence", () => {
    const seq = buildProbeSequence();
    expect(seq.match(/\u001b\[6n/g)).toHaveLength(PROBE_GLYPHS.length + 1);
  });

  // A terminal that ignores CPR still must not be left with the probe glyphs
  // printed into the user's scrollback. The leading newline matters too: the
  // trailing erase must not wipe a line something else printed.
  it("draws on a fresh line at a known column and erases itself", () => {
    const seq = buildProbeSequence();
    expect(seq.startsWith("\n\r")).toBe(true);
    expect(seq.endsWith("\r\u001b[K")).toBe(true);
  });
});

describe("parseCprReports", () => {
  it("reads every reply in order", () => {
    expect(parseCprReports("\u001b[5;1R\u001b[5;3R")).toEqual([
      [5, 1],
      [5, 3],
    ]);
  });

  it("finds replies embedded in other input", () => {
    expect(parseCprReports("x\u001b[12;40Ry")).toEqual([[12, 40]]);
  });

  it("ignores anything that is not a CPR", () => {
    expect(parseCprReports("")).toEqual([]);
    expect(parseCprReports("\u001b[A")).toEqual([]);
    // Unterminated, and the DSR request rather than its reply.
    expect(parseCprReports("\u001b[5;1")).toEqual([]);
    expect(parseCprReports("\u001b[6n")).toEqual([]);
  });
});

describe("scrubCprReports", () => {
  it("removes replies and leaves the rest", () => {
    expect(scrubCprReports("a\u001b[5;1Rb\u001b[5;3Rc")).toBe("abc");
  });

  it("leaves unrelated input alone", () => {
    expect(scrubCprReports("hello")).toBe("hello");
    expect(scrubCprReports("\u001b[A")).toBe("\u001b[A");
  });

  it("agrees with hasCprReport", () => {
    expect(hasCprReport("\u001b[5;1R")).toBe(true);
    expect(hasCprReport(scrubCprReports("\u001b[5;1R"))).toBe(false);
    expect(hasCprReport("plain")).toBe(false);
  });
});

describe("widthsFromReports", () => {
  it("attributes each column delta to its glyph", () => {
    const widths = widthsFromReports(
      [
        [1, 1],
        [1, 3],
        [1, 4],
      ],
      ["wide", "narrow"],
    );
    expect(widths).toEqual({ wide: 2, narrow: 1 });
  });

  // A partly-wrong table is worse than none: the fallback heuristic is at least
  // self-consistent, so every suspect measurement rejects the whole run.
  it("rejects a measurement it cannot trust", () => {
    // Too few replies to attribute.
    expect(widthsFromReports([[1, 1]], ["a", "b"])).toBeUndefined();
    // The line wrapped, so the column delta is meaningless.
    expect(
      widthsFromReports(
        [
          [1, 80],
          [2, 1],
        ],
        ["a"],
      ),
    ).toBeUndefined();
    // Deltas outside 1..2 mean we are not reading what we think we are.
    expect(
      widthsFromReports(
        [
          [1, 1],
          [1, 1],
        ],
        ["a"],
      ),
    ).toBeUndefined();
    expect(
      widthsFromReports(
        [
          [1, 1],
          [1, 9],
        ],
        ["a"],
      ),
    ).toBeUndefined();
  });
});

describe("isAmbiguousWide", () => {
  it("takes the majority", () => {
    expect(isAmbiguousWide({ a: 2, b: 2, c: 1 })).toBe(true);
    expect(isAmbiguousWide({ a: 2, b: 1, c: 1 })).toBe(false);
  });

  // Over-counting shrinks every budget in the TUI and truncates rules at half
  // width, so an even split is resolved the less damaging way.
  it("breaks ties narrow", () => {
    expect(isAmbiguousWide({ a: 2, b: 1 })).toBe(false);
    expect(isAmbiguousWide({})).toBe(false);
  });
});

/**
 * A fake tty that answers the probe by walking the cursor `perGlyph` columns per
 * glyph, the way a real terminal would.
 */
function fakeTty(perGlyph?: number, glyphCount = PROBE_GLYPHS.length) {
  const listeners: Array<(chunk: Buffer | string) => void> = [];
  const calls: string[] = [];
  let raw: boolean | undefined;
  return {
    calls,
    rawAtEnd: (): boolean | undefined => raw,
    listenerCount: (): number => listeners.length,
    streams: {
      input: {
        isTTY: true,
        setRawMode: (mode: boolean) => {
          raw = mode;
        },
        on: (_e: "data", fn: (chunk: Buffer | string) => void) => {
          listeners.push(fn);
        },
        off: (_e: "data", fn: (chunk: Buffer | string) => void) => {
          const i = listeners.indexOf(fn);
          if (i >= 0) {
            listeners.splice(i, 1);
          }
        },
        resume: () => undefined,
        pause: () => undefined,
        isPaused: () => false,
      },
      output: {
        isTTY: true,
        columns: 80,
        write: (s: string) => {
          calls.push(s);
          if (perGlyph === undefined) {
            return;
          }
          let reply = "";
          for (let i = 0; i <= glyphCount; i++) {
            reply += `\u001b[3;${1 + i * perGlyph}R`;
          }
          setTimeout(() => {
            for (const fn of [...listeners]) {
              fn(reply);
            }
          }, 0);
        },
      },
    },
  };
}

describe("probeAmbiguousWidth", () => {
  it("reports narrow when the cursor advances one column per glyph", async () => {
    const tty = fakeTty(1);
    const result = await probeAmbiguousWidth(tty.streams, 500);
    expect(result?.wide).toBe(false);
    expect(result?.widths["─"]).toBe(1);
  });

  // The case this exists for: a terminal drawing box-drawing glyphs double-wide,
  // which under the old TERM_PROGRAM guess was assumed rather than measured.
  it("reports wide when the cursor advances two columns per glyph", async () => {
    const tty = fakeTty(2);
    const result = await probeAmbiguousWidth(tty.streams, 500);
    expect(result?.wide).toBe(true);
    expect(result?.widths["─"]).toBe(2);
  });

  // The normal outcome for a terminal without CPR, so it must cost nothing but
  // the timeout and never fail startup.
  it("resolves undefined when nothing answers", async () => {
    const tty = fakeTty();
    await expect(probeAmbiguousWidth(tty.streams, 5)).resolves.toBeUndefined();
  });

  // Leaving raw mode on, or a listener attached, breaks the keyboard for the
  // real input handling set up immediately after this.
  it("restores the stream either way", async () => {
    for (const perGlyph of [1, undefined]) {
      const tty = fakeTty(perGlyph);
      await probeAmbiguousWidth(tty.streams, 5);
      expect(tty.rawAtEnd()).toBe(false);
      expect(tty.listenerCount()).toBe(0);
    }
  });

  it("does not query a non-tty", async () => {
    const tty = fakeTty(1);
    tty.streams.input.isTTY = false;
    await expect(probeAmbiguousWidth(tty.streams, 5)).resolves.toBeUndefined();
    expect(tty.calls).toEqual([]);
  });

  // On a terminal too narrow to hold the probe line the glyphs would wrap and
  // the deltas would be rejected anyway, so skip the round trip.
  it("does not query a terminal too narrow for the probe line", async () => {
    const tty = fakeTty(1);
    tty.streams.output.columns = 3;
    await expect(probeAmbiguousWidth(tty.streams, 5)).resolves.toBeUndefined();
    expect(tty.calls).toEqual([]);
  });

  it("survives a stream that throws", async () => {
    const spy = vi.fn();
    const streams = {
      input: {
        isTTY: true,
        setRawMode: () => {
          throw new Error("no");
        },
        on: spy,
      },
      output: { isTTY: true, write: spy },
    };
    await expect(probeAmbiguousWidth(streams, 5)).resolves.toBeUndefined();
  });
});
