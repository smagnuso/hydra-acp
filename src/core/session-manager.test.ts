import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Resurrect now reseeds when the recorded cwd is gone (the agent's own
// session is pinned to it), so resurrect-path tests need a cwd that
// actually exists. These stand in for the old WORK_CWD / W_CWD placeholders.
const WORK_CWD = mkdtempSync(path.join(os.tmpdir(), "hydra-test-work-"));
const W_CWD = mkdtempSync(path.join(os.tmpdir(), "hydra-test-w-"));
import {
  SessionManager,
  extractInitialModel,
  extractInitialModels,
  effectiveInteractive,
} from "./session-manager.js";
import { Registry, type RegistryAgent } from "./registry.js";
import {
  makeMockAgent,
  type MockAgentControls,
} from "../__tests__/test-utils.js";
import { JsonRpcErrorCodes } from "../acp/types.js";
import { HYDRA_CAT_CLIENT_NAME } from "./hydra-version.js";

function fakeRegistryAgent(id = "claude-code"): RegistryAgent {
  return {
    id,
    name: id,
    distribution: { npx: { package: id } },
  };
}

function fakeRegistry(agents: RegistryAgent[]): Registry {
  return {
    async getAgent(id: string) {
      return agents.find((a) => a.id === id);
    },
    async load() {
      return { version: "0", agents };
    },
    async refresh() {
      return { version: "0", agents };
    },
  } as unknown as Registry;
}

describe("SessionManager.resurrect", () => {
  let mocks: MockAgentControls[];
  let mockIndex: number;
  let manager: SessionManager;

  beforeEach(() => {
    mocks = [];
    mockIndex = 0;
    manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
        mocks.push(m);
        const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        requestMock
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockResolvedValueOnce({ sessionId: "u_loaded" });
        return m.agent;
      },
    );
  });

  it("spawns the agent, calls initialize then session/load, and registers a session", async () => {
    // Use a real dir so the resurrect cwd-heal is a no-op and the cwd
    // threading assertion below stays meaningful.
    const realCwd = process.cwd();
    const session = await manager.resurrect({
      hydraSessionId: "sess_hyd",
      upstreamSessionId: "u_loaded",
      agentId: "claude-code",
      cwd: realCwd,
    });

    expect(session.sessionId).toBe("sess_hyd");
    expect(session.upstreamSessionId).toBe("u_loaded");

    const requestMock = mocks[0]!.agent.connection.request as ReturnType<typeof vi.fn>;
    expect(requestMock.mock.calls[0]?.[0]).toBe("initialize");
    expect(requestMock.mock.calls[1]).toMatchObject([
      "session/load",
      { sessionId: "u_loaded", cwd: realCwd },
    ]);
    void mockIndex;
  });

  it("forwards params.mcpServers into the agent's session/load call", async () => {
    // Resurrect used to hardcode `mcpServers: []`, which left cold sessions
    // without the extension MCP servers they had at original create time
    // (the daemon's per-session bearer tokens are in-memory and die on
    // restart, so the descriptors baked into the agent's session snapshot
    // stop authenticating). The WS layer now mints fresh descriptors and
    // passes them through ResurrectParams; this asserts the manager
    // forwards them rather than silently dropping them.
    const realCwd = process.cwd();
    const descriptors = [
      {
        name: "hydra-acp-planner",
        type: "http",
        url: "http://127.0.0.1:0/mcp/hydra-acp-planner",
        headers: [{ name: "Authorization", value: "Bearer test" }],
      },
    ];
    await manager.resurrect({
      hydraSessionId: "sess_hyd_mcp",
      upstreamSessionId: "u_loaded",
      agentId: "claude-code",
      cwd: realCwd,
      mcpServers: descriptors,
    });
    const requestMock = mocks[0]!.agent.connection.request as ReturnType<typeof vi.fn>;
    expect(requestMock.mock.calls[1]).toMatchObject([
      "session/load",
      { sessionId: "u_loaded", cwd: realCwd, mcpServers: descriptors },
    ]);
  });

  it("returns the existing session if hydraSessionId is already known", async () => {
    const first = await manager.resurrect({
      hydraSessionId: "sess_hyd",
      upstreamSessionId: "u_loaded",
      agentId: "claude-code",
      cwd: WORK_CWD,
    });
    const second = await manager.resurrect({
      hydraSessionId: "sess_hyd",
      upstreamSessionId: "u_loaded",
      agentId: "claude-code",
      cwd: WORK_CWD,
    });
    expect(second).toBe(first);
    expect(mocks).toHaveLength(1);
  });

  it("rejects mismatched upstream IDs for the same hydra session", async () => {
    await manager.resurrect({
      hydraSessionId: "sess_hyd",
      upstreamSessionId: "u_loaded",
      agentId: "claude-code",
      cwd: WORK_CWD,
    });
    await expect(
      manager.resurrect({
        hydraSessionId: "sess_hyd",
        upstreamSessionId: "u_DIFFERENT",
        agentId: "claude-code",
        cwd: WORK_CWD,
      }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCodes.AlreadyAttached });
  });

  it("serializes concurrent resurrections of the same hydra session", async () => {
    const [a, b] = await Promise.all([
      manager.resurrect({
        hydraSessionId: "sess_concurrent",
        upstreamSessionId: "u_c",
        agentId: "claude-code",
        cwd: WORK_CWD,
      }),
      manager.resurrect({
        hydraSessionId: "sess_concurrent",
        upstreamSessionId: "u_c",
        agentId: "claude-code",
        cwd: WORK_CWD,
      }),
    ]);
    expect(a).toBe(b);
    expect(mocks).toHaveLength(1);
  });

  it("recovers via import-reseed when session/load fails for the upstream id", async () => {
    let spawnCount = 0;
    const failingMgr = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: W_CWD });
        mocks.push(m);
        const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        if (spawnCount === 0) {
          requestMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockRejectedValueOnce(new Error("loadSession not supported"));
        } else {
          // Recovery: initialize + session/new return a fresh upstream
          // id. No session/prompt expected — no history is planted, so
          // buildSwitchTranscript yields an empty string and the seed
          // is a no-op.
          requestMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockResolvedValueOnce({ sessionId: "u_new" });
        }
        spawnCount += 1;
        return m.agent;
      },
    );

    const session = await failingMgr.resurrect({
      hydraSessionId: "sess_fail",
      upstreamSessionId: "u_fail",
      agentId: "claude-code",
      cwd: W_CWD,
    });

    expect(session.upstreamSessionId).toBe("u_new");
    expect(mocks[0]?.agent.kill).toHaveBeenCalled();
    expect(spawnCount).toBe(2);

    const reloaded = await failingMgr.loadFromDisk("sess_fail");
    expect(reloaded?.upstreamSessionId).toBe("u_new");
  });

  it("propagates AUTH_REQUIRED from session/load with enriched authMethods (no recovery)", async () => {
    let spawnCount = 0;
    const authMethods = [
      { id: "claude-login", description: "Log in", type: "agent" as const },
    ];
    const authMgr = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: W_CWD });
        mocks.push(m);
        spawnCount += 1;
        const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        const authErr = Object.assign(new Error("auth needed"), {
          code: JsonRpcErrorCodes.AuthRequired,
        });
        requestMock
          .mockResolvedValueOnce({ protocolVersion: 1, authMethods })
          .mockRejectedValueOnce(authErr);
        return m.agent;
      },
    );

    let caught: unknown;
    try {
      await authMgr.resurrect({
        hydraSessionId: "sess_auth",
        upstreamSessionId: "u_auth",
        agentId: "claude-code",
        cwd: W_CWD,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const err = caught as { code: number; message: string; data: Record<string, unknown> };
    expect(err.code).toBe(JsonRpcErrorCodes.AuthRequired);
    expect(err.message).toBe("auth needed");
    const meta = err.data._meta as Record<string, unknown>;
    const hydraMeta = meta["hydra-acp"] as { agentId: string; authMethods: unknown[] };
    expect(hydraMeta.agentId).toBe("claude-code");
    expect(hydraMeta.authMethods).toEqual(authMethods);
    // Recovery/reseed path must NOT run for AUTH_REQUIRED.
    expect(spawnCount).toBe(1);
    expect(mocks[0]?.agent.kill).toHaveBeenCalled();
  });

  it("still recovers via import-reseed when session/load fails with a non-auth code (regression guard)", async () => {
    let spawnCount = 0;
    const recoverMgr = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: W_CWD });
        mocks.push(m);
        const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        if (spawnCount === 0) {
          const otherErr = Object.assign(new Error("session not found"), {
            code: JsonRpcErrorCodes.SessionNotFound,
          });
          requestMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockRejectedValueOnce(otherErr);
        } else {
          requestMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockResolvedValueOnce({ sessionId: "u_recovered" });
        }
        spawnCount += 1;
        return m.agent;
      },
    );
    const session = await recoverMgr.resurrect({
      hydraSessionId: "sess_recover",
      upstreamSessionId: "u_old",
      agentId: "claude-code",
      cwd: W_CWD,
    });
    expect(session.upstreamSessionId).toBe("u_recovered");
    expect(spawnCount).toBe(2);
  });

  it("captures the agent's _meta on session/load for passthrough", async () => {
    const passthroughMgr = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: W_CWD });
        mocks.push(m);
        const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        requestMock
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockResolvedValueOnce({
            _meta: { "agent-vendor": { sequence: 7 } },
          });
        return m.agent;
      },
    );
    const session = await passthroughMgr.resurrect({
      hydraSessionId: "sess_meta",
      upstreamSessionId: "u",
      agentId: "claude-code",
      cwd: W_CWD,
    });
    expect(session.agentMeta).toEqual({ "agent-vendor": { sequence: 7 } });
  });

  it("does not let the first prompt after resurrect clobber the persisted title", async () => {
    const titledMgr = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: W_CWD });
        mocks.push(m);
        const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        requestMock
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ stopReason: "end_turn" });
        return m.agent;
      },
    );
    const session = await titledMgr.resurrect({
      hydraSessionId: "sess_resurrect_title",
      upstreamSessionId: "u",
      agentId: "claude-code",
      cwd: W_CWD,
      title: "feature-X",
    });
    const { JsonRpcConnection } = await import("../acp/connection.js");
    const { makeControlledStream } = await import(
      "../__tests__/test-utils.js"
    );
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    await session.attach({ clientId: "c1", connection: conn }, "full");

    await session.prompt("c1", {
      prompt: [{ type: "text", text: "first prompt of the new life" }],
    });
    expect(session.title).toBe("feature-X");
    await titledMgr.flushMetaWrites();
    await titledMgr.flushHistoryWrites();
  });

  it("re-seeds the title from the next prompt when the resurrected record had none (firstPromptSeeded gates on title)", async () => {
    const untitledMgr = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: W_CWD });
        mocks.push(m);
        const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        requestMock
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ stopReason: "end_turn" });
        return m.agent;
      },
    );
    const session = await untitledMgr.resurrect({
      hydraSessionId: "sess_no_title",
      upstreamSessionId: "u",
      agentId: "claude-code",
      cwd: W_CWD,
      // No title — should NOT lock firstPromptSeeded on.
    });
    const { JsonRpcConnection } = await import("../acp/connection.js");
    const { makeControlledStream } = await import(
      "../__tests__/test-utils.js"
    );
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    await session.attach({ clientId: "c1", connection: conn }, "full");

    await session.prompt("c1", {
      prompt: [{ type: "text", text: "recovered title line" }],
    });
    expect(session.title).toBe("recovered title line");
    // Drain pending persistTitle + history.append writes before tmpHome
    // cleanup so a straggler's fs.mkdir doesn't race the rmSync and
    // surface as ENOTEMPTY in the next test's teardown.
    await untitledMgr.flushMetaWrites();
    await untitledMgr.flushHistoryWrites();
  });

  it("propagates title onto the resurrected session and into list()", async () => {
    const titledMgr = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: W_CWD });
        mocks.push(m);
        const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        requestMock
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockResolvedValueOnce({});
        return m.agent;
      },
    );
    const session = await titledMgr.resurrect({
      hydraSessionId: "sess_titled",
      upstreamSessionId: "u",
      agentId: "claude-code",
      cwd: W_CWD,
      title: "feature-X",
    });
    expect(session.title).toBe("feature-X");
    const entries = await titledMgr.list({ includeNonInteractive: true });
    expect(entries[0]?.title).toBe("feature-X");
  });

  it("rejects when the agent ID is not in the registry", async () => {
    await expect(
      manager.resurrect({
        hydraSessionId: "x",
        upstreamSessionId: "u",
        agentId: "unknown-agent",
        cwd: "/",
      }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCodes.AgentNotInstalled });
  });
});

describe("SessionManager.resurrect: dead cwd reseed", () => {
  it("reseeds a fresh agent session in defaultCwd (not session/load) when the recorded cwd is gone, and persists the new id + cwd", async () => {
    const { SessionStore } = await import("./session-store.js");
    const store = new SessionStore();
    const deadCwd = "/no/such/hydra/dir/abc123";
    const fallback = process.cwd();

    await store.write({
      sessionId: "hydra_dead_cwd",
      cwd: deadCwd,
      agentId: "claude-code",
      upstreamSessionId: "u_dead",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 30_000).toISOString(),
      attentionFlags: [],
    });

    let spawnedCwd: string | undefined;
    const mock = makeMockAgent({ agentId: "claude-code", cwd: fallback });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock.mockImplementation((method: string) => {
      if (method === "initialize") {
        return Promise.resolve({ protocolVersion: 1 });
      }
      if (method === "session/new") {
        return Promise.resolve({ sessionId: "u_reseeded" });
      }
      return Promise.resolve({});
    });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      (opts) => {
        spawnedCwd = opts.cwd;
        return mock.agent;
      },
      undefined,
      { defaultCwd: fallback },
    );

    const params = await manager.loadFromDisk("hydra_dead_cwd");
    expect(params).not.toBeNull();
    const session = await manager.resurrect(params!);

    // The dead-dir session can't be resumed (its agent is pinned to a gone
    // cwd), so we reseed: a fresh session/new in the fallback cwd, never a
    // session/load against the stale upstream id.
    expect(spawnedCwd).toBe(fallback);
    const methods = requestMock.mock.calls.map((c) => c[0]);
    expect(methods).toContain("session/new");
    expect(methods).not.toContain("session/load");
    expect(session.cwd).toBe(fallback);
    expect(session.upstreamSessionId).toBe("u_reseeded");

    // The new upstream id + healed cwd are persisted so the next resurrect
    // resumes normally instead of pointing at the dead dir.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const reloaded = await manager.loadFromDisk("hydra_dead_cwd");
    expect(reloaded?.cwd).toBe(fallback);
    expect(reloaded?.upstreamSessionId).toBe("u_reseeded");
  });
});

