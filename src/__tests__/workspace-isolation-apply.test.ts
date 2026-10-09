// End-to-end: `/hydra workspace apply`, the workspace's content without
// its history.
//
// `apply` is the only landing route that delivers into the index, and the
// only one that needs neither a branch nor a fast-forward. Both of those
// are the point of it, so both are asserted here: what the source's index
// looks like afterwards, and that a source which has moved on (where
// `stop` refuses) still takes the work.
//
// The two subtle ones are the base it measures from and the re-baseline
// it writes: a synced workspace must not re-deliver the source's own
// commits, and a `stop` after an `apply` must not treat the applied
// content as the user's divergence and collide with it.
//
// One of the workspace-isolation-*.test.ts files; shared fixtures live in
// workspace-isolation-harness.ts.

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

// Real git in temp trees, same as the other isolation suites.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

registerTempRootCleanup();

async function porcelain(repo: string): Promise<string> {
  const out = await exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo });
  return out.stdout;
}

async function staged(repo: string): Promise<string> {
  const out = await exec("git", ["diff", "--cached", "--name-status"], { cwd: repo });
  return out.stdout;
}

async function head(repo: string): Promise<string> {
  const out = await exec("git", ["rev-parse", "HEAD"], { cwd: repo });
  return out.stdout.trim();
}

