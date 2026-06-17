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
import { ExtensionMcpRegistry } from "../../core/extension-mcp.js";
import { McpTokenRegistry } from "../mcp/token-registry.js";
import { SessionStore } from "../../core/session-store.js";

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

  it("POST /v1/sessions/:id/stdin/open + /stdin feed the session's stdin ring", async () => {
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });

    const openRes = await fetch(
      `${harness.baseUrl}/v1/sessions/${session.sessionId}/stdin/open`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "memory", capacityBytes: 4096 }),
      },
    );
    expect(openRes.status).toBe(200);
    const open = (await openRes.json()) as { capacityBytes: number };
    expect(open.capacityBytes).toBe(4096);

    const writeRes = await fetch(
      `${harness.baseUrl}/v1/sessions/${session.sessionId}/stdin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chunk: Buffer.from("hello stdin").toString("base64"),
          eof: true,
        }),
      },
    );
    expect(writeRes.status).toBe(200);
    const write = (await writeRes.json()) as { writeCursor: number };
    expect(write.writeCursor).toBe("hello stdin".length);

    // The bytes are now readable from the session's ring (the surface
    // the MCP stdin tools consume in-process).
    const read = await session.streamRead(0, undefined, 0);
    expect(Buffer.from(read.bytes, "base64").toString("utf8")).toBe("hello stdin");
    expect(read.eof).toBe(true);
  });

  it("POST /v1/sessions/:id/stdin 404s for an unknown session", async () => {
    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/hydra_session_nope/stdin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunk: "" }),
      },
    );
    expect(res.status).toBe(404);
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
      (m) => "method" in m && m.method === "hydra-acp/session/closed",
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

    const entries = await harness.manager.list({
      cwd: "/w",
      includeNonInteractive: true,
    });
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
      (m) => "method" in m && m.method === "hydra-acp/session/closed",
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

    const res = await fetch(
      `${harness.baseUrl}/v1/sessions?includeNonInteractive=true`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{
        sessionId: string;
        status: string;
        busy?: boolean;
        awaitingInput?: boolean;
      }>;
    };
    const entry = body.sessions.find((s) => s.sessionId === session.sessionId);
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("live");
    expect(entry?.busy).toBe(false);
    expect(entry?.awaitingInput).toBe(false);
  });

  it("GET /v1/sessions includes compactionState when present on a session", async () => {
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    // Inject compactionState — for live sessions it must be set on the
    // in-memory object (listUncached reads session.compactionState);
    // the store write covers cold-session exposure.
    session.compactionState = {
      status: "running",
      requestedAt: Date.now(),
      iter: 1,
      attempts: 0,
    };
    const store = (harness.manager as unknown as { store: SessionStore }).store;
    const existing = await store.read(session.sessionId);
    await store.write({
      ...existing!,
      compactionState: session.compactionState,
    });

    const res = await fetch(
      `${harness.baseUrl}/v1/sessions?includeNonInteractive=true`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{
        sessionId: string;
        compactionState?: { status: string; iter?: number };
      }>;
    };
    const entry = body.sessions.find((s) => s.sessionId === session.sessionId);
    expect(entry).toBeDefined();
    expect(entry?.compactionState).toBeDefined();
    expect(entry?.compactionState?.status).toBe("running");
    expect(entry?.compactionState?.iter).toBe(1);
  });

  it("GET /v1/sessions omits compactionState when not present", async () => {
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });

    const res = await fetch(
      `${harness.baseUrl}/v1/sessions?includeNonInteractive=true`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ sessionId: string; compactionState?: unknown }>;
    };
    const entry = body.sessions.find((s) => s.sessionId === session.sessionId);
    expect(entry).toBeDefined();
    expect(entry?.compactionState).toBeUndefined();
  });

  it("GET /v1/sessions/:id returns the single entry", async () => {
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${session.sessionId}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      agentId?: string;
      status?: string;
    };
    expect(body.sessionId).toBe(session.sessionId);
    expect(body.agentId).toBe("claude-code");
    expect(body.status).toBe("live");
  });

  it("GET /v1/sessions/:id 404s for an unknown id", async () => {
    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/hydra_session_nope`,
    );
    expect(res.status).toBe(404);
  });

  it("POST /v1/sessions/search returns grouped hits", async () => {
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
      `${harness.baseUrl}/v1/sessions/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: "banana" }),
      },
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
      `${harness.baseUrl}/v1/sessions/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: "foo.ts" }),
      },
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

  it("POST /v1/sessions/search scopes the scan to sessionIds when provided", async () => {
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
      `${harness.baseUrl}/v1/sessions/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: "needle", sessionIds: [b.sessionId] }),
      },
    );
    const body = (await res.json()) as {
      results: Array<{ sessionId: string }>;
    };
    expect(body.results.map((r) => r.sessionId)).toEqual([b.sessionId]);
  });

  it("POST /v1/sessions/search returns 400 when q is missing or blank", async () => {
    const missing = await fetch(`${harness.baseUrl}/v1/sessions/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    const blank = await fetch(`${harness.baseUrl}/v1/sessions/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "  " }),
    });
    expect(blank.status).toBe(400);
  });

  it("GET /export?tools=summary sheds diff bodies; default inline keeps them", async () => {
    const s = await harness.manager.create({ cwd: "/w", agentId: "claude-code" });
    const history = new HistoryStore();
    const big = "x".repeat(50_000);
    await history.append(s.sessionId, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "e1",
          status: "completed",
          content: [{ type: "diff", path: "/repo/foo.ts", oldText: big, newText: big + "\nadded" }],
          rawOutput: { content: big, error: "" },
        },
      },
      recordedAt: 1,
    });

    const auth = { Authorization: "Bearer test" } as Record<string, string>;
    const inlineRes = await fetch(
      `${harness.baseUrl}/v1/sessions/${s.sessionId}/export`,
      { headers: auth },
    );
    const summaryRes = await fetch(
      `${harness.baseUrl}/v1/sessions/${s.sessionId}/export?tools=summary`,
      { headers: auth },
    );
    expect(inlineRes.status).toBe(200);
    expect(summaryRes.status).toBe(200);
    const inlineBody = await inlineRes.text();
    const summaryBody = await summaryRes.text();
    // Inline carries the full file text; summary does not.
    expect(inlineBody).toContain(big);
    expect(summaryBody).not.toContain(big);
    // Summary is dramatically smaller but still names the edited path.
    expect(summaryBody.length).toBeLessThan(inlineBody.length / 10);
    expect(summaryBody).toContain("/repo/foo.ts");
  });

  it("GET /export?tools=references ships ref-form history + deduped gzipped toolBlobs", async () => {
    const s = await harness.manager.create({ cwd: "/w", agentId: "claude-code" });
    const history = new HistoryStore();
    const big = "K".repeat(30_000);
    await history.append(s.sessionId, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "e1",
          status: "completed",
          content: [{ type: "diff", path: "/repo/foo.ts", oldText: big, newText: big + "x" }],
        },
      },
      recordedAt: 1,
    });
    const auth = { Authorization: "Bearer test" } as Record<string, string>;
    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${s.sessionId}/export?tools=references`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as {
      history: Array<{ params: { update: { content: Array<Record<string, unknown>> } } }>;
      toolBlobs?: Record<string, string>;
    };
    const body = JSON.stringify(bundle);
    // History carries refs, not the full text; blobs travel in toolBlobs.
    expect(body).not.toContain(big);
    expect(bundle.toolBlobs).toBeDefined();
    const hashes = Object.keys(bundle.toolBlobs!);
    expect(hashes.length).toBe(2); // old + new, deduped by content
    const block = bundle.history.find((e) =>
      (e.params?.update?.content ?? []).some((b) => b.type === "diff"),
    )!.params.update.content.find((b) => b.type === "diff")!;
    expect((block.oldText as { __hydraBlob?: string }).__hydraBlob).toBeDefined();

    // Re-import under a new lineage and confirm the blobs are restored so a
    // hydrating load reconstructs the original inline content.
    const imp = await fetch(`${harness.baseUrl}/v1/sessions/import`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ bundle, replace: true }),
    });
    expect(imp.status === 200 || imp.status === 201).toBe(true);
    const hydrated = await harness.manager.loadHistory(s.sessionId);
    const diff = (hydrated[0]!.params as { update: { content: Array<Record<string, unknown>> } })
      .update.content[0]!;
    expect(diff.oldText).toBe(big);
    expect(diff.newText).toBe(big + "x");
  });

  it("GET /v1/sessions/:id/diff returns aggregated per-file hunks", async () => {
    const s = await harness.manager.create({ cwd: "/w", agentId: "claude-code" });
    const history = new HistoryStore();
    // Two distinct files, one with two snippet edits to exercise hunks[].
    await history.append(s.sessionId, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "e1",
          status: "completed",
          content: [{ type: "diff", path: "/repo/a.ts", oldText: "old1", newText: "new1" }],
        },
      },
      recordedAt: 1,
    });
    await history.append(s.sessionId, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "e2",
          status: "completed",
          content: [{ type: "diff", path: "/repo/a.ts", oldText: "old2", newText: "new2" }],
        },
      },
      recordedAt: 2,
    });
    await history.append(s.sessionId, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "e3",
          status: "completed",
          content: [{ type: "diff", path: "/repo/b.ts", oldText: "x", newText: "y" }],
        },
      },
      recordedAt: 3,
    });

    const auth = { Authorization: "Bearer test" } as Record<string, string>;
    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${s.sessionId}/diff`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      path: string;
      hunks: Array<{ oldText: string; newText: string }>;
      created: boolean;
    }>;
    const byPath = Object.fromEntries(body.map((f) => [f.path, f]));
    expect(byPath["/repo/a.ts"]?.hunks).toEqual([
      { oldText: "old1", newText: "new1" },
      { oldText: "old2", newText: "new2" },
    ]);
    expect(byPath["/repo/b.ts"]?.hunks).toEqual([
      { oldText: "x", newText: "y" },
    ]);

    // ?paths= filters results.
    const filtered = await fetch(
      `${harness.baseUrl}/v1/sessions/${s.sessionId}/diff?paths=/repo/b.ts`,
      { headers: auth },
    );
    const filteredBody = (await filtered.json()) as Array<{ path: string }>;
    expect(filteredBody.map((f) => f.path)).toEqual(["/repo/b.ts"]);
  });

  it("GET /v1/sessions/:id/diff returns 404 for an unknown session", async () => {
    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/does-not-exist/diff`,
      { headers: { Authorization: "Bearer test" } },
    );
    expect(res.status).toBe(404);
  });

  it("GET /tools/:hash returns an externalized blob, 404 for unknown", async () => {
    const s = await harness.manager.create({ cwd: "/w", agentId: "claude-code" });
    const history = new HistoryStore();
    const big = "Z".repeat(20_000);
    await history.append(s.sessionId, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "e1",
          status: "completed",
          content: [{ type: "diff", path: "/repo/foo.ts", oldText: big, newText: big }],
        },
      },
      recordedAt: 1,
    });
    // Discover the blob hash from the lean (references) load.
    const lean = await history.load(s.sessionId, { tools: "references" });
    const block = (lean[0]!.params as { update: { content: Array<Record<string, unknown>> } })
      .update.content[0]!;
    const hash = (block.oldText as { __hydraBlob: string }).__hydraBlob;
    expect(typeof hash).toBe("string");

    const auth = { Authorization: "Bearer test" } as Record<string, string>;
    const okRes = await fetch(
      `${harness.baseUrl}/v1/sessions/${s.sessionId}/tools/${hash}`,
      { headers: auth },
    );
    expect(okRes.status).toBe(200);
    expect(await okRes.text()).toBe(big);

    const missRes = await fetch(
      `${harness.baseUrl}/v1/sessions/${s.sessionId}/tools/${"a".repeat(64)}`,
      { headers: auth },
    );
    expect(missRes.status).toBe(404);
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

    // Forks are created with interactive=false (pristine snapshot), so
    // the default listing hides them. Use includeNonInteractive=1.
    const listRes = await fetch(
      `${harness.baseUrl}/v1/sessions?includeNonInteractive=1`,
    );
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
    // doesn't start with "~". Forks are interactive=false so list with
    // includeNonInteractive=1 to surface them.
    const listRes = await fetch(
      `${harness.baseUrl}/v1/sessions?includeNonInteractive=1`,
    );
    const listBody = (await listRes.json()) as {
      sessions: Array<{ sessionId: string; cwd: string }>;
    };
    const fork = listBody.sessions.find((s) => s.sessionId === body.sessionId);
    expect(fork).toBeDefined();
    expect(fork!.cwd.startsWith("~")).toBe(false);
  });

  it("GET /v1/sessions/:id returns the same shape as the corresponding /v1/sessions row", async () => {
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    const id = session.sessionId;

    const listRes = await fetch(
      `${harness.baseUrl}/v1/sessions?includeNonInteractive=1`,
    );
    const listBody = (await listRes.json()) as {
      sessions: Array<Record<string, unknown>>;
    };
    const listEntry = listBody.sessions.find((s) => s.sessionId === id);
    expect(listEntry).toBeDefined();

    const oneRes = await fetch(`${harness.baseUrl}/v1/sessions/${id}`);
    expect(oneRes.status).toBe(200);
    const oneEntry = (await oneRes.json()) as Record<string, unknown>;

    expect(oneEntry).toEqual(listEntry);
  });

  it("GET /v1/sessions/:id 404s for an unknown session", async () => {
    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/hydra-doesnotexist`,
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/sessions extension MCP injection", () => {
  // Mirror the WS session/new behaviour: every extension currently
  // registered with the daemon's ExtensionMcpRegistry must be appended
  // to the new session's mcpServers as an HTTP descriptor pointing at
  // /mcp/<extname>. Without this REST-initiated sessions (Slack
  // `!session`, browser, …) silently lose the planner MCP and the
  // agent can't see `set_plan` / `get_plan` etc.
  let app: FastifyInstance;
  let manager: SessionManager;
  let mocks: MockAgentControls[];
  let baseUrl: string;
  let extensionMcp: ExtensionMcpRegistry;
  let mcpTokenRegistry: McpTokenRegistry;

  beforeEach(async () => {
    mocks = [];
    manager = new SessionManager(
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
    extensionMcp = new ExtensionMcpRegistry();
    mcpTokenRegistry = new McpTokenRegistry();
    app = Fastify();
    registerSessionRoutes(
      app,
      manager,
      { agentId: "claude-code", cwd: "/w" },
      {
        extensionMcp,
        mcpTokenRegistry,
        getDaemonOrigin: () => "http://127.0.0.1:9999",
      },
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await manager.closeAll().catch(() => undefined);
    await app.close();
  });

  function findSessionNewCall(mock: MockAgentControls):
    { cwd: unknown; mcpServers: unknown[] } | undefined {
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    const call = requestMock.mock.calls.find((c) => c[0] === "session/new");
    return call?.[1] as { cwd: unknown; mcpServers: unknown[] } | undefined;
  }

  it("appends an HTTP descriptor for each registered extension MCP", async () => {
    const fakeConn = {} as unknown as Parameters<ExtensionMcpRegistry["register"]>[1];
    extensionMcp.register("hydra-acp-planner", fakeConn, undefined, [
      { name: "set_plan", description: "", inputSchema: {} },
    ]);
    extensionMcp.register("hydra-acp-notifier", fakeConn, undefined, [
      { name: "notify", description: "", inputSchema: {} },
    ]);

    const res = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/w", agentId: "claude-code" }),
    });
    expect(res.status).toBe(201);

    const payload = findSessionNewCall(mocks[0]!);
    expect(payload).toBeDefined();
    const servers = payload!.mcpServers as Array<{
      name: string;
      type: string;
      url: string;
      headers: Array<{ name: string; value: string }>;
    }>;
    const byName = new Map(servers.map((s) => [s.name, s]));
    expect(byName.has("hydra-acp-planner")).toBe(true);
    expect(byName.has("hydra-acp-notifier")).toBe(true);
    const planner = byName.get("hydra-acp-planner")!;
    expect(planner.type).toBe("http");
    expect(planner.url).toBe("http://127.0.0.1:9999/mcp/hydra-acp-planner");
    expect(planner.headers[0]!.name).toBe("Authorization");
    expect(planner.headers[0]!.value).toMatch(/^Bearer [0-9a-f]{64}$/);
    // Same bearer token across all extensions in one session (one
    // reservation, many descriptors).
    expect(byName.get("hydra-acp-notifier")!.headers[0]!.value).toBe(
      planner.headers[0]!.value,
    );
  });

  it("preserves caller-supplied mcpServers and appends extension descriptors after them", async () => {
    const fakeConn = {} as unknown as Parameters<ExtensionMcpRegistry["register"]>[1];
    extensionMcp.register("hydra-acp-planner", fakeConn, undefined, []);

    const callerDescriptor = { name: "caller-mcp", type: "stdio", command: "x" };
    const res = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: "/w",
        agentId: "claude-code",
        mcpServers: [callerDescriptor],
      }),
    });
    expect(res.status).toBe(201);

    const payload = findSessionNewCall(mocks[0]!);
    const servers = payload!.mcpServers as unknown[];
    expect(servers[0]).toEqual(callerDescriptor);
    expect(servers).toHaveLength(2);
    expect((servers[1] as { name: string }).name).toBe("hydra-acp-planner");
  });

  it("passes through the caller's mcpServers unchanged when no extensions are registered", async () => {
    const callerDescriptor = { name: "caller-only", type: "stdio", command: "x" };
    const res = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: "/w",
        agentId: "claude-code",
        mcpServers: [callerDescriptor],
      }),
    });
    expect(res.status).toBe(201);

    const payload = findSessionNewCall(mocks[0]!);
    expect(payload!.mcpServers).toEqual([callerDescriptor]);
  });
});

describe("session routes: compaction endpoints", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness.manager.closeAll().catch(() => undefined);
    await harness.app.close();
  });

  it("POST /v1/sessions/:id/compact returns 202 with { scheduled: true } for a live session", async () => {
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });

    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${session.sessionId}/compact`,
      { method: "POST" },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { scheduled: boolean };
    expect(body.scheduled).toBe(true);
  });

  it("POST /v1/sessions/:id/compact returns 404 for an unknown session", async () => {
    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/hydra_session_ghost/compact`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });

  it("POST /v1/sessions/:id/compact schedules compaction via coordinator for a cold session", async () => {
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    const id = session.sessionId;
    await session.close({ deleteRecord: false });
    expect(harness.manager.get(id)).toBeUndefined();

    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${id}/compact`,
      { method: "POST" },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { scheduled: boolean };
    expect(body.scheduled).toBe(true);
  });

  it("GET /v1/sessions/:id/compact returns current state shape", async () => {
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });

    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${session.sessionId}/compact`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summarizedThroughEntry?: number;
      inFlight: boolean;
    };
    // A fresh session has never been compacted, so summarizedThroughEntry
    // is undefined and omitted from the JSON response.
    expect(body).toHaveProperty("inFlight");
    expect(typeof body.inFlight).toBe("boolean");
  });

  it("GET /v1/sessions/:id/compact returns summarizedThroughEntry from a live session", async () => {
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    // New sessions have no summary yet, so summarizedThroughEntry should be undefined.
    session.summarizedThroughEntry = 42;

    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${session.sessionId}/compact`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summarizedThroughEntry?: number };
    expect(body.summarizedThroughEntry).toBe(42);
  });

  it("GET /v1/sessions/:id/compact returns 404 for an unknown session", async () => {
    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/hydra_session_ghost/compact`,
    );
    expect(res.status).toBe(404);
  });

  it("GET /v1/sessions/:id/compact returns summarizedThroughEntry for a cold session", async () => {
    // Import a bundle that already has summarizedThroughEntry set,
    // then verify the GET endpoint reads it from disk.
    const bundle = {
      version: 1 as const,
      exportedAt: "2026-05-13T00:00:00.000Z",
      exportedFrom: { hydraVersion: "0.1.0", machine: "h" },
      session: {
        sessionId: "hydra_session_cold",
        lineageId: "lin_cold_get",
        agentId: "claude-code",
        cwd: "/w",
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
        summarizedThroughEntry: 7,
      },
      history: [
        {
          method: "session/update",
          params: {
            sessionId: "u_cold",
            update: {
              sessionUpdate: "turn_complete",
              messageId: "m_cold",
              stopReason: "end_turn",
            },
          },
          recordedAt: 1,
        },
      ],
    };
    const imported = await harness.manager.importBundle(bundle);

    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${imported.sessionId}/compact`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summarizedThroughEntry?: number };
    expect(body.summarizedThroughEntry).toBe(7);
  });

  it("GET /v1/sessions/:id/compact includes compactionState when present", async () => {
    // Import a cold session, then inject compactionState directly via
    // the manager's private store so we can test the GET endpoint reads it.
    const bundle = {
      version: 1 as const,
      exportedAt: "2026-05-14T00:00:00.000Z",
      exportedFrom: { hydraVersion: "0.1.0", machine: "h" },
      session: {
        sessionId: "hydra_session_cs_route",
        lineageId: "lin_cs_route",
        agentId: "claude-code",
        cwd: "/w",
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
        summarizedThroughEntry: 12,
      },
      history: [] as Array<{
        method: string;
        params: Record<string, unknown>;
        recordedAt: number;
      }>,
    };
    const imported = await harness.manager.importBundle(bundle);
    // Inject compactionState by writing directly through the manager's store.
    const store = (harness.manager as unknown as { store: SessionStore }).store;
    const existing = await store.read(imported.sessionId);
    await store.write({
      ...existing!,
      compactionState: {
        status: "running",
        requestedAt: Date.now(),
        iter: 2,
        attempts: 0,
      },
    });

    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${imported.sessionId}/compact`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summarizedThroughEntry?: number;
      inFlight: boolean;
      compactionState?: { status: string; iter?: number };
    };
    expect(body.summarizedThroughEntry).toBe(12);
    expect(body.compactionState).toBeDefined();
    expect(body.compactionState?.status).toBe("running");
    expect(body.compactionState?.iter).toBe(2);
  });
});
