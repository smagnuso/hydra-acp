import { describe, it, expect, afterEach } from "vitest";
import { ForeignSessionCache } from "./session-forward.js";
import { PeerStore } from "../../core/peer-store.js";

function future(deltaMs = 60_000): string {
  return new Date(Date.now() + deltaMs).toISOString();
}

async function storeWithPeer(name: string): Promise<PeerStore> {
  const store = await PeerStore.load();
  await store.set({
    name,
    host: `${name}.example.com`,
    port: 55514,
    token: "tok",
    expiresAt: future(),
    addedAt: new Date().toISOString(),
  });
  return store;
}

function fakeFetch(sessions: Record<string, unknown>[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ sessions }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

type Page =
  | { sessions?: Record<string, unknown>[]; removed?: string[]; cursor?: number }
  | "error";

// Returns one queued page per call (the last page repeats once
// exhausted), and records the URL of every call so a test can assert
// on whether/how `since=` was sent.
function sequencedFetch(pages: Page[]): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL) => {
    urls.push(String(url));
    const page = pages[Math.min(i, pages.length - 1)];
    i++;
    if (page === "error") {
      throw new Error("ECONNREFUSED");
    }
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe("ForeignSessionCache", () => {
  let cache: ForeignSessionCache | undefined;

  afterEach(() => {
    cache?.stop();
    cache = undefined;
  });

  it("list() is empty before the first refresh", async () => {
    const store = await storeWithPeer("foo");
    cache = new ForeignSessionCache(store, { fetchImpl: fakeFetch([]) });
    expect(cache.list({})).toEqual([]);
  });

  it("refreshNow() populates the cache, tagged and rewrapped", async () => {
    const store = await storeWithPeer("foo");
    cache = new ForeignSessionCache(store, {
      fetchImpl: fakeFetch([
        { sessionId: "hydra_session_abc", interactive: true, status: "warm" },
      ]),
    });
    await cache.refreshNow();
    const [entry] = cache.list({});
    expect(entry).toMatchObject({
      sessionId: "foo:hydra_session_abc",
      remote: "foo",
    });
  });

  it("list() hides non-interactive entries by default, same as local sessions", async () => {
    const store = await storeWithPeer("foo");
    cache = new ForeignSessionCache(store, {
      fetchImpl: fakeFetch([
        { sessionId: "hydra_session_a", interactive: true, status: "warm" },
        { sessionId: "hydra_session_b", interactive: false, status: "warm" },
        { sessionId: "hydra_session_c", status: "warm" }, // undefined interactive
      ]),
    });
    await cache.refreshNow();
    expect(cache.list({}).map((e) => e.sessionId)).toEqual(["foo:hydra_session_a"]);
    expect(cache.list({ includeNonInteractive: true })).toHaveLength(3);
  });

  it("list() applies the status filter", async () => {
    const store = await storeWithPeer("foo");
    cache = new ForeignSessionCache(store, {
      fetchImpl: fakeFetch([
        { sessionId: "hydra_session_a", interactive: true, status: "warm" },
        { sessionId: "hydra_session_b", interactive: true, status: "cold" },
      ]),
    });
    await cache.refreshNow();
    expect(cache.list({ status: "warm" }).map((e) => e.sessionId)).toEqual([
      "foo:hydra_session_a",
    ]);
    expect(cache.list({ status: "cold" }).map((e) => e.sessionId)).toEqual([
      "foo:hydra_session_b",
    ]);
  });

  it("start() refreshes immediately rather than waiting a full interval", async () => {
    const store = await storeWithPeer("foo");
    cache = new ForeignSessionCache(store, {
      intervalMs: 60_000,
      fetchImpl: fakeFetch([
        { sessionId: "hydra_session_a", interactive: true, status: "warm" },
      ]),
    });
    cache.start();
    // The immediate refresh is fire-and-forget, with a few chained
    // awaits inside (fetch → res.json() → Promise.allSettled) — a
    // macrotask tick reliably drains all of them, a couple of
    // Promise.resolve() microtask flushes doesn't.
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.list({})).toHaveLength(1);
  });

  it("a peer that errors just yields nothing for that peer, not a thrown error", async () => {
    const store = await storeWithPeer("foo");
    cache = new ForeignSessionCache(store, {
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await expect(cache.refreshNow()).resolves.toBeUndefined();
    expect(cache.list({})).toEqual([]);
  });

  it("the first refresh fetches fresh (no since=); the second uses the cursor from the first", async () => {
    const store = await storeWithPeer("foo");
    const { fetchImpl, urls } = sequencedFetch([
      { sessions: [{ sessionId: "a", interactive: true, status: "warm" }], cursor: 100 },
      { sessions: [], cursor: 100 },
    ]);
    cache = new ForeignSessionCache(store, { fetchImpl });
    await cache.refreshNow();
    await cache.refreshNow();
    expect(urls[0]).not.toContain("since=");
    expect(urls[1]).toContain("since=100");
  });

  it("an incremental page upserts new/changed sessions without dropping untouched cold ones", async () => {
    const store = await storeWithPeer("foo");
    const { fetchImpl } = sequencedFetch([
      {
        sessions: [
          { sessionId: "a", interactive: true, status: "cold" },
          { sessionId: "b", interactive: true, status: "warm" },
        ],
        cursor: 100,
      },
      // Incremental page: only "b" changed (still warm), "a" isn't
      // resent — it's cold and untouched, so it must survive.
      {
        sessions: [{ sessionId: "b", interactive: true, status: "warm", busy: true }],
        cursor: 200,
      },
    ]);
    cache = new ForeignSessionCache(store, { fetchImpl });
    await cache.refreshNow();
    await cache.refreshNow();
    const ids = cache.list({ includeNonInteractive: true }).map((e) => e.sessionId).sort();
    expect(ids).toEqual(["foo:a", "foo:b"]);
    const b = cache.list({ includeNonInteractive: true }).find((e) => e.sessionId === "foo:b");
    expect(b?.busy).toBe(true);
  });

  it("a warm session absent from an incremental page is dropped even without appearing in removed", async () => {
    // Mirrors the client-side merge rule: an incremental page carries
    // the complete current warm set, so a row leaving it (e.g. no
    // longer attached) isn't a "removal" on the wire.
    const store = await storeWithPeer("foo");
    const { fetchImpl } = sequencedFetch([
      { sessions: [{ sessionId: "a", interactive: true, status: "warm" }], cursor: 100 },
      { sessions: [], cursor: 100 }, // "a" quietly cooled/detached, not in removed
    ]);
    cache = new ForeignSessionCache(store, { fetchImpl });
    await cache.refreshNow();
    expect(cache.list({ includeNonInteractive: true })).toHaveLength(1);
    await cache.refreshNow();
    expect(cache.list({ includeNonInteractive: true })).toHaveLength(0);
  });

  it("an id named in removed is deleted from the cache", async () => {
    const store = await storeWithPeer("foo");
    const { fetchImpl } = sequencedFetch([
      { sessions: [{ sessionId: "a", interactive: true, status: "cold" }], cursor: 100 },
      { sessions: [], removed: ["a"], cursor: 200 },
    ]);
    cache = new ForeignSessionCache(store, { fetchImpl });
    await cache.refreshNow();
    await cache.refreshNow();
    expect(cache.list({ includeNonInteractive: true })).toEqual([]);
  });

  it("a peer going unreachable mid-stream leaves its prior cache entry alone", async () => {
    const store = await storeWithPeer("foo");
    const { fetchImpl } = sequencedFetch([
      { sessions: [{ sessionId: "a", interactive: true, status: "cold" }], cursor: 100 },
      "error",
    ]);
    cache = new ForeignSessionCache(store, { fetchImpl });
    await cache.refreshNow();
    await cache.refreshNow();
    expect(cache.list({ includeNonInteractive: true }).map((e) => e.sessionId)).toEqual([
      "foo:a",
    ]);
  });

  it("a peer removed from the store is pruned from the cache on the next refresh", async () => {
    const store = await storeWithPeer("foo");
    cache = new ForeignSessionCache(store, {
      fetchImpl: fakeFetch([{ sessionId: "a", interactive: true, status: "cold" }]),
    });
    await cache.refreshNow();
    expect(cache.list({ includeNonInteractive: true })).toHaveLength(1);

    await store.delete("foo");
    await cache.refreshNow();
    expect(cache.list({ includeNonInteractive: true })).toEqual([]);
  });
});
