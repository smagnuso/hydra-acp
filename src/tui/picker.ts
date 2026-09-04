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
  DEFAULT_COLUMNS,
  type Row,
  type Widths,
  type FormatOptions,
} from "../cli/session-row.js";
import { localMachines } from "../core/machine.js";
import { lookupInheritedAgentValue } from "../core/registry.js";
import { paths, shortenHomePath } from "../core/paths.js";
import { stripHydraSessionPrefix } from "../core/session.js";
import { setDefaultAgent, type HydraConfig } from "../core/config.js";
import type { RemoteTarget } from "../core/remote-target.js";
import { terminalHost } from "./term-host/index.js";
import { canOpenTab, canReveal, openInNewTab, revealOrOpen } from "./term-host/open.js";
import {
  deleteSession,
  fetchWithTimeout,
  killSession,
  listSessionsPage,
  mergeSessionListPage,
  regenSessionTitle,
  renameSession,
  searchSessions,
  setSessionPriority,
  syncInstalledAgents,
  type DiscoveredAgent,
  type DiscoveredSession,
  type SessionHits,
} from "./discovery.js";
import { promptForAgent } from "./agent-prompt.js";
import { loadHistory } from "./history.js";
import { readClipboard } from "./clipboard.js";
import {
  InputDispatcher,
  type Attachment,
  type KeyEvent,
} from "./input.js";
import { editTextInEditor } from "./edit-in-editor.js";
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
import { promptForImportCwd } from "./import-cwd-prompt.js";
import { LineEditor } from "./line-editor.js";
import { completePathToken, extractPathToken } from "./file-completion.js";
import { drawBox, readTermHeight, readTermWidth } from "./prompt-utils.js";
import { ChordMatcher, RAW_KEY_CHORD_TABLE } from "./chord.js";
import { runUserHotkey } from "./user-hotkey.js";
import { RowPainter } from "./screen/painter.js";
import { withSync } from "./sync.js";
import {
  AUTOWRAP_ON,
  BRACKETED_PASTE_OFF,
  BRACKETED_PASTE_ON,
  DECCKM_OFF,
  DECPAM_OFF,
  FOCUS_IN,
  FOCUS_OUT,
  FOCUS_TRACK_OFF,
  FOCUS_TRACK_ON,
  FORMAT_OTHER_KEYS_OFF,
  KITTY_KBD_POP,
  MODIFY_OTHER_KEYS_OFF,
  MOUSE_BUTTON_OFF,
  MOUSE_SGR_OFF,
  MOUSE_X10_OFF,
  PASTE_END,
  PASTE_START,
  SHOW_CURSOR,
  writeControl,
} from "./ansi.js";
import { paint, type ChromeToken, SGR_RESET } from "./theme/index.js";
import { decodeBundle } from "../core/bundle.js";
import {
  aggregate as aggregateSessionInfo,
  formatSummary as formatSessionInfoSummary,
} from "../cli/commands/sessions-info.js";
import { writeDebugLine } from "./debug-log.js";
import {
  createInstallStatusLine,
  type InstallStatusLine,
  type InstallStatusSink,
} from "./install-status.js";

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
      // Same contract as the `new` variant: when set, picker deferred
      // its cleanup and left its frame painted. Caller MUST finalize
      // (directly or via runSession). Set on the main-picker attach
      // paths (Enter, `v`, mouse click) so "Resuming session…" and any
      // agent-install progress paint in the composer-adjacent status
      // row instead of scrolling out below the picker.
      installStatus?: InstallStatusLine;
      // Set from the find layer's selected snippet (Snippet.recordedAt) so
      // the fresh attach lands on the turn that matched instead of the
      // live tail — see TuiOptions.jumpToRecordedAt for the consuming end.
      // Undefined on every non-find attach path.
      jumpToRecordedAt?: number;
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
  | {
      kind: "new";
      prompt?: string;
      cwd?: string;
      // Image attachments the user pasted / read into the picker composer
      // before the session existed. Fired alongside `prompt` on the first
      // enqueuePrompt in the freshly-attached session.
      attachments?: Attachment[];
      // When set, the picker deferred its terminal cleanup and left its
      // rendered frame in place. The caller MUST finalize (directly or
      // via runSession). Writes to `.write()` / `.applyProgress()` paint
      // in the composer-adjacent status row.
      installStatus?: InstallStatusLine;
      // Present when the user clicked the composer's top-right agent
      // label and picked a different agent (or the seed was already
      // set). Undefined only when the caller supplied no seed AND the
      // user never opened the agent picker. Caller uses this in place
      // of opts.agentId when creating the session.
      agentId?: string;
      // Chosen model, tracked alongside agentId so the caller can seed
      // config.sessionDefaults or forward to session/new. Currently only
      // ever set indirectly: when the user switches agent via the
      // composer's agent picker, model updates to
      // config.sessionDefaults[newAgent]?.model (undefined if none).
      model?: string;
    }
  | { kind: "abort" }
  | { kind: "exit" };

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
  // Seed the composer with this text on open. Used when the agent
  // picker's Esc re-shows the session picker — the prompt the user
  // already typed for the new session is restored into the composer box.
  initialPrompt?: string;
  // Seed the composer's attachment list on open. Mirrors initialPrompt for
  // the case where the agent picker is re-entered and we want to preserve
  // any images the user pasted into the composer before diverting.
  initialAttachments?: Attachment[];
  // Persistent filter state. Seeded on first picker open from
  // createPickerPrefs(); pickSession mutates it in place so the next
  // invocation re-opens with the same `o`/`h` toggles the user left in
  // place. When omitted, picker uses defaults (cwdOnly off, hostFilter
  // "__local") and the legacy "auto-bump to __all when current row is
  // imported" rule still applies.
  prefs?: PickerPrefs;
  // Displayed in the top-right of the composer border as "agent•model".
  // Reflects what a fresh session created from the composer would use
  // (default agent + its configured default model). Both are optional:
  // if agentId is undefined, the label is omitted entirely; if only
  // model is undefined, we show just the agent id. Callers derive these
  // via composerAgentForCwd (tui/composer-agent.ts), which owns the
  // precedence rule; the cwd matters because a `.hydra-acp.json` in the
  // tree can set either key. See onCwdChange.
  //
  // The label is also click-actionable: clicking on it opens an agent
  // picker (see availableAgents). A change here overrides the seed and
  // is reported back on the "new" PickerResult (agentId / model) so the
  // caller can persist / launch with the user's choice.
  composerAgentId?: string;
  composerModel?: string;
  // Populates the agent picker that opens when the user clicks the
  // composer's top-right "agent•model" label. Callers fetch this via
  // `listAgents(target)` once before invoking pickSession and pass the
  // list through. When absent or empty, the click is a no-op — nothing
  // to switch to.
  availableAgents?: DiscoveredAgent[];
  // Called the moment the user commits a different agent in the
  // click-to-switch modal, with the agent and the model that now tracks
  // it. Fires independently of how the picker eventually resolves, so a
  // choice made just before attaching to an existing session (or Esc'ing
  // out) is still remembered by the caller's session-wide prefs. Without
  // this, the choice only reached the caller on the "new" result.
  onComposerAgentChange?: (agentId: string, model: string | undefined) => void;
  // Called after ^O moves the picker's cwd, to re-resolve the composer's
  // agent•model for the new directory. Not cosmetic: makeNewResult sends
  // both values on session/new alongside the new cwd, so without this a
  // ^O into a tree with its own `.hydra-acp.json` creates the session
  // with the previous directory's agent.
  //
  // Skipped once the user has picked an agent from the composer label in
  // this picker — an explicit choice outranks any directory default. The
  // caller resolves; `notice` is anything it saw but deliberately did not
  // act on, shown in the status line.
  onCwdChange?: (cwd: string) => Promise<{
    agentId?: string;
    model?: string;
    notice?: string;
  }>;
}

// Picker filter state. `filters` is its own nested bag so future
// non-filter prefs (sort order, view mode, etc.) can sit alongside it
// without churning the filter call sites.
export interface PickerFilters {
  cwdOnly: boolean;
  // "__local" | "__all" | "remote:<name>" | "host:<machine>". See
  // filterByHost/nextHostFilter for the cycle order and meaning.
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
  // Last ^F search, retained so that opening a hit and coming back
  // doesn't cost you the query and the scroll position. Selecting a hit
  // tears the whole picker down (cleanup + resolve), so this has to live
  // on the caller-owned prefs container rather than in pickSession's
  // closure. Never cleared implicitly; to forget a search, empty the
  // query box (^U) and Esc out.
  lastFind?: FindState;
}

export interface FindState {
  query: string;
  results: SessionHits[];
  truncated: boolean;
  selectedIdx: number;
  snippetIdx: number;
  scrollOffset: number;
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

// Each row is prefixed with "<p> " (2 columns wide): col 0 is the
// priority marker ("*" for priority>0, blank otherwise); col 1 is a
// fixed separating space. Selection is indicated by the row's
// background highlight, so no glyph is needed in the prefix. The
// label's content budget is therefore termWidth - 2.
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
type HelpEntry = readonly [string, string] | null;
const HELP_ENTRIES: ReadonlyArray<HelpEntry> = [
  ["Composer", "type prompt for new session; Enter creates + submits"],
  ["↓ from composer", "drop focus into session list"],
  ["typing in list", "jumps focus back to composer with that key"],
  ["mouse-hover composer", "Enter from anywhere creates a new session"],
  null,
  ["↑ / ↓, n / p, ^p / ^n", "navigate sessions"],
  ["PgUp / PgDn", "page up / page down"],
  ["Home / End", "first / last"],
  ["Enter", "open selected session"],
  ["v", "view-only (open transcript without spawning the agent)"],
  null,
  ["/", "search sessions (metadata)"],
  ["^f", "find in session history (content + tool inputs)"],
  ["  in results", "n/p cycle snippets · i info · Enter open"],
  ["  ", "the query and results survive opening a hit"],
  ["o", "toggle cwd-only filter"],
  ["h", "cycle host filter (local / <peer> / all)"],
  ["^o", "change cwd (for the picker and any new sessions)"],
  ["i", "show info for the selected session"],
  ["I", "toggle include-cat filter"],
  ["r", "refresh from daemon"],
  ["s", "sync sessions from installed agents"],
  null,
  ["k", "kill the selected warm session"],
  ["d", "delete the selected session (kills first if live)"],
  ["t", "retitle the selected session"],
  ["T", "regenerate title + synopsis via agent"],
  ["*", "toggle high priority on the selected session (floats to top)"],
  null,
  ["?", "toggle this help"],
  ["q / Esc / ^C / ^D", "quit picker (detach)"],
];

// Resolved per render rather than baked into HELP_ENTRIES, because the
// host-only row depends on the environment. Computing it at module load
// would freeze the answer at import time and make the module's top level
// depend on env — which also made it impossible to mock in tests.
/**
 * The active host's name, for status lines. Falls back to a neutral word so
 * the message still reads if the host went away mid-flight.
 */
function hostName(): string {
  return terminalHost()?.id ?? "terminal";
}

function helpEntries(): ReadonlyArray<HelpEntry> {
  if (!canOpenTab()) {
    return HELP_ENTRIES;
  }
  const out: HelpEntry[] = [];
  for (const entry of HELP_ENTRIES) {
    out.push(entry);
    if (entry?.[0] === "*") {
      out.push([
        "^t",
        canReveal()
          ? "go to selected session's tab (opening one if needed), or send the composer to a new one"
          : "new tab: selected session, or send the composer to a new one",
      ]);
    }
  }
  return out;
}

// A unit of focused input. The focus stack in pickSession routes all
// key/resize events to the topmost layer; push pushes a new one,
// pop restores the one below (and re-renders it via onResize).
export interface FocusLayer {
  onKey(name: string, _matches: unknown, data?: { isCharacter?: boolean }): void;
  onResize(): void;
  // Optional mouse handling for the layer while it's on top. Layers that
  // don't implement it swallow mouse events rather than letting them
  // reach the picker underneath — a click meant for a modal must never
  // act on the list behind it.
  onMouse?(name: string, data?: { x?: number; y?: number }): void;
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
  // Picker terminal-mode reset. Used at entry and again on SIGCONT
  // resume — the shell we yielded to during ^Z can leave any of these
  // modes in an unknown state, so we re-assert them before painting.
  const resetPickerTerminalModes = (): void => {
    writeControl(SGR_RESET);
    writeControl(KITTY_KBD_POP);
    writeControl(BRACKETED_PASTE_OFF);
    writeControl(MODIFY_OTHER_KEYS_OFF);
    writeControl(FORMAT_OTHER_KEYS_OFF);
    writeControl(MOUSE_X10_OFF);
    writeControl(MOUSE_BUTTON_OFF);
    writeControl(MOUSE_SGR_OFF);
    writeControl(DECCKM_OFF);
    writeControl(DECPAM_OFF);
  };
  resetPickerTerminalModes();

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
    if (current?.importedFromMachine || current?.remote) {
      prefs.filters.hostFilter = "__all";
    }
  }

  // sorted/rows/widths are rebuilt whenever the underlying session list
  // changes (kill / delete refetches from the daemon). `allSessions` is the
  // full sorted source; `visible` is the currently displayed slice — the
  // subset of allSessions after the cwd-only / host filter / search
  // filters compose.
  // Mutable cwd used for the composer title, the cwd-only filter, and as
  // the cwd reported back for "new" results. Initialized from opts.cwd
  // and updated by the ^p cwd-change prompt.
  let currentCwd = opts.cwd;
  let allSessions: DiscoveredSession[] = sortSessions(opts.sessions, currentCwd);
  // Cursor from the last listSessionsPage() response. undefined until the
  // picker's own first refresh (opts.sessions came from the caller, not a
  // page we have a cursor for), so that refresh is a full listing same as
  // before; every refresh after merges incrementally via applySessionPage.
  let sessionCursor: number | undefined;
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
      base = base.filter((s) => s.cwd === currentCwd);
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
  // Column selection + cwd cap, shared by computeWidths and formatRow so
  // widths and rendering agree on the same set/order. Honors the user's
  // tui.sessionColumns (which also controls order); falls back to the
  // built-in default (UPSTREAM hidden).
  const formatOpts: FormatOptions = {
    columns: opts.config.tui.sessionColumns ?? DEFAULT_COLUMNS,
    cwdMaxWidth: opts.config.tui.cwdColumnMaxWidth,
  };
  let rows: Row[] = visible.map((s) => toRow(s, Date.now()));
  let widths: Widths = computeWidths(rows, formatOpts);

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

  // When a held UP key walks the selection up into the composer
  // (selectedIdx 1→0), terminal key auto-repeat keeps emitting UP events.
  // Once focus reaches the composer, those repeats would otherwise feed
  // the composer's prompt-history walk. We can't see key-up events, so we
  // infer "still held" from cadence: auto-repeat fires every few tens of
  // ms, while a deliberate re-press comes after a human-scale gap. While
  // the guard is armed we swallow every UP whose gap from the previous UP
  // is within the repeat window, refreshing the timer each time. The
  // first UP separated by a longer gap (key released + re-pressed) clears
  // the guard and feeds history normally.
  const UP_REPEAT_GAP_MS = 120;
  // Armed when an UP crosses from the first session row into the composer.
  let upGuardArmed = false;
  // Timestamp of the most recent UP key event (list or composer).
  let lastUpAt = 0;

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
  let pendingAction: { sessionId: string; cwd: string; status: "warm" | "cold" } | null = null;
  // Find-session state. All transient — cleared when exitFind() fires.
  // findLayerActive gates the bracketed-paste interceptor so pasted text
  // reaches findComposer while the find dialog is open.
  let findLayerActive = false;
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
  // Rendered rows for the sessions behind findResults, keyed by session
  // id, plus the column widths computed across just that set. Rebuilt by
  // rebuildFindRows() whenever findResults changes so a hit's identity
  // line is formatted by the same code path as the main picker list.
  let findRows = new Map<string, Row>();
  let findWidths: Widths = computeWidths([], formatOpts);
  let findHeaderLine = "";
  const findRowFor = (sessionId: string): Row | null =>
    findRows.get(sessionId) ?? null;
  const rebuildFindRows = (): void => {
    const now = Date.now();
    const byId = new Map(visible.map((s) => [s.sessionId, s]));
    const rowList: Row[] = [];
    findRows = new Map();
    for (const hit of findResults) {
      const session = byId.get(hit.sessionId);
      if (!session) {
        continue;
      }
      const row = toRow(session, now);
      findRows.set(hit.sessionId, row);
      rowList.push(row);
    }
    findWidths = computeWidths(rowList, formatOpts);
    const budget = Math.max(20, readTermWidth(term) - ROW_PREFIX_WIDTH);
    findHeaderLine = formatRow(HEADER, findWidths, budget, formatOpts).padEnd(
      budget,
    );
  };
  // Rename input buffer. Pre-filled with the current title when `t` is
  // pressed on a live row; the user edits in-place with full readline
  // motion (arrows, ^A/^E, word motion, ^U/^K/^W, ^Y, ^_ undo, Alt-_
  // redo). Enter saves, Esc cancels. Null when not in rename mode.
  let renameEditor: LineEditor | null = null;
  // Transient one-line hint shown in the indicator slot. Cleared on the
  // next key press so it never lingers.
  let transientStatus: string | null = null;
  // Transient hint shown in the composer-adjacent status row (blank
  // gap between the composer's bottom border and the session-list
  // header). Currently used for tab-completion candidate lists.
  // Cleared on the next composer keystroke that isn't another Tab.
  // The `/` search filter also renders in this row when searchActive,
  // but it comes from searchTerm/visible directly — formatComposerStatus
  // combines both.
  let composerHint: string | null = null;
  // Post-selection install / launch status, painted in the same
  // composer-adjacent row. Set only after the picker has resolved with
  // a "new" selection and deferred its cleanup — while it's non-null
  // the row displays this string as `status-progress` (matching the pre-
  // alt-screen stdout redraw) instead of the hint / search line.
  // Precedence: installStatusText wins over search and hint.
  let installStatusText: string | null = null;

