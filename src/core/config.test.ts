import { describe, it, expect, vi } from "vitest";
import { homedir } from "node:os";
import * as fs from "node:fs/promises";
import {
  DEFAULT_DAEMON_PORT,
  HydraConfig,
  defaultConfig,
  expandHome,
  loadConfig,
  migrateLegacyAuthToken,
  writeConfig,
} from "./config.js";
import type { CompactionConfig } from "./config.js";
import { paths } from "./paths.js";

describe("defaultConfig", () => {
  it("emits a config with the expected daemon defaults", () => {
    const cfg = defaultConfig();
    expect(cfg.daemon.host).toBe("127.0.0.1");
    expect(cfg.daemon.port).toBe(DEFAULT_DAEMON_PORT);
    expect(cfg.registry.url).toContain("agentclientprotocol.com");
  });

  it("defaults defaultCwd to the literal '~' (expanded at use time)", () => {
    expect(defaultConfig().defaultCwd).toBe("~");
  });

  it("defaults defaultModels to an empty object (no per-agent overrides)", () => {
    expect(defaultConfig().defaultModels).toEqual({});
  });

  it("leaves tui.sessionColumns unset by default", () => {
    expect(defaultConfig().tui.sessionColumns).toBeUndefined();
  });
});

describe("tui.sessionColumns schema", () => {
  it("accepts a valid ordered column list", () => {
    const cfg = HydraConfig.parse({
      tui: { sessionColumns: ["session", "title", "state"] },
    });
    expect(cfg.tui.sessionColumns).toEqual(["session", "title", "state"]);
  });

  it("rejects an unknown column name", () => {
    expect(() =>
      HydraConfig.parse({ tui: { sessionColumns: ["session", "bogus"] } }),
    ).toThrow();
  });

  it("rejects an empty array", () => {
    expect(() =>
      HydraConfig.parse({ tui: { sessionColumns: [] } }),
    ).toThrow();
  });
});

describe("loadConfig", () => {
  it("works when config.json is absent (returns defaults)", async () => {
    const cfg = await loadConfig();
    expect(cfg.daemon.port).toBe(DEFAULT_DAEMON_PORT);
    expect(cfg.daemon.host).toBe("127.0.0.1");
  });

  it("applies fields from config.json", async () => {
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(
      paths.config(),
      JSON.stringify({ daemon: { port: 9999 }, defaultAgent: "opencode" }) + "\n",
      "utf8",
    );
    const cfg = await loadConfig();
    expect(cfg.daemon.port).toBe(9999);
    expect(cfg.defaultAgent).toBe("opencode");
  });

  it("silently drops a legacy daemon.authToken field (Zod strips unknowns) but still heals it to disk", async () => {
    const legacy = "hydra_token_" + "f".repeat(64);
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(
      paths.config(),
      JSON.stringify({ daemon: { port: 9000, authToken: legacy } }) + "\n",
      "utf8",
    );
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cfg = await loadConfig();
    expect((cfg.daemon as Record<string, unknown>).authToken).toBeUndefined();
    expect(cfg.daemon.port).toBe(9000);
    // Migration moved the legacy token to the auth-token file and rewrote config.json.
    expect((await fs.readFile(paths.authToken(), "utf8")).trim()).toBe(legacy);
    const raw = JSON.parse(await fs.readFile(paths.config(), "utf8"));
    expect(raw.daemon?.authToken).toBeUndefined();
    expect(raw.daemon?.port).toBe(9000);
    warn.mockRestore();
  });
});

