import * as fsp from "node:fs/promises";
import { loadConfig } from "../../core/config.js";
import { loadServiceToken } from "../../core/service-token.js";
import { paths } from "../../core/paths.js";
import { runLogTail } from "./log-tail.js";
import { httpBase } from "./sessions.js";

interface AgentSummary {
  id: string;
  name: string;
  version: string;
  description?: string;
  distributions: string[];
  installed: "yes" | "no" | "lazy";
}

export async function runAgentsList(): Promise<void> {
  const config = await loadConfig();
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  let body: {
    version: string;
    fetchedAt?: number;
    agents: AgentSummary[];
  };
  try {
    const r = await fetch(`${baseUrl}/v1/agents`, {
      headers: { Authorization: `Bearer ${serviceToken}` },
    });
    if (!r.ok) {
      process.stderr.write(`Daemon returned HTTP ${r.status}\n`);
      process.exit(1);
    }
    body = (await r.json()) as typeof body;
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
    installed: a.installed,
    description: a.description ?? "",
  }));
  const header = {
    id: "ID",
    name: "NAME",
    version: "VERSION",
    distributions: "DIST",
    installed: "INSTALLED",
    description: "DESCRIPTION",
  };
  const widths = {
    id: maxLen(header.id, rows.map((r) => r.id)),
    name: maxLen(header.name, rows.map((r) => r.name)),
    version: maxLen(header.version, rows.map((r) => r.version)),
    distributions: maxLen(header.distributions, rows.map((r) => r.distributions)),
    installed: maxLen(header.installed, rows.map((r) => r.installed)),
  };
  const fmt = (r: typeof header): string =>
    [
      r.id.padEnd(widths.id),
      r.name.padEnd(widths.name),
      r.version.padEnd(widths.version),
      r.distributions.padEnd(widths.distributions),
      r.installed.padEnd(widths.installed),
      r.description,
    ].join("  ");
  process.stdout.write(fmt(header) + "\n");
  for (const r of rows) {
    process.stdout.write(fmt(r) + "\n");
  }
  const syncSuffix =
    body.fetchedAt !== undefined
      ? ` (synced ${formatAge(Date.now() - body.fetchedAt)} ago)`
      : "";
  process.stdout.write(
    `\nRegistry version: ${body.version}${syncSuffix}\n`,
  );
}

// Round-and-bucket: "just now" for <60s, then a single
// minute/hour/day unit. Mirrors how `git log --relative-date`
// summarizes age — precise enough to spot a stale cache, terse
// enough to fit on the trailer line.
export function formatAge(ms: number): string {
  if (ms < 0) {
    return "just now";
  }
  const sec = Math.floor(ms / 1000);
  if (sec < 60) {
    return "just now";
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min} minute${min === 1 ? "" : "s"}`;
  }
  const hour = Math.floor(min / 60);
  if (hour < 24) {
    return `${hour} hour${hour === 1 ? "" : "s"}`;
  }
  const day = Math.floor(hour / 24);
  return `${day} day${day === 1 ? "" : "s"}`;
}

interface SyncedSession {
  sessionId: string;
  upstreamSessionId: string;
  agentId: string;
  cwd: string;
  title?: string;
  updatedAt: string;
}

export async function runAgentsInstall(
  agentId: string | undefined,
): Promise<void> {
  if (!agentId) {
    process.stderr.write("Usage: hydra-acp agent install <agent-id>\n");
    process.exit(2);
    return;
  }
  const config = await loadConfig();
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  process.stdout.write(`Installing ${agentId}…\n`);
  let body: {
    agentId: string;
    version: string;
    distribution: string;
    installed: boolean;
    command?: string;
    message?: string;
  };
  try {
    const r = await fetch(
      `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/install`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceToken}` },
      },
    );
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
      process.stderr.write(`hydra agent install ${agentId}: ${detail}\n`);
      process.exit(1);
    }
    body = (await r.json()) as typeof body;
  } catch (err) {
    process.stderr.write(
      `Could not reach daemon at ${baseUrl}: ${(err as Error).message}\n`,
    );
    process.exit(1);
    return;
  }

  if (!body.installed) {
    process.stdout.write(
      `${body.agentId} (${body.version}, ${body.distribution}): ${body.message ?? "nothing to install"}\n`,
    );
    return;
  }
  process.stdout.write(
    `Installed ${body.agentId} (${body.version}, ${body.distribution})\n`,
  );
  if (body.command) {
    process.stdout.write(`  → ${body.command}\n`);
  }
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

