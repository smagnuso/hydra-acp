import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { paths } from "./paths.js";
import {
  expandHome,
  type HydraConfig,
  type LocalAgentConfig,
} from "./config.js";
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

// A RegistryAgent after config.agents `extends` resolution. The extra
// fields are synthesized locally and are deliberately NOT part of the
// zod schema above — nothing in the network registry document may set
// them, since `installId` feeds a filesystem path.
export interface ResolvedAgent extends RegistryAgent {
  // Identity used to key install dirs, which would otherwise be the agent
  // id. A derived agent that only layers env on its base must share the
  // base's install dir rather than download a second identical copy, so
  // this is the nearest ancestor at or above the agent that last changed
  // the distribution. Undefined means "same as id".
  installId?: string;
  // Inheritance chain, most specific first: [id, base, base's base, …].
  // Canonical ids as resolved (so `extends: "pi"` records `pi-acp`), which
  // is what lets per-agent config maps be walked most-specific-first.
  extendsChain?: string[];
}

// Depth cap on `extends`. Cycles are caught exactly by the stack check;
// this is the backstop for a chain that is merely absurd.
const MAX_AGENT_EXTENDS_DEPTH = 8;

// The install identity for an agent: what `paths.agent*InstallDir` should
// be keyed on. Derived agents that share a base's distribution share its
// install dir.
export function agentInstallId(agent: ResolvedAgent): string {
  return agent.installId ?? agent.id;
}

// Which session store an agent reads from, approximated by the root of
// its `extends` chain.
//
// Two agent ids that derive from the same base usually read the same
// agent-side session store: `claude-acp-dev` swaps the command but still
// reads `~/.claude`, so `session/list` returns exactly what `claude-acp`
// returns. Anything that dedupes upstream sessions per agent id must key
// on this instead, or each sibling imports the whole store again under a
// fresh hydra id.
//
// It is an approximation in one direction only: a derived agent that
// repoints its config dir (`claude-home` with CLAUDE_CONFIG_DIR) has a
// genuinely separate store but still reports its base's root. That is
// harmless as long as agents mint session ids unique across stores — they
// are UUIDs in every agent we ship — because a false match needs two
// disjoint stores to produce the same id. If an agent ever turns up with
// ids that are only unique *within* a store, this needs a real store
// identity rather than the chain root.
export function agentChainRoot(agent: ResolvedAgent): string {
  const chain = agent.extendsChain;
  return chain && chain.length > 0 ? chain[chain.length - 1]! : agent.id;
}

// Narrower than ResolvedAgent so callers that only have an id plus a
// resolved chain (e.g. the TUI's AgentListEntry-derived agent list, which
// isn't a full ResolvedAgent) can use lookupInheritedAgentValue too.
export interface AgentChainRef {
  id: string;
  extendsChain?: string[];
}

