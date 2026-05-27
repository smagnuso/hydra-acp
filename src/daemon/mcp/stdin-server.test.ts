import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Session } from "../../core/session.js";
import { makeMockAgent } from "../../__tests__/test-utils.js";
import { McpTokenRegistry } from "./token-registry.js";
import { registerStdinMcpRoutes } from "./stdin-server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";

function makeStreamSession(): Session {
  const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
  const session = new Session({
    cwd: "/work",
    agentId: "mock",
    agent: mock.agent,
    upstreamSessionId: "u-test",
  });
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

  it("lists the six stdin tools", async () => {
    const r = await client!.listTools();
    const names = r.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ["grep", "head", "info", "read", "tail", "wait_for_more"].sort(),
    );
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
});
