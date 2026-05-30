// Pre-screen agent picker, shown in the gap between picker close and
// screen.start() when a NEW session needs an agent and none is set
// (no --agent and no config.defaultAgent). Same lifecycle / look as
// promptForImportAction: a centered bordered modal.
//
// Enter uses the highlighted agent for this session only; `s` also
// stores it as config.defaultAgent. Esc goes back (the caller re-shows
// the session picker, preserving the typed prompt); ^C/^D cancel the
// whole launch.

import type { Terminal } from "terminal-kit";
import type { DiscoveredAgent } from "./discovery.js";
import {
  drawBox,
  resetTerminalModes,
  readTermHeight,
  readTermWidth,
  type BoxLayout,
} from "./prompt-utils.js";

export type AgentPromptResult =
  | { kind: "select"; agentId: string; persist: boolean }
  | { kind: "back" }
  | { kind: "cancel" };

const PREFERRED_DEFAULT = "opencode";

// Most agent rows we'll ever show at once, before the list scrolls
// inside the box. Clamped further to the terminal height at render time.
const MAX_VISIBLE_ROWS = 20;

// Preferred dialog content width. Agent descriptions are long, so this
// is wider than the default modal; clamped to the terminal by drawBox.
const PREFERRED_CONTENT_WIDTH = 88;

function initialIndex(agents: DiscoveredAgent[]): number {
  const idx = agents.findIndex((a) => a.id === PREFERRED_DEFAULT);
  return idx === -1 ? 0 : idx;
}

export async function promptForAgent(
  term: Terminal,
  agents: DiscoveredAgent[],
): Promise<AgentPromptResult> {
  resetTerminalModes();
  let selected = initialIndex(agents);
  let windowStart = 0;

  // How many list rows fit: capped by MAX_VISIBLE_ROWS and by the
  // terminal height (leaving room for borders, the header line, the
  // footer line, and drawBox's own 4-row margin).
  const visibleRows = (): number => {
    const termBudget = readTermHeight(term) - 8;
    return Math.max(1, Math.min(MAX_VISIBLE_ROWS, agents.length, termBudget));
  };

  // Keep `selected` inside the scroll window.
  const reclamp = (): void => {
    const rows = visibleRows();
    if (selected < windowStart) {
      windowStart = selected;
    } else if (selected >= windowStart + rows) {
      windowStart = selected - rows + 1;
    }
    const maxStart = Math.max(0, agents.length - rows);
    if (windowStart > maxStart) {
      windowStart = maxStart;
    }
    if (windowStart < 0) {
      windowStart = 0;
    }
  };

  const render = (): BoxLayout => {
    reclamp();
    const rows = visibleRows();
    // header (1) + blank (1) + list (rows) + blank (1) + footer (1)
    const contentHeight = rows + 4;
    // Use most of the terminal width, up to PREFERRED_CONTENT_WIDTH, so
    // long descriptions have room without overflowing narrow terminals.
    const contentWidth = Math.min(
      PREFERRED_CONTENT_WIDTH,
      Math.max(40, readTermWidth(term) - 8),
    );
    const layout = drawBox(term, {
      contentHeight,
      contentWidth,
      title: "Select agent",
    });
    const innerW = layout.contentW;
    let row = 0;
    term.moveTo(layout.contentX, layout.contentY + row);
    term.noFormat(" Which agent should this session use?");
    row += 2;
    const end = Math.min(agents.length, windowStart + rows);
    for (let i = windowStart; i < end; i++) {
      const agent = agents[i];
      if (!agent) {
        continue;
      }
      const pointer = i === selected ? "❯" : " ";
      const desc = agent.description ?? agent.name;
      // id + dimmed description on one line; truncated to fit.
      const idPart = ` ${pointer} ${agent.id}`;
      term.moveTo(layout.contentX, layout.contentY + row);
      if (i === selected) {
        const line = `${idPart}  ${desc}`;
        term.brightWhite.bgBlue.noFormat(padRight(truncate(line, innerW), innerW));
      } else {
        term.noFormat(idPart);
        const room = innerW - idPart.length - 2;
        if (room > 1) {
          term.dim.noFormat(`  ${truncate(desc, room)}`);
        }
      }
      row++;
    }
    row++;
    term.moveTo(layout.contentX, layout.contentY + row);
    const more =
      agents.length > rows
        ? ` (${selected + 1}/${agents.length})`
        : "";
    term.dim.noFormat(
      ` ↑/↓ navigate · Enter this session · s set default · Esc back${more}`,
    );
    return layout;
  };

  render();
  term.hideCursor();

  return await new Promise<AgentPromptResult>((resolve) => {
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
    const finish = (value: AgentPromptResult): void => {
      cleanup();
      resolve(value);
    };
    const onResize = (): void => {
      if (resolved) {
        return;
      }
      render();
    };
    const moveDown = (): void => {
      if (selected < agents.length - 1) {
        selected++;
        render();
      }
    };
    const moveUp = (): void => {
      if (selected > 0) {
        selected--;
        render();
      }
    };
    const onKey = (
      name: string,
      _m: unknown,
      data?: { isCharacter?: boolean },
    ): void => {
      if (name === "CTRL_C" || name === "CTRL_D") {
        finish({ kind: "cancel" });
        return;
      }
      if (name === "ESCAPE") {
        finish({ kind: "back" });
        return;
      }
      if (name === "ENTER" || name === "KP_ENTER") {
        const agent = agents[selected];
        if (agent) {
          finish({ kind: "select", agentId: agent.id, persist: false });
        }
        return;
      }
      if (name === "UP" || name === "SHIFT_TAB") {
        moveUp();
        return;
      }
      if (name === "DOWN" || name === "TAB") {
        moveDown();
        return;
      }
      if (data?.isCharacter) {
        const lower = name.toLowerCase();
        if (lower === "s") {
          const agent = agents[selected];
          if (agent) {
            finish({ kind: "select", agentId: agent.id, persist: true });
          }
          return;
        }
        if (lower === "j") {
          moveDown();
          return;
        }
        if (lower === "k") {
          moveUp();
          return;
        }
      }
    };
    term.grabInput({});
    term.on("key", onKey);
    term.on("resize", onResize);
  });
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
