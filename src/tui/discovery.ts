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

// Default per-request timeout for daemon REST calls from the TUI. Picked
// to be long enough that a healthy daemon under load never trips it but
// short enough that an unresponsive daemon doesn't freeze the picker for
// minutes. See T2 — discovery.ts.
export const DEFAULT_DAEMON_FETCH_TIMEOUT_MS = 8000;

// Thrown when a daemon fetch is aborted by its own timeout rather than
// by the caller. Lets callers distinguish "user/cancellation" from
// "daemon stuck"; the picker treats both as silent-failure for the
// auto-refresh path but the error message surfaces for manual refresh.
export class DaemonTimeoutError extends Error {
  constructor(public readonly url: string, public readonly timeoutMs: number) {
    super(`daemon did not respond within ${timeoutMs}ms (${url})`);
    this.name = "DaemonTimeoutError";
  }
}

// Wraps `fetch` so every daemon call gets both a caller-supplied
// AbortSignal AND a hard timeout. The two are merged into a single
// AbortController that fires whichever comes first. On timeout we throw
// DaemonTimeoutError; on caller-cancellation we let the native AbortError
// from fetch propagate so existing `if (e.name === 'AbortError')` checks
// still match.
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_DAEMON_FETCH_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init.signal ?? undefined;
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener(
        "abort",
        () => controller.abort(callerSignal.reason),
        { once: true },
      );
    }
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      throw new DaemonTimeoutError(url, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

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
  // Set when this session was created by hydra-acp/session/fork.
  // forkedFromSessionId points to the local source session; forkedFromMessageId
  // is the messageId of the turn_complete the slice ended at.
  forkedFromSessionId?: string;
  forkedFromMessageId?: string;
  attachedClients: number;
  updatedAt: string;
  status: "live" | "cold";
  // Mid-turn flag from the daemon. Drives the picker's busy indicator.
  busy?: boolean;
  // True when the agent is blocked on the user (outstanding permission
  // request / posed question). Drives the picker's "waiting on you"
  // glyph, distinct from the busy dot.
  awaitingInput?: boolean;
  // clientInfo from the process that issued session/new. Carried for
  // log/display; the effective filtering signal is `interactive` below.
  originatingClient?: { name: string; version?: string };
  // Tristate filter signal computed by the daemon's effectiveInteractive
  // helper. The picker uses this to render hints; the daemon already
  // applied the filter when constructing the list.
  interactive?: boolean;
  // User-set sort weight. >0 floats the session to the top of the
  // picker; absent / 0 means normal priority. Toggled from the picker
  // with `*`.
  priority?: number;
  // Present when compaction is in progress. Lets list views surface a
  // badge without needing a per-session GET /compact call.
  compactionState?: unknown;
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
  // When true, asks the daemon to skip its default interactive-only
  // filter and return every row (including `hydra cat` sessions and
  // editor-spawned empty sessions). Picker's `i` toggle sets this.
  includeNonInteractive?: boolean;
  // Optional caller-cancellation signal. The picker passes one driven by
  // its layer lifetime so a stuck refresh aborts when the picker tears
  // down or when the user fires a fresh refresh.
  signal?: AbortSignal;
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
  if (opts.includeNonInteractive) {
    url.searchParams.set("includeNonInteractive", "true");
  }
  const response = await fetchWithTimeout(
    url.toString(),
    {
      headers: { Authorization: `Bearer ${target.token}` },
      signal: opts.signal,
    },
    DEFAULT_DAEMON_FETCH_TIMEOUT_MS,
    fetchImpl,
  );
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
    forkedFromSessionId: s.forkedFromSessionId,
    forkedFromMessageId: s.forkedFromMessageId,
    busy: s.busy,
    awaitingInput: s.awaitingInput,
    originatingClient: s.originatingClient,
    interactive: s.interactive,
    priority: s.priority,
    compactionState: s.compactionState,
  }));
}

export interface DiscoveredAgent {
  id: string;
  name: string;
  description?: string;
  onboarding?: {
    command?: string;
    url?: string;
    description?: string;
  };
}

// Spawn each installed agent transiently and pull in any sessions it
// remembers (across every cwd) as cold records via the daemon's
// per-agent sync endpoint. Mirrors the background agent-sync scheduler
// but on demand — the picker's `s` keystroke calls this so a user can
// surface agent-side sessions without waiting for the schedule. Returns
// aggregate counts; per-agent failures (no sessionCapabilities.list,
// spawn failure) are swallowed so one bad agent can't wedge the rest.
export async function syncInstalledAgents(
  target: RemoteTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<{ synced: number; skipped: number; agents: number }> {
  const response = await fetchWithTimeout(
    `${target.baseUrl}/v1/agents`,
    { headers: { Authorization: `Bearer ${target.token}` } },
    DEFAULT_DAEMON_FETCH_TIMEOUT_MS,
    fetchImpl,
  );
  if (!response.ok) {
    throw new Error(`daemon returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    agents?: Array<{ id: string; installed?: string }>;
  };
  const installed = Array.isArray(body.agents)
    ? body.agents.filter((a) => a.installed === "yes")
    : [];
  let synced = 0;
  let skipped = 0;
  let agents = 0;
  for (const agent of installed) {
    try {
      const res = await fetchWithTimeout(
        `${target.baseUrl}/v1/agents/${agent.id}/sync`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${target.token}` },
        },
        // Agent sync spawns a child process per agent; give it longer
        // than the default REST timeout before declaring it dead.
        30000,
        fetchImpl,
      );
      if (!res.ok) {
        continue;
      }
      const result = (await res.json()) as {
        synced?: unknown[];
        skipped?: number;
      };
      synced += Array.isArray(result.synced) ? result.synced.length : 0;
      skipped += typeof result.skipped === "number" ? result.skipped : 0;
      agents += 1;
    } catch {
      void 0;
    }
  }
  return { synced, skipped, agents };
}

