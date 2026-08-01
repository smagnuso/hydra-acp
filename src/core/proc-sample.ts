// Process-tree resource sampling: RSS and CPU% for a pid and all its
// descendants.
//
// Why a tree and not a single process: an agent is rarely one process. It
// spawns shells, language servers, MCP servers and other helpers, and the
// interesting number is what the agent costs you in total. Same for the
// daemon, which owns every agent.
//
// Sampling strategy, in order of preference:
//
//   1. THIS process — `process.memoryUsage.rss()` + `process.cpuUsage()`.
//      Exact, in-process, free. Never sample ourselves externally: doing it
//      by shelling out means the sampler is our own child, so it lands in
//      our tree and charges its cost to us. The monitor measured itself.
//   2. Another tree on Linux — read `/proc` directly. No process creation
//      at all, which matters more than it sounds: forking from a process
//      with a large heap, every few seconds, to read a table the kernel
//      will hand us as files is pure waste.
//   3. Another tree anywhere else — `ps`, parsed here. macOS has no
//      `/proc`, so this is the fallback rather than the default.
//
// COST. This runs every few seconds for the life of a TUI, so the naive
// implementation is not good enough. Measured on a 940-process box, per
// sample of two agent trees (8 processes between them):
//
//   full /proc scan, async fs      124.0ms cpu     ← the obvious version
//   tree walk, async fs             10.1ms cpu
//   tree walk, sync fs               1.1ms cpu     ← what this module does
//
// Two independent factors, both worth understanding before changing this:
//
//   TOPOLOGY. Reading all 940 `stat` files to discover which 8 are in the
//   tree is 100x more work than asking. `/proc/<pid>/task/<tid>/children`
//   names a thread's children directly, so the tree can be walked from its
//   root touching only its own nodes. It needs CONFIG_PROC_CHILDREN, which
//   is near-universal but not guaranteed — sampleTrees falls back to the
//   full scan when the file isn't there.
//
//   SYNC IO. Async `fs` costs ~130us per tiny /proc file against ~10us
//   sync: the threadpool handoff dwarfs the read. The usual "never block
//   the event loop" rule is about waiting on hardware, and procfs has none
//   — the kernel generates these bytes on read, so there is nothing to wait
//   for. Blocking for ~1ms every few seconds is cheaper than a repaint.
//   The injectable deps stay async-COMPATIBLE (they may return a promise or
//   a value) so tests can keep using async fakes.
//
// CPU is computed from CUMULATIVE cpu-time deltas between two samples, not
// from `ps`'s own `%cpu` column. That column reports an average over the
// process's whole lifetime on Linux (and a decaying average on macOS), so a
// long-lived agent that is currently idle would still read high — actively
// misleading for a live monitor. Delta-over-elapsed is a real interval
// measurement.
//
// On Linux that delta also picks up descendants that lived and died between
// two samples, via the kernel's reaped-children counters. Polling alone
// cannot see a 40ms `rg`, and an agent that shells out for everything spends
// most of its CPU in exactly those processes — without this the tree reads
// near 0% while genuinely busy. macOS has no portable equivalent through
// `ps`, so that path measures live processes only and under-reports a
// subprocess-heavy tree.

import { readdirSync, readFileSync } from "node:fs";

export interface ProcRow {
  pid: number;
  ppid: number;
  // Resident set size in bytes. Zero until filled: the /proc sampler reads
  // topology first and RSS only for the pids that end up in a sampled tree.
  rssBytes: number;
  // Cumulative CPU time consumed since the process started, in seconds.
  cpuSeconds: number;
  // Cumulative CPU time consumed by this process's REAPED children, in
  // seconds, recursively (a reaped child's own child-time rolls up into its
  // parent's). This is the only way to see processes that live and die
  // between two samples: polling can't catch a 40ms `rg`, but the kernel
  // banks its cost here the moment it's waited on, and it stays banked.
  //
  // Undefined when the sampler can't supply it — `ps` has no portable
  // column for it, so the non-Linux path leaves it out and treeUsage falls
  // back to live-process accounting alone.
  childCpuSeconds?: number;
}

