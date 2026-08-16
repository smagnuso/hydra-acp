// Recall against the tool-call shapes real agents actually emit.
//
// The arguments of a call do not arrive with the call: agents open a
// `tool_call` with an empty or partial rawInput and fill it in over later
// `tool_call_update` events, while rewriting `title` to the command text
// as they go. Reading the name from the newest event therefore yields the
// command in the name's place, and no tool_name filter can match it, so
// `tool_calls` returned nothing for whole sessions of shell work.
//
// These fixtures are transcribed from stored sessions rather than
// invented, because the differences between agents are the whole point.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Session, type SessionInit } from "../../core/session.js";
import { makeMockAgent } from "../../__tests__/test-utils.js";
import type { HistoryEntry } from "../../core/history-store.js";
import { HistoryStore } from "../../core/history-store.js";
import { McpTokenRegistry } from "./token-registry.js";
import { registerRecallMcpRoutes } from "./recall-server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";

interface CallResult {
  calls: Array<{
    tool: string;
    kind?: string;
    args: Record<string, unknown>;
    output?: string;
    outputBytes?: number;
    outputTruncated?: boolean;
  }>;
  truncated: boolean;
  outputBudgetExhausted?: boolean;
}

interface SearchResult {
  matches: Array<{ entryId: number; speaker: string; snippet: string }>;
  total_matched: number;
}

// claude-acp: generic title, empty opening rawInput, real name out of band
// in _meta, command and output on the updates.
function claudeShell(id: string, command: string, stdout: string): HistoryEntry[] {
  const meta = { claudeCode: { toolName: "Bash" } };
  return [
    {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: id,
          title: "Terminal",
          kind: "execute",
          rawInput: {},
          status: "pending",
          _meta: meta,
        },
      },
      recordedAt: 1000,
    },
    {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          title: command,
          kind: "execute",
          rawInput: { command },
          _meta: meta,
        },
      },
      recordedAt: 1001,
    },
    {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: "completed",
          rawOutput: stdout,
          _meta: { claudeCode: { toolResponse: { stdout, stderr: "" } } },
        },
      },
      recordedAt: 1002,
    },
  ];
}

// opencode: lowercase tool name as the opening title, cwd on the opening
// event, command added by the updates, output under rawOutput.output.
function opencodeShell(id: string, command: string, output: string): HistoryEntry[] {
  return [
    {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: id,
          title: "bash",
          kind: "execute",
          rawInput: { cwd: "/repo" },
          status: "pending",
        },
      },
      recordedAt: 2000,
    },
    {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          title: command,
          kind: "execute",
          rawInput: { command, cwd: "/repo" },
          status: "in_progress",
        },
      },
      recordedAt: 2001,
    },
    {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: "completed",
          rawOutput: { output, metadata: {} },
        },
      },
      recordedAt: 2002,
    },
  ];
}

function makeStreamSession(historyStore: HistoryStore): Session {
  const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
  const init: SessionInit = {
    cwd: "/work",
    agentId: "mock",
    agent: mock.agent,
    upstreamSessionId: "u-test",
    historyStore,
  };
  const session = new Session(init);
  session.openStream({ mode: "memory", capacityBytes: 64 * 1024 });
  session.summarizedThroughEntry = 1;
  return session;
}

