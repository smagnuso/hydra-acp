import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Session, type SessionInit } from "../core/session.js";
import { makeMockAgent } from "./test-utils.js";
import { HistoryStore } from "../core/history-store.js";
import type { HistoryEntry } from "../core/history-store.js";
import { McpTokenRegistry } from "../daemon/mcp/token-registry.js";
import { registerStdinMcpRoutes } from "../daemon/mcp/stdin-server.js";
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
  registerStdinMcpRoutes(app, registry);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address() as AddressInfo;
  return { app, registry, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function connectClient(
  baseUrl: string,
  token: string,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp/hydra-acp-stdin`),
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

describe("recall tools — gated on summarizedThroughEntry", () => {
  describe("absent when summarizedThroughEntry is undefined", () => {
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

    it("does not expose recall_search", async () => {
      const r = await client!.listTools();
      const names = r.tools.map((t) => t.name);
      expect(names).not.toContain("recall_search");
    });

    it("does not expose recall_range", async () => {
      const r = await client!.listTools();
      const names = r.tools.map((t) => t.name);
      expect(names).not.toContain("recall_range");
    });

    it("does not expose recall_tool_calls", async () => {
      const r = await client!.listTools();
      const names = r.tools.map((t) => t.name);
      expect(names).not.toContain("recall_tool_calls");
    });

    it("still exposes the five non-recall tools", async () => {
      const r = await client!.listTools();
      const names = r.tools.map((t) => t.name).sort();
      expect(names).toEqual(["grep", "head", "info", "read", "tail", "wait_for_more"].sort());
    });
  });

  describe("absent when summarizedThroughEntry is 0", () => {
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

    it("does not expose recall_search", async () => {
      const r = await client!.listTools();
      const names = r.tools.map((t) => t.name);
      expect(names).not.toContain("recall_search");
    });

    it("does not expose recall_range", async () => {
      const r = await client!.listTools();
      const names = r.tools.map((t) => t.name);
      expect(names).not.toContain("recall_range");
    });

    it("does not expose recall_tool_calls", async () => {
      const r = await client!.listTools();
      const names = r.tools.map((t) => t.name);
      expect(names).not.toContain("recall_tool_calls");
    });

    it("still exposes the five non-recall tools", async () => {
      const r = await client!.listTools();
      const names = r.tools.map((t) => t.name).sort();
      expect(names).toEqual(["grep", "head", "info", "read", "tail", "wait_for_more"].sort());
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

    it("exposes recall_search", async () => {
      const r = await client!.listTools();
      const names = r.tools.map((t) => t.name);
      expect(names).toContain("recall_search");
    });

    it("exposes recall_range", async () => {
      const r = await client!.listTools();
      const names = r.tools.map((t) => t.name);
      expect(names).toContain("recall_range");
    });

    it("exposes recall_tool_calls", async () => {
      const r = await client!.listTools();
      const names = r.tools.map((t) => t.name);
      expect(names).toContain("recall_tool_calls");
    });

    it("lists all nine tools", async () => {
      const r = await client!.listTools();
      const names = r.tools.map((t) => t.name).sort();
      expect(names).toEqual(
        ["grep", "head", "info", "read", "recall_range", "recall_search", "recall_tool_calls", "tail", "wait_for_more"].sort(),
      );
    });

    it("recall_search finds entries in history", async () => {
      const r = await client!.callTool({
        name: "recall_search",
        arguments: { query: "hello" },
      });
      const sc = r.structuredContent as { total_matched: number; matches: Array<{ entryId: number }> };
      expect(sc.total_matched).toBe(1);
      expect(sc.matches[0]!.entryId).toBe(0);
    });

    it("recall_range returns entries in the requested range", async () => {
      const r = await client!.callTool({
        name: "recall_range",
        arguments: { from_entry: 0, to_entry: 0 },
      });
      const sc = r.structuredContent as { entry_count: number; text: string };
      expect(sc.entry_count).toBe(1);
      expect(sc.text).toContain("hello world");
    });

    it("recall_tool_calls returns entries matching a tool filter", async () => {
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
        name: "recall_tool_calls",
        arguments: { tool_name: "bash" },
      });
      const sc = r.structuredContent as { calls: Array<{ tool: string }> };
      expect(sc.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("visibility flips after swap — new MCP server sees compaction", () => {
    let h: Harness | null = null;
    const preSwapToken = "pre-swap-token";
    const postSwapToken = "post-swap-token";

    afterEach(async () => {
      if (h) {
        await h.app.close().catch(() => undefined);
        h = null;
      }
    });

    it("pre-swap server lacks recall_*; post-swap server has them", async () => {
      // Build harness and session with no compaction.
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
              prompt: "pre-swap message",
            },
          },
          recordedAt: 1000,
        },
      ]);

      // Bind pre-swap token and connect client — MCP server built with summarizedThroughEntry = undefined.
      h.registry.bind(preSwapToken, session);
      const preClient = await connectClient(h.baseUrl, preSwapToken);

      // Pre-swap: no recall tools.
      const preTools = (await preClient.listTools()).tools.map((t) => t.name).sort();
      expect(preTools).not.toContain("recall_search");
      expect(preTools).not.toContain("recall_range");
      expect(preTools).not.toContain("recall_tool_calls");
      await preClient.close().catch(() => undefined);

      // Simulate compaction: set summarizedThroughEntry on the same session.
      // In production this happens via persistSynopsis after a compaction run.
      session.summarizedThroughEntry = 1;

      // Bind post-swap token — new MCP server built with summarizedThroughEntry = 1.
      h.registry.bind(postSwapToken, session);
      const postClient = await connectClient(h.baseUrl, postSwapToken);

      // Post-swap: recall tools are present.
      const postTools = (await postClient.listTools()).tools.map((t) => t.name).sort();
      expect(postTools).toContain("recall_search");
      expect(postTools).toContain("recall_range");
      expect(postTools).toContain("recall_tool_calls");

      // Post-swap recall tools actually work against the same history.
      const searchResult = await postClient.callTool({
        name: "recall_search",
        arguments: { query: "pre-swap" },
      });
      const sc = searchResult.structuredContent as { total_matched: number };
      expect(sc.total_matched).toBe(1);

      await postClient.close().catch(() => undefined);
    });
  });
});
