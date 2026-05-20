// Pre-screen interactive picker. Lists every session (live first, then
// cold sorted by recency) with a "New session" entry at the top — the
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
import { shortenHomePath } from "../core/paths.js";
import { stripHydraSessionPrefix } from "../core/session.js";
import type { HydraConfig } from "../core/config.js";
import {
  deleteSession,
  killSession,
  listSessions,
  regenSessionTitle,
  renameSession,
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
  serviceToken: string;
  // When the picker is opened from inside a session (^p), pre-select that
  // session's row so the user can drop straight back in with Enter.
  currentSessionId?: string;
}

// Each row is prefixed with "❯ " or "  " (2 columns wide) so the row's
// content budget is termWidth - 2. Apply the same prefix to the
// "New session" label so its truncation matches.
const ROW_PREFIX_WIDTH = 2;

// Help dialog content. `null` entries are blank-line separators. The
// keys column is left-aligned and padded to HELP_KEYS_WIDTH so the
// descriptions stack into a clean second column.
const HELP_KEYS_WIDTH = 20;
const HELP_ENTRIES: ReadonlyArray<readonly [string, string] | null> = [
  ["↑ / ↓ or n / p", "navigate"],
  ["PgUp / PgDn", "page up / page down"],
  ["Home / End", "first / last"],
  ["Enter", "open selected session (or create new)"],
  null,
  ["/", "search sessions"],
  ["o", "toggle cwd-only filter"],
  ["r", "refresh from daemon"],
  null,
  ["k", "kill the selected live session"],
  ["d", "delete the selected cold session"],
  ["t", "retitle the selected session"],
  ["T", "regenerate title via agent (live session)"],
  null,
  ["c", "create new session"],
  ["?", "toggle this help"],
  ["q / Esc / ^C / ^D", "quit picker (detach)"],
];

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
  // changes (kill / delete refetches from the daemon). `allSessions` is the
  // full sorted source; `visible` is the currently displayed slice — equal
  // to `allSessions` when the picker isn't filtering, otherwise the subset
  // matching `searchTerm`.
  let allSessions: DiscoveredSession[] = sortSessions(opts.sessions);
  let visible: DiscoveredSession[] = allSessions;
  let rows: Row[] = visible.map((s) => toRow(s, Date.now()));
  let widths: Widths = computeWidths(rows);

  // selectedIdx 0 = "New session"; 1..N = visible sessions in order.
  // scrollOffset is the 0-indexed session that occupies the first viewport
  // row. Both persist across resizes so the cursor doesn't snap.
  let total = 1 + visible.length;
  let selectedIdx = 0;
  let scrollOffset = 0;
  if (opts.currentSessionId !== undefined) {
    const idx = visible.findIndex((s) => s.sessionId === opts.currentSessionId);
    if (idx >= 0) {
      selectedIdx = idx + 1;
    }
  }

  // Picker-search state. `/` enters search; printable chars build up
  // `searchTerm` and incrementally narrow `visible`; ^c / ESC drops the
  // filter and returns to the full list. The filter never persists across
  // pickSession calls — state is local to this invocation.
  let searchActive = false;
  let searchTerm = "";

  // `o` toggles a cwd-only filter that narrows `visible` to sessions whose
  // cwd matches the current cwd. Composes with search — both are AND'd.
  let cwdOnly = false;

  // Confirmation state. While in 'confirm-kill' or 'confirm-delete' we
  // hijack key handling, replace the indicator with a yes/no prompt, and
  // ignore navigation until the user resolves (y/n/ESC). `pendingAction`
  // pins the row that was targeted when the prompt opened so concurrent
  // refreshes don't drift the action onto a different session.
  // 'help' replaces the entire screen with a hotkey cheatsheet that any
  // key dismisses.
  type Mode =
    | "normal"
    | "confirm-kill"
    | "confirm-delete"
    | "rename"
    | "busy"
    | "help";
  let mode: Mode = "normal";
  let pendingAction: { sessionId: string; cwd: string; status: "live" | "cold" } | null = null;
  // Rename input buffer. Pre-filled with the current title when `t` is
  // pressed on a live row; the user edits in-place (^U clears the line,
  // ^W deletes a word, Backspace pops a char). Enter saves, Esc cancels.
  let renameBuffer = "";
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

  const cwdMaxWidth = opts.config.tui.cwdColumnMaxWidth;
  const computeLayout = (): void => {
    termHeight = readTermHeight(term);
    termWidth = readTermWidth(term);
    const maxViewportRows = Math.max(3, termHeight - 6);
    viewportSize = Math.min(visible.length, maxViewportRows);
    const rowMaxWidth = Math.max(10, termWidth - ROW_PREFIX_WIDTH);
    newSessionLabel = formatNewSessionLabel(opts.cwd, rowMaxWidth);
    headerLine = formatRow(HEADER, widths, rowMaxWidth, cwdMaxWidth);
    sessionLines = rows.map((r) => formatRow(r, widths, rowMaxWidth, cwdMaxWidth));
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

  // Apply (or remove, when searchTerm is empty / searchActive is false)
  // the picker-search filter to `allSessions`, replacing `visible` with
  // the filtered slice and rebuilding all derived state. When invoked
  // while in search mode, snaps the cursor to the first match (or to
  // "New session" when nothing matches) so the user always sees a
  // selectable row; out of search mode the cursor/scroll are clamped
  // but not reset (so refresh after a kill doesn't drop context).
  const applyFilter = (): void => {
    let base = allSessions;
    if (cwdOnly) {
      base = base.filter((s) => s.cwd === opts.cwd);
    }
    if (searchActive && searchTerm.length > 0) {
      visible = base.filter((s) => matchesSearch(s, searchTerm));
    } else {
      visible = base;
    }
    rebuildRows();
    if (searchActive) {
      scrollOffset = 0;
      selectedIdx = visible.length > 0 ? 1 : 0;
    } else if (selectedIdx > total - 1) {
      selectedIdx = Math.max(0, total - 1);
    }
    if (scrollOffset + viewportSize > visible.length) {
      scrollOffset = Math.max(0, visible.length - viewportSize);
    }
    adjustScroll();
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
    const parts: string[] = [];
    if (cwdOnly) {
      parts.push("cwd-only");
    }
    if (above > 0) {
      parts.push(`↑ ${above} above`);
    }
    if (below > 0) {
      parts.push(`↓ ${below} below`);
    }
    if (parts.length === 0) {
      return "";
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
    if (mode === "rename" && pendingAction) {
      term.brightYellow.noFormat(`  title: ${renameBuffer}`);
      term.bgBrightYellow(" ");
      term.dim.noFormat("  Enter saves · Esc cancels");
      return;
    }
    if (transientStatus !== null) {
      term.dim.noFormat(`  ${transientStatus}`);
      return;
    }
    if (searchActive) {
      // Search line is anchored to the bottom of the picker so it stays
      // visible regardless of how the session list scrolls above. ^c
      // exits and clears the filter. A trailing block cursor reinforces
      // that the line accepts input.
      term.brightYellow.noFormat(`  /${searchTerm}`);
      term.bgBrightYellow(" ");
      const hint =
        visible.length === 0
          ? " no matches"
          : ` ${visible.length} match${visible.length === 1 ? "" : "es"}`;
      term.dim.noFormat(`${hint} · ^c clears`);
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
    if (mode === "help") {
      renderHelp();
      return;
    }
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

  const renderHelp = (): void => {
    term.moveTo(1, 1).eraseDisplayBelow();
    term.brightWhite.bold.noFormat("  Picker hotkeys")("\n\n");
    for (const entry of HELP_ENTRIES) {
      if (entry === null) {
        term("\n");
        continue;
      }
      const [keys, desc] = entry;
      term.brightCyan.noFormat(`  ${keys.padEnd(HELP_KEYS_WIDTH)}`);
      term.noFormat(desc)("\n");
    }
    term("\n");
    term.dim.noFormat("  press any key to dismiss")("\n");
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
        const next = await listSessions(opts.config, opts.serviceToken);
        allSessions = sortSessions(next);
        applyFilter();
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
    const performRename = async (title: string): Promise<void> => {
      if (!pendingAction) {
        return;
      }
      const target = pendingAction;
      mode = "busy";
      paintIndicator();
      try {
        await renameSession(opts.config, opts.serviceToken, target.sessionId, title);
        mode = "normal";
        pendingAction = null;
        renameBuffer = "";
        await refresh(target.sessionId);
      } catch (err) {
        mode = "normal";
        pendingAction = null;
        renameBuffer = "";
        transientStatus = `rename failed: ${(err as Error).message}`;
        paintIndicator();
      }
    };
    const performRegen = async (target: { sessionId: string; cwd: string; status: "live" | "cold" }): Promise<void> => {
      pendingAction = target;
      mode = "busy";
      paintIndicator();
      try {
        await regenSessionTitle(opts.config, opts.serviceToken, target.sessionId);
        mode = "normal";
        pendingAction = null;
        await refresh(target.sessionId);
      } catch (err) {
        mode = "normal";
        pendingAction = null;
        transientStatus = `regen failed: ${(err as Error).message}`;
        paintIndicator();
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
          await killSession(opts.config, opts.serviceToken, target.sessionId);
        } else {
          await deleteSession(opts.config, opts.serviceToken, target.sessionId);
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
      // Help dialog: any key dismisses and restores the picker. ^c still
      // aborts the picker entirely so the user can't feel trapped if
      // they hit help by mistake mid-session.
      if (mode === "help") {
        if (name === "CTRL_C") {
          cleanup();
          resolve({ kind: "abort" });
          return;
        }
        mode = "normal";
        renderFromScratch();
        return;
      }
      if (mode === "rename") {
        if (name === "ENTER" || name === "KP_ENTER") {
          const trimmed = renameBuffer.trim();
          if (trimmed.length === 0) {
            mode = "normal";
            pendingAction = null;
            renameBuffer = "";
            paintIndicator();
            return;
          }
          void performRename(trimmed);
          return;
        }
        if (name === "ESCAPE" || name === "CTRL_C") {
          mode = "normal";
          pendingAction = null;
          renameBuffer = "";
          paintIndicator();
          return;
        }
        if (name === "BACKSPACE") {
          if (renameBuffer.length > 0) {
            renameBuffer = renameBuffer.slice(0, -1);
            paintIndicator();
          }
          return;
        }
        if (name === "CTRL_U") {
          renameBuffer = "";
          paintIndicator();
          return;
        }
        if (name === "CTRL_W") {
          // Trim trailing whitespace then drop the last whitespace-delimited
          // word, matching what most readline-style editors do.
          const trimmedRight = renameBuffer.replace(/\s+$/, "");
          const lastSpace = trimmedRight.lastIndexOf(" ");
          renameBuffer = lastSpace >= 0 ? trimmedRight.slice(0, lastSpace) : "";
          paintIndicator();
          return;
        }
        if (data?.isCharacter) {
          renameBuffer += name;
          paintIndicator();
          return;
        }
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
      // `?` opens the help overlay outside of search mode (in search,
      // it's a literal character that may appear in a query).
      if (!searchActive && data?.isCharacter && name === "?") {
        mode = "help";
        renderHelp();
        return;
      }
      // Search mode: chars build the filter, navigation keys still move
      // through the filtered list, ^c / ESC clears the filter. r/k/d/etc.
      // are intentionally NOT interpreted as actions here — the user is
      // typing a substring that may contain those letters.
      if (searchActive) {
        if (data?.isCharacter) {
          searchTerm += name;
          applyFilter();
          renderFromScratch();
          return;
        }
        if (name === "BACKSPACE") {
          if (searchTerm.length > 0) {
            searchTerm = searchTerm.slice(0, -1);
            applyFilter();
            renderFromScratch();
          }
          return;
        }
        if (name === "ESCAPE" || name === "CTRL_C") {
          searchActive = false;
          searchTerm = "";
          applyFilter();
          renderFromScratch();
          return;
        }
        // Fall through for UP/DOWN/PAGE_UP/PAGE_DOWN/HOME/END/ENTER so the
        // user can navigate the filtered list and pick a match without
        // leaving search mode.
      }
      if (data?.isCharacter) {
        if (name === "/") {
          searchActive = true;
          searchTerm = "";
          applyFilter();
          renderFromScratch();
          return;
        }
        if (name === "n" || name === "N") {
          move(1);
          return;
        }
        if (name === "p" || name === "P") {
          move(-1);
          return;
        }
        if (name === "c" || name === "C") {
          cleanup();
          resolve({ kind: "new" });
          return;
        }
        if (name === "q" || name === "Q") {
          cleanup();
          resolve({ kind: "abort" });
          return;
        }
        if (name === "o" || name === "O") {
          const keepId =
            selectedIdx > 0 ? visible[selectedIdx - 1]?.sessionId : undefined;
          cwdOnly = !cwdOnly;
          applyFilter();
          if (keepId !== undefined) {
            const idx = visible.findIndex((s) => s.sessionId === keepId);
            if (idx >= 0) {
              selectedIdx = idx + 1;
              adjustScroll();
            }
          }
          renderFromScratch();
          return;
        }
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
        if (name === "t" && selectedIdx > 0) {
          const session = visible[selectedIdx - 1];
          if (!session) {
            return;
          }
          pendingAction = {
            sessionId: session.sessionId,
            cwd: session.cwd,
            status: session.status,
          };
          renameBuffer = session.title ?? "";
          mode = "rename";
          paintIndicator();
          return;
        }
        if (name === "T" && selectedIdx > 0) {
          const session = visible[selectedIdx - 1];
          if (!session || session.status !== "live") {
            return;
          }
          void performRegen({
            sessionId: session.sessionId,
            cwd: session.cwd,
            status: session.status,
          });
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
        case "CTRL_D":
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
// project root, leaf) to identify the session. ~/-shortened to match
// the session rows below.
function formatNewSessionLabel(cwd: string, maxWidth: number): string {
  const prefix = "New session in ";
  const budget = Math.max(1, maxWidth - prefix.length);
  return prefix + truncateMiddle(shortenHomePath(cwd), budget);
}

// Case-insensitive substring match across the session's user-visible
// metadata. Exported so the picker.test.ts can exercise it directly
// without driving a fake terminal.
export function matchesSearch(s: DiscoveredSession, term: string): boolean {
  if (term.length === 0) {
    return true;
  }
  const t = term.toLowerCase();
  const haystacks = [
    stripHydraSessionPrefix(s.sessionId),
    s.upstreamSessionId ?? "",
    s.agentId ?? "",
    s.title ?? "",
    s.cwd,
    shortenHomePath(s.cwd),
  ];
  for (const h of haystacks) {
    if (h.toLowerCase().includes(t)) {
      return true;
    }
  }
  return false;
}
