import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Session, type SessionInit } from "../../core/session.js";
import { makeMockAgent } from "../../__tests__/test-utils.js";
import type { HistoryEntry } from "../../core/history-store.js";
import { HistoryStore } from "../../core/history-store.js";
import { renderTranscript } from "../../core/history-transcript.js";
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

describe("stdin-server route — auth", () => {
  let h: Harness | null = null;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    if (h) {
      await h.app.close().catch(() => undefined);
      h = null;
    }
  });

  it("returns 401 with no Authorization header", async () => {
    const r = await fetch(`${h!.baseUrl}/mcp/hydra-acp-stdin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(r.status).toBe(401);
  });

  it("returns 401 when the header isn't a Bearer scheme", async () => {
    const r = await fetch(`${h!.baseUrl}/mcp/hydra-acp-stdin`, {
      method: "POST",
      headers: {
        Authorization: "Basic abcdef",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(r.status).toBe(401);
  });

  it("returns 404 for an unknown bearer token", async () => {
    const r = await fetch(`${h!.baseUrl}/mcp/hydra-acp-stdin`, {
      method: "POST",
      headers: {
        Authorization: "Bearer no-such-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(r.status).toBe(404);
  });
});

describe("stdin-server route — reservation race", () => {
  let h: Harness | null = null;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    if (h) {
      await h.app.close().catch(() => undefined);
      h = null;
    }
  });

  it("a request that arrives during the reserve→complete window resolves once complete() runs", async () => {
    const token = "race-token";
    const { complete } = h!.registry.reserve(token);

    // Fire the request first. The handler should find the reservation,
    // see session === undefined, and await sessionReady.
    const pending = fetch(`${h!.baseUrl}/mcp/hydra-acp-stdin`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.1" },
        },
      }),
    });

    // Brief delay so the handler is actually parked on sessionReady,
    // then complete the reservation.
    await new Promise((r) => setTimeout(r, 50));
    const session = makeStreamSession();
    complete(session);

    const r = await pending;
    expect(r.status).toBe(200);
  });
});

describe("stdin-server route — MCP tools end-to-end", () => {
  let h: Harness | null = null;
  let session: Session;
  let client: Client | null = null;
  const token = "test-token-deadbeef";

  beforeEach(async () => {
    h = await makeHarness();
    session = makeStreamSession();
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

  it("lists the five stdin tools (no recall_* without compaction)", async () => {
    const r = await client!.listTools();
    const names = r.tools.map((t) => t.name).sort();
    expect(names).toEqual(["grep", "head", "info", "read", "tail", "wait_for_more"].sort());
  });

  it("tail returns base64-encoded trailing bytes", async () => {
    session.streamWrite(Buffer.from("hello world").toString("base64"));
    const r = await client!.callTool({
      name: "tail",
      arguments: { bytes: 5 },
    });
    const sc = r.structuredContent as {
      bytes: string;
      startCursor: number;
      endCursor: number;
      truncated: boolean;
    };
    expect(Buffer.from(sc.bytes, "base64").toString("utf8")).toBe("world");
    expect(sc.endCursor).toBe(11);
    expect(sc.truncated).toBe(false);
  });

  it("head returns base64-encoded leading bytes", async () => {
    session.streamWrite(Buffer.from("hello world").toString("base64"));
    const r = await client!.callTool({
      name: "head",
      arguments: { bytes: 5 },
    });
    const sc = r.structuredContent as { bytes: string };
    expect(Buffer.from(sc.bytes, "base64").toString("utf8")).toBe("hello");
  });

  it("read with cursor returns a windowed slice", async () => {
    session.streamWrite(Buffer.from("0123456789").toString("base64"));
    const r = await client!.callTool({
      name: "read",
      arguments: { cursor: 3, max_bytes: 4 },
    });
    const sc = r.structuredContent as {
      bytes: string;
      nextCursor: number;
    };
    expect(Buffer.from(sc.bytes, "base64").toString("utf8")).toBe("3456");
    expect(sc.nextCursor).toBe(7);
  });

  it("info reports cursors and closed=false until close", async () => {
    session.streamWrite(Buffer.from("abc").toString("base64"));
    const r1 = await client!.callTool({ name: "info", arguments: {} });
    const sc1 = r1.structuredContent as {
      writeCursor: number;
      closed: boolean;
    };
    expect(sc1.writeCursor).toBe(3);
    expect(sc1.closed).toBe(false);

    session.streamWrite("", true);
    const r2 = await client!.callTool({ name: "info", arguments: {} });
    const sc2 = r2.structuredContent as { closed: boolean };
    expect(sc2.closed).toBe(true);
  });

  it("wait_for_more wakes when bytes are appended", async () => {
    const pending = client!.callTool({
      name: "wait_for_more",
      arguments: { cursor: 0, timeout_ms: 5_000 },
    });
    // Give the long-poll a moment to register the waiter before we
    // append. The MCP request travels async over HTTP; without this
    // delay the append could race ahead of the waiter registration and
    // the call would still return "data" via the writeCursor check —
    // but that wouldn't be exercising the wake path.
    await new Promise((r) => setTimeout(r, 50));
    session.streamWrite(Buffer.from("zz").toString("base64"));
    const r = await pending;
    const sc = r.structuredContent as {
      outcome: string;
      writeCursor: number;
    };
    expect(sc.outcome).toBe("data");
    expect(sc.writeCursor).toBe(2);
  });

  it("wait_for_more wakes with eof when the stream closes", async () => {
    const pending = client!.callTool({
      name: "wait_for_more",
      arguments: { cursor: 0, timeout_ms: 5_000 },
    });
    await new Promise((r) => setTimeout(r, 50));
    session.streamWrite("", true);
    const r = await pending;
    const sc = r.structuredContent as { outcome: string; closed: boolean };
    expect(sc.outcome).toBe("eof");
    expect(sc.closed).toBe(true);
  });

  it("wait_for_more returns timeout when no data and no close arrives", async () => {
    const r = await client!.callTool({
      name: "wait_for_more",
      arguments: { cursor: 0, timeout_ms: 100 },
    });
    const sc = r.structuredContent as { outcome: string };
    expect(sc.outcome).toBe("timeout");
  });

  it("grep returns matching lines with absolute cursors", async () => {
    const body = "alpha 720p\nbeta 1080p\ngamma 720p\ndelta 480p\n";
    session.streamWrite(Buffer.from(body).toString("base64"));
    const r = await client!.callTool({
      name: "grep",
      arguments: { pattern: "720p" },
    });
    const sc = r.structuredContent as {
      matches: Array<{ cursor: number; line: string }>;
      truncated: boolean;
    };
    expect(sc.truncated).toBe(false);
    expect(sc.matches.map((m) => m.line)).toEqual([
      "alpha 720p",
      "gamma 720p",
    ]);
    expect(sc.matches[0]!.cursor).toBe(0);
    expect(sc.matches[1]!.cursor).toBe("alpha 720p\nbeta 1080p\n".length);
  });

  it("grep honors regex:false for literal matching", async () => {
    const body = "a.c\nabc\nadc\n";
    session.streamWrite(Buffer.from(body).toString("base64"));
    const r = await client!.callTool({
      name: "grep",
      arguments: { pattern: "a.c", regex: false },
    });
    const sc = r.structuredContent as {
      matches: Array<{ line: string }>;
    };
    expect(sc.matches.map((m) => m.line)).toEqual(["a.c"]);
  });

  it("grep truncates at max_matches and reports nextCursor", async () => {
    const body = "hit\nhit\nhit\nhit\nhit\n";
    session.streamWrite(Buffer.from(body).toString("base64"));
    const r = await client!.callTool({
      name: "grep",
      arguments: { pattern: "hit", max_matches: 2 },
    });
    const sc = r.structuredContent as {
      matches: Array<{ line: string }>;
      truncated: boolean;
      nextCursor: number;
    };
    expect(sc.truncated).toBe(true);
    expect(sc.matches).toHaveLength(2);
    expect(sc.nextCursor).toBe("hit\nhit\n".length);
  });

  it("grep returns context_before / context_after lines", async () => {
    const body = "L0\nL1\nMATCH\nL3\nL4\n";
    session.streamWrite(Buffer.from(body).toString("base64"));
    const r = await client!.callTool({
      name: "grep",
      arguments: {
        pattern: "MATCH",
        context_before: 1,
        context_after: 1,
      },
    });
    const sc = r.structuredContent as {
      matches: Array<{
        line: string;
        before?: Array<{ line: string }>;
        after?: Array<{ line: string }>;
      }>;
    };
    expect(sc.matches).toHaveLength(1);
    expect(sc.matches[0]!.before?.map((b) => b.line)).toEqual(["L1"]);
    expect(sc.matches[0]!.after?.map((a) => a.line)).toEqual(["L3"]);
  });

 describe("stdin-server route — recall_range tool", () => {
  let h: Harness | null = null;
  let session: Session;
  let client: Client | null = null;
  const token = "recall-range-token-deadbeef";

  beforeEach(async () => {
    h = await makeHarness();
    const historyStore = new HistoryStore();
    session = makeStreamSession({ historyStore });
    session.summarizedThroughEntry = 1;
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

  function populateHistory(entries: HistoryEntry[]): void {
    void (session as unknown as { historyStore: HistoryStore }).historyStore.rewrite(
      session.sessionId,
      entries,
    );
  }

  it("rejects when to_entry < from_entry", async () => {
    populateHistory([]);
    const r = await client!.callTool({
      name: "recall_range",
      arguments: { from_entry: 5, to_entry: 2 },
    });
    const content = r.content as Array<{ text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]!.text).toContain("to_entry");
    expect(content[0]!.text).toContain("from_entry");
    expect(r.isError).toBe(true);
  });

  it("rejects when range size exceeds 50", async () => {
    populateHistory([]);
    const r = await client!.callTool({
      name: "recall_range",
      arguments: { from_entry: 0, to_entry: 50 },
    });
    expect(r.isError).toBe(true);
    const content = r.content as Array<{ text: string }>;
    expect(content[0]!.text).toContain(
      "exceeds maximum of 50 entries",
    );
  });

  it("clamps out-of-bounds indices to available history", async () => {
    const entries: HistoryEntry[] = [];
    for (let i = 0; i < 3; i++) {
      entries.push({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "prompt_received",
            prompt: `message ${i}`,
          },
        },
        recordedAt: 1000 + i,
      });
    }
    populateHistory(entries);

    const r = await client!.callTool({
      name: "recall_range",
      arguments: { from_entry: 1, to_entry: 10 },
    });
    const sc = r.structuredContent as {
      text: string;
      entry_count: number;
      truncated: boolean;
    };
    expect(sc.entry_count).toBe(2);
    expect(sc.truncated).toBe(true);
    expect(sc.text).toContain("message 1");
    expect(sc.text).toContain("message 2");
  });

  it("returns empty result when range is entirely beyond history", async () => {
    populateHistory([]);
    const r = await client!.callTool({
      name: "recall_range",
      arguments: { from_entry: 0, to_entry: 5 },
    });
    const sc = r.structuredContent as {
      text: string;
      entry_count: number;
      truncated: boolean;
    };
    expect(sc.entry_count).toBe(0);
    expect(sc.text).toBe("");
    expect(sc.truncated).toBe(true);
  });

  it("renders a small range correctly", async () => {
    const entries: HistoryEntry[] = [
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
            sessionUpdate: "turn_complete",
          },
        },
        recordedAt: 1002,
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "prompt_received",
            prompt: "second turn",
          },
        },
        recordedAt: 1003,
      },
    ];
    populateHistory(entries);

    const r = await client!.callTool({
      name: "recall_range",
      arguments: { from_entry: 0, to_entry: 1 },
    });
    const sc = r.structuredContent as {
      text: string;
      entry_count: number;
      truncated: boolean;
    };
    expect(sc.entry_count).toBe(2);
    expect(sc.truncated).toBe(false);
    expect(sc.text).toContain("User: hello world");
    expect(sc.text).toContain("Assistant: hi there");
  });

  it("renders tool_call entries through renderTranscript", async () => {
    const entries: HistoryEntry[] = [
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
    ];
    populateHistory(entries);

    const r = await client!.callTool({
      name: "recall_range",
      arguments: { from_entry: 0, to_entry: 0 },
    });
    const sc = r.structuredContent as { text: string; entry_count: number };
    expect(sc.entry_count).toBe(1);
    expect(sc.text).toContain("Tool: Bash");
    expect(sc.text).toContain("command=ls -la");
  });

  it("skips non-session/update entries in the rendered output", async () => {
    const entries: HistoryEntry[] = [
      {
        method: "notification",
        params: { type: "session_info" },
        recordedAt: 3000,
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "prompt_received",
            prompt: "only this shows",
          },
        },
        recordedAt: 3001,
      },
    ];
    populateHistory(entries);

    const r = await client!.callTool({
      name: "recall_range",
      arguments: { from_entry: 0, to_entry: 1 },
    });
    const sc = r.structuredContent as { text: string; entry_count: number };
    expect(sc.entry_count).toBe(2);
    expect(sc.text).toContain("only this shows");
    expect(sc.text).not.toContain("session_info");
  });

  it("renderTranscript truncation propagates through truncated flag", async () => {
    const bigText = "x".repeat(500_000);
    const entries: HistoryEntry[] = [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "prompt_received",
            prompt: bigText,
          },
        },
        recordedAt: 4000,
      },
    ];
    populateHistory(entries);

    const r = await client!.callTool({
      name: "recall_range",
      arguments: { from_entry: 0, to_entry: 0 },
    });
    const sc = r.structuredContent as { text: string; entry_count: number };
    expect(sc.entry_count).toBe(1);
    expect(sc.text.length).toBeLessThan(bigText.length);
  });

  it("renderTranscript produces the same output for a slice as direct rendering", async () => {
    const entries: HistoryEntry[] = [];
    for (let i = 0; i < 20; i++) {
      entries.push({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "prompt_received",
            prompt: `entry ${i}`,
          },
        },
        recordedAt: 5000 + i,
      });
    }
    populateHistory(entries);

    const slice = entries.slice(5, 10);
    const expected = renderTranscript(slice as unknown as Parameters<typeof renderTranscript>[0]);

    const r = await client!.callTool({
      name: "recall_range",
      arguments: { from_entry: 5, to_entry: 9 },
    });
    const sc = r.structuredContent as { text: string; entry_count: number };
    expect(sc.entry_count).toBe(5);
    expect(sc.text).toBe(expected);
  });
});
});
