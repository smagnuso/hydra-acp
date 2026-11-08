import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  completeAtMention,
  type FileListing,
  type MentionTarget,
  fuzzyScore,
  listProjectFilesUncached,
  mentionBlocks,
  rankFiles,
  resolveScope,
  wantsHidden,
  withDirectories,
} from "./file-search.js";

const ok = (list: string[]): FileListing => ({ files: list, truncated: false });

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
  const list = () => ok(files);

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
      targets: [{ kind: "file", path: "README.md" }],
      target: { kind: "file", path: "README.md" },
      truncated: false,
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
  const mentions = new Map<string, MentionTarget>([
    ["@src/a.ts", { kind: "file", path: "src/a.ts" }],
    ["@docs/my\\ notes.md", { kind: "file", path: "docs/my notes.md" }],
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
      expect(listProjectFilesUncached(dir).files.sort()).toEqual([
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
  const list = () => ok(withDirectories(files));

  it("commits a unique directory with a trailing slash and no file link", () => {
    const got = completeAtMention("@src/tu", "/cwd", () => ok(["src/tui/"]));
    expect(got).toEqual({
      replacement: "@src/tui/",
      candidates: ["src/tui/"],
      choices: ["@src/tui/"],
      targets: [null],
      truncated: false,
    });
  });

  it("ranks a directory by its own name", () => {
    expect(rankFiles("tui", list().files)[0]).toBe("src/tui/");
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
    const got = completeAtMention("@src\\tui\\ap", "C:\\proj", () => ok(["src/tui/app.ts"]));
    expect(got?.replacement).toBe("@src/tui/app.ts");
  });
});

describe("hidden entries", () => {
  it("wantsHidden is true only when a segment starts with a dot", () => {
    expect(wantsHidden(".bashr")).toBe(true);
    expect(wantsHidden("src/.en")).toBe(true);
    expect(wantsHidden("src\\.en")).toBe(true);
    expect(wantsHidden("bash.rc")).toBe(false);
    expect(wantsHidden("src/app")).toBe(false);
  });

  it("completeAtMention asks the lister for hidden files only when the query opts in", () => {
    const seen: boolean[] = [];
    const list = (_cwd: string, hidden: boolean): FileListing => {
      seen.push(hidden);
      return ok([".bashrc"]);
    };
    expect(completeAtMention("@.bashr", "/cwd", list)?.replacement).toBe("@.bashrc");
    completeAtMention("@bash", "/cwd", list);
    expect(seen).toEqual([true, false]);
  });

  it("the walk lists dotfiles only when asked, and never .git or node_modules", () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "tui-hidden-")));
    try {
      mkdirSync(join(dir, ".config"));
      mkdirSync(join(dir, ".git"));
      mkdirSync(join(dir, "node_modules"));
      writeFileSync(join(dir, ".bashrc"), "");
      writeFileSync(join(dir, ".config", "x"), "");
      writeFileSync(join(dir, ".git", "HEAD"), "");
      writeFileSync(join(dir, "node_modules", "n"), "");
      writeFileSync(join(dir, "a.txt"), "");
      expect(listProjectFilesUncached(dir).files.sort()).toEqual(["a.txt"]);
      expect(listProjectFilesUncached(dir, true).files.sort()).toEqual([".bashrc", ".config/x", "a.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scoped search for a truncated listing", () => {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const dirs = new Set(["/cwd/dnload", "/cwd/dnload/foo"]);
  const isDir = (abs: string): boolean => dirs.has(norm(abs));

  it("resolveScope takes the longest existing directory prefix", () => {
    const has = (rel: string): boolean => rel === "dnload/" || rel === "dnload/foo/";
    expect(resolveScope("dnload/foo/main", has)).toEqual({ base: "dnload/foo/", rest: "main" });
    expect(resolveScope("dnload/fo/main", has)).toEqual({ base: "dnload/", rest: "fo/main" });
    expect(resolveScope("main", has)).toEqual({ base: "", rest: "main" });
    expect(resolveScope("../dnload/x", has)).toEqual({ base: "", rest: "../dnload/x" });
  });

  it("searches the typed directory when the full listing was truncated", () => {
    const calls: string[] = [];
    const list = (cwd: string): FileListing => {
      calls.push(cwd);
      return norm(cwd).endsWith("dnload/foo")
        ? ok(["main.cpp", "util.cpp"])
        : { files: ["a.txt"], truncated: true };
    };
    const got = completeAtMention("@dnload/foo/main", "/cwd", list, isDir);
    expect(got?.replacement).toBe("@dnload/foo/main.cpp");
    expect(got?.target).toEqual({ kind: "file", path: "dnload/foo/main.cpp" });
    expect(got?.truncated).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("keeps the whole listing when it was complete, even for a path-like query", () => {
    let calls = 0;
    const list = (): FileListing => {
      calls += 1;
      return ok(["dnload/foo/main.cpp", "x/dnload/foo/main.cpp"]);
    };
    const got = completeAtMention("@dnload/foo/main", "/cwd", list, isDir);
    expect(got?.candidates).toHaveLength(2);
    expect(calls).toBe(1);
  });

  it("reports truncation when no directory prefix narrows it", () => {
    const list = (): FileListing => ({ files: ["main.cpp", "main.c"], truncated: true });
    expect(completeAtMention("@main", "/cwd", list, isDir)?.truncated).toBe(true);
  });
});

describe("session candidates alongside files", () => {
  const sessionCand = (title: string, id: string) => ({
    label: `session: ${title}  (${id.slice(0, 4)}, ~/p)`,
    choice: `@${title.toLowerCase().replace(/ /g, "-")}-${id.slice(0, 4)}`,
    target: { kind: "session" as const, id, title },
  });

  it("lists files first, then sessions, with a target for each", () => {
    const got = completeAtMention(
      "@log",
      "/cwd",
      () => ok(["src/login.ts"]),
      undefined,
      [sessionCand("Fix login", "ab12cd")],
    );
    expect(got?.choices).toEqual(["@src/login.ts", "@fix-login-ab12"]);
    expect(got?.targets).toEqual([
      { kind: "file", path: "src/login.ts" },
      { kind: "session", id: "ab12cd", title: "Fix login" },
    ]);
    expect(got?.replacement).toBe("@log");
  });

  it("commits a lone session match and exposes it as the target", () => {
    const got = completeAtMention("@zzz", "/cwd", () => ok([]), undefined, [
      sessionCand("Zzz work", "ff00aa"),
    ]);
    expect(got?.replacement).toBe("@zzz-work-ff00");
    expect(got?.target).toEqual({ kind: "session", id: "ff00aa", title: "Zzz work" });
  });

  it("puts sessions right after the first two files so they are on screen", () => {
    const many = Array.from({ length: 30 }, (_, i) => `login${i}.ts`);
    const got = completeAtMention("@login", "/cwd", () => ok(many), undefined, [
      sessionCand("Fix login", "ab12cd"),
    ]);
    expect(got?.choices.length).toBe(16);
    expect(got?.choices[2]).toBe("@fix-login-ab12");
    expect(got?.choices.filter((c) => c.startsWith("@login")).length).toBe(15);
    expect(got?.targets.slice(0, 2).every((t) => t?.kind === "file")).toBe(true);
    expect(got?.targets[2]).toMatchObject({ kind: "session" });
  });

  it("does not extend a token toward a session slug", () => {
    const got = completeAtMention("@fi", "/cwd", () => ok(["fig.ts"]), undefined, [
      sessionCand("Fix login", "ab12cd"),
    ]);
    expect(got?.replacement).toBe("@fi");
  });
});

describe("session mention links", () => {
  it("builds a hydra:// resource_link with the title and a read hint", () => {
    const m = new Map<string, MentionTarget>([
      ["@fix-login-ab12", { kind: "session", id: "hydra_session_ab12cd", title: "Fix login" }],
    ]);
    expect(mentionBlocks("see @fix-login-ab12 please", m, "/cwd")).toEqual([
      {
        type: "resource_link",
        uri: "hydra://sessions/hydra_session_ab12cd",
        name: "Fix login",
        description:
          "Hydra session hydra_session_ab12cd; read it with: hydra session transcript hydra_session_ab12cd",
        mimeType: "text/markdown",
      },
    ]);
  });

  it("names an untitled session by its id and drops it when the token is gone", () => {
    const m = new Map<string, MentionTarget>([
      ["@session-ab12", { kind: "session", id: "hydra_session_ab12cd", title: "" }],
    ]);
    expect(mentionBlocks("@session-ab12", m, "/cwd")[0]?.name).toBe("hydra_session_ab12cd");
    expect(mentionBlocks("nothing", m, "/cwd")).toEqual([]);
  });
});
