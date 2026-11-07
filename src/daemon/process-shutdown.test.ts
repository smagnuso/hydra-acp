import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetProcessShutdownForTests,
  shutdownDaemonProcess,
  type ProcessShutdownDeps,
} from "./process-shutdown.js";

// process.exit never returns, so the stand-in aborts the caller too.
class Exited extends Error {}

function harness(hardTimeoutMs?: number): {
  deps: ProcessShutdownDeps;
  log: string[];
} {
  const log: string[] = [];
  const deps: ProcessShutdownDeps = {
    exit: ((code: number) => {
      log.push(`exit:${code}`);
      throw new Exited(`exit:${code}`);
    }) as ProcessShutdownDeps["exit"],
    out: (text) => log.push(`out:${text.trim()}`),
    err: (text) => log.push(`err:${text.trim()}`),
    ...(hardTimeoutMs !== undefined ? { hardTimeoutMs } : {}),
  };
  return { deps, log };
}

describe("shutdownDaemonProcess", () => {
  beforeEach(() => {
    resetProcessShutdownForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the daemon shutdown and then exits 0", async () => {
    const h = harness();
    const handle = {
      shutdown: async () => {
        h.log.push("shutdown");
      },
    };
    await expect(shutdownDaemonProcess(handle, h.deps)).rejects.toBeInstanceOf(Exited);
    expect(h.log).toEqual(["out:Shutting down...", "shutdown", "exit:0"]);
  });

  it("still exits 0 after reporting a failed shutdown step", async () => {
    const h = harness();
    const handle = {
      shutdown: async () => {
        throw new Error("flush failed");
      },
    };
    await expect(shutdownDaemonProcess(handle, h.deps)).rejects.toBeInstanceOf(Exited);
    expect(h.log).toEqual([
      "out:Shutting down...",
      "err:shutdown failed: flush failed",
      "exit:0",
    ]);
  });

  it("exits immediately with 1 on a second request while one is in flight", async () => {
    const h = harness();
    let release: () => void = () => undefined;
    const handle = {
      shutdown: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    };
    const first = shutdownDaemonProcess(handle, h.deps);
    await expect(shutdownDaemonProcess(handle, h.deps)).rejects.toBeInstanceOf(Exited);
    expect(h.log).toContain("err:Second signal received; exiting immediately.");
    expect(h.log).toContain("exit:1");
    release();
    await expect(first).rejects.toBeInstanceOf(Exited);
  });

  it("force-exits with 1 when a step hangs past the hard timeout", async () => {
    vi.useFakeTimers();
    const h = harness(1_000);
    const handle = { shutdown: () => new Promise<void>(() => undefined) };
    void shutdownDaemonProcess(handle, h.deps).catch(() => undefined);
    // The timer's callback throws from exit(), as the real one would end the
    // process there.
    await vi.advanceTimersByTimeAsync(1_001).catch(() => undefined);
    expect(h.log).toContain("err:Graceful shutdown did not complete within 1000ms; forcing exit.");
    expect(h.log).toContain("exit:1");
  });
});
