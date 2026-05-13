import { describe, it, expect, vi } from "vitest";
import { homedir } from "node:os";
import * as fs from "node:fs/promises";
import {
  generateAuthToken,
  defaultConfig,
  ensureConfig,
  expandHome,
  loadConfig,
  updateConfigField,
  writeConfig,
  writeMinimalInitConfig,
} from "./config.js";
import { paths } from "./paths.js";

describe("generateAuthToken", () => {
  it("returns a hydra_token_-prefixed token with 32 hex bytes", () => {
    const token = generateAuthToken();
    expect(token.startsWith("hydra_token_")).toBe(true);
    const hex = token.slice("hydra_token_".length);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different tokens on subsequent calls", () => {
    expect(generateAuthToken()).not.toBe(generateAuthToken());
  });
});

describe("defaultConfig", () => {
  it("emits a config that validates and includes a fresh token", () => {
    const cfg = defaultConfig();
    expect(cfg.daemon.authToken.startsWith("hydra_token_")).toBe(true);
    expect(cfg.daemon.host).toBe("127.0.0.1");
    expect(cfg.daemon.port).toBe(8765);
    expect(cfg.registry.url).toContain("agentclientprotocol.com");
  });

  it("defaults defaultCwd to the literal '~' (expanded at use time)", () => {
    expect(defaultConfig().defaultCwd).toBe("~");
  });
});

describe("ensureConfig", () => {
  it("writes a fresh default config when none exists", async () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cfg = await ensureConfig();
    expect(cfg.daemon.authToken.startsWith("hydra_token_")).toBe(true);
    const written = await loadConfig();
    expect(written.daemon.authToken).toBe(cfg.daemon.authToken);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("only writes required fields to disk (no Zod defaults baked in)", async () => {
    // Regression: writing all defaults on init means raising a default
    // later (e.g. sessionIdleTimeoutSeconds) silently doesn't reach
    // existing users.
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await ensureConfig();
    const raw = JSON.parse(await fs.readFile(paths.config(), "utf8"));
    expect(Object.keys(raw)).toEqual(["daemon"]);
    expect(Object.keys(raw.daemon)).toEqual(["authToken"]);
    warn.mockRestore();
  });

  it("returns the existing config without rewriting it", async () => {
    const initial = defaultConfig();
    await writeConfig(initial);
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cfg = await ensureConfig();
    expect(cfg.daemon.authToken).toBe(initial.daemon.authToken);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("updateConfigField", () => {
  it("preserves the user's existing field set (no Zod defaults baked in)", async () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await ensureConfig();
    warn.mockRestore();
    await updateConfigField((raw) => {
      const daemon = (raw.daemon ??= {}) as Record<string, unknown>;
      daemon.authToken = "hydra_token_" + "0".repeat(64);
    });
    const raw = JSON.parse(await fs.readFile(paths.config(), "utf8"));
    expect(Object.keys(raw)).toEqual(["daemon"]);
    expect(Object.keys(raw.daemon)).toEqual(["authToken"]);
    expect(raw.daemon.authToken).toBe("hydra_token_" + "0".repeat(64));
  });
});

describe("writeMinimalInitConfig", () => {
  it("writes only daemon.authToken to disk", async () => {
    const cfg = await writeMinimalInitConfig();
    const raw = JSON.parse(await fs.readFile(paths.config(), "utf8"));
    expect(raw).toEqual({ daemon: { authToken: cfg.daemon.authToken } });
  });

  it("accepts an explicit token", async () => {
    const token = "hydra_token_" + "a".repeat(64);
    const cfg = await writeMinimalInitConfig(token);
    expect(cfg.daemon.authToken).toBe(token);
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
