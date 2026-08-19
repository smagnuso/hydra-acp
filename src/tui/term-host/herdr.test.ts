import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// net.connect can't be spied on in place — an ESM namespace object is
// non-configurable — so swap the module and route through a mutable hook
// the specs can repoint.
let connectImpl: () => unknown = () => fakeSocket();
let connectCalls = 0;
vi.mock("node:net", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:net")>();
  return {
    ...orig,
    connect: (...args: unknown[]) => {
      void args;
      connectCalls += 1;
      return connectImpl();
    },
  };
});

// The tab-label side rides the same socket, so leaving it live would add its
// readLabel/writeLabel round trips to every frame count below. It has its own
// spec; here it just needs to be out of the way.
const tabLabels: Array<{ label: string; transient: boolean }> = [];
vi.mock("./label-sync.js", () => ({
  TAB_LABEL_ENV: "HYDRA_TAB_LABEL",
  TRANSIENT_TAB_LABEL: "hydra…",
  syncTabLabel: (label: string, opts: { transient?: boolean } = {}) => {
    tabLabels.push({ label, transient: opts.transient === true });
  },
  restoreTabLabel: () => Promise.resolve(),
  tabLabelOwnershipEnv: (label: string) => ({ HYDRA_TAB_LABEL: label }),
}));

import {
  __resetTerminalHostForTests,
  initTerminalHost,
  terminalHost,
} from "./index.js";
import {
  __resetReportForTests,
  releaseTerminalHost,
  reportBanner,
  reportPermission,
  reportSessionbar,
  reportTurn,
  setReportSuspended,
} from "./report.js";
import { nearestPane } from "./herdr.js";
import type { OpenTabSpec, TerminalHost } from "./types.js";

// Captured frames, in wire order across all connections.
interface Frame {
  method: string;
  params: Record<string, unknown>;
}
let frames: Frame[];

// herdr serves one request per connection, so the fake accepts exactly
// one frame and then replies — which is what unblocks the next frame in
// the module's serialized chain.
function fakeSocket(): unknown {
  let onData: ((d: string) => void) | undefined;
  const sock = {
    on(event: string, cb: (...a: unknown[]) => void) {
      if (event === "connect") {
        // Defer so the caller has finished subscribing to "data".
        queueMicrotask(() => cb());
      } else if (event === "data") {
        onData = cb as (d: string) => void;
      }
      return sock;
    },
    write(payload: string) {
      const line = payload.trim();
      if (line.length > 0) {
        frames.push(JSON.parse(line) as Frame);
      }
      queueMicrotask(() => onData?.('{"result":{"type":"ok"}}'));
    },
    setTimeout() {
      return sock;
    },
    destroy() {},
    unref() {
      return sock;
    },
  };
  return sock;
}

// Replies with a JSON-RPC error body instead of ok, for the request/response
// paths whose failure handling is part of the contract.
function errorSocket(error: { code?: string; message?: string }): unknown {
  let onData: ((d: string) => void) | undefined;
  const sock = {
    on(event: string, cb: (...a: unknown[]) => void) {
      if (event === "connect") {
        queueMicrotask(() => cb());
      } else if (event === "data") {
        onData = cb as (d: string) => void;
      }
      return sock;
    },
    write(payload: string) {
      frames.push(JSON.parse(payload.trim()) as Frame);
      queueMicrotask(() => onData?.(JSON.stringify({ error })));
    },
    setTimeout() {
      return sock;
    },
    destroy() {},
  };
  return sock;
}

// Closes without replying — the "half-open socket" case, which must not read
// as success.
function closingSocket(): unknown {
  let onClose: (() => void) | undefined;
  const sock = {
    on(event: string, cb: (...a: unknown[]) => void) {
      if (event === "connect") {
        queueMicrotask(() => cb());
      } else if (event === "close") {
        onClose = cb as () => void;
      }
      return sock;
    },
    write(payload: string) {
      frames.push(JSON.parse(payload.trim()) as Frame);
      queueMicrotask(() => onClose?.());
    },
    setTimeout() {
      return sock;
    },
    destroy() {},
  };
  return sock;
}

// The transport is async now (one connection per frame, each awaiting its
// reply), so specs settle the chain before asserting.
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

function methodsSent(): string[] {
  return frames.map((f) => f.method);
}

function lastOf(method: string): Frame | undefined {
  return [...frames].reverse().find((f) => f.method === method);
}

function countOf(method: string): number {
  return frames.filter((f) => f.method === method).length;
}

// Host detection walks CANDIDATES in order and the first match wins, so the
// tmux candidate is reached whenever the herdr env is incomplete. Running the
// suite INSIDE tmux therefore made the "is inert" cases resolve a real TmuxHost
// — pane and socket and all — and fail. Neutralise every candidate's env up
// front so these tests assert "no host", which is what they mean, rather than
// "no herdr host on a machine that happens not to run tmux".
const HOST_ENV = [
  "HERDR_ENV",
  "HERDR_SOCKET_PATH",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "TMUX",
  "TMUX_PANE",
] as const;

let savedHostEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedHostEnv = {};
  for (const key of HOST_ENV) {
    savedHostEnv[key] = process.env[key];
    delete process.env[key];
  }
  frames = [];
  tabLabels.length = 0;
  connectCalls = 0;
  connectImpl = () => fakeSocket();
  __resetReportForTests();
  __resetTerminalHostForTests();
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = "/tmp/fake-herdr.sock";
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.HERDR_TAB_ID = "w1:t1";
  // Resolution is opt-in; the real TUI does this once from runTuiApp.
  initTerminalHost();
});

