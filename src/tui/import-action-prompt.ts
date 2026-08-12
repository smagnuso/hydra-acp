// Pre-screen "what do you want to do?" dialog for sessions imported
// from another machine that haven't been launched locally yet
// (importedFromMachine set + upstreamSessionId empty + cold).
//
// Replaces the previous flow where pressing Enter on such a row in the
// picker dropped straight into promptForImportCwd — the user now picks
// run-vs-view first (with headroom for a future "attach remotely"
// entry once daemon support lands).
//
// Rendered as a centered bordered modal in the gap between picker
// close and screen.start(); same lifecycle as promptForImportCwd.

import type { Terminal } from "terminal-kit";
import { shortenHomePath } from "../core/paths.js";
import { stripHydraSessionPrefix } from "../core/session.js";
import type { DiscoveredSession } from "./discovery.js";
import {
  drawBox,
  padRight,
  resetTerminalModes,
  runModalPrompt,
  truncate,
  type BoxLayout,
} from "./prompt-utils.js";
import { paint } from "./theme/index.js";

export type ImportAction = "fork-local" | "view";

export interface ActionChoice {
  key: ImportAction;
  label: string;
  // Single-character hotkey that jumps straight to this entry from
  // anywhere in the dialog. Mirrors the picker's `v` shortcut.
  hotkey: string;
  description: string;
}

// Source of truth for the dialog's options. Adding a third entry here
// (e.g. "attach remotely" once the daemon supports it) is the only
// edit needed to extend the dialog.
export const ACTION_CHOICES: readonly ActionChoice[] = [
  {
    key: "fork-local",
    label: "Fork locally",
    hotkey: "f",
    description: "spawn a local fork — original imported copy stays as-is",
  },
  {
    key: "view",
    label: "View transcript",
    hotkey: "v",
    description: "open read-only, no agent spawn",
  },
];

// Pure state machine: holds the current selection index and consumes
// abstract key names, returning either an unchanged/updated state or
// the resolved action / cancel.
//
// Exported so tests can drive the keyboard logic without standing up a
// terminal mock. The UI shell below maps terminal-kit's event shape
// onto KeyInput and renders the resulting state.
export type KeyInput =
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "enter" }
  | { kind: "back" }
  | { kind: "cancel" }
  | { kind: "char"; ch: string };

// "back" goes one step backward in the wizard (Esc — re-show the
// picker). "cancel" tears down the whole program (^C / ^D). UI shells
// translate both into the corresponding promptForImportAction return.
export type ActionStep =
  | { kind: "continue"; selected: number }
  | { kind: "resolve"; action: ImportAction }
  | { kind: "back" }
  | { kind: "cancel" };

export type ActionResult = ImportAction | "back" | "cancel";

export function actionPromptStep(
  selected: number,
  key: KeyInput,
  choices: readonly ActionChoice[] = ACTION_CHOICES,
): ActionStep {
  if (key.kind === "cancel") {
    return { kind: "cancel" };
  }
  if (key.kind === "back") {
    return { kind: "back" };
  }
  if (key.kind === "enter") {
    const choice = choices[selected];
    if (!choice) {
      return { kind: "back" };
    }
    return { kind: "resolve", action: choice.key };
  }
  if (key.kind === "up") {
    return {
      kind: "continue",
      selected: Math.max(0, selected - 1),
    };
  }
  if (key.kind === "down") {
    return {
      kind: "continue",
      selected: Math.min(choices.length - 1, selected + 1),
    };
  }
  if (key.kind === "char") {
    const lower = key.ch.toLowerCase();
    if (lower === "n") {
      return {
        kind: "continue",
        selected: Math.min(choices.length - 1, selected + 1),
      };
    }
    if (lower === "p") {
      return {
        kind: "continue",
        selected: Math.max(0, selected - 1),
      };
    }
    const idx = choices.findIndex((c) => c.hotkey.toLowerCase() === lower);
    if (idx >= 0) {
      const choice = choices[idx];
      if (choice) {
        return { kind: "resolve", action: choice.key };
      }
    }
  }
  return { kind: "continue", selected };
}