// List the agents the daemon's registry knows about (GET /v1/agents),
// routed through the active RemoteTarget so it works against local and
// remote daemons alike. Used by the in-TUI agent picker shown when a new
// session needs an agent and none is configured.
export async function listAgents(
  target: RemoteTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredAgent[]> {
  const response = await fetchWithTimeout(
    `${target.baseUrl}/v1/agents`,
    { headers: { Authorization: `Bearer ${target.token}` } },
    DEFAULT_DAEMON_FETCH_TIMEOUT_MS,
    fetchImpl,
  );
  if (!response.ok) {
    throw new Error(`daemon returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    agents?: Array<{
      id: string;
      name: string;
      description?: string;
      onboarding?: { command?: string; url?: string; description?: string };
    }>;
  };
  if (!Array.isArray(body.agents)) {
    return [];
  }
  return body.agents.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    ...(a.onboarding ? { onboarding: a.onboarding } : {}),
  }));
}

// Demote a live session to cold (POST .../kill). A 404 is tolerated so
// callers don't have to special-case races where the session was already
// removed by another client.
// Branch an existing session into a new one. Daemon mints a fresh
// sessionId + lineageId, seeds history through forkAt (default = last
// turn_complete), and returns the new id. First attach to the new
// session triggers seedFromImport so the agent absorbs the transcript.
export async function forkSession(
  target: RemoteTarget,
  id: string,
  opts: { forkAt?: string; cwd?: string; agentId?: string; title?: string; mode?: "verbatim" | "synthesis" } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{
  sessionId: string;
  forkedFromSessionId: string;
  forkedAt: string;
}> {
  const response = await fetchWithTimeout(
    `${target.baseUrl}/v1/sessions/${id}/fork`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(opts),
    },
    // Fork can include a seedFromImport replay, and synthesis mode spawns
    // an ephemeral synopsis agent (~120s budget). Keep this comfortably above.
    180000,
    fetchImpl,
  );
  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: string };
      if (typeof body.error === "string") {
        detail = `: ${body.error}`;
      }
    } catch {
      void 0;
    }
    throw new Error(`fork failed (HTTP ${response.status})${detail}`);
  }
  return (await response.json()) as {
    sessionId: string;
    forkedFromSessionId: string;
    forkedAt: string;
  };
}

export async function killSession(
  target: RemoteTarget,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchWithTimeout(
    `${target.baseUrl}/v1/sessions/${id}/kill`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${target.token}` },
    },
    DEFAULT_DAEMON_FETCH_TIMEOUT_MS,
    fetchImpl,
  );
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
  const response = await fetchWithTimeout(
    `${target.baseUrl}/v1/sessions/${id}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title }),
    },
    DEFAULT_DAEMON_FETCH_TIMEOUT_MS,
    fetchImpl,
  );
  if (!response.ok && response.status !== 204 && response.status !== 404) {
    throw new Error(`daemon returned HTTP ${response.status}`);
  }
}

// Set or clear the user-set priority on a session via PATCH .../sessions/:id.
// Pass null (or 0) to return to normal priority. Works on live AND cold
// sessions. 404 (no such record) is tolerated so the picker doesn't
// special-case races where the row vanished between list and toggle.
export async function setSessionPriority(
  target: RemoteTarget,
  id: string,
  priority: number | null,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchWithTimeout(
    `${target.baseUrl}/v1/sessions/${id}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ priority }),
    },
    DEFAULT_DAEMON_FETCH_TIMEOUT_MS,
    fetchImpl,
  );
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
  const response = await fetchWithTimeout(
    `${target.baseUrl}/v1/sessions/${id}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ regen: true }),
    },
    DEFAULT_DAEMON_FETCH_TIMEOUT_MS,
    fetchImpl,
  );
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
//
// POST (not GET) because the picker's allowlist can grow past the
// HTTP header-size limit when serialized into a query string on
// long-lived installs (HTTP 431).
export async function searchSessions(
  target: RemoteTarget,
  query: string,
  opts: { sessionIds?: string[] } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<SessionSearchResponse> {
  const body: { q: string; sessionIds?: string[] } = { q: query };
  if (opts.sessionIds && opts.sessionIds.length > 0) {
    body.sessionIds = opts.sessionIds;
  }
  const response = await fetchWithTimeout(
    `${target.baseUrl}/v1/sessions/search`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    // Full-text search across many sessions can take a few seconds.
    20000,
    fetchImpl,
  );
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
  const response = await fetchWithTimeout(
    `${target.baseUrl}/v1/sessions/${id}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${target.token}` },
    },
    DEFAULT_DAEMON_FETCH_TIMEOUT_MS,
    fetchImpl,
  );
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
