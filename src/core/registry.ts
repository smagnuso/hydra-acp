import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { paths } from "./paths.js";
import type { HydraConfig } from "./config.js";
import { readJsonSafe, writeJsonAtomic } from "./json-store.js";
import {
  currentPlatformKey,
  ensureBinary,
  pickBinaryTarget,
  type BinaryInstallProgress,
} from "./binary-install.js";
import {
  ensureNpmPackage,
  type NpmInstallProgress,
} from "./npm-install.js";

// Unified install-progress event surface for callers that want a single
// callback regardless of which distribution channel (binary download vs.
// npm) actually services the request. Discriminated by `source` so
// downstream renderers can pick the right copy ("Downloading …" vs.
// "Installing … via npm").
export type AgentInstallProgress =
  | ({ source: "binary" } & BinaryInstallProgress)
  | ({ source: "npm" } & NpmInstallProgress);

export type AgentInstallProgressCallback = (event: AgentInstallProgress) => void;

const NpxDistribution = z.object({
  package: z.string(),
  // The bin to invoke after install. Defaults to the package basename
  // (e.g. "claude-code" for "@anthropic-ai/claude-code"). Required when
  // the package exposes a bin name that differs from its basename.
  bin: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const BinaryTarget = z.object({
  archive: z.string().url().optional(),
  cmd: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const BinaryDistribution = z.object({
  "darwin-aarch64": BinaryTarget.optional(),
  "darwin-x86_64": BinaryTarget.optional(),
  "linux-aarch64": BinaryTarget.optional(),
  "linux-x86_64": BinaryTarget.optional(),
  "windows-x86_64": BinaryTarget.optional(),
  "windows-aarch64": BinaryTarget.optional(),
});

const UvxDistribution = z.object({
  package: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

// A directly-executable command. Used only by config-defined local agents
// (config.agents) — never present in the network registry document. There
// is no install step: the daemon spawns `command` with `args`/`env` as-is.
const ExecDistribution = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const Onboarding = z.object({
  command: z.string().optional(),
  url: z.string().optional(),
  description: z.string().optional(),
});

const Distribution = z.object({
  npx: NpxDistribution.optional(),
  binary: BinaryDistribution.optional(),
  uvx: UvxDistribution.optional(),
  exec: ExecDistribution.optional(),
});

export const RegistryAgent = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  authors: z.array(z.string()).optional(),
  license: z.string().optional(),
  icon: z.string().optional(),
  repository: z.string().optional(),
  website: z.string().optional(),
  distribution: Distribution,
  onboarding: Onboarding.optional(),
  // Per-agent allowlist of env var names the client may opportunistically
  // forward at session/new time (e.g. ["OPENAI_API_KEY","OPENAI_BASE_URL"]).
  // Pure hint — the daemon does not enforce it; the bearer token already
  // gates the trust boundary.
  requiredEnv: z.array(z.string().min(1)).optional(),
});
export type RegistryAgent = z.infer<typeof RegistryAgent>;

export const RegistryDocument = z.object({
  version: z.string(),
  agents: z.array(RegistryAgent),
  extensions: z.array(z.unknown()).optional(),
});
export type RegistryDocument = z.infer<typeof RegistryDocument>;

// In-memory cache. `raw` is what gets persisted to disk verbatim — never
// run through zod. `data` is the zod-validated view used by callers.
// Keeping both means a future schema bump picks up fields the on-disk
// cache "didn't know about" simply by re-parsing the same raw bytes
// with the new schema; we never strip-then-rewrite.
interface CachedRegistry {
  fetchedAt: number;
  raw: unknown;
  data: RegistryDocument;
}

export interface RegistryOptions {
  // Fires after every successful network fetch (both explicit refresh()
  // and the TTL-driven refetch inside load()). The callback's errors are
  // swallowed so a faulty hook can never wedge a registry refresh.
  onFetched?: (doc: RegistryDocument) => void | Promise<void>;
}

export class Registry {
  private cache: CachedRegistry | undefined;

  constructor(
    private config: HydraConfig,
    private options: RegistryOptions = {},
  ) {}

  async load(): Promise<RegistryDocument> {
    if (this.cache && (this.isPinned() || this.isFresh(this.cache.fetchedAt))) {
      return this.cache.data;
    }
    const onDisk = await this.readDiskCache();
    if (onDisk && (this.isPinned() || this.isFresh(onDisk.fetchedAt))) {
      this.cache = onDisk;
      return onDisk.data;
    }
    try {
      const fresh = await this.fetchFromNetwork();
      this.cache = fresh;
      await this.writeDiskCache(fresh);
      return fresh.data;
    } catch (err) {
      if (onDisk) {
        this.cache = onDisk;
        return onDisk.data;
      }
      throw err;
    }
  }

  async refresh(): Promise<RegistryDocument> {
    const fresh = await this.fetchFromNetwork();
    this.cache = fresh;
    await this.writeDiskCache(fresh);
    return fresh.data;
  }

  // Epoch ms of the last successful registry fetch (in-memory or
  // disk). Returns undefined before load()/refresh() has populated the
  // cache. Used by `/v1/agents` to surface "synced N minutes ago" in
  // the CLI without exposing the full cache shape.
  lastFetchedAt(): number | undefined {
    return this.cache?.fetchedAt;
  }

  async getAgent(id: string): Promise<RegistryAgent | undefined> {
    // Config-defined local agents shadow the registry — check them first
    // so a user can override a broken registry agent by id.
    const local = this.localAgents().find((a) => a.id === id);
    if (local) {
      return local;
    }
    const doc = await this.load();
    const exact = doc.agents.find((a) => a.id === id);
    if (exact) {
      return this.applyOverride(exact);
    }
    const byBasename = doc.agents.find((a) => npxPackageBasename(a) === id);
    return byBasename ? this.applyOverride(byBasename) : undefined;
  }

  // Synthesize RegistryAgent entries from config.agents. These carry an
  // `exec` distribution and a fixed "local" version key (no install dir).
  localAgents(): RegistryAgent[] {
    return Object.entries(this.config.agents ?? {}).map(([id, def]) => ({
      id,
      name: def.name ?? id,
      description: def.description,
      version: "local",
      distribution: {
        exec: {
          // Default the command to the agent id (like extensions default
          // theirs to the extension name) — resolved off PATH at spawn.
          command: def.command ?? id,
          args: def.args,
          env: def.env,
        },
      },
    }));
  }

  // Apply a config.agentOverrides[id] pin to a registry agent: swap the
  // npx package spec and key the install dir on the pinned version so it
  // never collides with the floating "current" install. No-op when the
  // agent has no override or isn't npx-distributed.
  private applyOverride(agent: RegistryAgent): RegistryAgent {
    const override = this.config.agentOverrides?.[agent.id];
    if (!override?.packageSpec || !agent.distribution.npx) {
      return agent;
    }
    return {
      ...agent,
      version: versionKeyFromSpec(override.packageSpec),
      distribution: {
        ...agent.distribution,
        npx: { ...agent.distribution.npx, package: override.packageSpec },
      },
    };
  }

  private isPinned(): boolean {
    return this.config.registry?.pinned === true;
  }

  private isFresh(fetchedAt: number): boolean {
    const ageMs = Date.now() - fetchedAt;
    const ttlMs = this.config.registry.ttlHours * 60 * 60 * 1000;
    return ageMs < ttlMs;
  }

  private async fetchFromNetwork(): Promise<CachedRegistry> {
    const response = await fetch(this.config.registry.url);
    if (!response.ok) {
      throw new Error(`Registry fetch failed: HTTP ${response.status}`);
    }
    const raw = await response.json();
    const data = RegistryDocument.parse(raw);
    const cached: CachedRegistry = { fetchedAt: Date.now(), raw, data };
    const hook = this.options.onFetched;
    if (hook) {
      // Fire-and-forget: never let a misbehaving hook wedge a refresh.
      void Promise.resolve()
        .then(() => hook(data))
        .catch(() => undefined);
    }
    return cached;
  }

  private async readDiskCache(): Promise<CachedRegistry | undefined> {
    // Anything that isn't a fully-valid cache — missing, empty,
    // truncated mid-write, hand-edited, or schema-drifted — should NOT
    // wedge the daemon. Treat any failure as "no cache" and let load()
    // re-fetch instead. readJsonSafe surfaces only genuine IO errors
    // (permission, etc.), which we deliberately re-throw because those
    // signal a misconfigured HYDRA_ACP_HOME.
    const parsed = await readJsonSafe<{ fetchedAt?: unknown; data?: unknown }>(
      paths.registryCache(),
    );
    if (!parsed || typeof parsed.fetchedAt !== "number" || parsed.data === undefined) {
      return undefined;
    }
    try {
      const data = RegistryDocument.parse(parsed.data);
      return { fetchedAt: parsed.fetchedAt, raw: parsed.data, data };
    } catch {
      return undefined;
    }
  }

  private async writeDiskCache(cache: CachedRegistry): Promise<void> {
    await writeJsonAtomic(paths.registryCache(), {
      fetchedAt: cache.fetchedAt,
      data: cache.raw,
    });
  }
}

export interface SpawnPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  // Version string used to construct the install dir. Mirrors the
  // `version: agent.version ?? "current"` default that ensureBinary /
  // ensureNpmPackage already use, so the prune sweep can identify
  // which install dirs are owned by live agents.
  version: string;
}

// Derive an install-dir version key from a pinned package spec. For
// "opencode-ai@0.5.12" → "0.5.12"; for a scoped "@scope/pkg@1.2.3" →
// "1.2.3"; for a bare "opencode-ai" (no version) → "pinned" so it still
// gets its own dir distinct from the floating "current" install. Any
// filesystem-hostile characters (dist-tags, ranges like "^1") are
// sanitized to keep the path safe.
function versionKeyFromSpec(spec: string): string {
  const lastAt = spec.lastIndexOf("@");
  const version = lastAt > 0 ? spec.slice(lastAt + 1) : "";
  const sanitized = version.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.length > 0 ? `pin-${sanitized}` : "pinned";
}

function npxPackageBasename(agent: RegistryAgent): string | undefined {
  const pkg = agent.distribution.npx?.package;
  if (!pkg) {
    return undefined;
  }
  const lastSlash = pkg.lastIndexOf("/");
  const afterSlash = lastSlash === -1 ? pkg : pkg.slice(lastSlash + 1);
  const atIdx = afterSlash.lastIndexOf("@");
  return atIdx <= 0 ? afterSlash : afterSlash.slice(0, atIdx);
}

// "yes" → an install dir for this agent's current version is on disk
// for this platform. "no" → npx/binary agent that hasn't been
// pre-installed yet. "lazy" → uvx-only; nothing to pre-install
// because uvx resolves on first run.
export type AgentInstallState = "yes" | "no" | "lazy";

// One entry in the agent-list view (REST `GET /v1/agents` and the ACP
// `hydra-acp/agents/list` method share this shape).
export interface AgentListEntry {
  id: string;
  name: string;
  version: string | undefined;
  description: string | undefined;
  distributions: string[];
  installed: AgentInstallState;
  // Where this entry came from: "local" → config.agents (shadows any
  // same-id registry entry); "registry" → the network registry document.
  source: "local" | "registry";
  // Optional onboarding hints (T4) — surfaced so the TUI can paint a
  // helpful AUTH_REQUIRED banner without a second round trip.
  onboarding?: {
    command?: string;
    url?: string;
    description?: string;
  };
}

export interface AgentListResult {
  version: string;
  fetchedAt: number | undefined;
  agents: AgentListEntry[];
}

// Shared builder for the agent catalog a client can choose from when
// creating a session. Backs both the REST endpoint and the ACP method
// so the two surfaces never drift.
export async function listAgents(registry: Registry): Promise<AgentListResult> {
  // Tolerate registry doubles (tests) that don't implement localAgents.
  const local =
    typeof registry.localAgents === "function" ? registry.localAgents() : [];
  // When the registry is unreachable and the user only relies on local
  // agents, still surface those rather than failing the whole list.
  let doc: RegistryDocument;
  try {
    doc = await registry.load();
  } catch (err) {
    if (local.length === 0) {
      throw err;
    }
    doc = { version: "local-only", agents: [] };
  }
  const localIds = new Set(local.map((a) => a.id));
  // Local agents shadow registry entries of the same id.
  const merged = [...local, ...doc.agents.filter((a) => !localIds.has(a.id))];
  const agents = await Promise.all(
    merged.map(async (a) => ({
      id: a.id,
      name: a.name,
      version: a.version,
      description: a.description,
      distributions: Object.keys(a.distribution),
      installed: await agentInstallState(a),
      source: localIds.has(a.id)
        ? ("local" as const)
        : ("registry" as const),
      ...(a.onboarding ? { onboarding: a.onboarding } : {}),
    })),
  );
  return {
    version: doc.version,
    fetchedAt: registry.lastFetchedAt(),
    agents,
  };
}

export async function agentInstallState(
  agent: RegistryAgent,
): Promise<AgentInstallState> {
  const platformKey = currentPlatformKey();
  if (!platformKey) {
    return "no";
  }
  const version = agent.version ?? "current";
  // Local exec agents are always "installed" — there's nothing to fetch.
  if (agent.distribution.exec) {
    return "yes";
  }
  if (agent.distribution.binary) {
    const target = pickBinaryTarget(agent.distribution.binary, platformKey);
    if (target?.cmd) {
      const cmdPath = path.resolve(
        paths.agentInstallDir(agent.id, platformKey, version),
        target.cmd,
      );
      if (await fileExists(cmdPath)) {
        return "yes";
      }
    }
  }
  if (agent.distribution.npx) {
    const npx = agent.distribution.npx;
    const bin = npx.bin ?? npxPackageBasename(agent) ?? npx.package;
    const installDir = paths.agentNpmInstallDir(agent.id, platformKey, version);
    const binPath = path.join(installDir, "node_modules", ".bin", bin);
    if (await fileExists(binPath)) {
      return "yes";
    }
  }
  if (
    !agent.distribution.npx &&
    !agent.distribution.binary &&
    agent.distribution.uvx
  ) {
    return "lazy";
  }
  return "no";
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Caller-supplied args replace the registry's args entirely. When the caller
// passes nothing, the registry defaults are used. The previous "always append"
// behavior caused doubled args when an editor prefix (e.g. `hydra-acp launch`)
// forwarded the same ACP subcommand the registry already supplies — opencode's
// `acp acp` invocation died with -32603 once session/new ran.
export async function planSpawn(
  agent: RegistryAgent,
  callerArgs: string[] = [],
  options: {
    npmRegistry?: string;
    onInstallProgress?: AgentInstallProgressCallback;
  } = {},
): Promise<SpawnPlan> {
  const version = agent.version ?? "current";
  if (agent.distribution.npx) {
    const npx = agent.distribution.npx;
    const tail = callerArgs.length > 0 ? callerArgs : (npx.args ?? []);
    // HYDRA_ACP_SKIP_NPM_PREFETCH lets the test suite (and any debugging
    // scenario that wants the legacy `npx -y` behavior) skip the local
    // install — useful in environments where invoking `npm install` is
    // either undesirable or impossible.
    if (process.env.HYDRA_ACP_SKIP_NPM_PREFETCH) {
      return {
        command: "npx",
        args: ["-y", npx.package, ...tail],
        env: npx.env ?? {},
        version,
      };
    }
    const bin = npx.bin ?? npxPackageBasename(agent) ?? npx.package;
    const npmCb = options.onInstallProgress;
    const binPath = await ensureNpmPackage({
      agentId: agent.id,
      version,
      packageSpec: npx.package,
      bin,
      registry: options.npmRegistry,
      onProgress: npmCb
        ? (e) => npmCb({ source: "npm", ...e })
        : undefined,
    });
    return {
      command: binPath,
      args: tail,
      env: npx.env ?? {},
      version,
    };
  }
  if (agent.distribution.binary) {
    const target = pickBinaryTarget(agent.distribution.binary);
    if (!target) {
      throw new Error(
        `Agent ${agent.id} has no binary distribution for ${currentPlatformKey() ?? "this platform"}.`,
      );
    }
    const binCb = options.onInstallProgress;
    const cmdPath = await ensureBinary({
      agentId: agent.id,
      version,
      target,
      onProgress: binCb
        ? (e) => binCb({ source: "binary", ...e })
        : undefined,
    });
    const tail = callerArgs.length > 0 ? callerArgs : (target.args ?? []);
    return {
      command: cmdPath,
      args: tail,
      env: target.env ?? {},
      version,
    };
  }
  if (agent.distribution.uvx) {
    const uvx = agent.distribution.uvx;
    const tail = callerArgs.length > 0 ? callerArgs : (uvx.args ?? []);
    return {
      command: "uvx",
      args: [uvx.package, ...tail],
      env: uvx.env ?? {},
      version,
    };
  }
  if (agent.distribution.exec) {
    const exec = agent.distribution.exec;
    const tail = callerArgs.length > 0 ? callerArgs : (exec.args ?? []);
    return {
      command: exec.command,
      args: tail,
      env: exec.env ?? {},
      version,
    };
  }
  throw new Error(`Agent ${agent.id} has no usable distribution method.`);
}