  const formatComposerStatus = (): { plain: string; render: () => void } | null => {
    if (installStatusText !== null) {
      const text = installStatusText;
      return {
        plain: text,
        render: () => {
          paint(term, "status-active", `  ${text}`);
        },
      };
    }
    if (searchActive) {
      const matches =
        visible.length === 0
          ? "no matches"
          : `${visible.length} match${visible.length === 1 ? "" : "es"}`;
      const plain = `/${searchTerm}▉ ${matches} · ^c clears`;
      return {
        plain,
        render: () => {
          paint(term, "prompt-text", `  /${searchTerm}`);
          paint(term, "prompt-cursor", " ");
          paint(term, "modal-hint", ` ${matches} · ^c clears`);
        },
      };
    }
    if (composerHint !== null) {
      return {
        plain: composerHint,
        render: () => {
          paint(term, "modal-hint", `  ${composerHint}`);
        },
      };
    }
    return null;
  };
  // Set when the user kills or deletes the session they opened the picker
  // from. Aborting (Esc) would otherwise resume that now-dead session,
  // which then errors on the first prompt — so we block the abort and
  // make the user pick a warm session or start a new one instead.
  let currentSessionGone = false;

  // Composer pane at the top of the picker. Reuses the live composer's
  // InputDispatcher so every readline shortcut (Alt+Enter newline,
  // ^A/^E, ^U/^K/^W, ^Y, etc.) works identically. The dispatcher's
  // buffer text is sent as the new session's first prompt on Enter.
  const composer = new InputDispatcher({ history: [] });
  // Restore a prompt the user already typed for a new session (e.g. the
  // agent picker's Esc re-opened this picker) so the composer box isn't
  // cleared out from under them.
  if (opts.initialPrompt) {
    composer.setBuffer(opts.initialPrompt);
  }
  if (opts.initialAttachments) {
    for (const a of opts.initialAttachments) {
      composer.addAttachment(a);
    }
  }
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

  // Row-level diff painter: every render path funnels its row writes
  // through painter.paintRow(row, sig, paint) so consecutive frames
  // emit only the rows whose sig changed. Cleared at entry points
  // that paint outside the painter (help / find overlays, openCwdPrompt)
  // so the next picker render emits a full frame.
  const painter = new RowPainter(term);

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

  const computeLayout = (): void => {
    termHeight = readTermHeight(term);
    termWidth = readTermWidth(term);
    // Leave the rightmost column unwritten: filling all `termWidth`
    // cells triggers the terminal's last-column auto-wrap and eats the
    // trailing glyph (e.g. the final digit of a 5-char COST cell). The
    // -1 keeps the last data column safe.
    const rowMaxWidth = Math.max(10, termWidth - ROW_PREFIX_WIDTH - 1);
    // Composer body sits inside a "│ … │" box, costing 4 cols (border +
    // 1-col pad on each side). Buffer wrap is computed against this
    // tighter budget so cursor placement matches what we paint.
    composerRoom = Math.max(10, termWidth - BOX_HORIZONTAL_PAD);
    // Title embeds in the top border as "╭─ <title> ──...─╮", so the
    // title length is capped at termWidth - 8 to guarantee at least two
    // trailing dashes before the corner glyph.
    const titleBudget = Math.max(10, termWidth - 8);
    const attachmentCount = composer.state().attachments.length;
    const suffix = attachmentCount > 0 ? ` · 📎×${attachmentCount}` : "";
    const titleBudgetForCwd = Math.max(10, titleBudget - suffix.length);
    composerTitle = formatComposerTitle(currentCwd, titleBudgetForCwd) + suffix;
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
    headerLine = formatRow(HEADER, widths, rowMaxWidth, formatOpts).padEnd(
      rowMaxWidth,
    );
    sessionLines = rows.map((r) =>
      formatRow(r, widths, rowMaxWidth, formatOpts).padEnd(rowMaxWidth),
    );
  };

