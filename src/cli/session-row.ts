// Shared table-row formatting for the session listing — used by both
// `hydra-acp sessions list` (printed to stdout) and the TUI picker
// (rendered into a terminal-kit pane). Keeping the column layout in one
// place ensures the two views stay byte-identical, and centralizes the
// width-aware truncation so neither caller wraps onto a second line.

import {
  formatAgentCell,
  formatCostCell,
  shortenModel,
  type DisplayUsage,
} from "../core/agent-display.js";
import { shortenHomePath } from "../core/paths.js";
import { stripHydraSessionPrefix } from "../core/session.js";

export interface SessionSummary {
  sessionId: string;
  upstreamSessionId?: string;
  cwd: string;
  agentId?: string;
  // Last-known model id. Rendered (provider-prefix stripped) in the
  // optional MODEL column; the AGENT cell deliberately omits it to stay
  // narrow.
  currentModel?: string;
  currentUsage?: DisplayUsage;
  title?: string;
  // Origin host for imported sessions. Used to populate the UPSTREAM
  // cell with `← <host>` when the local upstream id hasn't been bound
  // yet (typical for imported-not-yet-attached rows), so imported rows
  // visibly carry their provenance instead of rendering as "-".
  importedFromMachine?: string;
  attachedClients: number;
  updatedAt: string;
  status?: "live" | "cold";
  // Mid-turn flag from the daemon. Renders as a filled trailing dot
  // (`•`) in the STATE cell so the picker can show which live sessions
  // are working without the user having to attach.
  busy?: boolean;
  // Set when the agent is blocked on the user (outstanding permission
  // request / posed question). Renders as a hollow trailing dot (`◦`),
  // distinct from the busy dot. Takes precedence over `busy` since a
  // session awaiting input is mid-turn but stalled on the human.
  awaitingInput?: boolean;
  // Present when compaction is in progress. Drives the trailing ⟳ in
  // the STATE cell (`LIVE⟳`) so operators can spot mid-compaction
  // sessions at a glance without a per-session GET /compact/status call.
  compactionState?: unknown;
  // Present when this session is a fork whose synopsis is being generated
  // in the background. Drives ✨ (running) or ⚠ (failed) in the STATE
  // cell so operators can spot mid-synthesis forks at a glance.
  forkSynthesisState?: "running" | "failed";
}

export interface Row {
  session: string;
  upstream: string;
  // Live/cold status plus a trailing dot for in-flight work: filled
  // `•` when mid-turn, hollow `◦` when blocked awaiting the user.
  // `LIVE` / `LIVE•` / `LIVE◦` / `COLD`.
  state: string;
  agent: string;
  // Last-known model id, provider prefix stripped (e.g. "claude-opus-4").
  // "-" when unknown. Not shown by default.
  model: string;
  age: string;
  title: string;
  cwd: string;
  // Origin host for imported sessions (e.g. "machine-b"); "-" otherwise.
  // Not shown by default.
  host: string;
  // Full-precision per-session cost (e.g. "$5.60"); "-" when unknown.
  // Shown by default as the trailing column.
  cost: string;
}

export interface Widths {
  session: number;
  upstream: number;
  state: number;
  agent: number;
  model: number;
  age: number;
  cwd: number;
  title: number;
  host: number;
  cost: number;
}

// Every column the session table knows how to render, in their canonical
// left-to-right order. Doubles as the validation allowlist for --columns
// and tui.sessionColumns: any name outside this set is rejected.
export type ColumnKey = keyof Widths;
export const ALL_COLUMNS: ColumnKey[] = [
  "session",
  "upstream",
  "host",
  "state",
  "agent",
  "model",
  "age",
  "cwd",
  "title",
  "cost",
];

// Columns shown when the caller doesn't specify a set. UPSTREAM/HOST/
// MODEL are omitted — they rarely help when switching sessions. COST is
// the trailing column (after the elastic TITLE) so per-session spend is
// always visible flush-right. Opt into the hidden columns / reorder via
// --columns or config.tui.sessionColumns.
export const DEFAULT_COLUMNS: ColumnKey[] = [
  "session",
  "state",
  "age",
  "cwd",
  "title",
  "agent",
  "cost",
];

