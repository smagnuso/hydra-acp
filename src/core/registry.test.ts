import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { homedir } from "node:os";
import {
  agentInstallState,
  Registry,
  listAgents,
  planSpawn,
  type AgentInstallProgress,
  type RegistryAgent,
  RegistryDocument,
} from "./registry.js";
import { paths } from "./paths.js";
import { currentPlatformKey } from "./binary-install.js";
import type { HydraConfig } from "./config.js";
import { writeExecutable } from "../__tests__/test-utils.js";

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
      logLevel: "warn",
      sessionIdleTimeoutSeconds: 30,
      sessionHistoryMaxEntries: 1000,
      agentStderrTailBytes: 4096,
      agentSyncIntervalMinutes: 0,
      sessionGcIntervalMinutes: 0,
      sessionGcMaxAgeDays: 2,
    },
    registry: {
      url: "http://example.invalid/never",
      ttlHours: 24,
      pinned: false,
    },
    defaultAgent: "claude-acp",
    defaultModels: {},
    synopsisOnClose: false,
    defaultCwd: homedir(),
    compressToolContent: true,
    sessionListColdLimit: 20,
    agents: {},
    agentOverrides: {},
    extensions: {},
    transformers: {},
    defaultTransformers: [],
    tui: {
      repaintThrottleMs: 1000,
      maxScrollbackLines: 10_000,
      mouse: false,
      logMaxBytes: 5 * 1024 * 1024,
      cwdColumnMaxWidth: 24,
      progressIndicator: true,
      defaultEnterAction: "amend" as const,
      showThoughts: true,
      ambiguousWidth: "narrow",
      toolContent: "inline",
      diffContextLines: 3,
      promptHistoryMaxEntries: 2_000,
      maxToolItems: 5,
      maxPlanItems: 5,
      showFileUpdates: "none" as const,
      selectionClipboard: "both" as const,
    },
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

describe("Registry.lastFetchedAt", () => {
  it("returns undefined before load() populates the cache", () => {
    const registry = new Registry(fakeConfig());
    expect(registry.lastFetchedAt()).toBeUndefined();
  });

  it("returns the cache fetchedAt once seeded", () => {
    const registry = new Registry(fakeConfig());
    seedCache(registry, FIXTURE);
    const at = registry.lastFetchedAt();
    expect(at).toBeTypeOf("number");
    expect(Date.now() - at!).toBeLessThan(1000);
  });
});