export async function runAgentsLogs(
  agentId: string | undefined,
  rest: string[],
): Promise<void> {
  if (!agentId) {
    process.stderr.write(
      "Usage: hydra-acp agent log <id> [--tail N] [--follow]\n",
    );
    process.exit(2);
    return;
  }
  const logPath = paths.agentLogFile(agentId);
  await runLogTail(logPath, rest, "No log file (agent never ran?)");
}

export async function runAgentsSet(
  agentId: string | undefined,
  modelId: string | undefined,
): Promise<void> {
  const config = await loadConfig();
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);

  if (!agentId) {
    const daemonView = await fetchDaemonAgentDefaults(baseUrl, serviceToken);
    const view = daemonView ?? readAgentDefaults(await readRawConfig());
    process.stdout.write(`${formatDefaultLine(view)}\n`);
    return;
  }

  let known: string[] | undefined;
  try {
    const r = await fetch(`${baseUrl}/v1/agents`, {
      headers: { Authorization: `Bearer ${serviceToken}` },
    });
    if (r.ok) {
      const body = (await r.json()) as { agents: AgentSummary[] };
      known = body.agents.map((a) => a.id);
    }
  } catch {
    void 0;
  }

  if (known !== undefined && !known.includes(agentId)) {
    process.stderr.write(
      `hydra agent set: '${agentId}' is not in the registry. Known ids: ${known.join(", ")}\n`,
    );
    process.exit(1);
    return;
  }

  const raw = await readRawConfig();
  if (modelId === undefined) {
    raw.defaultAgent = agentId;
    await writeRawConfig(raw);
  } else {
    // Model ids are opaque agent-specific strings (e.g. "claude-opus-4-7",
    // "openai/gpt-5-codex"), so we don't try to validate the model
    // against the agent — just write it through.
    const models =
      raw.defaultModels && typeof raw.defaultModels === "object"
        ? (raw.defaultModels as Record<string, unknown>)
        : {};
    models[agentId] = modelId;
    raw.defaultModels = models;
    await writeRawConfig(raw);
  }

  const disk = readAgentDefaults(await readRawConfig());
  if (modelId !== undefined && agentId !== disk.agent) {
    process.stdout.write(
      `Default model for ${agentId} is now ${modelId}.\n`,
    );
  }
  process.stdout.write(`${formatDefaultLine(disk)}\n`);

  const daemonView = await fetchDaemonAgentDefaults(baseUrl, serviceToken);
  if (daemonView === undefined) {
    return;
  }
  if (daemonView.agent === disk.agent && daemonView.model === disk.model) {
    return;
  }
  process.stdout.write(
    `Daemon still has ${formatAgentModel(daemonView)} — restart with \`hydra-acp daemon restart\` to apply.\n`,
  );
}

function formatDefaultLine(view: { agent: string; model?: string }): string {
  return `Default agent is ${formatAgentModel(view)}`;
}

function formatAgentModel(view: { agent: string; model?: string }): string {
  return view.model !== undefined
    ? `${view.agent} with ${view.model}`
    : view.agent;
}

function readAgentDefaults(
  raw: Record<string, unknown>,
): { agent: string; model?: string } {
  const agent =
    typeof raw.defaultAgent === "string" ? raw.defaultAgent : "(unset)";
  const models =
    raw.defaultModels && typeof raw.defaultModels === "object"
      ? (raw.defaultModels as Record<string, unknown>)
      : {};
  const rawModel = models[agent];
  return typeof rawModel === "string"
    ? { agent, model: rawModel }
    : { agent };
}

async function fetchDaemonAgentDefaults(
  baseUrl: string,
  serviceToken: string,
): Promise<{ agent: string; model?: string } | undefined> {
  try {
    const r = await fetch(`${baseUrl}/v1/config`, {
      headers: { Authorization: `Bearer ${serviceToken}` },
    });
    if (!r.ok) {
      return undefined;
    }
    const body = (await r.json()) as {
      defaultAgent?: unknown;
      defaultModels?: unknown;
    };
    return readAgentDefaults(body as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

async function readRawConfig(): Promise<Record<string, unknown>> {
  const raw = await fsp.readFile(paths.config(), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function writeRawConfig(raw: Record<string, unknown>): Promise<void> {
  await fsp.writeFile(
    paths.config(),
    JSON.stringify(raw, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600 },
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
