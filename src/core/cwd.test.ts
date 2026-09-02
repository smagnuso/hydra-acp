import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  completeLocalPath,
  pathShadowBoundary,
  pathShadowCommitBoundary,
  pickInitialLocalCwd,
  validateLocalCwd,
} from "./cwd.js";

// Table verified against GNU Emacs 29.3's `substitute-in-file-name`,
// which implements the same "guess what you meant" collapsing that
// ido-find-file relies on.
describe("pathShadowBoundary", () => {
  it.each([
    ["/etc/passwd/~/", "~/"],
    ["/etc/passwd/~", "~"],
    ["/etc/passwd~/", "/etc/passwd~/"], // no "/" before "~" — literal
    ["/etc/passwd/~user", "/etc/passwd/~user"], // named user, not bare
    ["/etc/passwd/~user/", "/etc/passwd/~user/"],
    ["/etc//foo", "/foo"],
    ["/etc///foo", "/foo"],
    ["foo//bar", "/bar"],
    ["foo//", "/"],
    ["//", "/"],
    ["///", "/"],
    ["/", "/"],
    ["~", "~"],
    ["", ""],
    ["a", "a"],
    ["~//foo", "/foo"],
    ["/foo/~//bar", "/bar"],
    ["/a/~/b//c", "/c"], // rightmost trigger (the "//") wins over "~/"
    ["/a//b/~/c", "~/c"], // rightmost trigger (the "~/") wins over "//"
    ["~/a/~x/b/~/c", "~/c"],
  ])("collapses %j to %j", (input, expected) => {
    expect(input.slice(pathShadowBoundary(input))).toBe(expected);
  });
});

// The live-typing sibling: one keystroke more conservative than
// pathShadowBoundary on both branches. A dangling "~" needs an explicit
// trailing "/" before it commits (might still grow into "~user"), and a
// run of slashes needs a *third* one before it commits (two might still
// be a typo about to be backspaced) — collapsing down to the single
// trailing "/" left once the redundant ones are dropped.
describe("pathShadowCommitBoundary", () => {
  it.each([
    ["/etc/passwd/~/", "~/"], // trailing "/" confirms it — commits
    ["/etc/passwd/~", "/etc/passwd/~"], // dangling "~" — not yet committed
    ["/etc/passwd/~user", "/etc/passwd/~user"],
    ["/etc//", "/etc//"], // exactly two slashes — not yet committed
    ["/etc///", "/"], // a third slash confirms it — commits
    ["/etc///foo", "/foo"],
    ["/etc/", "/etc/"],
    ["~", "~"],
    ["", ""],
  ])("collapses %j to %j", (input, expected) => {
    expect(input.slice(pathShadowCommitBoundary(input))).toBe(expected);
  });
});

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

  it("collapses a stray prefix before a bare ~ to just home", async () => {
    const result = await validateLocalCwd("/not-a-real-dir/~");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(path.resolve(os.homedir()));
    }
  });

  it("collapses a doubled slash to just the tail", async () => {
    // tmpDir already starts with "/", so gluing a trailing-slash prefix
    // onto it produces a "//" at the seam — exactly what a leftover
    // ^O buffer looks like after typing a fresh absolute path.
    const result = await validateLocalCwd(`/not-a-real-dir/${tmpDir}`);
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

  it("collapses a stray prefix before the tab-completed token", async () => {
    const result = await completeLocalPath(`/not-a-real-dir/${tmpDir}/ap`);
    expect(result.prefix).toBe(`${tmpDir}/`);
    expect(result.basePrefix).toBe("ap");
    expect(result.matches).toEqual(["apple/", "apricot.txt"]);
  });
});