export async function promptForImportAction(
  term: Terminal,
  session: DiscoveredSession,
): Promise<ActionResult> {
  resetTerminalModes();

  const shortId = stripHydraSessionPrefix(session.sessionId);
  const fromMachine = session.importedFromMachine ?? "another machine";
  const originalCwd = shortenHomePath(session.cwd);

  // Default to "View transcript" — the non-destructive option. Forking
  // spawns a new agent, so the safer choice should land under the
  // cursor when the dialog opens.
  let selected = ACTION_CHOICES.findIndex((c) => c.key === "view");
  if (selected < 0) {
    selected = 0;
  }

  // Screen coords from the last paint, for the mouse handler.
  let boxBounds: BoxLayout | null = null;
  let firstChoiceRow: number | null = null;

  const render = (): BoxLayout => {
    const choiceRows = ACTION_CHOICES.length * 2;
    const contentHeight = 7 + choiceRows + 2;
    const layout = drawBox(term, {
      contentHeight,
      title: "Imported session",
    });
    const innerW = layout.contentW;
    const headerRows = [
      { label: "session: ", value: shortId },
      { label: "from:    ", value: fromMachine },
      { label: "cwd:     ", value: originalCwd },
    ];
    let row = 0;
    for (const hr of headerRows) {
      term.moveTo(layout.contentX, layout.contentY + row);
      paint(term, "modal-label", ` ${hr.label}`);
      paint(term, "content", truncate(hr.value, innerW - hr.label.length - 2));
      row++;
    }
    row++;
    const body = paintActionBody(term, layout, row, {
      intro: "What do you want to do?",
      choices: ACTION_CHOICES,
      selected,
      footer: "↑/↓ navigate · Enter select · f/v jump · Esc back",
    });
    boxBounds = layout;
    firstChoiceRow = body.firstChoiceRow;
    return layout;
  };

  // Repaint just the label rows — a full drawBox per hover event flickers.
  const repaintChoices = (): void => {
    const layout = boxBounds;
    const first = firstChoiceRow;
    if (layout === null || first === null) {
      return;
    }
    for (let i = 0; i < ACTION_CHOICES.length; i++) {
      const choice = ACTION_CHOICES[i];
      if (!choice) {
        continue;
      }
      paintChoiceLabel(term, layout, first + i * 2, choice.label, i === selected);
    }
  };

  const moveSelection = (idx: number): void => {
    if (idx < 0 || idx >= ACTION_CHOICES.length || idx === selected) {
      return;
    }
    selected = idx;
    repaintChoices();
  };

  // runModalPrompt hands `finish` to each event; the mouse handler is
  // built once (it carries the press-cell across two events), so it
  // resolves through whichever finish the current event supplied.
  let finishNow: ((value: ActionResult) => void) | null = null;
  const onMouse = createChoiceMouse({
    choiceCount: ACTION_CHOICES.length,
    layout: () => boxBounds,
    firstChoiceRow: () => firstChoiceRow,
    selected: () => selected,
    select: moveSelection,
    commit: (idx) => {
      const choice = ACTION_CHOICES[idx];
      if (choice) {
        finishNow?.(choice.key);
      }
    },
    back: () => finishNow?.("back"),
  });

  return runModalPrompt<ActionResult>({
    term,
    render,
    onKey: (name, _matches, data, finish) => {
      const input = mapKey(name, data);
      if (!input) {
        return;
      }
      const step = actionPromptStep(selected, input);
      if (step.kind === "cancel") {
        finish("cancel");
        return;
      }
      if (step.kind === "back") {
        finish("back");
        return;
      }
      if (step.kind === "resolve") {
        finish(step.action);
        return;
      }
      moveSelection(step.selected);
    },
    onMouse: (name, data, finish) => {
      finishNow = finish;
      onMouse(name, data);
    },
  });
}

// Shared "intro line + choice list + footer hint" block used by both
// promptForImportAction and promptForLaunchOrView. Layout above the
// startRow (header rows + blank) is the caller's responsibility because
// the two modals have different header shapes.
//
// Returns the absolute screen row of the first choice's label line so
// mouse-driven callers can hit-test hover / clicks against the list.
// Each choice occupies two rows: label then description.
function paintActionBody(
  term: Terminal,
  layout: BoxLayout,
  startRow: number,
  opts: {
    intro: string;
    choices: readonly { label: string; description: string }[];
    selected: number;
    footer: string;
  },
): { firstChoiceRow: number } {
  let row = startRow;
  term.moveTo(layout.contentX, layout.contentY + row);
  paint(term, "content", ` ${opts.intro}`);
  row += 2;
  const firstChoiceRow = layout.contentY + row;
  for (let i = 0; i < opts.choices.length; i++) {
    const choice = opts.choices[i];
    if (!choice) {
      continue;
    }
    paintChoiceLabel(
      term,
      layout,
      layout.contentY + row,
      choice.label,
      i === opts.selected,
    );
    row++;
    term.moveTo(layout.contentX, layout.contentY + row);
    paint(term, "list-description", `     ${choice.description}`);
    row++;
  }
  row++;
  term.moveTo(layout.contentX, layout.contentY + row);
  paint(term, "modal-hint", ` ${opts.footer}`);
  return { firstChoiceRow };
}

