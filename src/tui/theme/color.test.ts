import { afterEach, describe, expect, it } from "vitest";
import {
  ansi,
  band,
  bgOpen,
  contrastRatio,
  setSensedPalette,
  quantizeGrey16,
  type Color,
  brighten,
  darken,
  fgOpen,
  isDark,
  lighten,
  luminance,
  mix,
  parseColor,
  quantize16,
  quantize256,
  rgb,
} from "./color.js";

describe("ansi slots emit the legacy codes", () => {
  // Not 38;5;n: the legacy codes are what a terminal maps to the user's own
  // configured palette, and what the pre-theme code emitted.
  it("maps 0-7 to 30-37 / 40-47", () => {
    expect(fgOpen(ansi(0), "truecolor")).toBe("\x1b[30m");
    expect(fgOpen(ansi(1), "ansi256")).toBe("\x1b[31m");
    expect(fgOpen(ansi(7), "truecolor")).toBe("\x1b[37m");
    expect(bgOpen(ansi(4), "truecolor")).toBe("\x1b[44m");
    expect(bgOpen(ansi(7), "ansi256")).toBe("\x1b[47m");
  });

  it("maps 8-15 to 90-97 / 100-107", () => {
    expect(fgOpen(ansi(8), "truecolor")).toBe("\x1b[90m");
    expect(fgOpen(ansi(11), "truecolor")).toBe("\x1b[93m");
    expect(fgOpen(ansi(15), "ansi256")).toBe("\x1b[97m");
    expect(bgOpen(ansi(11), "truecolor")).toBe("\x1b[103m");
  });

  it("ignores colour depth, since the terminal owns these", () => {
    expect(fgOpen(ansi(9), "truecolor")).toBe(fgOpen(ansi(9), "ansi256"));
  });
});

describe("rgb emission", () => {
  it("emits 24-bit when the terminal takes it", () => {
    expect(fgOpen(rgb(255, 110, 103), "truecolor")).toBe("\x1b[38;2;255;110;103m");
    expect(bgOpen(rgb(40, 42, 54), "truecolor")).toBe("\x1b[48;2;40;42;54m");
  });

  it("quantises to the 256 cube otherwise", () => {
    expect(fgOpen(rgb(255, 0, 0), "ansi256")).toBe("\x1b[38;5;196m");
    expect(bgOpen(rgb(0, 0, 0), "ansi256")).toBe("\x1b[48;5;16m");
  });
});

describe("quantize256", () => {
  it("hits exact cube corners", () => {
    expect(quantize256(rgb(0, 0, 0))).toBe(16);
    expect(quantize256(rgb(255, 255, 255))).toBe(231);
    expect(quantize256(rgb(255, 0, 0))).toBe(196);
  });

  it("prefers the gray ramp for near-grays", () => {
    // The cube's gray diagonal is coarse; #808080 lands better on the ramp.
    const idx = quantize256(rgb(128, 128, 128));
    expect(idx).toBeGreaterThanOrEqual(232);
    expect(idx).toBeLessThanOrEqual(255);
  });

  it("stays in range for every channel combination it is given", () => {
    for (const v of [0, 1, 47, 95, 128, 214, 255]) {
      const i = quantize256(rgb(v, 255 - v, (v * 7) % 256));
      expect(i).toBeGreaterThanOrEqual(16);
      expect(i).toBeLessThanOrEqual(255);
    }
  });
});

describe("parseColor", () => {
  it("accepts the shapes a theme file would use", () => {
    expect(parseColor("#282a36")).toEqual(rgb(40, 42, 54));
    expect(parseColor("#FFF")).toEqual(rgb(255, 255, 255));
    expect(parseColor("  #f8f8f2  ")).toEqual(rgb(248, 248, 242));
    expect(parseColor("rgb(255, 85, 85)")).toEqual(rgb(255, 85, 85));
  });

  it("returns null rather than guessing", () => {
    // A malformed theme should be reportable, not silently black.
    for (const bad of ["", "#12", "#1234", "red", "#gggggg", "rgb(1,2)"]) {
      expect(parseColor(bad), bad).toBeNull();
    }
  });
});

