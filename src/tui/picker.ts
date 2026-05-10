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

  const items: string[] = [];
  items.push("+ New session in this cwd");
  for (const s of sorted) {
    items.push(formatRow(s));
  }
  items.push("× Cancel");

  term("\n");
  term.bold("Sessions in ")(opts.cwd)("\n\n");

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

function formatRow(s: DiscoveredSession): string {
  const tag = s.status === "live" ? "●" : "○";
  const id = s.sessionId.length > 16 ? `…${s.sessionId.slice(-15)}` : s.sessionId;
  const title = s.title ?? "";
  const agent = s.agentId ?? "?";
  const trailing = title ? ` — ${title}` : "";
  return `${tag} ${id}  [${agent}]${trailing}`;
}
