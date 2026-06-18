// Pre-screen modal that asks the user for a local cwd when they pick
// "Fork locally" on an imported session that has never been launched
// on this machine. Originally a plain stack of text lines under the
// picker; now a centered bordered dialog matching
// promptForImportAction's look.
//
// Esc returns "back" so the caller can re-show the action dialog. ^C /
// ^D return "cancel" which the caller treats as a full TUI exit. Enter
// awaits validateLocalCwd() and only resolves with the path if the
// directory exists; otherwise the error is rendered inline and the
// user keeps editing.

import type { Terminal } from "terminal-kit";
import * as os from "node:os";
import { shortenHomePath } from "../core/paths.js";
import { stripHydraSessionPrefix } from "../core/session.js";
import {
  completeLocalPath,
  pickInitialLocalCwd,
  validateLocalCwd,
} from "../core/cwd.js";
import type { DiscoveredSession } from "./discovery.js";
import { longestCommonPrefix } from "./completion.js";
import {
  drawBox,
  resetTerminalModes,
  runModalPrompt,
  truncate,
  type BoxLayout,
} from "./prompt-utils.js";

export interface PromptOptions {
  defaultCwd?: string;
  // Box title. Defaults to the fork-locally wording; the dead-cwd repair
  // path overrides it.
  title?: string;
  // Line shown above the input. Defaults to the fork-locally wording.
  intro?: string;
}

export type CwdPromptResult =
  | { kind: "ok"; path: string }
  | { kind: "back" }
  | { kind: "cancel" };

