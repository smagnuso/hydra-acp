// Maps RenderEvents to FormattedLines. Pure (no I/O, no terminal-kit) so the
// screen layer is the only place that knows how to translate Style names
// into ANSI/terminal-kit calls.

import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";
import stringWidth from "string-width";
import { shortenHomePath } from "../core/paths.js";
import {
  sanitizeSingleLine,
  sanitizeWireText,
  type EditDiff,
  type PlanEntry,
  type RenderEvent,
} from "../core/render-update.js";

export type Style =
  | "user"
  | "agent"
  | "thought"
  | "tool"
  | "tool-status-ok"
  | "tool-status-fail"
  | "tool-status-pending"
  | "tool-status-running"
  | "tool-status-cancelled"
  | "plan"
  | "plan-done"
  | "plan-pending"
  | "system"
  | "info"
  | "dim"
  | "code"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "search-highlight"
  | "search-highlight-active"
  | "selection-highlight";

export interface FormattedLine {
  prefix?: string;
  prefixStyle?: Style;
  body: string;
  bodyStyle?: Style;
  // When set, the screen layer pads the body with spaces (using bodyStyle)
  // to fill the remainder of the terminal row, so a background-colored
  // style extends as a continuous stripe across the whole line. Used to
  // visually band user turns in scrollback.
  fillRow?: boolean;
  // When set, the body contains embedded ANSI escape sequences (from a
  // syntax highlighter). The screen layer routes such lines through
  // ANSI-aware wrap/width helpers so escape bytes don't inflate column
  // counts. Only used today for highlighted code blocks inside fences.
  ansi?: boolean;
  // When set on user-text echo lines, the screen layer emits the
  // iTerm2 OSC 1337 inline-image escape after the body so a thumbnail
  // of the attached image appears in scrollback. Non-iTerm2 terminals
  // ignore the field and only the body (filename / size) is shown.
  iterm2Image?: { data: string; heightCells: number };
  // The upsert key of the block this line belongs to, stamped by
  // Screen.upsertLines. Lets a left-click resolve the line back to its
  // owning block (for click-to-expand) even after the key is forgotten
  // via clearKey — the lines stay painted, so the stamp outlives the
  // keyedBlocks entry. Plain appended lines (appendLine/appendLines)
  // carry no key.
  blockKey?: string;
  // When true, the line stays in scrollback but is skipped at draw/measure
  // time (like a hidden thought). Used to fold a contiguous run of thought
  // blocks behind a single "Thoughts" line: the run's secondary lines and
  // their separators are marked collapsed so only the lead line paints.
  // Cleared to restore the original blocks.
  collapsed?: boolean;
}

export interface FormatEventOptions {
  // Cap on plan entries shown before the renderer collapses to a sliding
  // window. 0 means render all entries (no window). Defaults to
  // PLAN_VISIBLE_LIMIT when omitted so tests / direct callers don't have
  // to plumb config through.
  maxPlanItems?: number;
}

export function formatEvent(
  event: RenderEvent,
  options: FormatEventOptions = {},
): FormattedLine[] {
  switch (event.kind) {
    case "user-text": {
      const lines = formatBlock(
        event.text,
        "▎ ",
        "user",
        undefined,
        event.sentBy,
        true,
      );
      if (event.attachments && event.attachments.length > 0) {
        for (const a of event.attachments) {
          lines.push({
            prefix: "▎ ",
            prefixStyle: "user",
            body: `📎 ${a.name ?? "image"}`,
            bodyStyle: "user",
            fillRow: true,
            iterm2Image: { data: a.data, heightCells: 5 },
          });
        }
      }
      return lines;
    }
    case "agent-text":
      return formatBlock(event.text, "  ", "agent");
    case "agent-thought":
      return formatBlock(event.text, "  ", "thought", "thought");
    case "tool-call":
    case "tool-call-update":
      // Tool calls render as a single mutating line keyed by toolCallId —
      // see formatToolLine + Screen.upsertLine. app.ts intercepts these
      // events before reaching here, so this case is unreachable in
      // production but kept exhaustive for the switch.
      return [];
    case "exit-plan-mode":
      // Rendered as a keyed multi-line block by app.ts (upsertLines), not
      // appended through here. Same unreachable-but-exhaustive treatment.
      return [];
    case "plan":
      return formatPlan(event, options.maxPlanItems ?? PLAN_VISIBLE_LIMIT);
    case "mode-changed":
      return [
        {
          prefix: "» ",
          prefixStyle: "info",
          body: `mode: ${event.mode}`,
          bodyStyle: "info",
        },
      ];
    case "model-changed":
      // Sessionbar reflects the live model — a scrollback line would just
      // be noise (and on session/new the snapshot replay fires one of
      // these before the user has done anything).
      return [];
    case "turn-complete":
      // Boundary is rendered as a blank separator only — see the
      // ensureSeparator() call in app.ts after a turn-complete event.
      return [];
    case "usage-update":
      // Usage is rendered in the header by the app, not in scrollback.
      return [];
    case "available-commands":
    case "available-modes":
    case "config-options":
      // Stored as completion/selector data, not rendered to scrollback.
      return [];
    case "session-info":
      // Title is rendered in the header by the app, not in scrollback.
      return [];
    case "unknown":
      // Silently drop notification kinds we don't have a styled rendering
      // for (available_commands_update, config_option_update, etc.). The
      // mapper still produces the event, so a debug mode could surface it
      // in the future.
      return [];
  }
}

