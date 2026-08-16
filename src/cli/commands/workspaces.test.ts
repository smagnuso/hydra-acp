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
import { writeDaemonPidFile } from "../../core/daemon-pidfile.js";
import { writeServiceToken } from "../../core/service-token.js";
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
 * An unowned workspace: a real worktree under the workspaces root that no session
 * record mentions. Built with plain git so the test does not depend on
 * the provisioning path it is meant to be independent of.
 */
async function makeUnownedWorktree(repo: string, label: string): Promise<string> {
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

  it("tears down an unowned workspace completely, not just its directory", async () => {
    const repo = await makeGitRepo();
    const dir = await makeUnownedWorktree(repo, "stranded");
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
    const dir = await makeUnownedWorktree(repo, "haswork");
    await fs.writeFile(path.join(dir, "new.txt"), "committed in the workspace\n");
    await exec("git", ["add", "-A"], { cwd: dir });
    await exec("git", ["commit", "-q", "-m", "work"], { cwd: dir });

    await runWorkspacePrune();

    // Directory goes; the commits are the durable artifact and stay.
    await expect(fs.access(dir)).rejects.toThrow();
    expect(await branches(repo)).toContain("hydra/haswork");
    expect(out).toContain("commit(s) not in HEAD");
  });

  it("keeps an unowned workspace holding uncommitted work unless forced", async () => {
    const repo = await makeGitRepo();
    const dir = await makeUnownedWorktree(repo, "dirty");
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
    const dir = await makeUnownedWorktree(repo, "findme");

    await runWorkspaceList();

    expect(out).toContain("WORKSPACE");
    expect(out).toContain(shortenHomePath(dir));
  });

  it("attributes an unowned workspace to its source tree instead of reporting unknown", async () => {
    const repo = await makeGitRepo();
    const dir = await makeUnownedWorktree(repo, "whereami");

    const rows = await collectWorkspaces();
    const row = rows.find((r) => r.path === dir);

    expect(row?.state).toBe("unowned");
    expect(row?.sourceCwd).toBe(repo);
    expect(row?.provider).toBe("git");
    expect(row?.branch).toBe("hydra/whereami");
    expect(row?.clean).toBe(true);
  });
});

// `remove` on an inactive workspace.
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

/**
 * A stand-in for the daemon's `PATCH /v1/sessions/:id` route.
 *
 * The CLI does not write session records any more, it asks — so these
 * tests need something to ask, and it has to perform the clear for real
 * or every assertion about the record would be measuring the fake
 * instead of the command. `live` reproduces the single refusal the real
 * route makes; `patches` records the wire calls so the contract itself
 * can be asserted rather than only its effect.
 */
interface FakeDaemon {
  live: Set<string>;
  patches: Array<{ id: string; body: unknown }>;
  close: () => Promise<void>;
}

