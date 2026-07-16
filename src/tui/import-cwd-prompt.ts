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
import { LineEditor } from "./line-editor.js";

export interface PromptOptions {
  defaultCwd?: string;
  // Box title. Defaults to the fork-locally wording; the dead-cwd repair
  // path overrides it.
  title?: string;
  // Line shown above the input. Defaults to the fork-locally wording.
  intro?: string;
  // Render as an overlay on top of an existing UI (no screen wipe, box
  // interior gets an explicit blank fill so the underlying frame
  // doesn't bleed through the border). The caller is responsible for
  // repainting the underlying frame after the modal resolves.
  overlay?: boolean;
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

  const editor = new LineEditor(defaultCwd);
  let errorLine: string | null = null;
  let busy = false;
  let layout: BoxLayout | null = null;
  // Screen coord bookkeeping for the mouse handler. `hintRowY` is the
  // absolute row where the "Enter accept · Tab complete · Esc back ·
  // ^U clear" line paints (only meaningful when errorLine === null;
  // when set, the error replaces the hint at the same row). Ranges are
  // screen columns (1-indexed, inclusive).
  let hintRowY: number | null = null;
  let acceptClickRange: { start: number; end: number } | null = null;
  let backClickRange: { start: number; end: number } | null = null;

  // Single source of truth for the hint text so paint + hit-test can't
  // drift. Tab-completion and ^U are still bound at the key level but
  // aren't advertised — the intro line above already establishes the
  // context, so the hint stays minimal.
  const HINT_TEXT = " Enter accept · Esc back";
  const ACCEPT_LABEL = "Enter accept";
  const BACK_LABEL = "Esc back";
  const acceptOffset = HINT_TEXT.indexOf(ACCEPT_LABEL);
  const backOffset = HINT_TEXT.indexOf(BACK_LABEL);

  const render = (): void => {
    const contentHeight = headerRows.length + 6;
    layout = drawBox(term, {
      contentHeight,
      title,
      overlay: opts.overlay === true,
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
    const screenRow = layout.contentY + row;
    if (errorLine !== null) {
      term.moveTo(layout.contentX, screenRow);
      term.red.noFormat(` ${truncate(errorLine, innerW - 2)}`);
      hintRowY = null;
      acceptClickRange = null;
      backClickRange = null;
    } else {
      term.moveTo(layout.contentX, screenRow);
      term.dim.noFormat(HINT_TEXT);
      hintRowY = screenRow;
      acceptClickRange = {
        start: layout.contentX + acceptOffset,
        end: layout.contentX + acceptOffset + ACCEPT_LABEL.length - 1,
      };
      backClickRange = {
        start: layout.contentX + backOffset,
        end: layout.contentX + backOffset + BACK_LABEL.length - 1,
      };
    }
  };

  // Header rows, one blank, the intro line, one blank — then the input.
  const inputRow = (): number => headerRows.length + 3;

  // Horizontal scroll offset for the input window. Adjusted on every
  // paint so the cursor stays visible; leading "…" surfaces when the
  // window has scrolled off the left.
  let scrollOffset = 0;

  const paintInputRow = (rowOffset?: number): void => {
    if (!layout) {
      return;
    }
    const r = rowOffset ?? inputRow();
    term.moveTo(layout.contentX, layout.contentY + r).eraseLineAfter();
    term.moveTo(layout.x + layout.w - 1, layout.contentY + r);
    term.dim.noFormat("│");
    // Single leading space of padding; the intro line above ("Pick a
    // local cwd for this session:" / "New cwd for the picker …")
    // already establishes what's being edited, so no "cwd:" label.
    term.moveTo(layout.contentX, layout.contentY + r);
    term.noFormat(" ");
    const label = 1;
    const available = Math.max(1, layout.contentW - label - 2);
    const text = editor.text;
    const cur = editor.cursor;
    if (cur < scrollOffset) {
      scrollOffset = cur;
    }
    if (cur - scrollOffset >= available) {
      scrollOffset = cur - available + 1;
    }
    if (scrollOffset < 0) {
      scrollOffset = 0;
    }
    let visible = text.slice(scrollOffset, scrollOffset + available);
    if (scrollOffset > 0 && visible.length > 0) {
      visible = "…" + visible.slice(1);
    }
    const rel = cur - scrollOffset;
    if (busy) {
      term.noFormat(visible);
      return;
    }
    if (rel >= visible.length) {
      term.noFormat(visible);
      term.bgWhite(" ");
    } else {
      term.noFormat(visible.slice(0, rel));
      term.bgWhite.noFormat(visible[rel] ?? " ");
      term.noFormat(visible.slice(rel + 1));
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
    const screenRow = layout.contentY + errRow;
    term.moveTo(layout.contentX, screenRow);
    if (errorLine !== null) {
      term.red.noFormat(` ${truncate(errorLine, layout.contentW - 2)}`);
      hintRowY = null;
      acceptClickRange = null;
      backClickRange = null;
    } else {
      term.dim.noFormat(HINT_TEXT);
      hintRowY = screenRow;
      acceptClickRange = {
        start: layout.contentX + acceptOffset,
        end: layout.contentX + acceptOffset + ACCEPT_LABEL.length - 1,
      };
      backClickRange = {
        start: layout.contentX + backOffset,
        end: layout.contentX + backOffset + BACK_LABEL.length - 1,
      };
    }
  };

  // Extracted so both Enter and a click on "Enter accept" run the same
  // validate-then-finish flow.
  const submit = (finish: (v: CwdPromptResult) => void): void => {
    if (busy) {
      return;
    }
    const candidate = editor.text;
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
  };
  return runModalPrompt<CwdPromptResult>({
    term,
    render,
    overlay: opts.overlay === true,
    onKey: (name, _matches, data, finish) => {
      if (busy) {
        return;
      }
      if (name === "ENTER" || name === "KP_ENTER") {
        submit(finish);
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
        void completeLocalPath(editor.text).then((result) => {
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
          if (next === editor.text) {
            return;
          }
          editor.setText(next, { recordUndo: true });
          errorLine = null;
          repaintInput();
        });
        return;
      }
      if (editor.handleKey(name, data?.isCharacter === true)) {
        errorLine = null;
        repaintInput();
        return;
      }
    },
    // Click the "Enter accept" or "Esc back" hint labels to trigger
    // their key equivalents. Only the two words carry click semantics;
    // "Tab complete" needs a target string, "^U clear" is destructive.
    // Enabling mouse here disables terminal-native text selection in
    // the modal — accept that trade-off for the click affordance.
    onMouse: (name, data, finish) => {
      if (busy) {
        return;
      }
      if (name !== "MOUSE_LEFT_BUTTON_PRESSED") {
        return;
      }
      const x = data?.x;
      const y = data?.y;
      if (typeof x !== "number" || typeof y !== "number") {
        return;
      }
      // Click outside the box → cancel (Esc equivalent).
      if (
        layout !== null &&
        (x < layout.x ||
          x >= layout.x + layout.w ||
          y < layout.y ||
          y >= layout.y + layout.h)
      ) {
        finish({ kind: "back" });
        return;
      }
      if (hintRowY === null) {
        return;
      }
      if (y !== hintRowY) {
        return;
      }
      if (
        acceptClickRange !== null &&
        x >= acceptClickRange.start &&
        x <= acceptClickRange.end
      ) {
        submit(finish);
        return;
      }
      if (
        backClickRange !== null &&
        x >= backClickRange.start &&
        x <= backClickRange.end
      ) {
        finish({ kind: "back" });
        return;
      }
    },
  });
}
