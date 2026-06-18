import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { startDaemon, type DaemonHandle } from "./server.js";
import type { HydraConfig } from "../core/config.js";

const TEST_TOKEN = "hydra_token_0123456789abcdef0123456789abcdef";

function testConfig(): HydraConfig {
  return {
    daemon: {
      host: "127.0.0.1",
      port: 0,
      logLevel: "warn",
      sessionIdleTimeoutSeconds: 30,
      sessionHistoryMaxEntries: 1000,
      agentStderrTailBytes: 4096,
      agentSyncIntervalMinutes: 0,
      sessionGcIntervalMinutes: 0,
      sessionGcMaxAgeDays: 2,
    },
    registry: {
      url: "http://127.0.0.1:65535/never-reached",
      ttlHours: 24,
      pinned: false,
    },
    defaultAgent: "claude-acp",
    defaultModels: {},
    defaultCwd: os.homedir(),
    compressToolContent: true,
    sessionListColdLimit: 20,
    agents: {},
    agentOverrides: {},
    extensions: {},
    transformers: {},
    defaultTransformers: [],
    tui: {
      repaintThrottleMs: 1000,
      maxScrollbackLines: 10_000,
      mouse: false,
      logMaxBytes: 5 * 1024 * 1024,
      cwdColumnMaxWidth: 24,
      progressIndicator: true,
      defaultEnterAction: "amend" as const,
      showThoughts: true,
      ambiguousWidth: "narrow",
      toolContent: "inline",
      diffContextLines: 3,
      promptHistoryMaxEntries: 2_000,
      maxToolItems: 5,
      maxPlanItems: 5,
      showFileUpdates: "none" as const,
      selectionClipboard: "both" as const,
    },
    compaction: {
      tailK: 0,
      maxIterations: 1,
      contextFraction: 0.5,
      hardCeilingFraction: 0.85,
      absoluteFallback: 120_000,
      idleBeforePromptMs: 300_000,
      modelContextWindows: {},
    },
  };
}

function port(handle: DaemonHandle): number {
  const addr = handle.app.server.address() as AddressInfo | string | null;
  if (!addr || typeof addr === "string") {
    throw new Error("server has no bound port");
  }
  return addr.port;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

// Open a WS subprotocol-authenticated connection on behalf of an
// extension named `name`, complete initialize, then return the open
// socket + a small helper that round-trips a JSON-RPC request.
async function openExtensionWs(
  wsUrl: string,
  handle: DaemonHandle,
  name: string,
): Promise<{
  ws: WebSocket;
  request: (method: string, params: unknown) => Promise<JsonRpcResponse>;
}> {
  const extToken = handle.processRegistry.mint(name, "extension");
  const ws = new WebSocket(wsUrl, [
    "acp.v1",
    `hydra-acp-token.${extToken}`,
  ]);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  let nextId = 1;
  const inflight = new Map<number, (msg: JsonRpcResponse) => void>();
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString("utf8")) as JsonRpcResponse;
    if (typeof msg.id === "number") {
      const resolver = inflight.get(msg.id);
      if (resolver !== undefined) {
        inflight.delete(msg.id);
        resolver(msg);
      }
    }
  });

  const request = (
    method: string,
    params: unknown,
  ): Promise<JsonRpcResponse> => {
    const id = nextId++;
    return new Promise((resolve) => {
      inflight.set(id, resolve);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  };

  // initialize is required before any other handler is exposed; the
  // process kind is also recorded here.
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name, version: "0.0.1" },
  });
  if (init.error !== undefined) {
    throw new Error(`initialize failed: ${init.error.message}`);
  }

  return { ws, request };
}

