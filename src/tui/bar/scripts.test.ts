import { describe, expect, it, vi } from "vitest";
import { collectScriptCommands, createScriptRunner } from "./scripts.js";
import type { BarLayoutConfig } from "./types.js";

function emptyBarConfig(): BarLayoutConfig {
  return {
    composer: {
      top: { left: [], right: [] },
      bottom: { left: [], right: [] },
    },
    sessionbar: { left: [], right: [] },
  };
}

describe("collectScriptCommands", () => {
  it("collects a script entry at its default refresh", () => {
    const cfg = emptyBarConfig();
    cfg.composer.top.left = [{ script: "date" }];
    expect(collectScriptCommands(cfg, 5_000)).toEqual(new Map([["date", 5_000]]));
  });

  it("ignores entries without a script (field, text)", () => {
    const cfg = emptyBarConfig();
    cfg.composer.top.left = ["status", { text: "hi" }];
    expect(collectScriptCommands(cfg, 5_000).size).toBe(0);
  });

  it("honors a per-entry refreshMs override", () => {
    const cfg = emptyBarConfig();
    cfg.composer.top.left = [{ script: "date", refreshMs: 2_000 }];
    expect(collectScriptCommands(cfg, 5_000)).toEqual(new Map([["date", 2_000]]));
  });

  it("dedups the same command across regions, keeping the minimum refreshMs", () => {
    const cfg = emptyBarConfig();
    cfg.composer.top.left = [{ script: "date", refreshMs: 5_000 }];
    cfg.sessionbar.right = [{ script: "date", refreshMs: 1_000 }];
    expect(collectScriptCommands(cfg, 5_000)).toEqual(new Map([["date", 1_000]]));
  });

  it("walks all six sides", () => {
    const cfg: BarLayoutConfig = {
      composer: {
        top: { left: [{ script: "a" }], right: [{ script: "b" }] },
        bottom: { left: [{ script: "c" }], right: [{ script: "d" }] },
      },
      sessionbar: { left: [{ script: "e" }], right: [{ script: "f" }] },
    };
    expect([...collectScriptCommands(cfg, 5_000).keys()].sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
  });
});

describe("createScriptRunner", () => {
  it("runs a due command and reports sanitized stdout", async () => {
    const outputs = new Map<string, string | null>();
    const runner = createScriptRunner({
      cwd: () => null,
      onOutput: (command, output) => outputs.set(command, output),
    });
    const command = "echo '  hi  there  '";
    runner.poll(new Map([[command, 1_000]]), 0);
    await vi.waitFor(() => {
      expect(outputs.get(command)).toBe("hi there");
    });
  });

  it("collapses multi-line stdout to a single space-joined line", async () => {
    const outputs = new Map<string, string | null>();
    const runner = createScriptRunner({
      cwd: () => null,
      onOutput: (command, output) => outputs.set(command, output),
    });
    const command = "printf 'line1\\nline2\\n'";
    runner.poll(new Map([[command, 1_000]]), 0);
    await vi.waitFor(() => {
      expect(outputs.get(command)).toBe("line1 line2");
    });
  });

  it("reports null on a non-zero exit", async () => {
    const outputs = new Map<string, string | null>();
    const runner = createScriptRunner({
      cwd: () => null,
      onOutput: (command, output) => outputs.set(command, output),
    });
    const command = "exit 1";
    runner.poll(new Map([[command, 1_000]]), 0);
    await vi.waitFor(() => {
      expect(outputs.has(command)).toBe(true);
    });
    expect(outputs.get(command)).toBeNull();
  });

  it("reports null when stdout is empty", async () => {
    const outputs = new Map<string, string | null>();
    const runner = createScriptRunner({
      cwd: () => null,
      onOutput: (command, output) => outputs.set(command, output),
    });
    const command = "true";
    runner.poll(new Map([[command, 1_000]]), 0);
    await vi.waitFor(() => {
      expect(outputs.has(command)).toBe(true);
    });
    expect(outputs.get(command)).toBeNull();
  });

  it("does not re-spawn a command already in flight", async () => {
    const calls: number[] = [];
    const outputs = new Map<string, string | null>();
    const runner = createScriptRunner({
      cwd: () => null,
      onOutput: (command, output) => {
        outputs.set(command, output);
        calls.push(Date.now());
      },
    });
    const command = "sleep 0.2 && echo done";
    // Two polls in quick succession, both "due" by refreshMs: the second
    // must not spawn a second process while the first is still running.
    runner.poll(new Map([[command, 0]]), 0);
    runner.poll(new Map([[command, 0]]), 10);
    await vi.waitFor(() => {
      expect(outputs.get(command)).toBe("done");
    });
    expect(calls.length).toBe(1);
  });

  it("does not re-spawn a command before its refreshMs elapses", async () => {
    const outputs = new Map<string, string | null>();
    let runs = 0;
    const runner = createScriptRunner({
      cwd: () => null,
      onOutput: (command, output) => {
        runs++;
        outputs.set(command, output);
      },
    });
    const command = "echo again";
    runner.poll(new Map([[command, 10_000]]), 0);
    await vi.waitFor(() => {
      expect(outputs.has(command)).toBe(true);
    });
    // Still well within the 10s window: a second poll must not re-run it.
    runner.poll(new Map([[command, 10_000]]), 100);
    expect(runs).toBe(1);
  });
});
