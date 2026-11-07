import { describe, expect, it } from "vitest";

import {
  stopDaemonProcess,
  type ShutdownRequest,
  type StopDeps,
} from "./daemon-stop.js";

interface Harness {
  deps: StopDeps;
  log: string[];
}

function harness(opts: {
  platform: NodeJS.Platform;
  answer?: ShutdownRequest;
  // How many liveness checks report alive before the daemon is gone.
  aliveChecks?: number;
  gracefulWaitMs?: number;
}): Harness {
  const log: string[] = [];
  let checks = 0;
  const deps: StopDeps = {
    platform: opts.platform,
    gracefulWaitMs: opts.gracefulWaitMs ?? 1_000,
    requestShutdown: async () => {
      log.push("request");
      return opts.answer ?? "accepted";
    },
    isAlive: () => {
      checks += 1;
      return checks <= (opts.aliveChecks ?? 0);
    },
    signal: (pid) => log.push(`signal:${pid}`),
    killTree: (pid) => log.push(`kill:${pid}`),
    sleep: async () => undefined,
  };
  return { deps, log };
}

describe("stopDaemonProcess", () => {
  it("sends SIGTERM on POSIX and does not touch the API", async () => {
    const h = harness({ platform: "linux" });
    expect(await stopDaemonProcess(42, h.deps)).toEqual({ how: "signalled" });
    expect(h.log).toEqual(["signal:42"]);
  });

  it("on Windows asks the daemon to stop and waits for it to exit", async () => {
    const h = harness({ platform: "win32", aliveChecks: 3 });
    expect(await stopDaemonProcess(42, h.deps)).toEqual({ how: "graceful" });
    expect(h.log).toEqual(["request"]);
  });

  it("on Windows force-kills the tree when the daemon accepts but never exits", async () => {
    const h = harness({ platform: "win32", aliveChecks: Infinity, gracefulWaitMs: 5 });
    expect(await stopDaemonProcess(42, h.deps)).toEqual({ how: "forced", reason: "timeout" });
    expect(h.log).toEqual(["request", "kill:42"]);
  });

  it("on Windows force-kills the tree for a daemon that refuses the request", async () => {
    // A daemon from before the endpoint existed answers 404.
    const h = harness({ platform: "win32", answer: "refused" });
    expect(await stopDaemonProcess(42, h.deps)).toEqual({ how: "forced", reason: "refused" });
    expect(h.log).toEqual(["request", "kill:42"]);
  });

  it("on Windows force-kills the tree when the daemon cannot be reached", async () => {
    const h = harness({ platform: "win32", answer: "unreachable" });
    expect(await stopDaemonProcess(42, h.deps)).toEqual({ how: "forced", reason: "unreachable" });
    expect(h.log).toEqual(["request", "kill:42"]);
  });

  it("never signals a Windows daemon with SIGTERM, which would hard-kill it unannounced", async () => {
    for (const answer of ["accepted", "refused", "unreachable"] as const) {
      const h = harness({ platform: "win32", answer, aliveChecks: 0 });
      await stopDaemonProcess(7, h.deps);
      expect(h.log.some((l) => l.startsWith("signal:"))).toBe(false);
    }
  });
});
