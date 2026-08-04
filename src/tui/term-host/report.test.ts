import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Label sync has its own spec and its own round trips; keep it out of the way
// so the snapshot assertions here stay about snapshots.
const tabLabels: Array<{ label: string; transient: boolean }> = [];
vi.mock("./label-sync.js", () => ({
  TAB_LABEL_ENV: "HYDRA_TAB_LABEL",
  syncTabLabel: (label: string, opts: { transient?: boolean } = {}) => {
    tabLabels.push({ label, transient: opts.transient === true });
  },
  restoreTabLabel: () => Promise.resolve(),
  tabLabelOwnershipEnv: (label: string) => ({ HYDRA_TAB_LABEL: label }),
}));

import { setTerminalHost, __resetTerminalHostForTests } from "./index.js";
import {
  __resetReportForTests,
  releaseTerminalHost,
  reportBanner,
  reportPermission,
  reportSessionbar,
  setReportSuspended,
} from "./report.js";
import type { TerminalHost, TerminalHostSnapshot } from "./types.js";

// The whole point of the refactor: core's job is to derive and de-duplicate
// snapshots, which is testable without any transport at all.
let snaps: TerminalHostSnapshot[];
let releases: number;
let reportThrows: Error | null;
let canReport: boolean;

function fakeHost(): TerminalHost {
  return {
    id: "fake",
    get caps() {
      return { openTab: true, split: false, label: true, report: canReport };
    },
    report: (snap) => {
      snaps.push(snap);
      return reportThrows ? Promise.reject(reportThrows) : Promise.resolve();
    },
    release: () => {
      releases += 1;
      return Promise.resolve();
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

function last(): TerminalHostSnapshot | undefined {
  return snaps.at(-1);
}

beforeEach(() => {
  snaps = [];
  releases = 0;
  reportThrows = null;
  canReport = true;
  __resetReportForTests();
  __resetTerminalHostForTests();
  tabLabels.length = 0;
  setTerminalHost(fakeHost());
});

afterEach(() => {
  __resetReportForTests();
  __resetTerminalHostForTests();
});

describe("the reporting gate", () => {
  it("does not claim the pane before a session id is known", async () => {
    // A banner tick during startup would otherwise register a titleless
    // agent on the pane.
    reportBanner({ status: "busy" });
    await settle();
    expect(snaps).toEqual([]);
  });

  it("reports once a session id arrives", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    expect(snaps).toHaveLength(1);
  });

  it("is inert with no host", async () => {
    setTerminalHost(null);
    reportSessionbar({ sessionId: "s1" });
    reportBanner({ status: "busy" });
    await settle();
    expect(snaps).toEqual([]);
  });

  it("still drives the tab label for a host that cannot report", async () => {
    // caps.report and caps.label are independent: a host might rename tabs
    // but have nowhere to put status.
    canReport = false;
    reportSessionbar({ sessionId: "s1", title: "Refactor auth" });
    await settle();
    expect(snaps).toEqual([]);
    expect(tabLabels.at(-1)).toEqual({ label: "Refactor auth", transient: false });
  });
});

describe("state derivation", () => {
  beforeEach(() => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
  });

  it("maps busy to working", async () => {
    reportBanner({ status: "busy" });
    await settle();
    expect(last()?.state).toBe("working");
  });

  it("maps ready to idle", async () => {
    reportBanner({ status: "ready" });
    await settle();
    expect(last()?.state).toBe("idle");
  });

  it("keeps cancelling as working, since the turn has not settled", async () => {
    reportBanner({ status: "cancelling" });
    await settle();
    expect(last()?.state).toBe("working");
  });

  it("maps disconnected to unknown rather than idle", async () => {
    reportBanner({ status: "disconnected" });
    await settle();
    expect(last()?.state).toBe("unknown");
  });

  it("lets a pending permission win over a running turn", async () => {
    reportBanner({ status: "busy" });
    reportPermission(true);
    await settle();
    expect(last()?.state).toBe("blocked");
  });

  it("falls back to the banner state when the permission clears", async () => {
    reportBanner({ status: "busy" });
    reportPermission(true);
    await settle();
    reportPermission(false);
    await settle();
    expect(last()?.state).toBe("working");
  });
});

describe("suspended (picker up)", () => {
  it("reports unknown instead of the session's activity", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    reportBanner({ status: "busy" });
    await settle();
    expect(last()?.state).toBe("working");
    setReportSuspended(true);
    await settle();
    expect(last()?.state).toBe("unknown");
  });

  it("overrides a busy state that arrives while suspended", async () => {
    // Muting updates instead would freeze the last report, leaving a session
    // that went busy just before the picker opened stuck at `working`.
    reportSessionbar({ sessionId: "s1" });
    setReportSuspended(true);
    await settle();
    snaps = [];
    reportBanner({ status: "busy" });
    await settle();
    expect(snaps).toEqual([]);
  });

  it("outranks a pending permission too", async () => {
    reportSessionbar({ sessionId: "s1" });
    reportPermission(true);
    setReportSuspended(true);
    await settle();
    expect(last()?.state).toBe("unknown");
  });

  it("restores the real state on resume", async () => {
    reportSessionbar({ sessionId: "s1" });
    reportBanner({ status: "busy" });
    setReportSuspended(true);
    await settle();
    setReportSuspended(false);
    await settle();
    expect(last()?.state).toBe("working");
  });

  it("leaves the title and tokens alone", async () => {
    // Only the state is a lie while suspended; the session's identity is
    // still exactly what it was.
    reportSessionbar({ sessionId: "s1", agent: "claude", title: "T", model: "m" });
    await settle();
    setReportSuspended(true);
    await settle();
    expect(last()?.title).toBe("T");
    expect(last()?.agent).toBe("claude");
    expect(last()?.model).toBe("m");
  });

  it("renames the tab off the session so the tab bar doesn't read as still-in-session", async () => {
    reportSessionbar({ sessionId: "s1", title: "Refactor auth" });
    await settle();
    expect(tabLabels.at(-1)).toEqual({ label: "Refactor auth", transient: false });
    setReportSuspended(true);
    await settle();
    expect(tabLabels.at(-1)).toEqual({ label: "hydra", transient: true });
  });

  it("puts the session title back on the tab when the picker closes", async () => {
    reportSessionbar({ sessionId: "s1", title: "Refactor auth" });
    setReportSuspended(true);
    await settle();
    setReportSuspended(false);
    await settle();
    expect(tabLabels.at(-1)).toEqual({ label: "Refactor auth", transient: false });
  });

  it("marks only the picker label transient", async () => {
    reportSessionbar({ sessionId: "s1", title: "Refactor auth" });
    setReportSuspended(true);
    await settle();
    expect(tabLabels.filter((t) => t.transient).map((t) => t.label)).toEqual(["hydra"]);
  });

  it("is idempotent", async () => {
    reportSessionbar({ sessionId: "s1" });
    setReportSuspended(true);
    await settle();
    snaps = [];
    setReportSuspended(true);
    await settle();
    expect(snaps).toEqual([]);
  });
});

