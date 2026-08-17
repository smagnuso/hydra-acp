// End-to-end: `start --clean` and the `clean` verb.
//
// The two are one idea approached from opposite ends, so they are tested
// together: `--clean` produces a workspace with no carried work, and
// `clean` returns an existing workspace to exactly that state. The
// property worth protecting is that they agree, because that agreement is
// what makes them share a name.
//
// The landing anchor is the subtle half. A workspace created WITH the
// source's uncommitted work has that work as its anchor, and landing
// excludes the anchor from the patch it replays, on the understanding that
// the workspace still holds a copy for the merge to bring back. Both verbs
// break that understanding, so both have to move the anchor to the base
// commit, or a landing resets the source and restores the work from
// neither route.
//
// One of several workspace-isolation-*.test.ts files; shared fixtures live
// in workspace-isolation-harness.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionManager } from "../core/session-manager.js";
import {
  drainSnapshots,
  exec,
  makeGitRepo,
  makeIsolationManager,
  registerTempRootCleanup,
} from "./workspace-isolation-harness.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

registerTempRootCleanup();

/**
 * Allow local-path submodules for the duration of a test.
 *
 * The CVE-2022-39253 fix refuses the `file` transport by default, and a
 * repo-local config setting does not help: `submodule add` clones in a
 * child process that reads the config of a repository which does not exist
 * yet. The documented workaround is to pass it as configuration the
 * environment carries, which every descendant git inherits, including the
 * daemon's own `submodule update --init`.
 */
function allowFileSubmodules(): () => void {
  const saved = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0,
    value: process.env.GIT_CONFIG_VALUE_0,
  };
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
  process.env.GIT_CONFIG_VALUE_0 = "always";
  return () => {
    for (const [name, value] of [
      ["GIT_CONFIG_COUNT", saved.count],
      ["GIT_CONFIG_KEY_0", saved.key],
      ["GIT_CONFIG_VALUE_0", saved.value],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

/** A source repo with a real submodule, isolated into a workspace. */
async function withSubmodule(
  manager: SessionManager,
): Promise<{ repo: string; session: Awaited<ReturnType<SessionManager["create"]>> }> {
  const upstream = await makeGitRepo();
  await fs.writeFile(path.join(upstream, "lib.txt"), "v1\n");
  await exec("git", ["add", "-A"], { cwd: upstream });
  await exec("git", ["commit", "-q", "-m", "lib"], { cwd: upstream });

  const repo = await makeGitRepo();
  await exec("git", ["submodule", "add", "-q", upstream, "sub"], { cwd: repo });
  await exec("git", ["commit", "-q", "-m", "add sub"], { cwd: repo });

  const session = await manager.create({ agentId: "claude-code", cwd: repo });
  await manager.runWorkspaceAction(session.sessionId, "start", "withsub");
  return { repo, session };
}

describe("workspace start --clean", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = makeIsolationManager(() => undefined);
  });

  afterEach(async () => {
    await drainSnapshots(manager);
  });

  it("leaves uncommitted work in the source instead of copying it in", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "tracked.txt"), "my wip\n");
    await fs.writeFile(path.join(repo, "extra.txt"), "untracked wip\n");

    const msg = await manager.runWorkspaceAction(session.sessionId, "start", "fresh", {
      clean: true,
    });

    // The workspace is at the last commit.
    expect(await fs.readFile(path.join(session.cwd, "tracked.txt"), "utf8")).toBe("original\n");
    await expect(fs.access(path.join(session.cwd, "extra.txt"))).rejects.toThrow();
    const inWs = await exec("git", ["status", "--porcelain", "-uall"], { cwd: session.cwd });
    expect(inWs.stdout.trim()).toBe("");

    // The source still has everything, untouched.
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("my wip\n");
    expect(await fs.readFile(path.join(repo, "extra.txt"), "utf8")).toBe("untracked wip\n");

    // And it says what it left, by name. A count cannot tell you whether
    // the file you were mid-way through is among them.
    expect(msg).toContain("started clean");
    expect(msg).toContain("tracked.txt");
    expect(msg).toContain("extra.txt");
    expect(msg).not.toContain("source tree was clean");
  });

  it("records clean-ness so a landing can explain itself", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "tracked.txt"), "my wip\n");

    await manager.runWorkspaceAction(session.sessionId, "start", "fresh", { clean: true });
    expect(session.workspace?.clean).toBe(true);
  });

  it("still reports a clean source as clean rather than as work left behind", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });

    const msg = await manager.runWorkspaceAction(session.sessionId, "start", "fresh", {
      clean: true,
    });
    expect(msg).toContain("source tree was clean");
    expect(msg).not.toContain("started clean");
  });

  it("anchors landing at the base so the source's work survives the round trip", async () => {
    // The whole reason --clean cannot reuse the carry anchor. The landing
    // resets the source before fast-forwarding, so the user's uncommitted
    // work has to come back through the replay; anchored at a working-state
    // snapshot it would be the base of that diff and excluded from it.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "tracked.txt"), "my wip\n");
    await fs.writeFile(path.join(repo, "extra.txt"), "untracked wip\n");

    await manager.runWorkspaceAction(session.sessionId, "start", "fresh", { clean: true });

    // The agent does its own, unrelated work and commits it.
    await fs.writeFile(path.join(session.cwd, "agent.txt"), "agent work\n");
    await exec("git", ["add", "-A"], { cwd: session.cwd });
    await exec("git", ["commit", "-q", "-m", "agent work"], { cwd: session.cwd });

    await manager.runWorkspaceAction(session.sessionId, "stop");

    // The agent's commit landed...
    expect(await fs.readFile(path.join(repo, "agent.txt"), "utf8")).toBe("agent work\n");
    // ...and the user's uncommitted work is still uncommitted, and still there.
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("my wip\n");
    expect(await fs.readFile(path.join(repo, "extra.txt"), "utf8")).toBe("untracked wip\n");
    const after = await exec("git", ["status", "--porcelain", "-uall"], { cwd: repo });
    expect(after.stdout).toContain("tracked.txt");
    expect(after.stdout).toContain("extra.txt");
  });
});

