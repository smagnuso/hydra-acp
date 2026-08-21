// Characterization test for writeStyled.
//
// This does not assert that any particular colour is *correct* — it pins the
// bytes currently emitted for every Style, in both hover states, at both
// colour depths. The point is to make the theme refactor (which replaces
// terminal-kit style chains with explicit SGR pairs) provably
// output-preserving: if a snapshot moves, the refactor changed rendering.
//
// Recorded against the pre-refactor implementation. Do not re-record to make
// a failure go away without understanding which style changed and why.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeStyled } from "../screen.js";
import type { Style } from "../format.js";
import { createCapturingTerminal, visible, isolateColorEnv } from "./capture.js";
import { bgGrayscale, styleCarriesInlineSgr } from "./index.js";

// The `generic` passed below is meant to pin colour depth; ambient COLORTERM
// would otherwise override it. See isolateColorEnv.
let restoreColorEnv: () => void;
beforeEach(() => {
  restoreColorEnv = isolateColorEnv();
});
afterEach(() => {
  restoreColorEnv();
});

// Every member of the Style union, plus `undefined` for the default arm.
const ALL_STYLES: (Style | undefined)[] = [
  "user",
  "agent",
  "thought",
  "tool",
  "tool-status-ok",
  "tool-status-fail",
  "tool-status-pending",
  "tool-status-running",
  "tool-status-cancelled",
  "plan",
  "plan-done",
  "plan-pending",
  "local-heading",
  "local-item",
  "notice",
  "notice-ok",
  "notice-error",
  "metric",
  "muted",
  "tool-output",
  "status-ready",
  "status-idle",
  "status-active",
  "status-blocked",
  "status-queued",
  "status-alert",
  "status-cold",
  "git-staged",
  "git-dirty",
  "git-untracked",
  "file-path",
  "meter-fill",
  "meter-warn",
  "sidebar-rule",
  "sidebar-title",
  "code",
  "heading-1",
  "heading-2",
  "heading-3",
  "search-highlight",
  "search-highlight-active",
  "selection-highlight",
  undefined,
];

// Plain text, text carrying an inline SGR span, and text carrying literal
// carets.
//
// The caret cases are the interesting ones. They used to be markup: a subset
// of styles routed through terminal-kit's interpreter, which turned "^C" into
// a colour and collapsed "^^" to one caret. format.ts now emits SGR directly
// and nothing interprets carets, so a caret is ordinary text — including the
// doubled form, which no longer means anything. An agent discussing "^C" or
// "^^" gets those characters rendered verbatim.
const SAMPLES: { name: string; text: string }[] = [
  { name: "plain", text: "Xy" },
  { name: "inline-sgr-span", text: "a\x1b[96mb\x1b[0mc" },
  { name: "literal-caret", text: "a^Cb^:c" },
  { name: "literal-doubled-caret", text: "a^^K" },
];

for (const generic of ["xterm-256color", "xterm-truecolor"]) {
  describe(`writeStyled bytes (${generic})`, () => {
    for (const sample of SAMPLES) {
      it(`emits stable bytes for every style — ${sample.name}`, () => {
        const { term, take } = createCapturingTerminal(generic);
        const rows: string[] = [];
        for (const style of ALL_STYLES) {
          for (const hovered of [false, true]) {
            take();
            writeStyled(term, sample.text, style, hovered);
            const label = `${style ?? "(undefined)"}${hovered ? " [hover]" : ""}`;
            rows.push(`${label.padEnd(32)} ${visible(take())}`);
          }
        }
        expect(rows.join("\n")).toMatchSnapshot();
      });
    }
  });
}

describe("writeStyled invariants", () => {
  it("writes nothing for empty text", () => {
    const { term, take } = createCapturingTerminal();
    take();
    writeStyled(term, "", "tool", false);
    expect(take()).toBe("");
  });
});

describe("styleCarriesInlineSgr", () => {
  // Locked to the set the width-measuring code used before the theme table
  // existed. Adding a style here without teaching format.ts to emit markup
  // for it makes wrap subtract carets that aren't there; removing one makes
  // rows wrap early. Change deliberately, not incidentally.
  it("matches the markup-bearing styles exactly", () => {
    const markup = ALL_STYLES.filter((s) => styleCarriesInlineSgr(s));
    expect(markup).toEqual([
      "agent",
      "thought",
      "plan",
      "plan-done",
      "plan-pending",
      "heading-1",
      "heading-2",
      "heading-3",
    ]);
  });
});

describe("bgGrayscale", () => {
  it("passes through on a 24-bit terminal", () => {
    expect(bgGrayscale(43, "truecolor").open).toBe("\x1b[48;2;43;43;43m");
  });

  // Reproduces terminal-kit's quantisation, which is what decides the actual
  // shade of the user-message and code bands on a 256-colour terminal.
  it("quantises onto the 256-colour grayscale ramp", () => {
    expect(bgGrayscale(43, "ansi256").open).toBe("\x1b[48;5;235m");
    expect(bgGrayscale(28, "ansi256").open).toBe("\x1b[48;5;234m");
    expect(bgGrayscale(25, "ansi256").open).toBe("\x1b[48;5;233m");
  });

  it("maps the ends of the range onto the cube corners", () => {
    expect(bgGrayscale(0, "ansi256").open).toBe("\x1b[48;5;16m");
    expect(bgGrayscale(255, "ansi256").open).toBe("\x1b[48;5;231m");
  });

  it("always closes with a background reset", () => {
    expect(bgGrayscale(43, "truecolor").close).toBe("\x1b[49m");
    expect(bgGrayscale(43, "ansi256").close).toBe("\x1b[49m");
  });
});

