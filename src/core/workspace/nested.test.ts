// Nested-tree carry, against real repositories.
//
// These tests double as the record of the git behaviour the module is
// built around. Each claim in nested.ts's header was verified on git
// 2.43 by hand and is asserted here, because every one of them is a
// version away from changing and the failure mode is silent data loss
// rather than an error.

import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyNestedCarry,
  captureNested,
  enumerateNested,
  landNested,
  nestedHasWork,
  nestedReportPaths,
} from "./nested.js";

function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      // Local-path submodules are refused by default since the
      // CVE-2022-39253 fix; these fixtures are ours, so allow them.
      ["-c", "protocol.file.allow=always", ...args],
      { cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: stdout ?? "", err: stderr ?? "" }),
    );
  });
}

async function identity(repo: string): Promise<void> {
  await git(["config", "user.email", "t@t"], repo);
  await git(["config", "user.name", "t"], repo);
}

/**
 * A superproject with one submodule, plus a worktree of the superproject
 * whose submodule is populated. Mirrors what `workspace start` produces.
 */
async function fixture(): Promise<{
  root: string;
  source: string;
  workspace: string;
  sub: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-nested-"));
  const sub = path.join(root, "sub-origin");
  const source = path.join(root, "source");

  await fs.mkdir(sub, { recursive: true });
  await git(["init", "-q", "."], sub);
  await identity(sub);
  await fs.writeFile(path.join(sub, "lib.txt"), "v1\n");
  await git(["add", "-A"], sub);
  await git(["commit", "-qm", "sub init"], sub);

  await fs.mkdir(source, { recursive: true });
  await git(["init", "-q", "."], source);
  await identity(source);
  await fs.writeFile(path.join(source, "top.txt"), "top\n");
  await git(["add", "-A"], source);
  await git(["commit", "-qm", "init"], source);
  await git(["submodule", "add", "-q", sub, "sub"], source);
  await git(["commit", "-qm", "add sub"], source);
  await identity(path.join(source, "sub"));

  const workspace = path.join(root, "ws");
  await git(["worktree", "add", "-q", "--no-track", "-b", "hydra/t", workspace, "HEAD"], source);
  await git(["submodule", "update", "--init", "--recursive"], workspace);

  return { root, source, workspace, sub };
}