describe("workspace clean", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = makeIsolationManager(() => undefined);
  });

  afterEach(async () => {
    await drainSnapshots(manager);
  });

  it("discards uncommitted work and commits, and stays in the workspace", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "messy");
    const wsPath = session.cwd;

    await fs.writeFile(path.join(wsPath, "committed.txt"), "a commit\n");
    await exec("git", ["add", "-A"], { cwd: wsPath });
    await exec("git", ["commit", "-q", "-m", "agent commit"], { cwd: wsPath });
    await fs.writeFile(path.join(wsPath, "loose.txt"), "loose\n");
    await fs.writeFile(path.join(wsPath, "tracked.txt"), "mangled\n");

    const msg = await manager.runWorkspaceAction(session.sessionId, "clean");

    // Still here, same directory and same binding.
    expect(session.cwd).toBe(wsPath);
    expect(session.workspace?.path).toBe(wsPath);
    // And back at the base: no commit, no loose files, tracked file restored.
    await expect(fs.access(path.join(wsPath, "committed.txt"))).rejects.toThrow();
    await expect(fs.access(path.join(wsPath, "loose.txt"))).rejects.toThrow();
    expect(await fs.readFile(path.join(wsPath, "tracked.txt"), "utf8")).toBe("original\n");
    const st = await exec("git", ["status", "--porcelain", "-uall"], { cwd: wsPath });
    expect(st.stdout.trim()).toBe("");

    expect(msg).toContain("Cleaned");
    expect(msg).toContain("discarded");
  });

  it("lands on the same state that start --clean produces", async () => {
    // The property that justifies the shared name.
    const repo = await makeGitRepo();
    await fs.writeFile(path.join(repo, "tracked.txt"), "user wip\n");

    const viaFlag = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(viaFlag.sessionId, "start", "byflag", { clean: true });

    const viaVerb = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(viaVerb.sessionId, "start", "byverb");
    await manager.runWorkspaceAction(viaVerb.sessionId, "clean");

    for (const s of [viaFlag, viaVerb]) {
      const st = await exec("git", ["status", "--porcelain", "-uall"], { cwd: s.cwd });
      expect(st.stdout.trim()).toBe("");
      expect(await fs.readFile(path.join(s.cwd, "tracked.txt"), "utf8")).toBe("original\n");
      expect(s.workspace?.clean).toBe(true);
    }
  });

  it("moves the landing anchor so a carry-started workspace does not lose the source's work", async () => {
    // The data-loss path this verb would otherwise open. Started WITH the
    // user's work, the anchor is a snapshot of it; cleaning deletes the
    // workspace's copy, so an unmoved anchor leaves the landing resetting
    // the source and restoring nothing.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "tracked.txt"), "user wip\n");
    await fs.writeFile(path.join(repo, "extra.txt"), "user untracked\n");

    await manager.runWorkspaceAction(session.sessionId, "start", "carried");
    // The carry happened, so this workspace's anchor is a working-state snapshot.
    expect(session.workspace?.clean).toBeUndefined();

    await manager.runWorkspaceAction(session.sessionId, "clean");
    expect(session.workspace?.clean).toBe(true);

    await fs.writeFile(path.join(session.cwd, "agent.txt"), "agent\n");
    await exec("git", ["add", "-A"], { cwd: session.cwd });
    await exec("git", ["commit", "-q", "-m", "agent"], { cwd: session.cwd });
    await manager.runWorkspaceAction(session.sessionId, "stop");

    expect(await fs.readFile(path.join(repo, "agent.txt"), "utf8")).toBe("agent\n");
    // The work the user never committed is still theirs, and still uncommitted.
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("user wip\n");
    expect(await fs.readFile(path.join(repo, "extra.txt"), "utf8")).toBe("user untracked\n");
  });

  it("never touches the source tree", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "tracked.txt"), "user wip\n");
    await manager.runWorkspaceAction(session.sessionId, "start", "safe");

    await manager.runWorkspaceAction(session.sessionId, "clean");

    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("user wip\n");
  });

  it("refuses on a workspace another live session is in", async () => {
    const repo = await makeGitRepo();
    const host = await manager.create({ agentId: "claude-code", cwd: repo });
    const guest = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(host.sessionId, "start", "shared");
    await manager.runWorkspaceAction(guest.sessionId, "start", "shared");
    expect(guest.workspace?.path).toBe(host.workspace?.path);

    await expect(manager.runWorkspaceAction(host.sessionId, "clean")).rejects.toThrow(
      /shared with/,
    );
  });

  it("refuses when the session is not in a workspace at all", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await expect(manager.runWorkspaceAction(session.sessionId, "clean")).rejects.toThrow(
      /not in a workspace/,
    );
  });

  it("says so plainly when there was nothing to discard", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "already-clean");

    const msg = await manager.runWorkspaceAction(session.sessionId, "clean");
    expect(msg).toContain("nothing to discard");
  });

  it("keeps ignored files by default and rebuilds them under --deep", async () => {
    const repo = await makeGitRepo();
    await fs.writeFile(path.join(repo, ".gitignore"), "deps/\n");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-q", "-m", "ignore deps"], { cwd: repo });
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "deps");

    // Stands in for node_modules: ignored, expensive, and part of what
    // `start` produced rather than something the agent made.
    await fs.mkdir(path.join(session.cwd, "deps"), { recursive: true });
    await fs.writeFile(path.join(session.cwd, "deps", "installed.txt"), "dep\n");

    await manager.runWorkspaceAction(session.sessionId, "clean");
    expect(await fs.readFile(path.join(session.cwd, "deps", "installed.txt"), "utf8")).toBe(
      "dep\n",
    );

    await manager.runWorkspaceAction(session.sessionId, "clean", undefined, { deep: true });
    await expect(fs.access(path.join(session.cwd, "deps", "installed.txt"))).rejects.toThrow();
  });
});

