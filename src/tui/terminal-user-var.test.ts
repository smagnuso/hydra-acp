import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { clearUserVar, emitSetUserVar } from "./terminal-user-var.js";

describe("terminal-user-var", () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalPane = process.env.TMUX_PANE;
  let chunks: string[] = [];
  beforeEach(() => {
    chunks = [];
    process.stdout.write = ((buf: string | Uint8Array): boolean => {
      chunks.push(typeof buf === "string" ? buf : Buffer.from(buf).toString());
      return true;
    }) as typeof process.stdout.write;
    // Force the tmux shellout branch off so tests don't spawn processes.
    delete process.env.TMUX_PANE;
  });
  afterEach(() => {
    process.stdout.write = originalWrite;
    if (originalPane === undefined) {
      delete process.env.TMUX_PANE;
    } else {
      process.env.TMUX_PANE = originalPane;
    }
  });

  it("emits OSC 1337 SetUserVar with base64-encoded value", () => {
    emitSetUserVar("hydra_session", "hydra_session_abc123");
    expect(chunks).toEqual([
      `\x1b]1337;SetUserVar=hydra_session=${Buffer.from(
        "hydra_session_abc123",
      ).toString("base64")}\x07`,
    ]);
  });

  it("clearUserVar emits the sequence with an empty value", () => {
    clearUserVar("hydra_session");
    expect(chunks).toEqual(["\x1b]1337;SetUserVar=hydra_session=\x07"]);
  });
});
