import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import { once } from "node:events";
import { homedir } from "node:os";
import { Registry, planSpawn, type RegistryAgent } from "./registry.js";
import { paths } from "./paths.js";
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

type CacheShape = { fetchedAt: number; raw: unknown; data: typeof FIXTURE };
function seedCache(registry: Registry, fixture: typeof FIXTURE): void {
  const doc = { ...fixture, version: "0" };
  (registry as unknown as { cache: CacheShape }).cache = {
    fetchedAt: Date.now(),
    raw: doc,
    data: doc as never,
  };
}

describe("Registry.getAgent fallback", () => {
  it("matches by exact id first", async () => {
    const registry = new Registry(fakeConfig());
    seedCache(registry, FIXTURE);
    const a = await registry.getAgent("claude-acp");
    expect(a?.id).toBe("claude-acp");
  });

  it("falls back to npx package basename when id miss", async () => {
    const registry = new Registry(fakeConfig());
    seedCache(registry, FIXTURE);
    expect((await registry.getAgent("claude-agent-acp"))?.id).toBe("claude-acp");
    expect((await registry.getAgent("gemini-cli"))?.id).toBe("gemini");
  });

  it("returns undefined when neither id nor package matches", async () => {
    const registry = new Registry(fakeConfig());
    seedCache(registry, FIXTURE);
    expect(await registry.getAgent("not-a-real-thing")).toBeUndefined();
  });
});

describe("planSpawn", () => {
  it("appends extra args to the registry's npx args", async () => {
    const plan = await planSpawn(FIXTURE.agents[2]!, [
      "-c",
      "sandbox_mode=danger-full-access",
    ]);
    expect(plan.command).toBe("npx");
    expect(plan.args).toEqual([
      "-y",
      "@zed-industries/codex-acp@0.14.0",
      "-c",
      "sandbox_mode=danger-full-access",
    ]);
  });

  it("works with no extra args (default)", async () => {
    const plan = await planSpawn(FIXTURE.agents[0]!);
    expect(plan.args).toEqual([
      "-y",
      "@agentclientprotocol/claude-agent-acp@0.33.1",
    ]);
  });

  it("rejects a binary agent that has no target for the current platform", async () => {
    const agent: RegistryAgent = {
      id: "binary-only-windows",
      name: "Binary Only Windows",
      version: "0.0.1",
      distribution: {
        binary: {
          "windows-x86_64": {
            archive: "https://example.invalid/foo.zip",
            cmd: "foo.exe",
          },
        },
      },
    };
    // The current test host is linux/darwin; the agent only advertises
    // windows, so we should fail with a clear message instead of trying
    // to download.
    if (process.platform === "win32") {
      return;
    }
    await expect(planSpawn(agent)).rejects.toThrow(/no binary distribution/);
  });
});

describe("Registry disk cache", () => {
  function configForUrl(url: string): HydraConfig {
    return {
      ...fakeConfig(),
      registry: { url, ttlHours: 24 },
    };
  }

  async function serve(body: string): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(body);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no server addr");
    }
    return {
      url: `http://127.0.0.1:${addr.port}/registry.json`,
      close: async () => {
        server.close();
        await once(server, "close");
      },
    };
  }

  it("preserves unknown fields on disk across a fetch/read round-trip", async () => {
    // A future registry schema gains "experimental.flags". The current
    // zod schema doesn't list it, so a naive cache that wrote
    // RegistryDocument.parse(json) would strip it. The fix: persist the
    // raw response body.
    const future = {
      version: "1.0.0",
      agents: [
        {
          id: "future-agent",
          name: "Future Agent",
          distribution: { npx: { package: "future-pkg@1.0.0" } },
          experimental: { flags: ["unstable-thing"] },
        },
      ],
      experimentalRoot: "yes",
    };
    const { url, close } = await serve(JSON.stringify(future));
    try {
      const r = new Registry(configForUrl(url));
      await r.load();
      const text = await fs.readFile(paths.registryCache(), "utf8");
      const onDisk = JSON.parse(text) as { data: typeof future };
      expect(onDisk.data.experimentalRoot).toBe("yes");
      expect(onDisk.data.agents[0]!).toMatchObject({
        experimental: { flags: ["unstable-thing"] },
      });
    } finally {
      await close();
    }
  });

  it("writes atomically — no .tmp- siblings remain after a successful write", async () => {
    const fixture = { version: "1.0.0", agents: [] };
    const { url, close } = await serve(JSON.stringify(fixture));
    try {
      const r = new Registry(configForUrl(url));
      await r.refresh();
      const entries = await fs.readdir(paths.home());
      const stragglers = entries.filter((e) =>
        e.startsWith("registry.json.tmp-"),
      );
      expect(stragglers).toEqual([]);
      // And the final file is present and parseable.
      const text = await fs.readFile(paths.registryCache(), "utf8");
      expect(JSON.parse(text).data.version).toBe("1.0.0");
    } finally {
      await close();
    }
  });

  it("self-heals from a corrupted on-disk cache by re-fetching", async () => {
    const fixture = { version: "1.0.0", agents: [] };
    const { url, close } = await serve(JSON.stringify(fixture));
    try {
      await fs.mkdir(paths.home(), { recursive: true });
      // Truncated mid-write — JSON.parse would throw.
      await fs.writeFile(
        paths.registryCache(),
        '{"fetchedAt":123,"data":{"versi',
        "utf8",
      );
      const r = new Registry(configForUrl(url));
      // Should not throw — readDiskCache treats unparseable bytes as
      // missing and falls through to fetchFromNetwork.
      const doc = await r.load();
      expect(doc.version).toBe("1.0.0");
      // And the corrupted file got replaced by a valid one.
      const text = await fs.readFile(paths.registryCache(), "utf8");
      expect(JSON.parse(text).data.version).toBe("1.0.0");
    } finally {
      await close();
    }
  });
});
