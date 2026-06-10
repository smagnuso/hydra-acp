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
      term.dim.noFormat(` ${hr.label}`);
      term.noFormat(truncate(hr.value, innerW - hr.label.length - 2));
      row++;
    }
    row++;
    paintActionBody(term, layout, row, {
      intro: "What do you want to do?",
      choices: ACTION_CHOICES,
      selected,
      footer: "↑/↓ navigate · Enter select · f/v jump · Esc back",
    });
    return layout;
  };

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
      if (step.selected !== selected) {
        selected = step.selected;
        render();
      }
    },
  });
}

// Shared "intro line + choice list + footer hint" block used by both
// promptForImportAction and promptForLaunchOrView. Layout above the
// startRow (header rows + blank) is the caller's responsibility because
// the two modals have different header shapes.
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
): void {
  const innerW = layout.contentW;
  let row = startRow;
  term.moveTo(layout.contentX, layout.contentY + row);
  term.noFormat(` ${opts.intro}`);
  row += 2;
  for (let i = 0; i < opts.choices.length; i++) {
    const choice = opts.choices[i];
    if (!choice) {
      continue;
    }
    const pointer = i === opts.selected ? "❯" : " ";
    const label = ` ${pointer} ${choice.label}`;
    term.moveTo(layout.contentX, layout.contentY + row);
    if (i === opts.selected) {
      term.brightWhite.bgBlue.noFormat(padRight(label, innerW));
    } else {
      term.noFormat(label);
    }
    row++;
    term.moveTo(layout.contentX, layout.contentY + row);
    term.dim.noFormat(`     ${choice.description}`);
    row++;
  }
  row++;
  term.moveTo(layout.contentX, layout.contentY + row);
  term.dim.noFormat(` ${opts.footer}`);
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
    push: (layer: { onKey: (name: string, _m: unknown, data?: { isCharacter?: boolean }) => void; onResize: () => void }) => void;
    pop: () => void;
  },
): Promise<LaunchOrViewResult> {
  const shortId = stripHydraSessionPrefix(session.sessionId);
  const titleOrCwd = session.title ?? shortenHomePath(session.cwd);

  // Default to "View transcript" — the non-destructive option.
  let selected = 1;

  const CHOICES: ReadonlyArray<{ label: string; hotkey: string; description: string }> = [
    { label: "Launch", hotkey: "l", description: "start a new agent session" },
    { label: "View transcript", hotkey: "v", description: "open read-only, no agent spawn" },
  ];

  const render = (): void => {
    const layout = drawBox(term, { contentHeight: 11, title: "Open session" });
    const innerW = layout.contentW;
    let row = 0;
    term.moveTo(layout.contentX, layout.contentY + row);
    term.dim.noFormat(" session: ");
    term.noFormat(truncate(shortId, innerW - 10));
    row++;
    term.moveTo(layout.contentX, layout.contentY + row);
    term.noFormat(" " + truncate(titleOrCwd, innerW - 2));
    row++;
    row++;
    paintActionBody(term, layout, row, {
      intro: "What do you want to do?",
      choices: CHOICES,
      selected,
      footer: "↑/↓ navigate · Enter select · l/v jump · Esc back",
    });
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
        finish(selected === 0 ? "launch" : "view");
        return;
      }
      if (name === "UP" || name === "SHIFT_TAB") {
        if (selected > 0) {
          selected--;
          render();
        }
        return;
      }
      if (name === "DOWN" || name === "TAB") {
        if (selected < CHOICES.length - 1) {
          selected++;
          render();
        }
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
          if (selected < CHOICES.length - 1) {
            selected++;
            render();
          }
          return;
        }
        if (lower === "p") {
          if (selected > 0) {
            selected--;
            render();
          }
          return;
        }
      }
    };
    focus.push({
      onKey: (name, _m, data) => { if (!resolved) onKey(name, _m, data); },
      onResize: () => { if (!resolved) render(); },
    });
  });
}