describe("SessionManager.reapIfOrphanedNonInteractive", () => {
  // create()/reap never stat the cwd, so any existing dir works — use one
  // that needs no import so this block stands on its own.
  const REAP_CWD = process.cwd();
  function makeCreateManager(): {
    manager: SessionManager;
    requestMock: ReturnType<typeof vi.fn>;
  } {
    const mock = makeMockAgent({ agentId: "claude-code", cwd: REAP_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock.mockImplementation((method: string) => {
      if (method === "initialize") {
        return Promise.resolve({ protocolVersion: 1 });
      }
      if (method === "session/new") {
        return Promise.resolve({ sessionId: `u_${Math.random()}` });
      }
      return Promise.resolve({});
    });
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => mock.agent,
    );
    return { manager, requestMock };
  }

  it("closes an orphaned cat-origin session (kills agent, keeps cold record)", async () => {
    const { manager } = makeCreateManager();
    const session = await manager.create({
      cwd: REAP_CWD,
      agentId: "claude-code",
      originatingClient: { name: HYDRA_CAT_CLIENT_NAME },
    });
    const id = session.sessionId;
    expect(manager.get(id)).toBeDefined();
    expect(session.attachedCount).toBe(0);

    await manager.reapIfOrphanedNonInteractive(id);

    // Live agent dropped, but the cold record survives for a later refine.
    expect(manager.get(id)).toBeUndefined();
    expect(await manager.loadFromDisk(id)).toBeDefined();
  });

  it("leaves an interactive session running", async () => {
    const { manager } = makeCreateManager();
    const session = await manager.create({
      cwd: REAP_CWD,
      agentId: "claude-code",
      originatingClient: { name: "hydra-acp-tui" },
      interactive: true,
    });
    const id = session.sessionId;

    await manager.reapIfOrphanedNonInteractive(id);

    expect(manager.get(id)).toBeDefined();
  });

  it("reaps an orphaned never-prompted non-cat session (interactive===undefined)", async () => {
    const { manager } = makeCreateManager();
    const session = await manager.create({
      cwd: REAP_CWD,
      agentId: "claude-code",
      originatingClient: { name: "hydra-acp-tui" },
    });
    const id = session.sessionId;
    expect(session.interactive).toBeUndefined();
    expect(session.attachedCount).toBe(0);

    await manager.reapIfOrphanedNonInteractive(id);

    // Never promoted to interactive → reaped, cold record kept.
    expect(manager.get(id)).toBeUndefined();
    expect(await manager.loadFromDisk(id)).toBeDefined();
  });

  it("leaves a session that was promoted to interactive by a real prompt", async () => {
    const { manager } = makeCreateManager();
    const session = await manager.create({
      cwd: REAP_CWD,
      agentId: "claude-code",
      originatingClient: { name: "hydra-acp-tui" },
    });
    const id = session.sessionId;
    expect(session.interactive).toBeUndefined();

    const { JsonRpcConnection } = await import("../acp/connection.js");
    const { makeControlledStream } = await import(
      "../__tests__/test-utils.js"
    );
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    await session.attach({ clientId: "c1", connection: conn }, "full");
    await session.prompt("c1", {
      prompt: [{ type: "text", text: "a real, non-ancillary prompt" }],
    });
    expect(session.interactive).toBe(true);
    session.detach("c1");
    expect(session.attachedCount).toBe(0);

    await manager.reapIfOrphanedNonInteractive(id);

    expect(manager.get(id)).toBeDefined();
  });

  it("does not reap while another client is still attached", async () => {
    const { manager } = makeCreateManager();
    const session = await manager.create({
      cwd: REAP_CWD,
      agentId: "claude-code",
      originatingClient: { name: HYDRA_CAT_CLIENT_NAME },
    });
    const id = session.sessionId;
    const { JsonRpcConnection } = await import("../acp/connection.js");
    const { makeControlledStream } = await import(
      "../__tests__/test-utils.js"
    );
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    await session.attach({ clientId: "c1", connection: conn }, "full");
    expect(session.attachedCount).toBe(1);

    await manager.reapIfOrphanedNonInteractive(id);

    expect(manager.get(id)).toBeDefined();
  });
});

describe("SessionManager: history persistence", () => {
  let tmpHome: string;
  let mocks: MockAgentControls[];
  let manager: SessionManager;

  beforeEach(() => {
    tmpHome = process.env.HYDRA_ACP_HOME!;
    mocks = [];
    manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: W_CWD });
        mocks.push(m);
        const requestMock = m.agent.connection.request as ReturnType<
          typeof vi.fn
        >;
        // initialize + (session/new on create, session/load on resurrect).
        requestMock
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockResolvedValueOnce({ sessionId: "u_freshly_loaded" });
        return m.agent;
      },
    );
  });

  // Helper: history-store appends are fire-and-forget, so tests need
  // to give them time to settle before reading back.
  async function flushHistoryWrites(): Promise<void> {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }

  it("persists broadcast notifications to disk and serves them on getHistory", async () => {
    const session = await manager.create({
      cwd: W_CWD,
      agentId: "claude-code",
    });
    const m = mocks[0]!;
    m.triggerNotification("session/update", {
      sessionId: session.upstreamSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello world" },
      },
    });
    await flushHistoryWrites();

    const history = await manager.getHistory(session.sessionId);
    expect(history).toBeDefined();
    const chunk = history!.find(
      (e) =>
        (e.params as { update?: { sessionUpdate?: string } }).update
          ?.sessionUpdate === "agent_message_chunk",
    );
    expect(chunk).toBeDefined();
    // Persisted form has the hydra sessionId substituted in (rewriteForClient).
    expect((chunk!.params as { sessionId: string }).sessionId).toBe(
      session.sessionId,
    );
  });

  it("replays the persisted history to the next attaching client after resurrect", async () => {
    // First incarnation: emit a notification, then idle-close (no record delete).
    const live = await manager.create({ cwd: W_CWD, agentId: "claude-code" });
    const sessionId = live.sessionId;
    mocks[0]!.triggerNotification("session/update", {
      sessionId: live.upstreamSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "first turn output" },
      },
    });
    await flushHistoryWrites();
    await live.close({ deleteRecord: false });

    // Resurrect via the loadFromDisk path (no resume hints).
    const resumeParams = await manager.loadFromDisk(sessionId);
    expect(resumeParams).toBeDefined();

    const revived = await manager.resurrect(resumeParams!);
    expect(revived.sessionId).toBe(sessionId);

    // Fresh client attaches; replay should include the persisted chunk.
    const { JsonRpcConnection } = await import("../acp/connection.js");
    const { makeControlledStream } = await import(
      "../__tests__/test-utils.js"
    );
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    const { entries: replay } = await revived.attach(
      { clientId: "c1", connection: conn },
      "full",
    );

    const replayedChunk = replay.find(
      (e) =>
        (e.params as { update?: { sessionUpdate?: string } }).update
          ?.sessionUpdate === "agent_message_chunk",
    );
    expect(replayedChunk).toBeDefined();
    expect(
      (replayedChunk!.params as { update: { content: { text: string } } })
        .update.content.text,
    ).toBe("first turn output");
  });

  it("drops the agent's session/load replay instead of re-recording it (regression: doubled history every resurrect)", async () => {
    // First incarnation: emit one real chunk that legitimately lands in
    // history, then idle-close so the disk record sticks around.
    const live = await manager.create({ cwd: W_CWD, agentId: "claude-code" });
    const sessionId = live.sessionId;
    const upstream = live.upstreamSessionId;
    mocks[0]!.triggerNotification("session/update", {
      sessionId: upstream,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "original turn output" },
      },
    });
    await flushHistoryWrites();
    await live.close({ deleteRecord: false });

    // Fresh SessionManager whose session/load mock simulates the
    // ACP-spec behavior: agent re-emits the conversation via
    // session/update notifications before its session/load reply
    // returns. Those land in the connection's pre-handler buffer.
    // Without drainBuffered, wireAgent's subscription would flush
    // them through recordAndBroadcast and double the on-disk log.
    const replayMgr = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: W_CWD });
        mocks.push(m);
        const requestMock = m.agent.connection.request as ReturnType<
          typeof vi.fn
        >;
        requestMock
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockImplementationOnce(async (method: string) => {
            if (method === "session/load") {
              m.triggerNotification("session/update", {
                sessionId: upstream,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: {
                    type: "text",
                    text: "REPLAYED — should not be recorded",
                  },
                },
              });
            }
            return {};
          });
        return m.agent;
      },
    );

    await replayMgr.resurrect({
      hydraSessionId: sessionId,
      upstreamSessionId: upstream,
      agentId: "claude-code",
      cwd: W_CWD,
    });
    await flushHistoryWrites();

    const history = await replayMgr.getHistory(sessionId);
    expect(history).toBeDefined();
    const chunks = history!.filter(
      (e) =>
        (e.params as { update?: { sessionUpdate?: string } }).update
          ?.sessionUpdate === "agent_message_chunk",
    );
    expect(chunks).toHaveLength(1);
    expect(
      (chunks[0]!.params as { update: { content: { text: string } } }).update
        .content.text,
    ).toBe("original turn output");
  });

  it("loads history from disk on resume-hints resurrect (regression: hints used to skip the disk load)", async () => {
    // Pre-create + emit a chunk so a history file exists on disk.
    const live = await manager.create({ cwd: W_CWD, agentId: "claude-code" });
    const sessionId = live.sessionId;
    mocks[0]!.triggerNotification("session/update", {
      sessionId: live.upstreamSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "should replay even on hints path" },
      },
    });
    await flushHistoryWrites();
    await live.close({ deleteRecord: false });

    // Hints-style resurrect (no seedHistory passed). History still
    // comes from the on-disk store via the Session's historyStore.
    const revived = await manager.resurrect({
      hydraSessionId: sessionId,
      upstreamSessionId: "u_freshly_loaded",
      agentId: "claude-code",
      cwd: W_CWD,
    });

    const { JsonRpcConnection } = await import("../acp/connection.js");
    const { makeControlledStream } = await import(
      "../__tests__/test-utils.js"
    );
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    const { entries: replay } = await revived.attach(
      { clientId: "c1", connection: conn },
      "full",
    );

    const hasChunk = replay.some(
      (e) =>
        (e.params as { update?: { sessionUpdate?: string } }).update
          ?.sessionUpdate === "agent_message_chunk",
    );
    expect(hasChunk).toBe(true);
  });

  it("self-heals a missing title from the first prompt in history on loadFromDisk", async () => {
    const live = await manager.create({ cwd: W_CWD, agentId: "claude-code" });
    const sessionId = live.sessionId;
    // Drive a prompt_received into history without the in-memory title
    // path firing setTitle's persist hook — simulate the race that
    // leaves the title in memory but not on disk by clearing it before
    // close.
    mocks[0]!.triggerNotification("session/update", {
      sessionId: live.upstreamSessionId,
      update: {
        sessionUpdate: "prompt_received",
        prompt: [{ type: "text", text: "implement the cache layer" }],
      },
    });
    await flushHistoryWrites();
    // Mimic the persisted-without-title state by stripping title from
    // meta.json directly (would require the SessionStore but we'll
    // approximate via a fresh resurrect path).
    await live.close({ deleteRecord: false });

    // Wipe the title field on disk to simulate the lost-title state.
    const metaPath = path.join(
      tmpHome,
      "sessions",
      sessionId,
      "meta.json",
    );
    const raw = await fs.readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw);
    delete parsed.title;
    await fs.writeFile(metaPath, JSON.stringify(parsed, null, 2) + "\n");

    const resumeParams = await manager.loadFromDisk(sessionId);
    expect(resumeParams?.title).toBe("implement the cache layer");
  });

  it("preserves createdAt across resurrect (regression: attachManagerHooks used to reset it)", async () => {
    const live = await manager.create({ cwd: W_CWD, agentId: "claude-code" });
    const sessionId = live.sessionId;
    const original = await manager.loadFromDisk(sessionId);
    const originalCreatedAt = original?.createdAt;
    expect(originalCreatedAt).toBeDefined();

    // Force the second clock tick before resurrect so a regression
    // (createdAt = new Date().toISOString()) would change the value.
    await new Promise((r) => setTimeout(r, 20));
    await live.close({ deleteRecord: false });
    const revived = await manager.resurrect({
      hydraSessionId: sessionId,
      upstreamSessionId: "u_resurrected",
      agentId: "claude-code",
      cwd: W_CWD,
      title: original?.title,
      createdAt: original?.createdAt,
    });
    void revived;

    const after = await manager.loadFromDisk(sessionId);
    expect(after?.createdAt).toBe(originalCreatedAt);
  });

  it("deletes the history file when the session record is destroyed", async () => {
    const session = await manager.create({
      cwd: W_CWD,
      agentId: "claude-code",
    });
    mocks[0]!.triggerNotification("session/update", {
      sessionId: session.upstreamSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "x" },
      },
    });
    await flushHistoryWrites();
    const historyPath = path.join(
      tmpHome,
      "sessions",
      session.sessionId,
      "history.jsonl",
    );
    // Ensure the history file exists before close.
    const before = await manager.getHistory(session.sessionId);
    expect((before ?? []).length).toBeGreaterThan(0);

    await session.close({ deleteRecord: true });

    // Poll briefly because close handlers run fire-and-forget.
    let exists = true;
    for (let i = 0; i < 20; i++) {
      try {
        await fs.access(historyPath);
      } catch {
        exists = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(exists).toBe(false);
  });

  it("preserves the history file across idle close (deleteRecord: false)", async () => {
    const session = await manager.create({
      cwd: W_CWD,
      agentId: "claude-code",
    });
    mocks[0]!.triggerNotification("session/update", {
      sessionId: session.upstreamSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "preserved" },
      },
    });
    await flushHistoryWrites();
    await session.close({ deleteRecord: false });

    const history = await manager.getHistory(session.sessionId);
    expect(history).toBeDefined();
    const chunk = history!.find(
      (e) =>
        (e.params as { update?: { sessionUpdate?: string } }).update
          ?.sessionUpdate === "agent_message_chunk",
    );
    expect(chunk).toBeDefined();
  });

  describe("snapshot state (model/mode/commands) in meta.json", () => {
    // persistSnapshot is fire-and-forget (read + write hops on top of
    // the notification dispatch). Poll loadFromDisk until the expected
    // shape arrives or we run out of attempts.
    async function eventually<T>(
      check: () => Promise<T | undefined>,
      pred: (v: T | undefined) => boolean,
    ): Promise<T | undefined> {
      for (let i = 0; i < 30; i++) {
        const v = await check();
        if (pred(v)) {
          return v;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return check();
    }

    it("persists current_model_update + current_mode_update into meta.json", async () => {
      const session = await manager.create({
        cwd: W_CWD,
        agentId: "claude-code",
      });
      const m = mocks[0]!;
      m.triggerNotification("session/update", {
        sessionId: session.upstreamSessionId,
        update: { sessionUpdate: "current_model_update", currentModel: "sonnet-4.6" },
      });
      m.triggerNotification("session/update", {
        sessionId: session.upstreamSessionId,
        update: { sessionUpdate: "current_mode_update", currentMode: "plan" },
      });
      // Sanity check: in-memory Session state should reflect the
      // notifications synchronously — handler dispatch is direct.
      expect(session.currentModel).toBe("sonnet-4.6");
      expect(session.currentMode).toBe("plan");

      const params = await eventually(
        () => manager.loadFromDisk(session.sessionId),
        (p) => p?.currentModel === "sonnet-4.6" && p?.currentMode === "plan",
      );
      expect(params?.currentModel).toBe("sonnet-4.6");
      expect(params?.currentMode).toBe("plan");
    });

    it("persists agent-emitted available_commands_update into meta.json", async () => {
      const session = await manager.create({
        cwd: W_CWD,
        agentId: "claude-code",
      });
      mocks[0]!.triggerNotification("session/update", {
        sessionId: session.upstreamSessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "create_plan", description: "Plan a thing" },
            { name: "research" },
          ],
        },
      });

      const params = await eventually(
        () => manager.loadFromDisk(session.sessionId),
        (p) => (p?.agentCommands?.length ?? 0) === 2,
      );
      expect(params?.agentCommands).toEqual([
        { name: "create_plan", description: "Plan a thing" },
        { name: "research" },
      ]);
    });

    it("filters snapshot updates out of history (transcript stays focused on conversation)", async () => {
      const session = await manager.create({
        cwd: W_CWD,
        agentId: "claude-code",
      });
      mocks[0]!.triggerNotification("session/update", {
        sessionId: session.upstreamSessionId,
        update: { sessionUpdate: "current_model_update", currentModel: "x" },
      });
      mocks[0]!.triggerNotification("session/update", {
        sessionId: session.upstreamSessionId,
        update: { sessionUpdate: "current_mode_update", currentMode: "y" },
      });
      mocks[0]!.triggerNotification("session/update", {
        sessionId: session.upstreamSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "this stays in history" },
        },
      });
      await flushHistoryWrites();

      const history = await manager.getHistory(session.sessionId);
      const kinds = (history ?? []).map(
        (e) =>
          (e.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate,
      );
      expect(kinds).toContain("agent_message_chunk");
      expect(kinds).not.toContain("current_model_update");
      expect(kinds).not.toContain("current_mode_update");
      expect(kinds).not.toContain("available_commands_update");
    });

    it("threads snapshot state into the resurrected Session", async () => {
      const live = await manager.create({ cwd: W_CWD, agentId: "claude-code" });
      const sessionId = live.sessionId;
      mocks[0]!.triggerNotification("session/update", {
        sessionId: live.upstreamSessionId,
        update: {
          sessionUpdate: "current_model_update",
          currentModel: "opus-4.7",
        },
      });
      mocks[0]!.triggerNotification("session/update", {
        sessionId: live.upstreamSessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "create_plan" }],
        },
      });
      await eventually(
        () => manager.loadFromDisk(sessionId),
        (p) =>
          p?.currentModel === "opus-4.7" &&
          (p?.agentCommands?.length ?? 0) === 1,
      );
      await live.close({ deleteRecord: false });

      const resumeParams = await manager.loadFromDisk(sessionId);
      const revived = await manager.resurrect(resumeParams!);
      expect(revived.currentModel).toBe("opus-4.7");
      const merged = revived.mergedAvailableCommands().map((c) => c.name);
      expect(merged).toContain("create_plan");
      expect(merged).toContain("hydra");
    });

    it("pushes persisted currentMode back to the agent via session/set_mode on resurrect (regression: plan mode silently reverted to default on daemon restart)", async () => {
      const live = await manager.create({ cwd: W_CWD, agentId: "claude-code" });
      const sessionId = live.sessionId;
      mocks[0]!.triggerNotification("session/update", {
        sessionId: live.upstreamSessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentMode: "plan",
        },
      });
      await eventually(
        () => manager.loadFromDisk(sessionId),
        (p) => p?.currentMode === "plan",
      );
      await live.close({ deleteRecord: false });

      const resumeParams = await manager.loadFromDisk(sessionId);
      const revived = await manager.resurrect(resumeParams!);

      expect(revived.currentMode).toBe("plan");

      // mocks[1] is the freshly spawned agent for the resurrect. The
      // default spawner queue answers initialize + session/load; the
      // set_mode call falls through to the vi.fn() default (undefined),
      // which is a fine response for a void method.
      const requestMock = mocks[1]!.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      const setModeCall = requestMock.mock.calls.find(
        (c) => c[0] === "session/set_mode",
      );
      expect(setModeCall).toBeDefined();
      expect(setModeCall?.[1]).toMatchObject({
        sessionId: revived.upstreamSessionId,
        modeId: "plan",
      });
    });

    it("skips session/set_mode on resurrect when the agent already reports the persisted mode", async () => {
      // Replace the default spawner so the resurrect agent's session/load
      // returns currentModeId: "plan" — i.e. the agent is already in the
      // mode we want, so no reapply is needed.
      const localMocks: MockAgentControls[] = [];
      let callIndex = 0;
      const localManager = new SessionManager(
        fakeRegistry([fakeRegistryAgent("claude-code")]),
        () => {
          const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
          localMocks.push(m);
          const requestMock = m.agent.connection.request as ReturnType<
            typeof vi.fn
          >;
          if (callIndex === 0) {
            requestMock
              .mockResolvedValueOnce({ protocolVersion: 1 })
              .mockResolvedValueOnce({ sessionId: "u_already_plan" });
          } else {
            requestMock
              .mockResolvedValueOnce({ protocolVersion: 1 })
              .mockResolvedValueOnce({
                sessionId: "u_already_plan",
                currentModeId: "plan",
              });
          }
          callIndex += 1;
          return m.agent;
        },
      );

      const live = await localManager.create({
        cwd: W_CWD,
        agentId: "claude-code",
      });
      const sessionId = live.sessionId;
      localMocks[0]!.triggerNotification("session/update", {
        sessionId: live.upstreamSessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentMode: "plan",
        },
      });
      await eventually(
        () => localManager.loadFromDisk(sessionId),
        (p) => p?.currentMode === "plan",
      );
      await live.close({ deleteRecord: false });

      const resumeParams = await localManager.loadFromDisk(sessionId);
      const revived = await localManager.resurrect(resumeParams!);
      expect(revived.currentMode).toBe("plan");

      const requestMock = localMocks[1]!.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      const setModeCall = requestMock.mock.calls.find(
        (c) => c[0] === "session/set_mode",
      );
      expect(setModeCall).toBeUndefined();
    });

    it("skips session/set_mode on resurrect when the persisted mode is not in the agent's advertised modes", async () => {
      // Resurrect agent advertises a single mode "default" — the
      // persisted "plan" is unknown to the new agent, so we should not
      // blindly forward it (would be rejected, or worse, accepted as
      // garbage). Effective mode falls back to the agent's reported
      // mode.
      const localMocks: MockAgentControls[] = [];
      let callIndex = 0;
      const localManager = new SessionManager(
        fakeRegistry([fakeRegistryAgent("claude-code")]),
        () => {
          const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
          localMocks.push(m);
          const requestMock = m.agent.connection.request as ReturnType<
            typeof vi.fn
          >;
          if (callIndex === 0) {
            requestMock
              .mockResolvedValueOnce({ protocolVersion: 1 })
              .mockResolvedValueOnce({ sessionId: "u_no_plan_mode" });
          } else {
            requestMock
              .mockResolvedValueOnce({ protocolVersion: 1 })
              .mockResolvedValueOnce({
                sessionId: "u_no_plan_mode",
                currentModeId: "default",
                availableModes: [{ id: "default" }],
              });
          }
          callIndex += 1;
          return m.agent;
        },
      );

      const live = await localManager.create({
        cwd: W_CWD,
        agentId: "claude-code",
      });
      const sessionId = live.sessionId;
      localMocks[0]!.triggerNotification("session/update", {
        sessionId: live.upstreamSessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentMode: "plan",
        },
      });
      await eventually(
        () => localManager.loadFromDisk(sessionId),
        (p) => p?.currentMode === "plan",
      );
      await live.close({ deleteRecord: false });

      const resumeParams = await localManager.loadFromDisk(sessionId);
      const revived = await localManager.resurrect(resumeParams!);
      // Falls back to the agent's reported mode rather than the
      // unsupported persisted one.
      expect(revived.currentMode).toBe("default");

      const requestMock = localMocks[1]!.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      const setModeCall = requestMock.mock.calls.find(
        (c) => c[0] === "session/set_mode",
      );
      expect(setModeCall).toBeUndefined();
    });

    it("passes persisted model via _meta to session/load on resurrect (regression: opus[1m] silently reverted to sonnet on daemon restart)", async () => {
      // doResurrect passes _meta.claudeCode.options.model in the session/load
      // call so the agent initializes claude with --model <id> at resume time —
      // equivalent to `claude --resume --model opus`. The session model is then
      // whatever the agent reports back (which should now be opus).
      const localMocks: MockAgentControls[] = [];
      let callIndex = 0;
      const localManager = new SessionManager(
        fakeRegistry([fakeRegistryAgent("claude-acp")]),
        () => {
          const m = makeMockAgent({ agentId: "claude-acp", cwd: WORK_CWD });
          localMocks.push(m);
          const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
          if (callIndex === 0) {
            // create(): initialize + session/new
            requestMock
              .mockResolvedValueOnce({ protocolVersion: 1 })
              .mockResolvedValueOnce({ sessionId: "u_orig" });
          } else {
            // resurrect's session/load agent: reports opus[1m] (agent honored _meta)
            requestMock
              .mockResolvedValueOnce({ protocolVersion: 1 })
              .mockResolvedValueOnce({ sessionId: "u_orig", currentModelId: "opus[1m]" });
          }
          callIndex += 1;
          return m.agent;
        },
      );

      const live = await localManager.create({ cwd: W_CWD, agentId: "claude-acp" });
      const sessionId = live.sessionId;
      localMocks[0]!.triggerNotification("session/update", {
        sessionId: live.upstreamSessionId,
        update: { sessionUpdate: "current_model_update", currentModel: "opus[1m]" },
      });
      await eventually(
        () => localManager.loadFromDisk(sessionId),
        (p) => p?.currentModel === "opus[1m]",
      );
      await live.close({ deleteRecord: false });

      const resumeParams = await localManager.loadFromDisk(sessionId);
      const revived = await localManager.resurrect(resumeParams!);

      // The session/load call must include _meta with the persisted model.
      const loadAgentMock = localMocks[1]!.agent.connection.request as ReturnType<typeof vi.fn>;
      const loadCall = loadAgentMock.mock.calls.find((c) => c[0] === "session/load");
      expect(loadCall?.[1]).toMatchObject({
        _meta: { claudeCode: { options: { model: "opus[1m]" } } },
      });
      // Session uses whatever model the agent reported after session/load.
      expect(revived.currentModel).toBe("opus[1m]");
    });

    it("skips session/set_model on resurrect when the agent already reports the persisted model", async () => {
      const localMocks: MockAgentControls[] = [];
      let callIndex = 0;
      const localManager = new SessionManager(
        fakeRegistry([fakeRegistryAgent("claude-code")]),
        () => {
          const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
          localMocks.push(m);
          const requestMock = m.agent.connection.request as ReturnType<
            typeof vi.fn
          >;
          if (callIndex === 0) {
            requestMock
              .mockResolvedValueOnce({ protocolVersion: 1 })
              .mockResolvedValueOnce({ sessionId: "u_already_opus" });
          } else {
            requestMock
              .mockResolvedValueOnce({ protocolVersion: 1 })
              .mockResolvedValueOnce({
                sessionId: "u_already_opus",
                currentModelId: "opus[1m]",
              });
          }
          callIndex += 1;
          return m.agent;
        },
      );

      const live = await localManager.create({
        cwd: W_CWD,
        agentId: "claude-code",
      });
      const sessionId = live.sessionId;
      localMocks[0]!.triggerNotification("session/update", {
        sessionId: live.upstreamSessionId,
        update: {
          sessionUpdate: "current_model_update",
          currentModel: "opus[1m]",
        },
      });
      await eventually(
        () => localManager.loadFromDisk(sessionId),
        (p) => p?.currentModel === "opus[1m]",
      );
      await live.close({ deleteRecord: false });

      const resumeParams = await localManager.loadFromDisk(sessionId);
      const revived = await localManager.resurrect(resumeParams!);
      expect(revived.currentModel).toBe("opus[1m]");

      const requestMock = localMocks[1]!.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      const setModelCall = requestMock.mock.calls.find(
        (c) => c[0] === "session/set_model",
      );
      expect(setModelCall).toBeUndefined();
    });

    it("falls back to agent-reported model when both _meta and set_model are rejected", async () => {
      // Agent reports a different model from session/load AND rejects set_model.
      // doResurrect should fall back to whatever the agent actually reported.
      const localMocks: MockAgentControls[] = [];
      let callIndex = 0;
      const localManager = new SessionManager(
        fakeRegistry([fakeRegistryAgent("claude-code")]),
        () => {
          const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
          localMocks.push(m);
          const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
          if (callIndex === 0) {
            requestMock
              .mockResolvedValueOnce({ protocolVersion: 1 })
              .mockResolvedValueOnce({ sessionId: "u_orig" });
          } else {
            // session/load reports wrong model; set_model then rejects
            requestMock
              .mockResolvedValueOnce({ protocolVersion: 1 })
              .mockResolvedValueOnce({ sessionId: "u_orig", currentModelId: "sonnet" })
              .mockImplementationOnce((method: string) => {
                if (method === "session/set_model")
                  return Promise.reject(new Error("unknown model"));
                return Promise.resolve({});
              });
          }
          callIndex += 1;
          return m.agent;
        },
      );

      const live = await localManager.create({ cwd: W_CWD, agentId: "claude-code" });
      const sessionId = live.sessionId;
      localMocks[0]!.triggerNotification("session/update", {
        sessionId: live.upstreamSessionId,
        update: { sessionUpdate: "current_model_update", currentModel: "opus[1m]" },
      });
      await eventually(
        () => localManager.loadFromDisk(sessionId),
        (p) => p?.currentModel === "opus[1m]",
      );
      await live.close({ deleteRecord: false });

      const resumeParams = await localManager.loadFromDisk(sessionId);
      const revived = await localManager.resurrect(resumeParams!);
      // Both _meta and set_model failed — session uses what the agent reported.
      expect(revived.currentModel).toBe("sonnet");
    });

    it("restores persisted model via set_model when agent reports wrong model on session/load (codex-acp path)", async () => {
      // codex-acp has no _meta extension, so it boots its default model after
      // session/load. doResurrect calls set_model as a fallback to push the
      // persisted model back. When set_model succeeds the session uses the
      // persisted model, not the agent's default.
      const localMocks: MockAgentControls[] = [];
      let callIndex = 0;
      const localManager = new SessionManager(
        fakeRegistry([fakeRegistryAgent("codex-acp")]),
        () => {
          const m = makeMockAgent({ agentId: "codex-acp", cwd: WORK_CWD });
          localMocks.push(m);
          const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
          if (callIndex === 0) {
            requestMock
              .mockResolvedValueOnce({ protocolVersion: 1 })
              .mockResolvedValueOnce({ sessionId: "u_codex" });
          } else {
            // session/load: agent boots default (gpt-5.4/medium) ignoring model
            requestMock
              .mockResolvedValueOnce({ protocolVersion: 1 })
              .mockResolvedValueOnce({ sessionId: "u_codex", currentModelId: "gpt-5.4/medium" });
            // set_model accepts the persisted model
          }
          callIndex += 1;
          return m.agent;
        },
      );

      const live = await localManager.create({ cwd: W_CWD, agentId: "codex-acp" });
      const sessionId = live.sessionId;
      localMocks[0]!.triggerNotification("session/update", {
        sessionId: live.upstreamSessionId,
        update: { sessionUpdate: "current_model_update", currentModel: "gpt-5" },
      });
      await eventually(
        () => localManager.loadFromDisk(sessionId),
        (p) => p?.currentModel === "gpt-5",
      );
      await live.close({ deleteRecord: false });

      const resumeParams = await localManager.loadFromDisk(sessionId);
      const revived = await localManager.resurrect(resumeParams!);
      // set_model succeeded — session uses the persisted model.
      expect(revived.currentModel).toBe("gpt-5");

      const requestMock = localMocks[1]!.agent.connection.request as ReturnType<typeof vi.fn>;
      const setModelCall = requestMock.mock.calls.find((c) => c[0] === "session/set_model");
      expect(setModelCall?.[1]).toMatchObject({ modelId: "gpt-5" });
    });

    it("preserves cumulative cost across resurrect (regression: meta.json overwritten with raw cost after restart)", async () => {
      const live = await manager.create({ cwd: W_CWD, agentId: "claude-code" });
      const sessionId = live.sessionId;
      mocks[0]!.triggerNotification("session/update", {
        sessionId: live.upstreamSessionId,
        update: {
          sessionUpdate: "usage_update",
          cost: { amount: 3, currency: "USD" },
        },
      });
      await eventually(
        () => manager.loadFromDisk(sessionId),
        (p) =>
          (p?.currentUsage?.cumulativeCost ?? p?.currentUsage?.costAmount) === 3,
      );
      await live.close({ deleteRecord: false });

      const resumeParams = await manager.loadFromDisk(sessionId);
      // loadFromDisk folds prior {costAmount} into cumulativeCost so the
      // resurrected session starts with the full lifetime total in
      // cumulativeCost and a clean costAmount for the new agent life.
      expect(resumeParams?.currentUsage?.cumulativeCost).toBe(3);
      expect(resumeParams?.currentUsage?.costAmount).toBeUndefined();

      const revived = await manager.resurrect(resumeParams!);
      // The currentUsage getter returns the running total (cumulativeCost +
      // raw). With no new usage from the resurrected agent yet, that's the
      // preserved $3.
      expect(revived.currentUsage?.costAmount).toBe(3);
      // The getter strips cumulativeCost so it never leaks to consumers /
      // persistence paths.
      expect(revived.currentUsage?.cumulativeCost).toBeUndefined();

      // A new agent life now reports $0.50 raw — total must be $3.50, not $0.50.
      mocks[1]!.triggerNotification("session/update", {
        sessionId: revived.upstreamSessionId,
        update: {
          sessionUpdate: "usage_update",
          cost: { amount: 0.5, currency: "USD" },
        },
      });
      expect(revived.currentUsage?.costAmount).toBe(3.5);
    });

    it("does not drop currentUsage when resurrectParams is rebuilt with resume-hint identity overrides (regression: src/daemon/acp-ws.ts hydraHints branch)", async () => {
      const live = await manager.create({ cwd: W_CWD, agentId: "claude-code" });
      const sessionId = live.sessionId;
      mocks[0]!.triggerNotification("session/update", {
        sessionId: live.upstreamSessionId,
        update: {
          sessionUpdate: "usage_update",
          cost: { amount: 7.5, currency: "USD" },
        },
      });
      await eventually(
        () => manager.loadFromDisk(sessionId),
        (p) =>
          (p?.currentUsage?.cumulativeCost ?? p?.currentUsage?.costAmount) ===
          7.5,
      );
      await live.close({ deleteRecord: false });

      const fromDisk = await manager.loadFromDisk(sessionId);

      // First: prove the bug. Mirror the PRE-FIX shape of acp-ws.ts's
      // hydraHints branch — a fresh object with selective copies of
      // fromDisk that *omits* currentUsage. The resurrected session
      // should have lost the cumulative.
      const buggyResurrectParams = {
        hydraSessionId: sessionId,
        upstreamSessionId: "u_resume_hint_buggy",
        agentId: "claude-code",
        cwd: W_CWD,
        title: fromDisk?.title,
        agentArgs: fromDisk?.agentArgs,
        currentModel: fromDisk?.currentModel,
        currentMode: fromDisk?.currentMode,
        agentCommands: fromDisk?.agentCommands,
        createdAt: fromDisk?.createdAt,
      };
      let requestMock = mocks[0]!.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock
        .mockResolvedValueOnce({ protocolVersion: 1 })
        .mockResolvedValueOnce({ sessionId: "u_resume_hint_buggy" });
      const buggyRevived = await manager.resurrect(buggyResurrectParams);
      expect(buggyRevived.currentUsage?.costAmount).toBeUndefined();
      await buggyRevived.close({ deleteRecord: false });

      // Now the fix: ...fromDisk spread first, identity fields override.
      // Snapshot fields (currentUsage, agentModes, agentModels) flow
      // through, so cumulativeCost survives the resurrect.
      const fromDiskAfterBug = await manager.loadFromDisk(sessionId);
      const fixedResurrectParams = {
        ...fromDiskAfterBug!,
        upstreamSessionId: "u_resume_hint_fixed",
        agentId: "claude-code",
        cwd: W_CWD,
      };
      requestMock = mocks[0]!.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock
        .mockResolvedValueOnce({ protocolVersion: 1 })
        .mockResolvedValueOnce({ sessionId: "u_resume_hint_fixed" });
      const fixedRevived = await manager.resurrect(fixedResurrectParams);
      expect(fixedRevived.currentUsage?.costAmount).toBe(7.5);
    });
  });

  describe("getHistory (used by the REST history endpoint)", () => {
    it("returns the persisted history for a hot session (disk is the source of truth)", async () => {
      const session = await manager.create({
        cwd: W_CWD,
        agentId: "claude-code",
      });
      mocks[0]!.triggerNotification("session/update", {
        sessionId: session.upstreamSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "live" },
        },
      });
      await flushHistoryWrites();

      const history = await manager.getHistory(session.sessionId);
      expect(history).toBeDefined();
      const kinds = history!.map(
        (e) =>
          (e.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate,
      );
      expect(kinds).toContain("agent_message_chunk");
    });

    it("falls back to on-disk history for a cold session", async () => {
      const live = await manager.create({
        cwd: W_CWD,
        agentId: "claude-code",
      });
      const sessionId = live.sessionId;
      mocks[0]!.triggerNotification("session/update", {
        sessionId: live.upstreamSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "persisted" },
        },
      });
      await flushHistoryWrites();
      await live.close({ deleteRecord: false });

      const history = await manager.getHistory(sessionId);
      expect(history).toBeDefined();
      expect(history!.length).toBeGreaterThan(0);
    });

    it("returns undefined for a completely unknown session id", async () => {
      const history = await manager.getHistory("hydra_session_does_not_exist");
      expect(history).toBeUndefined();
    });
  });

  describe("flushMetaWrites", () => {
    it("awaits pending title persistence so a shutdown right after setTitle doesn't lose it", async () => {
      const session = await manager.create({
        cwd: W_CWD,
        agentId: "claude-code",
      });
      // Drive a title set; persistTitle is fire-and-forget.
      mocks[0]!.triggerNotification("session/update", {
        sessionId: session.upstreamSessionId,
        update: {
          sessionUpdate: "session_info_update",
          title: "near-shutdown title",
        },
      });
      // flushMetaWrites is what daemon shutdown calls; after it, disk
      // must reflect the just-set title even though we never awaited
      // anything else.
      await manager.flushMetaWrites();
      const after = await manager.loadFromDisk(session.sessionId);
      expect(after?.title).toBe("near-shutdown title");
    });
  });
});

