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

import {
  __resetHerdrForTests,
  clearHerdrSession,
  herdrActive,
  initHerdrReporting,
  syncHerdrBanner,
  syncHerdrPermission,
  syncHerdrSessionbar,
} from "./herdr.js";

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
  connectCalls = 0;
  connectImpl = () => fakeSocket();
  __resetHerdrForTests();
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = "/tmp/fake-herdr.sock";
  process.env.HERDR_PANE_ID = "w1:p1";
  // Reporting is opt-in; the real TUI does this once from runTuiApp.
  initHerdrReporting();
});

afterEach(() => {
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
  __resetHerdrForTests();
});

describe("herdrActive", () => {
  it("is inert without HERDR_ENV", async () => {
    delete process.env.HERDR_ENV;
    initHerdrReporting();
    expect(herdrActive()).toBe(false);
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    syncHerdrBanner({ status: "busy" });
    await settle();
    expect(frames).toEqual([]);
  });

  it("is inert when the pane id is missing", async () => {
    delete process.env.HERDR_PANE_ID;
    initHerdrReporting();
    expect(herdrActive()).toBe(false);
    syncHerdrSessionbar({ sessionId: "s1" });
    await settle();
    expect(frames).toEqual([]);
  });

  it("is active with the full env triple", async () => {
    expect(herdrActive()).toBe(true);
  });

  // Regression: the taps live in Screen, so anything that constructs a
  // Screen and pushes a session bar or banner would report. Running the
  // suite from a shell inside a herdr pane used to pin a phantom `hydra`
  // agent at `working` on the developer's own pane, with no teardown and
  // no screen-scrape fallback to correct it. Reporting must stay inert
  // until the real TUI opts in, even with the env fully present.
  it("stays inert until reporting is explicitly initialised", async () => {
    __resetHerdrForTests();
    expect(process.env.HERDR_ENV).toBe("1");
    expect(process.env.HERDR_PANE_ID).toBe("w1:p1");
    expect(herdrActive()).toBe(false);

    syncHerdrSessionbar({ sessionId: "s1", agent: "claude", title: "t" });
    syncHerdrBanner({ status: "busy" });
    syncHerdrPermission(true);
    await settle();
    expect(frames).toEqual([]);
    expect(connectCalls).toBe(0);
  });
});

describe("reporting gate", () => {
  it("does not claim the pane before a session id is known", async () => {
    syncHerdrBanner({ status: "busy" });
    await settle();
    expect(frames).toEqual([]);
  });

  it("reports once a session id arrives", async () => {
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude" });
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
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
  });

  it("maps busy to working", async () => {
    syncHerdrBanner({ status: "busy" });
    await settle();
    expect(lastOf("pane.report_agent")!.params.state).toBe("working");
  });

  it("maps ready to idle", async () => {
    syncHerdrBanner({ status: "busy" });
    await settle();
    syncHerdrBanner({ status: "ready" });
    await settle();
    expect(lastOf("pane.report_agent")!.params.state).toBe("idle");
  });

  it("keeps cancelling as working since the turn has not settled", async () => {
    syncHerdrBanner({ status: "cancelling" });
    await settle();
    expect(lastOf("pane.report_agent")!.params.state).toBe("working");
  });

  it("maps disconnected to unknown rather than idle", async () => {
    syncHerdrBanner({ status: "ready" });
    await settle();
    syncHerdrBanner({ status: "disconnected" });
    await settle();
    expect(lastOf("pane.report_agent")!.params.state).toBe("unknown");
  });

  it("lets a pending permission win over a running turn", async () => {
    syncHerdrBanner({ status: "busy" });
    await settle();
    syncHerdrPermission(true);
    await settle();
    expect(lastOf("pane.report_agent")!.params.state).toBe("blocked");
  });

  it("falls back to the underlying banner state when the permission clears", async () => {
    syncHerdrBanner({ status: "busy" });
    await settle();
    syncHerdrPermission(true);
    await settle();
    syncHerdrPermission(false);
    await settle();
    expect(lastOf("pane.report_agent")!.params.state).toBe("working");
  });
});

