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

describe("recall_tool_calls — missing both filters rejected", () => {
  let h: Harness | null = null;
  let client: Client | null = null;
  const token = "no-filters-token";

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

  it("rejects when neither tool_name nor file_path is provided", async () => {
    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: {},
    });
    expect(r.isError).toBe(true);
    const content = r.content as Array<{ text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]!.text).toContain("at least one of");
  });

  it("rejects when both are empty strings", async () => {
    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "", file_path: "" },
    });
    expect(r.isError).toBe(true);
  });
});

describe("recall_tool_calls — tool_name filter", () => {
  let h: Harness | null = null;
  let session: Session;
  let client: Client | null = null;
  const token = "tool-name-token";

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
            sessionUpdate: "tool_call",
            name: "Bash",
            rawInput: { command: "ls -la" },
            status: "succeeded",
          },
        },
        recordedAt: 1000,
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Read",
            rawInput: { path: "src/foo.ts" },
            status: "succeeded",
          },
        },
        recordedAt: 1001,
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Bash",
            rawInput: { command: "grep hello *.ts" },
            status: "succeeded",
          },
        },
        recordedAt: 1002,
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Edit",
            rawInput: { file_path: "src/bar.ts", old_string: "a", new_string: "b" },
            status: "succeeded",
          },
        },
        recordedAt: 1003,
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

  it("returns only Bash tool calls when tool_name is 'Bash'", async () => {
    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Bash" },
    });
    const sc = r.structuredContent as {
      calls: Array<{ tool: string }>;
      truncated: boolean;
    };
    expect(sc.calls).toHaveLength(2);
    expect(sc.calls[0]!.tool).toBe("Bash");
    expect(sc.calls[1]!.tool).toBe("Bash");
    expect(sc.truncated).toBe(false);
  });

  it("returns only Read tool calls when tool_name is 'Read'", async () => {
    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Read" },
    });
    const sc = r.structuredContent as { calls: Array<{ tool: string }> };
    expect(sc.calls).toHaveLength(1);
    expect(sc.calls[0]!.tool).toBe("Read");
  });

  it("uses case-insensitive matching for tool_name", async () => {
    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "bash" },
    });
    const sc = r.structuredContent as { calls: Array<{ tool: string }> };
    expect(sc.calls).toHaveLength(2);
  });

  it("returns empty when tool_name matches nothing", async () => {
    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Write" },
    });
    const sc = r.structuredContent as { calls: unknown[]; truncated: boolean };
    expect(sc.calls).toHaveLength(0);
    expect(sc.truncated).toBe(false);
  });

  it("includes status from the tool_call entry", async () => {
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Bash",
            rawInput: { command: "exit 1" },
            status: "failed",
          },
        },
        recordedAt: 2000,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Bash" },
    });
    const sc = r.structuredContent as { calls: Array<{ status: string }> };
    expect(sc.calls[0]!.status).toBe("failed");
  });

  it("defaults to in_progress when no status field present", async () => {
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Bash",
            rawInput: { command: "sleep 10" },
          },
        },
        recordedAt: 3000,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Bash" },
    });
    const sc = r.structuredContent as { calls: Array<{ status: string }> };
    expect(sc.calls[0]!.status).toBe("in_progress");
  });

  it("includes timestamp from recordedAt", async () => {
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Bash",
            rawInput: { command: "ls" },
            status: "succeeded",
          },
        },
        recordedAt: 1700000000000,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Bash" },
    });
    const sc = r.structuredContent as { calls: Array<{ timestamp?: string }> };
    expect(sc.calls[0]!.timestamp).toBe("1700000000000");
  });

  it("excludes non-tool_call entries", async () => {
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "prompt_received",
            prompt: "hello world",
          },
        },
        recordedAt: 4000,
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Bash",
            rawInput: { command: "ls" },
            status: "succeeded",
          },
        },
        recordedAt: 4001,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Bash" },
    });
    const sc = r.structuredContent as { calls: Array<{ entryId: number }> };
    expect(sc.calls).toHaveLength(1);
    expect(sc.calls[0]!.entryId).toBe(1);
  });

  it("uses title field when name is absent", async () => {
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            title: "Edit",
            rawInput: { file_path: "src/a.ts" },
            status: "succeeded",
          },
        },
        recordedAt: 5000,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Edit" },
    });
    const sc = r.structuredContent as { calls: Array<{ tool: string }> };
    expect(sc.calls).toHaveLength(1);
    expect(sc.calls[0]!.tool).toBe("Edit");
  });
});

