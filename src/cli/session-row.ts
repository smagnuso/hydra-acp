// Shared table-row formatting for the session listing — used by both
// `hydra-acp sessions list` (printed to stdout) and the TUI picker
// (rendered into a terminal-kit pane). Keeping the column layout in one
// place ensures the two views stay byte-identical, and centralizes the
// width-aware truncation so neither caller wraps onto a second line.

import { formatAgentCell, type DisplayUsage } from "../core/agent-display.js";
import { shortenHomePath } from "../core/paths.js";
import { stripHydraSessionPrefix } from "../core/session.js";

export interface SessionSummary {
  sessionId: string;
  upstreamSessionId?: string;
  cwd: string;
  agentId?: string;
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
  // Mid-turn flag from the daemon. Renders as a trailing dot in the
  // STATE cell so the picker can show which live sessions are working
  // without the user having to attach.
  busy?: boolean;
}

export interface Row {
  session: string;
  upstream: string;
  // Live/cold status plus a trailing `•` when a live session is
  // mid-turn. `LIVE` / `LIVE•` / `COLD`.
  state: string;
  agent: string;
  age: string;
  title: string;
  cwd: string;
}

export interface Widths {
  session: number;
  upstream: number;
  state: number;
  agent: number;
  age: number;
  cwd: number;
  title: number;
}

export const HEADER: Row = {
  session: "SESSION",
  upstream: "UPSTREAM",
  state: "STATE",
  agent: "AGENT",
  age: "AGE",
  title: "TITLE",
  cwd: "CWD",
};

const SEP = "  ";
// Default cap on the cwd column when one isn't passed. Anything past this
// gets middle-truncated by formatRow when a maxWidth is in effect. Both
// the CLI sessions command and the TUI picker pass an explicit value
// (sourced from config.tui.cwdColumnMaxWidth); the default is the fallback
// for callers that don't have config in hand.
const DEFAULT_CWD_MAX_WIDTH = 24;

export function toRow(s: SessionSummary, now: number = Date.now()): Row {
  return {
    session: stripHydraSessionPrefix(s.sessionId),
    upstream: formatUpstreamCell(s.upstreamSessionId, s.importedFromMachine),
    state: formatState(s.status, s.busy),
    agent: formatAgentCell(s.agentId, s.currentUsage),
    age: formatRelativeAge(s.updatedAt, now),
    title: s.title ?? "-",
    cwd: shortenHomePath(s.cwd),
  };
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

// Live/cold state cell. Live sessions render as `LIVE` (or `LIVE•`
// when mid-turn); cold sessions render as `COLD`. The HEADER row
// reuses formatRow's plumbing but its `state` cell is literal "STATE".
function formatState(
  status: "live" | "cold" | undefined,
  busy: boolean | undefined,
): string {
  if (status === "cold") {
    return "COLD";
  }
  return busy ? "LIVE•" : "LIVE";
}

export function computeWidths(rows: Row[]): Widths {
  return {
    session: maxLen(HEADER.session, rows.map((r) => r.session)),
    upstream: maxLen(HEADER.upstream, rows.map((r) => r.upstream)),
    state: maxLen(HEADER.state, rows.map((r) => r.state)),
    agent: maxLen(HEADER.agent, rows.map((r) => r.agent)),
    age: maxLen(HEADER.age, rows.map((r) => r.age)),
    cwd: maxLen(HEADER.cwd, rows.map((r) => r.cwd)),
    title: maxLen(HEADER.title, rows.map((r) => r.title)),
  };
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

// Build a single formatted row. When `maxWidth` is provided, the row is
// guaranteed to occupy at most `maxWidth` columns: cwd is middle-truncated
// (paths read better with the leading and trailing segments preserved)
// and title is right-truncated to absorb whatever budget remains. The
// fixed columns (session/upstream/state/agent/age) are never truncated —
// they're keyed by short ids and short labels, so their natural width is
// expected to fit.
export function formatRow(
  r: Row,
  w: Widths,
  maxWidth?: number,
  cwdMaxWidth: number = DEFAULT_CWD_MAX_WIDTH,
): string {
  const fixed = [
    r.session.padEnd(w.session),
    r.upstream.padEnd(w.upstream),
    r.state.padEnd(w.state),
    r.agent.padEnd(w.agent),
    r.age.padStart(w.age),
  ].join(SEP);

  if (maxWidth === undefined) {
    return [fixed, r.cwd.padEnd(w.cwd), r.title].join(SEP);
  }

  const budget = maxWidth - fixed.length - SEP.length;
  if (budget <= 0) {
    return fixed.slice(0, maxWidth);
  }

  // Give cwd its natural (header-aware, capped) width first; title takes
  // whatever's left as the trailing elastic cell. Always reserve at least
  // one column for title so an oversized cwd can't push it off the row.
  const cwdCap = Math.min(w.cwd, cwdMaxWidth);
  const cwdAlloc = Math.min(cwdCap, Math.max(0, budget - SEP.length - 1));
  const cwdCell = truncateMiddle(r.cwd, cwdAlloc).padEnd(cwdAlloc);
  const titleBudget = Math.max(0, budget - cwdAlloc - SEP.length);
  const titleCell = truncateRight(r.title, titleBudget);

  return [fixed, cwdCell, titleCell].join(SEP);
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
