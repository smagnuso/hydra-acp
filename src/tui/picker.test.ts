import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "terminal-kit";
import {
  createPickerPrefs,
  filterByHost,
  matchesSearch,
  nextHostFilter,
  pickSession,
  sortSessions,
  type PickerPrefs,
  type PickerResult,
} from "./picker.js";
import type { DiscoveredSession } from "./discovery.js";
import type { HydraConfig } from "../core/config.js";
import type { RemoteTarget } from "../core/remote-target.js";

function session(overrides: Partial<DiscoveredSession>): DiscoveredSession {
  return {
    sessionId: "hydra-abc123",
    cwd: "/home/me/work/project",
    updatedAt: "2026-05-14T10:00:00Z",
    attachedClients: 0,
    status: "cold",
    // Default to interactive so the picker's interactive-only filter
    // doesn't silently hide every test fixture. Tests that exercise
    // non-interactive filtering can override.
    interactive: true,
    ...overrides,
  };
}

// Test harness for pickSession: a fake terminal-kit Terminal that
// captures the registered key handler so the test can drive synthetic
// keystrokes. The chain-and-call Proxy mirrors screen.test.ts — terminal-
// kit lets you write `term.brightWhite.bgBlue.noFormat("x")` so every
// property access has to be both callable and chainable.
interface KeyDriver {
  press(name: string, opts?: { isCharacter?: boolean }): void;
  type(text: string): void;
  // Simulate a bracketed-paste by sending the start/end markers + text
  // through the raw stdin handler that pickSession installs.
  paste(text: string): void;
  resolveOnce: Promise<PickerResult>;
}

function makePicker(opts: {
  sessions: DiscoveredSession[];
  cwd?: string;
  currentSessionId?: string;
  prefs?: PickerPrefs;
  target?: RemoteTarget;
}): KeyDriver {
  let onKey: ((name: string, _matches: unknown, data?: { isCharacter?: boolean }) => void) | null = null;
  // Fake stdin: captures whatever rawStdinHandler is registered via
  // removeListener / on so the bracketed-paste interceptor can install
  // itself and we can drive it from the test.
  let stdinDataHandler: ((chunk: Buffer) => void) | null = null;
  const fakeTkStdin = {
    removeListener(_event: string, _cb: (chunk: Buffer) => void): void {
      // terminal-kit's own handler; we don't need to do anything with it
      // in tests since we just want to capture the replacement handler.
    },
    on(_event: string, cb: (chunk: Buffer) => void): void {
      stdinDataHandler = cb;
    },
  };

  const handler: ProxyHandler<(...args: unknown[]) => unknown> = {
    apply: () => term,
    get(_target, prop) {
      if (prop === "width") return 80;
      if (prop === "height") return 24;
      if (prop === "stdin") return fakeTkStdin;
      if (prop === "onStdin") return (): void => undefined;
      if (prop === "on") {
        return (event: string, cb: typeof onKey): void => {
          if (event === "key") {
            onKey = cb;
          }
        };
      }
      if (prop === "off") {
        return (): void => undefined;
      }
      return new Proxy(() => term, handler);
    },
  };
  const term = new Proxy(
    function noop() {} as (...args: unknown[]) => unknown,
    handler,
  ) as unknown as Terminal;

  const config = {
    tui: { cwdColumnMaxWidth: 40 },
  } as unknown as HydraConfig;
  const target = opts.target ?? ({} as RemoteTarget);

  const resolveOnce = pickSession(term, {
    cwd: opts.cwd ?? "/home/me/work/project",
    sessions: opts.sessions,
    config,
    target,
    ...(opts.currentSessionId !== undefined
      ? { currentSessionId: opts.currentSessionId }
      : {}),
    ...(opts.prefs !== undefined ? { prefs: opts.prefs } : {}),
  });

  return {
    press(name, optsArg = {}) {
      if (!onKey) {
        throw new Error("onKey not registered yet");
      }
      onKey(name, undefined, optsArg);
    },
    type(text) {
      if (!onKey) {
        throw new Error("onKey not registered yet");
      }
      for (const ch of text) {
        onKey(ch, undefined, { isCharacter: true });
      }
    },
    paste(text) {
      if (!stdinDataHandler) {
        throw new Error("stdin handler not installed yet");
      }
      // Send as a single chunk exactly as a terminal would for a paste.
      const payload = `\x1b[200~${text}\x1b[201~`;
      stdinDataHandler(Buffer.from(payload, "binary"));
    },
    resolveOnce,
  };
}

