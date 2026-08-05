import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the argv handed to tmux. The unit specs assert on the command line
// because that IS the protocol here — there's no socket frame to inspect, and
// a wrong flag is exactly the kind of bug that silently targets the wrong
// pane. The live suite at the bottom then checks those command lines actually
// do what we think against a real server.
interface Invocation {
  args: string[];
}
let calls: Invocation[];
let stdoutFor: (args: string[]) => string;
let failWith: (Error & { stderr?: string }) | null;

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return {
    ...orig,
    execFile: (
      _file: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void,
    ) => {
      calls.push({ args });
      if (failWith) {
        cb(failWith);
        return;
      }
      cb(null, { stdout: stdoutFor(args), stderr: "" });
    },
  };
});

import { __resetTerminalHostForTests, initTerminalHost, terminalHost } from "./index.js";
import { tmuxCandidate } from "./tmux.js";
import type { TerminalHost, TerminalHostSnapshot } from "./types.js";

const SOCK = "/tmp/tmux-1000/default";

function host(): TerminalHost {
  const h = terminalHost();
  if (!h) {
    throw new Error("no host resolved");
  }
  return h;
}

/** The argv of the nth tmux invocation, minus the `-S <socket>` prefix. */
function argv(n = 0): string[] {
  return (calls[n]?.args ?? []).slice(2);
}

function snapshot(over: Partial<TerminalHostSnapshot> = {}): TerminalHostSnapshot {
  return {
    state: "working",
    title: "Refactor auth",
    cwd: "/home/me/dev/proj",
    agent: "claude-code",
    model: "opus",
    cost: "$1.23",
    queued: 2,
    ...over,
  };
}

beforeEach(() => {
  calls = [];
  failWith = null;
  stdoutFor = (args) => {
    if (args.includes("#{session_id}")) {
      return "$0\n";
    }
    return "zsh\t1\t1\n";
  };
  process.env.TMUX = `${SOCK},12345,0`;
  process.env.TMUX_PANE = "%3";
  __resetTerminalHostForTests();
  initTerminalHost();
});

afterEach(() => {
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  __resetTerminalHostForTests();
});

describe("detection", () => {
  it("needs both the server handle and the pane id", () => {
    expect(tmuxCandidate.detect({ TMUX: `${SOCK},1,0`, TMUX_PANE: "%3" })).toBe(true);
    expect(tmuxCandidate.detect({ TMUX: `${SOCK},1,0` })).toBe(false);
    expect(tmuxCandidate.detect({ TMUX_PANE: "%3" })).toBe(false);
    expect(tmuxCandidate.detect({})).toBe(false);
  });

  it("declares only the pane id as pane-scoped, not the server handle", () => {
    // TMUX carries the socket path, which stays valid as long as the server
    // runs; TMUX_PANE is the identity that must not outlive the pane.
    expect(tmuxCandidate.paneScopedEnv).toEqual(["TMUX_PANE"]);
  });

  it("loses to herdr when both are present, since herdr is the inner host", () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_SOCKET_PATH = "/run/h.sock";
    process.env.HERDR_PANE_ID = "w1:p1";
    try {
      __resetTerminalHostForTests();
      expect(initTerminalHost()?.id).toBe("herdr");
    } finally {
      delete process.env.HERDR_ENV;
      delete process.env.HERDR_SOCKET_PATH;
      delete process.env.HERDR_PANE_ID;
    }
  });
});

