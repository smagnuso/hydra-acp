import { describe, expect, it } from "vitest";
import {
  collectTree,
  fillRssBytes,
  parseCpuTime,
  parseProcStat,
  parsePsOutput,
  parseVmRss,
  sampleProcfs,
  sampleTrees,
  selfCpuFraction,
  treeUsage,
} from "./proc-sample.js";
import type { ProcSample } from "./proc-sample.js";

// Real `ps -A -o pid=,ppid=,rss=,time=` output shape (leading whitespace and
// column padding included, because that's what ps actually emits).
const PS = `
      1       0   14932 00:00:02
    100       1   50000 00:01:30
    101     100  120000 01:00:00
    102     100    2048 00:00:00
    200       1    4096 2-03:04:05
`;

describe("parseCpuTime", () => {
  it("parses the formats ps emits", () => {
    expect(parseCpuTime("00:00")).toBe(0);
    expect(parseCpuTime("01:30")).toBe(90);
    expect(parseCpuTime("00:01:30")).toBe(90);
    expect(parseCpuTime("01:00:00")).toBe(3600);
    expect(parseCpuTime("2-03:04:05")).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  });

  it("keeps fractional seconds", () => {
    expect(parseCpuTime("00:01.50")).toBeCloseTo(1.5, 5);
  });

  it("rejects non-durations rather than guessing", () => {
    expect(parseCpuTime("")).toBeNull();
    expect(parseCpuTime("12")).toBeNull();
    expect(parseCpuTime("a:b")).toBeNull();
    expect(parseCpuTime("-1:00")).toBeNull();
    expect(parseCpuTime("1:2:3:4")).toBeNull();
  });
});

describe("parsePsOutput", () => {
  it("parses rows and converts RSS from kB to bytes", () => {
    const rows = parsePsOutput(PS);
    expect(rows.size).toBe(5);
    expect(rows.get(100)).toEqual({
      pid: 100,
      ppid: 1,
      rssBytes: 50_000 * 1024,
      cpuSeconds: 90,
    });
  });

  // Scraped text from a program whose formatting varies by platform: a bad
  // line must be skipped, never thrown on, or one odd row would take down
  // the caller's poll loop.
  it("skips unparseable lines instead of throwing", () => {
    const rows = parsePsOutput(
      ["garbage", "1 2 3", "x y z w", "  7   1   64   00:00:01", ""].join("\n"),
    );
    expect([...rows.keys()]).toEqual([7]);
  });

  it("handles empty input", () => {
    expect(parsePsOutput("").size).toBe(0);
  });
});

describe("collectTree", () => {
  const rows = parsePsOutput(PS);

  it("includes the root and all descendants", () => {
    expect([...collectTree(rows, 100)].sort((a, b) => a - b)).toEqual([
      100, 101, 102,
    ]);
  });

  it("returns just the process when it has no children", () => {
    expect([...collectTree(rows, 200)]).toEqual([200]);
  });

  it("returns empty for an unknown pid", () => {
    expect(collectTree(rows, 99_999).size).toBe(0);
  });

  it("terminates on a malformed parent/child cycle", () => {
    const cyclic = parsePsOutput(
      ["  10   11   100   00:00:01", "  11   10   100   00:00:01"].join("\n"),
    );
    expect([...collectTree(cyclic, 10)].sort((a, b) => a - b)).toEqual([10, 11]);
  });
});

