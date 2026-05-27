import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { registerAgentRoutes } from "./agents.js";
import { Registry, type RegistryAgent } from "../../core/registry.js";
import { SessionManager } from "../../core/session-manager.js";
import { makeMockAgent } from "../../__tests__/test-utils.js";

function npxPackageBasename(a: RegistryAgent): string | undefined {
  const pkg = a.distribution.npx?.package;
  if (!pkg) {
    return undefined;
  }
  const lastSlash = pkg.lastIndexOf("/");
  const afterSlash = lastSlash === -1 ? pkg : pkg.slice(lastSlash + 1);
  const atIdx = afterSlash.lastIndexOf("@");
  return atIdx <= 0 ? afterSlash : afterSlash.slice(0, atIdx);
}

function fakeRegistry(
  agents: RegistryAgent[],
  opts: { fetchedAt?: number } = {},
): Registry {
  return {
    async getAgent(id: string) {
      return (
        agents.find((a) => a.id === id) ??
        agents.find((a) => npxPackageBasename(a) === id)
      );
    },
    async load() {
      return { version: "0", agents };
    },
    async refresh() {
      return { version: "0", agents };
    },
    lastFetchedAt() {
      return opts.fetchedAt;
    },
  } as unknown as Registry;
}

interface Harness {
  app: FastifyInstance;
  baseUrl: string;
}

async function buildHarness(
  agents: RegistryAgent[],
  opts: { fetchedAt?: number } = {},
): Promise<Harness> {
  const manager = new SessionManager(fakeRegistry(agents, opts), () =>
    makeMockAgent({ agentId: "x", cwd: "/w" }).agent,
  );
  const app = Fastify();
  registerAgentRoutes(app, fakeRegistry(agents, opts), manager);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${addr.port}` };
}

describe("agent routes: install", () => {
  let harness: Harness;
  const prevSkip = process.env.HYDRA_ACP_SKIP_NPM_PREFETCH;

  beforeEach(() => {
    // Skip the real npm install during planSpawn — we just want the
    // route to return a plan, not actually shell out to npm.
    process.env.HYDRA_ACP_SKIP_NPM_PREFETCH = "1";
  });

  afterEach(async () => {
    if (prevSkip === undefined) {
      delete process.env.HYDRA_ACP_SKIP_NPM_PREFETCH;
    } else {
      process.env.HYDRA_ACP_SKIP_NPM_PREFETCH = prevSkip;
    }
    await harness.app.close();
  });

  it("returns 404 for an unknown agent id", async () => {
    harness = await buildHarness([]);
    const res = await fetch(`${harness.baseUrl}/v1/agents/nope/install`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("nope");
  });

  it("installs an npx agent and returns the spawn plan", async () => {
    harness = await buildHarness([
      {
        id: "claude-code",
        name: "claude-code",
        version: "1.2.3",
        distribution: { npx: { package: "claude-code" } },
      },
    ]);
    const res = await fetch(
      `${harness.baseUrl}/v1/agents/claude-code/install`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agentId: string;
      version: string;
      distribution: string;
      installed: boolean;
      command: string;
    };
    expect(body).toMatchObject({
      agentId: "claude-code",
      version: "1.2.3",
      distribution: "npx",
      installed: true,
    });
    expect(body.command).toBe("npx");
  });

  it("resolves an agent via npx package basename fallback", async () => {
    harness = await buildHarness([
      {
        id: "claude-code",
        name: "claude-code",
        distribution: { npx: { package: "@anthropic/claude-agent-acp" } },
      },
    ]);
    const res = await fetch(
      `${harness.baseUrl}/v1/agents/claude-agent-acp/install`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentId: string };
    expect(body.agentId).toBe("claude-code");
  });

  it("lists agents with installed state and fetchedAt", async () => {
    const fetchedAt = Date.now() - 5 * 60_000;
    harness = await buildHarness(
      [
        {
          id: "claude-code",
          name: "claude-code",
          version: "1.2.3",
          distribution: { npx: { package: "claude-code" } },
        },
        {
          id: "uvx-only",
          name: "uvx-only",
          distribution: { uvx: { package: "uvx-only" } },
        },
      ],
      { fetchedAt },
    );
    const res = await fetch(`${harness.baseUrl}/v1/agents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      fetchedAt: number;
      agents: { id: string; installed: string }[];
    };
    expect(body.fetchedAt).toBe(fetchedAt);
    const claude = body.agents.find((a) => a.id === "claude-code");
    const uvx = body.agents.find((a) => a.id === "uvx-only");
    expect(claude?.installed).toBe("no");
    expect(uvx?.installed).toBe("lazy");
  });

  it("reports uvx agents as not pre-installable", async () => {
    harness = await buildHarness([
      {
        id: "uvx-only",
        name: "uvx-only",
        distribution: { uvx: { package: "uvx-only" } },
      },
    ]);
    const res = await fetch(`${harness.baseUrl}/v1/agents/uvx-only/install`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      installed: boolean;
      distribution: string;
      message: string;
    };
    expect(body.installed).toBe(false);
    expect(body.distribution).toBe("uvx");
    expect(body.message).toMatch(/uvx/i);
  });
});
