import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { homedir } from "node:os";
import {
  agentInstallId,
  agentInstallState,
  lookupInheritedAgentValue,
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
      nonInteractiveOrphanTimeoutSeconds: 30,
      sessionHistoryMaxEntries: 1000,
      sessionHistoryArchiveMaxBytes: 10_000_000,
      sessionHistoryArchiveTiers: 10,
      agentStderrTailBytes: 4096,
      agentSyncIntervalMinutes: 0,
      scrubEnv: [],
      sessionGcIntervalMinutes: 0,
      sessionGcMaxAgeDays: 2,
    },
    registry: {
      url: "http://example.invalid/never",
      ttlHours: 24,
      pinned: false,
    },
    defaultAgent: "claude-acp",
    sessionDefaults: {},
    defaultCwd: homedir(),
    compressToolContent: true,
    sessionListColdLimit: 20,
    agents: {},
    agentOverrides: {},
    extensions: {},
    transformers: {},
    defaultTransformers: [],
    tui: {
      composer: {
        top: { left: ["status"], right: ["usage"] },
        bottom: { left: [], right: ["helpHint"] },
        hintTurns: 3,
      },
      sessionbar: { left: ["cwd", "title"], right: ["agentModel"] },
      scriptRefreshMs: 5_000,
      repaintThrottleMs: 1000,
      maxScrollbackLines: 10_000,
      mouse: false,
      logMaxBytes: 5 * 1024 * 1024,
      cwdColumnMaxWidth: 24,
      progressIndicator: true,
      terminalHost: true,
      launcherModeWhenHosted: false,
      skipPermissions: false,
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
      sidebar: { enabled: false, border: "frame" as const, gadgets: [] },
      hotkeys: {},
    },
    compaction: {
      tailK: 0,
      maxIterations: 1,
      contextFraction: 0.5,
      hardCeilingFraction: 0.85,
      absoluteFallback: 120_000,
      idleBeforePromptMs: 300_000,
      modelContextWindows: {},
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
    const before = Date.now();
    const registry = new Registry(fakeConfig());
    seedCache(registry, FIXTURE);
    const at = registry.lastFetchedAt();
    expect(at).toBeTypeOf("number");
    // Bracketed rather than age-bounded: "stamped during this test" is
    // the actual claim, and it stays true however long the machine
    // stalls between these two statements.
    expect(at!).toBeGreaterThanOrEqual(before);
    expect(at!).toBeLessThanOrEqual(Date.now());
  });
});

