// End-to-end: workspace isolation as the AGENT and the USER see it.
//
// Two surfaces that both have to agree the session moved: the orientation
// the agent gets on its first prompt (including the rewriting of stale
// source-tree paths), and the workspace verbs a user actually types.
//
// One of six workspace-isolation-*.test.ts files split out of a single
// 2100-line suite so vitest can spread them across workers; shared
// fixtures live in workspace-isolation-harness.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionManager } from "../core/session-manager.js";
import { JsonRpcConnection } from "../acp/connection.js";
import { type AttachedClient } from "../core/session.js";
import { makeControlledStream } from "./test-utils.js";
import {
  drainSnapshots,
  exec,
  makeClient,
  makeGitRepo,
  makeIsolationManager,
  makeTempDir,
  registerTempRootCleanup,
} from "./workspace-isolation-harness.js";

// See workspace-isolation-lifecycle.test.ts: real git, and these files
// no longer get the machine to themselves.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

registerTempRootCleanup();

describe("session isolation end-to-end: prompts and typed commands", () => {
  let manager: SessionManager;
  let spawnedCwd: string | undefined;

  function makeManager(): SessionManager {
    return makeIsolationManager((cwd) => {
      spawnedCwd = cwd;
    });
  }

  beforeEach(() => {
    spawnedCwd = undefined;
    manager = makeManager();
  });

  afterEach(async () => {
    await drainSnapshots(manager);
  });

  it("orients the agent on its first prompt and rewrites source-tree paths", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "oriented" },
    });
    expect(session.workspaceNotes.length).toBeGreaterThan(0);

    const rewrite = (
      session as unknown as { applyWorkspacePromptRewrite(p: unknown[]): unknown[] }
    ).applyWorkspacePromptRewrite.bind(session);

    const first = rewrite([{ type: "text", text: `look at ${repo}/tracked.txt` }]) as {
      text: string;
    }[];
    // Oriented once, up front...
    expect(first[0]?.text).toContain("[workspace]");
    expect(first[0]?.text).toContain(session.cwd);
    // ...and the path now points at the file the agent should touch.
    expect(first[0]?.text).toContain(`${session.cwd}/tracked.txt`);
    expect(first[0]?.text).not.toContain(`${repo}/tracked.txt`);

    // An ordinary follow-up does not re-pay for the preamble.
    const second = rewrite([{ type: "text", text: "now run the tests" }]) as { text: string }[];
    expect(second[0]?.text).toBe("now run the tests");

    // But naming the source tree re-asserts, because that is the moment
    // a forgotten mapping does damage, and the preamble is exactly what
    // compaction drops on a long session.
    const third = rewrite([{ type: "text", text: `also ${repo}/other.txt` }]) as {
      text: string;
    }[];
    expect(third[0]?.text).toMatch(/reminder/i);
    expect(third[0]?.text).toContain(`${session.cwd}/other.txt`);
  });

  it("reports a write that lands in the source tree", async () => {
    // Detection, not prevention: the daemon sees file edits as
    // notifications, after the write. The point is that a breach of the
    // one promise isolation makes is never silent.
    const repo = await makeGitRepo();
    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "breach" },
    });

    const events: { kind: string; payload: unknown }[] = [];
    (session as unknown as { notifyChain(k: string, p: unknown): void }).notifyChain = (
      kind,
      payload,
    ) => {
      events.push({ kind, payload });
    };
    const report = (
      session as unknown as { reportIsolationBreach(p: string, t: unknown): void }
    ).reportIsolationBreach.bind(session);

    report(`${repo}/tracked.txt`, "tool-1");
    expect(events.map((e) => e.kind)).toContain("workspace.breach");
    expect((events[0]?.payload as { path?: string }).path).toBe(`${repo}/tracked.txt`);

    // Writes inside the workspace, and unrelated paths, are silent.
    events.length = 0;
    report(`${session.cwd}/tracked.txt`, "tool-2");
    report("/tmp/scratch.txt", "tool-3");
    expect(events).toEqual([]);
  });

  it("leaves a non-isolated session's prompts untouched", async () => {
    const plain = await makeTempDir("hydra-iso-noprompt-");
    const session = await manager.create({ agentId: "claude-code", cwd: plain });
    const out = (
      session as unknown as { applyWorkspacePromptRewrite(p: unknown[]): unknown[] }
    ).applyWorkspacePromptRewrite([{ type: "text", text: `look at ${plain}/x.ts` }]) as {
      text: string;
    }[];
    expect(out[0]?.text).toBe(`look at ${plain}/x.ts`);
  });

  it("starts a workspace when the user actually types the command", async () => {
    // Every other test here calls runWorkspaceAction directly, which
    // skips the prompt queue. Typing `/hydra workspace start` does not:
    // the command runs as a queue entry, so the session is mid-drain
    // while it asks to be swapped. Keying the swap gate on "is the queue
    // busy" makes the command refuse itself, and no test that bypasses
    // the queue can see it.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const { client } = makeClient();
    session.attach(client, "full");

    await session.prompt(client.clientId, {
      prompt: [{ type: "text", text: "/hydra workspace start typed" }],
    });

    expect(session.workspace?.sourceCwd).toBe(repo);
    expect(session.cwd).toBe(session.workspace?.path);
    expect(session.cwd).not.toBe(repo);
  });

  it("discards the workspace and its branch, keeping the autosave as the net", async () => {
    // The counterpart of `stop`. Destructive on purpose, and a slash
    // command has nowhere to put a confirmation prompt — so the autosave
    // ref is the confirmation: the work goes, but not irretrievably.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "nope");
    const wsPath = session.cwd;
    await fs.writeFile(path.join(wsPath, "regret.txt"), "not wanted\n");
    await (
      manager as unknown as { runWorkspaceSnapshot(s: typeof session): Promise<void> }
    ).runWorkspaceSnapshot(session);

    const msg = await manager.runWorkspaceAction(session.sessionId, "discard");

    expect(msg).toContain("Discarded");
    expect(session.cwd).toBe(repo);
    expect(session.workspace).toBeUndefined();
    // Directory and branch both gone; nothing landed in the source.
    await expect(fs.access(wsPath)).rejects.toThrow();
    expect((await exec("git", ["branch", "--list", "hydra/*"], { cwd: repo })).stdout).not.toContain(
      "hydra/nope",
    );
    await expect(fs.access(path.join(repo, "regret.txt"))).rejects.toThrow();

    // But the autosave survives, is named in the output, and still holds
    // the discarded file. Retired out of the live namespace, so a later
    // workspace reusing this label cannot overwrite it.
    const ref = /refs\/hydra\/retired\/nope-[0-9a-f]+/.exec(msg)?.[0];
    expect(ref).toBeDefined();
    const shown = await exec("git", ["show", `${ref}:regret.txt`], { cwd: repo });
    expect(shown.stdout).toBe("not wanted\n");
  });

  it("retires a discarded autosave so a reused label cannot clobber it", async () => {
    // A label is a name, not an identity: it is free again the moment its
    // workspace is gone, and the default is derived per session, so "try
    // again" reuses it. Left in the live namespace, the retained snapshot
    // is overwritten by the next workspace of that name on its first
    // turn — and the recovery command `discard` just printed would then
    // resolve to somebody else's work, with the discarded content
    // surviving only as an unmarked reflog entry.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const snap = manager as unknown as {
      runWorkspaceSnapshot(s: typeof session): Promise<void>;
    };

    await manager.runWorkspaceAction(session.sessionId, "start", "recycled");
    await fs.writeFile(path.join(session.cwd, "first.txt"), "attempt one\n");
    await snap.runWorkspaceSnapshot(session);
    const msg = await manager.runWorkspaceAction(session.sessionId, "discard");

    const retired = /refs\/hydra\/retired\/\S+/.exec(msg)?.[0];
    expect(retired).toBeDefined();
    // The live name is vacated, so nothing inherits its reflog.
    const live = await exec("git", ["for-each-ref", "refs/hydra/workspaces/recycled/"], {
      cwd: repo,
    });
    expect(live.stdout.trim()).toBe("");

    // Same label again — the ordinary retry path.
    await manager.runWorkspaceAction(session.sessionId, "start", "recycled");
    expect(session.workspace?.label).toBe("recycled");
    await fs.writeFile(path.join(session.cwd, "second.txt"), "attempt two\n");
    await snap.runWorkspaceSnapshot(session);

    // The retired snapshot still holds attempt one, untouched...
    const shown = await exec("git", ["show", `${retired}:first.txt`], { cwd: repo });
    expect(shown.stdout).toBe("attempt one\n");
    // ...and the new workspace's reflog covers only attempt two.
    const log = await exec(
      "git",
      ["reflog", "--format=%H", "refs/hydra/workspaces/recycled/autosave"],
      { cwd: repo },
    );
    expect(log.stdout.trim().split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("syncs the source's commits in, leaving a landing possible", async () => {
    // Explicit sync, run early to integration-test against what you will
    // land onto. (The landing path syncs by itself now, so this is the
    // deliberate use rather than the recovery.)
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "drifted");
    await fs.writeFile(path.join(session.cwd, "agent.txt"), "agent work\n");

    // The source moves on, on a path the workspace never touched.
    await fs.writeFile(path.join(repo, "theirs.txt"), "landed elsewhere\n");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-qm", "someone else landed"], { cwd: repo });

    const synced = await manager.runWorkspaceAction(session.sessionId, "sync");
    expect(synced).toContain("1 commit(s)");
    // The source's commit is present, and the agent's uncommitted work survived.
    expect(await fs.readFile(path.join(session.cwd, "theirs.txt"), "utf8")).toBe(
      "landed elsewhere\n",
    );
    expect(await fs.readFile(path.join(session.cwd, "agent.txt"), "utf8")).toBe("agent work\n");

    // And now it lands.
    const landed = await manager.runWorkspaceAction(session.sessionId, "stop");
    expect(landed).toContain("Merged");
    expect(await fs.readFile(path.join(repo, "agent.txt"), "utf8")).toBe("agent work\n");
  });

  it("autosaves after a TYPED sync, because the command is itself a turn", async () => {
    // No explicit snapshot in the sync path. A typed `/hydra …` runs as a
    // queue entry, and runQueueEntry ends in broadcastTurnComplete, which
    // fires the snapshot hook unconditionally — so the autosave follows
    // from the command being a turn rather than from sync arranging it.
    // Asserted end-to-end because that is a chain of three assumptions.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const { client } = makeClient();
    session.attach(client, "full");
    await manager.runWorkspaceAction(session.sessionId, "start", "snapsync");

    // Uncommitted work, so a snapshot has something to capture at all.
    await fs.writeFile(path.join(session.cwd, "wip.txt"), "in progress\n");
    await (
      manager as unknown as { runWorkspaceSnapshot(s: typeof session): Promise<void> }
    ).runWorkspaceSnapshot(session);
    const ref = "refs/hydra/workspaces/snapsync/autosave";
    const before = (await exec("git", ["rev-parse", ref], { cwd: repo })).stdout.trim();

    // Source moves on, then sync via the typed command.
    await fs.writeFile(path.join(repo, "theirs.txt"), "landed\n");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-qm", "source moved"], { cwd: repo });
    await session.prompt(client.clientId, {
      prompt: [{ type: "text", text: "/hydra workspace sync" }],
    });

    // The snapshot is fire-and-forget, so wait on the CONDITION rather
    // than on a duration.
    let after = before;
    for (let i = 0; i < 100 && after === before; i += 1) {
      after = (await exec("git", ["rev-parse", ref], { cwd: repo })).stdout.trim();
      if (after === before) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    expect(after).not.toBe(before);
    // And it captured the post-sync tree, not just the old one.
    const listed = await exec("git", ["ls-tree", "-r", "--name-only", after], { cwd: repo });
    expect(listed.stdout).toContain("theirs.txt");
    expect(listed.stdout).toContain("wip.txt");
  });

  it("reports an already-current workspace instead of making an empty commit", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "current");
    const before = (await exec("git", ["rev-parse", "HEAD"], { cwd: session.cwd })).stdout.trim();

    const msg = await manager.runWorkspaceAction(session.sessionId, "sync");

    expect(msg).toContain("Already up to date");
    const after = (await exec("git", ["rev-parse", "HEAD"], { cwd: session.cwd })).stdout.trim();
    expect(after).toBe(before);
  });

  it("refuses to sync a workspace someone else is in", async () => {
    // A sync rewrites files under whoever is working in there.
    const repo = await makeGitRepo();
    const owner = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(owner.sessionId, "start", "busy");
    const guest = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(guest.sessionId, "start", "busy");

    await expect(manager.runWorkspaceAction(guest.sessionId, "sync")).rejects.toThrow(
      /would move files under them/,
    );
  });

  it("keeps an explicit sync's conflict in the workspace, to be resolved there", async () => {
    // Aborting here is what made a genuinely conflicting pair unlandable:
    // landing needs a sync, so a sync that always aborted left no way to
    // resolve one from inside hydra at all. A conflicted workspace is also
    // what a workspace is FOR — fast-forward-only landing exists to keep
    // conflicts out of the user's tree — and there is an agent sitting in
    // this one that can do the resolving.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "clash");
    // Same file, same line, committed on both sides.
    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "workspace version\n");
    await exec("git", ["commit", "-qam", "agent edit"], { cwd: session.cwd });
    await fs.writeFile(path.join(repo, "tracked.txt"), "source version\n");
    await exec("git", ["commit", "-qam", "source edit"], { cwd: repo });

    // Reported as an outcome, not thrown: the tree really did change, so
    // an exception would claim nothing happened.
    const msg = await manager.runWorkspaceAction(session.sessionId, "sync");
    expect(msg).toContain("Synced with conflicts");
    expect(msg).toContain("tracked.txt");
    expect(msg).toContain("merge --abort");

    // The merge is genuinely in progress, with markers to resolve.
    const state = await exec("git", ["status", "--porcelain"], { cwd: session.cwd });
    expect(state.stdout).toContain("UU");
    const body = await fs.readFile(path.join(session.cwd, "tracked.txt"), "utf8");
    expect(body).toContain("workspace version");
    expect(body).toContain("source version");

    // And resolving it makes the landing work.
    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "reconciled\n");
    await exec("git", ["add", "tracked.txt"], { cwd: session.cwd });
    await exec("git", ["commit", "-qm", "resolve"], { cwd: session.cwd });
    const landed = await manager.runWorkspaceAction(session.sessionId, "stop");
    expect(landed).toContain("Merged");
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("reconciled\n");
  });

  it("syncs under uncommitted work on a file the incoming commit touches", async () => {
    // The condition git refuses to merge under is the NORMAL state of a
    // workspace: an agent is in there, so it is dirty. A sync that needs a
    // clean tree is one that works exactly when you do not need it, which
    // is how a drifted source became a dead end at `stop`.
    const repo = await makeGitRepo();
    // Long enough that the two edits do not share diff context. A
    // three-line file would put them in one hunk, which is a different
    // test: the restore then needs a 3-way merge and comes back staged.
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    await fs.writeFile(path.join(repo, "shared.txt"), `${lines.join("\n")}\n`);
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-qm", "add shared"], { cwd: repo });
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "dirtysync");

    // Mid-task: an uncommitted edit at the top of the file...
    const agentEdit = [...lines];
    agentEdit[0] = "line 1, edited by the agent";
    await fs.writeFile(path.join(session.cwd, "shared.txt"), `${agentEdit.join("\n")}\n`);
    // ...while the source lands a commit touching the same file at the far
    // end. Different hunks, but git declines on the FILE, not the overlap.
    const sourceEdit = [...lines];
    sourceEdit[19] = "line 20, landed by someone else";
    await fs.writeFile(path.join(repo, "shared.txt"), `${sourceEdit.join("\n")}\n`);
    await exec("git", ["commit", "-qam", "someone else landed"], { cwd: repo });

    const both = [...lines];
    both[0] = agentEdit[0] as string;
    both[19] = sourceEdit[19] as string;
    const msg = await manager.runWorkspaceAction(session.sessionId, "sync");
    expect(msg).toContain("1 commit(s)");
    expect(msg).toContain("set aside");
    expect(await fs.readFile(path.join(session.cwd, "shared.txt"), "utf8")).toBe(
      `${both.join("\n")}\n`,
    );
    // Back UNSTAGED, which is how it was being held. Only true because the
    // replay tries a plain apply before falling back to --3way, which
    // stages what it applies.
    const state = await exec("git", ["status", "--porcelain"], { cwd: session.cwd });
    expect(state.stdout).toMatch(/^ M shared\.txt$/m);
    // The recovery ref is released once the work is back in the tree.
    const held = await exec("git", ["for-each-ref", "refs/hydra/sync/"], { cwd: repo });
    expect(held.stdout.trim()).toBe("");

    const landed = await manager.runWorkspaceAction(session.sessionId, "stop");
    expect(landed).toContain("Merged");
    expect(await fs.readFile(path.join(repo, "shared.txt"), "utf8")).toBe(`${both.join("\n")}\n`);
  });

  it("lands a drifted source from a dirty workspace without a manual sync", async () => {
    // The reported failure, end to end: `stop` already auto-synced, and the
    // sync died on the workspace's own uncommitted work — then suggested
    // the verb that had just failed, and mislabelled the reason as
    // "0 file(s) conflict".
    const repo = await makeGitRepo();
    await fs.writeFile(path.join(repo, "shared.txt"), "top\nmiddle\nbottom\n");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-qm", "add shared"], { cwd: repo });
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "healed");

    await fs.writeFile(path.join(session.cwd, "shared.txt"), "agent top\nmiddle\nbottom\n");
    await fs.writeFile(path.join(repo, "shared.txt"), "top\nmiddle\nsource bottom\n");
    await exec("git", ["commit", "-qam", "someone else landed"], { cwd: repo });

    const landed = await manager.runWorkspaceAction(session.sessionId, "stop");
    expect(landed).toContain("Merged");
    expect(landed).not.toContain("file(s) conflict");
    expect(await fs.readFile(path.join(repo, "shared.txt"), "utf8")).toBe(
      "agent top\nmiddle\nsource bottom\n",
    );
  });

  it("puts the work back and names the next action when the histories really conflict", async () => {
    // A conflict has to be resolved with a merge left in progress, and that
    // cannot coexist with work held aside for the merge to run at all. So
    // this one restores instead — which keeps "nothing changed" true, and
    // is what makes the next step statable.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "clashdirty");
    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "workspace version\n");
    await exec("git", ["commit", "-qam", "agent edit"], { cwd: session.cwd });
    await fs.writeFile(path.join(repo, "tracked.txt"), "source version\n");
    await exec("git", ["commit", "-qam", "source edit"], { cwd: repo });
    // And the agent has kept editing the same file since committing.
    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "workspace version, still going\n");
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: session.cwd })).stdout.trim();

    const msg = await manager.runWorkspaceAction(session.sessionId, "sync");
    expect(msg).toContain("genuinely conflict");
    expect(msg).toContain("Commit it");
    // The count that described nothing: printed for any failed merge,
    // including one git never started.
    expect(msg).not.toContain("0 file(s) conflict");

    // Nothing changed: work in place, no merge in progress, HEAD unmoved.
    expect(await fs.readFile(path.join(session.cwd, "tracked.txt"), "utf8")).toBe(
      "workspace version, still going\n",
    );
    const merging = await exec("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
      cwd: session.cwd,
    })
      .then(() => true)
      .catch(() => false);
    expect(merging).toBe(false);
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: session.cwd })).stdout.trim()).toBe(
      head,
    );
    const held = await exec("git", ["for-each-ref", "refs/hydra/sync/"], { cwd: repo });
    expect(held.stdout.trim()).toBe("");

    // Following the named action gets to the resolvable state, which is
    // the whole point: the refusal is a step, not a dead end.
    await exec("git", ["commit", "-qam", "agent commits its wip"], { cwd: session.cwd });
    const second = await manager.runWorkspaceAction(session.sessionId, "sync");
    expect(second).toContain("Synced with conflicts");
    expect(second).toContain("tracked.txt");
  });

  it("says the source moved on at the turn boundary, once per new tip", async () => {
    // `status` could always answer this, but nobody runs `status` mid-task,
    // so the drift was discovered at `stop` — the worst moment, since the
    // answer there is a refusal.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const stream = makeControlledStream();
    await session.attach(
      { clientId: "c_drift", connection: new JsonRpcConnection(stream) } as AttachedClient,
      "none",
    );
    await manager.runWorkspaceAction(session.sessionId, "start", "drifty");
    const snap = manager as unknown as {
      runWorkspaceSnapshot(s: typeof session): Promise<void>;
    };
    const drifts = (): Array<Record<string, unknown>> =>
      stream.sent
        .map(
          (m) =>
            (m as { params?: { update?: Record<string, unknown> } }).params?.update ??
            {},
        )
        .filter((u) => u.sessionUpdate === "hydra_workspace" && u.phase === "drift");
    const said = (): string =>
      stream.sent
        .map((m) => {
          const u = (m as { params?: { update?: { content?: { text?: unknown } } } }).params
            ?.update;
          return typeof u?.content?.text === "string" ? u.content.text : "";
        })
        .join("");

    // Nothing has moved, and this turn wrote nothing either.
    await snap.runWorkspaceSnapshot(session);
    expect(drifts()).toHaveLength(0);

    await fs.writeFile(path.join(repo, "theirs.txt"), "landed\n");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-qm", "source moved"], { cwd: repo });

    // Probed even though this turn changed no file in the workspace: drift
    // is about the source, not about whether the agent wrote anything.
    await snap.runWorkspaceSnapshot(session);
    expect(drifts()).toHaveLength(1);
    expect(drifts()[0]?.behind).toBe(1);
    // Plus the prose, so a client that renders no phases still shows it.
    expect(said()).toContain("/hydra workspace sync");

    // Same tip on the next turn: silence, not a per-turn nag.
    await snap.runWorkspaceSnapshot(session);
    expect(drifts()).toHaveLength(1);

    // A further commit is new information.
    await fs.writeFile(path.join(repo, "more.txt"), "also landed\n");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-qm", "source moved again"], { cwd: repo });
    await snap.runWorkspaceSnapshot(session);
    expect(drifts()).toHaveLength(2);
    expect(drifts()[1]?.behind).toBe(2);

    // And a sync leaves nothing to say.
    await manager.runWorkspaceAction(session.sessionId, "sync");
    await snap.runWorkspaceSnapshot(session);
    expect(drifts()).toHaveLength(2);
  });

  it("refuses to discard a workspace someone else is in", async () => {
    // The refcount would keep the directory for the co-tenant, so a
    // degraded discard would report a deletion that did not happen.
    const repo = await makeGitRepo();
    const owner = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(owner.sessionId, "start", "ours");
    const wsPath = owner.cwd;
    const guest = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(guest.sessionId, "start", "ours");

    await expect(
      manager.runWorkspaceAction(guest.sessionId, "discard"),
    ).rejects.toThrow(/not yours alone to discard/);

    expect(guest.workspace).toBeDefined();
    await expect(fs.access(wsPath)).resolves.toBeUndefined();
  });

  it("rejects a verb it does not know, listing the ones it does", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const stream = makeControlledStream();
    const clientId = "c_unknownverb";
    await session.attach(
      { clientId, connection: new JsonRpcConnection(stream) } as AttachedClient,
      "none",
    );

    await session.prompt(clientId, {
      prompt: [{ type: "text", text: "/hydra workspace end" }],
    });

    expect(session.workspace).toBeUndefined();
    const said = stream.sent
      .map((m) => {
        const u = (m as { params?: { update?: { content?: { text?: unknown } } } }).params?.update;
        return typeof u?.content?.text === "string" ? u.content.text : "";
      })
      .join("");
    expect(said).toContain('Unknown workspace verb "end"');
    expect(said).toContain("start, merge, sync, stop, detach, discard, status");
  });
});
