import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Session, type SessionInit } from "../core/session.js";
import { makeMockAgent } from "./test-utils.js";
import { HistoryStore } from "../core/history-store.js";
import type { HistoryEntry } from "../core/history-store.js";
import { McpTokenRegistry } from "../daemon/mcp/token-registry.js";
import { registerRecallMcpRoutes } from "../daemon/mcp/recall-server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";

function makeStreamSession(
  opts?: { historyStore?: HistoryStore; summarizedThroughEntry?: number },
): Session {
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
  if (opts?.summarizedThroughEntry !== undefined) {
    session.summarizedThroughEntry = opts.summarizedThroughEntry;
  }
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
  registerRecallMcpRoutes(app, registry);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address() as AddressInfo;
  return { app, registry, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function connectClient(
  baseUrl: string,
  token: string,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp/hydra-acp-recall`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  );
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

function populateHistory(session: Session, entries: HistoryEntry[]): void {
  void (session as unknown as { historyStore: HistoryStore }).historyStore.rewrite(
    session.sessionId,
    entries,
  );
}

describe("recall tools — call-time gated on summarizedThroughEntry", () => {
  // The recall MCP server always exposes the three tools (the SDK
  // requires at least one registered tool to wire the tools/list
  // handler). When summarizedThroughEntry is undefined or 0, calling a
  // tool returns a friendly "no compacted history yet" result with an
  // empty payload rather than an error. The gate moves to call time so
  // pre-compaction sessions get the same tool surface as post-compaction
  // ones; the gate is purely on what the tools DO, not what's listed.
  describe("when summarizedThroughEntry is undefined", () => {
    let h: Harness | null = null;
    let client: Client | null = null;
    const token = "no-compaction-token";

    beforeEach(async () => {
      h = await makeHarness();
      const session = makeStreamSession();
      expect(session.summarizedThroughEntry).toBeUndefined();
      h.registry.bind(token, session);
      client = await connectClient(h.baseUrl, token);
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

    it("lists the three recall tools (registered unconditionally to keep tools/list wired)", async () => {
      const r = await client!.listTools();
      const names = r.tools.map((t) => t.name).sort();
      expect(names).toEqual(["range", "search", "tool_calls"]);
    });

    it("search returns empty matches + a 'no compacted history' note", async () => {
      const r = await client!.callTool({
        name: "search",
        arguments: { query: "anything" },
      });
      const sc = r.structuredContent as { matches: unknown[]; total_matched: number; note?: string };
      expect(sc.matches).toEqual([]);
      expect(sc.total_matched).toBe(0);
      expect(sc.note).toContain("no compacted history");
    });

    it("range returns empty text + a 'no compacted history' note", async () => {
      const r = await client!.callTool({
        name: "range",
        arguments: { from_entry: 0, to_entry: 5 },
      });
      const sc = r.structuredContent as { text: string; entry_count: number; note?: string };
      expect(sc.text).toBe("");
      expect(sc.entry_count).toBe(0);
      expect(sc.note).toContain("no compacted history");
    });

    it("tool_calls returns empty calls + a 'no compacted history' note", async () => {
      const r = await client!.callTool({
        name: "tool_calls",
        arguments: { tool_name: "anything" },
      });
      const sc = r.structuredContent as { calls: unknown[]; note?: string };
      expect(sc.calls).toEqual([]);
      expect(sc.note).toContain("no compacted history");
    });
  });

  describe("when summarizedThroughEntry is 0", () => {
    let h: Harness | null = null;
    let client: Client | null = null;
    const token = "zero-compaction-token";

    beforeEach(async () => {
      h = await makeHarness();
      const session = makeStreamSession({ summarizedThroughEntry: 0 });
      expect(session.summarizedThroughEntry).toBe(0);
      h.registry.bind(token, session);
      client = await connectClient(h.baseUrl, token);
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

    it("search returns empty matches + a 'no compacted history' note", async () => {
      const r = await client!.callTool({
        name: "search",
        arguments: { query: "anything" },
      });
      const sc = r.structuredContent as { matches: unknown[]; note?: string };
      expect(sc.matches).toEqual([]);
      expect(sc.note).toContain("no compacted history");
    });
  });

  describe("present when summarizedThroughEntry > 0", () => {
    let h: Harness | null = null;
    let client: Client | null = null;
    const token = "compacted-token";
    let session: Session;

    beforeEach(async () => {
      h = await makeHarness();
      const historyStore = new HistoryStore();
      session = makeStreamSession({ historyStore, summarizedThroughEntry: 42 });
      expect(session.summarizedThroughEntry).toBe(42);
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
      ]);
      h.registry.bind(token, session);
      client = await connectClient(h.baseUrl, token);
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

    it("exposes search", async () => {
      const r = await client!.listTools();
      const names = r.tools.map((t) => t.name);
      expect(names).toContain("search");
    });

    it("exposes range", async () => {
      const r = await client!.listTools();
      const names = r.tools.map((t) => t.name);
      expect(names).toContain("range");
    });

    it("exposes tool_calls", async () => {
      const r = await client!.listTools();
      const names = r.tools.map((t) => t.name);
      expect(names).toContain("tool_calls");
    });

    it("lists exactly the three recall tools (server is recall-only)", async () => {
      const r = await client!.listTools();
      const names = r.tools.map((t) => t.name).sort();
      expect(names).toEqual(
        ["range", "search", "tool_calls"],
      );
    });

    it("search finds entries in history", async () => {
      const r = await client!.callTool({
        name: "search",
        arguments: { query: "hello" },
      });
      const sc = r.structuredContent as { total_matched: number; matches: Array<{ entryId: number }> };
      expect(sc.total_matched).toBe(1);
      expect(sc.matches[0]!.entryId).toBe(0);
    });

    it("range returns entries in the requested range", async () => {
      const r = await client!.callTool({
        name: "range",
        arguments: { from_entry: 0, to_entry: 0 },
      });
      const sc = r.structuredContent as { entry_count: number; text: string };
      expect(sc.entry_count).toBe(1);
      expect(sc.text).toContain("hello world");
    });

    it("tool_calls returns entries matching a tool filter", async () => {
      populateHistory(session, [
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call",
              name: "Bash",
              title: "Bash",
              rawInput: { command: "ls -la" },
            },
          },
          recordedAt: 2000,
        },
      ]);
      const r = await client!.callTool({
        name: "tool_calls",
        arguments: { tool_name: "bash" },
      });
      const sc = r.structuredContent as { calls: Array<{ tool: string }> };
      expect(sc.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("behavior flips after compaction — same MCP server, gate moves from no-op to real work", () => {
    let h: Harness | null = null;
    const token = "behavior-flip-token";

    afterEach(async () => {
      if (h) {
        await h.app.close().catch(() => undefined);
        h = null;
      }
    });

    it("search returns empty pre-compaction; returns matches post-compaction (same client, same token)", async () => {
      h = await makeHarness();
      const historyStore = new HistoryStore();
      const session = makeStreamSession({ historyStore });
      expect(session.summarizedThroughEntry).toBeUndefined();

      populateHistory(session, [
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "prompt_received",
              prompt: "pre-compaction message",
            },
          },
          recordedAt: 1000,
        },
      ]);

      h.registry.bind(token, session);
      const client = await connectClient(h.baseUrl, token);

      // Pre-compaction: tool is listed but returns the "no compacted
      // history" note. The list is identical to the post-compaction list
      // — what differs is the answer the tool gives, not its visibility.
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual(["range", "search", "tool_calls"]);

      const preCallResult = await client.callTool({
        name: "search",
        arguments: { query: "pre-compaction" },
      });
      const preCall = preCallResult.structuredContent as {
        matches: unknown[];
        total_matched: number;
        note?: string;
      };
      expect(preCall.matches).toEqual([]);
      expect(preCall.total_matched).toBe(0);
      expect(preCall.note).toContain("no compacted history");

      // Simulate compaction: set summarizedThroughEntry. In production
      // this is done via persistSynopsis after a successful compaction
      // run. The MCP server is reused (same token), so the test verifies
      // the call-time gate flips — no need for a fresh token / route
      // rebuild for the BEHAVIOR transition.
      session.summarizedThroughEntry = 1;

      const postCallResult = await client.callTool({
        name: "search",
        arguments: { query: "pre-compaction" },
      });
      const postCall = postCallResult.structuredContent as {
        matches: Array<{ entryId: number }>;
        total_matched: number;
      };
      expect(postCall.total_matched).toBe(1);
      expect(postCall.matches[0]!.entryId).toBe(0);

      await client.close().catch(() => undefined);
    });
  });
});