describe("deduplication", () => {
  it("does not resend an unchanged snapshot", async () => {
    // The banner funnel ticks at 1Hz while a turn runs (the elapsed clock),
    // so without this every second would be a fresh report.
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    reportBanner({ status: "busy" });
    await settle();
    const before = snaps.length;
    reportBanner({ status: "busy" });
    reportBanner({ status: "busy" });
    await settle();
    expect(snaps.length).toBe(before);
  });

  it("re-sends after a failed report rather than believing the host knows", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    reportThrows = new Error("socket gone");
    reportBanner({ status: "busy" });
    await settle();
    reportThrows = null;
    snaps = [];
    reportBanner({ status: "busy" });
    await settle();
    expect(snaps).toHaveLength(1);
  });
});

describe("snapshot fields", () => {
  it("carries the agent kind, model and formatted cost", async () => {
    reportSessionbar({
      sessionId: "s1",
      agent: "claude-code",
      model: "opus",
      costAmount: 1.5,
    });
    await settle();
    expect(last()).toMatchObject({ agent: "claude-code", model: "opus", cost: "$1.50" });
  });

  it("omits a zero cost rather than rendering $0.00", async () => {
    reportSessionbar({ sessionId: "s1", costAmount: 0 });
    await settle();
    expect(last()?.cost).toBeNull();
  });

  it("reports queue depth as null rather than 0 when nothing is queued", async () => {
    reportSessionbar({ sessionId: "s1" });
    reportBanner({ status: "ready", queued: 0 });
    await settle();
    expect(last()?.queued).toBe(0);
  });

  it("carries the SESSION cwd, which the pane process's own cwd cannot follow", async () => {
    reportSessionbar({ sessionId: "s1", cwd: "/home/me/dev/proj" });
    await settle();
    expect(last()?.cwd).toBe("/home/me/dev/proj");
  });

  it("titles an untitled session by its directory rather than leaving it blank", async () => {
    // Reporting no title would let a host fall back to a label derived from
    // the PANE's cwd — wherever `hydra` was launched, which never follows a
    // session switch.
    reportSessionbar({ sessionId: "s1", cwd: "/home/me/dev/proj" });
    await settle();
    expect(last()?.title).toBe("proj");
  });

  it("prefers an explicit session title over the directory", async () => {
    reportSessionbar({ sessionId: "s1", title: "Refactor auth", cwd: "/home/me/dev/proj" });
    await settle();
    expect(last()?.title).toBe("Refactor auth");
  });

  it("assigns rather than merges, so a switch cannot retain stale values", async () => {
    // A session with no model yet legitimately reports model: undefined, so
    // merging would keep the previous session's.
    reportSessionbar({ sessionId: "s1", agent: "claude", model: "opus", costAmount: 2 });
    await settle();
    reportSessionbar({ sessionId: "s2", agent: "codex" });
    await settle();
    expect(last()).toMatchObject({ agent: "codex", model: null, cost: null });
  });
});

describe("releaseTerminalHost", () => {
  it("releases the host", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    await releaseTerminalHost();
    expect(releases).toBe(1);
  });

  it("is a no-op when nothing was ever reported", async () => {
    await releaseTerminalHost();
    expect(releases).toBe(0);
  });

  it("does not report again after teardown until a new session arrives", async () => {
    reportSessionbar({ sessionId: "s1", agent: "claude" });
    await settle();
    await releaseTerminalHost();
    snaps = [];
    reportBanner({ status: "busy" });
    await settle();
    expect(snaps).toEqual([]);
  });

  it("survives a host that throws on release", async () => {
    reportSessionbar({ sessionId: "s1" });
    await settle();
    setTerminalHost({
      ...fakeHost(),
      release: () => Promise.reject(new Error("gone")),
    });
    await expect(releaseTerminalHost()).resolves.toBeUndefined();
  });
});