// Most-specific-wins lookup over a config map keyed by agent id
// (defaultModels, agentOverrides): try the agent's own id, then each id it
// extends, in order. `from` is the key that actually matched, so callers
// can name it in diagnostics rather than reporting the id the user asked
// for and leaving them hunting for a setting they never wrote.
export function lookupInheritedAgentValue<T>(
  map: Record<string, T> | undefined,
  agent: AgentChainRef,
): { value: T; from: string } | undefined {
  if (!map) {
    return undefined;
  }
  for (const key of agent.extendsChain ?? [agent.id]) {
    const value = map[key];
    if (value !== undefined) {
      return { value, from: key };
    }
  }
  return undefined;
}

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
  // Fires when a config.agents entry can't be resolved during
  // resolvedLocalAgents() — a broken `extends`. The catalog drops the
  // entry and keeps going; this is how the reason reaches daemon.log.
  onResolveError?: (agentId: string, err: Error) => void;
  // Fires when a network fetch fails and load() silently serves the
  // stale on-disk cache instead. Without this hook a machine that can't
  // reach the registry keeps resolving weeks-old agent versions with no
  // indication anywhere; ageMs says how old the served cache is.
  onStaleFallback?: (err: Error, ageMs: number) => void;
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
        const hook = this.options.onStaleFallback;
        if (hook) {
          // Same containment as onFetched: a faulty hook must not turn a
          // survivable fetch failure into a failed load.
          try {
            hook(err as Error, Date.now() - onDisk.fetchedAt);
          } catch {
            // ignore
          }
        }
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

  // Swap the config backing agent resolution. Every read of `this.config`
  // is per-call (findLocalDef, localAgents, applyOverride, the registry
  // url/ttl/pinned checks), so a replacement takes effect on the next
  // getAgent without touching the fetched-document cache — a config edit
  // shouldn't force a network refetch.
  //
  // Only affects FUTURE spawns. A session already running an agent keeps
  // its process until it restarts, which is the same way defaultModels
  // has always behaved on resurrect.
  setConfig(next: HydraConfig): void {
    this.config = next;
  }

  async getAgent(id: string): Promise<ResolvedAgent | undefined> {
    return this.resolveAgent(id, []);
  }

  // `stack` carries the derived ids already being resolved, innermost
  // last, so an `extends` cycle is caught exactly rather than by depth
  // alone (and can name the loop in the error).
  private async resolveAgent(
    id: string,
    stack: string[],
  ): Promise<ResolvedAgent | undefined> {
    // Config-defined local agents shadow the registry — check them first
    // so a user can override a broken registry agent by id.
    const local = this.findLocalDef(id);
    if (local) {
      if (local.def.extends === undefined) {
        return {
          ...synthesizeLocalAgent(local.id, local.def),
          extendsChain: [local.id],
        };
      }
      if (stack.includes(local.id)) {
        throw new Error(
          `agent ${local.id}: extends cycle (${[...stack, local.id].join(" -> ")})`,
        );
      }
      if (stack.length + 1 >= MAX_AGENT_EXTENDS_DEPTH) {
        throw new Error(
          `agent ${local.id}: extends chain deeper than ${MAX_AGENT_EXTENDS_DEPTH} (${[...stack, local.id].join(" -> ")})`,
        );
      }
      // Recurse through the same resolution so a base named by its
      // shorthand resolves the way `--agent` would (`extends: "pi"` →
      // `pi-acp`), and so chains of derived agents compose.
      const base = await this.resolveAgent(local.def.extends, [
        ...stack,
        local.id,
      ]);
      if (!base) {
        throw new Error(
          `agent ${local.id}: extends ${JSON.stringify(local.def.extends)}, which is not a known agent`,
        );
      }
      // applyOverride last so a packageSpec pin on the *derived* id wins
      // over one inherited from the base.
      return this.applyOverride(deriveAgent(local.id, local.def, base));
    }
    const doc = await this.load();
    const exact = doc.agents.find((a) => a.id === id);
    if (exact) {
      return this.applyOverride(exact);
    }
    const byBasename = doc.agents.find((a) => npxPackageBasename(a) === id);
    if (byBasename) {
      return this.applyOverride(byBasename);
    }
    const lcId = id.toLowerCase();
    // Implied `-acp` suffix: `--agent pi` means `pi-acp`. Checked before
    // the prefix rule so shorthand still resolves when sibling ids share
    // the prefix (e.g. local pi-dev / pi-local).
    const bySuffix = doc.agents.find(
      (a) => a.id.toLowerCase() === `${lcId}-acp`,
    );
    if (bySuffix) {
      return this.applyOverride(bySuffix);
    }
    // Unique-prefix fuzzy match on agent id (case-insensitive). Lets a
    // user type `--agent claude` and get `claude-acp` without having to
    // know the canonical id, but only when the prefix unambiguously
    // resolves to a single agent. Ambiguous prefixes (e.g. `co` →
    // codex-acp / codebuddy-code / cortex-code) deliberately fail so
    // the caller surfaces a "not found" rather than silently picking
    // the first hit.
    if (lcId.length > 0) {
      const prefixHits = doc.agents.filter((a) =>
        a.id.toLowerCase().startsWith(lcId),
      );
      if (prefixHits.length === 1) {
        return this.applyOverride(prefixHits[0]!);
      }
    }
    return undefined;
  }

  // Locate a config.agents entry by id, applying the same implied `-acp`
  // shorthand the registry lookup below uses.
  private findLocalDef(
    id: string,
  ): { id: string; def: LocalAgentConfig } | undefined {
    const agents = this.config.agents ?? {};
    const exact = agents[id];
    if (exact) {
      return { id, def: exact };
    }
    const lc = id.toLowerCase();
    for (const [key, def] of Object.entries(agents)) {
      if (key.toLowerCase() === `${lc}-acp`) {
        return { id: key, def };
      }
    }
    return undefined;
  }

  // Synthesize RegistryAgent entries from config.agents. These carry an
  // `exec` distribution and a fixed "local" version key (no install dir).
  // `~/...` and `$HOME/...` are expanded in the command and args so users
  // can write portable entries pointing at scripts under their home dir.
  //
  // Entries using `extends` are omitted: their distribution comes from a
  // base that may only be resolvable asynchronously (registry load), and
  // synthesizing one here would default its command to the agent id and
  // produce a bogus `exec` entry. Callers that need those resolved go
  // through resolvedLocalAgents().
  localAgents(): RegistryAgent[] {
    return Object.entries(this.config.agents ?? {})
      .filter(([, def]) => def.extends === undefined)
      .map(([id, def]) => synthesizeLocalAgent(id, def));
  }

  // Every config.agents entry, with `extends` resolved. A single broken
  // entry (cycle, unknown base) is dropped with a log line rather than
  // failing the whole catalog — the agent list is also how a user would
  // go looking for what they broke.
  async resolvedLocalAgents(): Promise<ResolvedAgent[]> {
    const out: ResolvedAgent[] = [];
    for (const id of Object.keys(this.config.agents ?? {})) {
      try {
        const resolved = await this.resolveAgent(id, []);
        if (resolved) {
          out.push(resolved);
        }
      } catch (err) {
        this.options.onResolveError?.(id, err as Error);
      }
    }
    return out;
  }

  // Apply a config.agentOverrides[id] pin to a registry agent: swap the
  // npx package spec (keying the install dir on the pinned version so it
  // never collides with the floating "current" install), append extraArgs
  // onto whichever distribution kind the agent resolves to, and/or merge
  // env onto it. No-op when the agent has no override.
  private applyOverride(agent: ResolvedAgent): ResolvedAgent {
    const withChain: ResolvedAgent = agent.extendsChain
      ? agent
      : { ...agent, extendsChain: [agent.id] };
    const override = this.config.agentOverrides?.[withChain.id];
    if (!override) {
      return withChain;
    }

    let distribution = withChain.distribution;
    let version = withChain.version;
    let installId = withChain.installId;

    if (override.packageSpec && distribution.npx) {
      version = versionKeyFromSpec(override.packageSpec);
      // Pinning a different package makes this a distinct install, so it
      // stops sharing whatever install dir it inherited.
      installId = withChain.id;
      distribution = {
        ...distribution,
        npx: { ...distribution.npx, package: override.packageSpec },
      };
    }

    if (override.extraArgs?.length) {
      distribution = appendExtraArgsToDistribution(distribution, override.extraArgs);
    }

    // Reuses the derived-agent env overlay so the merge semantics are
    // identical either way the user reaches for env: override wins over
    // the distribution's own entries, key by key.
    if (override.env && Object.keys(override.env).length > 0) {
      distribution = mergeIntoDistribution(distribution, { env: override.env });
    }

    if (distribution === withChain.distribution) {
      return withChain;
    }
    return { ...withChain, version, installId, distribution };
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
  // Identity the install dir is keyed on — the agent's own id, unless it
  // derives from another agent without changing the distribution, in
  // which case it shares the base's install. Carried here so the prune
  // sweep sees the same identity the installer used; keying the live-agent
  // set on the derived id instead would leave a shared dir unprotected.
  // Optional so a hand-built plan (tests, fixtures) can omit it; consumers
  // fall back to the agent id.
  installId?: string;
}

