// Pre-screen interactive picker. Lists every live session plus the most
// recently-touched cold ones (capped at coldLimit) to keep the table
// scannable when the on-disk history is deep, plus a "+ New session"
// entry at the bottom (the default cursor position). Lives outside the
// main screen so it can run before fullscreen mode is engaged.

import type { Terminal } from "terminal-kit";
import { stripHydraSessionPrefix } from "../core/session.js";
import type { DiscoveredSession } from "./discovery.js";

export type PickerResult =
  | { kind: "attach"; sessionId: string; agentId?: string }
  | { kind: "new" }
  | { kind: "abort" };

export interface PickOptions {
  cwd: string;
  sessions: DiscoveredSession[];
  // Maximum cold sessions to render. Live sessions are always included.
  coldLimit: number;
}

interface Row {
  session: string;
  upstream: string;
  status: string;
  clients: string;
  agent: string;
  title: string;
  cwd: string;
}

interface Widths {
  session: number;
  upstream: number;
  status: number;
  clients: number;
  agent: number;
  title: number;
}

const HEADER: Row = {
  session: "SESSION",
  upstream: "UPSTREAM",
  status: "STATUS",
  clients: "CLIENTS",
  agent: "AGENT",
  title: "TITLE",
  cwd: "CWD",
};

export async function pickSession(
  term: Terminal,
  opts: PickOptions,
): Promise<PickerResult> {
  if (opts.sessions.length === 0) {
    return { kind: "new" };
  }
  const sorted = [...opts.sessions].sort((a, b) => {
    const liveDiff = (b.status === "live" ? 1 : 0) - (a.status === "live" ? 1 : 0);
    if (liveDiff !== 0) {
      return liveDiff;
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  const liveCount = sorted.filter((s) => s.status !== "cold").length;
  const coldSlice = sorted.slice(liveCount, liveCount + opts.coldLimit);
  const hiddenCold = sorted.length - liveCount - coldSlice.length;
  const visible = [...sorted.slice(0, liveCount), ...coldSlice];
  const rows = visible.map(toRow);
  const widths = computeWidths(rows);
  const newSessionLabel = `+ New session in ${opts.cwd}`;

  const items: string[] = rows.map((r) => formatRow(r, widths));
  items.push(newSessionLabel);

  term("\n");
  term.bold("Select a session")("\n");
  if (hiddenCold > 0) {
    term.dim(`(${hiddenCold} older cold session${hiddenCold === 1 ? "" : "s"} hidden; use \`hydra-acp sessions --all\` to view)\n`);
  }
  term.dim(formatRow(HEADER, widths))("\n");

  // grabInput puts stdin in raw mode, so the kernel won't deliver SIGINT for
  // Ctrl+C. Some terminal-kit versions also drop CTRL_C from menu key
  // bindings entirely. Listen at the term level and force-exit on Ctrl+C so
  // the picker is always escapable.
  const onCtrlC = (name: string): void => {
    if (name === "CTRL_C") {
      term.grabInput(false);
      term("\n");
      process.exit(130);
    }
  };
  term.on("key", onCtrlC);

  let response;
  try {
    response = await term
      .singleColumnMenu(items, {
        cancelable: true,
        exitOnUnexpectedKey: false,
        selectedIndex: items.length - 1,
        style: term.brightWhite,
        selectedStyle: term.brightWhite.bgBlue,
        keyBindings: {
          ENTER: "submit",
          KP_ENTER: "submit",
          UP: "previous",
          DOWN: "next",
          TAB: "next",
          SHIFT_TAB: "previous",
          HOME: "first",
          END: "last",
          ESCAPE: "cancel",
          CTRL_C: "cancel",
        },
      })
      .promise;
  } finally {
    term.off("key", onCtrlC);
  }

  term("\n");

  if (response.canceled || response.selectedIndex === undefined) {
    return { kind: "abort" };
  }
  if (response.selectedIndex === items.length - 1) {
    return { kind: "new" };
  }
  const session = visible[response.selectedIndex];
  if (!session) {
    return { kind: "abort" };
  }
  const result: PickerResult = {
    kind: "attach",
    sessionId: session.sessionId,
  };
  if (session.agentId !== undefined) {
    result.agentId = session.agentId;
  }
  return result;
}

function toRow(s: DiscoveredSession): Row {
  return {
    session: stripHydraSessionPrefix(s.sessionId),
    upstream: s.upstreamSessionId ?? "-",
    status: s.status.toUpperCase(),
    clients: s.status === "cold" ? "-" : String(s.attachedClients),
    agent: s.agentId ?? "?",
    title: s.title ?? "-",
    cwd: s.cwd,
  };
}

function computeWidths(rows: Row[]): Widths {
  return {
    session: maxLen(HEADER.session, rows.map((r) => r.session)),
    upstream: maxLen(HEADER.upstream, rows.map((r) => r.upstream)),
    status: maxLen(HEADER.status, rows.map((r) => r.status)),
    clients: maxLen(HEADER.clients, rows.map((r) => r.clients)),
    agent: maxLen(HEADER.agent, rows.map((r) => r.agent)),
    title: maxLen(HEADER.title, rows.map((r) => r.title)),
  };
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

function formatRow(r: Row, w: Widths): string {
  return [
    r.session.padEnd(w.session),
    r.upstream.padEnd(w.upstream),
    r.status.padEnd(w.status),
    r.clients.padStart(w.clients),
    r.agent.padEnd(w.agent),
    r.title.padEnd(w.title),
    r.cwd,
  ].join("  ");
}
