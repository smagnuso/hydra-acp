import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// net.connect can't be spied on in place (ESM namespace is
// non-configurable), so swap the module and route through a mutable hook.
interface Sent {
  id: string;
  method: string;
  params: Record<string, unknown>;
}
let sent: Sent[];
let connections: number;
let replyWith: string | null;
let connectThrows: Error | null;

function fakeSocket(): unknown {
  let onData: ((d: string) => void) | undefined;
  let onClose: (() => void) | undefined;
  const sock = {
    on(event: string, cb: (...a: unknown[]) => void) {
      if (event === "connect") {
        queueMicrotask(() => cb());
      } else if (event === "data") {
        onData = cb as (d: string) => void;
      } else if (event === "close") {
        onClose = cb as () => void;
      }
      return sock;
    },
    write(payload: string) {
      sent.push(JSON.parse(payload.trim()) as Sent);
      queueMicrotask(() => {
        if (replyWith === null) {
          onClose?.();
        } else {
          onData?.(replyWith);
        }
      });
    },
    setTimeout() {
      return sock;
    },
    destroy() {},
  };
  return sock;
}

vi.mock("node:net", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:net")>();
  return {
    ...orig,
    connect: (...args: unknown[]) => {
      void args;
      connections += 1;
      if (connectThrows) {
        throw connectThrows;
      }
      return fakeSocket();
    },
  };
});

import {
  canOpenInHerdrTab,
  labelForPrompt,
  openNewSessionInHerdrTab,
  openSessionInHerdrTab,
} from "./herdr-open.js";

beforeEach(() => {
  sent = [];
  connections = 0;
  connectThrows = null;
  replyWith = JSON.stringify({ id: "hydra-open", result: { type: "layout_applied" } });
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = "/tmp/fake-herdr.sock";
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.HERDR_WORKSPACE_ID = "w1";
});

afterEach(() => {
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_WORKSPACE_ID;
});

describe("canOpenInHerdrTab", () => {
  it("is true with the full env triple", () => {
    expect(canOpenInHerdrTab()).toBe(true);
  });

  it("is false outside herdr", () => {
    delete process.env.HERDR_ENV;
    expect(canOpenInHerdrTab()).toBe(false);
  });

  it("is false without a socket path", () => {
    delete process.env.HERDR_SOCKET_PATH;
    expect(canOpenInHerdrTab()).toBe(false);
  });

  // Unlike the reporter there is no init step to gate on, and the picker is
  // reachable from entry points that never start reporting — so this reads
  // the environment on every call rather than caching at import.
  it("reflects a later environment change without a reload", () => {
    expect(canOpenInHerdrTab()).toBe(true);
    delete process.env.HERDR_PANE_ID;
    expect(canOpenInHerdrTab()).toBe(false);
  });
});

