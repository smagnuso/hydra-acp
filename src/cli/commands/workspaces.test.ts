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
import {
  collectWorkspaces,
  runWorkspaceList,
  runWorkspacePrune,
  runWorkspaceRemove,
} from "./workspaces.js";

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

// `remove` on a missing workspace.
//
// The directory is gone but the binding is not, and the row is built FROM
// the binding — so the early "already gone; clearing nothing" return left
// the user unable to clear the row they had just pointed the command at.
// What survives the directory is the binding, the branch, and the
// snapshot refs, and only the branch can hold work.

async function bindSession(
  sessionId: string,
  ws: { path: string; sourceCwd: string; label: string; branch: string; repoRoot: string },
): Promise<string> {
  const dir = path.join(paths.home(), "sessions", sessionId);
  await fs.mkdir(dir, { recursive: true });
  const meta = path.join(dir, "meta.json");
  await fs.writeFile(
    meta,
    JSON.stringify({
      sessionId,
      agent: "claude-code",
      cwd: ws.path,
      workspace: {
        path: ws.path,
        sourceCwd: ws.sourceCwd,
        label: ws.label,
        provider: "git",
        vcs: { kind: "git", branch: ws.branch, repoRoot: ws.repoRoot },
      },
    }),
  );
  return meta;
}

/** A workspace whose directory was deleted without git being told. */
async function makeMissing(
  repo: string,
  label: string,
  sessionId: string,
  opts: { commit?: boolean; branch?: string } = {},
): Promise<{ dir: string; meta: string; branch: string }> {
  const dir = path.join(paths.home(), "workspaces", "deadbeef", label);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  const branch = opts.branch ?? `hydra/${label}`;
  await exec("git", ["worktree", "add", "-b", branch, dir], { cwd: repo });
  if (opts.commit === true) {
    await fs.writeFile(path.join(dir, "work.txt"), "agent work\n");
    await exec("git", ["add", "-A"], { cwd: dir });
    await exec("git", ["commit", "-q", "-m", "agent work"], { cwd: dir });
  }
  const meta = await bindSession(sessionId, {
    path: dir,
    sourceCwd: repo,
    label,
    branch,
    repoRoot: repo,
  });
  // The whole point: gone from disk, still in git's registry and still
  // named by the session record.
  await fs.rm(dir, { recursive: true, force: true });
  return { dir, meta, branch };
}

async function bindingOf(meta: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(meta, "utf8")).workspace;
}

describe("workspace remove — missing", () => {
  afterEach(async () => {
    await fs.rm(path.join(paths.home(), "sessions"), { recursive: true, force: true });
    await fs.rm(path.join(paths.home(), "workspaces"), { recursive: true, force: true });
  });

  it("clears the binding so the row stops being listed", async () => {
    const repo = await makeGitRepo();
    const { meta } = await makeMissing(repo, "gone", "sess-gone");
    expect((await collectWorkspaces()).map((r) => r.state)).toEqual(["missing"]);

    await runWorkspaceRemove({ target: "sess-gone" });

    expect(await bindingOf(meta)).toBeUndefined();
    expect(await collectWorkspaces()).toEqual([]);
  });

  it("leaves the rest of the session record alone", async () => {
    // Subtracting one field, not rewriting the session.
    const repo = await makeGitRepo();
    const { meta } = await makeMissing(repo, "gone", "sess-keep");
    await runWorkspaceRemove({ target: "sess-keep" });
    const rec = JSON.parse(await fs.readFile(meta, "utf8"));
    expect(rec.sessionId).toBe("sess-keep");
    expect(rec.agent).toBe("claude-code");
  });

  it("deletes the empty branch and the stale worktree registration", async () => {
    const repo = await makeGitRepo();
    await makeMissing(repo, "gone", "sess-branch");
    await runWorkspaceRemove({ target: "sess-branch" });
    expect(await branches(repo)).not.toContain("hydra/gone");
    expect(await worktreeList(repo)).not.toContain("gone");
  });

  it("refuses when the branch still holds commits, and changes nothing", async () => {
    // The branch is the only surviving copy of that work, and clearing
    // the binding is what strands it.
    const repo = await makeGitRepo();
    const { meta } = await makeMissing(repo, "work", "sess-work", { commit: true });

    await expect(runWorkspaceRemove({ target: "sess-work" })).rejects.toThrow(
      /1 commit\(s\) not in HEAD/,
    );
    expect(await bindingOf(meta)).toMatchObject({ label: "work" });
    expect(await branches(repo)).toContain("hydra/work");
  });

  it("names the command that would keep the work", async () => {
    const repo = await makeGitRepo();
    await makeMissing(repo, "work", "sess-hint", { commit: true });
    await expect(runWorkspaceRemove({ target: "sess-hint" })).rejects.toThrow(
      /hydra workspace merge sess-hint/,
    );
  });

  it("discards the commits under --force", async () => {
    const repo = await makeGitRepo();
    const { meta } = await makeMissing(repo, "work", "sess-force", { commit: true });
    await runWorkspaceRemove({ target: "sess-force", force: true });
    expect(await bindingOf(meta)).toBeUndefined();
    expect(await branches(repo)).not.toContain("hydra/work");
  });

  it("never deletes a branch outside hydra's namespace", async () => {
    // A workspace checked out on the user's own branch: the binding is
    // ours to clear, the branch is not ours to delete.
    const repo = await makeGitRepo();
    const { meta } = await makeMissing(repo, "mine", "sess-mine", {
      branch: "feature/mine",
      commit: true,
    });
    await runWorkspaceRemove({ target: "sess-mine" });
    expect(await bindingOf(meta)).toBeUndefined();
    const { stdout } = await exec("git", ["branch", "--list", "feature/mine"], { cwd: repo });
    expect(stdout).toContain("feature/mine");
  });

  it("drops the snapshot refs it left behind", async () => {
    // They are GC roots: leaving them pins objects for a checkout that
    // no longer exists.
    const repo = await makeGitRepo();
    await makeMissing(repo, "refs", "sess-refs");
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    for (const ref of ["refs/hydra/snapshots/sess-refs", "refs/hydra/start/sess-refs"]) {
      await exec("git", ["update-ref", ref, head], { cwd: repo });
    }
    await runWorkspaceRemove({ target: "sess-refs" });
    const { stdout } = await exec("git", ["for-each-ref", "refs/hydra/"], { cwd: repo });
    expect(stdout.trim()).toBe("");
  });
});
