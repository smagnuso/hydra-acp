import * as fs from "node:fs/promises";
import { z } from "zod";
import { paths } from "./paths.js";
import type { HydraConfig } from "./config.js";

const NpxDistribution = z.object({
  package: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const BinaryTarget = z.object({
  archive: z.string().url().optional(),
  cmd: z.string().optional(),
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

interface CachedRegistry {
  fetchedAt: number;
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
    return doc.agents.find((a) => a.id === id);
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
    const json = await response.json();
    const data = RegistryDocument.parse(json);
    return { fetchedAt: Date.now(), data };
  }

  private async readDiskCache(): Promise<CachedRegistry | undefined> {
    try {
      const raw = await fs.readFile(paths.registryCache(), "utf8");
      const parsed = JSON.parse(raw) as CachedRegistry;
      if (
        typeof parsed.fetchedAt === "number" &&
        parsed.data &&
        Array.isArray(parsed.data.agents)
      ) {
        return parsed;
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        throw err;
      }
    }
    return undefined;
  }

  private async writeDiskCache(cache: CachedRegistry): Promise<void> {
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(
      paths.registryCache(),
      JSON.stringify(cache, null, 2) + "\n",
      "utf8",
    );
  }
}

export interface SpawnPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function planSpawn(agent: RegistryAgent): SpawnPlan {
  if (agent.distribution.npx) {
    const npx = agent.distribution.npx;
    const args = ["-y", npx.package, ...(npx.args ?? [])];
    return {
      command: "npx",
      args,
      env: npx.env ?? {},
    };
  }
  if (agent.distribution.binary) {
    throw new Error(
      `Agent ${agent.id} uses binary distribution; not yet supported in acp-hydra. PRs welcome.`,
    );
  }
  if (agent.distribution.uvx) {
    const uvx = agent.distribution.uvx;
    const args = [uvx.package, ...(uvx.args ?? [])];
    return {
      command: "uvx",
      args,
      env: uvx.env ?? {},
    };
  }
  throw new Error(`Agent ${agent.id} has no usable distribution method.`);
}
