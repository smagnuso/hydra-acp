import { describe, it, expect } from "vitest";
import { parseWorktreeListPorcelain, shortBranchName } from "./worktree-list.js";

describe("parseWorktreeListPorcelain", () => {
  it("parses a main worktree plus a linked one", () => {
    const out = parseWorktreeListPorcelain(
      [
        "worktree /home/u/proj",
        "HEAD 0e78d0d1a2b3c4d5e6f708192a3b4c5d6e7f8091",
        "branch refs/heads/main",
        "",
        "worktree /home/u/.hydra-acp/workspaces/ab12/feature",
        "HEAD 4f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a",
        "branch refs/heads/hydra/feature",
        "",
      ].join("\n"),
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.path).toBe("/home/u/proj");
    expect(out[0]?.branch).toBe("refs/heads/main");
    expect(out[1]?.path).toBe("/home/u/.hydra-acp/workspaces/ab12/feature");
    expect(out[1]?.branch).toBe("refs/heads/hydra/feature");
  });

  it("keeps spaces in paths instead of truncating at the first one", () => {
    const out = parseWorktreeListPorcelain(
      ["worktree /home/u/my project/sub dir", "HEAD abc123", "detached", ""].join("\n"),
    );
    expect(out[0]?.path).toBe("/home/u/my project/sub dir");
    expect(out[0]?.detached).toBe(true);
  });

  it("captures a lock reason, and an empty string for a bare lock", () => {
    const withReason = parseWorktreeListPorcelain(
      ["worktree /a", "HEAD abc", "locked hydra-acp:session S1", ""].join("\n"),
    );
    expect(withReason[0]?.lockedReason).toBe("hydra-acp:session S1");

    const bare = parseWorktreeListPorcelain(["worktree /a", "HEAD abc", "locked", ""].join("\n"));
    // Distinguishing "locked, no reason" from "not locked" matters:
    // reconciliation must not remove either, and only a defined value
    // says the worktree is locked at all.
    expect(bare[0]?.lockedReason).toBe("");
    expect(bare[0]?.lockedReason).toBeDefined();
  });

  it("handles a bare main worktree with no HEAD or branch", () => {
    const out = parseWorktreeListPorcelain(["worktree /repo.git", "bare", ""].join("\n"));
    expect(out[0]?.bare).toBe(true);
    expect(out[0]?.head).toBeUndefined();
    expect(out[0]?.branch).toBeUndefined();
  });

  it("marks prunable entries", () => {
    const out = parseWorktreeListPorcelain(
      ["worktree /gone", "HEAD abc", "prunable gitdir file points to non-existent location", ""].join(
        "\n",
      ),
    );
    expect(out[0]?.prunableReason).toContain("non-existent");
  });

  it("tolerates a trailing record with no blank line, CRLF, and empty input", () => {
    const noTrailingBlank = parseWorktreeListPorcelain("worktree /a\nHEAD abc\nbranch refs/heads/x");
    expect(noTrailingBlank).toHaveLength(1);
    expect(noTrailingBlank[0]?.branch).toBe("refs/heads/x");

    const crlf = parseWorktreeListPorcelain("worktree /a\r\nHEAD abc\r\n\r\n");
    expect(crlf[0]?.path).toBe("/a");
    expect(crlf[0]?.head).toBe("abc");

    expect(parseWorktreeListPorcelain("")).toEqual([]);
  });

  it("ignores attribute lines that appear before any worktree line", () => {
    const out = parseWorktreeListPorcelain(["HEAD abc", "branch refs/heads/x", ""].join("\n"));
    expect(out).toEqual([]);
  });
});

describe("shortBranchName", () => {
  it("strips refs/heads/ and leaves other namespaces alone", () => {
    expect(shortBranchName("refs/heads/hydra/feature")).toBe("hydra/feature");
    expect(shortBranchName("refs/remotes/origin/main")).toBe("refs/remotes/origin/main");
    expect(shortBranchName(undefined)).toBeUndefined();
  });
});
