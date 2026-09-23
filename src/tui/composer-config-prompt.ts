// Overlay popup opened from the picker composer's top-border labels. One
// row per setting a new session is created with (agent, model, host);
// ←/→ cycles the focused row, Enter applies, Esc cancels. The same shape
// as the `/hydra config` index form, minus the round trips: nothing is
// applied until Enter.

import type { Terminal } from "terminal-kit";
import {
  composerConfigLabel,
  composerConfigRows,
  cycleComposerConfig,
  type ComposerConfig,
  type ComposerConfigChoices,
  type ComposerConfigRow,
} from "./composer-config.js";
import {
  drawBox,
  padRight,
  resetTerminalModes,
  runModalPrompt,
  truncate,
  type BoxLayout,
} from "./prompt-utils.js";
import { paint } from "./theme/index.js";

export type ComposerConfigResult =
  | { kind: "apply"; config: ComposerConfig; persist: boolean }
  | { kind: "cancel" };

const ROW_TITLES: Record<ComposerConfigRow, string> = {
  agent: "Agent",
  model: "Model",
  host: "Host",
};

const CONTENT_WIDTH = 72;

export async function promptForComposerConfig(
  term: Terminal,
  initial: ComposerConfig,
  choices: ComposerConfigChoices,
  focus: ComposerConfigRow = "agent",
): Promise<ComposerConfigResult> {
  resetTerminalModes();
  const rows = composerConfigRows(choices);
  if (rows.length === 0) {
    return { kind: "cancel" };
  }
  let state = initial;
  let cursor = Math.max(0, rows.indexOf(focus));
  let layout: BoxLayout | null = null;

  const paintRow = (i: number): void => {
    if (layout === null) {
      return;
    }
    const row = rows[i]!;
    const value = composerConfigLabel(state, row);
    const text = ` ${i === cursor ? "❯" : " "} ${padRight(ROW_TITLES[row], 7)} ‹ ${value} ›`;
    term.moveTo(layout.contentX, layout.contentY + 1 + i);
    const line = padRight(truncate(text, layout.contentW), layout.contentW);
    paint(term, i === cursor ? "list-selected" : "content", line);
  };

  const render = (): void => {
    layout = drawBox(term, {
      contentHeight: rows.length + 4,
      contentWidth: CONTENT_WIDTH,
      title: "New session",
      overlay: true,
    });
    term.moveTo(layout.contentX, layout.contentY);
    paint(term, "content", " Used when the composer creates a session:");
    for (let i = 0; i < rows.length; i++) {
      paintRow(i);
    }
    term.moveTo(layout.contentX, layout.contentY + rows.length + 2);
    paint(
      term,
      "modal-hint",
      padRight(
        truncate(" ↑/↓ row · ←/→ change · ⏎ apply · s apply & save agent · Esc cancel", layout.contentW),
        layout.contentW,
      ),
    );
  };

  const move = (to: number): void => {
    const prev = cursor;
    cursor = to;
    paintRow(prev);
    paintRow(cursor);
  };

  const cycle = (delta: 1 | -1): void => {
    state = cycleComposerConfig(state, rows[cursor]!, delta, choices);
    // Changing the agent also resets the model row.
    for (let i = 0; i < rows.length; i++) {
      paintRow(i);
    }
  };

  return runModalPrompt<ComposerConfigResult>({
    term,
    render,
    overlay: true,
    onKey: (name, _m, data, finish) => {
      if (name === "CTRL_C" || name === "CTRL_D" || name === "ESCAPE") {
        finish({ kind: "cancel" });
        return;
      }
      if (name === "ENTER" || name === "KP_ENTER") {
        finish({ kind: "apply", config: state, persist: false });
        return;
      }
      if (name === "UP" || name === "SHIFT_TAB") {
        move((cursor - 1 + rows.length) % rows.length);
        return;
      }
      if (name === "DOWN" || name === "TAB") {
        move((cursor + 1) % rows.length);
        return;
      }
      if (name === "LEFT") {
        cycle(-1);
        return;
      }
      if (name === "RIGHT") {
        cycle(1);
        return;
      }
      if (data?.isCharacter && name.toLowerCase() === "s") {
        finish({ kind: "apply", config: state, persist: true });
      }
    },
    onMouse: (name, data, finish) => {
      if (name !== "MOUSE_LEFT_BUTTON_PRESSED") {
        return;
      }
      const x = data?.x;
      const y = data?.y;
      if (layout === null || typeof x !== "number" || typeof y !== "number") {
        return;
      }
      if (
        x < layout.x ||
        x >= layout.x + layout.w ||
        y < layout.y ||
        y >= layout.y + layout.h
      ) {
        finish({ kind: "cancel" });
        return;
      }
      const i = y - (layout.contentY + 1);
      if (i < 0 || i >= rows.length) {
        return;
      }
      if (i !== cursor) {
        move(i);
        return;
      }
      cycle(1);
    },
  });
}