// Hover / click / wheel behaviour shared by the two choice-list modals
// (the imported-session dialog and the launch-vs-view dialog). Both are
// a bordered box with N two-row choices, so both want the same rules:
// hover highlights, a click commits, the wheel nudges, and a click
// outside the box backs out. Matches promptForAgent's list semantics.
//
// The getters are read on every event rather than captured once because
// a resize re-renders the box somewhere else.
function createChoiceMouse(opts: {
  choiceCount: number;
  layout: () => BoxLayout | null;
  firstChoiceRow: () => number | null;
  selected: () => number;
  select: (idx: number) => void;
  commit: (idx: number) => void;
  back: () => void;
}): (name: string, data?: { x?: number; y?: number }) => void {
  let pressCell: { x: number; y: number } | null = null;
  // Both rows of a choice (label + description) are part of its hit box.
  const choiceAtRow = (y: number): number | null => {
    const first = opts.firstChoiceRow();
    if (first === null) {
      return null;
    }
    const rel = y - first;
    if (rel < 0) {
      return null;
    }
    const idx = Math.floor(rel / 2);
    return idx < opts.choiceCount ? idx : null;
  };
  return (name, data) => {
    if (name === "MOUSE_WHEEL_UP") {
      opts.select(opts.selected() - 1);
      return;
    }
    if (name === "MOUSE_WHEEL_DOWN") {
      opts.select(opts.selected() + 1);
      return;
    }
    if (name === "MOUSE_LEFT_BUTTON_PRESSED") {
      pressCell = { x: data?.x ?? -1, y: data?.y ?? -1 };
      return;
    }
    const y = data?.y;
    if (typeof y !== "number") {
      return;
    }
    if (name === "MOUSE_MOTION") {
      const idx = choiceAtRow(y);
      if (idx !== null) {
        opts.select(idx);
      }
      return;
    }
    if (name !== "MOUSE_LEFT_BUTTON_RELEASED") {
      return;
    }
    const x = data?.x;
    // A click is a release on the press cell; a drag isn't a click.
    const sameCell =
      pressCell !== null && x === pressCell.x && y === pressCell.y;
    pressCell = null;
    if (!sameCell) {
      return;
    }
    const box = opts.layout();
    if (
      box !== null &&
      typeof x === "number" &&
      (x < box.x || x >= box.x + box.w || y < box.y || y >= box.y + box.h)
    ) {
      opts.back();
      return;
    }
    const idx = choiceAtRow(y);
    if (idx !== null) {
      opts.commit(idx);
    }
  };
}

// One choice's label line. Split out of paintActionBody so a selection
// change (hover or arrow key) can repaint just the label rows instead
// of redrawing the whole box, which flickers over the picker beneath.
// Unselected rows are padded too so residue from the highlight bar is
// overwritten.
function paintChoiceLabel(
  term: Terminal,
  layout: BoxLayout,
  rowOnScreen: number,
  label: string,
  isSelected: boolean,
): void {
  const pointer = isSelected ? "❯" : " ";
  const text = padRight(` ${pointer} ${label}`, layout.contentW);
  term.moveTo(layout.contentX, rowOnScreen);
  paint(term, isSelected ? "list-selected" : "content", text);
}

function mapKey(
  name: string,
  data?: { isCharacter?: boolean },
): KeyInput | null {
  if (name === "UP") {
    return { kind: "up" };
  }
  if (name === "DOWN") {
    return { kind: "down" };
  }
  if (name === "ENTER" || name === "KP_ENTER") {
    return { kind: "enter" };
  }
  if (name === "ESCAPE") {
    return { kind: "back" };
  }
  if (name === "CTRL_C" || name === "CTRL_D") {
    return { kind: "cancel" };
  }
  if (data?.isCharacter) {
    return { kind: "char", ch: name };
  }
  return null;
}

export type LaunchOrViewResult = "launch" | "view" | "back" | "cancel";