// Elastic columns flex under a width budget; the rest take their natural
// (header-aware) width and are never truncated. cwd is middle-truncated
// (paths read better with both ends preserved); title is right-truncated.
const ELASTIC_COLUMNS: ReadonlySet<ColumnKey> = new Set(["cwd", "title"]);

export const HEADER: Row = {
  session: "SESSION",
  upstream: "UPSTREAM",
  host: "HOST",
  state: "STATE",
  agent: "AGENT",
  model: "MODEL",
  age: "AGE",
  title: "TITLE",
  cwd: "CWD",
  cost: "COST",
};

const SEP = "  ";
// Default cap on the cwd column when one isn't passed. Anything past this
// gets middle-truncated by formatRow when a maxWidth is in effect. Both
// the CLI sessions command and the TUI picker pass an explicit value
// (sourced from config.tui.cwdColumnMaxWidth); the default is the fallback
// for callers that don't have config in hand.
const DEFAULT_CWD_MAX_WIDTH = 32;

export interface FormatOptions {
  // Columns to render, in the given order. Defaults to DEFAULT_COLUMNS.
  // Honored as-is so callers can reorder columns, not just hide them.
  columns?: ColumnKey[];
  // Cap on the cwd column's natural width. Defaults to
  // DEFAULT_CWD_MAX_WIDTH.
  cwdMaxWidth?: number;
}

// Parse a comma-separated column list (from --columns or config) into a
// validated, ordered ColumnKey[]. Order is preserved. Throws on an empty
// list, an unknown name, or a duplicate — all of which are user error
// worth surfacing rather than silently papering over.
export function parseColumns(raw: string): ColumnKey[] {
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error("--columns: no column names given");
  }
  const seen = new Set<string>();
  const out: ColumnKey[] = [];
  for (const name of parts) {
    if (!ALL_COLUMNS.includes(name as ColumnKey)) {
      throw new Error(
        `--columns: unknown column "${name}" (valid: ${ALL_COLUMNS.join(", ")})`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`--columns: duplicate column "${name}"`);
    }
    seen.add(name);
    out.push(name as ColumnKey);
  }
  return out;
}

export function toRow(s: SessionSummary, now: number = Date.now()): Row {
  return {
    session: stripHydraSessionPrefix(s.sessionId),
    upstream: formatUpstreamCell(s.upstreamSessionId, s.importedFromMachine),
    host: s.importedFromMachine ?? "-",
    state: formatState(
      s.status,
      s.busy,
      s.awaitingInput,
      isCompactionInProgress(s.compactionState),
      s.forkSynthesisState,
    ),
    agent: formatAgentCell(s.agentId),
    model: shortenModel(s.currentModel) ?? "-",
    age: formatRelativeAge(s.updatedAt, now),
    title: s.title ?? "-",
    cwd: shortenHomePath(s.cwd),
    cost: formatCostCell(s.currentUsage),
  };
}

// True only for the active phases of compaction. Terminal states like
// "failed" leave compactionState populated on disk so the user can read
// lastError, but the picker badge must NOT render a spinner for them.
function isCompactionInProgress(state: unknown): boolean {
  if (state == null || typeof state !== "object") {
    return false;
  }
  const status = (state as { status?: unknown }).status;
  return (
    status === "requested" ||
    status === "running" ||
    status === "swap_pending" ||
    status === "swap_deferred"
  );
}

// Pre-first-attach imported sessions have no local upstream id yet —
// the cell would otherwise render as "-" with no hint that the row
// came from another machine. When the import breadcrumb is present
// we surface the origin host in its place so the provenance is
// visible in the picker. Once the local agent is bound, the real
// upstream id wins.
export function formatUpstreamCell(
  upstreamSessionId: string | undefined,
  importedFromMachine: string | undefined,
): string {
  if (upstreamSessionId && upstreamSessionId.length > 0) {
    return upstreamSessionId;
  }
  if (importedFromMachine && importedFromMachine.length > 0) {
    return `← ${importedFromMachine}`;
  }
  return "-";
}

