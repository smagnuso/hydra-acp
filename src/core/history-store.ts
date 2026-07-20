import * as fs from "node:fs/promises";
import { paths } from "./paths.js";
import { externalizeToolEntry, expandToolRefs } from "./tool-content.js";
import { putToolBlob, getToolBlob, deleteToolBlobs } from "./tool-store.js";

const ARCHIVE_NAME_PATTERN = /^history\.jsonl\.(\d+)$/;

// One on-disk history.jsonl per session: the replay buffer of broadcast
// notifications captured by Session.recordAndBroadcast. The point is to
// let a session that has gone cold (idle-closed by the daemon) be
// brought back with its conversation intact — the resurrect path loads
// these entries and seeds Session.history, so a fresh client attach
// replays the prior conversation the same way it would for a hot
// session. Entries are stored after rewriteForClient, so the on-disk
// sessionId is the hydra id, not the upstream agent's.
export interface HistoryEntry {
  method: string;
  params: unknown;
  recordedAt: number;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_ARCHIVE_MAX_BYTES = 10_000_000;
const DEFAULT_ARCHIVE_TIERS = 10;

export interface HistoryStoreOptions {
  // Defensive cap applied on read: even if a file grew unbounded (older
  // daemon, manual edit), load() tails to this many entries. Mirrors the
  // compaction cap Session uses on write.
  maxEntries?: number;
  // Per-archive byte ceiling for spilled history. See config
  // sessionHistoryArchiveMaxBytes for semantics. 0 disables archiving
  // (compact reverts to silent drop of the head slice).
  archiveMaxBytes?: number;
  // Max number of history.jsonl.N archives kept per session. The oldest
  // is deleted when a new archive would push the count over this cap.
  archiveTiers?: number;
}

export class HistoryStore {
  // Serialize writes per session id so appends and rewrites don't
  // interleave JSONL lines on disk. The chain swallows errors so one
  // failed append doesn't poison every subsequent write.
  private writeQueues = new Map<string, Promise<void>>();
  private maxEntries: number;
  private archiveMaxBytes: number;
  private archiveTiers: number;
  // Cached "current archive index" per session — the file the next spill
  // should append to. Populated lazily on the first spill after process
  // start (or after resurrect) by scanning the session dir; incremented
  // in-process when the current archive fills. Unset means "haven't
  // scanned yet."
  private nextArchiveIndex = new Map<string, number>();

  constructor(options: HistoryStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.archiveMaxBytes = options.archiveMaxBytes ?? DEFAULT_ARCHIVE_MAX_BYTES;
    this.archiveTiers = options.archiveTiers ?? DEFAULT_ARCHIVE_TIERS;
  }

