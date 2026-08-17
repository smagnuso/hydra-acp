// Nested-tree handling in the git provider, against real repositories.
//
// These tests double as the record of the git behaviour the provider's
// nested methods are built around. Each was verified by hand on git 2.43
// and is asserted here, because every one is a version away from changing
// and the failure mode is silent data loss rather than an error:
//
//   - staging a superproject records a submodule as a gitlink, so
//     uncommitted work inside one is absent from the container's snapshot
//     while still present in its status
//   - a worktree's submodules have their own object store, so a commit that
//     exists only in the source's copy is unreachable from the workspace's
//   - neither `reset --hard` nor `clean -fd` reaches inside a submodule
//
// They exercise the provider through IsolationProvider, not through git, so
// they also pin the abstract contract: listNested / captureNested /
// reproduceNested / integrateNested.

import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GitProvider } from "./git-provider.js";
import { nestedHasWork, type IsolationProvider, type Workspace } from "./provider.js";

const provider: IsolationProvider = new GitProvider();

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

function asWorkspace(root: string, source: string): Workspace {
  return { path: root, sourceCwd: source, label: "t", provider: "git" };
}

/**
 * A superproject with one submodule, plus a worktree of it whose submodule
 * is populated. Mirrors what `workspace start` produces.
 */
async function fixture(): Promise<{
  root: string;
  source: string;
  workspace: string;
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

  return { root, source, workspace };
}

