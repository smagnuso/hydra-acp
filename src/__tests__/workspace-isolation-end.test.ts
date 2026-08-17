// End-to-end: leaving a workspace — merge, abandon, and the aftermath.
//
// The landing path is where the work either arrives or is lost, so these
// cover what a merge does to uncommitted vs committed work, what it
// reports when both sides edited the same lines, and what the session
// looks like afterwards (departure state, stale-path redirection,
// re-entry, and starting again without colliding with its own leftovers).
//
// One of six workspace-isolation-*.test.ts files split out of a single
// 2100-line suite so vitest can spread them across workers; shared
// fixtures live in workspace-isolation-harness.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionManager } from "../core/session-manager.js";
import { extractHydraMeta } from "../acp/types-hydra-meta.js";
import { buildHydraSessionMeta } from "../acp/types-session-list.js";
import { JsonRpcConnection } from "../acp/connection.js";
import { type AttachedClient } from "../core/session.js";
import { makeControlledStream } from "./test-utils.js";
import {
  drainSnapshots,
  exec,
  makeClient,
  makeGitRepo,
  makeIsolationManager,
  registerTempRootCleanup,
} from "./workspace-isolation-harness.js";

// See workspace-isolation-lifecycle.test.ts: real git, and these files
// no longer get the machine to themselves. This is the slowest of the six.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

registerTempRootCleanup();

