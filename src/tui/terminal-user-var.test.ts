import { describe, expect, it, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  __resetTtyCacheForTests,
  clearActiveHydraSession,
  listLiveHydraTtys,
  publishActiveHydraSession,
  readStickyHydraSession,
} from "./terminal-user-var.js";

describe("terminal-user-var", () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalPane = process.env.TMUX_PANE;
  const originalHome = process.env.HYDRA_ACP_HOME;
  const originalIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
  let chunks: string[] = [];
  let tmpHome: string;

  beforeEach(() => {
    chunks = [];
    process.stdout.write = ((buf: string | Uint8Array): boolean => {
      chunks.push(typeof buf === "string" ? buf : Buffer.from(buf).toString());
      return true;
    }) as typeof process.stdout.write;
    delete process.env.TMUX_PANE;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-tty-test-"));
    process.env.HYDRA_ACP_HOME = tmpHome;
    (process.stdin as { isTTY?: boolean }).isTTY = false;
    __resetTtyCacheForTests();
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    if (originalPane === undefined) {
      delete process.env.TMUX_PANE;
    } else {
      process.env.TMUX_PANE = originalPane;
    }
    if (originalHome === undefined) {
      delete process.env.HYDRA_ACP_HOME;
    } else {
      process.env.HYDRA_ACP_HOME = originalHome;
    }
    (process.stdin as { isTTY?: boolean }).isTTY = originalIsTTY;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    __resetTtyCacheForTests();
  });

  it("emits OSC 1337 SetUserVar on publish", () => {
    publishActiveHydraSession("hydra_session_abc");
    expect(chunks[0]).toBe(
      `\x1b]1337;SetUserVar=hydra_session=${Buffer.from(
        "hydra_session_abc",
      ).toString("base64")}\x07`,
    );
  });

  it("clearActiveHydraSession emits the clear OSC", () => {
    clearActiveHydraSession();
    expect(chunks[0]).toBe("\x1b]1337;SetUserVar=hydra_session=\x07");
  });

  it("does not write a sticky file when stdin isn't a TTY", () => {
    publishActiveHydraSession("hydra_session_abc");
    expect(fs.existsSync(path.join(tmpHome, "tty"))).toBe(false);
    expect(readStickyHydraSession()).toBeNull();
  });

  // The file-format tests below exercise listLiveHydraTtys /
  // readStickyHydraSession via files we plant directly, since we can't
  // portably fake /proc/self/fd/0 to stress writeTtyStickyFile end-to-end.
  const seedStickyFile = (name: string, contents: string): void => {
    const dir = path.join(tmpHome, "tty");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), contents);
  };

  it("listLiveHydraTtys reports liveness via kill(pid, 0)", () => {
    seedStickyFile("42", `${process.pid}:${process.ppid}:hydra_session_alive\n`);
    seedStickyFile("99", `999999:1:hydra_session_dead\n`);
    seedStickyFile("legacy", `hydra_session_bare_id\n`);
    const entries = listLiveHydraTtys().sort((a, b) =>
      a.ttyBasename.localeCompare(b.ttyBasename),
    );
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      ttyBasename: "42",
      sessionId: "hydra_session_alive",
      alive: true,
    });
    expect(entries[1]).toMatchObject({
      ttyBasename: "99",
      sessionId: "hydra_session_dead",
      alive: false,
    });
    expect(entries[2]).toMatchObject({
      ttyBasename: "legacy",
      sessionId: "hydra_session_bare_id",
      alive: false,
      hydraPid: 0,
      parentPid: 0,
    });
  });

  it("listLiveHydraTtys returns [] when the tty dir doesn't exist", () => {
    expect(listLiveHydraTtys()).toEqual([]);
  });
});
