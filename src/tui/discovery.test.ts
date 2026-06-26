import { describe, expect, it } from "vitest";
import {
  DaemonTimeoutError,
  deleteSession,
  fetchWithTimeout,
  killSession,
  listSessions,
  pickMostRecent,
  searchSessions,
  syncInstalledAgents,
} from "./discovery.js";
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

  it("throws on non-2xx", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(listSessions(target, {}, fetchImpl)).rejects.toThrow(/HTTP 500/);
  });

  it("returns [] when sessions field missing", async () => {
    expect(await listSessions(target, {}, fakeOk({}))).toEqual([]);
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