  // After the underlying session list changed (kill / delete), rebuild
  // the derived row/widths/layout arrays in lockstep. Callers handle
  // cursor placement and trigger the actual repaint themselves.
  const rebuildRows = (): void => {
    rows = visible.map((s) => toRow(s, Date.now()));
    widths = computeWidths(rows, formatOpts);
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
  // least 2 so we can always fit "──". We leave the rightmost terminal
  // column blank — picker doesn't disable DECAWM, so a glyph painted in
  // the last column triggers a wrap that pushes the right border ╮ onto
  // the next row.
  const composerBoxInner = (): number => Math.max(2, termWidth - 3);

  // Top border with the title embedded:
  //   ╭─ Create new session in ~/foo ────────────────────╮
  // Title is middle-truncated by formatComposerTitle to fit composerRoom;
  // the dashes flex to fill whatever remains so the border touches the
  // right edge of the terminal.
  // Set true while the mouse is over the composer box. Affordance only:
  // flips the border to `box-border-focused` so the
  // user gets a hint that a click here would focus the composer. Does
  // NOT change selectedIdx — focus only moves on click.
  let composerHover = false;
  // Tracks DECSET 1004 focus reports. While false, painted rows lose
  // their selection highlight and the composer border dims, mirroring
  // the OS-level "this window isn't active" affordance. selectedIdx
  // itself is preserved across focus loss, so regaining focus restores
  // the same highlighted row (unless a hover event lands on a
  // different row in the meantime — that path is already gated by
  // selectedIdx and only fires when the list is focused).
  let terminalFocused = true;
  // Forward-declared promise-scope state hoisted so the raw stdin
  // handler (built before the Promise body runs) can observe whether
  // the picker has resolved and whether a modal layer is currently up.
  // The Promise body assigns to these; before that, the handler can't
  // be invoked (grabInput hasn't been wired) so the defaults are safe.
  let resolved = false;
  let focusStackRef: FocusLayer[] = [];
  // "agent•model" (or just "agent") stamp for the top-right of the
  // composer border. Reflects what a fresh session created from the
  // composer would use. Omitted entirely when neither seed nor a
  // click-through override supplied an agent id.
  //
  // Mutable: openAgentPrompt updates these on user choice, and the
  // picker rerenders so the label follows. Read on the "new" result so
  // the caller launches with the picked agent.
  let composerAgentId = opts.composerAgentId;
  let composerModel = opts.composerModel;
  // True once the user has committed an agent in the click-to-switch
  // modal. An explicit pick outranks a directory default, so ^O stops
  // re-resolving the label after one.
  let composerAgentExplicit = false;
  const composerAgentModelLabel = (): string => {
    const a = composerAgentId;
    if (!a) {
      return "";
    }
    const m = composerModel;
    return m ? `${a}•${m}` : a;
  };
  // Screen-column ranges (1-indexed, inclusive) of the two click zones
  // painted on the composer's top border (row = startRow). Updated by
  // paintComposerTopBorder every time it paints. Nullable: null means
  // "no click zone this frame" (e.g. the fragment didn't fit and was
  // omitted). onMouse consults these on a click at startRow to decide
  // between opening the cwd prompt, the agent picker, or falling
  // through to the default composer-focus behavior.
  let cwdClickRange: { start: number; end: number } | null = null;
  let agentClickRange: { start: number; end: number } | null = null;
  // Which top-border click zone the mouse is currently hovering. Drives
  // the bold affordance on that fragment so it's obvious it's clickable
  // — plain text otherwise, matching the rest of the border. Cleared
  // when the mouse leaves the top border (or the composer entirely).
  let composerTopHover: "cwd" | "agent" | null = null;
  const paintComposerTopBorder = (): void => {
    const inner = composerBoxInner();
    const titleFragment = `─ ${composerTitle} `;
    // "─ agent•model ─" glued to the right corner. Space padding on
    // both sides keeps the label readable against the dashes. Suppress
    // the fragment entirely when it wouldn't fit alongside the title
    // — the title wins because the cwd is always relevant, whereas the
    // agent stamp is a nice-to-have.
    const rawRight = composerAgentModelLabel();
    let rightFragment = "";
    if (rawRight.length > 0) {
      const candidate = `─ ${rawRight} `;
      if (candidate.length + titleFragment.length + 1 <= inner) {
        rightFragment = candidate;
      }
    }
    const dashCount = Math.max(1, inner - titleFragment.length - rightFragment.length);
    const dashes = "─".repeat(dashCount);
    const focused = (selectedIdx === 0 || composerHover) && terminalFocused;
    // Column layout of the row we're about to paint (1-indexed screen
    // columns): "╭" at col 1, then titleFragment, then dashes, then
    // (optional) rightFragment, then "╮" at col inner+2. Record the
    // click-through zones for onMouse. Whole "─ <cwd> " title fragment
    // is clickable (including its own leading dash + trailing space,
    // matching how obviously "titley" that segment reads); ditto for
    // the right fragment.
    // "╭" occupies column 1, then titleFragment spans columns 2..1+titleFragment.length.
    cwdClickRange =
      titleFragment.length > 0
        ? { start: 2, end: 1 + titleFragment.length }
        : null;
    if (rightFragment.length > 0) {
      // rightFragment sits between the trailing dashes and the "╮"
      // corner. Its start column = 1 (corner) + titleFragment.length +
      // dashCount + 1 (first char of rightFragment).
      const rightStart = 1 + titleFragment.length + dashCount + 1;
      agentClickRange = {
        start: rightStart,
        end: rightStart + rightFragment.length - 1,
      };
    } else {
      agentClickRange = null;
    }
    // The hovered fragment (cwd title on the left, agent•model on the right)
    // bolds so it visibly reads as clickable. Non-hovered fragments and the
    // surrounding dashes/corners stay unbolded.
    const borderToken: ChromeToken = focused
      ? "box-border-focused"
      : "box-border";
    const hoverToken: ChromeToken = focused
      ? "box-border-focused-hover"
      : "box-border-hover";
    const emitFragment = (frag: string, hovered: boolean): void => {
      paint(term, hovered ? hoverToken : borderToken, frag);
    };
    paint(term, borderToken, "╭");
    emitFragment(titleFragment, composerTopHover === "cwd");
    paint(term, borderToken, dashes);
    if (rightFragment) {
      emitFragment(rightFragment, composerTopHover === "agent");
    }
    paint(term, borderToken, "╮");
  };

  // Bottom border: ╰──...──╯ stretched to the terminal width.
  const paintComposerBottomBorder = (): void => {
    const inner = composerBoxInner();
    const dashes = "─".repeat(inner);
    if ((selectedIdx === 0 || composerHover) && terminalFocused) {
      paint(term, "box-border-focused", `╰${dashes}╯`);
    } else {
      paint(term, "box-border", `╰${dashes}╯`);
    }
  };

  // Composer-adjacent status row, one line below the composer's bottom
  // border. Blank unless there's a hint to show (tab-completion
  // candidates, or the active `/` filter).
  const paintComposerStatus = (): void => {
    const status = formatComposerStatus();
    if (status === null) {
      return;
    }
    const w = Math.max(0, readTermWidth(term) - 2);
    if (status.plain.length > w) {
      const truncated = status.plain.slice(0, Math.max(0, w - 1)) + "…";
      paint(term, "modal-hint", `  ${truncated}`);
      return;
    }
    status.render();
  };

  // The visible slice of the composer buffer for one visual row, used
  // by paintComposerBodyRow to draw the row and by composerBodySig to
  // detect when that row's content has changed across frames.
  const composerSliceAt = (visualIdx: number): string => {
    const vr = composerVisualRows[visualIdx];
    if (!vr) {
      return "";
    }
    return (composer.state().buffer[vr.bufferIdx] ?? "").slice(
      vr.startCol,
      vr.endCol,
    );
  };

  // One visual row of the composer body. Focused: border glyphs in
  // `box-border-focused`, content plain. Unfocused: plain borders.
  const paintComposerBodyRow = (visualIdx: number): void => {
    const inner = composerBoxInner();
    const slice = composerSliceAt(visualIdx);
    const padWidth = Math.max(0, inner - 1 - slice.length);
    const pad = " ".repeat(padWidth);
    if ((selectedIdx === 0 || composerHover) && terminalFocused) {
      paint(term, "box-border-focused", "│");
      paint(term, "content", ` ${slice}${pad}`);
      paint(term, "box-border-focused", "│");
    } else {
      paint(term, "box-border", "│");
      paint(term, "content", ` ${slice}${pad}`);
      paint(term, "box-border", "│");
    }
  };

  const paintSessionRow = (sessionIdx: number): void => {
    const label = sessionLines[sessionIdx] ?? "";
    // 2-col prefix: "* " for priority rows, "  " for normal rows.
    // Selection is signalled by the bg highlight (no arrow glyph).
    const session = visible[sessionIdx];
    const prefix =
      session && session.priority && session.priority > 0 ? "* " : "  ";
    if (selectedIdx === sessionIdx + 1 && !composerHover && terminalFocused) {
      paint(term, "list-selected", `${prefix}${label}`);
    } else {
      paint(term, "content", `${prefix}${label}`);
    }
  };

  // Indicator parts as structured tokens. `kind: "host"` is the
  // click target wired up by hostHitCols; everything else paints as
  // plain hint text. Order is preserved so the join order matches what
  // formatIndicator() reports.
  type IndicatorPart = { kind: "plain" | "host"; text: string };
  const indicatorParts = (): IndicatorPart[] => {
    const above = scrollOffset;
    const below = Math.max(0, visible.length - scrollOffset - viewportSize);
    const parts: IndicatorPart[] = [];
    if (prefs.filters.cwdOnly) {
      parts.push({ kind: "plain", text: "cwd-only" });
    }
    if (prefs.filters.hostFilter !== "__all") {
      parts.push({ kind: "host", text: describeHostFilter(prefs.filters.hostFilter) });
    }
    if (prefs.filters.includeNonInteractive) {
      parts.push({ kind: "plain", text: "+non-interactive" });
    }
    if (above > 0) {
      parts.push({ kind: "plain", text: `↑ ${above} above` });
    }
    if (below > 0) {
      parts.push({ kind: "plain", text: `↓ ${below} below` });
    }
    return parts;
  };
  const formatIndicator = (): string => {
    const parts = indicatorParts();
    if (parts.length === 0) {
      return "";
    }
    return `  ${parts.map((p) => p.text).join(" · ")}`;
  };

  // Short id used in confirm prompts; matches what users see in the table.
  const shortId = (sessionId: string): string => stripHydraSessionPrefix(sessionId);

  // Paint just the indicator row in whatever style matches the current
  // mode. Used by every state transition that doesn't redraw the whole
  // picker (most navigation, confirm/cancel, transient hints). Content
  // length varies (search hint, transient status), so we still have to
  // clear leftover chars — but doing the erase AFTER paint (rather than
  // before) means the row is never blanked mid-frame.
  // Sig captures every state input the indicator paint reads so the
  // row-painter cache can short-circuit redundant emits between key
  // events. Includes mode, pending session id/status, transient
  // status, search state, and filter prefs (so toggling filters
  // re-emits the indicator).
  const indicatorSig = (): string => {
    const pending = pendingAction
      ? `${pendingAction.sessionId}|${pendingAction.status}`
      : "";
    return [
      "ind",
      mode,
      pending,
      renameEditor ? `${renameEditor.text}\u0002${renameEditor.cursor}` : "",
      transientStatus ?? "",
      searchActive ? `1|${searchTerm}|${visible.length}` : "0",
      formatIndicator(),
      escHintHovered ? "h1" : "h0",
      hostHintHovered ? "ho1" : "ho0",
    ].join("\u0001");
  };
  const paintIndicator = (): void => {
    withSync(() => {
      painter.paintRow(indicatorRow(), indicatorSig(), () => {
        // Sub-modes never expose host or esc as click targets — clear
        // both hit ranges so a stale rect from the last normal-mode
        // frame doesn't keep firing.
        const clearHits = (): void => {
          escHitCols = null;
          hostHitCols = null;
        };
        if (mode === "confirm-kill" && pendingAction) {
          clearHits();
          paint(term, "prompt-text", `  kill ${shortId(pendingAction.sessionId)}? [y/N]`);
        } else if (mode === "confirm-delete" && pendingAction) {
          clearHits();
          if (pendingAction.status === "warm") {
            paint(
              term,
              "prompt-destructive",
              `  kill + delete ${shortId(pendingAction.sessionId)}? [y/N]`,
            );
          } else {
            paint(
              term,
              "prompt-destructive",
              `  delete ${shortId(pendingAction.sessionId)}? [y/N]`,
            );
          }
        } else if (mode === "busy" && pendingAction) {
          clearHits();
          paint(term, "modal-status", `  working on ${shortId(pendingAction.sessionId)}…`);
        } else if (mode === "rename" && pendingAction && renameEditor) {
          clearHits();
          const text = renameEditor.text;
          const cur = renameEditor.cursor;
          paint(term, "prompt-text", "  title: ");
          paint(term, "prompt-text", text.slice(0, cur));
          if (cur < text.length) {
            paint(term, "prompt-cursor", text[cur] ?? " ");
            paint(term, "prompt-text", text.slice(cur + 1));
          } else {
            paint(term, "prompt-cursor", " ");
          }
          paint(term, "modal-hint", "  Enter saves · Esc cancels");
        } else if (transientStatus !== null) {
          clearHits();
          paint(term, "modal-status", `  ${transientStatus}`);
        } else {
          // Normal mode: left side is formatIndicator(); right edge gets
          // an "Esc · Go Back" hint that doubles as a click target
          // (see escHitCols / onMouse). The padding between left and
          // hint is rendered with spaces so the previous frame's text
          // is overwritten even when paintRow's eraseLineAfter only
          // reaches to the cursor after the hint.
          const parts = indicatorParts();
          const leftText = formatIndicator();
          const escHint = "Esc · Go Back";
          const hintWidth = escHint.length;
          const rightMargin = 5;
          const leftWidth = leftText.length;
          const gap = Math.max(
            1,
            termWidth - leftWidth - hintWidth - rightMargin,
          );
          // Paint the left indicator token by token so we can capture
          // the host segment's screen column range while we draw it.
          // The leading "  " (2 cols) matches formatIndicator()'s prefix.
          hostHitCols = null;
          if (parts.length > 0) {
            paint(term, "modal-hint", "  ");
            let col = 3; // 1-based column of next glyph
            for (let i = 0; i < parts.length; i++) {
              const p = parts[i]!;
              if (i > 0) {
                paint(term, "modal-hint", " · ");
                col += 3;
              }
              if (p.kind === "host") {
                hostHitCols = { start: col, end: col + p.text.length - 1 };
                if (hostHintHovered) {
                  paint(term, "content", p.text);
                } else {
                  paint(term, "modal-hint", p.text);
                }
              } else {
                paint(term, "modal-hint", p.text);
              }
              col += p.text.length;
            }
          }
          paint(term, "modal-hint", " ".repeat(gap));
          if (escHintHovered) {
            paint(term, "content", escHint);
          } else {
            paint(term, "modal-hint", escHint);
          }
          escHitCols = {
            start: termWidth - rightMargin - hintWidth + 1,
            end: termWidth - rightMargin,
          };
        }
      });
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

  // Sigs for the row-painter cache. Each must include every variable
  // input that affects the row's visible output; identical sig means
  // identical bytes so paintRow can short-circuit.
  const composerFocusFlag = (): string => {
    if (!terminalFocused) return "x";
    return selectedIdx === 0 ? "f" : composerHover ? "h" : "u";
  };
  const composerTopSig = (): string =>
    `ct|${composerFocusFlag()}|${composerBoxInner()}|${composerTitle}|${composerAgentModelLabel()}|${composerTopHover ?? ""}`;
  const composerBotSig = (): string =>
    `cb|${composerFocusFlag()}|${composerBoxInner()}`;
  const composerStatusSig = (): string => {
    if (installStatusText !== null) {
      return `cs|i|${installStatusText}`;
    }
    if (searchActive) {
      return `cs|s|${searchTerm}|${visible.length}`;
    }
    if (composerHint !== null) {
      return `cs|h|${composerHint}`;
    }
    return "blank";
  };
  const composerBodySig = (visualIdx: number): string =>
    `cbb|${composerFocusFlag()}|${composerBoxInner()}|${composerSliceAt(visualIdx)}`;
  const headerSig = (): string => `h|${headerLine}`;
  const sessionRowSig = (sessionIdx: number): string => {
    const session = visible[sessionIdx];
    const prefix = session && session.priority && session.priority > 0 ? "* " : "  ";
    const label = sessionLines[sessionIdx] ?? "";
    const selected =
      selectedIdx === sessionIdx + 1 && !composerHover && terminalFocused
        ? "1"
        : "0";
    return `sr|${selected}|${prefix}${label}`;
  };

  // Paint the picker's main view through the row-painter so frames
  // share their per-row signature cache. The first call (after
  // painter.clearCache()) emits every row; subsequent calls with
  // overlapping state emit only the rows whose sig changed.
  // Hides the cursor for the duration so the user never sees it
  // skitter row-by-row across the frame; the trailing block places
  // it where it belongs.
  const renderFromScratch = (): void => {
    withSync(() => {
      term.hideCursor();
      computeLayout();
      adjustScroll();
      startRow = 1;
      painter.ensureSize(termWidth, termHeight);
      painter.paintRow(startRow, composerTopSig(), () => {
        paintComposerTopBorder();
      });
      for (let v = 0; v < composerRows; v++) {
        const visualIdx = composerWindowStart + v;
        painter.paintRow(composerBodyRow(v), composerBodySig(visualIdx), () => {
          paintComposerBodyRow(visualIdx);
        });
      }
      painter.paintRow(composerBottomRow(), composerBotSig(), () => {
        paintComposerBottomBorder();
      });
      painter.paintRow(
        composerBottomRow() + 1,
        composerStatusSig(),
        () => paintComposerStatus(),
      );
      painter.paintRow(headerRow(), headerSig(), () => {
        paint(term, "list-header", `  ${headerLine}`);
      });
      for (let v = 0; v < viewportSize; v++) {
        const sessionIdx = scrollOffset + v;
        const row = headerRow() + 1 + v;
        if (sessionIdx < visible.length) {
          painter.paintRow(row, sessionRowSig(sessionIdx), () => {
            paintSessionRow(sessionIdx);
          });
        } else {
          painter.paintRow(row, "blank", () => {});
        }
      }
      paintIndicator();
      // Blank every row from just after the indicator down to the
      // bottom of the terminal. The list shrinks when a filter
      // (host / org / project) narrows the visible set, dropping
      // viewportSize and pulling the indicator up; rows the prior
      // frame painted below the new indicator must be cleared or
      // they leave stale glyphs on screen.
      for (let r = indicatorRow() + 1; r <= termHeight; r++) {
        painter.paintRow(r, "blank", () => {});
      }
      if (selectedIdx === 0) {
        placeComposerCursor();
        term.hideCursor(false);
      }
    });
  };

  // Force-repaint every row. renderFromScratch only repaints rows whose
  // signatures changed, which is wrong any time the terminal contents
  // are out of sync with our cache — after SIGCONT resume, after ^L, or
  // any other "the screen lied to us" event. Wipe the cache and clear
  // the display so the next paintRow call for each row is unconditional.
  const forceFullRepaint = (): void => {
    painter.clearCache();
    term.moveTo(1, 1).eraseDisplayBelow();
    renderFromScratch();
  };

  const renderHelp = (): void => {
    withSync(() => {
      term.hideCursor();
      painter.clearCache();
      term.moveTo(1, 1).eraseDisplayBelow();
      paint(term, "modal-title", "  Picker hotkeys");
      term.noFormat("\n\n");
      for (const entry of helpEntries()) {
        if (entry === null) {
          term("\n");
          continue;
        }
        const [keys, desc] = entry;
        paint(term, "modal-key", `  ${keys.padEnd(HELP_KEYS_WIDTH)}`);
        paint(term, "content", desc);
        term.noFormat("\n");
      }
      term("\n");
      paint(term, "modal-hint", "  press any key to dismiss");
      term.noFormat("\n");
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
  //   row findBoxRows+4  SESSION STATE AGE CWD TITLE…   ← findHeaderRow()
  //   row findBoxRows+5  ❯ session-id  cold  Title   ← findResultsStartRow()
  //   ...
  //   last               indicator
  //
  // The column header is the same one the main picker paints, and the
  // result rows are formatted by the same formatRow — a hit should read
  // identically to its row in the list you came from.
  const findHeaderRow = (): number => findBoxRows + 4;
  const findResultsStartRow = (): number => findBoxRows + 5;
  const FIND_FOOTER_ROWS = 2;
  let findScrollOffset = 0;
  const findViewportSize = (): number => {
    termHeight = readTermHeight(term);
    const avail = Math.max(2, termHeight - (findBoxRows + 4) - FIND_FOOTER_ROWS);
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
  // pattern. "focused" picks the focused vs plain border token, and
  // determines whether the real terminal cursor is placed inside.

  const paintFindBoxTopBorder = (focused: boolean): void => {
    termWidth = readTermWidth(term);
    const inner = Math.max(2, termWidth - 3);
    const title = "─ Find sessions ";
    const dashes = "─".repeat(Math.max(1, inner - title.length));
    if (focused) {
      paint(term, "box-border-focused", `╭${title}${dashes}╮`);
    } else {
      paint(term, "box-border", `╭${title}${dashes}╮`);
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
    const inner = Math.max(2, termWidth - 3);
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
      paint(term, "box-border-focused", "│");
      paint(term, "content", ` ${slice}${pad}`);
      paint(term, "box-border-focused", "│");
    } else {
      paint(term, "box-border", "│");
      paint(term, "content", ` ${slice}${pad}`);
      paint(term, "box-border", "│");
    }
    term.styleReset();
  };

  const paintFindBoxBottomBorder = (focused: boolean): void => {
    termWidth = readTermWidth(term);
    const inner = Math.max(2, termWidth - 3);
    const dashes = "─".repeat(inner);
    if (focused) {
      paint(term, "box-border-focused", `╰${dashes}╯`);
    } else {
      paint(term, "box-border", `╰${dashes}╯`);
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

  // Snippet indent on the result's second row ("    " before the prefix).
  const SNIPPET_INDENT = 4;
  // Room reserved for the "[1/5] ToolName  " prefix when asking the
  // daemon for a snippet width. Rows whose prefix runs longer than this
  // get trimmed client-side; rows with a shorter one just don't use the
  // full budget. Guessing here beats asking per-row — the width is a
  // property of the whole request.
  const SNIPPET_PREFIX_RESERVE = 16;
  const snippetRenderWidth = (): number =>
    Math.max(
      24,
      readTermWidth(term) - 1 - SNIPPET_INDENT - SNIPPET_PREFIX_RESERVE,
    );

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
    // Render the identity line with the picker's own row formatter so a
    // hit shows the same columns (age, agent, cwd, title, cost) in the
    // same places as the main list. findWidths is computed across just
    // the hit sessions, so the find list is internally aligned even
    // though its column widths won't match the picker's. Nothing is
    // appended to this line — a counter tacked on the end lands under
    // whichever column happens to be last (AGENT / COST) and reads like
    // a value in it.
    const row = findRowFor(hit.sessionId);
    const line1 =
      row !== null
        ? formatRow(row, findWidths, rowBudget, formatOpts).padEnd(rowBudget)
        : // Session retired out from under the results (killed, or a
          // filter change since the search). Fall back to what the hit
          // itself carries.
          `${stripHydraSessionPrefix(hit.sessionId)}  ${hit.status === "warm" ? "warm" : "cold"}  ${truncateMiddle(
            hit.title ?? shortenHomePath(hit.cwd),
            Math.max(5, rowBudget - 20),
          )}`.padEnd(rowBudget);
    // Snippet line: counter first (it's about the snippets, so it belongs
    // on the snippet row), then the tool name when there is one. The
    // snippet *kind* (agent / thought / user) is deliberately omitted —
    // it's noise next to the matched text, which speaks for itself.
    // Shown on every row, not just the focused one. Hiding it until focus
    // made rows change shape as the cursor moved, and it hid the one fact
    // that tells you whether a hit is worth stepping into.
    const snippetIdx = focused ? findSnippetIdx : 0;
    const snippet = hit.snippets[snippetIdx];
    const counterText =
      hit.snippets.length > 1
        ? `[${snippetIdx + 1}/${hit.snippets.length}] `
        : hit.totalMatches > hit.snippets.length
          ? `[${hit.snippets.length} of ${hit.totalMatches}] `
          : "";
    const toolPart = snippet?.toolName ? `${snippet.toolName}  ` : "";
    const prefix = `${counterText}${toolPart}`;
    // Exactly what's left on the row: full width, less the last column we
    // leave unwritten (auto-wrap guard), less the indent and prefix. The
    // daemon already sized the snippet to roughly this, so in the common
    // case truncateMiddle is a no-op rather than a second haircut on top
    // of the server's.
    const snippetBudget = Math.max(
      10,
      w - 1 - SNIPPET_INDENT - prefix.length,
    );
    const text = snippet ? truncateMiddle(snippet.text, snippetBudget) : "";
    const line2 = snippet ? `    ${prefix}${text}` : "    (no snippet)";
    return { rowBudget, line1, line2: line2.padEnd(rowBudget + ROW_PREFIX_WIDTH), focusedRow: focused };
  };

  // Column header for the results list. Same content as the main
  // picker's header, dimmed and indented by the 2-col row prefix so the
  // columns line up with the result rows below it.
  const paintFindHeader = (): void => {
    paint(term, "list-header", `  ${findHeaderLine}`);
    term.styleReset();
  };

  // Paint just the title/id row for one result (no newline). Full-width
  // padEnd means no eraseLineAfter is needed — stale chars from a wider
  // previous frame can't survive.
  const paintFindResultA = (idx: number, focused: boolean): void => {
    const { line1, focusedRow } = findResultData(idx, focused);
    if (focusedRow) {
      paint(term, "list-selected", `❯ ${line1}`);
    } else {
      paint(term, "content", `  ${line1}`);
    }
    term.styleReset();
  };

  // Paint just the snippet row for one result (no newline).
  const paintFindResultB = (idx: number, focused: boolean): void => {
    const { line2 } = findResultData(idx, focused);
    paint(term, "list-description", line2);
    term.styleReset();
  };

  const paintFindIndicator = (): void => {
    if (findInFlight) {
      paint(term, "modal-status", "  searching…");
      term.styleReset();
      term.eraseLineAfter();
    } else if (findError !== null) {
      paint(term, "modal-error", `  ${findError}`);
      term.styleReset();
      term.eraseLineAfter();
    } else if (findSubMode === "input") {
      if (findResults.length > 0) {
        paint(term, "modal-hint", "  Enter to search · ↓ browse results · Esc cancel");
      } else {
        paint(term, "modal-hint", "  Enter to search · Esc cancel");
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
      paint(
        term,
        "modal-hint",
        `${countPart}↑ edit query · Up/Down sessions · n/p snippets · i info · Enter open · Esc back`,
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
      painter.clearCache();
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
          paint(term, "modal-hint", "  type a query in the box above, then press Enter");
          term.eraseLineAfter();
        } else if (findError === null) {
          paint(term, "modal-status", "  no matches");
          term.eraseLineAfter();
        }
        term.moveTo(1, findResultsStartRow() + 1);
        paintFindIndicator();
      } else {
        adjustFindScroll();
        term.moveTo(1, findHeaderRow());
        paintFindHeader();
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

  // Feed pasted text into findComposer and reflow the find box. Called from
  // the bracketed-paste interceptor when the find dialog is open and the
  // input box is focused.
  const feedFindPaste = (text: string): void => {
    const prevRows = findBoxRows;
    findComposer.feed({ type: "paste", text });
    computeFindBoxLayout();
    if (findBoxRows !== prevRows) {
      renderFind();
    } else {
      repaintFindBoxBodyRows();
    }
  };

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
        snippetWidth: snippetRenderWidth(),
      });
      findResults = out.results;
      rebuildFindRows();
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

  // Snapshot the current find state onto the caller-owned prefs so the
  // next ^F (in this picker or after a round-trip through a session)
  // picks up where this one left off. Called on exit and just before
  // resolving into a session.
  const persistFind = (): void => {
    const query = findQueryText();
    if (query.trim().length === 0 && findResults.length === 0) {
      delete prefs.lastFind;
      return;
    }
    prefs.lastFind = {
      query,
      results: findResults,
      truncated: findTruncated,
      selectedIdx: findSelectedIdx,
      snippetIdx: findSnippetIdx,
      scrollOffset: findScrollOffset,
    };
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
      painter.paintRow(startRow, composerTopSig(), () => {
        paintComposerTopBorder();
      });
      painter.paintRow(composerBottomRow(), composerBotSig(), () => {
        paintComposerBottomBorder();
      });
      for (let v = 0; v < composerRows; v++) {
        const visualIdx = composerWindowStart + v;
        painter.paintRow(composerBodyRow(v), composerBodySig(visualIdx), () => {
          paintComposerBodyRow(visualIdx);
        });
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
  const repaintComposerStatus = (): void => {
    withSync(() => {
      painter.paintRow(
        composerBottomRow() + 1,
        composerStatusSig(),
        () => paintComposerStatus(),
      );
    });
  };

  const clearComposerStatus = (): void => {
    if (composerHint === null) {
      return;
    }
    composerHint = null;
    repaintComposerStatus();
  };

  // User-configured hotkeys from tui.hotkeys (core/config.ts) — the same
  // config app.ts's live-session composer reads via tryHandleUserHotkey.
  // No session exists yet here, so %s / HYDRA_SESSION_ID substitutes to ""
  // rather than a real id; cwd and agent reflect the composer's current
  // draft. The picker has no scrollback to append command output to, so
  // it surfaces through composerHint instead — the same one-line status
  // area completion hints use.
  const tryHandleComposerHotkey = (name: string): boolean => {
    const spec = (
      opts.config.tui.hotkeys as Record<
        string,
        { command: string | string[] } | undefined
      >
    )[name];
    if (!spec) {
      return false;
    }
    runUserHotkey(
      spec,
      {
        sessionId: "",
        cwd: currentCwd,
        agentId: composerAgentId ?? "",
        baseUrl: opts.target.baseUrl,
        tokenFile: paths.authToken(),
      },
      {
        notify: (msg) => {
          composerHint = msg;
          repaintComposerStatus();
        },
        cwd: currentCwd,
        emitLines: (lines) => {
          if (lines.length === 0) {
            return;
          }
          const first = lines[0]!.text;
          composerHint =
            lines.length > 1 ? `${first} (+${lines.length - 1} more)` : first;
          repaintComposerStatus();
        },
      },
    );
    return true;
  };

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
        const visualIdx = composerWindowStart + v;
        painter.paintRow(composerBodyRow(v), composerBodySig(visualIdx), () => {
          paintComposerBodyRow(visualIdx);
        });
      }
      if (showCursor) {
        placeComposerCursor();
        term.hideCursor(false);
      }
    });
  };

  // Fetch an image from the system clipboard (best-effort, image-first)
  // and add it to the composer's attachment list. Fired when the
  // dispatcher emits an attachment-request effect from ^V or from an
  // empty bracketed paste (wezterm's native ctrl+shift+v with an
  // image-only clipboard). Reflects success/failure in the transient
  // indicator slot so the user knows the paste took effect.
  const ingestClipboardAttachment = async (): Promise<void> => {
    const result = await readClipboard();
    if (!result.ok) {
      transientStatus = result.reason;
      paintIndicator();
      return;
    }
    if (result.kind !== "image") {
      // Text-only clipboard: route through the same paste path as
      // bracketed paste so multi-line content splits at \n.
      // state() aliases the live buffer array (documented perf choice
      // in input.ts). Snapshot lines here so the after-comparison
      // actually sees the pre-feed state.
      const beforeState = composer.state();
      const beforeBuffer = [...beforeState.buffer];
      const beforeRow = beforeState.row;
      const beforeCol = beforeState.col;
      composer.feed({ type: "paste", text: result.text });
      const after = composer.state();
      const changed =
        beforeBuffer.length !== after.buffer.length ||
        beforeRow !== after.row ||
        beforeCol !== after.col ||
        !beforeBuffer.every((line, i) => line === after.buffer[i]);
      if (changed) {
        const rows = computePromptVisualRows(after.buffer, composerRoom);
        const layout = computePromptLayout(
          rows,
          after,
          PICKER_COMPOSER_MAX_ROWS,
        );
        if (layout.rendered !== composerRows) {
          renderFromScratch();
        } else {
          repaintComposerBody();
        }
      }
      return;
    }
    composer.addAttachment(result.attachment);
    transientStatus = `attached ${result.attachment.name ?? "image"}`;
    // Attachment count is baked into composerTitle, so a full redraw
    // keeps the box border label in sync with the new count.
    renderFromScratch();
  };
  // ^X: hand the composer draft to $VISUAL/$EDITOR. withdrawTerminalForChild
  // / reclaimTerminalFromChild are the same terminal-kit teardown/re-install
  // pair ^Z suspend uses, called directly instead of through a SIGTSTP round
  // trip. Both are non-null by the time a keystroke can reach this — they're
  // assigned right after installGrab() in the same setup block.
  const handleEditInEditor = async (): Promise<void> => {
    const edited = await editTextInEditor(composer.expandedText(), {
      suspend: () => withdrawTerminalForChild?.(),
      resume: () => reclaimTerminalFromChild?.(),
      notify: (message) => {
        transientStatus = message;
        paintIndicator();
      },
    });
    if (edited === null) {
      return;
    }
    composer.setBuffer(edited, composer.state().attachments);
    renderFromScratch();
  };
  const repaintSessionRow = (sessionIdx: number): void => {
    if (
      sessionIdx < scrollOffset ||
      sessionIdx >= scrollOffset + viewportSize
    ) {
      return;
    }
    withSync(() => {
      painter.paintRow(sessionRow(sessionIdx), sessionRowSig(sessionIdx), () => {
        paintSessionRow(sessionIdx);
      });
    });
  };
  const repaintViewport = (): void => {
    withSync(() => {
      for (let v = 0; v < viewportSize; v++) {
        const row = headerRow() + 1 + v;
        const sessionIdx = scrollOffset + v;
        if (sessionIdx < visible.length) {
          painter.paintRow(row, sessionRowSig(sessionIdx), () => {
            paintSessionRow(sessionIdx);
          });
        } else {
          // Past the end of the visible list — emit a blank row so a
          // stale row from a prior frame doesn't linger.
          painter.paintRow(row, "blank", () => {});
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
      painter.paintRow(headerRow(), headerSig(), () => {
        paint(term, "list-header", `  ${headerLine}`);
      });
      for (let v = 0; v < viewportSize; v++) {
        const row = headerRow() + 1 + v;
        const sessionIdx = scrollOffset + v;
        if (sessionIdx < visible.length) {
          painter.paintRow(row, sessionRowSig(sessionIdx), () => {
            paintSessionRow(sessionIdx);
          });
        } else {
          painter.paintRow(row, "blank", () => {});
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
    // Tracks DECSET 1004 focus reports. Mouse clicks on the picker are
    // ignored while the terminal lacks focus so a focusing click can't
    // also select a session row.
    // Timestamp (ms) of the most recent FOCUS_IN. Terminals emit
    // FOCUS_IN before the click that caused it, so we drop every press
    // within FOCUS_GRACE_MS of a focus gain to swallow the focusing
    // click.
    let lastFocusInAt = 0;
    const FOCUS_GRACE_MS = 200;
    // Cell where the left button went down. A click only "counts" if
    // the release lands on the same cell — drag-then-release is not a
    // click. Cleared on release regardless of outcome.
    let pickerPressCell: { x: number; y: number } | null = null;
    // True when the press that armed pickerPressCell happened while
    // the terminal was unfocused / inside the focus grace window. The
    // matching release becomes "select-only" — it highlights the
    // clicked row but doesn't attach.
    let pickerPressUnfocused = false;
    // 1-based column range of the right-aligned "Esc · Go Back" hint on
    // the indicator row. Set by paintIndicator only while mode === "normal"
    // (the modes where ESC actually aborts the picker, rather than
    // cancelling a sub-mode like search/rename/confirm); cleared otherwise.
    // A click landing inside this range on the indicator row triggers the
    // same tryAbort() as pressing ESC.
    let escHitCols: { start: number; end: number } | null = null;
    let escHintHovered = false;
    // 1-based column range of the "host: …" segment in the left part of
    // the indicator row. Set by paintIndicator only while mode === "normal";
    // null when no host segment is rendered (host filter == "__all") or in
    // any sub-mode. A click cycles `nextHostFilter`; hover dims-up.
    let hostHitCols: { start: number; end: number } | null = null;
    let hostHintHovered = false;
  let tkStdinHandler: ((chunk: Buffer) => void) | null = null;
  // Assigned later (in the Promise body, after dispatch/grabInput state
  // exists) so the suspend closure can refer to the same listeners /
  // teardown bits cleanup() uses. Null on Windows (no SIGTSTP / SIGCONT).
  let suspend: (() => void) | null = null;
  // Same withdraw/reclaim pair ^Z suspend uses, exposed separately so ^X
  // (edit composer in $EDITOR) can hand the terminal to a foreground
  // child without going through an actual SIGTSTP/SIGCONT round trip.
  // Assigned unconditionally once installGrab/uninstallGrab exist —
  // unlike `suspend`, this isn't gated on signal support.
  let withdrawTerminalForChild: (() => void) | null = null;
  let reclaimTerminalFromChild: (() => void) | null = null;
  // True from withdrawTerminalForChild until reclaimTerminalFromChild —
  // guards autoRefreshTick, which otherwise keeps firing on its own timer
  // while a foreground child (the ^X $EDITOR round trip) owns the tty and
  // paints a stray picker row into it.
  let terminalWithdrawnForChild = false;
  // Forward-declared layer dispatcher. Assigned once the focus stack is
  // constructed; rawStdinHandler uses it to route synthetic key events
  // for terminal-kit's blind spots (Ctrl-_, Alt-_) straight to the
  // active layer.
  let dispatchToActiveLayer: ((name: string) => void) | null = null;
  const rawStdinHandler = (chunk: Buffer): void => {
    let text = chunk.toString("binary");
    if (text.includes(FOCUS_IN) || text.includes(FOCUS_OUT)) {
      while (true) {
        const inIdx = text.indexOf(FOCUS_IN);
        const outIdx = text.indexOf(FOCUS_OUT);
        const which =
          inIdx === -1 ? outIdx :
          outIdx === -1 ? inIdx :
          Math.min(inIdx, outIdx);
        if (which === -1) {
          break;
        }
        const wasFocused = terminalFocused;
        terminalFocused = which === inIdx;
        if (terminalFocused) {
          lastFocusInAt = Date.now();
        }
        if (
          wasFocused !== terminalFocused &&
          !resolved &&
          focusStackRef.length <= 1
        ) {
          withSync(() => {
            repaintComposerChrome();
            repaintViewport();
          });
        }
        text = text.slice(0, which) + text.slice(which + FOCUS_IN.length);
      }
      if (text.length === 0) {
        return;
      }
    }
    // ^Z (SUB, 0x1a) — raw mode swallowed VSUSP. Only the bare byte
    // counts; embedded 0x1a inside a longer chunk is treated as data.
    if (!pasteActive && text === "\x1a" && suspend) {
      suspend();
      return;
    }
    // Ctrl-_ (== Ctrl-/, byte 0x1f) and Alt-_ (\x1b_ or \x1b\x1f) —
    // terminal-kit doesn't name these, so route them to the active
    // layer as synthetic key events with the raw byte as the name. The
    // layers' onKey handlers match on those strings.
    if (
      !pasteActive &&
      (text === "\x1f" || text === "\x1b_" || text === "\x1b\x1f")
    ) {
      dispatchToActiveLayer?.(text);
      return;
    }
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
      if (findLayerActive) {
        if (findSubMode === "input" && !findInFlight) {
          feedFindPaste(pasted);
        }
      } else if (selectedIdx === 0 && !searchActive) {
        const effects = composer.feed({ type: "paste", text: pasted });
        // Empty bracketed paste (wezterm's ctrl+shift+v on an image-only
        // clipboard) surfaces as an attachment-request — read the
        // clipboard and attach any image found.
        for (const effect of effects) {
          if (effect.type === "attachment-request") {
            void ingestClipboardAttachment();
          }
        }
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
    let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
    let autoRefreshInFlight = false;
    // AbortController tied to the in-flight refresh. Allows the picker
    // teardown (cleanup) and a fresh keystroke-driven refresh to cancel
    // a stuck listSessions before starting a new one.
    let autoRefreshAbort: AbortController | null = null;
    // Guards the on-demand agent sync (`s`). Sync spawns a fresh process
    // per installed agent and can run for several seconds; the guard
    // keeps repeated `s` presses from launching overlapping syncs.
    let syncInFlight = false;

    // ── Focus stack ────────────────────────────────────────────────────
    // Each interactive layer (picker, find, modals) is a FocusLayer.
    // All terminal key/resize events route through the top of the stack.
    // pop() restores the layer below and calls its onResize so the screen
    // reflects whatever was behind the layer that just closed.
    const focusStack: FocusLayer[] = focusStackRef;
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

    // Build a "new" PickerResult, always reporting the picker's
    // current cwd so the caller's launch path uses the same path the
    // composer title is showing — no opts.cwd vs currentCwd skew.
    const makeNewResult = (): {
      kind: "new";
      prompt?: string;
      cwd?: string;
      attachments?: Attachment[];
      installStatus?: InstallStatusLine;
      agentId?: string;
      model?: string;
    } => {
      const out: {
        kind: "new";
        prompt?: string;
        cwd?: string;
        attachments?: Attachment[];
        installStatus?: InstallStatusLine;
        agentId?: string;
        model?: string;
      } = { kind: "new", cwd: currentCwd };
      const attached = composer.state().attachments;
      if (attached.length > 0) {
        out.attachments = [...attached];
      }
      if (composerAgentId) {
        out.agentId = composerAgentId;
      }
      if (composerModel) {
        out.model = composerModel;
      }
      return out;
    };

    // Re-derive the composer's agent•model from the directory we just
    // moved to. Both are assigned together when the caller resolves an
    // agent: switching from a tree that names a model to one that does
    // not has to clear the stale model, not keep painting it.
    const refreshComposerAgentForCwd = async (): Promise<void> => {
      if (composerAgentExplicit || !opts.onCwdChange) {
        return;
      }
      try {
        const next = await opts.onCwdChange(currentCwd);
        if (next.agentId !== undefined) {
          composerAgentId = next.agentId;
          composerModel = next.model;
        }
        if (next.notice !== undefined) {
          transientStatus = next.notice;
        }
      } catch {
        // Keep the previous label rather than blanking it: a failed
        // re-resolve is not evidence that there is no agent.
      }
    };

    // ^O opens a directory prompt. On accept, currentCwd updates and the
    // composer title + cwd-only filter + agent•model label follow. On
    // Esc, cwd is unchanged. The prompt manages its own grabInput / key
    // listeners, so we have to detach the picker's grab while it runs
    // and re-attach after.
    const openCwdPrompt = async (): Promise<void> => {
      uninstallGrab();
      painter.clearCache();
      // Layer the modal on top of the picker frame — no eraseDisplayBelow,
      // the picker's rows stay visible around the box.
      const cwdLayer: FocusLayer = { onKey: () => {}, onResize: () => {} };
      pushLayer(cwdLayer);
      let result;
      try {
        result = await promptForImportCwd(term, undefined, {
          defaultCwd: currentCwd,
          title: "Change cwd",
          intro: "New cwd for the picker and any new sessions:",
          overlay: true,
        });
      } finally {
        popLayer();
        installGrab();
      }
      if (result.kind === "ok" && result.path !== currentCwd) {
        currentCwd = result.path;
        // Re-sort so the cwd-priority bump in sortSessions follows the new
        // cwd, then re-run filters (cwd-only depends on currentCwd too).
        allSessions = sortSessions(allSessions, currentCwd);
        applyFilter();
        await refreshComposerAgentForCwd();
      }
      if (!resolved) {
        renderFromScratch();
      }
    };
    // Sibling to openCwdPrompt: opened by clicking the composer's
    // top-right "agent•model" label. Runs the standard promptForAgent
    // modal, updates composerAgentId + composerModel on select, and
    // re-renders. No-op if the caller didn't pass availableAgents (no
    // list → no modal to show).
    const openAgentPrompt = async (): Promise<void> => {
      const agents = opts.availableAgents;
      if (!agents || agents.length === 0) {
        return;
      }
      uninstallGrab();
      painter.clearCache();
      const agentLayer: FocusLayer = { onKey: () => {}, onResize: () => {} };
      pushLayer(agentLayer);
      let result;
      try {
        result = await promptForAgent(term, agents, composerAgentId, {
          title: "Switch agent",
          intro: "Agent used when the composer creates a new session:",
          overlay: true,
        });
      } finally {
        popLayer();
        installGrab();
      }
      if (result.kind === "select") {
        composerAgentId = result.agentId;
        // Deliberate, in-picker choice: from here on ^O leaves the label
        // alone rather than replacing it with a directory default.
        composerAgentExplicit = true;
        // When the agent changes, the model tracks whatever's configured
        // as the default for the new agent (or clears if none). If the
        // user wants a specific model, `hydra agent set <id> <model>`
        // still owns that persistence. Inheritance-aware: a derived agent
        // (`extends: "claude-acp"`) with no default of its own falls back
        // to its base's, mirroring ensureAgentForNew's lookup in app.ts.
        const chosenAgentEntry = agents.find((a) => a.id === result.agentId);
        composerModel = lookupInheritedAgentValue(opts.config.sessionDefaults, {
          id: result.agentId,
          extendsChain: chosenAgentEntry?.extendsChain,
        })?.value.model;
        opts.onComposerAgentChange?.(composerAgentId, composerModel);
        if (result.persist) {
          // Mirror ensureAgentForNew's persistence behavior: the `s`
          // affordance in promptForAgent records the user's choice as
          // config.defaultAgent. Best-effort — the picker still resolves
          // with the chosen agent even if the config write fails.
          try {
            await setDefaultAgent(result.agentId);
          } catch {
            // ignore
          }
        }
      }
      if (!resolved) {
        renderFromScratch();
      }
    };
    exitFind = (): void => {
      persistFind();
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
      findLayerActive = false;
      popLayer(); // restores picker layer → renderFromScratch
    };
    // Chord support (Ctrl+X Ctrl+E, …) shared with runModalPrompt via
    // RAW_KEY_CHORD_TABLE — see chord.ts. Sits ahead of the focus stack so
    // every layer (composer, findComposer, cwd/agent sub-prompts) gets it
    // uniformly instead of each reinventing it.
    const chordMatcher = new ChordMatcher<string>(RAW_KEY_CHORD_TABLE);
    const dispatch = (
      name: string,
      _matches: unknown,
      data?: { isCharacter?: boolean },
    ): void => {
      resetAutoRefresh();
      if (data?.isCharacter) {
        // A stray chord prefix must not eat the character typed right
        // after it.
        chordMatcher.clear();
        focusStack[focusStack.length - 1]?.onKey(name, _matches, data);
        return;
      }
      const result = chordMatcher.feed(name);
      switch (result.kind) {
        case "pass":
          focusStack[focusStack.length - 1]?.onKey(result.token, _matches, data);
          return;
        case "armed":
        case "aborted":
          return;
      }
    };
    const dispatchResize = (): void => {
      if (resolved) return;
      focusStack[focusStack.length - 1]?.onResize();
    };
    // Now that focusStack and resolved exist, expose a dispatcher to
    // rawStdinHandler for the synthetic Ctrl-_ / Alt-_ events.
    dispatchToActiveLayer = (name: string): void => {
      if (resolved) return;
      // Bypasses dispatch()/chordMatcher entirely — clear any pending
      // chord so a stray Ctrl-_/Alt-_ right after a prefix key can't
      // later be misread as completing it.
      chordMatcher.clear();
      focusStack[focusStack.length - 1]?.onKey(name, null, {});
    };

    // Every OS-/terminal-side listener and grab this picker owns. Runs
    // idempotently: safe to call from both cleanup() (normal resolve)
    // and makePickerInstallStatus() (deferred-cleanup resolve, where we
    // keep the visible frame but must still detach input so keystrokes
    // during the install window don't stack `rawStdinHandler`s across
    // successive pickSession invocations — each leaked handler forwards
    // every byte to termkit, so N leaks means the current picker's
    // dispatch fires N times per keypress).
    let inputDetached = false;
    const detachInput = (): void => {
      if (inputDetached) {
        return;
      }
      inputDetached = true;
      focusStack.length = 0;
      if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
      }
      if (autoRefreshAbort) {
        autoRefreshAbort.abort();
        autoRefreshAbort = null;
        autoRefreshInFlight = false;
      }
      term.off("key", dispatch);
      term.off("mouse", onMouse);
      term.off("resize", dispatchResize);
      writeControl(BRACKETED_PASTE_OFF);
      writeControl(FOCUS_TRACK_OFF);
      const tClean = term as unknown as { stdin: NodeJS.ReadableStream };
      if (tClean.stdin && tkStdinHandler) {
        tClean.stdin.removeListener("data", rawStdinHandler);
        tClean.stdin.on("data", tkStdinHandler);
        tkStdinHandler = null;
      }
      pasteActive = false;
      pasteBuffer = "";
      term.grabInput(false);
      writeDebugLine({ src: "grab", site: "picker.detachInput", on: false });
    };
    const cleanup = (): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      detachInput();
      // Terminate the visible frame: park the cursor just below the
      // picker so subsequent stdout writes (or the outer flow's own
      // paint) don't overwrite our last row.
      term.hideCursor(false);
      term.moveTo(1, indicatorRow() + 1);
      term("\n");
    };
    // One tick of the low-frequency background refresh. Skipped while a
    // modal/find layer, prompt, or search is up (so we don't trample a
    // partial buffer) and while a prior refresh is still pending.
    const autoRefreshTick = (): void => {
      if (
        resolved ||
        focusStack.length > 1 ||
        mode !== "normal" ||
        searchActive ||
        syncInFlight ||
        terminalWithdrawnForChild
      ) {
        return;
      }
      if (autoRefreshInFlight && autoRefreshAbort) {
        // A prior refresh is stuck — cancel it before issuing a new one
        // so an unresponsive daemon can't latch the in-flight flag.
        autoRefreshAbort.abort();
        autoRefreshAbort = null;
        autoRefreshInFlight = false;
      }
      const currentId =
        selectedIdx > 0 ? visible[selectedIdx - 1]?.sessionId : undefined;
      autoRefreshInFlight = true;
      const controller = new AbortController();
      autoRefreshAbort = controller;
      void refresh(currentId, { silent: true, signal: controller.signal }).finally(() => {
        if (autoRefreshAbort === controller) {
          autoRefreshAbort = null;
        }
        autoRefreshInFlight = false;
      });
    };
    // Restart the 3s countdown. Called on every keypress so a silent
    // refresh (which re-sorts `visible`) can only fire after 3s of
    // keyboard idle — never landing a resort between a navigation key and
    // the Enter that selects a row, which previously let the cursor's
    // session shift out from under the user.
    const resetAutoRefresh = (): void => {
      if (resolved) {
        return;
      }
      if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
      }
      autoRefreshTimer = setInterval(autoRefreshTick, 3000);
    };
    // Build an InstallStatusLine that paints into the picker's composer-
    // adjacent status row and defers the terminal cleanup until finalize().
    // Called on the "new"-selection paths so the launch label /
    // agent-install progress lands in the visible picker frame instead
    // of the pre-alt-screen stdout gap.
    //
    // Contract: caller MUST call .finalize() exactly once — that's what
    // actually tears down input handlers, releases the terminal grab,
    // and moves the cursor below the picker. Missing that call leaves
    // the picker painted but frozen.
    const makePickerInstallStatus = (): InstallStatusLine => {
      // Full input teardown up front — including the raw stdin data
      // listener and the terminal grab. Without this, a stacked
      // rawStdinHandler from each prior deferred-cleanup pickSession
      // would forward every keystroke through termkit N times, so the
      // next picker's dispatch would fire N times per press (repro:
      // start session → back to picker → start session → back to picker,
      // then observe arrow keys moving the cursor by N rows). The
      // visible frame is preserved because we skip the terminating
      // cursor-move + newline; those run later inside finalize().
      detachInput();
      const sink: InstallStatusSink = {
        write(text) {
          installStatusText = text;
          repaintComposerStatus();
        },
        finalize() {
          installStatusText = null;
          // Do NOT repaint the status row here — the row is about to be
          // wiped by the alt-screen switch anyway, and repainting a
          // now-null status could race the caller's next terminal write.
          cleanup();
        },
      };
      return createInstallStatusLine("", sink);
    };

    // Abort returns the user to the session they opened the picker from.
    // If that session was killed/deleted in this picker session there's
    // nothing live to return to, so we resolve with `exit` instead — the
    // caller treats that as "exit hydra entirely" rather than re-attaching
    // to a session that no longer exists. Returns true if handled.
    const tryAbort = (): boolean => {
      cleanup();
      resolve({ kind: currentSessionGone ? "exit" : "abort" });
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
            `${r.session}|${r.upstream}|${r.host}|${r.state}|${r.agent}|${r.model}|${r.age}|${r.title}|${r.cwd}|${r.cost}`,
        )
        .join("\n");
      return `${selectedIdx}:${scrollOffset}:${transientStatus ?? ""}\n${cells}`;
    };
    // Merge a listSessionsPage() response into allSessions and advance
    // sessionCursor. See mergeSessionListPage (discovery.ts) for the
    // incremental-merge contract.
    const applySessionPage = (
      page: { sessions: DiscoveredSession[]; removed: string[]; cursor: number },
      incremental: boolean,
    ): void => {
      allSessions = sortSessions(
        mergeSessionListPage(allSessions, page, incremental),
        currentCwd,
      );
      sessionCursor = page.cursor;
    };
    const refresh = async (
      preferredId?: string,
      refreshOpts: { silent?: boolean; signal?: AbortSignal } = {},
    ): Promise<void> => {
      try {
        const beforeKey = refreshOpts.silent ? renderFingerprint() : "";
        const beforeTotal = total;
        const incremental = sessionCursor !== undefined;
        const page = await listSessionsPage(opts.target, {
          includeNonInteractive: true,
          since: sessionCursor,
          signal: refreshOpts.signal,
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
        applySessionPage(page, incremental);
        applyFilter();
        if (followId !== undefined) {
          const idx = visible.findIndex((s) => s.sessionId === followId);
          if (idx >= 0) {
            selectedIdx = idx + 1;
          } else {
            // The session under the cursor is gone after the resort.
            // Don't leave selectedIdx pointing at its old numeric slot —
            // that now aliases onto whatever session slid into that
            // position, so Enter would pick the wrong one. Fall back to
            // the composer ("New session"), a predictable, safe landing.
            selectedIdx = 0;
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
        renameEditor = null;
        await refresh(session.sessionId);
      } catch (err) {
        mode = "normal";
        pendingAction = null;
        renameEditor = null;
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
    // Toggle the user-set priority on a session. With the picker only
    // distinguishing normal (0) and high (1) for now, we flip between
    // those two values; the on-disk schema accepts any positive integer
    // so a future "very high" tier would slot in without a migration.
    // Mutates the in-memory `visible`/`allSessions` rows immediately so
    // the row re-sorts on the next paint without waiting for the auto-
    // refresh round-trip; the daemon write is fire-and-forget.
    const performTogglePriority = async (
      session: DiscoveredSession,
    ): Promise<void> => {
      const current = session.priority && session.priority > 0 ? session.priority : 0;
      const next: number | null = current > 0 ? null : 1;
      const nextValue = next ?? 0;
      // Mutate the loaded source rows so subsequent applyFilter sorts
      // pick up the new value. visible is rebuilt from allSessions in
      // applyPrefsFilters, so updating the entry in allSessions is enough.
      for (const row of allSessions) {
        if (row.sessionId === session.sessionId) {
          row.priority = nextValue > 0 ? nextValue : undefined;
        }
      }
      const keepId = session.sessionId;
      allSessions = sortSessions(allSessions, currentCwd);
          applyFilter();
          if (keepId !== undefined) {
            restoreCursorAfterFilter(keepId);
          }
          renderFromScratch();
      transientStatus = nextValue > 0 ? "priority: high" : "priority: normal";
      paintIndicator();
      try {
        await setSessionPriority(opts.target, session.sessionId, next);
      } catch (err) {
        transientStatus = `priority failed: ${(err as Error).message}`;
        paintIndicator();
      }
    };
    // On-demand agent sync (the `s` keystroke). Spawns each installed
    // agent transiently to pull in sessions it remembers, then refreshes
    // the list so freshly-imported rows (with their agent-generated
    // titles) appear. Shows a transient status throughout since the
    // round-trip can take a few seconds per agent.
    const performSync = async (): Promise<void> => {
      if (syncInFlight) {
        return;
      }
      syncInFlight = true;
      const currentId =
        selectedIdx > 0 ? visible[selectedIdx - 1]?.sessionId : undefined;
      transientStatus = "syncing agents…";
      paintIndicator();
      try {
        const { synced, skipped, agents } = await syncInstalledAgents(
          opts.target,
        );
        await refresh(currentId);
        transientStatus = `synced ${synced} new (${skipped} known) from ${agents} agent${agents === 1 ? "" : "s"}`;
        paintIndicator();
      } catch (err) {
        transientStatus = `sync failed: ${(err as Error).message}`;
        paintIndicator();
      } finally {
        syncInFlight = false;
      }
    };
    // Hand the selected session to the terminal host, rather than switching
    // this pane to it. The daemon owns the session and multi-client attach
    // is the normal path, so both panes are first-class views of the same
    // session — nothing is "moved".
    //
    // Jumps to the pane already showing it when there is one. Without that,
    // the natural way to use this key — pick a session, come back, pick it
    // again — silently accumulates duplicate tabs on one session, and the
    // duplicates are indistinguishable from each other in the tab bar.
    //
    // Deliberately leaves the picker open so several sessions can be fanned
    // out in a row.
    let openTabInFlight = false;
    const performOpenInNewTab = async (
      session: DiscoveredSession,
    ): Promise<void> => {
      if (openTabInFlight) {
        return;
      }
      openTabInFlight = true;
      const label = session.title?.trim() || stripHydraSessionPrefix(session.sessionId);
      transientStatus = canReveal()
        ? `showing ${label} in ${hostName()}…`
        : `opening ${label} in a new ${hostName()} tab…`;
      paintIndicator();
      try {
        const result = await revealOrOpen({
          kind: "attach",
          sessionId: session.sessionId,
          title: session.title,
          cwd: session.cwd,
        });
        transientStatus =
          result.outcome === "revealed"
            ? `jumped to ${label} — already open in ${hostName()}`
            : result.outcome === "opened"
              ? `opened ${label} in a new ${hostName()} tab`
              : `new tab failed: ${result.error ?? "unknown error"}`;
      } catch (err) {
        transientStatus = `new tab failed: ${(err as Error).message}`;
      } finally {
        openTabInFlight = false;
        paintIndicator();
      }
    };
    // ^t from the composer: a brand-new session in a new tab.
    //
    // Shares openTabInFlight with the session path above — one ^t, one
    // tab, whichever flavour.
    //
    // Whatever is typed in the composer rides along as --prompt and fires
    // as the new session's first turn, so this really is "Enter, but in
    // another tab". The cwd, agent and model the composer has selected go
    // too.
    //
    // ATTACHMENTS DO NOT. They're in-memory image bytes with nowhere to go
    // on an argv, so rather than dropping them silently the status line
    // says so and they stay in this composer.
    //
    // The picker stays open either way — this pane is not going anywhere.
    // But the text IS cleared on success, for the same reason Enter clears
    // it: it has been sent. Leaving it would invite sending it twice, once
    // per tab.
    const performNewInNewTab = async (): Promise<void> => {
      if (openTabInFlight) {
        return;
      }
      openTabInFlight = true;
      const text = composer.expandedText();
      // Snapshotted rather than read back after the await: state() aliases
      // the dispatcher's live array, and setBuffer below replaces it.
      const keptAttachments = [...composer.state().attachments];
      const dropped = keptAttachments.length;
      transientStatus = `opening a new session in a new ${hostName()} tab…`;
      paintIndicator();
      try {
        const result = await openInNewTab({
          kind: "new",
          cwd: currentCwd,
          agentId: composerAgentId,
          model: composerModel,
          prompt: text,
        });
        if (result.ok) {
          if (text.trim().length > 0) {
            composer.setBuffer("", keptAttachments);
          }
          transientStatus =
            dropped > 0
              ? `opened a new ${hostName()} tab — ${dropped} attachment${dropped === 1 ? "" : "s"} stayed here`
              : `opened a new session in a new ${hostName()} tab`;
        } else {
          transientStatus = `new tab failed: ${result.error ?? "unknown error"}`;
        }
      } catch (err) {
        transientStatus = `new tab failed: ${(err as Error).message}`;
      } finally {
        openTabInFlight = false;
        renderFromScratch();
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
        // For delete: follow the next visible neighbor so the cursor
        // stays at the deleted row's slot (occupied by whichever session
        // shifts up). Falls back to the previous neighbor at the tail.
        // Without this, refresh's default followId picks up the
        // now-deleted session's id, fails to find it, and snaps the
        // selection back to the composer.
        let followId: string | undefined;
        if (kind === "kill") {
          followId = session.sessionId;
        } else {
          const idx = visible.findIndex(
            (s) => s.sessionId === session.sessionId,
          );
          if (idx >= 0) {
            followId =
              visible[idx + 1]?.sessionId ?? visible[idx - 1]?.sessionId;
          }
        }
        await refresh(followId);
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
      selectedIdx = next;
      adjustScroll();
      // Always repaint the whole viewport rather than a targeted two-row
      // swap. The swap relied on repaintSessionRow for both the old and new
      // rows, but repaintSessionRow silently no-ops when a row falls outside
      // the current window — which left the old highlight painted as a
      // "ghost" alongside the live one. A full viewport paint is atomic
      // (one DEC 2026 frame) and only writes viewportSize rows, so it's
      // cheap and always consistent.
      withSync(() => {
        repaintViewport();
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
      // A click dismisses too — the sheet says "press any key", and a
      // mouse is the other way a user says "done reading". Release-only
      // so the press that opened something else can't close it instantly.
      let pressed = false;
      pushLayer({
        onKey: (name) => {
          if (name === "CTRL_C") {
            cleanup();
            resolve({ kind: "abort" });
            return;
          }
          popLayer(); // restores picker layer → calls renderFromScratch
        },
        onMouse: (name) => {
          if (name === "MOUSE_LEFT_BUTTON_PRESSED") {
            pressed = true;
            return;
          }
          if (name !== "MOUSE_LEFT_BUTTON_RELEASED" || !pressed) {
            return;
          }
          pressed = false;
          popLayer();
        },
        onResize: () => renderHelp(),
      });
    };
    const openInfoLayer = (session: DiscoveredSession): void => {
      let lines: string[] | null = null;
      let error: string | null = null;
      let loading = true;
      let infoScroll = 0;
      // Box geometry from the last paint, so the mouse handler can tell
      // an inside click from an outside one. Null until first render.
      let infoBox: { x: number; y: number; w: number; h: number } | null = null;
      // Rows of body actually painted last frame — the wheel scroll clamp
      // needs the same number renderInfo used.
      let infoBodyRows = 0;

      // Rendered as an overlay box (drawBox({overlay:true})) rather than
      // a full-screen wipe, so whatever you opened it from — the picker
      // list or the ^F results — stays visible around the edges and is
      // still there when you Esc out.
      const infoBody = (): string[] => {
        if (loading) {
          return ["loading…"];
        }
        if (error !== null) {
          return [error];
        }
        return lines ?? [];
      };
      const renderInfo = (): void => {
        withSync(() => {
          term.hideCursor();
          painter.clearCache();
          const body = infoBody();
          const termH = readTermHeight(term);
          const termW = readTermWidth(term);
          // +1 for the footer hint row. Cap so drawBox's own clamp never
          // silently eats content rows we counted on.
          const maxBody = Math.max(3, termH - 6);
          const bodyRows = Math.min(body.length, maxBody);
          const widest = body.reduce((m, l) => Math.max(m, l.length), 0);
          const contentWidth = Math.min(
            Math.max(40, widest + 2),
            Math.max(20, termW - 6),
          );
          const layout = drawBox(term, {
            contentHeight: bodyRows + 2,
            contentWidth,
            title: `Session info — ${stripHydraSessionPrefix(session.sessionId)}`,
            overlay: true,
          });
          infoBox = { x: layout.x, y: layout.y, w: layout.w, h: layout.h };
          infoBodyRows = bodyRows;
          infoScroll = Math.max(
            0,
            Math.min(infoScroll, Math.max(0, body.length - bodyRows)),
          );
          for (let i = 0; i < bodyRows; i++) {
            const line = body[infoScroll + i] ?? "";
            term.moveTo(layout.contentX, layout.contentY + i);
            const slice = line.slice(0, layout.contentW - 1);
            if (error !== null) {
              paint(term, "modal-error", ` ${slice}`);
            } else {
              paint(term, "content", ` ${slice}`);
            }
            term.styleReset();
          }
          const more = body.length - bodyRows - infoScroll;
          const hint =
            body.length > bodyRows
              ? `↑/↓/wheel scroll${more > 0 ? ` (${more} more)` : ""} · Esc or click outside to return`
              : "Esc or click outside to return";
          term.moveTo(layout.contentX, layout.contentY + bodyRows + 1);
          paint(term, "modal-hint", ` ${hint}`);
          term.styleReset();
        });
      };

      renderInfo();
      // Cancellation tied to the info layer's lifetime. On Esc / ^C we
      // abort the in-flight export fetch so a stuck daemon doesn't keep
      // the picker pinned waiting for the response.
      const infoAbort = new AbortController();
      const closeInfo = (): void => {
        infoAbort.abort();
        popLayer();
      };
      // Shared by the keyboard and the wheel. Clamped against the body
      // length so the last line can't scroll past the bottom of the box.
      const scrollInfo = (delta: number): void => {
        const max = Math.max(0, infoBody().length - infoBodyRows);
        const next = Math.max(0, Math.min(max, infoScroll + delta));
        if (next === infoScroll) {
          return;
        }
        infoScroll = next;
        renderInfo();
      };
      const infoLayer: FocusLayer = {
        onKey: (name) => {
          if (name === "ESCAPE" || name === "CTRL_C") {
            closeInfo();
            return;
          }
          if (name === "UP") {
            scrollInfo(-1);
            return;
          }
          if (name === "DOWN") {
            scrollInfo(1);
            return;
          }
          if (name === "PAGE_UP") {
            scrollInfo(-Math.max(1, infoBodyRows - 1));
            return;
          }
          if (name === "PAGE_DOWN") {
            scrollInfo(Math.max(1, infoBodyRows - 1));
            return;
          }
          if (name === "HOME") {
            scrollInfo(-Number.MAX_SAFE_INTEGER);
            return;
          }
          if (name === "END") {
            scrollInfo(Number.MAX_SAFE_INTEGER);
            return;
          }
        },
        onMouse: (name, data) => {
          if (name === "MOUSE_WHEEL_UP") {
            scrollInfo(-3);
            return;
          }
          if (name === "MOUSE_WHEEL_DOWN") {
            scrollInfo(3);
            return;
          }
          // Click-outside-to-dismiss. Fires on release so a press that
          // drags into the box doesn't close it, and so the click that
          // refocuses the terminal doesn't count.
          if (name !== "MOUSE_LEFT_BUTTON_RELEASED" || infoBox === null) {
            return;
          }
          const x = data?.x ?? -1;
          const y = data?.y ?? -1;
          const inside =
            x >= infoBox.x &&
            x < infoBox.x + infoBox.w &&
            y >= infoBox.y &&
            y < infoBox.y + infoBox.h;
          if (!inside) {
            closeInfo();
          }
        },
        onResize: () => renderInfo(),
      };
      pushLayer(infoLayer);

      void (async () => {
        try {
          const resp = await fetchWithTimeout(
            `${opts.target.baseUrl}/v1/sessions/${encodeURIComponent(session.sessionId)}/export`,
            {
              headers: { Authorization: `Bearer ${opts.target.token}` },
              signal: infoAbort.signal,
            },
          );
          if (!resp.ok) {
            throw new Error(`daemon returned HTTP ${resp.status}`);
          }
          const raw = await resp.json();
          const bundle = decodeBundle(raw);
          const data = aggregateSessionInfo(bundle, session.status);
          const text = formatSessionInfoSummary(data, false);
          lines = text.replace(/\n$/, "").split("\n");
        } catch (err) {
          if (infoAbort.signal.aborted) {
            return;
          }
          error = `failed to load info: ${(err as Error).message}`;
        } finally {
          loading = false;
          // Only paint if the info layer is still on top and the picker
          // hasn't resolved — otherwise we'd clobber whatever replaced it.
          if (!resolved && focusStack[focusStack.length - 1] === infoLayer) {
            renderInfo();
          }
        }
      })();
    };

    const openFindLayer = (): void => {
      if (visible.length === 0) {
        transientStatus = "no sessions to search";
        paintIndicator();
        return;
      }
      findComposer = new InputDispatcher({
        history: [],
        collapsePastes: false,
      });
      // Restore the previous search if there is one. Results are only
      // reusable when they're still in `visible` — a filter change or a
      // kill since the last search can retire rows out from under us, so
      // drop any hit that no longer has a session behind it.
      const saved = prefs.lastFind;
      const stillVisible = new Set(visible.map((s) => s.sessionId));
      const restored = saved
        ? saved.results.filter((h) => stillVisible.has(h.sessionId))
        : [];
      if (saved && saved.query.length > 0) {
        findComposer.setBuffer(saved.query);
      }
      findResults = restored;
      rebuildFindRows();
      findTruncated = saved?.truncated ?? false;
      findSelectedIdx = Math.min(
        Math.max(0, saved?.selectedIdx ?? 0),
        Math.max(0, restored.length - 1),
      );
      findSnippetIdx = 0;
      findScrollOffset = 0;
      findError = null;
      findInFlight = false;
      // Land straight on the results when we have some — the user came
      // back to keep browsing, not to retype the query. ^F or ↑ from the
      // top of the list gets back to the input box.
      findSubMode = restored.length > 0 ? "results" : "input";
      findLayerActive = true;
      computeFindBoxLayout();
      adjustFindScroll();
      renderFind();

      // Open the currently-selected hit. Shared by Enter and by a click
      // on an already-selected row, so the two can't drift apart.
      const openFindHit = (): void => {
        const hit = findResults[findSelectedIdx];
        if (!hit) {
          return;
        }
        const session = visible.find((s) => s.sessionId === hit.sessionId);
        // remote wins over importedFromMachine — see app.ts's
        // isImportedFirstLaunch for why a federated entry can carry
        // both and must never be treated as a local-import candidate.
        const isImportedPassive =
          !!session?.importedFromMachine &&
          !session.remote &&
          !session.upstreamSessionId;
        // Snippet currently shown for this hit (cycled by n/p, LEFT/RIGHT) —
        // its recordedAt is what the attach jumps to.
        const jumpToRecordedAt =
          hit.snippets[findSnippetIdx]?.recordedAt ?? hit.snippets[0]?.recordedAt;
        if (isImportedPassive) {
          persistFind();
          cleanup();
          const result: PickerResult = {
            kind: "attach",
            sessionId: hit.sessionId,
          };
          if (session.agentId !== undefined) {
            result.agentId = session.agentId;
          }
          if (jumpToRecordedAt !== undefined) {
            result.jumpToRecordedAt = jumpToRecordedAt;
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
            persistFind();
            cleanup();
            resolve({ kind: "abort" });
            return;
          }
          // No re-attach needed — focus.pop() inside promptForLaunchOrView restores the find layer
          if (action === "back") return;
          persistFind();
          cleanup();
          const result: PickerResult = {
            kind: "attach",
            sessionId: hit.sessionId,
            readonly: action === "view",
          };
          if (session?.agentId !== undefined) {
            result.agentId = session.agentId;
          }
          if (jumpToRecordedAt !== undefined) {
            result.jumpToRecordedAt = jumpToRecordedAt;
          }
          resolve(result);
        })();
      };

      // Move the results cursor to `idx`, repainting only what changed.
      // Shared by keyboard navigation and by mouse hover / click.
      const selectFindIdx = (idx: number): void => {
        if (idx < 0 || idx >= findResults.length || idx === findSelectedIdx) {
          return;
        }
        const oldIdx = findSelectedIdx;
        const oldScroll = findScrollOffset;
        findSelectedIdx = idx;
        findSnippetIdx = 0;
        adjustFindScroll();
        if (findScrollOffset !== oldScroll) {
          repaintFindViewport();
        } else {
          withSync(() => {
            repaintFindResult(oldIdx, false);
            repaintFindResult(findSelectedIdx, true);
          });
        }
        repaintFindIndicatorRow();
      };

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
          // state() aliases the live buffer — snapshot before feeding.
          const beforeState = findComposer.state();
          const beforeBuffer = [...beforeState.buffer];
          const beforeRow = beforeState.row;
          const beforeCol = beforeState.col;
          let event: KeyEvent | null = null;
          if (name === "\x1f") {
            event = { type: "key", name: "ctrl-underscore" };
          } else if (name === "\x1b_" || name === "\x1b\x1f") {
            event = { type: "key", name: "alt-underscore" };
          } else if (data?.isCharacter) {
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
            beforeBuffer.length === after.buffer.length &&
            beforeBuffer.every((l, i) => l === after.buffer[i]) &&
            beforeRow === after.row &&
            beforeCol === after.col;
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
            openFindHit();
            return;
          }
          // `i` mirrors the main picker's info key. The find layer stays
          // on the stack underneath, so Esc out of the info overlay lands
          // back on the results with the selection intact.
          if (data?.isCharacter && name === "i") {
            const hit = findResults[findSelectedIdx];
            if (!hit) {
              return;
            }
            const session = visible.find((s) => s.sessionId === hit.sessionId);
            if (!session) {
              return;
            }
            openInfoLayer(session);
            return;
          }
          // Shared by n/p and LEFT/RIGHT — both cycle the snippet shown
          // for the selected hit, LEFT/RIGHT just spare the pinky reach.
          const cycleFindSnippet = (delta: number): void => {
            const hit = findResults[findSelectedIdx];
            if (!hit || hit.snippets.length <= 1) {
              return;
            }
            findSnippetIdx =
              (findSnippetIdx + delta + hit.snippets.length) %
              hit.snippets.length;
            repaintFindResult(findSelectedIdx, true);
          };
          if (data?.isCharacter && (name === "n" || name === "N")) {
            cycleFindSnippet(1);
            return;
          }
          if (data?.isCharacter && (name === "p" || name === "P")) {
            cycleFindSnippet(-1);
            return;
          }
          if (name === "LEFT") {
            cycleFindSnippet(-1);
            return;
          }
          if (name === "RIGHT") {
            cycleFindSnippet(1);
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
            selectFindIdx(
              Math.min(
                findResults.length - 1,
                Math.max(0, findSelectedIdx + delta),
              ),
            );
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

      // Each result occupies two screen rows (identity + snippet); both
      // map to the same hit. Returns null for anything outside the list.
      const findIdxAtRow = (y: number): number | null => {
        const first = findResultsStartRow();
        const last = first + findViewportSize() * 2 - 1;
        if (y < first || y > last) {
          return null;
        }
        const idx = findScrollOffset + Math.floor((y - first) / 2);
        return idx >= 0 && idx < findResults.length ? idx : null;
      };

      // Press cell for the find layer, kept separate from the picker's
      // own (the picker never sees these events). A click is a release
      // on the same cell as the press.
      let findPressCell: { x: number; y: number } | null = null;

      const findOnMouse = (
        name: string,
        data?: { x?: number; y?: number },
      ): void => {
        if (findInFlight) {
          return;
        }
        if (name === "MOUSE_WHEEL_UP" || name === "MOUSE_WHEEL_DOWN") {
          if (findResults.length === 0) {
            return;
          }
          const delta = name === "MOUSE_WHEEL_UP" ? -3 : 3;
          const max = Math.max(0, findResults.length - findViewportSize());
          const next = Math.min(max, Math.max(0, findScrollOffset + delta));
          if (next === findScrollOffset) {
            return;
          }
          findScrollOffset = next;
          // Keep the cursor inside the window, matching the main list's
          // wheel behavior — scrolling shouldn't strand the selection
          // off-screen.
          if (findSelectedIdx < findScrollOffset) {
            findSelectedIdx = findScrollOffset;
            findSnippetIdx = 0;
          } else if (findSelectedIdx >= findScrollOffset + findViewportSize()) {
            findSelectedIdx = findScrollOffset + findViewportSize() - 1;
            findSnippetIdx = 0;
          }
          repaintFindViewport();
          repaintFindIndicatorRow();
          return;
        }
        if (name === "MOUSE_LEFT_BUTTON_PRESSED") {
          findPressCell = { x: data?.x ?? -1, y: data?.y ?? -1 };
          return;
        }
        const y = data?.y;
        if (typeof y !== "number") {
          return;
        }
        if (name === "MOUSE_MOTION") {
          // Hover tracks the selection only while the list already has
          // focus — same rule as the main picker, so a mouse trip across
          // the results on the way somewhere else doesn't yank focus out
          // of the query box.
          if (findSubMode !== "results") {
            return;
          }
          const idx = findIdxAtRow(y);
          if (idx !== null) {
            selectFindIdx(idx);
          }
          return;
        }
        if (name !== "MOUSE_LEFT_BUTTON_RELEASED") {
          return;
        }
        const sameCell =
          findPressCell !== null &&
          data?.x === findPressCell.x &&
          y === findPressCell.y;
        findPressCell = null;
        if (!sameCell) {
          return;
        }
        // Click on the query box: focus it, don't touch the selection.
        if (y <= findBoxRows + 2) {
          if (findSubMode !== "input") {
            findSubMode = "input";
            repaintFindViewport();
            repaintFindIndicatorRow();
            repaintFindBoxChrome();
            term.moveTo(findBoxCursorCol(), findBoxCursorScreenRow());
            term.hideCursor(false);
          }
          return;
        }
        const idx = findIdxAtRow(y);
        if (idx === null) {
          return;
        }
        // First click moves focus/selection to the row; a second click on
        // the already-selected row opens it. Mirrors the main list, and
        // keeps a stray click from launching a session.
        const wasInput = findSubMode === "input";
        if (wasInput) {
          findSubMode = "results";
          findSelectedIdx = idx;
          findSnippetIdx = 0;
          adjustFindScroll();
          withSync(() => {
            repaintFindBoxChrome();
            repaintFindViewport();
            repaintFindIndicatorRow();
            term.hideCursor();
          });
          return;
        }
        if (idx !== findSelectedIdx) {
          selectFindIdx(idx);
          return;
        }
        openFindHit();
      };

      pushLayer({
        onKey: findOnKey,
        onMouse: findOnMouse,
        onResize: () => renderFind(),
      });
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
      // ^O opens the cwd prompt from anywhere in the picker — composer,
      // list focus, search, rename, or a confirm modal. Hoisted above all
      // mode checks so no submode can swallow it. (^P stays bound to
      // "previous in list" / "drop focus into list" via the handlers
      // further down.)
      if (name === "CTRL_O") {
        void openCwdPrompt();
        return;
      }
      // ^L — full repaint. Hoisted above mode checks so the user can
      // recover from a scrambled screen in any submode.
      if (name === "CTRL_L") {
        forceFullRepaint();
        return;
      }
      if (mode === "rename" && renameEditor) {
        if (name === "ENTER" || name === "KP_ENTER") {
          const trimmed = renameEditor.text.trim();
          if (trimmed.length === 0) {
            mode = "normal";
            pendingAction = null;
            renameEditor = null;
            paintIndicator();
            return;
          }
          void performRename(trimmed);
          return;
        }
        if (name === "ESCAPE" || name === "CTRL_C") {
          mode = "normal";
          pendingAction = null;
          renameEditor = null;
          paintIndicator();
          return;
        }
        if (renameEditor.handleKey(name, data?.isCharacter === true)) {
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
      // Mouse hover over the composer visually pretends the composer
      // is focused (border tinted, session-row highlight hidden)
      // even though selectedIdx still points at a session row. The
      // instant the user touches the keyboard they've switched to
      // keyboard control — commit the visual to real focus so the
      // subsequent handler runs against the composer branch. Without
      // this, DOWN feels stuck (selectedIdx advances but the highlight
      // stays hidden because composerHover suppresses it, so nothing
      // visibly moves).
      if (composerHover) {
        composerHover = false;
        selectedIdx = 0;
        withSync(() => {
          repaintComposerChrome();
          repaintViewport();
        });
      }
      // ^F opens the find layer only when focus is in the session list.
      // In the composer it falls through to the InputDispatcher so it
      // behaves as the readline "forward-character" binding.
      if (name === "CTRL_F" && selectedIdx !== 0) {
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
          const text = composer.expandedText();
          const out = makeNewResult();
          if (text.trim().length > 0) {
            out.prompt = text;
          }
          out.installStatus = makePickerInstallStatus();
          resolve(out);
          return;
        }
        // ^t from the composer: a new session in a new tab.
        //
        // Must be intercepted HERE, not in the switch below that handles
        // ^t for a selected row. Composer-focused keys are routed through
        // the InputDispatcher a few lines down and never reach that
        // switch, so a handler there is unreachable from the composer —
        // and ^t would instead land on the dispatcher as a readline
        // transpose-chars.
        if (name === "CTRL_T") {
          if (canOpenTab()) {
            void performNewInNewTab();
          }
          // Swallowed either way: with no host, ^t transposing the
          // user's characters would be a surprising consolation prize.
          return;
        }
        // A held UP that just walked focus up into the composer keeps
        // auto-repeating. While the guard is armed, swallow each UP that
        // arrives within the auto-repeat cadence of the previous one
        // (refreshing the timer), so a sustained hold never tumbles into
        // prompt-history. The first UP after a human-scale gap (key
        // released + re-pressed) disarms the guard and enters history.
        if (name === "UP" && upGuardArmed) {
          const now = Date.now();
          const gap = now - lastUpAt;
          lastUpAt = now;
          if (gap < UP_REPEAT_GAP_MS) {
            placeComposerCursor();
            return;
          }
          upGuardArmed = false;
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
        // ^P from the composer drops focus into the session list (same
        // chord the live composer would interpret as "switch session",
        // which is meaningless here).
        if (name === "CTRL_P") {
          if (visible.length > 0) {
            move(1);
          }
          return;
        }
        // Any other key in the composer cancels the held-UP guard so a
        // later, deliberate UP isn't wrongly swallowed.
        upGuardArmed = false;
        // Tab expands a path-like token under the cursor against the
        // picker's current cwd, matching what the live session composer
        // does. Bare-word tokens fall through to InputDispatcher, which
        // treats Tab as insert-two-spaces (indent). No multi-candidate
        // overlay here — the picker has nowhere to render it — so a
        // token with multiple matches commits the longest common prefix
        // silently and the user hits Tab again once they've disambiguated.
        if (name === "TAB") {
          const st = composer.state();
          const line = st.buffer[st.row] ?? "";
          const tok = extractPathToken(line, st.col);
          if (tok !== null) {
            const result = completePathToken(tok.token, currentCwd);
            if (result !== null) {
              if (result.replacement !== tok.token) {
                composer.replaceRangeOnCurrentLine(
                  tok.start,
                  st.col,
                  result.replacement,
                );
                repaintComposerBody();
              }
              // Ambiguous match — no path-completion overlay in the
              // picker, so surface candidate basenames in the composer-
              // adjacent status row so the user can see what
              // disambiguates. The row width truncates for us.
              if (result.candidates.length > 1) {
                const shown = result.candidates.join("  ");
                composerHint = `${result.candidates.length} matches: ${shown}`;
                repaintComposerStatus();
              } else {
                clearComposerStatus();
              }
              placeComposerCursor();
              return;
            }
          }
        }
        // Any composer keystroke other than Tab dismisses a lingering
        // completion hint so it doesn't shadow the next action.
        clearComposerStatus();
        // state() aliases the live buffer — snapshot before feeding so
        // in-place mutations (e.g. ^K at col=0 rewriting the current
        // line) are visible in the after-comparison.
        const beforeState = composer.state();
        const beforeBuffer = [...beforeState.buffer];
        const beforeRow = beforeState.row;
        const beforeCol = beforeState.col;
        let event: KeyEvent | null = null;
        if (name === "\x1f") {
          event = { type: "key", name: "ctrl-underscore" };
        } else if (name === "\x1b_" || name === "\x1b\x1f") {
          event = { type: "key", name: "alt-underscore" };
        } else if (data?.isCharacter) {
          event = { type: "char", ch: name };
        } else {
          const mapped = mapKeyName(name);
          if (mapped !== null) {
            if (tryHandleComposerHotkey(mapped)) {
              placeComposerCursor();
              return;
            }
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
          beforeBuffer.length === after.buffer.length &&
          beforeBuffer.every((line, i) => line === after.buffer[i]) &&
          beforeRow === after.row &&
          beforeCol === after.col;
        // Dispatcher told us to exit — ^c with no text left to clear,
        // ^d on an empty buffer, or ^d at end-of-buffer with nothing
        // forward to delete (all handled inside the dispatcher).
        if (effects.some((e) => e.type === "exit")) {
          tryAbort();
          return;
        }
        // ^V (or an empty bracketed paste from wezterm's native ctrl+shift+v
        // when the clipboard holds only an image) surfaces as an
        // attachment-request. Read the system clipboard and attach any
        // image found so the new-session flow can send it with the first
        // prompt.
        for (const effect of effects) {
          if (effect.type === "attachment-request") {
            void ingestClipboardAttachment();
          } else if (effect.type === "edit-in-editor") {
            void handleEditInEditor();
          }
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
          // Entering search mode with an empty term doesn't filter
          // anything, so the cursor should stay where it was — applyFilter
          // snaps to the first match whenever searchActive, which would
          // otherwise jerk the selection to the top row before the user
          // has typed a single character.
          const keepId =
            selectedIdx > 0 ? visible[selectedIdx - 1]?.sessionId : undefined;
          searchActive = true;
          searchTerm = "";
          applyFilter();
          restoreCursorAfterFilter(keepId);
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
          const highlighted =
            selectedIdx > 0 ? visible[selectedIdx - 1] : undefined;
          const result = makeNewResult();
          if (highlighted?.cwd)
            result.cwd = highlighted.cwd;
          result.installStatus = makePickerInstallStatus();
          resolve(result);
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
        if (name === "i" && selectedIdx > 0) {
          const session = visible[selectedIdx - 1];
          if (!session) {
            return;
          }
          openInfoLayer(session);
          return;
        }
        if (name === "I") {
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
        if (name === "s" || name === "S") {
          void performSync();
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
          const result: PickerResult = {
            kind: "attach",
            sessionId: session.sessionId,
            readonly: true,
          };
          if (session.agentId !== undefined) {
            result.agentId = session.agentId;
          }
          result.installStatus = makePickerInstallStatus();
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
          renameEditor = new LineEditor(session.title ?? "");
          mode = "rename";
          paintIndicator();
          return;
        }
        if (name === "T" && selectedIdx > 0) {
          const session = visible[selectedIdx - 1];
          if (!session) {
            return;
          }
          void performRegen({ sessionId: session.sessionId });
          return;
        }
        if (name === "*" && selectedIdx > 0) {
          const session = visible[selectedIdx - 1];
          if (!session) {
            return;
          }
          void performTogglePriority(session);
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
        // Unbound printable char while focus is in the session list:
        // pull focus up into the composer and feed the character so the
        // user can just start typing a new-session prompt without first
        // pressing ↑ to land on the composer box.
        composerHover = false;
        selectedIdx = 0;
        composer.feed({ type: "char", ch: name });
        renderFromScratch();
        return;
      }
      switch (name) {
        // ^t — open the selected session in a new tab.
        //
        // Must live in this switch rather than the isCharacter block above:
        // CTRL_T is a control key, so `data.isCharacter` is false and that
        // whole block is skipped. A handler placed there is silently
        // unreachable — no error, the key just does nothing.
        case "CTRL_T": {
          if (!canOpenTab()) {
            return;
          }
          // Keyed on focus, mirroring what Enter already teaches here:
          // on a row it acts on that session, in the composer it starts a
          // new one. Same key, no new binding to learn.
          if (composerHover || selectedIdx === 0) {
            void performNewInNewTab();
            return;
          }
          const session = visible[selectedIdx - 1];
          if (!session) {
            return;
          }
          void performOpenInNewTab(session);
          return;
        }
        case "UP":
        case "SHIFT_TAB":
        case "CTRL_P":
          // Crossing from the topmost session row into the composer via a
          // held UP arms the guard so auto-repeat doesn't fall through into
          // prompt-history (see upGuardArmed / lastUpAt).
          if (name === "UP") {
            if (selectedIdx === 1) {
              upGuardArmed = true;
            }
            lastUpAt = Date.now();
          }
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
        case "RIGHT":
          if (composerHover || selectedIdx === 0) {
            break;
          }
        // fallthrough: RIGHT on a session row activates it like ENTER.
        case "ENTER":
        case "KP_ENTER": {
          if (composerHover) {
            const text = composer.expandedText();
            const out = makeNewResult();
            if (text.trim().length > 0) {
              out.prompt = text;
            }
            out.installStatus = makePickerInstallStatus();
            resolve(out);
            return;
          }
          if (selectedIdx === 0) {
            const out = makeNewResult();
            out.installStatus = makePickerInstallStatus();
            resolve(out);
            return;
          }
          const session = visible[selectedIdx - 1];
          if (!session) {
            cleanup();
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
          result.installStatus = makePickerInstallStatus();
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
    // Translate a mouse click in the session list area into "select that
    // row + Enter". Only fires on the picker's base layer in normal mode;
    // ignored while find/help/info/confirm/rename are active. Clicks
    // outside the viewport (composer, header, indicator, padding) are
    // dropped silently so a stray click doesn't dismiss the picker.
    const onMouse = (name: string, data?: { x?: number; y?: number }): void => {
      if (resolved) return;
      // A layer is up: give it first refusal, then stop. Never fall
      // through to the picker's own list handling — the list isn't what
      // the user is looking at.
      if (focusStack.length !== 1) {
        focusStack[focusStack.length - 1]?.onMouse?.(name, data);
        return;
      }
      if (mode !== "normal") return;
      const isMotion = name === "MOUSE_MOTION";
      const isPress = name === "MOUSE_LEFT_BUTTON_PRESSED";
      const isRelease = name === "MOUSE_LEFT_BUTTON_RELEASED";
      const isWheelUp = name === "MOUSE_WHEEL_UP";
      const isWheelDown = name === "MOUSE_WHEEL_DOWN";
      // Record press cell; clicks fire on release only when the
      // release lands on the same cell (drag-then-release isn't a
      // click). Out-of-focus presses are dropped entirely so they
      // can't arm a release-fire on the next focusing click.
      const recentlyFocused =
        terminalFocused && Date.now() - lastFocusInAt < FOCUS_GRACE_MS;
      const unfocused = !terminalFocused || recentlyFocused;
      if (isPress) {
        // Record the press cell even when unfocused — so a focusing
        // release can still highlight the clicked row. The `unfocused`
        // flag below downgrades that release from "click" (attach) to
        // "select-only" (highlight + focus the list).
        pickerPressCell = { x: data?.x ?? -1, y: data?.y ?? -1 };
        pickerPressUnfocused = unfocused;
        return;
      }
      if (isMotion && unfocused) {
        return;
      }
      const sameCell =
        isRelease &&
        pickerPressCell !== null &&
        data?.x === pickerPressCell.x &&
        data?.y === pickerPressCell.y;
      // A release on the same cell counts as a click ONLY when the
      // press was focused; an unfocused press downgrades the release
      // to "select-only" so a focusing click highlights its row but
      // doesn't attach.
      const isClick = sameCell && !pickerPressUnfocused;
      const isSelectOnlyRelease = sameCell && pickerPressUnfocused;
      if (isRelease) {
        pickerPressCell = null;
        pickerPressUnfocused = false;
        if (!sameCell) {
          return;
        }
      }
      if (isWheelUp || isWheelDown) {
        if (visible.length === 0) return;
        const delta = isWheelUp ? -3 : 3;
        const max = Math.max(0, visible.length - viewportSize);
        const nextScroll = Math.min(max, Math.max(0, scrollOffset + delta));
        if (nextScroll === scrollOffset) return;
        scrollOffset = nextScroll;
        // Keep the cursor visible: if the selected row scrolled off the
        // top/bottom of the viewport, snap selectedIdx to the nearest
        // edge of the new window. Composer (selectedIdx 0) stays put.
        if (selectedIdx > 0) {
          const sessionIdx = selectedIdx - 1;
          if (sessionIdx < scrollOffset) {
            selectedIdx = scrollOffset + 1;
          } else if (sessionIdx >= scrollOffset + viewportSize) {
            selectedIdx = scrollOffset + viewportSize;
          }
        }
        repaintViewport();
        return;
      }
      if (!isMotion && !isClick) return;
      const y = data?.y;
      if (typeof y !== "number") return;
      {
        const x = data?.x;
        const overEsc =
          escHitCols !== null &&
          y === indicatorRow() &&
          typeof x === "number" &&
          x >= escHitCols.start &&
          x <= escHitCols.end;
        const overHost =
          hostHitCols !== null &&
          y === indicatorRow() &&
          typeof x === "number" &&
          x >= hostHitCols.start &&
          x <= hostHitCols.end;
        if (overEsc !== escHintHovered || overHost !== hostHintHovered) {
          escHintHovered = overEsc;
          hostHintHovered = overHost;
          paintIndicator();
          if (selectedIdx === 0) {
            placeComposerCursor();
            term.hideCursor(false);
          } else {
            term.hideCursor(true);
          }
        }
      }
      // "Esc · Go Back" hint on the indicator row: a click inside its
      // recorded column range aborts the picker, matching the ESC key
      // handler in normal mode. escHitCols is only populated by
      // paintIndicator while mode === "normal", so confirm/rename/search
      // states naturally fall through and ignore the click.
      if (isClick && escHitCols !== null && y === indicatorRow()) {
        const x = data?.x;
        if (
          typeof x === "number" &&
          x >= escHitCols.start &&
          x <= escHitCols.end
        ) {
          tryAbort();
          return;
        }
      }
      // "host: …" segment on the indicator row: a click cycles the
      // host filter the same way pressing `h` does. Mirrors the `h`
      // key handler at the bottom of the onKey switch.
      if (isClick && hostHitCols !== null && y === indicatorRow()) {
        const x = data?.x;
        if (
          typeof x === "number" &&
          x >= hostHitCols.start &&
          x <= hostHitCols.end
        ) {
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
      }
      // Focus model:
      //   * Click on the composer box → focus moves to the composer.
      //   * Click on a session row → focus moves to the list (selecting
      //     that row); a second click on the already-selected row
      //     attaches.
      //   * Hover changes the list selection ONLY while the list is
      //     already focused. Hovering across panes never steals focus
      //     and never changes the visible selection, so a mouse trip
      //     through the picker on the way to copy-paste doesn't
      //     reshuffle anything.
      const overComposer = y >= startRow && y <= composerBottomRow();
      if (overComposer) {
        // Track which top-border click zone (cwd / agent) the mouse is
        // over so paintComposerTopBorder can bold the hovered fragment.
        // Cleared as soon as the cursor leaves row=startRow (still over
        // composer body) so the affordance goes away when the pointer
        // moves off the clickable region.
        let nextTopHover: "cwd" | "agent" | null = null;
        if (y === startRow) {
          const px = data?.x;
          if (typeof px === "number") {
            if (
              agentClickRange !== null &&
              px >= agentClickRange.start &&
              px <= agentClickRange.end
            ) {
              nextTopHover = "agent";
            } else if (
              cwdClickRange !== null &&
              px >= cwdClickRange.start &&
              px <= cwdClickRange.end
            ) {
              nextTopHover = "cwd";
            }
          }
        }
        if (nextTopHover !== composerTopHover) {
          composerTopHover = nextTopHover;
          repaintComposerChrome();
        }
        // Top-border click zones: clicking the cwd title on the left
        // opens the same modal `^o` uses; clicking the agent•model
        // label on the right opens the agent picker. Motion / hover
        // stays with the default composer-focus behavior — we only
        // hijack an actual click.
        if (isClick && y === startRow) {
          if (composerTopHover === "agent") {
            void openAgentPrompt();
            return;
          }
          if (composerTopHover === "cwd") {
            void openCwdPrompt();
            return;
          }
        }
        if ((isClick || isSelectOnlyRelease) && selectedIdx !== 0) {
          composerHover = false;
          const old = selectedIdx;
          selectedIdx = 0;
          withSync(() => {
            repaintViewport();
            onFocusChange(old, selectedIdx);
          });
          return;
        }
        if (isMotion && !composerHover && selectedIdx !== 0) {
          composerHover = true;
          withSync(() => {
            repaintComposerChrome();
            repaintViewport();
          });
        }
        return;
      }
      if (composerTopHover !== null) {
        composerTopHover = null;
        repaintComposerChrome();
      }
      if (composerHover) {
        composerHover = false;
        withSync(() => {
          repaintComposerChrome();
          repaintViewport();
        });
      }
      const firstRow = headerRow() + 1;
      const lastRow = firstRow + viewportSize - 1;
      if (y < firstRow || y > lastRow) return;
      const sessionIdx = scrollOffset + (y - firstRow);
      if (sessionIdx < 0 || sessionIdx >= visible.length) return;
      const session = visible[sessionIdx];
      if (!session) return;
      const targetIdx = sessionIdx + 1;
      // Hover only moves the selection while the list is already
      // focused; a hover that arrives while the composer is focused
      // is ignored so a mouse trip through the picker doesn't steal
      // focus. Clicks: a click while the composer is focused only
      // focuses the list (and selects the clicked row) — it doesn't
      // attach. A click on the already-selected row attaches. A click
      // on a different row while the list is focused selects it
      // without attaching.
      if (isMotion && selectedIdx === 0) {
        return;
      }
      const wasComposer = selectedIdx === 0;
      const alreadySelected = selectedIdx === targetIdx;
      // Treat a "select-only" release the same as a click that lands
      // on a different row — it highlights but doesn't attach.
      if (isSelectOnlyRelease && selectedIdx !== targetIdx) {
        const old = selectedIdx;
        selectedIdx = targetIdx;
        adjustScroll();
        withSync(() => {
          repaintViewport();
          onFocusChange(old, selectedIdx);
        });
        return;
      }
      if (isSelectOnlyRelease) {
        return;
      }
      if (selectedIdx !== targetIdx) {
        const old = selectedIdx;
        selectedIdx = targetIdx;
        adjustScroll();
        withSync(() => {
          repaintViewport();
          onFocusChange(old, selectedIdx);
        });
      }
      if (!isClick) return;
      if (wasComposer || !alreadySelected) {
        return;
      }
      const result: PickerResult = {
        kind: "attach",
        sessionId: session.sessionId,
      };
      if (session.agentId !== undefined) {
        result.agentId = session.agentId;
      }
      result.installStatus = makePickerInstallStatus();
      resolve(result);
    };
    const installGrab = (): void => {
      term.grabInput({ mouse: "motion" });
      writeDebugLine({ src: "grab", site: "picker.installGrab", on: true });
      const tSetup = term as unknown as {
        stdin: NodeJS.ReadableStream;
        onStdin: (chunk: Buffer) => void;
      };
      if (tSetup.stdin && typeof tSetup.onStdin === "function") {
        tkStdinHandler = tSetup.onStdin;
        tSetup.stdin.removeListener("data", tSetup.onStdin);
        tSetup.stdin.on("data", rawStdinHandler);
        writeControl(BRACKETED_PASTE_ON);
        writeControl(FOCUS_TRACK_ON);
      }
      term.on("key", dispatch);
      term.on("mouse", onMouse);
      term.on("resize", dispatchResize);
    };
    // Reverse of installGrab. Used both by cleanup (in resolve path) and
    // by suspend (which then re-runs installGrab on SIGCONT).
    const uninstallGrab = (): void => {
      writeControl(BRACKETED_PASTE_OFF);
      writeControl(FOCUS_TRACK_OFF);
      const tClean = term as unknown as { stdin: NodeJS.ReadableStream };
      if (tClean.stdin && tkStdinHandler) {
        tClean.stdin.removeListener("data", rawStdinHandler);
        tClean.stdin.on("data", tkStdinHandler);
        tkStdinHandler = null;
      }
      pasteActive = false;
      pasteBuffer = "";
      term.off("key", dispatch);
      term.off("mouse", onMouse);
      term.off("resize", dispatchResize);
      term.grabInput(false);
      writeDebugLine({ src: "grab", site: "picker.uninstallGrab", on: false });
      term.hideCursor(false);
    };
    installGrab();
    // Shared by ^Z suspend and ^X (edit composer in $EDITOR): tear down
    // everything a foreground process would fight over (grab, alt
    // screen), and its reverse. Route alt-screen re-entry through
    // terminal-kit so its internal fullscreen tracking stays consistent
    // with what's on the wire. Whatever we yielded to can have scrambled
    // DECCKM, kitty kbd, mouse, modifyOtherKeys, bracketed paste, cursor
    // visibility — re-assert every mode the picker depends on before
    // installGrab() turns bracketed paste back on and the first repaint
    // goes out.
    withdrawTerminalForChild = (): void => {
      terminalWithdrawnForChild = true;
      // A refresh already in flight would otherwise land its repaint
      // after the tty has been handed to the child — same corruption
      // the terminalWithdrawnForChild guard on autoRefreshTick prevents
      // for refreshes that haven't started yet.
      if (autoRefreshAbort) {
        autoRefreshAbort.abort();
        autoRefreshAbort = null;
        autoRefreshInFlight = false;
      }
      uninstallGrab();
      term.fullscreen(false);
      writeControl(`${AUTOWRAP_ON}${SHOW_CURSOR}`);
    };
    reclaimTerminalFromChild = (): void => {
      terminalWithdrawnForChild = false;
      term.fullscreen(true);
      resetPickerTerminalModes();
      term.hideCursor();
      installGrab();
      if (!resolved) {
        forceFullRepaint();
      }
    };
    // ^Z suspend. Tears down terminal state (alt screen, raw mode, paste
    // mode, grabInput), raises SIGTSTP on ourselves so the kernel stops
    // the process, and re-installs everything on SIGCONT. The picker
    // model state (selection, filters, find layer, composer buffer) is
    // all closure-local so it survives the suspend; renderFromScratch()
    // repaints the full layer state on resume.
    if (process.platform !== "win32") {
      let suspendInProgress = false;
      const onCont = (): void => {
        if (!suspendInProgress) {
          return;
        }
        suspendInProgress = false;
        reclaimTerminalFromChild?.();
      };
      suspend = (): void => {
        if (suspendInProgress || resolved) {
          return;
        }
        suspendInProgress = true;
        withdrawTerminalForChild?.();
        // Trailing newline so any shell job-control message renders
        // cleanly under the cursor withdrawTerminalForChild left visible.
        writeControl("\n");
        process.once("SIGCONT", onCont);
        process.kill(process.pid, "SIGTSTP");
      };
    }
    // Low-frequency refresh so busy indicators, new titles, and
    // appearing/disappearing sessions track without the user mashing `r`.
    // Skip while a prompt or search is up so we don't trample a partially
    // typed buffer, and skip while a prior refresh is still pending so
    // a slow daemon can't pile up overlapping repaints. `silent: true`
    // makes refresh a no-op when the visible state is unchanged, which
    // is the common case — keeps the picker quiet between actual events.
    autoRefreshTimer = setInterval(autoRefreshTick, 3000);
  });
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
//   6: live + busy + awaiting input
//   5: live + busy
//   4: live + awaiting input (turn over)
//   3: live + priority (idle)
//   2: live (idle)
//   1: cold + priority
//   0: cold
// Active sessions outrank everything else — even pinned ones — because
// they're the ones with real-time activity the user might want to peek
// at. Busy is the primary axis and awaiting-input breaks ties within it:
// a mid-turn agent blocked on a question is the most urgent row there
// is, but an awaiting-input flag on a session whose turn is already over
// is the *least* urgent of the active signals, since it is frequently
// just a flag nobody cleared (see the dead-agent case in
// daemon/server.ts) rather than an agent actually standing by. Hence 4
// sits below plain busy. Priority then floats idle-live rows above other
// idle-live, and cold-priority rows above plain cold.
// Within a tier, higher priority value wins; final tiebreak is
// updatedAt at minute precision so per-chunk mtime churn doesn't
// reshuffle the list between auto-refreshes.
export function sortSessions(
  sessions: DiscoveredSession[],
  _cwd: string,
): DiscoveredSession[] {
  const priorityOf = (s: DiscoveredSession): number =>
    s.priority && s.priority > 0 ? s.priority : 0;
  const tier = (s: DiscoveredSession): number => {
    const isWarm = s.status === "warm";
    const isPriority = priorityOf(s) > 0;
    if (isWarm && s.busy && s.awaitingInput) return 6;
    if (isWarm && s.busy) return 5;
    if (isWarm && s.awaitingInput) return 4;
    if (isWarm && isPriority) return 3;
    if (isWarm) return 2;
    if (isPriority) return 1;
    return 0;
  };
  return [...sessions].sort((a, b) => {
    const dt = tier(b) - tier(a);
    if (dt !== 0) {
      return dt;
    }
    const dp = priorityOf(b) - priorityOf(a);
    if (dp !== 0) {
      return dp;
    }
    return b.updatedAt.slice(0, 16).localeCompare(a.updatedAt.slice(0, 16));
  });
}

// A session is "from this machine" when it was never imported OR the
// exporting host matches thisMachine() — a bundle round-tripped through
// export/import on the same box (e.g. archiver undelete of a local
// session) is by definition local, not a peer mirror. See
// core/machine.ts for the identity source and the HYDRA_ACP_LOCAL_HOSTS
// override.
function isFromThisMachine(
  importedFromMachine: string | undefined,
  locals: Set<string>,
): boolean {
  if (!importedFromMachine) return true;
  return locals.has(importedFromMachine);
}

// True when a federated entry is, on the *peer's own* side, a dormant
// import mirror it has never attached to — importedFromMachine rides
// through the merge unchanged from the peer's own record (see
// daemon/routes/session-forward.ts's ForeignSessionCache, which
// deliberately does NOT filter these out of the data — that's a
// general-purpose cache, this is a presentation decision made here
// instead). Not "what's happening on the peer" in any useful sense —
// inert leftover data nobody there has claimed — so it's excluded from
// that remote's own bucket, the same way it'd be excluded from
// "__local" if it were a local dormant mirror. Still visible under
// "__all", same as a local one is.
function isDormantOnPeer(s: { importedFromMachine?: string; upstreamSessionId?: string }): boolean {
  return !!s.importedFromMachine && !s.upstreamSessionId;
}

// Filter-value namespace prefixes. A `hydra remote add`'s name is
// human-chosen and very commonly just the machine's hostname (as in
// `hydra remote add mrclean mrclean.local`) — the exact same string
// the old bundle-import path already records in importedFromMachine
// (also a hostname, via thisMachine()). Without a prefix, "mrclean" as
// a bare filter value can't tell "the live remote named mrclean" from
// "an old imported mirror from the machine named mrclean" apart, and
// silently merges two unrelated session sets under one bucket — a real
// bug, not a hypothetical, caught when a federated remote happened to
// share a name with a years-old bundle import from the same box.
const REMOTE_FILTER_PREFIX = "remote:";
const HOST_FILTER_PREFIX = "host:";

// Apply the picker's host filter to a session list. Sentinel/namespaced
// values:
//   "__all"      — no filter.
//   "__local"    — sessions created here, imported from this machine
//                  (self-restore via archiver / manual export+import), OR
//                  imported from another host and already bound to a local
//                  agent (upstreamSessionId set). The "I'm working on this
//                  here" bucket. Federated (remote-set) sessions never land
//                  here — see below.
//   "host:<m>"   — passive mirrors imported from machine <m> that haven't
//                  been attached locally yet. Once you attach, the session
//                  graduates to "__local" and stops appearing here.
//   "remote:<n>" — sessions live on the `hydra remote` registered under
//                  <n> (session.remote === n — see
//                  daemon/routes/session-forward.ts), excluding any that
//                  are themselves a dormant, never-attached import mirror
//                  on that peer's own side (see isDormantOnPeer) — those
//                  still show under "__all". Unlike an imported mirror, a
//                  federated session never graduates out of this bucket
//                  into "__local": it stays live on the peer for as long
//                  as it's federated, there's no local copy to bind.
// A bare, unprefixed value (no known persisted preference should look
// like this going forward) is treated as a pre-namespacing "host:"
// value for backward compatibility with an already-saved preference —
// see nextHostFilter's doc comment.
export function filterByHost(
  sessions: DiscoveredSession[],
  hostFilter: string,
  hostnames: Set<string> = localMachines(),
): DiscoveredSession[] {
  if (hostFilter === "__all") {
    return sessions;
  }
  if (hostFilter === "__local") {
    return sessions.filter(
      (s) =>
        !s.remote &&
        (isFromThisMachine(s.importedFromMachine, hostnames) ||
          !!s.upstreamSessionId),
    );
  }
  if (hostFilter.startsWith(REMOTE_FILTER_PREFIX)) {
    const name = hostFilter.slice(REMOTE_FILTER_PREFIX.length);
    return sessions.filter((s) => s.remote === name && !isDormantOnPeer(s));
  }
  const machine = hostFilter.startsWith(HOST_FILTER_PREFIX)
    ? hostFilter.slice(HOST_FILTER_PREFIX.length)
    : hostFilter; // pre-namespacing persisted value
  return sessions.filter(
    (s) =>
      s.importedFromMachine === machine &&
      !hostnames.has(machine) &&
      !s.upstreamSessionId,
  );
}

// Cycle the host filter through "__local" → each federated remote with
// at least one non-dormant session (alphabetical) → each peer host with
// at least one passive mirror (alphabetical) → "__all" → back to
// "__local". A peer host whose sessions have all been attached locally
// drops out of the cycle because the "host:<m>" filter would render an
// empty list for it; a federated remote drops out the same way if
// every one of its sessions is itself a dormant, never-attached import
// mirror on the peer's own side (see isDormantOnPeer / filterByHost).
// Local hostnames (this box or HYDRA_ACP_LOCAL_HOSTS) also drop out
// since they roll up into "__local". Values are namespaced
// ("remote:<n>" / "host:<m>", see filterByHost) precisely so a remote
// and an imported-machine bucket that happen to share a name stay
// distinct rather than silently merging. Exported so picker.test.ts
// can drive the transitions.
export function nextHostFilter(
  current: string,
  sessions: ReadonlyArray<{
    importedFromMachine?: string;
    upstreamSessionId?: string;
    remote?: string;
  }>,
  hostnames: Set<string> = localMachines(),
): string {
  const remotes = new Set<string>();
  const hosts = new Set<string>();
  for (const s of sessions) {
    if (s.remote) {
      // A remote whose sessions are ALL dormant mirrors on the peer's
      // own side would render an empty list if selected — same reason
      // an imported host with no passive mirrors left drops out below.
      if (!isDormantOnPeer(s)) {
        remotes.add(s.remote);
      }
      continue;
    }
    if (
      s.importedFromMachine &&
      !s.upstreamSessionId &&
      !hostnames.has(s.importedFromMachine)
    ) {
      hosts.add(s.importedFromMachine);
    }
  }
  const ordered = [
    "__local",
    ...[...remotes].sort().map((n) => `${REMOTE_FILTER_PREFIX}${n}`),
    ...[...hosts].sort().map((m) => `${HOST_FILTER_PREFIX}${m}`),
    "__all",
  ];
  const idx = ordered.indexOf(current);
  if (idx === -1) {
    return "__local";
  }
  return ordered[(idx + 1) % ordered.length] ?? "__local";
}

// Strips the namespace prefix for display — the status line shows
// "remote: mrclean" or "host: mrclean" (still legible even when both
// exist under the same name), never the raw "remote:mrclean" value.
export function describeHostFilter(hostFilter: string): string {
  if (hostFilter === "__local") {
    return "host: local";
  }
  if (hostFilter.startsWith(REMOTE_FILTER_PREFIX)) {
    return `remote: ${hostFilter.slice(REMOTE_FILTER_PREFIX.length)}`;
  }
  if (hostFilter.startsWith(HOST_FILTER_PREFIX)) {
    return `host: ${hostFilter.slice(HOST_FILTER_PREFIX.length)}`;
  }
  return `host: ${hostFilter}`; // pre-namespacing persisted value
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