// Inline-mark pass — converts a subset of markdown's inline syntax into
// terminal-kit's `^X…^:` markup, which `term(text)` processes inside the
// formatter so a single line can mix styles. Order matters: we escape
// literal carets FIRST so user-typed `^` doesn't get mistaken for our own
// markup, then apply each pattern.
//
// Supported:
//   **bold**         → ^+bold^:
//   `inline code`    → ^Cinline code^:    (bright-cyan tint)
//
// Skipped intentionally:
//   *italic* / _italic_  — `*` and `_` are too common in code/paths/
//                          shell args, false-positives would litter the
//                          UI with spurious italics.
//
// boldReset/codeReset allow callers to substitute a non-full-reset sequence.
// codeOpen defaults to "^C" (bright cyan); thoughts pass "^c" (dim cyan) so
// inline code reads as a muted tint that fits the gray thought aesthetic.
// Thoughts also pass boldReset "^-" and codeReset "^K" so neither resets the
// foreground to default — the brightBlack base color holds throughout.
function applyInlineMarkup(
  text: string,
  opts?: { codeOpen?: string; boldReset?: string; codeReset?: string },
): string {
  const codeOpen = opts?.codeOpen ?? "^C";
  const boldReset = opts?.boldReset ?? "^:";
  const codeReset = opts?.codeReset ?? "^:";
  let s = text.replace(/\^/g, "^^");
  s = s.replace(/\*\*(.+?)\*\*/g, `^+$1${boldReset}`);
  s = s.replace(/`([^`]+)`/g, `${codeOpen}$1${codeReset}`);
  return s;
}

// Per-heading inline-markup opts. Headings render via the markup-interpreting
// writer (no .noFormat) so inline code / bold inside them gets styled, but
// `^:` reset would drop the outer bold+color too; each closer re-emits the
// heading's base attrs so the rest of the heading keeps its style. heading-2
// uses `^Y` (bright yellow) as the code opener because the default `^C`
// would match the heading's brightCyan and disappear visually.
function headingInlineOptsFor(style: Style): {
  codeOpen: string;
  boldReset: string;
  codeReset: string;
} {
  switch (style) {
    case "heading-1":
      return { codeOpen: "^C", boldReset: "^+^Y", codeReset: "^+^Y" };
    case "heading-2":
      return { codeOpen: "^Y", boldReset: "^+^C", codeReset: "^+^C" };
    case "heading-3":
    default:
      return { codeOpen: "^C", boldReset: "^:^+", codeReset: "^:^+" };
  }
}

interface ParseMarkdownOpts {
  // bodyStyle for prose, list items, and headings. Code fences in agent mode
  // use "code" with syntax highlighting; in thought mode they use this style
  // so the hide-thoughts filter (which keys on bodyStyle) catches them.
  proseStyle: Style;
  // When true, code fences get syntax highlighting and bodyStyle "code".
  // When false, fence lines are escaped and emitted with proseStyle.
  highlightCode: boolean;
  // Applied to every emitted line's prefixStyle field.
  prefixStyle?: Style;
  // Prefix for the first non-blank line. All other lines use "  ".
  firstPrefix?: string;
  // Passed to applyInlineMarkup for prose and list items.
  inlineOpts?: { codeOpen?: string; boldReset?: string; codeReset?: string };
  // Total terminal width available for the rendered block (including the
  // prefix). When set, pipe tables clamp column widths to fit and word-wrap
  // cells across multiple physical rows; without it tables stay natural-width
  // and the screen layer mid-row wraps them, producing the broken layout we
  // had pre-clamp. Other block kinds ignore it — they're already single-line.
  maxWidth?: number;
}

// Block-level markdown → FormattedLines. Each newline-separated line is
// classified once and emitted with a matching style. Inline marks for bold +
// code are applied to prose and list items (see applyInlineMarkup); they are
// intentionally NOT applied inside code fences or headings.
//
// Streamed text is fed through this on every chunk and the resulting lines are
// upserted as a single keyed block (idempotent; the block mutates in place as
// more content arrives). Mirrors the regex-based approach in
// @hydra-acp/browser's markdown.ts.
function parseMarkdown(text: string, opts: ParseMarkdownOpts): FormattedLine[] {
  const {
    proseStyle,
    highlightCode,
    prefixStyle,
    firstPrefix = "  ",
    inlineOpts,
    maxWidth,
  } = opts;
  const out: FormattedLine[] = [];
  // Drop leading whitespace (blank lines + indentation) before the first
  // content. Streamed reasoning/agent deltas frequently begin with a space,
  // which would otherwise land between the gutter and the first word ("  "
  // + " word" → "   word") and push the first line one column right of the
  // (whitespace-trimmed) continuation rows.
  const lines = text.replace(/^\s+/, "").split("\n");
  let inCode = false;
  let codeLang = "";
  let codeBuffer: string[] = [];
  let firstNonBlank = firstPrefix !== "  ";
  const line = (body: string, bodyStyle: Style, prefix = "  "): void => {
    const entry: FormattedLine = { prefix, body, bodyStyle };
    if (prefixStyle !== undefined)
      entry.prefixStyle = prefixStyle;
    out.push(entry);
  };
  const nextPrefix = (): string => {
    if (!firstNonBlank)
      return "  ";
    firstNonBlank = false;
    return firstPrefix;
  };
  const flushCode = (): void => {
    if (codeBuffer.length === 0)
      return;
    if (highlightCode) {
      const highlighted = highlightFencedBlock(codeLang, codeBuffer);
      for (const piece of highlighted) {
        const entry: FormattedLine = {
          prefix: "  ",
          body: piece.body,
          bodyStyle: "code",
          fillRow: true,
        };
        if (prefixStyle !== undefined)
          entry.prefixStyle = prefixStyle;
        if (piece.ansi)
          entry.ansi = true;
        out.push(entry);
      }
    } else {
      for (const cl of codeBuffer)
        line(cl.replace(/\^/g, "^^"), proseStyle);
    }
    codeBuffer = [];
    codeLang = "";
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const fence = l.match(/^\s*```\s*(\w*)\s*$/);
    if (fence) {
      if (!inCode) {
        inCode = true;
        codeLang = fence[1] ?? "";
      } else {
        flushCode();
        inCode = false;
      }
      // Don't render the ``` fence line itself.
      continue;
    }
    if (inCode) {
      codeBuffer.push(l);
      continue;
    }
    const heading = l.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      const headingText = heading[2] ?? "";
      const headingStyle: Style = highlightCode
        ? level === 1
          ? "heading-1"
          : level === 2
            ? "heading-2"
            : "heading-3"
        : proseStyle;
      // Inline marks render with closers that restore the heading's base
      // style (bold + color) — `^:` would also kill the outer chain, so
      // each level emits its own restore sequence after the inline span.
      const headingInlineOpts = highlightCode
        ? headingInlineOptsFor(headingStyle)
        : inlineOpts;
      line(
        applyInlineMarkup(headingText, headingInlineOpts),
        headingStyle,
        nextPrefix(),
      );
      continue;
    }
    // Pipe table: a header row, an `|---|---|` separator on the very next
    // line with the same column count, then zero or more body rows. The
    // separator is the disambiguator — a stray `a | b` in prose without a
    // following separator falls through to the default branch and renders
    // as plain text.
    const next = lines[i + 1];
    if (
      l.includes("|") &&
      next !== undefined &&
      isTableSeparatorLine(next) &&
      parseTableRow(l).length === parseTableRow(next).length
    ) {
      const header = parseTableRow(l);
      const body: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j]!.includes("|")) {
        body.push(parseTableRow(lines[j]!));
        j++;
      }
      const tableLines = formatTable(header, body, maxWidth);
      for (const tl of tableLines) {
        if (prefixStyle !== undefined)
          tl.prefixStyle = prefixStyle;
        out.push(tl);
      }
      i = j - 1;
      continue;
    }
    const bullet = l.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const indent = bullet[1] ?? "";
      const item = bullet[2] ?? "";
      line(
        `${indent}• ${applyInlineMarkup(item, inlineOpts)}`,
        proseStyle,
        nextPrefix(),
      );
      continue;
    }
    const ordered = l.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (ordered) {
      const indent = ordered[1] ?? "";
      const num = ordered[2] ?? "";
      const item = ordered[3] ?? "";
      line(
        `${indent}${num}. ${applyInlineMarkup(item, inlineOpts)}`,
        proseStyle,
        nextPrefix(),
      );
      continue;
    }
    const isBlank = l.trim() === "";
    line(
      applyInlineMarkup(l, inlineOpts),
      proseStyle,
      isBlank ? "  " : nextPrefix(),
    );
  }
  // Mid-stream: flush in-progress fence so content is visible before the
  // closing ``` arrives.
  if (inCode)
    flushCode();
  // Trim trailing blank lines. Symmetric with the leading-whitespace strip
  // above: messages routinely end with "\n", which would otherwise emit a
  // prefix-only ("  ", "") tail line. That tail isn't recognized as blank
  // by Screen.ensureSeparator (it probes for an empty prefix), so the next
  // block's separator stacks on top of it and doubles the gap between
  // adjacent agent/thought blocks.
  while (out.length > 0 && out[out.length - 1]!.body === "") {
    out.pop();
  }
  return out;
}