export async function promptForLaunchOrView(
  term: Terminal,
  session: { sessionId: string; title?: string; cwd: string },
  focus: {
    push: (layer: {
      onKey: (name: string, _m: unknown, data?: { isCharacter?: boolean }) => void;
      onMouse?: (name: string, data?: { x?: number; y?: number }) => void;
      onResize: () => void;
    }) => void;
    pop: () => void;
  },
): Promise<LaunchOrViewResult> {
  const shortId = stripHydraSessionPrefix(session.sessionId);
  const titleOrCwd = session.title ?? shortenHomePath(session.cwd);

  // Default to "View transcript" — the non-destructive option.
  let selected = 1;

  const CHOICES: ReadonlyArray<{
    key: "launch" | "view";
    label: string;
    hotkey: string;
    description: string;
  }> = [
    { key: "launch", label: "Launch", hotkey: "l", description: "start a new agent session" },
    { key: "view", label: "View transcript", hotkey: "v", description: "open read-only, no agent spawn" },
  ];

  // Screen-coord bookkeeping for the mouse handler, refreshed by every
  // full render: the box bounds (click outside → back) and the row of
  // the first choice label (hit-test for hover / click).
  let boxBounds: BoxLayout | null = null;
  let firstChoiceRow: number | null = null;

  const render = (): void => {
    // overlay: the only caller is the picker's ^F results list, and
    // wiping the screen there loses the results the user is choosing
    // from — they'd have no context for which hit this modal is about.
    const layout = drawBox(term, {
      contentHeight: 11,
      title: "Open session",
      overlay: true,
    });
    const innerW = layout.contentW;
    let row = 0;
    term.moveTo(layout.contentX, layout.contentY + row);
    paint(term, "modal-label", " session: ");
    paint(term, "content", truncate(shortId, innerW - 10));
    row++;
    term.moveTo(layout.contentX, layout.contentY + row);
    paint(term, "content", " " + truncate(titleOrCwd, innerW - 2));
    row++;
    row++;
    const body = paintActionBody(term, layout, row, {
      intro: "What do you want to do?",
      choices: CHOICES,
      selected,
      footer: "↑/↓ navigate · Enter select · l/v jump · Esc back",
    });
    boxBounds = layout;
    firstChoiceRow = body.firstChoiceRow;
  };

  // Repaint only the label rows — descriptions and chrome don't change
  // with the selection, and a full drawBox on every hover flickers.
  const repaintChoices = (): void => {
    const layout = boxBounds;
    const first = firstChoiceRow;
    if (layout === null || first === null) {
      return;
    }
    for (let i = 0; i < CHOICES.length; i++) {
      const choice = CHOICES[i];
      if (!choice) {
        continue;
      }
      paintChoiceLabel(term, layout, first + i * 2, choice.label, i === selected);
    }
  };

  const moveSelection = (idx: number): void => {
    if (idx < 0 || idx >= CHOICES.length || idx === selected) {
      return;
    }
    selected = idx;
    repaintChoices();
  };

  render();
  term.hideCursor();

  return await new Promise<LaunchOrViewResult>((resolve) => {
    let resolved = false;
    const cleanup = (): void => {
      resolved = true;
    };
    const finish = (value: LaunchOrViewResult): void => {
      cleanup();
      focus.pop();
      resolve(value);
    };
    const onKey = (
      name: string,
      _m: unknown,
      data?: { isCharacter?: boolean },
    ): void => {
      if (name === "CTRL_C" || name === "CTRL_D") {
        finish("cancel");
        return;
      }
      if (name === "ESCAPE") {
        finish("back");
        return;
      }
      if (name === "ENTER" || name === "KP_ENTER") {
        finish(CHOICES[selected]?.key ?? "view");
        return;
      }
      if (name === "UP" || name === "SHIFT_TAB") {
        moveSelection(selected - 1);
        return;
      }
      if (name === "DOWN" || name === "TAB") {
        moveSelection(selected + 1);
        return;
      }
      if (data?.isCharacter) {
        const lower = name.toLowerCase();
        if (lower === "l") {
          finish("launch");
          return;
        }
        if (lower === "v") {
          finish("view");
          return;
        }
        if (lower === "n") {
          moveSelection(selected + 1);
          return;
        }
        if (lower === "p") {
          moveSelection(selected - 1);
          return;
        }
      }
    };

    const onMouse = createChoiceMouse({
      choiceCount: CHOICES.length,
      layout: () => boxBounds,
      firstChoiceRow: () => firstChoiceRow,
      selected: () => selected,
      select: moveSelection,
      commit: (idx) => {
        const choice = CHOICES[idx];
        if (choice) {
          finish(choice.key);
        }
      },
      back: () => finish("back"),
    });

    focus.push({
      onKey: (name, _m, data) => { if (!resolved) onKey(name, _m, data); },
      onMouse: (name, data) => { if (!resolved) onMouse(name, data); },
      onResize: () => { if (!resolved) render(); },
    });
  });
}


