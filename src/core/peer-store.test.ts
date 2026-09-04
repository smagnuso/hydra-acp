import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import { PeerStore, PEER_NAME_PATTERN } from "./peer-store.js";
import { paths } from "./paths.js";

function future(deltaMs: number): string {
  return new Date(Date.now() + deltaMs).toISOString();
}

function past(deltaMs: number): string {
  return new Date(Date.now() - deltaMs).toISOString();
}

describe("PeerStore", () => {
  it("load returns an empty store when no file exists", async () => {
    const store = await PeerStore.load();
    expect(store.get("foo")).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("set writes the file with mode 0600, keyed by name", async () => {
    const store = await PeerStore.load();
    await store.set({
      name: "foo",
      host: "foo.example.com",
      port: 8443,
      token: "hydra_session_abc",
      expiresAt: future(60_000),
      addedAt: past(1000),
      label: "foo-label",
    });
    const stat = await fs.stat(paths.peers());
    expect(stat.mode & 0o777).toBe(0o600);
    const text = await fs.readFile(paths.peers(), "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe(1);
    expect(parsed.entries.foo.token).toBe("hydra_session_abc");
    expect(parsed.entries.foo.host).toBe("foo.example.com");
    expect(parsed.entries.foo.label).toBe("foo-label");
  });

  it("get returns the live entry, including the token", async () => {
    const store = await PeerStore.load();
    await store.set({
      name: "foo",
      host: "foo.example.com",
      port: 8443,
      token: "hydra_session_abc",
      expiresAt: future(60_000),
      addedAt: past(1000),
    });
    const fresh = await PeerStore.load();
    expect(fresh.get("foo")?.token).toBe("hydra_session_abc");
  });

  it("does not filter expired entries — staleness is surfaced, not hidden", async () => {
    const store = await PeerStore.load();
    await store.set({
      name: "foo",
      host: "foo.example.com",
      port: 8443,
      token: "hydra_session_stale",
      expiresAt: past(60_000),
      addedAt: past(120_000),
    });
    expect(store.get("foo")?.token).toBe("hydra_session_stale");
    expect(store.list()).toHaveLength(1);
  });

  it("list never includes the token", async () => {
    const store = await PeerStore.load();
    await store.set({
      name: "foo",
      host: "foo.example.com",
      port: 8443,
      token: "hydra_session_abc",
      expiresAt: future(60_000),
      addedAt: past(1000),
    });
    const [summary] = store.list();
    expect(summary).not.toHaveProperty("token");
    expect(summary?.name).toBe("foo");
  });

  it("set on an existing name upserts rather than erroring — the documented refresh path", async () => {
    const store = await PeerStore.load();
    await store.set({
      name: "foo",
      host: "foo.example.com",
      port: 8443,
      token: "tok-old",
      expiresAt: past(1000),
      addedAt: past(120_000),
    });
    await store.set({
      name: "foo",
      host: "foo.example.com",
      port: 8443,
      token: "tok-new",
      expiresAt: future(60_000),
      addedAt: past(1000),
    });
    expect(store.get("foo")?.token).toBe("tok-new");
    expect(store.list()).toHaveLength(1);
  });

  it("delete removes the entry and rewrites the file", async () => {
    const store = await PeerStore.load();
    await store.set({
      name: "foo",
      host: "foo.example.com",
      port: 8443,
      token: "tok",
      expiresAt: future(60_000),
      addedAt: past(1000),
    });
    expect(await store.delete("foo")).toBe(true);
    expect(store.get("foo")).toBeUndefined();
    expect(await store.delete("foo")).toBe(false);
  });

  it("two names can point at the same host:port", async () => {
    const store = await PeerStore.load();
    await store.set({
      name: "foo",
      host: "127.0.0.1",
      port: 55514,
      token: "tok-foo",
      expiresAt: future(60_000),
      addedAt: past(1000),
    });
    await store.set({
      name: "bar",
      host: "127.0.0.1",
      port: 55514,
      token: "tok-bar",
      expiresAt: future(60_000),
      addedAt: past(1000),
    });
    expect(store.get("foo")?.token).toBe("tok-foo");
    expect(store.get("bar")?.token).toBe("tok-bar");
  });

  it("tolerates a corrupt peers.json by starting fresh", async () => {
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(paths.peers(), "{not json", { encoding: "utf8" });
    const store = await PeerStore.load();
    expect(store.list()).toEqual([]);
  });

  it("ignores entries with malformed fields", async () => {
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(
      paths.peers(),
      JSON.stringify({
        version: 1,
        entries: {
          broken: { name: "broken", host: "127.0.0.1", port: 55514, token: 42 },
          foo: {
            name: "foo",
            host: "foo.example.com",
            port: 8443,
            token: "tok-ok",
            expiresAt: future(60_000),
            addedAt: past(1000),
            label: "good",
          },
        },
      }),
    );
    const store = await PeerStore.load();
    expect(store.get("broken")).toBeUndefined();
    expect(store.get("foo")?.token).toBe("tok-ok");
  });
});

describe("PEER_NAME_PATTERN", () => {
  it("accepts git-remote-like names", () => {
    for (const name of ["foo", "work-laptop", "foo.bar", "a1", "foo_bar"]) {
      expect(PEER_NAME_PATTERN.test(name)).toBe(true);
    }
  });

  it("rejects names that would collide with the addressing scheme or path segments", () => {
    for (const name of ["", "-foo", "foo:bar", "foo/bar", " foo"]) {
      expect(PEER_NAME_PATTERN.test(name)).toBe(false);
    }
  });
});