export interface ProcTreeUsage {
  // Processes in the tree, including the root.
  processes: number;
  rssBytes: number;
  // Share of ONE core, as a fraction: 1.0 means one core saturated. A tree
  // can exceed 1.0 across multiple cores, and is deliberately not clamped —
  // "300%" is real and worth seeing. Undefined on the first sample, when
  // there's no previous reading to difference against.
  cpuFraction?: number;
}

export interface ProcSample {
  at: number;
  rows: Map<number, ProcRow>;
  // Pids whose rssBytes was actually read. The /proc sampler only reads RSS
  // for the trees it was asked about, so a row outside those trees carries a
  // placeholder 0 rather than a measurement — indistinguishable from a real
  // zero unless the sample says which is which. Absent on the ps path, where
  // every row's RSS comes from the same output.
  rssKnown?: Set<number>;
}

// Linux exposes CPU time in USER_HZ units, which the kernel fixes at 100
// for /proc regardless of the configured tick rate. Node exposes no
// sysconf(), so this is assumed rather than queried — it is part of the
// /proc ABI, not a build-time detail.
const USER_HZ = 100;

// Parse one /proc/<pid>/stat line into topology + cumulative CPU.
//
// Field 2 is the executable name wrapped in parentheses, and it can contain
// BOTH spaces and parentheses ("(Web Content)", "(foo) bar"). Splitting on
// whitespace is therefore wrong — the standard fix is to slice after the
// LAST ')' and index from there.
export function parseProcStat(content: string): ProcRow | null {
  const close = content.lastIndexOf(")");
  if (close === -1) {
    return null;
  }
  const pid = Number(content.slice(0, content.indexOf(" ")));
  // Fields after comm: state(3) ppid(4) ... utime(14) stime(15) cutime(16)
  // cstime(17). Field n is at rest[n - 3].
  const rest = content.slice(close + 2).split(" ");
  const ppid = Number(rest[1]);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const cutime = Number(rest[13]);
  const cstime = Number(rest[14]);
  if (
    !Number.isInteger(pid) ||
    !Number.isInteger(ppid) ||
    !Number.isFinite(utime) ||
    !Number.isFinite(stime)
  ) {
    return null;
  }
  // Child times are additive extra, not load-bearing: a truncated line
  // still yields usable self-CPU, so a missing pair degrades to the
  // live-process-only accounting rather than dropping the row.
  const childCpuSeconds =
    Number.isFinite(cutime) && Number.isFinite(cstime)
      ? (cutime + cstime) / USER_HZ
      : undefined;
  return {
    pid,
    ppid,
    // RSS is filled in later from /proc/<pid>/status, which reports it in
    // explicit kB. stat's rss field is in PAGES, and Node exposes no page
    // size — assuming 4K would be wrong on a 16K-page arm64 kernel.
    rssBytes: 0,
    cpuSeconds: (utime + stime) / USER_HZ,
    ...(childCpuSeconds === undefined ? {} : { childCpuSeconds }),
  };
}

