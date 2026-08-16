// One contract suite, run against every provider.
//
// This is the file that decides whether IsolationProvider is a real
// abstraction or git wearing a different hat. Every assertion below is
// written against the interface only; nothing here knows what a commit,
// a branch, or a worktree is. A provider that needs a special case added
// to this table has found a hole in the contract, and the fix belongs in
// the contract rather than in an exception here.

import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { CopyProvider } from "./copy-provider.js";
import { GitProvider } from "./git-provider.js";
import {
  WorkspaceUnsupportedError,
  type IsolationProvider,
  type Workspace,
} from "./provider.js";

const exec = promisify(execFile);

const tempRoots: string[] = [];

afterEach(async () => {
  // HYDRA_ACP_HOME (and therefore every workspace) is cleaned by
  // vitest.setup.ts, but source trees live in the OS tmpdir and would
  // otherwise accumulate across runs.
  await Promise.all(
    tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  // macOS /var/folders is a symlink to /private/var/folders; git reports
  // the resolved path, so compare like with like.
  return fs.realpath(dir);
}

async function makePlainSource(): Promise<string> {
  const dir = await makeTempDir("hydra-ws-plain-");
  await fs.writeFile(path.join(dir, "file.txt"), "original\n");
  await fs.mkdir(path.join(dir, "nested"), { recursive: true });
  await fs.writeFile(path.join(dir, "nested", "deep.txt"), "deep\n");
  return dir;
}

async function makeGitSource(): Promise<string> {
  const dir = await makePlainSource();
  await exec("git", ["init", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  await exec("git", ["config", "user.name", "Test"], { cwd: dir });
  await exec("git", ["add", "-A"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

interface Fixture {
  kind: string;
  provider: () => IsolationProvider;
  makeSource: () => Promise<string>;
}

const FIXTURES: Fixture[] = [
  { kind: "git", provider: () => new GitProvider(), makeSource: makeGitSource },
  { kind: "copy", provider: () => new CopyProvider(), makeSource: makePlainSource },
];

describe.each(FIXTURES)("IsolationProvider contract [$kind]", (fixture) => {
  async function created(label = "wsA"): Promise<{
    provider: IsolationProvider;
    source: string;
    ws: NonNullable<Awaited<ReturnType<IsolationProvider["createWorkspace"]>> & { ok: true }>["workspace"];
  }> {
    const provider = fixture.provider();
    const source = await fixture.makeSource();
    const res = await provider.createWorkspace({ sourceCwd: source, label });
    if (!res.ok) {
      throw new Error(`createWorkspace failed for ${fixture.kind}: ${res.reason}`);
    }
    return { provider, source, ws: res.workspace };
  }

  it("creates a workspace that exists, carries its source, and names this provider", async () => {
    const { provider, source, ws } = await created();
    expect((await fs.stat(ws.path)).isDirectory()).toBe(true);
    expect(ws.sourceCwd).toBe(source);
    expect(ws.provider).toBe(provider.kind);
  });

  it("places the workspace outside its source tree", async () => {
    // Load-bearing, not cosmetic. Everything downstream (the cwd= filter,
    // budgeter's spend attribution) is forbidden from relating a
    // workspace to its source by path prefix, and this is why.
    const { source, ws } = await created();
    expect(ws.path.startsWith(source + path.sep)).toBe(false);
    expect(ws.path).not.toBe(source);
  });

  it("carries the source's content into the workspace", async () => {
    const { ws } = await created();
    expect(await fs.readFile(path.join(ws.path, "file.txt"), "utf8")).toBe("original\n");
    expect(await fs.readFile(path.join(ws.path, "nested", "deep.txt"), "utf8")).toBe("deep\n");
  });

  it("isolates writes from the source tree", async () => {
    const { source, ws } = await created();
    await fs.writeFile(path.join(ws.path, "file.txt"), "changed in workspace\n");
    await fs.writeFile(path.join(ws.path, "brand-new.txt"), "new\n");

    expect(await fs.readFile(path.join(source, "file.txt"), "utf8")).toBe("original\n");
    await expect(fs.access(path.join(source, "brand-new.txt"))).rejects.toThrow();
  });

  it("reports clean immediately after creation", async () => {
    const { provider, ws } = await created();
    const status = await provider.status(ws);
    expect(status.clean).toBe(true);
    expect(status.changedPaths).toEqual([]);
  });

  it("reports dirty and names the changed path after an edit", async () => {
    const { provider, ws } = await created();
    await fs.writeFile(path.join(ws.path, "brand-new.txt"), "new\n");
    const status = await provider.status(ws);
    expect(status.clean).toBe(false);
    expect(status.changedPaths).toContain("brand-new.txt");
  });

  it("returns changed paths repo-relative, never absolute", async () => {
    const { provider, ws } = await created();
    await fs.writeFile(path.join(ws.path, "nested", "deep.txt"), "edited\n");
    const status = await provider.status(ws);
    expect(status.changedPaths.length).toBeGreaterThan(0);
    for (const p of status.changedPaths) {
      expect(path.isAbsolute(p)).toBe(false);
    }
  });

  it("lists the workspace it created, and stops listing it after removal", async () => {
    const { provider, source, ws } = await created();
    const before = await provider.listWorkspaces(source);
    expect(before.map((w) => w.path)).toContain(ws.path);

    await provider.removeWorkspace(ws, { force: true });
    const after = await provider.listWorkspaces(source);
    expect(after.map((w) => w.path)).not.toContain(ws.path);
    await expect(fs.access(ws.path)).rejects.toThrow();
  });

  it("refuses to remove a dirty workspace without force", async () => {
    const { provider, ws } = await created();
    await fs.writeFile(path.join(ws.path, "brand-new.txt"), "new\n");
    await expect(provider.removeWorkspace(ws, { force: false })).rejects.toThrow();
    expect((await fs.stat(ws.path)).isDirectory()).toBe(true);
  });

  it("never hands back an existing workspace for a duplicate label", async () => {
    // The property that matters is distinctness, not refusal. Callers ask
    // for isolation rather than for a particular name, so a taken label
    // gets suffixed; what must never happen is two sessions pointed at
    // one checkout, which is the failure this whole mechanism prevents.
    const { provider, source, ws } = await created("dupe");
    const again = await provider.createWorkspace({ sourceCwd: source, label: "dupe" });
    expect(again.ok).toBe(true);
    if (!again.ok) {
      return;
    }
    expect(again.workspace.path).not.toBe(ws.path);
    // Both remain usable and independent.
    await fs.writeFile(path.join(ws.path, "a.txt"), "first\n");
    await fs.writeFile(path.join(again.workspace.path, "a.txt"), "second\n");
    expect(await fs.readFile(path.join(ws.path, "a.txt"), "utf8")).toBe("first\n");
  });

  it("reports a missing source as a reason rather than throwing", async () => {
    const provider = fixture.provider();
    const res = await provider.createWorkspace({
      sourceCwd: path.join(os.tmpdir(), "hydra-does-not-exist-9f3a2b"),
      label: "nope",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason.length).toBeGreaterThan(0);
    }
  });

  it("throws WorkspaceUnsupportedError for operations it declares unsupported", async () => {
    const { provider, ws } = await created();
    const supports = provider.capabilities().supports;
    if (!supports.record) {
      await expect(provider.record(ws, "m")).rejects.toBeInstanceOf(WorkspaceUnsupportedError);
    }
    if (!supports.integrate) {
      await expect(
        provider.integrate({ from: ws.snapshot ?? ("x" as never), into: ws }),
      ).rejects.toBeInstanceOf(WorkspaceUnsupportedError);
    }
  });

  it("produces environment notes that name the source tree", async () => {
    const { provider, source, ws } = await created();
    if (!provider.capabilities().supports.environmentNotes) {
      return;
    }
    const notes = await provider.environmentNotes(ws);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.join(" ")).toContain(source);
  });

  it("reports its own state as lines that name what changed", async () => {
    const { provider, ws } = await created();
    const before = (await provider.statusReport(ws)).join("\n");
    expect(before.length).toBeGreaterThan(0);
    expect(before).not.toContain("file.txt");

    await fs.writeFile(path.join(ws.path, "file.txt"), "edited by the agent\n");
    const after = (await provider.statusReport(ws)).join("\n");
    expect(after).toContain("file.txt");
  });
});

describe("git provider specifics", () => {
  async function gitWorkspace(label: string): Promise<{
    provider: GitProvider;
    source: string;
    ws: Workspace;
  }> {
    const provider = new GitProvider();
    const source = await makeGitSource();
    const res = await provider.createWorkspace({ sourceCwd: source, label });
    if (!res.ok) {
      throw new Error(`createWorkspace failed: ${res.reason}`);
    }
    return { provider, source, ws: res.workspace };
  }

  it("separates staged, unstaged and untracked in its status report", async () => {
    // The distinction the shared WorkspaceStatus shape cannot carry, which
    // is why the report is prose. `git add` then edit again leaves ONE
    // file both staged and unstaged, and both halves are true at once.
    const { provider, ws } = await gitWorkspace("codes");
    await fs.writeFile(path.join(ws.path, "file.txt"), "staged\n");
    await exec("git", ["add", "file.txt"], { cwd: ws.path });
    await fs.writeFile(path.join(ws.path, "nested", "deep.txt"), "unstaged\n");
    await fs.writeFile(path.join(ws.path, "fresh.ts"), "export {};\n");

    const report = (await provider.statusReport(ws)).join("\n");
    expect(report).toMatch(/1 staged/);
    expect(report).toMatch(/1 unstaged/);
    expect(report).toMatch(/1 untracked/);
    expect(report).toContain("M  file.txt");
    expect(report).toContain(" M nested/deep.txt");
    expect(report).toContain("?? fresh.ts");
  });

  it("says it is in sync with the source when neither side has moved", async () => {
    const { provider, source, ws } = await gitWorkspace("insync");
    const report = (await provider.statusReport(ws)).join("\n");
    expect(report).toContain(`in sync with ${source}`);
  });

  it("counts the source's new commits and names the verb that brings them in", async () => {
    // The whole point of reporting this: landing is fast-forward-only, so
    // a source that moved on turns `stop` into a refusal, and today the
    // only way to find that out is to run `stop` and read the failure.
    const { provider, ws } = await gitWorkspace("behind");
    await fs.writeFile(path.join(ws.sourceCwd, "moved-on.txt"), "meanwhile\n");
    await exec("git", ["add", "-A"], { cwd: ws.sourceCwd });
    await exec("git", ["commit", "-q", "-m", "source moved on"], { cwd: ws.sourceCwd });

    const report = (await provider.statusReport(ws)).join("\n");
    expect(report).toContain("1 commit(s) behind");
    expect(report).toContain("/hydra workspace sync");
    expect(report).not.toContain("in sync with");
  });

  it("counts its own commits as not landed yet", async () => {
    const { provider, ws } = await gitWorkspace("ahead");
    await fs.writeFile(path.join(ws.path, "agent.ts"), "export {};\n");
    await exec("git", ["add", "-A"], { cwd: ws.path });
    await exec("git", ["commit", "-q", "-m", "agent work"], { cwd: ws.path });

    const report = (await provider.statusReport(ws)).join("\n");
    expect(report).toContain("1 commit(s) recorded here and not landed yet");
    expect(report).toContain("no uncommitted changes");
  });

  it("declines a directory that is not a repository, with a reason", async () => {
    const provider = new GitProvider();
    const plain = await makePlainSource();
    const res = await provider.createWorkspace({ sourceCwd: plain, label: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/not a git repository/i);
    }
  });

  it("declines a repository with no commits rather than throwing", async () => {
    const provider = new GitProvider();
    const dir = await makeTempDir("hydra-ws-empty-");
    await exec("git", ["init", "-b", "main"], { cwd: dir });
    const res = await provider.createWorkspace({ sourceCwd: dir, label: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/no commits/i);
    }
  });

  it("guards untracked files itself, because git worktree remove does not", async () => {
    // Regression pin, and a warning against "simplifying" removeWorkspace
    // to just shell out to `git worktree remove`. On git 2.43 that command
    // deletes a worktree containing untracked files and exits 0; it only
    // refuses for modified TRACKED files. Untracked files are exactly what
    // an agent produces, so the provider must make this call itself.
    const provider = new GitProvider();
    const source = await makeGitSource();
    const res = await provider.createWorkspace({ sourceCwd: source, label: "untracked" });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    // Untracked only: nothing tracked is modified.
    await fs.writeFile(path.join(res.workspace.path, "agent-wrote-this.ts"), "export {};\n");

    await expect(provider.removeWorkspace(res.workspace, { force: false })).rejects.toThrow();
    expect(
      await fs.readFile(path.join(res.workspace.path, "agent-wrote-this.ts"), "utf8"),
    ).toBe("export {};\n");
  });

  it("rebuilds a deleted workspace with its committed work intact", async () => {
    // This is what makes an isolated session resurrectable at all. The
    // session's recorded cwd IS the workspace, so if a deleted workspace
    // could not be rebuilt, the session would have nowhere to come back
    // to. `git worktree remove` deletes only the checkout: the branch and
    // its commits are ordinary refs and survive.
    const provider = new GitProvider();
    const source = await makeGitSource();
    const res = await provider.createWorkspace({ sourceCwd: source, label: "restoreme" });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    const ws = res.workspace;

    await fs.writeFile(path.join(ws.path, "committed.txt"), "durable\n");
    await exec("git", ["add", "-A"], { cwd: ws.path });
    await exec("git", ["commit", "-q", "-m", "agent work"], { cwd: ws.path });
    // Uncommitted alongside it, to pin what does NOT survive.
    await fs.writeFile(path.join(ws.path, "scratch.txt"), "ephemeral\n");

    await provider.removeWorkspace(ws, { force: true });
    await expect(fs.access(ws.path)).rejects.toThrow();

    const restored = await provider.rematerialize(ws);
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      return;
    }
    expect(await fs.readFile(path.join(restored.workspace.path, "committed.txt"), "utf8")).toBe(
      "durable\n",
    );
    // Uncommitted work died with the directory. Same bargain git makes
    // everywhere else, but worth pinning so nobody assumes otherwise.
    await expect(fs.access(path.join(restored.workspace.path, "scratch.txt"))).rejects.toThrow();
  });

  it("declines to rebuild when the source repository itself is gone", async () => {
    const provider = new GitProvider();
    const source = await makeGitSource();
    const res = await provider.createWorkspace({ sourceCwd: source, label: "orphaned" });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    await provider.removeWorkspace(res.workspace, { force: true });
    await fs.rm(source, { recursive: true, force: true });

    const restored = await provider.rematerialize(res.workspace);
    expect(restored.ok).toBe(false);
  });

  it("captures uncommitted AND untracked work without touching the user's index or tree", async () => {
    const provider = new GitProvider();
    const source = await makeGitSource();

    await fs.writeFile(path.join(source, "tracked.txt"), "modified\n");
    await fs.writeFile(path.join(source, "brand-new.ts"), "export {};\n");
    // Something deliberately staged, to prove the real index survives.
    await exec("git", ["add", "tracked.txt"], { cwd: source });
    const indexBefore = await exec("git", ["diff", "--cached", "--name-only"], { cwd: source });

    const snap = await provider.captureWorkingState(source, "snapshot");
    expect(snap).toMatch(/^[0-9a-f]{7,}$/);

    // The user's staged set is unchanged...
    const indexAfter = await exec("git", ["diff", "--cached", "--name-only"], { cwd: source });
    expect(indexAfter.stdout).toBe(indexBefore.stdout);
    // ...and so are their files.
    expect(await fs.readFile(path.join(source, "tracked.txt"), "utf8")).toBe("modified\n");
    expect(await fs.readFile(path.join(source, "brand-new.ts"), "utf8")).toBe("export {};\n");

    // The snapshot holds both the modification and the UNTRACKED file,
    // which is the case `git stash create` silently drops and the whole
    // reason for the temp-index approach.
    const listed = await exec("git", ["ls-tree", "-r", "--name-only", snap], { cwd: source });
    expect(listed.stdout).toContain("brand-new.ts");
    const blob = await exec("git", ["show", `${snap}:tracked.txt`], { cwd: source });
    expect(blob.stdout).toBe("modified\n");
  });

  it("keeps a file that is tracked AND ignore-matched, rather than snapshotting a deletion", async () => {
    // Git's rule is that ignore patterns do not apply to already-tracked
    // files, which is why such a file reads as clean in the real repo. It
    // is a common shape: a .DS_Store committed years ago, a .env added
    // before the rule existed, generated output added and later ignored.
    //
    // The snapshot is built in a temp index, and an EMPTY index means git
    // considers nothing tracked, so the rule stops protecting those paths
    // and `add -A` skips them. The file then vanishes from the tree and
    // reads as a deletion against HEAD — which the carried-work patch
    // replays into a new workspace, and a later landing commits and
    // fast-forwards into the source, quietly deleting a tracked file.
    const provider = new GitProvider();
    const source = await makeGitSource();

    await fs.writeFile(path.join(source, ".gitignore"), ".DS_Store\n");
    await fs.writeFile(path.join(source, ".DS_Store"), "mac junk\n");
    await exec("git", ["add", "-f", ".DS_Store", ".gitignore"], { cwd: source });
    await exec("git", ["commit", "-qm", "committed before it was ignored"], { cwd: source });
    // Clean, exactly as it looks in a real repo.
    const status = await exec("git", ["status", "--porcelain"], { cwd: source });
    expect(status.stdout.trim()).toBe("");

    const snap = await provider.captureWorkingState(source, "snapshot");

    const listed = await exec("git", ["ls-tree", "-r", "--name-only", snap], { cwd: source });
    expect(listed.stdout).toContain(".DS_Store");
    const diff = await exec("git", ["diff", "--name-status", "HEAD", snap], { cwd: source });
    expect(diff.stdout).not.toContain(".DS_Store");
  });

  it("still snapshots a genuine deletion of a tracked file", async () => {
    // The counterpart: seeding the index from HEAD must not make real
    // deletions invisible.
    const provider = new GitProvider();
    const source = await makeGitSource();
    await fs.rm(path.join(source, "file.txt"));

    const snap = await provider.captureWorkingState(source, "snapshot");

    const diff = await exec("git", ["diff", "--name-status", "HEAD", snap], { cwd: source });
    expect(diff.stdout.trim()).toMatch(/^D\s+file\.txt$/);
  });

  it("retains a snapshot under refs/hydra without creating a branch", async () => {
    const provider = new GitProvider();
    const source = await makeGitSource();
    const res = await provider.createWorkspace({ sourceCwd: source, label: "snapref" });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    await fs.writeFile(path.join(res.workspace.path, "wip.txt"), "in progress\n");
    const snap = await provider.captureWorkingState(res.workspace.path, "autosave");
    const ref = "refs/hydra/snapshots/test-session";
    await provider.retainSnapshot(res.workspace, ref, snap);

    // Durable: the ref resolves and is a GC root.
    const resolved = await exec("git", ["rev-parse", ref], { cwd: source });
    expect(resolved.stdout.trim()).toBe(snap);

    // Invisible: autosaving must not litter the user's branch list.
    const branches = await exec("git", ["branch", "--list"], { cwd: source });
    expect(branches.stdout).not.toContain("snapshots");

    await provider.dropSnapshotRef(res.workspace, ref);
    await expect(exec("git", ["rev-parse", "--verify", ref], { cwd: source })).rejects.toThrow();
  });

  it("locks a live workspace so a concurrent prune cannot remove it", async () => {
    const provider = new GitProvider();
    const source = await makeGitSource();
    const res = await provider.createWorkspace({ sourceCwd: source, label: "locked" });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    await provider.lock(res.workspace, "session S1");
    const listed = await provider.listWorkspaces(source);
    const found = listed.find((w) => w.path === res.workspace.path);
    expect(found?.vcs?.locked).toContain("hydra-acp:");
  });
});

describe("copy provider specifics", () => {
  it("reports workspaces as expensive so callers cap fan-out", () => {
    expect(new CopyProvider().capabilities().cheapWorkspaces).toBe(false);
    expect(new GitProvider().capabilities().cheapWorkspaces).toBe(true);
  });

  it("cannot rebuild a deleted workspace, and says so rather than pretending", async () => {
    // Capability difference made visible: with nothing retained outside
    // the directory, a copy workspace is gone for good. A session
    // isolated this way has to fall back to a fresh workspace from its
    // source, which is exactly why the caller checks the capability
    // instead of assuming recovery is always possible.
    const provider = new CopyProvider();
    expect(provider.capabilities().supports.rematerialize).toBe(false);
    const source = await makePlainSource();
    const res = await provider.createWorkspace({ sourceCwd: source, label: "gone" });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    await provider.removeWorkspace(res.workspace, { force: true });
    const restored = await provider.rematerialize(res.workspace);
    expect(restored.ok).toBe(false);
  });

  it("works on a directory with no version control at all", async () => {
    const provider = new CopyProvider();
    const plain = await makePlainSource();
    const res = await provider.createWorkspace({ sourceCwd: plain, label: "novcs" });
    expect(res.ok).toBe(true);
  });

  it("does not copy .git, which would present as a detached repository", async () => {
    const provider = new CopyProvider();
    const source = await makeGitSource();
    const res = await provider.createWorkspace({ sourceCwd: source, label: "nogit" });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    await expect(fs.access(path.join(res.workspace.path, ".git"))).rejects.toThrow();
  });
});
