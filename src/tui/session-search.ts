import { shortenHomePath } from "../core/paths.js";
import { stripHydraSessionPrefix } from "../core/session.js";
import type { DiscoveredSession } from "./discovery.js";

// Case-insensitive substring match across the session's user-visible
// metadata. Exported so the picker.test.ts can exercise it directly
// without driving a fake terminal. Lives here, away from picker.ts,
// so lighter modules (the "@" session completion) can share it.
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