describe("Registry.load stale fallback", () => {
  it("fires onStaleFallback when the fetch fails and a stale disk cache is served", async () => {
    const doc = { ...FIXTURE, version: "0" };
    const staleMs = 48 * 60 * 60 * 1000;
    await fs.mkdir(path.dirname(paths.registryCache()), { recursive: true });
    await fs.writeFile(
      paths.registryCache(),
      JSON.stringify({ fetchedAt: Date.now() - staleMs, data: doc }),
    );
    const calls: Array<{ err: Error; ageMs: number }> = [];
    const registry = new Registry(fakeConfig(), {
      onStaleFallback: (err, ageMs) => {
        calls.push({ err, ageMs });
      },
    });
    try {
      const loaded = await registry.load();
      expect(loaded.agents.map((a) => a.id)).toContain("claude-acp");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.ageMs).toBeGreaterThanOrEqual(staleMs);
    } finally {
      await fs.rm(paths.registryCache(), { force: true });
    }
  });

  it("survives an onStaleFallback hook that throws", async () => {
    const doc = { ...FIXTURE, version: "0" };
    await fs.mkdir(path.dirname(paths.registryCache()), { recursive: true });
    await fs.writeFile(
      paths.registryCache(),
      JSON.stringify({ fetchedAt: 0, data: doc }),
    );
    const registry = new Registry(fakeConfig(), {
      onStaleFallback: () => {
        throw new Error("hook exploded");
      },
    });
    try {
      const loaded = await registry.load();
      expect(loaded.agents.map((a) => a.id)).toContain("claude-acp");
    } finally {
      await fs.rm(paths.registryCache(), { force: true });
    }
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

  it("falls back to unique-prefix match on id when nothing exact hits", async () => {
    const registry = new Registry(fakeConfig());
    seedCache(registry, FIXTURE);
    expect((await registry.getAgent("claude"))?.id).toBe("claude-acp");
    expect((await registry.getAgent("Claude"))?.id).toBe("claude-acp");
    expect((await registry.getAgent("CODEX"))?.id).toBe("codex-acp");
    expect((await registry.getAgent("cod"))?.id).toBe("codex-acp");
  });

  it("resolves an implied -acp suffix even when the prefix is ambiguous", async () => {
    const registry = new Registry({
      ...fakeConfig(),
      agents: {
        "pi-dev": { command: "pi-dev" },
        "pi-local": { command: "pi-local" },
      },
    });
    seedCache(registry, {
      agents: [
        {
          id: "pi-acp",
          name: "pi ACP",
          distribution: { npx: { package: "pi-acp@0.0.33" } },
        },
      ],
    });
    expect((await registry.getAgent("pi"))?.id).toBe("pi-acp");
    expect((await registry.getAgent("PI"))?.id).toBe("pi-acp");
  });

  it("returns undefined when a prefix matches multiple agents", async () => {
    const registry = new Registry({
      ...fakeConfig(),
    });
    seedCache(registry, {
      agents: [
        {
          id: "codex-acp",
          name: "Codex",
          distribution: { npx: { package: "@zed-industries/codex-acp@0.14.0" } },
        },
        {
          id: "codebuddy-code",
          name: "Codebuddy",
          distribution: { npx: { package: "@codebuddy/codebuddy@1.0.0" } },
        },
      ],
    });
    expect(await registry.getAgent("cod")).toBeUndefined();
    expect(await registry.getAgent("co")).toBeUndefined();
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

  it("appends agentOverrides extraArgs onto a registry agent's npx args", async () => {
    const config: HydraConfig = {
      ...fakeConfig(),
      agentOverrides: {
        "claude-acp": { extraArgs: ["--foo", "bar"] },
      },
    };
    const registry = new Registry(config);
    seedCache(registry, FIXTURE);
    const agent = await registry.getAgent("claude-acp");
    expect(agent?.distribution.npx?.args).toEqual(["--foo", "bar"]);
    // packageSpec/version/installId are untouched when no pin is set.
    expect(agent?.version).toBeUndefined();
    expect(agent?.installId).toBeUndefined();
  });

  it("appends agentOverrides extraArgs onto every platform of a binary distribution", async () => {
    const doc: { agents: RegistryAgent[] } = {
      agents: [
        {
          id: "some-binary-acp",
          name: "Some Binary",
          distribution: {
            binary: {
              "linux-x86_64": { cmd: "run", args: ["--serve"] },
              "darwin-aarch64": { cmd: "run" },
            },
          },
        },
      ],
    };
    const config: HydraConfig = {
      ...fakeConfig(),
      agentOverrides: {
        "some-binary-acp": { extraArgs: ["--enforce_kernel_ipv6_support=false"] },
      },
    };
    const registry = new Registry(config);
    seedCache(registry, doc as typeof FIXTURE);
    const agent = await registry.getAgent("some-binary-acp");
    expect(agent?.distribution.binary?.["linux-x86_64"]?.args).toEqual([
      "--serve",
      "--enforce_kernel_ipv6_support=false",
    ]);
    expect(agent?.distribution.binary?.["darwin-aarch64"]?.args).toEqual([
      "--enforce_kernel_ipv6_support=false",
    ]);
  });

  it("merges agentOverrides env onto a registry agent's npx distribution", async () => {
    const doc: { agents: RegistryAgent[] } = {
      agents: [
        {
          id: "claude-acp",
          name: "Claude",
          distribution: {
            npx: {
              package: "@agentclientprotocol/claude-agent-acp@0.33.1",
              env: { KEEP_ME: "yes", API_TIMEOUT_MS: "1000" },
            },
          },
        },
      ],
    };
    const config: HydraConfig = {
      ...fakeConfig(),
      agentOverrides: {
        "claude-acp": { env: { API_TIMEOUT_MS: "600000" } },
      },
    };
    const registry = new Registry(config);
    seedCache(registry, doc as typeof FIXTURE);
    const agent = await registry.getAgent("claude-acp");
    // Override wins key by key; unrelated keys survive.
    expect(agent?.distribution.npx?.env).toEqual({
      KEEP_ME: "yes",
      API_TIMEOUT_MS: "600000",
    });
    // env alone must not disturb the install identity.
    expect(agent?.version).toBeUndefined();
    expect(agent?.installId).toBeUndefined();
  });

  it("applies agentOverrides env to every platform of a binary distribution", async () => {
    const doc: { agents: RegistryAgent[] } = {
      agents: [
        {
          id: "some-binary-acp",
          name: "Some Binary",
          distribution: {
            binary: {
              "linux-x86_64": { cmd: "run", env: { A: "1" } },
              "darwin-aarch64": { cmd: "run" },
            },
          },
        },
      ],
    };
    const config: HydraConfig = {
      ...fakeConfig(),
      agentOverrides: {
        "some-binary-acp": { env: { B: "2" } },
      },
    };
    const registry = new Registry(config);
    seedCache(registry, doc as typeof FIXTURE);
    const agent = await registry.getAgent("some-binary-acp");
    expect(agent?.distribution.binary?.["linux-x86_64"]?.env).toEqual({
      A: "1",
      B: "2",
    });
    expect(agent?.distribution.binary?.["darwin-aarch64"]?.env).toEqual({
      B: "2",
    });
  });

  it("combines a packageSpec pin with extraArgs on the same override", async () => {
    const config: HydraConfig = {
      ...fakeConfig(),
      agentOverrides: {
        "claude-acp": {
          packageSpec: "@agentclientprotocol/claude-agent-acp@0.99.0",
          extraArgs: ["--foo"],
        },
      },
    };
    const registry = new Registry(config);
    seedCache(registry, FIXTURE);
    const agent = await registry.getAgent("claude-acp");
    expect(agent?.distribution.npx?.package).toBe(
      "@agentclientprotocol/claude-agent-acp@0.99.0",
    );
    expect(agent?.distribution.npx?.args).toEqual(["--foo"]);
    expect(agent?.installId).toBe("claude-acp");
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

  it("round-trips an optional requiredEnv field on agent entries", async () => {
    const doc = {
      version: "1.0.0",
      agents: [
        {
          id: "needs-env",
          name: "Needs Env",
          distribution: { npx: { package: "needs-env@1.0.0" } },
          requiredEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
        },
        {
          id: "plain",
          name: "Plain",
          distribution: { npx: { package: "plain@1.0.0" } },
        },
      ],
    };
    const parsed = RegistryDocument.parse(doc);
    expect(parsed.agents[0]!.requiredEnv).toEqual([
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
    ]);
    expect(parsed.agents[1]!.requiredEnv).toBeUndefined();
  });

  it("rejects malformed requiredEnv shapes", () => {
    const base = {
      id: "a",
      name: "A",
      distribution: { npx: { package: "a@1.0.0" } },
    };
    const wrap = (requiredEnv: unknown) => ({
      version: "1.0.0",
      agents: [{ ...base, requiredEnv }],
    });
    expect(() => RegistryDocument.parse(wrap("OPENAI_API_KEY"))).toThrow();
    expect(() => RegistryDocument.parse(wrap([123]))).toThrow();
    expect(() => RegistryDocument.parse(wrap([""]))).toThrow();
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

const EXTENDS_FIXTURE: { agents: RegistryAgent[] } = {
  agents: [
    {
      id: "opencode",
      name: "opencode",
      description: "from the registry",
      version: "1.2.3",
      distribution: {
        npx: {
          package: "opencode-ai@1.2.3",
          args: ["acp"],
          env: { OPENCODE_BASE: "1" },
        },
      },
    },
    {
      id: "pi-acp",
      name: "pi",
      distribution: { npx: { package: "pi-acp@0.1.0" } },
    },
  ],
};

function extendsRegistry(agents: HydraConfig["agents"]): Registry {
  const registry = new Registry({ ...fakeConfig(), agents });
  seedCache(registry, EXTENDS_FIXTURE);
  return registry;
}

describe("config.agents extends", () => {
  it("merges env onto the base distribution and keeps the base's package", async () => {
    const registry = extendsRegistry({
      "opencode-home": {
        extends: "opencode",
        env: { OPENCODE_CONFIG_DIR: "/tmp/home" },
      },
    });
    const a = await registry.getAgent("opencode-home");
    expect(a?.id).toBe("opencode-home");
    expect(a?.distribution.npx?.package).toBe("opencode-ai@1.2.3");
    expect(a?.distribution.npx?.env).toEqual({
      OPENCODE_BASE: "1",
      OPENCODE_CONFIG_DIR: "/tmp/home",
    });
    // Not overridden, so inherited verbatim.
    expect(a?.distribution.npx?.args).toEqual(["acp"]);
    expect(a?.description).toBe("from the registry");
  });

  it("lets the derived entry win on a key the base also sets", async () => {
    const registry = extendsRegistry({
      "opencode-home": {
        extends: "opencode",
        name: "opencode (home)",
        env: { OPENCODE_BASE: "0" },
        args: ["acp", "--verbose"],
      },
    });
    const a = await registry.getAgent("opencode-home");
    expect(a?.name).toBe("opencode (home)");
    expect(a?.distribution.npx?.env).toEqual({ OPENCODE_BASE: "0" });
    // Arrays replace rather than append.
    expect(a?.distribution.npx?.args).toEqual(["acp", "--verbose"]);
  });

  it("shares the base's install dir when only env is layered", async () => {
    const registry = extendsRegistry({
      "opencode-home": {
        extends: "opencode",
        env: { OPENCODE_CONFIG_DIR: "/tmp/home" },
      },
    });
    const a = await registry.getAgent("opencode-home");
    expect(agentInstallId(a!)).toBe("opencode");
  });

  it("replaces the distribution when the derived entry sets a command", async () => {
    const registry = extendsRegistry({
      "opencode-dev": {
        extends: "opencode",
        command: "/tmp/acp-dev.sh",
      },
    });
    const a = await registry.getAgent("opencode-dev");
    // The trap this guards: planSpawn checks npx before exec, so an
    // inherited npx left in place would silently spawn the base agent
    // and ignore the command entirely.
    expect(a?.distribution.npx).toBeUndefined();
    expect(a?.distribution.exec?.command).toBe("/tmp/acp-dev.sh");
    const plan = await planSpawn(a!);
    expect(plan.command).toBe("/tmp/acp-dev.sh");
    // Its own command means its own install identity.
    expect(agentInstallId(a!)).toBe("opencode-dev");
  });

  it("resolves a base named by its shorthand, and records the canonical id", async () => {
    const registry = extendsRegistry({
      "pi-home": { extends: "pi", env: { PI_CODING_AGENT_DIR: "/tmp/pi" } },
    });
    const a = await registry.getAgent("pi-home");
    expect(a?.extendsChain).toEqual(["pi-home", "pi-acp"]);
  });

  it("composes through a chain of derived agents", async () => {
    const registry = extendsRegistry({
      "pi-dev": { extends: "pi-acp", command: "/tmp/pi-dev.sh" },
      "pi-local": { extends: "pi-dev", name: "pi (local)" },
    });
    const a = await registry.getAgent("pi-local");
    expect(a?.extendsChain).toEqual(["pi-local", "pi-dev", "pi-acp"]);
    expect(a?.name).toBe("pi (local)");
    expect(a?.distribution.exec?.command).toBe("/tmp/pi-dev.sh");
  });

  it("throws on an extends cycle rather than recursing forever", async () => {
    const registry = extendsRegistry({
      a: { extends: "b" },
      b: { extends: "a" },
    });
    await expect(registry.getAgent("a")).rejects.toThrow(/extends cycle/);
  });

  it("throws a named error when the base does not resolve", async () => {
    const registry = extendsRegistry({
      orphan: { extends: "no-such-agent" },
    });
    await expect(registry.getAgent("orphan")).rejects.toThrow(
      /extends "no-such-agent"/,
    );
  });

  it("omits extends entries from localAgents but resolves them in resolvedLocalAgents", async () => {
    const registry = extendsRegistry({
      "opencode-home": { extends: "opencode", env: { X: "1" } },
      standalone: { command: "/tmp/standalone" },
    });
    // localAgents() is sync and can't resolve a base, so a derived entry
    // there would synthesize a bogus exec command from the agent id.
    expect(registry.localAgents().map((a) => a.id)).toEqual(["standalone"]);
    const resolved = await registry.resolvedLocalAgents();
    expect(resolved.map((a) => a.id).sort()).toEqual([
      "opencode-home",
      "standalone",
    ]);
    expect(
      resolved.find((a) => a.id === "opencode-home")?.distribution.npx?.package,
    ).toBe("opencode-ai@1.2.3");
  });

  it("listAgents includes extendsChain for a derived agent, not the base", async () => {
    const registry = extendsRegistry({
      "opencode-home": { extends: "opencode", env: { X: "1" } },
    });
    const listed = await listAgents(registry);
    const derived = listed.agents.find((a) => a.id === "opencode-home");
    const base = listed.agents.find((a) => a.id === "opencode");
    // Clients (e.g. the TUI composer preview) resolve per-agent config
    // maps like sessionDefaults via this chain — see
    // lookupInheritedAgentValue. Losing it here silently breaks that
    // resolution for every derived agent.
    expect(derived?.extendsChain).toEqual(["opencode-home", "opencode"]);
    expect(base?.extendsChain).toBeUndefined();
  });

  it("drops a broken entry from the catalog instead of failing the list", async () => {
    const errors: string[] = [];
    const registry = new Registry(
      {
        ...fakeConfig(),
        agents: {
          broken: { extends: "no-such-agent" },
          fine: { command: "/tmp/fine" },
        },
      },
      { onResolveError: (id) => errors.push(id) },
    );
    seedCache(registry, EXTENDS_FIXTURE);
    const resolved = await registry.resolvedLocalAgents();
    expect(resolved.map((a) => a.id)).toEqual(["fine"]);
    expect(errors).toEqual(["broken"]);
    const listed = await listAgents(registry);
    expect(listed.agents.map((a) => a.id)).toContain("fine");
    expect(listed.agents.map((a) => a.id)).not.toContain("broken");
  });
});

describe("lookupInheritedAgentValue", () => {
  it("prefers the most specific entry and reports which key matched", async () => {
    const registry = extendsRegistry({
      "opencode-home": { extends: "opencode", env: { X: "1" } },
    });
    const a = await registry.getAgent("opencode-home");
    expect(
      lookupInheritedAgentValue(
        { opencode: "base-model", "opencode-home": "own-model" },
        a!,
      ),
    ).toEqual({ value: "own-model", from: "opencode-home" });
  });

  it("walks up to the base when the derived agent has no entry", async () => {
    const registry = extendsRegistry({
      "opencode-home": { extends: "opencode", env: { X: "1" } },
    });
    const a = await registry.getAgent("opencode-home");
    expect(lookupInheritedAgentValue({ opencode: "base-model" }, a!)).toEqual({
      value: "base-model",
      from: "opencode",
    });
  });

  it("returns undefined when nothing in the chain has a value", async () => {
    const registry = extendsRegistry({
      "opencode-home": { extends: "opencode", env: { X: "1" } },
    });
    const a = await registry.getAgent("opencode-home");
    expect(lookupInheritedAgentValue({ other: "x" }, a!)).toBeUndefined();
  });
});