describe("treeUsage", () => {
  const sample = (at: number, text: string): ProcSample => ({
    at,
    rows: parsePsOutput(text),
  });

  const before = sample(
    10_000,
    ["  100     1   50000  00:00:10", "  101   100  120000  00:00:20"].join("\n"),
  );

  it("sums RSS across the tree", () => {
    const usage = treeUsage(before, null, 100)!;
    expect(usage.processes).toBe(2);
    expect(usage.rssBytes).toBe((50_000 + 120_000) * 1024);
  });

  it("has no CPU reading without a previous sample", () => {
    expect(treeUsage(before, null, 100)!.cpuFraction).toBeUndefined();
  });

  it("computes CPU as cpu-time delta over elapsed wall time", () => {
    // +1s of CPU on 100 and +2s on 101 over 5s of wall clock → 0.6 cores.
    const after = sample(
      15_000,
      ["  100     1   50000  00:00:11", "  101   100  120000  00:00:22"].join(
        "\n",
      ),
    );
    expect(treeUsage(after, before, 100)!.cpuFraction).toBeCloseTo(0.6, 5);
  });

  it("does not clamp above one core — a busy tree really is >100%", () => {
    const after = sample(
      11_000,
      ["  100     1   50000  00:00:12", "  101   100  120000  00:00:23"].join(
        "\n",
      ),
    );
    expect(treeUsage(after, before, 100)!.cpuFraction).toBeCloseTo(5, 5);
  });

  // A process born during the interval has no baseline; charging its whole
  // lifetime CPU to this interval would spike the reading (a fresh `bash -c`
  // reading as several hundred percent).
  it("ignores CPU from processes that appeared mid-interval", () => {
    const after = sample(
      15_000,
      [
        "  100     1   50000  00:00:10",
        "  101   100  120000  00:00:20",
        "  102   100    2048  00:00:30",
      ].join("\n"),
    );
    const usage = treeUsage(after, before, 100)!;
    expect(usage.cpuFraction).toBe(0);
    // ...but its memory counts, being a point-in-time measure.
    expect(usage.processes).toBe(3);
    expect(usage.rssBytes).toBe((50_000 + 120_000 + 2_048) * 1024);
  });

  it("tolerates a recycled pid reading lower than before", () => {
    const after = sample(15_000, ["  100     1   50000  00:00:01"].join("\n"));
    expect(treeUsage(after, before, 100)!.cpuFraction).toBe(0);
  });

  it("returns null when the root is gone", () => {
    const after = sample(15_000, "  1   0   100   00:00:01");
    expect(treeUsage(after, before, 100)).toBeNull();
  });

  it("reports no CPU when no wall time has passed", () => {
    expect(treeUsage(before, before, 100)!.cpuFraction).toBeUndefined();
  });
});

// /proc/<pid>/stat: "pid (comm) state ppid ..." where comm can contain
// spaces AND parentheses, which is why the parser slices after the LAST ')'
// instead of splitting on whitespace.
const statLine = (
  pid: number,
  comm: string,
  ppid: number,
  utime: number,
  stime: number,
  // cutime/cstime: CPU banked by this process's reaped children.
  cutime = 0,
  cstime = 0,
): string => {
  const after = [
    "S",
    String(ppid),
    "1",
    "1",
    "0",
    "-1",
    "4194304",
    "100",
    "0",
    "0",
    "0",
    String(utime),
    String(stime),
    String(cutime),
    String(cstime),
    "20",
    "0",
    "1",
    "0",
    "100",
    "3036161",
    "422",
  ];
  return `${pid} (${comm}) ${after.join(" ")}\n`;
};

describe("parseProcStat", () => {
  it("parses pid, ppid and cumulative cpu seconds", () => {
    const row = parseProcStat(statLine(100, "node", 1, 150, 50))!;
    expect(row.pid).toBe(100);
    expect(row.ppid).toBe(1);
    // (utime + stime) / USER_HZ, with USER_HZ fixed at 100 by the /proc ABI.
    expect(row.cpuSeconds).toBeCloseTo(2, 5);
  });

  it("leaves rss to the status pass", () => {
    expect(parseProcStat(statLine(100, "node", 1, 0, 0))!.rssBytes).toBe(0);
  });

  // The trap: splitting on whitespace mis-indexes every field after comm.
  it("survives a comm containing spaces and parentheses", () => {
    const spaces = parseProcStat(statLine(7, "Web Content", 3, 100, 0))!;
    expect(spaces).toMatchObject({ pid: 7, ppid: 3 });
    const parens = parseProcStat(statLine(8, "weird (name) here", 4, 200, 0))!;
    expect(parens).toMatchObject({ pid: 8, ppid: 4 });
    expect(parens.cpuSeconds).toBeCloseTo(2, 5);
  });

  it("returns null on malformed content rather than throwing", () => {
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("no parens here")).toBeNull();
    expect(parseProcStat("1 (x)")).toBeNull();
  });
});

