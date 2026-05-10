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
  title?: string;
  attachedClients: number;
  updatedAt: string;
  status: "live" | "cold";
}

export interface ListOptions {
  cwd?: string;
  all?: boolean;
}

export async function listSessions(
  config: HydraConfig,
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
    headers: { Authorization: `Bearer ${config.daemon.authToken}` },
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
    title: s.title,
  }));
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
