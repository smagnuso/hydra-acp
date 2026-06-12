import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "./session-manager.js";
import { Registry, type RegistryAgent } from "./registry.js";
import { makeMockAgent } from "../__tests__/test-utils.js";
import type { AgentInstanceOptions } from "./agent-instance.js";

const WORK_CWD = mkdtempSync(path.join(os.tmpdir(), "hydra-test-fwdenv-"));

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

interface Captured {
  opts: AgentInstanceOptions;
}

function buildManager(opts?: {
  newSessionId?: string;
  logger?: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
}): {
  manager: SessionManager;
  spawns: Captured[];
} {
  const spawns: Captured[] = [];
  const newSid = opts?.newSessionId ?? "u_new";
  const manager = new SessionManager(
    fakeRegistry([fakeRegistryAgent("claude-code")]),
    (spawnOpts) => {
      spawns.push({ opts: spawnOpts });
      const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
      const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
      // Default: protocolVersion + a session/new style response.
      requestMock
        .mockResolvedValueOnce({ protocolVersion: 1 })
        .mockResolvedValueOnce({ sessionId: newSid });
      return m.agent;
    },
    undefined,
    { logger: opts?.logger },
  );
  return { manager, spawns };
}

describe("SessionManager forwardedEnv plumbing", () => {
  let realCwd: string;
  beforeEach(() => {
    realCwd = process.cwd();
  });

  it("threads forwardedEnv from create() into the spawner extraEnv and persists it on the record", async () => {
    const { manager, spawns } = buildManager();
    const session = await manager.create({
      cwd: realCwd,
      agentId: "claude-code",
      forwardedEnv: { FOO: "bar" },
    });
    expect(spawns[0]?.opts.extraEnv).toEqual({ FOO: "bar" });
    await manager.flushMetaWrites();
    const reloaded = await manager.loadFromDisk(session.sessionId);
    expect(reloaded?.forwardedEnv).toEqual({ FOO: "bar" });
  });

  it("reapplies persisted forwardedEnv on cold-resurrect (load-from-disk → spawn)", async () => {
    const { manager, spawns } = buildManager();
    const session = await manager.create({
      cwd: realCwd,
      agentId: "claude-code",
      forwardedEnv: { FOO: "bar" },
    });
    await manager.flushMetaWrites();
    await session.close({ deleteRecord: false });

    const resurrectParams = await manager.loadFromDisk(session.sessionId);
    expect(resurrectParams?.forwardedEnv).toEqual({ FOO: "bar" });
    await manager.resurrect(resurrectParams!);
    // spawns[0] = original create; spawns[1] = resurrect spawn.
    expect(spawns[1]?.opts.extraEnv).toEqual({ FOO: "bar" });
  });

  it("setForwardedEnv overwrites the persisted map in full (no merge)", async () => {
    const { manager } = buildManager();
    const session = await manager.create({
      cwd: realCwd,
      agentId: "claude-code",
      forwardedEnv: { FOO: "bar" },
    });
    await manager.flushMetaWrites();

    await manager.setForwardedEnv(session.sessionId, { QUX: "q" });
    await manager.flushMetaWrites();

    const reloaded = await manager.loadFromDisk(session.sessionId);
    expect(reloaded?.forwardedEnv).toEqual({ QUX: "q" });
    expect(reloaded?.forwardedEnv?.FOO).toBeUndefined();
  });

  it("setForwardedEnv with the same keys but new values overwrites prior values", async () => {
    const { manager } = buildManager();
    const session = await manager.create({
      cwd: realCwd,
      agentId: "claude-code",
      forwardedEnv: { FOO: "bar" },
    });
    await manager.flushMetaWrites();

    await manager.setForwardedEnv(session.sessionId, { FOO: "baz" });
    await manager.flushMetaWrites();

    const reloaded = await manager.loadFromDisk(session.sessionId);
    expect(reloaded?.forwardedEnv).toEqual({ FOO: "baz" });
  });

  it("setForwardedEnv with empty {} clears the persisted env", async () => {
    const { manager } = buildManager();
    const session = await manager.create({
      cwd: realCwd,
      agentId: "claude-code",
      forwardedEnv: { FOO: "bar" },
    });
    await manager.flushMetaWrites();

    await manager.setForwardedEnv(session.sessionId, {});
    await manager.flushMetaWrites();

    const reloaded = await manager.loadFromDisk(session.sessionId);
    expect(reloaded?.forwardedEnv).toEqual({});
  });

  it("respawnAgent reapplies the in-memory forwardedEnv", async () => {
    const { manager, spawns } = buildManager();
    const session = await manager.create({
      cwd: realCwd,
      agentId: "claude-code",
      forwardedEnv: { FOO: "bar" },
    });
    // respawnAgent is the private kill-and-respawn used by /hydra
    // restart and forceCancel — exercise it directly so the test
    // doesn't depend on the slash-command queue plumbing.
    await (
      session as unknown as { respawnAgent(): Promise<void> }
    ).respawnAgent();
    // spawns[0] = original; spawns[1] = respawn.
    expect(spawns[1]?.opts.extraEnv).toEqual({ FOO: "bar" });
  });

  it("does not write env values to the logger (secret hygiene)", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const { manager } = buildManager({ logger });
    await manager.create({
      cwd: realCwd,
      agentId: "claude-code",
      forwardedEnv: { SECRET: "shh-please-do-not-log" },
    });
    await manager.flushMetaWrites();
    const all = [...logger.info.mock.calls, ...logger.warn.mock.calls]
      .flat()
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join("\n");
    expect(all).not.toContain("shh-please-do-not-log");
  });
});

afterAll(() => {
  rmSync(WORK_CWD, { recursive: true, force: true });
});