afterEach(() => {
  // Restore rather than delete: the ambient values belong to whoever is running
  // the suite, and a later test file may legitimately care about them.
  for (const key of HOST_ENV) {
    const prior = savedHostEnv[key];
    if (prior === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prior;
    }
  }
  __resetReportForTests();
  __resetTerminalHostForTests();
});

describe("detection", () => {
  it("is inert without HERDR_ENV", async () => {
    delete process.env.HERDR_ENV;
    initTerminalHost();
    expect(terminalHost()).toBeNull();
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    reportBanner({ status: "busy" });
    await settle();
    expect(frames).toEqual([]);
  });

  it("is inert when the pane id is missing", async () => {
    delete process.env.HERDR_PANE_ID;
    initTerminalHost();
    expect(terminalHost()).toBeNull();
    reportSessionbar({ sessionId: "s1" });
    await settle();
    expect(frames).toEqual([]);
  });

  it("is active with the full env triple", async () => {
    expect(terminalHost()).not.toBeNull();
  });

  // Regression: the taps live in Screen, so anything that constructs a
  // Screen and pushes a session bar or banner would report. Running the
  // suite from a shell inside a herdr pane used to pin a phantom `hydra`
  // agent at `working` on the developer's own pane, with no teardown and
  // no screen-scrape fallback to correct it. Reporting must stay inert
  // until the real TUI opts in, even with the env fully present.
  it("stays inert until resolution is explicitly initialised", async () => {
    // The env is fully present; what's missing is the opt-in call. This is
    // what keeps `pnpm test` from reporting to the developer's own pane.
    __resetReportForTests();
    __resetTerminalHostForTests();
    expect(process.env.HERDR_ENV).toBe("1");
    expect(process.env.HERDR_PANE_ID).toBe("w1:p1");
    expect(terminalHost()).toBeNull();

    reportSessionbar({ sessionId: "s1", agent: "claude", title: "t" });
    reportBanner({ status: "busy" });
    reportPermission(true);
    await settle();
    expect(frames).toEqual([]);
    expect(connectCalls).toBe(0);
  });
});

describe("reporting gate", () => {
  it("does not claim the pane before a session id is known", async () => {
    reportBanner({ status: "busy" });
    await settle();
    expect(frames).toEqual([]);
  });

  it("publishes identity as soon as a session id arrives", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    expect(methodsSent()).toContain("pane.report_metadata");
  });

  it("claims the pane once a real state is known, not before", async () => {
    // The session bar seeds before the banner, so the only state available
    // at that point is `unknown` — see the withhold in report().
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    expect(methodsSent()).not.toContain("pane.report_agent");

    reportBanner({ status: "ready" });
    await settle();
    expect(lastOf("pane.report_agent")!.params).toMatchObject({
      pane_id: "w1:p1",
      source: "hydra",
      agent: "hydra",
      state: "idle",
    });
  });

  it("never publishes the opening unknown, so herdr sees no completion", async () => {
    // `unknown -> idle, same agent` is herdr's definition of a completion.
    // Publishing the pair made every freshly attached pane announce that
    // its agent had just finished.
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    reportBanner({ status: "ready" });
    await settle();
    const states = frames
      .filter((f) => f.method === "pane.report_agent")
      .map((f) => f.params.state);
    expect(states).toEqual(["idle"]);
  });
});

describe("state mapping", () => {
  beforeEach(async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
  });

  it("maps busy to working", async () => {
    reportBanner({ status: "busy" });
    await settle();
    expect(lastOf("pane.report_agent")!.params.state).toBe("working");
  });

  it("maps ready to idle", async () => {
    reportBanner({ status: "busy" });
    await settle();
    reportBanner({ status: "ready" });
    await settle();
    expect(lastOf("pane.report_agent")!.params.state).toBe("idle");
  });

  it("keeps cancelling as working since the turn has not settled", async () => {
    reportBanner({ status: "cancelling" });
    await settle();
    expect(lastOf("pane.report_agent")!.params.state).toBe("working");
  });

  it("maps a lasting disconnect to unknown rather than idle", async () => {
    // Two guards stand between a disconnect and an `unknown` frame: the
    // opening-unknown withhold (a first observation is not a transition) and
    // the unreachable hold (a blink is not a state change). So the only way
    // herdr ever hears `unknown` is a session that was genuinely live and
    // stayed unreachable — which is exactly when it's true.
    vi.useFakeTimers();
    try {
      reportBanner({ status: "ready" });
      await settle();
      reportBanner({ status: "disconnected" });
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(lastOf("pane.report_agent")!.params.state).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send an agent frame for a disconnect it is holding through", async () => {
    // The reason the hold exists is herdr-specific: it reads unknown → idle
    // with an unchanged agent label as a completion, so a daemon restart
    // would blue-dot the pane. Assert the frame never leaves.
    reportBanner({ status: "ready" });
    await settle();
    const before = countOf("pane.report_agent");
    reportBanner({ status: "disconnected" });
    await settle();
    expect(countOf("pane.report_agent")).toBe(before);
  });

  it("lets a pending permission win over a running turn", async () => {
    reportBanner({ status: "busy" });
    await settle();
    reportPermission(true);
    await settle();
    expect(lastOf("pane.report_agent")!.params.state).toBe("blocked");
  });

  it("falls back to the underlying banner state when the permission clears", async () => {
    reportBanner({ status: "busy" });
    await settle();
    reportPermission(true);
    await settle();
    reportPermission(false);
    await settle();
    expect(lastOf("pane.report_agent")!.params.state).toBe("working");
  });
});

