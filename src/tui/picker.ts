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
import { paths, shortenHomePath } from "../core/paths.js";
import { stripHydraSessionPrefix } from "../core/session.js";
import type { HydraConfig } from "../core/config.js";
import type { RemoteTarget } from "../core/remote-target.js";
import {
  deleteSession,
  killSession,
  listSessions,
  regenSessionTitle,
  renameSession,
  searchSessions,
  type DiscoveredSession,
  type SessionHits,
} from "./discovery.js";
import { loadHistory } from "./history.js";
import { InputDispatcher, type KeyEvent } from "./input.js";
import {
  computePromptLayout,
  computePromptVisualRows,
  mapKeyName,
  type PromptVisualRow,
} from "./screen.js";
import {
  promptForLaunchOrView,
  type LaunchOrViewResult,
} from "./import-action-prompt.js";
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
  | {
      // Picker's `f` keystroke. Outer flow runs the (optional) cwd
      // prompt, calls the daemon's fork endpoint, then attaches to the
      // returned new session id. Picker forwards the source's metadata
      // verbatim so the outer flow can decide whether to prompt
      // (foreign-imported-never-launched → yes) or skip (local source).
      kind: "fork";
      sourceSessionId: string;
      sourceAgentId?: string;
      sourceCwd: string;
      sourceImportedFromMachine?: string;
      sourceUpstreamSessionId?: string;
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
  // Persistent filter state. Seeded on first picker open from
  // createPickerPrefs(); pickSession mutates it in place so the next
  // invocation re-opens with the same `o`/`h` toggles the user left in
  // place. When omitted, picker uses defaults (cwdOnly off, hostFilter
  // "__local") and the legacy "auto-bump to __all when current row is
  // imported" rule still applies.
  prefs?: PickerPrefs;
}

// Picker filter state. `filters` is its own nested bag so future
// non-filter prefs (sort order, view mode, etc.) can sit alongside it
// without churning the filter call sites.
export interface PickerFilters {
  cwdOnly: boolean;
  // "__local" | "__all" | host name. See `hostFilter` in pickSession
  // for the cycle order and meaning.
  hostFilter: string;
  // When false (default), the picker only renders rows the daemon
  // marked interactive (real conversations). Cat one-shots and
  // editor-spawned empty sessions stay hidden. Toggle with `i` to
  // surface everything.
  includeNonInteractive: boolean;
}

// User-tweakable picker state that should outlive a single pickSession
// invocation. Created once per TUI process and threaded through every
// picker open so toggles survive entering a session and returning via
// ^p.
export interface PickerPrefs {
  filters: PickerFilters;
}

export function createPickerPrefs(): PickerPrefs {
  return {
    filters: {
      cwdOnly: false,
      hostFilter: "__local",
      includeNonInteractive: false,
    },
  };
}

// Each row is prefixed with "❯ " or "  " (2 columns wide) so the row's
// content budget is termWidth - 2. Apply the same prefix to the
// "Create new session" title so its truncation matches.
const ROW_PREFIX_WIDTH = 2;

// Visual rows the composer pane can occupy before its internal window
// scrolls. Kept smaller than the live composer's MAX_PROMPT_ROWS (8)
// because the picker still has to leave room for the session list.
const PICKER_COMPOSER_MAX_ROWS = 4;

// Same cap for the find-session query box.
const FIND_BOX_MAX_ROWS = 4;

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
  ["/", "search sessions (metadata)"],
  ["^f", "find in session history (content + tool inputs)"],
  ["o", "toggle cwd-only filter"],
  ["h", "cycle host filter (local / <peer> / all)"],
  ["i", "toggle include-cat filter"],
  ["r", "refresh from daemon"],
  null,
  ["k", "kill the selected live session"],
  ["d", "delete the selected session (kills first if live)"],
  ["t", "retitle the selected session"],
  ["T", "regenerate title + synopsis via agent (live session)"],
  null,
  ["?", "toggle this help"],
  ["q / Esc / ^C / ^D", "quit picker (detach)"],
];

