// Replaying the source's divergence when part of it is already there.
//
// The case that motivated this: `merge` lands the workspace's work into
// the source and stays put, so a later `stop` measured the source against
// the state at `start`, produced a patch describing work the source
// already had, and reported the resulting apply failure as "your own
// edits overlap the workspace's changes". Nothing was lost, but a
// warning about possible data loss that is wrong is worse than no
// warning at all.

import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { GitProvider } from "./git-provider.js";
import { replaySourceDivergence } from "./source-state.js";
import type { SnapshotId } from "./provider.js";

const exec = promisify(execFile);
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-src-state-"));
  temps.push(dir);
  const real = await fs.realpath(dir);
  await fs.writeFile(path.join(real, "tracked.txt"), "original\n");
  await exec("git", ["init", "-b", "main"], { cwd: real });
  await exec("git", ["config", "user.email", "t@e.invalid"], { cwd: real });
  await exec("git", ["config", "user.name", "T"], { cwd: real });
  await exec("git", ["add", "-A"], { cwd: real });
  await exec("git", ["commit", "-q", "-m", "initial"], { cwd: real });
  return real;
}

const provider = new GitProvider();

/** Snapshot the working tree the way a landing does. */
function snap(repo: string, msg: string): Promise<SnapshotId> {
  return provider.captureWorkingState(repo, msg);
}

describe("replaySourceDivergence", () => {
  it("succeeds without touching the tree when the patch is already applied", async () => {
    const repo = await makeRepo();
    const base = await snap(repo, "base");
    await fs.writeFile(path.join(repo, "tracked.txt"), "landed work\n");
    const snapshot = await snap(repo, "diverged");

    // The tree still holds exactly what the patch describes, which is the
    // shape a second landing sees: the first one put it there.
    const ok = await replaySourceDivergence({
      source: repo,
      capture: { clean: false, base, snapshot },
    });

    expect(ok).toBe(true);
    const after = await fs.readFile(path.join(repo, "tracked.txt"), "utf8");
    expect(after).toBe("landed work\n");
    // No conflict markers: an already-applied patch must not be run
    // through --3way, which leaves them behind when it fails.
    expect(after).not.toContain("<<<<<<<");
  });

  it("still applies a patch the tree does not have", async () => {
    const repo = await makeRepo();
    const base = await snap(repo, "base");
    await fs.writeFile(path.join(repo, "tracked.txt"), "user work\n");
    const snapshot = await snap(repo, "diverged");
    // Roll the tree back, so the divergence genuinely needs replaying.
    await exec("git", ["checkout", "--", "tracked.txt"], { cwd: repo });

    const ok = await replaySourceDivergence({
      source: repo,
      capture: { clean: false, base, snapshot },
    });

    expect(ok).toBe(true);
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("user work\n");
  });

  it("reports a genuine conflict rather than silently discarding one side", async () => {
    const repo = await makeRepo();
    const base = await snap(repo, "base");
    await fs.writeFile(path.join(repo, "tracked.txt"), "their line\n");
    const snapshot = await snap(repo, "diverged");
    // A different edit to the same line, so neither patch nor tree wins.
    await fs.writeFile(path.join(repo, "tracked.txt"), "our line\n");
    await exec("git", ["commit", "-qam", "ours"], { cwd: repo });

    const ok = await replaySourceDivergence({
      source: repo,
      capture: { clean: false, base, snapshot },
    });

    expect(ok).toBe(false);
  });

  it("treats a clean capture as nothing to do", async () => {
    const repo = await makeRepo();
    expect(
      await replaySourceDivergence({ source: repo, capture: { clean: true, base: "HEAD" } }),
    ).toBe(true);
  });
});
