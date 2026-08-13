import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "terminal-kit";

// Observe the terminal-host hand-off without touching a transport.
// `hostAvailable` is a hook so specs can simulate having no host.
let hostAvailable = true;
interface OpenCall {
  kind: string;
  sessionId?: string;
  title?: string;
  cwd?: string;
  agentId?: string;
  model?: string;
  prompt?: string;
}
const openCalls: OpenCall[] = [];
let openOk = true;
// Session ids the fake host is already showing somewhere, so a reveal
// short-circuits the open. Empty by default: the specs below are about what
// the picker asks for, and a host that reveals nothing keeps them reading as
// "opened a tab".
let revealable: string[] = [];
const revealCalls: string[] = [];
vi.mock("./term-host/open.js", () => ({
  canOpenTab: () => hostAvailable,
  canReveal: () => hostAvailable,
  labelForPrompt: (t?: string) => t ?? "new session",
  openInNewTab: async (spec: OpenCall) => {
    openCalls.push(spec);
    return openOk ? { ok: true } : { ok: false, error: "no workspace" };
  },
  // Mirrors the real policy in open.ts: reveal when we can, else open.
  revealOrOpen: async (spec: OpenCall) => {
    revealCalls.push(spec.sessionId as string);
    if (revealable.includes(spec.sessionId as string)) {
      return { outcome: "revealed" as const };
    }
    openCalls.push(spec);
    return openOk
      ? { outcome: "opened" as const }
      : { outcome: "failed" as const, error: "no workspace" };
  },
}));
vi.mock("./term-host/index.js", () => ({
  terminalHost: () => (hostAvailable ? { id: "testhost" } : null),
}));

// Views over the recorded calls, so the existing specs keep reading the way
// they did before the two entry points became one discriminated union.
const attachCalls = {
  get length() {
    return openCalls.filter((c) => c.kind === "attach").length;
  },
  map<T>(fn: (c: OpenCall) => T): T[] {
    return openCalls.filter((c) => c.kind === "attach").map(fn);
  },
};
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
  mouse(name: string, x?: number, y?: number): void;
  // Every string the picker painted since the last clear. The fake
  // terminal has no grid, so this is a flat transcript of writes — good
  // enough to assert "this label was rendered", not layout.
  output(): string;
  clearOutput(): void;
  resolveOnce: Promise<PickerResult>;
}

