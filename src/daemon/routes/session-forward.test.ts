import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { registerSessionRoutes } from "./sessions.js";
import { ForeignSessionCache, registerSessionForwardHook } from "./session-forward.js";
import { SessionManager } from "../../core/session-manager.js";
import { HistoryStore } from "../../core/history-store.js";
import { Registry, type RegistryAgent } from "../../core/registry.js";
import { PeerStore } from "../../core/peer-store.js";
import { makeMockAgent, type MockAgentControls } from "../../__tests__/test-utils.js";

function fakeRegistryAgent(id = "claude-code"): RegistryAgent {
  return { id, name: id, distribution: { npx: { package: id } } };
}

function fakeRegistry(agents: RegistryAgent[]): Registry {
  return {
    async getAgent(id: string) {
      return agents.find((a) => a.id === id);
    },
    async load() {
      return { version: "0", agents };
    },
    async refresh() {
      return { version: "0", agents };
    },
  } as unknown as Registry;
}

interface Node {
  app: FastifyInstance;
  manager: SessionManager;
  mocks: MockAgentControls[];
  baseUrl: string;
  port: number;
  // Only set when built with a peerStore. Tests call refreshNow()
  // explicitly rather than waiting on the real interval timer.
  foreignSessionCache?: ForeignSessionCache;
}

async function buildNode(
  peerStore?: PeerStore,
  opts: { withLocalMiss?: boolean } = {},
): Promise<Node> {
  const mocks: MockAgentControls[] = [];
  const manager = new SessionManager(
    fakeRegistry([fakeRegistryAgent("claude-code")]),
    () => {
      const m = makeMockAgent({ agentId: "claude-code", cwd: "/w" });
      mocks.push(m);
      const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
      requestMock
        .mockResolvedValueOnce({ protocolVersion: 1 })
        .mockResolvedValueOnce({ sessionId: `u_${mocks.length}` });
      return m.agent;
    },
  );
  const app = Fastify();
  const foreignSessionCache = peerStore ? new ForeignSessionCache(peerStore) : undefined;
  registerSessionRoutes(
    app,
    manager,
    { agentId: "claude-code", cwd: "/w" },
    {},
    peerStore,
    foreignSessionCache,
  );
  if (peerStore) {
    registerSessionForwardHook(app, {
      store: peerStore,
      ...(opts.withLocalMiss
        ? {
            localMiss: {
              resolvesLocally: async (id) =>
                (await manager.resolveCanonicalId(id)) !== undefined,
              cache: foreignSessionCache!,
            },
          }
        : {}),
    });
  }
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address() as AddressInfo;
  return {
    app,
    manager,
    mocks,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    foreignSessionCache,
  };
}

function future(deltaMs = 60_000): string {
  return new Date(Date.now() + deltaMs).toISOString();
}

