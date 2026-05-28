import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { registerSessionRoutes } from "./sessions.js";
import { SessionManager } from "../../core/session-manager.js";
import { Registry, type RegistryAgent } from "../../core/registry.js";
import { HistoryStore } from "../../core/history-store.js";
import {
  makeMockAgent,
  makeControlledStream,
  type MockAgentControls,
} from "../../__tests__/test-utils.js";
import { JsonRpcConnection } from "../../acp/connection.js";

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

interface Harness {
  app: FastifyInstance;
  manager: SessionManager;
  mocks: MockAgentControls[];
  baseUrl: string;
}

async function buildHarness(): Promise<Harness> {
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
  registerSessionRoutes(app, manager, { agentId: "claude-code", cwd: "/w" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address() as AddressInfo;
  return { app, manager, mocks, baseUrl: `http://127.0.0.1:${addr.port}` };
}

describe("session routes: termination broadcasts session_closed", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness.manager.closeAll().catch(() => undefined);
    await harness.app.close();
  });

  it("POST /v1/sessions/:id/kill notifies attached clients and demotes the session to cold", async () => {
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    const stream = makeControlledStream();
    await session.attach(
      { clientId: "c1", connection: new JsonRpcConnection(stream) },
      "full",
    );

    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${session.sessionId}/kill`,
      { method: "POST" },
    );
    // Kill is fire-and-forget so the picker doesn't block on the
    // close-time snapshot regen — endpoint returns 202 immediately and
    // the close continues in the background.
    expect(res.status).toBe(202);

    // Poll briefly for the close to complete. Mock agent has no real
    // regen turn so this finishes within a few ms; cap at 2s as a safety.
    const deadline = Date.now() + 2_000;
    while (
      Date.now() < deadline &&
      harness.manager.get(session.sessionId) !== undefined
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const closeMsg = stream.sent.find(
      (m) => "method" in m && m.method === "hydra-acp/session_closed",
    );
    expect(closeMsg).toMatchObject({
      params: { sessionId: session.sessionId },
    });
    // Live entry is gone; record stays on disk so the next attach can
    // resurrect.
    expect(harness.manager.get(session.sessionId)).toBeUndefined();
    expect(await harness.manager.hasRecord(session.sessionId)).toBe(true);
  });

  it("PATCH /v1/sessions/:id with { title } sets the title and broadcasts session_info_update", async () => {
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    const stream = makeControlledStream();
    await session.attach(
      { clientId: "c1", connection: new JsonRpcConnection(stream) },
      "full",
    );

    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${session.sessionId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Renamed from picker" }),
      },
    );
    expect(res.status).toBe(204);

    const infoMsg = stream.sent.find(
      (m) =>
        "method" in m &&
        m.method === "session/update" &&
        (m as { params?: { update?: { sessionUpdate?: string } } }).params
          ?.update?.sessionUpdate === "session_info_update",
    );
    expect(infoMsg).toMatchObject({
      params: {
        sessionId: session.sessionId,
        update: { title: "Renamed from picker" },
      },
    });
  });

  it("PATCH /v1/sessions/:id rejects empty title with 400", async () => {
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${session.sessionId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "   " }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("PATCH /v1/sessions/:id retitles a cold (non-live) session by writing meta.json", async () => {
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    const id = session.sessionId;
    await session.close({ deleteRecord: false });
    expect(harness.manager.get(id)).toBeUndefined();

    const res = await fetch(`${harness.baseUrl}/v1/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Cold rename" }),
    });
    expect(res.status).toBe(204);

    const entries = await harness.manager.list({ cwd: "/w" });
    const entry = entries.find((e) => e.sessionId === id);
    expect(entry?.title).toBe("Cold rename");
  });

  it("PATCH /v1/sessions/:id 404s when no record exists at all", async () => {
    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/hydra-doesnotexist`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "nope" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("PATCH /v1/sessions/:id with { regen: true } returns 202 without waiting for the agent", async () => {
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    const requestMock = harness.mocks[0]!.agent.connection
      .request as ReturnType<typeof vi.fn>;
    // Make the underlying session/prompt that runTitleRegen issues hang
    // forever — if the route awaited it, this test would time out. We
    // expect 202 to come back essentially immediately.
    requestMock.mockImplementationOnce(() => new Promise(() => undefined));

    const t0 = Date.now();
    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${session.sessionId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regen: true }),
      },
    );
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(202);
    // Generous bound — what we care about is that we DIDN'T block on
    // the (intentionally never-resolving) agent request.
    expect(elapsed).toBeLessThan(1000);
  });

  it("PATCH /v1/sessions/:id with { regen: true } accepts cold sessions (schedules background synopsis)", async () => {
    // Phase 2.5: cold sessions are no longer rejected. The synopsis
    // coordinator reads history.jsonl + meta.json from disk and spawns
    // an ephemeral agent to generate the synopsis — no live session
    // required.
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    const id = session.sessionId;
    await session.close({ deleteRecord: false });

    const res = await fetch(`${harness.baseUrl}/v1/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ regen: true }),
    });
    expect(res.status).toBe(202);
  });

  it("DELETE /v1/sessions/:id notifies attached clients and removes the record", async () => {
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    const stream = makeControlledStream();
    await session.attach(
      { clientId: "c1", connection: new JsonRpcConnection(stream) },
      "full",
    );

    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${session.sessionId}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(204);

    const closeMsg = stream.sent.find(
      (m) => "method" in m && m.method === "hydra-acp/session_closed",
    );
    expect(closeMsg).toMatchObject({
      params: { sessionId: session.sessionId },
    });
    expect(harness.manager.get(session.sessionId)).toBeUndefined();
    expect(await harness.manager.hasRecord(session.sessionId)).toBe(false);
  });

  it("GET /v1/sessions reports busy: false for an idle live session", async () => {
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });

    const res = await fetch(`${harness.baseUrl}/v1/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ sessionId: string; status: string; busy?: boolean }>;
    };
    const entry = body.sessions.find((s) => s.sessionId === session.sessionId);
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("live");
    expect(entry?.busy).toBe(false);
  });

  it("GET /v1/sessions/search returns grouped hits", async () => {
    // Two sessions, distinct prose, plus an Edit tool call so the file
    // path scan path also runs.
    const a = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    const b = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    const history = new HistoryStore();
    await history.append(a.sessionId, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "alpha banana split" },
        },
      },
      recordedAt: 1,
    });
    await history.append(b.sessionId, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc1",
          name: "Edit",
          title: "Edit /repo/src/foo.ts",
          rawInput: { file_path: "/repo/src/foo.ts" },
        },
      },
      recordedAt: 2,
    });

    const proseRes = await fetch(
      `${harness.baseUrl}/v1/sessions/search?q=banana`,
    );
    expect(proseRes.status).toBe(200);
    const proseBody = (await proseRes.json()) as {
      query: string;
      truncated: boolean;
      results: Array<{ sessionId: string; totalMatches: number }>;
    };
    expect(proseBody.query).toBe("banana");
    expect(proseBody.truncated).toBe(false);
    expect(proseBody.results.map((r) => r.sessionId)).toEqual([a.sessionId]);

    const toolRes = await fetch(
      `${harness.baseUrl}/v1/sessions/search?q=foo.ts`,
    );
    const toolBody = (await toolRes.json()) as {
      results: Array<{
        sessionId: string;
        snippets: Array<{ kind: string; toolName?: string; text: string }>;
      }>;
    };
    expect(toolBody.results.map((r) => r.sessionId)).toEqual([b.sessionId]);
    const inputSnippet = toolBody.results[0]?.snippets.find(
      (s) => s.kind === "tool-input",
    );
    expect(inputSnippet?.toolName).toBe("Edit");
    expect(inputSnippet?.text).toContain("foo.ts");
  });

  it("GET /v1/sessions/search scopes the scan to sessionIds when provided", async () => {
    const a = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    const b = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    const history = new HistoryStore();
    const sameText = {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "needle" },
        },
      },
      recordedAt: 1,
    };
    await history.append(a.sessionId, sameText);
    await history.append(b.sessionId, sameText);

    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/search?q=needle&sessionIds=${b.sessionId}`,
    );
    const body = (await res.json()) as {
      results: Array<{ sessionId: string }>;
    };
    expect(body.results.map((r) => r.sessionId)).toEqual([b.sessionId]);
  });

  it("GET /v1/sessions/search returns 400 when q is missing or blank", async () => {
    const missing = await fetch(`${harness.baseUrl}/v1/sessions/search`);
    expect(missing.status).toBe(400);
    const blank = await fetch(`${harness.baseUrl}/v1/sessions/search?q=%20%20`);
    expect(blank.status).toBe(400);
  });
});

