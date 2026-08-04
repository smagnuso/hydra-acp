import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTerminalHost, __resetTerminalHostForTests } from "./index.js";
import { canOpenTab, labelForPrompt, openInNewTab } from "./open.js";
import type { OpenTabResult, OpenTabSpec, TerminalHost } from "./types.js";

// A fake host, not a fake socket. Everything in open.ts is
// backend-independent — which hydra binary to relaunch, what argv to build,
// what to call the tab, and handing the child its ownership marker — so the
// assertions are about the OpenTabSpec handed to the adapter. How a spec
// reaches a particular host is that adapter's spec, not this one.
let specs: OpenTabSpec[];
let result: OpenTabResult;
let openThrows: Error | null;
let caps: TerminalHost["caps"];
let hasOpenTab: boolean;

function fakeHost(): TerminalHost {
  const host: TerminalHost = {
    id: "fake",
    get caps() {
      return caps;
    },
    report: () => Promise.resolve(),
    release: () => Promise.resolve(),
  };
  if (hasOpenTab) {
    host.openTab = (spec) => {
      specs.push(spec);
      return openThrows ? Promise.reject(openThrows) : Promise.resolve(result);
    };
  }
  return host;
}

function install(): void {
  setTerminalHost(fakeHost());
}

function only(): OpenTabSpec {
  expect(specs).toHaveLength(1);
  return specs[0] as OpenTabSpec;
}

/** argv from `tui` onwards — the part that isn't node/entry-point plumbing. */
function tuiArgs(): string[] {
  const argv = only().argv;
  return argv.slice(argv.indexOf("tui"));
}

beforeEach(() => {
  specs = [];
  result = { ok: true };
  openThrows = null;
  caps = { openTab: true, split: false, label: true, report: true };
  hasOpenTab = true;
  __resetTerminalHostForTests();
  install();
});

afterEach(() => {
  __resetTerminalHostForTests();
});

describe("canOpenTab", () => {
  it("is true when the host advertises and implements openTab", () => {
    expect(canOpenTab()).toBe(true);
  });

  it("is false with no host", () => {
    setTerminalHost(null);
    expect(canOpenTab()).toBe(false);
  });

  it("is false when the host does not advertise the capability", () => {
    caps = { ...caps, openTab: false };
    expect(canOpenTab()).toBe(false);
  });

  it("is false when the capability is advertised but the method is missing", () => {
    // Belt and braces: caps is the contract, but a hand-written or
    // user-supplied adapter can get it wrong, and this gates a keybinding.
    hasOpenTab = false;
    install();
    expect(canOpenTab()).toBe(false);
  });
});

describe("which hydra gets relaunched", () => {
  const realArgv1 = process.argv[1];

  afterEach(() => {
    if (realArgv1 === undefined) {
      delete process.argv[1];
    } else {
      process.argv[1] = realArgv1;
    }
  });

  it("launches this build when argv[1] is hydra's entry point", async () => {
    // Matters on a linked or checked-out dev build, where PATH `hydra` can be
    // a different version from the one the user is sitting in.
    process.argv[1] = "/home/me/dev/hydra-acp/cli/dist/cli.js";
    await openInNewTab({ kind: "attach", sessionId: "s" });
    expect(only().argv.slice(0, 2)).toEqual([
      process.execPath,
      "/home/me/dev/hydra-acp/cli/dist/cli.js",
    ]);
  });

  it("accepts the installed bin names too", async () => {
    for (const bin of ["/usr/local/bin/hydra", "/usr/local/bin/hydra-acp"]) {
      specs = [];
      process.argv[1] = bin;
      await openInNewTab({ kind: "attach", sessionId: "s" });
      expect(only().argv[1]).toBe(bin);
    }
  });

  it("never relaunches a non-hydra entry point", async () => {
    // Load-bearing, not paranoia: an unvalidated argv[1] turns "launch hydra
    // in a new tab" into "launch whatever started me in a new tab". If that
    // thing also opens a tab, it self-replicates — verified the hard way at
    // ~97 tabs.
    process.argv[1] = "/usr/lib/node_modules/npm/bin/npm-cli.js";
    await openInNewTab({ kind: "attach", sessionId: "s" });
    expect(only().argv).toEqual(["hydra", "tui", "--session", "s"]);
  });

  it("falls back to PATH when there is no entry point at all", async () => {
    delete process.argv[1];
    await openInNewTab({ kind: "attach", sessionId: "s" });
    expect(only().argv[0]).toBe("hydra");
  });

  it("names the tui verb explicitly rather than relying on the bare-verb default", async () => {
    await openInNewTab({ kind: "attach", sessionId: "s" });
    expect(tuiArgs()[0]).toBe("tui");
  });
});

describe("attaching an existing session", () => {
  it("passes the session id", async () => {
    await openInNewTab({ kind: "attach", sessionId: "hydra_session_abc" });
    expect(tuiArgs()).toEqual(["tui", "--session", "hydra_session_abc"]);
  });

  it("labels the tab with the session title", async () => {
    await openInNewTab({
      kind: "attach",
      sessionId: "hydra_session_abc",
      title: "refactor auth",
    });
    expect(only().label).toBe("refactor auth");
  });

  it("falls back to the session id when there is no title", async () => {
    await openInNewTab({ kind: "attach", sessionId: "hydra_session_abc" });
    expect(only().label).toBe("hydra_session_abc");
  });

  it("falls back to the session id when the title is only whitespace", async () => {
    await openInNewTab({ kind: "attach", sessionId: "abc", title: "   " });
    expect(only().label).toBe("abc");
  });

  it("passes the session cwd so the pane starts in the right place", async () => {
    await openInNewTab({ kind: "attach", sessionId: "s", cwd: "/home/me/proj" });
    expect(only().cwd).toBe("/home/me/proj");
  });
});