export async function promptForImportCwd(
  term: Terminal,
  session: DiscoveredSession | undefined,
  opts: PromptOptions = {},
): Promise<CwdPromptResult> {
  const defaultCwd =
    opts.defaultCwd ??
    (session ? await pickInitialLocalCwd(session.cwd) : undefined) ??
    os.homedir();
  resetTerminalModes();

  const title = opts.title ?? "Fork locally — choose cwd";
  const intro = opts.intro ?? "Pick a local cwd for this session:";
  // The "from:" row only makes sense for imported sessions; the dead-cwd
  // repair path has no origin machine, so it's omitted there. When there
  // is no session (picker-cwd-change path), the whole header block is
  // dropped.
  const headerRows = session
    ? [
        { label: "session: ", value: stripHydraSessionPrefix(session.sessionId) },
        ...(session.importedFromMachine
          ? [{ label: "from:    ", value: session.importedFromMachine }]
          : []),
        { label: "cwd:     ", value: shortenHomePath(session.cwd) },
      ]
    : [];

  let buffer = defaultCwd;
  let errorLine: string | null = null;
  let busy = false;
  let layout: BoxLayout | null = null;
  // Undo/redo for the buffer. ^_ undoes, Alt-_ redoes. One snapshot per
  // keystroke — matches bash readline.
  let undoStack: string[] = [];
  let redoStack: string[] = [];
  const recordEdit = (): void => {
    undoStack.push(buffer);
    if (undoStack.length > 500) undoStack.shift();
    redoStack = [];
  };
  const undoEdit = (): void => {
    const prev = undoStack.pop();
    if (prev === undefined) return;
    redoStack.push(buffer);
    buffer = prev;
  };
  const redoEdit = (): void => {
    const next = redoStack.pop();
    if (next === undefined) return;
    undoStack.push(buffer);
    buffer = next;
  };

  const render = (): void => {
    const contentHeight = headerRows.length + 6;
    layout = drawBox(term, {
      contentHeight,
      title,
    });
    const innerW = layout.contentW;
    let row = 0;
    for (const hr of headerRows) {
      term.moveTo(layout.contentX, layout.contentY + row);
      term.dim.noFormat(` ${hr.label}`);
      term.noFormat(truncate(hr.value, innerW - hr.label.length - 2));
      row++;
    }
    row++;
    term.moveTo(layout.contentX, layout.contentY + row);
    term.noFormat(` ${intro}`);
    row += 2;
    paintInputRow(row);
    row += 2;
    if (errorLine !== null) {
      term.moveTo(layout.contentX, layout.contentY + row);
      term.red.noFormat(` ${truncate(errorLine, innerW - 2)}`);
    } else {
      term.moveTo(layout.contentX, layout.contentY + row);
      term.dim.noFormat(
        " Enter accept · Tab complete · Esc back · ^U clear",
      );
    }
  };

  // Header rows, one blank, the intro line, one blank — then the input.
  const inputRow = (): number => headerRows.length + 3;

  const paintInputRow = (rowOffset?: number): void => {
    if (!layout) {
      return;
    }
    const r = rowOffset ?? inputRow();
    term.moveTo(layout.contentX, layout.contentY + r).eraseLineAfter();
    // Re-draw the right border the eraseLineAfter just wiped.
    term.moveTo(layout.x + layout.w - 1, layout.contentY + r);
    term.dim.noFormat("│");
    term.moveTo(layout.contentX, layout.contentY + r);
    term.bold.noFormat(" cwd: ");
    const available = layout.contentW - " cwd: ".length - 2;
    term.noFormat(truncateLeft(buffer, available));
    if (!busy) {
      term.bgWhite(" ");
    }
  };

  const repaintInput = (): void => {
    paintInputRow();
    // The hint/error row sits right below; repaint it too so an error
    // appearing or clearing updates immediately.
    if (!layout) {
      return;
    }
    const errRow = inputRow() + 2;
    term.moveTo(layout.contentX, layout.contentY + errRow).eraseLineAfter();
    term.moveTo(layout.x + layout.w - 1, layout.contentY + errRow);
    term.dim.noFormat("│");
    term.moveTo(layout.contentX, layout.contentY + errRow);
    if (errorLine !== null) {
      term.red.noFormat(` ${truncate(errorLine, layout.contentW - 2)}`);
    } else {
      term.dim.noFormat(
        " Enter accept · Tab complete · Esc back · ^U clear",
      );
    }
  };

  return runModalPrompt<CwdPromptResult>({
    term,
    render,
    hideCursor: false,
    onKey: (name, _matches, data, finish) => {
      if (busy) {
        return;
      }
      if (name === "ENTER" || name === "KP_ENTER") {
        const candidate = buffer;
        busy = true;
        errorLine = null;
        repaintInput();
        void validateLocalCwd(candidate).then((result) => {
          busy = false;
          if (result.ok) {
            finish({ kind: "ok", path: result.path });
            return;
          }
          errorLine = result.reason;
          repaintInput();
        });
        return;
      }
      if (name === "ESCAPE") {
        finish({ kind: "back" });
        return;
      }
      if (name === "CTRL_C" || name === "CTRL_D") {
        finish({ kind: "cancel" });
        return;
      }
      if (name === "TAB") {
        busy = true;
        void completeLocalPath(buffer).then((result) => {
          busy = false;
          if (result.matches.length === 0) {
            return;
          }
          let next: string;
          if (result.matches.length === 1) {
            next = result.prefix + result.matches[0]!;
          } else {
            const lcp = longestCommonPrefix(result.matches);
            if (lcp.length <= result.basePrefix.length) {
              return;
            }
            next = result.prefix + lcp;
          }
          if (next === buffer) {
            return;
          }
          recordEdit();
          buffer = next;
          errorLine = null;
          repaintInput();
        });
        return;
      }
      if (name === "BACKSPACE") {
        if (buffer.length > 0) {
          recordEdit();
          buffer = buffer.slice(0, -1);
          errorLine = null;
          repaintInput();
        }
        return;
      }
      if (name === "CTRL_U") {
        if (buffer.length > 0) {
          recordEdit();
          buffer = "";
          errorLine = null;
          repaintInput();
        }
        return;
      }
      if (name === "CTRL_W") {
        const trimmedRight = buffer.replace(/[/\s]+$/, "");
        const lastSep = Math.max(
          trimmedRight.lastIndexOf("/"),
          trimmedRight.lastIndexOf(" "),
        );
        const next =
          lastSep >= 0 ? trimmedRight.slice(0, lastSep + 1) : "";
        if (next !== buffer) {
          recordEdit();
          buffer = next;
          errorLine = null;
          repaintInput();
        }
        return;
      }
      // ^_ undo / Alt-_ redo. Raw bytes — terminal-kit doesn't name them.
      if (name === "\x1f") {
        undoEdit();
        errorLine = null;
        repaintInput();
        return;
      }
      if (name === "\x1b_" || name === "\x1b\x1f") {
        redoEdit();
        errorLine = null;
        repaintInput();
        return;
      }
      if (data?.isCharacter) {
        recordEdit();
        buffer += name;
        errorLine = null;
        repaintInput();
        return;
      }
    },
  });
}

// Used for the cwd input: when the buffer is longer than the visible
// width, keep the right edge (where the cursor sits) visible by
// trimming the left side with a leading ellipsis.
function truncateLeft(s: string, max: number): string {
  if (max <= 1) {
    return "";
  }
  if (s.length <= max) {
    return s;
  }
  return "…" + s.slice(s.length - (max - 1));
}