describe("SessionManager: /hydra agent persistence", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = process.env.HYDRA_ACP_HOME!;
  });

  it("stamps pendingAgentSwap on the on-disk record when /hydra agent runs (the swap itself is dispatched async via the coordinator)", async () => {
    const oldMock = makeMockAgent({ agentId: "old", cwd: WORK_CWD });
    const handed: MockAgentControls[] = [oldMock];
    let idx = 0;

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("old"), fakeRegistryAgent("new")]),
      () => {
        const m = handed[idx++];
        if (!m) throw new Error("unexpected extra spawner call");
        const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        requestMock
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockResolvedValueOnce({ sessionId: "u_old" });
        return m.agent;
      },
    );

    const session = await manager.create({
      cwd: WORK_CWD,
      agentId: "old",
    });

    // Attach a client so prompt() will accept the slash command.
    const { JsonRpcConnection } = await import("../acp/connection.js");
    const { makeControlledStream } = await import(
      "../__tests__/test-utils.js"
    );
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    await session.attach({ clientId: "c1", connection: conn }, "full");

    await session.prompt("c1", {
      prompt: [{ type: "text", text: "/hydra agent new" }],
    });

    // Live session stays on the original agent — the cross-agent swap is
    // async via the coordinator's synthesis + idle-edge dispatch.
    expect(session.agentId).toBe("old");
    expect(session.upstreamSessionId).toBe("u_old");

    // pendingAgentSwap is the breadcrumb the resume scan reads on
    // daemon restart.  Persistence is fire-and-forget; poll briefly.
    const recordPath = path.join(
      tmpHome,
      "sessions",
      session.sessionId,
      "meta.json",
    );
    let record: { agentId?: string; pendingAgentSwap?: string } | undefined;
    for (let i = 0; i < 20; i++) {
      const raw = await fs.readFile(recordPath, "utf8");
      record = JSON.parse(raw);
      if (record?.pendingAgentSwap === "new") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(record?.pendingAgentSwap).toBe("new");
    expect(record?.agentId).toBe("old");
  });
});