// While the picker is up the pane isn't showing a session, so the session's
// activity isn't the pane's state. Screen.stop()/start() drive this, mirroring
// the started-guard that already stops the OSC 9;4 taskbar pulse.
describe("suspended (picker up)", () => {
  it("releases the agent so the pane leaves herdr's Agent panel", async () => {
    // herdr keeps a pane in the Agent panel for as long as it has an agent
    // label, whatever its state — so reporting `unknown` would leave a row
    // for a pane that is showing a picker. release_agent drops the label.
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    reportBanner({ status: "busy" });
    await settle();
    expect(lastOf("pane.report_agent")!.params.state).toBe("working");
    frames = [];
    setReportSuspended(true);
    await settle();
    expect(lastOf("pane.release_agent")).toBeTruthy();
    expect(frames.filter((f) => f.method === "pane.report_agent")).toEqual([]);
  });

  it("clears the session token when the picker opens", async () => {
    // release_agent drops the agent label but leaves published metadata
    // behind, so the token map has to be nulled in the same breath or
    // herdr-hardcopy.sh keeps resolving the session that was up before.
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    frames = [];
    setReportSuspended(true);
    await settle();
    expect(
      (lastOf("pane.report_metadata")!.params.tokens as Record<string, unknown>).session,
    ).toBeNull();
  });

  it("re-claims the pane when the picker closes", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    reportBanner({ status: "ready" });
    await settle();
    setReportSuspended(true);
    await settle();
    frames = [];
    setReportSuspended(false);
    await settle();
    expect(lastOf("pane.report_agent")).toBeTruthy();
    expect(
      (lastOf("pane.report_metadata")!.params.tokens as Record<string, unknown>).session,
    ).toBe("s1");
  });

  // Muting updates instead would freeze the last report, leaving a session
  // that went busy just before the picker opened stuck at `working`.
  it("overrides a busy state that arrives while suspended", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    setReportSuspended(true);
    await settle();
    frames = [];
    reportBanner({ status: "busy" });
    await settle();
    expect(frames.filter((f) => f.method === "pane.report_agent")).toEqual([]);
  });

  it("releases even when a permission is pending", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    reportPermission(true);
    await settle();
    frames = [];
    setReportSuspended(true);
    await settle();
    expect(lastOf("pane.release_agent")).toBeTruthy();
  });

  it("renames the tab off the session, so the tab bar doesn't read as still-in-session", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude", title: "Refactor auth" });
    await settle();
    expect(tabLabels.at(-1)).toEqual({ label: "Refactor auth", transient: false });
    setReportSuspended(true);
    await settle();
    expect(tabLabels.at(-1)).toEqual({ label: "hydra…", transient: true });
  });

  it("puts the session title back on the tab when the picker closes", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude", title: "Refactor auth" });
    setReportSuspended(true);
    await settle();
    setReportSuspended(false);
    await settle();
    expect(tabLabels.at(-1)).toEqual({ label: "Refactor auth", transient: false });
  });

  it("marks the picker label transient so it can never be left on the tab", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude", title: "Refactor auth" });
    setReportSuspended(true);
    await settle();
    expect(tabLabels.filter((t) => t.transient).map((t) => t.label)).toEqual([
      "hydra…",
    ]);
  });

  it("restores the real state on resume", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    reportBanner({ status: "busy" });
    setReportSuspended(true);
    await settle();
    frames = [];
    setReportSuspended(false);
    await settle();
    expect(lastOf("pane.report_agent")!.params.state).toBe("working");
  });

  // Otherwise the pane loses its identity in herdr's sidebar while picking.
  it("withdraws the title and tokens along with the agent", async () => {
    // The inverse of the old behaviour: identity used to be left in place
    // because only the state was suspect. Now the pane stops being an
    // agent at all, so anything published about the session goes with it.
    reportSessionbar({
      sessionId: "s1",
      agent: "claude",
      title: "refactor auth",
      model: "opus-5",
    });
    await settle();
    frames = [];
    setReportSuspended(true);
    await settle();
    const meta = lastOf("pane.report_metadata")!.params;
    expect(meta.clear_title).toBe(true);
    expect(meta.tokens).toEqual({
      kind: null,
      cwd: null,
      model: null,
      cost: null,
      queue: null,
      turn: null,
      turn_label: null,
      session: null,
    });
  });

  it("is idempotent", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    setReportSuspended(true);
    await settle();
    frames = [];
    setReportSuspended(true);
    setReportSuspended(true);
    await settle();
    expect(frames).toEqual([]);
  });
});