describe("matchesSearch", () => {
  it("returns true for empty term (no filter)", () => {
    expect(matchesSearch(session({}), "")).toBe(true);
  });

  it("matches the short session id case-insensitively", () => {
    const s = session({ sessionId: "hydra-ABC123" });
    expect(matchesSearch(s, "abc")).toBe(true);
    expect(matchesSearch(s, "AbC1")).toBe(true);
    expect(matchesSearch(s, "xyz")).toBe(false);
  });

  it("matches the agent id", () => {
    const s = session({ agentId: "claude-code" });
    expect(matchesSearch(s, "claude")).toBe(true);
    expect(matchesSearch(s, "CODE")).toBe(true);
  });

  it("matches the title", () => {
    const s = session({ title: "Refactor auth flow" });
    expect(matchesSearch(s, "auth")).toBe(true);
    expect(matchesSearch(s, "AUTH")).toBe(true);
  });

  it("matches the upstream session id", () => {
    const s = session({ upstreamSessionId: "session_abc_456" });
    expect(matchesSearch(s, "session_abc")).toBe(true);
  });

  it("matches the raw cwd path", () => {
    const s = session({ cwd: "/home/me/work/hydra-acp/cli" });
    expect(matchesSearch(s, "hydra-acp")).toBe(true);
    expect(matchesSearch(s, "CLI")).toBe(true);
  });

  it("matches the home-shortened cwd (tilde form)", () => {
    const home = process.env.HOME ?? "";
    if (home.length === 0) {
      return;
    }
    const s = session({ cwd: `${home}/projects/foo` });
    expect(matchesSearch(s, "~/projects")).toBe(true);
  });

  it("does not match unrelated terms", () => {
    const s = session({
      sessionId: "hydra-abc123",
      agentId: "claude",
      cwd: "/home/me/work",
      title: "thing",
    });
    expect(matchesSearch(s, "nothing-matches-here")).toBe(false);
  });
});

describe("nextHostFilter", () => {
  const sessions = [
    { importedFromMachine: undefined },
    { importedFromMachine: "machine-b" },
    { importedFromMachine: "machine-a" },
    { importedFromMachine: "machine-b" },
  ];

  it("cycles local → first peer → next peer → all → local", () => {
    expect(nextHostFilter("__local", sessions)).toBe("machine-a");
    expect(nextHostFilter("machine-a", sessions)).toBe("machine-b");
    expect(nextHostFilter("machine-b", sessions)).toBe("__all");
    expect(nextHostFilter("__all", sessions)).toBe("__local");
  });

  it("collapses to local → all → local when there are no peers", () => {
    const onlyLocal = [{ importedFromMachine: undefined }];
    expect(nextHostFilter("__local", onlyLocal)).toBe("__all");
    expect(nextHostFilter("__all", onlyLocal)).toBe("__local");
  });

  it("resets to local when the current value no longer appears", () => {
    // Mimics the post-refresh case where a peer host vanished from
    // allSessions while its hostname was selected.
    const drained = [{ importedFromMachine: "machine-a" }];
    expect(nextHostFilter("machine-z", drained)).toBe("__local");
  });

  it("drops peer hosts whose imports have all been bound to a local agent", () => {
    // machine-b's only session has been attached locally, so its
    // host bucket would be empty — skip it in the cycle.
    const mixed = [
      { importedFromMachine: "machine-a" },
      { importedFromMachine: "machine-b", upstreamSessionId: "u_abc" },
    ];
    expect(nextHostFilter("__local", mixed)).toBe("machine-a");
    expect(nextHostFilter("machine-a", mixed)).toBe("__all");
  });
});