describe("openSessionInHerdrTab", () => {
  it("refuses outside herdr without opening a socket", async () => {
    delete process.env.HERDR_ENV;
    const r = await openSessionInHerdrTab({ sessionId: "hydra_session_x" });
    expect(r.ok).toBe(false);
    expect(connections).toBe(0);
  });

  it("calls layout.apply", async () => {
    await openSessionInHerdrTab({ sessionId: "hydra_session_x" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("layout.apply");
  });

  // Omitting tab_id is what makes this a new tab. Passing the live tab_id
  // would replace that tab, and herdr's replacement path does not preserve
  // live PTYs — it would kill the hydra the user is sitting in.
  it("omits tab_id so the current tab is never replaced", async () => {
    await openSessionInHerdrTab({ sessionId: "hydra_session_x" });
    expect(sent[0]!.params.tab_id).toBeUndefined();
  });

  it("launches this build when argv[1] is hydra's entry point", async () => {
    const original = process.argv[1]!;
    process.argv[1] = "/opt/hydra/dist/cli.js";
    try {
      await openSessionInHerdrTab({ sessionId: "hydra_session_x" });
    } finally {
      process.argv[1] = original;
    }
    const root = sent[0]!.params.root as { command: string[] };
    expect(root.command).toEqual([
      process.execPath,
      "/opt/hydra/dist/cli.js",
      "tui",
      "--session",
      "hydra_session_x",
    ]);
  });

  it("accepts the installed bin names too", async () => {
    const original = process.argv[1]!;
    process.argv[1] = "/home/me/.local/bin/hydra";
    try {
      await openSessionInHerdrTab({ sessionId: "s" });
    } finally {
      process.argv[1] = original;
    }
    const root = sent[0]!.params.root as { command: string[] };
    expect(root.command[1]).toBe("/home/me/.local/bin/hydra");
  });

  // Regression, learned the hard way. Passing argv[1] through unvalidated
  // is correct only while the process really is hydra. Under any other host
  // — a test harness, a wrapper, an embedding program — "open hydra in a
  // tab" becomes "open my caller in a tab", and if the caller opens a tab
  // too, each new pane re-runs it. That produced ~97 tabs before it stopped.
  it("never relaunches a non-hydra entry point", async () => {
    const original = process.argv[1]!;
    process.argv[1] = "/tmp/some-harness.mjs";
    try {
      await openSessionInHerdrTab({ sessionId: "s" });
    } finally {
      process.argv[1] = original;
    }
    const root = sent[0]!.params.root as { command: string[] };
    expect(root.command).toEqual(["hydra", "tui", "--session", "s"]);
    expect(root.command.join(" ")).not.toContain("harness");
  });

  it("falls back to PATH when there is no entry point at all", async () => {
    const original = process.argv[1]!;
    // Simulate an embedded / REPL host with no script entry.
    process.argv.splice(1, 1);
    try {
      await openSessionInHerdrTab({ sessionId: "s" });
    } finally {
      process.argv.splice(1, 0, original);
    }
    expect((sent[0]!.params.root as { command: string[] }).command[0]).toBe("hydra");
  });

  it("labels the tab and pane with the session title", async () => {
    await openSessionInHerdrTab({ sessionId: "hydra_session_x", title: "refactor auth" });
    const p = sent[0]!.params;
    expect(p.tab_label).toBe("refactor auth");
    expect((p.root as { label: string }).label).toBe("refactor auth");
  });

  it("falls back to the session id when there is no title", async () => {
    await openSessionInHerdrTab({ sessionId: "hydra_session_x", title: "   " });
    expect(sent[0]!.params.tab_label).toBe("hydra_session_x");
  });

  it("passes the session cwd so the pane starts in the right place", async () => {
    await openSessionInHerdrTab({ sessionId: "s", cwd: "/home/me/dev/proj" });
    expect((sent[0]!.params.root as { cwd?: string }).cwd).toBe("/home/me/dev/proj");
  });

  // herdr validates absolute + is_dir and rejects the whole call rather
  // than ignoring a bad cwd, so a relative one must not be sent at all.
  it("omits a relative cwd rather than having herdr reject the call", async () => {
    await openSessionInHerdrTab({ sessionId: "s", cwd: "relative/dir" });
    expect((sent[0]!.params.root as { cwd?: string }).cwd).toBeUndefined();
  });

  it("scopes the tab to this pane's workspace", async () => {
    await openSessionInHerdrTab({ sessionId: "s" });
    expect(sent[0]!.params.workspace_id).toBe("w1");
  });

  it("lets herdr choose the workspace when it did not tell us one", async () => {
    delete process.env.HERDR_WORKSPACE_ID;
    await openSessionInHerdrTab({ sessionId: "s" });
    expect(sent[0]!.params.workspace_id).toBeUndefined();
  });

  it("focuses the new tab", async () => {
    await openSessionInHerdrTab({ sessionId: "s" });
    expect(sent[0]!.params.focus).toBe(true);
  });

  it("uses exactly one connection, since herdr serves one request per socket", async () => {
    await openSessionInHerdrTab({ sessionId: "s" });
    expect(connections).toBe(1);
  });

  it("surfaces a herdr error body", async () => {
    replyWith = JSON.stringify({
      id: "hydra-open",
      error: { code: "invalid_params", message: "workspace not found" },
    });
    const r = await openSessionInHerdrTab({ sessionId: "s" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("workspace not found");
  });

  it("surfaces a closed connection as a failure rather than a false success", async () => {
    replyWith = null;
    const r = await openSessionInHerdrTab({ sessionId: "s" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/closed/);
  });

  it("surfaces a connect failure", async () => {
    connectThrows = new Error("ECONNREFUSED");
    const r = await openSessionInHerdrTab({ sessionId: "s" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("ECONNREFUSED");
  });
});

describe("openNewSessionInHerdrTab", () => {
  function argv(): string[] {
    return (sent[0]?.params.root as { command: string[] }).command;
  }

  it("passes --new so the new pane doesn't re-enter the picker", async () => {
    const r = await openNewSessionInHerdrTab({});
    expect(r.ok).toBe(true);
    expect(argv()).toContain("--new");
    expect(argv()).not.toContain("--session");
  });

  it("forwards the composer's cwd, agent and model", async () => {
    await openNewSessionInHerdrTab({ cwd: "/tmp", agentId: "claude", model: "opus" });
    const a = argv();
    expect(a.slice(a.indexOf("tui"))).toEqual([
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
    await openNewSessionInHerdrTab({ cwd: "/tmp" });
    const a = argv();
    expect(a).not.toContain("--agent");
    expect(a).not.toContain("--model");
  });

  it("also sets the pane cwd, so a split off it starts in the right place", async () => {
    await openNewSessionInHerdrTab({ cwd: "/tmp" });
    expect((sent[0]?.params.root as { cwd?: string }).cwd).toBe("/tmp");
  });

  it("drops a relative cwd from the pane rather than letting herdr reject the call", async () => {
    await openNewSessionInHerdrTab({ cwd: "relative/path" });
    expect((sent[0]?.params.root as { cwd?: string }).cwd).toBeUndefined();
  });

  it("creates a new tab rather than replacing the current one", async () => {
    await openNewSessionInHerdrTab({});
    expect(sent[0]?.params.tab_id).toBeUndefined();
    expect(sent[0]?.method).toBe("layout.apply");
  });

  it("is inert outside herdr", async () => {
    delete process.env.HERDR_ENV;
    const r = await openNewSessionInHerdrTab({});
    expect(r.ok).toBe(false);
    expect(connections).toBe(0);
  });

  it("surfaces a herdr error body", async () => {
    replyWith = JSON.stringify({ id: "hydra-open", error: { code: "invalid_params" } });
    const r = await openNewSessionInHerdrTab({});
    expect(r.ok).toBe(false);
    expect(r.error).toBe("invalid_params");
  });
});

describe("openNewSessionInHerdrTab prompt forwarding", () => {
  function argv(): string[] {
    return (sent[0]?.params.root as { command: string[] }).command;
  }
  function label(): string {
    return sent[0]?.params.tab_label as string;
  }

  it("sends the composer text as --prompt, last in the argv", async () => {
    await openNewSessionInHerdrTab({ prompt: "fix the parser" });
    const a = argv();
    expect(a.slice(-2)).toEqual(["--prompt", "fix the parser"]);
  });

  it("passes text through verbatim — herdr runs argv with no shell", async () => {
    const nasty = 'rm -rf $(pwd); `whoami` "quoted" \'single\'\nsecond line';
    await openNewSessionInHerdrTab({ prompt: nasty });
    expect(argv().slice(-1)).toEqual([nasty]);
  });

  it("omits --prompt for empty or whitespace-only text", async () => {
    await openNewSessionInHerdrTab({ prompt: "   \n  " });
    expect(argv()).not.toContain("--prompt");
  });

  it("labels the tab with the prompt's first line", async () => {
    await openNewSessionInHerdrTab({ prompt: "fix the parser\nand the lexer" });
    expect(label()).toBe("fix the parser");
  });

  it("falls back to a generic label with no prompt", async () => {
    await openNewSessionInHerdrTab({});
    expect(label()).toBe("new session");
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