describe("parseVmRss", () => {
  it("reads VmRSS in kB and returns bytes", () => {
    expect(parseVmRss("Name:\tnode\nVmRSS:\t    2460 kB\nThreads:\t7\n")).toBe(
      2460 * 1024,
    );
  });

  // Kernel threads have no VmRSS line; that's normal, not an error.
  it("returns null when absent", () => {
    expect(parseVmRss("Name:\tkthreadd\nThreads:\t1\n")).toBeNull();
    expect(parseVmRss("")).toBeNull();
  });
});

describe("selfCpuFraction", () => {
  const usage = (user: number, system: number): NodeJS.CpuUsage => ({
    user,
    system,
  });

  it("is undefined without a baseline", () => {
    expect(selfCpuFraction(usage(1000, 1000), null, 1000)).toBeUndefined();
  });

  it("converts microseconds of cpu over milliseconds of wall time", () => {
    // 500ms of CPU across user+system over 1000ms wall → half a core.
    expect(
      selfCpuFraction(usage(400_000, 100_000), usage(0, 0), 1_000),
    ).toBeCloseTo(0.5, 5);
  });

  it("is undefined when no wall time elapsed", () => {
    expect(selfCpuFraction(usage(10, 10), usage(0, 0), 0)).toBeUndefined();
  });
});

describe("sampleProcfs / fillRssBytes", () => {
  const fs = {
    "/proc/1/stat": statLine(1, "init", 0, 100, 0),
    "/proc/100/stat": statLine(100, "agent", 1, 500, 100),
    "/proc/101/stat": statLine(101, "helper", 100, 200, 0),
    "/proc/1/status": "VmRSS:\t    1024 kB\n",
    "/proc/100/status": "VmRSS:\t   50000 kB\n",
    "/proc/101/status": "VmRSS:\t   20000 kB\n",
  } as Record<string, string>;
  const readDir = async (): Promise<string[]> => [
    "1",
    "100",
    "101",
    "self",
    "cpuinfo",
  ];
  const readFile = async (path: string): Promise<string> => {
    const body = fs[path];
    if (body === undefined) {
      throw new Error("ENOENT");
    }
    return body;
  };

  it("reads only numeric entries as processes", async () => {
    const rows = await sampleProcfs(readDir, readFile);
    expect([...rows.keys()].sort((a, b) => a - b)).toEqual([1, 100, 101]);
  });

  it("skips a process that exits mid-scan", async () => {
    const rows = await sampleProcfs(
      async () => ["1", "100", "999"],
      readFile,
    );
    expect(rows.has(999)).toBe(false);
    expect(rows.has(100)).toBe(true);
  });

  it("fills rss only for the requested pids", async () => {
    const rows = await sampleProcfs(readDir, readFile);
    await fillRssBytes(rows, [100, 101], readFile);
    expect(rows.get(100)!.rssBytes).toBe(50_000 * 1024);
    expect(rows.get(101)!.rssBytes).toBe(20_000 * 1024);
    // Not requested: still zero, having never been read.
    expect(rows.get(1)!.rssBytes).toBe(0);
  });

  it("produces a usable tree reading end to end", async () => {
    const rows = await sampleProcfs(readDir, readFile);
    await fillRssBytes(rows, collectTree(rows, 100), readFile);
    const usage = treeUsage({ at: 1_000, rows }, null, 100)!;
    expect(usage.processes).toBe(2);
    expect(usage.rssBytes).toBe((50_000 + 20_000) * 1024);
  });
});

