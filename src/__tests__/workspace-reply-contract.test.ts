// Reply strings that hydra-acp-planner parses.
//
// The planner drives workspaces over chat text — it sends
// `/hydra workspace <verb>` into a session and reads the reply — because
// there is no RPC for landing. That makes these human-facing strings a
// de-facto wire contract for it, and its own tests necessarily assert
// against strings a human typed into a fake. If the wording here ever
// drifts, those fakes keep passing while the real integration silently
// misreads every landing.
//
// So this file pins the shapes the planner depends on, produced by the
// REAL code path (real git, real provider, real SessionManager) rather
// than by a fixture. A failure here is not "fix the test" — it means a
// planner release has to change with this one. The parsers that consume
// each string are named per-assertion.

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

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

registerTempRootCleanup();

describe("workspace reply contract (consumed by hydra-acp-planner)", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = makeIsolationManager(() => {});
  });

  afterEach(async () => {
    await drainSnapshots(manager);
  });

  async function isolatedSession(repo: string, label: string) {
    return await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label },
    });
  }

  it("a clean workspace says 'no uncommitted changes' and 'in sync with'", async () => {
    // planner: classifyWorkspaceStatusReply -> "nothing-here".
    // The pair matters: clean ALONE does not mean the work was
    // committed, it can equally mean nothing was done.
    const repo = await makeGitRepo();
    const s = await isolatedSession(repo, "clean-probe");

    const status = await manager.runWorkspaceAction(s.sessionId, "status");

    expect(status).toContain("no uncommitted changes");
    expect(status).toContain("in sync with");
  });

  it("a status reply head-lines 'Isolated in ', which is how a reply is told from a push", async () => {
    // planner: sendWorkspaceCommand/isReplyTo. The planner matches
    // synthetic agent text against this prefix to decide whether a chunk
    // is the answer to the `status` it just sent. It has to, because the
    // daemon ALSO pushes unsolicited synthetic text onto the same
    // session (see the drift test below); without a prefix to match on,
    // the planner consumed that push as the reply and paused projects
    // over work that had landed.
    const repo = await makeGitRepo();
    const s = await isolatedSession(repo, "header-probe");

    const status = await manager.runWorkspaceAction(s.sessionId, "status");

    expect(status.trim().startsWith("Isolated in ")).toBe(true);
  });

  it("a dirty workspace reports counts as '<n> staged/unstaged/untracked'", async () => {
    // planner: classifyWorkspaceStatusReply -> "uncommitted", which is
    // what triggers a commit reminder rather than a landing.
    const repo = await makeGitRepo();
    const s = await isolatedSession(repo, "dirty-probe");
    await fs.writeFile(path.join(s.cwd, "untracked.ts"), "export const x = 1;\n");

    const status = await manager.runWorkspaceAction(s.sessionId, "status");

    expect(status).toMatch(/\d+ (staged|unstaged|untracked)/);
  });

  it("a committed workspace reports '<n> commit(s) recorded here and not landed yet'", async () => {
    // planner: classifyWorkspaceStatusReply -> "committed". This is the
    // positive evidence that a worker actually committed, as opposed to
    // its own self-reported `commits` claim.
    const repo = await makeGitRepo();
    const s = await isolatedSession(repo, "committed-probe");
    await fs.writeFile(path.join(s.cwd, "work.ts"), "export const x = 1;\n");
    await exec("git", ["add", "-A"], { cwd: s.cwd });
    await exec("git", ["commit", "-m", "work"], { cwd: s.cwd });

    const status = await manager.runWorkspaceAction(s.sessionId, "status");

    expect(status).toContain("no uncommitted changes");
    expect(status).toMatch(/\d+ commit\(s\) recorded here and not landed yet/);
  });

  it("a successful landing head-lines 'Merged '", async () => {
    // planner: classifyMergeReply -> "landed". The prefix is matched at
    // the START of the reply, so a leading-line change breaks it.
    const repo = await makeGitRepo();
    const s = await isolatedSession(repo, "merge-probe");
    await fs.writeFile(path.join(s.cwd, "work.ts"), "export const x = 1;\n");
    await exec("git", ["add", "-A"], { cwd: s.cwd });
    await exec("git", ["commit", "-m", "work"], { cwd: s.cwd });

    const msg = await manager.runWorkspaceAction(s.sessionId, "merge");

    expect(msg.startsWith("Merged ")).toBe(true);
  });

  it("a refused landing is thrown, and surfaces as 'Workspace merge failed: '", async () => {
    // planner: classifyMergeReply -> "declined". The chat layer wraps a
    // thrown workspace action as `Workspace <verb> failed: <message>`;
    // this asserts both halves of that path.
    const repo = await makeGitRepo();
    const s = await isolatedSession(repo, "refuse-probe");
    await fs.writeFile(path.join(s.cwd, "work.ts"), "export const x = 1;\n");
    await exec("git", ["add", "-A"], { cwd: s.cwd });
    await exec("git", ["commit", "-m", "work"], { cwd: s.cwd });
    // Move the source on independently so the landing cannot fast-forward
    // and cannot be auto-synced away.
    await fs.writeFile(path.join(repo, "work.ts"), "export const conflicting = 2;\n");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-m", "source moved"], { cwd: repo });

    await expect(manager.runWorkspaceAction(s.sessionId, "merge")).rejects.toThrow();
    // And the wrapper the planner actually sees.
    const wrapped = await manager
      .runWorkspaceAction(s.sessionId, "merge")
      .catch((e: unknown) => `Workspace merge failed: ${e instanceof Error ? e.message : String(e)}`);
    expect(wrapped.startsWith("Workspace merge failed: ")).toBe(true);
  });

  it("a successful discard head-lines 'Discarded '", async () => {
    // planner: classifyDiscardReply -> ok. Used to clean up competition
    // losers; a false negative here leaks a worktree, a false positive
    // reports cleanup that did not happen.
    const repo = await makeGitRepo();
    const s = await isolatedSession(repo, "discard-probe");

    const msg = await manager.runWorkspaceAction(s.sessionId, "discard");

    expect(msg.startsWith("Discarded ")).toBe(true);
  });

  it("warnings ride UNDER a 'Merged ' head line rather than replacing it", async () => {
    // planner: classifyMergeReply downgrades `Merged ...` + WARNING to
    // "unknown" instead of "landed". That downgrade only fires if the
    // daemon keeps appending warnings below the head line rather than
    // reshaping the reply — which is the assumption being pinned.
    const repo = await makeGitRepo();
    const s = await isolatedSession(repo, "warn-probe");
    // Uncommitted work is what gets replayed, and the replay is what can
    // warn. A clean-created workspace landing dirty work is the exact
    // shape the planner hits whenever a worker forgets to commit.
    await fs.writeFile(path.join(s.cwd, "loose.ts"), "export const x = 1;\n");

    const msg = await manager.runWorkspaceAction(s.sessionId, "merge");

    expect(msg.startsWith("Merged ")).toBe(true);
    for (const line of msg.split("\n").slice(1)) {
      if (line.includes("WARNING")) {
        expect(line.trimStart().startsWith("WARNING:")).toBe(true);
      }
    }
  });
});