describe("migrateLegacyAuthToken", () => {
  it("is a no-op when no legacy field is present", async () => {
    await migrateLegacyAuthToken();
    await expect(fs.access(paths.authToken())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("moves a legacy token to the auth-token file and strips it from config.json", async () => {
    const legacy = "hydra_token_" + "b".repeat(64);
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(
      paths.config(),
      JSON.stringify({ daemon: { authToken: legacy }, defaultAgent: "opencode" }) + "\n",
      "utf8",
    );
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await migrateLegacyAuthToken();
    expect((await fs.readFile(paths.authToken(), "utf8")).trim()).toBe(legacy);
    const raw = JSON.parse(await fs.readFile(paths.config(), "utf8"));
    expect(raw.daemon).toBeUndefined();
    expect(raw.defaultAgent).toBe("opencode");
    warn.mockRestore();
  });

  it("leaves config.json as {} when the legacy daemon block only held the token", async () => {
    const legacy = "hydra_token_" + "e".repeat(64);
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(
      paths.config(),
      JSON.stringify({ daemon: { authToken: legacy } }) + "\n",
      "utf8",
    );
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await migrateLegacyAuthToken();
    const raw = JSON.parse(await fs.readFile(paths.config(), "utf8"));
    expect(raw).toEqual({});
    warn.mockRestore();
  });

  it("throws when both auth-token and legacy daemon.authToken are set", async () => {
    const legacy = "hydra_token_" + "c".repeat(64);
    const current = "hydra_token_" + "d".repeat(64);
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(
      paths.config(),
      JSON.stringify({ daemon: { authToken: legacy } }) + "\n",
      "utf8",
    );
    await fs.writeFile(paths.authToken(), current + "\n", {
      mode: 0o600,
    });
    await expect(migrateLegacyAuthToken()).rejects.toThrow(/present in both/);
  });
});

describe("writeConfig", () => {
  it("round-trips a config to and from disk", async () => {
    const cfg = defaultConfig();
    await writeConfig(cfg);
    const raw = JSON.parse(await fs.readFile(paths.config(), "utf8"));
    expect(raw.daemon.port).toBe(DEFAULT_DAEMON_PORT);
    expect(raw.defaultAgent).toBe("opencode");
  });
});

describe("loadConfig with a broken config symlink", () => {
  it("throws instead of returning defaults when config.json is a dangling symlink", async () => {
    await fs.mkdir(paths.home(), { recursive: true });
    // Clear any regular config.json a prior test left behind.
    await fs.rm(paths.config(), { force: true });
    const missingTarget = `${paths.home()}/does-not-exist-target.json`;
    await fs.symlink(missingTarget, paths.config());
    try {
      await expect(loadConfig()).rejects.toThrow(/broken symlink/);
    } finally {
      await fs.rm(paths.config(), { force: true });
    }
  });
});

describe("compaction config", () => {
  it("defaults tailK to 20", () => {
    const cfg = defaultConfig();
    expect(cfg.compaction.tailK).toBe(20);
  });

  it("defaults maxIterations to 3", () => {
    const cfg = defaultConfig();
    expect(cfg.compaction.maxIterations).toBe(3);
  });

  it("parses from an empty object", () => {
    const cfg = HydraConfig.parse({ compaction: {} });
    expect(cfg.compaction.tailK).toBe(20);
    expect(cfg.compaction.maxIterations).toBe(3);
  });

  it("accepts explicit tailK and maxIterations", () => {
    const cfg = HydraConfig.parse({
      compaction: { tailK: 50, maxIterations: 10 },
    });
    expect(cfg.compaction.tailK).toBe(50);
    expect(cfg.compaction.maxIterations).toBe(10);
  });

  it("omits compaction entirely and still defaults", () => {
    const cfg = HydraConfig.parse({});
    expect(cfg.compaction.tailK).toBe(20);
    expect(cfg.compaction.maxIterations).toBe(3);
  });

  it("rejects a negative tailK", () => {
    expect(() =>
      HydraConfig.parse({ compaction: { tailK: -1 } }),
    ).toThrow();
  });

  it("rejects a non-integer tailK", () => {
    expect(() =>
      HydraConfig.parse({ compaction: { tailK: 1.5 } }),
    ).toThrow();
  });

  it("accepts tailK of zero", () => {
    const cfg = HydraConfig.parse({ compaction: { tailK: 0 } });
    expect(cfg.compaction.tailK).toBe(0);
  });

  it("rejects a non-positive maxIterations", () => {
    expect(() =>
      HydraConfig.parse({ compaction: { maxIterations: 0 } }),
    ).toThrow();
  });

  it("rejects a negative maxIterations", () => {
    expect(() =>
      HydraConfig.parse({ compaction: { maxIterations: -5 } }),
    ).toThrow();
  });

  it("rejects a non-integer maxIterations", () => {
    expect(() =>
      HydraConfig.parse({ compaction: { maxIterations: 2.7 } }),
    ).toThrow();
  });

  it("CompactionConfig type is available", () => {
    const c: CompactionConfig = {
      tailK: 10,
      maxIterations: 5,
      contextFraction: 0.5,
      hardCeilingFraction: 0.85,
      absoluteFallback: 120_000,
      idleBeforePromptMs: 300_000,
      modelContextWindows: {},
    };
    expect(c.tailK).toBe(10);
  });

  it("compaction.agent and compaction.model parse correctly when set", () => {
    const cfg = HydraConfig.parse({
      compaction: { agent: "compact-agent", model: "gpt-5-turbo" },
    });
    expect(cfg.compaction.agent).toBe("compact-agent");
    expect(cfg.compaction.model).toBe("gpt-5-turbo");
  });

  it("compaction.agent and compaction.model are optional when omitted", () => {
    const cfg = HydraConfig.parse({ compaction: {} });
    expect(cfg.compaction.agent).toBeUndefined();
    expect(cfg.compaction.model).toBeUndefined();
  });
});

describe("expandHome", () => {
  const home = homedir();

  it("expands a bare ~", () => {
    expect(expandHome("~")).toBe(home);
  });

  it("expands ~/foo", () => {
    expect(expandHome("~/dev/foo")).toBe(`${home}/dev/foo`);
  });

  it("expands a bare $HOME", () => {
    expect(expandHome("$HOME")).toBe(home);
  });

  it("expands $HOME/foo", () => {
    expect(expandHome("$HOME/dev/foo")).toBe(`${home}/dev/foo`);
  });

  it("passes absolute paths through unchanged", () => {
    expect(expandHome("/var/log")).toBe("/var/log");
  });

  it("does not expand a tilde mid-string", () => {
    expect(expandHome("/tmp/~oddname")).toBe("/tmp/~oddname");
  });
});
