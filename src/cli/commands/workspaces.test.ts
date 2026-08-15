// `hydra workspace list|prune` against real git worktrees.
//
// The case that motivated these: a failed `workspace start` left a
// workspace nothing pointed at, and pruning it deleted the directory
// with a bare rm — so git kept a (locked) worktree registry entry and a
// branch aimed at a path that no longer existed, and `git worktree list`
// stayed wrong until someone cleaned it by hand.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { paths, shortenHomePath } from "../../core/paths.js";
import { collectWorkspaces, runWorkspaceList, runWorkspacePrune } from "./workspaces.js";

const exec = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function makeGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-ws-cli-"));
  tempRoots.push(dir);
  const real = await fs.realpath(dir);
  await fs.writeFile(path.join(real, "tracked.txt"), "original\n");
  await exec("git", ["init", "-b", "main"], { cwd: real });
  await exec("git", ["config", "user.email", "t@e.invalid"], { cwd: real });
  await exec("git", ["config", "user.name", "T"], { cwd: real });
  await exec("git", ["add", "-A"], { cwd: real });
  await exec("git", ["commit", "-q", "-m", "initial"], { cwd: real });
  return real;
}

/**
 * An orphan: a real worktree under the workspaces root that no session
 * record mentions. Built with plain git so the test does not depend on
 * the provisioning path it is meant to be independent of.
 */
async function makeOrphanWorktree(repo: string, label: string): Promise<string> {
  const dir = path.join(paths.home(), "workspaces", "deadbeef", label);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await exec("git", ["worktree", "add", "-b", `hydra/${label}`, dir], { cwd: repo });
  return dir;
}

async function worktreeList(repo: string): Promise<string> {
  const { stdout } = await exec("git", ["worktree", "list"], { cwd: repo });
  return stdout;
}

async function branches(repo: string): Promise<string> {
  const { stdout } = await exec("git", ["branch", "--list", "hydra/*"], { cwd: repo });
  return stdout;
}

describe("workspace prune", () => {
  let out: string;

  beforeEach(() => {
    out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tears down an orphan completely, not just its directory", async () => {
    const repo = await makeGitRepo();
    const dir = await makeOrphanWorktree(repo, "stranded");
    expect(await worktreeList(repo)).toContain(dir);

    await runWorkspacePrune();

    expect(out).toContain("1 removed");
    await expect(fs.access(dir)).rejects.toThrow();
    // The parts a bare rm leaves behind.
    expect(await worktreeList(repo)).not.toContain(dir);
    expect(await branches(repo)).not.toContain("hydra/stranded");
  });

  it("keeps a branch that carries commits, and says so", async () => {
    const repo = await makeGitRepo();
    const dir = await makeOrphanWorktree(repo, "haswork");
    await fs.writeFile(path.join(dir, "new.txt"), "committed in the workspace\n");
    await exec("git", ["add", "-A"], { cwd: dir });
    await exec("git", ["commit", "-q", "-m", "work"], { cwd: dir });

    await runWorkspacePrune();

    // Directory goes; the commits are the durable artifact and stay.
    await expect(fs.access(dir)).rejects.toThrow();
    expect(await branches(repo)).toContain("hydra/haswork");
    expect(out).toContain("commit(s) not in HEAD");
  });

  it("keeps an orphan holding uncommitted work unless forced", async () => {
    const repo = await makeGitRepo();
    const dir = await makeOrphanWorktree(repo, "dirty");
    await fs.writeFile(path.join(dir, "scratch.txt"), "unsaved\n");

    await runWorkspacePrune();

    expect(out).toContain("1 kept");
    // Attribution means the reason is specific rather than a shrug.
    expect(out).toContain("uncommitted change(s)");
    expect(out).not.toContain("state unknown");
    await expect(fs.access(dir)).resolves.toBeUndefined();

    await runWorkspacePrune({ force: true });
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it("shows where the workspace actually is", async () => {
    // The label alone does not tell you the directory: it is the last
    // segment of a path whose parent is a content hash, so there is no
    // way to reconstruct it by hand.
    const repo = await makeGitRepo();
    const dir = await makeOrphanWorktree(repo, "findme");

    await runWorkspaceList();

    expect(out).toContain("WORKSPACE");
    expect(out).toContain(shortenHomePath(dir));
  });

  it("attributes an orphan to its source tree instead of reporting unknown", async () => {
    const repo = await makeGitRepo();
    const dir = await makeOrphanWorktree(repo, "whereami");

    const rows = await collectWorkspaces();
    const row = rows.find((r) => r.path === dir);

    expect(row?.state).toBe("orphan");
    expect(row?.sourceCwd).toBe(repo);
    expect(row?.provider).toBe("git");
    expect(row?.branch).toBe("hydra/whereami");
    expect(row?.clean).toBe(true);
  });
});
