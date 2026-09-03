import { describe, expect, it } from "vitest";
import {
  DaemonTimeoutError,
  deleteSession,
  fetchWithTimeout,
  killSession,
  listSessions,
  listSessionsPage,
  mergeSessionListPage,
  pickMostRecent,
  searchSessions,
  syncInstalledAgents,
} from "./discovery.js";
import type { DiscoveredSession } from "./discovery.js";
import { toRow } from "../cli/session-row.js";
import type { RemoteTarget } from "../core/remote-target.js";

// Deliberately NOT the real daemon port (DEFAULT_DAEMON_PORT): every
// test injects a fake fetch, but if one ever forgot to, we must not be
// able to reach a live daemon. 1 is in the reserved range and never
// bound by anything, so an accidental real fetch fails fast instead of
// mutating an active daemon.
const target: RemoteTarget = {
  baseUrl: "http://127.0.0.1:1",
  wsUrl: "ws://127.0.0.1:1/acp",
  token: "tok",
  display: "127.0.0.1:1",
  isLocal: true,
};

const fakeOk = (body: unknown): typeof fetch =>
  (async (_input: string | URL | Request) => {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

describe("listSessions", () => {
  it("issues GET with bearer auth and parses sessions", async () => {
    const captured: { url: string; auth?: string } = { url: "" };
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      captured.url = input as string;
      const headers = init?.headers as Record<string, string> | undefined;
      captured.auth = headers?.["Authorization"];
      return new Response(
        JSON.stringify({
          sessions: [
            {
              sessionId: "s1",
              cwd: "/x",
              updatedAt: "2025-01-01T00:00:00Z",
              attachedClients: 1,
              status: "warm",
              agentId: "claude-acp",
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const out = await listSessions(target, { cwd: "/x", all: true }, fetchImpl);
    expect(captured.url).toBe(
      `${target.baseUrl}/v1/sessions?cwd=%2Fx&all=true`,
    );
    expect(captured.auth).toBe("Bearer tok");
    expect(out).toEqual([
      {
        sessionId: "s1",
        cwd: "/x",
        updatedAt: "2025-01-01T00:00:00Z",
        attachedClients: 1,
        status: "warm",
        agentId: "claude-acp",
        upstreamSessionId: undefined,
        title: undefined,
      },
    ]);
  });

  // The picker renders through the same toRow as the CLI, but
  // DiscoveredSession is its own summary type: an optional field the daemon
  // sends is silently dropped if this mapping forgets to copy it, and
  // TypeScript stays quiet because the field is optional on both sides.
  // That is exactly how armedTasks shipped invisible to the TUI while the
  // CLI rendered it correctly. Assert the user-visible outcome, not just
  // the field, so the whole path stays covered.
  it("preserves armedTasks so the picker reflects a pending wakeup", async () => {
    const out = await listSessions(
      target,
      {},
      fakeOk({
        sessions: [
          {
            sessionId: "s1",
            cwd: "/x",
            updatedAt: "2025-01-01T00:00:00Z",
            attachedClients: 1,
            status: "warm",
            busy: false,
            armedTasks: 2,
          },
        ],
      }),
    );
    expect(out[0]?.armedTasks).toBe(2);
    expect(toRow(out[0]!, Date.now()).state).toBe("BUSY");
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(listSessions(target, {}, fetchImpl)).rejects.toThrow(/HTTP 500/);
  });

  it("returns [] when sessions field missing", async () => {
    expect(await listSessions(target, {}, fakeOk({}))).toEqual([]);
  });
});

describe("listSessionsPage", () => {
  it("omits since from the query when not passed", async () => {
    const captured: { url: string } = { url: "" };
    const fetchImpl = (async (input: string) => {
      captured.url = input as string;
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
    }) as typeof fetch;
    await listSessionsPage(target, { includeNonInteractive: true }, fetchImpl);
    expect(captured.url).not.toContain("since");
  });

  it("passes since as a query param and surfaces removed + cursor", async () => {
    const captured: { url: string } = { url: "" };
    const fetchImpl = (async (input: string) => {
      captured.url = input as string;
      return new Response(
        JSON.stringify({
          sessions: [
            {
              sessionId: "s1",
              cwd: "/x",
              updatedAt: "2025-01-01T00:00:00Z",
              status: "cold",
            },
          ],
          removed: ["s0"],
          cursor: 1700000000123,
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const page = await listSessionsPage(target, { since: 1700000000000 }, fetchImpl);
    expect(captured.url).toContain("since=1700000000000");
    expect(page.removed).toEqual(["s0"]);
    expect(page.cursor).toBe(1700000000123);
    expect(page.sessions.map((s) => s.sessionId)).toEqual(["s1"]);
  });

  it("defaults removed to [] and cursor to 0 for a daemon predating this field", async () => {
    const page = await listSessionsPage(target, {}, fakeOk({ sessions: [] }));
    expect(page.removed).toEqual([]);
    expect(page.cursor).toBe(0);
  });
});

describe("mergeSessionListPage", () => {
  const warm = (id: string): DiscoveredSession => ({
    sessionId: id,
    cwd: "/w",
    updatedAt: "2025-01-01T00:00:00Z",
    attachedClients: 1,
    status: "warm",
  });
  const cold = (id: string, updatedAt = "2025-01-01T00:00:00Z"): DiscoveredSession => ({
    sessionId: id,
    cwd: "/w",
    updatedAt,
    attachedClients: 0,
    status: "cold",
  });

  it("replaces wholesale for a non-incremental (first / full) page", () => {
    const current = [warm("stale"), cold("also-stale")];
    const page = { sessions: [cold("fresh")], removed: [], cursor: 1 };
    expect(mergeSessionListPage(current, page, false)).toEqual([cold("fresh")]);
  });

  it("upserts changed cold rows and leaves untouched cold rows alone", () => {
    const current = [cold("unchanged"), cold("stale", "2025-01-01T00:00:00Z")];
    const page = {
      sessions: [cold("stale", "2025-01-02T00:00:00Z")],
      removed: [],
      cursor: 2,
    };
    const merged = mergeSessionListPage(current, page, true);
    expect(merged).toContainEqual(cold("unchanged"));
    expect(merged).toContainEqual(cold("stale", "2025-01-02T00:00:00Z"));
    expect(merged).toHaveLength(2);
  });

  it("drops ids in removed", () => {
    const current = [cold("keep"), cold("drop")];
    const page = { sessions: [], removed: ["drop"], cursor: 3 };
    expect(mergeSessionListPage(current, page, true).map((s) => s.sessionId)).toEqual([
      "keep",
    ]);
  });

  it("replaces the ENTIRE warm set on every incremental page, even a warm row absent from it", () => {
    // The daemon always answers an incremental request with the complete
    // warm set. A warm row this merge doesn't see in `page.sessions` is
    // therefore gone (cooled, killed, resurrected under a new id) —
    // never carried forward as a stale warm entry.
    const current = [warm("was-warm-1"), warm("was-warm-2"), cold("cold-1")];
    const page = { sessions: [warm("was-warm-1")], removed: [], cursor: 4 };
    const merged = mergeSessionListPage(current, page, true);
    expect(merged.map((s) => s.sessionId).sort()).toEqual(["cold-1", "was-warm-1"]);
  });

  it("a session cooling down (present as a changed cold row) replaces its stale warm copy", () => {
    const current = [warm("s1")];
    const page = { sessions: [cold("s1", "2025-01-02T00:00:00Z")], removed: [], cursor: 5 };
    const merged = mergeSessionListPage(current, page, true);
    expect(merged).toEqual([cold("s1", "2025-01-02T00:00:00Z")]);
  });

  it("picks up a field change on a row that stays warm (busy flipping mid-turn)", () => {
    // The daemon returns the full warm set on every incremental page, and
    // `busy` lives only in its memory (never in meta.json, so no mtime
    // moves when it flips). If the merge failed to take the incoming warm
    // copy, the picker would render a mid-turn session as WARM forever.
    const current = [{ ...warm("s1"), busy: false }];
    const page = {
      sessions: [{ ...warm("s1"), busy: true }],
      removed: [],
      cursor: 6,
    };
    expect(mergeSessionListPage(current, page, true)[0]?.busy).toBe(true);
  });

  it("purges a local row with an unknown status instead of stranding it as a live-looking ghost", () => {
    // Regression: the purge used to key on `status === "warm"`, so a row
    // whose status was missing survived AND had nothing in page.sessions
    // to overwrite it. session-row.ts's formatState treats any non-"cold"
    // status as live, so it rendered as WARM on every subsequent poll,
    // forever — the full-replace code this merge superseded had wiped it.
    const ghost = { ...warm("ghost"), status: undefined } as unknown as DiscoveredSession;
    const merged = mergeSessionListPage(
      [ghost, cold("keep")],
      { sessions: [], removed: [], cursor: 7 },
      true,
    );
    expect(merged.map((s) => s.sessionId)).toEqual(["keep"]);
  });
});

describe("killSession", () => {
  it("issues POST .../kill with bearer auth", async () => {
    const captured: { url: string; method?: string; auth?: string } = { url: "" };
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      captured.url = input as string;
      captured.method = init?.method;
      const headers = init?.headers as Record<string, string> | undefined;
      captured.auth = headers?.["Authorization"];
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await killSession(target, "sess-1", fetchImpl);
    expect(captured.url).toBe(`${target.baseUrl}/v1/sessions/sess-1/kill`);
    expect(captured.method).toBe("POST");
    expect(captured.auth).toBe("Bearer tok");
  });

  it("tolerates 404", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    await expect(killSession(target, "sess-1", fetchImpl)).resolves.toBeUndefined();
  });

  it("throws on other non-2xx", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(killSession(target, "sess-1", fetchImpl)).rejects.toThrow(/HTTP 500/);
  });
});

describe("deleteSession", () => {
  it("issues DELETE with bearer auth", async () => {
    const captured: { url: string; method?: string; auth?: string } = { url: "" };
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      captured.url = input as string;
      captured.method = init?.method;
      const headers = init?.headers as Record<string, string> | undefined;
      captured.auth = headers?.["Authorization"];
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await deleteSession(target, "sess-1", fetchImpl);
    expect(captured.url).toBe(`${target.baseUrl}/v1/sessions/sess-1`);
    expect(captured.method).toBe("DELETE");
    expect(captured.auth).toBe("Bearer tok");
  });

  it("tolerates 404", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    await expect(deleteSession(target, "sess-1", fetchImpl)).resolves.toBeUndefined();
  });
});

describe("pickMostRecent", () => {
  const mk = (
    sessionId: string,
    cwd: string,
    updatedAt: string,
    status: "warm" | "cold" = "warm",
  ) => ({ sessionId, cwd, updatedAt, status, attachedClients: 0 });

  it("returns null when no cwd match", () => {
    expect(pickMostRecent([mk("a", "/x", "2025-01-01")], "/y")).toBeNull();
  });

  it("prefers live over cold", () => {
    const live = mk("a", "/x", "2025-01-01", "warm");
    const coldNewer = mk("b", "/x", "2025-02-01", "cold");
    expect(pickMostRecent([coldNewer, live], "/x")).toBe(live);
  });

  it("picks most recent within same status", () => {
    const older = mk("a", "/x", "2025-01-01", "warm");
    const newer = mk("b", "/x", "2025-02-01", "warm");
    expect(pickMostRecent([older, newer], "/x")).toBe(newer);
  });
});

describe("searchSessions", () => {
  it("issues POST .../search with q in the JSON body and bearer auth", async () => {
    const captured: {
      url: string;
      method?: string;
      auth?: string;
      body?: unknown;
    } = { url: "" };
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      captured.url = input as string;
      captured.method = init?.method;
      const headers = init?.headers as Record<string, string> | undefined;
      captured.auth = headers?.["Authorization"];
      captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
      return new Response(
        JSON.stringify({ query: "needle", truncated: false, results: [] }),
        { status: 200 },
      );
    }) as typeof fetch;
    const out = await searchSessions(target, "needle", {}, fetchImpl);
    expect(captured.url).toBe(
      `${target.baseUrl}/v1/sessions/search`,
    );
    expect(captured.method).toBe("POST");
    expect(captured.auth).toBe("Bearer tok");
    expect(captured.body).toEqual({ q: "needle" });
    expect(out.results).toEqual([]);
  });

  it("includes sessionIds in the JSON body when provided", async () => {
    const captured: { body?: unknown } = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
      return new Response(
        JSON.stringify({ query: "x", truncated: false, results: [] }),
        { status: 200 },
      );
    }) as typeof fetch;
    await searchSessions(
      target,
      "x",
      { sessionIds: ["sess_a", "sess_b", "sess_c"] },
      fetchImpl,
    );
    expect(captured.body).toEqual({
      q: "x",
      sessionIds: ["sess_a", "sess_b", "sess_c"],
    });
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = (async () => new Response("bad", { status: 400 })) as typeof fetch;
    await expect(searchSessions(target, "x", {}, fetchImpl)).rejects.toThrow(
      /HTTP 400/,
    );
  });
});

describe("syncInstalledAgents", () => {
  it("syncs only installed agents and aggregates counts", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/v1/agents")) {
        return new Response(
          JSON.stringify({
            agents: [
              { id: "opencode", installed: "yes" },
              { id: "claude-acp", installed: "yes" },
              { id: "codex-acp", installed: "no" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/v1/agents/opencode/sync")) {
        return new Response(JSON.stringify({ synced: [{}, {}], skipped: 3 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/v1/agents/claude-acp/sync")) {
        return new Response(JSON.stringify({ synced: [{}], skipped: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const out = await syncInstalledAgents(target, fetchImpl);
    expect(out).toEqual({ synced: 3, skipped: 4, agents: 2 });
    expect(calls).toContain(
      `POST ${target.baseUrl}/v1/agents/opencode/sync`,
    );
    expect(calls).toContain(
      `POST ${target.baseUrl}/v1/agents/claude-acp/sync`,
    );
    expect(calls).not.toContain(
      `POST ${target.baseUrl}/v1/agents/codex-acp/sync`,
    );
  });

  it("swallows per-agent sync failures", async () => {
    const fetchImpl = (async (input: string) => {
      const url = String(input);
      if (url.endsWith("/v1/agents")) {
        return new Response(
          JSON.stringify({ agents: [{ id: "opencode", installed: "yes" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "no list cap" }), {
        status: 409,
      });
    }) as typeof fetch;
    const out = await syncInstalledAgents(target, fetchImpl);
    expect(out).toEqual({ synced: 0, skipped: 0, agents: 0 });
  });

  it("throws when the agents listing fails", async () => {
    const fetchImpl = (async () => new Response("x", { status: 500 })) as typeof fetch;
    await expect(syncInstalledAgents(target, fetchImpl)).rejects.toThrow(
      /HTTP 500/,
    );
  });
});

describe("fetchWithTimeout (T2 — picker hang regression)", () => {
  // Drives the picker auto-refresh path: an unresponsive daemon must
  // not freeze the picker forever. With a tight timeout the helper
  // rejects with DaemonTimeoutError instead of pending indefinitely.
  it("rejects with DaemonTimeoutError when the daemon never responds", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          (err as Error & { name: string }).name = "AbortError";
          reject(err);
        });
      })) as typeof fetch;
    await expect(
      fetchWithTimeout("http://stuck/", {}, 25, fetchImpl),
    ).rejects.toBeInstanceOf(DaemonTimeoutError);
  });

  it("propagates caller-cancellation as AbortError, not DaemonTimeoutError", async () => {
    const controller = new AbortController();
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          (err as Error & { name: string }).name = "AbortError";
          reject(err);
        });
      })) as typeof fetch;
    const p = fetchWithTimeout(
      "http://stuck/",
      { signal: controller.signal },
      10000,
      fetchImpl,
    );
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("listSessions plumbs caller signals through to the fetch", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return Promise.resolve(
        new Response(JSON.stringify({ sessions: [] }), { status: 200 }),
      );
    }) as typeof fetch;
    const ctrl = new AbortController();
    await listSessions(target, { signal: ctrl.signal }, fetchImpl);
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);
    ctrl.abort();
    expect(observedSignal?.aborted).toBe(true);
  });
});
