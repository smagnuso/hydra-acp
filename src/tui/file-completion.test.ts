import { describe, expect, it } from "vitest";
import { onPlatform } from "../core/platform-stub.js";
import {
  completePathToken,
  extractPathToken,
  looksLikePath,
  type DirEntry,
} from "./file-completion.js";

describe("extractPathToken", () => {
  it("returns null at start-of-line or after whitespace", () => {
    expect(extractPathToken("", 0)).toBe(null);
    expect(extractPathToken("foo ", 4)).toBe(null);
  });

  it("grabs the whitespace-delimited run before the cursor", () => {
    expect(extractPathToken("open src/fo", 11)).toEqual({
      token: "src/fo",
      start: 5,
    });
  });

  it("stops at the cursor, ignoring text after it", () => {
    expect(extractPathToken("src/foo bar", 7)).toEqual({
      token: "src/foo",
      start: 0,
    });
  });

  it("honors backslash-escaped spaces", () => {
    expect(extractPathToken("my\\ dir/fi", 10)).toEqual({
      token: "my\\ dir/fi",
      start: 0,
    });
  });
});

describe("looksLikePath", () => {
  it("treats slash-bearing and relative/home markers as paths", () => {
    expect(looksLikePath("src/foo")).toBe(true);
    expect(looksLikePath("/etc")).toBe(true);
    expect(looksLikePath("~")).toBe(true);
    expect(looksLikePath("..")).toBe(true);
  });

  it("leaves bare words alone", () => {
    expect(looksLikePath("hello")).toBe(false);
    expect(looksLikePath("")).toBe(false);
  });
});

describe("completePathToken", () => {
  const dir = (entries: DirEntry[]) => () => entries;

  it("returns null for a bare word when nothing in cwd matches", () => {
    expect(completePathToken("hello", "/cwd", dir([]))).toBe(null);
    expect(
      completePathToken("hello", "/cwd", dir([{ name: "other", isDir: false }])),
    ).toBe(null);
  });

  it("completes a bare word against cwd when a file matches", () => {
    // The user's ask: type "Mak", press Tab, get "Makefile".
    expect(
      completePathToken("Mak", "/cwd", dir([{ name: "Makefile", isDir: false }])),
    ).toEqual({ replacement: "Makefile", candidates: ["Makefile"] });
  });

  it("completes a bare word to the common prefix when multiple files match", () => {
    expect(
      completePathToken(
        "co",
        "/cwd",
        dir([
          { name: "config.json", isDir: false },
          { name: "convention.md", isDir: false },
        ]),
      ),
    ).toEqual({
      replacement: "con",
      candidates: ["config.json", "convention.md"],
    });
  });

  it("returns null when the directory is unreadable", () => {
    expect(completePathToken("src/x", "/cwd", () => null)).toBe(null);
  });

  it("returns null when nothing matches the base", () => {
    expect(
      completePathToken("src/z", "/cwd", dir([{ name: "foo", isDir: false }])),
    ).toBe(null);
  });

  it("commits a unique file match", () => {
    expect(
      completePathToken("src/fo", "/cwd", dir([{ name: "foo.ts", isDir: false }])),
    ).toEqual({ replacement: "src/foo.ts", candidates: ["foo.ts"] });
  });

  it("appends a slash for a unique directory match", () => {
    expect(
      completePathToken("./s", "/cwd", dir([{ name: "src", isDir: true }])),
    ).toEqual({ replacement: "./src/", candidates: ["src/"] });
  });

  it("extends to the common prefix and lists candidates when ambiguous", () => {
    const got = completePathToken(
      "src/f",
      "/cwd",
      dir([
        { name: "foo.ts", isDir: false },
        { name: "foobar.ts", isDir: false },
      ]),
    );
    expect(got).toEqual({
      replacement: "src/foo",
      candidates: ["foo.ts", "foobar.ts"],
    });
  });

  it("hides dotfiles unless the base starts with a dot", () => {
    expect(
      completePathToken(
        "./",
        "/cwd",
        dir([
          { name: ".git", isDir: true },
          { name: "src", isDir: true },
        ]),
      ),
    ).toEqual({ replacement: "./src/", candidates: ["src/"] });
    expect(
      completePathToken(
        "./.",
        "/cwd",
        dir([
          { name: ".git", isDir: true },
          { name: "src", isDir: true },
        ]),
      ),
    ).toEqual({ replacement: "./.git/", candidates: [".git/"] });
  });

  it("re-escapes spaces in the completed token", () => {
    expect(
      completePathToken("./my\\ d", "/cwd", dir([{ name: "my dir", isDir: true }])),
    ).toEqual({ replacement: "./my\\ dir/", candidates: ["my dir/"] });
  });
});

describe("Windows path completion", () => {
  const dir = (entries: DirEntry[]) => () => entries;

  it("treats a token containing a backslash as a path on Windows only", async () => {
    await onPlatform("win32", () => {
      expect(looksLikePath("src\\fo")).toBe(true);
    });
    await onPlatform("linux", () => {
      expect(looksLikePath("src\\fo")).toBe(false);
    });
  });

  it("completes after a backslash and keeps the backslash style", async () => {
    await onPlatform("win32", () => {
      expect(
        completePathToken("src\\fo", "C:\\proj", dir([{ name: "foo", isDir: true }])),
      ).toEqual({ replacement: "src\\foo\\", candidates: ["foo\\"] });
    });
  });

  it("keeps a forward slash when that is what was typed", async () => {
    await onPlatform("win32", () => {
      expect(
        completePathToken("src/fo", "C:\\proj", dir([{ name: "foo", isDir: true }])),
      ).toEqual({ replacement: "src/foo/", candidates: ["foo/"] });
    });
  });

  it("matches names case-insensitively on Windows", async () => {
    await onPlatform("win32", () => {
      expect(
        completePathToken("src\\mak", "C:\\proj", dir([{ name: "Makefile", isDir: false }])),
      ).toEqual({ replacement: "src\\Makefile", candidates: ["Makefile"] });
    });
  });

  it("still escapes a space with a backslash", async () => {
    await onPlatform("win32", () => {
      expect(
        completePathToken(
          "C:\\Program\\ Fi",
          "C:\\proj",
          dir([{ name: "Program Files", isDir: true }]),
        ),
      ).toEqual({
        replacement: "C:\\Program\\ Files\\",
        candidates: ["Program Files\\"],
      });
    });
  });
});
