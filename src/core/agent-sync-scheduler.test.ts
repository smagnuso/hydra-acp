import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startAgentSyncScheduler } from "./agent-sync-scheduler.js";
import * as registryMod from "./registry.js";
import type { Registry, RegistryAgent } from "./registry.js";
import type { SessionManager } from "./session-manager.js";

function fakeRegistry(agents: RegistryAgent[]): Registry {
  return {
    async load() {
      return { version: "0", agents };
    },
  } as unknown as Registry;
}

function fakeManager(
  syncFromAgent: (id: string) => Promise<{
    synced: unknown[];
    skipped: number;
  }>,
): SessionManager {
  return { syncFromAgent } as unknown as SessionManager;
}

function mockInstallStates(states: Record<string, "yes" | "no" | "lazy">): void {
  vi.spyOn(registryMod, "agentInstallState").mockImplementation(
    async (a: RegistryAgent) => states[a.id] ?? "no",
  );
}

describe("startAgentSyncScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("skips lazy and uninstalled agents, syncs only 'yes' ones", async () => {
    const agents: RegistryAgent[] = [
      { id: "yes-1", name: "A", distribution: { npx: { package: "a" } } },
      { id: "lazy-1", name: "B", distribution: { uvx: { package: "b" } } },
      { id: "no-1", name: "C", distribution: { npx: { package: "c" } } },
    ];
    mockInstallStates({ "yes-1": "yes", "lazy-1": "lazy", "no-1": "no" });
    const calls: string[] = [];
    const syncFn = vi.fn(async (id: string) => {
      calls.push(id);
      return { synced: [], skipped: 0 };
    });
    const stop = startAgentSyncScheduler({
      registry: fakeRegistry(agents),
      manager: fakeManager(syncFn),
      intervalMs: 1000,
    });
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls.every((c) => c === "yes-1")).toBe(true);
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });

  it("round-robins across multiple installed agents, one per slot", async () => {
    const agents: RegistryAgent[] = [
      { id: "a", name: "A", distribution: { npx: { package: "a" } } },
      { id: "b", name: "B", distribution: { npx: { package: "b" } } },
    ];
    mockInstallStates({ a: "yes", b: "yes" });
    const calls: string[] = [];
    const syncFn = vi.fn(async (id: string) => {
      calls.push(id);
      return { synced: [], skipped: 0 };
    });
    // intervalMs=1000, 2 agents → slotMs=500. First tick at t=1000
    // (boot delay), then every 500ms.
    const stop = startAgentSyncScheduler({
      registry: fakeRegistry(agents),
      manager: fakeManager(syncFn),
      intervalMs: 1000,
    });
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toEqual(["a"]);
      await vi.advanceTimersByTimeAsync(500);
      expect(calls).toEqual(["a", "b"]);
      await vi.advanceTimersByTimeAsync(500);
      expect(calls).toEqual(["a", "b", "a"]);
    } finally {
      stop();
    }
  });

  it("logs and recovers from syncFromAgent failures", async () => {
    const agents: RegistryAgent[] = [
      { id: "broken", name: "X", distribution: { npx: { package: "x" } } },
      { id: "ok", name: "Y", distribution: { npx: { package: "y" } } },
    ];
    mockInstallStates({ broken: "yes", ok: "yes" });
    const calls: string[] = [];
    const syncFn = vi.fn(async (id: string) => {
      calls.push(id);
      if (id === "broken") {
        throw new Error("session/list not supported");
      }
      return { synced: [], skipped: 0 };
    });
    const warns: string[] = [];
    const logger = {
      info: () => undefined,
      warn: (m: string) => warns.push(m),
    };
    const stop = startAgentSyncScheduler({
      registry: fakeRegistry(agents),
      manager: fakeManager(syncFn),
      intervalMs: 1000,
      logger,
    });
    try {
      await vi.advanceTimersByTimeAsync(1500);
      expect(calls).toContain("broken");
      expect(calls).toContain("ok");
      expect(warns.some((w) => w.includes("broken"))).toBe(true);
    } finally {
      stop();
    }
  });

  it("stop() cancels pending ticks", async () => {
    const agents: RegistryAgent[] = [
      { id: "a", name: "A", distribution: { npx: { package: "a" } } },
    ];
    mockInstallStates({ a: "yes" });
    const syncFn = vi.fn(async () => ({ synced: [], skipped: 0 }));
    const stop = startAgentSyncScheduler({
      registry: fakeRegistry(agents),
      manager: fakeManager(syncFn),
      intervalMs: 1000,
    });
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(syncFn).not.toHaveBeenCalled();
  });

  it("when no agents are installed, waits a full interval before retrying", async () => {
    const agents: RegistryAgent[] = [
      { id: "lazy-only", name: "Z", distribution: { uvx: { package: "z" } } },
    ];
    mockInstallStates({ "lazy-only": "lazy" });
    const syncFn = vi.fn(async () => ({ synced: [], skipped: 0 }));
    const stop = startAgentSyncScheduler({
      registry: fakeRegistry(agents),
      manager: fakeManager(syncFn),
      intervalMs: 1000,
    });
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(syncFn).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
