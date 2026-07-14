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

  function makeExecutable(path: string): void {
    writeFileSync(path, "#!/bin/sh\necho hi\n");
    chmodSync(path, 0o755);
  }

  it("finds a hydra-acp-<name> binary on PATH", () => {
    const target = join(pathDir1, "hydra-acp-planner");
    makeExecutable(target);
    const env = { PATH: [pathDir1, pathDir2].join(delimiter) };
    expect(findExternalSubcommand("planner", env)).toBe(target);
  });

  it("returns undefined when no binary matches", () => {
    const env = { PATH: [pathDir1, pathDir2].join(delimiter) };
    expect(findExternalSubcommand("planner", env)).toBeUndefined();
  });

  it("returns the first match when multiple PATH dirs have it", () => {
    const first = join(pathDir1, "hydra-acp-planner");
    const second = join(pathDir2, "hydra-acp-planner");
    makeExecutable(first);
    makeExecutable(second);
    const env = { PATH: [pathDir1, pathDir2].join(delimiter) };
    expect(findExternalSubcommand("planner", env)).toBe(first);
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
    makeExecutable(join(pathDir1, "hydra-acp"));
    makeExecutable(join(pathDir1, "hydra-acp-planner-helper"));
    const env = { PATH: pathDir1 };
    expect(findExternalSubcommand("planner", env)).toBeUndefined();
  });

  it("respects subcommand names with hyphens", () => {
    const target = join(pathDir1, "hydra-acp-my-team");
    makeExecutable(target);
    const env = { PATH: pathDir1 };
    expect(findExternalSubcommand("my-team", env)).toBe(target);
  });
});