describe("listNested", () => {
  it("returns nothing for a project with no nested trees", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-plain-"));
    await git(["init", "-q", "."], dir);
    await identity(dir);
    await fs.writeFile(path.join(dir, "a.txt"), "a\n");
    await git(["add", "-A"], dir);
    await git(["commit", "-qm", "init"], dir);
    expect(await provider.listNested(dir)).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reports a nested tree as having no work when it matches what is recorded", async () => {
    const { root, source } = await fixture();
    const states = await provider.listNested(source);
    expect(states).toHaveLength(1);
    expect(states[0]!.relPath).toBe("sub");
    expect(states[0]!.actual).toBe(states[0]!.recorded);
    expect(states[0]!.changedPaths).toEqual([]);
    expect(nestedHasWork(states[0]!)).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("sees uncommitted work the container's own snapshot cannot express", async () => {
    const { root, source } = await fixture();
    await fs.writeFile(path.join(source, "sub", "lib.txt"), "v2\n");

    // The premise of the whole design: the container records only a pointer,
    // so this work produces no container-level delta while still showing in
    // its status.
    const delta = await provider.captureDelta(
      source,
      (await provider.currentState(source))!,
      await provider.captureWorkingState(source, "probe"),
    );
    expect(delta!.trim()).toBe("");
    const status = await provider.status(asWorkspace(source, source));
    expect(status.changedPaths).toContain("sub");

    const states = await provider.listNested(source);
    expect(states[0]!.changedPaths).toEqual(["lib.txt"]);
    expect(nestedHasWork(states[0]!)).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("treats a locally advanced nested tree as work even when its own tree is clean", async () => {
    const { root, source } = await fixture();
    await fs.writeFile(path.join(source, "sub", "lib.txt"), "v2\n");
    await git(["commit", "-qam", "sub advance"], path.join(source, "sub"));

    const states = await provider.listNested(source);
    expect(states[0]!.changedPaths).toEqual([]);
    expect(states[0]!.actual).not.toBe(states[0]!.recorded);
    expect(nestedHasWork(states[0]!)).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("ignores a declared nested path that climbs out of the tree", async () => {
    // Nested paths come from tracked project config, so they can arrive on a
    // line someone else wrote, and each gets joined onto two roots before
    // being used as a cwd. Git validates these itself; this asserts our own
    // guard rather than git's.
    const { root, source } = await fixture();
    await fs.writeFile(
      path.join(source, ".gitmodules"),
      `[submodule "esc"]\n\tpath = ../escaped\n\turl = ./nowhere\n`,
    );
    const states = await provider.listNested(source);
    expect(states.map((s) => s.relPath)).not.toContain("../escaped");
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("reproduceNested", () => {
  it("reproduces uncommitted nested work in the workspace, unstaged", async () => {
    const { root, source, workspace } = await fixture();
    await fs.writeFile(path.join(source, "sub", "lib.txt"), "v2\n");
    await fs.writeFile(path.join(source, "sub", "fresh.txt"), "new\n");

    const captures = await provider.captureNested(source, await provider.listNested(source));
    expect(captures).toHaveLength(1);
    expect(captures[0]!.delta).toBeDefined();

    const res = await provider.reproduceNested(workspace, source, captures);
    expect(res.failed).toEqual([]);
    expect(res.applied).toEqual(["sub"]);

    expect(await fs.readFile(path.join(workspace, "sub", "lib.txt"), "utf8")).toBe("v2\n");
    expect(await fs.readFile(path.join(workspace, "sub", "fresh.txt"), "utf8")).toBe("new\n");

    // Unstaged and untracked, matching the container's own carry contract:
    // the agent's first bare commit must not sweep up the user's work.
    const staged = await provider.status(
      asWorkspace(path.join(workspace, "sub"), path.join(source, "sub")),
    );
    expect(staged.hasStagedWork).toBe(false);

    // And the source is untouched: carry copies, it does not move.
    expect(await fs.readFile(path.join(source, "sub", "lib.txt"), "utf8")).toBe("v2\n");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("transfers a state that exists only in the source's copy", async () => {
    const { root, source, workspace } = await fixture();
    await fs.writeFile(path.join(source, "sub", "lib.txt"), "v2\n");
    await git(["commit", "-qam", "sub advance"], path.join(source, "sub"));
    const advanced = (await provider.currentState(path.join(source, "sub")))!;

    // The premise for the transfer: nested trees do not share storage
    // between materializations, so this commit is unreachable from the
    // workspace's copy until it is fetched.
    const before = await git(
      ["cat-file", "-e", `${advanced}^{commit}`],
      path.join(workspace, "sub"),
    );
    expect(before.ok).toBe(false);

    const captures = await provider.captureNested(source, await provider.listNested(source));
    const res = await provider.reproduceNested(workspace, source, captures);
    expect(res.failed).toEqual([]);
    expect(await provider.currentState(path.join(workspace, "sub"))).toBe(advanced);
    expect(await fs.readFile(path.join(workspace, "sub", "lib.txt"), "utf8")).toBe("v2\n");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reproduces an advanced nested tree AND uncommitted work on top of it", async () => {
    const { root, source, workspace } = await fixture();
    await fs.writeFile(path.join(source, "sub", "lib.txt"), "v2\n");
    await git(["commit", "-qam", "sub advance"], path.join(source, "sub"));
    await fs.writeFile(path.join(source, "sub", "lib.txt"), "v3\n");

    const captures = await provider.captureNested(source, await provider.listNested(source));
    const res = await provider.reproduceNested(workspace, source, captures);
    expect(res.failed).toEqual([]);
    // v3 only lands if the tree moved to the advanced state FIRST: the
    // delta is v2->v3, so applying it against v1 fails on context.
    expect(await fs.readFile(path.join(workspace, "sub", "lib.txt"), "utf8")).toBe("v3\n");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("leaves no scratch index file behind in the captured tree", async () => {
    const { root, source, workspace } = await fixture();
    await fs.writeFile(path.join(source, "sub", "lib.txt"), "v2\n");

    const captures = await provider.captureNested(source, await provider.listNested(source));
    await provider.reproduceNested(workspace, source, captures);

    for (const dir of [path.join(source, "sub"), path.join(workspace, "sub")]) {
      const entries = await fs.readdir(dir);
      expect(entries.filter((e) => e.includes("hydra-index"))).toEqual([]);
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it("ignores an unregistered nested tree instead of populating it", async () => {
    const { root, source, workspace } = await fixture();
    // `deinit` clears the containing tree's copy and unregisters it in the
    // config every worktree of the repo shares, so both trees stop reporting
    // it. An unregistered nested tree is a choice about the project, not a
    // gap to fill in.
    await git(["submodule", "deinit", "-f", "sub"], source);
    await fs.writeFile(path.join(workspace, "sub", "lib.txt"), "ws\n");

    expect(await provider.listNested(source)).toEqual([]);
    expect(await provider.listNested(workspace)).toEqual([]);
    const captures = await provider.captureNested(workspace, await provider.listNested(workspace));
    expect(captures).toEqual([]);
    expect(await provider.reproduceNested(source, workspace, captures)).toEqual({
      applied: [],
      failed: [],
    });
    expect(await fs.readdir(path.join(source, "sub"))).toEqual([]);
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("integrateNested", () => {
  /**
   * The agent commits inside a nested tree and advances what the container
   * records, then the container integrates. This is the case that leaves the
   * source pointing at a state its own nested copy has never seen.
   */
  async function landingFixture() {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "sub", "lib.txt"), "agent\n");
    await git(["commit", "-qam", "agent work in sub"], path.join(f.workspace, "sub"));
    const bumped = (await provider.currentState(path.join(f.workspace, "sub")))!;
    await git(["add", "sub"], f.workspace);
    await git(["commit", "-qm", "bump sub"], f.workspace);
    await git(["merge", "--ff-only", "hydra/t"], f.source);
    return { ...f, bumped };
  }

  it("moves the source's nested tree onto the integrated state, transferring it", async () => {
    const { root, source, workspace, bumped } = await landingFixture();

    // The premise: the integration moved the pointer but not the tree, and
    // the source's nested store cannot even reach the state it now records.
    const status = await provider.status(asWorkspace(source, source));
    expect(status.changedPaths).toContain("sub");
    const reachable = await git(["cat-file", "-e", `${bumped}^{commit}`], path.join(source, "sub"));
    expect(reachable.ok).toBe(false);

    const res = await provider.integrateNested(source, workspace, []);
    expect(res.failed).toEqual([]);
    expect(res.applied).toEqual(["sub"]);
    expect(await provider.currentState(path.join(source, "sub"))).toBe(bumped);
    expect(await fs.readFile(path.join(source, "sub", "lib.txt"), "utf8")).toBe("agent\n");
    // And the container is clean again, which is the whole point.
    expect((await provider.status(asWorkspace(source, source))).changedPaths).toEqual([]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("brings the workspace's uncommitted nested work across as uncommitted", async () => {
    const { root, source, workspace } = await landingFixture();
    await fs.writeFile(path.join(workspace, "sub", "wip.txt"), "wip\n");
    const captures = await provider.captureNested(workspace, await provider.listNested(workspace));

    const res = await provider.integrateNested(source, workspace, captures);
    expect(res.failed).toEqual([]);
    expect(await fs.readFile(path.join(source, "sub", "wip.txt"), "utf8")).toBe("wip\n");
    const st = await provider.status(
      asWorkspace(path.join(source, "sub"), path.join(source, "sub")),
    );
    expect(st.changedPaths).toContain("wip.txt");
    expect(st.hasStagedWork).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("refuses to touch a nested tree holding its own uncommitted work", async () => {
    const { root, source, workspace, bumped } = await landingFixture();
    await fs.writeFile(path.join(source, "sub", "mine.txt"), "mine\n");

    const res = await provider.integrateNested(source, workspace, []);
    expect(res.applied).toEqual([]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]!.path).toBe("sub");
    expect(res.failed[0]!.reason).toContain("uncommitted change");
    // Untouched: the user's file is still there and the tree did not move.
    expect(await fs.readFile(path.join(source, "sub", "mine.txt"), "utf8")).toBe("mine\n");
    expect(await provider.currentState(path.join(source, "sub"))).not.toBe(bumped);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does nothing when nothing moved and nothing was left uncommitted", async () => {
    const { root, source, workspace } = await fixture();
    expect(await provider.integrateNested(source, workspace, [])).toEqual({
      applied: [],
      failed: [],
    });
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("resetTo", () => {
  it("clears nested dirt, which the container-level reset cannot reach", async () => {
    const { root, source, workspace } = await fixture();
    const base = (await provider.currentState(workspace))!;
    await fs.writeFile(path.join(workspace, "sub", "lib.txt"), "mangled\n");
    await fs.writeFile(path.join(workspace, "sub", "junk.txt"), "junk\n");

    const res = await provider.resetTo(workspace, base);
    expect(res.ok).toBe(true);
    // Neither `reset --hard` nor `clean -fd` recurses into a nested tree, so
    // without explicit handling both of these would survive.
    expect(await fs.readFile(path.join(workspace, "sub", "lib.txt"), "utf8")).toBe("v1\n");
    await expect(fs.access(path.join(workspace, "sub", "junk.txt"))).rejects.toThrow();
    await fs.rm(root, { recursive: true, force: true });
  });
});
