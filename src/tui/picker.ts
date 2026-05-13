// Pre-screen interactive picker. Lists every session (live first, then
// cold sorted by recency) with a "+ New session" entry at the top — the
// default cursor position — so Enter creates a new session or the user
// can arrow down into the list. Long lists scroll within a fixed
// viewport so every session remains reachable. Lives outside the main
// screen so it can run before fullscreen mode is engaged.

import type { Terminal } from "terminal-kit";
import {
  HEADER,
  computeWidths,
  formatRow,
  toRow,
  truncateMiddle,
  type Row,
  type Widths,
} from "../cli/session-row.js";
import { stripHydraSessionPrefix } from "../core/session.js";
import type { HydraConfig } from "../core/config.js";
import {
  deleteSession,
  killSession,
  listSessions,
  type DiscoveredSession,
} from "./discovery.js";

export type PickerResult =
  | { kind: "attach"; sessionId: string; agentId?: string }
  | { kind: "new" }
  | { kind: "abort" };

export interface PickOptions {
  cwd: string;
  sessions: DiscoveredSession[];
  config: HydraConfig;
}

// Each row is prefixed with "❯ " or "  " (2 columns wide) so the row's
// content budget is termWidth - 2. Apply the same prefix to the
// "+ New session" label so its truncation matches.
const ROW_PREFIX_WIDTH = 2;

