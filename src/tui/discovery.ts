// Thin REST client over the daemon's /v1/sessions endpoint, used by the picker
// and `--resume`. Mirrors the pattern in src/cli/commands/sessions.ts but only
// what the TUI needs.

import type { HydraConfig } from "../core/config.js";
import { httpBase } from "../cli/commands/sessions.js";

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
  config: HydraConfig,
  serviceToken: string,
  opts: ListOptions = {},
  // Allow tests to inject a fetch implementation. Defaults to the global one.
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredSession[]> {
  const base = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const url = new URL(`${base}/v1/sessions`);
  if (opts.cwd) {
    url.searchParams.set("cwd", opts.cwd);
  }
  if (opts.all) {
    url.searchParams.set("all", "true");
  }
  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${serviceToken}` },
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
  }));
}

// Demote a live session to cold (POST .../kill). A 404 is tolerated so
// callers don't have to special-case races where the session was already
// removed by another client.
export async function killSession(
  config: HydraConfig,
  serviceToken: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const response = await fetchImpl(`${base}/v1/sessions/${id}/kill`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceToken}` },
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
  config: HydraConfig,
  serviceToken: string,
  id: string,
  title: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const response = await fetchImpl(`${base}/v1/sessions/${id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title }),
  });
  if (!response.ok && response.status !== 204 && response.status !== 404) {
    throw new Error(`daemon returned HTTP ${response.status}`);
  }
}

// Ask the daemon to regenerate a live session's title via its agent
// (equivalent to typing bare `/hydra title` in the composer). 404 (no
// such record) and 409 (cold — no agent to talk to) are both tolerated
// silently; the picker's `T` is treated as a no-op in those cases.
export async function regenSessionTitle(
  config: HydraConfig,
  serviceToken: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const response = await fetchImpl(`${base}/v1/sessions/${id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ regen: true }),
  });
  if (
    !response.ok &&
    response.status !== 204 &&
    response.status !== 404 &&
    response.status !== 409
  ) {
    throw new Error(`daemon returned HTTP ${response.status}`);
  }
}

export async function deleteSession(
  config: HydraConfig,
  serviceToken: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const response = await fetchImpl(`${base}/v1/sessions/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${serviceToken}` },
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
