import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JsonRpcConnection } from "../../acp/connection.js";
import { Session } from "../../core/session.js";
import { makeMockAgent } from "../../__tests__/test-utils.js";
import { ExtensionMcpRegistry } from "../../core/extension-mcp.js";
import { McpTokenRegistry } from "./token-registry.js";
import { registerStdinMcpRoutes } from "./stdin-server.js";
import { registerExtensionMcpRoutes } from "./extension-route.js";

interface MockConnection {
  conn: JsonRpcConnection;
  calls: Array<{ method: string; params: unknown }>;
  setResponder: (
    fn: (method: string, params: unknown) => Promise<unknown>,
  ) => void;
}

function makeMockConnection(): MockConnection {
  let responder: (method: string, params: unknown) => Promise<unknown> =
    async () => {
      throw new Error("no responder set");
    };
  const calls: Array<{ method: string; params: unknown }> = [];
  const conn = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return responder(method, params);
    },
  } as unknown as JsonRpcConnection;
  return {
    conn,
    calls,
    setResponder: (fn) => {
      responder = fn;
    },
  };
}

function makeSession(): Session {
  const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
  return new Session({
    cwd: "/work",
    agentId: "mock",
    agent: mock.agent,
    upstreamSessionId: "u-test",
  });
}

interface Harness {
  app: FastifyInstance;
  tokenRegistry: McpTokenRegistry;
  extensionMcp: ExtensionMcpRegistry;
  baseUrl: string;
}