describe("hover banding", () => {
  const hoverOf = (style: Style): string => {
    const { term, take } = createCapturingTerminal("xterm-256color");
    take();
    writeStyled(term, "Xy", style, true);
    return take();
  };

  it("bands all three plan states identically", () => {
    // Only plan-pending used to band, so hovering a checklist lit up the
    // not-yet-started entries and left in-progress and completed ones flat.
    const band = "\x1b[48;5;236m";
    for (const style of ["plan", "plan-done", "plan-pending"] as const) {
      expect(hoverOf(style).startsWith(band), style).toBe(true);
    }
  });

  it("closes the band it opens", () => {
    // A hovered row used to leak its background to end of row and rely on the
    // painter's styleReset. The trailing padding is a separate hovered write
    // that re-bands itself, so closing here costs no coverage.
    for (const style of [
      "plan",
      "plan-done",
      "plan-pending",
      "thought",
      "tool",
      "muted",
      "tool-output",
      "status-idle",
      "code",
    ] as const) {
      expect(hoverOf(style).endsWith("\x1b[49m"), style).toBe(true);
    }
  });

  it("leaves sidebar-only tokens unbanded", () => {
    // These were split out of banded tokens (plan-done, tool, muted,
    // tool-status-running). They lose the band on purpose: the predecessors
    // needed it because they also appear in transcript tool/plan blocks,
    // whereas these only reach the sidebar, whose painter passes
    // hovered: false.
    for (const style of [
      "git-staged",
      "git-dirty",
      "git-untracked",
      "file-path",
      "meter-fill",
      "meter-warn",
      "sidebar-rule",
      "sidebar-title",
      "status-active",
      "status-blocked",
      "status-queued",
    ] as const) {
      const { term, take } = createCapturingTerminal("xterm-256color");
      take();
      writeStyled(term, "Xy", style, true);
      const hovered = take();
      writeStyled(term, "Xy", style, false);
      expect(hovered, style).toBe(take());
    }
  });

  it("leaves styles that cannot be hovered unbanded", () => {
    // Hover marks a clickable block. agent/heading rows live in agent:
    // blocks, which the pointer handler skips; user and the local-/notice-/
    // metric- tokens are appended unkeyed and never hovered at all.
    for (const style of [
      "agent",
      "heading-1",
      "heading-2",
      "heading-3",
      "user",
      "local-heading",
      "local-item",
      "notice",
      "notice-ok",
      "notice-error",
      "metric",
    ] as const) {
      expect(hoverOf(style), style).toBe(
        (() => {
          const { term, take } = createCapturingTerminal("xterm-256color");
          take();
          writeStyled(term, "Xy", style, false);
          return take();
        })(),
      );
    }
  });
});

describe("tokens split out of dim / system / info", () => {
  const render = (style: Style): string => {
    const { term, take } = createCapturingTerminal("xterm-256color");
    take();
    writeStyled(term, "Xy", style);
    return take();
  };

  // Tokens that were separated so they could be themed apart but still share a
  // rendering. Recorded so divergence has to be a deliberate edit here rather
  // than something that drifts in. Same shape the tool-status tokens have
  // always had: distinct meanings, shared default.
  const SHARED: Array<{ why: string; styles: Style[] }> = [
    {
      why: "former `dim`: chrome, tool output, and quiescent state",
      styles: [
        "muted",
        "tool-output",
        "status-idle",
        // `status-blocked` used to sit here, on the note that it was "split so
        // it can diverge". It has: blocked-on-the-user now renders yellow, so
        // the row that needs you no longer reads as the same grey as the rows
        // that don't.
        "git-untracked",
        // Split out of `muted` so the sidebar frame can be tinted without
        // touching transcript rules and provenance tags.
        "sidebar-rule",
        "sidebar-title",
      ],
    },
    {
      why: "the active accent: a turn in flight, and outstanding queued work",
      styles: ["status-active", "status-queued", "tool-status-running"],
    },
    {
      why: "tokens split out of borrowed plan/tool roles in the sidebar",
      styles: ["git-dirty", "file-path", "tool"],
    },
    {
      why: "former `info`: list rows, passive notices, and metrics",
      styles: ["local-item", "notice", "metric"],
    },
  ];

  for (const group of SHARED) {
    it(`renders identically today — ${group.why}`, () => {
      const first = render(group.styles[0]!);
      for (const style of group.styles.slice(1)) {
        expect(render(style), style).toBe(first);
      }
    });
  }

  // Tokens deliberately pulled apart after the split, with what they must no
  // longer look like. Each of these was a real misreading before: a failed
  // command that looked like a help listing, a finished write and a static
  // heading both wearing the busy accent.
  const DIVERGED: Array<{ why: string; style: Style; notLike: Style }> = [
    {
      why: "a failed command must not look like a list row",
      style: "notice-error",
      notLike: "local-item",
    },
    {
      why: "a failed command is milder than a broken tool call",
      style: "notice-error",
      notLike: "tool-status-fail",
    },
    {
      why: "a success confirmation must not wear the busy accent",
      style: "notice-ok",
      notLike: "tool-status-running",
    },
    {
      why: "a local heading must not wear the busy accent",
      style: "local-heading",
      notLike: "plan",
    },
  ];

  for (const c of DIVERGED) {
    it(`${c.style} differs from ${c.notLike} — ${c.why}`, () => {
      expect(render(c.style)).not.toBe(render(c.notLike));
    });
  }

  it("keeps notice-error unmistakably an error", () => {
    // Red foreground, matching the family tool-status-fail belongs to.
    expect(render("notice-error")).toContain("\x1b[31m");
  });

  it("keeps notice-ok in the success colour plan-done uses", () => {
    expect(render("notice-ok")).toBe(render("plan-done"));
  });
});