describe("workspaces with submodules", () => {
  let manager: SessionManager;
  let restoreGitEnv: () => void;

  beforeEach(() => {
    restoreGitEnv = allowFileSubmodules();
    manager = makeIsolationManager(() => undefined);
  });

  afterEach(async () => {
    await drainSnapshots(manager);
    restoreGitEnv();
  });

  it("populates submodules on start, rather than leaving empty directories", async () => {
    const { session } = await withSubmodule(manager);
    // `git worktree add` does not do this on its own. Left empty, the
    // workspace cannot build and the agent is one plausible `git add` away
    // from committing the empty directory as an ordinary file.
    expect(await fs.readFile(path.join(session.cwd, "sub", "lib.txt"), "utf8")).toBe("v1\n");
  });

  it("carries uncommitted work from inside a submodule", async () => {
    const upstream = await makeGitRepo();
    await fs.writeFile(path.join(upstream, "lib.txt"), "v1\n");
    await exec("git", ["add", "-A"], { cwd: upstream });
    await exec("git", ["commit", "-q", "-m", "lib"], { cwd: upstream });
    const repo = await makeGitRepo();
    await exec("git", ["submodule", "add", "-q", upstream, "sub"], { cwd: repo });
    await exec("git", ["commit", "-q", "-m", "add sub"], { cwd: repo });
    const session = await manager.create({ agentId: "claude-code", cwd: repo });

    // The superproject's own snapshot records a gitlink, not content, so
    // this work is invisible to it. Before nested carry existed it stayed
    // behind while the reply claimed it had come along.
    await fs.writeFile(path.join(repo, "sub", "lib.txt"), "user edit\n");
    await fs.writeFile(path.join(repo, "sub", "new.txt"), "user new\n");

    const msg = await manager.runWorkspaceAction(session.sessionId, "start", "nested");

    expect(await fs.readFile(path.join(session.cwd, "sub", "lib.txt"), "utf8")).toBe("user edit\n");
    expect(await fs.readFile(path.join(session.cwd, "sub", "new.txt"), "utf8")).toBe("user new\n");
    // Named per file, not as the single path the superproject reports.
    expect(msg).toContain("sub/lib.txt");
    expect(msg).toContain("sub/new.txt");
    // And the source keeps its copy.
    expect(await fs.readFile(path.join(repo, "sub", "lib.txt"), "utf8")).toBe("user edit\n");
  });

  it("clears submodule dirt on clean, which reset and clean cannot reach alone", async () => {
    const { session } = await withSubmodule(manager);
    await fs.writeFile(path.join(session.cwd, "sub", "lib.txt"), "agent mangled\n");
    await fs.writeFile(path.join(session.cwd, "sub", "junk.txt"), "junk\n");

    await manager.runWorkspaceAction(session.sessionId, "clean");

    // Neither `reset --hard` nor `clean -fd` recurses into a submodule, so
    // without explicit handling both of these would survive the verb.
    expect(await fs.readFile(path.join(session.cwd, "sub", "lib.txt"), "utf8")).toBe("v1\n");
    await expect(fs.access(path.join(session.cwd, "sub", "junk.txt"))).rejects.toThrow();
  });

  it("leaves submodule work behind under --clean, and says so", async () => {
    const upstream = await makeGitRepo();
    await fs.writeFile(path.join(upstream, "lib.txt"), "v1\n");
    await exec("git", ["add", "-A"], { cwd: upstream });
    await exec("git", ["commit", "-q", "-m", "lib"], { cwd: upstream });
    const repo = await makeGitRepo();
    await exec("git", ["submodule", "add", "-q", upstream, "sub"], { cwd: repo });
    await exec("git", ["commit", "-q", "-m", "add sub"], { cwd: repo });
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "sub", "lib.txt"), "user edit\n");

    const msg = await manager.runWorkspaceAction(session.sessionId, "start", "nofresh", {
      clean: true,
    });

    expect(await fs.readFile(path.join(session.cwd, "sub", "lib.txt"), "utf8")).toBe("v1\n");
    expect(msg).toContain("started clean");
    expect(msg).toContain("sub/lib.txt");
  });

  it("reconciles the source's submodule after landing a submodule bump", async () => {
    const { repo, session } = await withSubmodule(manager);

    // The agent commits inside the submodule and bumps the gitlink. The
    // fast-forward moves the superproject's gitlink but not the source's
    // submodule checkout, and the source's submodule store cannot even
    // reach the commit it now records.
    await fs.writeFile(path.join(session.cwd, "sub", "lib.txt"), "agent work\n");
    await exec("git", ["commit", "-q", "-am", "agent in sub"], {
      cwd: path.join(session.cwd, "sub"),
    });
    await exec("git", ["add", "sub"], { cwd: session.cwd });
    await exec("git", ["commit", "-q", "-m", "bump sub"], { cwd: session.cwd });

    await manager.runWorkspaceAction(session.sessionId, "stop");

    expect(await fs.readFile(path.join(repo, "sub", "lib.txt"), "utf8")).toBe("agent work\n");
    const st = await exec("git", ["status", "--porcelain"], { cwd: repo });
    expect(st.stdout.trim()).toBe("");
  });
});