describe("targeting", () => {
  it("passes the server socket from $TMUX rather than relying on inheritance", () => {
    // So we keep talking to the right server even from an environment that
    // has been through the pane-scoped scrub.
    void host().report(snapshot());
    expect(calls[0]?.args.slice(0, 2)).toEqual(["-S", SOCK]);
  });

  it("targets our own pane, never the client's current one", async () => {
    // With no -t, tmux acts on whatever the user is looking at — a
    // background hydra would then report onto someone else's pane.
    await host().report(snapshot());
    const a = argv();
    // Every set-option in the chain carries the target, not just the first.
    const targets = a.filter((_, i) => a[i - 1] === "-t");
    expect(targets).toHaveLength(7);
    expect(new Set(targets)).toEqual(new Set(["%3"]));
  });

  it("resolves the session for window-scoped commands", async () => {
    // `new-window -t %3` fails outright with "can't specify pane here", so
    // the pane id has to be turned into a session id first.
    await host().openTab!({ label: "x", argv: ["hydra"] });
    expect(argv(0)).toEqual([
      "display-message", "-p", "-t", "%3", "-F", "#{session_id}",
    ]);
    expect(argv(1)).toContain("new-window");
    expect(argv(1)).toContain("$0");
  });

  it("resolves the session once and caches it", async () => {
    await host().openTab!({ label: "a", argv: ["hydra"] });
    await host().openTab!({ label: "b", argv: ["hydra"] });
    const lookups = calls.filter((c) => c.args.includes("#{session_id}"));
    expect(lookups).toHaveLength(1);
  });
});

describe("openTab", () => {
  it("names the window and passes argv verbatim", async () => {
    await host().openTab!({
      label: "Refactor auth",
      argv: ["node", "/x/cli.js", "tui", "--prompt", "rm -rf $(pwd) `whoami`"],
    });
    const a = argv(1);
    expect(a.slice(0, 5)).toEqual(["new-window", "-t", "$0", "-n", "Refactor auth"]);
    // tmux execs multiple arguments directly instead of re-parsing through a
    // shell, so shell metacharacters need no escaping and must survive whole.
    expect(a.slice(-1)).toEqual(["rm -rf $(pwd) `whoami`"]);
  });

  it("passes env through as -e pairs", async () => {
    await host().openTab!({
      label: "x",
      argv: ["hydra"],
      env: { HYDRA_TAB_LABEL: "x" },
    });
    const a = argv(1);
    expect(a[a.indexOf("-e") + 1]).toBe("HYDRA_TAB_LABEL=x");
  });

  it("passes an absolute cwd", async () => {
    await host().openTab!({ label: "x", argv: ["hydra"], cwd: "/home/me" });
    expect(argv(1)[argv(1).indexOf("-c") + 1]).toBe("/home/me");
  });

  it("drops a relative cwd, which tmux would otherwise silently accept", async () => {
    // Unlike herdr, which rejects the whole call, tmux takes a relative path
    // and resolves it against a directory we can't predict from here.
    await host().openTab!({ label: "x", argv: ["hydra"], cwd: "relative/dir" });
    expect(argv(1)).not.toContain("-c");
  });

  it("surfaces tmux's stderr as the error", async () => {
    failWith = Object.assign(new Error("exit 1"), { stderr: "can't find session\n" });
    const r = await host().openTab!({ label: "x", argv: ["hydra"] });
    expect(r).toEqual({ ok: false, error: "can't find session" });
  });
});

describe("splitTab", () => {
  it("splits beside our pane, targeting the pane directly", async () => {
    // The first host that can do this at all — herdr forced the capability
    // to exist and then had to decline it.
    await host().splitTab!({ label: "x", argv: ["hydra"] });
    expect(argv(0).slice(0, 4)).toEqual(["split-window", "-h", "-t", "%3"]);
  });

  it("needs no session lookup, since a pane target is valid here", async () => {
    await host().splitTab!({ label: "x", argv: ["hydra"] });
    expect(calls.some((c) => c.args.includes("#{session_id}"))).toBe(false);
  });

  it("does not rename the window", async () => {
    // The label belongs to the window, and the window is about to hold two
    // sessions. The pane-count guard in label-sync would refuse anyway.
    await host().splitTab!({ label: "Refactor auth", argv: ["hydra"] });
    expect(argv(0)).not.toContain("-n");
  });

  it("advertises the capability", () => {
    expect(host().caps.split).toBe(true);
  });
});

