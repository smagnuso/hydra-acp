import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Session, type SessionInit } from "../../core/session.js";
import { makeMockAgent } from "../../__tests__/test-utils.js";
import type { HistoryEntry } from "../../core/history-store.js";
import { HistoryStore } from "../../core/history-store.js";
import { McpTokenRegistry } from "./token-registry.js";
import { registerStdinMcpRoutes } from "./stdin-server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";

function makeStreamSession(opts?: { historyStore?: HistoryStore }): Session {
  const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
  const init: SessionInit = {
    cwd: "/work",
    agentId: "mock",
    agent: mock.agent,
    upstreamSessionId: "u-test",
  };
  if (opts?.historyStore) {
    init.historyStore = opts.historyStore;
  }
  const session = new Session(init);
  session.openStream({ mode: "memory", capacityBytes: 64 * 1024 });
  session.summarizedThroughEntry = 1;
  return session;
}

interface Harness {
  app: FastifyInstance;
  registry: McpTokenRegistry;
  baseUrl: string;
}

async function makeHarness(): Promise<Harness> {
  const registry = new McpTokenRegistry();
  const app = Fastify({ logger: false });
  registerStdinMcpRoutes(app, registry);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address() as AddressInfo;
  return { app, registry, baseUrl: `http://127.0.0.1:${addr.port}` };
}

function populateHistory(
  session: Session,
  entries: HistoryEntry[],
): void {
  void (session as unknown as { historyStore: HistoryStore }).historyStore.rewrite(
    session.sessionId,
    entries,
  );
}

describe("recall_search — empty query rejected", () => {
  let h: Harness | null = null;
  let client: Client | null = null;
  const token = "empty-query-token";

  beforeEach(async () => {
    h = await makeHarness();
    const session = makeStreamSession();
    h.registry.bind(token, session);
    const transport = new StreamableHTTPClientTransport(
      new URL(`${h.baseUrl}/mcp/hydra-acp-stdin`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    );
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(transport);
  });

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => undefined);
      client = null;
    }
    if (h) {
      await h.app.close().catch(() => undefined);
      h = null;
    }
  });

  it("rejects when query is an empty string", async () => {
    const r = await client!.callTool({
      name: "recall_search",
      arguments: { query: "" },
    });
    expect(r.isError).toBe(true);
    const content = r.content as Array<{ text: string }>;
    expect(content).toHaveLength(1);
  });

  it("rejects when query is missing entirely", async () => {
    const r = await client!.callTool({
      name: "recall_search",
      arguments: {},
    });
    expect(r.isError).toBe(true);
  });
});