  async append(sessionId: string, entry: HistoryEntry): Promise<void> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return;
    }
    return this.enqueue(sessionId, async () => {
      await fs.mkdir(paths.sessionDir(sessionId), { recursive: true });
      // Offload heavy tool content to the blob store; the line written to
      // history.jsonl carries refs instead. The in-memory `entry` is not
      // mutated, so the live broadcast still sends full content.
      const stored = await externalizeToolEntry(entry, (t) =>
        putToolBlob(sessionId, t),
      );
      const line = JSON.stringify(stored) + "\n";
      await fs.appendFile(paths.historyFile(sessionId), line, {
        encoding: "utf8",
        mode: 0o600,
      });
    });
  }

  async rewrite(sessionId: string, entries: HistoryEntry[]): Promise<void> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return;
    }
    return this.enqueue(sessionId, async () => {
      await fs.mkdir(paths.sessionDir(sessionId), { recursive: true });
      // Re-externalize on rewrite so heavy content stays offloaded — this
      // also opportunistically migrates old inline entries (which arrive
      // here hydrated from load()) into the blob store.
      const stored: HistoryEntry[] = [];
      for (const e of entries) {
        stored.push(await externalizeToolEntry(e, (t) => putToolBlob(sessionId, t)));
      }
      const body =
        stored.length === 0
          ? ""
          : stored.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await fs.writeFile(paths.historyFile(sessionId), body, {
        encoding: "utf8",
        mode: 0o600,
      });
    });
  }

  // Trim the on-disk history file to the most recent maxEntries lines.
  // Runs through the same per-session write queue as append/rewrite so
  // it's safe to invoke alongside ongoing writes; a no-op if the file is
  // already at or below the cap.
  //
  // Spill semantics (when archiveMaxBytes > 0): the evicted head slice
  // is appended verbatim to the "current" archive file
  // (history.jsonl.N) before the live file is rewritten. If that
  // archive's post-append size exceeds archiveMaxBytes, the next spill
  // rolls to N+1 (byte cap is soft — a batch is never split across
  // files). Once archiveTiers archives exist and a new one is needed,
  // the oldest (lowest N) is deleted first. This is the only path in
  // the store that ever discards data; a fresh install with default
  // config keeps ~100MB of spilled history per session before the ring
  // starts turning over.
  async compact(sessionId: string, maxEntries: number): Promise<void> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return;
    }
    return this.enqueue(sessionId, async () => {
      let raw: string;
      try {
        raw = await fs.readFile(paths.historyFile(sessionId), "utf8");
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") {
          return;
        }
        throw err;
      }
      const lines = raw.split("\n").filter((l) => l.length > 0);
      if (lines.length <= maxEntries) {
        return;
      }
      const head = lines.slice(0, lines.length - maxEntries);
      const tail = lines.slice(-maxEntries);
      if (this.archiveMaxBytes > 0 && head.length > 0) {
        await this.spillToArchive(sessionId, head);
      }
      await fs.writeFile(paths.historyFile(sessionId), tail.join("\n") + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
    });
  }

  // Append the evicted head slice to the current archive. Rolls to the
  // next tier when the current archive is over the byte cap after the
  // write, and evicts the oldest archive when the tier count would
  // exceed archiveTiers. Called only from within the per-session write
  // queue (via compact), so archive index bookkeeping is race-free.
  private async spillToArchive(
    sessionId: string,
    headLines: string[],
  ): Promise<void> {
    const body = headLines.join("\n") + "\n";
    let n = await this.resolveNextArchiveIndex(sessionId);
    await this.enforceArchiveTierCap(sessionId, n);
    const archivePath = paths.historyArchiveFile(sessionId, n);
    await fs.mkdir(paths.sessionDir(sessionId), { recursive: true });
    await fs.appendFile(archivePath, body, { encoding: "utf8", mode: 0o600 });
    let size = 0;
    try {
      size = (await fs.stat(archivePath)).size;
    } catch {
      size = 0;
    }
    // Roll to N+1 on the next spill when the current archive is over cap.
    // Cap is soft: this batch has already landed intact, we only advance
    // the pointer for future spills.
    if (size >= this.archiveMaxBytes) {
      this.nextArchiveIndex.set(sessionId, n + 1);
    } else {
      this.nextArchiveIndex.set(sessionId, n);
    }
  }

  // Return the archive index the next spill should append to. On first
  // call for a session (or after a process restart) this readdirs the
  // session dir to find the highest existing archive; subsequent calls
  // are served from the in-memory cache.
  private async resolveNextArchiveIndex(sessionId: string): Promise<number> {
    const cached = this.nextArchiveIndex.get(sessionId);
    if (cached !== undefined) {
      return cached;
    }
    const existing = await this.listArchiveIndices(sessionId);
    const max = existing.length === 0 ? 0 : existing[existing.length - 1]!;
    // If the highest existing archive is already over cap, start a new
    // one; otherwise keep appending to it. This is the resurrect-safe
    // path: we don't create a fresh archive per resurrect cycle.
    let next = max === 0 ? 1 : max;
    if (max > 0) {
      try {
        const size = (await fs.stat(paths.historyArchiveFile(sessionId, max))).size;
        if (size >= this.archiveMaxBytes) {
          next = max + 1;
        }
      } catch {
        next = max;
      }
    }
    this.nextArchiveIndex.set(sessionId, next);
    return next;
  }

  // If writing to `candidateIndex` would take the archive count over
  // archiveTiers, delete the oldest archive first. Called before the
  // append so a crash between delete and append at worst loses the
  // oldest tier (which was going to die anyway).
  private async enforceArchiveTierCap(
    sessionId: string,
    candidateIndex: number,
  ): Promise<void> {
    if (this.archiveTiers <= 0) {
      return;
    }
    const existing = await this.listArchiveIndices(sessionId);
    // Post-write count: existing archives plus `candidateIndex` itself
    // when it's new. If we'd be appending to an existing archive the
    // count doesn't grow, so nothing to evict.
    const wouldExist = existing.includes(candidateIndex)
      ? existing.length
      : existing.length + 1;
    let overBy = wouldExist - this.archiveTiers;
    let i = 0;
    while (overBy > 0 && i < existing.length) {
      const victim = existing[i]!;
      // Never evict the archive we're about to write to.
      if (victim !== candidateIndex) {
        try {
          await fs.unlink(paths.historyArchiveFile(sessionId, victim));
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code !== "ENOENT") {
            throw err;
          }
        }
        overBy -= 1;
      }
      i += 1;
    }
  }

  // Read the session dir once and return archive suffix numbers in
  // ascending order (oldest first). Empty when the dir doesn't exist
  // or contains no archives.
  private async listArchiveIndices(sessionId: string): Promise<number[]> {
    let names: string[];
    try {
      names = await fs.readdir(paths.sessionDir(sessionId));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return [];
      }
      throw err;
    }
    const out: number[] = [];
    for (const name of names) {
      const m = ARCHIVE_NAME_PATTERN.exec(name);
      if (!m) {
        continue;
      }
      const n = Number.parseInt(m[1]!, 10);
      if (Number.isFinite(n) && n > 0) {
        out.push(n);
      }
    }
    out.sort((a, b) => a - b);
    return out;
  }

  // Enumerate the archive files for a session, oldest to newest by
  // suffix. Exposed so callers (recall MCP, forensic tooling) can walk
  // spilled history without duplicating the readdir logic. Paths are
  // absolute; entries can be parsed as JSONL, one HistoryEntry per line.
  async listArchives(sessionId: string): Promise<Array<{ index: number; path: string }>> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return [];
    }
    const indices = await this.listArchiveIndices(sessionId);
    return indices.map((index) => ({
      index,
      path: paths.historyArchiveFile(sessionId, index),
    }));
  }

  // Load every archived entry for a session in chronological order
  // (oldest tier first, each file top-to-bottom). Sibling of load()
  // for callers that specifically want the spilled tail rather than
  // the live working set. Malformed lines are skipped, mirroring
  // load(). Tool refs are left as-is (call expandToolRefs downstream
  // if you need inline content); most archive walks are search/scan
  // shaped and don't benefit from eager hydration.
  async loadArchives(sessionId: string): Promise<HistoryEntry[]> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return [];
    }
    const pending = this.writeQueues.get(sessionId);
    if (pending) {
      await pending;
    }
    const archives = await this.listArchives(sessionId);
    const out: HistoryEntry[] = [];
    for (const { path: filePath } of archives) {
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf8");
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") {
          continue;
        }
        throw err;
      }
      for (const line of raw.split("\n")) {
        if (line.length === 0) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          continue;
        }
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.method !== "string") {
          continue;
        }
        if (typeof obj.recordedAt !== "number") {
          continue;
        }
        out.push({
          method: obj.method,
          params: obj.params,
          recordedAt: obj.recordedAt,
        });
      }
    }
    return out;
  }

  // `tools` selects how externalized tool content is materialized:
  //   "inline" (default) — expand blob refs back to full content, so every
  //                        consumer sees the original recorded shape.
  //   "references"       — leave references in place (the lean form) for
  //                        clients that fetch tool content on demand.
  async load(
    sessionId: string,
    opts: {
      tools?: "inline" | "references";
      // Override the store's default per-load entry cap. Compaction
      // passes Infinity so it sees every entry on disk and can detect
      // growth past the last summarization watermark; consumers that
      // only care about recent history (TUI replay etc.) accept the
      // default cap.
      maxEntries?: number;
    } = {},
  ): Promise<HistoryEntry[]> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return [];
    }
    const expand = (opts.tools ?? "inline") === "inline";
    // Drain any pending writes so the read sees the latest contents.
    // We don't enqueue the read itself — appending happens concurrently
    // with reads in the wild (the read snapshot is consistent regardless),
    // but a race between an in-flight append and a load could otherwise
    // miss the just-written entry.
    const pending = this.writeQueues.get(sessionId);
    if (pending) {
      await pending;
    }
    let raw: string;
    try {
      raw = await fs.readFile(paths.historyFile(sessionId), "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return [];
      }
      throw err;
    }
    const out: HistoryEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.method !== "string") {
        continue;
      }
      if (typeof obj.recordedAt !== "number") {
        continue;
      }
      out.push({
        method: obj.method,
        params: obj.params,
        recordedAt: obj.recordedAt,
      });
    }
    const effectiveCap = opts.maxEntries ?? this.maxEntries;
    const kept =
      out.length > effectiveCap ? out.slice(-effectiveCap) : out;
    if (!expand) {
      return kept;
    }
    // Expand refs back to inline content, caching blob reads so an agent's
    // repeated (deduped) content is read from disk once per load.
    const blobCache = new Map<string, string | null>();
    const get = async (hash: string): Promise<string | null> => {
      const cached = blobCache.get(hash);
      if (cached !== undefined) {
        return cached;
      }
      const value = await getToolBlob(sessionId, hash);
      blobCache.set(hash, value);
      return value;
    };
    const inlined: HistoryEntry[] = [];
    for (const entry of kept) {
      inlined.push(await expandToolRefs(entry, get));
    }
    return inlined;
  }

  // Wait for every pending append/rewrite/compact across all sessions to
  // settle. Daemon shutdown calls this after closing sessions so the final
  // turn_complete(interrupted) emitted by markClosed reaches disk before
  // the process exits — without this, history-replay attaches after a
  // restart see an unmatched prompt_received and leak pendingTurns on
  // every client.
  async flushAll(): Promise<void> {
    const pending = [...this.writeQueues.values()];
    if (pending.length === 0) {
      return;
    }
    await Promise.allSettled(pending);
  }

  async delete(sessionId: string): Promise<void> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return;
    }
    return this.enqueue(sessionId, async () => {
      try {
        await fs.unlink(paths.historyFile(sessionId));
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ENOENT") {
          throw err;
        }
      }
      // Sweep any spill archives too; missing files are fine (best-effort
      // cleanup mirrors the live-file path above).
      const archives = await this.listArchiveIndices(sessionId);
      for (const n of archives) {
        try {
          await fs.unlink(paths.historyArchiveFile(sessionId, n));
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code !== "ENOENT") {
            throw err;
          }
        }
      }
      this.nextArchiveIndex.delete(sessionId);
      // Drop the externalized tool blobs alongside the history file.
      await deleteToolBlobs(sessionId);
      // Best-effort cleanup: if no other tenant (meta.json, etc.) is
      // left in the session dir, drop it. Both this and
      // SessionStore.delete attempt this; whichever runs last is the
      // one that succeeds.
      try {
        await fs.rmdir(paths.sessionDir(sessionId));
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ENOENT" && e.code !== "ENOTEMPTY") {
          throw err;
        }
      }
    });
  }

  private enqueue(
    sessionId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const prev = this.writeQueues.get(sessionId) ?? Promise.resolve();
    // Run the task whether the previous one resolved or rejected, so a
    // single failing write doesn't deadlock the queue.
    const task$ = prev.then(task, task);
    const settled = task$.catch(() => undefined);
    this.writeQueues.set(sessionId, settled);
    void settled.finally(() => {
      if (this.writeQueues.get(sessionId) === settled) {
        this.writeQueues.delete(sessionId);
      }
    });
    return task$;
  }
}