export function parseAgentMarkdown(
  text: string,
  opts?: { maxWidth?: number },
): FormattedLine[] {
  return parseMarkdown(text, {
    proseStyle: "agent",
    highlightCode: true,
    maxWidth: opts?.maxWidth,
  });
}

// Thoughts use proseStyle "thought" throughout so the ^T hide-thoughts filter
// (which keys on bodyStyle) catches every line. There is no marker glyph:
// the dim gray "thought" color plus the indent set thoughts apart, and a
// blank gutter keeps copy/paste clean (no leading "*"/"·" to strip). Both
// inline resets use "^-" (bold-off only) so bold and code spans stay in the
// same gray register without a hue shift.
export function parseThoughtMarkdown(text: string): FormattedLine[] {
  return parseMarkdown(text, {
    proseStyle: "thought",
    highlightCode: false,
    prefixStyle: "thought",
    firstPrefix: "  ",
    inlineOpts: { codeOpen: "^c", boldReset: "^-", codeReset: "^K" },
  });
}

// Split a `| a | b | c |` row into trimmed cells. Outer pipes are
// optional in GFM — strip them when present so `a | b` and `| a | b |`
// both parse to the same two cells. We don't support escaped `\|` inside
// cells; agent output overwhelmingly uses plain pipes.
function parseTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) {
    s = s.slice(1);
  }
  if (s.endsWith("|")) {
    s = s.slice(0, -1);
  }
  return s.split("|").map((c) => c.trim());
}

// GFM separator row: every cell is `-+` with optional leading/trailing
// `:` for alignment. We accept 1+ dashes (strict GFM wants 3+) since
// agent output is sometimes terse. Alignment markers are accepted but
// not yet honored — every column renders left-aligned.
function isTableSeparatorLine(line: string): boolean {
  if (!line.includes("|")) {
    return false;
  }
  const cells = parseTableRow(line);
  if (cells.length === 0) {
    return false;
  }
  return cells.every((c) => /^:?-+:?$/.test(c));
}

// Visible terminal width of a cell after applyInlineMarkup runs against it
// — both header and body cells go through term(text) with markup
// interpretation, so **bold** -> ^+bold^… and `code` -> ^Ccode^… are
// zero-width markers. Italic *…* / _…_ stay intact, so they contribute
// to visible width. Uses string-width so wide glyphs (CJK, emoji) count
// as 2 cols and code-point oddities (combining marks, ZWJ sequences)
// reflect their on-screen footprint rather than .length.
function cellVisibleWidth(cell: string): number {
  const visible = cell
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
  return stringWidth(visible);
}

// Per-column minimum content width when shrinking a table to fit. Below this
// every cell is so chopped that word-wrap stops being useful — we let
// over-wide tables overflow the terminal instead.
const TABLE_MIN_COL = 6;
// Prefix added to every emitted row in the table block — kept in sync with
// the literal "  " passed in renderRow's FormattedLine.prefix.
const TABLE_PREFIX_WIDTH = 2;
// Visible width of the `" │ "` separator between adjacent columns.
const TABLE_SEP_WIDTH = 3;

// Atom for word-wrap inside a cell. Whitespace runs and word runs alternate;
// `**…**` / `` `…` `` markup spans (which may contain spaces) stay inside a
// single word atom so applyInlineMarkup downstream sees a balanced span and
// the markup never gets split mid-line.
interface CellAtom {
  text: string;
  isWS: boolean;
  width: number;
}

function tokenizeCell(cell: string): CellAtom[] {
  const atoms: CellAtom[] = [];
  let i = 0;
  while (i < cell.length) {
    const ch = cell[i]!;
    if (ch === " " || ch === "\t") {
      let j = i;
      while (j < cell.length && (cell[j] === " " || cell[j] === "\t")) {
        j++;
      }
      const text = cell.slice(i, j);
      atoms.push({ text, isWS: true, width: stringWidth(text) });
      i = j;
      continue;
    }
    let word = "";
    let j = i;
    while (j < cell.length) {
      const c = cell[j]!;
      if (c === " " || c === "\t") {
        break;
      }
      if (cell[j] === "*" && cell[j + 1] === "*") {
        const close = cell.indexOf("**", j + 2);
        if (close === -1) {
          word += "**";
          j += 2;
        } else {
          word += cell.slice(j, close + 2);
          j = close + 2;
        }
        continue;
      }
      if (c === "`") {
        const close = cell.indexOf("`", j + 1);
        if (close === -1) {
          word += "`";
          j += 1;
        } else {
          word += cell.slice(j, close + 1);
          j = close + 1;
        }
        continue;
      }
      word += c;
      j += 1;
    }
    atoms.push({ text: word, isWS: false, width: cellVisibleWidth(word) });
    i = j;
  }
  return atoms;
}

// Character-grained break for atoms wider than the column. Splits by visible
// width per code point so wide glyphs (CJK, emoji) don't sneak past the
// boundary. Used only for atoms with no markdown markers — atoms containing
// `**…**` / `` `…` `` slip through unchanged (and overflow) so a balanced
// markup span never gets severed.
function hardBreak(text: string, width: number): string[] {
  const out: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (currentWidth > 0 && currentWidth + w > width) {
      out.push(current);
      current = ch;
      currentWidth = w;
    } else {
      current += ch;
      currentWidth += w;
    }
  }
  if (current.length > 0) {
    out.push(current);
  }
  return out;
}

// Greedy word-wrap on tokenized cell atoms. Returns one source-text slice per
// physical row; applyInlineMarkup runs later. A non-WS atom wider than the
// column hard-breaks by character (when plain) so column alignment holds;
// atoms that contain markdown markup overflow rather than risk splitting a
// `**…**` / `` `…` `` span mid-render.
function wrapCellAtoms(atoms: CellAtom[], width: number): string[] {
  if (width <= 0) {
    return atoms.length === 0 ? [""] : [atoms.map((a) => a.text).join("")];
  }
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  const flush = (): void => {
    lines.push(current.replace(/[ \t]+$/, ""));
    current = "";
    currentWidth = 0;
  };
  for (const atom of atoms) {
    if (atom.isWS) {
      if (currentWidth === 0) {
        continue;
      }
      current += atom.text;
      currentWidth += atom.width;
      continue;
    }
    if (atom.width > width) {
      if (currentWidth > 0) {
        flush();
      }
      const hasMarkup =
        atom.text.includes("**") || atom.text.includes("`");
      if (hasMarkup) {
        lines.push(atom.text);
      } else {
        const fragments = hardBreak(atom.text, width);
        for (let k = 0; k < fragments.length - 1; k++) {
          lines.push(fragments[k]!);
        }
        const last = fragments[fragments.length - 1] ?? "";
        current = last;
        currentWidth = stringWidth(last);
      }
      continue;
    }
    if (currentWidth === 0) {
      current = atom.text;
      currentWidth = atom.width;
      continue;
    }
    if (currentWidth + atom.width > width) {
      flush();
      current = atom.text;
      currentWidth = atom.width;
    } else {
      current += atom.text;
      currentWidth += atom.width;
    }
  }
  if (current.length > 0 || lines.length === 0) {
    flush();
  }
  return lines;
}