describe("SessionManager: importBundle", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = process.env.HYDRA_ACP_HOME!;
    void tmpHome;
  });

  function bundleFor(opts: {
    lineageId: string;
    sessionId?: string;
    upstreamSessionId?: string;
    agentId?: string;
    cwd?: string;
    title?: string;
    machine?: string;
    history?: Array<{ method: string; params: unknown; recordedAt: number }>;
    promptHistory?: string[];
    createdAt?: string;
    updatedAt?: string;
    interactive?: boolean;
    originatingClient?: { name: string; version?: string };
  }) {
    return {
      version: 1 as const,
      exportedAt: "2026-05-13T00:00:00.000Z",
      exportedFrom: { hydraVersion: "0.1.0", machine: opts.machine ?? "h" },
      session: {
        sessionId: opts.sessionId ?? "hydra_session_origin",
        lineageId: opts.lineageId,
        ...(opts.upstreamSessionId !== undefined
          ? { upstreamSessionId: opts.upstreamSessionId }
          : {}),
        agentId: opts.agentId ?? "claude-code",
        cwd: opts.cwd ?? WORK_CWD,
        title: opts.title,
        ...(opts.interactive !== undefined
          ? { interactive: opts.interactive }
          : {}),
        ...(opts.originatingClient !== undefined
          ? { originatingClient: opts.originatingClient }
          : {}),
        createdAt: opts.createdAt ?? "2026-05-13T00:00:00.000Z",
        updatedAt: opts.updatedAt ?? "2026-05-13T00:00:00.000Z",
      },
      history: opts.history ?? [],
      ...(opts.promptHistory ? { promptHistory: opts.promptHistory } : {}),
    };
  }

  function noSpawnManager(): SessionManager {
    return new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        throw new Error("spawner should not be called from importBundle alone");
      },
    );
  }

  it("creates a fresh local session for a new bundle (no lineage match)", async () => {
    const manager = noSpawnManager();
    const result = await manager.importBundle(
      bundleFor({ lineageId: "hydra_lineage_aaa" }),
    );
    expect(result.replaced).toBe(false);
    expect(result.importedFromSessionId).toBe("hydra_session_origin");
    expect(result.sessionId).toMatch(/^hydra_session_/);
    expect(result.sessionId).not.toBe("hydra_session_origin");
  });

  it("persists upstreamSessionId='' so the next attach triggers reseed", async () => {
    const manager = noSpawnManager();
    const result = await manager.importBundle(
      bundleFor({ lineageId: "hydra_lineage_b" }),
    );
    const metaPath = path.join(
      process.env.HYDRA_ACP_HOME!,
      "sessions",
      result.sessionId,
      "meta.json",
    );
    const raw = await fs.readFile(metaPath, "utf8");
    const record = JSON.parse(raw);
    expect(record.upstreamSessionId).toBe("");
    expect(record.lineageId).toBe("hydra_lineage_b");
    expect(record.importedFromSessionId).toBe("hydra_session_origin");
  });

  it("persists origin machine and origin upstream id on import", async () => {
    const manager = noSpawnManager();
    const result = await manager.importBundle(
      bundleFor({
        lineageId: "hydra_lineage_origin",
        upstreamSessionId: "agent-side-xyz",
        machine: "build-host",
      }),
    );
    const metaPath = path.join(
      process.env.HYDRA_ACP_HOME!,
      "sessions",
      result.sessionId,
      "meta.json",
    );
    const record = JSON.parse(await fs.readFile(metaPath, "utf8"));
    expect(record.importedFromMachine).toBe("build-host");
    expect(record.importedFromUpstreamSessionId).toBe("agent-side-xyz");
  });

  it("carries the source's raw interactive value rather than forcing true", async () => {
    const manager = noSpawnManager();
    const readInteractive = async (sessionId: string): Promise<unknown> => {
      const metaPath = path.join(
        process.env.HYDRA_ACP_HOME!,
        "sessions",
        sessionId,
        "meta.json",
      );
      const record = JSON.parse(await fs.readFile(metaPath, "utf8"));
      return record.interactive;
    };

    // Real conversation: arrives true → visible immediately.
    const real = await manager.importBundle(
      bundleFor({ lineageId: "hydra_lineage_real", interactive: true }),
    );
    expect(await readInteractive(real.sessionId)).toBe(true);

    // Empty / undecided source: stays undefined (no forced true), so it's
    // hidden until a real turn lands here.
    const empty = await manager.importBundle(
      bundleFor({ lineageId: "hydra_lineage_empty" }),
    );
    expect(await readInteractive(empty.sessionId)).toBeUndefined();
  });

  it("keeps an imported cat session hidden but promotable", async () => {
    const manager = noSpawnManager();
    const result = await manager.importBundle(
      bundleFor({
        lineageId: "hydra_lineage_cat",
        originatingClient: { name: "hydra-acp-cat" },
        history: [
          { method: "session/update", params: { x: 1 }, recordedAt: 1 },
        ],
      }),
    );
    const record = JSON.parse(
      await fs.readFile(
        path.join(
          process.env.HYDRA_ACP_HOME!,
          "sessions",
          result.sessionId,
          "meta.json",
        ),
        "utf8",
      ),
    );
    // Raw value never frozen to false — it stays undefined (promotable)…
    expect(record.interactive).toBeUndefined();
    expect(record.originatingClient).toEqual({ name: "hydra-acp-cat" });
    // …but the read-time resolver still hides it via the cat-name hint
    // even though it has history content.
    expect(effectiveInteractive(record, true)).toBe(false);
  });

  it("stamps history file mtime with the bundle's updatedAt so AGE reflects source activity, not import time", async () => {
    const manager = noSpawnManager();
    const sourceUpdatedAt = "2026-05-13T00:00:00.000Z";
    const result = await manager.importBundle(
      bundleFor({
        lineageId: "hydra_lineage_mtime",
        updatedAt: sourceUpdatedAt,
      }),
    );
    const historyPath = path.join(
      process.env.HYDRA_ACP_HOME!,
      "sessions",
      result.sessionId,
      "history.jsonl",
    );
    const st = await fs.stat(historyPath);
    expect(new Date(st.mtimeMs).toISOString()).toBe(sourceUpdatedAt);

    const metaPath = path.join(
      process.env.HYDRA_ACP_HOME!,
      "sessions",
      result.sessionId,
      "meta.json",
    );
    const record = JSON.parse(await fs.readFile(metaPath, "utf8"));
    expect(record.updatedAt).toBe(sourceUpdatedAt);
  });

  it("preserves origin machine and origin upstream id across --replace", async () => {
    const manager = noSpawnManager();
    const first = await manager.importBundle(
      bundleFor({
        lineageId: "hydra_lineage_rep_origin",
        upstreamSessionId: "agent-1",
        machine: "host-1",
      }),
    );
    await manager.importBundle(
      bundleFor({
        lineageId: "hydra_lineage_rep_origin",
        upstreamSessionId: "agent-2",
        machine: "host-2",
      }),
      { replace: true },
    );
    const metaPath = path.join(
      process.env.HYDRA_ACP_HOME!,
      "sessions",
      first.sessionId,
      "meta.json",
    );
    const record = JSON.parse(await fs.readFile(metaPath, "utf8"));
    expect(record.importedFromMachine).toBe("host-2");
    expect(record.importedFromUpstreamSessionId).toBe("agent-2");
  });

  it("rejects a duplicate import (lineage match) without --replace", async () => {
    const manager = noSpawnManager();
    const first = await manager.importBundle(
      bundleFor({ lineageId: "hydra_lineage_dup" }),
    );
    await expect(
      manager.importBundle(bundleFor({ lineageId: "hydra_lineage_dup" })),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCodes.BundleAlreadyImported,
      existingSessionId: first.sessionId,
    });
  });

  it("overwrites in place with --replace, preserving the local sessionId", async () => {
    const manager = noSpawnManager();
    const first = await manager.importBundle(
      bundleFor({ lineageId: "hydra_lineage_rep", title: "first" }),
    );
    const second = await manager.importBundle(
      bundleFor({ lineageId: "hydra_lineage_rep", title: "second" }),
      { replace: true },
    );
    expect(second.replaced).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);

    const metaPath = path.join(
      process.env.HYDRA_ACP_HOME!,
      "sessions",
      first.sessionId,
      "meta.json",
    );
    const raw = await fs.readFile(metaPath, "utf8");
    const record = JSON.parse(raw);
    expect(record.title).toBe("second");
    expect(record.lineageId).toBe("hydra_lineage_rep");
  });

  it("writes history and prompt-history to disk", async () => {
    const manager = noSpawnManager();
    const result = await manager.importBundle(
      bundleFor({
        lineageId: "hydra_lineage_hist",
        history: [
          {
            method: "session/update",
            params: { update: { sessionUpdate: "prompt_received" } },
            recordedAt: 1,
          },
          {
            method: "session/update",
            params: { update: { sessionUpdate: "agent_message_chunk" } },
            recordedAt: 2,
          },
        ],
        promptHistory: ["one", "two"],
      }),
    );
    const histPath = path.join(
      process.env.HYDRA_ACP_HOME!,
      "sessions",
      result.sessionId,
      "history.jsonl",
    );
    const histRaw = await fs.readFile(histPath, "utf8");
    expect(histRaw.split("\n").filter((l) => l.length > 0)).toHaveLength(2);

    const promptPath = path.join(
      process.env.HYDRA_ACP_HOME!,
      "sessions",
      result.sessionId,
      "prompt-history",
    );
    const promptRaw = await fs.readFile(promptPath, "utf8");
    expect(promptRaw).toContain('"one"');
    expect(promptRaw).toContain('"two"');
  });

  it("persists the caller's cwd override instead of the bundle's recorded cwd", async () => {
    const manager = noSpawnManager();
    const result = await manager.importBundle(
      bundleFor({ lineageId: "hydra_lineage_cwd", cwd: "/home/abakken/dev/owm" }),
      { cwd: "/home/smagnuson/local-target" },
    );
    const metaPath = path.join(
      process.env.HYDRA_ACP_HOME!,
      "sessions",
      result.sessionId,
      "meta.json",
    );
    const record = JSON.parse(await fs.readFile(metaPath, "utf8"));
    expect(record.cwd).toBe("/home/smagnuson/local-target");
  });

  it("honors the cwd override on --replace too", async () => {
    const manager = noSpawnManager();
    const first = await manager.importBundle(
      bundleFor({ lineageId: "hydra_lineage_cwd_rep", cwd: "/orig" }),
    );
    const second = await manager.importBundle(
      bundleFor({ lineageId: "hydra_lineage_cwd_rep", cwd: "/orig" }),
      { replace: true, cwd: "/picked-on-replace" },
    );
    expect(second.replaced).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);

    const metaPath = path.join(
      process.env.HYDRA_ACP_HOME!,
      "sessions",
      first.sessionId,
      "meta.json",
    );
    const record = JSON.parse(await fs.readFile(metaPath, "utf8"));
    expect(record.cwd).toBe("/picked-on-replace");
  });

  it("falls back to the bundle's cwd when no override is given", async () => {
    const manager = noSpawnManager();
    const result = await manager.importBundle(
      bundleFor({ lineageId: "hydra_lineage_no_cwd", cwd: "/bundle-orig" }),
    );
    const metaPath = path.join(
      process.env.HYDRA_ACP_HOME!,
      "sessions",
      result.sessionId,
      "meta.json",
    );
    const record = JSON.parse(await fs.readFile(metaPath, "utf8"));
    expect(record.cwd).toBe("/bundle-orig");
  });

  it("closes a warm session backed by the replaced record and notifies attached clients", async () => {
    // Replace-over-live is the only importBundle path that can yank the
    // session out from under an attached client; assert it broadcasts
    // hydra-acp/session/closed so the TUI's cold-banner handler trips.
    const mock = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    // bootstrap: initialize + session/new for the resurrect-from-import
    // path. No history in the bundle → seedFromImport is a no-op.
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({ sessionId: "u_live_imported" });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => mock.agent,
    );

    const imported = await manager.importBundle(
      bundleFor({ lineageId: "hydra_lineage_replace_live" }),
    );

    const live = await manager.resurrect({
      hydraSessionId: imported.sessionId,
      upstreamSessionId: "",
      agentId: "claude-code",
      cwd: WORK_CWD,
    });

    const { JsonRpcConnection } = await import("../acp/connection.js");
    const { makeControlledStream } = await import(
      "../__tests__/test-utils.js"
    );
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    await live.attach({ clientId: "c1", connection: conn }, "full");

    const replaced = await manager.importBundle(
      bundleFor({ lineageId: "hydra_lineage_replace_live", title: "second" }),
      { replace: true },
    );
    expect(replaced.replaced).toBe(true);

    const closeMsg = stream.sent.find(
      (m) => "method" in m && m.method === "hydra-acp/session/closed",
    );
    expect(closeMsg).toMatchObject({
      params: { sessionId: imported.sessionId },
    });
    expect(manager.get(imported.sessionId)).toBeUndefined();
  });
});

