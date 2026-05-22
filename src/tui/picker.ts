// Pre-screen interactive picker. A multiline "Create new session"
// composer sits at the top — focused by default — so the user can type
// the first prompt before the session exists; Enter creates it and
// submits the typed text. Below the composer is the session table
// (live first, then cold sorted by recency); ↓ from the composer drops
// focus into the list. The composer reuses the live screen's
// InputDispatcher so every readline shortcut works identically. Long
// lists scroll within a fixed viewport so every session remains
// reachable. Lives outside the main screen so it can run before
// fullscreen mode is engaged.

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
import type { RemoteTarget } from "../core/remote-target.js";
import {
  deleteSession,
  killSession,
  listSessions,
  regenSessionTitle,
  renameSession,
  type DiscoveredSession,
} from "./discovery.js";
import { InputDispatcher, type KeyEvent } from "./input.js";
import {
  computePromptLayout,
  computePromptVisualRows,
  mapKeyName,
  type PromptVisualRow,
} from "./screen.js";
import { withSync } from "./sync.js";

export type PickerResult =
  | {
      kind: "attach";
      sessionId: string;
      agentId?: string;
      // When true, the caller should attach with TuiOptions.readonly so
      // the daemon takes the viewer path (cold sessions don't resurrect)
      // and the TUI hides the composer. Set by the picker's `v`
      // keystroke; Enter leaves it undefined / false.
      readonly?: boolean;
    }
  | { kind: "new"; prompt?: string }
  | { kind: "abort" };

export interface PickOptions {
  cwd: string;
  sessions: DiscoveredSession[];
  config: HydraConfig;
  // Daemon connection — local or remote. Picker REST calls (list /
  // rename / kill / delete) all route through this so the picker
  // always operates on the same daemon as the active connection.
  target: RemoteTarget;
  // When the picker is opened from inside a session (^p), pre-select that
  // session's row so the user can drop straight back in with Enter.
  currentSessionId?: string;
}

// Each row is prefixed with "❯ " or "  " (2 columns wide) so the row's
// content budget is termWidth - 2. Apply the same prefix to the
// "Create new session" title so its truncation matches.
const ROW_PREFIX_WIDTH = 2;

// Visual rows the composer pane can occupy before its internal window
// scrolls. Kept smaller than the live composer's MAX_PROMPT_ROWS (8)
// because the picker still has to leave room for the session list.
const PICKER_COMPOSER_MAX_ROWS = 4;

// Composer box borders + 1-col inner pad on each side: "│ …slice… │".
// Subtracted from termWidth to derive the soft-wrap budget so text
// never collides with the right border.
const BOX_HORIZONTAL_PAD = 4;

// Help dialog content. `null` entries are blank-line separators. The
// keys column is left-aligned and padded to HELP_KEYS_WIDTH so the
// descriptions stack into a clean second column.
const HELP_KEYS_WIDTH = 20;
const HELP_ENTRIES: ReadonlyArray<readonly [string, string] | null> = [
  ["Composer", "type prompt for new session; Enter creates + submits"],
  ["↓ from composer", "drop focus into session list"],
  null,
  ["↑ / ↓, n / p, ^p / ^n", "navigate sessions"],
  ["PgUp / PgDn", "page up / page down"],
  ["Home / End", "first / last"],
  ["Enter", "open selected session"],
  ["v", "view-only (open transcript without spawning the agent)"],
  null,
  ["/", "search sessions"],
  ["o", "toggle cwd-only filter"],
  ["h", "cycle host filter (local / <peer> / all)"],
  ["r", "refresh from daemon"],
  null,
  ["k", "kill the selected live session"],
  ["d", "delete the selected cold session"],
  ["t", "retitle the selected session"],
  ["T", "regenerate title via agent (live session)"],
  null,
  ["?", "toggle this help"],
  ["q / Esc / ^C / ^D", "quit picker (detach)"],
];

