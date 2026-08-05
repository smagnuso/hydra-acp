import stripAnsi from "strip-ansi";
import {
  parseAgentMarkdown,
  type FormattedLine,
  type Style,
} from "../../tui/format.js";
import { styled } from "../../tui/theme/index.js";

// `hydra-acp cat` markdown post-processor. Sits between agent-text events
// and stdout: turns the same FormattedLine[] the TUI renders into a single
// string of either ANSI-styled text (TTY) or plain text (pipe). Tables
// (already laid out with box-drawing chars by formatTable) pass through
// in both modes. --raw bypasses this entirely.

export type CatRenderMode = "ansi" | "plain";

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
  if (mode === "ansi") {
    // Inline spans (`code`, **bold**, links) are already SGR in the body,
    // emitted by format.ts. Only the per-line base style has to be added.
    return applyStyle(line.body, line.bodyStyle);
  }
  // Plain mode: drop the inline spans along with anything cli-highlight
  // embedded into a fenced code line.
  return stripAnsi(line.body);
}

// Map FormattedLine.bodyStyle to a chalk wrapper for ansi mode. Only covers
// what parseAgentMarkdown actually emits, which is the sole source here:
// headings, the table separator rule, and default unstyled prose (`agent`).
// Fenced-code lines carry their syntax-highlighted ANSI inside `body`
// already; they pass through unmodified rather than having the TUI's
// background colour overlaid, which would clash with a piped consumer.
//
// An allowlist rather than a mapping: the bytes come from the theme, so a
// heading recoloured there is recoloured here too. This file used to restate
// each colour in chalk, which meant `hydra cat` quietly ignored the theme.
//
// It stays an allowlist because "style every token" would be wrong for `code`:
// fenced lines already carry cli-highlight's ANSI in `body`, and overlaying the
// TUI's background band would fight a piped consumer's terminal.
//
// Typed as ReadonlySet<Style> so a renamed token fails to compile. The gap that
// remains: *adding* a Style still compiles and falls through unstyled. That is
// fine for the tokens the app and sidebar own (notices, metrics, sidebar
// chrome) since none of them can reach `cat`, but routing slash-command output
// through `cat` would need entries here.
const CAT_STYLED: ReadonlySet<Style> = new Set<Style>([
  "heading-1",
  "heading-2",
  "heading-3",
  // The markdown table's ───┼─── rule. parseAgentMarkdown's only muted line.
  "muted",
]);

function applyStyle(text: string, style: Style | undefined): string {
  if (text.length === 0 || style === undefined || !CAT_STYLED.has(style)) {
    return text;
  }
  return styled(style, text);
}
