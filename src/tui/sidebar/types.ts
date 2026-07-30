// Sidebar data model and gadget contract.
//
// The sidebar is a fixed-width column painted down the right edge of the
// scrollback region only (rows 1..scrollbackBottom) — the prompt, the
// separators and the sessionbar keep the full terminal width so prompt
// editing is never narrowed.
//
// Gadgets are pure functions of a SidebarSnapshot. They never read app
// state directly: app.ts pushes a snapshot into Screen, Screen hands it
// to each gadget at paint time. That keeps gadget rendering trivially
// testable and makes the memo cache in registry.ts sound — a gadget's
// output can only change when its versionKey changes.
//
// Text metrics (cellWidth/truncate) are injected via SidebarContext
// rather than imported from screen.ts: screen.ts imports this module, so
// importing back would form a cycle.

import type { FormattedLine } from "../format.js";
import type { PlanEntry } from "../../core/render-update.js";

export interface SidebarUsage {
  used?: number;
  size?: number;
  costAmount?: number;
  costCurrency?: string;
}

export interface SidebarGitFile {
  // Absolute path. Resolved by app.ts against the repo toplevel (git
  // reports paths relative to the root, which isn't necessarily the
  // session cwd) so a double-click can open it without further context.
  path: string;
  // Worktree state, in the order a user thinks about it.
  state: "staged" | "dirty" | "new";
}

export interface SidebarGitStatus {
  branch: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
  files: SidebarGitFile[];
}

export interface SidebarEditedFile {
  // Absolute where known; app.ts resolves tool-reported paths against the
  // session cwd so double-click-to-open doesn't depend on the editor's
  // working directory.
  path: string;
  // Line counts are only known for edits that carried a diff payload;
  // undefined means "touched, extent unknown" (e.g. Write with no diff).
  added?: number;
  removed?: number;
}

// One tool call currently in flight. Derived per-repaint from the app's
// per-turn tool state; see running-tools.ts for why this list is capped
// rather than paginated.
export interface SidebarRunningTool {
  // Short verb from the ACP `kind` ("read" / "edit" / "run" / "fetch" …),
  // already normalized. "tool" when the agent sent no kind.
  verb: string;
  // Single-line, whitespace-collapsed hint of what the call acts on. This
  // is ToolLineState.detail (the CLIPPED hint), never detailFull — an
  // execute call's full command line is unbounded.
  detail?: string;
  // Wall clock the call started, for the live elapsed column. Undefined
  // for calls that arrived without one; the row then omits the timer.
  startedAt?: number;
  // Absolute where known, for double-click-to-open.
  path?: string;
}

// Resource reading for one process tree.
export interface SidebarProcUsage {
  label: string;
  rssBytes: number;
  // Fraction of one core; may exceed 1 on a multi-core tree. Undefined
  // before the second sample, when there's no baseline to difference.
  cpuFraction?: number;
  processes: number;
}

export interface SidebarSnapshot {
  // Paint-time clock. Passed in rather than read via Date.now() inside
  // gadgets so elapsed rendering is deterministic under test.
  now: number;
  // Non-null while at least one turn is in flight (any client's turn —
  // mirrors app.ts pendingTurns/sessionBusySince).
  busySince: number | null;
  // Wall clock of the last turn-complete, for the idle counter.
  lastTurnEndedAt: number | null;
  queued: number;
  usage: SidebarUsage;
  plan: PlanEntry[];
  editedFiles: SidebarEditedFile[];
  // Tool calls in flight right now, in the same order as the tools block.
  // Empty while idle, which is also when the gadget hides itself.
  running: SidebarRunningTool[];
  // null when the cwd isn't a git repo, or when the git gadget isn't
  // configured (in which case app.ts never runs the poller at all).
  git: SidebarGitStatus | null;
  // Resource readings, in display order. Empty when the resources gadget
  // isn't configured, when sampling isn't possible, or when the daemon is
  // remote — the agent's pid then belongs to another machine's process
  // table, so measuring it locally would report someone else's process.
  resources: SidebarProcUsage[];
  sessionId: string | null;
  agent: string | null;
  model: string | null;
  mode: string | null;
}