describe("recall across agent tool-call shapes", () => {
  let app: FastifyInstance | null = null;
  let client: Client | null = null;
  let session: Session;
  const token = "agent-shapes-token";

  async function seed(entries: HistoryEntry[]): Promise<void> {
    await (
      session as unknown as { historyStore: HistoryStore }
    ).historyStore.rewrite(session.sessionId, entries);
  }

  beforeEach(async () => {
    const registry = new McpTokenRegistry();
    app = Fastify({ logger: false });
    registerRecallMcpRoutes(app, registry);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address() as AddressInfo;
    session = makeStreamSession(new HistoryStore());
    registry.bind(token, session);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${addr.port}/mcp/hydra-acp-recall`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(transport);
  });

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    client = null;
    app = null;
  });

  async function toolCalls(args: Record<string, unknown>): Promise<CallResult> {
    const r = await client!.callTool({ name: "tool_calls", arguments: args });
    return r.structuredContent as CallResult;
  }

  it("finds a claude-acp shell call by its real tool name", async () => {
    await seed(claudeShell("a", "git status --short", "M src/foo.ts"));
    const sc = await toolCalls({ tool_name: "Bash" });
    expect(sc.calls).toHaveLength(1);
    expect(sc.calls[0]!.tool).toBe("Bash");
    expect(sc.calls[0]!.args.command).toBe("git status --short");
  });

  it("finds an opencode shell call by its tool name", async () => {
    await seed(opencodeShell("a", "ls -la", "total 0"));
    const sc = await toolCalls({ tool_name: "bash" });
    expect(sc.calls).toHaveLength(1);
    expect(sc.calls[0]!.args.command).toBe("ls -la");
  });

  it("does not report the command text as the tool name", async () => {
    await seed(claudeShell("a", "rm -rf /tmp/scratch", "ok"));
    const sc = await toolCalls({ kind: "execute" });
    expect(sc.calls[0]!.tool).toBe("Bash");
    expect(sc.calls[0]!.tool).not.toContain("rm -rf");
  });

  it("matches both agents' shell calls through the agent-independent kind", async () => {
    await seed([
      ...claudeShell("a", "echo one", "one"),
      ...opencodeShell("b", "echo two", "two"),
    ]);
    const sc = await toolCalls({ kind: "execute" });
    expect(sc.calls).toHaveLength(2);
    expect(sc.calls.map((c) => c.args.command)).toEqual(["echo one", "echo two"]);
  });

  it("matches a tool name case-insensitively and by substring", async () => {
    await seed(claudeShell("a", "true", ""));
    expect((await toolCalls({ tool_name: "bash" })).calls).toHaveLength(1);
    expect((await toolCalls({ tool_name: "BASH" })).calls).toHaveLength(1);
  });

  it("returns what a claude-acp call printed", async () => {
    await seed(claudeShell("a", "wc -l < f", "1679"));
    const sc = await toolCalls({ kind: "execute" });
    expect(sc.calls[0]!.output).toBe("1679");
    expect(sc.calls[0]!.outputTruncated).toBe(false);
  });

  it("returns what an opencode call printed", async () => {
    await seed(opencodeShell("a", "cat f", "hello"));
    const sc = await toolCalls({ kind: "execute" });
    expect(sc.calls[0]!.output).toBe("hello");
  });

  it("separates stderr so a failure is legible", async () => {
    const entries = claudeShell("a", "false", "");
    const last = entries[2]!.params as { update: Record<string, unknown> };
    last.update._meta = {
      claudeCode: { toolResponse: { stdout: "", stderr: "boom" } },
    };
    await seed(entries);
    const sc = await toolCalls({ kind: "execute" });
    expect(sc.calls[0]!.output).toContain("boom");
  });

  it("caps a large output and says it did", async () => {
    const huge = "x".repeat(50_000);
    await seed(claudeShell("a", "cat big", huge));
    const sc = await toolCalls({ kind: "execute" });
    expect(sc.calls[0]!.outputTruncated).toBe(true);
    expect(sc.calls[0]!.outputBytes).toBe(50_000);
    expect(sc.calls[0]!.output!.length).toBeLessThan(3_000);
  });

  it("omits output when the caller only wants the commands", async () => {
    await seed(claudeShell("a", "echo hi", "hi"));
    const sc = await toolCalls({ kind: "execute", include_output: false });
    expect(sc.calls[0]!.args.command).toBe("echo hi");
    expect(sc.calls[0]!.output).toBeUndefined();
  });

  it("still rejects a call with no filter at all", async () => {
    await seed(claudeShell("a", "echo hi", "hi"));
    const r = await client!.callTool({ name: "tool_calls", arguments: {} });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text: string }>)[0]!.text).toContain("at least one of");
  });

  describe("search over tool activity", () => {
    async function search(query: string): Promise<SearchResult> {
      const r = await client!.callTool({ name: "search", arguments: { query } });
      return r.structuredContent as SearchResult;
    }

    it("finds text that only ever appeared inside a shell command", async () => {
      await seed(claudeShell("a", "grep -rn copyright src/", "src/foo.h:1"));
      const sc = await search("copyright");
      expect(sc.total_matched).toBeGreaterThan(0);
      expect(sc.matches[0]!.speaker).toBe("tool");
    });

    it("finds text that only ever appeared in a command's output", async () => {
      await seed(claudeShell("a", "cat version", "release-42-candidate"));
      const sc = await search("release-42-candidate");
      expect(sc.total_matched).toBeGreaterThan(0);
    });

    it("finds text inside an opencode command", async () => {
      await seed(opencodeShell("a", "pytest tests/test_auth.py", "1 passed"));
      const sc = await search("test_auth");
      expect(sc.total_matched).toBeGreaterThan(0);
    });

    // search tells the agent to pull a match "in full via range", so a
    // match range cannot render is a dead end.
    it("hands off to range, which can show what was matched", async () => {
      await seed(claudeShell("a", "cat version", "release-42-candidate"));
      const hit = await search("release-42-candidate");
      expect(hit.total_matched).toBeGreaterThan(0);
      const entryId = hit.matches[0]!.entryId;
      const r = await client!.callTool({
        name: "range",
        arguments: { from_entry: Math.max(0, entryId - 3), to_entry: entryId + 1 },
      });
      const sc = r.structuredContent as { text: string };
      expect(sc.text).toContain("release-42-candidate");
      expect(sc.text).toContain("cat version");
    });

    it("skips tool activity when the caller opts out", async () => {
      await seed(claudeShell("a", "grep -rn copyright src/", "hit"));
      const r = await client!.callTool({
        name: "search",
        arguments: { query: "copyright", include_tool_calls: false },
      });
      const sc = r.structuredContent as SearchResult;
      expect(sc.total_matched).toBe(0);
    });
  });
});
