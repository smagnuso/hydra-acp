import wrapAnsi from "wrap-ansi";
import type { Terminal } from "terminal-kit";
import {
  drawBox,
  readTermHeight,
  readTermWidth,
  resetTerminalModes,
  runModalPrompt,
  truncate,
  type BoxLayout,
} from "./prompt-utils.js";

export type StartupFailureResult = "retry" | "back" | "cancel";

// Widest the box grows regardless of terminal size — past this, extra
// width stops helping the repro line and the box just looks unwieldy.
// drawBox additionally clamps to the terminal width.
const MAX_CONTENT_WIDTH = 100;

// Shown when a brand-new session's agent fails to come up — spawn error,
// immediate exit, or a connection lost during initialize/session/new.
// The failure is recoverable, so we report the reason and let the user
// retry the same agent, go back to the picker to choose another, or
// cancel out — instead of the whole TUI dying on an opaque error. Sibling
// to promptAuthRequiredBanner; same modal/box machinery.
//
// The message can carry a multi-line stderr tail and a repro command, so
// content is hard-wrapped (not truncated) to the box width and the box is
// sized wide so those lines stay readable/copyable.
export async function promptStartupFailureBanner(
  term: Terminal,
  agentId: string | undefined,
  message: string,
  opts?: { canGoBack?: boolean },
): Promise<StartupFailureResult> {
  resetTerminalModes();
  const canGoBack = opts?.canGoBack !== false;
  const title = agentId ? `Couldn't start ${agentId}` : "Couldn't start session";
  const rawLines = message
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  const footer = canGoBack
    ? "r retry · Esc back to picker · ^C cancel"
    : "r retry · Esc / ^C exit";

  const render = (): BoxLayout => {
    const termW = readTermWidth(term);
    const termH = readTermHeight(term);
    const contentW = Math.min(MAX_CONTENT_WIDTH, Math.max(20, termW - 4));
    // Every content line is painted with a leading space, so wrap one
    // column narrower. `hard` breaks long unbroken tokens (e.g. the repro
    // command's absolute paths) instead of overflowing the box.
    const wrapW = Math.max(1, contentW - 1);
    const wrapped = rawLines.flatMap((l) =>
      wrapAnsi(l, wrapW, { hard: true, trim: false }).split("\n"),
    );
    // Chrome rows: title + blank + blank + footer. Bound the body (plus a
    // possible overflow notice) to the remaining vertical space so the box
    // never runs off-screen; the full text is always in tui.log.
    const avail = Math.max(1, termH - 4 - 4);
    const overflow = wrapped.length > avail;
    const body = overflow ? wrapped.slice(0, avail - 1) : wrapped;
    const rows = body.length + (overflow ? 1 : 0) + 4;
    const layout = drawBox(term, {
      contentHeight: rows,
      contentWidth: contentW,
      title: "Agent failed to start",
    });
    const innerW = layout.contentW;
    let row = 0;
    term.moveTo(layout.contentX, layout.contentY + row);
    term.brightWhite.bold.noFormat(truncate(` ${title}`, innerW));
    row += 2;
    for (const line of body) {
      term.moveTo(layout.contentX, layout.contentY + row);
      term.brightRed.noFormat(truncate(` ${line}`, innerW));
      row++;
    }
    if (overflow) {
      term.moveTo(layout.contentX, layout.contentY + row);
      term.dim.noFormat(truncate(" … (full details in ~/.hydra-acp/tui.log)", innerW));
      row++;
    }
    row++;
    term.moveTo(layout.contentX, layout.contentY + row);
    term.dim.noFormat(truncate(` ${footer}`, innerW));
    return layout;
  };

  return runModalPrompt<StartupFailureResult>({
    term,
    render: () => {
      render();
    },
    onKey: (name, _matches, _data, finish) => {
      if (name === "r" || name === "R" || name === "ENTER" || name === "KP_ENTER") {
        finish("retry");
        return;
      }
      if (name === "ESCAPE") {
        finish(canGoBack ? "back" : "cancel");
        return;
      }
      if (name === "CTRL_C") {
        finish("cancel");
      }
    },
  });
}
