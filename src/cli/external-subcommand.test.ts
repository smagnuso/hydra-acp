import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import {
  argvWithoutFirstPositional,
  findExternalSubcommand,
  firstPositional,
  isBuiltinSubcommand,
} from "./external-subcommand.js";

describe("isBuiltinSubcommand", () => {
  it("recognizes core verbs", () => {
    for (const v of ["session", "daemon", "agent", "tui", "shim", "acp", "cat", "launch"]) {
      expect(isBuiltinSubcommand(v)).toBe(true);
    }
  });

  it("rejects names that aren't built-in", () => {
    expect(isBuiltinSubcommand("planner")).toBe(false);
    expect(isBuiltinSubcommand("metrics")).toBe(false);
    expect(isBuiltinSubcommand("")).toBe(false);
  });
});

describe("firstPositional", () => {
  it("returns the first non-flag token", () => {
    expect(firstPositional(["planner", "list"])).toBe("planner");
    expect(firstPositional(["--json", "planner", "list"])).toBe("planner");
  });

  it("returns undefined when every token is a flag", () => {
    expect(firstPositional([])).toBeUndefined();
    expect(firstPositional(["--help"])).toBeUndefined();
    expect(firstPositional(["--session", "-p"])).toBeUndefined();
  });
});

describe("argvWithoutFirstPositional", () => {
  it("removes only the first positional, preserves the rest", () => {
    expect(argvWithoutFirstPositional(["planner", "list", "--json"])).toEqual([
      "list",
      "--json",
    ]);
  });

  it("preserves flags that come before the first positional", () => {
    expect(argvWithoutFirstPositional(["--verbose", "planner", "list"])).toEqual([
      "--verbose",
      "list",
    ]);
  });

  it("returns the argv unchanged when there is no positional", () => {
    expect(argvWithoutFirstPositional(["--help"])).toEqual(["--help"]);
  });
});

describe("findExternalSubcommand", () => {
  let tmpDir: string;
  let pathDir1: string;
  let pathDir2: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hydra-ext-test-"));
    pathDir1 = join(tmpDir, "bin1");
    pathDir2 = join(tmpDir, "bin2");
    mkdirSync(pathDir1);
    mkdirSync(pathDir2);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Paths compare case-insensitively: PATHEXT is conventionally
  // uppercase and Windows' filesystem is not case-sensitive, so a
  // fixture written as .cmd is legitimately found as .CMD. Which casing
  // comes back is not a behavioural difference there.
  function expectSamePath(actual: string | undefined, expected: string): void {
    expect(actual?.toLowerCase()).toBe(expected.toLowerCase());
  }

  // Creates the name the platform can actually execute, and returns it.
  // On Windows an extensionless file is not runnable and
  // findExternalSubcommand only considers PATHEXT extensions, so a
  // POSIX-shaped fixture is invisible to it — the lookup is right and
  // the fixture was wrong.
  function makeExecutable(dir: string, base: string): string {
    if (process.platform === "win32") {
      const target = join(dir, `${base}.cmd`);
      writeFileSync(target, "@echo off\r\necho hi\r\n");
      return target;
    }
    const target = join(dir, base);
    writeFileSync(target, "#!/bin/sh\necho hi\n");
    chmodSync(target, 0o755);
    return target;
  }

  it("finds a hydra-acp-<name> binary on PATH", () => {
    const target = makeExecutable(pathDir1, "hydra-acp-planner");
    const env = { PATH: [pathDir1, pathDir2].join(delimiter) };
    expectSamePath(findExternalSubcommand("planner", env), target);
  });

  it("finds a hydra-<name> binary only when an extension of that name is registered", () => {
    const target = makeExecutable(pathDir1, "hydra-ahp");
    const env = { PATH: pathDir1 };
    expect(findExternalSubcommand("ahp", env)).toBeUndefined();
    expect(findExternalSubcommand("ahp", env, new Set(["other"]))).toBeUndefined();
    expectSamePath(findExternalSubcommand("ahp", env, new Set(["hydra-ahp"])), target);
  });

  it("prefers hydra-acp-<name> over hydra-<name>", () => {
    makeExecutable(pathDir1, "hydra-ahp");
    const preferred = makeExecutable(pathDir2, "hydra-acp-ahp");
    const env = { PATH: [pathDir1, pathDir2].join(delimiter) };
    expectSamePath(findExternalSubcommand("ahp", env, new Set(["hydra-ahp"])), preferred);
  });

  it("returns undefined when no binary matches", () => {
    const env = { PATH: [pathDir1, pathDir2].join(delimiter) };
    expect(findExternalSubcommand("planner", env)).toBeUndefined();
  });

  it("returns the first match when multiple PATH dirs have it", () => {
    const first = makeExecutable(pathDir1, "hydra-acp-planner");
    makeExecutable(pathDir2, "hydra-acp-planner");
    const env = { PATH: [pathDir1, pathDir2].join(delimiter) };
    expectSamePath(findExternalSubcommand("planner", env), first);
  });

  it("skips non-executable files (unix)", () => {
    if (process.platform === "win32") {
      return; // PATHEXT-driven on Windows, X bit doesn't apply
    }
    const path = join(pathDir1, "hydra-acp-planner");
    writeFileSync(path, "#!/bin/sh\n"); // mode 0644 by default
    const env = { PATH: pathDir1 };
    expect(findExternalSubcommand("planner", env)).toBeUndefined();
  });

  it("returns undefined when PATH is empty", () => {
    expect(findExternalSubcommand("planner", { PATH: "" })).toBeUndefined();
    expect(findExternalSubcommand("planner", {})).toBeUndefined();
  });

  it("does not match unrelated binaries with similar prefixes", () => {
    makeExecutable(pathDir1, "hydra-acp");
    makeExecutable(pathDir1, "hydra-acp-planner-helper");
    const env = { PATH: pathDir1 };
    expect(findExternalSubcommand("planner", env)).toBeUndefined();
  });

  it("respects subcommand names with hyphens", () => {
    const target = makeExecutable(pathDir1, "hydra-acp-my-team");
    const env = { PATH: pathDir1 };
    expectSamePath(findExternalSubcommand("my-team", env), target);
  });
});