describe("SessionManager: closeAll", () => {
  it("broadcasts hydra-acp/session/closed to every attached client", async () => {
    // Daemon graceful shutdown calls closeAll; without this, attached
    // clients would just see the WS drop and never the explicit "session
    // is gone" signal that drives the cold banner.
    const mocks: MockAgentControls[] = [];
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: W_CWD });
        mocks.push(m);
        const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        requestMock
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockResolvedValueOnce({ sessionId: `u_${mocks.length}` });
        return m.agent;
      },
    );

    const sessionA = await manager.create({ cwd: W_CWD, agentId: "claude-code" });
    const sessionB = await manager.create({ cwd: W_CWD, agentId: "claude-code" });

    const { JsonRpcConnection } = await import("../acp/connection.js");
    const { makeControlledStream } = await import(
      "../__tests__/test-utils.js"
    );
    const streamA = makeControlledStream();
    const streamB = makeControlledStream();
    await sessionA.attach(
      { clientId: "cA", connection: new JsonRpcConnection(streamA) },
      "full",
    );
    await sessionB.attach(
      { clientId: "cB", connection: new JsonRpcConnection(streamB) },
      "full",
    );

    await manager.closeAll();

    for (const [stream, session] of [
      [streamA, sessionA],
      [streamB, sessionB],
    ] as const) {
      const closeMsg = stream.sent.find(
        (m) => "method" in m && m.method === "hydra-acp/session/closed",
      );
      expect(closeMsg).toMatchObject({
        params: { sessionId: session.sessionId },
      });
    }
    expect(manager.get(sessionA.sessionId)).toBeUndefined();
    expect(manager.get(sessionB.sessionId)).toBeUndefined();
  });
});

describe("SessionManager: resurrect from import", () => {
  it("bootstraps a fresh agent and runs seedFromImport when upstreamSessionId is empty", async () => {
    const mock = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    // bootstrap: initialize + session/new, then seedFromImport's
    // session/prompt (transcript replay).
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({ sessionId: "u_fresh" })
      .mockResolvedValueOnce({ stopReason: "end_turn" });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => mock.agent,
    );

    // Plant an imported-style record on disk via importBundle.
    const imported = await manager.importBundle({
      version: 1,
      exportedAt: "2026-05-13T00:00:00.000Z",
      exportedFrom: { hydraVersion: "0.1.0", machine: "h" },
      session: {
        sessionId: "hydra_session_origin",
        lineageId: "hydra_lineage_reseed",
        agentId: "claude-code",
        cwd: WORK_CWD,
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
      // At least one prompt_received entry so buildSwitchTranscript
      // produces non-empty output and triggers runInternalPrompt.
      history: [
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "prompt_received",
              prompt: [{ type: "text", text: "hello" }],
            },
          },
          recordedAt: 1,
        },
      ],
    });

    const session = await manager.resurrect({
      hydraSessionId: imported.sessionId,
      upstreamSessionId: "",
      agentId: "claude-code",
      cwd: WORK_CWD,
    });

    expect(session.upstreamSessionId).toBe("u_fresh");

    // Allow the fire-and-forget seedFromImport to land.
    for (let i = 0; i < 30; i += 1) {
      if (requestMock.mock.calls.length >= 3) {
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(requestMock.mock.calls[0]?.[0]).toBe("initialize");
    expect(requestMock.mock.calls[1]?.[0]).toBe("session/new");
    expect(requestMock.mock.calls[2]?.[0]).toBe("session/prompt");
  });
});

describe("SessionManager: bootstrap failures and unknown ids", () => {
  it("create() rejects and kills the agent when initialize fails", async () => {
    const mocks: MockAgentControls[] = [];
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: W_CWD });
        mocks.push(m);
        const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        requestMock.mockRejectedValueOnce(new Error("spawn ENOENT: npx-not-found"));
        return m.agent;
      },
    );
    await expect(
      manager.create({ cwd: W_CWD, agentId: "claude-code" }),
    ).rejects.toThrow(/npx-not-found/);
    expect(mocks[0]?.agent.kill).toHaveBeenCalled();
  });

  it("create() rejects and kills the agent when session/new fails", async () => {
    const mocks: MockAgentControls[] = [];
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: W_CWD });
        mocks.push(m);
        const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        requestMock
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockRejectedValueOnce(new Error("session/new rejected: bad model"));
        return m.agent;
      },
    );
    await expect(
      manager.create({ cwd: W_CWD, agentId: "claude-code" }),
    ).rejects.toThrow(/bad model/);
    expect(mocks[0]?.agent.kill).toHaveBeenCalled();
  });

  it("create() rejects when the agent id isn't in the registry", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => makeMockAgent({ agentId: "claude-code", cwd: W_CWD }).agent,
    );
    await expect(
      manager.create({ cwd: W_CWD, agentId: "ghost-agent" }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCodes.AgentNotInstalled });
  });

  it("resurrect() rejects and kills the agent when initialize fails", async () => {
    const mocks: MockAgentControls[] = [];
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: W_CWD });
        mocks.push(m);
        const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        requestMock.mockRejectedValueOnce(new Error("agent died mid-handshake"));
        return m.agent;
      },
    );
    await expect(
      manager.resurrect({
        hydraSessionId: "sess_init_fail",
        upstreamSessionId: "u_old",
        agentId: "claude-code",
        cwd: W_CWD,
      }),
    ).rejects.toThrow(/died mid-handshake/);
    expect(mocks[0]?.agent.kill).toHaveBeenCalled();
  });

  it("resurrect() throws cleanly when both session/load and the recovery spawn fail", async () => {
    let spawnCount = 0;
    const mocks: MockAgentControls[] = [];
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: W_CWD });
        mocks.push(m);
        const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        if (spawnCount === 0) {
          requestMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockRejectedValueOnce(new Error("session/load: no such id"));
        } else {
          requestMock.mockRejectedValueOnce(
            new Error("recovery spawn: agent binary missing"),
          );
        }
        spawnCount += 1;
        return m.agent;
      },
    );
    await expect(
      manager.resurrect({
        hydraSessionId: "sess_cascade",
        upstreamSessionId: "u_gone",
        agentId: "claude-code",
        cwd: W_CWD,
      }),
    ).rejects.toThrow(/agent binary missing/);
    expect(spawnCount).toBe(2);
    expect(mocks[0]?.agent.kill).toHaveBeenCalled();
    expect(mocks[1]?.agent.kill).toHaveBeenCalled();
  });

  it("loadFromDisk returns undefined for an unknown session id", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => makeMockAgent({ agentId: "claude-code", cwd: W_CWD }).agent,
    );
    const result = await manager.loadFromDisk("hydra_session_does_not_exist");
    expect(result).toBeUndefined();
  });

  it("hasRecord returns false for an unknown session id", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => makeMockAgent({ agentId: "claude-code", cwd: W_CWD }).agent,
    );
    expect(await manager.hasRecord("hydra_session_does_not_exist")).toBe(false);
  });

  it("getHistory returns undefined for an unknown session id", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => makeMockAgent({ agentId: "claude-code", cwd: W_CWD }).agent,
    );
    expect(await manager.getHistory("hydra_session_does_not_exist")).toBeUndefined();
  });
});

describe("extractInitialModel", () => {
  it("pulls models.currentModelId (opencode-style)", () => {
    expect(
      extractInitialModel({
        sessionId: "ses_xxx",
        models: {
          currentModelId: "ollama/qwen3:8b",
          availableModels: [{ modelId: "ollama/qwen3:8b" }],
        },
        modes: { availableModes: [], currentModeId: "build" },
      }),
    ).toBe("ollama/qwen3:8b");
  });

  it("pulls _meta.<ns>.modelId when nothing else carries it", () => {
    expect(
      extractInitialModel({
        sessionId: "ses_xxx",
        _meta: {
          opencode: { modelId: "openai/gpt-5-codex", variant: null },
          "hydra-acp": { whatever: 1 },
        },
      }),
    ).toBe("openai/gpt-5-codex");
  });

  it("pulls a top-level currentModelId / currentModel / modelId / model", () => {
    expect(extractInitialModel({ sessionId: "x", currentModelId: "a" })).toBe("a");
    expect(extractInitialModel({ sessionId: "x", currentModel: "b" })).toBe("b");
    expect(extractInitialModel({ sessionId: "x", modelId: "c" })).toBe("c");
    expect(extractInitialModel({ sessionId: "x", model: "d" })).toBe("d");
  });

  it("returns undefined when the response carries no model anywhere", () => {
    expect(
      extractInitialModel({
        sessionId: "ses_xxx",
        agentCapabilities: {},
        _meta: { "hydra-acp": { upstreamSessionId: "u" } },
      }),
    ).toBeUndefined();
  });

  it("ignores blank-string model fields", () => {
    expect(extractInitialModel({ sessionId: "x", currentModel: "   " })).toBeUndefined();
  });
});

describe("extractInitialModels", () => {
  it("pulls top-level availableModels (spec-strict agent)", () => {
    expect(
      extractInitialModels({
        sessionId: "x",
        availableModels: [
          { modelId: "openai/gpt-5", name: "GPT-5" },
          { modelId: "openai/o3" },
        ],
      }),
    ).toEqual([
      { modelId: "openai/gpt-5", name: "GPT-5" },
      { modelId: "openai/o3" },
    ]);
  });

  it("pulls models.availableModels (opencode / claude-agent-acp shape)", () => {
    expect(
      extractInitialModels({
        sessionId: "x",
        models: {
          currentModelId: "ollama/qwen3:8b",
          availableModels: [{ modelId: "ollama/qwen3:8b" }],
        },
      }),
    ).toEqual([{ modelId: "ollama/qwen3:8b" }]);
  });

  it("pulls _meta.<ns>.availableModels when the agent only namespaces it", () => {
    expect(
      extractInitialModels({
        sessionId: "x",
        _meta: {
          opencode: {
            availableModels: [{ modelId: "x" }, { modelId: "y" }],
          },
          "hydra-acp": { upstreamSessionId: "u" },
        },
      }),
    ).toEqual([{ modelId: "x" }, { modelId: "y" }]);
  });

  it("accepts the opencode config-option shape ({ value, name }) interchangeably", () => {
    // parseModelsList is the shared parser so it must accept both
    // { modelId, name } and { value, name }. This guards against a
    // future refactor splitting the two shapes apart.
    expect(
      extractInitialModels({
        sessionId: "x",
        availableModels: [
          { value: "x/y", name: "X over Y" },
          { value: "a/b" },
        ],
      }),
    ).toEqual([{ modelId: "x/y", name: "X over Y" }, { modelId: "a/b" }]);
  });

  it("returns [] when the response carries nothing", () => {
    expect(extractInitialModels({ sessionId: "x" })).toEqual([]);
  });

  it("drops malformed entries silently rather than crashing", () => {
    expect(
      extractInitialModels({
        sessionId: "x",
        availableModels: [
          null,
          "not-an-object",
          { description: "no id" },
          { modelId: "good" },
        ],
      }),
    ).toEqual([{ modelId: "good" }]);
  });
});

