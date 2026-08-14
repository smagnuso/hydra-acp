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
import { WorkspaceUnsupportedError, type IsolationProvider } from "./provider.js";

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

  it("refuses a duplicate label rather than adopting the existing directory", async () => {
    const { provider, source } = await created("dupe");
    const again = await provider.createWorkspace({ sourceCwd: source, label: "dupe" });
    expect(again.ok).toBe(false);
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
});

describe("git provider specifics", () => {
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
