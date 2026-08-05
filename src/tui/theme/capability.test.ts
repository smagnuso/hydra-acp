import { describe, expect, it } from "vitest";
import {
  colorEnabled,
  depthForStream,
  depthForTerminal,
} from "./capability.js";

const tty = { isTTY: true };
const pipe = { isTTY: false };

describe("depthForStream", () => {
  it("reads COLORTERM for truecolor", () => {
    expect(depthForStream(tty, { COLORTERM: "truecolor" })).toBe("truecolor");
    expect(depthForStream(tty, { COLORTERM: "24bit" })).toBe("truecolor");
  });

  it("reads TERM for 256 and direct colour", () => {
    expect(depthForStream(tty, { TERM: "xterm-256color" })).toBe("ansi256");
    expect(depthForStream(tty, { TERM: "xterm-direct" })).toBe("truecolor");
    expect(depthForStream(tty, { TERM: "xterm-truecolor" })).toBe("truecolor");
  });

  it("falls back to 16 colours on a bare TERM", () => {
    expect(depthForStream(tty, { TERM: "xterm" })).toBe("ansi16");
    expect(depthForStream(tty, {})).toBe("ansi16");
  });

  it("emits nothing to a pipe", () => {
    expect(depthForStream(pipe, { TERM: "xterm-256color" })).toBe("none");
  });

  it("believes TERM=dumb even on a tty", () => {
    expect(depthForStream(tty, { TERM: "dumb" })).toBe("none");
  });

  describe("NO_COLOR", () => {
    it("disables colour when set to anything non-empty", () => {
      for (const v of ["1", "0", "true", "yes", " "]) {
        // Per no-color.org the VALUE is irrelevant — presence is the signal.
        // NO_COLOR=0 disabling colour looks wrong but is the spec.
        expect(depthForStream(tty, { NO_COLOR: v, COLORTERM: "truecolor" }), v).toBe(
          "none",
        );
      }
    });

    it("treats an empty value as unset", () => {
      expect(depthForStream(tty, { NO_COLOR: "", TERM: "xterm-256color" })).toBe(
        "ansi256",
      );
    });

    it("beats FORCE_COLOR", () => {
      // An explicit opt-out should not be overridable by tooling that sets
      // FORCE_COLOR for unrelated reasons.
      expect(
        depthForStream(pipe, { NO_COLOR: "1", FORCE_COLOR: "3" }),
      ).toBe("none");
    });
  });

  describe("FORCE_COLOR", () => {
    it("names a level directly", () => {
      expect(depthForStream(pipe, { FORCE_COLOR: "0" })).toBe("none");
      expect(depthForStream(pipe, { FORCE_COLOR: "1" })).toBe("ansi16");
      expect(depthForStream(pipe, { FORCE_COLOR: "2" })).toBe("ansi256");
      expect(depthForStream(pipe, { FORCE_COLOR: "3" })).toBe("truecolor");
    });

    it("beats the tty check, which is its purpose", () => {
      expect(
        depthForStream(pipe, { FORCE_COLOR: "1", TERM: "xterm-256color" }),
      ).toBe("ansi16");
    });

    it("without a level, turns colour on and lets the env pick depth", () => {
      expect(
        depthForStream(pipe, { FORCE_COLOR: "", COLORTERM: "truecolor" }),
      ).toBe("truecolor");
      expect(depthForStream(pipe, { FORCE_COLOR: "true", TERM: "xterm" })).toBe(
        "ansi16",
      );
    });
  });

  it("colorEnabled agrees with depthForStream", () => {
    expect(colorEnabled(tty, { TERM: "xterm-256color" })).toBe(true);
    expect(colorEnabled(pipe, { TERM: "xterm-256color" })).toBe(false);
    expect(colorEnabled(tty, { NO_COLOR: "1" })).toBe(false);
  });
});

describe("depthForTerminal", () => {
  // Shapes matching what terminal-kit exposes: `na` (not available) and `fb`
  // (fallback) both mean the capability is not really there.
  const t = (caps: Record<string, unknown>) => ({ esc: caps });

  it("takes terminal-kit's answer rather than redoing detection", () => {
    expect(depthForTerminal(t({ color24bits: {} }), {})).toBe("truecolor");
    expect(
      depthForTerminal(t({ color24bits: { fb: true }, color256: {} }), {}),
    ).toBe("ansi256");
    expect(
      depthForTerminal(
        t({ color24bits: { na: true }, color256: { na: true } }),
        {},
      ),
    ).toBe("ansi16");
  });

  it("ignores the environment's TERM, unlike the stream path", () => {
    // The TUI has a real terminal that already resolved a termconfig; matching
    // it is what keeps grayscale bands on the bytes they always emitted.
    expect(depthForTerminal(t({ color24bits: {} }), { TERM: "dumb" })).toBe(
      "truecolor",
    );
  });

  it("still honours NO_COLOR", () => {
    // The one rule that has to hold on every surface, TUI included.
    expect(
      depthForTerminal(t({ color24bits: {} }), { NO_COLOR: "1" }),
    ).toBe("none");
  });

  it("degrades safely when handed something without caps", () => {
    expect(depthForTerminal({}, {})).toBe("ansi16");
    expect(depthForTerminal(undefined, {})).toBe("ansi16");
  });
});