describe("filterByHost", () => {
  // session() returns a DiscoveredSession-shaped fixture with only the
  // fields filterByHost reads — the rest of the type is bypassed via
  // the cast.
  const session = (
    overrides: Partial<DiscoveredSession>,
  ): DiscoveredSession =>
    ({
      sessionId: "hydra-abc",
      cwd: "/w",
      updatedAt: "2026-05-20T00:00:00Z",
      attachedClients: 0,
      status: "cold",
      ...overrides,
    }) as DiscoveredSession;

  it("__local: includes locally-created sessions", () => {
    const s = session({});
    expect(filterByHost([s], "__local")).toEqual([s]);
  });

  it("__local: includes imports that have been bound to a local agent", () => {
    const s = session({
      importedFromMachine: "broom",
      upstreamSessionId: "u_local",
    });
    expect(filterByHost([s], "__local")).toEqual([s]);
  });

  it("__local: excludes passive mirrors (imported, no local upstream)", () => {
    const s = session({ importedFromMachine: "broom" });
    expect(filterByHost([s], "__local")).toEqual([]);
  });

  it("<host>: includes passive mirrors from that host only", () => {
    const passive = session({ importedFromMachine: "broom" });
    const attached = session({
      importedFromMachine: "broom",
      upstreamSessionId: "u_local",
    });
    const otherPeer = session({ importedFromMachine: "dustpan" });
    expect(
      filterByHost([passive, attached, otherPeer], "broom"),
    ).toEqual([passive]);
  });

  it("__all: includes everything", () => {
    const items = [
      session({}),
      session({ importedFromMachine: "broom" }),
      session({
        importedFromMachine: "broom",
        upstreamSessionId: "u_local",
      }),
    ];
    expect(filterByHost(items, "__all")).toEqual(items);
  });
});

describe("sortSessions", () => {
  const cwd = "/home/me/work/project";

  it("floats busy sessions above non-busy live sessions", () => {
    const live = session({
      sessionId: "hydra-live",
      status: "live",
      cwd,
      updatedAt: "2026-05-20T12:00:00Z",
    });
    const busy = session({
      sessionId: "hydra-busy",
      status: "live",
      busy: true,
      cwd,
      updatedAt: "2026-05-20T11:00:00Z",
    });
    const cold = session({
      sessionId: "hydra-cold",
      status: "cold",
      cwd,
      updatedAt: "2026-05-20T13:00:00Z",
    });
    const out = sortSessions([live, cold, busy], cwd);
    expect(out.map((s) => s.sessionId)).toEqual([
      "hydra-busy",
      "hydra-live",
      "hydra-cold",
    ]);
  });

  it("floats awaiting-input sessions above merely-busy ones", () => {
    const busy = session({
      sessionId: "hydra-busy",
      status: "live",
      busy: true,
      cwd,
      updatedAt: "2026-05-20T13:00:00Z",
    });
    const awaiting = session({
      sessionId: "hydra-awaiting",
      status: "live",
      busy: true,
      awaitingInput: true,
      cwd,
      updatedAt: "2026-05-20T10:00:00Z",
    });
    const out = sortSessions([busy, awaiting], cwd);
    expect(out.map((s) => s.sessionId)).toEqual([
      "hydra-awaiting",
      "hydra-busy",
    ]);
  });

  it("ranks awaiting-input elsewhere above busy in the current cwd", () => {
    const busyHere = session({
      sessionId: "hydra-here",
      status: "live",
      busy: true,
      cwd,
      updatedAt: "2026-05-20T12:00:00Z",
    });
    const awaitingElsewhere = session({
      sessionId: "hydra-elsewhere",
      status: "live",
      awaitingInput: true,
      cwd: "/other/place",
      updatedAt: "2026-05-20T11:00:00Z",
    });
    const out = sortSessions([busyHere, awaitingElsewhere], cwd);
    expect(out.map((s) => s.sessionId)).toEqual([
      "hydra-elsewhere",
      "hydra-here",
    ]);
  });

  it("prefers busy + cwd match over busy in a different cwd", () => {
    const busyHere = session({
      sessionId: "hydra-here",
      status: "live",
      busy: true,
      cwd,
      updatedAt: "2026-05-20T11:00:00Z",
    });
    const busyElsewhere = session({
      sessionId: "hydra-elsewhere",
      status: "live",
      busy: true,
      cwd: "/other/place",
      updatedAt: "2026-05-20T12:00:00Z",
    });
    const out = sortSessions([busyElsewhere, busyHere], cwd);
    expect(out.map((s) => s.sessionId)).toEqual([
      "hydra-here",
      "hydra-elsewhere",
    ]);
  });

  it("ranks busy elsewhere above non-busy in current cwd", () => {
    const liveHere = session({
      sessionId: "hydra-here",
      status: "live",
      cwd,
      updatedAt: "2026-05-20T12:00:00Z",
    });
    const busyElsewhere = session({
      sessionId: "hydra-elsewhere",
      status: "live",
      busy: true,
      cwd: "/other/place",
      updatedAt: "2026-05-20T11:00:00Z",
    });
    const out = sortSessions([liveHere, busyElsewhere], cwd);
    expect(out.map((s) => s.sessionId)).toEqual([
      "hydra-elsewhere",
      "hydra-here",
    ]);
  });

  it("sorts by updatedAt within the same tier", () => {
    const older = session({
      sessionId: "hydra-older",
      status: "live",
      busy: true,
      cwd,
      updatedAt: "2026-05-20T10:00:00Z",
    });
    const newer = session({
      sessionId: "hydra-newer",
      status: "live",
      busy: true,
      cwd,
      updatedAt: "2026-05-20T12:00:00Z",
    });
    const out = sortSessions([older, newer], cwd);
    expect(out.map((s) => s.sessionId)).toEqual([
      "hydra-newer",
      "hydra-older",
    ]);
  });
});