// Distribute `budget` columns across `natural` widths. Columns under
// TABLE_MIN_COL keep their natural width; the rest shrink proportionally but
// never below TABLE_MIN_COL. Leftover budget after rounding is handed out to
// the columns with the largest unsatisfied need.
function distributeColumnWidths(
  natural: number[],
  budget: number,
): number[] {
  const cols = natural.length;
  const total = natural.reduce((a, b) => a + b, 0);
  if (total <= budget) {
    return natural.slice();
  }
  const widths = natural.map((n) => Math.min(n, TABLE_MIN_COL));
  let used = widths.reduce((a, b) => a + b, 0);
  if (used >= budget) {
    return widths;
  }
  const remaining = budget - used;
  const shrinkable = natural
    .map((n, i) => ({ i, slack: Math.max(0, n - widths[i]!) }))
    .filter((e) => e.slack > 0);
  const shrinkableTotal = shrinkable.reduce((a, b) => a + b.slack, 0);
  if (shrinkableTotal === 0) {
    return widths;
  }
  for (const e of shrinkable) {
    const add = Math.floor((remaining * e.slack) / shrinkableTotal);
    widths[e.i] = widths[e.i]! + Math.min(add, e.slack);
  }
  used = widths.reduce((a, b) => a + b, 0);
  let leftover = budget - used;
  while (leftover > 0) {
    let bestIdx = -1;
    let bestDeficit = 0;
    for (let i = 0; i < cols; i++) {
      const deficit = natural[i]! - widths[i]!;
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) {
      break;
    }
    widths[bestIdx] = widths[bestIdx]! + 1;
    leftover--;
  }
  return widths;
}

// Emit a header row (heading-3), a dim `─┼─` rule, then one row per body
// entry. Column widths come from cellVisibleWidth (markdown markers stripped,
// wide glyphs counted via string-width). When maxWidth is set and the
// natural table exceeds it, columns shrink (down to TABLE_MIN_COL) and cells
// word-wrap across multiple physical rows with aligned `│` separators —
// without it, the screen layer's mid-row wrap chops cells and the divider
// row drifts onto its own line.
function formatTable(
  header: string[],
  body: string[][],
  maxWidth?: number,
): FormattedLine[] {
  const cols = header.length;
  const natural: number[] = new Array(cols).fill(0);
  for (let c = 0; c < cols; c++) {
    natural[c] = cellVisibleWidth(header[c] ?? "");
  }
  for (const row of body) {
    for (let c = 0; c < cols; c++) {
      const cell = row[c] ?? "";
      const w = cellVisibleWidth(cell);
      if (w > natural[c]!) {
        natural[c] = w;
      }
    }
  }
  let widths = natural.slice();
  if (maxWidth !== undefined) {
    const budget = Math.max(
      cols * TABLE_MIN_COL,
      maxWidth - TABLE_PREFIX_WIDTH - (cols - 1) * TABLE_SEP_WIDTH,
    );
    widths = distributeColumnWidths(natural, budget);
  }
  const renderRow = (
    cells: string[],
    style: Style,
    inlineOpts?: { codeOpen?: string; boldReset?: string; codeReset?: string },
  ): FormattedLine[] => {
    const wrapped: string[][] = [];
    let rowHeight = 1;
    for (let c = 0; c < cols; c++) {
      const cell = cells[c] ?? "";
      const w = widths[c]!;
      const lines = wrapCellAtoms(tokenizeCell(cell), w);
      wrapped.push(lines);
      if (lines.length > rowHeight) {
        rowHeight = lines.length;
      }
    }
    const out: FormattedLine[] = [];
    for (let r = 0; r < rowHeight; r++) {
      const padded: string[] = [];
      for (let c = 0; c < cols; c++) {
        const cellLine = wrapped[c]![r] ?? "";
        const w = widths[c]!;
        const visible = cellVisibleWidth(cellLine);
        const rendered = applyInlineMarkup(cellLine, inlineOpts);
        padded.push(rendered + " ".repeat(Math.max(0, w - visible)));
      }
      out.push({
        prefix: "  ",
        body: padded.join(" │ "),
        bodyStyle: style,
      });
    }
    return out;
  };
  const out: FormattedLine[] = [];
  out.push(
    ...renderRow(header, "heading-3", headingInlineOptsFor("heading-3")),
  );
  const rules: string[] = [];
  for (let c = 0; c < cols; c++) {
    rules.push("─".repeat(widths[c]!));
  }
  out.push({
    prefix: "  ",
    body: rules.join("─┼─"),
    bodyStyle: "dim",
  });
  for (const row of body) {
    out.push(...renderRow(row, "agent"));
  }
  return out;
}

// Forced-color chalk instance so highlight.js output carries ANSI escapes
// even when stdout isn't a TTY (vitest, piped runs). The actual terminal
// strips/renders these correctly in the TUI's fullscreen mode.
const highlightChalk = new chalk.Instance({ level: 3 });

// Theme keyed by highlight.js token classes. Picks per-token colors that
// read well on the dark grayscale background stripe the screen layer
// paints behind code blocks. Diff tokens (addition/deletion/meta) are
// the common case the user asked us to handle first.
const HIGHLIGHT_THEME = {
  keyword: highlightChalk.blueBright,
  built_in: highlightChalk.cyan,
  type: highlightChalk.cyanBright,
  literal: highlightChalk.blue,
  number: highlightChalk.greenBright,
  string: highlightChalk.yellow,
  regexp: highlightChalk.red,
  comment: highlightChalk.gray,
  function: highlightChalk.yellow,
  title: highlightChalk.yellow,
  class: highlightChalk.yellowBright,
  attr: highlightChalk.cyan,
  attribute: highlightChalk.cyan,
  variable: highlightChalk.white,
  params: highlightChalk.white,
  meta: highlightChalk.magenta,
  symbol: highlightChalk.magenta,
  addition: highlightChalk.greenBright,
  deletion: highlightChalk.redBright,
  section: highlightChalk.cyan,
  tag: highlightChalk.cyan,
  name: highlightChalk.cyanBright,
};

