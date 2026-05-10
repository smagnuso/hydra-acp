import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { homedir } from "node:os";
import {
  generateAuthToken,
  defaultConfig,
  ensureConfig,
  expandHome,
  loadConfig,
  writeConfig,
} from "./config.js";

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
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-acp-cfg-"));
    process.env.HYDRA_ACP_HOME = tmpHome;
  });

  afterEach(async () => {
    delete process.env.HYDRA_ACP_HOME;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("writes a fresh default config when none exists", async () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cfg = await ensureConfig();
    expect(cfg.daemon.authToken.startsWith("hydra_token_")).toBe(true);
    const written = await loadConfig();
    expect(written.daemon.authToken).toBe(cfg.daemon.authToken);
    expect(warn).toHaveBeenCalled();
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