describe("recall_tool_calls — file_path filter", () => {
  let h: Harness | null = null;
  let session: Session;
  let client: Client | null = null;
  const token = "file-path-token";

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
            sessionUpdate: "tool_call",
            name: "Read",
            rawInput: { path: "src/foo.ts" },
            status: "succeeded",
          },
        },
        recordedAt: 1000,
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Edit",
            rawInput: { file_path: "src/bar.ts", old_string: "a", new_string: "b" },
            status: "succeeded",
          },
        },
        recordedAt: 1001,
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Write",
            rawInput: { file_path: "src/foo.ts", content: "hello" },
            status: "succeeded",
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

  it("returns tool calls that touched src/foo.ts", async () => {
    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { file_path: "src/foo.ts" },
    });
    const sc = r.structuredContent as { calls: Array<{ tool: string }> };
    expect(sc.calls).toHaveLength(2);
    expect(sc.calls[0]!.tool).toBe("Read");
    expect(sc.calls[1]!.tool).toBe("Write");
  });

  it("returns only Edit for src/bar.ts", async () => {
    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { file_path: "src/bar.ts" },
    });
    const sc = r.structuredContent as { calls: Array<{ tool: string }> };
    expect(sc.calls).toHaveLength(1);
    expect(sc.calls[0]!.tool).toBe("Edit");
  });

  it("does not match when file_path is absent from all entries", async () => {
    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { file_path: "src/missing.ts" },
    });
    const sc = r.structuredContent as { calls: unknown[]; truncated: boolean };
    expect(sc.calls).toHaveLength(0);
    expect(sc.truncated).toBe(false);
  });

  it("is case-insensitive for file_path matching", async () => {
    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { file_path: "src/FOO.TS" },
    });
    const sc = r.structuredContent as { calls: Array<{ tool: string }> };
    expect(sc.calls).toHaveLength(2);
  });

  it("does not match against non-path fields like command", async () => {
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Bash",
            rawInput: { command: "cat src/foo.ts" },
            status: "succeeded",
          },
        },
        recordedAt: 2000,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { file_path: "src/foo.ts" },
    });
    const sc = r.structuredContent as { calls: unknown[] };
    expect(sc.calls).toHaveLength(0);
  });

  it("does not match partial paths", async () => {
    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { file_path: "src/ba" },
    });
    const sc = r.structuredContent as { calls: unknown[] };
    expect(sc.calls).toHaveLength(0);
  });

  it("excludes non-tool_call entries even with a matching path in prompt", async () => {
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "prompt_received",
            prompt: "please edit src/foo.ts",
          },
        },
        recordedAt: 3000,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { file_path: "src/foo.ts" },
    });
    const sc = r.structuredContent as { calls: unknown[] };
    expect(sc.calls).toHaveLength(0);
  });
});

describe("recall_tool_calls — both filters combined", () => {
  let h: Harness | null = null;
  let session: Session;
  let client: Client | null = null;
  const token = "both-filters-token";

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
            sessionUpdate: "tool_call",
            name: "Read",
            rawInput: { path: "src/foo.ts" },
            status: "succeeded",
          },
        },
        recordedAt: 1000,
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Edit",
            rawInput: { file_path: "src/foo.ts", old_string: "a", new_string: "b" },
            status: "succeeded",
          },
        },
        recordedAt: 1001,
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Edit",
            rawInput: { file_path: "src/bar.ts", old_string: "x", new_string: "y" },
            status: "failed",
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

  it("matches only Edit calls on src/foo.ts when both filters applied", async () => {
    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Edit", file_path: "src/foo.ts" },
    });
    const sc = r.structuredContent as { calls: Array<{ tool: string }> };
    expect(sc.calls).toHaveLength(1);
    expect(sc.calls[0]!.tool).toBe("Edit");
  });

  it("matches nothing when filters are incompatible", async () => {
    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Read", file_path: "src/bar.ts" },
    });
    const sc = r.structuredContent as { calls: unknown[]; truncated: boolean };
    expect(sc.calls).toHaveLength(0);
    expect(sc.truncated).toBe(false);
  });

  it("matches Edit on src/foo.ts with status included", async () => {
    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Edit", file_path: "src/foo.ts" },
    });
    const sc = r.structuredContent as { calls: Array<{ status: string }> };
    expect(sc.calls[0]!.status).toBe("succeeded");
  });

  it("matches Edit on src/bar.ts with failed status", async () => {
    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Edit", file_path: "src/bar.ts" },
    });
    const sc = r.structuredContent as { calls: Array<{ status: string }> };
    expect(sc.calls[0]!.status).toBe("failed");
  });
});

