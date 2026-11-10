// "@" completion candidates for other hydra sessions. The session list
// comes from the picker's own data and matching (matchesSearch); picking
// one inserts a readable "@slug-ab12" token and, on send, a resource_link
// to hydra://sessions/<id> goes out with the prompt.

import { shortenHomePath } from "../core/paths.js";
import { stripHydraSessionPrefix } from "../core/session.js";
import type { DiscoveredSession } from "./discovery.js";
import type { MentionCandidate } from "./file-search.js";
import { takeWidth, textWidth } from "../core/width.js";
import { matchesSearch } from "./session-search.js";

const MAX_SESSION_CANDIDATES = 5;
const SLUG_MAX = 24;
const MIN_SLUG_WORD = 8;
const LABEL_TITLE_MAX = 56;
const SHORT_ID_LEN = 4;

export function slugify(title: string): string {
  const full = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (full.length <= SLUG_MAX) {
    return full;
  }
  // Cut at a word boundary when there is one worth keeping.
  const window = full.slice(0, SLUG_MAX + 1);
  const boundary = window.lastIndexOf("-");
  const cut = boundary >= MIN_SLUG_WORD ? window.slice(0, boundary) : full.slice(0, SLUG_MAX);
  return cut.replace(/-+$/g, "");
}

function clip(text: string, max: number): string {
  return textWidth(text) > max ? `${takeWidth(text, max - 3)}...` : text;
}

// The short id is always part of the token: two sessions can share a title,
// and a mention is recorded by its token text, so it has to be unique.
export function sessionToken(s: Pick<DiscoveredSession, "sessionId" | "title">): string {
  const short = stripHydraSessionPrefix(s.sessionId).slice(0, SHORT_ID_LEN);
  const slug = slugify(s.title ?? "");
  return `@${slug.length > 0 ? slug : "session"}-${short}`;
}

export function sessionCandidates(
  query: string,
  sessions: readonly DiscoveredSession[],
  opts: { excludeId?: string; limit?: number } = {},
): MentionCandidate[] {
  // A path-shaped query is a file search, not a session title.
  if (query.includes("/") || query.includes("\\") || query.startsWith(".")) {
    return [];
  }
  // Titles have spaces where the typed token has hyphens; try both forms.
  const term = query.replace(/[-_]+/g, " ").trim();
  const recency = (s: DiscoveredSession): number => {
    const t = Date.parse(s.updatedAt);
    return Number.isNaN(t) ? 0 : t;
  };
  const q = query.toLowerCase();
  const t = term.toLowerCase();
  // A title hit beats a hit on the cwd, id or agent, which are far looser.
  const inTitle = (s: DiscoveredSession): boolean => {
    const title = (s.title ?? "").toLowerCase();
    return title.includes(q) || title.includes(t);
  };
  return sessions
    .filter(
      (s) =>
        s.remote === undefined &&
        s.sessionId !== opts.excludeId &&
        (matchesSearch(s, query) || matchesSearch(s, term)),
    )
    .sort((a, b) => Number(inTitle(b)) - Number(inTitle(a)) || recency(b) - recency(a))
    .slice(0, opts.limit ?? MAX_SESSION_CANDIDATES)
    .map((s) => {
      const title = s.title?.trim() ?? "";
      const short = stripHydraSessionPrefix(s.sessionId).slice(0, SHORT_ID_LEN);
      return {
        label: `session: ${title.length > 0 ? clip(title, LABEL_TITLE_MAX) : "(untitled)"}  (${short}, ${shortenHomePath(s.cwd)})`,
        choice: sessionToken(s),
        target: { kind: "session", id: s.sessionId, title },
      };
    });
}