describe("recall_search — matches return", () => {
  let h: Harness | null = null;
  let session: Session;
  let client: Client | null = null;
  const token = "matches-token";

  beforeEach(async () => {
    h = await makeHarness();
    const historyStore = new HistoryStore();
    session = makeStreamSession({ historyStore });
    h.registry.bind(token, session);
    const transport = new StreamableHTTPClientTransport(
      new URL(`${h.baseUrl}/mcp/hydra-acp-stdin`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    );
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(transport);

    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "prompt_received",
            prompt: "hello world",
          },
        },
        recordedAt: 1000,
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { text: "hi there" },
          },
        },
        recordedAt: 1001,
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "prompt_received",
            prompt: "goodbye world",
          },
        },
        recordedAt: 1002,
      },
    ]);
  });

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => undefined);
      client = null;
    }
    if (h) {
      await h.app.close().catch(() => undefined);
      h = null;
    }
  });

  it("returns matches for a query that appears in multiple entries", async () => {
    const r = await client!.callTool({
      name: "recall_search",
      arguments: { query: "world" },
    });
    const sc = r.structuredContent as {
      matches: Array<{ entryId: number; speaker: string; snippet: string }>;
      total_matched: number;
      truncated: boolean;
    };
    expect(sc.matches).toHaveLength(2);
    expect(sc.total_matched).toBe(2);
    expect(sc.truncated).toBe(false);
    expect(sc.matches[0]!.speaker).toBe("user");
    expect(sc.matches[1]!.speaker).toBe("user");
  });

  it("returns single match for a unique query", async () => {
    const r = await client!.callTool({
      name: "recall_search",
      arguments: { query: "goodbye" },
    });
    const sc = r.structuredContent as { matches: Array<{ entryId: number }> };
    expect(sc.matches).toHaveLength(1);
    expect(sc.matches[0]!.entryId).toBe(2);
  });

  it("returns no matches when query is absent from all entries", async () => {
    const r = await client!.callTool({
      name: "recall_search",
      arguments: { query: "xyzzy" },
    });
    const sc = r.structuredContent as { matches: unknown[]; total_matched: number };
    expect(sc.matches).toHaveLength(0);
    expect(sc.total_matched).toBe(0);
  });

  it("includes tool_call entries by default", async () => {
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Bash",
            rawInput: { command: "ls -la" },
          },
        },
        recordedAt: 2000,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_search",
      arguments: { query: "ls" },
    });
    const sc = r.structuredContent as { matches: Array<{ speaker: string }> };
    expect(sc.matches).toHaveLength(1);
    expect(sc.matches[0]!.speaker).toBe("tool");
  });

  it("excludes tool_call entries when include_tool_calls is false", async () => {
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Bash",
            rawInput: { command: "ls -la" },
          },
        },
        recordedAt: 2000,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_search",
      arguments: { query: "ls", include_tool_calls: false },
    });
    const sc = r.structuredContent as { matches: unknown[] };
    expect(sc.matches).toHaveLength(0);
  });

  it("includes timestamps from recordedAt", async () => {
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "prompt_received",
            prompt: "hello world",
          },
        },
        recordedAt: 1700000000000,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_search",
      arguments: { query: "world" },
    });
    const sc = r.structuredContent as { matches: Array<{ timestamp?: string }> };
    expect(sc.matches[0]!.timestamp).toBe("1700000000000");
  });

  it("renders entryId as the zero-based array index", async () => {
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "prompt_received",
            prompt: "first entry",
          },
        },
        recordedAt: 1000,
      },
      {
        method: "notification",
        params: { type: "session_info" },
        recordedAt: 1001,
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "prompt_received",
            prompt: "hello world",
          },
        },
        recordedAt: 1002,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_search",
      arguments: { query: "world" },
    });
    const sc = r.structuredContent as { matches: Array<{ entryId: number }> };
    expect(sc.matches[0]!.entryId).toBe(2);
  });
});

describe("recall_search — limit honored", () => {
  let h: Harness | null = null;
  let session: Session;
  let client: Client | null = null;
  const token = "limit-token";

  beforeEach(async () => {
    h = await makeHarness();
    const historyStore = new HistoryStore();
    session = makeStreamSession({ historyStore });
    h.registry.bind(token, session);
    const transport = new StreamableHTTPClientTransport(
      new URL(`${h.baseUrl}/mcp/hydra-acp-stdin`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    );
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(transport);

    const entries: HistoryEntry[] = [];
    for (let i = 0; i < 20; i++) {
      entries.push({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "prompt_received",
            prompt: `this is a hit entry number ${i}`,
          },
        },
        recordedAt: 1000 + i,
      });
    }
    populateHistory(session, entries);
  });

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => undefined);
      client = null;
    }
    if (h) {
      await h.app.close().catch(() => undefined);
      h = null;
    }
  });

  it("caps results at the specified limit", async () => {
    const r = await client!.callTool({
      name: "recall_search",
      arguments: { query: "hit", limit: 5 },
    });
    const sc = r.structuredContent as { matches: unknown[]; truncated: boolean };
    expect(sc.matches).toHaveLength(5);
    expect(sc.truncated).toBe(true);
  });

  it("uses default limit of 10 when not specified", async () => {
    const r = await client!.callTool({
      name: "recall_search",
      arguments: { query: "hit" },
    });
    const sc = r.structuredContent as { matches: unknown[]; truncated: boolean };
    expect(sc.matches).toHaveLength(10);
    expect(sc.truncated).toBe(true);
  });

  it("rejects limit > 50", async () => {
    const r = await client!.callTool({
      name: "recall_search",
      arguments: { query: "hit", limit: 51 },
    });
    expect(r.isError).toBe(true);
  });

  it("rejects limit < 1", async () => {
    const r = await client!.callTool({
      name: "recall_search",
      arguments: { query: "hit", limit: 0 },
    });
    expect(r.isError).toBe(true);
  });

  it("returns truncated=false when total matches fit within limit", async () => {
    const r = await client!.callTool({
      name: "recall_search",
      arguments: { query: "hit", limit: 25 },
    });
    const sc = r.structuredContent as { matches: unknown[]; truncated: boolean };
    expect(sc.truncated).toBe(false);
  });
});

