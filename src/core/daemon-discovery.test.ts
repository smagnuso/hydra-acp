// Coverage for how a client finds an already-running daemon.
//
// This is the path issue #9 fails on: the shim probes, concludes no
// daemon is running, autostarts a second one, and times out waiting for
// it while a perfectly healthy daemon is listening the whole time. None
// of it had a single test on any platform, which is why a Windows-only
// break in it reached a user.
//
// Everything here drives a REAL daemon through a REAL pidfile rather
// than a mock, because the failure modes worth catching all live in the
// seams: what gets written to the pidfile, whether the pid probe
// answers honestly, and whether the loopback URL derived from it is
// actually dialable. A mock of any of those three would assert the bug
// away.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import { startDaemon, type DaemonHandle } from "../daemon/server.js";
import { probeDaemon, waitForDaemonReady } from "./daemon-bootstrap.js";
import {
  readDaemonPidFile,
  writeDaemonPidFile,
  isProcessAlive,
} from "./daemon-pidfile.js";
import { recordDaemonBootFailure } from "./daemon-boot-log.js";
import { paths } from "./paths.js";
import type { HydraConfig } from "./config.js";
import * as fsp from "node:fs/promises";

const TEST_TOKEN = "hydra_token_0123456789abcdef0123456789abcdef";

function testConfig(): HydraConfig {
  return {
    daemon: {
      host: "127.0.0.1",
      port: 0,
      logLevel: "error",
      sessionIdleTimeoutSeconds: 30,
      nonInteractiveOrphanTimeoutSeconds: 30,
      sessionHistoryMaxEntries: 1000,
      sessionHistoryArchiveMaxBytes: 10_000_000,
      sessionHistoryArchiveTiers: 10,
      agentStderrTailBytes: 4096,
      agentSyncIntervalMinutes: 0,
      scrubEnv: [],
      sessionGcIntervalMinutes: 0,
      sessionGcMaxAgeDays: 2,
    },
    registry: {
      url: "http://127.0.0.1:65535/never-reached",
      ttlHours: 24,
      pinned: false,
    },
    defaultAgent: "claude-acp",
    sessionDefaults: {},
    defaultCwd: os.homedir(),
    compressToolContent: true,
    sessionListColdLimit: 20,
    agents: {},
    agentOverrides: {},
    extensions: {},
    transformers: {},
    defaultTransformers: [],
    tui: {
      composer: {
        top: { left: [], right: [] },
        bottom: { left: [], right: [] },
        hintTurns: 3,
      },
      sessionbar: { left: [], right: [] },
      scriptRefreshMs: 5_000,
      repaintThrottleMs: 1000,
      maxScrollbackLines: 10_000,
      mouse: false,
      logMaxBytes: 5 * 1024 * 1024,
      cwdColumnMaxWidth: 24,
      progressIndicator: true,
      terminalHost: true,
      launcherModeWhenHosted: false,
      skipPermissions: false,
      defaultEnterAction: "amend" as const,
      defaultHost: "local",
      showThoughts: true,
      ambiguousWidth: "narrow",
      toolContent: "inline",
      diffContextLines: 3,
      promptHistoryMaxEntries: 2_000,
      maxToolItems: 5,
      maxPlanItems: 5,
      showFileUpdates: "none" as const,
      selectionClipboard: "both" as const,
      sidebar: { enabled: false, border: "frame" as const, gadgets: [] },
      hotkeys: {},
    },
    compaction: {
      tailK: 0,
      maxIterations: 1,
      contextFraction: 0.5,
      hardCeilingFraction: 0.85,
      absoluteFallback: 120_000,
      idleBeforePromptMs: 300_000,
      modelContextWindows: {},
    },
  };
}

let handle: DaemonHandle | null = null;

beforeEach(() => {
  handle = null;
});

afterEach(async () => {
  if (handle) {
    await handle.shutdown().catch(() => undefined);
    handle = null;
  }
});

describe("daemon discovery", () => {
  it("finds a running daemon through the pidfile it wrote", async () => {
    handle = await startDaemon(testConfig(), TEST_TOKEN);

    // The pidfile is the ONLY discovery channel. If this round-trip
    // breaks, every client concludes there is no daemon and autostarts a
    // second one that cannot bind the port.
    const info = await readDaemonPidFile();
    expect(info).toBeDefined();
    expect(info!.pid).toBe(process.pid);
    expect(info!.loopbackPort).toBeGreaterThan(0);
    expect(isProcessAlive(info!.pid)).toBe(true);

    expect(await probeDaemon(testConfig())).toBe("match");
  });

  it("reports a healthy daemon ready without waiting", async () => {
    handle = await startDaemon(testConfig(), TEST_TOKEN);
    await expect(waitForDaemonReady(testConfig(), 5_000)).resolves.toBeUndefined();
  });

  it("reports missing when no pidfile exists", async () => {
    expect(await probeDaemon(testConfig())).toBe("missing");
  });

  it("reports missing when the pidfile names a dead process", async () => {
    // A pid that cannot exist, so the liveness probe is the only thing
    // that can reject it. Guards the inverse of the EPERM handling in
    // isProcessAlive: "cannot signal" must mean alive, "does not exist"
    // must mean dead.
    await writeDaemonPidFile({
      pid: 0x7ffffff0,
      host: "127.0.0.1",
      port: 65535,
      loopbackPort: 65535,
      startedAt: new Date().toISOString(),
    });
    expect(await probeDaemon(testConfig())).toBe("missing");
  });

  it("reports missing when the pidfile points at a port nothing answers", async () => {
    // Live pid, dead port: this process is certainly alive, but nothing
    // is listening on the recorded loopback port. The probe has to fetch,
    // not just stat the pidfile.
    await writeDaemonPidFile({
      pid: process.pid,
      host: "127.0.0.1",
      port: 1,
      loopbackPort: 1,
      startedAt: new Date().toISOString(),
    });
    expect(await probeDaemon(testConfig())).toBe("missing");
  });

  it("quotes a recorded startup failure instead of a bare timeout", async () => {
    // What issue #9 sees: no daemon comes up, and the caller is told only
    // that 15s elapsed. The boot log is the difference between that and
    // an actionable message.
    await fsp.rm(paths.daemonBootLog(), { force: true });
    await recordDaemonBootFailure("listen EADDRINUSE 127.0.0.1:55514");
    await expect(waitForDaemonReady(testConfig(), 300)).rejects.toThrow(
      /EADDRINUSE/,
    );
  });

  it("says which home it looked in when nothing was recorded", async () => {
    await fsp.rm(paths.daemonBootLog(), { force: true });
    await expect(waitForDaemonReady(testConfig(), 300)).rejects.toThrow(
      /HYDRA_ACP_HOME/,
    );
  });
});
