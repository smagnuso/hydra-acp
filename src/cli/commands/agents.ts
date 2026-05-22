import { loadConfig } from "../../core/config.js";
import { loadServiceToken } from "../../core/service-token.js";
import { httpBase } from "./sessions.js";

interface AgentSummary {
  id: string;
  name: string;
  version: string;
  description?: string;
  distributions: string[];
}

export async function runAgentsList(): Promise<void> {
  const config = await loadConfig();
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  let body: { version: string; agents: AgentSummary[] };
  try {
    const r = await fetch(`${baseUrl}/v1/agents`, {
      headers: { Authorization: `Bearer ${serviceToken}` },
    });
    if (!r.ok) {
      process.stderr.write(`Daemon returned HTTP ${r.status}\n`);
      process.exit(1);
    }
    body = (await r.json()) as { version: string; agents: AgentSummary[] };
  } catch (err) {
    process.stderr.write(
      `Could not reach daemon at ${baseUrl}: ${(err as Error).message}\n`,
    );
    process.exit(1);
    return;
  }

  if (body.agents.length === 0) {
    process.stdout.write("No agents in registry.\n");
    return;
  }

  const rows = body.agents.map((a) => ({
    id: a.id,
    name: a.name,
    version: a.version,
    distributions: a.distributions.join(","),
    description: a.description ?? "",
  }));
  const header = {
    id: "ID",
    name: "NAME",
    version: "VERSION",
    distributions: "DIST",
    description: "DESCRIPTION",
  };
  const widths = {
    id: maxLen(header.id, rows.map((r) => r.id)),
    name: maxLen(header.name, rows.map((r) => r.name)),
    version: maxLen(header.version, rows.map((r) => r.version)),
    distributions: maxLen(header.distributions, rows.map((r) => r.distributions)),
  };
  const fmt = (r: typeof header): string =>
    [
      r.id.padEnd(widths.id),
      r.name.padEnd(widths.name),
      r.version.padEnd(widths.version),
      r.distributions.padEnd(widths.distributions),
      r.description,
    ].join("  ");
  process.stdout.write(fmt(header) + "\n");
  for (const r of rows) {
    process.stdout.write(fmt(r) + "\n");
  }
  process.stdout.write(`\nRegistry version: ${body.version}\n`);
}

interface SyncedSession {
  sessionId: string;
  upstreamSessionId: string;
  agentId: string;
  cwd: string;
  title?: string;
  updatedAt: string;
}

export async function runAgentsSync(agentId: string | undefined): Promise<void> {
  if (!agentId) {
    process.stderr.write("Usage: hydra-acp agent sync <agent-id>\n");
    process.exit(2);
    return;
  }
  const config = await loadConfig();
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  let body: { synced: SyncedSession[]; skipped: number };
  try {
    const r = await fetch(`${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceToken}` },
    });
    if (!r.ok) {
      let detail = `HTTP ${r.status}`;
      try {
        const j = (await r.json()) as { error?: string };
        if (j.error) {
          detail = j.error;
        }
      } catch {
        void 0;
      }
      process.stderr.write(`hydra agent sync ${agentId}: ${detail}\n`);
      process.exit(1);
    }
    body = (await r.json()) as { synced: SyncedSession[]; skipped: number };
  } catch (err) {
    process.stderr.write(
      `Could not reach daemon at ${baseUrl}: ${(err as Error).message}\n`,
    );
    process.exit(1);
    return;
  }

  if (body.synced.length === 0) {
    process.stdout.write(
      `Nothing new to sync (${body.skipped} already tracked).\n`,
    );
    return;
  }

  const rows = body.synced.map((s) => ({
    id: s.sessionId,
    upstream: s.upstreamSessionId,
    cwd: s.cwd,
    title: s.title ?? "-",
  }));
  const header = { id: "ID", upstream: "UPSTREAM", cwd: "CWD", title: "TITLE" };
  const widths = {
    id: maxLen(header.id, rows.map((r) => r.id)),
    upstream: maxLen(header.upstream, rows.map((r) => r.upstream)),
    cwd: maxLen(header.cwd, rows.map((r) => r.cwd)),
  };
  const fmt = (r: typeof header): string =>
    [
      r.id.padEnd(widths.id),
      r.upstream.padEnd(widths.upstream),
      r.cwd.padEnd(widths.cwd),
      r.title,
    ].join("  ");
  process.stdout.write(fmt(header) + "\n");
  for (const r of rows) {
    process.stdout.write(fmt(r) + "\n");
  }
  process.stdout.write(
    `\nSynced ${body.synced.length} session(s); skipped ${body.skipped} already tracked.\n`,
  );
}

export async function runAgentsRefresh(): Promise<void> {
  const config = await loadConfig();
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  let body: { version: string; agentCount: number };
  try {
    const r = await fetch(`${baseUrl}/v1/registry/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceToken}` },
    });
    if (!r.ok) {
      process.stderr.write(`Daemon returned HTTP ${r.status}\n`);
      process.exit(1);
    }
    body = (await r.json()) as { version: string; agentCount: number };
  } catch (err) {
    process.stderr.write(
      `Could not reach daemon at ${baseUrl}: ${(err as Error).message}\n`,
    );
    process.exit(1);
    return;
  }
  process.stdout.write(
    `Refreshed registry: ${body.agentCount} agents (version ${body.version})\n`,
  );
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
