// Terminal-mode escapes must not outlive the process that set them.
//
// These sequences mutate state in the TERMINAL, so an enable without its
// matching disable leaks past exit into whatever ran us. Two that bit the
// test suite itself: Screen.start() enabled focus reporting (?1004h) and
// disabled auto-wrap (?7l) on the real stdout, past the injected mock
// `term`. Every test file that started a Screen without stopping it left
// the developer's terminal reporting focus changes into vitest's stdin
// and clipping the reporter's own output at the right margin, so a
// running suite was indistinguishable from a hung one.
//
// Two invariants, then: writes route through the swappable sink (so
// vitest.setup.ts can discard them), and start/stop is symmetric.

import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "terminal-kit";
import { setControlWriter, writeControl } from "./ansi.js";
import type { InputDispatcher } from "./input.js";
import { Screen } from "./screen.js";

/** Captures mode writes for the duration of `fn`. */
function capture(fn: () => void): string {
  const chunks: string[] = [];
  const previous = setControlWriter((seq) => chunks.push(seq));
  try {
    fn();
  } finally {
    setControlWriter(previous);
  }
  return chunks.join("");
}

function makeScreen(): Screen {
  const handler: ProxyHandler<(...args: unknown[]) => unknown> = {
    apply: () => term,
    get(_target, prop) {
      if (prop === "width") return 10;
      if (prop === "height") return 10;
      if (prop === "on" || prop === "off") return () => undefined;
      return new Proxy(() => term, handler);
    },
  };
  const term = new Proxy(
    function noop() {} as (...args: unknown[]) => unknown,
    handler,
  ) as unknown as Terminal;
  const dispatcher = {
    state: () => ({
      buffer: [""],
      row: 0,
      col: 0,
      planMode: false,
      historyIndex: -1,
      queueIndex: -1,
      attachments: [],
      historySearchQuery: null,
    }),
  } as unknown as InputDispatcher;
  return new Screen({
    term,
    dispatcher,
    onKey: () => {},
    repaintThrottleMs: 0,
    progressIndicator: false,
    mouse: false,
    turnSlide: false,
  });
}

/** Every `CSI ? <n> h` in `seq`, in order. */
function modesEnabled(seq: string): string[] {
  return [...seq.matchAll(/\x1b\[\?(\d+)h/g)].map((m) => m[1]!);
}

/** Every `CSI ? <n> l` in `seq`, in order. */
function modesDisabled(seq: string): string[] {
  return [...seq.matchAll(/\x1b\[\?(\d+)l/g)].map((m) => m[1]!);
}

describe("terminal-mode writes", () => {
  it("go to the installed writer, not straight to stdout", () => {
    const spy = vi.spyOn(process.stdout, "write");
    try {
      const out = capture(() => writeControl("\x1b[?1004h"));
      expect(out).toBe("\x1b[?1004h");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("reach stdout again once the writer is uninstalled", () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      setControlWriter(null);
      writeControl("\x1b[?1004l");
      expect(spy).toHaveBeenCalledWith("\x1b[?1004l");
    } finally {
      spy.mockRestore();
      setControlWriter(() => {});
    }
  });

  it("leave no DEC private mode set after a screen start/stop round trip", () => {
    const screen = makeScreen();
    const startSeq = capture(() => screen.start());
    const stopSeq = capture(() => screen.stop());
    // The invariant runs one way only: everything start() turned on has
    // to come back off. The reverse does not hold, deliberately — stop()
    // also disables modes it never enabled (terminal-kit's grabInput
    // leaves SGR mouse on and never clears it) and re-enables host
    // defaults it never took away (cursor visible, auto-wrap).
    const leftOn = modesEnabled(startSeq).filter(
      (m) => !modesDisabled(stopSeq).includes(m),
    );
    expect(leftOn).toEqual([]);
    // Guard the guard: if start() ever stops writing through the control
    // writer, the filter above passes vacuously.
    expect(modesEnabled(startSeq)).toContain("1004");
    expect(modesEnabled(startSeq)).toContain("2004");
  });

  it("restore auto-wrap on the way out, having disabled it on the way in", () => {
    const screen = makeScreen();
    const out = capture(() => {
      screen.start();
      screen.stop();
    });
    expect(out).toContain("\x1b[?7l");
    expect(out.lastIndexOf("\x1b[?7h")).toBeGreaterThan(
      out.indexOf("\x1b[?7l"),
    );
  });

  it("pop the kitty keyboard stack as many times as they pushed it", () => {
    const screen = makeScreen();
    const out = capture(() => {
      screen.start();
      screen.stop();
    });
    const pushes = out.split("\x1b[>1u").length - 1;
    const pops = out.split("\x1b[<u").length - 1;
    expect(pops).toBeGreaterThanOrEqual(pushes);
  });
});
