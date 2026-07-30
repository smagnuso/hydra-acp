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
  // null when the cwd isn't a git repo, or when the git gadget isn't
  // configured (in which case app.ts never runs the poller at all).
  git: SidebarGitStatus | null;
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

export interface SidebarContext {
  metrics: SidebarTextMetrics;
  border: SidebarBorder;
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
  // Glyph the screen layer paints in the gutter for this row (the border
  // rules). Undefined means blank. The scroll-indicator arrows override it
  // on the column's first and last row — knowing there is content out of
  // view matters more than an unbroken rule.
  gutter?: string;
}

export interface Gadget {
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
    git: null,
    sessionId: null,
    agent: null,
    model: null,
    mode: null,
  };
}