describe("report", () => {
  it("writes the whole token set in a single invocation", async () => {
    // Seven spawns per report would be absurd at the banner funnel's 1Hz.
    await host().report(snapshot());
    expect(calls).toHaveLength(1);
    const a = argv();
    expect(a.filter((x) => x === ";")).toHaveLength(6);
    expect(a.filter((x) => x === "set-option")).toHaveLength(7);
  });

  it("sets semantic words, not glyphs", async () => {
    // tmux format strings can branch on these, so the user picks the icon
    // and the colour. Shipping a glyph would bake in a font assumption.
    await host().report(snapshot({ state: "blocked" }));
    const a = argv();
    expect(a[a.indexOf("@hydra_state") + 1]).toBe("blocked");
  });

  it("carries every semantic field", async () => {
    await host().report(snapshot());
    const a = argv();
    const val = (k: string): string | undefined => a[a.indexOf(k) + 1];
    expect(val("@hydra_title")).toBe("Refactor auth");
    expect(val("@hydra_agent")).toBe("claude-code");
    expect(val("@hydra_model")).toBe("opus");
    expect(val("@hydra_cost")).toBe("$1.23");
    expect(val("@hydra_queue")).toBe("2");
    expect(val("@hydra_cwd")).toBe("/home/me/dev/proj");
  });

  it("unsets absent values rather than omitting the key", async () => {
    // Omitting would leave the previous session's value on the pane after a
    // switch, silently misattributed.
    await host().report(snapshot({ model: null, cost: null, queued: null }));
    const a = argv().join(" ");
    expect(a).toContain("-u @hydra_model");
    expect(a).toContain("-u @hydra_cost");
    expect(a).toContain("-u @hydra_queue");
  });

  it("treats a zero queue as nothing queued", async () => {
    await host().report(snapshot({ queued: 0 }));
    expect(argv().join(" ")).toContain("-u @hydra_queue");
  });

  it("does not respawn tmux for an unchanged token set", async () => {
    await host().report(snapshot());
    await host().report(snapshot());
    expect(calls).toHaveLength(1);
  });

  it("re-sends after a failure rather than believing tmux knows", async () => {
    failWith = Object.assign(new Error("server gone"), { stderr: "no server" });
    await expect(host().report(snapshot())).rejects.toThrow();
    failWith = null;
    calls = [];
    await host().report(snapshot());
    expect(calls).toHaveLength(1);
  });

  it("clears every token on release", async () => {
    await host().report(snapshot());
    calls = [];
    await host().release();
    expect(argv().filter((x) => x === "-u")).toHaveLength(7);
  });

  it("does not clear on release when nothing was ever reported", async () => {
    await host().release();
    expect(calls).toEqual([]);
  });
});

describe("label", () => {
  it("reads name, pane count and the automatic-rename flag in one call", async () => {
    stdoutFor = () => "zsh\t1\t1\n";
    const view = await host().readLabel!();
    expect(view).toEqual({ label: "zsh", paneCount: 1, auto: true });
  });

  it("reports a manually named window as not auto", async () => {
    // tmux tracks this as a FACT — no string heuristic needed, unlike hosts
    // that can only infer from the name.
    stdoutFor = () => "my work\t1\t0\n";
    expect((await host().readLabel!())?.auto).toBe(false);
  });

  it("surfaces the pane count so a split window is left alone", async () => {
    stdoutFor = () => "zsh\t2\t1\n";
    expect((await host().readLabel!())?.paneCount).toBe(2);
  });

  it("returns null rather than guessing when the read is malformed", async () => {
    stdoutFor = () => "garbage\n";
    expect(await host().readLabel!()).toBeNull();
  });

  it("returns null when tmux fails", async () => {
    failWith = Object.assign(new Error("exit 1"), { stderr: "no server" });
    expect(await host().readLabel!()).toBeNull();
  });

  it("renames the window by targeting our pane", async () => {
    expect(await host().writeLabel!("Refactor auth")).toBe(true);
    expect(argv()).toEqual(["rename-window", "-t", "%3", "Refactor auth"]);
  });

  it("reports a failed rename rather than throwing", async () => {
    failWith = Object.assign(new Error("exit 1"), { stderr: "no such window" });
    expect(await host().writeLabel!("x")).toBe(false);
  });

  it("answers isAutoLabel conservatively, since readLabel is authoritative", () => {
    // tmux's generated names are just the running command ("zsh", "node"),
    // indistinguishable from names a person might type — so any string
    // heuristic here would eventually overwrite a deliberate choice.
    expect(host().isAutoLabel!("zsh")).toBe(false);
    expect(host().isAutoLabel!("1")).toBe(false);
  });
});