describe("recall_tool_calls — args and truncation", () => {
  let h: Harness | null = null;
  let session: Session;
  let client: Client | null = null;
  const token = "args-token";

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
            sessionUpdate: "tool_call",
            name: "Read",
            rawInput: { path: "src/foo.ts" },
            status: "succeeded",
          },
        },
        recordedAt: 1000,
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Edit",
            rawInput: { file_path: "src/bar.ts", old_string: "a", new_string: "b" },
            status: "succeeded",
          },
        },
        recordedAt: 1001,
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

  it("includes short string args in the response", async () => {
    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Read" },
    });
    const sc = r.structuredContent as { calls: Array<{ args: Record<string, unknown> }> };
    expect(sc.calls[0]!.args).toHaveProperty("path", "src/foo.ts");
  });

  it("includes number and boolean args", async () => {
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Grep",
            rawInput: { pattern: "hello", max_matches: 10, case_insensitive: true },
            status: "succeeded",
          },
        },
        recordedAt: 2000,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Grep" },
    });
    const sc = r.structuredContent as { calls: Array<{ args: Record<string, unknown> }> };
    expect(sc.calls[0]!.args).toHaveProperty("pattern", "hello");
    expect(sc.calls[0]!.args).toHaveProperty("max_matches", 10);
    expect(sc.calls[0]!.args).toHaveProperty("case_insensitive", true);
  });

  it("truncates long string args at 500 chars", async () => {
    const longContent = "x".repeat(600);
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Write",
            rawInput: { file_path: "src/big.ts", content: longContent },
            status: "succeeded",
          },
        },
        recordedAt: 3000,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Write" },
    });
    const sc = r.structuredContent as { calls: Array<{ args: Record<string, unknown> }> };
    const content = sc.calls[0]!.args["content"] as string;
    expect(content.length).toBe(498);
    expect(content.endsWith("\u2026")).toBe(true);
  });

  it("excludes non-primitive arg values (objects, arrays)", async () => {
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Edit",
            rawInput: { file_path: "src/a.ts", diff: { type: "diff" } },
            status: "succeeded",
          },
        },
        recordedAt: 4000,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Edit" },
    });
    const sc = r.structuredContent as { calls: Array<{ args: Record<string, unknown> }> };
    expect(sc.calls[0]!.args).toHaveProperty("file_path", "src/a.ts");
    expect(sc.calls[0]!.args).not.toHaveProperty("diff");
  });

  it("honors the limit parameter", async () => {
    const entries: HistoryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Read",
            rawInput: { path: `src/file${i}.ts` },
            status: "succeeded",
          },
        },
        recordedAt: 1000 + i,
      });
    }
    populateHistory(session, entries);

    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Read", limit: 3 },
    });
    const sc = r.structuredContent as { calls: unknown[]; truncated: boolean };
    expect(sc.calls).toHaveLength(3);
    expect(sc.truncated).toBe(true);
  });

  it("uses default limit of 20 when not specified", async () => {
    const entries: HistoryEntry[] = [];
    for (let i = 0; i < 30; i++) {
      entries.push({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Read",
            rawInput: { path: `src/file${i}.ts` },
            status: "succeeded",
          },
        },
        recordedAt: 1000 + i,
      });
    }
    populateHistory(session, entries);

    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Read" },
    });
    const sc = r.structuredContent as { calls: unknown[]; truncated: boolean };
    expect(sc.calls).toHaveLength(20);
    expect(sc.truncated).toBe(true);
  });

  it("rejects limit > 100", async () => {
    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Read", limit: 101 },
    });
    expect(r.isError).toBe(true);
  });

  it("rejects limit < 1", async () => {
    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Read", limit: 0 },
    });
    expect(r.isError).toBe(true);
  });

  it("returns truncated=false when results fit within limit", async () => {
    const entries: HistoryEntry[] = [];
    for (let i = 0; i < 5; i++) {
      entries.push({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Read",
            rawInput: { path: `src/file${i}.ts` },
            status: "succeeded",
          },
        },
        recordedAt: 1000 + i,
      });
    }
    populateHistory(session, entries);

    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Read", limit: 20 },
    });
    const sc = r.structuredContent as { calls: unknown[]; truncated: boolean };
    expect(sc.calls).toHaveLength(5);
    expect(sc.truncated).toBe(false);
  });

  it("skips non-session/update entries in iteration", async () => {
    populateHistory(session, [
      {
        method: "notification",
        params: { type: "session_info" },
        recordedAt: 6000,
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Read",
            rawInput: { path: "src/foo.ts" },
            status: "succeeded",
          },
        },
        recordedAt: 6001,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Read" },
    });
    const sc = r.structuredContent as { calls: Array<{ entryId: number }> };
    expect(sc.calls[0]!.entryId).toBe(1);
  });

  it("does not include full tool result body — only status and short args", async () => {
    populateHistory(session, [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Bash",
            rawInput: { command: "ls -la" },
            status: "succeeded",
            rawOutput: { output: "a huge block of stdout that should not appear here" },
          },
        },
        recordedAt: 7000,
      },
    ]);

    const r = await client!.callTool({
      name: "recall_tool_calls",
      arguments: { tool_name: "Bash" },
    });
    const sc = r.structuredContent as { calls: Array<{ args: Record<string, unknown>; status: string }> };
    expect(sc.calls[0]!.status).toBe("succeeded");
    expect(sc.calls[0]!.args).not.toHaveProperty("rawOutput");
  });
});