describe("deduplication", () => {
  it("does not resend an unchanged report", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    reportBanner({ status: "busy" });
    await settle();
    const before = frames.length;
    // The banner funnel fires at 1Hz for the elapsed clock; none of these
    // change any derived value.
    reportBanner({ status: "busy" });
    await settle();
    reportBanner({ status: "busy" });
    await settle();
    reportBanner({ status: "busy" });
    await settle();
    expect(frames.length).toBe(before);
  });

  it("sends only the state frame when only state changed", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    reportBanner({ status: "busy" });
    await settle();
    frames = [];
    reportBanner({ status: "ready" });
    await settle();
    expect(methodsSent()).toEqual(["pane.report_agent"]);
  });

  it("sends only the metadata frame when only metadata changed", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    reportBanner({ status: "busy" });
    await settle();
    frames = [];
    reportSessionbar({ sessionId: "s1", agent: "claude", model: "opus-5" });
    await settle();
    expect(methodsSent()).toEqual(["pane.report_metadata"]);
  });

  it("re-reports state when only the turn origin changed", async () => {
    // The origin rides the state frame, so deduping on state alone would
    // swallow it: a peer turn starting while an agent turn is already
    // running is working -> working with a different cause.
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    reportTurn({ origin: "agent" });
    reportBanner({ status: "busy" });
    await settle();
    frames = [];
    // reportTurn stores without flushing; the 1Hz elapsed tick is what
    // carries a mid-turn origin change out. Stand in for that tick.
    reportTurn({ origin: "peer" });
    reportBanner({ status: "busy" });
    await settle();
    expect(lastOf("pane.report_agent")!.params).toMatchObject({
      state: "working",
      turn_origin: "peer",
    });
  });

  it("does not re-report state when only the origin LABEL changed", async () => {
    // The label is free-form display text and lives in the token map; a new
    // one should not spend a state frame (or a seq) on an unchanged state.
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    reportTurn({ origin: "agent", label: "monitor one" });
    reportBanner({ status: "busy" });
    await settle();
    frames = [];
    reportTurn({ origin: "agent", label: "monitor two" });
    reportBanner({ status: "busy" });
    await settle();
    expect(methodsSent()).toEqual(["pane.report_metadata"]);
  });
});

describe("turn provenance", () => {
  it("rides both the state frame and the token map", async () => {
    // Two carriers on purpose: the frame is where a future herdr policy
    // would read it, the tokens are what `pane.list` reads back today.
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    reportTurn({ origin: "agent", label: "monitor: deploy.log" });
    reportBanner({ status: "busy" });
    await settle();
    expect(lastOf("pane.report_agent")!.params).toMatchObject({
      state: "working",
      turn_origin: "agent",
      turn_label: "monitor: deploy.log",
    });
    expect(lastOf("pane.report_metadata")!.params.tokens).toMatchObject({
      turn: "agent",
      turn_label: "monitor: deploy.log",
    });
  });

  it("omits the frame fields rather than sending nulls", async () => {
    // herdr ignores what it doesn't know either way; omitting keeps the
    // frame honest about carrying no claim.
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    reportBanner({ status: "busy" });
    await settle();
    const params = lastOf("pane.report_agent")!.params;
    expect(params).not.toHaveProperty("turn_origin");
    expect(params).not.toHaveProperty("turn_label");
  });

  it("still reports `working` for an agent-initiated turn", async () => {
    // Pass-through, not policy: the state herdr sees is unchanged by this
    // feature, which is why the completion chime is still herdr's call.
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    reportTurn({ origin: "agent", label: "monitor" });
    reportBanner({ status: "busy" });
    await settle();
    expect(lastOf("pane.report_agent")!.params.state).toBe("working");
    reportBanner({ status: "ready" });
    await settle();
    expect(lastOf("pane.report_agent")!.params).toMatchObject({
      state: "idle",
      turn_origin: "agent",
    });
  });

  it("clears both tokens on release", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    reportTurn({ origin: "agent", label: "monitor" });
    await settle();
    frames = [];
    await releaseTerminalHost();
    await settle();
    expect(lastOf("pane.report_metadata")!.params.tokens).toMatchObject({
      turn: null,
      turn_label: null,
    });
  });
});

describe("seq", () => {
  // herdr's sequence memory is per (pane, source) and survives our
  // process. A restart that began at 1 would have every report rejected
  // as stale for the life of the pane — silently, since dropped reports
  // still answer `ok`.
  it("is seeded from the wall clock so a restart outranks the last process", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    const first = frames[0]!.params.seq as number;
    // Microsecond scale, matching herdr's own integrations.
    expect(first).toBeGreaterThan(1_700_000_000_000 * 1000);
    expect(first).toBeLessThanOrEqual(Date.now() * 1000 + 1000);
  });

  // Plain epoch-ms would leave one unit of headroom per millisecond, so a
  // process that emitted N frames reaches start+N, and a restart fewer than
  // N ms later would begin below that watermark and be silently rejected.
  // Microsecond scaling gives 1000 units per ms of clock advance; this pins
  // the "one seq per frame" half of that arithmetic.
  it("advances by exactly one per frame, so drift is bounded by frame count", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    reportBanner({ status: "ready" });
    await settle();
    const seqs = frames.map((f) => f.params.seq as number);
    expect(seqs.length).toBe(2);
    expect(seqs[1]! - seqs[0]!).toBe(1);
  });

  it("is strictly increasing across every frame and never resets on switch", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    reportBanner({ status: "busy" });
    await settle();
    reportSessionbar({ sessionId: "s2", agent: "codex", title: "other" });
    await settle();
    reportBanner({ status: "ready" });
    await settle();
    await releaseTerminalHost();
    await settle();
    const seqs = frames.map((f) => f.params.seq as number);
    expect(seqs.length).toBeGreaterThan(4);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
  });
});