describe("derivation", () => {
  it("luminance is null for ansi, since the terminal decides", () => {
    expect(luminance(ansi(0))).toBeNull();
    expect(luminance(rgb(0, 0, 0))).toBe(0);
    expect(luminance(rgb(255, 255, 255))).toBeCloseTo(1, 5);
  });

  it("isDark separates a dark theme bg from a light one", () => {
    expect(isDark(rgb(40, 42, 54))).toBe(true); // dracula bg
    expect(isDark(rgb(253, 246, 227))).toBe(false); // solarized light bg
  });

  it("brighten defers to the terminal's own bright slot for ansi", () => {
    // Better than computing: the user already chose their bright red.
    expect(brighten(ansi(1))).toEqual(ansi(9));
    expect(brighten(ansi(9))).toEqual(ansi(9));
  });

  it("brighten lightens an explicit colour", () => {
    const b = brighten(rgb(100, 0, 0)) as { r: number };
    expect(b.r).toBeGreaterThan(100);
  });

  it("lighten and darken move the right way and clamp", () => {
    expect(lighten(rgb(0, 0, 0), 1)).toEqual(rgb(255, 255, 255));
    expect(darken(rgb(255, 255, 255), 1)).toEqual(rgb(0, 0, 0));
    expect(lighten(rgb(10, 10, 10), 0)).toEqual(rgb(10, 10, 10));
  });

  it("mix interpolates", () => {
    expect(mix(rgb(0, 0, 0), rgb(100, 200, 40), 0.5)).toEqual(rgb(50, 100, 20));
  });

  it("derivation leaves ansi colours alone", () => {
    // There is no value to compute on, so the honest answer is "unchanged"
    // rather than a fabricated one.
    for (const f of [lighten, darken] as const) {
      expect(f(ansi(3), 0.5)).toEqual(ansi(3));
    }
    expect(band(ansi(0), 0.1)).toEqual(ansi(0));
  });
});

describe("band", () => {
  // The rule that makes a light theme work from one key.
  it("lifts away from a dark background", () => {
    const b = band(rgb(40, 42, 54), 0.1) as { r: number };
    expect(b.r).toBeGreaterThan(40);
  });

  it("lifts away from a light background too, i.e. downward", () => {
    const b = band(rgb(253, 246, 227), 0.1) as { r: number };
    expect(b.r).toBeLessThan(253);
  });
});

describe("a sparse theme fills itself in", () => {
  // The property that makes a two-key theme viable: name `bg` and the bands
  // derive, in the right direction, on both a dark and a light theme. These
  // are real palettes rather than synthetic values because the failure mode is
  // subtle — a light theme whose bands head toward white looks fine in a unit
  // test and invisible on screen.
  const cases = [
    { name: "dracula", bg: "#282a36", dark: true },
    { name: "solarized-light", bg: "#fdf6e3", dark: false },
  ] as const;

  for (const c of cases) {
    it(`${c.name}: bands step away from the background`, () => {
      const bg = parseColor(c.bg)!;
      expect(isDark(bg)).toBe(c.dark);
      const b1 = band(bg, 0.06) as { r: number; g: number; b: number };
      const b2 = band(bg, 0.12) as { r: number; g: number; b: number };
      const base = bg as { r: number };
      if (c.dark) {
        expect(b1.r).toBeGreaterThan(base.r);
        expect(b2.r).toBeGreaterThan(b1.r);
      } else {
        expect(b1.r).toBeLessThan(base.r);
        expect(b2.r).toBeLessThan(b1.r);
      }
    });

    it(`${c.name}: bands stay distinguishable after 256-colour quantisation`, () => {
      // A band that quantises onto the same index as the background is
      // invisible — the failure the grayscale ramp exists to avoid.
      const bg = parseColor(c.bg)!;
      const bgIdx = quantize256(bg as never);
      const b1Idx = quantize256(band(bg, 0.06) as never);
      const b2Idx = quantize256(band(bg, 0.12) as never);
      expect(b1Idx).not.toBe(bgIdx);
      expect(b2Idx).not.toBe(b1Idx);
    });
  }

  it("a derived bright colour differs from its base at both depths", () => {
    const red = parseColor("#dc322f")!;
    const bright = brighten(red);
    expect(fgOpen(bright, "truecolor")).not.toBe(fgOpen(red, "truecolor"));
    expect(quantize256(bright as never)).not.toBe(quantize256(red as never));
  });
});

