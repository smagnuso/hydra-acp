import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyCarry,
  readWorkspaceRepoConfig,
  runWorkspaceHook,
} from "./setup.js";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function tmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return fs.realpath(dir);
}

describe("readWorkspaceRepoConfig", () => {
  it("returns empty when the repo declares nothing", async () => {
    expect(await readWorkspaceRepoConfig(await tmp("hydra-cfg-none-"))).toEqual({});
  });

  it("unions .worktreeinclude with our own carry list", async () => {
    // A repo already set up for `claude --worktree` should need no
    // second config to work here.
    const dir = await tmp("hydra-cfg-union-");
    await fs.mkdir(path.join(dir, ".hydra"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".hydra/worktree.json"),
      JSON.stringify({ carry: [".env"], postCreate: "npm ci" }),
    );
    await fs.writeFile(
      path.join(dir, ".worktreeinclude"),
      "# comment\n\n.env\nconfig/secrets.json\n",
    );

    const cfg = await readWorkspaceRepoConfig(dir);
    expect(cfg.carry?.sort()).toEqual([".env", "config/secrets.json"]);
    expect(cfg.postCreate).toBe("npm ci");
  });

  it("skips pattern lines rather than half-implementing globbing", async () => {
    // A silently mis-expanded pattern is worse than an honestly ignored
    // one: the user would think a file was carried when it was not.
    const dir = await tmp("hydra-cfg-glob-");
    await fs.writeFile(path.join(dir, ".worktreeinclude"), "*.env\n!keep\n.env.local\n");
    const cfg = await readWorkspaceRepoConfig(dir);
    expect(cfg.carry).toEqual([".env.local"]);
  });

  it("reads a foreign declaration but never a foreign hook", async () => {
    // pi-worktree's config declares postCreate commands. Copying a
    // listed file is inert; running another tool's setup command
    // because its config is present would execute commands with no user
    // intent behind them here.
    const dir = await tmp("hydra-cfg-foreign-");
    await fs.mkdir(path.join(dir, ".pi"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".pi/worktree.json"),
      JSON.stringify({ postCreate: "rm -rf /" }),
    );
    const cfg = await readWorkspaceRepoConfig(dir);
    expect(cfg.postCreate).toBeUndefined();
  });
});

describe("applyCarry", () => {
  it("copies a file that the checkout did not materialize", async () => {
    const src = await tmp("hydra-carry-src-");
    const ws = await tmp("hydra-carry-ws-");
    await fs.writeFile(path.join(src, ".env"), "SECRET=1\n");

    const res = await applyCarry(src, ws, [".env"]);
    expect(res.copied).toEqual([".env"]);
    expect(await fs.readFile(path.join(ws, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  it("never overwrites a file the workspace already has", async () => {
    // This is how "only gitignored files are carried" falls out without
    // asking git anything: a TRACKED file is already in the checkout, so
    // it is present and skipped. Overwriting would replace materialized
    // content with a stale copy from the source tree.
    const src = await tmp("hydra-carry-src2-");
    const ws = await tmp("hydra-carry-ws2-");
    await fs.writeFile(path.join(src, "tracked.txt"), "source version\n");
    await fs.writeFile(path.join(ws, "tracked.txt"), "workspace version\n");

    const res = await applyCarry(src, ws, ["tracked.txt"]);
    expect(res.skipped).toEqual(["tracked.txt"]);
    expect(await fs.readFile(path.join(ws, "tracked.txt"), "utf8")).toBe("workspace version\n");
  });

  it("carries a directory and creates intermediate dirs", async () => {
    const src = await tmp("hydra-carry-src3-");
    const ws = await tmp("hydra-carry-ws3-");
    await fs.mkdir(path.join(src, "config"), { recursive: true });
    await fs.writeFile(path.join(src, "config/secrets.json"), "{}\n");

    const res = await applyCarry(src, ws, ["config/secrets.json"]);
    expect(res.copied).toEqual(["config/secrets.json"]);
    expect(await fs.readFile(path.join(ws, "config/secrets.json"), "utf8")).toBe("{}\n");
  });

  it("refuses to escape either tree", async () => {
    // Carry entries are repo config, and repo config can arrive on a
    // branch someone else wrote.
    const src = await tmp("hydra-carry-src4-");
    const ws = await tmp("hydra-carry-ws4-");
    const res = await applyCarry(src, ws, ["../../etc/passwd", "/etc/hosts"]);
    expect(res.copied).toEqual([]);
    expect(res.skipped).toHaveLength(2);
  });

  it("skips a declared file the source does not have", async () => {
    const src = await tmp("hydra-carry-src5-");
    const ws = await tmp("hydra-carry-ws5-");
    const res = await applyCarry(src, ws, [".env"]);
    expect(res.copied).toEqual([]);
    expect(res.skipped).toEqual([".env"]);
  });
});

describe("runWorkspaceHook", () => {
  it("runs in the workspace and receives context as env", async () => {
    const src = await tmp("hydra-hook-src-");
    const ws = await tmp("hydra-hook-ws-");
    const res = await runWorkspaceHook(
      'printf "%s|%s" "$PWD" "$HYDRA_SOURCE_CWD" > marker.txt',
      { workspacePath: ws, sourceCwd: src, label: "l" },
    );
    expect(res.ok).toBe(true);
    expect(await fs.readFile(path.join(ws, "marker.txt"), "utf8")).toBe(`${ws}|${src}`);
  });

  it("also receives context as JSON on stdin", async () => {
    const src = await tmp("hydra-hook-src2-");
    const ws = await tmp("hydra-hook-ws2-");
    const res = await runWorkspaceHook("cat > payload.json", {
      workspacePath: ws,
      sourceCwd: src,
      label: "mylabel",
    });
    expect(res.ok).toBe(true);
    const parsed = JSON.parse(await fs.readFile(path.join(ws, "payload.json"), "utf8"));
    expect(parsed).toMatchObject({ path: ws, sourceCwd: src, label: "mylabel" });
  });

  it("reports failure with the reason instead of throwing", async () => {
    // A broken setup command must not take the session down: a session
    // in a half-set-up workspace is more useful than no session.
    const ws = await tmp("hydra-hook-ws3-");
    const res = await runWorkspaceHook("echo 'boom' >&2; exit 3", {
      workspacePath: ws,
      sourceCwd: ws,
      label: "l",
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("boom");
  });

  it("kills a hook that overruns its timeout", async () => {
    const ws = await tmp("hydra-hook-ws4-");
    const res = await runWorkspaceHook("sleep 5", {
      workspacePath: ws,
      sourceCwd: ws,
      label: "l",
      timeoutSeconds: 1,
    });
    expect(res.ok).toBe(false);
  });
});