/**
 * `submodule add` from a file:// path is refused by default, and the clone
 * runs in a child process, so the permission has to travel in the
 * environment. Same shape as the fixture in workspace-isolation-clean.
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

describe("workspace apply", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = makeIsolationManager(() => undefined);
  });

  afterEach(async () => {
    await drainSnapshots(manager);
  });

  it("stages the workspace's changes into the source and stays put", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "stageit");
    const wsPath = session.cwd;
    await fs.writeFile(path.join(wsPath, "tracked.txt"), "agent work\n");
    await fs.writeFile(path.join(wsPath, "brand-new.txt"), "new file\n");
    const before = await head(repo);

    const msg = await manager.runWorkspaceAction(session.sessionId, "apply");
    expect(msg).toContain("as staged changes");
    expect(msg).toContain("diff --cached");

    // The content arrived.
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("agent work\n");
    expect(await fs.readFile(path.join(repo, "brand-new.txt"), "utf8")).toBe("new file\n");

    // Staged, and the new file staged as ADDED rather than left untracked:
    // the reviewable changeset in the index is the whole deliverable, so a
    // file the agent created has to be part of it.
    const cached = await staged(repo);
    expect(cached).toContain("M\ttracked.txt");
    expect(cached).toContain("A\tbrand-new.txt");
    // Nothing was committed, on either side.
    expect(await head(repo)).toBe(before);

    // Still working in the workspace, with its work intact: `apply` is the
    // no-history sibling of `merge`, not of `stop`.
    expect(session.cwd).toBe(wsPath);
    expect(session.workspace?.path).toBe(wsPath);
    expect(await fs.readFile(path.join(wsPath, "tracked.txt"), "utf8")).toBe("agent work\n");
  });

  it("flattens the agent's commits into one changeset, leaving them on the branch", async () => {
    // The whole trade: the content arrives, the lineage does not. What
    // makes that safe is that the workspace keeps its history, so `stop`
    // is still available if the commits turn out to be worth having.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "flatten");
    const wsPath = session.cwd;

    await fs.writeFile(path.join(wsPath, "tracked.txt"), "step one\n");
    await exec("git", ["commit", "-qam", "step one"], { cwd: wsPath });
    await fs.writeFile(path.join(wsPath, "tracked.txt"), "step two\n");
    await exec("git", ["commit", "-qam", "step two"], { cwd: wsPath });
    await fs.writeFile(path.join(wsPath, "tracked.txt"), "step three, uncommitted\n");
    const before = await head(repo);

    await manager.runWorkspaceAction(session.sessionId, "apply");

    // One staged changeset covering committed and uncommitted alike, and
    // no commit of its own.
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe(
      "step three, uncommitted\n",
    );
    expect(await staged(repo)).toBe("M\ttracked.txt\n");
    expect(await head(repo)).toBe(before);
    const log = await exec("git", ["log", "--oneline", "hydra/flatten"], { cwd: repo });
    expect(log.stdout).toContain("step one");
    expect(log.stdout).toContain("step two");
  });

  it("refuses when the source already has something staged, and touches nothing", async () => {
    // The index is what `apply` delivers, so it cannot also hold the
    // user's own staging: afterwards nothing could tell the two sets
    // apart, and `git reset` would unstage both.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "refuseit");
    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "agent work\n");

    await fs.writeFile(path.join(repo, "mine.txt"), "my staged work\n");
    await exec("git", ["add", "mine.txt"], { cwd: repo });

    await expect(manager.runWorkspaceAction(session.sessionId, "apply")).rejects.toThrow(
      /already has changes staged/,
    );

    // A refusal is a no-op: their staging survives exactly as it was, and
    // the agent's work did not arrive.
    expect(await porcelain(repo)).toContain("A  mine.txt");
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("original\n");
  });

  it("applies even when the source has moved on, which is what stop cannot do", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "drifted");
    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "agent work\n");

    // The source gains a commit the workspace has never seen. This is the
    // state that makes landing refuse, because it is no longer a
    // fast-forward.
    await fs.writeFile(path.join(repo, "theirs.txt"), "landed\n");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-qm", "source moved"], { cwd: repo });
    const moved = await head(repo);

    const msg = await manager.runWorkspaceAction(session.sessionId, "apply");
    expect(msg).toContain("as staged changes");

    // The source keeps its own commit AND gets the workspace's change.
    expect(await head(repo)).toBe(moved);
    expect(await fs.readFile(path.join(repo, "theirs.txt"), "utf8")).toBe("landed\n");
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("agent work\n");
    expect(await staged(repo)).toContain("M\ttracked.txt");
  });

  it("does not re-deliver commits a sync brought into the workspace", async () => {
    // Regression shape. Measured from the workspace's creation state, the
    // changeset would carry the source's own synced commits as well, and
    // an apply is atomic: one already-present hunk takes the whole thing
    // down. Measured from the source's tip, which the workspace now
    // contains, it is exactly what the workspace added.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "syncedup");

    await fs.writeFile(path.join(repo, "theirs.txt"), "landed\n");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-qm", "source moved"], { cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "sync");

    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "agent work\n");
    await manager.runWorkspaceAction(session.sessionId, "apply");

    const cached = (await exec("git", ["diff", "--cached", "--name-only"], { cwd: repo })).stdout
      .trim()
      .split("\n")
      .filter((s) => s.length > 0);
    expect(cached).toEqual(["tracked.txt"]);
  });

  it("leaves the user's own post-start edits loose rather than in the changeset", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "mineandyours");
    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "agent work\n");

    // The user keeps working in their own tree after isolating.
    await fs.writeFile(path.join(repo, "mine.txt"), "my own wip\n");

    await manager.runWorkspaceAction(session.sessionId, "apply");

    // Their file is back, still untracked: it was never part of what the
    // workspace changed, so it must not be swept into the changeset the
    // user is about to review and commit.
    expect(await fs.readFile(path.join(repo, "mine.txt"), "utf8")).toBe("my own wip\n");
    const status = await porcelain(repo);
    expect(status).toContain("?? mine.txt");
    expect(await staged(repo)).toBe("M\ttracked.txt\n");
  });

  it("says so when there is nothing to apply", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "quietws");

    const msg = await manager.runWorkspaceAction(session.sessionId, "apply");
    expect(msg).toContain("Nothing to apply");
    expect(await porcelain(repo)).toBe("");
  });

  it("names work inside a nested tree rather than reporting it as applied", async () => {
    // A container records a submodule as a pointer, so a changeset can only
    // ever move that pointer in the index: it cannot check the tree out,
    // and it cannot reach the work inside one at all. Reporting success
    // over that work is the failure this warning exists to prevent.
    const restore = allowFileSubmodules();
    try {
      const upstream = await makeGitRepo();
      await fs.writeFile(path.join(upstream, "lib.txt"), "v1\n");
      await exec("git", ["add", "-A"], { cwd: upstream });
      await exec("git", ["commit", "-qm", "lib"], { cwd: upstream });

      const repo = await makeGitRepo();
      await exec("git", ["submodule", "add", "-q", upstream, "sub"], { cwd: repo });
      await exec("git", ["commit", "-qm", "add sub"], { cwd: repo });

      const session = await manager.create({ agentId: "claude-code", cwd: repo });
      await manager.runWorkspaceAction(session.sessionId, "start", "withsub");
      const wsPath = session.cwd;
      // Work in both trees: the container's own change must still arrive.
      await fs.writeFile(path.join(wsPath, "tracked.txt"), "agent work\n");
      await fs.writeFile(path.join(wsPath, "sub", "lib.txt"), "v2 from the agent\n");

      const msg = await manager.runWorkspaceAction(session.sessionId, "apply");

      expect(msg).toContain("nested tree sub was NOT included");
      expect(await staged(repo)).toContain("M\ttracked.txt");
      // Named because it did NOT arrive, so the claim has to hold.
      expect(await fs.readFile(path.join(repo, "sub", "lib.txt"), "utf8")).toBe("v1\n");
    } finally {
      restore();
    }
  });

  it("lets a later stop land the same workspace without a collision", async () => {
    // The double-landing case. `apply` puts content in the source that no
    // commit accounts for, so without a re-baseline the next landing
    // measures the source's divergence from `start`, finds that content,
    // and replays it on top of the very same work arriving from the
    // workspace, which conflicts as soon as the agent has touched the
    // file again since.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "applythenstop");
    const wsPath = session.cwd;

    await fs.writeFile(path.join(wsPath, "tracked.txt"), "agent work v1\n");
    await manager.runWorkspaceAction(session.sessionId, "apply");

    // The agent carries on after the apply.
    await fs.writeFile(path.join(wsPath, "tracked.txt"), "agent work v2\n");
    const msg = await manager.runWorkspaceAction(session.sessionId, "stop");

    expect(msg).not.toContain("WARNING");
    expect(session.cwd).toBe(repo);
    const landed = await fs.readFile(path.join(repo, "tracked.txt"), "utf8");
    expect(landed).toBe("agent work v2\n");
    expect(landed).not.toContain("<<<<<<<");
  });
});
