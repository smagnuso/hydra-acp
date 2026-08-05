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

import { describe, expect, it } from "vitest";
import { writeStyled } from "../screen.js";
import type { Style } from "../format.js";
import { createCapturingTerminal, visible } from "./capture.js";
import { bgGrayscale, styleUsesMarkup } from "./index.js";

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
  "system",
  "info",
  "dim",
  "code",
  "heading-1",
  "heading-2",
  "heading-3",
  "search-highlight",
  "search-highlight-active",
  "selection-highlight",
  undefined,
];

// Plain text, plus text carrying caret markup. The markup case matters
// because a subset of styles deliberately route through terminal-kit's
// markup interpreter; the rest must emit the carets literally.
const SAMPLES: { name: string; text: string }[] = [
  { name: "plain", text: "Xy" },
  { name: "markup", text: "a^Cb^:c" },
  { name: "escaped-caret", text: "a^^K" },
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

describe("styleUsesMarkup", () => {
  // Locked to the set the width-measuring code used before the theme table
  // existed. Adding a style here without teaching format.ts to emit markup
  // for it makes wrap subtract carets that aren't there; removing one makes
  // rows wrap early. Change deliberately, not incidentally.
  it("matches the markup-bearing styles exactly", () => {
    const markup = ALL_STYLES.filter((s) => styleUsesMarkup(s));
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
    expect(bgGrayscale(43, true).open).toBe("\x1b[48;2;43;43;43m");
  });

  // Reproduces terminal-kit's quantisation, which is what decides the actual
  // shade of the user-message and code bands on a 256-colour terminal.
  it("quantises onto the 256-colour grayscale ramp", () => {
    expect(bgGrayscale(43, false).open).toBe("\x1b[48;5;235m");
    expect(bgGrayscale(28, false).open).toBe("\x1b[48;5;234m");
    expect(bgGrayscale(25, false).open).toBe("\x1b[48;5;233m");
  });

  it("maps the ends of the range onto the cube corners", () => {
    expect(bgGrayscale(0, false).open).toBe("\x1b[48;5;16m");
    expect(bgGrayscale(255, false).open).toBe("\x1b[48;5;231m");
  });

  it("always closes with a background reset", () => {
    expect(bgGrayscale(43, true).close).toBe("\x1b[49m");
    expect(bgGrayscale(43, false).close).toBe("\x1b[49m");
  });
});
