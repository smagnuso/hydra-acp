import { describe, it, expect, afterEach, vi } from "vitest";
import { PeerHealthTracker } from "./peer-health.js";
import { PeerStore } from "../core/peer-store.js";

function future(deltaMs = 60_000): string {
  return new Date(Date.now() + deltaMs).toISOString();
}

async function storeWithPeers(
  names: string[],
): Promise<PeerStore> {
  const store = await PeerStore.load();
  for (const name of names) {
    await store.set({
      name,
      host: `${name}.example.com`,
      port: 55514,
      token: `tok-${name}`,
      expiresAt: future(),
      addedAt: new Date().toISOString(),
    });
  }
  return store;
}

describe("PeerHealthTracker", () => {
  let tracker: PeerHealthTracker | undefined;

  afterEach(() => {
    tracker?.stop();
    tracker = undefined;
  });

  it("get() returns undefined before any check has run", async () => {
    const store = await storeWithPeers(["foo"]);
    tracker = new PeerHealthTracker(store, { fetchImpl: async () => new Response(null, { status: 200 }) });
    expect(tracker.get("foo")).toBeUndefined();
  });

  it("checkAll marks a peer ok when /v1/auth/verify returns 200", async () => {
    const store = await storeWithPeers(["foo"]);
    tracker = new PeerHealthTracker(store, {
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    await tracker.checkAll();
    expect(tracker.get("foo")?.status).toBe("ok");
    expect(typeof tracker.get("foo")?.checkedAt).toBe("string");
  });

  it("checkAll marks a peer unauthorized on a non-2xx response", async () => {
    const store = await storeWithPeers(["foo"]);
    tracker = new PeerHealthTracker(store, {
      fetchImpl: async () => new Response(null, { status: 401 }),
    });
    await tracker.checkAll();
    expect(tracker.get("foo")?.status).toBe("unauthorized");
  });

  it("checkAll marks a peer unreachable when the request throws", async () => {
    const store = await storeWithPeers(["foo"]);
    tracker = new PeerHealthTracker(store, {
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await tracker.checkAll();
    expect(tracker.get("foo")).toMatchObject({
      status: "unreachable",
      error: "ECONNREFUSED",
    });
  });

  it("checks every peer independently", async () => {
    const store = await storeWithPeers(["up", "down"]);
    tracker = new PeerHealthTracker(store, {
      fetchImpl: async (url) => {
        if (String(url).includes("down.example.com")) {
          throw new Error("refused");
        }
        return new Response(null, { status: 200 });
      },
    });
    await tracker.checkAll();
    expect(tracker.get("up")?.status).toBe("ok");
    expect(tracker.get("down")?.status).toBe("unreachable");
  });

  it("markOk seeds an immediate ok snapshot without a real check", async () => {
    const store = await storeWithPeers(["foo"]);
    tracker = new PeerHealthTracker(store, { fetchImpl: async () => new Response(null, { status: 500 }) });
    tracker.markOk("foo");
    expect(tracker.get("foo")?.status).toBe("ok");
  });

  it("forget removes a peer's snapshot", async () => {
    const store = await storeWithPeers(["foo"]);
    tracker = new PeerHealthTracker(store, { fetchImpl: async () => new Response(null, { status: 200 }) });
    await tracker.checkAll();
    expect(tracker.get("foo")).toBeDefined();
    tracker.forget("foo");
    expect(tracker.get("foo")).toBeUndefined();
  });

  it("records the peer's system info from /v1/system", async () => {
    const store = await storeWithPeers(["foo"]);
    const system = {
      machine: "foo",
      hydraVersion: "0.1.200",
      startedAt: new Date().toISOString(),
      os: { platform: "linux", release: "6.1", arch: "x64" },
      node: "v24.0.0",
    };
    const urls: string[] = [];
    tracker = new PeerHealthTracker(store, {
      fetchImpl: async (input) => {
        urls.push(String(input));
        return Response.json(system);
      },
    });
    await tracker.checkAll();
    expect(tracker.get("foo")?.status).toBe("ok");
    expect(tracker.get("foo")?.system).toEqual(system);
    expect(urls).toEqual(["https://foo.example.com:55514/v1/system"]);
  });

  it("falls back to /v1/auth/verify for a peer without /v1/system", async () => {
    const store = await storeWithPeers(["foo"]);
    const urls: string[] = [];
    tracker = new PeerHealthTracker(store, {
      fetchImpl: async (input) => {
        urls.push(String(input));
        return new Response(null, { status: String(input).endsWith("/v1/system") ? 404 : 401 });
      },
    });
    await tracker.checkAll();
    expect(tracker.get("foo")?.status).toBe("unauthorized");
    expect(tracker.get("foo")?.system).toBeUndefined();
    expect(urls).toEqual([
      "https://foo.example.com:55514/v1/system",
      "https://foo.example.com:55514/v1/auth/verify",
    ]);
  });

  it("start() runs a check immediately rather than waiting a full interval", async () => {
    const store = await storeWithPeers(["foo"]);
    tracker = new PeerHealthTracker(store, {
      intervalMs: 60_000,
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    tracker.start();
    // The immediate check is fire-and-forget; poll briefly for it to land,
    // far short of the 60s interval a deferred first check would need.
    await vi.waitFor(() => expect(tracker!.get("foo")?.status).toBe("ok"), { timeout: 1_000 });
  });
});
