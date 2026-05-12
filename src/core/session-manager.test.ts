import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "./session-manager.js";
import { Registry, type RegistryAgent } from "./registry.js";
import {
  makeMockAgent,
  type MockAgentControls,
} from "../__tests__/test-utils.js";
import { JsonRpcErrorCodes } from "../acp/types.js";

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
        const m = makeMockAgent({ agentId: "claude-code", cwd: "/work" });
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
    const session = await manager.resurrect({
      hydraSessionId: "sess_hyd",
      upstreamSessionId: "u_loaded",
      agentId: "claude-code",
      cwd: "/work",
    });

    expect(session.sessionId).toBe("sess_hyd");
    expect(session.upstreamSessionId).toBe("u_loaded");

    const requestMock = mocks[0]!.agent.connection.request as ReturnType<typeof vi.fn>;
    expect(requestMock.mock.calls[0]?.[0]).toBe("initialize");
    expect(requestMock.mock.calls[1]).toMatchObject([
      "session/load",
      { sessionId: "u_loaded", cwd: "/work" },
    ]);
    void mockIndex;
  });

  it("returns the existing session if hydraSessionId is already known", async () => {
    const first = await manager.resurrect({
      hydraSessionId: "sess_hyd",
      upstreamSessionId: "u_loaded",
      agentId: "claude-code",
      cwd: "/work",
    });
    const second = await manager.resurrect({
      hydraSessionId: "sess_hyd",
      upstreamSessionId: "u_loaded",
      agentId: "claude-code",
      cwd: "/work",
    });
    expect(second).toBe(first);
    expect(mocks).toHaveLength(1);
  });

  it("rejects mismatched upstream IDs for the same hydra session", async () => {
    await manager.resurrect({
      hydraSessionId: "sess_hyd",
      upstreamSessionId: "u_loaded",
      agentId: "claude-code",
      cwd: "/work",
    });
    await expect(
      manager.resurrect({
        hydraSessionId: "sess_hyd",
        upstreamSessionId: "u_DIFFERENT",
        agentId: "claude-code",
        cwd: "/work",
      }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCodes.AlreadyAttached });
  });

  it("serializes concurrent resurrections of the same hydra session", async () => {
    const [a, b] = await Promise.all([
      manager.resurrect({
        hydraSessionId: "sess_concurrent",
        upstreamSessionId: "u_c",
        agentId: "claude-code",
        cwd: "/work",
      }),
      manager.resurrect({
        hydraSessionId: "sess_concurrent",
        upstreamSessionId: "u_c",
        agentId: "claude-code",
        cwd: "/work",
      }),
    ]);
    expect(a).toBe(b);
    expect(mocks).toHaveLength(1);
  });

  it("kills the agent and surfaces an error if session/load fails", async () => {
    const failingMgr = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: "/w" });
        mocks.push(m);
        const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        requestMock
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockRejectedValueOnce(new Error("loadSession not supported"));
        return m.agent;
      },
    );
    await expect(
      failingMgr.resurrect({
        hydraSessionId: "sess_fail",
        upstreamSessionId: "u_fail",
        agentId: "claude-code",
        cwd: "/w",
      }),
    ).rejects.toThrow(/loadSession not supported/);
    expect(mocks[mocks.length - 1]?.agent.kill).toHaveBeenCalled();
  });

  it("captures the agent's _meta on session/load for passthrough", async () => {
    const passthroughMgr = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: "/w" });
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
      cwd: "/w",
    });
    expect(session.agentMeta).toEqual({ "agent-vendor": { sequence: 7 } });
  });

  it("propagates title onto the resurrected session and into list()", async () => {
    const titledMgr = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: "/w" });
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
      cwd: "/w",
      title: "feature-X",
    });
    expect(session.title).toBe("feature-X");
    const entries = await titledMgr.list();
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
        const m = makeMockAgent({ agentId: "claude-code", cwd: "/w" });
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

  it("persists broadcast notifications and seeds them on loadFromDisk", async () => {
    const session = await manager.create({
      cwd: "/w",
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

    const params = await manager.loadFromDisk(session.sessionId);
    expect(params?.seedHistory).toBeDefined();
    const chunk = params!.seedHistory!.find(
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
    const live = await manager.create({ cwd: "/w", agentId: "claude-code" });
    const sessionId = live.sessionId;
    mocks[0]!.triggerNotification("session/update", {
      sessionId: live.upstreamSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "first turn output" },
      },
    });
    await live.close({ deleteRecord: false });

    // Resurrect via the loadFromDisk path (no resume hints).
    const resumeParams = await manager.loadFromDisk(sessionId);
    expect(resumeParams).toBeDefined();
    expect(resumeParams!.seedHistory?.length).toBeGreaterThan(0);

    const revived = await manager.resurrect(resumeParams!);
    expect(revived.sessionId).toBe(sessionId);

    // Fresh client attaches; replay should include the persisted chunk.
    const { JsonRpcConnection } = await import("../acp/connection.js");
    const { makeControlledStream } = await import(
      "../__tests__/test-utils.js"
    );
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    const replay = revived.attach({ clientId: "c1", connection: conn }, "full");

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

  it("does NOT seed history when resurrecting via resume hints (shim path)", async () => {
    // Pre-create + emit a chunk so a history file exists on disk.
    const live = await manager.create({ cwd: "/w", agentId: "claude-code" });
    const sessionId = live.sessionId;
    mocks[0]!.triggerNotification("session/update", {
      sessionId: live.upstreamSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "should not replay" },
      },
    });
    await live.close({ deleteRecord: false });

    // Resume-hints path: caller (acp-ws) builds ResurrectParams without
    // seedHistory. The history on disk is left untouched but never
    // loaded into the new session.
    const revived = await manager.resurrect({
      hydraSessionId: sessionId,
      upstreamSessionId: "u_freshly_loaded",
      agentId: "claude-code",
      cwd: "/w",
    });

    const { JsonRpcConnection } = await import("../acp/connection.js");
    const { makeControlledStream } = await import(
      "../__tests__/test-utils.js"
    );
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    const replay = revived.attach({ clientId: "c1", connection: conn }, "full");

    // Replay should contain only the new session's constructor broadcast
    // (available_commands_update), not the prior chunk.
    const hasChunk = replay.some(
      (e) =>
        (e.params as { update?: { sessionUpdate?: string } }).update
          ?.sessionUpdate === "agent_message_chunk",
    );
    expect(hasChunk).toBe(false);
  });

  it("deletes the history file when the session record is destroyed", async () => {
    const session = await manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    mocks[0]!.triggerNotification("session/update", {
      sessionId: session.upstreamSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "x" },
      },
    });
    const historyPath = path.join(
      tmpHome,
      "sessions",
      session.sessionId,
      "history.jsonl",
    );
    // Ensure the history file exists before close.
    const before = await manager.loadFromDisk(session.sessionId);
    expect(before?.seedHistory?.length).toBeGreaterThan(0);

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
      cwd: "/w",
      agentId: "claude-code",
    });
    mocks[0]!.triggerNotification("session/update", {
      sessionId: session.upstreamSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "preserved" },
      },
    });
    await session.close({ deleteRecord: false });

    const params = await manager.loadFromDisk(session.sessionId);
    expect(params?.seedHistory).toBeDefined();
    const chunk = params!.seedHistory!.find(
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
        cwd: "/w",
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
        cwd: "/w",
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
        cwd: "/w",
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
      await new Promise((r) => setImmediate(r));

      const params = await manager.loadFromDisk(session.sessionId);
      const kinds = (params?.seedHistory ?? []).map(
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
      const live = await manager.create({ cwd: "/w", agentId: "claude-code" });
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
      expect(merged).toContain("/hydra title");
    });
  });

  describe("getHistory (used by the REST history endpoint)", () => {
    it("returns the live in-memory history snapshot for a hot session", async () => {
      const session = await manager.create({
        cwd: "/w",
        agentId: "claude-code",
      });
      mocks[0]!.triggerNotification("session/update", {
        sessionId: session.upstreamSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "live" },
        },
      });

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
        cwd: "/w",
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
});