function makePicker(opts: {
  sessions: DiscoveredSession[];
  cwd?: string;
  currentSessionId?: string;
  prefs?: PickerPrefs;
  target?: RemoteTarget;
  // Terminal size. Defaults to 80x24; tests that need content to
  // overflow a box (e.g. the scrollable info overlay) shrink it.
  width?: number;
  height?: number;
}): KeyDriver {
  let onKey: ((name: string, _matches: unknown, data?: { isCharacter?: boolean }) => void) | null = null;
  let onMouse: ((name: string, data?: { x?: number; y?: number }) => void) | null = null;
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

  const writes: string[] = [];
  const handler: ProxyHandler<(...args: unknown[]) => unknown> = {
    apply: (_t, _this, args) => {
      for (const a of args) {
        if (typeof a === "string") {
          writes.push(a);
        }
      }
      return term;
    },
    get(_target, prop) {
      if (prop === "width") return opts.width ?? 80;
      if (prop === "height") return opts.height ?? 24;
      if (prop === "stdin") return fakeTkStdin;
      if (prop === "onStdin") return (): void => undefined;
      if (prop === "on") {
        return (event: string, cb: unknown): void => {
          if (event === "key") {
            onKey = cb as typeof onKey;
          }
          if (event === "mouse") {
            onMouse = cb as typeof onMouse;
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
    mouse(name, x, y) {
      if (!onMouse) {
        throw new Error("onMouse not registered yet");
      }
      onMouse(name, { x: x ?? 1, y: y ?? 1 });
    },
    output: () => writes.join(""),
    clearOutput: () => {
      writes.length = 0;
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

  it("skips this machine's hostname since self-imports roll into __local", () => {
    const items = [
      { importedFromMachine: "blackbox" },
      { importedFromMachine: "machine-a" },
    ];
    const locals = new Set(["blackbox"]);
    expect(nextHostFilter("__local", items, locals)).toBe("machine-a");
    expect(nextHostFilter("machine-a", items, locals)).toBe("__all");
    expect(nextHostFilter("__all", items, locals)).toBe("__local");
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

  it("__local: self-imports (importedFromMachine === thisHost) count as local", () => {
    const selfImport = session({ importedFromMachine: "blackbox" });
    const peerImport = session({ importedFromMachine: "broom" });
    const locals = new Set(["blackbox"]);
    expect(filterByHost([selfImport, peerImport], "__local", locals)).toEqual([
      selfImport,
    ]);
  });

  it("<host>: never returns anything for a local hostname", () => {
    const selfImport = session({ importedFromMachine: "blackbox" });
    const locals = new Set(["blackbox"]);
    expect(filterByHost([selfImport], "blackbox", locals)).toEqual([]);
  });
});

describe("sortSessions", () => {
  const cwd = "/home/me/work/project";

  it("floats busy sessions above non-busy live sessions", () => {
    const live = session({
      sessionId: "hydra-live",
      status: "warm",
      cwd,
      updatedAt: "2026-05-20T12:00:00Z",
    });
    const busy = session({
      sessionId: "hydra-busy",
      status: "warm",
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
      status: "warm",
      busy: true,
      cwd,
      updatedAt: "2026-05-20T13:00:00Z",
    });
    const awaiting = session({
      sessionId: "hydra-awaiting",
      status: "warm",
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

  // An awaiting-input flag with no turn behind it is the weakest of the
  // active signals — often nobody is standing by to act on it — so it
  // sorts below a session that is actually mid-turn, in any cwd.
  it("ranks busy above awaiting-input whose turn is already over", () => {
    const busyHere = session({
      sessionId: "hydra-here",
      status: "warm",
      busy: true,
      cwd,
      updatedAt: "2026-05-20T12:00:00Z",
    });
    const awaitingElsewhere = session({
      sessionId: "hydra-elsewhere",
      status: "warm",
      awaitingInput: true,
      cwd: "/other/place",
      updatedAt: "2026-05-20T11:00:00Z",
    });
    const out = sortSessions([busyHere, awaitingElsewhere], cwd);
    expect(out.map((s) => s.sessionId)).toEqual([
      "hydra-here",
      "hydra-elsewhere",
    ]);
  });

  it("ranks busy + awaiting-input above plain busy", () => {
    const busy = session({
      sessionId: "hydra-busy",
      status: "warm",
      busy: true,
      cwd,
      updatedAt: "2026-05-20T12:00:00Z",
    });
    const busyAwaiting = session({
      sessionId: "hydra-busy-awaiting",
      status: "warm",
      busy: true,
      awaitingInput: true,
      cwd,
      updatedAt: "2026-05-20T10:00:00Z",
    });
    const idleAwaiting = session({
      sessionId: "hydra-idle-awaiting",
      status: "warm",
      awaitingInput: true,
      cwd,
      updatedAt: "2026-05-20T13:00:00Z",
    });
    const out = sortSessions([idleAwaiting, busy, busyAwaiting], cwd);
    expect(out.map((s) => s.sessionId)).toEqual([
      "hydra-busy-awaiting",
      "hydra-busy",
      "hydra-idle-awaiting",
    ]);
  });

  it("does not prefer current cwd within the same tier — newer wins", () => {
    const busyHere = session({
      sessionId: "hydra-here",
      status: "warm",
      busy: true,
      cwd,
      updatedAt: "2026-05-20T11:00:00Z",
    });
    const busyElsewhere = session({
      sessionId: "hydra-elsewhere",
      status: "warm",
      busy: true,
      cwd: "/other/place",
      updatedAt: "2026-05-20T12:00:00Z",
    });
    const out = sortSessions([busyHere, busyElsewhere], cwd);
    expect(out.map((s) => s.sessionId)).toEqual([
      "hydra-elsewhere",
      "hydra-here",
    ]);
  });

  it("ranks busy elsewhere above non-busy in current cwd", () => {
    const liveHere = session({
      sessionId: "hydra-here",
      status: "warm",
      cwd,
      updatedAt: "2026-05-20T12:00:00Z",
    });
    const busyElsewhere = session({
      sessionId: "hydra-elsewhere",
      status: "warm",
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
      status: "warm",
      busy: true,
      cwd,
      updatedAt: "2026-05-20T10:00:00Z",
    });
    const newer = session({
      sessionId: "hydra-newer",
      status: "warm",
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

  it("preserves compactionState on sessions through sorting", () => {
    const compacting = session({
      sessionId: "hydra-compacting",
      status: "warm",
      cwd,
      updatedAt: "2026-05-20T13:00:00Z",
      compactionState: { status: "running", requestedAt: Date.now() },
    });
    const idle = session({
      sessionId: "hydra-idle",
      status: "warm",
      cwd,
      updatedAt: "2026-05-20T14:00:00Z",
    });
    const out = sortSessions([idle, compacting], cwd);
    expect(out[0]!.sessionId).toBe("hydra-idle");
    expect(out[1]!.sessionId).toBe("hydra-compacting");
    // compactionState survives the sort.
    expect((out[1] as { compactionState?: unknown }).compactionState).toEqual({
      status: "running",
      requestedAt: expect.any(Number),
    });
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
    await expect(drv.resolveOnce).resolves.toMatchObject({
      kind: "new",
      cwd: "/home/me/work/project",
    });
  });

  it("returns kind:new with prompt when text is typed then Enter", async () => {
    const drv = makePicker({ sessions });
    drv.type("hello world");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toMatchObject({
      kind: "new",
      cwd: "/home/me/work/project",
      prompt: "hello world",
    });
  });

  it("ignores whitespace-only composer text on Enter", async () => {
    const drv = makePicker({ sessions });
    drv.type("   ");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toMatchObject({
      kind: "new",
      cwd: "/home/me/work/project",
    });
  });

  it("supports Alt+Enter for multiline prompts", async () => {
    const drv = makePicker({ sessions });
    drv.type("line one");
    drv.press("ALT_ENTER");
    drv.type("line two");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toMatchObject({
      kind: "new",
      cwd: "/home/me/work/project",
      prompt: "line one\nline two",
    });
  });

  it("Down at bottom of empty buffer moves focus to first session row", async () => {
    const drv = makePicker({ sessions });
    drv.press("DOWN");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toMatchObject({
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
    await expect(drv.resolveOnce).resolves.toMatchObject({
      kind: "new",
      cwd: "/home/me/work/project",
      prompt: "from composer",
    });
  });

  it("a held UP from the first session row settles in the composer", async () => {
    // Back-to-back synchronous UP presses simulate key auto-repeat: the
    // first walks focus from the first session row into the composer, and
    // every subsequent repeat (arriving within the cadence window) is
    // swallowed instead of falling through into prompt-history. Focus must
    // remain on the composer so typing + Enter creates a new session.
    const drv = makePicker({ sessions });
    drv.press("DOWN");
    for (let i = 0; i < 6; i += 1) {
      drv.press("UP");
    }
    drv.type("still composer");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toMatchObject({
      kind: "new",
      cwd: "/home/me/work/project",
      prompt: "still composer",
    });
  });

  it("preserves typed text across composer↔list focus toggles", async () => {
    const drv = makePicker({ sessions });
    drv.type("draft");
    drv.press("DOWN");
    drv.press("UP");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toMatchObject({
      kind: "new",
      cwd: "/home/me/work/project",
      prompt: "draft",
    });
  });

  it("opens with composer focused even when the session list is empty", async () => {
    const drv = makePicker({ sessions: [] });
    drv.type("only choice");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toMatchObject({
      kind: "new",
      cwd: "/home/me/work/project",
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
    await expect(drv.resolveOnce).resolves.toMatchObject({ kind: "abort" });
  });

  it("Ctrl+C aborts immediately when the composer is already empty", async () => {
    const drv = makePicker({ sessions });
    drv.press("CTRL_C");
    await expect(drv.resolveOnce).resolves.toMatchObject({ kind: "abort" });
  });

  it("^U clears the composer buffer", async () => {
    const drv = makePicker({ sessions });
    drv.type("scratch this");
    drv.press("CTRL_U");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toMatchObject({
      kind: "new",
      cwd: "/home/me/work/project",
    });
  });

  it("backspace deletes characters in the composer", async () => {
    const drv = makePicker({ sessions });
    drv.type("hellox");
    drv.press("BACKSPACE");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toMatchObject({
      kind: "new",
      cwd: "/home/me/work/project",
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
    await expect(drv.resolveOnce).resolves.toMatchObject({
      kind: "new",
      cwd: "/home/me/work/project",
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
    await expect(drv.resolveOnce).resolves.toMatchObject({
      kind: "new",
      cwd: "/home/me/work/project",
      prompt: "line one\nline two",
    });
  });

  it("bracketed paste with \r\n normalises to \n", async () => {
    const drv = makePicker({ sessions });
    drv.paste("first\r\nsecond");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toMatchObject({
      kind: "new",
      cwd: "/home/me/work/project",
      prompt: "first\nsecond",
    });
  });

  it("pasted text mixed with typed text works correctly", async () => {
    const drv = makePicker({ sessions });
    drv.type("prefix: ");
    drv.paste("pasted value");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toMatchObject({
      kind: "new",
      cwd: "/home/me/work/project",
      prompt: "prefix: pasted value",
    });
  });

  it("entering search mode with `/` keeps the current selection", async () => {
    const drv = makePicker({
      sessions: [
        session({ sessionId: "hydra-aaa", title: "first" }),
        session({ sessionId: "hydra-bbb", title: "second" }),
        session({ sessionId: "hydra-ccc", title: "third" }),
      ],
    });
    drv.press("DOWN");
    drv.press("DOWN");
    drv.press("DOWN");
    // An empty query filters nothing, so `/` must not jerk the cursor
    // back to the top row.
    drv.type("/");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toMatchObject({
      kind: "attach",
      sessionId: "hydra-ccc",
    });
  });

  it("`/` followed by a query still snaps to the first match", async () => {
    const drv = makePicker({
      sessions: [
        session({ sessionId: "hydra-aaa", title: "first" }),
        session({ sessionId: "hydra-bbb", title: "second" }),
        session({ sessionId: "hydra-ccc", title: "third" }),
      ],
    });
    drv.press("DOWN");
    drv.press("DOWN");
    drv.press("DOWN");
    drv.type("/");
    drv.type("second");
    drv.press("ENTER");
    await expect(drv.resolveOnce).resolves.toMatchObject({
      kind: "attach",
      sessionId: "hydra-bbb",
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

  it("exits hydra on abort when the current session was just killed", async () => {
    const live = session({
      sessionId: "hydra-current",
      status: "warm",
      agentId: "claude-code",
    });
    // After kill the daemon reports the session as cold (still on disk).
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
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
    // There's no live session to return to, so escape resolves with
    // `exit` — the caller treats that as "exit hydra entirely" instead
    // of re-attaching to a session that no longer exists.
    drv.press("ESCAPE");
    await expect(drv.resolveOnce).resolves.toMatchObject({ kind: "exit" });
  });

  it("still aborts normally when a non-current session is killed", async () => {
    const current = session({ sessionId: "hydra-current", status: "warm" });
    const other = session({ sessionId: "hydra-other", status: "warm" });
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
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
    await expect(drv.resolveOnce).resolves.toMatchObject({ kind: "abort" });
  });
});

describe("pickSession: ^F find mode", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const target = {
    baseUrl: "http://localhost:9999",
    token: "test-token",
    isLocal: true,
  } as unknown as RemoteTarget;

  const flush = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };

  const alpha = session({
    sessionId: "hydra_session_alpha",
    title: "Alpha session",
    cwd: "/home/me/work/alpha",
    agentId: "claude-code",
    updatedAt: "2026-05-14T10:00:00Z",
  });
  const beta = session({
    sessionId: "hydra_session_beta",
    title: "Beta session",
    cwd: "/home/me/work/beta",
    agentId: "codex",
    updatedAt: "2026-05-14T09:00:00Z",
  });

  const hits = [
    {
      sessionId: "hydra_session_alpha",
      cwd: "/home/me/work/alpha",
      status: "cold" as const,
      updatedAt: "2026-05-14T10:00:00Z",
      title: "Alpha session",
      totalMatches: 3,
      snippets: [
        {
          kind: "agent" as const,
          text: "the needle is here",
          recordedAt: 1,
        },
        {
          kind: "tool" as const,
          toolName: "Edit",
          text: "another needle",
          recordedAt: 2,
        },
      ],
    },
    {
      sessionId: "hydra_session_beta",
      cwd: "/home/me/work/beta",
      status: "cold" as const,
      updatedAt: "2026-05-14T09:00:00Z",
      title: "Beta session",
      totalMatches: 1,
      snippets: [
        {
          kind: "agent" as const,
          text: "beta needle line",
          recordedAt: 3,
        },
      ],
    },
  ];

  // A real bundle, long enough that the info overlay has to scroll in an
  // 80x24 terminal. The history entries are what make it long — the
  // summary lists per-tool counts.
  const exportBundle = (): unknown => ({
    version: 1,
    exportedAt: "2026-05-14T10:00:00Z",
    exportedFrom: { hydraVersion: "0.1.0", machine: "test-machine" },
    session: {
      sessionId: "hydra_session_alpha",
      lineageId: "hydra_lineage_alpha",
      agentId: "claude-code",
      cwd: "/home/me/work/alpha",
      title: "Alpha session",
      createdAt: "2026-05-14T09:00:00Z",
      updatedAt: "2026-05-14T10:00:00Z",
      upstreamSessionId: "ses_upstream_alpha",
      currentModel: "claude-sonnet-4",
    },
    history: Array.from({ length: 40 }, (_, i) => ({
      method: "session/update",
      recordedAt: 1000 + i,
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `tc${i}`,
          name: `Tool${i}`,
          title: `Tool${i}`,
          status: "completed",
        },
      },
    })),
  });

  const stubSearch = (): void => {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("/sessions/search")) {
        return new Response(
          JSON.stringify({ query: "needle", truncated: false, results: hits }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/export")) {
        return new Response(JSON.stringify(exportBundle()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ sessions: [alpha, beta] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  };

  // ^F only opens find when focus is in the session list, not the
  // composer (there it's readline forward-char), hence the DOWN first.
  const openFind = (drv: ReturnType<typeof makePicker>): void => {
    drv.press("DOWN");
    drv.press("CTRL_F");
  };

  // Drive: open find, type the query, run the search.
  const runSearch = async (drv: ReturnType<typeof makePicker>): Promise<void> => {
    openFind(drv);
    drv.type("needle");
    drv.press("ENTER");
    await flush();
  };

  it("persists the query and results onto prefs when find is dismissed", async () => {
    stubSearch();
    const prefs = createPickerPrefs();
    const drv = makePicker({ sessions: [alpha, beta], prefs, target });
    await runSearch(drv);
    expect(prefs.lastFind).toBeUndefined();
    drv.press("ESCAPE");
    expect(prefs.lastFind?.query).toBe("needle");
    expect(prefs.lastFind?.results.map((r) => r.sessionId)).toEqual([
      "hydra_session_alpha",
      "hydra_session_beta",
    ]);
    drv.press("CTRL_C");
    await drv.resolveOnce;
  });

  it("restores the previous search on the next ^F, landing in the results", async () => {
    stubSearch();
    const prefs = createPickerPrefs();
    const first = makePicker({ sessions: [alpha, beta], prefs, target });
    await runSearch(first);
    first.press("ESCAPE");
    first.press("CTRL_C");
    await first.resolveOnce;

    // A brand-new pickSession, same prefs — as if the user had opened a
    // hit and come back via ^p.
    const second = makePicker({ sessions: [alpha, beta], prefs, target });
    second.clearOutput();
    openFind(second);
    const out = second.output();
    // Query is back in the box and the hit's snippet is on screen without
    // the user having pressed Enter again.
    expect(out).toContain("needle");
    expect(out).toContain("the needle is here");
    // Esc leaves the find layer; only then does ^C abort the picker.
    second.press("ESCAPE");
    second.press("CTRL_C");
    await second.resolveOnce;
  });

  it("drops restored hits whose session is no longer visible", async () => {
    stubSearch();
    const prefs = createPickerPrefs();
    const first = makePicker({ sessions: [alpha, beta], prefs, target });
    await runSearch(first);
    first.press("ESCAPE");
    first.press("CTRL_C");
    await first.resolveOnce;

    // alpha is gone (killed + deleted since the search).
    const second = makePicker({ sessions: [beta], prefs, target });
    second.clearOutput();
    openFind(second);
    expect(second.output()).not.toContain("the needle is here");
    // Esc leaves the find layer; only then does ^C abort the picker.
    second.press("ESCAPE");
    second.press("CTRL_C");
    await second.resolveOnce;
  });

  it("renders find hits with the same columns as the picker list", async () => {
    stubSearch();
    const drv = makePicker({ sessions: [alpha, beta], target });
    drv.clearOutput();
    await runSearch(drv);
    const out = drv.output();
    // The picker's column header, and the agent column — neither of which
    // the old id/status/title find row carried.
    expect(out).toContain("SESSION");
    expect(out).toContain("AGE");
    expect(out).toContain("claude-code");
    drv.press("ESCAPE");
    drv.press("CTRL_C");
    await drv.resolveOnce;
  });

  // Result rows start below the query box; each hit is two rows. With a
  // one-line query box the first hit's identity row is row 6.
  const FIRST_HIT_ROW = 6;
  const click = (drv: ReturnType<typeof makePicker>, x: number, y: number): void => {
    drv.mouse("MOUSE_LEFT_BUTTON_PRESSED", x, y);
    drv.mouse("MOUSE_LEFT_BUTTON_RELEASED", x, y);
  };

  it("selects a find hit on click and opens it on the second click", async () => {
    stubSearch();
    const drv = makePicker({ sessions: [alpha, beta], target });
    await runSearch(drv);
    // Move focus back to the query box so the first click has to move it.
    drv.press("CTRL_F");
    drv.clearOutput();
    click(drv, 10, FIRST_HIT_ROW);
    // Focus moved into the list; the row is now selected, not opened.
    expect(drv.output()).toContain("the needle is here");
    drv.clearOutput();
    // Second click on the same (already-selected) row opens it, which
    // puts up the launch-or-view modal.
    click(drv, 10, FIRST_HIT_ROW);
    await flush();
    expect(drv.output()).toContain("Open session");
    drv.press("ESCAPE");
    await flush();
    drv.press("ESCAPE");
    drv.press("CTRL_C");
    await drv.resolveOnce;
  });

  it("a click on the snippet row hits the same result as its identity row", async () => {
    stubSearch();
    const drv = makePicker({ sessions: [alpha, beta], target });
    await runSearch(drv);
    drv.clearOutput();
    // Row FIRST_HIT_ROW + 1 is the snippet line of the same hit, which is
    // already selected — so this click should open it.
    click(drv, 10, FIRST_HIT_ROW + 1);
    await flush();
    expect(drv.output()).toContain("Open session");
    drv.press("ESCAPE");
    await flush();
    drv.press("ESCAPE");
    drv.press("CTRL_C");
    await drv.resolveOnce;
  });

  it("a click in the query box returns focus to it without opening anything", async () => {
    stubSearch();
    const drv = makePicker({ sessions: [alpha, beta], target });
    await runSearch(drv);
    drv.clearOutput();
    click(drv, 10, 2);
    const out = drv.output();
    expect(out).not.toContain("Open session");
    expect(out).toContain("Enter to search");
    drv.press("ESCAPE");
    drv.press("CTRL_C");
    await drv.resolveOnce;
  });

  it("a drag (press and release on different cells) is not a click", async () => {
    stubSearch();
    const drv = makePicker({ sessions: [alpha, beta], target });
    await runSearch(drv);
    drv.clearOutput();
    drv.mouse("MOUSE_LEFT_BUTTON_PRESSED", 10, FIRST_HIT_ROW);
    drv.mouse("MOUSE_LEFT_BUTTON_RELEASED", 40, FIRST_HIT_ROW);
    await flush();
    expect(drv.output()).not.toContain("Open session");
    drv.press("ESCAPE");
    drv.press("CTRL_C");
    await drv.resolveOnce;
  });

  it("hover does not move the find selection while the query box is focused", async () => {
    stubSearch();
    const drv = makePicker({ sessions: [alpha, beta], target });
    await runSearch(drv);
    drv.press("CTRL_F");
    drv.clearOutput();
    drv.mouse("MOUSE_MOTION", 10, FIRST_HIT_ROW);
    expect(drv.output()).toBe("");
    drv.press("ESCAPE");
    drv.press("CTRL_C");
    await drv.resolveOnce;
  });

  it("hover moves the find selection while the list is focused", async () => {
    stubSearch();
    const drv = makePicker({ sessions: [alpha, beta], target });
    await runSearch(drv);
    // Hit 0 is selected on arrival. Hover the second hit's identity row.
    drv.clearOutput();
    drv.mouse("MOUSE_MOTION", 10, FIRST_HIT_ROW + 2);
    const out = drv.output();
    // The newly-hovered row picked up the focused-row marker and its
    // counter; the previously-selected row lost them.
    expect(out).toContain("beta needle line");
    expect(out).toContain("❯ ");
    // Hovering back up moves it again.
    drv.clearOutput();
    drv.mouse("MOUSE_MOTION", 10, FIRST_HIT_ROW);
    expect(drv.output()).toContain("[1/2] the needle is here");
    drv.press("ESCAPE");
    drv.press("CTRL_C");
    await drv.resolveOnce;
  });

  it("the wheel scrolls the find results list", async () => {
    stubSearch();
    // Tall enough for the box but short enough that two hits (2 rows
    // each) overflow the results viewport.
    const drv = makePicker({ sessions: [alpha, beta], target, height: 9 });
    await runSearch(drv);
    drv.clearOutput();
    drv.mouse("MOUSE_WHEEL_DOWN", 10, FIRST_HIT_ROW);
    expect(drv.output()).toContain("beta needle line");
    drv.press("ESCAPE");
    drv.press("CTRL_C");
    await drv.resolveOnce;
  });

  it("closes the info overlay on a click outside the box", async () => {
    stubSearch();
    const drv = makePicker({ sessions: [alpha, beta], target });
    await runSearch(drv);
    drv.press("i", { isCharacter: true });
    await flush();
    drv.clearOutput();
    // Top-left corner is outside any centred box in an 80x24 terminal.
    drv.mouse("MOUSE_LEFT_BUTTON_RELEASED", 1, 1);
    // Back on the results, which the info box was covering.
    expect(drv.output()).toContain("the needle is here");
    drv.press("ESCAPE");
    drv.press("CTRL_C");
    await drv.resolveOnce;
  });

  it("keeps the info overlay open on a click inside the box", async () => {
    stubSearch();
    const drv = makePicker({ sessions: [alpha, beta], target });
    await runSearch(drv);
    drv.press("i", { isCharacter: true });
    await flush();
    drv.clearOutput();
    // Dead centre of an 80x24 terminal is inside the box.
    drv.mouse("MOUSE_LEFT_BUTTON_RELEASED", 40, 12);
    expect(drv.output()).toBe("");
    drv.press("ESCAPE");
    drv.press("ESCAPE");
    drv.press("CTRL_C");
    await drv.resolveOnce;
  });

  it("scrolls the info overlay with the wheel", async () => {
    stubSearch();
    // Short terminal so the summary overflows the box and there is
    // something to scroll.
    const drv = makePicker({ sessions: [alpha, beta], target, height: 14 });
    await runSearch(drv);
    drv.press("i", { isCharacter: true });
    await flush();
    await flush();
    const before = drv.output();
    expect(before).toContain("Session info");
    // Confirm the export actually landed — otherwise the body is the
    // single "loading…" line and there is nothing to scroll.
    expect(before).toContain("Last active:");
    drv.clearOutput();
    drv.mouse("MOUSE_WHEEL_DOWN", 40, 12);
    const scrolled = drv.output();
    // A repaint happened and the content moved.
    expect(scrolled).not.toBe("");
    expect(scrolled).not.toBe(before);
    // Wheeling back up returns to the top and stops there — a further
    // wheel-up is a no-op, not an unbounded scroll.
    drv.mouse("MOUSE_WHEEL_UP", 40, 12);
    drv.clearOutput();
    drv.mouse("MOUSE_WHEEL_UP", 40, 12);
    expect(drv.output()).toBe("");
    drv.press("ESCAPE");
    drv.press("ESCAPE");
    drv.press("CTRL_C");
    await drv.resolveOnce;
  });

  it("does not let a wheel event under a modal scroll the list behind it", async () => {
    stubSearch();
    const drv = makePicker({ sessions: [alpha, beta], target });
    await runSearch(drv);
    drv.press("i", { isCharacter: true });
    await flush();
    drv.clearOutput();
    // The picker's own wheel handler would repaint the session viewport;
    // the info layer consumes the event instead.
    drv.mouse("MOUSE_WHEEL_DOWN", 40, 12);
    expect(drv.output()).not.toContain("Alpha session  claude-code");
    drv.press("ESCAPE");
    drv.press("ESCAPE");
    drv.press("CTRL_C");
    await drv.resolveOnce;
  });

  it("puts the snippet counter on the snippet line, not the column row", async () => {
    stubSearch();
    const drv = makePicker({ sessions: [alpha, beta], target });
    await runSearch(drv);
    const out = drv.output();
    // Counter leads the snippet line rather than trailing the columns,
    // where it read as a value in the AGENT / COST column.
    expect(out).toContain("[1/2] the needle is here");
    // Snippet kind labels are gone; tool names survive.
    expect(out).not.toContain("agent  the needle");
    drv.clearOutput();
    drv.press("n", { isCharacter: true });
    const after = drv.output();
    expect(after).toContain("[2/2] Edit  another needle");
    expect(after).not.toContain("tool · Edit");
    // The counter is not focus-gated — an unfocused row still carries it,
    // pinned to its first snippet.
    drv.press("DOWN");
    drv.clearOutput();
    drv.press("UP");
    expect(drv.output()).toContain("[1/2] the needle is here");
    drv.press("ESCAPE");
    drv.press("CTRL_C");
    await drv.resolveOnce;
  });

  it("`i` on a hit opens the session info overlay", async () => {
    stubSearch();
    const drv = makePicker({ sessions: [alpha, beta], target });
    await runSearch(drv);
    drv.clearOutput();
    drv.press("i", { isCharacter: true });
    expect(drv.output()).toContain("Session info");
    // Esc dismisses the overlay and lands back on the results.
    drv.clearOutput();
    drv.press("ESCAPE");
    expect(drv.output()).toContain("the needle is here");
    drv.press("ESCAPE");
    drv.press("CTRL_C");
    await drv.resolveOnce;
  });
});

// The original ^T handler was placed inside the picker's `data.isCharacter`
// block, where a control key can never reach it. Every unit test for the
// open call itself passed while the key was silently dead, so the coverage
// that matters is here: dispatch the actual key through the picker.
describe("^t opens the selected session in a new terminal-host tab", () => {
  const flush = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };

  afterEach(() => {
    openCalls.length = 0;
    revealCalls.length = 0;
    revealable = [];
    hostAvailable = true;
    openOk = true;
  });

  it("hands the selected session to the terminal host", async () => {
    const s = session({
      sessionId: "hydra_session_abc",
      title: "refactor auth",
      cwd: "/home/me/dev/proj",
    });
    const drv = makePicker({ sessions: [s] });
    drv.press("DOWN");
    drv.press("CTRL_T");
    await flush();
    expect(openCalls).toEqual([
      {
        kind: "attach",
        sessionId: "hydra_session_abc",
        title: "refactor auth",
        cwd: "/home/me/dev/proj",
      },
    ]);
  });

  // The reason ^t routes through revealOrOpen rather than openInNewTab: the
  // natural way to use this key is pick, come back, pick again, and each
  // repeat would otherwise mint another tab on the same session.
  it("jumps to the existing tab instead of opening a second one", async () => {
    revealable = ["hydra_session_abc"];
    const drv = makePicker({
      sessions: [session({ sessionId: "hydra_session_abc", title: "refactor auth" })],
    });
    drv.press("DOWN");
    drv.press("CTRL_T");
    await flush();
    expect(revealCalls).toEqual(["hydra_session_abc"]);
    expect(openCalls).toEqual([]);
  });

  it("still opens a tab for a session that is not showing anywhere", async () => {
    revealable = ["hydra_session_elsewhere"];
    const drv = makePicker({
      sessions: [session({ sessionId: "hydra_session_abc" })],
    });
    drv.press("DOWN");
    drv.press("CTRL_T");
    await flush();
    expect(openCalls.map((c) => c.sessionId)).toEqual(["hydra_session_abc"]);
  });

  // Fanning out is still the point; revealing must not close the picker any
  // more than opening did.
  it("leaves the picker open after a reveal", async () => {
    revealable = ["hydra_session_abc"];
    const drv = makePicker({
      sessions: [
        session({ sessionId: "hydra_session_abc" }),
        session({ sessionId: "hydra_session_def" }),
      ],
    });
    drv.press("DOWN");
    drv.press("CTRL_T");
    await flush();
    drv.press("DOWN");
    drv.press("CTRL_T");
    await flush();
    expect(revealCalls).toEqual(["hydra_session_abc", "hydra_session_def"]);
    expect(openCalls.map((c) => c.sessionId)).toEqual(["hydra_session_def"]);
  });

  it("starts a NEW session in a host tab while focus is in the composer", async () => {
    // Keyed on focus, mirroring Enter: on a row it acts on that session,
    // in the composer it starts a new one.
    const drv = makePicker({ sessions: [session({ sessionId: "hydra_session_abc" })] });
    drv.press("CTRL_T");
    await flush();
    expect(openCalls.filter((c) => c.kind === "attach")).toEqual([]);
    expect(openCalls.filter((c) => c.kind === "new")).toHaveLength(1);
  });

  it("does not start a new session in a host tab when there is no host", async () => {
    hostAvailable = false;
    const drv = makePicker({ sessions: [session({ sessionId: "hydra_session_abc" })] });
    drv.press("CTRL_T");
    await flush();
    expect(openCalls.filter((c) => c.kind === "new")).toEqual([]);
  });

  it("sends the composer text along as the new session's first prompt", async () => {
    const drv = makePicker({ sessions: [session({ sessionId: "hydra_session_abc" })] });
    drv.type("fix the parser");
    drv.press("CTRL_T");
    await flush();
    expect(openCalls[0]?.prompt).toBe("fix the parser");
  });

  it("clears the composer on success, so the text can't be sent twice", async () => {
    const drv = makePicker({ sessions: [session({ sessionId: "hydra_session_abc" })] });
    drv.type("fix the parser");
    drv.press("CTRL_T");
    await flush();
    // Enter now starts a local session with no seeded prompt: the text
    // went to the other tab.
    drv.press("ENTER");
    const out = await drv.resolveOnce;
    expect(out.kind).toBe("new");
    expect((out as { prompt?: string }).prompt).toBeUndefined();
  });

  it("keeps the composer text when opening the tab fails", async () => {
    openOk = false;
    const drv = makePicker({ sessions: [session({ sessionId: "hydra_session_abc" })] });
    drv.type("fix the parser");
    drv.press("CTRL_T");
    await flush();
    drv.press("ENTER");
    const out = await drv.resolveOnce;
    expect((out as { prompt?: string }).prompt).toBe("fix the parser");
  });

  it("leaves the composer text and the picker alone when starting a new tab", async () => {
    const drv = makePicker({ sessions: [session({ sessionId: "hydra_session_abc" })] });
    drv.press("CTRL_T");
    await flush();
    drv.press("CTRL_T");
    await flush();
    // Two presses, two tabs — nothing resolved the picker in between.
    expect(openCalls.filter((c) => c.kind === "new")).toHaveLength(2);
  });

  it("does nothing when there is no terminal host", async () => {
    hostAvailable = false;
    const drv = makePicker({ sessions: [session({ sessionId: "hydra_session_abc" })] });
    drv.press("DOWN");
    drv.press("CTRL_T");
    await flush();
    expect(openCalls.filter((c) => c.kind === "attach")).toEqual([]);
  });

  it("leaves the picker open so several sessions can be fanned out", async () => {
    const a = session({ sessionId: "hydra_session_a", title: "a" });
    const b = session({ sessionId: "hydra_session_b", title: "b" });
    const drv = makePicker({ sessions: [a, b] });
    drv.press("DOWN");
    drv.press("CTRL_T");
    await flush();
    drv.press("DOWN");
    drv.press("CTRL_T");
    await flush();
    expect(attachCalls.map((c) => c.sessionId)).toEqual([
      "hydra_session_a",
      "hydra_session_b",
    ]);
  });
});