describe("pickSession composer", () => {
  const sessions = [
    session({ sessionId: "hydra-aaa", title: "first" }),
    session({ sessionId: "hydra-bbb", title: "second" }),
  ];

  it("returns kind:new with no prompt when Enter is hit on empty composer", async () => {
    const drv = makePicker({ sessions });
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toEqual({ kind: "new" });
  });

  it("returns kind:new with prompt when text is typed then Enter", async () => {
    const drv = makePicker({ sessions });
    drv.type("hello world");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toEqual({
      kind: "new",
      prompt: "hello world",
    });
  });

  it("ignores whitespace-only composer text on Enter", async () => {
    const drv = makePicker({ sessions });
    drv.type("   ");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toEqual({ kind: "new" });
  });

  it("supports Alt+Enter for multiline prompts", async () => {
    const drv = makePicker({ sessions });
    drv.type("line one");
    drv.press("ALT_ENTER");
    drv.type("line two");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toEqual({
      kind: "new",
      prompt: "line one\nline two",
    });
  });

  it("Down at bottom of empty buffer moves focus to first session row", async () => {
    const drv = makePicker({ sessions });
    drv.press("DOWN");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toEqual({
      kind: "attach",
      sessionId: "hydra-aaa",
    });
  });

  it("Up from first session row returns focus to composer", async () => {
    const drv = makePicker({ sessions });
    drv.press("DOWN");
    drv.press("UP");
    drv.type("from composer");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toEqual({
      kind: "new",
      prompt: "from composer",
    });
  });

  it("preserves typed text across composer↔list focus toggles", async () => {
    const drv = makePicker({ sessions });
    drv.type("draft");
    drv.press("DOWN");
    drv.press("UP");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toEqual({
      kind: "new",
      prompt: "draft",
    });
  });

  it("opens with composer focused even when the session list is empty", async () => {
    const drv = makePicker({ sessions: [] });
    drv.type("only choice");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toEqual({
      kind: "new",
      prompt: "only choice",
    });
  });

  it("Ctrl+C peels a non-empty composer buffer and only aborts once it's empty", async () => {
    const drv = makePicker({ sessions });
    drv.type("about to abort");
    // First ^c: the dispatcher clears the buffer (peel) instead of exiting.
    drv.press("CTRL_C");
    // Second ^c on the now-empty buffer emits the exit effect, which the
    // picker translates to an abort.
    drv.press("CTRL_C");
    await expect(drv.resolveOnce).resolves.toEqual({ kind: "abort" });
  });

  it("Ctrl+C aborts immediately when the composer is already empty", async () => {
    const drv = makePicker({ sessions });
    drv.press("CTRL_C");
    await expect(drv.resolveOnce).resolves.toEqual({ kind: "abort" });
  });

  it("^U clears the composer buffer", async () => {
    const drv = makePicker({ sessions });
    drv.type("scratch this");
    drv.press("CTRL_U");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toEqual({ kind: "new" });
  });

  it("backspace deletes characters in the composer", async () => {
    const drv = makePicker({ sessions });
    drv.type("hellox");
    drv.press("BACKSPACE");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toEqual({
      kind: "new",
      prompt: "hello",
    });
  });

  it("hotkey letters are typed as text while composer is focused", async () => {
    const drv = makePicker({ sessions });
    // Letters like 'h', 'r', 'k' are picker hotkeys when the list is
    // focused. In the composer they're just text and must NOT trigger
    // refresh / host-filter / kill.
    drv.type("hrkdcoqt?");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toEqual({
      kind: "new",
      prompt: "hrkdcoqt?",
    });
  });

  it("bracketed paste inserts text including newlines without submitting", async () => {
    const drv = makePicker({ sessions });
    // Simulates the user pasting "line one\nline two" — without the
    // bracketed-paste interceptor, the \n would arrive as ENTER and
    // immediately submit.
    drv.paste("line one\nline two");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toEqual({
      kind: "new",
      prompt: "line one\nline two",
    });
  });

  it("bracketed paste with \r\n normalises to \n", async () => {
    const drv = makePicker({ sessions });
    drv.paste("first\r\nsecond");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toEqual({
      kind: "new",
      prompt: "first\nsecond",
    });
  });

  it("pasted text mixed with typed text works correctly", async () => {
    const drv = makePicker({ sessions });
    drv.type("prefix: ");
    drv.paste("pasted value");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toEqual({
      kind: "new",
      prompt: "prefix: pasted value",
    });
  });
});