// A config.agents entry that defines its own command, as a RegistryAgent.
// `~/...` and `$HOME/...` are expanded so users can write portable entries
// pointing at scripts under their home dir.
function synthesizeLocalAgent(
  id: string,
  def: LocalAgentConfig,
): RegistryAgent {
  return {
    id,
    name: def.name ?? id,
    description: def.description,
    version: "local",
    distribution: {
      exec: {
        // Default the command to the agent id (like extensions default
        // theirs to the extension name) — resolved off PATH at spawn.
        command: expandHome(def.command ?? id),
        args: def.args?.map(expandHome),
        env: def.env,
      },
    },
  };
}

// Layer `env` / `args` onto whichever distribution kinds the base
// actually uses, so a derived agent can set an env var without knowing
// how its base is packaged (and keeps working if the registry later
// switches that agent from npx to binary). env merges, args replace.
function mergeIntoDistribution(
  base: RegistryAgent["distribution"],
  def: LocalAgentConfig,
): RegistryAgent["distribution"] {
  const args = def.args?.map(expandHome);
  const overlay = <T extends { args?: string[]; env?: Record<string, string> }>(
    target: T,
  ): T => ({
    ...target,
    ...(args ? { args } : {}),
    ...(def.env ? { env: { ...target.env, ...def.env } } : {}),
  });
  return {
    ...(base.npx ? { npx: overlay(base.npx) } : {}),
    ...(base.uvx ? { uvx: overlay(base.uvx) } : {}),
    ...(base.exec ? { exec: overlay(base.exec) } : {}),
    ...(base.binary
      ? {
          // Per-platform map: overlay each target that's actually present.
          binary: Object.fromEntries(
            Object.entries(base.binary).map(([platform, target]) => [
              platform,
              target ? overlay(target) : target,
            ]),
          ),
        }
      : {}),
  };
}