// Run highlight.js over a fenced block. Returns one entry per source
// line. When the language is unknown / unsupported, or highlight.js
// throws on malformed input, falls back to plain lines with ansi=false
// so the caller still gets a 1:1 mapping back to FormattedLines.
function highlightFencedBlock(
  lang: string,
  lines: string[],
): { body: string; ansi: boolean }[] {
  if (lang.length === 0 || !supportsLanguage(lang)) {
    return lines.map((body) => ({ body, ansi: false }));
  }
  let highlighted: string;
  try {
    highlighted = highlight(lines.join("\n"), {
      language: lang,
      theme: HIGHLIGHT_THEME,
      ignoreIllegals: true,
    });
  } catch {
    return lines.map((body) => ({ body, ansi: false }));
  }
  // chalk closes color spans with `\x1b[39m` (reset fg to terminal
  // default). That works when the surrounding context is the terminal
  // default — but our "code" body sits on a `bgColorGrayscale(28).white`
  // base, so the close drops the rest of the line to whatever the user's
  // default foreground is (blue / gray / etc. depending on theme) instead
  // of back to our explicit white. Rewrite every fg-close to an explicit
  // "set fg to white" so closes always restore the base we set in
  // screen.ts. Side-effect: nested chalk closes also land at white, which
  // matches the behavior cli-highlight already had (it concatenates spans
  // without re-emitting parents).
  highlighted = highlighted.replace(/\x1b\[39m/g, "\x1b[37m");
  const out = highlighted.split("\n");
  // Defensive: highlight.js should preserve newline count, but if it
  // didn't, prefer the source line count to keep wrap math sane.
  if (out.length !== lines.length) {
    return lines.map((body) => ({ body, ansi: false }));
  }
  return out.map((body, i) => ({
    body,
    ansi: body !== lines[i],
  }));
}

function formatBlock(
  text: string,
  prefix: string,
  bodyStyle: Style,
  prefixStyle?: Style,
  sentBy?: string,
  fillRow?: boolean,
): FormattedLine[] {
  // Mirror parseMarkdown: strip leading whitespace so a streamed/replayed
  // body that begins with a space doesn't push the first line one column
  // past the gutter and out of alignment with later rows.
  const lines = text.replace(/^\s+/, "").split("\n");
  const out: FormattedLine[] = [];
  if (sentBy) {
    out.push({
      prefix: "↳ ",
      prefixStyle: "dim",
      body: `from ${sentBy}`,
      bodyStyle: "dim",
    });
  }
  for (const line of lines) {
    const entry: FormattedLine = {
      prefix,
      prefixStyle: prefixStyle ?? bodyStyle,
      body: line,
      bodyStyle,
    };
    if (fillRow) {
      entry.fillRow = true;
    }
    out.push(entry);
  }
  return out;
}

// Compact byte-size label for the deferred-diff size hint (e.g. "~12 KB").
function formatDiffBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Humanize a millisecond span as "Xs" / "Ym Zs" / "Hh Mm". Shared by the
// busy banner, the tools-block header, and per-tool durations.
export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) {
    return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
  }
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin === 0 ? `${hr}h` : `${hr}h ${remMin}m`;
}

export interface ToolLineState {
  // The title from the initial `tool_call` event — usually the tool's
  // generic name (e.g. "Terminal", "Read File").
  initialTitle: string;
  // The most recent title from a `tool_call_update` event, if one carried
  // a refined label (e.g. the actual command, the file path). Falls back
  // to initialTitle.
  latestTitle: string;
  // Short single-line hint of what the tool acts on (bash command / file
  // path), shown after the verb so "bash"/"edit" rows say *which* one.
  detail?: string;
  // Un-clipped version of `detail` (full command / full path). Rendered
  // in the expanded view so users can read the whole thing instead of
  // the truncated …elided form shown in the collapsed row.
  detailFull?: string;
  status: string;
  // Optional error text from a `failed` update. When present, rendered as
  // an indented continuation line under the tool row so the user sees
  // *why* the tool failed instead of just a red ✗.
  errorText?: string;
  // In-memory record of the edit payload for this tool call (Edit /
  // Write / str_replace). Not consumed by formatToolLine — the scrollback
  // diff block is rendered separately by app.ts. Held here so the diff
  // from an initial `tool_call` (rawInput) survives until the later
  // `tool_call_update` that flips status to "completed", which is when
  // we actually drop the block into scrollback.
  editDiff?: EditDiff;
  // Wall-clock start of this tool call (set when the call first appears).
  // Drives the live "running for Xs" timer and the frozen "took Xs"
  // duration once the call reaches a terminal status.
  startedAt?: number;
  // Set the first time status flips to a terminal value (completed /
  // failed / etc.). Once set, the duration is frozen.
  endedAt?: number;
  // Identifier for the worker task that produced this tool call, forwarded
  // from the session update's workerTaskId field when present.
  workerTaskId?: string;
  // Captured plain-text output from the tool, extracted from the
  // `content[]` text blocks of a tool_call / tool_call_update payload.
  // Stored with latest-replaces semantics (each update overwrites).
  // Truncated to at most 40 lines or 4096 characters; when truncation
  // occurs, `resultTruncated` is true and the expansion renderer
  // appends a "… (truncated)" trailer.
  resultText?: string;
  // True when `resultText` was truncated because it exceeded 40 lines
  // or 4096 characters. Used by the expansion renderer to append a
  // "… (truncated)" trailer after the last visible line.
  resultTruncated?: boolean;
}

// Truncate a result-text string to at most 40 lines or 4096 characters,
// whichever limit is hit first. Returns { text, truncated }.
export function truncateResultText(raw: string): { text: string; truncated: boolean } {
  const MAX_CHARS = 4096;
  const MAX_LINES = 40;
  if (raw.length <= MAX_CHARS) {
    const lines = raw.split("\n");
    if (lines.length <= MAX_LINES) {
      return { text: raw, truncated: false };
    }
  }
  // Character cap first: slice to MAX_CHARS.
  let text = raw.slice(0, MAX_CHARS);
  let truncated = raw.length > MAX_CHARS;
  // Then enforce the line cap on the (possibly already-sliced) string.
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) {
    text = lines.slice(0, MAX_LINES).join("\n");
    truncated = true;
  }
  return { text, truncated };
}

// One tool call → one or more FormattedLines. The primary row is the
// icon + title (combined from initialTitle and latestTitle when the
// update refined the label). On failure, a second indented line carries
// the error text so a small red ✗ doesn't hide the actual cause.
//
// `now` is the wall-clock used to compute a still-running tool's live
// duration; it's threaded in (rather than read here) so the function stays
// pure and the 1Hz tools-block repaint advances the timer. Falls back to
// Date.now() for direct callers / tests that don't care about the tick.
export function formatToolLine(
  state: ToolLineState,
  now: number = Date.now(),
): FormattedLine[] {
  const initial = state.initialTitle;
  const latest = state.latestTitle;
  const initialLc = initial.toLowerCase();
  const latestLc = latest.toLowerCase();
  let title: string;
  if (latest === initial || latestLc.includes(initialLc)) {
    title = latest;
  } else if (initialLc.includes(latestLc)) {
    title = initial;
  } else {
    title = `${initial} · ${latest}`;
  }
  // Append the detail hint (bash command / file path) after the verb, so a
  // generic "bash"/"edit" row says which command/file — unless the title
  // already carries it (e.g. an agent that refines the title to the path).
  if (state.detail) {
    // Some adapters encode the tool verb into rawInput.command (e.g.
    // `command: "Read /foo"` for a Read tool), which would otherwise
    // double the verb: "Read · Read /foo". Strip a leading copy of the
    // title from the detail before appending.
    let detail = state.detail;
    const titleLc = title.toLowerCase();
    const detailLc = detail.toLowerCase();
    if (
      detailLc.startsWith(`${titleLc} `) ||
      detailLc.startsWith(`${titleLc}\t`)
    ) {
      detail = detail.slice(title.length).trimStart();
    }
    if (detail.length > 0 && !title.includes(detail)) {
      title = `${title} · ${detail}`;
    }
  }
  // Append a duration: a live "running for Xs" counter while in flight,
  // frozen as the total once the call hits a terminal status. Inherits the
  // row's status style (yellow while running, normal once done).
  if (state.startedAt !== undefined) {
    const end = state.endedAt ?? now;
    title = `${title} · ${formatElapsed(end - state.startedAt)}`;
  }
  const lines: FormattedLine[] = [
    {
      prefix: `  ${toolStatusIcon(state.status)} `,
      prefixStyle: toolIconStyle(state.status),
      body: title,
      bodyStyle: toolStatusStyle(state.status),
    },
  ];
  if (state.status === "failed" && state.errorText) {
    lines.push({
      prefix: "     ",
      body: sanitizeSingleLine(state.errorText),
      bodyStyle: "tool-status-fail",
    });
  }
  return lines;
}