// VmRSS from /proc/<pid>/status, in bytes. Null when absent (kernel threads
// have no VmRSS line).
export function parseVmRss(content: string): number | null {
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(content);
  if (match === null) {
    return null;
  }
  const kb = Number(match[1]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

// CPU share of one core for THIS process, from Node's own counters.
export function selfCpuFraction(
  current: NodeJS.CpuUsage,
  previous: NodeJS.CpuUsage | null,
  elapsedMs: number,
): number | undefined {
  if (previous === null || elapsedMs <= 0) {
    return undefined;
  }
  const deltaMicros =
    current.user - previous.user + (current.system - previous.system);
  return Math.max(0, deltaMicros / 1000 / elapsedMs);
}

// Parse `ps -A -o pid=,ppid=,rss=,time=` output.
//
// Tolerant by construction: this is scraped text from a program whose exact
// column formatting varies by platform, so an unparseable line is skipped
// rather than throwing. Losing one row degrades a diagnostic readout; a
// throw would take down the caller's poll loop.
export function parsePsOutput(stdout: string): Map<number, ProcRow> {
  const rows = new Map<number, ProcRow>();
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) {
      continue;
    }
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rssKb = Number(parts[2]);
    const cpuSeconds = parseCpuTime(parts[3]!);
    if (
      !Number.isInteger(pid) ||
      !Number.isInteger(ppid) ||
      !Number.isFinite(rssKb) ||
      cpuSeconds === null
    ) {
      continue;
    }
    // ps reports RSS in kilobytes on both Linux and macOS.
    rows.set(pid, { pid, ppid, rssBytes: rssKb * 1024, cpuSeconds });
  }
  return rows;
}

// ps TIME formats: "MM:SS", "MM:SS.CC", "HH:MM:SS", "D-HH:MM:SS", and macOS
// occasionally "H:MM.SS". Returns null when the field isn't a duration.
export function parseCpuTime(field: string): number | null {
  let rest = field;
  let days = 0;
  const dash = rest.indexOf("-");
  if (dash !== -1) {
    // Must be "<days>-<clock>": a leading dash means the field is negative
    // (or otherwise malformed), and Number("") is 0, so an emptiness check
    // is required or "-1:00" would parse as 0 days + 60 seconds.
    const daysPart = rest.slice(0, dash);
    if (daysPart.length === 0) {
      return null;
    }
    days = Number(daysPart);
    rest = rest.slice(dash + 1);
    if (!Number.isInteger(days) || days < 0) {
      return null;
    }
  }
  const parts = rest.split(":");
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }
  let seconds = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value) || value < 0) {
      return null;
    }
    seconds = seconds * 60 + value;
  }
  return days * 86_400 + seconds;
}

// Every pid in the tree rooted at `root`, root included.
//
// Guards against cycles. A parent/child cycle shouldn't be possible in a
// real process table, but this parses untrusted-ish scraped text and a
// malformed row pair would otherwise hang the walk.
export function collectTree(
  rows: Map<number, ProcRow>,
  root: number,
): Set<number> {
  const children = new Map<number, number[]>();
  for (const row of rows.values()) {
    const list = children.get(row.ppid);
    if (list === undefined) {
      children.set(row.ppid, [row.pid]);
    } else {
      list.push(row.pid);
    }
  }
  const seen = new Set<number>();
  if (!rows.has(root)) {
    return seen;
  }
  const stack = [root];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    for (const child of children.get(pid) ?? []) {
      if (!seen.has(child)) {
        stack.push(child);
      }
    }
  }
  return seen;
}

