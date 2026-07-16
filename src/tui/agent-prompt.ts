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
  padRight,
  readTermHeight,
  readTermWidth,
  resetTerminalModes,
  runModalPrompt,
  truncate,
  type BoxLayout,
} from "./prompt-utils.js";

export type AgentPromptResult =
  | { kind: "select"; agentId: string; persist: boolean }
  | { kind: "back" }
  | { kind: "cancel" };

// Hardcoded fallback used only when neither the caller nor config
// supplies a preferred agent id. Kept so the picker still highlights a
// sensible default on a fresh install.
const FALLBACK_PREFERRED_AGENT = "opencode";

// Most agent rows we'll ever show at once, before the list scrolls
// inside the box. Clamped further to the terminal height at render time.
const MAX_VISIBLE_ROWS = 20;

// Preferred dialog content width. Agent descriptions are long, so this
// is wider than the default modal; clamped to the terminal by drawBox.
const PREFERRED_CONTENT_WIDTH = 88;

function initialIndex(agents: DiscoveredAgent[], preferred: string): number {
  const idx = agents.findIndex((a) => a.id === preferred);
  return idx === -1 ? 0 : idx;
}

export async function promptForAgent(
  term: Terminal,
  agents: DiscoveredAgent[],
  preferred?: string,
  opts?: { title?: string; intro?: string; overlay?: boolean },
): Promise<AgentPromptResult> {
  resetTerminalModes();
  let selected = initialIndex(agents, preferred ?? FALLBACK_PREFERRED_AGENT);
  let windowStart = 0;
  // Screen-coord bookkeeping for the mouse handler. Populated by
  // render() every paint; the mouse handler consults these to hit-test
  // clicks against the currently-visible rows.
  let listFirstScreenRow: number | null = null;
  // Box bounds recorded by the most recent render so onMouse can decide
  // whether a click landed outside the modal (→ cancel like Esc).
  let boxBounds: BoxLayout | null = null;

  // How many list rows fit: capped by MAX_VISIBLE_ROWS and by the
  // terminal height (leaving room for borders, the header line, the
  // footer line, and drawBox's own 4-row margin).
  const visibleRows = (): number => {
    const termBudget = readTermHeight(term) - 8;
    return Math.max(1, Math.min(MAX_VISIBLE_ROWS, agents.length, termBudget));
  };

  // Clamp windowStart to [0, agents.length - rows]. Called on every
  // paint so a stale start (e.g. after resize) doesn't index off the
  // end of the list.
  const clampWindow = (): void => {
    const rows = visibleRows();
    const maxStart = Math.max(0, agents.length - rows);
    if (windowStart > maxStart) {
      windowStart = maxStart;
    }
    if (windowStart < 0) {
      windowStart = 0;
    }
  };

  // Keep `selected` inside the scroll window. Called on selection
  // changes (↑/↓/j/k/hover) but NOT on wheel — the wheel scrolls the
  // viewport independently of selection, so an off-screen selection is
  // allowed and just isn't highlighted visually until the row scrolls
  // back into view.
  const ensureSelectedVisible = (): void => {
    const rows = visibleRows();
    if (selected < windowStart) {
      windowStart = selected;
    } else if (selected >= windowStart + rows) {
      windowStart = selected - rows + 1;
    }
    clampWindow();
  };

  // Layout cached across renders. drawBox is idempotent-costly (emits
  // every border cell + a contentW-wide space fill for every row);
  // calling it on every hover event visibly flickers. Reuse the frame
  // on selection-only changes and repaint just the two affected rows.
  let cachedLayout: BoxLayout | null = null;
  let cachedVisibleRows = 0;

  const paintListRow = (i: number, layout: BoxLayout): void => {
    if (i < windowStart || i >= windowStart + cachedVisibleRows) {
      return;
    }
    const agent = agents[i];
    if (!agent) {
      return;
    }
    const innerW = layout.contentW;
    // Row 0 = intro (contentY), row 1 = blank, row 2 = first list row.
    const rowOnScreen = layout.contentY + 2 + (i - windowStart);
    term.moveTo(layout.contentX, rowOnScreen);
    const pointer = i === selected ? "❯" : " ";
    const desc = agent.description ?? agent.name;
    const idPart = ` ${pointer} ${agent.id}`;
    if (i === selected) {
      const line = `${idPart}  ${desc}`;
      term.brightWhite.bgBlue.noFormat(padRight(truncate(line, innerW), innerW));
    } else {
      // Padded to innerW so a previously-highlighted row's residual
      // brightWhite.bgBlue cells get overwritten with default bg.
      const room = innerW - idPart.length - 2;
      const descPart =
        room > 1 ? `  ${truncate(desc, room)}` : "";
      term.noFormat(idPart);
      if (descPart.length > 0) {
        term.dim.noFormat(descPart);
      }
      // Trailing blank fill.
      const painted = idPart.length + descPart.length;
      if (painted < innerW) {
        term.noFormat(" ".repeat(innerW - painted));
      }
    }
  };

  const paintFooter = (layout: BoxLayout, rows: number): void => {
    const footerRowOnScreen =
      layout.contentY + 2 + cachedVisibleRows + 1;
    term.moveTo(layout.contentX, footerRowOnScreen);
    const more =
      agents.length > rows
        ? ` (${selected + 1}/${agents.length})`
        : "";
    const line = ` ↑/↓ navigate · Enter this session · s set default · Esc back${more}`;
    const padded = padRight(truncate(line, layout.contentW), layout.contentW);
    term.dim.noFormat(padded);
  };

  const renderFrame = (): BoxLayout => {
    clampWindow();
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
      title: opts?.title ?? "Select agent",
      overlay: opts?.overlay === true,
    });
    boxBounds = layout;
    cachedLayout = layout;
    cachedVisibleRows = Math.min(rows, agents.length - windowStart);
    listFirstScreenRow = layout.contentY + 2;
    // Intro row.
    term.moveTo(layout.contentX, layout.contentY);
    term.noFormat(` ${opts?.intro ?? "Which agent should this session use?"}`);
    const end = Math.min(agents.length, windowStart + rows);
    for (let i = windowStart; i < end; i++) {
      paintListRow(i, layout);
    }
    paintFooter(layout, rows);
    return layout;
  };

  // Called by runModalPrompt on entry + resize; also the fallback when
  // scroll changes.
  const render = (): BoxLayout => renderFrame();

  // Partial repaint: two rows (old + new selection) + the footer's
  // "(m/N)" counter. Called on hover / arrow key when scroll doesn't
  // change — no borders or blank-fill emitted, so no flicker.
  const rerenderSelectionChange = (previousSelected: number): void => {
    const layout = cachedLayout;
    if (layout === null) {
      renderFrame();
      return;
    }
    // If ensureSelectedVisible shifted windowStart (selection ran off
    // the visible viewport) fall back to a full frame — every row's
    // index changed.
    const rows = visibleRows();
    const priorWindowStart = windowStart;
    ensureSelectedVisible();
    if (windowStart !== priorWindowStart) {
      renderFrame();
      return;
    }
    cachedVisibleRows = Math.min(rows, agents.length - windowStart);
    if (previousSelected !== selected) {
      paintListRow(previousSelected, layout);
      paintListRow(selected, layout);
    }
    paintFooter(layout, rows);
  };

  const moveDown = (): void => {
    if (selected < agents.length - 1) {
      const prev = selected;
      selected++;
      rerenderSelectionChange(prev);
    }
  };
  const moveUp = (): void => {
    if (selected > 0) {
      const prev = selected;
      selected--;
      rerenderSelectionChange(prev);
    }
  };

  // Partial repaint used by wheel scrolling. Skips borders / intro
  // (they don't change) and repaints every list row + the footer.
  // Blanks any tail rows that fall out of range so a shorter list
  // doesn't leave residue.
  const repaintList = (): void => {
    const layout = cachedLayout;
    if (layout === null) {
      renderFrame();
      return;
    }
    const rows = visibleRows();
    clampWindow();
    cachedVisibleRows = Math.min(rows, agents.length - windowStart);
    const end = Math.min(agents.length, windowStart + rows);
    for (let i = windowStart; i < end; i++) {
      paintListRow(i, layout);
    }
    for (let r = cachedVisibleRows; r < rows; r++) {
      const rowOnScreen = layout.contentY + 2 + r;
      term.moveTo(layout.contentX, rowOnScreen);
      term.noFormat(" ".repeat(layout.contentW));
    }
    paintFooter(layout, rows);
  };

  // Wheel scrolls the viewport; selection stays put. If the highlight
  // scrolls out of view, that's fine — it reappears when the row
  // scrolls back in.
  const scrollBy = (delta: number): void => {
    const rows = visibleRows();
    const maxStart = Math.max(0, agents.length - rows);
    if (maxStart === 0) {
      return;
    }
    const next = Math.max(0, Math.min(maxStart, windowStart + delta));
    if (next === windowStart) {
      return;
    }
    windowStart = next;
    repaintList();
  };

  return runModalPrompt<AgentPromptResult>({
    term,
    render,
    overlay: opts?.overlay === true,
    onKey: (name, _m, data, finish) => {
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
    },
    // Click a row to highlight it; click the already-highlighted row
    // to select. Wheel scrolls the highlight ± 1. Consistent with the
    // session picker's list semantics (click-to-select-then-click-to-
    // commit) so nothing surprising if you jump between the two.
    onMouse: (name, data, finish) => {
      if (name === "MOUSE_WHEEL_UP") {
        scrollBy(-1);
        return;
      }
      if (name === "MOUSE_WHEEL_DOWN") {
        scrollBy(1);
        return;
      }
      // Hover → move the highlight to the row under the cursor. Silent
      // when the cursor isn't over a row (border, header, footer,
      // outside the box) so a mouse trip through the modal doesn't
      // change selection.
      if (name === "MOUSE_MOTION") {
        const y = data?.y;
        if (typeof y !== "number" || listFirstScreenRow === null) {
          return;
        }
        const rel = y - listFirstScreenRow;
        if (rel < 0 || rel >= cachedVisibleRows) {
          return;
        }
        const targetIdx = windowStart + rel;
        if (targetIdx < 0 || targetIdx >= agents.length) {
          return;
        }
        if (targetIdx !== selected) {
          const prev = selected;
          selected = targetIdx;
          rerenderSelectionChange(prev);
        }
        return;
      }
      if (name !== "MOUSE_LEFT_BUTTON_PRESSED") {
        return;
      }
      const x = data?.x;
      const y = data?.y;
      // Click outside the box → cancel (same as Esc).
      if (
        boxBounds !== null &&
        typeof x === "number" &&
        typeof y === "number" &&
        (x < boxBounds.x ||
          x >= boxBounds.x + boxBounds.w ||
          y < boxBounds.y ||
          y >= boxBounds.y + boxBounds.h)
      ) {
        finish({ kind: "back" });
        return;
      }
      if (typeof y !== "number" || listFirstScreenRow === null) {
        return;
      }
      const rel = y - listFirstScreenRow;
      if (rel < 0 || rel >= cachedVisibleRows) {
        return;
      }
      const targetIdx = windowStart + rel;
      if (targetIdx < 0 || targetIdx >= agents.length) {
        return;
      }
      // Hover already parked the highlight on the row under the cursor,
      // so a click here is unconditional select — no need for the
      // click-then-click-to-commit pattern the session picker uses (the
      // hover feedback makes the target unambiguous).
      const agent = agents[targetIdx];
      if (agent) {
        finish({ kind: "select", agentId: agent.id, persist: false });
      }
    },
  });
}
