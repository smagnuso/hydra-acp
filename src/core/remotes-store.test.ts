import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import { RemotesStore, hostKey } from "./remotes-store.js";
import { paths } from "./paths.js";

function future(deltaMs: number): string {
  return new Date(Date.now() + deltaMs).toISOString();
}

function past(deltaMs: number): string {
  return new Date(Date.now() - deltaMs).toISOString();
}

describe("RemotesStore", () => {
  it("load returns an empty store when no file exists", async () => {
    const store = await RemotesStore.load();
    expect(store.get("127.0.0.1", 55514)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("set writes the file with mode 0600", async () => {
    const store = await RemotesStore.load();
    await store.set("127.0.0.1", 55514, {
      token: "tok-abc",
      expiresAt: future(60_000),
      label: "laptop",
    });
    const stat = await fs.stat(paths.remotes());
    expect(stat.mode & 0o777).toBe(0o600);
    const text = await fs.readFile(paths.remotes(), "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe(1);
    expect(parsed.entries["127.0.0.1:55514"].token).toBe("tok-abc");
    expect(parsed.entries["127.0.0.1:55514"].label).toBe("laptop");
  });

  it("get returns the live entry", async () => {
    const store = await RemotesStore.load();
    await store.set("127.0.0.1", 55514, {
      token: "tok-abc",
      expiresAt: future(60_000),
    });
    const fresh = await RemotesStore.load();
    expect(fresh.get("127.0.0.1", 55514)?.token).toBe("tok-abc");
  });

  it("keys distinguish ports on the same host", async () => {
    const store = await RemotesStore.load();
    await store.set("127.0.0.1", 55514, {
      token: "tok-default",
      expiresAt: future(60_000),
    });
    await store.set("127.0.0.1", 8080, {
      token: "tok-alt",
      expiresAt: future(60_000),
    });
    expect(store.get("127.0.0.1", 55514)?.token).toBe("tok-default");
    expect(store.get("127.0.0.1", 8080)?.token).toBe("tok-alt");
  });

  it("get returns undefined for expired entries", async () => {
    const store = await RemotesStore.load();
    await store.set("abc.ngrok.app", 443, {
      token: "tok-expired",
      expiresAt: past(60_000),
    });
    expect(store.get("abc.ngrok.app", 443)).toBeUndefined();
  });

  it("load sweeps expired entries from disk", async () => {
    const initial = await RemotesStore.load();
    await initial.set("abc.ngrok.app", 443, {
      token: "tok-expired",
      expiresAt: past(60_000),
    });
    await initial.set("def.ngrok.app", 443, {
      token: "tok-live",
      expiresAt: future(60_000),
    });
    const reloaded = await RemotesStore.load();
    expect(reloaded.get("abc.ngrok.app", 443)).toBeUndefined();
    expect(reloaded.get("def.ngrok.app", 443)?.token).toBe("tok-live");
    const onDisk = JSON.parse(await fs.readFile(paths.remotes(), "utf8"));
    expect(Object.keys(onDisk.entries)).toEqual(["def.ngrok.app:443"]);
  });

  it("delete removes the entry and rewrites the file", async () => {
    const store = await RemotesStore.load();
    await store.set("127.0.0.1", 55514, {
      token: "tok",
      expiresAt: future(60_000),
    });
    expect(await store.delete("127.0.0.1", 55514)).toBe(true);
    expect(store.get("127.0.0.1", 55514)).toBeUndefined();
    expect(await store.delete("127.0.0.1", 55514)).toBe(false);
  });

  it("list returns parsed host/port pairs", async () => {
    const store = await RemotesStore.load();
    await store.set("127.0.0.1", 55514, {
      token: "tok-a",
      expiresAt: future(60_000),
    });
    await store.set("abc.ngrok.app", 443, {
      token: "tok-b",
      expiresAt: future(60_000),
    });
    const list = store.list();
    expect(list).toHaveLength(2);
    const local = list.find((e) => e.host === "127.0.0.1");
    expect(local?.port).toBe(55514);
    expect(local?.entry.token).toBe("tok-a");
  });

  it("tolerates a corrupt remotes.json by starting fresh", async () => {
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(paths.remotes(), "{not json", { encoding: "utf8" });
    const store = await RemotesStore.load();
    expect(store.list()).toEqual([]);
  });

  it("ignores entries with malformed fields", async () => {
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(
      paths.remotes(),
      JSON.stringify({
        version: 1,
        entries: {
          "127.0.0.1:55514": { token: 42, expiresAt: future(60_000) },
          "abc.ngrok.app:443": {
            token: "tok-ok",
            expiresAt: future(60_000),
            label: "good",
          },
        },
      }),
    );
    const store = await RemotesStore.load();
    expect(store.get("127.0.0.1", 55514)).toBeUndefined();
    expect(store.get("abc.ngrok.app", 443)?.token).toBe("tok-ok");
  });
});

describe("hostKey", () => {
  it("formats as host:port", () => {
    expect(hostKey("127.0.0.1", 55514)).toBe("127.0.0.1:55514");
    expect(hostKey("abc.ngrok.app", 443)).toBe("abc.ngrok.app:443");
  });
});