// Sum a tree's usage, differencing CPU against a previous sample.
//
// Live processes are differenced pid by pid: a process present in BOTH
// samples contributes the growth in its own cpuSeconds. A process that
// appeared during the interval has no baseline, and treating its whole
// lifetime CPU as interval usage would spike the reading (a fresh `bash -c`
// would read as hundreds of percent), so its CPU waits for the next
// interval. Its RSS still counts — that's a point-in-time measure and needs
// no baseline.
//
// That alone systematically UNDER-reports, because it can only see what
// polling catches. An agent that shells out constantly spends its CPU in
// processes that are born and reaped between two 5s samples: never in two
// consecutive samples, so never counted, and a genuinely busy tree reads
// near 0%. The reaped-children counters (ProcRow.childCpuSeconds) close
// that: the kernel banks a child's cost on its parent at reap time,
// whatever the child's lifetime. See reapedChildDelta for the correction
// that keeps it from double-counting.
//
// Returns null when the sample doesn't carry RSS for the whole tree, which
// means it was taken for a DIFFERENT root than the one being summed. No
// reading is better than the alternative: unread rows hold a placeholder 0,
// so the tree would total 0B and look like a live agent using no memory.
export function treeUsage(
  current: ProcSample,
  previous: ProcSample | null,
  root: number,
): ProcTreeUsage | null {
  const tree = collectTree(current.rows, root);
  if (tree.size === 0) {
    return null;
  }
  let rssBytes = 0;
  let cpuDelta = 0;
  let comparable = false;
  for (const pid of tree) {
    if (current.rssKnown !== undefined && !current.rssKnown.has(pid)) {
      return null;
    }
    const row = current.rows.get(pid)!;
    rssBytes += row.rssBytes;
    const before = previous?.rows.get(pid);
    if (before !== undefined) {
      comparable = true;
      // Clamp: cpuSeconds is monotonic per process, but a recycled pid
      // could read lower than its predecessor.
      cpuDelta += Math.max(0, row.cpuSeconds - before.cpuSeconds);
    }
  }
  if (comparable && previous !== null) {
    cpuDelta += reapedChildDelta(current, previous, tree, root);
  }
  const usage: ProcTreeUsage = { processes: tree.size, rssBytes };
  const elapsedMs = previous === null ? 0 : current.at - previous.at;
  if (comparable && elapsedMs > 0) {
    // Clamped: the correction below can overshoot when a process leaves the
    // tree without being reaped inside it, and a negative "CPU used" is
    // never a reading worth showing.
    usage.cpuFraction = Math.max(0, cpuDelta) / (elapsedMs / 1000);
  }
  return usage;
}

// CPU consumed during the interval by descendants that DIED during it,
// which the live-process pass cannot see.
//
// Two terms:
//
//   + the growth in every surviving tree member's reaped-children counter.
//     Summed over all live members, not just the root: a grandchild is
//     reaped by whichever process spawned it, so its cost sits there until
//     that process itself dies and rolls up.
//
//   − everything already billed for each pid that was in the tree last
//     sample and is gone now: its own CPU (charged by the live pass) plus
//     its own reaped-children time (charged by the term above). Without
//     this we double-count, because the parent's counter jumps by the dead
//     process's ENTIRE lifetime — self and descendants both — at reap.
//     Subtracting what we already billed leaves exactly the sliver it
//     burned between the last sample and its exit.
//
// A child that lived and died entirely between two samples was never
// billed, so nothing is subtracted for it and its full cost lands in the
// interval it died in — which is the only interval we could have learned
// about it at all.
//
// Returns 0 when the sampler doesn't supply child times (the `ps` path),
// leaving the live-process accounting exactly as it was.
function reapedChildDelta(
  current: ProcSample,
  previous: ProcSample,
  tree: Set<number>,
  root: number,
): number {
  let delta = 0;
  let known = false;
  for (const pid of tree) {
    const now = current.rows.get(pid)!.childCpuSeconds;
    const before = previous.rows.get(pid)?.childCpuSeconds;
    if (now === undefined || before === undefined) {
      continue;
    }
    known = true;
    // Same recycled-pid clamp as the live pass.
    delta += Math.max(0, now - before);
  }
  if (!known) {
    return 0;
  }
  for (const pid of collectTree(previous.rows, root)) {
    if (tree.has(pid)) {
      continue;
    }
    const gone = previous.rows.get(pid);
    // Only correct for pids from a source that tracks child time; a row
    // without it was never part of this accounting.
    if (gone !== undefined && gone.childCpuSeconds !== undefined) {
      delta -= gone.cpuSeconds + gone.childCpuSeconds;
    }
  }
  return delta;
}

// ── samplers ─────────────────────────────────────────────────────────────

