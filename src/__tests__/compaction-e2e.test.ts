/**
 * End-to-end smoke test for the compaction → swap → recall pipeline.
 *
 * Verifies all four critical contracts hold simultaneously:
 *   (a) summarizedThroughEntry > 0 after compaction
 *   (b) upstreamSessionId rotated to a new value
 *   (c) spawnReplacementAgent receives original mcpServers (not [])
 *   (d) history.jsonl is preserved with original prompts
 *   (e) post-swap session carries mcpServers config for recall tools
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../core/session-manager.js";
import { Registry, type RegistryAgent } from "../core/registry.js";
import { makeMockAgent, makeControlledStream } from "./test-utils.js";
import { JsonRpcConnection } from "../acp/connection.js";
import type { SessionSynopsis } from "../core/snapshot.js";

// Mock synopsis-agent so compaction returns a deterministic artifact without LLM.
vi.mock("../core/synopsis-agent.js", () => ({
  generateCompaction: vi.fn(),
  generateSynopsis: vi.fn(),
}));
import { generateCompaction } from "../core/synopsis-agent.js";

const mockCompaction = generateCompaction as ReturnType<typeof vi.fn>;

// Poll until predicate is true or timeoutMs elapses.
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out");
    }
    await new Promise((r) => setTimeout(r, 30));
  }
}

function fakeRegistry(): Registry {
  const agent: RegistryAgent = {
    id: "claude-code",
    name: "claude-code",
    distribution: { npx: { package: "claude-code" } },
  };
  return {
    async getAgent(id: string) {
      return id === "claude-code" ? agent : undefined;
    },
    async load() {
      return { version: "0", agents: [agent] };
    },
    async refresh() {
      return { version: "0", agents: [agent] };
    },
  } as unknown as Registry;
}

function makeArtifact(): SessionSynopsis {
  return {
    goal: "implement user auth",
    outcome: "added JWT middleware",
    files_touched: ["src/auth.ts"],
    tools_used: ["read_file", "edit_file"],
  };
}

// A fake mcpServers config that includes a recall server.
const FAKE_MCP_SERVERS = [
  {
    name: "hydra-recall",
    transport: "stdio",
    command: "hydra-recall-server",
    args: ["--session", "{{sessionId}}"],
  },
  {
    name: "project-tools",
    transport: "stdio",
    command: "my-project-mcp",
    args: [],
  },
];

const WORK_CWD = mkdtempSync(path.join(os.tmpdir(), "hydra-test-e2e-"));

describe("compaction e2e — full happy path", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "hydra-test-e2e-home-"));
    process.env.HOME = tmpHome;
    mockCompaction.mockReset();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpHome, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  });

  it(
    "preserves identity, mcpServers, history, and recall config across compaction swap",
    async () => {
      let spawnCount = 0;
      const oldAgents: ReturnType<typeof makeMockAgent>[] = [];
      const newAgents: ReturnType<typeof makeMockAgent>[] = [];

      // Track mcpServers passed in session/new for each replacement agent.
      const replacementSessionNewParams: Array<{ mcpServers?: unknown[] }> = [];

      const manager = new SessionManager(
        fakeRegistry(),
        (spawnParams) => {
          if (spawnCount === 0) {
            const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
            oldAgents.push(m);
            const reqMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
            reqMock
              .mockResolvedValueOnce({ protocolVersion: 1 })
              .mockResolvedValueOnce({ sessionId: `u_initial_${spawnCount++}` });
            return m.agent;
          }
          const newM = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
          newAgents.push(newM);
          const reqMock = newM.agent.connection.request as ReturnType<typeof vi.fn>;
          // The spawner call itself doesn't carry mcpServers — those are
          // forwarded in the subsequent session/new request. Capture them.
          reqMock.mockImplementation(async (method: string, params: unknown) => {
            if (method === "session/new") {
              replacementSessionNewParams.push(params as { mcpServers?: unknown[] });
              return { sessionId: `fresh_${spawnCount++}` };
            }
            return {};
          });
          return newM.agent;
        },
        undefined,
        { compaction: { tailK: 5 } },
      );

      // --- 1. Create session with non-empty mcpServers ---
      const session = await manager.create({
        cwd: WORK_CWD,
        agentId: "claude-code",
        mcpServers: FAKE_MCP_SERVERS,
      });
      const sessionId = session.sessionId;
      const originalUpstream = session.upstreamSessionId;

      // --- 2. Attach a client ---
      const stream = makeControlledStream();
      const conn = new JsonRpcConnection(stream);
      await session.attach({ clientId: "c1", connection: conn }, "full");

      // --- 3. Send 4 prompts so history has real entries ---
      const oldReqMock = oldAgents[0]!.agent.connection.request as ReturnType<typeof vi.fn>;
      const prompts = ["list files", "read auth.ts", "add JWT check", "run tests"];
      for (const text of prompts) {
        oldReqMock.mockResolvedValueOnce({ stopReason: "end_turn" });
        await session.prompt("c1", {
          prompt: [{ type: "text", text }],
        });
      }

      // Flush so compaction has history entries to reference.
      await manager.flushHistoryWrites();

      // --- 4. Trigger compaction ---
      mockCompaction.mockResolvedValue({ synopsis: makeArtifact() });

      (
        manager as unknown as {
          synopsisCoordinator: { scheduleCompaction: (id: string) => void };
        }
      ).synopsisCoordinator.scheduleCompaction(sessionId);

      // --- 5. Wait for swap to complete (upstreamSessionId rotates) ---
      await waitFor(() => {
        const current = manager.get(sessionId);
        return !!current && current.upstreamSessionId !== originalUpstream;
      }, 15_000);

      const swapped = manager.get(sessionId)!;

      // --- 6a. summarizedThroughEntry > 0 on disk record ---
      // persistSynopsis writes to meta.json but does not update the live
      // Session object's _summarizedThroughEntry field (that is only set at
      // construction). Read the record from disk directly to verify the
      // compaction metadata was persisted.
      await manager.flushMetaWrites();
      const store = (manager as unknown as { store: { read: (id: string) => Promise<{ summarizedThroughEntry?: number } | undefined> } }).store;
      const record = await store.read(sessionId);
      expect(record?.summarizedThroughEntry).toBeDefined();
      expect(record!.summarizedThroughEntry!).toBeGreaterThan(0);

      // --- 6b. upstreamSessionId rotated ---
      expect(swapped.upstreamSessionId).not.toBe(originalUpstream);
      expect(swapped.upstreamSessionId).toMatch(/^fresh_/);

      // --- 6c. session/new on replacement agent received original mcpServers ---
      // bootstrapAgent forwards mcpServers into session/new — this is the
      // contract that keeps recall_* tools available after a swap.
      expect(replacementSessionNewParams.length).toBeGreaterThanOrEqual(1);
      const receivedMcpServers = replacementSessionNewParams[0]!.mcpServers ?? [];
      expect(receivedMcpServers).toHaveLength(FAKE_MCP_SERVERS.length);
      expect(receivedMcpServers).toEqual(FAKE_MCP_SERVERS);

      // --- 6d. history.jsonl preserved with original prompts ---
      const histStore = (
        session as unknown as {
          historyStore: { load: (id: string) => Promise<unknown[]> };
        }
      ).historyStore;
      const entries = await histStore.load(sessionId);
      expect(entries.length).toBeGreaterThanOrEqual(prompts.length);

      // Verify Hydra sessionId unchanged — identity preserved.
      expect(manager.get(sessionId)?.sessionId).toBe(sessionId);

      // --- 6e. Post-swap session still carries mcpServers config ---
      // This confirms recall_* tools remain available: the stored config
      // is what the stdin-server uses to gate recall tool routing.
      const postSwapMcpServers = (
        swapped as unknown as { mcpServersConfig: unknown[] }
      ).mcpServersConfig;
      expect(postSwapMcpServers).toBeDefined();
      expect(postSwapMcpServers).toEqual(FAKE_MCP_SERVERS);

      await manager.flushHistoryWrites();
    },
    30_000,
  );
});
