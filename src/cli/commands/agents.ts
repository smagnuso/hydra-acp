import * as fsp from "node:fs/promises";
import {
  loadConfig,
  setDefaultAgent,
  setAgentOverride,
  setLocalAgent,
  setRegistryPinned,
  type LocalAgentConfig,
} from "../../core/config.js";
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
  source?: "local" | "registry";
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
    source: a.source ?? "registry",
    distributions: a.distributions.join(","),
    installed: a.installed,
    description: a.description ?? "",
  }));
  const header = {
    id: "ID",
    name: "NAME",
    version: "VERSION",
    source: "SOURCE",
    distributions: "DIST",
    installed: "INSTALLED",
    description: "DESCRIPTION",
  };
  const widths = {
    id: maxLen(header.id, rows.map((r) => r.id)),
    name: maxLen(header.name, rows.map((r) => r.name)),
    version: maxLen(header.version, rows.map((r) => r.version)),
    source: maxLen(header.source, rows.map((r) => r.source)),
    distributions: maxLen(header.distributions, rows.map((r) => r.distributions)),
    installed: maxLen(header.installed, rows.map((r) => r.installed)),
  };
  const fmt = (r: typeof header): string =>
    [
      r.id.padEnd(widths.id),
      r.name.padEnd(widths.name),
      r.version.padEnd(widths.version),
      r.source.padEnd(widths.source),
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

// Validate an explicit --agent id against the daemon's registry before a
// caller commits to launching the TUI / cat (which only discover a bad id
// at session/new, after the terminal's already been taken over). Exits
// the process with a clear message + the known ids on a definitive
// mismatch. If the registry can't be reached we stay silent and let the
// later session/new path surface whatever error it would have.
export async function assertKnownAgent(agentId: string): Promise<void> {
  const config = await loadConfig();
  // A locally-defined agent is always valid — it doesn't need to be in
  // the registry, and the daemon may not have reloaded config yet.
  if (config.agents[agentId] !== undefined) {
    return;
  }
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  let known: string[];
  try {
    const r = await fetch(`${baseUrl}/v1/agents`, {
      headers: { Authorization: `Bearer ${serviceToken}` },
    });
    if (!r.ok) {
      return;
    }
    const body = (await r.json()) as { agents: AgentSummary[] };
    known = body.agents.map((a) => a.id);
  } catch {
    return;
  }
  if (known.includes(agentId)) {
    return;
  }
  process.stderr.write(
    `hydra-acp: unknown agent '${agentId}'. Run 'hydra-acp agent list' to see available agents.\n`,
  );
  process.exit(2);
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

  // A locally-defined agent (config.agents) is valid even when absent
  // from the registry — and shadows a registry agent of the same id.
  const isLocal = config.agents[agentId] !== undefined;
  if (!isLocal && known !== undefined && !known.includes(agentId)) {
    process.stderr.write(
      `hydra agent set: '${agentId}' is not in the registry or config.agents. Known ids: ${known.join(", ")}\n`,
    );
    process.exit(1);
    return;
  }

  // Model ids are opaque agent-specific strings (e.g. "claude-opus-4-7",
  // "openai/gpt-5-codex"), so we don't try to validate the model against
  // the agent — setDefaultAgent writes it through under defaultModels.
  await setDefaultAgent(agentId, modelId);

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

// `hydra agent pin <id> [packageSpec]` — pin a registry agent to a
// specific npm package spec (e.g. "opencode-ai@0.5.12"). With no spec,
// clears the pin. Requires a daemon restart to take effect on new spawns.
export async function runAgentsPin(
  agentId: string | undefined,
  packageSpec: string | undefined,
): Promise<void> {
  if (!agentId) {
    process.stderr.write(
      "Usage: hydra-acp agent pin <id> [packageSpec]   (omit packageSpec to clear)\n",
    );
    process.exit(2);
    return;
  }
  await setAgentOverride(agentId, packageSpec);
  if (packageSpec === undefined) {
    process.stdout.write(`Cleared version pin for ${agentId}.\n`);
  } else {
    process.stdout.write(`Pinned ${agentId} to ${packageSpec}.\n`);
  }
  process.stdout.write(
    "Restart with `hydra-acp daemon restart` to apply to new sessions.\n",
  );
}

// `hydra agent add <id> [--command CMD] [--args A,B,C] [--env K=V]...` —
// define (or update) a local agent that bypasses the registry. Mirrors
// `extensions add`. With no --command the executable defaults to <id>.
export async function runAgentsAdd(
  agentId: string | undefined,
  argv: string[],
): Promise<void> {
  if (!agentId) {
    process.stderr.write(
      "Usage: hydra-acp agent add <id> [--command CMD] [--args A,B,C] [--env K=V]...\n",
    );
    process.exit(2);
    return;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(agentId)) {
    process.stderr.write(
      `Invalid agent id '${agentId}': must match [A-Za-z0-9._-]+\n`,
    );
    process.exit(2);
    return;
  }
  const { command, args, env } = parseAgentAddFlags(argv);
  const def: LocalAgentConfig = {};
  if (command !== undefined) {
    def.command = command;
  }
  if (args.length > 0) {
    def.args = args;
  }
  if (Object.keys(env).length > 0) {
    def.env = env;
  }
  await setLocalAgent(agentId, def);
  const shown = command ?? `${agentId} (default — resolved off PATH)`;
  process.stdout.write(
    `Local agent ${agentId} → ${shown}${args.length > 0 ? " " + args.join(" ") : ""}\n`,
  );
  process.stdout.write(
    "Restart with `hydra-acp daemon restart` to apply to new sessions.\n",
  );
}

// `hydra agent remove <id>` — delete a local agent from config.
export async function runAgentsRemove(agentId: string | undefined): Promise<void> {
  if (!agentId) {
    process.stderr.write("Usage: hydra-acp agent remove <id>\n");
    process.exit(2);
    return;
  }
  await setLocalAgent(agentId, undefined);
  process.stdout.write(`Removed local agent ${agentId}.\n`);
  process.stdout.write(
    "Restart with `hydra-acp daemon restart` to apply to new sessions.\n",
  );
}

function parseAgentAddFlags(argv: string[]): {
  command: string | undefined;
  args: string[];
  env: Record<string, string>;
} {
  let command: string | undefined;
  let args: string[] = [];
  const env: Record<string, string> = {};
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === "--command") {
      const v = argv[i + 1];
      if (v === undefined) {
        process.stderr.write("--command requires a value\n");
        process.exit(2);
      }
      command = v;
      i += 2;
      continue;
    }
    if (tok === "--args") {
      const v = argv[i + 1];
      if (v === undefined) {
        process.stderr.write("--args requires a value\n");
        process.exit(2);
      }
      args = v.split(",").filter((s) => s.length > 0);
      i += 2;
      continue;
    }
    if (tok === "--env") {
      const v = argv[i + 1];
      if (v === undefined) {
        process.stderr.write("--env requires KEY=VALUE\n");
        process.exit(2);
      }
      const eq = v.indexOf("=");
      if (eq <= 0) {
        process.stderr.write(`Invalid --env value '${v}': expected KEY=VALUE\n`);
        process.exit(2);
      }
      env[v.slice(0, eq)] = v.slice(eq + 1);
      i += 2;
      continue;
    }
    process.stderr.write(`Unknown flag: ${tok}\n`);
    process.exit(2);
    return { command: undefined, args: [], env: {} };
  }
  return { command, args, env };
}

// `hydra registry pin` / `hydra registry unpin` — freeze (or unfreeze)
// the daemon on its on-disk registry cache so a bad upstream push can't
// be picked up. `hydra agent refresh` still forces a one-off fetch.
export async function runRegistryPin(pinned: boolean): Promise<void> {
  await setRegistryPinned(pinned);
  process.stdout.write(
    pinned
      ? "Registry pinned to the on-disk cache. `hydra-acp agent refresh` still forces a fetch.\n"
      : "Registry unpinned — the daemon will re-fetch per registry.ttlHours.\n",
  );
  process.stdout.write(
    "Restart with `hydra-acp daemon restart` to apply.\n",
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
