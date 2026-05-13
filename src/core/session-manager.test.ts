import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager, extractInitialModel } from "./session-manager.js";
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

  it("does not let the first prompt after resurrect clobber the persisted title", async () => {
    const titledMgr = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: "/w" });
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
      cwd: "/w",
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
  });

  it("re-seeds the title from the next prompt when the resurrected record had none (firstPromptSeeded gates on title)", async () => {
    const untitledMgr = new SessionManager(
      fakeRegistry([fakeRegistryAgent("claude-code")]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: "/w" });
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
      cwd: "/w",
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
    // Drain pending persistTitle writes before tmpHome cleanup so a
    // straggler doesn't race the next test's beforeEach.
    await untitledMgr.flushMetaWrites();
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

  // Helper: history-store appends are fire-and-forget, so tests need
  // to give them time to settle before reading back.
  async function flushHistoryWrites(): Promise<void> {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }

  it("persists broadcast notifications to disk and serves them on getHistory", async () => {
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
    const live = await manager.create({ cwd: "/w", agentId: "claude-code" });
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
    const replay = await revived.attach(
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

  it("loads history from disk on resume-hints resurrect (regression: hints used to skip the disk load)", async () => {
    // Pre-create + emit a chunk so a history file exists on disk.
    const live = await manager.create({ cwd: "/w", agentId: "claude-code" });
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
      cwd: "/w",
    });

    const { JsonRpcConnection } = await import("../acp/connection.js");
    const { makeControlledStream } = await import(
      "../__tests__/test-utils.js"
    );
    const stream = makeControlledStream();
    const conn = new JsonRpcConnection(stream);
    const replay = await revived.attach(
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
    const live = await manager.create({ cwd: "/w", agentId: "claude-code" });
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
    const live = await manager.create({ cwd: "/w", agentId: "claude-code" });
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
      cwd: "/w",
      title: original?.title,
      createdAt: original?.createdAt,
    });
    void revived;

    const after = await manager.loadFromDisk(sessionId);
    expect(after?.createdAt).toBe(originalCreatedAt);
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
    it("returns the persisted history for a hot session (disk is the source of truth)", async () => {
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
        cwd: "/w",
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
        // (transcript injection during /hydra agent — only the new agent).
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
    await session.attach({ clientId: "c1", connection: conn }, "full");

    await session.prompt("c1", {
      prompt: [{ type: "text", text: "/hydra agent new" }],
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

describe("SessionManager: importBundle", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = process.env.HYDRA_ACP_HOME!;
    void tmpHome;
  });

  function bundleFor(opts: {
    lineageId: string;
    sessionId?: string;
    agentId?: string;
    cwd?: string;
    title?: string;
    history?: Array<{ method: string; params: unknown; recordedAt: number }>;
    promptHistory?: string[];
  }) {
    return {
      version: 1 as const,
      exportedAt: "2026-05-13T00:00:00.000Z",
      exportedFrom: { hydraVersion: "0.1.0", machine: "h" },
      session: {
        sessionId: opts.sessionId ?? "hydra_session_origin",
        lineageId: opts.lineageId,
        agentId: opts.agentId ?? "claude-code",
        cwd: opts.cwd ?? "/work",
        title: opts.title,
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
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
});

describe("SessionManager: resurrect from import", () => {
  it("bootstraps a fresh agent and runs seedFromImport when upstreamSessionId is empty", async () => {
    const mock = makeMockAgent({ agentId: "claude-code", cwd: "/work" });
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
        cwd: "/work",
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
      cwd: "/work",
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

describe("SessionManager: defaultModels", () => {
  it("issues session/set_model after session/new and seeds currentModel", async () => {
    const mock = makeMockAgent({ agentId: "opencode", cwd: "/work" });
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

    const session = await manager.create({ cwd: "/work", agentId: "opencode" });

    expect(requestMock.mock.calls[0]?.[0]).toBe("initialize");
    expect(requestMock.mock.calls[1]?.[0]).toBe("session/new");
    expect(requestMock.mock.calls[2]).toEqual([
      "session/set_model",
      { sessionId: "u_fresh", modelId: "openai/gpt-5-codex" },
    ]);
    expect(session.currentModel).toBe("openai/gpt-5-codex");
  });

  it("skips session/set_model when the agent already reports that model", async () => {
    const mock = makeMockAgent({ agentId: "opencode", cwd: "/work" });
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

    await manager.create({ cwd: "/work", agentId: "opencode" });
    expect(requestMock.mock.calls.length).toBe(2);
  });

  it("skips session/set_model when no defaultModel is configured for the agent", async () => {
    const mock = makeMockAgent({ agentId: "claude-code", cwd: "/work" });
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

    await manager.create({ cwd: "/work", agentId: "claude-code" });
    expect(requestMock.mock.calls.length).toBe(2);
  });

  it("does not apply defaultModel on the resurrect/session-load path", async () => {
    const mock = makeMockAgent({ agentId: "opencode", cwd: "/work" });
    const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({ sessionId: "u_loaded" });

    const manager = new SessionManager(
      fakeRegistry([fakeRegistryAgent("opencode")]),
      () => mock.agent,
      undefined,
      { defaultModels: { opencode: "openai/gpt-5-codex" } },
    );

    await manager.resurrect({
      hydraSessionId: "sess_hyd",
      upstreamSessionId: "u_loaded",
      agentId: "opencode",
      cwd: "/work",
      currentModel: "ncp-anthropic/claude-opus-4-7",
    });

    expect(requestMock.mock.calls[1]?.[0]).toBe("session/load");
    expect(requestMock.mock.calls.length).toBe(2);
  });

  it("prefers params.model over defaultModels[agentId] on create", async () => {
    const mock = makeMockAgent({ agentId: "opencode", cwd: "/work" });
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
      cwd: "/work",
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
    const mock = makeMockAgent({ agentId: "claude-code", cwd: "/work" });
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
      cwd: "/work",
      agentId: "claude-code",
      model: "claude-opus-4-7",
    });

    expect(requestMock.mock.calls[2]).toEqual([
      "session/set_model",
      { sessionId: "u_fresh", modelId: "claude-opus-4-7" },
    ]);
  });

  it("falls back to the agent's chosen model when set_model rejects", async () => {
    const mock = makeMockAgent({ agentId: "opencode", cwd: "/work" });
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

    const session = await manager.create({ cwd: "/work", agentId: "opencode" });
    expect(session.currentModel).toBe("openai/gpt-4o");
  });
});