// Render the expanded detail body for a single tool call. Called by
// buildToolsLines when a tool's id is in perToolExpanded and the tool
// does not carry an editDiff (edit/write tools keep their dedicated
// diff block). Returns zero lines when there is no body to render.
export function renderToolDetail(state: ToolLineState): FormattedLine[] {
  // Edit/write tools: skip the inline body entirely — the editdiff:
  // scrollback block handles everything for those tools.
  if (state.editDiff !== undefined) {
    return [];
  }
  const lines: FormattedLine[] = [];
  // Full detail text from the initial tool_call (command, file path,
  // etc.) — un-clipped when available, falling back to the truncated
  // summary form. Multi-line: each line gets its own dim row so a long
  // bash command wraps naturally instead of being squashed onto one row.
  const fullDetail = state.detailFull ?? state.detail;
  if (fullDetail) {
    for (const line of fullDetail.split("\n")) {
      lines.push({
        prefix: "     ",
        body: sanitizeSingleLine(line),
        bodyStyle: "dim",
      });
    }
  }
  // Error text only when the call actually failed — otherwise it's stale.
  if (state.status === "failed" && state.errorText) {
    lines.push({
      prefix: "     ",
      body: sanitizeSingleLine(state.errorText),
      bodyStyle: "tool-status-fail",
    });
  }
  // Captured result text from content[] blocks, split into individual
  // dim lines. If truncated, append a trailer after the last visible line.
  if (state.resultText) {
    const resultLines = state.resultText.split("\n");
    for (const line of resultLines) {
      lines.push({
        prefix: "     ",
        body: sanitizeSingleLine(line),
        bodyStyle: "dim",
      });
    }
    if (state.resultTruncated) {
      lines.push({
        prefix: "     ",
        body: "\u2026 (truncated)",
        bodyStyle: "dim",
      });
    }
  }
  return lines;
}

// Max body lines we paint per diff so a 500-line Write doesn't carpet
// scrollback. Hunks past the cap are summarized with a dim trailer.
const EDIT_DIFF_MAX_LINES = 40;

// How many unchanged context lines to keep around each change when an edit
// carries full-file old/new text (ACP "diff" content blocks, as pi emits).
// Infinity = no hunking (render every context line — the historical
// behavior, kept for the `hydra session diff` CLI path). The TUI sets a
// finite value at startup via setDiffContextLines so a 1-line edit in a
// big file shows a small hunk instead of the whole file.
let diffContextLines = Number.POSITIVE_INFINITY;
export function setDiffContextLines(n: number): void {
  diffContextLines = n >= 0 ? n : 0;
}

// Mode for formatEditDiffBlock — mirrors the `tui.showFileUpdates`
// config values that map to a non-empty block ("none" short-circuits
// upstream in app.ts before we get here).
export type FileUpdateMode = "edit" | "diff";

// Render an EditDiff as a standalone scrollback block. In "edit" mode
// the block is just a dim one-line mark identifying the file; in "diff"
// mode the same mark is followed by a ```diff fenced body run through
// parseAgentMarkdown so +/-/@@ lines pick up cli-highlight's coloring.
// Called by app.ts and upserted by toolCallId so a later
// tool_call_update can amend the block in place.
export function formatEditDiffBlock(
  diff: EditDiff,
  mode: FileUpdateMode,
  opts: { deferredStatus?: "fetching" | "error" } = {},
): FormattedLine[] {
  const lines: FormattedLine[] = [];
  // In "references" mode the body text hasn't been fetched yet (oldRef/
  // newRef carry the blob sha256 + byte size). We can't compute +/- counts
  // without the content, so the collapsed mark shows an approximate size
  // hint instead; the app fetches the body when the diff is expanded.
  const deferred = diff.oldRef !== undefined || diff.newRef !== undefined;
  let summary: string;
  if (deferred) {
    const bytes = (diff.oldRef?.bytes ?? 0) + (diff.newRef?.bytes ?? 0);
    summary = ` (~${formatDiffBytes(bytes)})`;
  } else {
    // Summarize the change as (+added -removed) so the one-line mark conveys
    // the edit's magnitude. Counts come from the same LCS op stream the diff
    // body uses, so they always agree with the rendered hunk. Omitted when
    // both are zero (e.g. a no-op or pure rename).
    const counts = countDiffChanges(diff);
    const summaryParts: string[] = [];
    if (counts.added > 0) {
      summaryParts.push(`+${counts.added}`);
    }
    if (counts.removed > 0) {
      summaryParts.push(`-${counts.removed}`);
    }
    summary = summaryParts.length > 0 ? ` (${summaryParts.join(" ")})` : "";
  }
  // Build the header lazily so the marker reflects whether a diff body
  // actually follows: ▾ (open) when an expanded body is rendered below,
  // ▸ (closed) for the terse one-line "edit" mark or a header-only diff.
  const header = (open: boolean): FormattedLine => ({
    prefix: "  ",
    body: `${open ? "▾" : "▸"} Edited ${sanitizeSingleLine(shortenHomePath(diff.path!))}${summary}`,
    bodyStyle: "dim",
  });
  if (mode === "edit") {
    if (diff.path) {
      lines.push(header(false));
    }
    return lines;
  }
  // Expanded but body not yet fetched (references mode): show the open
  // header + a placeholder. app.ts fetches the blob(s) and re-renders this
  // block with the real diff once they arrive.
  if (deferred) {
    if (diff.path) {
      lines.push(header(true));
      lines.push(
        opts.deferredStatus === "error"
          ? {
              prefix: "  ",
              body: "⚠ failed to load diff",
              bodyStyle: "tool-status-fail",
            }
          : {
              prefix: "  ",
              body: "⋯ fetching diff…",
              bodyStyle: "dim",
            },
      );
      lines.unshift({ body: "" });
    }
    return lines;
  }
  // No line cap in the TUI diff view — show the whole change rather than
  // truncating with a "… N more" footer. The collapsed "edit" mark is the
  // terse option; opting into "diff" means you want to see everything.
  const body = buildUnifiedDiff(diff, { maxLines: Infinity });
  if (body.length === 0) {
    // Nothing to expand — fall back to the closed header (or nothing).
    if (diff.path) {
      lines.push(header(false));
    }
    return lines;
  }
  if (diff.path) {
    lines.push(header(true));
  }
  const fenced = "```diff\n" + body + "\n```";
  lines.push(...parseAgentMarkdown(fenced));
  // In diff mode the block is a multi-line visual unit (mark + fenced
  // body); a leading blank line sets it off from the prose above. Only
  // added once we know there's real content to show.
  if (lines.length > 0) {
    lines.unshift({ body: "" });
  }
  return lines;
}

// Split an edit's old/new text into lines the way buildUnifiedDiff does:
// a trailing empty line from a final \n is dropped so a 3-line edit
// doesn't count as 4. Shared so the header summary and the rendered body
// always agree on line counts.
function diffLinePair(diff: EditDiff): { oldLines: string[]; newLines: string[] } {
  const oldLines = sanitizeWireText(diff.oldText).split("\n");
  const newLines = sanitizeWireText(diff.newText).split("\n");
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === "") {
    oldLines.pop();
  }
  if (newLines.length > 0 && newLines[newLines.length - 1] === "") {
    newLines.pop();
  }
  return { oldLines, newLines };
}