async function makeHarness(opts?: { invokeTimeoutMs?: number }): Promise<Harness> {
  const tokenRegistry = new McpTokenRegistry();
  const extensionMcp = new ExtensionMcpRegistry();
  const app = Fastify({ logger: false });
  // Register stdin too — verifies that /mcp/hydra-acp-stdin still wins the route
  // race against /mcp/:name.
  registerStdinMcpRoutes(app, tokenRegistry);
  registerExtensionMcpRoutes(app, tokenRegistry, extensionMcp, {
    buildOptions:
      opts?.invokeTimeoutMs !== undefined
        ? { invokeTimeoutMs: opts.invokeTimeoutMs }
        : undefined,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address() as AddressInfo;
  return {
    app,
    tokenRegistry,
    extensionMcp,
    baseUrl: `http://127.0.0.1:${addr.port}`,
  };
}

function pingTool() {
  return {
    name: "ping",
    description: "say hi",
    inputSchema: { type: "object" },
  };
}

describe("extension MCP route — auth", () => {
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

  it("returns 401 without an Authorization header", async () => {
    const r = await fetch(`${h!.baseUrl}/mcp/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(r.status).toBe(401);
  });

  it("returns 401 for a non-Bearer Authorization header", async () => {
    const r = await fetch(`${h!.baseUrl}/mcp/memory`, {
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
    const r = await fetch(`${h!.baseUrl}/mcp/memory`, {
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

describe("extension MCP route — unknown extension", () => {
  let h: Harness | null = null;
  const token = "tok-known";
  beforeEach(async () => {
    h = await makeHarness();
    h.tokenRegistry.bind(token, makeSession());
  });
  afterEach(async () => {
    if (h) {
      await h.app.close().catch(() => undefined);
      h = null;
    }
  });

  it("returns 404 when no extension is registered under that name", async () => {
    const r = await fetch(`${h!.baseUrl}/mcp/ghost`, {
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
    expect(r.status).toBe(404);
  });
});

describe("extension MCP route — happy path", () => {
  let h: Harness | null = null;
  let mock: MockConnection;
  let client: Client | null = null;
  const token = "tok-happy";

  beforeEach(async () => {
    h = await makeHarness();
    mock = makeMockConnection();
    h.tokenRegistry.bind(token, makeSession());
    h.extensionMcp.register(
      "memory",
      mock.conn,
      "memory help",
      [pingTool()],
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`${h.baseUrl}/mcp/memory`),
      {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      },
    );
    client = new Client({ name: "test", version: "0.0.1" });
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

  it("tools/list returns the registered tools", async () => {
    const r = await client!.listTools();
    expect(r.tools.map((t) => t.name)).toEqual(["ping"]);
  });

  it("tools/call forwards to the extension and surfaces the result", async () => {
    mock.setResponder(async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    const r = await client!.callTool({ name: "ping", arguments: { x: 1 } });
    const content = r.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toBe("pong");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.method).toBe("hydra-acp/mcp_tools/invoke");
    expect(mock.calls[0]!.params).toEqual({
      server: "memory",
      tool: "ping",
      args: { x: 1 },
    });
  });

  it("extension throwing surfaces as isError to the agent", async () => {
    mock.setResponder(async () => {
      throw new Error("memory backend down");
    });
    const r = await client!.callTool({ name: "ping", arguments: {} });
    expect(r.isError).toBe(true);
    const content = r.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toMatch(/memory backend down/);
  });

  it("malformed extension result surfaces as isError", async () => {
    mock.setResponder(async () => ({ no_content: true }));
    const r = await client!.callTool({ name: "ping", arguments: {} });
    expect(r.isError).toBe(true);
  });
});

describe("extension MCP route — timeout", () => {
  let h: Harness | null = null;
  let mock: MockConnection;
  let client: Client | null = null;
  const token = "tok-timeout";

  beforeEach(async () => {
    h = await makeHarness({ invokeTimeoutMs: 50 });
    mock = makeMockConnection();
    h.tokenRegistry.bind(token, makeSession());
    h.extensionMcp.register("memory", mock.conn, undefined, [pingTool()]);
    const transport = new StreamableHTTPClientTransport(
      new URL(`${h.baseUrl}/mcp/memory`),
      {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      },
    );
    client = new Client({ name: "test", version: "0.0.1" });
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

  it("hung extension yields isError within the configured timeout", async () => {
    mock.setResponder(() => new Promise(() => undefined));
    const start = Date.now();
    const r = await client!.callTool({ name: "ping", arguments: {} });
    const elapsed = Date.now() - start;
    expect(r.isError).toBe(true);
    const content = r.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toMatch(/timeout/);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("extension MCP route — hot reload eviction", () => {
  let h: Harness | null = null;
  let mock: MockConnection;
  let client: Client | null = null;
  const token = "tok-reload";

  beforeEach(async () => {
    h = await makeHarness();
    mock = makeMockConnection();
    mock.setResponder(async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    h.tokenRegistry.bind(token, makeSession());
    h.extensionMcp.register("memory", mock.conn, undefined, [
      pingTool(),
    ]);
    const transport = new StreamableHTTPClientTransport(
      new URL(`${h.baseUrl}/mcp/memory`),
      {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      },
    );
    client = new Client({ name: "test", version: "0.0.1" });
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

  it("re-registration evicts the built transport so a fresh client sees the new tool list", async () => {
    // Confirm initial tool list.
    const before = await client!.listTools();
    expect(before.tools.map((t) => t.name)).toEqual(["ping"]);

    // Re-register with a different tool name.
    h!.extensionMcp.register("memory", mock.conn, undefined, [
      {
        name: "ping_v2",
        description: "",
        inputSchema: { type: "object" },
      },
    ]);

    // The client we opened earlier may or may not survive (depends on
    // SDK behavior); the more important guarantee is that a *new*
    // client opening a *new* transport sees the new tool list. The
    // route closure should have evicted the cached transport.
    const fresh = new Client({ name: "fresh", version: "0.0.1" });
    const freshT = new StreamableHTTPClientTransport(
      new URL(`${h!.baseUrl}/mcp/memory`),
      {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      },
    );
    await fresh.connect(freshT);
    try {
      const after = await fresh.listTools();
      expect(after.tools.map((t) => t.name)).toEqual(["ping_v2"]);
    } finally {
      await fresh.close().catch(() => undefined);
    }
  });

  it("clear() evicts the built transport; subsequent requests get 404", async () => {
    h!.extensionMcp.clear("memory");
    const r = await fetch(`${h!.baseUrl}/mcp/memory`, {
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
    expect(r.status).toBe(404);
  });
});

describe("extension MCP route — session-end cleanup", () => {
  it("unbinding the token disposes the cached transport", async () => {
    const h = await makeHarness();
    const mock = makeMockConnection();
    mock.setResponder(async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    const token = "tok-unbind";
    h.tokenRegistry.bind(token, makeSession());
    h.extensionMcp.register("memory", mock.conn, undefined, [pingTool()]);

    // Open + use the transport so the lazy cache populates.
    const transport = new StreamableHTTPClientTransport(
      new URL(`${h.baseUrl}/mcp/memory`),
      {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      },
    );
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(transport);
    await client.callTool({ name: "ping", arguments: {} });
    await client.close().catch(() => undefined);

    // Unbind the token. The disposer registered by the route should
    // have torn down the transport. Subsequent requests with the same
    // token return 404 ("unknown mcp token").
    await h.tokenRegistry.unbind(token);
    const r = await fetch(`${h.baseUrl}/mcp/memory`, {
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
    expect(r.status).toBe(404);
    await h.app.close().catch(() => undefined);
  });
});