describe("tokens", () => {
  it("always emits the complete key set so a switch cannot leak values", async () => {
    reportSessionbar({
      sessionId: "s1",
      agent: "claude",
      model: "opus-5",
      costAmount: 1.239,
    });
    reportBanner({ status: "busy", queued: 3 });
    await settle();
    expect(lastOf("pane.report_metadata")!.params.tokens).toEqual({
      kind: "claude",
      cwd: null,
      model: "opus-5",
      cost: "$1.24",
      queue: "3",
      turn: null,
      turn_label: null,
      session: "s1",
    });

    // Switching to a session with no model/cost/queue must null those
    // keys, not omit them — herdr treats omitted keys as "leave as-is".
    // The caller hands us its whole merged state, so an absent model here
    // means "this session has no model", not "unchanged".
    frames = [];
    reportSessionbar({
      sessionId: "s2",
      agent: "codex",
      model: undefined,
      costAmount: undefined,
    });
    reportBanner({ status: "ready", queued: 0 });
    await settle();
    expect(lastOf("pane.report_metadata")!.params.tokens).toEqual({
      kind: "codex",
      cwd: null,
      model: null,
      cost: null,
      queue: null,
      turn: null,
      turn_label: null,
      // The whole reason this token exists: it has to follow an
      // in-process switch, which argv and the environment cannot.
      session: "s2",
    });
  });

  it("omits a zero cost rather than rendering $0.00", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude", costAmount: 0 });
    await settle();
    expect(
      (lastOf("pane.report_metadata")!.params.tokens as Record<string, unknown>).cost,
    ).toBeNull();
  });

  it("clears the session token on release", async () => {
    // A pane still advertising a session after the TUI exited would send
    // the hardcopy script off to fetch a transcript for a session nobody
    // is attached to.
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    frames = [];
    await releaseTerminalHost();
    await settle();
    expect(
      (lastOf("pane.report_metadata")!.params.tokens as Record<string, unknown>).session,
    ).toBeNull();
  });
});

// herdr derives its Space label, pane `cwd` and `foreground_cwd` from the
// hydra TUI process, which does not chdir when you switch sessions — the
// session's directory lives in the daemon. So every cwd label herdr owns
// is pinned to wherever `hydra` was launched. Reporting the session cwd
// ourselves is the only way a pane can follow a switch.
describe("agent identity", () => {
  // From herdr's point of view the agent in the pane is hydra; the
  // backing agent is a session detail, exposed as an opt-in token.
  it("never sets display_agent, so the row falls back to the hydra label", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    const p = lastOf("pane.report_metadata")!.params;
    expect(p.display_agent).toBeUndefined();
    // Sent every time so a value set by an older build is removed rather
    // than inherited.
    expect(p.clear_display_agent).toBe(true);
  });

  // parse_agent_label("hydra") returning None is what keeps the pane out
  // of herdr's resume_agents_on_restore path. If this ever reports the
  // real kind, herdr will relaunch a second agent beside the
  // daemon-owned one on restart.
  it("keeps the semantic agent label as hydra so herdr cannot resume it", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    reportBanner({ status: "ready" });
    await settle();
    expect(lastOf("pane.report_agent")!.params.agent).toBe("hydra");
  });

  it("exposes the backing agent as the kind token instead", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    const tokens = lastOf("pane.report_metadata")!.params.tokens as Record<string, unknown>;
    expect(tokens.kind).toBe("claude");
  });

  it("follows the backing agent across a swap without touching the label", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    frames = [];
    reportSessionbar({ sessionId: "s1", agent: "codex" });
    await settle();
    const tokens = lastOf("pane.report_metadata")!.params.tokens as Record<string, unknown>;
    expect(tokens.kind).toBe("codex");
    // No new state frame: the semantic label and state are unchanged.
    expect(lastOf("pane.report_agent")).toBeUndefined();
  });

  it("nulls the kind token when the agent is unknown", async () => {
    reportSessionbar({ sessionId: "s1", title: "t" });
    await settle();
    const tokens = lastOf("pane.report_metadata")!.params.tokens as Record<string, unknown>;
    expect(tokens.kind).toBeNull();
  });
});

describe("session cwd", () => {
  it("surfaces the session directory as a token", async () => {
    reportSessionbar({
      sessionId: "s1",
      agent: "claude",
      cwd: "/home/me/dev/hydra-acp/cli",
    });
    await settle();
    const tokens = lastOf("pane.report_metadata")!.params.tokens as Record<string, unknown>;
    expect(tokens.cwd).toBe("cli");
  });

  it("follows a switch into a different directory", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude", cwd: "/home/me/dev/hydra-acp/cli" });
    await settle();
    frames = [];
    reportSessionbar({
      sessionId: "s2",
      agent: "claude",
      cwd: "/home/me/netflix/git/nrdp/nrdjs",
    });
    await settle();
    const tokens = lastOf("pane.report_metadata")!.params.tokens as Record<string, unknown>;
    expect(tokens.cwd).toBe("nrdjs");
  });

  it("titles an untitled session by its directory rather than clearing", async () => {
    // Clearing would let herdr fall back to its own pane-cwd label, which
    // is the launch directory — so an untitled session in another repo
    // would still read as the launch dir.
    reportSessionbar({
      sessionId: "s2",
      agent: "claude",
      cwd: "/home/me/netflix/git/nrdp/nrdjs",
    });
    await settle();
    expect(lastOf("pane.report_metadata")!.params.title).toBe("nrdjs");
    expect(lastOf("pane.report_metadata")!.params.clear_title).toBeUndefined();
  });

  it("prefers an explicit session title over the directory", async () => {
    reportSessionbar({
      sessionId: "s2",
      agent: "claude",
      title: "port the codec shim",
      cwd: "/home/me/netflix/git/nrdp/nrdjs",
    });
    await settle();
    expect(lastOf("pane.report_metadata")!.params.title).toBe("port the codec shim");
  });
});