// Count added / removed lines for an edit via the same LCS op stream the
// unified-diff body uses, so the (+N -M) header summary matches the hunk.
export function countDiffChanges(diff: EditDiff): {
  added: number;
  removed: number;
} {
  const { oldLines, newLines } = diffLinePair(diff);
  let added = 0;
  let removed = 0;
  for (const op of diffLines(oldLines, newLines)) {
    if (op.op === "+") {
      added++;
    } else if (op.op === "-") {
      removed++;
    }
  }
  return { added, removed };
}

export interface BuildUnifiedDiffOptions {
  // Cap rendered lines (including the truncation trailer). Defaults to
  // EDIT_DIFF_MAX_LINES for the TUI scrollback path; callers like
  // `hydra session diff` pass Infinity to render the full body.
  maxLines?: number;
  // Unchanged context lines kept around each change. Defaults to the
  // module-level diffContextLines (Infinity unless setDiffContextLines was
  // called). Finite values collapse the runs of unchanged lines between
  // hunks into a "⋯ N unchanged lines" marker, so a 1-line edit in a big
  // file (e.g. an ACP full-file diff) renders a small hunk, not the whole
  // file.
  contextLines?: number;
}

// Render one LCS op as a unified-diff body line.
function renderDiffOp(op: DiffOp): string {
  if (op.op === "=") {
    return `  ${op.text}`;
  }
  return op.op === "-" ? `- ${op.text}` : `+ ${op.text}`;
}

// Build a unified-diff body for the given edit. Computes an LCS-based
// line-level diff so context lines flow between +/- chunks rather than
// painting every old line as removed and every new line as added.
// Collapses far-from-change context into hunks (contextLines) and
// truncates with a "… N more" footer past the configured cap.
export function buildUnifiedDiff(
  diff: EditDiff,
  opts: BuildUnifiedDiffOptions = {},
): string {
  const maxLines = opts.maxLines ?? EDIT_DIFF_MAX_LINES;
  const ctx = opts.contextLines ?? diffContextLines;
  const { oldLines, newLines } = diffLinePair(diff);
  const ops = diffLines(oldLines, newLines);

  // Hunking pass: with a finite context window, keep only changes and the
  // `ctx` unchanged lines on either side; runs of dropped context collapse
  // into a single gap marker. Infinite context (CLI path) renders every op.
  const display: string[] = [];
  if (!Number.isFinite(ctx)) {
    for (const op of ops) {
      display.push(renderDiffOp(op));
    }
  } else {
    const hasChange = ops.some((o) => o.op !== "=");
    if (!hasChange) {
      return "";
    }
    const keep = new Array<boolean>(ops.length).fill(false);
    for (let i = 0; i < ops.length; i++) {
      if (ops[i]!.op !== "=") {
        const lo = Math.max(0, i - ctx);
        const hi = Math.min(ops.length - 1, i + ctx);
        for (let k = lo; k <= hi; k++) {
          keep[k] = true;
        }
      }
    }
    let i = 0;
    while (i < ops.length) {
      if (keep[i]) {
        display.push(renderDiffOp(ops[i]!));
        i++;
        continue;
      }
      let j = i;
      while (j < ops.length && !keep[j]) {
        j++;
      }
      const skipped = j - i;
      display.push(`  ⋯ ${skipped} unchanged line${skipped === 1 ? "" : "s"}`);
      i = j;
    }
  }

  // Line-cap pass over the (possibly hunked) body.
  const rendered: string[] = [];
  for (let idx = 0; idx < display.length; idx++) {
    const wouldTruncate =
      rendered.length >= maxLines - 1 && idx < display.length - 1;
    if (wouldTruncate) {
      const remaining = display.length - idx;
      rendered.push(`… ${remaining} more line${remaining === 1 ? "" : "s"}`);
      break;
    }
    rendered.push(display[idx]!);
  }
  return rendered.join("\n");
}

interface DiffOp {
  op: "=" | "-" | "+";
  text: string;
}

// LCS-based line diff. O(n*m) time/space — fine for the small hunks edit
// tools emit (old_string / new_string slices, not whole files). Write
// tools land here too, but their diff is "every new line is +", which
// the table reduces to a single column of inserts in linear time.
//
// Some agents (e.g. pi) emit FULL-FILE old/new text, so a 1-line edit to a
// 5000-line file would otherwise build a 5000x5000 LCS matrix (~26M cells,
// hundreds of MB, seconds of CPU) — and countDiffChanges runs this for the
// header summary of *every* edit, even collapsed. So we first strip the
// common leading/trailing lines (which are unchanged "=" context anyway)
// and run the quadratic LCS only on the differing middle. Localized edits
// then diff a handful of lines instead of the whole file.
function diffLines(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  const minLen = Math.min(a.length, b.length);
  while (start < minLen && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffOp[] = [];
  for (let k = 0; k < start; k++) {
    out.push({ op: "=", text: a[k]! });
  }
  out.push(...lcsDiff(a.slice(start, endA), b.slice(start, endB)));
  for (let k = endA; k < a.length; k++) {
    out.push({ op: "=", text: a[k]! });
  }
  return out;
}

// Quadratic LCS diff over the (already prefix/suffix-trimmed) slices.
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) {
    const out: DiffOp[] = [];
    for (const text of a) {
      out.push({ op: "-", text });
    }
    for (const text of b) {
      out.push({ op: "+", text });
    }
    return out;
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0) as number[],
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ op: "=", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ op: "-", text: a[i]! });
      i++;
    } else {
      out.push({ op: "+", text: b[j]! });
      j++;
    }
  }
  while (i < m) {
    out.push({ op: "-", text: a[i]! });
    i++;
  }
  while (j < n) {
    out.push({ op: "+", text: b[j]! });
    j++;
  }
  return out;
}

// A tool call is "done" once it reaches any of these statuses. Used to
// freeze the per-tool duration timer.
export function isTerminalToolStatus(status: string): boolean {
  switch (status) {
    case "completed":
    case "succeeded":
    case "ok":
    case "failed":
    case "error":
    case "rejected":
    case "cancelled":
      return true;
    default:
      return false;
  }
}

function toolStatusIcon(status: string): string {
  switch (status) {
    case "completed":
    case "succeeded":
    case "ok":
      return "✓";
    case "failed":
    case "error":
      return "✗";
    case "rejected":
      return "⊘";
    case "cancelled":
      return "⊝";
    case "in_progress":
    case "running":
    case "updated":
    case "pending":
    default:
      // Same spinner glyph for queued vs. running — bodyStyle distinguishes
      // them visually (dim vs. bold).
      return "◐";
  }
}

// Icon color tracks the icon's meaning, not the line's emphasis: the ◐
// stays yellow (matching the busy banner / plan accent) for both queued
// and running, so any tool with work pending reads as "active" at a glance.
function toolIconStyle(status: string): Style {
  switch (status) {
    case "completed":
    case "succeeded":
    case "ok":
      return "tool-status-ok";
    case "failed":
    case "error":
    case "rejected":
      return "tool-status-fail";
    case "cancelled":
      return "tool-status-cancelled";
    default:
      return "tool-status-running";
  }
}

