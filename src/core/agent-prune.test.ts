import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pruneStaleAgentVersions } from "./agent-prune.js";
import { paths } from "./paths.js";
import {
  currentPlatformKey,
  type PlatformKey,
} from "./binary-install.js";
import { Registry, type RegistryDocument } from "./registry.js";

function fakeRegistry(agents: { id: string; version?: string }[]): Registry {
  const doc: RegistryDocument = {
    version: "1",
    agents: agents.map((a) => ({
      id: a.id,
      name: a.id,
      version: a.version,
      distribution: { npx: { package: a.id } },
    })),
  };
  return {
    async load() {
      return doc;
    },
  } as unknown as Registry;
}

async function seedVersion(
  platformKey: PlatformKey,
  agentId: string,
  version: string,
): Promise<string> {
  const dir = path.join(paths.agentsDir(), platformKey, agentId, version);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "marker"), "x");
  return dir;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe("pruneStaleAgentVersions", () => {
  it("removes versions that aren't current and aren't in use", async () => {
    const platformKey = currentPlatformKey();
    if (!platformKey) {
      return;
    }
    const current = await seedVersion(platformKey, "foo", "2.0.0");
    const stale = await seedVersion(platformKey, "foo", "1.0.0");
    const stale2 = await seedVersion(platformKey, "foo", "1.5.0");

    await pruneStaleAgentVersions(
      fakeRegistry([{ id: "foo", version: "2.0.0" }]),
      { activeAgentVersions: () => new Map() },
    );

    expect(await exists(current)).toBe(true);
    expect(await exists(stale)).toBe(false);
    expect(await exists(stale2)).toBe(false);
  });

  it("keeps versions backing a live session even when stale", async () => {
    const platformKey = currentPlatformKey();
    if (!platformKey) {
      return;
    }
    const current = await seedVersion(platformKey, "foo", "2.0.0");
    const inUse = await seedVersion(platformKey, "foo", "1.0.0");
    const stale = await seedVersion(platformKey, "foo", "1.5.0");

    await pruneStaleAgentVersions(
      fakeRegistry([{ id: "foo", version: "2.0.0" }]),
      {
        activeAgentVersions: () =>
          new Map([["foo", new Set(["1.0.0"])]]),
      },
    );

    expect(await exists(current)).toBe(true);
    expect(await exists(inUse)).toBe(true);
    expect(await exists(stale)).toBe(false);
  });

  it("leaves dirs for agents no longer in the registry untouched", async () => {
    const platformKey = currentPlatformKey();
    if (!platformKey) {
      return;
    }
    const dropped = await seedVersion(platformKey, "ghost", "0.1.0");
    const kept = await seedVersion(platformKey, "foo", "2.0.0");

    await pruneStaleAgentVersions(
      fakeRegistry([{ id: "foo", version: "2.0.0" }]),
      { activeAgentVersions: () => new Map() },
    );

    expect(await exists(dropped)).toBe(true);
    expect(await exists(kept)).toBe(true);
  });

  it("treats a missing registry version as 'current'", async () => {
    const platformKey = currentPlatformKey();
    if (!platformKey) {
      return;
    }
    const kept = await seedVersion(platformKey, "foo", "current");
    const stale = await seedVersion(platformKey, "foo", "2.0.0");

    await pruneStaleAgentVersions(
      fakeRegistry([{ id: "foo" }]),
      { activeAgentVersions: () => new Map() },
    );

    expect(await exists(kept)).toBe(true);
    expect(await exists(stale)).toBe(false);
  });

  it("leaves in-flight .partial- tempdirs alone", async () => {
    const platformKey = currentPlatformKey();
    if (!platformKey) {
      return;
    }
    const current = await seedVersion(platformKey, "foo", "2.0.0");
    const inFlight = await seedVersion(
      platformKey,
      "foo",
      "2.0.0.partial-AbCdEf",
    );

    await pruneStaleAgentVersions(
      fakeRegistry([{ id: "foo", version: "2.0.0" }]),
      { activeAgentVersions: () => new Map() },
    );

    expect(await exists(current)).toBe(true);
    expect(await exists(inFlight)).toBe(true);
  });

  it("is a no-op when the agents dir doesn't exist", async () => {
    await expect(
      pruneStaleAgentVersions(
        fakeRegistry([{ id: "foo", version: "2.0.0" }]),
        { activeAgentVersions: () => new Map() },
      ),
    ).resolves.toBeUndefined();
  });
});