export interface SidebarTextMetrics {
  cellWidth(s: string): number;
  truncate(s: string, max: number, opts?: { stripMarkup?: boolean }): string;
}

// How the column is framed.
//   "none"  — no rules; blocks separated by a blank row.
//   "rule"  — one continuous vertical rule down the gutter, blocks
//             separated by a blank row.
//   "frame" — a continuous left edge with a horizontal rule at every
//             boundary, using the box-drawing junction each position calls
//             for: "┌" opens the column, "├" separates one gadget from the
//             next (the vertical line continues through it), and "└" closes
//             the column off at the bottom. Costs one row per boundary plus
//             the closing rule.
export type SidebarBorder = "none" | "rule" | "frame";

export function isFramedBorder(border: SidebarBorder): boolean {
  return border === "frame";
}

// Click target on a sidebar row, in columns relative to the row BODY
// (1-based), so the screen layer only has to add the body's origin.
export interface SidebarAction {
  start: number;
  end: number;
  // Set the named gadget's page to this index. Absolute rather than a
  // delta, so the renderer does the clamping once (it knows the page count)
  // and the screen layer never has to reason about bounds.
  page: { gadget: string; index: number };
}

export interface SidebarContext {
  metrics: SidebarTextMetrics;
  border: SidebarBorder;
  // Current page per gadget id, for gadgets that paginate. Missing means
  // page 0. Clamped by the renderer against the live item count.
  pages?: Readonly<Record<string, number>>;
  // Body rows the column can show at once. The renderer paginates only as
  // much as it must: with room for every item it shows them all and emits no
  // pagers at all, and when it does have to window it grows the page as
  // large as still fits rather than falling back to the gadget's default.
  //
  // Undefined means "available height unknown", and the renderer then
  // paginates at each gadget's declared pageSize — the conservative choice,
  // since assuming unlimited room would silently disable windowing.
  maxRows?: number;
  // Inner width available to a gadget body, i.e. the column width less
  // the gutter. Gadgets must not emit rows wider than this; the screen
  // layer truncates defensively but a too-wide row means a wrong bar.
  width: number;
}

// A sidebar row. Extends FormattedLine with the one piece of interaction
// state the column needs: the file a double-click on this row should open.
// The screen layer records these per painted row and routes a double-click
// through the same tryOpenPathString() the transcript uses, so the sidebar
// honours tui.openFileCommand with no separate plumbing.
export interface SidebarLine extends FormattedLine {
  openPath?: string;
  // Marks a row as one of the gadget's list ITEMS, i.e. a row that
  // pagination may window out. Rows without it (titles, summary counts) are
  // structural and always render. Keeping the distinction on the line means
  // gadgets stay pure list-builders and the renderer owns paging.
  item?: boolean;
  // Single-click regions on this row (the pager arrows).
  actions?: SidebarAction[];
  // Glyph the screen layer paints in the gutter for this row (the border
  // rules). Undefined means blank. The scroll-indicator arrows override it
  // on the column's first and last row — knowing there is content out of
  // view matters more than an unbroken rule.
  gutter?: string;
}

export interface Gadget {
  // Max item rows to show at once. Undefined means "never paginate" —
  // the gadget's rows are all structural, or its list is inherently short.
  pageSize?: number;
  id: string;
  // Rendered as a dim header row above the body. Omit for gadgets that
  // are self-describing in one line (activity).
  title?: string;
  // Cheap, allocation-free predicate. False means the gadget is skipped
  // entirely — no header, no blank separator, and (for git) no polling.
  relevant(s: SidebarSnapshot): boolean;
  // Everything that can change this gadget's rendered output. The memo
  // cache in registry.ts keys on it, so a 1 Hz elapsed tick dirties only
  // the activity gadget and leaves the rest cached.
  versionKey(s: SidebarSnapshot, ctx: SidebarContext): string;
  render(s: SidebarSnapshot, ctx: SidebarContext): SidebarLine[];
}

export function emptySnapshot(now = 0): SidebarSnapshot {
  return {
    now,
    busySince: null,
    lastTurnEndedAt: null,
    queued: 0,
    usage: {},
    plan: [],
    editedFiles: [],
    running: [],
    git: null,
    resources: [],
    sessionId: null,
    agent: null,
    model: null,
    mode: null,
  };
}
