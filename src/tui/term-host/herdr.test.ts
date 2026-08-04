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
  setReportSuspended,
} from "./report.js";
import type { OpenTabSpec } from "./types.js";

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

beforeEach(() => {
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
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_TAB_ID;
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

  it("reports once a session id arrives", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    expect(methodsSent()).toContain("pane.report_agent");
    expect(lastOf("pane.report_agent")!.params).toMatchObject({
      pane_id: "w1:p1",
      source: "hydra",
      agent: "hydra",
    });
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

  it("maps disconnected to unknown rather than idle", async () => {
    reportBanner({ status: "ready" });
    await settle();
    reportBanner({ status: "disconnected" });
    await settle();
    expect(lastOf("pane.report_agent")!.params.state).toBe("unknown");
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
  it("reports unknown instead of the session's activity", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    reportBanner({ status: "busy" });
    await settle();
    expect(lastOf("pane.report_agent")!.params.state).toBe("working");
    frames = [];
    setReportSuspended(true);
    await settle();
    expect(lastOf("pane.report_agent")!.params.state).toBe("unknown");
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

  it("outranks a pending permission too", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    reportPermission(true);
    setReportSuspended(true);
    await settle();
    expect(lastOf("pane.report_agent")!.params.state).toBe("unknown");
  });

  it("renames the tab off the session, so the tab bar doesn't read as still-in-session", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude", title: "Refactor auth" });
    await settle();
    expect(tabLabels.at(-1)).toEqual({ label: "Refactor auth", transient: false });
    setReportSuspended(true);
    await settle();
    expect(tabLabels.at(-1)).toEqual({ label: "hydra", transient: true });
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
      "hydra",
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
  it("leaves the title and tokens alone", async () => {
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
    expect(frames.filter((f) => f.method === "pane.report_metadata")).toEqual([]);
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
    });
  });

  it("omits a zero cost rather than rendering $0.00", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude", costAmount: 0 });
    await settle();
    expect(
      (lastOf("pane.report_metadata")!.params.tokens as Record<string, unknown>).cost,
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
    // First report emits both a state frame and a metadata frame.
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
