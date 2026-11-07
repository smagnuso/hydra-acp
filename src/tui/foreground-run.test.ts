import { EventEmitter } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { describe, expect, it } from "vitest";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { onPlatform } from "../core/platform-stub.js";
import { runForegroundChild, type SpawnFn } from "./foreground-run.js";

interface Harness {
  log: string[];
  writes: string[];
  child: EventEmitter;
  spawn: SpawnFn;
  calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }>;
  deps: {
    suspend: () => void;
    resume: () => void;
    notify: (message: string) => void;
    spawn: SpawnFn;
    write: (text: string) => void;
  };
}

function harness(opts: { throwOnSpawn?: Error } = {}): Harness {
  const log: string[] = [];
  const writes: string[] = [];
  const child = new EventEmitter();
  const calls: Harness["calls"] = [];
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    if (opts.throwOnSpawn) {
      throw opts.throwOnSpawn;
    }
    log.push("spawn");
    return child as unknown as ChildProcess;
  };
  return {
    log,
    writes,
    child,
    spawn,
    calls,
    deps: {
      suspend: () => log.push("suspend"),
      resume: () => log.push("resume"),
      notify: (message) => log.push(`notify:${message}`),
      spawn,
      write: (text) => writes.push(text),
    },
  };
}

const SPEC = { program: "vim", args: ["+42", "/repo/foo.ts"], cwd: "/repo" };

describe("runForegroundChild", () => {
  it("suspends before the spawn and resumes after the child exits", async () => {
    const h = harness();
    const done = runForegroundChild({ ...SPEC, banner: "editing\n" }, h.deps);
    expect(h.log).toEqual(["suspend", "spawn"]);
    h.child.emit("exit", 0);
    await expect(done).resolves.toEqual({ exitCode: 0 });
    expect(h.log).toEqual(["suspend", "spawn", "resume"]);
  });

  it("hands the child the terminal", async () => {
    const h = harness();
    const done = runForegroundChild(SPEC, h.deps);
    h.child.emit("exit", 0);
    await done;
    expect(h.calls).toEqual([
      {
        command: "vim",
        args: ["+42", "/repo/foo.ts"],
        options: { stdio: "inherit", cwd: "/repo" },
      },
    ]);
  });

  it("clears the screen and prints the banner before starting", async () => {
    const h = harness();
    const done = runForegroundChild({ ...SPEC, banner: "editing\n" }, h.deps);
    expect(h.writes).toEqual(["\x1b[H\x1b[J", "editing\n"]);
    h.child.emit("exit", 0);
    await done;
  });

  it("resumes and reports when the spawn fails outright", async () => {
    const h = harness();
    const done = runForegroundChild(SPEC, h.deps);
    h.child.emit("error", new Error("ENOENT"));
    await expect(done).resolves.toMatchObject({ exitCode: null });
    expect(h.log).toEqual([
      "suspend",
      "spawn",
      "resume",
      "notify:vim failed: ENOENT",
    ]);
  });

  it("resumes when spawn throws synchronously", async () => {
    const h = harness({ throwOnSpawn: new Error("EACCES") });
    await expect(runForegroundChild(SPEC, h.deps)).resolves.toMatchObject({
      exitCode: null,
    });
    expect(h.log).toEqual(["suspend", "resume", "notify:vim failed: EACCES"]);
  });

  it("reports a nonzero exit — the detached path never sees one", async () => {
    const h = harness();
    const done = runForegroundChild(SPEC, h.deps);
    h.child.emit("exit", 1);
    await done;
    expect(h.log).toEqual(["suspend", "spawn", "resume", "notify:vim exited 1"]);
  });

  it("settles once when both error and exit fire", async () => {
    const h = harness();
    const done = runForegroundChild(SPEC, h.deps);
    h.child.emit("error", new Error("boom"));
    h.child.emit("exit", null);
    await done;
    expect(h.log.filter((entry) => entry === "resume")).toHaveLength(1);
  });

  it("parks SIGINT listeners for the duration and restores them after", async () => {
    // ^C inside the editor hits our process group too, and the TUI's own
    // SIGINT handler would cancel the turn or exit out from under the
    // editor. A no-op has to take its place: with zero listeners node
    // applies the default action and the process dies.
    const ours = (): void => undefined;
    process.on("SIGINT", ours);
    // Snapshot rather than assert a count: the test runner keeps its own
    // SIGINT listeners on process.
    const before = process.listeners("SIGINT");
    try {
      const h = harness();
      const done = runForegroundChild(SPEC, h.deps);
      const parked = process.listeners("SIGINT");
      expect(parked).not.toContain(ours);
      expect(parked).toHaveLength(1);
      h.child.emit("exit", 0);
      await done;
      expect(process.listeners("SIGINT")).toEqual(before);
    } finally {
      process.off("SIGINT", ours);
    }
  });
});

describe("runForegroundChild with a Windows .cmd shim", () => {
  // `code`, `cursor` and `subl` are .cmd files on Windows, which spawn()
  // cannot run by bare name or without cmd.exe.
  async function runShim(dirName: string): Promise<Harness["calls"]> {
    const dir = mkdtempSync(join(tmpdir(), "hydra-fg-")) + "/" + dirName;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir);
    writeFileSync(join(dir, "myeditor.cmd"), "@echo off\n");
    const previous = process.env["PATH"];
    process.env["PATH"] = dir;
    try {
      return await onPlatform("win32", async () => {
        const h = harness();
        const done = runForegroundChild(
          { program: "myeditor", args: ["--wait", "C:\\a b\\x.md"] },
          h.deps,
        );
        h.child.emit("exit", 0);
        await done;
        return h.calls;
      });
    } finally {
      process.env["PATH"] = previous;
    }
  }

  it("resolves the shim and runs it through the shell", async () => {
    const calls = await runShim("bin");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command.endsWith("myeditor.cmd")).toBe(true);
    expect(calls[0]!.options.shell).toBe(true);
    expect(calls[0]!.args).toEqual(["--wait", '"C:\\a b\\x.md"']);
  });

  it("quotes a shim path that contains a space", async () => {
    const calls = await runShim("my bin");
    expect(calls[0]!.command.startsWith('"')).toBe(true);
    expect(calls[0]!.command.endsWith('myeditor.cmd"')).toBe(true);
  });

  it("does not use the shell for an ordinary program", async () => {
    const h = harness();
    const done = runForegroundChild({ program: "vim", args: ["x"] }, h.deps);
    h.child.emit("exit", 0);
    await done;
    expect(h.calls[0]!.options.shell).toBeUndefined();
    expect(h.calls[0]!.command).toBe("vim");
  });
});
