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
  resetTerminalModes,
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
    term.moveTo(layout.contentX, layout.contentY + row);
    term.noFormat(" What do you want to do?");
    row += 2;
    for (let i = 0; i < ACTION_CHOICES.length; i++) {
      const choice = ACTION_CHOICES[i];
      if (!choice) {
        continue;
      }
      const pointer = i === selected ? "❯" : " ";
      const label = ` ${pointer} ${choice.label}`;
      term.moveTo(layout.contentX, layout.contentY + row);
      if (i === selected) {
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
    term.dim.noFormat(" ↑/↓ navigate · Enter select · f/v jump · Esc back");
    return layout;
  };

  render();
  term.hideCursor();

  return await new Promise<ActionResult>((resolve) => {
    let resolved = false;
    const cleanup = (): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      term.off("key", onKey);
      term.off("resize", onResize);
      term.grabInput(false);
      term.hideCursor(false);
      term.moveTo(1, 1).eraseDisplayBelow();
    };
    const finish = (value: ActionResult): void => {
      cleanup();
      resolve(value);
    };
    const onResize = (): void => {
      if (resolved) {
        return;
      }
      render();
    };
    const onKey = (
      name: string,
      _matches: unknown,
      data?: { isCharacter?: boolean },
    ): void => {
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
    };
    term.grabInput({});
    term.on("key", onKey);
    term.on("resize", onResize);
  });
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

function truncate(s: string, max: number): string {
  if (max <= 1) {
    return "";
  }
  if (s.length <= max) {
    return s;
  }
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

function padRight(s: string, w: number): string {
  if (s.length >= w) {
    return s.slice(0, w);
  }
  return s + " ".repeat(w - s.length);
}
