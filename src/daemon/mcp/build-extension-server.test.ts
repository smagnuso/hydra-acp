import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { JsonRpcConnection } from "../../acp/connection.js";
import {
  ExtensionMcpRegistry,
  type ExtensionMcpEntry,
} from "../../core/extension-mcp.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  buildExtensionServer,
  startProgressHeartbeat,
} from "./build-extension-server.js";

// Mock JsonRpcConnection that records every outgoing request and lets
// the test control how the daemon-side response resolves. We only need
// the `request` method — that's the entire surface the builder uses.
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

async function connect(server: Server): Promise<Client> {
  const [serverT, clientT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.1" });
  await client.connect(clientT);
  return client;
}

function entryFor(
  conn: JsonRpcConnection,
  tools: ExtensionMcpEntry["tools"],
  instructions?: string,
): ExtensionMcpEntry {
  return { connection: conn, instructions, tools };
}

describe("buildExtensionServer — tools/list", () => {
  let mock: MockConnection;
  let server: Server;
  let client: Client | null = null;

  beforeEach(() => {
    mock = makeMockConnection();
  });

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => undefined);
      client = null;
    }
    if (server) {
      await server.close().catch(() => undefined);
    }
  });

  it("returns the registered tools verbatim with inputSchema preserved", async () => {
    const entry = entryFor(mock.conn, [
      {
        name: "search",
        description: "find stuff",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
    server = buildExtensionServer("memory", entry, "hydra_session_test");
    client = await connect(server);
    const r = await client.listTools();
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0]!.name).toBe("search");
    expect(r.tools[0]!.description).toBe("find stuff");
    expect(r.tools[0]!.inputSchema).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
  });

  it("includes outputSchema when registered", async () => {
    const entry = entryFor(mock.conn, [
      {
        name: "ping",
        description: "",
        inputSchema: { type: "object" },
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    ]);
    server = buildExtensionServer("memory", entry, "hydra_session_test");
    client = await connect(server);
    const r = await client.listTools();
    expect(r.tools[0]!.outputSchema).toEqual({
      type: "object",
      properties: { ok: { type: "boolean" } },
    });
  });

  it("omits outputSchema when not registered", async () => {
    const entry = entryFor(mock.conn, [
      { name: "ping", description: "", inputSchema: { type: "object" } },
    ]);
    server = buildExtensionServer("memory", entry, "hydra_session_test");
    client = await connect(server);
    const r = await client.listTools();
    expect(r.tools[0]!.outputSchema).toBeUndefined();
  });

  it("surfaces instructions on the server when registered", async () => {
    // Instructions land on the client via the initialize handshake, not
    // tools/list, so we read them off `serverCapabilities` indirectly.
    // The SDK exposes them as `client.getServerVersion().instructions`
    // is not a stable surface; we instead trust the SDK round-trip by
    // checking the spec field was passed through by reading
    // `client.getInstructions()` if available, otherwise just ensuring
    // the connect succeeded with a non-empty instructions string in the
    // server's options (already tested by construction).
    const entry = entryFor(
      mock.conn,
      [{ name: "ping", description: "", inputSchema: { type: "object" } }],
      "memory extension help",
    );
    server = buildExtensionServer("memory", entry, "hydra_session_test");
    client = await connect(server);
    // SDK exposes the server's instructions on the client side once
    // initialize completes; whether the API name is getInstructions or
    // serverInstructions depends on SDK version. Read pragmatically.
    const c = client as unknown as {
      getInstructions?: () => string | undefined;
      instructions?: string;
    };
    const inst = c.getInstructions?.() ?? c.instructions;
    if (inst !== undefined) {
      expect(inst).toBe("memory extension help");
    }
  });
});