describe("agentInstallState", () => {
  it("returns 'lazy' for uvx-only agents", async () => {
    const agent: RegistryAgent = {
      id: "uvx-only",
      name: "Uvx Only",
      distribution: { uvx: { package: "uvx-only" } },
    };
    expect(await agentInstallState(agent)).toBe("lazy");
  });

  it("returns 'no' for an npx agent that has not been pre-installed", async () => {
    const agent: RegistryAgent = {
      id: "claude-acp",
      name: "Claude",
      distribution: {
        npx: { package: "@agentclientprotocol/claude-agent-acp@0.33.1" },
      },
    };
    expect(await agentInstallState(agent)).toBe("no");
  });
});

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
  it("uses caller args after the npx package when registry has no args", async () => {
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

  it("caller args replace the registry's npx args when both are present", async () => {
    const agent: RegistryAgent = {
      id: "with-default-args",
      name: "With Default Args",
      distribution: {
        npx: { package: "some-pkg@1", args: ["--acp"] },
      },
    };
    const plan = await planSpawn(agent, ["--something-else"]);
    expect(plan.args).toEqual(["-y", "some-pkg@1", "--something-else"]);
  });

  it("falls back to the registry's npx args when caller passes none", async () => {
    const agent: RegistryAgent = {
      id: "with-default-args",
      name: "With Default Args",
      distribution: {
        npx: { package: "some-pkg@1", args: ["--acp"] },
      },
    };
    const plan = await planSpawn(agent);
    expect(plan.args).toEqual(["-y", "some-pkg@1", "--acp"]);
  });

  it(
    "forwards binary-install progress through onInstallProgress, tagged with source='binary'",
    { timeout: 15_000 },
    async () => {
      if (process.platform === "win32") {
        return;
      }
      const platformKey = currentPlatformKey();
      if (!platformKey) {
        return;
      }
      const stage = await fs.mkdtemp(
        path.join(os.tmpdir(), "planSpawn-progress-"),
      );
      try {
        // Build a tarball at the test fixture location and serve it
        // over http so planSpawn's binary path actually downloads.
        const payloadDir = path.join(stage, "payload");
        await fs.mkdir(payloadDir);
        await fs.writeFile(
          path.join(payloadDir, "planbin"),
          "#!/bin/sh\nexit 0\n",
        );
        const archive = path.join(stage, "planspawn-1.0.0.tar.gz");
        await runArchive("tar", ["-czf", archive, "-C", payloadDir, "planbin"]);

        const server = http.createServer((req, res) => {
          if (req.url !== "/planspawn-1.0.0.tar.gz") {
            res.statusCode = 404;
            res.end();
            return;
          }
          fs.readFile(archive).then((buf) => {
            res.setHeader("content-length", String(buf.length));
            res.end(buf);
          });
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
          const addr = server.address();
          if (!addr || typeof addr === "string") {
            throw new Error("no server addr");
          }
          const url = `http://127.0.0.1:${addr.port}/planspawn-1.0.0.tar.gz`;
          const agent: RegistryAgent = {
            id: "planspawn-binary",
            name: "PlanSpawn Binary",
            version: "1.0.0",
            distribution: {
              binary: {
                [platformKey]: { archive: url, cmd: "./planbin" },
              },
            },
          };
          const events: AgentInstallProgress[] = [];
          await planSpawn(agent, [], {
            onInstallProgress: (e) => events.push(e),
          });
          // Every event must carry source="binary"; the registry must
          // never leak a typo'd source onto npm events into the binary
          // channel or vice versa.
          expect(events.length).toBeGreaterThan(0);
          for (const e of events) {
            expect(e.source).toBe("binary");
          }
          const phases = events.map((e) => e.phase);
          expect(phases[0]).toBe("download_start");
          expect(phases[phases.length - 1]).toBe("installed");
        } finally {
          server.close();
          await once(server, "close");
        }
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
      }
    },
  );

  it("forwards npm-install progress through onInstallProgress, tagged with source='npm'", async () => {
    // Sandbox a fake `npm` that mimics a successful install. We rely
    // on PATH manipulation rather than mocking the spawn API so the
    // actual subprocess plumbing in npm-install runs.
    //
    // The global vitest.setup.ts pins HYDRA_ACP_SKIP_NPM_PREFETCH=1 so
    // most tests get the legacy `npx -y` plan (no actual install).
    // Override here so planSpawn takes the ensureNpmPackage branch and
    // emits the progress events we're testing.
    const sandbox = await fs.mkdtemp(
      path.join(process.env.HYDRA_ACP_HOME!, "planspawn-npm-"),
    );
    const fakeNpm = path.join(sandbox, "npm");
    // Restore /bin:/usr/bin so mkdir/touch/chmod resolve inside the
    // script even though the outer PATH is scoped to the sandbox.
    await writeExecutable(
      fakeNpm,
      "#!/bin/sh\nexport PATH=/bin:/usr/bin\nmkdir -p node_modules/.bin\ntouch node_modules/.bin/planspawn-npm-bin\nchmod +x node_modules/.bin/planspawn-npm-bin\nexit 0\n",
    );
    const originalPath = process.env.PATH;
    const originalSkip = process.env.HYDRA_ACP_SKIP_NPM_PREFETCH;
    process.env.PATH = sandbox;
    delete process.env.HYDRA_ACP_SKIP_NPM_PREFETCH;
    try {
      const agent: RegistryAgent = {
        id: "planspawn-npm",
        name: "PlanSpawn npm",
        version: "1.0.0",
        distribution: {
          npx: { package: "planspawn-pkg", bin: "planspawn-npm-bin" },
        },
      };
      const events: AgentInstallProgress[] = [];
      await planSpawn(agent, [], {
        onInstallProgress: (e) => events.push(e),
      });
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(e.source).toBe("npm");
      }
      const phases = events.map((e) => e.phase);
      expect(phases).toContain("install_start");
      expect(phases[phases.length - 1]).toBe("installed");
    } finally {
      if (originalPath !== undefined) {
        process.env.PATH = originalPath;
      }
      if (originalSkip !== undefined) {
        process.env.HYDRA_ACP_SKIP_NPM_PREFETCH = originalSkip;
      }
    }
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

describe("local agents and pin overrides", () => {
  it("planSpawn handles an exec distribution directly", async () => {
    const agent: RegistryAgent = {
      id: "my-opencode",
      name: "System opencode",
      version: "local",
      distribution: {
        exec: { command: "opencode", args: ["acp"], env: { FOO: "bar" } },
      },
    };
    const plan = await planSpawn(agent);
    expect(plan).toMatchObject({
      command: "opencode",
      args: ["acp"],
      env: { FOO: "bar" },
      version: "local",
    });
  });

  it("getAgent synthesizes a config-defined local agent without the network", async () => {
    const config: HydraConfig = {
      ...fakeConfig(),
      agents: {
        "my-opencode": { name: "System opencode", command: "opencode", args: ["acp"] },
      },
    };
    const registry = new Registry(config);
    const agent = await registry.getAgent("my-opencode");
    expect(agent?.distribution.exec).toEqual({
      command: "opencode",
      args: ["acp"],
      env: undefined,
    });
    expect(agent?.version).toBe("local");
  });

  it("defaults a local agent's command to the agent id when omitted", async () => {
    const config: HydraConfig = {
      ...fakeConfig(),
      agents: { opencode: {} },
    };
    const registry = new Registry(config);
    const agent = await registry.getAgent("opencode");
    expect(agent?.distribution.exec?.command).toBe("opencode");
  });

  it("listAgents surfaces local agents even when the registry is unreachable", async () => {
    const config: HydraConfig = {
      ...fakeConfig(),
      registry: { url: "http://127.0.0.1:0/never", ttlHours: 24, pinned: false },
      agents: { local1: { command: "foo" } },
    };
    const registry = new Registry(config);
    const result = await listAgents(registry);
    const ids = result.agents.map((a) => a.id);
    expect(ids).toContain("local1");
    const local = result.agents.find((a) => a.id === "local1");
    expect(local?.installed).toBe("yes");
    expect(local?.distributions).toContain("exec");
    expect(local?.source).toBe("local");
  });

  it("a local agent shadows a same-id registry agent", async () => {
    const doc = JSON.stringify({
      version: "1.0.0",
      agents: [
        {
          id: "opencode",
          name: "Registry opencode",
          distribution: { npx: { package: "opencode-ai" } },
        },
      ],
    });
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(doc);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no server addr");
    }
    const url = `http://127.0.0.1:${addr.port}/registry.json`;
    try {
      const config: HydraConfig = {
        ...fakeConfig(),
        registry: { url, ttlHours: 24, pinned: false },
        agents: {
          opencode: { name: "System opencode", command: "opencode", args: ["acp"] },
        },
      };
      const registry = new Registry(config);
      const agent = await registry.getAgent("opencode");
      expect(agent?.name).toBe("System opencode");
      expect(agent?.distribution.exec?.command).toBe("opencode");

      const list = await listAgents(registry);
      const matches = list.agents.filter((a) => a.id === "opencode");
      expect(matches).toHaveLength(1);
      expect(matches[0]?.name).toBe("System opencode");
      expect(matches[0]?.distributions).toContain("exec");
      expect(matches[0]?.source).toBe("local");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("derives a pinned install-dir version key from a packageSpec", async () => {
    const pinned: RegistryAgent = {
      id: "opencode",
      name: "opencode",
      version: versionKeyForTest("opencode-ai@0.5.12"),
      distribution: { npx: { package: "opencode-ai@0.5.12" } },
    };
    process.env.HYDRA_ACP_SKIP_NPM_PREFETCH = "1";
    const plan = await planSpawn(pinned);
    delete process.env.HYDRA_ACP_SKIP_NPM_PREFETCH;
    expect(plan.command).toBe("npx");
    expect(plan.args).toEqual(["-y", "opencode-ai@0.5.12"]);
    expect(plan.version).toBe("pin-0.5.12");
  });
});

// Mirror of registry.ts versionKeyFromSpec for assertion in the pin test.
function versionKeyForTest(spec: string): string {
  const lastAt = spec.lastIndexOf("@");
  const version = lastAt > 0 ? spec.slice(lastAt + 1) : "";
  const sanitized = version.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.length > 0 ? `pin-${sanitized}` : "pinned";
}

describe("Registry disk cache", () => {
  function configForUrl(url: string): HydraConfig {
    return {
      ...fakeConfig(),
      registry: { url, ttlHours: 24, pinned: false },
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

  it("round-trips an optional onboarding field on agent entries", async () => {
    const doc = {
      version: "1.0.0",
      agents: [
        {
          id: "needs-auth",
          name: "Needs Auth",
          distribution: { npx: { package: "needs-auth@1.0.0" } },
          onboarding: {
            command: "needs-auth login",
            url: "https://example.com/auth",
            description: "Run `needs-auth login` to authenticate.",
          },
        },
        {
          id: "plain",
          name: "Plain",
          distribution: { npx: { package: "plain@1.0.0" } },
        },
      ],
    };
    const parsed = RegistryDocument.parse(doc);
    expect(parsed.agents[0]!.onboarding).toEqual({
      command: "needs-auth login",
      url: "https://example.com/auth",
      description: "Run `needs-auth login` to authenticate.",
    });
    expect(parsed.agents[1]!.onboarding).toBeUndefined();
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

function runArchive(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}