export async function pickSession(
  term: Terminal,
  opts: PickOptions,
): Promise<PickerResult> {
  if (opts.sessions.length === 0) {
    return { kind: "new" };
  }
  const sortSessions = (sessions: DiscoveredSession[]): DiscoveredSession[] => {
    const score = (s: DiscoveredSession): number => {
      if (s.status !== "live") {
        return 0;
      }
      return s.cwd === opts.cwd ? 2 : 1;
    };
    return [...sessions].sort((a, b) => {
      const tier = score(b) - score(a);
      if (tier !== 0) {
        return tier;
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  };

  // sorted/rows/widths are rebuilt whenever the underlying session list
  // changes (kill / delete refetches from the daemon).
  let visible: DiscoveredSession[] = sortSessions(opts.sessions);
  let rows: Row[] = visible.map((s) => toRow(s, Date.now()));
  let widths: Widths = computeWidths(rows);

  // selectedIdx 0 = "+ New session"; 1..N = visible sessions in order.
  // scrollOffset is the 0-indexed session that occupies the first viewport
  // row. Both persist across resizes so the cursor doesn't snap.
  let total = 1 + visible.length;
  let selectedIdx = 0;
  let scrollOffset = 0;

  // Confirmation state. While in 'confirm-kill' or 'confirm-delete' we
  // hijack key handling, replace the indicator with a yes/no prompt, and
  // ignore navigation until the user resolves (y/n/ESC). `pendingAction`
  // pins the row that was targeted when the prompt opened so concurrent
  // refreshes don't drift the action onto a different session.
  type Mode = "normal" | "confirm-kill" | "confirm-delete" | "busy";
  let mode: Mode = "normal";
  let pendingAction: { sessionId: string; cwd: string; status: "live" | "cold" } | null = null;
  // Transient one-line hint shown in the indicator slot (e.g. "live —
  // press k first" when 'd' was used on a live row). Cleared on the next
  // key press so it never lingers.
  let transientStatus: string | null = null;

  // All layout state — recomputed on initial paint AND on every resize.
  let termHeight = readTermHeight(term);
  let termWidth = readTermWidth(term);
  let viewportSize = 0;
  let newSessionLabel = "";
  let headerLine = "";
  let sessionLines: string[] = [];
  let startRow = 1;

  const computeLayout = (): void => {
    termHeight = readTermHeight(term);
    termWidth = readTermWidth(term);
    const maxViewportRows = Math.max(3, termHeight - 6);
    viewportSize = Math.min(visible.length, maxViewportRows);
    const rowMaxWidth = Math.max(10, termWidth - ROW_PREFIX_WIDTH);
    newSessionLabel = formatNewSessionLabel(opts.cwd, rowMaxWidth);
    headerLine = formatRow(HEADER, widths, rowMaxWidth);
    sessionLines = rows.map((r) => formatRow(r, widths, rowMaxWidth));
  };

  // After the underlying session list changed (kill / delete), rebuild
  // the derived row/widths/layout arrays in lockstep. Callers handle
  // cursor placement and trigger the actual repaint themselves.
  const rebuildRows = (): void => {
    rows = visible.map((s) => toRow(s, Date.now()));
    widths = computeWidths(rows);
    total = 1 + visible.length;
    computeLayout();
  };

  const adjustScroll = (): void => {
    if (selectedIdx === 0) {
      return;
    }
    const sessionIdx = selectedIdx - 1;
    if (sessionIdx < scrollOffset) {
      scrollOffset = sessionIdx;
    } else if (sessionIdx >= scrollOffset + viewportSize) {
      scrollOffset = sessionIdx - viewportSize + 1;
    } else if (scrollOffset + viewportSize > visible.length) {
      // Resize shrank the viewport past the tail — pull scrollOffset back
      // so we still fill the visible rows.
      scrollOffset = Math.max(0, visible.length - viewportSize);
    }
  };

  const paintNewItem = (): void => {
    if (selectedIdx === 0) {
      term.brightWhite.bgBlue.noFormat(`❯ ${newSessionLabel}`);
    } else {
      term.noFormat(`  ${newSessionLabel}`);
    }
  };

  const paintSessionRow = (sessionIdx: number): void => {
    const label = sessionLines[sessionIdx] ?? "";
    if (selectedIdx === sessionIdx + 1) {
      term.brightWhite.bgBlue.noFormat(`❯ ${label}`);
    } else {
      term.noFormat(`  ${label}`);
    }
  };

  const formatIndicator = (): string => {
    const above = scrollOffset;
    const below = Math.max(0, visible.length - scrollOffset - viewportSize);
    if (above === 0 && below === 0) {
      return "";
    }
    const parts: string[] = [];
    if (above > 0) {
      parts.push(`↑ ${above} above`);
    }
    if (below > 0) {
      parts.push(`↓ ${below} below`);
    }
    return `  ${parts.join(" · ")}`;
  };

  // Short id used in confirm prompts; matches what users see in the table.
  const shortId = (sessionId: string): string => stripHydraSessionPrefix(sessionId);

  // Paint just the indicator row in whatever style matches the current
  // mode. Used by every state transition that doesn't redraw the whole
  // picker (most navigation, confirm/cancel, transient hints).
  const paintIndicator = (): void => {
    term.moveTo(1, indicatorRow()).eraseLineAfter();
    if (mode === "confirm-kill" && pendingAction) {
      term.brightYellow.noFormat(`  kill ${shortId(pendingAction.sessionId)}? [y/N]`);
      return;
    }
    if (mode === "confirm-delete" && pendingAction) {
      term.brightRed.noFormat(`  delete ${shortId(pendingAction.sessionId)}? [y/N]`);
      return;
    }
    if (mode === "busy" && pendingAction) {
      term.dim.noFormat(`  working on ${shortId(pendingAction.sessionId)}…`);
      return;
    }
    if (transientStatus !== null) {
      term.dim.noFormat(`  ${transientStatus}`);
      return;
    }
    term.dim.noFormat(formatIndicator());
  };

  const indicatorRow = (): number => startRow + 3 + viewportSize;
  const sessionRow = (sessionIdx: number): number =>
    startRow + 3 + (sessionIdx - scrollOffset);

  // Full paint from a clean slate: clear the screen, anchor the picker at
  // row 1, and lay out every row. Used on initial entry (so we don't have
  // to rely on a cursor-position query) and on resize (where the cleanest
  // way to recover is to start over).
  const renderFromScratch = (): void => {
    computeLayout();
    adjustScroll();
    startRow = 1;
    term.moveTo(1, 1).eraseDisplayBelow();
    paintNewItem();
    term("\n\n");
    term.dim.noFormat(`  ${headerLine}`)("\n");
    for (let v = 0; v < viewportSize; v++) {
      paintSessionRow(scrollOffset + v);
      term("\n");
    }
    paintIndicator();
    term("\n");
  };

  const repaintNewItem = (): void => {
    term.moveTo(1, startRow).eraseLineAfter();
    paintNewItem();
  };
  const repaintSessionRow = (sessionIdx: number): void => {
    if (
      sessionIdx < scrollOffset ||
      sessionIdx >= scrollOffset + viewportSize
    ) {
      return;
    }
    term.moveTo(1, sessionRow(sessionIdx)).eraseLineAfter();
    paintSessionRow(sessionIdx);
  };
  const repaintViewport = (): void => {
    for (let v = 0; v < viewportSize; v++) {
      const row = startRow + 3 + v;
      term.moveTo(1, row).eraseLineAfter();
      const sessionIdx = scrollOffset + v;
      if (sessionIdx < visible.length) {
        paintSessionRow(sessionIdx);
      }
    }
    paintIndicator();
  };

  renderFromScratch();
  term.hideCursor();

  return await new Promise<PickerResult>((resolve) => {
    let resolved = false;
    const onResize = (): void => {
      if (resolved) {
        return;
      }
      renderFromScratch();
    };
    const cleanup = (): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      term.off("key", onKey);
      term.off("resize", onResize);
      term.grabInput(false);
      term.hideCursor(false);
      term.moveTo(1, indicatorRow() + 1);
      term("\n");
    };
    // Refetch sessions from the daemon and re-render. When `preferredId`
    // is provided we try to land the cursor on that session id (used
    // after kill so the cursor follows the row as it sorts to the cold
    // tier); otherwise selectedIdx stays put (clamped to the new size),
    // which after delete lands on whatever now occupies the old slot.
    const refresh = async (preferredId?: string): Promise<void> => {
      try {
        const next = await listSessions(opts.config);
        visible = sortSessions(next);
        rebuildRows();
        if (preferredId !== undefined) {
          const idx = visible.findIndex((s) => s.sessionId === preferredId);
          if (idx >= 0) {
            selectedIdx = idx + 1;
          }
        }
        if (selectedIdx > total - 1) {
          selectedIdx = Math.max(0, total - 1);
        }
        if (scrollOffset + viewportSize > visible.length) {
          scrollOffset = Math.max(0, visible.length - viewportSize);
        }
        adjustScroll();
        renderFromScratch();
      } catch (err) {
        transientStatus = `refresh failed: ${(err as Error).message}`;
        renderFromScratch();
      }
    };
    const performAction = async (kind: "kill" | "delete"): Promise<void> => {
      if (!pendingAction) {
        return;
      }
      const target = pendingAction;
      mode = "busy";
      paintIndicator();
      try {
        if (kind === "kill") {
          await killSession(opts.config, target.sessionId);
        } else {
          await deleteSession(opts.config, target.sessionId);
        }
        mode = "normal";
        pendingAction = null;
        await refresh(kind === "kill" ? target.sessionId : undefined);
      } catch (err) {
        mode = "normal";
        pendingAction = null;
        transientStatus = `${kind} failed: ${(err as Error).message}`;
        paintIndicator();
      }
    };
    const move = (delta: number): void => {
      const next = Math.min(total - 1, Math.max(0, selectedIdx + delta));
      if (next === selectedIdx) {
        return;
      }
      const old = selectedIdx;
      const oldScroll = scrollOffset;
      selectedIdx = next;
      adjustScroll();
      if (scrollOffset !== oldScroll) {
        // Viewport scrolled — every session row may have changed. Also
        // refresh "+ New" if its selection state flipped on this move.
        repaintViewport();
        if (old === 0 || selectedIdx === 0) {
          repaintNewItem();
        }
        return;
      }
      // No scroll: just redraw the two rows whose selection state changed.
      if (old === 0) {
        repaintNewItem();
      } else {
        repaintSessionRow(old - 1);
      }
      if (selectedIdx === 0) {
        repaintNewItem();
      } else {
        repaintSessionRow(selectedIdx - 1);
      }
    };
    const clearTransient = (): boolean => {
      if (transientStatus === null) {
        return false;
      }
      transientStatus = null;
      paintIndicator();
      return true;
    };
    const onKey = (
      name: string,
      _matches: unknown,
      data?: { isCharacter?: boolean },
    ): void => {
      // Drop input while an HTTP action is mid-flight so we don't
      // double-fire a kill/delete or repaint over the in-progress prompt.
      if (mode === "busy") {
        return;
      }
      if (mode === "confirm-kill" || mode === "confirm-delete") {
        if (data?.isCharacter && (name === "y" || name === "Y")) {
          const kind = mode === "confirm-kill" ? "kill" : "delete";
          void performAction(kind);
          return;
        }
        if (
          name === "ESCAPE" ||
          name === "CTRL_C" ||
          name === "ENTER" ||
          name === "KP_ENTER" ||
          (data?.isCharacter && (name === "n" || name === "N"))
        ) {
          mode = "normal";
          pendingAction = null;
          paintIndicator();
          return;
        }
        return;
      }
      // Any keypress dismisses a transient hint so it doesn't bleed
      // into the next action's context. We still fall through and run
      // the key's normal behavior.
      clearTransient();
      if (data?.isCharacter) {
        if (name === "r" || name === "R") {
          const currentId =
            selectedIdx > 0 ? visible[selectedIdx - 1]?.sessionId : undefined;
          void refresh(currentId);
          return;
        }
        if ((name === "k" || name === "K") && selectedIdx > 0) {
          const session = visible[selectedIdx - 1];
          if (!session) {
            return;
          }
          pendingAction = {
            sessionId: session.sessionId,
            cwd: session.cwd,
            status: session.status,
          };
          mode = "confirm-kill";
          paintIndicator();
          return;
        }
        if ((name === "d" || name === "D") && selectedIdx > 0) {
          const session = visible[selectedIdx - 1];
          if (!session) {
            return;
          }
          if (session.status === "live") {
            transientStatus = "session is live — press k to kill it first";
            paintIndicator();
            return;
          }
          pendingAction = {
            sessionId: session.sessionId,
            cwd: session.cwd,
            status: session.status,
          };
          mode = "confirm-delete";
          paintIndicator();
          return;
        }
        return;
      }
      switch (name) {
        case "UP":
        case "SHIFT_TAB":
          move(-1);
          return;
        case "DOWN":
        case "TAB":
          move(1);
          return;
        case "PAGE_UP":
          move(-viewportSize);
          return;
        case "PAGE_DOWN":
          move(viewportSize);
          return;
        case "HOME":
          move(-total);
          return;
        case "END":
          move(total);
          return;
        case "ENTER":
        case "KP_ENTER": {
          cleanup();
          if (selectedIdx === 0) {
            resolve({ kind: "new" });
            return;
          }
          const session = visible[selectedIdx - 1];
          if (!session) {
            resolve({ kind: "abort" });
            return;
          }
          const result: PickerResult = {
            kind: "attach",
            sessionId: session.sessionId,
          };
          if (session.agentId !== undefined) {
            result.agentId = session.agentId;
          }
          resolve(result);
          return;
        }
        case "ESCAPE":
        case "CTRL_C":
          cleanup();
          resolve({ kind: "abort" });
          return;
      }
    };
    term.grabInput({});
    term.on("key", onKey);
    term.on("resize", onResize);
  });
}

function readTermHeight(term: Terminal): number {
  return (term as unknown as { height?: number }).height ?? 24;
}

function readTermWidth(term: Terminal): number {
  return (term as unknown as { width?: number }).width ?? 80;
}

// Middle-truncate the cwd so the user still sees enough of it (home,
// project root, leaf) to identify the session.
function formatNewSessionLabel(cwd: string, maxWidth: number): string {
  const prefix = "+ New session in ";
  const budget = Math.max(1, maxWidth - prefix.length);
  return prefix + truncateMiddle(cwd, budget);
}