describe("SessionManager: /hydra switch persistence", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = process.env.HYDRA_ACP_HOME!;
  });

  it("rewrites the on-disk record's agentId + upstreamSessionId after a switch", async () => {
    const oldMock = makeMockAgent({ agentId: "old", cwd: "/work" });
    const newMock = makeMockAgent({ agentId: "new", cwd: "/work" });
    const handed: MockAgentControls[] = [oldMock, newMock];
    let idx = 0;

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("old"), fakeRegistryAgent("new")]),
      ({ agentId }) => {
        const m = handed[idx++];
        if (!m) throw new Error("unexpected extra spawner call");
        const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
        // initialize + session/new (bootstrapAgent), then session/prompt
        // (transcript injection during /hydra switch — only the new agent).
        if (agentId === "old") {
          requestMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockResolvedValueOnce({ sessionId: "u_old" });
        } else {
          requestMock
            .mockResolvedValueOnce({ protocolVersion: 1 })
            .mockResolvedValueOnce({ sessionId: "u_new" })
            .mockResolvedValueOnce({ stopReason: "end_turn" });
        }
        return m.agent;
      },
    );

    const session = await manager.create({
      cwd: "/work",
      agentId: "old",
    });

    // Attach a client so prompt() will accept the slash command.
    const { JsonRpcConnection } = await import("../acp/connection.js");
    const { makeControlledStream } = await import(
      "../__tests__/test-utils.js"
    );
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    session.attach({ clientId: "c1", connection: conn }, "full");

    await session.prompt("c1", {
      prompt: [{ type: "text", text: "/hydra switch new" }],
    });

    expect(session.agentId).toBe("new");
    expect(session.upstreamSessionId).toBe("u_new");

    const recordPath = path.join(
      tmpHome,
      "sessions",
      session.sessionId,
      "meta.json",
    );
    // persistAgentChange is fire-and-forget (void) and itself does
    // read-then-write, so two async hops separate "switch returned"
    // from "disk reflects the new agent". Poll briefly.
    let record: { agentId: string; upstreamSessionId: string } | undefined;
    for (let i = 0; i < 20; i++) {
      const raw = await fs.readFile(recordPath, "utf8");
      record = JSON.parse(raw);
      if (record!.agentId === "new") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(record?.agentId).toBe("new");
    expect(record?.upstreamSessionId).toBe("u_new");
  });
});
