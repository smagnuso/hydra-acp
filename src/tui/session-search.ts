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
  const wanted: string[] = [];
  const words: string[] = [];
  for (const w of term.trim().split(/\s+/)) {
    const m = w.match(/^(?:#|tag:)(.+)$/i);
    if (m) {
      wanted.push(m[1]!.toLowerCase());
    } else {
      words.push(w);
    }
  }
  if (wanted.length > 0) {
    const have = s.tags ?? [];
    // A tag also matches its children, so #area finds area/auth.
    const ok = wanted.every((w) =>
      have.some((t) => t === w || t.startsWith(`${w}/`)),
    );
    if (!ok) {
      return false;
    }
    if (words.length === 0) {
      return true;
    }
  }
  const t = (wanted.length > 0 ? words.join(" ") : term).toLowerCase();
  const haystacks = [
    stripHydraSessionPrefix(s.sessionId),
    s.upstreamSessionId ?? "",
    s.agentId ?? "",
    s.title ?? "",
    s.cwd,
    shortenHomePath(s.cwd),
    ...(s.tags ?? []),
  ];
  for (const h of haystacks) {
    if (h.toLowerCase().includes(t)) {
      return true;
    }
  }
  return false;
}
