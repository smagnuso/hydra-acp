// Shared table-row formatting for the session listing — used by both
// `hydra-acp sessions list` (printed to stdout) and the TUI picker
// (rendered into a terminal-kit pane). Keeping the column layout in one
// place ensures the two views stay byte-identical, and centralizes the
// width-aware truncation so neither caller wraps onto a second line.

import { formatAgentWithModel } from "../core/agent-display.js";
import { stripHydraSessionPrefix } from "../core/session.js";

export interface SessionSummary {
  sessionId: string;
  upstreamSessionId?: string;
  cwd: string;
  agentId?: string;
  currentModel?: string;
  title?: string;
  attachedClients: number;
  updatedAt: string;
  status?: "live" | "cold";
}

export interface Row {
  session: string;
  upstream: string;
  status: string;
  clients: string;
  agent: string;
  age: string;
  title: string;
  cwd: string;
}

export interface Widths {
  session: number;
  upstream: number;
  status: number;
  clients: number;
  agent: number;
  age: number;
  title: number;
}

export const HEADER: Row = {
  session: "SESSION",
  upstream: "UPSTREAM",
  status: "STATUS",
  clients: "CLIENTS",
  agent: "AGENT",
  age: "AGE",
  title: "TITLE",
  cwd: "CWD",
};

const SEP = "  ";
const MIN_CWD = 8;
// Cap the title column so a single long title doesn't blow the column
// out wide enough to starve the cwd column. Anything past this gets
// right-truncated by formatRow when a maxWidth is in effect.
const TITLE_MAX_WIDTH = 40;

export function toRow(s: SessionSummary, now: number = Date.now()): Row {
  return {
    session: stripHydraSessionPrefix(s.sessionId),
    upstream: s.upstreamSessionId ?? "-",
    status: (s.status ?? "live").toUpperCase(),
    clients: s.status === "cold" ? "-" : String(s.attachedClients),
    agent: formatAgentWithModel(s.agentId, s.currentModel),
    age: formatRelativeAge(s.updatedAt, now),
    title: s.title ?? "-",
    cwd: s.cwd,
  };
}

export function computeWidths(rows: Row[]): Widths {
  return {
    session: maxLen(HEADER.session, rows.map((r) => r.session)),
    upstream: maxLen(HEADER.upstream, rows.map((r) => r.upstream)),
    status: maxLen(HEADER.status, rows.map((r) => r.status)),
    clients: maxLen(HEADER.clients, rows.map((r) => r.clients)),
    agent: maxLen(HEADER.agent, rows.map((r) => r.agent)),
    age: maxLen(HEADER.age, rows.map((r) => r.age)),
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
// guaranteed to occupy at most `maxWidth` columns: title is right-truncated
// and cwd is middle-truncated (paths read better with the leading and
// trailing segments preserved than with either end lopped off). The fixed
// columns (session/upstream/status/clients/agent) are never truncated —
// they're keyed by short ids and short labels, so their natural width is
// expected to fit.
export function formatRow(r: Row, w: Widths, maxWidth?: number): string {
  const fixed = [
    r.session.padEnd(w.session),
    r.upstream.padEnd(w.upstream),
    r.status.padEnd(w.status),
    r.clients.padStart(w.clients),
    r.agent.padEnd(w.agent),
    r.age.padStart(w.age),
  ].join(SEP);

  if (maxWidth === undefined) {
    return [fixed, r.title.padEnd(w.title), r.cwd].join(SEP);
  }

  // Cap title column when fitting to width so one outlier title doesn't
  // starve cwd of room. Long titles get right-truncated to this cap.
  const titleCap = Math.min(w.title, TITLE_MAX_WIDTH);
  const budget = maxWidth - fixed.length - SEP.length;
  if (budget <= 0) {
    return fixed.slice(0, maxWidth);
  }

  // Prefer title at its capped width; let cwd absorb the rest. If even
  // MIN_CWD won't fit alongside a full title, shrink title further.
  const titleNatural = Math.min(r.title.length, titleCap);
  let titleAlloc =
    titleNatural + SEP.length + MIN_CWD <= budget
      ? titleCap
      : Math.max(0, budget - SEP.length - MIN_CWD);
  titleAlloc = Math.min(titleAlloc, Math.max(0, budget - SEP.length - 1));

  const titleCell = truncateRight(r.title, titleAlloc).padEnd(titleAlloc);
  const cwdBudget = Math.max(0, budget - titleAlloc - SEP.length);
  const cwdCell = truncateMiddle(r.cwd, cwdBudget);

  return [fixed, titleCell, cwdCell].join(SEP);
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