// Live/cold state cell. Cold sessions render as `COLD`. Live sessions
// render as `LIVE◦` when the agent is blocked awaiting the user (a
// permission request / posed question), `LIVE•` when actively mid-turn,
// `LIVE✨` when fork synopsis synthesis is running, `LIVE⟳` when
// background compaction is running, or plain `LIVE` when idle.
// Precedence: awaiting-input > busy > synthesizing > compacting > idle.
// The two user-attention signals (◦, •) outrank the background-work
// signals because they indicate something the operator may need to react
// to. Failed synthesis shows ⚠ below any activity signal so it is always
// visible regardless of what else is happening.
// The HEADER row reuses formatRow's plumbing but its `state` cell is
// literal "STATE".
function formatState(
  status: "live" | "cold" | undefined,
  busy: boolean | undefined,
  awaitingInput: boolean | undefined,
  compacting: boolean | undefined,
  forkSynthesisState?: "running" | "failed",
): string {
  if (status === "cold") {
    return "COLD";
  }
  if (awaitingInput) {
    return forkSynthesisState === "failed" ? "LIVE◦⚠" : "LIVE\u25e6";
  }
  if (busy) {
    return forkSynthesisState === "failed" ? "LIVE•⚠" : "LIVE\u2022";
  }
  if (forkSynthesisState === "running") {
    return "LIVE✨";
  }
  if (forkSynthesisState === "failed") {
    return "LIVE⚠";
  }
  if (compacting) {
    return "LIVE\u27f3";
  }
  return "LIVE";
}

// Header-aware natural width per column. Only the selected columns are
// sized; unselected ones get 0 so they reserve no space. (formatRow
// renders strictly from the same column list, so a 0 here is never read
// for a rendered cell.)
export function computeWidths(rows: Row[], opts: FormatOptions = {}): Widths {
  const columns = opts.columns ?? DEFAULT_COLUMNS;
  const w: Widths = {
    session: 0,
    upstream: 0,
    host: 0,
    state: 0,
    agent: 0,
    model: 0,
    age: 0,
    cwd: 0,
    title: 0,
    cost: 0,
  };
  for (const col of columns) {
    w[col] = maxLen(HEADER[col], rows.map((r) => r[col]));
  }
  return w;
}

// Short, roughly-accurate "time since" hint. Tuned for table display
// where the cell is ~3-5 chars wide: "<1m", "12m", "3h", "2d", "5w",
// "11mo", "2y". Falls back to "?" when the timestamp is missing or
// unparseable.
export function formatRelativeAge(iso: string | undefined, now: number): string {
  if (!iso) {
    return "?";
  }
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return "?";
  }
  const diff = Math.max(0, now - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) {
    return "<1m";
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}m`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}h`;
  }
  const day = Math.floor(hr / 24);
  if (day < 14) {
    return `${day}d`;
  }
  const week = Math.floor(day / 7);
  if (week < 9) {
    return `${week}w`;
  }
  const month = Math.floor(day / 30);
  if (month < 12) {
    return `${month}mo`;
  }
  const year = Math.floor(day / 365);
  return `${year}y`;
}

function maxLen(headerCell: string, values: string[]): number {
  let max = headerCell.length;
  for (const v of values) {
    if (v.length > max) {
      max = v.length;
    }
  }
  return max;
}

