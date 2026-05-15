// Maps RenderEvents to FormattedLines. Pure (no I/O, no terminal-kit) so the
// screen layer is the only place that knows how to translate Style names
// into ANSI/terminal-kit calls.

import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";
import type { RenderEvent } from "./render-update.js";

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
      return [
        {
          prefix: "» ",
          prefixStyle: "info",
          body: `model: ${event.model}`,
          bodyStyle: "info",
        },
      ];
    case "turn-complete":
      // Boundary is rendered as a blank separator only — see the
      // ensureSeparator() call in app.ts after a turn-complete event.
      return [];
    case "usage-update":
      // Usage is rendered in the header by the app, not in scrollback.
      return [];
    case "available-commands":
      // Commands are stored as completion data, not rendered to scrollback.
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
function applyInlineMarkup(text: string): string {
  let s = text.replace(/\^/g, "^^");
  s = s.replace(/\*\*(.+?)\*\*/g, "^+$1^:");
  s = s.replace(/`([^`]+)`/g, "^C$1^:");
  return s;
}

// Block-level markdown → FormattedLines. Mirrors the regex-based approach
// in @hydra-acp/browser's markdown.ts: each newline-separated line is
// classified once and emitted with a matching style. Streamed agent text
// is fed through this on every chunk and the resulting lines are upserted
// as a single keyed block (so re-parsing is idempotent and the block
// mutates in place as more content arrives). Inline marks for bold + code
// are applied to plain prose / list items (see applyInlineMarkup); they
// are intentionally NOT applied inside code fences (literal display) or
// headings (already styled at the block level).
export function parseAgentMarkdown(text: string): FormattedLine[] {
  const out: FormattedLine[] = [];
  const lines = text.split("\n");
  let inCode = false;
  let codeLang = "";
  let codeBuffer: string[] = [];
  const flushCode = (): void => {
    if (codeBuffer.length === 0) {
      return;
    }
    const highlighted = highlightFencedBlock(codeLang, codeBuffer);
    for (const piece of highlighted) {
      const entry: FormattedLine = {
        prefix: "  ",
        body: piece.body,
        bodyStyle: "code",
        fillRow: true,
      };
      if (piece.ansi) {
        entry.ansi = true;
      }
      out.push(entry);
    }
    codeBuffer = [];
    codeLang = "";
  };
  for (const line of lines) {
    const fence = line.match(/^\s*```\s*(\w*)\s*$/);
    if (fence) {
      if (!inCode) {
        inCode = true;
        codeLang = fence[1] ?? "";
      } else {
        flushCode();
        inCode = false;
      }
      // Don't render the ``` fence line itself — the styled bg of the
      // following code lines is the visual cue that we're in a block.
      continue;
    }
    if (inCode) {
      codeBuffer.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2] ?? "";
      const style: Style =
        level === 1 ? "heading-1" : level === 2 ? "heading-2" : "heading-3";
      out.push({
        prefix: "  ",
        body: text,
        bodyStyle: style,
      });
      continue;
    }
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const indent = bullet[1] ?? "";
      const item = bullet[2] ?? "";
      out.push({
        prefix: "  ",
        body: `${indent}• ${applyInlineMarkup(item)}`,
        bodyStyle: "agent",
      });
      continue;
    }
    const ordered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (ordered) {
      const indent = ordered[1] ?? "";
      const num = ordered[2] ?? "";
      const item = ordered[3] ?? "";
      out.push({
        prefix: "  ",
        body: `${indent}${num}. ${applyInlineMarkup(item)}`,
        bodyStyle: "agent",
      });
      continue;
    }
    out.push({
      prefix: "  ",
      body: applyInlineMarkup(line),
      bodyStyle: "agent",
    });
  }
  // Mid-stream: the closing fence hasn't arrived yet but we still need
  // the in-progress code visible. Flush the buffer with whatever language
  // hint was captured (or none) so the user sees content as it streams.
  if (inCode) {
    flushCode();
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
}

// Render the single line that represents a tool call. Combines the initial
// (generic) title with the refined update title when they add information,
// and folds them into one when the refinement subsumes the initial label.
// The icon is styled independently from the title so the active glyph (◐)
// stays yellow even while the title is dimmed to mark a queued call.
export function formatToolLine(state: ToolLineState): FormattedLine {
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
  return {
    prefix: `  ${toolStatusIcon(state.status)} `,
    prefixStyle: toolIconStyle(state.status),
    body: title,
    bodyStyle: toolStatusStyle(state.status),
  };
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

function formatPlan(event: Extract<RenderEvent, { kind: "plan" }>): FormattedLine[] {
  if (event.entries.length === 0) {
    return [
      {
        prefix: "▣ ",
        prefixStyle: "plan",
        body: "(empty plan)",
        bodyStyle: "dim",
      },
    ];
  }
  // Header tracks the plan's overall state: yellow ("plan") while any
  // entry is still pending/in-progress (matches the busy banner + running
  // tool accent), green ("plan-done") once every entry is completed so a
  // finished plan stops drawing the eye like an active one.
  const allComplete = event.entries.every(
    (e) => (e.status ?? "pending") === "completed",
  );
  const headerStyle: Style = allComplete ? "plan-done" : "plan";
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
    const style: Style =
      status === "completed"
        ? "plan-done"
        : status === "in_progress"
          ? "plan"
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
