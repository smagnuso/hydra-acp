import { describe, it, expect, vi } from "vitest";
import { homedir } from "node:os";
import * as fs from "node:fs/promises";
import {
  generateAuthToken,
  defaultConfig,
  ensureConfig,
  expandHome,
  loadAuthToken,
  loadConfig,
  writeAuthToken,
  writeConfig,
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

  it("defaults defaultModels to an empty object (no per-agent overrides)", () => {
    expect(defaultConfig().defaultModels).toEqual({});
  });
});

describe("ensureConfig", () => {
  it("writes a fresh auth token when none exists", async () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cfg = await ensureConfig();
    expect(cfg.daemon.authToken.startsWith("hydra_token_")).toBe(true);
    const onDisk = (await fs.readFile(paths.authToken(), "utf8")).trim();
    expect(onDisk).toBe(cfg.daemon.authToken);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not create config.json (defaults are filled in by Zod at load time)", async () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await ensureConfig();
    await expect(fs.access(paths.config())).rejects.toMatchObject({ code: "ENOENT" });
    warn.mockRestore();
  });

  it("returns the existing config without rewriting the token", async () => {
    const token = generateAuthToken();
    await writeAuthToken(token);
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cfg = await ensureConfig();
    expect(cfg.daemon.authToken).toBe(token);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("loadAuthToken", () => {
  it("reads the token from auth-token when present", async () => {
    const token = generateAuthToken();
    await writeAuthToken(token);
    expect(await loadAuthToken()).toBe(token);
  });

  it("returns undefined when neither file has a token", async () => {
    expect(await loadAuthToken()).toBeUndefined();
  });

  it("migrates a legacy daemon.authToken into the auth-token file and strips it from config.json", async () => {
    const legacy = "hydra_token_" + "b".repeat(64);
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(
      paths.config(),
      JSON.stringify({ daemon: { authToken: legacy }, defaultAgent: "opencode" }) + "\n",
      "utf8",
    );
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await loadAuthToken()).toBe(legacy);
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
    await loadAuthToken();
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
    await writeAuthToken(current);
    await expect(loadAuthToken()).rejects.toThrow(/present in both/);
  });
});

describe("loadConfig", () => {
  it("works when config.json is absent (token only)", async () => {
    const token = generateAuthToken();
    await writeAuthToken(token);
    const cfg = await loadConfig();
    expect(cfg.daemon.authToken).toBe(token);
    expect(cfg.daemon.port).toBe(8765);
  });

  it("merges fields from config.json with the token from auth-token", async () => {
    const token = generateAuthToken();
    await writeAuthToken(token);
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(
      paths.config(),
      JSON.stringify({ daemon: { port: 9999 }, defaultAgent: "opencode" }) + "\n",
      "utf8",
    );
    const cfg = await loadConfig();
    expect(cfg.daemon.authToken).toBe(token);
    expect(cfg.daemon.port).toBe(9999);
    expect(cfg.defaultAgent).toBe("opencode");
  });

  it("throws when no token exists at all", async () => {
    await expect(loadConfig()).rejects.toThrow(/No auth token found/);
  });
});

describe("writeConfig", () => {
  it("strips daemon.authToken so config.json stays safe to version-control", async () => {
    const cfg = defaultConfig();
    await writeConfig(cfg);
    const raw = JSON.parse(await fs.readFile(paths.config(), "utf8"));
    expect(raw.daemon.authToken).toBeUndefined();
    expect(raw.daemon.port).toBe(8765);
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