describe("deduplication", () => {
  it("does not resend an unchanged report", async () => {
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    syncHerdrBanner({ status: "busy" });
    await settle();
    const before = frames.length;
    // The banner funnel fires at 1Hz for the elapsed clock; none of these
    // change any derived value.
    syncHerdrBanner({ status: "busy" });
    await settle();
    syncHerdrBanner({ status: "busy" });
    await settle();
    syncHerdrBanner({ status: "busy" });
    await settle();
    expect(frames.length).toBe(before);
  });

  it("sends only the state frame when only state changed", async () => {
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    syncHerdrBanner({ status: "busy" });
    await settle();
    frames = [];
    syncHerdrBanner({ status: "ready" });
    await settle();
    expect(methodsSent()).toEqual(["pane.report_agent"]);
  });

  it("sends only the metadata frame when only metadata changed", async () => {
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    syncHerdrBanner({ status: "busy" });
    await settle();
    frames = [];
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude", model: "opus-5" });
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
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude" });
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
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    const seqs = frames.map((f) => f.params.seq as number);
    expect(seqs.length).toBe(2);
    expect(seqs[1]! - seqs[0]!).toBe(1);
  });

  it("is strictly increasing across every frame and never resets on switch", async () => {
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    syncHerdrBanner({ status: "busy" });
    await settle();
    syncHerdrSessionbar({ sessionId: "s2", agent: "codex", title: "other" });
    await settle();
    syncHerdrBanner({ status: "ready" });
    await settle();
    await clearHerdrSession();
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
    syncHerdrSessionbar({
      sessionId: "s1",
      agent: "claude",
      model: "opus-5",
      costAmount: 1.239,
    });
    syncHerdrBanner({ status: "busy", queued: 3 });
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
    syncHerdrSessionbar({
      sessionId: "s2",
      agent: "codex",
      model: undefined,
      costAmount: undefined,
    });
    syncHerdrBanner({ status: "ready", queued: 0 });
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
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude", costAmount: 0 });
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
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude" });
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
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    expect(lastOf("pane.report_agent")!.params.agent).toBe("hydra");
  });

  it("exposes the backing agent as the kind token instead", async () => {
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    const tokens = lastOf("pane.report_metadata")!.params.tokens as Record<string, unknown>;
    expect(tokens.kind).toBe("claude");
  });

  it("follows the backing agent across a swap without touching the label", async () => {
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    frames = [];
    syncHerdrSessionbar({ sessionId: "s1", agent: "codex" });
    await settle();
    const tokens = lastOf("pane.report_metadata")!.params.tokens as Record<string, unknown>;
    expect(tokens.kind).toBe("codex");
    // No new state frame: the semantic label and state are unchanged.
    expect(lastOf("pane.report_agent")).toBeUndefined();
  });

  it("nulls the kind token when the agent is unknown", async () => {
    syncHerdrSessionbar({ sessionId: "s1", title: "t" });
    await settle();
    const tokens = lastOf("pane.report_metadata")!.params.tokens as Record<string, unknown>;
    expect(tokens.kind).toBeNull();
  });
});

describe("session cwd", () => {
  it("surfaces the session directory as a token", async () => {
    syncHerdrSessionbar({
      sessionId: "s1",
      agent: "claude",
      cwd: "/home/me/dev/hydra-acp/cli",
    });
    await settle();
    const tokens = lastOf("pane.report_metadata")!.params.tokens as Record<string, unknown>;
    expect(tokens.cwd).toBe("cli");
  });

  it("follows a switch into a different directory", async () => {
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude", cwd: "/home/me/dev/hydra-acp/cli" });
    await settle();
    frames = [];
    syncHerdrSessionbar({
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
    syncHerdrSessionbar({
      sessionId: "s2",
      agent: "claude",
      cwd: "/home/me/netflix/git/nrdp/nrdjs",
    });
    await settle();
    expect(lastOf("pane.report_metadata")!.params.title).toBe("nrdjs");
    expect(lastOf("pane.report_metadata")!.params.clear_title).toBeUndefined();
  });

  it("prefers an explicit session title over the directory", async () => {
    syncHerdrSessionbar({
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
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude", title: "refactor auth" });
    await settle();
    expect(lastOf("pane.report_metadata")!.params.title).toBe("refactor auth");
  });

  it("clears the title when the session has none", async () => {
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    expect(lastOf("pane.report_metadata")!.params.clear_title).toBe(true);
    expect(lastOf("pane.report_metadata")!.params.title).toBeUndefined();
  });

  it("clears a stale title when switching to an untitled session", async () => {
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude", title: "refactor auth" });
    await settle();
    frames = [];
    syncHerdrSessionbar({ sessionId: "s2", agent: "claude", title: "" });
    await settle();
    expect(lastOf("pane.report_metadata")!.params.clear_title).toBe(true);
  });
});

describe("clearHerdrSession", () => {
  it("clears metadata before releasing the agent", async () => {
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude", title: "t" });
    await settle();
    frames = [];
    await clearHerdrSession();
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
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    frames = [];
    await clearHerdrSession();
    await settle();
    for (const f of frames) {
      expect(typeof f.params.seq).toBe("number");
    }
  });

  it("is a no-op when nothing was ever reported", async () => {
    await clearHerdrSession();
    await settle();
    expect(frames).toEqual([]);
  });

  it("does not report again after teardown until a new session arrives", async () => {
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    await clearHerdrSession();
    await settle();
    frames = [];
    syncHerdrBanner({ status: "busy" });
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
      syncHerdrSessionbar({ sessionId: "s1", agent: "claude" });
    }).not.toThrow();
    await settle();
  });

  // herdr serves one request per socket and resets. Batching frames onto
  // one connection silently drops everything after the first — which is
  // how the initial metadata report and the teardown release both went
  // missing before this was fixed.
  it("uses exactly one connection per frame", async () => {
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude", title: "t" });
    await settle();
    // First report emits both a state frame and a metadata frame.
    expect(frames.length).toBe(2);
    expect(connectCalls).toBe(2);
  });

  it("opens no socket at all when a report is deduped away", async () => {
    syncHerdrSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    syncHerdrBanner({ status: "busy" });
    await settle();
    const before = connectCalls;
    syncHerdrBanner({ status: "busy" });
    await settle();
    syncHerdrBanner({ status: "busy" });
    await settle();
    expect(connectCalls).toBe(before);
  });
});
