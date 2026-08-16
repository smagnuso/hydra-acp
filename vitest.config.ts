import * as os from "node:os";
import { defineConfig } from "vitest/config";

// Worker cap, deliberately far below the core count.
//
// Vitest defaults maxThreads to the number of CPUs, which is the right
// default for CPU-bound unit tests and badly wrong for this suite: a
// large share of these tests shell out (git worktrees, fake npm, spawned
// agents), so N workers means N × their own subprocesses competing. On a
// 64-core machine the default was pathological — the same 188 files took
// 103s at 64 workers and 31s at 8, and the aggregate collect time fell
// from 2424s to 35s, i.e. ~70x less CPU burned to do identical work.
// Individual files showed it starkly: core/session.test.ts runs its 211
// tests in 150ms alone and took 6.8s inside the 64-worker run.
//
// Measured on this suite: 4 → 36s, 6 → 32s, 8 → 32s, 12 → 31s, 16 → 35s
// (with a contention flake), 32 → 62s, 64 → 104s. The floor is a broad
// plateau from 6 to 12, so 8 sits in the middle of it with margin against
// the flakiness that appears as contention climbs.
//
// Scales down for smaller machines: a 4-core laptop gets 4, not 8.
const cpus = os.availableParallelism?.() ?? os.cpus().length;
const maxThreads = Math.max(2, Math.min(8, cpus));

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: false,
        // minThreads has to come down with maxThreads: it also defaults
        // to the CPU count, and a max below it is a hard RangeError
        // ("minThreads and maxThreads must not conflict") rather than a
        // clamp, so setting only the max fails to start at all.
        minThreads: 1,
        maxThreads,
      },
    },
  },
});