describe("quantize16", () => {
  // The bug this exists for: dracula's code band, #40414c, is a grey with a
  // faint blue cast. Nearest-RGB across all sixteen slots ties it exactly
  // between bright black (128,128,128) and dark cyan (0,128,128) — both at
  // squared error 10769 — and index order handed it to cyan. A grey band
  // rendered as a saturated cyan stripe across every fenced code block.
  it("keeps a near-grey grey instead of finding a hue", () => {
    for (const c of [
      rgb(0x40, 0x41, 0x4c), // the dracula code band
      rgb(0x4d, 0x4e, 0x58), // the dracula user band
      rgb(0x2e, 0x34, 0x40), // nord's background
      rgb(0x28, 0x2a, 0x36), // dracula's background
      rgb(0x3b, 0x42, 0x52),
    ]) {
      expect([0, 8, 7, 15]).toContain(quantize16(c));
    }
  });

  it("still finds the hue when there is one", () => {
    expect(quantize16(rgb(255, 0, 0))).toBe(9);
    expect(quantize16(rgb(0, 255, 255))).toBe(14);
    expect(quantize16(rgb(0, 128, 128))).toBe(6);
    expect(quantize16(rgb(128, 0, 0))).toBe(1);
  });

  // Nearest-RGB sent all five of these to a grey or a white, because a pastel
  // sits nearer the middle of the cube than any of its corners. The palette
  // survived as luminance and nothing else.
  it("keeps a pastel palette distinguishable", () => {
    expect(quantize16(rgb(0x8b, 0xe9, 0xfd))).toBe(14); // dracula cyan
    // Bright blue, not magenta: dracula's own ANSI mapping puts this purple in
    // the blue slot too.
    expect(quantize16(rgb(0xbd, 0x93, 0xf9))).toBe(12);
    expect(quantize16(rgb(0x50, 0xfa, 0x7b))).toBe(10); // dracula green
    expect(quantize16(rgb(0xf1, 0xfa, 0x8c))).toBe(11); // dracula yellow
    expect(quantize16(rgb(0xff, 0x79, 0xc6))).toBe(13); // dracula pink
    expect(quantize16(rgb(0xff, 0x55, 0x55))).toBe(9); // dracula red
  });

  it("maps the greys across the range", () => {
    expect(quantize16(rgb(0, 0, 0))).toBe(0);
    expect(quantize16(rgb(255, 255, 255))).toBe(15);
    expect(quantize16(rgb(130, 130, 130))).toBe(8);
    expect(quantize16(rgb(195, 195, 195))).toBe(7);
  });
});