export async function pickSession(
  term: Terminal,
  opts: PickOptions,
): Promise<PickerResult> {
  // Belt-and-suspenders: clear any sticky kitty / mouse / bracketed-paste
  // state from a previous crashed run (or a previous screen session in
  // this process) before we start grabbing input. The picker uses
  // terminal-kit's native parser which can't handle CSI-u sequences, so
  // leaving kitty pushed makes arrows and ESC misbehave here.
  //
  // Also force DECCKM off (\x1b[?1l) and DECPAM off (\x1b>): when the
  // alternate screen is active, iTerm enables application-cursor-key
  // mode, in which arrows are sent as \x1bOA/B/C/D instead of
  // \x1b[A/B/C/D. terminal-kit detects iTerm as osx-256color whose
  // keymap only recognizes the \x1b[ form, so without this reset the
  // arrows are dropped as "unknown" sequences and never reach onKey.
  process.stdout.write("\x1b[<u");
  process.stdout.write("\x1b[?2004l");
  process.stdout.write("\x1b[>4;0m");
  process.stdout.write("\x1b[>5;0m");
  process.stdout.write("\x1b[?1000l");
  process.stdout.write("\x1b[?1002l");
  process.stdout.write("\x1b[?1006l");
  process.stdout.write("\x1b[?1l");
  process.stdout.write("\x1b>");
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

  // `o` toggles a cwd-only filter that narrows `visible` to sessions whose
  // cwd matches the current cwd. Composes with search — both are AND'd.
  let cwdOnly = false;

  // `h` cycles a host filter. "__local" (default) hides every imported
  // session; "__all" hides nothing; any other value matches the row's
  // importedFromMachine literally. Cycle order is local → each unique
  // peer host (alphabetical) → all → back to local. If the picker was
  // opened from inside an imported session (^p), bump straight to
  // "__all" so the current row is still findable below.
  let hostFilter: string = "__local";
  if (opts.currentSessionId !== undefined) {
    const current = opts.sessions.find(
      (s) => s.sessionId === opts.currentSessionId,
    );
    if (current?.importedFromMachine) {
      hostFilter = "__all";
    }
  }

  // sorted/rows/widths are rebuilt whenever the underlying session list
  // changes (kill / delete refetches from the daemon). `allSessions` is the
  // full sorted source; `visible` is the currently displayed slice — the
  // subset of allSessions after the cwd-only / host filter / search
  // filters compose. Initial `visible` already respects the default
  // host filter so a fresh picker doesn't flash the unfiltered list.
  let allSessions: DiscoveredSession[] = sortSessions(opts.sessions);
  let visible: DiscoveredSession[] = filterByHost(allSessions, hostFilter);
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

  // Composer pane at the top of the picker. Reuses the live composer's
  // InputDispatcher so every readline shortcut (Alt+Enter newline,
  // ^A/^E, ^U/^K/^W, ^Y, etc.) works identically. The dispatcher's
  // buffer text is sent as the new session's first prompt on Enter.
  const composer = new InputDispatcher({ history: [] });

  // All layout state — recomputed on initial paint AND on every resize.
  let termHeight = readTermHeight(term);
  let termWidth = readTermWidth(term);
  let viewportSize = 0;
  let composerTitle = "";
  // Wrap budget for composer body slices; matches what computeLayout's
  // computePromptVisualRows was called with so cursor placement uses
  // the same room value as rendering.
  let composerRoom = 0;
  let composerVisualRows: PromptVisualRow[] = [];
  // Rendered composer body row count this frame (1..PICKER_COMPOSER_MAX_ROWS).
  let composerRows = 1;
  // Window start into composerVisualRows when the buffer overflows
  // PICKER_COMPOSER_MAX_ROWS. Recomputed via computePromptLayout.
  let composerWindowStart = 0;
  let composerCursorRow = 0;
  let composerCursorCol = 0;
  let headerLine = "";
  let sessionLines: string[] = [];
  let startRow = 1;

  const cwdMaxWidth = opts.config.tui.cwdColumnMaxWidth;
  const computeLayout = (): void => {
    termHeight = readTermHeight(term);
    termWidth = readTermWidth(term);
    const rowMaxWidth = Math.max(10, termWidth - ROW_PREFIX_WIDTH);
    // Composer body sits inside a "│ … │" box, costing 4 cols (border +
    // 1-col pad on each side). Buffer wrap is computed against this
    // tighter budget so cursor placement matches what we paint.
    composerRoom = Math.max(10, termWidth - BOX_HORIZONTAL_PAD);
    // Title embeds in the top border as "╭─ <title> ──...─╮", so the
    // title length is capped at termWidth - 8 to guarantee at least two
    // trailing dashes before the corner glyph.
    const titleBudget = Math.max(10, termWidth - 8);
    composerTitle = formatComposerTitle(opts.cwd, titleBudget);
    const state = composer.state();
    composerVisualRows = computePromptVisualRows(state.buffer, composerRoom);
    const layout = computePromptLayout(
      composerVisualRows,
      state,
      PICKER_COMPOSER_MAX_ROWS,
    );
    composerRows = layout.rendered;
    composerWindowStart = layout.windowStart;
    composerCursorRow = layout.cursorVisualRow;
    composerCursorCol = layout.cursorVisualCol;
    // Reserve rows: top border (1) + body (composerRows) + bottom
    // border (1) + blank (1) + header (1) + indicator (1) + trailing
    // newline (1).
    const reserved = 6 + composerRows;
    const maxViewportRows = Math.max(3, termHeight - reserved);
    viewportSize = Math.min(visible.length, maxViewportRows);
    // Pad header / session lines to rowMaxWidth so paintSessionRow and the
    // header paint can overwrite the previous frame without an
    // eraseLineAfter. Without padding, a shorter new row would leave
    // stale glyphs from the prior frame.
    headerLine = formatRow(HEADER, widths, rowMaxWidth, cwdMaxWidth).padEnd(
      rowMaxWidth,
    );
    sessionLines = rows.map((r) =>
      formatRow(r, widths, rowMaxWidth, cwdMaxWidth).padEnd(rowMaxWidth),
    );
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
    base = filterByHost(base, hostFilter);
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

  // Inner width of the box (cols between the two corner glyphs). At
  // least 2 so we can always fit "──".
  const composerBoxInner = (): number => Math.max(2, termWidth - 2);

  // Top border with the title embedded:
  //   ╭─ Create new session in ~/foo ────────────────────╮
  // Title is middle-truncated by formatComposerTitle to fit composerRoom;
  // the dashes flex to fill whatever remains so the border touches the
  // right edge of the terminal.
  const paintComposerTopBorder = (): void => {
    const inner = composerBoxInner();
    const focused = selectedIdx === 0;
    const titleFragment = `─ ${composerTitle} `;
    const dashCount = Math.max(1, inner - titleFragment.length);
    const dashes = "─".repeat(dashCount);
    if (focused) {
      term.brightCyan.noFormat("╭");
      term.brightCyan.bold.noFormat(titleFragment);
      term.brightCyan.noFormat(`${dashes}╮`);
    } else {
      term.dim.noFormat(`╭${titleFragment}${dashes}╮`);
    }
  };

  // Bottom border: ╰──...──╯ stretched to the terminal width.
  const paintComposerBottomBorder = (): void => {
    const inner = composerBoxInner();
    const dashes = "─".repeat(inner);
    if (selectedIdx === 0) {
      term.brightCyan.noFormat(`╰${dashes}╯`);
    } else {
      term.dim.noFormat(`╰${dashes}╯`);
    }
  };

  // One visual row of the composer body, wrapped in left/right box
  // borders. Inside the box we keep just a one-column space between the
  // border and the text — no "> " / "· " gutters because the box itself
  // is the visual frame, and the cursor + content make the entry intent
  // obvious.
  const paintComposerBodyRow = (visualIdx: number): void => {
    const inner = composerBoxInner();
    const sideStyle = selectedIdx === 0 ? term.brightCyan : term.dim;
    sideStyle.noFormat("│");
    const vr = composerVisualRows[visualIdx];
    let slice = "";
    if (vr) {
      slice = (composer.state().buffer[vr.bufferIdx] ?? "").slice(
        vr.startCol,
        vr.endCol,
      );
    }
    // Inner cell content: " " + slice + pad so the right border lands
    // exactly at column termWidth. inner counts only the cells between
    // borders, so total inner-pad width is inner - 1 (left pad already
    // written) - slice.length.
    term.noFormat(" ");
    term.noFormat(slice);
    const padWidth = Math.max(0, inner - 1 - slice.length);
    if (padWidth > 0) {
      term.noFormat(" ".repeat(padWidth));
    }
    sideStyle.noFormat("│");
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
    if (hostFilter !== "__all") {
      parts.push(
        hostFilter === "__local"
          ? "host: local"
          : `host: ${hostFilter}`,
      );
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
  // picker (most navigation, confirm/cancel, transient hints). Content
  // length varies (search hint, transient status), so we still have to
  // clear leftover chars — but doing the erase AFTER paint (rather than
  // before) means the row is never blanked mid-frame.
  const paintIndicator = (): void => {
    withSync(() => {
      term.moveTo(1, indicatorRow());
      if (mode === "confirm-kill" && pendingAction) {
        term.brightYellow.noFormat(`  kill ${shortId(pendingAction.sessionId)}? [y/N]`);
      } else if (mode === "confirm-delete" && pendingAction) {
        term.brightRed.noFormat(`  delete ${shortId(pendingAction.sessionId)}? [y/N]`);
      } else if (mode === "busy" && pendingAction) {
        term.dim.noFormat(`  working on ${shortId(pendingAction.sessionId)}…`);
      } else if (mode === "rename" && pendingAction) {
        term.brightYellow.noFormat(`  title: ${renameBuffer}`);
        term.bgBrightYellow(" ");
        term.dim.noFormat("  Enter saves · Esc cancels");
      } else if (transientStatus !== null) {
        term.dim.noFormat(`  ${transientStatus}`);
      } else if (searchActive) {
        // Search line is anchored to the bottom of the picker so it
        // stays visible regardless of how the session list scrolls
        // above. ^c exits and clears the filter. A trailing block
        // cursor reinforces that the line accepts input.
        term.brightYellow.noFormat(`  /${searchTerm}`);
        term.bgBrightYellow(" ");
        const hint =
          visible.length === 0
            ? " no matches"
            : ` ${visible.length} match${visible.length === 1 ? "" : "es"}`;
        term.dim.noFormat(`${hint} · ^c clears`);
      } else {
        term.dim.noFormat(formatIndicator());
      }
      // Trailing reset + erase: clears any stale chars past the new
      // content from the previous frame, with default SGR so the
      // erased cells don't inherit a bg colour from the rename / search
      // bgBrightYellow span above.
      term.styleReset();
      term.eraseLineAfter();
    });
  };

  // Composer rows:
  //   startRow                            ╭─ title ─╮
  //   startRow + 1 .. + composerRows      │ body  │
  //   startRow + composerRows + 1         ╰─────────╯
  //   startRow + composerRows + 2         blank
  //   startRow + composerRows + 3         header
  //   sessions follow; indicator after the viewport
  const composerBodyRow = (visualOffset: number): number =>
    startRow + 1 + visualOffset;
  const composerBottomRow = (): number => startRow + composerRows + 1;
  const headerRow = (): number => startRow + composerRows + 3;
  const sessionRow = (sessionIdx: number): number =>
    headerRow() + 1 + (sessionIdx - scrollOffset);
  const indicatorRow = (): number => headerRow() + 1 + viewportSize;

  // Position the visible terminal cursor inside the composer body so the
  // user can see where typed characters will land. Called after every
  // render/repaint when selectedIdx === 0; hidden by callers otherwise.
  // Column 1 is the left border, column 2 is the inner pad, so the
  // first content column is 3.
  const placeComposerCursor = (): void => {
    const visualOffset = composerCursorRow - composerWindowStart;
    if (visualOffset < 0 || visualOffset >= composerRows) {
      return;
    }
    const col = 3 + composerCursorCol;
    term.moveTo(col, composerBodyRow(visualOffset));
  };

  // Full paint from a clean slate: clear the screen, anchor the picker at
  // row 1, and lay out every row. Used on initial entry (so we don't have
  // to rely on a cursor-position query) and on resize (where the cleanest
  // way to recover is to start over). Hides the cursor for the duration
  // of the paint so the user never sees it skitter row-by-row across the
  // frame; the trailing block places it where it belongs.
  const renderFromScratch = (): void => {
    if (mode === "help") {
      renderHelp();
      return;
    }
    withSync(() => {
      term.hideCursor();
      computeLayout();
      adjustScroll();
      startRow = 1;
      term.moveTo(1, 1).eraseDisplayBelow();
      paintComposerTopBorder();
      term("\n");
      for (let v = 0; v < composerRows; v++) {
        paintComposerBodyRow(composerWindowStart + v);
        term("\n");
      }
      paintComposerBottomBorder();
      term("\n\n");
      term.dim.noFormat(`  ${headerLine}`)("\n");
      for (let v = 0; v < viewportSize; v++) {
        paintSessionRow(scrollOffset + v);
        term("\n");
      }
      paintIndicator();
      term("\n");
      if (selectedIdx === 0) {
        placeComposerCursor();
        term.hideCursor(false);
      }
    });
  };

  const renderHelp = (): void => {
    withSync(() => {
      term.hideCursor();
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
    });
  };

  // Repaint just the box chrome (top + bottom borders). Used when focus
  // toggles between composer and list so the border color flips without
  // a full picker redraw. Borders + body rows are written full-width
  // (border + pad + slice + pad + border = termWidth) so we skip the
  // eraseLineAfter call that previously caused a blank-flash frame.
  const repaintComposerChrome = (): void => {
    withSync(() => {
      const showCursor = selectedIdx === 0;
      if (showCursor) {
        term.hideCursor();
      }
      term.moveTo(1, startRow);
      paintComposerTopBorder();
      term.moveTo(1, composerBottomRow());
      paintComposerBottomBorder();
      for (let v = 0; v < composerRows; v++) {
        term.moveTo(1, composerBodyRow(v));
        paintComposerBodyRow(composerWindowStart + v);
      }
      if (showCursor) {
        placeComposerCursor();
        term.hideCursor(false);
      }
    });
  };
  // Redraw every composer body row without disturbing layout above or
  // below. Recomputes the visual rows from the dispatcher first; if the
  // dispatcher needs a wider window than this frame allotted, the caller
  // should renderFromScratch (handled by the row-count check in onKey).
  // Hides the cursor while painting so each keystroke doesn't visibly
  // walk it across the row before snapping back to the typing position.
  const repaintComposerBody = (): void => {
    withSync(() => {
      const state = composer.state();
      composerVisualRows = computePromptVisualRows(state.buffer, composerRoom);
      const layout = computePromptLayout(
        composerVisualRows,
        state,
        PICKER_COMPOSER_MAX_ROWS,
      );
      composerWindowStart = layout.windowStart;
      composerCursorRow = layout.cursorVisualRow;
      composerCursorCol = layout.cursorVisualCol;
      const showCursor = selectedIdx === 0;
      if (showCursor) {
        term.hideCursor();
      }
      for (let v = 0; v < composerRows; v++) {
        term.moveTo(1, composerBodyRow(v));
        paintComposerBodyRow(composerWindowStart + v);
      }
      if (showCursor) {
        placeComposerCursor();
        term.hideCursor(false);
      }
    });
  };
  const repaintSessionRow = (sessionIdx: number): void => {
    if (
      sessionIdx < scrollOffset ||
      sessionIdx >= scrollOffset + viewportSize
    ) {
      return;
    }
    withSync(() => {
      term.moveTo(1, sessionRow(sessionIdx));
      paintSessionRow(sessionIdx);
    });
  };
  const repaintViewport = (): void => {
    withSync(() => {
      for (let v = 0; v < viewportSize; v++) {
        const row = headerRow() + 1 + v;
        const sessionIdx = scrollOffset + v;
        if (sessionIdx < visible.length) {
          term.moveTo(1, row);
          paintSessionRow(sessionIdx);
        } else {
          // Past the end of the visible list — still need to erase so a
          // stale row from a prior frame doesn't linger.
          term.moveTo(1, row).eraseLineAfter();
        }
      }
      paintIndicator();
    });
  };

  renderFromScratch();

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
        const next = await listSessions(opts.target);
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
      const session = pendingAction;
      mode = "busy";
      paintIndicator();
      try {
        await renameSession(opts.target, session.sessionId, title);
        mode = "normal";
        pendingAction = null;
        renameBuffer = "";
        await refresh(session.sessionId);
      } catch (err) {
        mode = "normal";
        pendingAction = null;
        renameBuffer = "";
        transientStatus = `rename failed: ${(err as Error).message}`;
        paintIndicator();
      }
    };
    // Regen is fire-and-forget on the daemon side (202 Accepted) so the
    // picker doesn't block on the session's prompt queue draining. We
    // show a transient hint to confirm the request was accepted; the
    // new title surfaces on the next manual refresh (r) or on the next
    // picker open. Stays in normal mode throughout — no busy spinner,
    // no auto-refresh that would race the regen.
    const performRegen = async (session: { sessionId: string }): Promise<void> => {
      try {
        await regenSessionTitle(opts.target, session.sessionId);
        transientStatus = "title regen queued (press r to refresh)";
        paintIndicator();
      } catch (err) {
        transientStatus = `regen failed: ${(err as Error).message}`;
        paintIndicator();
      }
    };
    const performAction = async (kind: "kill" | "delete"): Promise<void> => {
      if (!pendingAction) {
        return;
      }
      const session = pendingAction;
      mode = "busy";
      paintIndicator();
      try {
        if (kind === "kill") {
          await killSession(opts.target, session.sessionId);
        } else {
          await deleteSession(opts.target, session.sessionId);
        }
        mode = "normal";
        pendingAction = null;
        await refresh(kind === "kill" ? session.sessionId : undefined);
      } catch (err) {
        mode = "normal";
        pendingAction = null;
        transientStatus = `${kind} failed: ${(err as Error).message}`;
        paintIndicator();
      }
    };
    // Side-effects for crossing the composer/list focus boundary: show /
    // hide the visible terminal cursor and repaint the composer chrome
    // so the border + title color reflects the new focus state.
    const onFocusChange = (oldIdx: number, newIdx: number): void => {
      if ((oldIdx === 0) === (newIdx === 0)) {
        return;
      }
      repaintComposerChrome();
      if (newIdx === 0) {
        term.hideCursor(false);
        placeComposerCursor();
      } else {
        term.hideCursor();
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
      // Wrap the whole focus change so the two-row swap (and any
      // composer chrome repaint on a focus-boundary crossing) commits
      // as one atomic frame on terminals that support DEC 2026.
      withSync(() => {
        if (scrollOffset !== oldScroll) {
          repaintViewport();
          onFocusChange(old, selectedIdx);
          return;
        }
        if (old !== 0) {
          repaintSessionRow(old - 1);
        }
        if (selectedIdx !== 0) {
          repaintSessionRow(selectedIdx - 1);
        }
        onFocusChange(old, selectedIdx);
      });
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
      // Composer focused: route keys through the InputDispatcher so every
      // readline shortcut works identically to the live composer. The
      // composer eats hotkeys like `/`, `r`, `?`, `k`, etc. — they only
      // fire when the user has moved focus down into the session list.
      if (selectedIdx === 0 && !searchActive) {
        if (name === "ESCAPE" || name === "CTRL_C" || name === "CTRL_D") {
          cleanup();
          resolve({ kind: "abort" });
          return;
        }
        if (name === "ENTER" || name === "KP_ENTER") {
          cleanup();
          const text = composer.state().buffer.join("\n");
          if (text.trim().length === 0) {
            resolve({ kind: "new" });
          } else {
            resolve({ kind: "new", prompt: text });
          }
          return;
        }
        // ↓ at the bottom visual row of the buffer drops focus into the
        // first session row. Anywhere else, ↓ feeds the dispatcher for
        // intra-buffer cursor motion. With no sessions to drop into, ↓
        // is a no-op (composer stays focused).
        if (name === "DOWN") {
          const atBottom =
            composerVisualRows.length === 0 ||
            composerCursorRow === composerVisualRows.length - 1;
          if (atBottom && visible.length > 0) {
            move(1);
            return;
          }
          // fall through to dispatcher
        }
        // PgDn at the bottom of the buffer also escapes to the list, so
        // a power user can jump straight from "type a prompt" into "pick
        // a session" without arrowing through every line.
        if (name === "PAGE_DOWN") {
          const atBottom =
            composerVisualRows.length === 0 ||
            composerCursorRow === composerVisualRows.length - 1;
          if (atBottom && visible.length > 0) {
            move(1);
            return;
          }
        }
        // ^P switches the input dispatcher in the live composer; here it
        // would emit a "switch-session" effect we'd just drop. Map it to
        // the picker's list-focus instead so the chord stays useful.
        if (name === "CTRL_P") {
          if (visible.length > 0) {
            move(1);
          }
          return;
        }
        const before = composer.state();
        let event: KeyEvent | null = null;
        if (data?.isCharacter) {
          event = { type: "char", ch: name };
        } else {
          const mapped = mapKeyName(name);
          if (mapped !== null) {
            event = { type: "key", name: mapped };
          }
        }
        if (event === null) {
          placeComposerCursor();
          return;
        }
        composer.feed(event);
        const after = composer.state();
        const unchanged =
          before.buffer.length === after.buffer.length &&
          before.buffer.every((line, i) => line === after.buffer[i]) &&
          before.row === after.row &&
          before.col === after.col;
        if (unchanged) {
          placeComposerCursor();
          return;
        }
        // Recompute visual rows; if the rendered row count needs to grow
        // or shrink, redraw the whole picker so the session list shifts
        // in lockstep. Otherwise repaint just the composer body.
        const newVisualRows = computePromptVisualRows(after.buffer, composerRoom);
        const newLayout = computePromptLayout(
          newVisualRows,
          after,
          PICKER_COMPOSER_MAX_ROWS,
        );
        if (newLayout.rendered !== composerRows) {
          renderFromScratch();
          return;
        }
        repaintComposerBody();
        return;
      }
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
          } else {
            searchActive = false;
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
        if (name === "h" || name === "H") {
          const keepId =
            selectedIdx > 0 ? visible[selectedIdx - 1]?.sessionId : undefined;
          hostFilter = nextHostFilter(hostFilter, allSessions);
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
        if ((name === "v" || name === "V") && selectedIdx > 0) {
          // View-only: attach as a transcript viewer without spawning an
          // agent. Same shape as the Enter path's attach result but with
          // readonly:true so the TUI signals the daemon's viewer path.
          const session = visible[selectedIdx - 1];
          if (!session) {
            return;
          }
          cleanup();
          const result: PickerResult = {
            kind: "attach",
            sessionId: session.sessionId,
            readonly: true,
          };
          if (session.agentId !== undefined) {
            result.agentId = session.agentId;
          }
          resolve(result);
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
          void performRegen({ sessionId: session.sessionId });
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
        case "CTRL_P":
          move(-1);
          return;
        case "DOWN":
        case "TAB":
        case "CTRL_N":
          move(1);
          return;
        case "PAGE_UP":
          move(-viewportSize);
          return;
        case "PAGE_DOWN":
          move(viewportSize);
          return;
        case "HOME":
          // Land on the topmost session (selectedIdx=1), not on the
          // composer (selectedIdx=0). adjustScroll then pulls scrollOffset
          // back to 0. Up arrow from there can still reach the composer.
          move(1 - selectedIdx);
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

// Title line for the composer pane. Middle-truncate the cwd so the user
// still sees enough (home, project root, leaf) to identify where the
// session will be created. ~/-shortened to match the session rows below.
function formatComposerTitle(cwd: string, maxWidth: number): string {
  const prefix = "Create new session in ";
  const budget = Math.max(1, maxWidth - prefix.length);
  return prefix + truncateMiddle(shortenHomePath(cwd), budget);
}

// Apply the picker's host filter to a session list. Sentinel values:
//   "__all"   — no filter.
//   "__local" — sessions created here OR imported and already bound to
//               a local agent (upstreamSessionId set). The "I'm working
//               on this here" bucket.
//   <host>    — passive mirrors imported from <host> that haven't been
//               attached locally yet. Once you attach, the session
//               graduates to "__local" and stops appearing here.
export function filterByHost(
  sessions: DiscoveredSession[],
  hostFilter: string,
): DiscoveredSession[] {
  if (hostFilter === "__all") {
    return sessions;
  }
  if (hostFilter === "__local") {
    return sessions.filter(
      (s) => !s.importedFromMachine || !!s.upstreamSessionId,
    );
  }
  return sessions.filter(
    (s) => s.importedFromMachine === hostFilter && !s.upstreamSessionId,
  );
}

// Cycle the host filter through "__local" → each peer host with at
// least one passive mirror (alphabetical) → "__all" → back to "__local".
// A peer host whose sessions have all been attached locally drops out
// of the cycle because the "<host>" filter would render an empty list
// for it. Exported so picker.test.ts can drive the transitions.
export function nextHostFilter(
  current: string,
  sessions: ReadonlyArray<{
    importedFromMachine?: string;
    upstreamSessionId?: string;
  }>,
): string {
  const hosts = new Set<string>();
  for (const s of sessions) {
    if (s.importedFromMachine && !s.upstreamSessionId) {
      hosts.add(s.importedFromMachine);
    }
  }
  const ordered = ["__local", ...[...hosts].sort(), "__all"];
  const idx = ordered.indexOf(current);
  if (idx === -1) {
    return "__local";
  }
  return ordered[(idx + 1) % ordered.length] ?? "__local";
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
