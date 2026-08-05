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
