import * as fs from "node:fs/promises";
import { z } from "zod";
import { paths } from "./paths.js";
import type { HydraConfig } from "./config.js";
import {
  currentPlatformKey,
  ensureBinary,
  pickBinaryTarget,
} from "./binary-install.js";

const NpxDistribution = z.object({
  package: z.string(),
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

const Distribution = z.object({
  npx: NpxDistribution.optional(),
  binary: BinaryDistribution.optional(),
  uvx: UvxDistribution.optional(),
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

export class Registry {
  private cache: CachedRegistry | undefined;

  constructor(private config: HydraConfig) {}

  async load(): Promise<RegistryDocument> {
    if (this.cache && this.isFresh(this.cache.fetchedAt)) {
      return this.cache.data;
    }
    const onDisk = await this.readDiskCache();
    if (onDisk && this.isFresh(onDisk.fetchedAt)) {
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

  async getAgent(id: string): Promise<RegistryAgent | undefined> {
    const doc = await this.load();
    const exact = doc.agents.find((a) => a.id === id);
    if (exact) {
      return exact;
    }
    return doc.agents.find((a) => npxPackageBasename(a) === id);
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
    return { fetchedAt: Date.now(), raw, data };
  }

  private async readDiskCache(): Promise<CachedRegistry | undefined> {
    let text: string;
    try {
      text = await fs.readFile(paths.registryCache(), "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return undefined;
      }
      // Permission/IO problems are operator-level — surface them instead
      // of pretending the cache is just missing, which would mask a
      // misconfigured HYDRA_ACP_HOME.
      throw err;
    }
    // Anything past this point — truncation mid-write, hand-edited file,
    // schema drift from a future version — should NOT wedge the daemon.
    // Treat the cache as missing and let load() re-fetch instead.
    try {
      const parsed = JSON.parse(text) as { fetchedAt?: unknown; data?: unknown };
      if (typeof parsed.fetchedAt !== "number" || parsed.data === undefined) {
        return undefined;
      }
      const data = RegistryDocument.parse(parsed.data);
      return { fetchedAt: parsed.fetchedAt, raw: parsed.data, data };
    } catch {
      return undefined;
    }
  }

  // Atomic write: dump to a sibling temp path, then rename onto the
  // target. POSIX rename is atomic within a filesystem, so readers
  // either see the old file or the fully-written new file — never a
  // truncated middle. This also makes simultaneous writers safe
  // without a lock file: the loser of the rename race just gets its
  // version replaced by the winner's.
  private async writeDiskCache(cache: CachedRegistry): Promise<void> {
    await fs.mkdir(paths.home(), { recursive: true });
    const final = paths.registryCache();
    const tmp = `${final}.tmp-${process.pid}-${randSuffix()}`;
    const body =
      JSON.stringify(
        { fetchedAt: cache.fetchedAt, data: cache.raw },
        null,
        2,
      ) + "\n";
    try {
      await fs.writeFile(tmp, body, "utf8");
      await fs.rename(tmp, final);
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }
}

function randSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

export interface SpawnPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
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

// Caller-supplied args replace the registry's args entirely. When the caller
// passes nothing, the registry defaults are used. The previous "always append"
// behavior caused doubled args when an editor prefix (e.g. `hydra-acp launch`)
// forwarded the same ACP subcommand the registry already supplies — opencode's
// `acp acp` invocation died with -32603 once session/new ran.
export async function planSpawn(
  agent: RegistryAgent,
  callerArgs: string[] = [],
): Promise<SpawnPlan> {
  if (agent.distribution.npx) {
    const npx = agent.distribution.npx;
    const tail = callerArgs.length > 0 ? callerArgs : (npx.args ?? []);
    return {
      command: "npx",
      args: ["-y", npx.package, ...tail],
      env: npx.env ?? {},
    };
  }
  if (agent.distribution.binary) {
    const target = pickBinaryTarget(agent.distribution.binary);
    if (!target) {
      throw new Error(
        `Agent ${agent.id} has no binary distribution for ${currentPlatformKey() ?? "this platform"}.`,
      );
    }
    const cmdPath = await ensureBinary({
      agentId: agent.id,
      version: agent.version ?? "current",
      target,
    });
    const tail = callerArgs.length > 0 ? callerArgs : (target.args ?? []);
    return {
      command: cmdPath,
      args: tail,
      env: target.env ?? {},
    };
  }
  if (agent.distribution.uvx) {
    const uvx = agent.distribution.uvx;
    const tail = callerArgs.length > 0 ? callerArgs : (uvx.args ?? []);
    return {
      command: "uvx",
      args: [uvx.package, ...tail],
      env: uvx.env ?? {},
    };
  }
  throw new Error(`Agent ${agent.id} has no usable distribution method.`);
}
