import { describe, expect, it, vi } from "vitest";
import { rgb } from "./color.js";
import {
  hasOsc11,
  installOsc11Scrub,
  parseOsc11,
  scrubOsc11,
  senseBackground,
} from "./sense.js";

describe("parseOsc11", () => {
  // The form xterm and VTE actually send. Verified against gnome-terminal and
  // through tmux, both of which answer this.
  it("reads the 16-bit-per-channel form", () => {
    expect(parseOsc11("\u001b]11;rgb:0000/0000/0000\u0007")).toEqual(
      rgb(0, 0, 0),
    );
    expect(parseOsc11("\u001b]11;rgb:ffff/ffff/ffff\u0007")).toEqual(
      rgb(255, 255, 255),
    );
    expect(parseOsc11("\u001b]11;rgb:2828/2a2a/3636\u0007")).toEqual(
      rgb(40, 42, 54),
    );
  });

  it("reads the 8-bit and ST-terminated forms", () => {
    expect(parseOsc11("\u001b]11;rgb:28/2a/36\u001b\\")).toEqual(
      rgb(40, 42, 54),
    );
    expect(parseOsc11("\u001b]11;#282a36\u0007")).toEqual(rgb(40, 42, 54));
  });

  // Each component scales by its own width rather than being truncated to its
  // first two digits: "f" is full-scale at one digit, and 0x0f8 of 0xfff is not
  // 0x0f of 0xff.
  it("scales each component by its width", () => {
    expect(parseOsc11("\u001b]11;rgb:f/f/f\u0007")).toEqual(
      rgb(255, 255, 255),
    );
    expect(parseOsc11("\u001b]11;rgb:8/0/0\u0007")).toEqual(rgb(136, 0, 0));
  });

  it("finds a reply embedded in other input", () => {
    expect(
      parseOsc11("junk\u001b[Ax\u001b]11;rgb:0000/0000/0000\u0007more"),
    ).toEqual(rgb(0, 0, 0));
  });

  // A wrong answer is worse than none: it flips the direction bands are derived
  // in, so a dark terminal would get bands headed toward white.
  it("returns undefined rather than guessing", () => {
    expect(parseOsc11("")).toBeUndefined();
    expect(parseOsc11("\u001b]11;rgb:0000/0000/0000")).toBeUndefined(); // unterminated
    expect(parseOsc11("\u001b]11;nonsense\u0007")).toBeUndefined();
    expect(parseOsc11("\u001b]11;rgb:00/00\u0007")).toBeUndefined();
    expect(parseOsc11("\u001b]11;rgb:00000/0/0\u0007")).toBeUndefined();
    expect(parseOsc11("\u001b]10;rgb:0000/0000/0000\u0007")).toBeUndefined();
  });
});

describe("scrubOsc11", () => {
  // For a reply that lands after we stop listening, when the TUI owns stdin and
  // would otherwise decode it as a burst of keypresses into the composer.
  it("removes a reply and leaves the rest", () => {
    expect(scrubOsc11("a\u001b]11;rgb:0000/0000/0000\u0007b")).toBe("ab");
    expect(scrubOsc11("a\u001b]11;rgb:28/2a/36\u001b\\b")).toBe("ab");
  });

  it("leaves unrelated input alone", () => {
    expect(scrubOsc11("hello")).toBe("hello");
    expect(scrubOsc11("\u001b[A")).toBe("\u001b[A");
    expect(scrubOsc11("\u001b]8;;http://x\u0007link")).toBe(
      "\u001b]8;;http://x\u0007link",
    );
  });

  it("agrees with hasOsc11", () => {
    const reply = "\u001b]11;rgb:0000/0000/0000\u0007";
    expect(hasOsc11(reply)).toBe(true);
    expect(hasOsc11(scrubOsc11(reply))).toBe(false);
  });
});

/** A fake tty pair whose reply, if any, is delivered on the next tick. */
function fakeTty(reply?: string) {
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
        write: (s: string) => {
          calls.push(s);
          if (reply !== undefined) {
            setTimeout(() => {
              for (const fn of [...listeners]) {
                fn(reply);
              }
            }, 0);
          }
        },
      },
    },
  };
}

describe("senseBackground", () => {
  it("resolves the colour the terminal reports", async () => {
    const tty = fakeTty("\u001b]11;rgb:2828/2a2a/3636\u0007");
    await expect(senseBackground(tty.streams, 500)).resolves.toEqual(
      rgb(40, 42, 54),
    );
    expect(tty.calls).toEqual(["\u001b]11;?\u0007"]);
  });

  // The normal outcome for a terminal that does not implement OSC 11, so it has
  // to cost nothing but the timeout and must never fail startup.
  it("resolves undefined when nothing answers", async () => {
    const tty = fakeTty();
    await expect(senseBackground(tty.streams, 5)).resolves.toBeUndefined();
  });

  it("stops waiting early on a malformed reply", async () => {
    const tty = fakeTty("\u001b]11;nonsense\u0007");
    // Would take the full 10s if it waited out the timeout instead.
    await expect(senseBackground(tty.streams, 10_000)).resolves.toBeUndefined();
  });

  // Leaving raw mode on, or a listener attached, breaks the keyboard for the
  // real input handling that is set up immediately after this.
  it("restores the stream either way", async () => {
    for (const reply of ["\u001b]11;rgb:0/0/0\u0007", undefined]) {
      const tty = fakeTty(reply);
      await senseBackground(tty.streams, 5);
      expect(tty.rawAtEnd()).toBe(false);
      expect(tty.listenerCount()).toBe(0);
    }
  });

  it("does not query a non-tty", async () => {
    const tty = fakeTty("\u001b]11;rgb:0/0/0\u0007");
    tty.streams.input.isTTY = false;
    await expect(senseBackground(tty.streams, 5)).resolves.toBeUndefined();
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
    await expect(senseBackground(streams, 5)).resolves.toBeUndefined();
  });
});

describe("installOsc11Scrub", () => {
  const reply = "\u001b]11;rgb:0000/0000/0000\u0007";
  const fakeTerm = () => {
    const seen: string[] = [];
    return {
      seen,
      term: {
        onStdin(chunk: Buffer) {
          seen.push(chunk.toString("latin1"));
        },
      },
    };
  };

  it("drops a reply that arrives on its own", () => {
    const f = fakeTerm();
    installOsc11Scrub(f.term);
    f.term.onStdin(Buffer.from(reply, "latin1"));
    expect(f.seen).toEqual([]);
  });

  it("keeps real keystrokes in the same chunk", () => {
    const f = fakeTerm();
    installOsc11Scrub(f.term);
    f.term.onStdin(Buffer.from(`ab${reply}cd`, "latin1"));
    expect(f.seen).toEqual(["abcd"]);
  });

  it("passes unrelated input through untouched, bytes and all", () => {
    const f = fakeTerm();
    installOsc11Scrub(f.term);
    // Multi-byte UTF-8 must survive the latin1 round trip byte-for-byte.
    const bytes = Buffer.from("héllo→\u001b[A", "utf8");
    f.term.onStdin(bytes);
    expect(f.seen).toEqual([bytes.toString("latin1")]);
  });

  it("is a no-op on something without onStdin", () => {
    expect(() => installOsc11Scrub({})).not.toThrow();
    expect(() => installOsc11Scrub(undefined)).not.toThrow();
  });
});
