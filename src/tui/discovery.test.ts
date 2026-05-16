import { describe, expect, it } from "vitest";
import {
  deleteSession,
  killSession,
  listSessions,
  pickMostRecent,
} from "./discovery.js";
import type { HydraConfig } from "../core/config.js";

const cfg = {
  daemon: {
    host: "127.0.0.1",
    port: 8765,
    logLevel: "info" as const,
  },
} as unknown as HydraConfig;

const TOKEN = "tok";

const fakeOk = (body: unknown): typeof fetch =>
  (async (input: string | URL | Request) => {
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
              status: "live",
              agentId: "claude-acp",
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const out = await listSessions(cfg, TOKEN, { cwd: "/x", all: true }, fetchImpl);
    expect(captured.url).toBe(
      "http://127.0.0.1:8765/v1/sessions?cwd=%2Fx&all=true",
    );
    expect(captured.auth).toBe("Bearer tok");
    expect(out).toEqual([
      {
        sessionId: "s1",
        cwd: "/x",
        updatedAt: "2025-01-01T00:00:00Z",
        attachedClients: 1,
        status: "live",
        agentId: "claude-acp",
        upstreamSessionId: undefined,
        title: undefined,
      },
    ]);
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(listSessions(cfg, TOKEN, {}, fetchImpl)).rejects.toThrow(/HTTP 500/);
  });

  it("returns [] when sessions field missing", async () => {
    expect(await listSessions(cfg, TOKEN, {}, fakeOk({}))).toEqual([]);
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
    await killSession(cfg, TOKEN, "sess-1", fetchImpl);
    expect(captured.url).toBe("http://127.0.0.1:8765/v1/sessions/sess-1/kill");
    expect(captured.method).toBe("POST");
    expect(captured.auth).toBe("Bearer tok");
  });

  it("tolerates 404", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    await expect(killSession(cfg, TOKEN, "sess-1", fetchImpl)).resolves.toBeUndefined();
  });

  it("throws on other non-2xx", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(killSession(cfg, TOKEN, "sess-1", fetchImpl)).rejects.toThrow(/HTTP 500/);
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
    await deleteSession(cfg, TOKEN, "sess-1", fetchImpl);
    expect(captured.url).toBe("http://127.0.0.1:8765/v1/sessions/sess-1");
    expect(captured.method).toBe("DELETE");
    expect(captured.auth).toBe("Bearer tok");
  });

  it("tolerates 404", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    await expect(deleteSession(cfg, TOKEN, "sess-1", fetchImpl)).resolves.toBeUndefined();
  });
});

describe("pickMostRecent", () => {
  const mk = (
    sessionId: string,
    cwd: string,
    updatedAt: string,
    status: "live" | "cold" = "live",
  ) => ({ sessionId, cwd, updatedAt, status, attachedClients: 0 });

  it("returns null when no cwd match", () => {
    expect(pickMostRecent([mk("a", "/x", "2025-01-01")], "/y")).toBeNull();
  });

  it("prefers live over cold", () => {
    const live = mk("a", "/x", "2025-01-01", "live");
    const coldNewer = mk("b", "/x", "2025-02-01", "cold");
    expect(pickMostRecent([coldNewer, live], "/x")).toBe(live);
  });

  it("picks most recent within same status", () => {
    const older = mk("a", "/x", "2025-01-01", "live");
    const newer = mk("b", "/x", "2025-02-01", "live");
    expect(pickMostRecent([older, newer], "/x")).toBe(newer);
  });
});
