import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  completeAtMention,
  fuzzyScore,
  listProjectFilesUncached,
  mentionBlocks,
  rankFiles,
  withDirectories,
} from "./file-search.js";

const files = [
  "src/tui/file-completion.ts",
  "src/tui/file-search.ts",
  "src/tui/app.ts",
  "README.md",
  "docs/my notes.md",
];

describe("fuzzyScore", () => {
  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("zzz", "src/app.ts")).toBe(null);
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("readme", "README.md")).not.toBe(null);
  });

  it("prefers contiguous basename matches", () => {
    const a = fuzzyScore("app", "src/tui/app.ts") as number;
    const b = fuzzyScore("app", "src/a/p/p.ts") as number;
    expect(a).toBeGreaterThan(b);
  });
});

describe("rankFiles", () => {
  it("ranks basename prefix hits first", () => {
    expect(rankFiles("file-s", files)[0]).toBe("src/tui/file-search.ts");
  });

  it("honors the limit", () => {
    expect(rankFiles("", files, 2)).toHaveLength(2);
  });
});

describe("completeAtMention", () => {
  const list = () => files;

  it("ignores tokens without a leading @", () => {
    expect(completeAtMention("app", "/cwd", list)).toBe(null);
  });

  it("returns null when nothing matches", () => {
    expect(completeAtMention("@zzzz", "/cwd", list)).toBe(null);
  });

  it("commits a single match", () => {
    expect(completeAtMention("@readme", "/cwd", list)).toEqual({
      replacement: "@README.md",
      candidates: ["README.md"],
      choices: ["@README.md"],
      file: "README.md",
    });
  });

  it("escapes spaces in the committed path", () => {
    expect(completeAtMention("@notes", "/cwd", list)?.replacement).toBe(
      "@docs/my\\ notes.md",
    );
  });

  it("extends a literal path prefix to the common prefix", () => {
    const got = completeAtMention("@src/tui/fi", "/cwd", list);
    expect(got?.replacement).toBe("@src/tui/file-");
  });

  it("leaves a fuzzy query alone and lists candidates", () => {
    const got = completeAtMention("@fil", "/cwd", list);
    expect(got?.replacement).toBe("@fil");
    expect(got?.candidates).toEqual([
      "src/tui/file-search.ts",
      "src/tui/file-completion.ts",
    ]);
  });
});

describe("mentionBlocks", () => {
  const mentions = new Map([
    ["@src/a.ts", "src/a.ts"],
    ["@docs/my\\ notes.md", "docs/my notes.md"],
  ]);

  // Windows anchors "/proj" to the current drive, so allow a drive letter.
  it("links mentions still present in the text", () => {
    const got = mentionBlocks("look at @src/a.ts please", mentions, "/proj");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: "resource_link", name: "src/a.ts" });
    expect(got[0]?.uri).toMatch(/^file:\/\/\/(?:[A-Za-z]:\/)?proj\/src\/a\.ts$/);
  });

  it("drops mentions that were edited away", () => {
    expect(mentionBlocks("nothing here", mentions, "/proj")).toEqual([]);
  });

  it("does not match a longer path sharing the prefix", () => {
    expect(mentionBlocks("see @src/a.tsx", mentions, "/proj")).toEqual([]);
  });

  it("encodes spaces in the uri", () => {
    const got = mentionBlocks("@docs/my\\ notes.md", mentions, "/proj");
    expect(got[0]?.uri).toMatch(/^file:\/\/\/(?:[A-Za-z]:\/)?proj\/docs\/my%20notes\.md$/);
  });
});

describe("listProjectFilesUncached", () => {
  it("lists a nested repo through git so its .gitignore applies", () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "tui-nested-")));
    try {
      const sub = join(dir, "pkg");
      mkdirSync(join(sub, "dist"), { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: sub, stdio: "ignore" });
      writeFileSync(join(sub, ".gitignore"), "dist/\n");
      writeFileSync(join(sub, "src.ts"), "");
      writeFileSync(join(sub, "dist", "out.js"), "");
      writeFileSync(join(dir, "top.txt"), "");
      expect(listProjectFilesUncached(dir).sort()).toEqual([
        "pkg/.gitignore",
        "pkg/src.ts",
        "top.txt",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("directory mentions", () => {
  const list = () => withDirectories(files);

  it("commits a unique directory with a trailing slash and no file link", () => {
    const got = completeAtMention("@src/tu", "/cwd", () => ["src/tui/"]);
    expect(got).toEqual({
      replacement: "@src/tui/",
      candidates: ["src/tui/"],
      choices: ["@src/tui/"],
      file: undefined,
    });
  });

  it("ranks a directory by its own name", () => {
    expect(rankFiles("tui", list())[0]).toBe("src/tui/");
  });

  it("adds each ancestor once", () => {
    expect(withDirectories(["a/b/c.ts", "a/d.ts"])).toEqual(["a/b/c.ts", "a/d.ts", "a/", "a/b/"]);
  });
});

describe("Windows-typed queries", () => {
  it("rankFiles matches a backslash query against forward-slashed paths", () => {
    expect(rankFiles("src\\tui\\app", files)[0]).toBe("src/tui/app.ts");
  });

  it("completeAtMention commits a backslash-typed unique match", () => {
    const got = completeAtMention("@src\\tui\\ap", "C:\\proj", () => ["src/tui/app.ts"]);
    expect(got?.replacement).toBe("@src/tui/app.ts");
  });
});