describe("title", () => {
  it("sets the pane title from the session title", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude", title: "refactor auth" });
    await settle();
    expect(lastOf("pane.report_metadata")!.params.title).toBe("refactor auth");
  });

  it("clears the title when the session has none", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    expect(lastOf("pane.report_metadata")!.params.clear_title).toBe(true);
    expect(lastOf("pane.report_metadata")!.params.title).toBeUndefined();
  });

  it("clears a stale title when switching to an untitled session", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude", title: "refactor auth" });
    await settle();
    frames = [];
    reportSessionbar({ sessionId: "s2", agent: "claude", title: "" });
    await settle();
    expect(lastOf("pane.report_metadata")!.params.clear_title).toBe(true);
  });
});

describe("release", () => {
  it("clears metadata before releasing the agent", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude", title: "t" });
    await settle();
    frames = [];
    await releaseTerminalHost();
    await settle();
    expect(methodsSent()).toEqual(["pane.report_metadata", "pane.release_agent"]);
    expect(lastOf("pane.report_metadata")!.params).toMatchObject({
      clear_title: true,
      clear_state_labels: true,
      tokens: { kind: null, cwd: null, model: null, cost: null, queue: null },
    });
    expect(lastOf("pane.release_agent")!.params).toMatchObject({
      pane_id: "w1:p1",
      source: "hydra",
      agent: "hydra",
    });
  });

  it("carries a seq on teardown, which herdr requires to accept it", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    frames = [];
    await releaseTerminalHost();
    await settle();
    for (const f of frames) {
      expect(typeof f.params.seq).toBe("number");
    }
  });

  it("is a no-op when nothing was ever reported", async () => {
    await releaseTerminalHost();
    await settle();
    expect(frames).toEqual([]);
  });

  it("does not report again after teardown until a new session arrives", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    await releaseTerminalHost();
    await settle();
    frames = [];
    reportBanner({ status: "busy" });
    await settle();
    expect(frames).toEqual([]);
  });
});

describe("socket failure", () => {
  it("swallows connect errors", async () => {
    connectImpl = () => {
      throw new Error("ECONNREFUSED");
    };
    expect(() => {
      reportSessionbar({ sessionId: "s1", agent: "claude" });
    }).not.toThrow();
    await settle();
  });

  // herdr serves one request per socket and resets. Batching frames onto
  // one connection silently drops everything after the first — which is
  // how the initial metadata report and the teardown release both went
  // missing before this was fixed.
  it("uses exactly one connection per frame", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude", title: "t" });
    await settle();
    reportBanner({ status: "ready" });
    await settle();
    // Metadata lands with the session bar; the state frame waits for the
    // banner. Two frames either way, one connection each.
    expect(frames.length).toBe(2);
    expect(connectCalls).toBe(2);
  });

  it("opens no socket at all when a report is deduped away", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    reportBanner({ status: "busy" });
    await settle();
    const before = connectCalls;
    reportBanner({ status: "busy" });
    await settle();
    reportBanner({ status: "busy" });
    await settle();
    expect(connectCalls).toBe(before);
  });
});