describe("isDark tracks which foreground actually reads better", () => {
  // The invariant, not the constant: isDark decides band direction, which theme
  // to default to, and whether to warn about a mismatch — and in every one of
  // those the real question is "does white text or black text win here". So this
  // derives the expected answer from WCAG contrast instead of restating the
  // threshold, and would catch the number being wrong rather than just changed.
  const winner = (c: Color): boolean => {
    const l = luminance(c)!;
    return (1.05 / (l + 0.05)) > ((l + 0.05) / 0.05);
  };

  it("agrees with the contrast winner across the whole grey ramp", () => {
    const disagreements: string[] = [];
    for (let g = 0; g <= 255; g++) {
      const c = rgb(g, g, g);
      if (isDark(c) !== winner(c)) {
        disagreements.push(`#${g.toString(16).padStart(2, "0").repeat(3)}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("agrees on saturated colours too, not just greys", () => {
    for (const c of [
      rgb(0, 0, 255), // deep blue: dark despite being a "bright" colour
      rgb(255, 255, 0), // yellow: light despite being vivid
      rgb(0, 128, 0),
      rgb(255, 128, 0),
      rgb(128, 0, 128),
    ]) {
      expect(isDark(c), JSON.stringify(c)).toBe(winner(c));
    }
  });

  // The range the old 0.5 threshold got wrong: mid greys where black text has
  // nearly twice the contrast were being called dark.
  it("calls mid greys light", () => {
    expect(isDark(rgb(0x80, 0x80, 0x80))).toBe(false);
    expect(isDark(rgb(0x96, 0x96, 0x96))).toBe(false);
    expect(isDark(rgb(0x6e, 0x6e, 0x6e))).toBe(true);
  });

  // The terminal owns its ansi slots and we cannot know what it made of them.
  it("defers on an ansi slot", () => {
    expect(isDark(ansi(0), true)).toBe(true);
    expect(isDark(ansi(0), false)).toBe(false);
  });
});

describe("band backs off to keep its text readable", () => {
  // A band moves the background toward the text sitting on it, so every step of
  // lift costs contrast. Without knowing the text colour the step is a guess
  // tuned against one terminal; with OSC 10 it can be checked.
  const ratio = (a: Color, b: Color): number => contrastRatio(a, b)!;

  it("uses the full step when the text is far away", () => {
    const bg = rgb(0, 0, 0);
    expect(band(bg, 0.11, rgb(255, 255, 255))).toEqual(band(bg, 0.11));
  });

  it("reduces the lift when the text would be swallowed", () => {
    // Dim grey text on black: the full 0.17 lift would leave under 4:1.
    const bg = rgb(0, 0, 0);
    const text = rgb(120, 120, 120);
    const unaware = band(bg, 0.17);
    const aware = band(bg, 0.17, text);
    expect(ratio(unaware, text)).toBeLessThan(4);
    expect(ratio(aware, text)).toBeGreaterThanOrEqual(4);
  });

  it("never increases the lift", () => {
    // The step is a design decision about how loud a band is; this is a floor
    // under it, not a replacement for it.
    for (const text of [rgb(255, 255, 255), rgb(200, 200, 200), rgb(90, 90, 90)]) {
      const bg = rgb(20, 20, 24);
      const aware = band(bg, 0.11, text);
      const unaware = band(bg, 0.11);
      expect(luminance(aware)!).toBeLessThanOrEqual(luminance(unaware)! + 1e-9);
    }
  });

  it("is a no-op for an ansi background, which has no measurable value", () => {
    expect(band(ansi(0), 0.11, rgb(255, 255, 255))).toEqual(ansi(0));
  });

  it("leaves a themed palette's bands alone — see bandTextColor", () => {
    // The clamp is for the case where we defer to the terminal's foreground.
    expect(band(rgb(0, 0, 0), 0.17)).toEqual(rgb(43, 43, 43));
  });
});

describe("a sensed palette replaces the assumption quantize16 was making", () => {
  // gnome-terminal's actual answer to OSC 4, captured from a real session. Kept
  // verbatim because the point is that it differs from xterm's defaults in the
  // way that mattered: slot 6 here is #2aa1b3, not the assumed (0,128,128).
  const GNOME = new Map<number, Color>(
    (
      [
        "#171421", "#c01c28", "#26a269", "#a2734c",
        "#12488b", "#a347ba", "#2aa1b3", "#d0cfcc",
        "#5e5c64", "#f66151", "#33da7a", "#e9ad0c",
        "#2a7bde", "#c061cb", "#33c7de", "#ffffff",
      ] as const
    ).map((h, i) => [i, parseColor(h)!]),
  );

  afterEach(() => setSensedPalette(undefined));

  // The bug that started all of this. #40414c is dracula's code band, and against
  // xterm's DEFAULTS it ties exactly — 10769 both ways — between bright black and
  // dark cyan, with index order handing it to cyan. Every fenced code block wore
  // an ESC[46m stripe.
  //
  // Against the terminal's real palette there is no tie to lose: slot 8 wins at
  // 2205 and slot 6 is not close. Asking beats assuming.
  it("cannot reproduce the cyan band once the palette is known", () => {
    const codeBand = rgb(0x40, 0x41, 0x4c);
    setSensedPalette(GNOME);
    expect(quantize16(codeBand)).toBe(8);
    expect(quantizeGrey16(codeBand)).toBe(8);
  });

  it("still finds the right hue for a saturated colour", () => {
    setSensedPalette(GNOME);
    expect(quantize16(rgb(0x50, 0xfa, 0x7b))).toBe(10); // dracula green
    expect(quantize16(rgb(0xff, 0x55, 0x55))).toBe(9); // dracula red
    expect(quantize16(rgb(0x8b, 0xe9, 0xfd))).toBe(14); // dracula cyan
  });

  // A terminal that answers for some slots and not others must not lose the
  // others entirely — an unanswered slot falls back to the xterm default.
  it("tolerates a partial answer", () => {
    setSensedPalette(new Map([[6, parseColor("#2aa1b3")!]]));
    expect(quantize16(rgb(0x40, 0x41, 0x4c))).toBe(8);
  });

  // tmux forwards OSC 10 and 11 but answers nothing for OSC 4, so this is the
  // live path for anyone inside it.
  it("falls back to the hue heuristic when nothing was sensed", () => {
    setSensedPalette(undefined);
    expect(quantize16(rgb(0x50, 0xfa, 0x7b))).toBe(10);
    expect([0, 8, 7, 15]).toContain(quantize16(rgb(0x40, 0x41, 0x4c)));
  });
});
