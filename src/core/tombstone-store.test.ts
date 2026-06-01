import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import {
  TombstoneStore,
  shouldResurrectFromUpstream,
  type Tombstone,
} from "./tombstone-store.js";
import { paths } from "./paths.js";

function makeT(): Omit<Tombstone, "version"> {
  return {
    agentId: "claude-code",
    upstreamSessionId: "u_one",
    deletedAt: "2026-06-01T00:00:00.000Z",
    upstreamUpdatedAt: "2026-05-31T00:00:00.000Z",
    cwd: "/work",
    title: "feature",
    reason: "user",
  };
}

describe("TombstoneStore", () => {
  it("add/has/read/remove round-trip", async () => {
    const s = new TombstoneStore();
    expect(await s.has("claude-code", "u_one")).toBe(false);
    await s.add(makeT());
    expect(await s.has("claude-code", "u_one")).toBe(true);
    const t = await s.read("claude-code", "u_one");
    expect(t).toMatchObject({
      version: 1,
      agentId: "claude-code",
      upstreamSessionId: "u_one",
      upstreamUpdatedAt: "2026-05-31T00:00:00.000Z",
      title: "feature",
    });
    await s.remove("claude-code", "u_one");
    expect(await s.has("claude-code", "u_one")).toBe(false);
  });

  it("list returns all and per-agent", async () => {
    const s = new TombstoneStore();
    await s.add(makeT());
    await s.add({ ...makeT(), upstreamSessionId: "u_two" });
    await s.add({ ...makeT(), agentId: "gemini", upstreamSessionId: "g_one" });
    const all = await s.list();
    expect(all).toHaveLength(3);
    const justClaude = await s.list("claude-code");
    expect(justClaude.map((t) => t.upstreamSessionId).sort()).toEqual([
      "u_one",
      "u_two",
    ]);
  });

  it("remove is idempotent and tolerant of missing files", async () => {
    const s = new TombstoneStore();
    await s.remove("nope", "missing");
    await s.add(makeT());
    await s.remove("claude-code", "u_one");
    await s.remove("claude-code", "u_one");
  });

  it("safely encodes filesystem-unsafe ids", async () => {
    const s = new TombstoneStore();
    await s.add({
      ...makeT(),
      agentId: "weird/agent",
      upstreamSessionId: "../escape",
    });
    expect(await s.has("weird/agent", "../escape")).toBe(true);
    const onDisk = await fs.readdir(paths.tombstonesDir());
    expect(onDisk).toContain(encodeURIComponent("weird/agent"));
  });

  it("treats an unreadable existing file as a bare tombstone", async () => {
    const s = new TombstoneStore();
    await fs.mkdir(paths.tombstoneAgentDir("claude-code"), { recursive: true });
    await fs.writeFile(paths.tombstoneFile("claude-code", "u_garbage"), "not json{");
    const t = await s.read("claude-code", "u_garbage");
    expect(t).toBeDefined();
    expect(t?.upstreamUpdatedAt).toBeUndefined();
  });
});

describe("shouldResurrectFromUpstream", () => {
  const t: Tombstone = {
    version: 1,
    agentId: "a",
    upstreamSessionId: "u",
    deletedAt: "2026-06-01T00:00:00.000Z",
    upstreamUpdatedAt: "2026-05-31T00:00:00.000Z",
  };

  it("listing without updatedAt never resurrects", () => {
    expect(shouldResurrectFromUpstream(t, undefined)).toBe(false);
  });

  it("strictly newer listing resurrects", () => {
    expect(shouldResurrectFromUpstream(t, "2026-06-01T00:00:00.000Z")).toBe(true);
  });

  it("equal timestamps do not resurrect", () => {
    expect(shouldResurrectFromUpstream(t, "2026-05-31T00:00:00.000Z")).toBe(false);
  });

  it("older listing does not resurrect", () => {
    expect(shouldResurrectFromUpstream(t, "2026-05-30T00:00:00.000Z")).toBe(false);
  });

  it("tombstone without upstreamUpdatedAt resurrects on any listing ts", () => {
    const bare: Tombstone = { ...t, upstreamUpdatedAt: undefined };
    expect(shouldResurrectFromUpstream(bare, "2020-01-01T00:00:00.000Z")).toBe(true);
  });
});
