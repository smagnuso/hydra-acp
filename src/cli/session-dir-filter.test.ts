import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { resolveDirFilter, sessionMatchesDir } from "./session-dir-filter.js";

describe("resolveDirFilter", () => {
  it("expands ~ and $HOME", () => {
    expect(resolveDirFilter("~/dev/foo")).toBe(`${homedir()}/dev/foo`);
    expect(resolveDirFilter("$HOME/dev/foo")).toBe(`${homedir()}/dev/foo`);
  });

  it("resolves relative paths against the process cwd", () => {
    expect(resolveDirFilter(".")).toBe(process.cwd());
  });

  it("strips a trailing separator but keeps root", () => {
    expect(resolveDirFilter("/tmp/foo/")).toBe("/tmp/foo");
    expect(resolveDirFilter("/")).toBe("/");
  });

  it("treats empty input as the current directory", () => {
    expect(resolveDirFilter("   ")).toBe(process.cwd());
  });
});

describe("sessionMatchesDir", () => {
  it("matches the directory itself and its subtree", () => {
    expect(sessionMatchesDir({ cwd: "/home/u/dev/foo" }, "/home/u/dev/foo")).toBe(true);
    expect(sessionMatchesDir({ cwd: "/home/u/dev/foo/pkg/a" }, "/home/u/dev/foo")).toBe(true);
    expect(sessionMatchesDir({ cwd: "/home/u/dev" }, "/home/u/dev/foo")).toBe(false);
  });

  it("respects path boundaries", () => {
    expect(sessionMatchesDir({ cwd: "/home/u/dev/foobar" }, "/home/u/dev/foo")).toBe(false);
  });

  it("matches an isolated session by its source tree", () => {
    const s = {
      cwd: "/home/u/.hydra-acp/workspaces/ws-1",
      workspace: { sourceCwd: "/home/u/dev/foo" },
    };
    expect(sessionMatchesDir(s, "/home/u/dev/foo")).toBe(true);
    expect(sessionMatchesDir(s, "/home/u/.hydra-acp/workspaces")).toBe(true);
    expect(sessionMatchesDir(s, "/home/u/dev/bar")).toBe(false);
  });

  it("ignores a missing or empty cwd", () => {
    expect(sessionMatchesDir({ cwd: "" }, "/home/u/dev/foo")).toBe(false);
  });

  it("normalizes a recorded path with a trailing separator", () => {
    expect(sessionMatchesDir({ cwd: "/home/u/dev/foo/" }, "/home/u/dev/foo")).toBe(true);
  });
});