// IO the samplers need. Values may be returned directly or as promises:
// production passes the synchronous fs calls (see the COST note at the top
// of this file), tests pass async fakes, and `await` accepts both.
type ReadDir = (path: string) => Promise<string[]> | string[];
type ReadFile = (path: string) => Promise<string> | string;

// Direct children of `pid`, from /proc/<pid>/task/<tid>/children.
//
// Unioned over every thread, not just the main one: `children` is a
// per-THREAD file, and a process that spawns from a worker thread would
// otherwise have that subtree silently missing. Costs one small read per
// thread, which is still a rounding error next to scanning /proc.
//
// Throws only when the children FILE is unavailable on the root itself,
// which sampleTrees uses to detect a kernel without CONFIG_PROC_CHILDREN.
// A thread that exits mid-walk is normal and skipped.
export async function readChildPids(
  pid: number,
  readDir: ReadDir,
  readFile: ReadFile,
): Promise<number[]> {
  const out: number[] = [];
  let tids: string[];
  try {
    tids = await readDir(`/proc/${pid}/task`);
  } catch {
    // The process exited between being named as a child and being walked.
    return out;
  }
  for (const tid of tids) {
    if (!/^\d+$/.test(tid)) {
      continue;
    }
    let text: string;
    try {
      text = await readFile(`/proc/${pid}/task/${tid}/children`);
    } catch {
      continue;
    }
    for (const token of text.split(/\s+/)) {
      if (token.length === 0) {
        continue;
      }
      const child = Number(token);
      if (Number.isInteger(child) && child > 0) {
        out.push(child);
      }
    }
  }
  return out;
}

// Walk the trees rooted at `roots`, reading only their own nodes.
//
// Returns null when the kernel doesn't expose `children` at all, so the
// caller can fall back to the full scan rather than silently reporting a
// one-process tree for an agent that has spawned a dozen.
export async function sampleProcTree(
  roots: readonly number[],
  readDir: ReadDir,
  readFile: ReadFile,
): Promise<Map<number, ProcRow> | null> {
  const rows = new Map<number, ProcRow>();
  const seen = new Set<number>();
  for (const root of roots) {
    if (seen.has(root)) {
      continue;
    }
    // Probe the root before walking: distinguishes "no such feature" from
    // "no children". A root that has exited is not evidence either way, so
    // it's skipped rather than treated as a missing feature.
    let rootStat: string;
    try {
      rootStat = await readFile(`/proc/${root}/stat`);
    } catch {
      continue;
    }
    try {
      await readFile(`/proc/${root}/task/${root}/children`);
    } catch {
      return null;
    }
    const rootRow = parseProcStat(rootStat);
    if (rootRow === null) {
      continue;
    }
    rows.set(root, rootRow);
    seen.add(root);
    const stack = [root];
    while (stack.length > 0) {
      const pid = stack.pop()!;
      for (const child of await readChildPids(pid, readDir, readFile)) {
        if (seen.has(child)) {
          continue;
        }
        seen.add(child);
        let row: ProcRow | null;
        try {
          row = parseProcStat(await readFile(`/proc/${child}/stat`));
        } catch {
          // Exited mid-walk; its CPU is already banked on its parent's
          // reaped-children counter, so nothing is lost by skipping it.
          continue;
        }
        if (row !== null) {
          rows.set(child, row);
          stack.push(child);
        }
      }
    }
  }
  return rows;
}

// Read every process's topology + CPU from /proc. One readdir plus one small
// file read per process, no process creation.
//
// RSS is deliberately NOT filled here: it needs a second file per process
// (/proc/<pid>/status, for explicit kB), and only the handful of pids in the
// trees we care about need it. fillRssBytes does that pass.
export async function sampleProcfs(
  readDir: ReadDir,
  readFile: ReadFile,
): Promise<Map<number, ProcRow>> {
  const rows = new Map<number, ProcRow>();
  let entries: string[];
  try {
    entries = await readDir("/proc");
  } catch {
    return rows;
  }
  await Promise.all(
    entries.map(async (entry) => {
      // Numeric entries are pids; everything else in /proc is not a process.
      if (!/^\d+$/.test(entry)) {
        return;
      }
      try {
        const row = parseProcStat(await readFile(`/proc/${entry}/stat`));
        if (row !== null) {
          rows.set(row.pid, row);
        }
      } catch {
        // The process exited between readdir and read. Normal; skip it.
      }
    }),
  );
  return rows;
}