// The wire shape of openTab. Core's argv/label assembly is open.test.ts's
// job; what's herdr-specific is which method carries a command at all, and
// the validation quirks that make a wrong call fail loudly instead of being
// ignored.
describe("openTab", () => {
  const spec: OpenTabSpec = {
    label: "refactor auth",
    argv: ["hydra", "tui", "--session", "s"],
    cwd: "/home/me/proj",
    env: { HYDRA_TAB_LABEL: "refactor auth" },
  };

  async function openTab(over: Partial<OpenTabSpec> = {}) {
    return terminalHost()!.openTab!({ ...spec, ...over });
  }

  function params(): Record<string, unknown> {
    return frames[0]!.params;
  }

  function root(): Record<string, unknown> {
    return params().root as Record<string, unknown>;
  }

  it("uses layout.apply, the only method that can launch a command", async () => {
    // tab.create and pane.split take only cwd/env/focus/label — no argv — so
    // neither can start hydra.
    await openTab();
    expect(frames.map((f) => f.method)).toEqual(["layout.apply"]);
  });

  it("omits tab_id so the current tab is never replaced", async () => {
    // Passing the current tab_id rebuilds the tab and does not preserve live
    // PTYs — it would kill the hydra the user is sitting in to make room.
    await openTab();
    expect(params().tab_id).toBeUndefined();
  });

  it("carries the argv and label onto the pane node", async () => {
    await openTab();
    expect(root().command).toEqual(["hydra", "tui", "--session", "s"]);
    expect(root().label).toBe("refactor auth");
    expect(params().tab_label).toBe("refactor auth");
  });

  it("passes the ownership env through to the new pane", async () => {
    await openTab();
    expect(root().env).toEqual({ HYDRA_TAB_LABEL: "refactor auth" });
  });

  it("omits env entirely when there is none, rather than sending {}", async () => {
    await openTab({ env: {} });
    expect(root().env).toBeUndefined();
  });

  it("drops a relative cwd rather than having herdr reject the whole call", async () => {
    // herdr validates absolute + is_dir and fails the request, so an
    // unusable cwd would cost the tab rather than just the directory.
    await openTab({ cwd: "relative/path" });
    expect(root().cwd).toBeUndefined();
    expect(root().command).toBeDefined();
  });

  it("focuses the new tab", async () => {
    await openTab();
    expect(params().focus).toBe(true);
  });

  it("scopes the tab to this pane's workspace when herdr named one", async () => {
    process.env.HERDR_WORKSPACE_ID = "wB";
    try {
      await openTab();
      expect(params().workspace_id).toBe("wB");
    } finally {
      delete process.env.HERDR_WORKSPACE_ID;
    }
  });

  it("lets herdr choose the workspace when it did not tell us one", async () => {
    delete process.env.HERDR_WORKSPACE_ID;
    await openTab();
    expect(params().workspace_id).toBeUndefined();
  });

  it("uses exactly one connection, since herdr serves one request per socket", async () => {
    await openTab();
    expect(connectCalls).toBe(1);
  });

  it("surfaces a herdr error body as a failed result", async () => {
    connectImpl = () => errorSocket({ code: "invalid_params", message: "no workspace" });
    const r = await openTab();
    expect(r).toEqual({ ok: false, error: "no workspace" });
  });

  it("falls back to the error code when there is no message", async () => {
    connectImpl = () => errorSocket({ code: "invalid_params" });
    const r = await openTab();
    expect(r.error).toBe("invalid_params");
  });

  it("treats a closed connection as failure rather than false success", async () => {
    connectImpl = () => closingSocket();
    const r = await openTab();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/closed/);
  });

  it("surfaces a connect failure", async () => {
    connectImpl = () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await openTab();
    expect(r).toEqual({ ok: false, error: "ECONNREFUSED" });
  });
});

describe("isAutoLabel", () => {
  const isAuto = (l: string): boolean => terminalHost()!.isAutoLabel!(l);

  it("treats the tab number as auto-generated", () => {
    // herdr's default is `custom_name.unwrap_or_else(|| (tab_idx + 1))`.
    expect(isAuto("1")).toBe(true);
    expect(isAuto("12")).toBe(true);
  });

  it("treats an empty label as auto-generated", () => {
    expect(isAuto("")).toBe(true);
    expect(isAuto("   ")).toBe(true);
  });

  it("treats anything a human would type as owned", () => {
    expect(isAuto("review")).toBe(false);
    expect(isAuto("tab 2")).toBe(false);
    // Not numeric-only: a session titled "2fa" is still a real name.
    expect(isAuto("2fa")).toBe(false);
  });
});

describe("capabilities", () => {
  it("advertises label sync only when herdr told us the tab id", () => {
    expect(terminalHost()!.caps.label).toBe(true);
    delete process.env.HERDR_TAB_ID;
    __resetTerminalHostForTests();
    initTerminalHost();
    expect(terminalHost()!.caps.label).toBe(false);
  });

  it("never advertises split, since herdr cannot split a live tab", () => {
    expect(terminalHost()!.caps.split).toBe(false);
  });
});

describe("nearestPane", () => {
  const pane = (
    pane_id: string,
    workspace_id?: string,
  ): { pane_id: string; workspace_id?: string } =>
    workspace_id ? { pane_id, workspace_id } : { pane_id };

  it("returns null for no candidates", () => {
    expect(nearestPane([], "w1:pA", "w1")).toBeNull();
  });

  // "Already looking at it" is a successful reveal. Excluding self would
  // make the caller open a duplicate on the session it is already showing.
  it("prefers this pane over any other", () => {
    const out = nearestPane(
      [pane("w1:pA", "w1"), pane("w9:pZ", "w9")],
      "w9:pZ",
      "w1",
    );
    expect(out?.pane_id).toBe("w9:pZ");
  });

  it("prefers a pane in our own workspace", () => {
    const out = nearestPane(
      [pane("w9:pA", "w9"), pane("w1:pB", "w1")],
      "w1:pSelf",
      "w1",
    );
    expect(out?.pane_id).toBe("w1:pB");
  });

  // Determinism is the point: the same key pressed twice must land in the
  // same pane, and pane.list ordering is not something to rely on.
  it("breaks ties on pane id, independent of input order", () => {
    const panes = [pane("w1:pC", "w1"), pane("w1:pA", "w1"), pane("w1:pB", "w1")];
    expect(nearestPane(panes, "w1:pSelf", "w1")?.pane_id).toBe("w1:pA");
    expect(nearestPane([...panes].reverse(), "w1:pSelf", "w1")?.pane_id).toBe(
      "w1:pA",
    );
  });

  it("still picks something when no pane is in our workspace", () => {
    const out = nearestPane([pane("w7:pB", "w7"), pane("w7:pA", "w7")], "w1:pSelf", "w1");
    expect(out?.pane_id).toBe("w7:pA");
  });

  // A scrubbed env has no HERDR_WORKSPACE_ID; the rule degrades to the
  // stable tiebreak rather than failing.
  it("tolerates an unknown workspace", () => {
    const out = nearestPane([pane("w7:pB"), pane("w2:pA")], "w1:pSelf", undefined);
    expect(out?.pane_id).toBe("w2:pA");
  });
});