// A unit of focused input. The focus stack in pickSession routes all
// key/resize events to the topmost layer; push pushes a new one,
// pop restores the one below (and re-renders it via onResize).
export interface FocusLayer {
  onKey(name: string, _matches: unknown, data?: { isCharacter?: boolean }): void;
  onResize(): void;
}

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

  // All persistent toggles live on `prefs.filters`. We read and write
  // straight through this object — no shadow locals — so adding a new
  // filter is one field on PickerFilters plus the per-filter key
  // handler; no further plumbing required. When the caller didn't pass
  // a prefs container, fall back to fresh defaults so the picker still
  // runs (state simply doesn't outlive the call).
  //
  //   `o` toggles cwd-only — narrows `visible` to sessions whose cwd
  //   matches the current cwd. Composes with search (both AND'd).
  //   `h` cycles host filter. "__local" (default) hides every imported
  //   session; "__all" hides nothing; any other value matches the row's
  //   importedFromMachine literally. Cycle order is local → each unique
  //   peer host (alphabetical) → all → back to local.
  //
  // Imported-current-session auto-bump: when the picker was opened from
  // inside an imported session (^p) AND the user hasn't explicitly
  // chosen a host filter yet (no prefs passed), bump straight to "__all"
  // so the current row is still findable. When prefs are passed in,
  // respect them verbatim — the user's choice wins.
  const prefs = opts.prefs ?? createPickerPrefs();
  if (opts.prefs === undefined && opts.currentSessionId !== undefined) {
    const current = opts.sessions.find(
      (s) => s.sessionId === opts.currentSessionId,
    );
    if (current?.importedFromMachine) {
      prefs.filters.hostFilter = "__all";
    }
  }

  // sorted/rows/widths are rebuilt whenever the underlying session list
  // changes (kill / delete refetches from the daemon). `allSessions` is the
  // full sorted source; `visible` is the currently displayed slice — the
  // subset of allSessions after the cwd-only / host filter / search
  // filters compose.
  let allSessions: DiscoveredSession[] = sortSessions(opts.sessions, opts.cwd);
  // Single source of truth for persistent filters from prefs. Both the
  // initial paint and applyFilter (after a toggle) route through this so
  // adding a new filter is a one-place change. The transient search
  // filter composes on top inside applyFilter — not here because
  // searchActive is always false at picker open.
  const applyPrefsFilters = (
    sessions: DiscoveredSession[],
  ): DiscoveredSession[] => {
    let base = sessions;
    if (prefs.filters.cwdOnly) {
      base = base.filter((s) => s.cwd === opts.cwd);
    }
    if (!prefs.filters.includeNonInteractive) {
      // Mirror the daemon's includeRow rule: only effective === true is
      // visible. Cat (false) and never-prompted editor panels (undefined)
      // both stay hidden until the user toggles `i`.
      base = base.filter((s) => s.interactive === true);
    }
    base = filterByHost(base, prefs.filters.hostFilter);
    return base;
  };
  let visible: DiscoveredSession[] = applyPrefsFilters(allSessions);
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
  type Mode =
    | "normal"
    | "confirm-kill"
    | "confirm-delete"
    | "rename"
    | "busy";
  let mode: Mode = "normal";
  let pendingAction: { sessionId: string; cwd: string; status: "live" | "cold" } | null = null;
  // Find-session state. All transient — cleared when exitFind() fires.
  let findSubMode: "input" | "results" = "input";
  let findComposer = new InputDispatcher({
    history: [],
    collapsePastes: false,
  });
  let findResults: SessionHits[] = [];
  let findTruncated = false;
  let findSelectedIdx = 0;
  let findSnippetIdx = 0;
  let findError: string | null = null;
  // True while a search HTTP call is in flight. Blocks input the same
  // way "busy" does for kill/delete, but with its own indicator so the
  // user sees "searching…" instead of "working on <id>…".
  let findInFlight = false;
  // Rename input buffer. Pre-filled with the current title when `t` is
  // pressed on a live row; the user edits in-place (^U clears the line,
  // ^W deletes a word, Backspace pops a char). Enter saves, Esc cancels.
  let renameBuffer = "";
  // Transient one-line hint shown in the indicator slot. Cleared on the
  // next key press so it never lingers.
  let transientStatus: string | null = null;
  // Set when the user kills or deletes the session they opened the picker
  // from. Aborting (Esc) would otherwise resume that now-dead session,
  // which then errors on the first prompt — so we block the abort and
  // make the user pick a live session or start a new one instead.
  let currentSessionGone = false;

  // Composer pane at the top of the picker. Reuses the live composer's
  // InputDispatcher so every readline shortcut (Alt+Enter newline,
  // ^A/^E, ^U/^K/^W, ^Y, etc.) works identically. The dispatcher's
  // buffer text is sent as the new session's first prompt on Enter.
  const composer = new InputDispatcher({ history: [] });
  // Seed Up-arrow recall with the global cross-session prompt history,
  // same as the live composer. Loaded asynchronously so we don't suspend
  // before installing input handlers; in practice the file load resolves
  // before the user can type, but even if they beat it, the worst case
  // is that the very first Up keystroke before load has no history.
  const composerHistoryCap = opts.config.tui.promptHistoryMaxEntries;
  loadHistory(paths.globalTuiHistoryFile())
    .then((entries) => {
      const capped =
        entries.length > composerHistoryCap
          ? entries.slice(entries.length - composerHistoryCap)
          : entries;
      composer.setHistory(capped);
    })
    .catch(() => undefined);

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
  // Find-box layout state — recomputed by computeFindBoxLayout() before
  // each renderFind() or after every keystroke that changes the buffer.
  let findRoom = 0;
  let findVisualRows: PromptVisualRow[] = [];
  let findBoxRows = 1;
  let findBoxWindowStart = 0;
  let findBoxCursorVisualRow = 0;
  let findBoxCursorVisualCol = 0;

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
    const base = applyPrefsFilters(allSessions);
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

  // Re-select the session that was under the cursor before a filter
  // toggle, falling back to the top of the new visible list when it's
  // no longer there. Every filter handler (`o`, `h`, future toggles)
  // should call this after applyFilter so the cursor lands somewhere
  // sensible — without it, the cursor stays at whatever row index it
  // happened to occupy, which after a host cycle can be any random
  // session.
  const restoreCursorAfterFilter = (keepId: string | undefined): void => {
    if (keepId !== undefined) {
      const idx = visible.findIndex((s) => s.sessionId === keepId);
      if (idx >= 0) {
        selectedIdx = idx + 1;
        adjustScroll();
        return;
      }
    }
    selectedIdx = visible.length > 0 ? 1 : 0;
    scrollOffset = 0;
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
    const titleFragment = `─ ${composerTitle} `;
    const dashCount = Math.max(1, inner - titleFragment.length);
    const dashes = "─".repeat(dashCount);
    if (selectedIdx === 0) {
      term.brightBlue.noFormat(`╭${titleFragment}${dashes}╮`);
    } else {
      term.dim.noFormat(`╭${titleFragment}${dashes}╮`);
    }
  };

  // Bottom border: ╰──...──╯ stretched to the terminal width.
  const paintComposerBottomBorder = (): void => {
    const inner = composerBoxInner();
    const dashes = "─".repeat(inner);
    if (selectedIdx === 0) {
      term.brightBlue.noFormat(`╰${dashes}╯`);
    } else {
      term.dim.noFormat(`╰${dashes}╯`);
    }
  };

  // One visual row of the composer body. Focused: border glyphs in
  // brightBlue, content plain. Unfocused: borders dim, content plain.
  const paintComposerBodyRow = (visualIdx: number): void => {
    const inner = composerBoxInner();
    const vr = composerVisualRows[visualIdx];
    let slice = "";
    if (vr) {
      slice = (composer.state().buffer[vr.bufferIdx] ?? "").slice(
        vr.startCol,
        vr.endCol,
      );
    }
    const padWidth = Math.max(0, inner - 1 - slice.length);
    const pad = " ".repeat(padWidth);
    if (selectedIdx === 0) {
      term.brightBlue.noFormat("│");
      term.noFormat(` ${slice}${pad}`);
      term.brightBlue.noFormat("│");
    } else {
      term.dim.noFormat("│");
      term.noFormat(` ${slice}${pad}`);
      term.dim.noFormat("│");
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
    if (prefs.filters.cwdOnly) {
      parts.push("cwd-only");
    }
    if (prefs.filters.hostFilter !== "__all") {
      parts.push(
        prefs.filters.hostFilter === "__local"
          ? "host: local"
          : `host: ${prefs.filters.hostFilter}`,
      );
    }
    if (prefs.filters.includeNonInteractive) {
      parts.push("+non-interactive");
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
        if (pendingAction.status === "live") {
          term.brightRed.noFormat(
            `  kill + delete ${shortId(pendingAction.sessionId)}? [y/N]`,
          );
        } else {
          term.brightRed.noFormat(
            `  delete ${shortId(pendingAction.sessionId)}? [y/N]`,
          );
        }
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

  // Find-session layout — box at top (findBoxRows+2 rows) + blank (1 row) + results.
  // Mirrors the normal picker's composer-box-above-session-list structure
  // so the query is always visible while browsing results.
  //
  //   row 1              ╭─ Find sessions ─╮
  //   row 2..findBoxRows+1  │ body rows     │
  //   row findBoxRows+2  ╰─────────────────╯
  //   row findBoxRows+3  (blank)
  //   row findBoxRows+4  ❯ session-id  cold  Title   ← findResultsStartRow()
  //   ...
  //   last               indicator
  const findResultsStartRow = (): number => findBoxRows + 4;
  const FIND_FOOTER_ROWS = 2;
  let findScrollOffset = 0;
  const findViewportSize = (): number => {
    termHeight = readTermHeight(term);
    const avail = Math.max(2, termHeight - (findBoxRows + 3) - FIND_FOOTER_ROWS);
    return Math.max(1, Math.floor(avail / 2));
  };
  const adjustFindScroll = (): void => {
    const v = findViewportSize();
    if (findSelectedIdx < findScrollOffset) {
      findScrollOffset = findSelectedIdx;
    } else if (findSelectedIdx >= findScrollOffset + v) {
      findScrollOffset = findSelectedIdx - v + 1;
    }
    if (findScrollOffset + v > findResults.length) {
      findScrollOffset = Math.max(0, findResults.length - v);
    }
    if (findScrollOffset < 0) {
      findScrollOffset = 0;
    }
  };

  // ── Box paint helpers ──────────────────────────────────────────────
  // These mirror the composer's paintComposerTopBorder / Body / Bottom
  // pattern. "focused" toggles brightBlue vs dim for the borders and
  // determines whether the real terminal cursor is placed inside.

  const paintFindBoxTopBorder = (focused: boolean): void => {
    termWidth = readTermWidth(term);
    const inner = Math.max(2, termWidth - 2);
    const title = "─ Find sessions ";
    const dashes = "─".repeat(Math.max(1, inner - title.length));
    if (focused) {
      term.brightBlue.noFormat(`╭${title}${dashes}╮`);
    } else {
      term.dim.noFormat(`╭${title}${dashes}╮`);
    }
    term.styleReset();
  };

  // Recompute findVisualRows, findBoxRows, window/cursor from the dispatcher.
  const computeFindBoxLayout = (): void => {
    termWidth = readTermWidth(term);
    findRoom = Math.max(10, termWidth - BOX_HORIZONTAL_PAD);
    const state = findComposer.state();
    findVisualRows = computePromptVisualRows(state.buffer, findRoom);
    const layout = computePromptLayout(findVisualRows, state, FIND_BOX_MAX_ROWS);
    findBoxRows = layout.rendered;
    findBoxWindowStart = layout.windowStart;
    findBoxCursorVisualRow = layout.cursorVisualRow;
    findBoxCursorVisualCol = layout.cursorVisualCol;
  };

  const paintFindBoxBodyRow = (visualIdx: number, focused: boolean): void => {
    termWidth = readTermWidth(term);
    const inner = Math.max(2, termWidth - 2);
    const vr = findVisualRows[visualIdx];
    let slice = "";
    if (vr) {
      slice = (findComposer.state().buffer[vr.bufferIdx] ?? "").slice(
        vr.startCol,
        vr.endCol,
      );
    }
    const padWidth = Math.max(0, inner - 1 - slice.length);
    const pad = " ".repeat(padWidth);
    if (focused) {
      term.brightBlue.noFormat("│");
      term.noFormat(` ${slice}${pad}`);
      term.brightBlue.noFormat("│");
    } else {
      term.dim.noFormat("│");
      term.noFormat(` ${slice}${pad}`);
      term.dim.noFormat("│");
    }
    term.styleReset();
  };

  const paintFindBoxBottomBorder = (focused: boolean): void => {
    termWidth = readTermWidth(term);
    const inner = Math.max(2, termWidth - 2);
    const dashes = "─".repeat(inner);
    if (focused) {
      term.brightBlue.noFormat(`╰${dashes}╯`);
    } else {
      term.dim.noFormat(`╰${dashes}╯`);
    }
    term.styleReset();
  };

  // Column where the real terminal cursor sits inside the box body.
  // Col 1 = left border │, col 2 = space pad, col 3+ = content.
  const findBoxCursorCol = (): number => 3 + findBoxCursorVisualCol;

  // Screen row of the cursor line inside the box body.
  // Row 1 = top border, row 2 = first body row.
  const findBoxCursorScreenRow = (): number =>
    2 + (findBoxCursorVisualRow - findBoxWindowStart);

  // Repaint box chrome (top/body rows/bottom) in place, and reposition
  // the cursor. Used when focus toggles between box and list without
  // changing the results content.
  const repaintFindBoxChrome = (): void => {
    const focused = findSubMode === "input";
    withSync(() => {
      if (focused) {
        term.hideCursor();
      }
      term.moveTo(1, 1);
      paintFindBoxTopBorder(focused);
      for (let v = 0; v < findBoxRows; v++) {
        term.moveTo(1, 2 + v);
        paintFindBoxBodyRow(findBoxWindowStart + v, focused);
      }
      term.moveTo(1, 2 + findBoxRows);
      paintFindBoxBottomBorder(focused);
      if (focused) {
        term.moveTo(findBoxCursorCol(), findBoxCursorScreenRow());
        term.hideCursor(false);
      }
    });
  };

  // Targeted repaint of body rows only (selection/cursor change, no height change).
  const repaintFindBoxBodyRows = (): void => {
    withSync(() => {
      term.hideCursor();
      for (let v = 0; v < findBoxRows; v++) {
        term.moveTo(1, 2 + v);
        paintFindBoxBodyRow(findBoxWindowStart + v, true);
      }
      term.moveTo(findBoxCursorCol(), findBoxCursorScreenRow());
      term.hideCursor(false);
    });
  };

  const SNIPPET_KIND_GLYPH: Record<string, string> = {
    user: "user",
    agent: "agent",
    thought: "thought",
    tool: "tool",
    "tool-input": "tool-input",
  };

  // Shared data for painting one result row. Extracted so paintFindResultA
  // and paintFindResultB stay in sync without duplicating field reads.
  const findResultData = (
    idx: number,
    focused: boolean,
  ): {
    rowBudget: number;
    line1: string;
    line2: string;
    focusedRow: boolean;
  } => {
    const hit = findResults[idx];
    if (!hit) {
      return { rowBudget: 20, line1: "", line2: "", focusedRow: false };
    }
    const w = readTermWidth(term);
    const rowBudget = Math.max(20, w - ROW_PREFIX_WIDTH);
    const shortId = stripHydraSessionPrefix(hit.sessionId);
    const title = hit.title ?? shortenHomePath(hit.cwd);
    const counterText =
      focused && hit.snippets.length > 1
        ? `  [${findSnippetIdx + 1}/${hit.snippets.length}]`
        : focused && hit.totalMatches > hit.snippets.length
          ? `  [${hit.snippets.length} of ${hit.totalMatches}]`
          : "";
    const head = `${shortId}  ${hit.status === "live" ? "live" : "cold"}`;
    const titleBudget = Math.max(5, rowBudget - head.length - counterText.length - 2);
    const titleSlice = truncateMiddle(title, titleBudget);
    const line1 = `${head}  ${titleSlice}${counterText}`.padEnd(rowBudget);
    const snippet = hit.snippets[focused ? findSnippetIdx : 0];
    const kind = snippet ? (SNIPPET_KIND_GLYPH[snippet.kind] ?? snippet.kind) : "";
    const prefix = snippet?.toolName ? `${kind} · ${snippet.toolName}` : kind;
    const snippetBudget = Math.max(10, rowBudget - prefix.length - 6);
    const text = snippet ? truncateMiddle(snippet.text, snippetBudget) : "";
    const line2 = snippet ? `    ${prefix}  ${text}` : "    (no snippet)";
    return { rowBudget, line1, line2: line2.padEnd(rowBudget + ROW_PREFIX_WIDTH), focusedRow: focused };
  };

  // Paint just the title/id row for one result (no newline). Full-width
  // padEnd means no eraseLineAfter is needed — stale chars from a wider
  // previous frame can't survive.
  const paintFindResultA = (idx: number, focused: boolean): void => {
    const { line1, focusedRow } = findResultData(idx, focused);
    if (focusedRow) {
      term.brightWhite.bgBlue.noFormat(`❯ ${line1}`);
    } else {
      term.noFormat(`  ${line1}`);
    }
    term.styleReset();
  };

  // Paint just the snippet row for one result (no newline).
  const paintFindResultB = (idx: number, focused: boolean): void => {
    const { line2 } = findResultData(idx, focused);
    term.dim.noFormat(line2);
    term.styleReset();
  };

  const paintFindIndicator = (): void => {
    if (findInFlight) {
      term.dim.noFormat("  searching…");
      term.styleReset();
      term.eraseLineAfter();
    } else if (findError !== null) {
      term.brightRed.noFormat(`  ${findError}`);
      term.styleReset();
      term.eraseLineAfter();
    } else if (findSubMode === "input") {
      if (findResults.length > 0) {
        term.dim.noFormat("  Enter to search · ↓ browse results · Esc cancel");
      } else {
        term.dim.noFormat("  Enter to search · Esc cancel");
      }
      term.styleReset();
      term.eraseLineAfter();
    } else {
      const sCount = findResults.length;
      const truncSuffix = findTruncated ? "  ·  truncated" : "";
      const countPart =
        sCount > 0
          ? `  ${sCount} ${sCount === 1 ? "session" : "sessions"} match${truncSuffix}  ·  `
          : "  ";
      term.dim.noFormat(
        `${countPart}↑ edit query · Up/Down sessions · n/p snippets · Enter open · Esc back`,
      );
      term.styleReset();
      term.eraseLineAfter();
    }
  };

  // Full repaint of the find-session screen. Clears once, then lays out
  // the box (rows 1..findBoxRows+2), blank, and results + indicator below.
  // Called only on mode entry/exit, search completion, and resize.
  const renderFind = (): void => {
    computeFindBoxLayout();
    const focused = findSubMode === "input";
    const queryText = findComposer.state().buffer.join("\n");
    withSync(() => {
      term.hideCursor();
      term.moveTo(1, 1).eraseDisplayBelow();
      // Box — always visible regardless of mode.
      paintFindBoxTopBorder(focused);
      for (let v = 0; v < findBoxRows; v++) {
        term.moveTo(1, 2 + v);
        paintFindBoxBodyRow(findBoxWindowStart + v, focused);
      }
      term.moveTo(1, 2 + findBoxRows);
      paintFindBoxBottomBorder(focused);
      // Blank separator row is already blank from eraseDisplayBelow.
      // Results area — show hints when nothing has been searched yet.
      const sCount = findResults.length;
      if (sCount === 0) {
        term.moveTo(1, findResultsStartRow());
        if (findInFlight) {
          // indicator handles the in-flight text; nothing extra here
        } else if (findError === null && queryText.trim().length === 0) {
          term.dim.noFormat("  type a query in the box above, then press Enter");
          term.eraseLineAfter();
        } else if (findError === null) {
          term.dim.noFormat("  no matches");
          term.eraseLineAfter();
        }
        term.moveTo(1, findResultsStartRow() + 1);
        paintFindIndicator();
      } else {
        adjustFindScroll();
        const v = findViewportSize();
        const listFocused = findSubMode !== "input";
        for (let i = 0; i < v; i++) {
          const idx = findScrollOffset + i;
          term.moveTo(1, findResultsStartRow() + i * 2);
          if (idx < sCount) {
            paintFindResultA(idx, listFocused && idx === findSelectedIdx);
          } else {
            term.eraseLineAfter();
          }
          term.moveTo(1, findResultsStartRow() + i * 2 + 1);
          if (idx < sCount) {
            paintFindResultB(idx, listFocused && idx === findSelectedIdx);
          } else {
            term.eraseLineAfter();
          }
        }
        term.moveTo(1, findResultsStartRow() + v * 2);
        paintFindIndicator();
      }
      // Place real cursor in box body when focused; hide it otherwise.
      if (focused) {
        term.moveTo(findBoxCursorCol(), findBoxCursorScreenRow());
        term.hideCursor(false);
      }
    });
  };

  // Targeted repaint helpers — used for incremental updates within
  // the same deep mode so the full eraseDisplayBelow is avoided.

  // Repaint both rows of one result in place (no layout shift).
  const repaintFindResult = (idx: number, focused: boolean): void => {
    const viewportIdx = idx - findScrollOffset;
    if (viewportIdx < 0 || viewportIdx >= findViewportSize()) {
      return;
    }
    withSync(() => {
      term.moveTo(1, findResultsStartRow() + viewportIdx * 2);
      paintFindResultA(idx, focused);
      term.moveTo(1, findResultsStartRow() + viewportIdx * 2 + 1);
      paintFindResultB(idx, focused);
    });
  };

  // Repaint the indicator row in place.
  const repaintFindIndicatorRow = (): void => {
    withSync(() => {
      term.moveTo(1, findResultsStartRow() + findViewportSize() * 2);
      paintFindIndicator();
    });
  };

  // Repaint the entire results viewport + indicator (scroll changed).
  const repaintFindViewport = (): void => {
    withSync(() => {
      const v = findViewportSize();
      const sCount = findResults.length;
      const listFocused = findSubMode !== "input";
      for (let i = 0; i < v; i++) {
        const idx = findScrollOffset + i;
        term.moveTo(1, findResultsStartRow() + i * 2);
        if (idx < sCount) {
          paintFindResultA(idx, listFocused && idx === findSelectedIdx);
        } else {
          term.eraseLineAfter();
        }
        term.moveTo(1, findResultsStartRow() + i * 2 + 1);
        if (idx < sCount) {
          paintFindResultB(idx, listFocused && idx === findSelectedIdx);
        } else {
          term.eraseLineAfter();
        }
      }
      term.moveTo(1, findResultsStartRow() + v * 2);
      paintFindIndicator();
    });
  };

  const findQueryText = (): string => findComposer.state().buffer.join("\n");

  // Kick off the search HTTP call from the input phase. Scopes to the
  // picker's currently `visible` ids so cwd-only/host/`/` filters
  // compose with the find scope. While the call is in flight, mode stays
  // "find-input" but findInFlight blocks input and the indicator says
  // "searching…"; on success we transition to deep-results.
  const runFind = async (): Promise<void> => {
    const query = findQueryText().trim();
    if (query.length === 0) {
      return;
    }
    if (visible.length === 0) {
      findError = "no sessions in view to search";
      renderFind();
      return;
    }
    findInFlight = true;
    findError = null;
    renderFind();
    try {
      const out = await searchSessions(opts.target, query, {
        sessionIds: visible.map((s) => s.sessionId),
      });
      findResults = out.results;
      findTruncated = out.truncated;
      findSelectedIdx = 0;
      findSnippetIdx = 0;
      findScrollOffset = 0;
      // Move focus to the list so the user can navigate immediately.
      // If there are no matches, stay in deep-input so they can refine.
      findSubMode = out.results.length > 0 ? "results" : "input";
      computeFindBoxLayout();
    } catch (err) {
      findError = `search failed: ${(err as Error).message}`;
    } finally {
      findInFlight = false;
      renderFind();
    }
  };

  // exitFind is forward-declared here and assigned inside the Promise
  // once popLayer is available. All call sites (findOnKey) are also inside
  // the Promise so the assignment always precedes the first call.
  let exitFind: () => void = () => { /* assigned below */ };

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

  // Repaint just the data zone (header + session rows + indicator) in-place
  // without clearing the screen. Safe when the session count hasn't changed
  // (layout row positions are stable). Avoids the eraseDisplayBelow flash
  // that renderFromScratch produces.
  const repaintDataZone = (): void => {
    withSync(() => {
      term.moveTo(1, headerRow());
      term.dim.noFormat(`  ${headerLine}`);
      for (let v = 0; v < viewportSize; v++) {
        const row = headerRow() + 1 + v;
        const sessionIdx = scrollOffset + v;
        if (sessionIdx < visible.length) {
          term.moveTo(1, row);
          paintSessionRow(sessionIdx);
        } else {
          term.moveTo(1, row).eraseLineAfter();
        }
      }
      paintIndicator();
      if (selectedIdx === 0) {
        placeComposerCursor();
        term.hideCursor(false);
      }
    });
  };

  // Bracketed-paste interceptor for the composer (same pattern as
  // screen.ts installBracketedPaste). After term.grabInput() we swap out
  // terminal-kit's own stdin listener with rawStdinHandler, which strips
  // \x1b[200~…\x1b[201~ paste markers and feeds the accumulated text to
  // the composer as a {type:"paste"} event. Non-paste bytes are forwarded
  // to terminal-kit unchanged. This prevents pasted newlines (\r or \n)
  // arriving as bare ENTER keys that submit the prompt.
  let pasteActive = false;
  let pasteBuffer = "";
  let tkStdinHandler: ((chunk: Buffer) => void) | null = null;
  const PASTE_START = "\x1b[200~";
  const PASTE_END = "\x1b[201~";
  const rawStdinHandler = (chunk: Buffer): void => {
    let text = chunk.toString("binary");
    if (pasteActive) {
      const endIdx = text.indexOf(PASTE_END);
      if (endIdx === -1) {
        pasteBuffer += text;
        return;
      }
      pasteBuffer += text.slice(0, endIdx);
      pasteActive = false;
      const pasted = Buffer.from(pasteBuffer, "binary")
        .toString("utf-8")
        .replace(/\r\n?/g, "\n");
      pasteBuffer = "";
      const remaining = text.slice(endIdx + PASTE_END.length);
      if (selectedIdx === 0 && !searchActive) {
        composer.feed({ type: "paste", text: pasted });
        const after = composer.state();
        const newVr = computePromptVisualRows(after.buffer, composerRoom);
        const newLayout = computePromptLayout(
          newVr,
          after,
          PICKER_COMPOSER_MAX_ROWS,
        );
        if (newLayout.rendered !== composerRows) {
          renderFromScratch();
        } else {
          repaintComposerBody();
        }
      }
      if (remaining.length > 0 && tkStdinHandler) {
        tkStdinHandler(Buffer.from(remaining, "binary"));
      }
      return;
    }
    const startIdx = text.indexOf(PASTE_START);
    if (startIdx === -1) {
      tkStdinHandler?.(chunk);
      return;
    }
    if (startIdx > 0) {
      tkStdinHandler?.(Buffer.from(text.slice(0, startIdx), "binary"));
    }
    text = text.slice(startIdx + PASTE_START.length);
    pasteActive = true;
    if (text.length > 0) {
      rawStdinHandler(Buffer.from(text, "binary"));
    }
  };

  renderFromScratch();

  return await new Promise<PickerResult>((resolve) => {
    let resolved = false;
    let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
    let autoRefreshInFlight = false;

    // ── Focus stack ────────────────────────────────────────────────────
    // Each interactive layer (picker, find, modals) is a FocusLayer.
    // All terminal key/resize events route through the top of the stack.
    // pop() restores the layer below and calls its onResize so the screen
    // reflects whatever was behind the layer that just closed.
    const focusStack: FocusLayer[] = [];
    const pushLayer = (layer: FocusLayer): void => {
      focusStack.push(layer);
    };
    const popLayer = (): void => {
      focusStack.pop();
      if (!resolved) {
        focusStack[focusStack.length - 1]?.onResize();
      }
    };
    const focus = { push: pushLayer, pop: popLayer };
    exitFind = (): void => {
      findComposer = new InputDispatcher({
        history: [],
        collapsePastes: false,
      });
      findResults = [];
      findTruncated = false;
      findSelectedIdx = 0;
      findSnippetIdx = 0;
      findScrollOffset = 0;
      findError = null;
      findInFlight = false;
      findSubMode = "input";
      popLayer(); // restores picker layer → renderFromScratch
    };
    const dispatch = (
      name: string,
      _matches: unknown,
      data?: { isCharacter?: boolean },
    ): void => {
      focusStack[focusStack.length - 1]?.onKey(name, _matches, data);
    };
    const dispatchResize = (): void => {
      if (resolved) return;
      focusStack[focusStack.length - 1]?.onResize();
    };

    const cleanup = (): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      focusStack.length = 0;
      if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
      }
      term.off("key", dispatch);
      term.off("resize", dispatchResize);
      // Restore terminal-kit's stdin listener and disable bracketed paste.
      process.stdout.write("\x1b[?2004l");
      const tClean = term as unknown as { stdin: NodeJS.ReadableStream };
      if (tClean.stdin && tkStdinHandler) {
        tClean.stdin.removeListener("data", rawStdinHandler);
        tClean.stdin.on("data", tkStdinHandler);
        tkStdinHandler = null;
      }
      pasteActive = false;
      pasteBuffer = "";
      term.grabInput(false);
      term.hideCursor(false);
      term.moveTo(1, indicatorRow() + 1);
      term("\n");
    };
    // Abort returns the user to the session they opened the picker from.
    // If that session was killed/deleted in this picker session there's
    // nothing live to return to, so we refuse the abort and keep the
    // picker up. Returns true if the abort was handled (i.e. resolved).
    const tryAbort = (): boolean => {
      if (currentSessionGone) {
        transientStatus =
          "current session ended — pick a session or start a new one";
        paintIndicator();
        return false;
      }
      cleanup();
      resolve({ kind: "abort" });
      return true;
    };
    // Refetch sessions from the daemon and re-render. When `preferredId`
    // is provided we try to land the cursor on that session id (used
    // after kill so the cursor follows the row as it sorts to the cold
    // tier); otherwise selectedIdx stays put (clamped to the new size),
    // which after delete lands on whatever now occupies the old slot.
    // Fingerprint of what would actually be painted. Used by auto-refresh
    // to skip repaints when the visible frame would be byte-identical to
    // the current one. We fingerprint the rendered `rows` (post-toRow)
    // plus selection/scroll/transient state rather than raw session data:
    // the raw `updatedAt` is the history file mtime, which bumps on
    // every chunk for a streaming session, while the rendered `age` is
    // coarse ("3m") and only changes at bucket boundaries. Using the
    // rendered form means a busy session that's actively producing
    // output but otherwise unchanged doesn't re-trigger a repaint.
    const renderFingerprint = (): string => {
      const cells = rows
        .map(
          (r) =>
            `${r.session}|${r.upstream}|${r.state}|${r.agent}|${r.age}|${r.title}|${r.cwd}`,
        )
        .join("\n");
      return `${selectedIdx}:${scrollOffset}:${transientStatus ?? ""}\n${cells}`;
    };
    const refresh = async (
      preferredId?: string,
      refreshOpts: { silent?: boolean } = {},
    ): Promise<void> => {
      try {
        const beforeKey = refreshOpts.silent ? renderFingerprint() : "";
        const beforeTotal = total;
        const next = await listSessions(opts.target, {
          includeNonInteractive: true,
        });
        // Snapshot the session the cursor is on right now — after the
        // HTTP wait, not before — so callers that don't pin a specific
        // id (auto-refresh, `r`) still follow the user's CURRENT
        // selection through a resort. If they pressed UP/DOWN during
        // the await, this captures where they are now, not where they
        // were three seconds ago.
        const followId =
          preferredId ??
          (selectedIdx > 0 ? visible[selectedIdx - 1]?.sessionId : undefined);
        allSessions = sortSessions(next, opts.cwd);
        applyFilter();
        if (followId !== undefined) {
          const idx = visible.findIndex((s) => s.sessionId === followId);
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
        if (refreshOpts.silent && renderFingerprint() === beforeKey) {
          return;
        }
        if (total === beforeTotal) {
          // Session count unchanged — repaint in-place so the composer
          // and screen structure are never cleared.
          repaintDataZone();
        } else {
          renderFromScratch();
        }
      } catch (err) {
        if (refreshOpts.silent) {
          return;
        }
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
        if (session.sessionId === opts.currentSessionId) {
          currentSessionGone = true;
        }
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
    const openHelpLayer = (): void => {
      renderHelp();
      pushLayer({
        onKey: (name) => {
          if (name === "CTRL_C") {
            cleanup();
            resolve({ kind: "abort" });
            return;
          }
          popLayer(); // restores picker layer → calls renderFromScratch
        },
        onResize: () => renderHelp(),
      });
    };
    const openFindLayer = (): void => {
      if (visible.length === 0) {
        transientStatus = "no sessions to search";
        paintIndicator();
        return;
      }
      findComposer = new InputDispatcher({ history: [] });
      findResults = [];
      findTruncated = false;
      findSelectedIdx = 0;
      findSnippetIdx = 0;
      findScrollOffset = 0;
      findError = null;
      findInFlight = false;
      findSubMode = "input";
      computeFindBoxLayout();
      renderFind();

      const findOnKey = (
        name: string,
        _matches: unknown,
        data?: { isCharacter?: boolean },
      ): void => {
        // Find: input (box focused).
        if (findSubMode === "input") {
          if (findInFlight) {
            return;
          }
          if (name === "ESCAPE" || name === "CTRL_C") {
            exitFind();
            return;
          }
          if (name === "ENTER" || name === "KP_ENTER") {
            if (findQueryText().trim().length === 0) {
              return;
            }
            void runFind();
            return;
          }
          if (
            (name === "DOWN" || name === "TAB" || name === "CTRL_N") &&
            findResults.length > 0
          ) {
            findSubMode = "results";
            findSelectedIdx = 0;
            findSnippetIdx = 0;
            withSync(() => {
              repaintFindBoxChrome();
              repaintFindResult(0, true);
              repaintFindIndicatorRow();
              term.hideCursor();
            });
            return;
          }
          const before = findComposer.state();
          let event: KeyEvent | null = null;
          if (data?.isCharacter) {
            event = { type: "char", ch: name };
          } else {
            const mapped = mapKeyName(name);
            if (mapped !== null)
              event = { type: "key", name: mapped };
          }
          if (event === null) {
            term.moveTo(findBoxCursorCol(), findBoxCursorScreenRow());
            return;
          }
          findComposer.feed(event);
          const after = findComposer.state();
          const unchanged =
            before.buffer.length === after.buffer.length &&
            before.buffer.every((l, i) => l === after.buffer[i]) &&
            before.row === after.row &&
            before.col === after.col;
          if (unchanged) {
            term.moveTo(findBoxCursorCol(), findBoxCursorScreenRow());
            return;
          }
          const prevRows = findBoxRows;
          computeFindBoxLayout();
          if (findBoxRows !== prevRows) {
            renderFind();
          } else {
            repaintFindBoxBodyRows();
          }
          return;
        }
        // Find: results (list focused).
        if (findSubMode === "results") {
          if (name === "ESCAPE" || name === "CTRL_C") {
            exitFind();
            return;
          }
          if (name === "CTRL_F") {
            findSubMode = "input";
            repaintFindViewport();
            repaintFindIndicatorRow();
            repaintFindBoxChrome();
            return;
          }
          if (name === "ENTER" || name === "KP_ENTER") {
            const hit = findResults[findSelectedIdx];
            if (!hit) {
              return;
            }
            const session = visible.find((s) => s.sessionId === hit.sessionId);
            const isImportedPassive =
              !!session?.importedFromMachine && !session.upstreamSessionId;
            if (isImportedPassive) {
              cleanup();
              const result: PickerResult = {
                kind: "attach",
                sessionId: hit.sessionId,
              };
              if (session.agentId !== undefined) {
                result.agentId = session.agentId;
              }
              resolve(result);
              return;
            }
            void (async () => {
              const action: LaunchOrViewResult = await promptForLaunchOrView(term, {
                sessionId: hit.sessionId,
                title: hit.title,
                cwd: hit.cwd,
              }, focus);
              if (action === "cancel") {
                cleanup();
                resolve({ kind: "abort" });
                return;
              }
              // No re-attach needed — focus.pop() inside promptForLaunchOrView restores the find layer
              if (action === "back") return;
              cleanup();
              const result: PickerResult = {
                kind: "attach",
                sessionId: hit.sessionId,
                readonly: action === "view",
              };
              if (session?.agentId !== undefined) {
                result.agentId = session.agentId;
              }
              resolve(result);
            })();
            return;
          }
          if (data?.isCharacter && (name === "n" || name === "N")) {
            const hit = findResults[findSelectedIdx];
            if (!hit || hit.snippets.length <= 1) {
              return;
            }
            findSnippetIdx = (findSnippetIdx + 1) % hit.snippets.length;
            repaintFindResult(findSelectedIdx, true);
            return;
          }
          if (data?.isCharacter && (name === "p" || name === "P")) {
            const hit = findResults[findSelectedIdx];
            if (!hit || hit.snippets.length <= 1) {
              return;
            }
            findSnippetIdx =
              (findSnippetIdx - 1 + hit.snippets.length) % hit.snippets.length;
            repaintFindResult(findSelectedIdx, true);
            return;
          }
          const moveDeep = (delta: number): void => {
            if (delta < 0 && findSelectedIdx === 0) {
              findSubMode = "input";
              withSync(() => {
                repaintFindResult(0, false);
                repaintFindIndicatorRow();
                repaintFindBoxChrome();
              });
              return;
            }
            const next = Math.min(
              findResults.length - 1,
              Math.max(0, findSelectedIdx + delta),
            );
            if (next === findSelectedIdx) {
              return;
            }
            const oldIdx = findSelectedIdx;
            const oldScroll = findScrollOffset;
            findSelectedIdx = next;
            findSnippetIdx = 0;
            adjustFindScroll();
            if (findScrollOffset !== oldScroll) {
              repaintFindViewport();
            } else {
              withSync(() => {
                repaintFindResult(oldIdx, false);
                repaintFindResult(findSelectedIdx, true);
              });
              repaintFindIndicatorRow();
            }
          };
          switch (name) {
            case "UP":
            case "SHIFT_TAB":
            case "CTRL_P":
              moveDeep(-1);
              return;
            case "DOWN":
            case "TAB":
            case "CTRL_N":
              moveDeep(1);
              return;
            case "PAGE_UP":
              moveDeep(-findViewportSize());
              return;
            case "PAGE_DOWN":
              moveDeep(findViewportSize());
              return;
            case "HOME":
              moveDeep(-findSelectedIdx);
              return;
            case "END":
              moveDeep(findResults.length);
              return;
          }
          return;
        }
      };

      pushLayer({ onKey: findOnKey, onResize: () => renderFind() });
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
      if (name === "CTRL_F") {
        openFindLayer();
        return;
      }
      // Composer focused: route keys through the InputDispatcher so every
      // readline shortcut works identically to the live composer. The
      // composer eats hotkeys like `/`, `r`, `?`, `k`, etc. — they only
      // fire when the user has moved focus down into the session list.
      if (selectedIdx === 0 && !searchActive) {
        // ESCAPE has no dispatcher-side meaning in the picker composer
        // (no in-flight turn to cancel), so it stays a top-level abort.
        // ^c / ^d are intentionally NOT intercepted here — they go
        // through the dispatcher below so they edit the buffer first
        // (^c peels: clear buffer / attachments; ^d deletes forward)
        // and only detach the picker when the dispatcher emits its
        // `exit` effect (i.e. there's nothing left to peel).
        if (name === "ESCAPE") {
          tryAbort();
          return;
        }
        if (name === "ENTER" || name === "KP_ENTER") {
          cleanup();
          const text = composer.expandedText();
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
        // is a no-op (composer stays focused). While the dispatcher is
        // walking prompt history or the queue, always fall through so
        // ↓ steps newer through history first — only after walkDown
        // restores the live draft (historyIndex === -1) does another
        // ↓ at the bottom row escape to the list.
        if (name === "DOWN") {
          const cs = composer.state();
          const inWalk = cs.historyIndex !== -1 || cs.queueIndex !== -1;
          const atBottom =
            composerVisualRows.length === 0 ||
            composerCursorRow === composerVisualRows.length - 1;
          if (!inWalk && atBottom && visible.length > 0) {
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
        const effects = composer.feed(event);
        const after = composer.state();
        const unchanged =
          before.buffer.length === after.buffer.length &&
          before.buffer.every((line, i) => line === after.buffer[i]) &&
          before.row === after.row &&
          before.col === after.col;
        // Dispatcher told us to exit — ^c with no text left to clear,
        // ^d on an empty buffer, or ^d at end-of-buffer with nothing
        // forward to delete (all handled inside the dispatcher).
        if (effects.some((e) => e.type === "exit")) {
          tryAbort();
          return;
        }
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
        openHelpLayer();
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
          tryAbort();
          return;
        }
        if (name === "o" || name === "O") {
          const keepId =
            selectedIdx > 0 ? visible[selectedIdx - 1]?.sessionId : undefined;
          prefs.filters.cwdOnly = !prefs.filters.cwdOnly;
          applyFilter();
          restoreCursorAfterFilter(keepId);
          renderFromScratch();
          return;
        }
        if (name === "h" || name === "H") {
          const keepId =
            selectedIdx > 0 ? visible[selectedIdx - 1]?.sessionId : undefined;
          prefs.filters.hostFilter = nextHostFilter(
            prefs.filters.hostFilter,
            allSessions,
          );
          applyFilter();
          restoreCursorAfterFilter(keepId);
          renderFromScratch();
          return;
        }
        if (name === "i" || name === "I") {
          const keepId =
            selectedIdx > 0 ? visible[selectedIdx - 1]?.sessionId : undefined;
          prefs.filters.includeNonInteractive =
            !prefs.filters.includeNonInteractive;
          applyFilter();
          restoreCursorAfterFilter(keepId);
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
        if ((name === "f" || name === "F") && selectedIdx > 0) {
          const session = visible[selectedIdx - 1];
          if (!session) {
            return;
          }
          cleanup();
          const result: PickerResult = {
            kind: "fork",
            sourceSessionId: session.sessionId,
            sourceCwd: session.cwd,
          };
          if (session.agentId !== undefined) {
            result.sourceAgentId = session.agentId;
          }
          if (session.importedFromMachine !== undefined) {
            result.sourceImportedFromMachine = session.importedFromMachine;
          }
          if (session.upstreamSessionId !== undefined) {
            result.sourceUpstreamSessionId = session.upstreamSessionId;
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
          tryAbort();
          return;
      }
    };
    pushLayer({
      onKey: (name, _matches, data) => onKey(name, _matches, data),
      onResize: () => { if (!resolved) renderFromScratch(); },
    });
    term.grabInput({});
    // Swap terminal-kit's stdin listener for our bracketed-paste interceptor.
    const tSetup = term as unknown as {
      stdin: NodeJS.ReadableStream;
      onStdin: (chunk: Buffer) => void;
    };
    if (tSetup.stdin && typeof tSetup.onStdin === "function") {
      tkStdinHandler = tSetup.onStdin;
      tSetup.stdin.removeListener("data", tSetup.onStdin);
      tSetup.stdin.on("data", rawStdinHandler);
      process.stdout.write("\x1b[?2004h");
    }
    term.on("key", dispatch);
    term.on("resize", dispatchResize);
    // Low-frequency refresh so busy indicators, new titles, and
    // appearing/disappearing sessions track without the user mashing `r`.
    // Skip while a prompt or search is up so we don't trample a partially
    // typed buffer, and skip while a prior refresh is still pending so
    // a slow daemon can't pile up overlapping repaints. `silent: true`
    // makes refresh a no-op when the visible state is unchanged, which
    // is the common case — keeps the picker quiet between actual events.
    autoRefreshTimer = setInterval(() => {
      if (resolved || focusStack.length > 1 || mode !== "normal" || searchActive || autoRefreshInFlight) {
        return;
      }
      const currentId =
        selectedIdx > 0 ? visible[selectedIdx - 1]?.sessionId : undefined;
      autoRefreshInFlight = true;
      void refresh(currentId, { silent: true }).finally(() => {
        autoRefreshInFlight = false;
      });
    }, 3000);
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

// Order sessions for the picker. Tiers (highest first):
//   6: live + awaiting input + cwd matches the picker's cwd
//   5: live + awaiting input
//   4: live + busy + cwd matches the picker's cwd
//   3: live + busy
//   2: live + cwd matches
//   1: live
//   0: cold
// Sessions blocked on the user float above merely-busy ones — they're
// the ones that actually need your attention. Within a tier, newer
// updatedAt wins — but compared at minute precision so a streaming
// session's per-chunk mtime churn doesn't keep flipping the sort order
// between auto-refreshes.
export function sortSessions(
  sessions: DiscoveredSession[],
  cwd: string,
): DiscoveredSession[] {
  const score = (s: DiscoveredSession): number => {
    if (s.status !== "live") {
      return 0;
    }
    const base = s.cwd === cwd ? 2 : 1;
    if (s.awaitingInput) {
      return base + 4;
    }
    return s.busy ? base + 2 : base;
  };
  return [...sessions].sort((a, b) => {
    const tier = score(b) - score(a);
    if (tier !== 0) {
      return tier;
    }
    return b.updatedAt.slice(0, 16).localeCompare(a.updatedAt.slice(0, 16));
  });
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