describe("SessionManager: defaultModels", () => {
  it("issues session/set_model after session/new and seeds currentModel", async () => {
    const mock = makeMockAgent({ agentId: "opencode", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({ sessionId: "u_fresh" })
      .mockResolvedValueOnce({ ok: true });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("opencode")]),
      () => mock.agent,
      undefined,
      { defaultModels: { opencode: "openai/gpt-5-codex" } },
    );

    const session = await manager.create({ cwd: WORK_CWD, agentId: "opencode" });

    expect(requestMock.mock.calls[0]?.[0]).toBe("initialize");
    expect(requestMock.mock.calls[1]?.[0]).toBe("session/new");
    expect(requestMock.mock.calls[2]).toEqual([
      "session/set_model",
      { sessionId: "u_fresh", modelId: "openai/gpt-5-codex" },
    ]);
    expect(session.currentModel).toBe("openai/gpt-5-codex");
  });

  it("skips session/set_model when the agent already reports that model", async () => {
    const mock = makeMockAgent({ agentId: "opencode", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({
        sessionId: "u_fresh",
        models: { currentModelId: "openai/gpt-5-codex" },
      });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("opencode")]),
      () => mock.agent,
      undefined,
      { defaultModels: { opencode: "openai/gpt-5-codex" } },
    );

    await manager.create({ cwd: WORK_CWD, agentId: "opencode" });
    expect(requestMock.mock.calls.length).toBe(2);
  });

  it("skips session/set_model when no defaultModel is configured for the agent", async () => {
    const mock = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({ sessionId: "u_fresh" });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => mock.agent,
      undefined,
      { defaultModels: { opencode: "openai/gpt-5-codex" } },
    );

    await manager.create({ cwd: WORK_CWD, agentId: "claude-code" });
    expect(requestMock.mock.calls.length).toBe(2);
  });

  it("passes persisted model (not defaultModels config) to session/load _meta on resurrect for claude-acp", async () => {
    // _meta.claudeCode.options.model must use the persisted model — not defaultModels[agentId].
    const mocks: ReturnType<typeof makeMockAgent>[] = [];
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-acp")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-acp", cwd: WORK_CWD });
        mocks.push(m);
        const req = m.agent.connection.request as ReturnType<typeof vi.fn>;
        req
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockResolvedValueOnce({ sessionId: "u_loaded" });
        return m.agent;
      },
      undefined,
      { defaultModels: { "claude-acp": "sonnet" } },
    );

    await manager.resurrect({
      hydraSessionId: "sess_hyd",
      upstreamSessionId: "u_loaded",
      agentId: "claude-acp",
      cwd: WORK_CWD,
      currentModel: "opus[1m]",
    });

    const req = mocks[0]!.agent.connection.request as ReturnType<typeof vi.fn>;
    const loadCall = req.mock.calls.find((c) => c[0] === "session/load");
    expect(loadCall?.[1]).toMatchObject({
      _meta: { claudeCode: { options: { model: "opus[1m]" } } },
    });
    expect(loadCall?.[1]._meta?.claudeCode?.options?.model).not.toBe("sonnet");
  });

  it("does not inject _meta.claudeCode into session/load for non-claude-acp agents", async () => {
    // opencode and other agents restore model from their own session state;
    // injecting _meta.claudeCode would be noise (and potentially harmful).
    const mocks: ReturnType<typeof makeMockAgent>[] = [];
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("opencode")]),
      () => {
        const m = makeMockAgent({ agentId: "opencode", cwd: WORK_CWD });
        mocks.push(m);
        const req = m.agent.connection.request as ReturnType<typeof vi.fn>;
        req
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockResolvedValueOnce({ sessionId: "u_loaded" });
        return m.agent;
      },
    );

    await manager.resurrect({
      hydraSessionId: "sess_hyd",
      upstreamSessionId: "u_loaded",
      agentId: "opencode",
      cwd: WORK_CWD,
      currentModel: "ncp-anthropic/claude-opus-4-7",
    });

    const req = mocks[0]!.agent.connection.request as ReturnType<typeof vi.fn>;
    const loadCall = req.mock.calls.find((c) => c[0] === "session/load");
    expect(loadCall?.[1]._meta).toBeUndefined();
  });

  it("prefers params.model over defaultModels[agentId] on create", async () => {
    const mock = makeMockAgent({ agentId: "opencode", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({ sessionId: "u_fresh" })
      .mockResolvedValueOnce({ ok: true });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("opencode")]),
      () => mock.agent,
      undefined,
      { defaultModels: { opencode: "openai/gpt-5-codex" } },
    );

    const session = await manager.create({
      cwd: WORK_CWD,
      agentId: "opencode",
      model: "openai/gpt-5",
    });

    expect(requestMock.mock.calls[2]).toEqual([
      "session/set_model",
      { sessionId: "u_fresh", modelId: "openai/gpt-5" },
    ]);
    expect(session.currentModel).toBe("openai/gpt-5");
  });

  it("uses params.model when no defaultModel is configured", async () => {
    const mock = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({ sessionId: "u_fresh" })
      .mockResolvedValueOnce({ ok: true });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => mock.agent,
      undefined,
      { defaultModels: {} },
    );

    await manager.create({
      cwd: WORK_CWD,
      agentId: "claude-code",
      model: "claude-opus-4-7",
    });

    expect(requestMock.mock.calls[2]).toEqual([
      "session/set_model",
      { sessionId: "u_fresh", modelId: "claude-opus-4-7" },
    ]);
  });

  it("falls back to the agent's chosen model when set_model rejects", async () => {
    const mock = makeMockAgent({ agentId: "opencode", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({
        sessionId: "u_fresh",
        models: { currentModelId: "openai/gpt-4o" },
      })
      .mockRejectedValueOnce(new Error("unknown model id"));

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("opencode")]),
      () => mock.agent,
      undefined,
      { defaultModels: { opencode: "bogus/no-such-model" } },
    );

    const session = await manager.create({ cwd: WORK_CWD, agentId: "opencode" });
    expect(session.currentModel).toBe("openai/gpt-4o");
  });

  it("skips session/set_model when defaultModels[agentId] is not in the agent's advertised availableModels", async () => {
    // Regression: with defaultModels[opencode] set to a value that
    // looks like a claude-acp id (e.g. "claude-opus-4-7[1m]" — a real
    // user-config bug we hit), the old code would fire set_model
    // anyway, opencode would silently store garbage as the model id,
    // and every subsequent prompt returned end_turn with no message.
    // Validate against the response's advertised list before firing.
    const mock = makeMockAgent({ agentId: "opencode", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({
        sessionId: "u_fresh",
        models: {
          currentModelId: "ncp-anthropic/claude-opus-4-7",
          availableModels: [
            { modelId: "ncp-anthropic/claude-opus-4-7" },
            { modelId: "openai/gpt-5" },
          ],
        },
      });

    const warnMessages: string[] = [];
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("opencode")]),
      () => mock.agent,
      undefined,
      // Intentionally a claude-acp-shaped id on an opencode agent.
      {
        defaultModels: { opencode: "claude-opus-4-7[1m]" },
        logger: { info: () => {}, warn: (msg) => warnMessages.push(msg) },
      },
    );

    const session = await manager.create({ cwd: WORK_CWD, agentId: "opencode" });

    // initialize + session/new only — NO session/set_model.
    expect(requestMock.mock.calls.length).toBe(2);
    expect(requestMock.mock.calls.map(([m]) => m)).toEqual([
      "initialize",
      "session/new",
    ]);
    // The session falls through to whatever the agent already picked.
    expect(session.currentModel).toBe("ncp-anthropic/claude-opus-4-7");
    // A warn was emitted so the operator can see why opus wasn't applied.
    expect(warnMessages.length).toBe(1);
    expect(warnMessages[0]).toContain("claude-opus-4-7[1m]");
    expect(warnMessages[0]).toContain("availableModels");
    // And the advertised list propagates into the in-memory snapshot.
    expect(session.availableModels()).toEqual([
      { modelId: "ncp-anthropic/claude-opus-4-7" },
      { modelId: "openai/gpt-5" },
    ]);
  });

  it("resolves a bare defaultModels id to the provider-prefixed advertised id", async () => {
    // The motivating bug: defaultModels[pi-dev] = "claude-opus-4-7" but
    // the agent advertises "anthropic/claude-opus-4-7". The bare id isn't
    // an exact match, but it's the only trailing-segment match, so we
    // resolve it and fire set_model with the advertised id.
    const mock = makeMockAgent({ agentId: "pi-dev", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({
        sessionId: "u_fresh",
        models: {
          currentModelId: "anthropic/claude-opus-4-8",
          availableModels: [
            { modelId: "anthropic/claude-opus-4-7" },
            { modelId: "anthropic/claude-opus-4-8" },
          ],
        },
      })
      .mockResolvedValueOnce({ ok: true });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("pi-dev")]),
      () => mock.agent,
      undefined,
      { defaultModels: { "pi-dev": "claude-opus-4-7" } },
    );

    const session = await manager.create({ cwd: WORK_CWD, agentId: "pi-dev" });

    // set_model fired with the resolved, fully-qualified id.
    expect(requestMock.mock.calls[2]).toEqual([
      "session/set_model",
      { sessionId: "u_fresh", modelId: "anthropic/claude-opus-4-7" },
    ]);
    expect(session.currentModel).toBe("anthropic/claude-opus-4-7");
  });

  it("skips set_model when a bare defaultModels id is ambiguous across providers", async () => {
    const mock = makeMockAgent({ agentId: "opencode", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({
        sessionId: "u_fresh",
        models: {
          currentModelId: "openai/gpt-5",
          availableModels: [
            { modelId: "anthropic/claude-opus-4-7" },
            { modelId: "ncp-anthropic/claude-opus-4-7" },
            { modelId: "openai/gpt-5" },
          ],
        },
      });

    const warnMessages: string[] = [];
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("opencode")]),
      () => mock.agent,
      undefined,
      {
        defaultModels: { opencode: "claude-opus-4-7" },
        logger: { info: () => {}, warn: (msg) => warnMessages.push(msg) },
      },
    );

    const session = await manager.create({ cwd: WORK_CWD, agentId: "opencode" });

    // No set_model — ambiguous match left untouched.
    expect(requestMock.mock.calls.length).toBe(2);
    expect(session.currentModel).toBe("openai/gpt-5");
    expect(warnMessages.length).toBe(1);
    expect(warnMessages[0]).toContain("ambiguous");
  });

  it("still fires set_model when the agent didn't advertise an availableModels list (pass-through fallback)", async () => {
    // Some agents only announce their model via current_model_update
    // later, not in the session/new response. In that case we can't
    // validate locally — fall back to the previous behavior of
    // forwarding optimistically. The agent's own validation (or
    // silence) is the safety net.
    const mock = makeMockAgent({ agentId: "opencode", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({ sessionId: "u_fresh" })
      .mockResolvedValueOnce({ ok: true });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("opencode")]),
      () => mock.agent,
      undefined,
      { defaultModels: { opencode: "openai/gpt-5-codex" } },
    );

    await manager.create({ cwd: WORK_CWD, agentId: "opencode" });

    expect(requestMock.mock.calls[2]).toEqual([
      "session/set_model",
      { sessionId: "u_fresh", modelId: "openai/gpt-5-codex" },
    ]);
  });
});

describe("SessionManager: resurrectPendingQueues", () => {
  it("replays queued prompts persisted on disk against a resurrected session", async () => {
    const { paths } = await import("./paths.js");
    const { SessionStore } = await import("./session-store.js");
    const { rewriteQueue } = await import("./queue-store.js");
    const store = new SessionStore();

    // Persist a session record so SessionManager.list / loadFromDisk
    // can find it on startup.
    await store.write({
      sessionId: "hydra_session_replay",
      cwd: WORK_CWD,
      agentId: "claude-code",
      upstreamSessionId: "u_replay",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 30_000).toISOString(),
      attentionFlags: [],
    });
    // And drop a fresh queue file alongside it.
    await rewriteQueue("hydra_session_replay", [
      {
        messageId: "m_replay_AAA",
        originator: { clientInfo: { name: "tui", version: "0.3.0" } },
        prompt: [{ type: "text", text: "resume me" }],
        enqueuedAt: Date.now() - 5_000,
      },
    ]);

    const mock = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({ sessionId: "u_replay" })
      // The replayed queue's upstream session/prompt — hangs so we
      // can observe it was called without the test running to
      // completion.
      .mockImplementationOnce(() => new Promise(() => undefined));

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => mock.agent,
    );

    await manager.resurrectPendingQueues();
    // Give the replay's drainQueue a tick to fire the upstream
    // session/prompt.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const promptCalls = requestMock.mock.calls.filter(
      ([m]) => m === "session/prompt",
    );
    expect(promptCalls).toHaveLength(1);
    expect(
      (promptCalls[0]?.[1] as { prompt: Array<{ text: string }> })
        .prompt[0]?.text,
    ).toBe("resume me");
  });

  it("drops persisted entries past the TTL and doesn't resurrect for stale-only queues", async () => {
    const { SessionStore } = await import("./session-store.js");
    const { rewriteQueue, loadQueue } = await import("./queue-store.js");
    const store = new SessionStore();

    await store.write({
      sessionId: "hydra_session_stale",
      cwd: WORK_CWD,
      agentId: "claude-code",
      upstreamSessionId: "u_stale",
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
      attentionFlags: [],
    });
    // enqueuedAt well past TTL (TTL is 15 min, this is a day).
    await rewriteQueue("hydra_session_stale", [
      {
        messageId: "m_stale_AAA",
        originator: { clientInfo: { name: "tui" } },
        prompt: [{ type: "text", text: "yesterday's prompt" }],
        enqueuedAt: Date.now() - 86_400_000,
      },
    ]);

    let spawnCount = 0;
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        spawnCount += 1;
        return makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD }).agent;
      },
    );

    await manager.resurrectPendingQueues();

    // No spawn happened — the queue was all stale, nothing to replay.
    expect(spawnCount).toBe(0);
    // And the stale file got rewritten to empty (and then deleted).
    expect(await loadQueue("hydra_session_stale")).toEqual([]);
  });
});