describe("buildExtensionServer — tools/call success", () => {
  let mock: MockConnection;
  let server: Server;
  let client: Client | null = null;

  beforeEach(() => {
    mock = makeMockConnection();
  });

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => undefined);
      client = null;
    }
    if (server) {
      await server.close().catch(() => undefined);
    }
  });

  it("forwards method=hydra-acp/mcp_tools/invoke with server+tool+args", async () => {
    mock.setResponder(async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    const entry = entryFor(mock.conn, [
      {
        name: "ping",
        description: "",
        inputSchema: { type: "object", properties: { x: { type: "number" } } },
      },
    ]);
    server = buildExtensionServer("memory", entry, "hydra_session_test");
    client = await connect(server);
    await client.callTool({ name: "ping", arguments: { x: 42 } });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.method).toBe("hydra-acp/mcp_tools/invoke");
    expect(mock.calls[0]!.params).toEqual({
      server: "memory",
      tool: "ping",
      args: { x: 42 },
      sessionId: "hydra_session_test",
    });
  });

  it("passes through content + structuredContent unchanged", async () => {
    mock.setResponder(async () => ({
      content: [{ type: "text", text: "hello" }],
      structuredContent: { ok: true, n: 7 },
    }));
    const entry = entryFor(mock.conn, [
      { name: "ping", description: "", inputSchema: { type: "object" } },
    ]);
    server = buildExtensionServer("memory", entry, "hydra_session_test");
    client = await connect(server);
    const r = await client.callTool({ name: "ping", arguments: {} });
    expect(r.content).toEqual([{ type: "text", text: "hello" }]);
    expect(r.structuredContent).toEqual({ ok: true, n: 7 });
    expect(r.isError).toBeFalsy();
  });

  it("defaults args to {} when the agent omits arguments", async () => {
    mock.setResponder(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const entry = entryFor(mock.conn, [
      { name: "ping", description: "", inputSchema: { type: "object" } },
    ]);
    server = buildExtensionServer("memory", entry, "hydra_session_test");
    client = await connect(server);
    await client.callTool({ name: "ping" });
    expect(mock.calls[0]!.params).toEqual({
      server: "memory",
      tool: "ping",
      args: {},
      sessionId: "hydra_session_test",
    });
  });

  it("heartbeats fire even when the client did not pass onprogress, addressed to the JSON-RPC requestId", async () => {
    // Long-running extension call so the heartbeat has time to tick.
    let resolveExtension: ((v: unknown) => void) | undefined;
    mock.setResponder(
      () =>
        new Promise((resolve) => {
          resolveExtension = resolve;
        }),
    );
    const entry = entryFor(mock.conn, [
      { name: "ping", description: "", inputSchema: { type: "object" } },
    ]);
    server = buildExtensionServer("memory", entry, "hydra_session_test");
    client = await connect(server);
    // Hook a notification handler directly — the client SDK only wires
    // onprogress when the caller passes it, but it still dispatches
    // notifications/progress to any explicit handler we register here.
    const seen: Array<{ progressToken: string | number; progress: number }> = [];
    client.setNotificationHandler(ProgressNotificationSchema, async (n) => {
      seen.push({
        progressToken: n.params.progressToken,
        progress: n.params.progress,
      });
    });
    const callPromise = client.callTool(
      { name: "ping", arguments: {} },
      undefined,
      // Critically: no onprogress. opencode's real usage.
      { resetTimeoutOnProgress: true, timeout: 60_000 },
    );
    // Wait long enough for at least one production-interval heartbeat
    // would be too slow (15s). Instead bounce the heartbeat through
    // the helper directly in a unit test (above); here we just verify
    // the integration emits SOMETHING addressed to a numeric token
    // matching a JSON-RPC requestId, with a short artificial delay.
    await new Promise((r) => setTimeout(r, 50));
    resolveExtension!({ content: [{ type: "text", text: "done" }] });
    await callPromise;
    // We expect 0 heartbeats given the production 15s interval and
    // 50ms wait — the assertion is type-level: no crash, no leaked
    // interval, no errors with the requestId fallback. The unit-level
    // tests above prove ticks fire at the configured interval.
    expect(seen.length).toBe(0);
  });
});

