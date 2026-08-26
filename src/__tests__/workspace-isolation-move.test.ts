// End-to-end: moving a LIVE session into a workspace, and landing again.
//
// The swap has to carry uncommitted work in, announce itself so clients
// stop pointing at the old tree, leave nothing behind when it fails
// partway, and keep the pre-move state recoverable under refs/hydra.
//
// One of six workspace-isolation-*.test.ts files split out of a single
// 2100-line suite so vitest can spread them across workers; shared
// fixtures live in workspace-isolation-harness.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionManager } from "../core/session-manager.js";
import {
  drainSnapshots,
  exec,
  makeClient,
  makeGitRepo,
  makeIsolationManager,
  registerTempRootCleanup,
} from "./workspace-isolation-harness.js";

// See workspace-isolation-lifecycle.test.ts: real git, and these files
// no longer get the machine to themselves.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

registerTempRootCleanup();

describe("session isolation end-to-end: moving a live session", () => {
  let manager: SessionManager;
  /** cwd the agent process was actually spawned with. */
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

  it("copies staged work in, but lands it unstaged in the workspace", async () => {
    // Staging it in the workspace would leave the user's WIP sitting in
    // the index the agent commits from, so the agent's first bare
    // `git commit` would sweep it up.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "tracked.txt"), "staged edit\n");
    await fs.writeFile(path.join(repo, "added.txt"), "staged addition\n");
    await exec("git", ["add", "-A"], { cwd: repo });

    const msg = await manager.runWorkspaceAction(session.sessionId, "start", "staged");
    // Said out loud, because the files are here but `git diff --cached` is
    // empty, and nothing else would explain that.
    expect(msg).toContain("staging did not come along");

    expect(await fs.readFile(path.join(session.cwd, "tracked.txt"), "utf8")).toBe("staged edit\n");
    expect(await fs.readFile(path.join(session.cwd, "added.txt"), "utf8")).toBe(
      "staged addition\n",
    );
    const inWs = await exec("git", ["status", "--porcelain", "-uall"], { cwd: session.cwd });
    expect(inWs.stdout).toContain(" M tracked.txt");
    expect(inWs.stdout).toContain("?? added.txt");

    // And the source keeps its own copy, staged as the user left it.
    const inSource = await exec("git", ["status", "--porcelain", "-uall"], { cwd: repo });
    expect(inSource.stdout).toContain("M  tracked.txt");
    expect(inSource.stdout).toContain("A  added.txt");
  });

  it("gives two workspaces started from one dirty tree the same baseline", async () => {
    // The reason start copies. Taking the work would mean whichever
    // session runs first silently claims it and the second begins from
    // HEAD — a different baseline, chosen by typing order, reported to
    // nobody. Competition siblings exist to be identical at t=0, so
    // this is not a surprise but a wrong answer.
    const repo = await makeGitRepo();
    const first = await manager.create({ agentId: "claude-code", cwd: repo });
    const second = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "tracked.txt"), "shared premise\n");
    await fs.writeFile(path.join(repo, "notes.md"), "shared note\n");

    await manager.runWorkspaceAction(first.sessionId, "start", "one");
    await manager.runWorkspaceAction(second.sessionId, "start", "two");

    for (const s of [first, second]) {
      expect(await fs.readFile(path.join(s.cwd, "tracked.txt"), "utf8")).toBe("shared premise\n");
      expect(await fs.readFile(path.join(s.cwd, "notes.md"), "utf8")).toBe("shared note\n");
    }
    // And the tree they were both derived from still has it.
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("shared premise\n");
  });

  it("leaves nothing behind when the swap fails partway", async () => {
    // The failure this reproduces stranded a workspace holding the only
    // copy of the user's edits. Unwinding has to put the work back
    // BEFORE removing the tree that holds it.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "tracked.txt"), "work in progress\n");
    await fs.writeFile(path.join(repo, "extra.txt"), "untracked too\n");
    await exec("git", ["add", "tracked.txt"], { cwd: repo });

    vi.spyOn(session, "swapIntoWorkspace").mockRejectedValue(new Error("agent respawn failed"));

    await expect(
      manager.runWorkspaceAction(session.sessionId, "start", "doomed"),
    ).rejects.toThrow(/agent respawn failed/);

    // Session never moved.
    expect(session.workspace).toBeUndefined();
    expect(session.cwd).toBe(repo);
    // The work is back, staged and untracked alike.
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("work in progress\n");
    expect(await fs.readFile(path.join(repo, "extra.txt"), "utf8")).toBe("untracked too\n");
    // And no orphan workspace was left for `hydra workspace prune` to find.
    const worktrees = await exec("git", ["worktree", "list"], { cwd: repo });
    expect(worktrees.stdout).not.toContain("doomed");
  });

  it("refuses to start while the agent is mid-turn, without provisioning anything", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    vi.spyOn(session, "quiesceBlocker").mockResolvedValue(
      "the agent is still working; wait for the current turn to finish, then try again",
    );

    await expect(manager.runWorkspaceAction(session.sessionId, "start", "busy")).rejects.toThrow(
      /still working/i,
    );

    const worktrees = await exec("git", ["worktree", "list"], { cwd: repo });
    expect(worktrees.stdout).not.toContain("busy");
  });

  it("moves a live session into a workspace, copying uncommitted work in", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    expect(session.workspace).toBeUndefined();

    // Planning phase produced edits in the real tree.
    await fs.writeFile(path.join(repo, "tracked.txt"), "planned edit\n");
    await fs.writeFile(path.join(repo, "notes.md"), "new file\n");

    const msg = await manager.runWorkspaceAction(session.sessionId, "start", "feature");
    expect(msg).toContain("Moved into workspace");
    expect(msg).toContain("untouched");
    // Named, not counted: this is the only moment the pre-move state is
    // observable, and the list is how you check that what you were
    // mid-way through actually came along.
    expect(msg).toContain("carried 2 uncommitted file(s) in");
    expect(msg).toContain("tracked.txt");
    expect(msg).toContain("notes.md");

    // The session relocated, and the agent was respawned there.
    expect(session.workspace?.sourceCwd).toBe(repo);
    expect(session.cwd).toBe(session.workspace?.path);
    expect(spawnedCwd).toBe(session.cwd);

    // The work came along...
    expect(await fs.readFile(path.join(session.cwd, "tracked.txt"), "utf8")).toBe("planned edit\n");
    expect(await fs.readFile(path.join(session.cwd, "notes.md"), "utf8")).toBe("new file\n");

    // ...and is still in the real tree, which the session does not own.
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("planned edit\n");
    expect(await fs.readFile(path.join(repo, "notes.md"), "utf8")).toBe("new file\n");
  });

  it("announces the move so clients can stop pointing at the old tree", async () => {
    // A client resolves cwd once, at session/new or attach. Without this
    // event it has no way to learn the session relocated, and its cwd is
    // what file completion, the git panel and diff resolution are all
    // computed against.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const seen: Array<Record<string, unknown>> = [];
    session.onBroadcast?.((msg) => {
      const update = (msg.params as { update?: Record<string, unknown> } | undefined)?.update;
      if (update?.sessionUpdate === "_hydra_workspace") {
        seen.push(update);
      }
    });

    await manager.runWorkspaceAction(session.sessionId, "start", "announced");

    const phases = seen.map((u) => u.phase);
    expect(phases).toContain("provisioning");
    expect(phases).toContain("swapping");
    // The terminal phase carries where the session actually went.
    const entered = seen.find((u) => u.phase === "entered");
    expect(entered?.cwd).toBe(session.cwd);
    expect(entered?.sourceCwd).toBe(repo);
    expect(entered?.label).toBe("announced");
    // ...and it lands only after the record is written, so a client
    // acting on it cannot outrun the state that justifies it.
    expect(phases.indexOf("entered")).toBe(phases.length - 1);

    seen.length = 0;
    await manager.runWorkspaceAction(session.sessionId, "stop");
    const left = seen.find((u) => u.phase === "left");
    expect(left?.cwd).toBe(repo);
  });

  it("announces failure so the progress indicator cannot stick", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const seen: Array<Record<string, unknown>> = [];
    session.onBroadcast?.((msg) => {
      const update = (msg.params as { update?: Record<string, unknown> } | undefined)?.update;
      if (update?.sessionUpdate === "_hydra_workspace") {
        seen.push(update);
      }
    });
    vi.spyOn(session, "swapIntoWorkspace").mockRejectedValue(new Error("respawn failed"));

    await expect(
      manager.runWorkspaceAction(session.sessionId, "start", "doomed"),
    ).rejects.toThrow(/respawn failed/);

    expect(seen.map((u) => u.phase)).toContain("failed");
  });

  it("ends by returning uncommitted work uncommitted, and commits as commits", async () => {
    // The round trip has to be faithful. Handing WIP back as a commit
    // creates something the user never chose to create, and promotes
    // their untracked files to tracked ones on the way.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "tracked.txt"), "user wip\n");
    await fs.writeFile(path.join(repo, "scratch.md"), "untracked wip\n");

    await manager.runWorkspaceAction(session.sessionId, "start", "roundtrip");
    const wsPath = session.cwd;

    // The agent commits one thing deliberately and leaves another loose.
    await fs.writeFile(path.join(wsPath, "shipped.ts"), "deliberate\n");
    await exec("git", ["add", "shipped.ts"], { cwd: wsPath });
    await exec("git", ["commit", "-q", "-m", "agent: ship it"], { cwd: wsPath });
    await fs.writeFile(path.join(wsPath, "loose.ts"), "still working\n");

    await manager.runWorkspaceAction(session.sessionId, "stop");

    // The deliberate commit arrived as a commit.
    const log = await exec("git", ["log", "--oneline", "-3"], { cwd: repo });
    expect(log.stdout).toContain("agent: ship it");
    expect(log.stdout).not.toContain("hydra: work from");

    // Everything uncommitted arrived uncommitted, and the untracked file
    // is still untracked.
    const status = await exec("git", ["status", "--porcelain", "-uall"], { cwd: repo });
    expect(status.stdout).toContain(" M tracked.txt");
    expect(status.stdout).toContain("?? scratch.md");
    expect(status.stdout).toContain("?? loose.ts");
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("user wip\n");
    expect(await fs.readFile(path.join(repo, "loose.ts"), "utf8")).toBe("still working\n");
  });

  it("keeps working in the source tree while isolated, and lands both sides", async () => {
    // Copy semantics make this the intended workflow, not an edge case:
    // the source stays usable precisely because the workspace did not
    // take the work. So editing here must not make `stop` refuse.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "tracked.txt"), "copied in\n");

    await manager.runWorkspaceAction(session.sessionId, "start", "diverge");
    const wsPath = session.cwd;

    // The user keeps working in the source, on a file the agent never
    // touches. The agent works on its own file.
    await fs.writeFile(path.join(repo, "mine.txt"), "my parallel work\n");
    await fs.writeFile(path.join(wsPath, "theirs.txt"), "agent work\n");
    await exec("git", ["add", "theirs.txt"], { cwd: wsPath });
    await exec("git", ["commit", "-q", "-m", "agent: theirs"], { cwd: wsPath });

    await manager.runWorkspaceAction(session.sessionId, "stop");

    // Both survive. The agent's commit is a commit...
    const log = await exec("git", ["log", "--oneline", "-2"], { cwd: repo });
    expect(log.stdout).toContain("agent: theirs");
    // ...the copied WIP is back as uncommitted work...
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("copied in\n");
    // ...and so is the work done in the source while isolated.
    expect(await fs.readFile(path.join(repo, "mine.txt"), "utf8")).toBe("my parallel work\n");
  });

  it("reports rather than loses work when both sides edited the same lines", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });

    await manager.runWorkspaceAction(session.sessionId, "start", "clash");
    const wsPath = session.cwd;

    // Same file, same line, two different edits.
    await fs.writeFile(path.join(repo, "tracked.txt"), "source version\n");
    await fs.writeFile(path.join(wsPath, "tracked.txt"), "workspace version\n");
    await exec("git", ["commit", "-qam", "agent: my version"], { cwd: wsPath });

    const msg = await manager.runWorkspaceAction(session.sessionId, "stop");

    // The merge still lands, and the clash is reported with a recovery
    // path rather than the source edit being silently dropped.
    expect(msg).toMatch(/overlap|could not be replayed/i);
    const refs = await exec("git", ["for-each-ref", "refs/hydra/landing"], { cwd: repo });
    expect(refs.stdout.trim().length).toBeGreaterThan(0);
  });

  it("keeps the pre-move state recoverable under refs/hydra", async () => {
    // There is a window where the work exists in neither tree. The
    // snapshot ref is written before the source is touched so that
    // window is survivable.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "precious.txt"), "do not lose me\n");

    await manager.runWorkspaceAction(session.sessionId, "start", "safety");

    // The START ref, not the autosave ref. They were the same name once,
    // which is exactly how the autosave came to clobber this baseline.
    const ref = `refs/hydra/workspaces/${session.workspace?.label}/start`;
    const sha = (await exec("git", ["rev-parse", ref], { cwd: repo })).stdout.trim();
    const shown = await exec("git", ["show", `${sha}:precious.txt`], { cwd: repo });
    expect(shown.stdout).toBe("do not lose me\n");
  });

  it("keeps a per-turn history of the autosave in its reflog", async () => {
    // Each autosave overwrites the ref, and parents on HEAD rather than
    // on its predecessor, so without a log every new snapshot made the
    // last one unreachable: exactly one recovery point. Git will not log
    // a ref outside refs/heads on its own, so `--create-reflog` is what
    // turns "as of the last turn" into a per-turn history.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "turns");
    const snap = manager as unknown as {
      runWorkspaceSnapshot(s: typeof session): Promise<void>;
    };

    for (const text of ["first\n", "second\n", "third\n"]) {
      await fs.writeFile(path.join(session.cwd, "tracked.txt"), text);
      await snap.runWorkspaceSnapshot(session);
    }

    const ref = "refs/hydra/workspaces/turns/autosave";
    const log = await exec("git", ["reflog", "--format=%H", ref], { cwd: repo });
    const shas = log.stdout.trim().split("\n").filter((l) => l.length > 0);
    expect(shas).toHaveLength(3);

    // Every intermediate turn is still readable, not just the newest.
    const contents = await Promise.all(
      shas.map(async (sha) => (await exec("git", ["show", `${sha}:tracked.txt`], { cwd: repo })).stdout),
    );
    expect(contents).toEqual(["third\n", "second\n", "first\n"]);
  });

  it("persists cwd and the binding together, and reports status", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const started = await manager.runWorkspaceAction(session.sessionId, "start", "persisted");
    // Silence would read as "we did not look" rather than "there was
    // nothing to bring".
    expect(started).toContain("source tree was clean; nothing carried in");

    const record = await manager.loadFromDisk(session.sessionId);
    // The invariant every consumer relies on: if there is a binding,
    // cwd IS the workspace path.
    expect(record?.workspace?.path).toBe(record?.cwd);
    expect(record?.workspace?.sourceCwd).toBe(repo);

    const status = await manager.runWorkspaceAction(session.sessionId, "status");
    expect(status).toContain("Isolated in");
    expect(status).toContain(repo);
  });

  it("persists the recall watermark the swap installs", async () => {
    // The swap arms recall by stamping summarizedThroughEntry, which is
    // the whole reason it can skip generating a synopsis first. Both
    // gates that decide whether the replacement agent actually gets the
    // recall tools read that field off the RECORD, so a watermark that
    // only ever lived in memory buys recall until the first idle timeout
    // or daemon restart and then loses it with no error anywhere.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const { client } = makeClient();
    await session.attach(client, "none");
    await session.prompt(client.clientId, {
      prompt: [{ type: "text", text: "work worth recalling" }],
    });

    await manager.runWorkspaceAction(session.sessionId, "start", "watermarked");

    const armed = session.summarizedThroughEntry;
    expect(armed).toBeGreaterThan(0);
    const record = await manager.loadFromDisk(session.sessionId);
    expect(record?.summarizedThroughEntry).toBe(armed);
  });
});