describe("nested-tree enumeration", () => {
  it("returns nothing for a repo with no submodules", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-plain-"));
    await git(["init", "-q", "."], dir);
    await identity(dir);
    await fs.writeFile(path.join(dir, "a.txt"), "a\n");
    await git(["add", "-A"], dir);
    await git(["commit", "-qm", "init"], dir);
    expect(await enumerateNested(dir)).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("ignores a declared nested path that climbs out of the tree", async () => {
    // `.gitmodules` is tracked, so a path here can arrive on a branch
    // someone else wrote, and every one of them gets joined onto both a
    // source root and a workspace root. Git validates these itself, so this
    // asserts our own guard rather than git's: the parse is driven directly
    // to prove a traversing path is dropped instead of resolved.
    const { root, source } = await fixture();
    await fs.writeFile(
      path.join(source, ".gitmodules"),
      `[submodule "esc"]\n\tpath = ../escaped\n\turl = ./nowhere\n`,
    );
    const states = await enumerateNested(source);
    expect(states.map((s) => s.relPath)).not.toContain("../escaped");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports a submodule as clean when it matches the recorded gitlink", async () => {
    const { root, source } = await fixture();
    const states = await enumerateNested(source);
    expect(states).toHaveLength(1);
    expect(states[0]!.relPath).toBe("sub");
    expect(states[0]!.head).toBe(states[0]!.gitlink);
    expect(states[0]!.changedPaths).toEqual([]);
    expect(nestedHasWork(states[0]!)).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("sees uncommitted work inside a submodule that the superproject cannot express", async () => {
    const { root, source } = await fixture();
    await fs.writeFile(path.join(source, "sub", "lib.txt"), "v2\n");

    // The premise of the whole module: the superproject's own snapshot
    // records only a gitlink, so this work produces no superproject diff
    // while still showing up in its status.
    const superStatus = await git(["status", "--porcelain", "-uall"], source);
    expect(superStatus.out).toContain("sub");

    const states = await enumerateNested(source);
    expect(states[0]!.changedPaths).toEqual(["lib.txt"]);
    expect(nestedHasWork(states[0]!)).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("treats a locally advanced submodule as work even when its tree is clean", async () => {
    const { root, source } = await fixture();
    await fs.writeFile(path.join(source, "sub", "lib.txt"), "v2\n");
    await git(["commit", "-qam", "sub advance"], path.join(source, "sub"));

    const states = await enumerateNested(source);
    expect(states[0]!.changedPaths).toEqual([]);
    expect(states[0]!.head).not.toBe(states[0]!.gitlink);
    expect(nestedHasWork(states[0]!)).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("nested-tree carry", () => {
  it("reproduces uncommitted submodule work in the workspace, unstaged", async () => {
    const { root, source, workspace } = await fixture();
    await fs.writeFile(path.join(source, "sub", "lib.txt"), "v2\n");
    await fs.writeFile(path.join(source, "sub", "fresh.txt"), "new\n");

    const carries = await captureNested(source, await enumerateNested(source));
    expect(carries).toHaveLength(1);
    expect(carries[0]!.patch).toBeDefined();

    const res = await applyNestedCarry(workspace, source, carries);
    expect(res.failed).toEqual([]);
    expect(res.applied).toEqual(["sub"]);

    expect(await fs.readFile(path.join(workspace, "sub", "lib.txt"), "utf8")).toBe("v2\n");
    expect(await fs.readFile(path.join(workspace, "sub", "fresh.txt"), "utf8")).toBe("new\n");

    // Unstaged and untracked, matching the superproject's carry contract:
    // the agent's first bare commit must not sweep up the user's work.
    const staged = await git(["diff", "--cached", "--name-only"], path.join(workspace, "sub"));
    expect(staged.out.trim()).toBe("");
    const st = await git(["status", "--porcelain", "-uall"], path.join(workspace, "sub"));
    expect(st.out).toContain("?? fresh.txt");

    // And the source is untouched: carry copies, it does not move.
    expect(await fs.readFile(path.join(source, "sub", "lib.txt"), "utf8")).toBe("v2\n");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("aligns the workspace submodule to a commit that exists only in the source", async () => {
    const { root, source, workspace } = await fixture();
    await fs.writeFile(path.join(source, "sub", "lib.txt"), "v2\n");
    await git(["commit", "-qam", "sub advance"], path.join(source, "sub"));
    const advanced = (await git(["rev-parse", "HEAD"], path.join(source, "sub"))).out.trim();

    // The premise for the fetch: a worktree's submodule has its own
    // object store, so a commit made only in the source's copy is not
    // reachable from the workspace's copy.
    const before = await git(
      ["cat-file", "-e", `${advanced}^{commit}`],
      path.join(workspace, "sub"),
    );
    expect(before.ok).toBe(false);

    const carries = await captureNested(source, await enumerateNested(source));
    const res = await applyNestedCarry(workspace, source, carries);
    expect(res.failed).toEqual([]);
    expect((await git(["rev-parse", "HEAD"], path.join(workspace, "sub"))).out.trim()).toBe(
      advanced,
    );
    expect(await fs.readFile(path.join(workspace, "sub", "lib.txt"), "utf8")).toBe("v2\n");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("carries an advanced submodule AND uncommitted work on top of it", async () => {
    const { root, source, workspace } = await fixture();
    await fs.writeFile(path.join(source, "sub", "lib.txt"), "v2\n");
    await git(["commit", "-qam", "sub advance"], path.join(source, "sub"));
    await fs.writeFile(path.join(source, "sub", "lib.txt"), "v3\n");

    const carries = await captureNested(source, await enumerateNested(source));
    const res = await applyNestedCarry(workspace, source, carries);
    expect(res.failed).toEqual([]);
    // v3 only lands if the checkout moved to the advanced commit FIRST:
    // the patch is v2->v3, so applying it against v1 fails on context.
    expect(await fs.readFile(path.join(workspace, "sub", "lib.txt"), "utf8")).toBe("v3\n");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not leave its own index file behind in the captured tree", async () => {
    const { root, source, workspace } = await fixture();
    await fs.writeFile(path.join(source, "sub", "lib.txt"), "v2\n");

    const carries = await captureNested(source, await enumerateNested(source));
    await applyNestedCarry(workspace, source, carries);

    for (const dir of [path.join(source, "sub"), path.join(workspace, "sub")]) {
      const entries = await fs.readdir(dir);
      expect(entries.filter((e) => e.includes("hydra-nested-index"))).toEqual([]);
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it("ignores an unregistered submodule instead of populating it", async () => {
    const { root, source, workspace } = await fixture();
    // `deinit` clears the containing tree's copy and unregisters the
    // submodule in `.git/config`, which every worktree of the repo shares.
    // So both trees stop reporting it, and neither carry nor landing has
    // any business bringing it back: an unregistered submodule is a choice
    // the user made about the repo, not a gap to fill in.
    await git(["submodule", "deinit", "-f", "sub"], source);
    await fs.writeFile(path.join(workspace, "sub", "lib.txt"), "ws\n");

    expect(await enumerateNested(source)).toEqual([]);
    expect(await enumerateNested(workspace)).toEqual([]);
    const carries = await captureNested(workspace, await enumerateNested(workspace));
    expect(carries).toEqual([]);
    const res = await landNested(source, workspace, carries);
    expect(res).toEqual({ landed: [], skipped: [] });
    // And the source's cleared directory stays cleared.
    expect(await fs.readdir(path.join(source, "sub"))).toEqual([]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("names every changed file inside a submodule, not just the submodule", async () => {
    const { root, source } = await fixture();
    await fs.writeFile(path.join(source, "sub", "lib.txt"), "v2\n");
    await fs.writeFile(path.join(source, "sub", "other.txt"), "x\n");

    const carries = await captureNested(source, await enumerateNested(source));
    const reported = nestedReportPaths(carries);
    // The superproject would have reported this as the single path "sub".
    expect(reported).toContain("sub/lib.txt");
    expect(reported).toContain("sub/other.txt");
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("nested-tree landing", () => {
  /**
   * The agent commits inside a submodule and bumps the gitlink in the
   * workspace, then the superproject fast-forwards. This is the case that
   * leaves the source pointing at a commit its own submodule store has
   * never seen.
   */
  async function landingFixture() {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "sub", "lib.txt"), "agent\n");
    await git(["commit", "-qam", "agent work in sub"], path.join(f.workspace, "sub"));
    const bumped = (await git(["rev-parse", "HEAD"], path.join(f.workspace, "sub"))).out.trim();
    await git(["add", "sub"], f.workspace);
    await git(["commit", "-qm", "bump sub"], f.workspace);
    await git(["merge", "--ff-only", "hydra/t"], f.source);
    return { ...f, bumped };
  }

  it("checks out the landed gitlink in the source, fetching objects it lacks", async () => {
    const { root, source, workspace, bumped } = await landingFixture();

    // The premise: the fast-forward moved the gitlink but not the
    // checkout, and the source's submodule store cannot even reach the
    // commit it now records.
    const dirty = await git(["status", "--porcelain"], source);
    expect(dirty.out).toContain("sub");
    const reachable = await git(["cat-file", "-e", `${bumped}^{commit}`], path.join(source, "sub"));
    expect(reachable.ok).toBe(false);

    const res = await landNested(source, workspace, []);
    expect(res.skipped).toEqual([]);
    expect(res.landed).toEqual(["sub"]);
    expect((await git(["rev-parse", "HEAD"], path.join(source, "sub"))).out.trim()).toBe(bumped);
    expect(await fs.readFile(path.join(source, "sub", "lib.txt"), "utf8")).toBe("agent\n");
    // And the superproject is clean again, which is the whole point.
    expect((await git(["status", "--porcelain"], source)).out.trim()).toBe("");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lands the workspace's uncommitted submodule work as uncommitted", async () => {
    const { root, source, workspace } = await landingFixture();
    await fs.writeFile(path.join(workspace, "sub", "wip.txt"), "wip\n");
    const carries = await captureNested(workspace, await enumerateNested(workspace));

    const res = await landNested(source, workspace, carries);
    expect(res.skipped).toEqual([]);
    expect(await fs.readFile(path.join(source, "sub", "wip.txt"), "utf8")).toBe("wip\n");
    const st = await git(["status", "--porcelain", "-uall"], path.join(source, "sub"));
    expect(st.out).toContain("?? wip.txt");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("refuses to touch a source submodule that has its own uncommitted work", async () => {
    const { root, source, workspace, bumped } = await landingFixture();
    await fs.writeFile(path.join(source, "sub", "mine.txt"), "mine\n");

    const res = await landNested(source, workspace, []);
    expect(res.landed).toEqual([]);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]!.path).toBe("sub");
    expect(res.skipped[0]!.reason).toContain("uncommitted change");
    // Untouched: the user's file is still there and the checkout did not move.
    expect(await fs.readFile(path.join(source, "sub", "mine.txt"), "utf8")).toBe("mine\n");
    expect((await git(["rev-parse", "HEAD"], path.join(source, "sub"))).out.trim()).not.toBe(
      bumped,
    );
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does nothing when no gitlink moved and nothing was left uncommitted", async () => {
    const { root, source, workspace } = await fixture();
    const res = await landNested(source, workspace, []);
    expect(res).toEqual({ landed: [], skipped: [] });
    await fs.rm(root, { recursive: true, force: true });
  });
});