describe("session routes: POST /v1/sessions/:id/fork", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness.manager.closeAll().catch(() => undefined);
    await harness.app.close();
  });

  // Seed a "source" session on disk by importing a bundle that already
  // has at least one completed turn — that's the minimum forkSession
  // needs to compute a default forkAt.
  async function seedSource(): Promise<string> {
    const bundle = {
      version: 1 as const,
      exportedAt: "2026-05-13T00:00:00.000Z",
      exportedFrom: { hydraVersion: "0.1.0", machine: "h" },
      session: {
        sessionId: "hydra_session_src",
        lineageId: "lin_route_fork",
        agentId: "claude-code",
        cwd: "/w",
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
      history: [
        {
          method: "session/update",
          params: {
            sessionId: "u_src",
            update: {
              sessionUpdate: "turn_complete",
              messageId: "m_only",
              stopReason: "end_turn",
            },
          },
          recordedAt: 1,
        },
      ],
    };
    const imported = await harness.manager.importBundle(bundle);
    return imported.sessionId;
  }

  it("returns 201 with the new session id, breadcrumb, and forkedAt", async () => {
    const sourceId = await seedSource();
    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${sourceId}/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      sessionId: string;
      forkedFromSessionId: string;
      forkedAt: string;
    };
    expect(body.sessionId).toMatch(/^hydra_session_/);
    expect(body.sessionId).not.toBe(sourceId);
    expect(body.forkedFromSessionId).toBe(sourceId);
    expect(body.forkedAt).toBe("m_only");
  });

  it("returns 404 for unknown source session", async () => {
    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/hydra_session_ghost/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when forkAt is empty string", async () => {
    const sourceId = await seedSource();
    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${sourceId}/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forkAt: "" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when forkAt messageId does not exist", async () => {
    const sourceId = await seedSource();
    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${sourceId}/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forkAt: "m_missing" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when agentId is unknown to the registry", async () => {
    const sourceId = await seedSource();
    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${sourceId}/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "no-such-agent" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("GET /v1/sessions surfaces forkedFromSessionId and forkedFromMessageId on the new fork", async () => {
    const sourceId = await seedSource();
    const forkRes = await fetch(
      `${harness.baseUrl}/v1/sessions/${sourceId}/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(forkRes.status).toBe(201);
    const forkBody = (await forkRes.json()) as { sessionId: string };

    const listRes = await fetch(`${harness.baseUrl}/v1/sessions`);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      sessions: Array<{
        sessionId: string;
        forkedFromSessionId?: string;
        forkedFromMessageId?: string;
      }>;
    };
    const fork = listBody.sessions.find((s) => s.sessionId === forkBody.sessionId);
    expect(fork).toBeDefined();
    expect(fork!.forkedFromSessionId).toBe(sourceId);
    expect(fork!.forkedFromMessageId).toBe("m_only");
  });

  it("expands ~ in cwd override", async () => {
    const sourceId = await seedSource();
    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${sourceId}/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: "~/forked" }),
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sessionId: string };
    // Look up the new record's cwd via GET /v1/sessions and assert it
    // doesn't start with "~".
    const listRes = await fetch(`${harness.baseUrl}/v1/sessions`);
    const listBody = (await listRes.json()) as {
      sessions: Array<{ sessionId: string; cwd: string }>;
    };
    const fork = listBody.sessions.find((s) => s.sessionId === body.sessionId);
    expect(fork).toBeDefined();
    expect(fork!.cwd.startsWith("~")).toBe(false);
  });
});
