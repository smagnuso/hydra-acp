import { loadConfig } from "../../core/config.js";
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
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  let body: { version: string; agents: AgentSummary[] };
  try {
    const r = await fetch(`${baseUrl}/v1/agents`, {
      headers: { Authorization: `Bearer ${config.daemon.authToken}` },
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

export async function runAgentsRefresh(): Promise<void> {
  const config = await loadConfig();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  let body: { version: string; agentCount: number };
  try {
    const r = await fetch(`${baseUrl}/v1/registry/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.daemon.authToken}` },
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
