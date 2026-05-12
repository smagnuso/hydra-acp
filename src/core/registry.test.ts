import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { Registry, planSpawn, type RegistryAgent } from "./registry.js";
import type { HydraConfig } from "./config.js";

const FIXTURE: { agents: RegistryAgent[] } = {
  agents: [
    {
      id: "claude-acp",
      name: "Claude",
      distribution: {
        npx: { package: "@agentclientprotocol/claude-agent-acp@0.33.1" },
      },
    },
    {
      id: "gemini",
      name: "Gemini",
      distribution: {
        npx: { package: "@google/gemini-cli@0.41.2" },
      },
    },
    {
      id: "codex-acp",
      name: "Codex",
      distribution: {
        npx: { package: "@zed-industries/codex-acp@0.14.0" },
      },
    },
  ],
};

function fakeConfig(): HydraConfig {
  return {
    daemon: {
      host: "127.0.0.1",
      port: 8765,
      authToken: "hydra_token_xxx",
      logLevel: "warn",
      sessionIdleTimeoutSeconds: 30,
    },
    registry: {
      url: "http://example.invalid/never",
      ttlHours: 24,
    },
    defaultAgent: "claude-acp",
    defaultCwd: homedir(),
    sessionListColdLimit: 20,
    extensions: {},
    tui: { repaintThrottleMs: 1000, maxScrollbackLines: 10_000 },
  };
}

describe("Registry.getAgent fallback", () => {
  it("matches by exact id first", async () => {
    const registry = new Registry(fakeConfig());
    (registry as unknown as { cache: { fetchedAt: number; data: typeof FIXTURE } }).cache = {
      fetchedAt: Date.now(),
      data: { ...FIXTURE, version: "0" } as never,
    };
    const a = await registry.getAgent("claude-acp");
    expect(a?.id).toBe("claude-acp");
  });

  it("falls back to npx package basename when id miss", async () => {
    const registry = new Registry(fakeConfig());
    (registry as unknown as { cache: { fetchedAt: number; data: typeof FIXTURE } }).cache = {
      fetchedAt: Date.now(),
      data: { ...FIXTURE, version: "0" } as never,
    };
    expect((await registry.getAgent("claude-agent-acp"))?.id).toBe("claude-acp");
    expect((await registry.getAgent("gemini-cli"))?.id).toBe("gemini");
  });

  it("returns undefined when neither id nor package matches", async () => {
    const registry = new Registry(fakeConfig());
    (registry as unknown as { cache: { fetchedAt: number; data: typeof FIXTURE } }).cache = {
      fetchedAt: Date.now(),
      data: { ...FIXTURE, version: "0" } as never,
    };
    expect(await registry.getAgent("not-a-real-thing")).toBeUndefined();
  });
});

describe("planSpawn", () => {
  it("appends extra args to the registry's npx args", () => {
    const plan = planSpawn(FIXTURE.agents[2]!, ["-c", "sandbox_mode=danger-full-access"]);
    expect(plan.command).toBe("npx");
    expect(plan.args).toEqual([
      "-y",
      "@zed-industries/codex-acp@0.14.0",
      "-c",
      "sandbox_mode=danger-full-access",
    ]);
  });

  it("works with no extra args (default)", () => {
    const plan = planSpawn(FIXTURE.agents[0]!);
    expect(plan.args).toEqual(["-y", "@agentclientprotocol/claude-agent-acp@0.33.1"]);
  });
});
