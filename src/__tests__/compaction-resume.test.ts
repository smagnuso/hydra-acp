import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../core/session-manager.js";
import { Registry, type RegistryAgent } from "../core/registry.js";
import { SessionStore } from "../core/session-store.js";

// Mock synopsis-agent so no real compaction runs.
vi.mock("../core/synopsis-agent.js", () => ({
  generateCompaction: vi.fn(),
  generateSynopsis: vi.fn(),
}));

const WORK_CWD = mkdtempSync(path.join(os.tmpdir(), "hydra-test-resume-"));

function nowIso(): string {
  return new Date().toISOString();
}

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

function makeManager(): SessionManager {
  return new SessionManager(
    fakeRegistry([fakeRegistryAgent("claude-code")]),
    () => {
      throw new Error("no agent spawn expected in resume test");
    },
  );
}

describe("compaction resume on daemon startup", () => {
  it("scheduleCompaction is called for a session with status=requested", async () => {
    const sessionId = "hydra_" + "a".repeat(24);
    const store = new SessionStore();
    await store.write({
      sessionId,
      upstreamSessionId: "upstream_" + sessionId,
      agentId: "claude-code",
      cwd: WORK_CWD,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      compactionState: {
        status: "requested",
        requestedAt: Date.now(),
        iter: 1,
        attempts: 0,
      },
      attentionFlags: [],
    });

    const manager = makeManager();
    const scheduleSpy = vi.fn();
    vi.spyOn(manager, "scheduleCompaction").mockImplementation(scheduleSpy);

    await manager.resumePendingCompactions();

    expect(scheduleSpy).toHaveBeenCalledWith(sessionId);
  });

  it("scheduleCompaction is called for a session with status=running", async () => {
    const sessionId = "hydra_" + "b".repeat(24);
    const store = new SessionStore();
    await store.write({
      sessionId,
      upstreamSessionId: "upstream_" + sessionId,
      agentId: "claude-code",
      cwd: WORK_CWD,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      compactionState: {
        status: "running",
        requestedAt: Date.now(),
        iter: 2,
        attempts: 0,
      },
      attentionFlags: [],
    });

    const manager = makeManager();
    const scheduleSpy = vi.fn();
    vi.spyOn(manager, "scheduleCompaction").mockImplementation(scheduleSpy);

    await manager.resumePendingCompactions();

    expect(scheduleSpy).toHaveBeenCalledWith(sessionId);
  });

  it("scheduleCompaction is called for a session with status=swap_pending", async () => {
    const sessionId = "hydra_" + "c".repeat(24);
    const store = new SessionStore();
    await store.write({
      sessionId,
      upstreamSessionId: "upstream_" + sessionId,
      agentId: "claude-code",
      cwd: WORK_CWD,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      compactionState: {
        status: "swap_pending",
        requestedAt: Date.now(),
        iter: 1,
        attempts: 0,
      },
      attentionFlags: [],
    });

    const manager = makeManager();
    const scheduleSpy = vi.fn();
    vi.spyOn(manager, "scheduleCompaction").mockImplementation(scheduleSpy);

    await manager.resumePendingCompactions();

    expect(scheduleSpy).toHaveBeenCalledWith(sessionId);
  });

  it("scheduleCompaction is called for a session with status=swap_deferred (no re-summarization)", async () => {
    const sessionId = "hydra_" + "d".repeat(24);
    const store = new SessionStore();
    await store.write({
      sessionId,
      upstreamSessionId: "upstream_" + sessionId,
      agentId: "claude-code",
      cwd: WORK_CWD,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      summarizedThroughEntry: 5,
      synopsis: {
        goal: "fix bug",
        outcome: "fixed",
      },
      compactionState: {
        status: "swap_deferred",
        requestedAt: Date.now(),
        iter: 1,
        attempts: 1,
      },
      attentionFlags: [],
    });

    const manager = makeManager();
    const scheduleSpy = vi.fn();
    vi.spyOn(manager, "scheduleCompaction").mockImplementation(scheduleSpy);

    await manager.resumePendingCompactions();

    expect(scheduleSpy).toHaveBeenCalledWith(sessionId);
  });

  it("sessions without compactionState are skipped", async () => {
    const sessionId = "hydra_" + "e".repeat(24);
    const store = new SessionStore();
    await store.write({
      sessionId,
      upstreamSessionId: "upstream_" + sessionId,
      agentId: "claude-code",
      cwd: WORK_CWD,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      attentionFlags: [],
    });

    const manager = makeManager();
    const scheduleSpy = vi.fn();
    vi.spyOn(manager, "scheduleCompaction").mockImplementation(scheduleSpy);

    await manager.resumePendingCompactions();

    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("sessions with terminal 'failed' compactionState are NOT auto-resumed", async () => {
    const sessionId = "hydra_" + "f".repeat(24);
    const store = new SessionStore();
    await store.write({
      sessionId,
      upstreamSessionId: "upstream_" + sessionId,
      agentId: "claude-code",
      cwd: WORK_CWD,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      compactionState: {
        status: "failed",
        requestedAt: Date.now() - 60_000,
        iter: 1,
        lastError: "agent returned unparseable JSON",
      },
      attentionFlags: [],
    });

    const manager = makeManager();
    const scheduleSpy = vi.fn();
    vi.spyOn(manager, "scheduleCompaction").mockImplementation(scheduleSpy);

    await manager.resumePendingCompactions();

    expect(scheduleSpy).not.toHaveBeenCalled();
  });
});