describe("SessionManager.syncFromAgent", () => {
  function makeSyncManager(opts: {
    capability?: unknown;
    pages: Array<{
      sessions: Array<{
        sessionId: string;
        cwd: string;
        title?: string;
        updatedAt?: string;
      }>;
      nextCursor?: string;
    }>;
  }): { manager: SessionManager; mock: MockAgentControls } {
    const mock = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock.mockResolvedValueOnce({
      protocolVersion: 1,
      agentCapabilities:
        opts.capability === undefined
          ? {}
          : { sessionCapabilities: { list: opts.capability } },
    });
    for (const page of opts.pages) {
      requestMock.mockResolvedValueOnce(page);
    }
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => mock.agent,
    );
    return { manager, mock };
  }

  it("persists a cold record per agent-side session with pendingHistorySync set", async () => {
    const { manager, mock } = makeSyncManager({
      capability: {},
      pages: [
        {
          sessions: [
            {
              sessionId: "u_one",
              cwd: "/projects/a",
              title: "explore atlas",
              updatedAt: "2026-05-01T00:00:00.000Z",
            },
            { sessionId: "u_two", cwd: "/projects/b" },
          ],
        },
      ],
    });
    const { synced, skipped } = await manager.syncFromAgent("claude-code");
    expect(synced).toHaveLength(2);
    expect(skipped).toBe(0);
    expect(synced.every((r) => r.pendingHistorySync === true)).toBe(true);
    expect(synced.map((r) => r.upstreamSessionId).sort()).toEqual([
      "u_one",
      "u_two",
    ]);
    expect(synced.find((r) => r.upstreamSessionId === "u_one")?.title).toBe(
      "explore atlas",
    );
    expect(synced.find((r) => r.upstreamSessionId === "u_two")?.title).toBeUndefined();
    expect(mock.agent.kill).toHaveBeenCalled();
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    expect(requestMock.mock.calls[0]?.[0]).toBe("initialize");
    expect(requestMock.mock.calls[1]?.[0]).toBe("session/list");
  });

  it("skips entries whose (agentId, upstreamSessionId) is already tracked locally", async () => {
    const { SessionStore } = await import("./session-store.js");
    const store = new SessionStore();
    await store.write({
      sessionId: "hydra_session_existing",
      cwd: "/projects/a",
      agentId: "claude-code",
      upstreamSessionId: "u_one",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attentionFlags: [],
    });

    const { manager } = makeSyncManager({
      capability: {},
      pages: [
        {
          sessions: [
            { sessionId: "u_one", cwd: "/projects/a" },
            { sessionId: "u_new", cwd: "/projects/b" },
          ],
        },
      ],
    });
    const { synced, skipped } = await manager.syncFromAgent("claude-code");
    expect(skipped).toBe(1);
    expect(synced).toHaveLength(1);
    expect(synced[0]?.upstreamSessionId).toBe("u_new");
  });

  it("throws and kills the agent when sessionCapabilities.list is not advertised", async () => {
    const { manager, mock } = makeSyncManager({ pages: [] });
    await expect(manager.syncFromAgent("claude-code")).rejects.toThrow(
      /does not advertise sessionCapabilities\.list/,
    );
    expect(mock.agent.kill).toHaveBeenCalled();
  });

  it("threads nextCursor across pages", async () => {
    const { manager, mock } = makeSyncManager({
      capability: {},
      pages: [
        {
          sessions: [{ sessionId: "u_p1", cwd: "/a" }],
          nextCursor: "cursor-2",
        },
        { sessions: [{ sessionId: "u_p2", cwd: "/b" }] },
      ],
    });
    const { synced } = await manager.syncFromAgent("claude-code");
    expect(synced.map((r) => r.upstreamSessionId).sort()).toEqual([
      "u_p1",
      "u_p2",
    ]);
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    expect(requestMock.mock.calls[1]).toEqual(["session/list", {}]);
    expect(requestMock.mock.calls[2]).toEqual([
      "session/list",
      { cursor: "cursor-2" },
    ]);
  });

  it("rejects when the agent is not in the registry", async () => {
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => makeMockAgent({ agentId: "claude-code" }).agent,
    );
    await expect(manager.syncFromAgent("unknown-agent")).rejects.toMatchObject({
      code: JsonRpcErrorCodes.AgentNotInstalled,
    });
  });

  it("skips entries whose cwd is under hydra's data dir (synopsis ephemerals)", async () => {
    const { paths } = await import("./paths.js");
    const synopsisCwd = paths.sessionDir("hydra_session_some_other");
    const { manager } = makeSyncManager({
      capability: {},
      pages: [
        {
          sessions: [
            { sessionId: "u_real", cwd: "/projects/real" },
            { sessionId: "u_synopsis_leak", cwd: synopsisCwd },
          ],
        },
      ],
    });
    const { synced, skipped } = await manager.syncFromAgent("claude-code");
    expect(synced.map((r) => r.upstreamSessionId)).toEqual(["u_real"]);
    expect(skipped).toBe(1);
  });

  it("skips entries that match a tombstone with an unchanged upstreamUpdatedAt", async () => {
    const { TombstoneStore } = await import("./tombstone-store.js");
    const tombstones = new TombstoneStore();
    await tombstones.add({
      agentId: "claude-code",
      upstreamSessionId: "u_dead",
      deletedAt: "2026-06-01T00:00:00.000Z",
      upstreamUpdatedAt: "2026-05-31T00:00:00.000Z",
      reason: "user",
    });
    const { manager } = makeSyncManager({
      capability: {},
      pages: [
        {
          sessions: [
            {
              sessionId: "u_dead",
              cwd: "/projects/a",
              updatedAt: "2026-05-31T00:00:00.000Z",
            },
            { sessionId: "u_new", cwd: "/projects/b" },
          ],
        },
      ],
    });
    const { synced, skipped } = await manager.syncFromAgent("claude-code");
    expect(synced.map((r) => r.upstreamSessionId)).toEqual(["u_new"]);
    expect(skipped).toBe(1);
    expect(await tombstones.has("claude-code", "u_dead")).toBe(true);
  });

  it("resurrects (drops tombstone, reimports) when the agent reports newer updatedAt", async () => {
    const { TombstoneStore } = await import("./tombstone-store.js");
    const tombstones = new TombstoneStore();
    await tombstones.add({
      agentId: "claude-code",
      upstreamSessionId: "u_revived",
      deletedAt: "2026-06-01T00:00:00.000Z",
      upstreamUpdatedAt: "2026-05-31T00:00:00.000Z",
      reason: "expired",
    });
    const { manager } = makeSyncManager({
      capability: {},
      pages: [
        {
          sessions: [
            {
              sessionId: "u_revived",
              cwd: "/projects/a",
              updatedAt: "2026-06-02T00:00:00.000Z",
              title: "back from the dead",
            },
          ],
        },
      ],
    });
    const { synced, skipped } = await manager.syncFromAgent("claude-code");
    expect(skipped).toBe(0);
    expect(synced).toHaveLength(1);
    expect(synced[0]?.upstreamSessionId).toBe("u_revived");
    expect(synced[0]?.title).toBe("back from the dead");
    expect(await tombstones.has("claude-code", "u_revived")).toBe(false);
  });

  it("does not resurrect when the agent reports no updatedAt", async () => {
    const { TombstoneStore } = await import("./tombstone-store.js");
    const tombstones = new TombstoneStore();
    await tombstones.add({
      agentId: "claude-code",
      upstreamSessionId: "u_dead2",
      deletedAt: "2026-06-01T00:00:00.000Z",
      upstreamUpdatedAt: "2026-05-31T00:00:00.000Z",
    });
    const { manager } = makeSyncManager({
      capability: {},
      pages: [{ sessions: [{ sessionId: "u_dead2", cwd: "/a" }] }],
    });
    const { synced, skipped } = await manager.syncFromAgent("claude-code");
    expect(synced).toHaveLength(0);
    expect(skipped).toBe(1);
    expect(await tombstones.has("claude-code", "u_dead2")).toBe(true);
  });
});

describe("SessionManager.deleteRecord", () => {
  it("writes a tombstone capturing upstream identity and updatedAt", async () => {
    const { SessionStore } = await import("./session-store.js");
    const { TombstoneStore } = await import("./tombstone-store.js");
    const store = new SessionStore();
    await store.write({
      sessionId: "hydra_session_doomed",
      lineageId: "hydra_lineage_xxxxxxxxxxxxxxxx",
      upstreamSessionId: "u_doomed",
      agentId: "claude-code",
      cwd: "/work",
      title: "rip",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-05-15T10:00:00.000Z",
      attentionFlags: [],
    });
    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => makeMockAgent({ agentId: "claude-code" }).agent,
    );
    const removed = await manager.deleteRecord("hydra_session_doomed");
    expect(removed).toBe(true);

    const tombstones = new TombstoneStore();
    const t = await tombstones.read("claude-code", "u_doomed");
    expect(t).toMatchObject({
      agentId: "claude-code",
      upstreamSessionId: "u_doomed",
      upstreamUpdatedAt: "2026-05-15T10:00:00.000Z",
      title: "rip",
      cwd: "/work",
      reason: "user",
    });
  });
});

describe("SessionManager.resurrect: pendingHistorySync", () => {
  it("keeps the agent's session/load replay and clears the flag", async () => {
    const mock = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({});
    const drainSpy = vi.spyOn(mock.agent.connection, "drainBuffered");

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => mock.agent,
    );

    // Seed the on-disk record with pendingHistorySync so the clear path
    // has something to overwrite (loadFromDisk forwards the flag through
    // ResurrectParams; using resurrect() directly mirrors that wire-up).
    const { SessionStore } = await import("./session-store.js");
    const store = new SessionStore();
    await store.write({
      sessionId: "hydra_session_synced",
      cwd: WORK_CWD,
      agentId: "claude-code",
      upstreamSessionId: "u_synced",
      pendingHistorySync: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attentionFlags: [],
    });

    await manager.resurrect({
      hydraSessionId: "hydra_session_synced",
      upstreamSessionId: "u_synced",
      agentId: "claude-code",
      cwd: WORK_CWD,
      pendingHistorySync: true,
    });

    expect(drainSpy).not.toHaveBeenCalled();
    await manager.flushMetaWrites();
    const reread = await store.read("hydra_session_synced");
    expect(reread?.pendingHistorySync).toBeUndefined();
  });
});


describe("SessionManager: parentSessionId", () => {
  it("surfaces parentSessionId for a warm session in list()", async () => {
    const mock = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({ sessionId: "u_child" });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => mock.agent,
    );

    await manager.create({
      agentId: "claude-code",
      cwd: WORK_CWD,
      parentSessionId: "hydra_session_parent",
    });

    const entries = await manager.list({ includeNonInteractive: true });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.parentSessionId).toBe("hydra_session_parent");
  });

  it("surfaces parentSessionId for a cold session in list()", async () => {
    const { SessionStore } = await import("./session-store.js");
    const store = new SessionStore();

    await store.write({
      sessionId: "hydra_session_child",
      cwd: WORK_CWD,
      agentId: "claude-code",
      upstreamSessionId: "u_cold_child",
      parentSessionId: "hydra_session_parent_cold",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attentionFlags: [],
    });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => { throw new Error("should not spawn"); },
    );

    const entries = await manager.list({ includeNonInteractive: true });
    const child = entries.find((e) => e.sessionId === "hydra_session_child");
    expect(child?.parentSessionId).toBe("hydra_session_parent_cold");
  });
});

describe("SessionManager: originatingClient", () => {
  it("surfaces originatingClient for a warm session in list() and persists it", async () => {
    const mock = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({ sessionId: "u_origin" });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => mock.agent,
    );

    const session = await manager.create({
      agentId: "claude-code",
      cwd: WORK_CWD,
      originatingClient: { name: "hydra-acp-cat", version: "9.9.9" },
    });

    const entries = await manager.list({ includeNonInteractive: true });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.originatingClient).toEqual({
      name: "hydra-acp-cat",
      version: "9.9.9",
    });

    const { SessionStore } = await import("./session-store.js");
    const store = new SessionStore();
    const record = await store.read(session.sessionId);
    expect(record?.originatingClient).toEqual({
      name: "hydra-acp-cat",
      version: "9.9.9",
    });
  });

  it("surfaces originatingClient for a cold session in list()", async () => {
    const { SessionStore } = await import("./session-store.js");
    const store = new SessionStore();

    await store.write({
      sessionId: "hydra_session_cat_cold",
      cwd: WORK_CWD,
      agentId: "claude-code",
      upstreamSessionId: "u_cold_cat",
      originatingClient: { name: "hydra-acp-cat" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attentionFlags: [],
    });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => { throw new Error("should not spawn"); },
    );

    const entries = await manager.list({ includeNonInteractive: true });
    const cat = entries.find((e) => e.sessionId === "hydra_session_cat_cold");
    expect(cat?.originatingClient).toEqual({ name: "hydra-acp-cat" });
  });
});

describe("SessionManager.create: transformChain threading", () => {
  it("wires the resolved transform chain onto the created session", async () => {
    const { JsonRpcConnection } = await import("../acp/connection.js");
    const { makeControlledStream } = await import("../__tests__/test-utils.js");

    const mock = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({ sessionId: "u_chain" });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => mock.agent,
    );

    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    const transformerRef = {
      name: "t1",
      intercepts: new Set(["request:session/prompt"]),
      connection: conn,
    };

    const session = await manager.create({
      agentId: "claude-code",
      cwd: WORK_CWD,
      transformChain: [transformerRef],
    });

    // The chain should be live on the session.
    expect((session as unknown as { transformChain: unknown[] }).transformChain).toHaveLength(1);
    expect(
      (session as unknown as { transformChain: Array<{ name: string }> }).transformChain[0]!.name,
    ).toBe("t1");
  });

  it("session has empty chain when no transformChain is provided", async () => {
    const mock = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({ sessionId: "u_no_chain" });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => mock.agent,
    );

    const session = await manager.create({ agentId: "claude-code", cwd: WORK_CWD });
    expect(
      (session as unknown as { transformChain: unknown[] }).transformChain,
    ).toHaveLength(0);
  });
});

describe("SessionManager.create: agent:initialize intercept", () => {
  it("runs agent:initialize chain intercept and passes modified capabilities to the session", async () => {
    const { makeControlledStream } = await import("../__tests__/test-utils.js");
    const { JsonRpcConnection } = await import("../acp/connection.js");

    const mock = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    // initialize returns capabilities; session/new returns session id.
    requestMock
      .mockResolvedValueOnce({
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: false } },
      })
      .mockResolvedValueOnce({ sessionId: "u_init_intercept" });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => mock.agent,
    );

    const interceptedRequests: unknown[] = [];
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    // Spy on hydra-acp/transformer/message calls and return a replaced capabilities object.
    const connRequestSpy = vi.spyOn(conn, "request").mockImplementation(
      async (_method: string, params: unknown) => {
        interceptedRequests.push(params);
        return {
          action: "stop",
          payload: { promptCapabilities: { image: true, injected: true } },
        };
      },
    );

    const transformerRef = {
      name: "caps-injector",
      intercepts: new Set(["agent:initialize"]),
      connection: conn,
    };

    await manager.create({
      agentId: "claude-code",
      cwd: WORK_CWD,
      transformChain: [transformerRef],
    });

    // The intercept should have received a hydra-acp/transformer/message call.
    expect(connRequestSpy).toHaveBeenCalledWith(
      "hydra-acp/transformer/message",
      expect.objectContaining({ method: "initialize", phase: "response" }),
    );
    // The envelope passed should carry the agent's original capabilities.
    const call = interceptedRequests[0] as { envelope: Record<string, unknown> };
    expect(call.envelope).toMatchObject({ promptCapabilities: { image: false } });
  });

  it("skips the intercept when no transformer declares agent:initialize", async () => {
    const mock = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({ sessionId: "u_no_intercept" });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => mock.agent,
    );

    const { makeControlledStream } = await import("../__tests__/test-utils.js");
    const { JsonRpcConnection } = await import("../acp/connection.js");
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    const connRequestSpy = vi.spyOn(conn, "request");

    await manager.create({
      agentId: "claude-code",
      cwd: WORK_CWD,
      transformChain: [{
        name: "prompt-only",
        intercepts: new Set(["request:session/prompt"]), // no agent:initialize
        connection: conn,
      }],
    });

    expect(connRequestSpy).not.toHaveBeenCalled();
  });
});

describe("SessionManager.create: captures child authMethods on AgentInstance", () => {
  it("populates agent.authMethods from the initialize response for a brand-new session", async () => {
    const mock = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [
          {
            id: "claude-login",
            description: "Log in with Claude account",
            type: "agent",
          },
          {
            id: "api-key",
            description: "Use ANTHROPIC_API_KEY",
            type: "terminal",
          },
        ],
      })
      .mockResolvedValueOnce({ sessionId: "u_auth_capture" });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => mock.agent,
    );

    await manager.create({ agentId: "claude-code", cwd: WORK_CWD });

    expect(mock.agent.authMethods).toEqual([
      {
        id: "claude-login",
        description: "Log in with Claude account",
        type: "agent",
      },
      {
        id: "api-key",
        description: "Use ANTHROPIC_API_KEY",
        type: "terminal",
      },
    ]);
  });

  it("preserves name and plain-object _meta verbatim and drops malformed variants", async () => {
    const mock = makeMockAgent({ agentId: "qwen-code", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [
          {
            id: "qwen-oauth",
            name: "Qwen OAuth",
            description: "Sign in via Qwen",
            _meta: { type: "terminal", args: ["--auth", "qwen"] },
          },
          {
            id: "bad-meta-array",
            description: "meta is array",
            _meta: ["nope"],
          },
          {
            id: "bad-meta-null",
            description: "meta is null",
            _meta: null,
          },
          {
            id: "bad-meta-string",
            description: "meta is string",
            _meta: "nope",
          },
          {
            id: "bad-name",
            description: "name not string",
            name: 42,
          },
          {
            id: "plain",
            description: "no extras",
          },
        ],
      })
      .mockResolvedValueOnce({ sessionId: "u_auth_meta" });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("qwen-code")]),
      () => mock.agent,
    );

    await manager.create({ agentId: "qwen-code", cwd: WORK_CWD });

    expect(mock.agent.authMethods).toEqual([
      {
        id: "qwen-oauth",
        description: "Sign in via Qwen",
        name: "Qwen OAuth",
        _meta: { type: "terminal", args: ["--auth", "qwen"] },
      },
      { id: "bad-meta-array", description: "meta is array" },
      { id: "bad-meta-null", description: "meta is null" },
      { id: "bad-meta-string", description: "meta is string" },
      { id: "bad-name", description: "name not string" },
      { id: "plain", description: "no extras" },
    ]);
  });

  it("leaves agent.authMethods undefined when the initialize response omits the field", async () => {
    const mock = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1, agentCapabilities: {} })
      .mockResolvedValueOnce({ sessionId: "u_no_auth" });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => mock.agent,
    );

    await manager.create({ agentId: "claude-code", cwd: WORK_CWD });

    expect(mock.agent.authMethods).toBeUndefined();
  });
});

