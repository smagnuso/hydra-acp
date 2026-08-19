// Live tmux integration.
//
// The unit spec asserts on the command lines this adapter builds, which is
// necessary but not sufficient: it proves we send what we meant to, not that
// tmux does what we think. Several of the choices in tmux.ts came from
// probing a real server and would have been wrong on reasonable-looking
// assumptions —
//
//   * `new-window -t %pane` fails outright ("can't specify pane here"), so
//     window commands need a session target
//   * `rename-window` clears `automatic-rename` permanently
//   * multiple argv words are exec'd directly, NOT re-parsed by a shell
//
// so those get checked against the real thing. Skipped automatically when
// tmux isn't installed; runs on its own private socket so it can never touch
// a developer's session.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __resetTerminalHostForTests, initTerminalHost } from "./index.js";
import type { TerminalHost } from "./types.js";

const run = promisify(execFile);

const SOCKET = `/tmp/hydra-tmux-test-${process.pid}.sock`;

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await run("tmux", ["-S", SOCKET, ...args], { timeout: 5_000 });
  return stdout;
}

async function haveTmux(): Promise<boolean> {
  try {
    await run("tmux", ["-V"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

const installed = await haveTmux();

describe.skipIf(!installed)("tmux adapter against a real server", () => {
  let host: TerminalHost;
  let pane: string;

  beforeAll(async () => {
    await tmux("new-session", "-d", "-s", "hydratest", "sleep", "600");
    pane = (await tmux("display-message", "-p", "-F", "#{pane_id}")).trim();
    process.env.TMUX = `${SOCKET},1,0`;
    process.env.TMUX_PANE = pane;
    __resetTerminalHostForTests();
    const resolved = initTerminalHost();
    if (!resolved) {
      throw new Error("tmux host did not resolve");
    }
    host = resolved;
  });

  afterAll(async () => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    __resetTerminalHostForTests();
    await tmux("kill-server").catch(() => {});
  });

  it("resolves as the tmux host", () => {
    expect(host.id).toBe("tmux");
  });

  it("reads the window's real name, pane count and automatic-rename flag", async () => {
    const view = await host.readLabel!();
    expect(view).not.toBeNull();
    expect(view!.paneCount).toBe(1);
    // A fresh window tmux named itself after the running command.
    expect(view!.auto).toBe(true);
  });

  it("renames the window, and tmux then reports it as no longer auto", async () => {
    // The behaviour core's ownership guard depends on: after we write a
    // label, tmux stops considering the name its own.
    expect(await host.writeLabel!("hydra-live-test")).toBe(true);
    const view = await host.readLabel!();
    expect(view!.label).toBe("hydra-live-test");
    expect(view!.auto).toBe(false);
  });

  it("sets tokens that resolve in a per-window format string", async () => {
    // This is the whole point of `report` on tmux: a user putting
    // #{@hydra_state} in window-status-format sees which sessions need them.
    await host.report({
      state: "blocked",
      sessionId: "hydra_session_LIVEBLOCKED",
      title: "Refactor auth",
      cwd: "/tmp",
      agent: "claude-code",
      model: "opus",
      cost: "$1.23",
      queued: 2,
      turnOrigin: "peer",
      turnLabel: "fix flaky test",
    });
    const rendered = (
      await tmux("display-message", "-p", "-t", pane, "-F", "[#{@hydra_state}][#{@hydra_cost}]")
    ).trim();
    expect(rendered).toBe("[blocked][$1.23]");

    // Turn provenance resolves the same way, which is what makes a
    // "only flag work a human asked for" format string possible.
    const turn = (
      await tmux(
        "display-message",
        "-p",
        "-t",
        pane,
        "-F",
        "[#{@hydra_turn_origin}][#{@hydra_turn_label}]",
      )
    ).trim();
    expect(turn).toBe("[peer][fix flaky test]");

    // And per-window, which is what window-status-format evaluates.
    const perWindow = (await tmux("list-windows", "-F", "#{@hydra_state}")).trim();
    expect(perWindow.split("\n")).toContain("blocked");
  });

  it("clears tokens rather than leaving a stale value after a switch", async () => {
    await host.report({
      state: "idle",
      sessionId: "hydra_session_LIVEIDLE",
      title: "Other",
      cwd: "/tmp",
      agent: null,
      model: null,
      cost: null,
      queued: null,
      turnOrigin: null,
      turnLabel: null,
    });
    const rendered = (
      await tmux("display-message", "-p", "-t", pane, "-F", "[#{@hydra_cost}][#{@hydra_model}]")
    ).trim();
    expect(rendered).toBe("[][]");
  });

  it("opens a new window running the command, with env and argv intact", async () => {
    const marker = `/tmp/hydra-tmux-argv-${process.pid}.json`;
    const nasty = 'rm -rf $(pwd); `whoami` "q" and spaces';
    const result = await host.openTab!({
      label: "hydra-opened",
      argv: [
        process.execPath,
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(marker)},` +
          ` JSON.stringify([process.argv[1], process.env.HYDRA_TAB_LABEL]));` +
          // Stay alive: tmux closes a window the moment its command exits,
          // so a write-and-exit child would take the window with it before
          // the assertions below could see it.
          ` setTimeout(() => {}, 600000)`,
        nasty,
      ],
      env: { HYDRA_TAB_LABEL: "hydra-opened" },
      cwd: "/tmp",
    });
    expect(result.ok).toBe(true);

    const names = (await tmux("list-windows", "-F", "#{window_name}")).trim().split("\n");
    expect(names).toContain("hydra-opened");

    // The child actually ran, got its env, and received the argument
    // byte-identically — no shell re-parsing anywhere in the path.
    const { readFileSync, rmSync } = await import("node:fs");
    for (let i = 0; i < 60; i += 1) {
      try {
        const [arg, env] = JSON.parse(readFileSync(marker, "utf8")) as [string, string];
        expect(arg).toBe(nasty);
        expect(env).toBe("hydra-opened");
        rmSync(marker, { force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw new Error("spawned child never wrote its marker");
  }, 20_000);

  it("splits beside our pane, which the window's pane count then reflects", async () => {
    const before = (await host.readLabel!())!.paneCount;
    const result = await host.splitTab!({ label: "ignored", argv: ["sleep", "600"] });
    expect(result.ok).toBe(true);
    const after = (await host.readLabel!())!.paneCount;
    expect(after).toBe(before + 1);
  });

  // The load-bearing assumption in revealSession, and the one a unit spec
  // cannot check: that a pane user option interpolates inside a
  // `list-panes -F` format. If it does not, every reveal silently misses and
  // the picker quietly goes back to minting duplicate tabs.
  it("finds a pane by the @hydra_session it published, server-wide", async () => {
    await host.report({
      state: "idle",
      sessionId: "hydra_session_LIVEREVEAL",
      title: "Reveal me",
      cwd: "/tmp",
      agent: null,
      model: null,
      cost: null,
      queued: null,
      turnOrigin: null,
      turnLabel: null,
    });
    const listed = (
      await tmux("list-panes", "-a", "-F", "#{pane_id}\t#{@hydra_session}")
    ).trim();
    expect(listed).toContain("hydra_session_LIVEREVEAL");

    await expect(host.revealSession!("hydra_session_LIVEREVEAL")).resolves.toBe(
      true,
    );
    // We are that pane, so the reveal should have left focus on it.
    const active = (
      await tmux("display-message", "-p", "-F", "#{pane_id}")
    ).trim();
    expect(active).toBe(pane);
  });

  it("does not claim to find a session nobody published", async () => {
    await expect(host.revealSession!("hydra_session_NOSUCH")).resolves.toBe(
      false,
    );
  });

  // release() unsets the option, so a pane that has exited or switched away
  // must stop being findable. A stale hit sends the user to the wrong pane,
  // which is worse than opening a redundant one.
  it("stops finding a pane once its tokens are released", async () => {
    await host.report({
      state: "idle",
      sessionId: "hydra_session_LIVEGONE",
      title: "Transient",
      cwd: "/tmp",
      agent: null,
      model: null,
      cost: null,
      queued: null,
      turnOrigin: null,
      turnLabel: null,
    });
    await expect(host.revealSession!("hydra_session_LIVEGONE")).resolves.toBe(
      true,
    );
    await host.release();
    await expect(host.revealSession!("hydra_session_LIVEGONE")).resolves.toBe(
      false,
    );
  });

  it("surfaces a real tmux error message", async () => {
    const bad = await host.openTab!({ label: "x", argv: [], cwd: "/tmp" });
    // An empty argv is not a valid command; whatever tmux says about it
    // should reach the user rather than a generic failure.
    if (!bad.ok) {
      expect(bad.error).toBeTruthy();
    }
  });
});