describe("herdr revealSession", () => {
  // A socket that answers per method, so one spec can serve the pane.list
  // scan and then the focus calls it provokes.
  function routedSocket(reply: (frame: Frame) => unknown): unknown {
    let onData: ((d: string) => void) | undefined;
    const sock = {
      on(event: string, cb: (...a: unknown[]) => void) {
        if (event === "connect") {
          queueMicrotask(() => cb());
        } else if (event === "data") {
          onData = cb as (d: string) => void;
        }
        return sock;
      },
      write(payload: string) {
        const frame = JSON.parse(payload.trim()) as Frame;
        frames.push(frame);
        queueMicrotask(() => onData?.(JSON.stringify(reply(frame))));
      },
      setTimeout() {
        return sock;
      },
      destroy() {},
      unref() {
        return sock;
      },
    };
    return sock;
  }

  function serve(panes: unknown[]): void {
    connectImpl = () =>
      routedSocket((frame) =>
        frame.method === "pane.list"
          ? { result: { panes } }
          : { result: { type: "ok" } },
      );
  }

  const sent = (method: string): Frame[] =>
    frames.filter((f) => f.method === method);

  function host(): TerminalHost {
    const h = terminalHost();
    if (!h) {
      throw new Error("no host resolved");
    }
    return h;
  }

  it("advertises the capability", () => {
    expect(host().caps.reveal).toBe(true);
  });

  it("focuses the tab and then the pane holding the session", async () => {
    serve([
      { pane_id: "w1:pB", tab_id: "w1:tB", workspace_id: "w1", tokens: { session: "s1" } },
    ]);
    await expect(host().revealSession?.("s1")).resolves.toBe(true);
    expect(sent("tab.focus")[0]?.params).toMatchObject({ tab_id: "w1:tB" });
    expect(sent("pane.focus")[0]?.params).toMatchObject({ pane_id: "w1:pB" });
    // Order matters: tab.focus alone leaves focus wherever it was inside a
    // split, so the pane.focus has to come after it rather than be undone.
    const methods = frames.map((f) => f.method);
    expect(methods.indexOf("tab.focus")).toBeLessThan(
      methods.indexOf("pane.focus"),
    );
  });

  it("is false, and focuses nothing, when no pane holds the session", async () => {
    serve([
      { pane_id: "w1:pB", tab_id: "w1:tB", workspace_id: "w1", tokens: { session: "other" } },
      { pane_id: "w1:pC", tab_id: "w1:tC", workspace_id: "w1" },
    ]);
    await expect(host().revealSession?.("s1")).resolves.toBe(false);
    expect(sent("tab.focus")).toHaveLength(0);
    expect(sent("pane.focus")).toHaveLength(0);
  });

  // A pane with the picker up has released its tokens, so it must not match
  // the session it was showing a moment ago.
  it("ignores panes with no session token", async () => {
    serve([
      { pane_id: "w1:pB", tab_id: "w1:tB", tokens: { session: null } },
      { pane_id: "w1:pC", tab_id: "w1:tC", tokens: {} },
    ]);
    await expect(host().revealSession?.("s1")).resolves.toBe(false);
  });

  it("never treats an empty session id as a match", async () => {
    serve([{ pane_id: "w1:pB", tab_id: "w1:tB", tokens: { session: null } }]);
    await expect(host().revealSession?.("")).resolves.toBe(false);
    expect(sent("pane.list")).toHaveLength(0);
  });

  it("still focuses a pane herdr reported without a tab", async () => {
    serve([{ pane_id: "w1:pB", workspace_id: "w1", tokens: { session: "s1" } }]);
    await expect(host().revealSession?.("s1")).resolves.toBe(true);
    expect(sent("tab.focus")).toHaveLength(0);
    expect(sent("pane.focus")[0]?.params).toMatchObject({ pane_id: "w1:pB" });
  });

  it("is false rather than throwing when pane.list errors", async () => {
    connectImpl = () =>
      routedSocket(() => ({ error: { code: "nope", message: "no" } }));
    await expect(host().revealSession?.("s1")).resolves.toBe(false);
  });

  it("is false rather than throwing on a malformed reply", async () => {
    connectImpl = () => routedSocket(() => ({ result: { panes: "not a list" } }));
    await expect(host().revealSession?.("s1")).resolves.toBe(false);
  });

  // The focus calls are best-effort: having found the pane, a failure to
  // land on it is still a reveal from the caller's point of view, and
  // reporting false would make it open a duplicate tab.
  it("reports true even when the focus calls fail", async () => {
    connectImpl = () =>
      routedSocket((frame) =>
        frame.method === "pane.list"
          ? {
              result: {
                panes: [
                  { pane_id: "w1:pB", tab_id: "w1:tB", tokens: { session: "s1" } },
                ],
              },
            }
          : { error: { code: "gone" } },
      );
    await expect(host().revealSession?.("s1")).resolves.toBe(true);
  });
});