describe("starting a new session", () => {
  it("passes --new so the new pane doesn't re-enter the picker", async () => {
    await openInNewTab({ kind: "new" });
    expect(tuiArgs()).toContain("--new");
    expect(tuiArgs()).not.toContain("--session");
  });

  it("forwards the composer's cwd, agent and model", async () => {
    await openInNewTab({
      kind: "new",
      cwd: "/tmp",
      agentId: "claude",
      model: "opus",
    });
    expect(tuiArgs()).toEqual([
      "tui",
      "--new",
      "--cwd",
      "/tmp",
      "--agent",
      "claude",
      "--model",
      "opus",
    ]);
  });

  it("omits flags the composer hasn't set", async () => {
    await openInNewTab({ kind: "new", cwd: "/tmp" });
    expect(tuiArgs()).not.toContain("--agent");
    expect(tuiArgs()).not.toContain("--model");
  });

  it("sets the pane cwd as well as --cwd", async () => {
    // Different jobs: the pane cwd is where the host spawns (and what a split
    // off it inherits), --cwd is what hydra records on the session.
    await openInNewTab({ kind: "new", cwd: "/tmp" });
    expect(only().cwd).toBe("/tmp");
    expect(tuiArgs()).toContain("--cwd");
  });

  it("labels the tab generically when there is no prompt", async () => {
    await openInNewTab({ kind: "new" });
    expect(only().label).toBe("new session");
  });
});

describe("prompt forwarding", () => {
  it("sends the composer text as --prompt, last in the argv", async () => {
    await openInNewTab({ kind: "new", prompt: "fix the parser" });
    // Last so a long free-text argument doesn't sit between flag pairs in a
    // `ps` listing.
    expect(only().argv.slice(-2)).toEqual(["--prompt", "fix the parser"]);
  });

  it("passes text through verbatim — argv is launched with no shell", async () => {
    const nasty = 'rm -rf $(pwd); `whoami` "quoted" \'single\'\nsecond line';
    await openInNewTab({ kind: "new", prompt: nasty });
    expect(only().argv.slice(-1)).toEqual([nasty]);
  });

  it("omits --prompt for empty or whitespace-only text", async () => {
    await openInNewTab({ kind: "new", prompt: "   \n  " });
    expect(tuiArgs()).not.toContain("--prompt");
  });

  it("labels the tab with the prompt's first line", async () => {
    await openInNewTab({ kind: "new", prompt: "fix the parser\nand the lexer" });
    expect(only().label).toBe("fix the parser");
  });
});

describe("tab-label ownership hand-off", () => {
  it("tells the child which label it owns", async () => {
    // Without this the label guard misfires exactly where the feature matters
    // most: the tab comes up already named after the session, and the hydra
    // in it — a different process, with no memory of the call that named it —
    // concludes a human named the tab and leaves it alone forever.
    await openInNewTab({ kind: "attach", sessionId: "s", title: "refactor auth" });
    expect(only().env).toEqual({ HYDRA_TAB_LABEL: "refactor auth" });
  });

  it("hands over exactly the label it asked the host to set", async () => {
    // Ownership is proven by matching, so a mismatch here would silently
    // disable label sync in every ^t tab.
    await openInNewTab({ kind: "new", prompt: "fix the parser" });
    expect(only().env?.HYDRA_TAB_LABEL).toBe(only().label);
  });
});

describe("failure handling", () => {
  it("refuses with no host, without calling any adapter", async () => {
    setTerminalHost(null);
    const r = await openInNewTab({ kind: "attach", sessionId: "s" });
    expect(r.ok).toBe(false);
    expect(specs).toEqual([]);
  });

  it("refuses when the host cannot open tabs", async () => {
    caps = { ...caps, openTab: false };
    const r = await openInNewTab({ kind: "attach", sessionId: "s" });
    expect(r.ok).toBe(false);
    expect(specs).toEqual([]);
  });

  it("passes a host's own failure through unchanged", async () => {
    result = { ok: false, error: "workspace not found" };
    const r = await openInNewTab({ kind: "attach", sessionId: "s" });
    expect(r).toEqual({ ok: false, error: "workspace not found" });
  });

  it("turns a thrown adapter error into a failed result rather than a rejection", async () => {
    // The caller is a keystroke handler; an unhandled rejection here would
    // surface as a crash instead of a status line.
    openThrows = new Error("ECONNREFUSED");
    const r = await openInNewTab({ kind: "attach", sessionId: "s" });
    expect(r).toEqual({ ok: false, error: "ECONNREFUSED" });
  });
});

describe("labelForPrompt", () => {
  it("keeps a short single line as-is", () => {
    expect(labelForPrompt("fix it")).toBe("fix it");
  });

  it("takes only the first line, so no newline reaches the tab bar", () => {
    expect(labelForPrompt("first\nsecond")).toBe("first");
    expect(labelForPrompt("\n\nsecond")).toBe("new session");
  });

  it("truncates a long line with an ellipsis", () => {
    const out = labelForPrompt("x".repeat(200));
    expect(out).toHaveLength(40);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back for empty input", () => {
    expect(labelForPrompt(undefined)).toBe("new session");
    expect(labelForPrompt("  ")).toBe("new session");
  });
});
