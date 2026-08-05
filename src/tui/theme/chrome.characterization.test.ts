// Equivalence test for the chrome tokens.
//
// The scrollback tokens had a single choke point (writeStyled) to snapshot.
// Chrome does not: it was ~160 scattered `term.brightYellow.noFormat(...)`
// calls across seven renderers whose existing tests drive a no-op Proxy mock
// and never observe a byte.
//
// So instead of snapshotting output, each token records the terminal-kit chain
// it replaced, and this asserts the two emit the same bytes when driven
// through the real library. That proves the table is right. Whether a given
// call site got the *right* token is a review matter, not something a test can
// know — but every substitution was 1:1, so the table is where an error would
// actually hide.
//
// Verified against terminal-kit rather than assumed, for the same reason
// bgGrayscale was: its close sequences are LIFO and its bold-off is SGR 22,
// neither of which is guessable.

import { describe, expect, it } from "vitest";
import type { Terminal } from "terminal-kit";
import { paint, type ChromeToken } from "./index.js";
import { createCapturingTerminal, visible } from "./capture.js";

// token -> the chain it replaced. Keyed so a renamed token fails to compile.
const REPLACED: Record<ChromeToken, (t: Terminal, s: string) => void> = {
  "box-border": (t, s) => t.dim.noFormat(s),
  "box-border-focused": (t, s) => t.brightBlue.noFormat(s),
  "box-border-hover": (t, s) => t.dim.bold.noFormat(s),
  "box-border-focused-hover": (t, s) => t.brightBlue.bold.noFormat(s),
  "box-title": (t, s) => t.brightCyan.noFormat(s),
  "modal-title": (t, s) => t.brightWhite.bold.noFormat(s),
  "modal-label": (t, s) => t.dim.noFormat(s),
  "modal-value": (t, s) => t.brightWhite.noFormat(s),
  "modal-note": (t, s) => t.brightYellow.noFormat(s),
  "modal-error": (t, s) => t.brightRed.noFormat(s),
  "modal-hint": (t, s) => t.dim.noFormat(s),
  "modal-status": (t, s) => t.dim.noFormat(s),
  "modal-key": (t, s) => t.brightCyan.noFormat(s),
  "input-error": (t, s) => t.red.noFormat(s),
  "input-cursor": (t, s) => t.bgWhite.noFormat(s),
  "prompt-text": (t, s) => t.brightYellow.noFormat(s),
  "prompt-cursor": (t, s) => t.bgBrightYellow.noFormat(s),
  "prompt-destructive": (t, s) => t.brightRed.noFormat(s),
  "list-selected": (t, s) => t.brightWhite.bgBlue.noFormat(s),
  "list-description": (t, s) => t.dim.noFormat(s),
  "list-header": (t, s) => t.dim.noFormat(s),
  "status-progress": (t, s) => t.brightYellow.noFormat(s),
  "modal-option": (t, s) => t.dim.noFormat(s),
  "modal-option-selected": (t, s) => t.brightYellow.noFormat(s),
  "bar-text": (t, s) => t.bold.noFormat(s),
  "bar-indicator": (t, s) => t.brightCyan.noFormat(s),
  rule: (t, s) => t.bold.noFormat(s),
  "rule-pad": (t, s) => t.dim.noFormat(s),
  "rule-meta": (t, s) => t.dim.noFormat(s),
  // Unstyled by design — the surrounding chunks are dim, so full brightness
  // is the hover signal.
  "hint-hover": (t, s) => t.noFormat(s),
  "status-ready": (t, s) => t.noFormat(s),
  "status-busy": (t, s) => t.brightYellow.noFormat(s),
  "status-alert": (t, s) => t.brightRed.noFormat(s),
  "status-cold": (t, s) => t.brightMagenta.noFormat(s),
  "completion-name": (t, s) => t.brightCyan.noFormat(s),
  "completion-desc": (t, s) => t.dim.noFormat(s),
  attachment: (t, s) => t.yellow.noFormat(s),
  "queue-row": (t, s) => t.bgBlue.brightWhite.noFormat(s),
  "queue-cursor": (t, s) => t.bgBlue.brightYellow.noFormat(s),
  "queue-blank": (t, s) => t.bgBlue.noFormat(s),
  "composer-gutter": (t, s) => t.brightWhite.noFormat(s),
  "composer-inactive": (t, s) => t.dim.noFormat(s),
  "composer-continuation": (t, s) => t.dim.noFormat(s),
  "cli-warn": (t, s) => t.yellow.noFormat(s),
};

for (const generic of ["xterm-256color", "xterm-truecolor"]) {
  describe(`chrome tokens match the chains they replaced (${generic})`, () => {
    for (const [token, chain] of Object.entries(REPLACED) as Array<
      [ChromeToken, (t: Terminal, s: string) => void]
    >) {
      it(token, () => {
        const { term, take } = createCapturingTerminal(generic);
        take();
        chain(term, "Xy");
        const before = take();
        paint(term, token, "Xy");
        const after = take();
        expect(visible(after)).toBe(visible(before));
      });
    }
  });
}

describe("paint", () => {
  it("writes nothing for empty text", () => {
    const { term, take } = createCapturingTerminal();
    take();
    paint(term, "box-border", "");
    expect(take()).toBe("");
  });

  it("never interprets a caret as a style command", () => {
    // Chrome text is paths, branch names and agent-supplied labels. One of the
    // sites this replaced used terminal-kit's markup-interpreting call, so a
    // caret in an install progress line would have been eaten.
    const { term, take } = createCapturingTerminal();
    take();
    paint(term, "status-progress", "press ^C to cancel");
    expect(take()).toContain("press ^C to cancel");
  });
});