describe("acp-ws: register_mcp_tools", () => {
  let tmpHome: string;
  let handle: DaemonHandle | null = null;
  let wsUrl: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "hydra-acp-extmcp-test-"),
    );
    process.env.HYDRA_ACP_HOME = tmpHome;
    handle = await startDaemon(testConfig(), TEST_TOKEN);
    wsUrl = `ws://127.0.0.1:${port(handle)}/acp`;
  });

  afterEach(async () => {
    if (handle) {
      await handle.shutdown().catch(() => undefined);
      handle = null;
    }
    await fs.rm(tmpHome, { recursive: true, force: true }).catch(
      () => undefined,
    );
  });

  it("populates extensionMcp with a successful registration", async () => {
    const { ws, request } = await openExtensionWs(wsUrl, handle!, "memory");
    try {
      const resp = await request("hydra-acp/mcp_tools/register", {
        instructions: "memory help",
        tools: [
          {
            name: "search",
            description: "find stuff",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
      });
      expect(resp.error).toBeUndefined();
      expect(resp.result).toEqual({ ok: true, registered: 1 });

      const entry = handle!.extensionMcp.lookup("memory");
      expect(entry).toBeDefined();
      expect(entry!.instructions).toBe("memory help");
      expect(entry!.tools.map((t) => t.name)).toEqual(["search"]);
      expect(handle!.extensionMcp.list()).toEqual(["memory"]);
    } finally {
      ws.close();
    }
  });

  it("re-registration overwrites tools and instructions", async () => {
    const { ws, request } = await openExtensionWs(wsUrl, handle!, "memory");
    try {
      await request("hydra-acp/mcp_tools/register", {
        instructions: "v1",
        tools: [
          {
            name: "old",
            description: "",
            inputSchema: { type: "object" },
          },
        ],
      });
      await request("hydra-acp/mcp_tools/register", {
        instructions: "v2",
        tools: [
          {
            name: "new",
            description: "",
            inputSchema: { type: "object" },
          },
        ],
      });
      const entry = handle!.extensionMcp.lookup("memory");
      expect(entry!.instructions).toBe("v2");
      expect(entry!.tools.map((t) => t.name)).toEqual(["new"]);
    } finally {
      ws.close();
    }
  });

  it("rejects payload with an empty tools list", async () => {
    const { ws, request } = await openExtensionWs(wsUrl, handle!, "memory");
    try {
      const resp = await request("hydra-acp/mcp_tools/register", {
        tools: [],
      });
      expect(resp.error).toBeDefined();
      expect(handle!.extensionMcp.lookup("memory")).toBeUndefined();
    } finally {
      ws.close();
    }
  });

  it("rejects tools missing required fields (silently drops them, errors if all dropped)", async () => {
    const { ws, request } = await openExtensionWs(wsUrl, handle!, "memory");
    try {
      // No name → dropped; inputSchema not an object → dropped; nothing
      // valid remains → handler treats as empty list and rejects.
      const resp = await request("hydra-acp/mcp_tools/register", {
        tools: [
          { description: "missing name", inputSchema: { type: "object" } },
          { name: "bad-schema", description: "", inputSchema: "string" },
        ],
      });
      expect(resp.error).toBeDefined();
    } finally {
      ws.close();
    }
  });

  it("optional outputSchema is preserved", async () => {
    const { ws, request } = await openExtensionWs(wsUrl, handle!, "memory");
    try {
      await request("hydra-acp/mcp_tools/register", {
        tools: [
          {
            name: "ping",
            description: "",
            inputSchema: { type: "object" },
            outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
          },
        ],
      });
      const entry = handle!.extensionMcp.lookup("memory");
      expect(entry!.tools[0]!.outputSchema).toEqual({
        type: "object",
        properties: { ok: { type: "boolean" } },
      });
    } finally {
      ws.close();
    }
  });

  it("clearing the registry happens on connection close", async () => {
    const { ws, request } = await openExtensionWs(wsUrl, handle!, "memory");
    await request("hydra-acp/mcp_tools/register", {
      tools: [
        { name: "t", description: "", inputSchema: { type: "object" } },
      ],
    });
    expect(handle!.extensionMcp.lookup("memory")).toBeDefined();
    ws.close();
    // Give the close event a tick to fire the registry clear handler.
    await new Promise((r) => setTimeout(r, 50));
    expect(handle!.extensionMcp.lookup("memory")).toBeUndefined();
  });

  it("two different extensions register under their own names", async () => {
    const a = await openExtensionWs(wsUrl, handle!, "memory");
    const b = await openExtensionWs(wsUrl, handle!, "notifier");
    try {
      await a.request("hydra-acp/mcp_tools/register", {
        tools: [
          { name: "search", description: "", inputSchema: { type: "object" } },
        ],
      });
      await b.request("hydra-acp/mcp_tools/register", {
        tools: [
          { name: "notify", description: "", inputSchema: { type: "object" } },
        ],
      });
      const names = handle!.extensionMcp.list().sort();
      expect(names).toEqual(["memory", "notifier"]);
      expect(handle!.extensionMcp.lookup("memory")!.tools[0]!.name).toBe("search");
      expect(handle!.extensionMcp.lookup("notifier")!.tools[0]!.name).toBe("notify");
    } finally {
      a.ws.close();
      b.ws.close();
    }
  });
});