export interface ExitPlanState {
  plan: string;
  status?: string;
}

// Render Claude's ExitPlanMode plan as a scrollback block: a 📋 Plan header,
// the markdown body parsed via parseAgentMarkdown (same renderer agent text
// uses, so headers/bullets/fences are styled), and a trailing status line
// reflecting the user's approval choice. Keyed by toolCallId via
// screen.upsertLines so status flips amend the block in place.
export function formatExitPlanMode(state: ExitPlanState): FormattedLine[] {
  const lines: FormattedLine[] = [
    {
      prefix: "▣ ",
      prefixStyle: "plan",
      body: "Plan",
      bodyStyle: "plan",
    },
  ];
  lines.push(...parseAgentMarkdown(state.plan));
  const status = state.status;
  if (status !== undefined) {
    const footer = exitPlanFooter(status);
    if (footer !== null) {
      lines.push(footer);
    }
  }
  return lines;
}

function exitPlanFooter(status: string): FormattedLine | null {
  switch (status) {
    case "completed":
    case "succeeded":
    case "ok":
      return {
        prefix: "  ",
        body: "✓ Approved",
        bodyStyle: "tool-status-ok",
      };
    case "failed":
    case "error":
    case "rejected":
      return {
        prefix: "  ",
        body: "✗ Rejected",
        bodyStyle: "tool-status-fail",
      };
    case "cancelled":
      return {
        prefix: "  ",
        body: "⊝ Cancelled",
        bodyStyle: "tool-status-cancelled",
      };
    case "pending":
    case "in_progress":
    case "running":
    case "updated":
      return {
        prefix: "  ",
        body: "awaiting approval…",
        bodyStyle: "dim",
      };
    default:
      return null;
  }
}

// Maximum plan entries rendered inline before the formatter switches to a
// sliding window. Picked to match the tools-block cap so a busy turn with
// both a long plan and many tool calls stays roughly the same vertical
// footprint as a turn with one or the other.
const PLAN_VISIBLE_LIMIT = 5;

// Pick the window of entries to render when there are too many to show
// all at once. Anchors the window on the "action point" — the first
// in_progress entry, falling back to the first pending entry, then the
// last entry when everything is done — and biases the window to put the
// anchor near the middle so the user can see what just finished above
// and what's coming below. Sliding the start back when the right edge
// hits `total` keeps the window the same width as the anchor approaches
// the end of the list. A limit of 0 disables windowing — every entry
// is included.
export function pickPlanWindow(
  entries: PlanEntry[],
  limit: number,
): { start: number; end: number } {
  const total = entries.length;
  if (limit <= 0 || total <= limit) {
    return { start: 0, end: total };
  }
  const inProgressIdx = entries.findIndex(
    (e) => (e.status ?? "pending") === "in_progress",
  );
  const firstPendingIdx = entries.findIndex(
    (e) => (e.status ?? "pending") === "pending",
  );
  const anchor =
    inProgressIdx >= 0
      ? inProgressIdx
      : firstPendingIdx >= 0
        ? firstPendingIdx
        : total - 1;
  const aboveSlots = Math.floor((limit - 1) / 2);
  let start = Math.max(0, anchor - aboveSlots);
  let end = Math.min(total, start + limit);
  if (end - start < limit) {
    start = Math.max(0, end - limit);
  }
  return { start, end };
}

function formatPlan(
  event: Extract<RenderEvent, { kind: "plan" }>,
  limit: number,
): FormattedLine[] {
  const stopped = event.stopped === true;
  const amended = event.amended === true;
  // Amended is a deliberate user action (the user replaced this prompt),
  // not a failure — dim the header so it doesn't read as an error.
  const stoppedStyle: Style = amended ? "tool-status-cancelled" : "tool-status-fail";
  // Header tracks the plan's overall state: yellow ("plan") while any
  // entry is still pending/in-progress (matches the busy banner + running
  // tool accent), green ("plan-done") once every entry is completed so a
  // finished plan stops drawing the eye like an active one. When the turn
  // ends with a non-success stopReason and the plan didn't finish, the
  // header flips to bold red ("tool-status-fail") to match the
  // "stopped (<reason>)" treatment on the tools block — except for
  // amended turns, which dim instead since they aren't errors.
  const allComplete = event.entries.every(
    (e) => (e.status ?? "pending") === "completed",
  );
  const headerStyle: Style = allComplete
    ? "plan-done"
    : stopped
      ? stoppedStyle
      : "plan";
  const total = event.entries.length;
  const { start: winStart, end: winEnd } = pickPlanWindow(
    event.entries,
    limit,
  );
  const truncated = winEnd - winStart < total;
  // Summary suffix only when truncation is in play — for short plans the
  // entries themselves carry the status and a counter would be noise.
  // "X done · Y left" mirrors the user's mental model (work behind /
  // ahead) rather than which rows are off-screen, since the off-screen
  // rows can be either side of the active entry.
  let headerBody = "Plan";
  if (truncated) {
    let doneCount = 0;
    for (const e of event.entries) {
      if ((e.status ?? "pending") === "completed") {
        doneCount += 1;
      }
    }
    const leftCount = total - doneCount;
    // Once everything is checked off, "0 left" is just noise — the
    // green header style already signals completion. Drop it.
    headerBody =
      leftCount === 0
        ? `Plan · ${doneCount} done`
        : `Plan · ${doneCount} done · ${leftCount} left`;
  }
  const lines: FormattedLine[] = [
    {
      prefix: "▣ ",
      prefixStyle: headerStyle,
      body: headerBody,
      bodyStyle: headerStyle,
    },
  ];
  for (let i = winStart; i < winEnd; i++) {
    const entry = event.entries[i];
    if (!entry) {
      continue;
    }
    const status = entry.status ?? "pending";
    const marker =
      status === "completed"
        ? "[x]"
        : status === "in_progress"
          ? "[~]"
          : "[ ]";
    // In_progress entries are no longer running once the turn stopped —
    // dim them so the row reads as "didn't get there" rather than
    // "actively working".
    const style: Style =
      status === "completed"
        ? "plan-done"
        : status === "in_progress"
          ? stopped
            ? "plan-pending"
            : "plan"
          : "plan-pending";
    // Agents sometimes decorate each plan entry with a "N/M" progress
    // marker — either leading ("1/5 Read config") or trailing
    // ("Read config (1/5)" / "Read config 1/5"). Now that the header
    // carries "X done · Y left", the per-entry marker is redundant
    // noise. Strip leading and trailing forms; preserve any other use
    // of digits inside the entry.
    const content = entry.content
      .replace(/^\d+\/\d+\s+/, "")
      .replace(/\s*\(?\d+\/\d+\)?\s*$/, "");
    lines.push({
      prefix: "  ",
      body: `${marker} ${content}`,
      bodyStyle: style,
    });
  }
  return lines;
}

function toolStatusStyle(status: string): Style {
  switch (status) {
    case "completed":
    case "succeeded":
    case "ok":
      return "tool-status-ok";
    case "failed":
    case "error":
    case "rejected":
      return "tool-status-fail";
    case "in_progress":
    case "running":
    case "updated":
      return "tool-status-running";
    case "cancelled":
      return "tool-status-cancelled";
    default:
      // pending / unknown — the "waiting" state
      return "tool-status-pending";
  }
}