describe("session isolation end-to-end: leaving a workspace", () => {
  let manager: SessionManager;
  let spawnedCwd: string | undefined;

  // The resurrect-after-landing tests build a second manager, so this
  // keeps the name the bodies already call.
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

  it("ends a workspace by merging and returning to the source", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "shipit");
    const wsPath = session.cwd;
    await fs.writeFile(path.join(wsPath, "tracked.txt"), "agent work\n");

    const msg = await manager.runWorkspaceAction(session.sessionId, "stop");
    // One sentence for one action: what merged, where it went, and that
    // the workspace is gone.
    expect(msg).toContain("Merged");
    expect(msg).toContain("returned there");
    expect(msg).toContain("workspace removed");

    // Back in the real tree, with the work landed.
    expect(session.cwd).toBe(repo);
    expect(session.workspace).toBeUndefined();
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("agent work\n");

    // Binding cleared on disk, not just in memory.
    const record = await manager.loadFromDisk(session.sessionId);
    expect(record?.workspace).toBeUndefined();
    expect(record?.cwd).toBe(repo);

    // Workspace gone, and its snapshot ref with it: integrated work
    // needs no recovery anchor, and a live ref pins objects forever.
    await expect(fs.access(wsPath)).rejects.toThrow();
    await expect(
      exec("git", ["rev-parse", "--verify", "refs/hydra/workspaces/quiet/autosave"], {
        cwd: repo,
      }),
    ).rejects.toThrow();
  });

  it("leaves the recall watermark on disk, so a cold wake still has recall", async () => {
    // Regression. Both round trips stamp summarizedThroughEntry to arm
    // recall, and neither used to persist it: leaveWorkspace's record
    // write carries cwd and the binding only. The session then kept
    // recall exactly as long as it stayed warm, and the first idle
    // timeout or daemon restart cost it every turn before the swap,
    // which is the history the round trip exists to preserve.
    //
    // Asserted through loadFromDisk because that is the read the
    // descriptor gate in resurrectFromDisk uses to decide whether the
    // resurrected agent is handed the recall MCP server at all.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const { client } = makeClient();
    await session.attach(client, "none");
    await session.prompt(client.clientId, {
      prompt: [{ type: "text", text: "work worth recalling" }],
    });

    await manager.runWorkspaceAction(session.sessionId, "start", "recallable");
    const entered = (await manager.loadFromDisk(session.sessionId))?.summarizedThroughEntry;
    expect(entered).toBeGreaterThan(0);

    await manager.runWorkspaceAction(session.sessionId, "stop");

    const left = await manager.loadFromDisk(session.sessionId);
    expect(left?.workspace).toBeUndefined();
    // The leave swap moves the watermark forward again (the workspace
    // turns are now behind it too), and that later value is the one that
    // has to survive.
    expect(left?.summarizedThroughEntry).toBe(session.summarizedThroughEntry);
    expect(left?.summarizedThroughEntry).toBeGreaterThanOrEqual(entered as number);
  });

  it("lands cleanly after several turns of autosave", async () => {
    // Regression. The start baseline and the per-turn autosave shared one
    // ref name, so the autosave clobbered the baseline on the first turn
    // inside the workspace. Landing then diffed the WORKSPACE against the
    // source and produced the inverse of the agent's own work; `git apply
    // --3way` rejecting it is the only reason it did not silently revert
    // the session's changes. Existing tests all landed immediately, so
    // none of them had an autosave to be clobbered by.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    // The user has their own uncommitted edit, untouched by the agent.
    await fs.writeFile(path.join(repo, "mine.txt"), "user edit\n");

    await manager.runWorkspaceAction(session.sessionId, "start", "afterturns");
    const wsPath = session.cwd;

    // Several turns' worth of agent work, each followed by an autosave.
    for (const round of ["one", "two", "three"]) {
      await fs.writeFile(path.join(wsPath, "tracked.txt"), `agent ${round}\n`);
      await (
        manager as unknown as { runWorkspaceSnapshot(s: typeof session): Promise<void> }
      ).runWorkspaceSnapshot(session);
    }

    const stream = makeControlledStream();
    await session.attach(
      { clientId: "c_afterturns", connection: new JsonRpcConnection(stream) } as AttachedClient,
      "none",
    );

    const report = await manager.runWorkspaceAction(session.sessionId, "stop");
    expect(report).toContain("Merged");
    // The agent's work survived: the whole point.
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("agent three\n");
    // The user's own edit came back too, and was not reported as a conflict.
    expect(await fs.readFile(path.join(repo, "mine.txt"), "utf8")).toBe("user edit\n");
    expect(report).not.toMatch(/could not be replayed|WARNING/i);
  });

  it("drops both the autosave and the landing baseline on exit", async () => {
    // Two refs now, two GC roots. A survivor pins objects for a session
    // that is finished with them.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "mine.txt"), "user edit\n");
    await manager.runWorkspaceAction(session.sessionId, "start", "refs");
    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "work\n");
    await (
      manager as unknown as { runWorkspaceSnapshot(s: typeof session): Promise<void> }
    ).runWorkspaceSnapshot(session);

    const before = await exec("git", ["for-each-ref", "refs/hydra/"], { cwd: repo });
    expect(before.stdout).toContain("refs/hydra/workspaces/refs/start");

    await manager.runWorkspaceAction(session.sessionId, "stop");
    const after = await exec("git", ["for-each-ref", "refs/hydra/"], { cwd: repo });
    expect(after.stdout).not.toContain(session.sessionId);
  });

  it("says nothing on a workspace swap, least of all that it compacted", async () => {
    // Workspace moves borrow swapUpstream, which is the compaction path,
    // so they used to announce "Compaction completed." That is wrong
    // twice: nothing was summarized, and it invites worry about lost
    // context at the moment the user is confirming a clean transition.
    //
    // Naming the swap after its cause fixed the wrong half. The swap is a
    // STEP inside `workspace start` / `stop`, not the outcome of one, and
    // the caller already reports the outcome — so announcing the step too
    // printed three lines for one action, two of them saying "returned".
    // It also fired before startWorkspace had written the cwd/binding
    // record, claiming a move nothing on disk yet justified. Progress is
    // covered by the workspace phases, which drive a live indicator.
    //
    // The synthetic message goes to ATTACHED CLIENTS rather than through
    // onBroadcast (it is deliberately not recorded to history), so the
    // assertion has to read a client's wire.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const stream = makeControlledStream();
    await session.attach(
      { clientId: "c_label", connection: new JsonRpcConnection(stream) } as AttachedClient,
      "none",
    );
    const textOf = (): string =>
      stream.sent
        .map((m) => {
          const u = (m as { params?: { update?: { content?: { text?: unknown } } } }).params
            ?.update;
          return typeof u?.content?.text === "string" ? u.content.text : "";
        })
        .join("");

    await manager.runWorkspaceAction(session.sessionId, "start", "labelled");
    expect(textOf()).not.toContain("Compaction completed");
    expect(textOf()).not.toMatch(/Moved into|Switched to/);

    stream.sent.length = 0;
    await manager.runWorkspaceAction(session.sessionId, "stop");
    expect(textOf()).not.toContain("Compaction completed");
    expect(textOf()).not.toMatch(/Returned to|Switched to/);
  });

  /** The streamed chunks in order, rather than joined into one blob. */
  function streamedTexts(stream: { sent: unknown[] }): string[] {
    return stream.sent
      .map((m) => {
        const u = (m as { params?: { update?: { content?: { text?: unknown } } } }).params?.update;
        return typeof u?.content?.text === "string" ? u.content.text : "";
      })
      .filter((t) => t.length > 0);
  }

  it("states the whole outcome once, rather than a line per step", async () => {
    // Three messages for one command, two of them saying "returned":
    // the streamed merge summary, the swap's own "Returned to the source
    // tree.", and the return value's "Returned to X. Workspace removed."
    //
    // The streaming existed only to dodge an ordering artifact — a
    // command's result renders at end of turn, so the merge summary
    // arrived AFTER the swap notice it preceded. Silencing the swap
    // removes the artifact and the reason for the workaround together,
    // which is what lets the whole outcome be one sentence.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const stream = makeControlledStream();
    await session.attach(
      { clientId: "c_order", connection: new JsonRpcConnection(stream) } as AttachedClient,
      "none",
    );
    await manager.runWorkspaceAction(session.sessionId, "start", "ordered");
    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "agent work\n");

    stream.sent.length = 0;
    const result = await manager.runWorkspaceAction(session.sessionId, "stop");

    // Nothing streamed: no half-report to be ordered against anything.
    expect(streamedTexts(stream)).toEqual([]);
    // And one line carrying every part, in the order it happened.
    expect(result.split("\n")).toHaveLength(1);
    expect(result).toMatch(/^Merged .* and returned there; workspace removed\.$/);
  });

  it("does not mistake its own landed work for the user's overlapping edits", async () => {
    // `merge` lands the work and stays put. A later `stop` then measured
    // the source against the snapshot taken at `start`, found the work the
    // merge had just put there, and reported the workspace's OWN changes
    // as the user's edits overlapping it. Nothing was lost, but the
    // warning said otherwise, which is worse than useless on a message
    // about possible data loss.
    //
    // Asserted against the STREAMED text, not the return value: the merge
    // summary (warnings included) now streams, so checking the return
    // would pass no matter what.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const stream = makeControlledStream();
    await session.attach(
      { clientId: "c_twice", connection: new JsonRpcConnection(stream) } as AttachedClient,
      "none",
    );
    await manager.runWorkspaceAction(session.sessionId, "start", "twice");
    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "original\nagent work\n");

    const merged = await manager.runWorkspaceAction(session.sessionId, "merge");
    expect(merged).not.toContain("WARNING");
    // The landing recorded where it left the source, which is what the
    // next one measures against.
    const refs = await exec("git", ["for-each-ref", "refs/hydra/"], { cwd: repo });
    expect(refs.stdout).toContain(`refs/hydra/workspaces/${session.workspace?.label}/baseline`);

    stream.sent.length = 0;
    const streamed = await manager.runWorkspaceAction(session.sessionId, "stop");
    expect(streamed).toContain("Merged");
    expect(streamed).not.toContain("WARNING");

    // And the work is in the source exactly once.
    const landed = await fs.readFile(path.join(repo, "tracked.txt"), "utf8");
    expect(landed).toBe("original\nagent work\n");
    // The baseline is a GC root like the others, so leaving is where it goes.
    const afterRefs = await exec("git", ["for-each-ref", "refs/hydra/"], { cwd: repo });
    expect(afterRefs.stdout).not.toContain(session.sessionId);
  });

  it("still reports a genuine overlap after a previous landing", async () => {
    // The re-baseline must not turn the warning off wholesale: an edit
    // the user makes to the same lines AFTER a merge is a real conflict
    // and still has to be reported and preserved.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const stream = makeControlledStream();
    await session.attach(
      { clientId: "c_conflict", connection: new JsonRpcConnection(stream) } as AttachedClient,
      "none",
    );
    await manager.runWorkspaceAction(session.sessionId, "start", "conflict");
    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "agent version\n");
    await manager.runWorkspaceAction(session.sessionId, "merge");

    // Post-merge, both sides now touch the same line.
    await fs.writeFile(path.join(repo, "tracked.txt"), "user version\n");
    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "agent second version\n");

    stream.sent.length = 0;
    const streamed = await manager.runWorkspaceAction(session.sessionId, "stop");
    expect(streamed).toContain("WARNING");
    expect(streamed).toContain(`refs/hydra/landing/${session.sessionId}`);

    // And the base it offers for recovery is the state the FIRST landing
    // left, not the state at `start`. This is the re-baseline's own
    // observable effect: measuring from `start` would make the earlier
    // landed work part of "the user's edits", both in the diff the hint
    // prints and in the patch that gets replayed.
    const base = /diff (\S+) /.exec(streamed)?.[1];
    expect(base).toBeDefined();
    const atBase = await exec("git", ["show", `${base}:tracked.txt`], { cwd: repo });
    expect(atBase.stdout).toBe("agent version\n");
  });

  it("reports progress phases on the way out, as it does on the way in", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const phases: string[] = [];
    session.onBroadcast((raw) => {
      const ev = raw as { params?: { update?: { sessionUpdate?: string; phase?: string } } };
      if (ev.params?.update?.sessionUpdate === "hydra_workspace") {
        phases.push(ev.params.update.phase ?? "");
      }
    });

    await manager.runWorkspaceAction(session.sessionId, "start", "phased");
    expect(phases).toContain("provisioning");
    expect(phases).toContain("entered");

    phases.length = 0;
    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "work\n");
    await manager.runWorkspaceAction(session.sessionId, "stop");
    // Both legs of the exit are slow enough that silence reads as a hang.
    expect(phases).toContain("landing");
    expect(phases).toContain("returning");
    expect(phases).toContain("left");
  });

  it("still reports the workspace to clients after a resurrect", async () => {
    // What a reattaching TUI actually reads. Session.workspace being right
    // is necessary but not sufficient: the projection into _meta is a
    // separate step, and state that only propagates via change events is
    // invisible to a client that joins after the change.
    const repo = await makeGitRepo();
    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "survives" },
    });
    const originalPath = session.cwd;

    const restarted = makeManager();
    const reloaded = await restarted.loadFromDisk(session.sessionId);
    const revived = await restarted.resurrect(reloaded!);

    // Read it the way a client does, through extractHydraMeta, not off
    // the builder's output. Asserting on the raw object skips the parser,
    // and the parser was where the binding was being dropped: it parses
    // key-by-key and simply had no case for workspaceInfo, so every
    // client saw undefined while the wire carried the real thing.
    const meta = extractHydraMeta({
      "hydra-acp": buildHydraSessionMeta(restarted.liveListEntry(revived)),
    });
    const info = meta.workspaceInfo;
    expect(info?.sourceCwd).toBe(repo);
    expect(info?.path).toBe(originalPath);
    // cwd and the binding must still agree, or a client shows one tree
    // while the agent edits another.
    expect(meta.cwd).toBe(info?.path);

    // The same session as `session list` and GET /v1/sessions see it.
    // That path is a separate warm-entry literal from liveListEntry, and
    // it was reporting this session as an ordinary one in a hash dir.
    // includeNonInteractive: a freshly resurrected session with no
    // history yet reads as non-interactive and is filtered out by default.
    const listed = (await restarted.list({ includeNonInteractive: true })).find(
      (e) => e.sessionId === revived.sessionId,
    );
    expect(listed).toBeDefined();
    expect(listed?.workspace?.sourceCwd).toBe(repo);
    expect(listed?.cwd).toBe(originalPath);
  });

  it("reports the REBUILT workspace after recovery, not the vanished one", async () => {
    // The recovery ladder can relocate a session, so the projection has to
    // follow it. Reporting the recorded path here would point a client at
    // a directory that no longer exists.
    const repo = await makeGitRepo();
    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "relocated" },
    });
    await fs.writeFile(path.join(session.cwd, "work.txt"), "committed\n");
    await exec("git", ["add", "-A"], { cwd: session.cwd });
    await exec("git", ["commit", "-q", "-m", "work"], { cwd: session.cwd });
    await fs.rm(session.cwd, { recursive: true, force: true });

    const restarted = makeManager();
    const revived = await restarted.resurrect((await restarted.loadFromDisk(session.sessionId))!);

    const meta = buildHydraSessionMeta(restarted.liveListEntry(revived));
    const info = meta.workspaceInfo as { path?: string; sourceCwd?: string } | undefined;
    expect(info?.sourceCwd).toBe(repo);
    expect(meta.cwd).toBe(revived.cwd);
    expect(meta.cwd).toBe(info?.path);
    // And it is a directory that actually exists.
    expect((await fs.stat(revived.cwd)).isDirectory()).toBe(true);
  });

  it("tells the agent it has left, and redirects stale workspace paths", async () => {
    // Leaving does not erase the agent's memory. Its transcript refers to
    // files by workspace path, and nothing in the conversation says those
    // are no longer where its work belongs.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "departing");
    const wsPath = session.cwd;
    await manager.runWorkspaceAction(session.sessionId, "stop");

    const rewrite = (
      session as unknown as { applyWorkspacePromptRewrite(p: unknown[]): unknown[] }
    ).applyWorkspacePromptRewrite.bind(session);

    const first = rewrite([
      { type: "text", text: `check ${wsPath}/tracked.txt again` },
    ]) as { text: string }[];
    // Told plainly, once.
    expect(first[0]?.text).toContain("LEFT the isolated workspace");
    expect(first[0]?.text).toContain(repo);
    // And the stale path is redirected to where the work now lives.
    expect(first[0]?.text).toContain(`${repo}/tracked.txt`);
    expect(first[0]?.text).not.toContain(`${wsPath}/tracked.txt`);

    // An ordinary follow-up does not re-pay for the note.
    const second = rewrite([{ type: "text", text: "carry on" }]) as { text: string }[];
    expect(second[0]?.text).toBe("carry on");

    // But naming the dead workspace re-asserts, same as on the way in.
    const third = rewrite([{ type: "text", text: `what about ${wsPath}/other.txt` }]) as {
      text: string;
    }[];
    expect(third[0]?.text).toContain("LEFT the isolated workspace");
  });

  it("warns differently after detach, because the directory still absorbs writes", async () => {
    // `stop` removes the workspace, so a stale path fails loudly. `detach`
    // keeps it, so writes succeed and never land — the silent case, which
    // needs the stronger wording.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "abandoning");
    const wsPath = session.cwd;
    await manager.runWorkspaceAction(session.sessionId, "detach");

    const out = (
      session as unknown as { applyWorkspacePromptRewrite(p: unknown[]): unknown[] }
    ).applyWorkspacePromptRewrite([{ type: "text", text: "keep going" }]) as {
      text: string;
    }[];
    expect(out[0]?.text).toContain("NO LONGER YOURS");
    expect(out[0]?.text).toContain("will not reach");

    // And a write into the abandoned directory is reported rather than
    // silently accepted.
    const events: string[] = [];
    (session as unknown as { notifyChain(k: string, p: unknown): void }).notifyChain = (k) => {
      events.push(k);
    };
    (
      session as unknown as { reportIsolationBreach(p: string, t: unknown): void }
    ).reportIsolationBreach(`${wsPath}/ghost.ts`, "tool-1");
    expect(events).toContain("workspace.staleWrite");
  });

  it("clears the departure state when re-entering a workspace", async () => {
    // Leaving a stale rewrite armed would redirect paths belonging to a
    // workspace two moves ago.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "firstws");
    const firstPath = session.cwd;
    await manager.runWorkspaceAction(session.sessionId, "stop");
    await manager.runWorkspaceAction(session.sessionId, "start", "secondws");

    const out = (
      session as unknown as { applyWorkspacePromptRewrite(p: unknown[]): unknown[] }
    ).applyWorkspacePromptRewrite([{ type: "text", text: `look at ${firstPath}/x.ts` }]) as {
      text: string;
    }[];
    // Now isolated again, so the ENTRY preamble applies, not a departure note.
    expect(out[0]?.text).toContain("[workspace]");
    expect(out[0]?.text).not.toContain("LEFT the isolated workspace");
  });

  it("can start again after ending, without colliding with its own leftovers", async () => {
    // Regression. The default label is derived from the session id, so
    // it repeats; `stop` used to keep the branch, so the second start hit
    // "fatal: a branch named 'hydra/s-...' already exists". Two right
    // decisions that were wrong together.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });

    await manager.runWorkspaceAction(session.sessionId, "start");
    const first = session.cwd;
    await fs.writeFile(path.join(first, "tracked.txt"), "round one\n");
    await manager.runWorkspaceAction(session.sessionId, "stop");

    // The branch is gone too: merged, unreferenced, and squatting on the
    // label the next start wants.
    const branches = await exec("git", ["branch", "--list", "hydra/*"], { cwd: repo });
    expect(branches.stdout.trim()).toBe("");

    // Round two must just work.
    const msg = await manager.runWorkspaceAction(session.sessionId, "start");
    expect(msg).toContain("Moved into workspace");
    expect(session.workspace).toBeDefined();
    expect(session.cwd).not.toBe(repo);
  });

  it("picks a free label when a branch legitimately survives", async () => {
    // `detach` keeps the branch on purpose, so the name stays taken.
    // Starting again must sidestep rather than fail.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });

    await manager.runWorkspaceAction(session.sessionId, "start", "reused");
    await manager.runWorkspaceAction(session.sessionId, "detach");
    const kept = await exec("git", ["branch", "--list", "hydra/reused"], { cwd: repo });
    expect(kept.stdout).toContain("hydra/reused");

    await manager.runWorkspaceAction(session.sessionId, "start", "reused");
    expect(session.workspace?.label).toBe("reused-2");
    expect(session.workspace?.vcs?.branch).toBe("hydra/reused-2");
  });

  it("abandons without merging, keeping the workspace and its safety net", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "nevermind");
    const wsPath = session.cwd;
    await fs.writeFile(path.join(wsPath, "experiment.txt"), "might want this\n");
    // Give the ref something to hold.
    await (
      manager as unknown as { runWorkspaceSnapshot(s: typeof session): Promise<void> }
    ).runWorkspaceSnapshot(session);

    const msg = await manager.runWorkspaceAction(session.sessionId, "detach");
    expect(msg).toContain("WITHOUT merging");

    expect(session.cwd).toBe(repo);
    expect(session.workspace).toBeUndefined();
    // Nothing landed.
    await expect(fs.access(path.join(repo, "experiment.txt"))).rejects.toThrow();
    // The directory and the ref are the only copies, so both survive.
    expect(await fs.readFile(path.join(wsPath, "experiment.txt"), "utf8")).toBe(
      "might want this\n",
    );
    const ref = await exec(
      "git",
      ["rev-parse", "refs/hydra/workspaces/nevermind/autosave"],
      { cwd: repo },
    );
    expect(ref.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses to end when the drift CONFLICTS, leaving the session in place", async () => {
    // A source that merely moved on no longer refuses — the landing syncs
    // first, since fast-forward-only is a guarantee about the source and
    // merging into the workspace preserves it. What still refuses is drift
    // that genuinely conflicts, and the invariant this test exists for is
    // unchanged: a failed `stop` must not strand the work by returning to
    // the source anyway.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "stuck");
    const wsPath = session.cwd;
    // Same file, same line, committed on both sides.
    await fs.writeFile(path.join(wsPath, "tracked.txt"), "agent work\n");
    await exec("git", ["commit", "-qam", "agent work"], { cwd: wsPath });
    await fs.writeFile(path.join(repo, "tracked.txt"), "source work\n");
    await exec("git", ["commit", "-qam", "moved on, incompatibly"], { cwd: repo });

    await expect(manager.runWorkspaceAction(session.sessionId, "stop")).rejects.toThrow(
      /cannot fast-forward/i,
    );
    expect(session.cwd).toBe(wsPath);
    expect(session.workspace).toBeDefined();
    // The auto-sync aborted, so the workspace is not left half-merged.
    const state = await exec("git", ["status", "--porcelain"], { cwd: wsPath });
    expect(state.stdout).not.toContain("UU");
  });

  it("auto-syncs on the landing path when the source merely moved on", async () => {
    // The chore this removes: `stop` knew the source had moved, knew a
    // sync would fix it, and knew a sync fails safely — and still just
    // told the user to go run one command and come back.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "auto");
    await fs.writeFile(path.join(session.cwd, "agent.txt"), "agent work\n");
    await fs.writeFile(path.join(repo, "theirs.txt"), "landed elsewhere\n");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-qm", "someone else landed"], { cwd: repo });

    const msg = await manager.runWorkspaceAction(session.sessionId, "stop");

    expect(msg).toContain("Merged");
    expect(msg).toContain("synced with the source first");
    // Both sides present in the source, and the session is back home.
    expect(await fs.readFile(path.join(repo, "agent.txt"), "utf8")).toBe("agent work\n");
    expect(await fs.readFile(path.join(repo, "theirs.txt"), "utf8")).toBe("landed elsewhere\n");
    expect(session.workspace).toBeUndefined();
  });

  it("merges without leaving the workspace", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "keepgoing");
    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "first pass\n");

    const msg = await manager.runWorkspaceAction(session.sessionId, "merge");
    expect(msg).toContain("still working in");
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("first pass\n");
    expect(session.workspace).toBeDefined();
  });

  it("rejects workspace verbs on a session that is not isolated", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    for (const verb of ["merge", "stop", "detach"] as const) {
      await expect(manager.runWorkspaceAction(session.sessionId, verb)).rejects.toThrow(
        /not in a workspace/i,
      );
    }
  });
});
