// Pre-screen interactive picker. Lists sessions for the given cwd plus a
// "+ New session" entry, returns the user's choice. Lives outside the main
// screen so it can run before fullscreen mode is engaged.

import type { Terminal } from "terminal-kit";
import type { DiscoveredSession } from "./discovery.js";

export type PickerResult =
  | { kind: "attach"; sessionId: string; agentId?: string }
  | { kind: "new" }
  | { kind: "abort" };

export interface PickOptions {
  cwd: string;
  sessions: DiscoveredSession[];
}

export async function pickSession(
  term: Terminal,
  opts: PickOptions,
): Promise<PickerResult> {
  const filtered = opts.sessions.filter((s) => s.cwd === opts.cwd);
  if (filtered.length === 0) {
    return { kind: "new" };
  }
  const sorted = [...filtered].sort((a, b) => {
    const liveDiff = (b.status === "live" ? 1 : 0) - (a.status === "live" ? 1 : 0);
    if (liveDiff !== 0) {
      return liveDiff;
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  const widths = computeWidths(sorted);
  const newSessionLabel = "+ New session in this cwd";
  const cancelLabel = "× Cancel";

  const items: string[] = [newSessionLabel];
  for (const s of sorted) {
    items.push(formatRow(s, widths));
  }
  items.push(cancelLabel);

  term("\n");
  term.bold("Sessions in ")(opts.cwd)("\n");
  term.dim(formatHeader(widths))("\n");

  const response = await term
    .singleColumnMenu(items, {
      cancelable: true,
      exitOnUnexpectedKey: false,
      style: term.brightWhite,
      selectedStyle: term.brightWhite.bgBlue,
    })
    .promise;

  term("\n");

  if (response.canceled || response.selectedIndex === undefined) {
    return { kind: "abort" };
  }
  if (response.selectedIndex === 0) {
    return { kind: "new" };
  }
  if (response.selectedIndex === items.length - 1) {
    return { kind: "abort" };
  }
  const session = sorted[response.selectedIndex - 1];
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

interface Widths {
  id: number;
  agent: number;
  clients: number;
  age: number;
}

function computeWidths(sessions: DiscoveredSession[]): Widths {
  const w: Widths = {
    id: "session".length,
    agent: "agent".length,
    clients: "clients".length,
    age: "age".length,
  };
  const now = Date.now();
  for (const s of sessions) {
    w.id = Math.max(w.id, shortId(s.sessionId).length);
    w.agent = Math.max(w.agent, (s.agentId ?? "?").length);
    w.clients = Math.max(w.clients, formatClients(s).length);
    w.age = Math.max(w.age, formatAge(s.updatedAt, now).length);
  }
  return w;
}

function formatHeader(w: Widths): string {
  return [
    " ", // status dot column
    "session".padEnd(w.id),
    "agent".padEnd(w.agent),
    "clients".padEnd(w.clients),
    "age".padEnd(w.age),
    "title",
  ].join("  ");
}

function formatRow(s: DiscoveredSession, w: Widths): string {
  const tag = s.status === "live" ? "●" : "○";
  const title = s.title ?? "";
  return [
    tag,
    shortId(s.sessionId).padEnd(w.id),
    (s.agentId ?? "?").padEnd(w.agent),
    formatClients(s).padEnd(w.clients),
    formatAge(s.updatedAt, Date.now()).padEnd(w.age),
    title,
  ].join("  ");
}

function formatClients(s: DiscoveredSession): string {
  if (s.status === "cold") {
    return "-";
  }
  return String(s.attachedClients);
}

function formatAge(updatedAt: string, now: number): string {
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) {
    return "?";
  }
  const seconds = Math.max(0, Math.floor((now - t) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function shortId(id: string): string {
  if (id.length <= 18) {
    return id;
  }
  const tail = id.slice(-8);
  const prefix = id.includes("_")
    ? id.slice(0, id.indexOf("_") + 1)
    : id.slice(0, 6);
  return `${prefix}…${tail}`;
}
