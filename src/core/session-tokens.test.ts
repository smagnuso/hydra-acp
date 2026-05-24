import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionTokenStore } from "./session-tokens.js";
import { paths } from "./paths.js";

function tokensFilePath(): string {
  return path.join(paths.home(), "session-tokens.json");
}

describe("SessionTokenStore", () => {
  it("starts empty when no file exists", async () => {
    const store = await SessionTokenStore.load();
    expect(store.list()).toEqual([]);
  });

  it("issue() returns a prefixed token and verify() accepts it", async () => {
    const store = await SessionTokenStore.load();
    const issued = await store.issue({ label: "test" });
    expect(issued.token.startsWith("hydra_session_")).toBe(true);
    expect(issued.id).toMatch(/^[0-9a-f]+$/);
    expect(await store.verify(issued.token)).toBe(issued.id);
  });

  it("verify() returns undefined for unknown tokens", async () => {
    const store = await SessionTokenStore.load();
    expect(await store.verify("hydra_session_unknown")).toBeUndefined();
    expect(await store.verify("not-a-session-token")).toBeUndefined();
    expect(await store.verify("")).toBeUndefined();
  });

  it("revoke() invalidates a previously-issued token", async () => {
    const store = await SessionTokenStore.load();
    const issued = await store.issue();
    expect(await store.revoke(issued.id)).toBe(true);
    expect(await store.verify(issued.token)).toBeUndefined();
  });

  it("revoke() returns false for an unknown id", async () => {
    const store = await SessionTokenStore.load();
    expect(await store.revoke("does-not-exist")).toBe(false);
  });

  it("revokeAll() clears every record and returns the count", async () => {
    const store = await SessionTokenStore.load();
    await store.issue();
    await store.issue();
    await store.issue();
    expect(await store.revokeAll()).toBe(3);
    expect(store.list()).toEqual([]);
  });

  it("list() omits the hash field", async () => {
    const store = await SessionTokenStore.load();
    await store.issue({ label: "alpha" });
    const items = store.list();
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe("alpha");
    expect((items[0] as unknown as Record<string, unknown>).hash).toBeUndefined();
  });

  it("verify() rejects expired tokens", async () => {
    const store = await SessionTokenStore.load();
    const issued = await store.issue({ ttlSec: 1 });
    expect(await store.verify(issued.token)).toBe(issued.id);
    // Wait until past the TTL (generous buffer to avoid flakiness on slow CI).
    await new Promise((r) => setTimeout(r, 1500));
    expect(await store.verify(issued.token)).toBeUndefined();
    // The expired record should also be removed from list().
    expect(store.list().find((r) => r.id === issued.id)).toBeUndefined();
  });

  it("sweepExpired() removes expired records and returns the count", async () => {
    const store = await SessionTokenStore.load();
    await store.issue({ ttlSec: 1 });
    await store.issue();
    await new Promise((r) => setTimeout(r, 1500));
    expect(store.sweepExpired()).toBe(1);
    expect(store.list()).toHaveLength(1);
  });

  it("persists records across reload", async () => {
    const store = await SessionTokenStore.load();
    const issued = await store.issue({ label: "persists" });
    await store.flush();
    const reloaded = await SessionTokenStore.load();
    expect(await reloaded.verify(issued.token)).toBe(issued.id);
  });

  it("stores only hashes on disk (no plaintext tokens)", async () => {
    const store = await SessionTokenStore.load();
    const issued = await store.issue();
    await store.flush();
    const raw = await fs.readFile(tokensFilePath(), "utf8");
    expect(raw).not.toContain(issued.token);
    expect(raw).toContain(`"hash":`);
  });

  it("writes the tokens file with mode 0600", async () => {
    const store = await SessionTokenStore.load();
    await store.issue();
    await store.flush();
    const stat = await fs.stat(tokensFilePath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("verify() bumps lastUsedAt", async () => {
    const store = await SessionTokenStore.load();
    const issued = await store.issue();
    const before = store.list()[0]!.lastUsedAt;
    await new Promise((r) => setTimeout(r, 20));
    await store.verify(issued.token);
    const after = store.list()[0]!.lastUsedAt;
    expect(after.localeCompare(before)).toBeGreaterThan(0);
  });
});
