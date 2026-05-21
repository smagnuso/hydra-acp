import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateLocalCwd } from "./cwd.js";

describe("validateLocalCwd", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-cwd-test-"));
    tmpFile = path.join(tmpDir, "file.txt");
    await fs.writeFile(tmpFile, "hi");
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("accepts an existing directory and returns its absolute path", async () => {
    const result = await validateLocalCwd(tmpDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(path.resolve(tmpDir));
    }
  });

  it("expands ~ to the home directory", async () => {
    const result = await validateLocalCwd("~");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(path.resolve(os.homedir()));
    }
  });

  it("expands ~/... to the absolute path under home", async () => {
    const result = await validateLocalCwd("~");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(os.homedir());
    }
  });

  it("rejects empty input", async () => {
    const result = await validateLocalCwd("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/empty/);
    }
  });

  it("rejects whitespace-only input", async () => {
    const result = await validateLocalCwd("   ");
    expect(result.ok).toBe(false);
  });

  it("rejects a path that does not exist", async () => {
    const ghost = path.join(tmpDir, "does-not-exist");
    const result = await validateLocalCwd(ghost);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/does not exist/);
    }
  });

  it("rejects a path that is a file, not a directory", async () => {
    const result = await validateLocalCwd(tmpFile);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not a directory/);
    }
  });

  it("trims surrounding whitespace before resolving", async () => {
    const result = await validateLocalCwd(`  ${tmpDir}  `);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(path.resolve(tmpDir));
    }
  });
});
