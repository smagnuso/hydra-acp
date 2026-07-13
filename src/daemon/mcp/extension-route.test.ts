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
  notifyToolListChanged: (sessionId: string, extName: string) => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const tokenRegistry = new McpTokenRegistry();
  const extensionMcp = new ExtensionMcpRegistry();
  const app = Fastify({ logger: false });
  // Register stdin too — verifies that /mcp/hydra-acp-stdin still wins the route
  // race against /mcp/:name.
  registerStdinMcpRoutes(app, tokenRegistry);
  const controls = registerExtensionMcpRoutes(app, tokenRegistry, extensionMcp);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address() as AddressInfo;
  return {
    app,
    tokenRegistry,
    extensionMcp,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    notifyToolListChanged: controls.notifyToolListChanged,
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
    expect(mock.calls[0]!.params).toMatchObject({
      server: "memory",
      tool: "ping",
      args: { x: 1 },
      sessionId: expect.any(String),
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

describe("extension MCP route — reservation pending (deadlock regression)", () => {
  // Regression for the planner-MCP deadlock: agent's session/new
  // initializes MCP servers against /mcp/<name> BEFORE the daemon's
  // session/new completes — i.e. while the token reservation is still
  // pending (entry.session === undefined). The route must allow
  // initialize / tools/list through immediately; only tools/call
  // needs the sessionId and may await sessionReady.
  let h: Harness | null = null;
  const token = "tok-pending";
  let reservation: { complete: (s: Session) => void; abandon: (e?: Error) => void };
  let mock: MockConnection;

  beforeEach(async () => {
    h = await makeHarness();
    reservation = h.tokenRegistry.reserve(token);
    mock = makeMockConnection();
    mock.setResponder(async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    h.extensionMcp.register("memory", mock.conn, undefined, [pingTool()]);
  });

  afterEach(async () => {
    if (h) {
      // Tests own whether they completed or abandoned the reservation;
      // abandon() here is a no-op if it already completed.
      try {
        reservation.abandon();
      } catch {
        // intentional
      }
      await h.app.close().catch(() => undefined);
      h = null;
    }
  });

  it("tools/list completes while the token reservation is still pending", async () => {
    // The reservation is pending — entry.session is undefined and
    // sessionReady will never resolve until complete() runs.
    // With the old behavior this would 503 after 10s.
    const transport = new StreamableHTTPClientTransport(
      new URL(`${h!.baseUrl}/mcp/memory`),
      {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      },
    );
    const client = new Client({ name: "test", version: "0.0.1" });
    const start = Date.now();
    await client.connect(transport);
    const r = await client.listTools();
    const elapsed = Date.now() - start;
    expect(r.tools.map((t) => t.name)).toEqual(["ping"]);
    // Must not have waited on the (never-resolving) sessionReady.
    expect(elapsed).toBeLessThan(2000);
    await client.close().catch(() => undefined);
  });

  it("tools/call awaits sessionReady and forwards the sessionId once the reservation completes", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${h!.baseUrl}/mcp/memory`),
      {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      },
    );
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(transport);

    // Complete the reservation a beat after issuing the call so the
    // resolver actually has to await. Without the fix this race would
    // be irrelevant — the deadlock blocked at connect-time.
    const session = makeSession();
    const callP = client.callTool({ name: "ping", arguments: { x: 1 } });
    setTimeout(() => reservation.complete(session), 25);
    const r = await callP;
    const content = r.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toBe("ok");
    expect(mock.calls[0]!.params).toMatchObject({
      server: "memory",
      tool: "ping",
      args: { x: 1 },
      sessionId: session.sessionId,
    });
    await client.close().catch(() => undefined);
  });
});

describe("extension MCP route — per-session dynamic tools + eviction", () => {
  // Covers the activate-then-refresh pattern: extension registers a
  // small "gateway" spec at boot; per-session state controls whether
  // ListTools returns the gateway or a larger spec; a targeted
  // eviction forces one session's agent to reconnect and re-list
  // without disturbing other sessions.
  let h: Harness | null = null;
  let mock: MockConnection;

  const gateway = [
    { name: "activate", description: "unlock", inputSchema: { type: "object" } },
  ];
  const full = [
    { name: "activate", description: "unlock", inputSchema: { type: "object" } },
    { name: "do_thing", description: "thing", inputSchema: { type: "object" } },
  ];

  // Extension serves `full` for sessions in `activated`, else `gateway`.
  // Modeled after the planner's list_tools handler.
  let activated: Set<string>;

  beforeEach(async () => {
    h = await makeHarness();
    mock = makeMockConnection();
    activated = new Set<string>();
    mock.setResponder(async (method, params) => {
      if (method === "hydra-acp/mcp_tools/list_tools") {
        const sid = (params as { sessionId?: string }).sessionId ?? "";
        return { tools: activated.has(sid) ? full : gateway };
      }
      if (method === "hydra-acp/mcp_tools/invoke") {
        return { content: [{ type: "text", text: "ok" }] };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    h.extensionMcp.register("planner", mock.conn, undefined, gateway);
  });

  afterEach(async () => {
    if (h) {
      await h.app.close().catch(() => undefined);
      h = null;
    }
  });

  async function openMcp(token: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${h!.baseUrl}/mcp/planner`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(transport);
    return client;
  }

  it("returns the gateway spec by default (session not activated)", async () => {
    const token = "tok-A";
    h!.tokenRegistry.bind(token, makeSession());
    const client = await openMcp(token);
    const r = await client.listTools();
    expect(r.tools.map((t) => t.name)).toEqual(["activate"]);
    await client.close().catch(() => undefined);
  });

  it("returns the full spec once the session is marked activated", async () => {
    const token = "tok-B";
    const session = makeSession();
    h!.tokenRegistry.bind(token, session);
    activated.add(session.sessionId);
    const client = await openMcp(token);
    const r = await client.listTools();
    expect(r.tools.map((t) => t.name)).toEqual(["activate", "do_thing"]);
    await client.close().catch(() => undefined);
  });

  it("notifyToolListChanged causes the SAME client to see the fresh per-session spec on next list", async () => {
    // Session opens on gateway. We mark it activated in the
    // extension, then notify. The SAME client — on the SAME
    // transport, no reconnect — must see the full spec on its next
    // listTools() call. This is the whole point of using
    // notifications instead of transport reset: the client's
    // in-flight state (including any pending tool call) stays intact.
    const token = "tok-C";
    const session = makeSession();
    h!.tokenRegistry.bind(token, session);

    const client = await openMcp(token);
    const r1 = await client.listTools();
    expect(r1.tools.map((t) => t.name)).toEqual(["activate"]);

    // Extension marks session activated + asks daemon to notify.
    activated.add(session.sessionId);
    await h!.notifyToolListChanged(session.sessionId, "planner");

    // Same client, same transport — the dynamic ListTools handler
    // now sees the session in `activated` and returns the full spec.
    const r2 = await client.listTools();
    expect(r2.tools.map((t) => t.name)).toEqual(["activate", "do_thing"]);
    await client.close().catch(() => undefined);
  });

  it("notifyToolListChanged isolates to the target session — others don't see the change", async () => {
    // Notifying session A must NOT affect session B: B's ListTools
    // response continues to reflect B's own per-session state.
    const tokenA = "tok-iso-A";
    const tokenB = "tok-iso-B";
    const sessA = makeSession();
    const sessB = makeSession();
    h!.tokenRegistry.bind(tokenA, sessA);
    h!.tokenRegistry.bind(tokenB, sessB);

    const clientA = await openMcp(tokenA);
    const clientB = await openMcp(tokenB);
    expect((await clientA.listTools()).tools.map((t) => t.name)).toEqual(["activate"]);
    expect((await clientB.listTools()).tools.map((t) => t.name)).toEqual(["activate"]);

    // Activate only A; notify only A.
    activated.add(sessA.sessionId);
    await h!.notifyToolListChanged(sessA.sessionId, "planner");

    // A now sees the full spec — its ListTools handler returns the
    // updated per-session view.
    expect((await clientA.listTools()).tools.map((t) => t.name)).toEqual([
      "activate",
      "do_thing",
    ]);
    // B is unchanged — still on gateway. Same transport, same
    // client, no disruption from A's notification.
    expect((await clientB.listTools()).tools.map((t) => t.name)).toEqual(["activate"]);

    await clientA.close().catch(() => undefined);
    await clientB.close().catch(() => undefined);
  });

  it("notifyToolListChanged is a no-op when no matching transport exists", async () => {
    // Never opens a client for the sessionId. Notification should
    // silently do nothing (resolve to undefined) rather than throw.
    await expect(
      h!.notifyToolListChanged("hydra_session_nonexistent", "planner"),
    ).resolves.toBeUndefined();
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