describe("pickSession: killing the current session blocks abort", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const target = {
    baseUrl: "http://localhost:9999",
    token: "test-token",
    isLocal: true,
  } as unknown as RemoteTarget;

  // Drain queued microtasks so the async kill → refresh chain settles
  // before the test inspects picker state.
  const flush = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };

  it("refuses to abort back into the session that was just killed", async () => {
    const live = session({
      sessionId: "hydra-current",
      status: "live",
      agentId: "claude-code",
    });
    // After kill the daemon reports the session as cold (still on disk).
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/kill")) {
        return new Response(null, { status: 202 });
      }
      return new Response(
        JSON.stringify({
          sessions: [{ ...live, status: "cold" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const drv = makePicker({
      sessions: [live],
      currentSessionId: "hydra-current",
      target,
    });
    // Focus the current session row, kill it, confirm.
    drv.press("DOWN");
    drv.press("k", { isCharacter: true });
    drv.press("y", { isCharacter: true });
    await flush();
    // Escape must NOT resolve the picker — there's no live session to
    // return to.
    drv.press("ESCAPE");
    const settled = await Promise.race([
      drv.resolveOnce.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(settled).toBe("pending");
    // Attaching to a different choice still works: start a new session.
    drv.press("UP");
    drv.type("fresh start");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toEqual({
      kind: "new",
      prompt: "fresh start",
    });
  });

  it("still aborts normally when a non-current session is killed", async () => {
    const current = session({ sessionId: "hydra-current", status: "live" });
    const other = session({ sessionId: "hydra-other", status: "live" });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/kill")) {
        return new Response(null, { status: 202 });
      }
      return new Response(
        JSON.stringify({
          sessions: [current, { ...other, status: "cold" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const drv = makePicker({
      sessions: [current, other],
      currentSessionId: "hydra-current",
      target,
    });
    // Move focus to the "other" row (row order is sorted; navigate to it).
    drv.press("DOWN");
    drv.press("DOWN");
    drv.press("k", { isCharacter: true });
    drv.press("y", { isCharacter: true });
    await flush();
    drv.press("ESCAPE");
    await expect(drv.resolveOnce).resolves.toEqual({ kind: "abort" });
  });
});