describe("SessionManager.forkSession", () => {
  // Build a synthetic history with N completed turns. Each turn produces
  // a single session/update with sessionUpdate=turn_complete and a stable
  // messageId so the slicer has something to anchor on.
  function turnComplete(messageId: string, t = 0): {
    method: string;
    params: unknown;
    recordedAt: number;
  } {
    return {
      method: "session/update",
      params: {
        sessionId: "u_x",
        update: { sessionUpdate: "turn_complete", messageId, stopReason: "end_turn" },
      },
      recordedAt: t,
    };
  }

  function userMessage(text: string, t = 0): {
    method: string;
    params: unknown;
    recordedAt: number;
  } {
    return {
      method: "session/update",
      params: {
        sessionId: "u_x",
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
      },
      recordedAt: t,
    };
  }

  function bundleWith(opts: {
    lineageId: string;
    sessionId?: string;
    agentId?: string;
    cwd?: string;
    title?: string;
    history: Array<{ method: string; params: unknown; recordedAt: number }>;
    promptHistory?: string[];
    currentModel?: string;
    currentMode?: string;
    currentUsage?: { cumulativeCost?: number; costAmount?: number };
    interactive?: boolean;
  }) {
    return {
      version: 1 as const,
      exportedAt: "2026-05-13T00:00:00.000Z",
      exportedFrom: { hydraVersion: "0.1.0", machine: "h" },
      session: {
        sessionId: opts.sessionId ?? "hydra_session_src",
        lineageId: opts.lineageId,
        agentId: opts.agentId ?? "claude-code",
        cwd: opts.cwd ?? WORK_CWD,
        ...(opts.title !== undefined ? { title: opts.title } : {}),
        ...(opts.currentModel !== undefined ? { currentModel: opts.currentModel } : {}),
        ...(opts.currentMode !== undefined ? { currentMode: opts.currentMode } : {}),
        ...(opts.currentUsage !== undefined ? { currentUsage: opts.currentUsage } : {}),
        ...(opts.interactive !== undefined ? { interactive: opts.interactive } : {}),
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
      history: opts.history,
      ...(opts.promptHistory ? { promptHistory: opts.promptHistory } : {}),
    };
  }

  function noSpawnManager(agents = ["claude-code"]): SessionManager {
    return new SessionManager(
      fakeRegistry(agents.map((id) => fakeRegistryAgent(id))),
      () => {
        throw new Error("spawner should not be called from forkSession");
      },
    );
  }

  async function readMeta(sessionId: string): Promise<Record<string, unknown>> {
    const metaPath = path.join(
      process.env.HYDRA_ACP_HOME!,
      "sessions",
      sessionId,
      "meta.json",
    );
    return JSON.parse(await fs.readFile(metaPath, "utf8"));
  }

  async function readHistory(sessionId: string): Promise<
    Array<{ method: string; params: unknown; recordedAt: number }>
  > {
    const histPath = path.join(
      process.env.HYDRA_ACP_HOME!,
      "sessions",
      sessionId,
      "history.jsonl",
    );
    const raw = await fs.readFile(histPath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  }

  it("forks at last turn_complete by default", async () => {
    const manager = noSpawnManager();
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_default",
        history: [turnComplete("m_one", 1), turnComplete("m_two", 2)],
      }),
    );
    const fork = await manager.forkSession(source.sessionId, { mode: "verbatim" });
    expect(fork.forkedAt).toBe("m_two");
    expect(fork.forkedFromSessionId).toBe(source.sessionId);
    const history = await readHistory(fork.sessionId);
    expect(history.length).toBe(2);
  });

  it("forces interactive=false on the fork regardless of source", async () => {
    // A fork is a pristine snapshot — it has not had a real turn on its
    // own yet. interactive=false (not undefined) bypasses
    // effectiveInteractive's hasContent → true inference, which would
    // otherwise put every fork in the default picker because forks
    // inherit history from the source. The first non-ancillary prompt
    // promotes the fork to interactive=true.
    const manager = noSpawnManager();
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_interactive",
        interactive: true,
        history: [turnComplete("m_one", 1)],
      }),
    );
    const fork = await manager.forkSession(source.sessionId);
    const forkMeta = await readMeta(fork.sessionId);
    expect(forkMeta.interactive).toBe(false);
  });

  it("forks at a specific messageId, truncating later turns", async () => {
    const manager = noSpawnManager();
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_explicit",
        history: [
          turnComplete("m_one", 1),
          turnComplete("m_two", 2),
          turnComplete("m_three", 3),
        ],
      }),
    );
    const fork = await manager.forkSession(source.sessionId, { forkAt: "m_one", mode: "verbatim" });
    expect(fork.forkedAt).toBe("m_one");
    const history = await readHistory(fork.sessionId);
    expect(history.length).toBe(1);
    const update = (history[0]!.params as { update: { messageId: string } }).update;
    expect(update.messageId).toBe("m_one");
  });

  it("mints a fresh lineageId for the fork", async () => {
    const manager = noSpawnManager();
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_orig",
        history: [turnComplete("m_one")],
      }),
    );
    const fork = await manager.forkSession(source.sessionId);
    const sourceMeta = await readMeta(source.sessionId);
    const forkMeta = await readMeta(fork.sessionId);
    expect(typeof forkMeta.lineageId).toBe("string");
    expect(forkMeta.lineageId).not.toBe(sourceMeta.lineageId);
  });

  it("persists forkedFromSessionId and forkedFromMessageId", async () => {
    const manager = noSpawnManager();
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_bread",
        history: [turnComplete("m_only")],
      }),
    );
    const fork = await manager.forkSession(source.sessionId, { mode: "verbatim" });
    const forkMeta = await readMeta(fork.sessionId);
    expect(forkMeta.forkedFromSessionId).toBe(source.sessionId);
    expect(forkMeta.forkedFromMessageId).toBe("m_only");
    expect(forkMeta.importedFromSessionId).toBeUndefined();
    expect(forkMeta.importedFromMachine).toBeUndefined();
  });

  it("errors on unknown source sessionId", async () => {
    const manager = noSpawnManager();
    await expect(
      manager.forkSession("hydra_session_ghost"),
    ).rejects.toMatchObject({ code: JsonRpcErrorCodes.SessionNotFound });
  });

  it("forks at the beginning when source has no completed turns", async () => {
    // Sources with no completed turns (e.g. a freshly-spawned session
    // that hasn't received a prompt yet) used to be unforkable. Now the
    // fork starts with empty history and forkedAt="" as the sentinel —
    // /btw and other fork-based features should work from any state.
    const manager = noSpawnManager();
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_empty",
        history: [userMessage("hello, only user input")],
      }),
    );
    const result = await manager.forkSession(source.sessionId, { mode: "verbatim" });
    expect(result.forkedFromSessionId).toBe(source.sessionId);
    expect(result.forkedAt).toBe("");
    const history = await readHistory(result.sessionId);
    expect(history).toEqual([]);
  });

  it("errors on unknown forkAt", async () => {
    const manager = noSpawnManager();
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_badforkat",
        history: [turnComplete("m_present")],
      }),
    );
    await expect(
      manager.forkSession(source.sessionId, { forkAt: "m_missing", mode: "verbatim" }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCodes.InvalidParams });
  });

  it("inherits the source cwd by default and honours cwd override", async () => {
    const manager = noSpawnManager();
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_cwd",
        cwd: "/orig/cwd",
        history: [turnComplete("m_one")],
      }),
    );
    const inherited = await manager.forkSession(source.sessionId);
    const inheritedMeta = await readMeta(inherited.sessionId);
    expect(inheritedMeta.cwd).toBe("/orig/cwd");

    const overridden = await manager.forkSession(source.sessionId, {
      cwd: "/new/cwd",
    });
    const overriddenMeta = await readMeta(overridden.sessionId);
    expect(overriddenMeta.cwd).toBe("/new/cwd");
  });

  it("cross-agent fork scrubs agent-specific state", async () => {
    const manager = noSpawnManager(["claude-code", "codex"]);
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_xagent",
        agentId: "claude-code",
        title: "shared title",
        currentModel: "claude-sonnet-4-6",
        currentMode: "default",
        currentUsage: { cumulativeCost: 4.2 },
        history: [turnComplete("m_one")],
      }),
    );
    const fork = await manager.forkSession(source.sessionId, { agentId: "codex" });
    const forkMeta = await readMeta(fork.sessionId);
    expect(forkMeta.agentId).toBe("codex");
    expect(forkMeta.title).toBe("shared title");
    expect(forkMeta.currentModel).toBeUndefined();
    expect(forkMeta.currentMode).toBeUndefined();
    expect(forkMeta.currentUsage).toBeUndefined();
    expect(forkMeta.agentCommands).toBeUndefined();
    expect(forkMeta.agentModes).toBeUndefined();
    expect(forkMeta.agentModels).toBeUndefined();
  });

  it("same-agent override behaves like default (model/mode preserved)", async () => {
    const manager = noSpawnManager();
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_sameagent",
        agentId: "claude-code",
        currentModel: "claude-sonnet-4-6",
        currentMode: "default",
        history: [turnComplete("m_one")],
      }),
    );
    const fork = await manager.forkSession(source.sessionId, {
      agentId: "claude-code",
    });
    const forkMeta = await readMeta(fork.sessionId);
    expect(forkMeta.currentModel).toBe("claude-sonnet-4-6");
    expect(forkMeta.currentMode).toBe("default");
  });

  it("same-agent fork wipes currentUsage (fork is a new session for billing)", async () => {
    const manager = noSpawnManager();
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_usage_same",
        agentId: "claude-code",
        currentModel: "claude-sonnet-4-6",
        currentMode: "default",
        currentUsage: { cumulativeCost: 4.2 },
        history: [turnComplete("m_one")],
      }),
    );
    const fork = await manager.forkSession(source.sessionId);
    const forkMeta = await readMeta(fork.sessionId);
    expect(forkMeta.currentUsage).toBeUndefined();
    expect(forkMeta.currentModel).toBe("claude-sonnet-4-6");
    expect(forkMeta.currentMode).toBe("default");
  });

  it("errors on unknown agentId", async () => {
    const manager = noSpawnManager();
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_unknownagent",
        history: [turnComplete("m_one")],
      }),
    );
    await expect(
      manager.forkSession(source.sessionId, { agentId: "no-such-agent" }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCodes.AgentNotInstalled });
  });

  it("sliced history bytes match the source prefix exactly", async () => {
    const manager = noSpawnManager();
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_bytes",
        history: [
          turnComplete("m_one", 1),
          turnComplete("m_two", 2),
          turnComplete("m_three", 3),
        ],
      }),
    );
    const fork = await manager.forkSession(source.sessionId, { forkAt: "m_two", mode: "verbatim" });
    const forkHist = await readHistory(fork.sessionId);
    const sourceHist = await readHistory(source.sessionId);
    expect(forkHist).toEqual(sourceHist.slice(0, 2));
  });

  it("fork is independent of source — later source appends don't affect fork", async () => {
    const manager = noSpawnManager();
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_indep",
        history: [turnComplete("m_one")],
      }),
    );
    const fork = await manager.forkSession(source.sessionId);
    const beforeAppend = await readHistory(fork.sessionId);
    // Append a fresh entry to the source's history on disk. The fork's
    // history file lives in a separate directory, so this should never
    // leak through.
    const sourceHistPath = path.join(
      process.env.HYDRA_ACP_HOME!,
      "sessions",
      source.sessionId,
      "history.jsonl",
    );
    await fs.appendFile(
      sourceHistPath,
      JSON.stringify(turnComplete("m_after_fork", 10)) + "\n",
    );
    const afterAppend = await readHistory(fork.sessionId);
    expect(afterAppend).toEqual(beforeAppend);
  });

  it("prompt history is carried forward to the fork", async () => {
    const manager = noSpawnManager();
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_prompts",
        history: [turnComplete("m_one")],
        promptHistory: ["first prompt", "second prompt"],
      }),
    );
    const fork = await manager.forkSession(source.sessionId);
    const forkPromptPath = path.join(
      process.env.HYDRA_ACP_HOME!,
      "sessions",
      fork.sessionId,
      "prompt-history",
    );
    const raw = await fs.readFile(forkPromptPath, "utf8");
    const lines = raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as string);
    expect(lines).toEqual(["first prompt", "second prompt"]);
  });

  it("cross-agent fork preserves title and history (positive scrub check)", async () => {
    const manager = noSpawnManager(["claude-code", "codex"]);
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_xagent_keep",
        agentId: "claude-code",
        title: "research thread",
        currentModel: "claude-sonnet-4-6",
        history: [turnComplete("m_one", 1), turnComplete("m_two", 2)],
      }),
    );
    const fork = await manager.forkSession(source.sessionId, { agentId: "codex" });
    const forkMeta = await readMeta(fork.sessionId);
    expect(forkMeta.title).toBe("research thread");
    expect(forkMeta.currentModel).toBeUndefined();
    const forkHist = await readHistory(fork.sessionId);
    expect(forkHist.length).toBe(2);
  });

  it("forking a fork chains forkedFromSessionId one level back", async () => {
    const manager = noSpawnManager();
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_chain",
        history: [turnComplete("m_one")],
      }),
    );
    const fork1 = await manager.forkSession(source.sessionId);
    const fork2 = await manager.forkSession(fork1.sessionId);
    const fork1Meta = await readMeta(fork1.sessionId);
    const fork2Meta = await readMeta(fork2.sessionId);
    expect(fork1Meta.forkedFromSessionId).toBe(source.sessionId);
    expect(fork2Meta.forkedFromSessionId).toBe(fork1.sessionId);
    // Each fork carries a distinct lineageId.
    expect(fork2Meta.lineageId).not.toBe(fork1Meta.lineageId);
    expect(fork1Meta.lineageId).not.toBe("lin_chain");
  });

  it("forking an imported session sets forked* and clears imported*", async () => {
    const manager = noSpawnManager();
    // Source was itself imported from another machine.
    const source = await manager.importBundle(
      bundleWith({
        lineageId: "lin_from_remote",
        history: [turnComplete("m_one")],
      }),
    );
    const sourceMeta = await readMeta(source.sessionId);
    expect(sourceMeta.importedFromMachine).toBe("h");
    const fork = await manager.forkSession(source.sessionId);
    const forkMeta = await readMeta(fork.sessionId);
    // Fork is local, not imported — even though the source row carries
    // import breadcrumbs and the synthesized bundle still passes through
    // writeImportedRecord, the isFork branch must suppress imported*.
    expect(forkMeta.importedFromMachine).toBeUndefined();
    expect(forkMeta.importedFromSessionId).toBeUndefined();
    expect(forkMeta.forkedFromSessionId).toBe(source.sessionId);
  });
});

afterAll(() => {
  rmSync(WORK_CWD, { recursive: true, force: true });
  rmSync(W_CWD, { recursive: true, force: true });
});
