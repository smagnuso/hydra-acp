import { EventEmitter } from "node:stream";
import { readFileSync, writeFileSync } from "node:fs";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  editTextInEditor,
  resolveEditorCommand,
  type EditTextDeps,
} from "./edit-in-editor.js";
import type { SpawnFn } from "./foreground-run.js";

describe("resolveEditorCommand", () => {
  it("prefers $HYDRA_EDITOR over $VISUAL and $EDITOR", () => {
    expect(
      resolveEditorCommand({ HYDRA_EDITOR: "hx", VISUAL: "code --wait", EDITOR: "vim" }),
    ).toEqual(["hx"]);
  });

  it("prefers $VISUAL over $EDITOR", () => {
    expect(resolveEditorCommand({ VISUAL: "code --wait", EDITOR: "vim" })).toEqual([
      "code",
      "--wait",
    ]);
  });

  it("falls back to $EDITOR when $VISUAL is unset", () => {
    expect(resolveEditorCommand({ EDITOR: "vim" })).toEqual(["vim"]);
  });

  it("skips a blank $VISUAL rather than letting it shadow $EDITOR", () => {
    expect(resolveEditorCommand({ VISUAL: "  ", EDITOR: "vim" })).toEqual(["vim"]);
  });

  it("skips a blank $HYDRA_EDITOR rather than letting it shadow $VISUAL", () => {
    expect(
      resolveEditorCommand({ HYDRA_EDITOR: "  ", VISUAL: "code --wait", EDITOR: "vim" }),
    ).toEqual(["code", "--wait"]);
  });

  it("returns null when none are set", () => {
    expect(resolveEditorCommand({})).toBeNull();
  });
});

interface Harness {
  deps: EditTextDeps;
  log: string[];
  written: () => string;
  child: EventEmitter;
}

// Fakes the editor: on spawn, overwrites the temp file it was handed
// (last arg) with `nextContent`, then the test fires exit itself.
function harness(nextContent: string | null): Harness {
  const log: string[] = [];
  let lastFile = "";
  const child = new EventEmitter();
  const spawn: SpawnFn = (command, args, _options: SpawnOptions) => {
    log.push(`spawn:${command}:${args.join(" ")}`);
    lastFile = args[args.length - 1]!;
    if (nextContent !== null) {
      writeFileSync(lastFile, nextContent, "utf8");
    }
    return child as unknown as ChildProcess;
  };
  return {
    log,
    written: () => readFileSync(lastFile, "utf8"),
    child,
    deps: {
      suspend: () => log.push("suspend"),
      resume: () => log.push("resume"),
      notify: (message) => log.push(`notify:${message}`),
      spawn,
      write: () => undefined,
    },
  };
}

describe("editTextInEditor", () => {
  it("writes the buffer to a temp file, spawns $EDITOR on it, and returns the edited text", async () => {
    const h = harness("edited text\n");
    const done = editTextInEditor("original text", {
      ...h.deps,
      env: { EDITOR: "vim" },
    });
    h.child.emit("exit", 0);
    await expect(done).resolves.toBe("edited text");
    expect(h.log).toEqual(["suspend", expect.stringContaining("spawn:vim:"), "resume"]);
  });

  it("passes the original buffer as the seed file content", async () => {
    const h = harness(null);
    const done = editTextInEditor("seed content", {
      ...h.deps,
      env: { EDITOR: "vim" },
    });
    expect(h.written()).toBe("seed content");
    h.child.emit("exit", 0);
    await done;
  });

  it("splits a multi-word $EDITOR into program and args", async () => {
    const h = harness("x");
    const done = editTextInEditor("x", { ...h.deps, env: { EDITOR: "code --wait" } });
    h.child.emit("exit", 0);
    await done;
    expect(h.log[1]).toContain("spawn:code:--wait ");
  });

  it("returns null and notifies when none of $HYDRA_EDITOR, $VISUAL, $EDITOR is set", async () => {
    const h = harness(null);
    const result = await editTextInEditor("text", { ...h.deps, env: {} });
    expect(result).toBeNull();
    expect(h.log).toEqual([
      "notify:no $HYDRA_EDITOR, $VISUAL or $EDITOR set — nothing to edit with",
    ]);
  });

  it("returns null on a nonzero exit, discarding whatever the editor wrote", async () => {
    const h = harness("half-written");
    const done = editTextInEditor("original", { ...h.deps, env: { EDITOR: "vim" } });
    h.child.emit("exit", 1);
    await expect(done).resolves.toBeNull();
  });

  it("strips exactly one trailing newline", async () => {
    const h = harness("line one\nline two\n\n");
    const done = editTextInEditor("x", { ...h.deps, env: { EDITOR: "vim" } });
    h.child.emit("exit", 0);
    await expect(done).resolves.toBe("line one\nline two\n");
  });
});
