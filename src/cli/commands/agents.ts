import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  loadConfig,
  setDefaultAgent,
  setDefaultModelForAgent,
  setAgentOverride,
  setLocalAgent,
  setRegistryPinned,
  type LocalAgentConfig,
} from "../../core/config.js";
import { paths } from "../../core/paths.js";
import { currentPlatformKey } from "../../core/binary-install.js";
import { runLogTail } from "./log-tail.js";
import {
  daemonFetch,
  formatRelative,
  parseAddFlags,
  readRawConfig,
} from "./_shared.js";

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
  const res = await daemonFetch("/v1/agents", { expectStatus: 200 });
  const body = res.body as {
    version: string;
    fetchedAt?: number;
    agents: AgentSummary[];
  };

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
      ? ` (synced ${formatRelative(body.fetchedAt)})`
      : "";
  process.stdout.write(
    `\nRegistry version: ${body.version}${syncSuffix}\n`,
  );
}

// Validate an explicit --agent id against the daemon's registry before a
// caller commits to launching the TUI / cat (which only discover a bad id
// at session/new, after the terminal's already been taken over). Exits
// the process with a clear message + the known ids on a definitive
// mismatch. If the registry can't be reached we stay silent and let the
// later session/new path surface whatever error it would have.
// Preflights an explicit --agent id against the daemon's registry so a
// typo fails at the shell rather than mid-session after the TUI has
// taken over the terminal. Exits the process on a definitive miss;
// stays silent (and lets the caller proceed) when the registry is
// unreachable. The id is NOT rewritten to canonical form here — the
// daemon's SessionManager.create canonicalizes on session/new via
// Registry.getAgent's resolution ladder (exact id → npx basename →
// unique case-insensitive prefix), so the persisted session record
// always carries the canonical id regardless of what the user typed.
export async function assertKnownAgent(agentId: string): Promise<void> {
  const config = await loadConfig();
  if (config.agents[agentId] !== undefined) {
    return;
  }
  let known: string[];
  try {
    const res = await daemonFetch("/v1/agents", { rethrowNetworkError: true });
    if (!res.ok) {
      return;
    }
    const body = res.body as { agents: AgentSummary[] };
    known = body.agents.map((a) => a.id);
  } catch {
    return;
  }
  if (known.includes(agentId)) {
    return;
  }
  // Mirror Registry.getAgent's unique-prefix fallback so the preflight
  // doesn't reject an id the daemon would happily resolve. Ambiguous
  // prefixes fall through to the "unknown agent" error.
  const lc = agentId.toLowerCase();
  if (lc.length > 0) {
    const prefixHits = known.filter((id) => id.toLowerCase().startsWith(lc));
    if (prefixHits.length === 1) {
      return;
    }
  }
  process.stderr.write(
    `hydra-acp: unknown agent '${agentId}'. Run 'hydra-acp agent list' to see available agents.\n`,
  );
  process.exit(2);
}

