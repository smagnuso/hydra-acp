import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import {
  ensureServiceToken,
  generateServiceToken,
  loadServiceToken,
  readServiceToken,
  rotateServiceToken,
  writeServiceToken,
} from "./service-token.js";
import { paths } from "./paths.js";

describe("generateServiceToken", () => {
  it("returns a hydra_token_-prefixed token with 32 hex bytes", () => {
    const token = generateServiceToken();
    expect(token.startsWith("hydra_token_")).toBe(true);
    const hex = token.slice("hydra_token_".length);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different tokens on subsequent calls", () => {
    expect(generateServiceToken()).not.toBe(generateServiceToken());
  });
});

describe("readServiceToken", () => {
  it("returns the token when the file exists", async () => {
    const token = generateServiceToken();
    await writeServiceToken(token);
    expect(await readServiceToken()).toBe(token);
  });

  it("returns undefined when no file exists", async () => {
    expect(await readServiceToken()).toBeUndefined();
  });

  it("returns undefined for an empty file", async () => {
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(paths.authToken(), "", { encoding: "utf8", mode: 0o600 });
    expect(await readServiceToken()).toBeUndefined();
  });

  it("trims surrounding whitespace and newline", async () => {
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(paths.authToken(), "  hydra_token_abc  \n", {
      encoding: "utf8",
      mode: 0o600,
    });
    expect(await readServiceToken()).toBe("hydra_token_abc");
  });
});

describe("loadServiceToken", () => {
  it("returns the token when present", async () => {
    const token = generateServiceToken();
    await writeServiceToken(token);
    expect(await loadServiceToken()).toBe(token);
  });

  it("throws with an init hint when no token file exists", async () => {
    await expect(loadServiceToken()).rejects.toThrow(/hydra-acp init/);
  });
});

describe("writeServiceToken", () => {
  it("creates the hydra home dir and writes the token with mode 0600", async () => {
    const token = generateServiceToken();
    await writeServiceToken(token);
    const stat = await fs.stat(paths.authToken());
    expect(stat.mode & 0o777).toBe(0o600);
    expect((await fs.readFile(paths.authToken(), "utf8")).trim()).toBe(token);
  });
});

describe("ensureServiceToken", () => {
  it("generates and persists a fresh token when none exists", async () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const token = await ensureServiceToken();
    expect(token.startsWith("hydra_token_")).toBe(true);
    expect((await fs.readFile(paths.authToken(), "utf8")).trim()).toBe(token);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns the existing token without rewriting or warning", async () => {
    const existing = generateServiceToken();
    await writeServiceToken(existing);
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await ensureServiceToken()).toBe(existing);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("rotateServiceToken", () => {
  it("overwrites the on-disk token with a fresh one", async () => {
    const original = generateServiceToken();
    await writeServiceToken(original);
    const rotated = await rotateServiceToken();
    expect(rotated).not.toBe(original);
    expect((await fs.readFile(paths.authToken(), "utf8")).trim()).toBe(rotated);
  });
});
