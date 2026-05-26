// Maps RenderEvents to FormattedLines. Pure (no I/O, no terminal-kit) so the
// screen layer is the only place that knows how to translate Style names
// into ANSI/terminal-kit calls.

import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";
import stringWidth from "string-width";
import { sanitizeSingleLine, type RenderEvent } from "../core/render-update.js";

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
  | "search-highlight-active";

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
}

export function formatEvent(event: RenderEvent): FormattedLine[] {
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
      return formatBlock(event.text, "· ", "thought", "thought");
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
      return formatPlan(event);
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
      // Stored as completion/mode data, not rendered to scrollback.
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
// Thoughts pass "^-" for both so bold and inline code stay within the gray
// register (bold-off only, no color change) rather than resetting to default fg.
function applyInlineMarkup(
  text: string,
  opts?: { boldReset?: string; codeReset?: string },
): string {
  const boldReset = opts?.boldReset ?? "^:";
  const codeReset = opts?.codeReset ?? "^:";
  let s = text.replace(/\^/g, "^^");
  s = s.replace(/\*\*(.+?)\*\*/g, `^+$1${boldReset}`);
  s = s.replace(/`([^`]+)`/g, `^C$1${codeReset}`);
  return s;
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
  inlineOpts?: { boldReset?: string; codeReset?: string };
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
  } = opts;
  const out: FormattedLine[] = [];
  const lines = text.split("\n");
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
      line(headingText, headingStyle, nextPrefix());
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
      const tableLines = formatTable(header, body);
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
  return out;
}

export function parseAgentMarkdown(text: string): FormattedLine[] {
  return parseMarkdown(text, { proseStyle: "agent", highlightCode: true });
}

// Thoughts use proseStyle "thought" throughout so the ^T hide-thoughts filter
// (which keys on bodyStyle) catches every line. The "· " gutter appears on
// the first non-blank line; both inline resets use "^-" (bold-off only) so
// bold and code spans stay in the same gray register without a hue shift.
export function parseThoughtMarkdown(text: string): FormattedLine[] {
  return parseMarkdown(text, {
    proseStyle: "thought",
    highlightCode: false,
    prefixStyle: "thought",
    firstPrefix: "· ",
    inlineOpts: { boldReset: "^-", codeReset: "^-" },
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

// Visible terminal width of a cell. Two flavors:
//   - asLiteral=true:  cell renders verbatim (heading-3 header rows
//                      go through term.bold.noFormat, no markup is
//                      interpreted). Measure the string as-is.
//   - asLiteral=false: cell renders through applyInlineMarkup +
//                      term(text), so **bold** -> ^+bold^: (4
//                      zero-width markup chars + the inner text)
//                      and `code` -> ^Ccode^: (likewise). Measure
//                      what the user sees by stripping those
//                      markers. Italic *…* / _…_ stay intact —
//                      applyInlineMarkup leaves them literal, so
//                      they contribute to visible width.
// Uses string-width so wide glyphs (CJK, emoji) count as 2 cols and
// code-point oddities (combining marks, ZWJ sequences) reflect their
// on-screen footprint rather than .length.
function cellVisibleWidth(cell: string, asLiteral: boolean): number {
  if (asLiteral) {
    return stringWidth(cell);
  }
  const visible = cell
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
  return stringWidth(visible);
}

// Emit a header row (heading-3), a dim `─┼─` rule, then one row per body
// entry. Column widths are the max of (a) the header cell measured
// literally — heading-3 lines render via term.bold.noFormat with no
// markup interpretation, so any `**bold**` / `` `code` `` markers in
// the header take real columns — and (b) each body cell measured
// with applyInlineMarkup's markers stripped, since body cells are
// interpreted by term(text). string-width is used throughout so wide
// glyphs (→ in ambiguous-wide terminals, emoji, CJK) align correctly.
function formatTable(header: string[], body: string[][]): FormattedLine[] {
  const cols = header.length;
  const widths: number[] = new Array(cols).fill(0);
  for (let c = 0; c < cols; c++) {
    widths[c] = cellVisibleWidth(header[c] ?? "", true);
  }
  for (const row of body) {
    for (let c = 0; c < cols; c++) {
      const cell = row[c] ?? "";
      const w = cellVisibleWidth(cell, false);
      if (w > widths[c]!) {
        widths[c] = w;
      }
    }
  }
  const renderRow = (
    cells: string[],
    style: Style,
    applyMarkup: boolean,
  ): FormattedLine => {
    const padded: string[] = [];
    for (let c = 0; c < cols; c++) {
      const cell = cells[c] ?? "";
      const w = widths[c]!;
      const visible = cellVisibleWidth(cell, !applyMarkup);
      const rendered = applyMarkup ? applyInlineMarkup(cell) : cell;
      padded.push(rendered + " ".repeat(Math.max(0, w - visible)));
    }
    return {
      prefix: "  ",
      body: padded.join(" │ "),
      bodyStyle: style,
    };
  };
  const out: FormattedLine[] = [];
  out.push(renderRow(header, "heading-3", false));
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
    out.push(renderRow(row, "agent", true));
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
  const lines = text.split("\n");
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

export interface ToolLineState {
  // The title from the initial `tool_call` event — usually the tool's
  // generic name (e.g. "Terminal", "Read File").
  initialTitle: string;
  // The most recent title from a `tool_call_update` event, if one carried
  // a refined label (e.g. the actual command, the file path). Falls back
  // to initialTitle.
  latestTitle: string;
  status: string;
  // Optional error text from a `failed` update. When present, rendered as
  // an indented continuation line under the tool row so the user sees
  // *why* the tool failed instead of just a red ✗.
  errorText?: string;
}

// One tool call → one or more FormattedLines. The primary row is the
// icon + title (combined from initialTitle and latestTitle when the
// update refined the label). On failure, a second indented line carries
// the error text so a small red ✗ doesn't hide the actual cause.
export function formatToolLine(state: ToolLineState): FormattedLine[] {
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

function formatPlan(event: Extract<RenderEvent, { kind: "plan" }>): FormattedLine[] {
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
  const lines: FormattedLine[] = [
    {
      prefix: "▣ ",
      prefixStyle: headerStyle,
      body: "Plan",
      bodyStyle: headerStyle,
    },
  ];
  for (const entry of event.entries) {
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
    lines.push({
      prefix: "  ",
      body: `${marker} ${entry.content}`,
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