// Fill in RSS for just the given pids, from /proc/<pid>/status.
export async function fillRssBytes(
  rows: Map<number, ProcRow>,
  pids: Iterable<number>,
  readFile: ReadFile,
): Promise<void> {
  for (const pid of pids) {
    const row = rows.get(pid);
    if (row === undefined) {
      continue;
    }
    try {
      const rss = parseVmRss(await readFile(`/proc/${pid}/status`));
      if (rss !== null) {
        row.rssBytes = rss;
      }
    } catch {
      // Exited mid-sample; leave rssBytes at 0 rather than dropping the
      // process, since its CPU delta is still meaningful.
    }
  }
}

// Platform-dispatched sample of the trees rooted at `roots`.
//
// Linux reads /proc; everything else shells out to `ps` once. That fallback
// is the same thing `pidusage` does on macOS, which is why this doesn't
// carry a dependency to reach it — and unlike ps's own `%cpu` column, both
// paths here difference cumulative CPU time, so a long-idle process reads as
// idle on both.
//
// RESOLUTION CAVEAT. `ps -o time` on Linux truncates to whole seconds
// (measured: /proc reports 3471.41s where ps reports 3471s for the same
// pid), so per-process CPU deltas over a few seconds quantize to 0 or 1 —
// enough to read 0% for a tree that is genuinely busy. That is why Linux
// uses /proc rather than treating ps as good enough everywhere. macOS ps
// reports centiseconds (`MM:SS.CC`, which parseCpuTime handles), so the
// platform that actually takes this path has usable resolution — though
// that is from pidusage's parser and macOS documentation, not measured
// here. If a macOS reading looks quantized, lengthening the baseline (
// differencing against a sample several ticks back instead of the previous
// one) is the fix, not switching to %cpu.
//
// Injectable IO so both paths are testable without a process table.
export interface SampleDeps {
  platform?: string;
  readDir?: ReadDir;
  readFile?: ReadFile;
  runPs?: () => Promise<string>;
}

export async function sampleTrees(
  roots: readonly number[],
  deps: SampleDeps = {},
): Promise<ProcSample> {
  const platform = deps.platform ?? process.platform;
  const at = Date.now();
  if (platform === "linux") {
    const readDir = deps.readDir ?? ((path: string) => readdirSync(path));
    const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
    // Preferred path: touch only the trees asked for.
    const walked = await sampleProcTree(roots, readDir, readFile);
    const rows = walked ?? (await sampleProcfs(readDir, readFile));
    // The walk already produced exactly the tree; the fallback produced
    // everything and has to be filtered down to it.
    const wanted = new Set<number>();
    if (walked !== null) {
      for (const pid of rows.keys()) {
        wanted.add(pid);
      }
    } else {
      for (const root of roots) {
        for (const pid of collectTree(rows, root)) {
          wanted.add(pid);
        }
      }
    }
    await fillRssBytes(rows, wanted, readFile);
    return { at, rows, rssKnown: wanted };
  }
  const runPs =
    deps.runPs ??
    (async () => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout } = await promisify(execFile)(
        "ps",
        ["-A", "-o", "pid=,ppid=,rss=,time="],
        { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
      );
      return stdout;
    });
  try {
    return { at, rows: parsePsOutput(await runPs()) };
  } catch {
    // No ps, or it timed out. An empty table makes treeUsage return null,
    // which drops the rows rather than showing stale numbers as current.
    return { at, rows: new Map() };
  }
}