describe("session forwarding", () => {
  let a: Node;
  let b: Node;
  let peerStore: PeerStore;

  beforeEach(async () => {
    b = await buildNode();
    peerStore = await PeerStore.load();
    await peerStore.set({
      name: "peerb",
      host: "127.0.0.1",
      port: b.port,
      token: "test-token",
      expiresAt: future(),
      addedAt: new Date().toISOString(),
    });
    a = await buildNode(peerStore);
  });

  afterEach(async () => {
    await a.manager.closeAll().catch(() => undefined);
    await b.manager.closeAll().catch(() => undefined);
    await a.app.close();
    await b.app.close();
  });

  it("GET /v1/sessions/:foreignId forwards to the peer that owns it", async () => {
    const session = await b.manager.create({ cwd: "/w", agentId: "claude-code" });
    const res = await fetch(`${a.baseUrl}/v1/sessions/peerb:${session.sessionId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).toBe(session.sessionId);
  });

  it("PATCH /v1/sessions/:foreignId forwards the mutation to the peer", async () => {
    const session = await b.manager.create({ cwd: "/w", agentId: "claude-code" });
    const res = await fetch(`${a.baseUrl}/v1/sessions/peerb:${session.sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "set via A" }),
    });
    expect(res.status).toBe(204);

    const onB = await fetch(`${b.baseUrl}/v1/sessions/${session.sessionId}`);
    const bodyOnB = (await onB.json()) as { title?: string };
    expect(bodyOnB.title).toBe("set via A");
  });

  it("404s with a helpful message for a name that was never federated", async () => {
    const res = await fetch(`${a.baseUrl}/v1/sessions/not-a-peer:abc123`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/No remote named/);
  });

  it("502s when the federated peer is unreachable", async () => {
    await peerStore.set({
      name: "down",
      host: "127.0.0.1",
      port: 1,
      token: "test-token",
      expiresAt: future(),
      addedAt: new Date().toISOString(),
    });
    const res = await fetch(`${a.baseUrl}/v1/sessions/down:abc123`);
    expect(res.status).toBe(502);
  });

  it("501s a streaming forward instead of hanging on ?follow=1", async () => {
    const session = await b.manager.create({ cwd: "/w", agentId: "claude-code" });
    const res = await fetch(
      `${a.baseUrl}/v1/sessions/peerb:${session.sessionId}/history?follow=1`,
    );
    expect(res.status).toBe(501);
  });

  it("does not forward /v1/auth/sessions/:id lookalikes", async () => {
    // /v1/auth/sessions/:id also has an `:id` param, but it means a
    // session-TOKEN id, not a hydra session id — the hook must gate on
    // the full route pattern ("/v1/sessions/:id...") rather than just
    // "any route with a param named id", or a foreign-looking token id
    // would get wrongly intercepted and forwarded/rejected here. Built
    // standalone (not via buildNode) since the route has to be
    // registered before the app starts listening.
    const app = Fastify();
    app.get("/v1/auth/sessions/:id", async () => ({ fromLocalHandler: true }));
    registerSessionForwardHook(app, { store: peerStore });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/v1/auth/sessions/peerb:abc`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { fromLocalHandler?: boolean };
      expect(body.fromLocalHandler).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("GET /v1/sessions merges the peer's list with a name-prefixed id", async () => {
    const local = await a.manager.create({
      cwd: "/w",
      agentId: "claude-code",
      interactive: true,
    });
    const remote = await b.manager.create({
      cwd: "/w",
      agentId: "claude-code",
      interactive: true,
    });

    // The list-merge reads from a's periodically-refreshed cache, not
    // a live per-request fetch — force it rather than waiting on the
    // real interval timer.
    await a.foreignSessionCache!.refreshNow();

    const res = await fetch(`${a.baseUrl}/v1/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ sessionId: string; remote?: string }>;
    };
    const ids = body.sessions.map((s) => s.sessionId);
    expect(ids).toContain(local.sessionId);
    expect(ids).toContain(`peerb:${remote.sessionId}`);

    const localEntry = body.sessions.find((s) => s.sessionId === local.sessionId);
    const foreignEntry = body.sessions.find(
      (s) => s.sessionId === `peerb:${remote.sessionId}`,
    );
    expect(localEntry?.remote).toBeUndefined();
    expect(foreignEntry?.remote).toBe("peerb");
  });

  it("GET /v1/sessions?since=... also merges peer sessions, not just a full listing", async () => {
    // Regression: the merge originally only ran on a plain (no
    // `since=`) call. A real client only ever makes that call once —
    // every poll after its first uses `since=`, so federated sessions
    // appeared exactly once and never again. See ForeignSessionCache's
    // doc comment.
    const remote = await b.manager.create({
      cwd: "/w",
      agentId: "claude-code",
      interactive: true,
    });
    await a.foreignSessionCache!.refreshNow();

    const res = await fetch(`${a.baseUrl}/v1/sessions?since=0`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
    const ids = body.sessions.map((s) => s.sessionId);
    expect(ids).toContain(`peerb:${remote.sessionId}`);
  });

  it("GET /v1/sessions?cwd=... excludes peer sessions", async () => {
    await a.manager.create({ cwd: "/w", agentId: "claude-code", interactive: true });
    await b.manager.create({ cwd: "/w", agentId: "claude-code", interactive: true });
    await a.foreignSessionCache!.refreshNow();

    const res = await fetch(`${a.baseUrl}/v1/sessions?cwd=%2Fw`);
    const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
    expect(body.sessions.every((s) => !s.sessionId.startsWith("peerb:"))).toBe(true);
  });

  it("POST /v1/sessions with remote set creates on the peer and returns the foreign id", async () => {
    const res = await fetch(`${a.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/on-peer", agentId: "claude-code", remote: "peerb" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sessionId: string; cwd: string };
    expect(body.sessionId).toMatch(/^peerb:/);
    expect(body.cwd).toBe("/on-peer");

    // It's a real session on B, not A — A never created anything.
    const [, localId] = body.sessionId.split(":");
    expect(b.manager.get(localId!)).toBeDefined();
    expect(a.manager.get(body.sessionId)).toBeUndefined();
  });

  it("POST /v1/sessions with an unknown remote 404s instead of creating locally", async () => {
    const res = await fetch(`${a.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/w", agentId: "claude-code", remote: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /v1/sessions with no remote still creates locally as before", async () => {
    const res = await fetch(`${a.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/w", agentId: "claude-code" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).not.toContain(":");
    expect(a.manager.get(body.sessionId)).toBeDefined();
  });

  it("POST /v1/sessions/search fans an unscoped query out to every peer, rewrapping hits", async () => {
    const onB = await b.manager.create({ cwd: "/w", agentId: "claude-code" });
    const history = new HistoryStore();
    await history.append(onB.sessionId, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "alpha banana split" },
        },
      },
      recordedAt: 1,
    });

    const res = await fetch(`${a.baseUrl}/v1/sessions/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "banana" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ sessionId: string }>;
    };
    // toContain, not toEqual: both nodes share one on-disk HYDRA_ACP_HOME
    // in this test fixture (minted fresh per test, not per node — see
    // vitest.setup.ts), so A's own local scan also finds B's session
    // directory as an (unprefixed) cold entry. That's a fixture artifact,
    // not something a real two-machine setup would do; the property this
    // test actually checks is that the fan-out reached B and rewrapped
    // its hit the same way GET /v1/sessions does.
    expect(body.results.map((r) => r.sessionId)).toContain(
      `peerb:${onB.sessionId}`,
    );
  });

  it("POST /v1/sessions/search scoped to a sessionIds allowlist only asks the peers named in it", async () => {
    const onA = await a.manager.create({ cwd: "/w", agentId: "claude-code" });
    const onB = await b.manager.create({ cwd: "/w", agentId: "claude-code" });
    const history = new HistoryStore();
    await history.append(onA.sessionId, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "banana on A" },
        },
      },
      recordedAt: 1,
    });
    await history.append(onB.sessionId, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "banana on B" },
        },
      },
      recordedAt: 1,
    });

    // Scoped to the peer hit only — A's own matching session is outside
    // the allowlist and must not appear.
    const res = await fetch(`${a.baseUrl}/v1/sessions/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: "banana",
        sessionIds: [`peerb:${onB.sessionId}`],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ sessionId: string }>;
    };
    expect(body.results.map((r) => r.sessionId)).toEqual([
      `peerb:${onB.sessionId}`,
    ]);
  });

  it("POST /v1/sessions/search with no peerStore configured behaves as local-only", async () => {
    const local = await buildNode();
    try {
      const onLocal = await local.manager.create({
        cwd: "/w",
        agentId: "claude-code",
      });
      const history = new HistoryStore();
      await history.append(onLocal.sessionId, {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "banana solo" },
          },
        },
        recordedAt: 1,
      });
      const res = await fetch(`${local.baseUrl}/v1/sessions/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: "banana" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ sessionId: string }>;
      };
      expect(body.results.map((r) => r.sessionId)).toEqual([
        onLocal.sessionId,
      ]);
    } finally {
      await local.manager.closeAll().catch(() => undefined);
      await local.app.close();
    }
  });
});