// Resolve a user-typed agent id to its canonical registry id using the
// same ladder as Registry.getAgent / assertKnownAgent: exact id → unique
// case-insensitive prefix. Returns the input unchanged when the registry
// is unreachable so the downstream daemon call can produce the real
// error. Exits on ambiguous / unknown ids.
export async function resolveAgentIdOrExit(
  agentId: string,
  commandLabel: string,
): Promise<string> {
  let known: string[];
  try {
    const res = await daemonFetch("/v1/agents", { rethrowNetworkError: true });
    if (!res.ok) {
      return agentId;
    }
    const body = res.body as { agents: AgentSummary[] };
    known = body.agents.map((a) => a.id);
  } catch {
    return agentId;
  }
  if (known.includes(agentId)) {
    return agentId;
  }
  const lc = agentId.toLowerCase();
  if (lc.length > 0) {
    const prefixHits = known.filter((id) => id.toLowerCase().startsWith(lc));
    if (prefixHits.length === 1) {
      return prefixHits[0]!;
    }
    if (prefixHits.length > 1) {
      process.stderr.write(
        `${commandLabel}: '${agentId}' is ambiguous (matches ${prefixHits.join(", ")}).\n`,
      );
      process.exit(2);
    }
  }
  process.stderr.write(
    `${commandLabel}: unknown agent '${agentId}'. Run 'hydra-acp agent list' to see available agents.\n`,
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
  const canonical = await resolveAgentIdOrExit(agentId, "hydra agent install");
  process.stdout.write(`Installing ${canonical}…\n`);
  const res = await daemonFetch(
    `/v1/agents/${encodeURIComponent(canonical)}/install`,
    {
      method: "POST",
      expectStatus: 200,
      errorPrefix: `hydra agent install ${agentId}:`,
    },
  );
  const body = res.body as {
    agentId: string;
    version: string;
    distribution: string;
    installed: boolean;
    command?: string;
    message?: string;
  };

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
  const canonical = await resolveAgentIdOrExit(agentId, "hydra agent sync");
  const res = await daemonFetch(
    `/v1/agents/${encodeURIComponent(canonical)}/sync`,
    {
      method: "POST",
      expectStatus: 200,
      errorPrefix: `hydra agent sync ${agentId}:`,
    },
  );
  const body = res.body as { synced: SyncedSession[]; skipped: number };

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

  if (!agentId) {
    const daemonView = await fetchDaemonAgentDefaults();
    const view = daemonView ?? readAgentDefaults(await readRawConfig());
    process.stdout.write(`${formatDefaultLine(view)}\n`);
    return;
  }

  let known: string[] | undefined;
  try {
    const res = await daemonFetch("/v1/agents", { rethrowNetworkError: true });
    if (res.ok) {
      const body = res.body as { agents: AgentSummary[] };
      known = body.agents.map((a) => a.id);
    }
  } catch {
    void 0;
  }

  // A locally-defined agent (config.agents) is valid even when absent
  // from the registry — and shadows a registry agent of the same id.
  const isLocal = config.agents[agentId] !== undefined;
  if (!isLocal && known !== undefined && !known.includes(agentId)) {
    // Mirror the resolution ladder used by --agent and the other
    // subcommands: unique case-insensitive prefix match against the
    // registry rewrites to the canonical id.
    const lc = agentId.toLowerCase();
    const prefixHits =
      lc.length > 0 ? known.filter((id) => id.toLowerCase().startsWith(lc)) : [];
    if (prefixHits.length === 1) {
      agentId = prefixHits[0]!;
    } else if (prefixHits.length > 1) {
      process.stderr.write(
        `hydra agent set: '${agentId}' is ambiguous (matches ${prefixHits.join(", ")}).\n`,
      );
      process.exit(1);
      return;
    } else {
      process.stderr.write(
        `hydra agent set: '${agentId}' is not in the registry or config.agents. Known ids: ${known.join(", ")}\n`,
      );
      process.exit(1);
      return;
    }
  }

  // Model ids are opaque agent-specific strings (e.g. "claude-opus-4-7",
  // "openai/gpt-5-codex"), so we don't try to validate the model against
  // the agent. When a modelId is provided we only update the per-agent
  // default model; the top-level defaultAgent is only changed when the
  // user runs `hydra agent set <agent>` without a model.
  if (modelId !== undefined) {
    await setDefaultModelForAgent(agentId, modelId);
  } else {
    await setDefaultAgent(agentId);
  }

  const disk = readAgentDefaults(await readRawConfig());
  if (modelId !== undefined && agentId !== disk.agent) {
    process.stdout.write(
      `Default model for ${agentId} is now ${modelId}.\n`,
    );
  }
  process.stdout.write(`${formatDefaultLine(disk)}\n`);

  const daemonView = await fetchDaemonAgentDefaults();
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

async function fetchDaemonAgentDefaults(): Promise<
  { agent: string; model?: string } | undefined
> {
  try {
    const res = await daemonFetch("/v1/config", { rethrowNetworkError: true });
    if (!res.ok) {
      return undefined;
    }
    return readAgentDefaults(res.body as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

export async function runAgentsRefresh(): Promise<void> {
  const res = await daemonFetch("/v1/registry/refresh", {
    method: "POST",
    expectStatus: 200,
  });
  const body = res.body as { version: string; agentCount: number };
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
  const parsed = parseAddFlags(argv, "agent");
  const command = parsed.command as string | undefined;
  const def: LocalAgentConfig = {};
  if (command !== undefined) {
    def.command = command;
  }
  if (parsed.args.length > 0) {
    def.args = parsed.args;
  }
  if (Object.keys(parsed.env).length > 0) {
    def.env = parsed.env;
  }
  await setLocalAgent(agentId, def);
  const shown = command ?? `${agentId} (default — resolved off PATH)`;
  process.stdout.write(
    `Local agent ${agentId} → ${shown}${parsed.args.length > 0 ? " " + parsed.args.join(" ") : ""}\n`,
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

// `hydra agent uninstall <id>` — purge the on-disk install cache for
// <id> so the next launch triggers a fresh download / npm install.
//
// What this deletes:
//   ~/.hydra-acp/agents/<platformKey>/<canonicalId>/
//
// That covers both binary and npx distributions (the npm ABI-keyed
// subdir sits inside the version dir). Only the current platform is
// touched — a Hydra home shared across machines keeps the other
// platform's caches intact. Nothing else is disturbed: config,
// registry cache, logs, sessions, and any user-defined local agent
// override survive.
//
// Doesn't touch running agent processes. On Linux/macOS the kernel
// keeps the inode alive as long as the process holds it, so an
// in-flight agent finishes normally and only *new* spawns re-install.
//
// Local-only (like `agent remove`): operates on this machine's cache
// via the filesystem, not a daemon REST call. Won't reach across to a
// remote target.
export async function runAgentsUninstall(
  agentId: string | undefined,
): Promise<void> {
  if (!agentId) {
    process.stderr.write("Usage: hydra-acp agent uninstall <id>\n");
    process.exit(2);
    return;
  }
  const canonical = await resolveAgentIdOrExit(agentId, "hydra agent uninstall");
  const platform = currentPlatformKey();
  if (platform === undefined) {
    process.stderr.write(
      "hydra agent uninstall: cannot determine current platform; nothing removed.\n",
    );
    process.exit(1);
    return;
  }
  const installRoot = path.join(paths.agentsDir(), platform, canonical);
  let existed = false;
  try {
    await fs.stat(installRoot);
    existed = true;
  } catch {
    // ENOENT falls through as existed=false.
  }
  if (!existed) {
    process.stdout.write(
      `Nothing to remove: ${canonical} is not installed on ${platform}.\n`,
    );
    return;
  }
  await fs.rm(installRoot, { recursive: true, force: true });
  process.stdout.write(
    `Uninstalled ${canonical} (${platform}). Next session using it will re-install.\n`,
  );
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