// Descendants that live and die between two samples are invisible to
// polling; the kernel banks their CPU on whoever reaps them. These cover
// the correction that folds that in without double-counting.
describe("treeUsage reaped-child accounting", () => {
  // Build a /proc-shaped sample: [pid, ppid, cpuSelf, cpuChildren].
  const procSample = (
    at: number,
    rows: Array<[number, number, number, number]>,
  ): ProcSample => ({
    at,
    rows: new Map(
      rows.map(([pid, ppid, self, kids]) => [
        pid,
        { pid, ppid, rssBytes: 0, cpuSeconds: self, childCpuSeconds: kids },
      ]),
    ),
  });

  const cpu = (a: ProcSample, b: ProcSample, root = 100): number =>
    treeUsage(b, a, root)!.cpuFraction!;

  // The whole point: a child born and reaped inside one interval is never
  // in two consecutive samples, so the live-process pass sees nothing.
  it("counts a child that lived and died entirely within the interval", () => {
    const before = procSample(0, [[100, 1, 10, 0]]);
    // 2s of grep, reaped. The agent itself did nothing.
    const after = procSample(1000, [[100, 1, 10, 2]]);
    expect(cpu(before, after)).toBeCloseTo(2, 5);
  });

  it("still reports zero for a genuinely idle tree", () => {
    const before = procSample(0, [[100, 1, 10, 5]]);
    const after = procSample(1000, [[100, 1, 10, 5]]);
    expect(cpu(before, after)).toBe(0);
  });

  // The trap. A child we watched for several intervals was billed as it
  // went; at reap the parent's counter jumps by its WHOLE lifetime.
  it("does not double-count a child it had already been billing", () => {
    // Child 101 is alive with 3s burned, all of it already reported.
    const before = procSample(0, [
      [100, 1, 10, 0],
      [101, 100, 3, 0],
    ]);
    // It ran 0.5s more, then exited and was reaped: parent banks 3.5s.
    const after = procSample(1000, [[100, 1, 10, 3.5]]);
    expect(cpu(before, after)).toBeCloseTo(0.5, 5);
  });

  it("subtracts a dead child's own child-time too, not just its self-time", () => {
    // 101 had itself reaped 4s of grandchildren, already billed.
    const before = procSample(0, [
      [100, 1, 10, 0],
      [101, 100, 3, 4],
    ]);
    // 101 exits: 3 + 4 roll up into 100, plus 0.5s of new work.
    const after = procSample(1000, [[100, 1, 10, 7.5]]);
    expect(cpu(before, after)).toBeCloseTo(0.5, 5);
  });

  // A grandchild is reaped by whichever process spawned it, so the counter
  // that moves is the intermediate's — summing only the root would miss it.
  it("counts children reaped by an intermediate process", () => {
    const before = procSample(0, [
      [100, 1, 10, 0],
      [101, 100, 3, 0],
    ]);
    const after = procSample(1000, [
      [100, 1, 10, 0],
      [101, 100, 3, 2],
    ]);
    expect(cpu(before, after)).toBeCloseTo(2, 5);
  });

  it("adds live-process CPU and reaped-child CPU in the same interval", () => {
    const before = procSample(0, [[100, 1, 10, 0]]);
    // 1s of its own work plus 2s of reaped children over 2s of wall clock.
    const after = procSample(2000, [[100, 1, 11, 2]]);
    expect(cpu(before, after)).toBeCloseTo(1.5, 5);
  });

  // A pid recycled onto a new process reads LOWER than its predecessor.
  it("clamps a counter that went backwards", () => {
    const before = procSample(0, [[100, 1, 10, 9]]);
    const after = procSample(1000, [[100, 1, 1, 0]]);
    expect(cpu(before, after)).toBe(0);
  });

  // Reparenting: the process left our tree without being reaped in it, so
  // the correction subtracts CPU that never gets added back.
  it("never reports a negative reading", () => {
    const before = procSample(0, [
      [100, 1, 10, 0],
      [101, 100, 50, 0],
    ]);
    const after = procSample(1000, [[100, 1, 10, 0]]);
    expect(cpu(before, after)).toBe(0);
  });

  // macOS: ps has no portable reaped-children column, so rows carry no
  // childCpuSeconds and the accounting stays live-process only.
  it("falls back to live-process accounting when child times are absent", () => {
    const before: ProcSample = {
      at: 0,
      rows: parsePsOutput("  100     1   50000  00:00:10"),
    };
    const after: ProcSample = {
      at: 1000,
      rows: parsePsOutput("  100     1   50000  00:00:11"),
    };
    expect(treeUsage(after, before, 100)!.cpuFraction).toBeCloseTo(1, 5);
  });
});