describe("depthForTerminal honours COLORTERM on top of terminal-kit", () => {
  // terminal-kit decides 24-bit from TERM alone and predates COLORTERM, so it
  // says no to almost every terminal that can actually do it:
  //   xterm-256color false, screen false, xterm-direct false, xterm-truecolor true
  // Deferring to it alone meant every theme rendered as a 256-colour
  // approximation on gnome-terminal, kitty, wezterm, iTerm2 — dracula's #6272a4
  // arriving as #5f5faf. Close enough to look deliberate, wrong enough to look off.
  const with256 = { esc: { color256: {}, color24bits: { na: true } } };
  const with24 = { esc: { color24bits: {} } };
  const only16 = { esc: { color256: { na: true }, color24bits: { na: true } } };

  it("upgrades a 256-colour terminal that advertises truecolor", () => {
    expect(depthForTerminal(with256, { COLORTERM: "truecolor" })).toBe("truecolor");
    expect(depthForTerminal(with256, { COLORTERM: "24bit" })).toBe("truecolor");
  });

  it("leaves it at 256 with no COLORTERM", () => {
    expect(depthForTerminal(with256, {})).toBe("ansi256");
  });

  it("never upgrades a terminal that cannot even do 256", () => {
    // An env var is not grounds for emitting 24-bit at something terminal-kit
    // says has neither capability.
    expect(depthForTerminal(only16, { COLORTERM: "truecolor" })).toBe("ansi16");
  });

  it("still trusts terminal-kit when it says yes", () => {
    expect(depthForTerminal(with24, {})).toBe("truecolor");
  });

  describe("inside tmux", () => {
    // COLORTERM there describes the OUTER terminal. tmux forwards the variable
    // whether or not it forwards the escapes, and an unconfigured tmux reports
    // `RGB: [missing]` / `Tc: [missing]`.
    it("withholds the upgrade for the default screen* TERM", () => {
      expect(
        depthForTerminal(with256, {
          COLORTERM: "truecolor",
          TMUX: "/tmp/tmux-1000/default,123,0",
          TERM: "screen",
        }),
      ).toBe("ansi256");
    });

    it("allows it once TERM says someone configured passthrough", () => {
      expect(
        depthForTerminal(with256, {
          COLORTERM: "truecolor",
          TMUX: "/tmp/tmux-1000/default,123,0",
          TERM: "tmux-256color",
        }),
      ).toBe("truecolor");
    });

    // The bug: terminal-kit reports `color256: { fb: true }` for TERM=screen,
    // and `fb` was being read as "cannot", which sent the whole TUI to 4-bit
    // inside tmux. Every themed colour then went through quantize16, where
    // dracula's grey code band tied with dark cyan and lost — a cyan stripe
    // across every fenced block, which is what put us here.
    it("floors at 256 for a screen TERM, which understates tmux", () => {
      const screenLike = {
        esc: { color256: { fb: true }, color24bits: { na: true } },
      };
      expect(
        depthForTerminal(screenLike, {
          TMUX: "/tmp/tmux-1000/default,123,0",
          TERM: "screen",
        }),
      ).toBe("ansi256");
      // ...and with COLORTERM forwarded from the outer terminal it stays at
      // 256 rather than being upgraded, since this tmux will not pass 24-bit.
      expect(
        depthForTerminal(screenLike, {
          TMUX: "/tmp/tmux-1000/default,123,0",
          TERM: "screen",
          COLORTERM: "truecolor",
        }),
      ).toBe("ansi256");
    });

    it("is unaffected outside tmux even with a screen TERM", () => {
      expect(
        depthForTerminal(with256, { COLORTERM: "truecolor", TERM: "screen" }),
      ).toBe("truecolor");
    });
  });

  it("NO_COLOR still wins over everything", () => {
    expect(
      depthForTerminal(with24, { NO_COLOR: "1", COLORTERM: "truecolor" }),
    ).toBe("none");
  });
});