// Build a single formatted row from the selected columns, in the order
// given (defaults to DEFAULT_COLUMNS). Fixed columns
// (session/upstream/host/state/agent/model/age/cost) take their natural
// width and are never truncated — they're keyed by short ids and short
// labels. The elastic columns flex: cwd is middle-truncated (paths read
// better with both ends preserved), title is right-truncated. When
// `maxWidth` is provided the row is guaranteed to fit: fixed columns are
// laid out first, then the remaining budget is handed to the elastic
// columns — the LAST elastic column in the list absorbs whatever's left,
// earlier elastic columns take their natural (cwd: capped) width. A
// fixed column placed after the last elastic column (e.g. the default
// trailing COST) is pushed flush-right because the elastic cell pads out
// to its allocation.
export function formatRow(
  r: Row,
  w: Widths,
  maxWidth?: number,
  opts: FormatOptions = {},
): string {
  const columns = opts.columns ?? DEFAULT_COLUMNS;
  const cwdMaxWidth = opts.cwdMaxWidth ?? DEFAULT_CWD_MAX_WIDTH;

  // Natural-width cell, no truncation. age is right-aligned (numeric-ish),
  // everything else left-aligned — matching the original layout.
  const naturalCell = (col: ColumnKey): string =>
    col === "age" ? r[col].padStart(w[col]) : r[col].padEnd(w[col]);

  // Unbounded path: every column at natural width. The trailing column
  // isn't padded (no need to pad the last cell out to a fixed width).
  if (maxWidth === undefined) {
    const cells = columns.map((col, i) =>
      i === columns.length - 1 ? r[col] : naturalCell(col),
    );
    return cells.join(SEP);
  }

  // Width-bounded path. Lay out fixed columns at natural width, reserve
  // the leftover budget for the elastic columns.
  const elasticIdx = columns
    .map((col, i) => ({ col, i }))
    .filter(({ col }) => ELASTIC_COLUMNS.has(col));
  const lastElastic =
    elasticIdx.length > 0 ? elasticIdx[elasticIdx.length - 1]!.i : -1;

  // No elastic column selected: the row is all fixed cells. Join in order
  // and hard-clip to maxWidth as a backstop.
  if (lastElastic === -1) {
    const out = columns.map(naturalCell).join(SEP);
    return out.length > maxWidth ? out.slice(0, maxWidth) : out;
  }

  // Budget available to elastic columns: maxWidth minus the natural width
  // of every fixed cell, minus every separator joining the row (counted
  // once each — fixed-vs-elastic doesn't matter for the separator count).
  const fixedWidth = columns
    .filter((col) => !ELASTIC_COLUMNS.has(col))
    .reduce((sum, col) => sum + w[col], 0);
  const sepCount = Math.max(0, columns.length - 1);
  let budget = maxWidth - fixedWidth - sepCount * SEP.length;
  if (budget < 0) {
    budget = 0;
  }

  // Allocate each elastic column. Non-last elastic columns take their
  // natural width (cwd capped by cwdMaxWidth), always reserving at least
  // one column for the trailing elastic cell. The last elastic column
  // absorbs the remainder.
  const elasticAlloc = new Map<number, number>();
  let remaining = budget;
  for (const { col, i } of elasticIdx) {
    if (i === lastElastic) {
      continue;
    }
    const natural = col === "cwd" ? Math.min(w[col], cwdMaxWidth) : w[col];
    const alloc = Math.min(natural, Math.max(0, remaining - 1));
    elasticAlloc.set(i, alloc);
    remaining = Math.max(0, remaining - alloc);
  }
  elasticAlloc.set(lastElastic, Math.max(0, remaining));

  const lastCol = columns.length - 1;
  // Render an elastic cell. cwd is always padded out (it's never the
  // trailing cell in practice). title is right-truncated; it's padded to
  // its allocated width only when something follows it (e.g. a trailing
  // COST column), so that following column sits flush at the right edge.
  // When title is the visually-last cell we leave it unpadded to avoid a
  // ragged trailing run of spaces.
  const renderElastic = (col: ColumnKey, width: number, isLast: boolean): string => {
    if (col === "cwd") {
      return truncateMiddle(r[col], width).padEnd(width);
    }
    const cell = truncateRight(r[col], width);
    return isLast ? cell : cell.padEnd(width);
  };

  const cells = columns.map((col, i) => {
    if (ELASTIC_COLUMNS.has(col)) {
      return renderElastic(col, elasticAlloc.get(i) ?? 0, i === lastCol);
    }
    return naturalCell(col);
  });

  // Backstop: when the fixed columns alone overflow maxWidth (elastic
  // budget already 0), hard-clip so the row never exceeds the cap.
  const out = cells.join(SEP);
  return out.length > maxWidth ? out.slice(0, maxWidth) : out;
}

export function truncateRight(s: string, max: number): string {
  if (max <= 0) {
    return "";
  }
  if (s.length <= max) {
    return s;
  }
  if (max === 1) {
    return "…";
  }
  return s.slice(0, max - 1) + "…";
}

export function truncateMiddle(s: string, max: number): string {
  if (max <= 0) {
    return "";
  }
  if (s.length <= max) {
    return s;
  }
  if (max === 1) {
    return "…";
  }
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}
