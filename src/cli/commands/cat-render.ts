import chalk from "chalk";
import stripAnsi from "strip-ansi";
import {
  parseAgentMarkdown,
  type FormattedLine,
  type Style,
} from "../../tui/format.js";

// `hydra-acp cat` markdown post-processor. Sits between agent-text events
// and stdout: turns the same FormattedLine[] the TUI renders into a single
// string of either ANSI-styled text (TTY) or plain text (pipe). Tables
// (already laid out with box-drawing chars by formatTable) pass through
// in both modes. --raw bypasses this entirely.

export type CatRenderMode = "ansi" | "plain";

// Force-level-3 chalk so escapes appear even when stdout isn't a TTY at
// the chalk-detection layer (vitest, the cli being piped through `cat`,
// etc.). The cat-render mode flag — not chalk's autodetection — decides
// whether to emit them.
const ansiChalk = new chalk.Instance({ level: 3 });

export function renderMarkdownForCat(
  text: string,
  mode: CatRenderMode,
): string {
  if (text.length === 0) {
    return "";
  }
  const lines = parseAgentMarkdown(text);
  if (lines.length === 0) {
    return "";
  }
  const out: string[] = [];
  for (const line of lines) {
    out.push(renderLine(line, mode));
  }
  let joined = out.join("\n");
  if (!joined.endsWith("\n")) {
    joined += "\n";
  }
  return joined;
}

function renderLine(line: FormattedLine, mode: CatRenderMode): string {
  let body = translateMarkup(line.body, mode);
  if (mode === "ansi") {
    body = applyStyle(body, line.bodyStyle);
  } else {
    // Strip any ANSI that parseAgentMarkdown's cli-highlight pass embedded
    // into a fenced code line. translateMarkup only deals with terminal-kit
    // ^X markers; SGR escapes in the body need a separate strip.
    body = stripAnsi(body);
  }
  return body;
}

// Convert terminal-kit caret markup emitted by applyInlineMarkup into
// either ANSI escapes (ansi mode) or nothing (plain mode). Order matters:
// `^^` is the escape for a literal `^`, so we stash it under a sentinel
// first; without that, `^^C` would mis-parse as `^` + `^C` after the next
// step. The thought-mode variants (`^c`, `^-`, `^K`) shouldn't appear here
// — parseAgentMarkdown only emits agent-style markup — but the fallback
// regex strips them defensively if a stray one ever leaks through.
const ANSI_BOLD = "\x1b[1m";
const ANSI_CODE = "\x1b[96m";
const ANSI_RESET = "\x1b[0m";
// NUL as a sentinel for stashed literal carets. sanitizeWireText in
// core/render-update.ts strips C0 controls (NUL included) from incoming
// agent text, so it can never collide with content the buffer holds.
const CARET_SENTINEL = "\x00";

function translateMarkup(text: string, mode: CatRenderMode): string {
  let s = text.replace(/\^\^/g, CARET_SENTINEL);
  if (mode === "ansi") {
    s = s
      .replace(/\^\+/g, ANSI_BOLD)
      .replace(/\^C/g, ANSI_CODE)
      .replace(/\^:/g, ANSI_RESET);
  }
  s = s.replace(/\^[+\-:CcK]/g, "");
  s = s.replace(/\x00/g, "^");
  return s;
}

// Map FormattedLine.bodyStyle to a chalk wrapper for ansi mode. Mirrors
// the TUI's styleFor (cli/src/tui/screen.ts) for the subset that matters
// when parseAgentMarkdown is the source: headings, table separator
// (`dim`), and the default unstyled prose (`agent`). Fenced-code lines
// carry their syntax-highlighted ANSI inside `body` already; we pass
// them through unmodified rather than overlaying a bg color the TUI
// applies, which would clash with a piped consumer's terminal width.
function applyStyle(text: string, style: Style | undefined): string {
  if (text.length === 0 || style === undefined) {
    return text;
  }
  switch (style) {
    case "heading-1":
      return ansiChalk.bold.yellowBright(text);
    case "heading-2":
      return ansiChalk.bold.cyanBright(text);
    case "heading-3":
      return ansiChalk.bold(text);
    case "dim":
      return ansiChalk.dim(text);
    default:
      return text;
  }
}
