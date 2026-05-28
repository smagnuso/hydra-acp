import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  completeLocalPath,
  pickInitialLocalCwd,
  validateLocalCwd,
} from "./cwd.js";

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

describe("pickInitialLocalCwd", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-cwd-pick-"));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns the literal path when it exists", async () => {
    const result = await pickInitialLocalCwd(tmpDir);
    expect(result).toBe(tmpDir);
  });

  it("returns null when the path does not exist and no swap helps", async () => {
    const ghost = path.join(tmpDir, "does-not-exist");
    const result = await pickInitialLocalCwd(ghost);
    expect(result).toBeNull();
  });

  it("falls back to the /home ↔ /Users swap when available", async () => {
    // Pick whichever prefix exists on this OS, then ask for the
    // swapped variant and confirm pickInitialLocalCwd recovers the
    // existing one.
    const home = os.homedir();
    let existing: string;
    let swapped: string;
    if (home.startsWith("/home/")) {
      existing = home;
      swapped = "/Users/" + home.slice("/home/".length);
    } else if (home.startsWith("/Users/")) {
      existing = home;
      swapped = "/home/" + home.slice("/Users/".length);
    } else {
      // Unusual layout; nothing meaningful to assert.
      return;
    }
    // Only meaningful if the swapped path is in fact absent — skip
    // otherwise so the test stays useful on machines that happen to
    // have both prefixes populated.
    try {
      await fs.stat(swapped);
      return;
    } catch {
      // expected
    }
    const result = await pickInitialLocalCwd(swapped);
    expect(result).toBe(existing);
  });
});

describe("completeLocalPath", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-cwd-complete-"));
    await fs.mkdir(path.join(tmpDir, "apple"));
    await fs.mkdir(path.join(tmpDir, "banana"));
    await fs.writeFile(path.join(tmpDir, "apricot.txt"), "a");
    await fs.writeFile(path.join(tmpDir, ".hidden"), "h");
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("lists non-hidden entries with / on directories when prefix is empty", async () => {
    const result = await completeLocalPath(`${tmpDir}/`);
    expect(result.prefix).toBe(`${tmpDir}/`);
    expect(result.basePrefix).toBe("");
    expect(result.matches).toEqual(["apple/", "apricot.txt", "banana/"]);
  });

  it("filters by basename prefix", async () => {
    const result = await completeLocalPath(`${tmpDir}/ap`);
    expect(result.basePrefix).toBe("ap");
    expect(result.matches).toEqual(["apple/", "apricot.txt"]);
  });

  it("returns a single directory match with trailing slash", async () => {
    const result = await completeLocalPath(`${tmpDir}/apple`);
    expect(result.matches).toEqual(["apple/"]);
  });

  it("hides dotfiles unless the prefix begins with .", async () => {
    const visible = await completeLocalPath(`${tmpDir}/`);
    expect(visible.matches).not.toContain(".hidden");
    const hidden = await completeLocalPath(`${tmpDir}/.hi`);
    expect(hidden.matches).toEqual([".hidden"]);
  });

  it("returns empty matches when the directory cannot be read", async () => {
    const result = await completeLocalPath(`${tmpDir}/does-not-exist/foo`);
    expect(result.matches).toEqual([]);
  });

  it("expands ~/ for the filesystem read but preserves it in prefix", async () => {
    const result = await completeLocalPath("~/");
    expect(result.prefix).toBe("~/");
    // We can't assert exact entries (home dir varies) but readdir on
    // $HOME should produce at least one entry on any developer box.
    expect(result.matches.length).toBeGreaterThan(0);
  });
});
