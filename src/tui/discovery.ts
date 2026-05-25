// Thin REST client over the daemon's /v1/sessions endpoint, used by the picker
// and `--reattach`. Mirrors the pattern in src/cli/commands/sessions.ts but only
// what the TUI needs.
//
// These functions take a RemoteTarget rather than (config, serviceToken)
// so the same code paths work for both the local-service-token attach
// and the remote-password-issued-session-token attach. The wire format
// is identical — the daemon's CompositeTokenValidator accepts either
// bearer kind.

import type { RemoteTarget } from "../core/remote-target.js";
import type {
  SessionSearchResponse,
  SessionHits,
  Snippet,
} from "../core/history-search.js";

export type { SessionSearchResponse, SessionHits, Snippet };

export interface DiscoveredSession {
  sessionId: string;
  upstreamSessionId?: string;
  cwd: string;
  agentId?: string;
  currentModel?: string;
  currentUsage?: DiscoveredUsage;
  title?: string;
  // Hostname of the machine that exported this session, when the
  // current record is the product of an import. Used by the picker to
  // fill the UPSTREAM cell pre-first-attach so imported rows don't
  // look like they appeared out of nowhere.
  importedFromMachine?: string;
  importedFromUpstreamSessionId?: string;
  attachedClients: number;
  updatedAt: string;
  status: "live" | "cold";
  // Mid-turn flag from the daemon. Drives the picker's busy indicator.
  busy?: boolean;
}

export interface DiscoveredUsage {
  used?: number;
  size?: number;
  costAmount?: number;
  costCurrency?: string;
}

export interface ListOptions {
  cwd?: string;
  all?: boolean;
}

export async function listSessions(
  target: RemoteTarget,
  opts: ListOptions = {},
  // Allow tests to inject a fetch implementation. Defaults to the global one.
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredSession[]> {
  const url = new URL(`${target.baseUrl}/v1/sessions`);
  if (opts.cwd) {
    url.searchParams.set("cwd", opts.cwd);
  }
  if (opts.all) {
    url.searchParams.set("all", "true");
  }
  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${target.token}` },
  });
  if (!response.ok) {
    throw new Error(`daemon returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    sessions?: Array<Partial<DiscoveredSession> & { sessionId: string; cwd: string; updatedAt: string; attachedClients?: number }>;
  };
  if (!Array.isArray(body.sessions)) {
    return [];
  }
  return body.sessions.map((s) => ({
    sessionId: s.sessionId,
    cwd: s.cwd,
    updatedAt: s.updatedAt,
    attachedClients: s.attachedClients ?? 0,
    status: s.status ?? "live",
    upstreamSessionId: s.upstreamSessionId,
    agentId: s.agentId,
    currentModel: s.currentModel,
    currentUsage: s.currentUsage,
    title: s.title,
    importedFromMachine: s.importedFromMachine,
    importedFromUpstreamSessionId: s.importedFromUpstreamSessionId,
    busy: s.busy,
  }));
}

// Demote a live session to cold (POST .../kill). A 404 is tolerated so
// callers don't have to special-case races where the session was already
// removed by another client.
export async function killSession(
  target: RemoteTarget,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${target.baseUrl}/v1/sessions/${id}/kill`, {
    method: "POST",
    headers: { Authorization: `Bearer ${target.token}` },
  });
  if (!response.ok && response.status !== 204 && response.status !== 404) {
    throw new Error(`daemon returned HTTP ${response.status}`);
  }
}

// Retitle a session via PATCH .../sessions/:id. Works on live AND cold
// sessions (cold just writes meta.json). A 404 is tolerated so callers
// don't need to handle the rare race where the record vanished between
// list and rename.
export async function renameSession(
  target: RemoteTarget,
  id: string,
  title: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${target.baseUrl}/v1/sessions/${id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${target.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title }),
  });
  if (!response.ok && response.status !== 204 && response.status !== 404) {
    throw new Error(`daemon returned HTTP ${response.status}`);
  }
}

// Ask the daemon to regenerate a live session's title via its agent
// (equivalent to typing bare `/hydra title` in the composer). The daemon
// responds 202 immediately — the regen runs asynchronously on the
// session's prompt queue, so the new title shows up on the next list
// refresh once the in-flight turn (if any) plus the regen complete.
// 404 (no such record) and 409 (cold — no agent to talk to) are both
// tolerated silently; the picker's `T` is treated as a no-op in those
// cases.
export async function regenSessionTitle(
  target: RemoteTarget,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${target.baseUrl}/v1/sessions/${id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${target.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ regen: true }),
  });
  if (
    !response.ok &&
    response.status !== 202 &&
    response.status !== 204 &&
    response.status !== 404 &&
    response.status !== 409
  ) {
    throw new Error(`daemon returned HTTP ${response.status}`);
  }
}

// Find-session transcripts on the connected daemon. `sessionIds` scopes
// the scan to a specific allowlist (the picker passes its currently
// visible rows so the existing filters compose with the find scope); when
// omitted, the daemon scans every session it knows about. Server
// returns 400 for an empty query, which we surface as a thrown error.
export async function searchSessions(
  target: RemoteTarget,
  query: string,
  opts: { sessionIds?: string[] } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<SessionSearchResponse> {
  const url = new URL(`${target.baseUrl}/v1/sessions/search`);
  url.searchParams.set("q", query);
  if (opts.sessionIds && opts.sessionIds.length > 0) {
    url.searchParams.set("sessionIds", opts.sessionIds.join(","));
  }
  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${target.token}` },
  });
  if (!response.ok) {
    throw new Error(`daemon returned HTTP ${response.status}`);
  }
  return (await response.json()) as SessionSearchResponse;
}

export async function deleteSession(
  target: RemoteTarget,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${target.baseUrl}/v1/sessions/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${target.token}` },
  });
  if (!response.ok && response.status !== 204 && response.status !== 404) {
    throw new Error(`daemon returned HTTP ${response.status}`);
  }
}

// Picks the most recent session for a cwd. Live preferred over cold; ties
// broken by `updatedAt` descending. Returns null when nothing matches.
export function pickMostRecent(
  sessions: DiscoveredSession[],
  cwd: string,
): DiscoveredSession | null {
  const matching = sessions.filter((s) => s.cwd === cwd);
  if (matching.length === 0) {
    return null;
  }
  const score = (s: DiscoveredSession): number => (s.status === "live" ? 1 : 0);
  const sorted = [...matching].sort((a, b) => {
    const ds = score(b) - score(a);
    if (ds !== 0) {
      return ds;
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  return sorted[0] ?? null;
}
