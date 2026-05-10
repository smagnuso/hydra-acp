import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
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
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "acp-hydra-mgr-"));
    process.env.ACP_HYDRA_HOME = tmpHome;
  });

  afterEach(async () => {
    delete process.env.ACP_HYDRA_HOME;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

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