// Append extraArgs onto whichever distribution kinds are actually present,
// leaving each distribution's own args in place ahead of them.
function appendExtraArgsToDistribution(
  base: RegistryAgent["distribution"],
  extraArgs: string[],
): RegistryAgent["distribution"] {
  const overlay = <T extends { args?: string[] }>(target: T): T => ({
    ...target,
    args: [...(target.args ?? []), ...extraArgs],
  });
  return {
    ...(base.npx ? { npx: overlay(base.npx) } : {}),
    ...(base.uvx ? { uvx: overlay(base.uvx) } : {}),
    ...(base.exec ? { exec: overlay(base.exec) } : {}),
    ...(base.binary
      ? {
          binary: Object.fromEntries(
            Object.entries(base.binary).map(([platform, target]) => [
              platform,
              target ? overlay(target) : target,
            ]),
          ),
        }
      : {}),
  };
}

// Build a derived agent from a config.agents entry and its resolved base.
// Objects merge, scalars and arrays replace, the derived entry wins.
function deriveAgent(
  id: string,
  def: LocalAgentConfig,
  base: ResolvedAgent,
): ResolvedAgent {
  // A command REPLACES the inherited distribution rather than merging
  // into it. planSpawn checks npx/binary/uvx before exec, so leaving the
  // base's distribution alongside a new exec would silently spawn the
  // base agent and quietly ignore the command.
  const replacesDistribution = def.command !== undefined;
  return {
    ...base,
    id,
    name: def.name ?? base.name,
    description: def.description ?? base.description,
    version: replacesDistribution ? "local" : base.version,
    distribution: replacesDistribution
      ? synthesizeLocalAgent(id, def).distribution
      : mergeIntoDistribution(base.distribution, def),
    installId: replacesDistribution ? id : (base.installId ?? base.id),
    extendsChain: [id, ...(base.extendsChain ?? [base.id])],
  };
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
  // Inheritance chain, most specific first (see ResolvedAgent). Lets a
  // client resolve per-agent config maps like defaultModels correctly for
  // a derived agent instead of only checking its own id.
  extendsChain?: string[];
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
  // Tolerate registry doubles (tests) that don't implement either hook.
  // resolvedLocalAgents is preferred because it also covers config.agents
  // entries that use `extends` — localAgents() skips those, since their
  // distribution isn't knowable without resolving the base.
  const local: ResolvedAgent[] =
    typeof registry.resolvedLocalAgents === "function"
      ? await registry.resolvedLocalAgents()
      : typeof registry.localAgents === "function"
        ? registry.localAgents()
        : [];
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
  // Local agents shadow registry entries of the same id. Typed as
  // ResolvedAgent[] (registry-only entries satisfy it structurally, since
  // extendsChain/installId are optional) so extendsChain is readable below.
  const merged: ResolvedAgent[] = [
    ...local,
    ...doc.agents.filter((a) => !localIds.has(a.id)),
  ];
  const agents = await Promise.all(
    merged.map(async (a) => ({
      id: a.id,
      name: a.name,
      version: a.version,
      description: a.description,
      distributions: Object.keys(a.distribution),
      installed: await agentInstallState(a),
      ...(a.extendsChain ? { extendsChain: a.extendsChain } : {}),
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
  agent: ResolvedAgent,
): Promise<AgentInstallState> {
  const platformKey = currentPlatformKey();
  if (!platformKey) {
    return "no";
  }
  const version = agent.version ?? "current";
  const installId = agentInstallId(agent);
  // Local exec agents are always "installed" — there's nothing to fetch.
  if (agent.distribution.exec) {
    return "yes";
  }
  if (agent.distribution.binary) {
    const target = pickBinaryTarget(agent.distribution.binary, platformKey);
    if (target?.cmd) {
      const cmdPath = path.resolve(
        paths.agentInstallDir(installId, platformKey, version),
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
    const installDir = paths.agentNpmInstallDir(installId, platformKey, version);
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
  agent: ResolvedAgent,
  callerArgs: string[] = [],
  options: {
    npmRegistry?: string;
    onInstallProgress?: AgentInstallProgressCallback;
  } = {},
): Promise<SpawnPlan> {
  const version = agent.version ?? "current";
  const installId = agentInstallId(agent);
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
        installId,
      };
    }
    const bin = npx.bin ?? npxPackageBasename(agent) ?? npx.package;
    const npmCb = options.onInstallProgress;
    const binPath = await ensureNpmPackage({
      agentId: installId,
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
      installId,
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
      agentId: installId,
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
      installId,
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
      installId,
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
      installId,
    };
  }
  throw new Error(`Agent ${agent.id} has no usable distribution method.`);
}
