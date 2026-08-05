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
// Keyed as a Partial<Record<Style, …>> rather than a switch with a default
// arm so a renamed token fails to compile here instead of silently losing
// its colour in piped output. Note the gap that remains: *adding* a Style
// still compiles, and anything absent falls through unstyled. That is
// intentional for the tokens the app/sidebar layers own (notices, metrics,
// sidebar chrome) since none of them can reach `cat` today, but it does mean
// routing slash-command output through `cat` would need entries here.
const CAT_ANSI_STYLES: Partial<
  Record<Style, (text: string) => string>
> = {
  "heading-1": (t) => ansiChalk.bold.yellowBright(t),
  "heading-2": (t) => ansiChalk.bold.cyanBright(t),
  "heading-3": (t) => ansiChalk.bold(t),
  // The markdown table's ───┼─── rule. parseAgentMarkdown's only muted line.
  muted: (t) => ansiChalk.dim(t),
};

function applyStyle(text: string, style: Style | undefined): string {
  if (text.length === 0 || style === undefined) {
    return text;
  }
  return CAT_ANSI_STYLES[style]?.(text) ?? text;
}