describe("sampleTrees", () => {
  it("reads /proc on linux, without spawning anything", async () => {
    let psCalls = 0;
    const sample = await sampleTrees([100], {
      platform: "linux",
      readDir: async () => ["100", "101"],
      readFile: async (path) => {
        if (path === "/proc/100/stat") return statLine(100, "agent", 1, 100, 0);
        if (path === "/proc/101/stat") return statLine(101, "kid", 100, 50, 0);
        if (path.endsWith("/status")) return "VmRSS:\t 1000 kB\n";
        throw new Error("ENOENT");
      },
      runPs: async () => {
        psCalls++;
        return "";
      },
    });
    expect(psCalls).toBe(0);
    expect(sample.rows.size).toBe(2);
    expect(sample.rows.get(100)!.rssBytes).toBe(1000 * 1024);
  });

  // macOS has no /proc; this is the same fallback pidusage uses there, which
  // is why reaching it doesn't warrant a dependency.
  it("falls back to ps off linux", async () => {
    let psCalls = 0;
    const sample = await sampleTrees([100], {
      platform: "darwin",
      readDir: async () => {
        throw new Error("should not read /proc");
      },
      runPs: async () => {
        psCalls++;
        return "  100     1   50000  00:00:10\n  101   100   20000  00:00:05\n";
      },
    });
    expect(psCalls).toBe(1);
    expect(sample.rows.get(100)).toMatchObject({ ppid: 1, cpuSeconds: 10 });
    expect(sample.rows.get(101)!.rssBytes).toBe(20_000 * 1024);
  });

  it("degrades to an empty table when ps is unavailable", async () => {
    const sample = await sampleTrees([100], {
      platform: "darwin",
      runPs: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(sample.rows.size).toBe(0);
    // Which makes the usage null, so callers drop the row rather than
    // showing a stale number as current.
    expect(treeUsage(sample, null, 100)).toBeNull();
  });

  // The failure this guards: the caller re-read the agent pid after
  // awaiting the sample, so the sample was taken for tree 100 and summed
  // for tree 200. Tree 200's rows exist (topology is read for every pid)
  // but their RSS was never read, so the row rendered "0B" for an agent
  // holding hundreds of megabytes.
  it("refuses to total a tree it did not read RSS for", async () => {
    const sample = await sampleTrees([100], {
      platform: "linux",
      readDir: async () => ["100", "200"],
      readFile: async (path) => {
        if (path === "/proc/100/stat") return statLine(100, "agent", 1, 100, 0);
        if (path === "/proc/200/stat") return statLine(200, "other", 1, 50, 0);
        if (path.endsWith("/status")) return "VmRSS:\t 1000 kB\n";
        throw new Error("ENOENT");
      },
    });
    expect(treeUsage(sample, null, 100)!.rssBytes).toBe(1000 * 1024);
    expect(treeUsage(sample, null, 200)).toBeNull();
  });
});