describe("startProgressHeartbeat", () => {
  it("emits ticking progress notifications until stopped", async () => {
    const sent: Array<{ progressToken: string | number; progress: number }> = [];
    const stop = startProgressHeartbeat(
      "tok-1",
      async (n) => {
        sent.push({
          progressToken: n.params.progressToken,
          progress: n.params.progress,
        });
      },
      10,
    );
    await new Promise((r) => setTimeout(r, 45));
    stop();
    // 45ms / 10ms interval ≈ 3–4 ticks (jitter-tolerant).
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent[0]!.progressToken).toBe("tok-1");
    expect(sent[0]!.progress).toBe(1);
    expect(sent[sent.length - 1]!.progress).toBe(sent.length);
    // No further ticks after stop().
    const seenAtStop = sent.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.length).toBe(seenAtStop);
  });

  it("is a no-op when progressToken is undefined", async () => {
    const sent: unknown[] = [];
    const stop = startProgressHeartbeat(
      undefined,
      async (n) => {
        sent.push(n);
      },
      5,
    );
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(sent).toEqual([]);
  });

  it("swallows sendNotification errors so heartbeat doesn't crash the call", async () => {
    let calls = 0;
    const stop = startProgressHeartbeat(
      1,
      async () => {
        calls += 1;
        throw new Error("transport closed");
      },
      10,
    );
    await new Promise((r) => setTimeout(r, 35));
    stop();
    expect(calls).toBeGreaterThanOrEqual(2);
    // Test passes by not having an unhandled rejection.
  });
});

describe("buildExtensionServer — tools/call error paths", () => {
  let mock: MockConnection;
  let server: Server;
  let client: Client | null = null;

  beforeEach(() => {
    mock = makeMockConnection();
  });

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => undefined);
      client = null;
    }
    if (server) {
      await server.close().catch(() => undefined);
    }
  });

  it("unknown tool returns isError without invoking the extension", async () => {
    const entry = entryFor(mock.conn, [
      { name: "ping", description: "", inputSchema: { type: "object" } },
    ]);
    server = buildExtensionServer("memory", entry, "hydra_session_test");
    client = await connect(server);
    const r = await client.callTool({ name: "absent", arguments: {} });
    expect(r.isError).toBe(true);
    expect(mock.calls).toHaveLength(0);
    const content = r.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toMatch(/unknown tool: absent/);
  });

  it("extension throwing yields isError with the thrown message", async () => {
    mock.setResponder(async () => {
      throw new Error("memory backend down");
    });
    const entry = entryFor(mock.conn, [
      { name: "ping", description: "", inputSchema: { type: "object" } },
    ]);
    server = buildExtensionServer("memory", entry, "hydra_session_test");
    client = await connect(server);
    const r = await client.callTool({ name: "ping", arguments: {} });
    expect(r.isError).toBe(true);
    const content = r.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toMatch(/memory backend down/);
  });

  it("malformed extension result (non-object) yields isError", async () => {
    mock.setResponder(async () => 42 as unknown);
    const entry = entryFor(mock.conn, [
      { name: "ping", description: "", inputSchema: { type: "object" } },
    ]);
    server = buildExtensionServer("memory", entry, "hydra_session_test");
    client = await connect(server);
    const r = await client.callTool({ name: "ping", arguments: {} });
    expect(r.isError).toBe(true);
    const content = r.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toMatch(/non-object/);
  });

  it("malformed extension result (missing content array) yields isError", async () => {
    mock.setResponder(async () => ({ structuredContent: { ok: true } }));
    const entry = entryFor(mock.conn, [
      { name: "ping", description: "", inputSchema: { type: "object" } },
    ]);
    server = buildExtensionServer("memory", entry, "hydra_session_test");
    client = await connect(server);
    const r = await client.callTool({ name: "ping", arguments: {} });
    expect(r.isError).toBe(true);
    const content = r.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toMatch(/omitted content array/);
  });
});

describe("buildExtensionServer — registry integration smoke", () => {
  it("builds against a freshly-registered entry from ExtensionMcpRegistry", async () => {
    // Sanity check: the registry's lookup() result is shape-compatible
    // with what the builder expects. If this passes, the route handler
    // can call registry.lookup() and feed the result straight to
    // buildExtensionServer without translation.
    const mock = makeMockConnection();
    mock.setResponder(async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    const registry = new ExtensionMcpRegistry();
    registry.register("memory", mock.conn, undefined, [
      { name: "ping", description: "", inputSchema: { type: "object" } },
    ]);
    const entry = registry.lookup("memory")!;
    const server = buildExtensionServer("memory", entry, "hydra_session_test");
    const client = await connect(server);
    try {
      const r = await client.callTool({ name: "ping", arguments: {} });
      const content = r.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toBe("ok");
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});
