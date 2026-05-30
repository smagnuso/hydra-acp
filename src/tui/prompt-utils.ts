// Shared primitives for pre-screen TUI prompts (the dialogs that run
// in the gap between picker close and screen.start()). Two helpers:
//
//   - resetTerminalModes(): clears the sticky kitty / mouse / bracketed-
//     paste / DECCKM / DECPAM state that a previous prompt or a crashed
//     run might have left engaged. Without this, terminal-kit's native
//     parser drops arrows and ESC as "unknown" sequences.
//
//   - drawBox(): paints a single-line bordered panel at a computed
//     position, optionally with a title strip inside the top border,
//     and returns the inner content area so callers can render their
//     own rows inside it without recomputing geometry.
//
// Both prompts (import-action-prompt and import-cwd-prompt) use these so
// they stay in lockstep — and so future modals don't reinvent the wheel.
//
// Box characters match the single-line set already used by screen.ts's
// separator (`─`). Borders render with `term.dim` so they recede behind
// the body content.
//
// Layout strategy: we never need partial repaints inside the box — every
// caller does full re-render on key events and resize, which is what
// picker.ts does too (see renderFromScratch in picker.ts:385).

import type { Terminal } from "terminal-kit";

export interface BoxLayout {
  // Outer coordinates (1-based, terminal-kit convention).
  x: number;
  y: number;
  w: number;
  h: number;
  // Inner content area — first column / row callers can paint into,
  // and the maximum content width / height available.
  contentX: number;
  contentY: number;
  contentW: number;
  contentH: number;
}

export interface DrawBoxOptions {
  // Desired content height (rows). drawBox adds 2 for the borders and
  // clamps to the terminal so callers don't have to.
  contentHeight: number;
  // Desired content width (cols). drawBox adds 2 for the borders and
  // clamps to the terminal width (termWidth - 4). When omitted, defaults
  // to MAX_BOX_WIDTH; an explicit value may exceed MAX_BOX_WIDTH (it's
  // only the default, not a hard ceiling).
  contentWidth?: number;
  title?: string;
}

const MAX_BOX_WIDTH = 64;
const HORIZ = "─";
const VERT = "│";
const TL = "┌";
const TR = "┐";
const BL = "└";
const BR = "┘";

// Belt-and-suspenders escape sequence reset. Lifted verbatim from
// picker.ts:105-113 so prompt-utils owns one copy and future prompts
// import the helper instead of pasting the block.
export function resetTerminalModes(): void {
  process.stdout.write("\x1b[<u");
  process.stdout.write("\x1b[?2004l");
  process.stdout.write("\x1b[>4;0m");
  process.stdout.write("\x1b[>5;0m");
  process.stdout.write("\x1b[?1000l");
  process.stdout.write("\x1b[?1002l");
  process.stdout.write("\x1b[?1006l");
  process.stdout.write("\x1b[?1l");
  process.stdout.write("\x1b>");
}

export function readTermWidth(term: Terminal): number {
  return (term as unknown as { width?: number }).width ?? 80;
}

export function readTermHeight(term: Terminal): number {
  return (term as unknown as { height?: number }).height ?? 24;
}

// Clear the display and paint a centered bordered box. Returns the
// inner content area so the caller can render rows with
// `term.moveTo(layout.contentX, layout.contentY + n)`.
export function drawBox(term: Terminal, opts: DrawBoxOptions): BoxLayout {
  const termW = readTermWidth(term);
  const termH = readTermHeight(term);
  const desiredContentW = opts.contentWidth ?? MAX_BOX_WIDTH;
  // An explicit contentWidth may exceed MAX_BOX_WIDTH (that's just the
  // default); the only hard cap is the terminal width.
  const maxContentW = Math.max(10, termW - 4);
  const contentW = Math.min(desiredContentW, maxContentW);
  const w = contentW + 2;
  const contentH = Math.max(1, Math.min(opts.contentHeight, termH - 4));
  const h = contentH + 2;
  const x = Math.max(1, Math.floor((termW - w) / 2) + 1);
  const y = Math.max(1, Math.floor((termH - h) / 2) + 1);

  term.moveTo(1, 1).eraseDisplayBelow();

  const topInner = HORIZ.repeat(w - 2);
  const top = renderTitleStrip(topInner, opts.title);
  term.moveTo(x, y);
  term.dim.noFormat(TL);
  paintTopStrip(term, top);
  term.dim.noFormat(TR);
  for (let row = 1; row <= contentH; row++) {
    term.moveTo(x, y + row);
    term.dim.noFormat(VERT);
    term.moveTo(x + w - 1, y + row);
    term.dim.noFormat(VERT);
  }
  term.moveTo(x, y + h - 1);
  term.dim.noFormat(BL + HORIZ.repeat(w - 2) + BR);

  return {
    x,
    y,
    w,
    h,
    contentX: x + 1,
    contentY: y + 1,
    contentW,
    contentH,
  };
}

// Pre-compute the top-border string with an optional title chip baked
// into the dashes. Kept as a pure helper so it's testable without a
// terminal.
export function renderTitleStrip(
  innerDashes: string,
  title?: string,
): { dashes: string; title?: { offset: number; text: string } } {
  if (!title) {
    return { dashes: innerDashes };
  }
  const chip = ` ${title} `;
  // Need room for the chip plus at least 2 dashes on each side so the
  // title still reads as part of a border. Fall back to no chip if the
  // box is too narrow.
  if (chip.length + 4 > innerDashes.length) {
    return { dashes: innerDashes };
  }
  const offset = 2;
  const dashes =
    innerDashes.slice(0, offset) +
    " ".repeat(chip.length) +
    innerDashes.slice(offset + chip.length);
  return { dashes, title: { offset, text: chip } };
}

// Paint a pre-rendered top strip — dashes first, then the title chip
// (brightCyan) overlaid at the offset reserved by renderTitleStrip.
function paintTopStrip(
  term: Terminal,
  strip: ReturnType<typeof renderTitleStrip>,
): void {
  if (!strip.title) {
    term.dim.noFormat(strip.dashes);
    return;
  }
  term.dim.noFormat(strip.dashes.slice(0, strip.title.offset));
  term.brightCyan.noFormat(strip.title.text);
  term.dim.noFormat(strip.dashes.slice(strip.title.offset + strip.title.text.length));
}