async function startFakeDaemon(): Promise<FakeDaemon> {
  const { createServer } = await import("node:http");
  const live = new Set<string>();
  const patches: Array<{ id: string; body: unknown }> = [];
  const server = createServer((req, res) => {
    const match = /^\/v1\/sessions\/([^/?]+)$/.exec(req.url ?? "");
    if (req.method !== "PATCH" || match === null) {
      res.writeHead(404).end("{}");
      return;
    }
    const id = decodeURIComponent(match[1]!);
    let raw = "";
    req.on("data", (c) => (raw += String(c)));
    req.on("end", () => {
      void (async () => {
        const body: unknown = raw.length > 0 ? JSON.parse(raw) : {};
        patches.push({ id, body });
        if (live.has(id)) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "session is live; its cwd is the workspace." }));
          return;
        }
        const meta = path.join(paths.home(), "sessions", id, "meta.json");
        const rec = JSON.parse(await fs.readFile(meta, "utf8")) as Record<string, unknown>;
        delete rec.workspace;
        await fs.writeFile(meta, JSON.stringify(rec));
        res.writeHead(204).end();
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await writeDaemonPidFile({
    pid: process.pid,
    host: "127.0.0.1",
    port,
    loopbackPort: port,
    startedAt: new Date(0).toISOString(),
  });
  // daemonFetch authenticates before it dials.
  await writeServiceToken("test-token");
  return {
    live,
    patches,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("workspace remove — inactive", () => {
  let out: string;
  let daemon: FakeDaemon;

  beforeEach(async () => {
    out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
    daemon = await startFakeDaemon();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await daemon.close();
    await fs.rm(path.join(paths.home(), "sessions"), { recursive: true, force: true });
    await fs.rm(path.join(paths.home(), "workspaces"), { recursive: true, force: true });
    await fs.rm(paths.pidFile(), { force: true });
  });

  it("clears the binding so the row stops being listed", async () => {
    const repo = await makeGitRepo();
    const { meta } = await makeMissing(repo, "gone", "sess-gone");
    expect((await collectWorkspaces()).map((r) => r.state)).toEqual(["inactive"]);

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

  it("keeps a branch that still holds commits, and says so", async () => {
    // Clearing the binding is what strands the branch, so this is the
    // moment it must be named. Deleting it here would make `remove`
    // destroy on `missing` what it preserves on `bound`.
    const repo = await makeGitRepo();
    const { meta } = await makeMissing(repo, "work", "sess-work", { commit: true });

    await runWorkspaceRemove({ target: "sess-work" });

    expect(await bindingOf(meta)).toBeUndefined();
    expect(await branches(repo)).toContain("hydra/work");
    expect(out).toContain("1 commit(s) not in HEAD");
  });

  it("keeps the commits under --force too", async () => {
    // --force covers the daemon guard, not the branch: there is no
    // uncommitted work to discard here, so nothing this command does is
    // destructive in either mode.
    const repo = await makeGitRepo();
    const { meta } = await makeMissing(repo, "work", "sess-force", { commit: true });
    await runWorkspaceRemove({ target: "sess-force", force: true });
    expect(await bindingOf(meta)).toBeUndefined();
    expect(await branches(repo)).toContain("hydra/work");
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

  it("drops the start ref but keeps the autosave", async () => {
    // Both are GC roots, which is the argument for dropping them. The
    // autosave outranks it: with the directory gone it is the only copy
    // of whatever was uncommitted when it went. Nothing can be landed
    // from a checkout that no longer exists, so the start ref is pure
    // garbage and goes.
    const repo = await makeGitRepo();
    await makeMissing(repo, "refs", "sess-refs");
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    for (const ref of [
      "refs/hydra/workspaces/refs/autosave",
      "refs/hydra/workspaces/refs/start",
    ]) {
      await exec("git", ["update-ref", ref, head], { cwd: repo });
    }

    await runWorkspaceRemove({ target: "sess-refs" });

    const { stdout } = await exec("git", ["for-each-ref", "--format=%(refname)", "refs/hydra/"], {
      cwd: repo,
    });
    expect(stdout.trim()).toBe("refs/hydra/workspaces/refs/autosave");
    expect(out).toContain("last autosave");
  });

  it("clears the binding through the daemon, not by editing the record", async () => {
    // The record belongs to the daemon: it holds live copies in memory
    // and rewrites them, so a file edited underneath it is reverted.
    // This is the one CLI path that would otherwise write one directly.
    const repo = await makeGitRepo();
    await makeMissing(repo, "wire", "sess-wire");

    await runWorkspaceRemove({ target: "sess-wire" });

    expect(daemon.patches).toEqual([{ id: "sess-wire", body: { workspace: null } }]);
  });

  it("surfaces the daemon's refusal for a live session, and changes nothing", async () => {
    // A live session's cwd IS the workspace, so the binding may only be
    // dropped by something that moves the agent too. The refusal has to
    // arrive before any git state is touched, or a command that failed
    // has still half-run.
    const repo = await makeGitRepo();
    const { meta, branch } = await makeMissing(repo, "hot", "sess-hot");
    daemon.live.add("sess-hot");

    await expect(runWorkspaceRemove({ target: "sess-hot" })).rejects.toThrow(/session is live/);

    expect(await bindingOf(meta)).toMatchObject({ label: "hot" });
    expect(await branches(repo)).toContain(branch);
    expect(await worktreeList(repo)).toContain("hot");
  });

  it("fails loudly when the daemon is unreachable", async () => {
    // No fallback to a direct write: the daemon is required, and a
    // command that cannot reach it has not done half its job silently.
    const repo = await makeGitRepo();
    const { meta } = await makeMissing(repo, "down", "sess-down");
    await daemon.close();

    await expect(runWorkspaceRemove({ target: "sess-down" })).rejects.toThrow(
      /could not reach the daemon/,
    );
    expect(await bindingOf(meta)).toMatchObject({ label: "down" });
  });
});

// `remove` on a workspace that still exists, and what it does with the
// two things that can hold the only copy of work: the directory (for
// uncommitted changes) and the autosave ref (for the same changes, as of
// the last turn).

describe("workspace remove — on disk", () => {
  let out: string;

  beforeEach(() => {
    out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(path.join(paths.home(), "sessions"), { recursive: true, force: true });
    await fs.rm(path.join(paths.home(), "workspaces"), { recursive: true, force: true });
  });

  it("refuses when it cannot tell whether the directory holds work", async () => {
    // Unknown is not clean. collectWorkspaces reports undefined for a
    // failed status, an unresolvable provider and a failed attribution
    // alike, and reading any of them as "nothing to lose" deletes a
    // directory nobody checked. `prune` already fails closed here.
    const dir = path.join(paths.home(), "workspaces", "deadbeef", "opaque");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "work.txt"), "not in any vcs\n");

    await expect(runWorkspaceRemove({ target: "opaque" })).rejects.toThrow(/cannot tell whether/);
    await expect(fs.access(dir)).resolves.toBeUndefined();

    await runWorkspaceRemove({ target: "opaque", force: true });
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it("keeps the autosave ref when --force discards uncommitted work", async () => {
    // The ref is the recovery mechanism for exactly what --force just
    // destroyed, so deleting it as GC hygiene is what turns a forced
    // removal from recoverable into final.
    const repo = await makeGitRepo();
    const dir = await makeUnownedWorktree(repo, "autosave");
    const meta = await bindSession("sess-auto", {
      path: dir,
      sourceCwd: repo,
      label: "autosave",
      branch: "hydra/autosave",
      repoRoot: repo,
    });
    await fs.writeFile(path.join(dir, "scratch.txt"), "unsaved\n");
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await exec("git", ["update-ref", "refs/hydra/workspaces/autosave/autosave", head], {
      cwd: repo,
    });
    await exec("git", ["update-ref", "refs/hydra/workspaces/autosave/start", head], { cwd: repo });

    await runWorkspaceRemove({ target: "sess-auto", force: true });

    // Retired out of the live namespace: a later workspace taking this
    // label would otherwise overwrite the only copy of what --force just
    // discarded, invalidating the recovery path printed below.
    const { stdout } = await exec("git", ["for-each-ref", "--format=%(refname)", "refs/hydra/"], {
      cwd: repo,
    });
    expect(stdout.trim()).toMatch(/^refs\/hydra\/retired\/autosave-[0-9a-f]+$/);
    expect(out).toContain("recoverable from the last autosave");
    expect(out).toContain("refs/hydra/retired/autosave-");
    expect(meta).toContain("sess-auto");
  });

  it("drops the autosave ref when the removal discarded nothing", async () => {
    // Clean removal destroys no copy of anything, so the ref is only
    // pinning objects and the hygiene argument stands unopposed.
    const repo = await makeGitRepo();
    const dir = await makeUnownedWorktree(repo, "clean");
    await bindSession("sess-clean", {
      path: dir,
      sourceCwd: repo,
      label: "clean",
      branch: "hydra/clean",
      repoRoot: repo,
    });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await exec("git", ["update-ref", "refs/hydra/workspaces/clean/autosave", head], { cwd: repo });

    await runWorkspaceRemove({ target: "sess-clean" });

    const { stdout } = await exec("git", ["for-each-ref", "refs/hydra/"], { cwd: repo });
    expect(stdout.trim()).toBe("");
    expect(out).not.toContain("recoverable");
  });

  it("tears an unowned workspace down through its provider, not with a bare rm", async () => {
    // Same residue prune exists to avoid: a bare rm leaves git's
    // worktree registry and the branch aimed at a path that is gone.
    const repo = await makeGitRepo();
    const dir = await makeUnownedWorktree(repo, "unowned");

    await runWorkspaceRemove({ target: "unowned" });

    await expect(fs.access(dir)).rejects.toThrow();
    expect(await worktreeList(repo)).not.toContain("unowned");
    expect(await branches(repo)).not.toContain("hydra/unowned");
  });

  it("keeps an unowned branch when it carries commits, and says so", async () => {
    const repo = await makeGitRepo();
    const dir = await makeUnownedWorktree(repo, "unownedwork");
    await fs.writeFile(path.join(dir, "work.txt"), "committed\n");
    await exec("git", ["add", "-A"], { cwd: dir });
    await exec("git", ["commit", "-q", "-m", "work"], { cwd: dir });

    await runWorkspaceRemove({ target: "unownedwork" });

    expect(await branches(repo)).toContain("hydra/unownedwork");
    expect(out).toContain("commit(s) not in HEAD");
  });
});

describe("workspace list — shared workspaces", () => {
  let out: string;

  beforeEach(() => {
    out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(path.join(paths.home(), "sessions"), { recursive: true, force: true });
    await fs.rm(path.join(paths.home(), "workspaces"), { recursive: true, force: true });
  });

  it("reports one row naming every session that claims it", async () => {
    // The row is per WORKSPACE. Keying the lookup by path and letting the
    // last binding win collapsed co-tenants, so a shared directory looked
    // exactly like a solo one and the other session was invisible.
    const repo = await makeGitRepo();
    const dir = await makeUnownedWorktree(repo, "together");
    for (const id of ["sess-one", "sess-two"]) {
      await bindSession(id, {
        path: dir,
        sourceCwd: repo,
        label: "together",
        branch: "hydra/together",
        repoRoot: repo,
      });
    }

    const rows = await collectWorkspaces();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("active");
    expect(rows[0]?.sessionIds?.sort()).toEqual(["sess-one", "sess-two"]);

    await runWorkspaceList();
    expect(out).toContain("sess-one,sess-two");
  });
});

describe("workspace list — inactive rows", () => {
  let out: string;

  beforeEach(() => {
    out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(path.join(paths.home(), "sessions"), { recursive: true, force: true });
    await fs.rm(path.join(paths.home(), "workspaces"), { recursive: true, force: true });
  });

  it("hides them from the table but never from the footer", async () => {
    const repo = await makeGitRepo();
    await makeMissing(repo, "ghost", "sess-ghost");

    await runWorkspaceList();

    expect(out).not.toContain("ghost");
    expect(out).toContain("1 inactive");
    expect(out).toContain("--inactive");
  });

  it("lists them under --inactive", async () => {
    const repo = await makeGitRepo();
    await makeMissing(repo, "ghost", "sess-ghost");

    await runWorkspaceList({ inactive: true });

    expect(out).toContain("ghost");
    expect(out).toContain("1 inactive");
    // The hint is for people who cannot see them; they can.
    expect(out).not.toContain("--inactive`");
  });

  it("keeps every row in --json", async () => {
    const repo = await makeGitRepo();
    await makeMissing(repo, "ghost", "sess-ghost");

    await runWorkspaceList({ json: true });

    const parsed = JSON.parse(out) as { workspaces: Array<{ state: string }> };
    expect(parsed.workspaces.map((w) => w.state)).toEqual(["inactive"]);
  });
});