describe("recall_search — case-insensitive match", () => {
  let h: Harness | null = null;
  let session: Session;
  let client: Client | null = null;
  const token = "case-token";

  beforeEach(async () => {
    h = await makeHarness();
    const historyStore = new HistoryStore();
    session = makeStreamSession({ historyStore });
    h.registry.bind(token, session);
    const transport = new StreamableHTTPClientTransport(
      new URL(`${h.baseUrl}/mcp/hydra-acp-stdin`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    );
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(transport);

    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "prompt_received",
            prompt: "HELLO WORLD",
          },
        },
        recordedAt: 1000,
      },
    ]);
  });

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => undefined);
      client = null;
    }
    if (h) {
      await h.app.close().catch(() => undefined);
      h = null;
    }
  });

  it("matches lowercase query against uppercase text", async () => {
    const r = await client!.callTool({
      name: "recall_search",
      arguments: { query: "hello" },
    });
    const sc = r.structuredContent as { matches: unknown[] };
    expect(sc.matches).toHaveLength(1);
  });

  it("matches mixed-case query against text", async () => {
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "prompt_received",
            prompt: "The Quick Brown Fox",
          },
        },
        recordedAt: 1001,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_search",
      arguments: { query: "QUICK brown" },
    });
    const sc = r.structuredContent as { matches: unknown[] };
    expect(sc.matches).toHaveLength(1);
  });

  it("does not match when case differs and no overlap", async () => {
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "prompt_received",
            prompt: "The Quick Brown Fox",
          },
        },
        recordedAt: 1002,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_search",
      arguments: { query: "xyz" },
    });
    const sc = r.structuredContent as { matches: unknown[] };
    expect(sc.matches).toHaveLength(0);
  });
});

describe("recall_search — snippet formatting", () => {
  let h: Harness | null = null;
  let session: Session;
  let client: Client | null = null;
  const token = "snippet-token";

  beforeEach(async () => {
    h = await makeHarness();
    const historyStore = new HistoryStore();
    session = makeStreamSession({ historyStore });
    h.registry.bind(token, session);
    const transport = new StreamableHTTPClientTransport(
      new URL(`${h.baseUrl}/mcp/hydra-acp-stdin`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    );
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(transport);
  });

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => undefined);
      client = null;
    }
    if (h) {
      await h.app.close().catch(() => undefined);
      h = null;
    }
  });

  it("returns the full text when rendered entry is short", async () => {
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "prompt_received",
            prompt: "hi",
          },
        },
        recordedAt: 1000,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_search",
      arguments: { query: "hi" },
    });
    const sc = r.structuredContent as { matches: Array<{ snippet: string }> };
    expect(sc.matches[0]!.snippet.length).toBeLessThanOrEqual(150);
  });

  it("centers the snippet around the match for long text", async () => {
    const longText = "aaaa".repeat(200) + "MATCH" + "bbbb".repeat(200);
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "prompt_received",
            prompt: longText,
          },
        },
        recordedAt: 1000,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_search",
      arguments: { query: "MATCH" },
    });
    const sc = r.structuredContent as { matches: Array<{ snippet: string }> };
    const snippet = sc.matches[0]!.snippet;
    expect(snippet.length).toBeLessThanOrEqual(150);
    expect(snippet).toContain("MATCH");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });
});