describe("session forwarding — local-miss fallback", () => {
  let a: Node;
  let b: Node;
  let peerStore: PeerStore;

  beforeEach(async () => {
    b = await buildNode();
    peerStore = await PeerStore.load();
    await peerStore.set({
      name: "peerb",
      host: "127.0.0.1",
      port: b.port,
      token: "test-token",
      expiresAt: future(),
      addedAt: new Date().toISOString(),
    });
    a = await buildNode(peerStore, { withLocalMiss: true });
  });

  afterEach(async () => {
    await a.manager.closeAll().catch(() => undefined);
    await b.manager.closeAll().catch(() => undefined);
    await a.app.close();
    await b.app.close();
  });

  it("forwards a bare id that misses locally but matches exactly one peer", async () => {
    const session = await b.manager.create({ cwd: "/w", agentId: "claude-code" });
    await a.foreignSessionCache!.refreshNow();

    const res = await fetch(`${a.baseUrl}/v1/sessions/${session.sessionId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).toBe(session.sessionId);
  });

  it("forwards the prefix-stripped display form of a peer's id (regression: sessions list's SESSION column strips hydra_session_)", async () => {
    const session = await b.manager.create({ cwd: "/w", agentId: "claude-code" });
    await a.foreignSessionCache!.refreshNow();

    const stripped = session.sessionId.replace(/^hydra_session_/, "");
    expect(stripped).not.toBe(session.sessionId);
    const res = await fetch(`${a.baseUrl}/v1/sessions/${stripped}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).toBe(session.sessionId);
  });

  it("still 404s a bare id that no peer has either", async () => {
    const res = await fetch(`${a.baseUrl}/v1/sessions/not-anywhere`);
    expect(res.status).toBe(404);
  });

  it("still resolves a locally-created session normally with the fallback wired up", async () => {
    const local = await a.manager.create({ cwd: "/w", agentId: "claude-code" });
    const res = await fetch(`${a.baseUrl}/v1/sessions/${local.sessionId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).toBe(local.sessionId);
  });

  it("errors naming every remote when the bare id is ambiguous across peers", async () => {
    const c = await buildNode();
    try {
      await peerStore.set({
        name: "peerc",
        host: "127.0.0.1",
        port: c.port,
        token: "test-token",
        expiresAt: future(),
        addedAt: new Date().toISOString(),
      });
      // Neither daemon can mint a duplicate id on demand, so fake the
      // collision directly in each peer's cached entry — the point of
      // this test is the >1-match branch in findByLocalId's caller,
      // not the (practically unreachable) odds of a real collision.
      const fakeId = "collidingId1234A";
      const entry = {
        sessionId: fakeId,
        cwd: "/w",
        attachedClients: 0,
        updatedAt: new Date().toISOString(),
        status: "cold" as const,
        interactive: true,
      };
      (a.foreignSessionCache as unknown as {
        perPeer: Map<string, { cursor: number | undefined; sessions: Map<string, unknown> }>;
      }).perPeer.set("peerb", {
        cursor: 1,
        sessions: new Map([[`peerb:${fakeId}`, { ...entry, sessionId: `peerb:${fakeId}`, remote: "peerb" }]]),
      });
      (a.foreignSessionCache as unknown as {
        perPeer: Map<string, { cursor: number | undefined; sessions: Map<string, unknown> }>;
      }).perPeer.set("peerc", {
        cursor: 1,
        sessions: new Map([[`peerc:${fakeId}`, { ...entry, sessionId: `peerc:${fakeId}`, remote: "peerc" }]]),
      });

      const res = await fetch(`${a.baseUrl}/v1/sessions/${fakeId}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/more than one remote/);
      expect(body.error).toMatch(/peerb/);
      expect(body.error).toMatch(/peerc/);
    } finally {
      await c.manager.closeAll().catch(() => undefined);
      await c.app.close();
    }
  });
});
