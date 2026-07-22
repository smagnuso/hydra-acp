import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createGunzip, gzip as gzipCb, gunzip as gunzipCb } from "node:zlib";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { paths } from "./paths.js";
import { externalizeToolEntry, expandToolRefs } from "./tool-content.js";
import { putToolBlob, getToolBlob, deleteToolBlobs } from "./tool-store.js";

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

// Matches both the plain (currently-writable) and gzipped (sealed on
// roll) archive filenames. Group 1 = index, group 2 = ".gz" or "".
const ARCHIVE_NAME_PATTERN = /^history\.jsonl\.(\d+)(\.gz)?$/;

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

export interface ArchiveLineCount {
  index: number;
  path: string;
  lineCount: number;
}

// One entry yielded by the recall iterator: the entry itself plus its
// stable global id in the archives-first concatenated view. Callers
// (recall MCP tools) return entryId to the agent so a follow-up
// range() can address the same entry.
export interface RecallEntry {
  entryId: number;
  entry: HistoryEntry;
}

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
  // Cached line counts per sealed/growing archive, populated on first
  // touch and reused for entry-id math and range() targeting. Sealed
  // (.gz) archives are immutable so their counts are permanent; the
  // currently-writable archive's count is refreshed on every spill
  // (spillToArchive updates it in-place). Invalidated wholesale when
  // new archives are created or when the store is reconstructed.
  private archiveLineCounts = new Map<string, ArchiveLineCount[]>();

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
  //
  // Seal-on-roll: when the current archive crosses archiveMaxBytes, it
  // is gzipped in place (`history.jsonl.N` → `history.jsonl.N.gz`) and
  // the plain file unlinked, before the pointer advances to N+1. JSONL
  // compresses ~5-10x on realistic session traffic, so sealed archives
  // take a fraction of the byte cap on disk. The currently-writable
  // archive stays plain-text (you can't cleanly append to a gzip stream
  // and the append-only property is worth more than the last tier's
  // compression). Recovery-safe: if a crash happens between gzip-write
  // and plain-unlink, the reader prefers `.gz` and the stale plain file
  // is cleaned up on the next spill's tier sweep.
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
      await this.sealArchive(sessionId, n);
      this.nextArchiveIndex.set(sessionId, n + 1);
    } else {
      this.nextArchiveIndex.set(sessionId, n);
    }
    // Both a fresh spill (current archive grew) and a seal-plus-roll
    // (path .N → .N.gz + new .N+1) invalidate any cached line counts
    // for this session. Drop the cache; the next reader repopulates.
    this.archiveLineCounts.delete(sessionId);
  }

  // Compress `history.jsonl.N` in place: write the .gz alongside, fsync
  // via close, then unlink the plain file. Idempotent — if a stale .gz
  // is already present (crash between roll and this call), it's
  // overwritten with the current plain contents. Silent no-op if the
  // plain file has vanished for any reason.
  private async sealArchive(sessionId: string, n: number): Promise<void> {
    const plainPath = paths.historyArchiveFile(sessionId, n);
    let raw: Buffer;
    try {
      raw = await fs.readFile(plainPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return;
      }
      throw err;
    }
    const compressed = await gzip(raw);
    await fs.writeFile(plainPath + ".gz", compressed, { mode: 0o600 });
    try {
      await fs.unlink(plainPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        throw err;
      }
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
    // If the highest existing archive is already sealed (present as .gz)
    // or over cap in plain form, roll to N+1 on the next spill. Sealed
    // archives are by definition full — that's why they were sealed —
    // so appending to them would be doubly wrong (can't append to gzip,
    // and we'd blow past the cap the seal was meant to lock in).
    let next = max === 0 ? 1 : max;
    if (max > 0) {
      const plainPath = paths.historyArchiveFile(sessionId, max);
      const gzPath = plainPath + ".gz";
      let sealed = false;
      try {
        await fs.access(gzPath);
        sealed = true;
      } catch {
        sealed = false;
      }
      if (sealed) {
        next = max + 1;
      } else {
        try {
          const size = (await fs.stat(plainPath)).size;
          if (size >= this.archiveMaxBytes) {
            next = max + 1;
          }
        } catch {
          next = max;
        }
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
        await this.unlinkArchive(sessionId, victim);
        overBy -= 1;
      }
      i += 1;
    }
  }

  // Delete both variants of an archive index (plain and .gz). Either
  // may be absent; only the "still there after we tried" case is an
  // error.
  private async unlinkArchive(sessionId: string, n: number): Promise<void> {
    const plainPath = paths.historyArchiveFile(sessionId, n);
    for (const p of [plainPath, plainPath + ".gz"]) {
      try {
        await fs.unlink(p);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ENOENT") {
          throw err;
        }
      }
    }
    this.archiveLineCounts.delete(sessionId);
  }

  // Read the session dir once and return archive suffix numbers in
  // ascending order (oldest first). Deduplicated across the plain and
  // .gz variants — if both `history.jsonl.5` and `history.jsonl.5.gz`
  // are present (crash between seal-write and plain-unlink), the index
  // 5 appears once and the .gz form is preferred by listArchives.
  // Empty when the dir doesn't exist or contains no archives.
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
    const seen = new Set<number>();
    for (const name of names) {
      const m = ARCHIVE_NAME_PATTERN.exec(name);
      if (!m) {
        continue;
      }
      const n = Number.parseInt(m[1]!, 10);
      if (Number.isFinite(n) && n > 0) {
        seen.add(n);
      }
    }
    return [...seen].sort((a, b) => a - b);
  }

  // Enumerate the archive files for a session, oldest to newest by
  // suffix. Exposed so callers (recall MCP, forensic tooling) can walk
  // spilled history without duplicating the readdir logic. `path` points
  // at the .gz variant when present (sealed archives), otherwise the
  // plain file (the still-writable current tier). Entries in either form
  // are JSONL, one HistoryEntry per line — readers should gunzip when
  // the path ends in .gz.
  async listArchives(sessionId: string): Promise<Array<{ index: number; path: string }>> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return [];
    }
    const indices = await this.listArchiveIndices(sessionId);
    const out: Array<{ index: number; path: string }> = [];
    for (const index of indices) {
      const plainPath = paths.historyArchiveFile(sessionId, index);
      const gzPath = plainPath + ".gz";
      let usePath = plainPath;
      try {
        await fs.access(gzPath);
        usePath = gzPath;
      } catch {
        usePath = plainPath;
      }
      out.push({ index, path: usePath });
    }
    return out;
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
        if (filePath.endsWith(".gz")) {
          const buf = await fs.readFile(filePath);
          raw = (await gunzip(buf)).toString("utf8");
        } else {
          raw = await fs.readFile(filePath, "utf8");
        }
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

  // Stream a single history file (plain or .gz) as an async iterator of
  // parsed HistoryEntry objects. Decompression, if any, happens in ~64KB
  // chunks flowing through zlib.createGunzip → readline; peak RAM per
  // file is a couple of chunks regardless of the file's uncompressed
  // size. Consumers that early-exit (break out of the for-await loop)
  // close the underlying stream through readline's own teardown, so
  // partial reads pay only for the bytes they consumed. Malformed
  // lines are skipped silently, matching load() and loadArchives().
  async *streamFile(filePath: string): AsyncGenerator<HistoryEntry> {
    let readStream: ReturnType<typeof createReadStream>;
    try {
      readStream = createReadStream(filePath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return;
      }
      throw err;
    }
    // The read stream may not error until the first read; wrap with a
    // one-shot check via an event listener so an ENOENT surfaces as a
    // clean early return rather than an unhandled event.
    const missing = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (v: boolean) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      readStream.once("error", (err) => {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") {
          done(true);
        } else {
          readStream.destroy();
          done(false);
        }
      });
      readStream.once("readable", () => done(false));
      readStream.once("end", () => done(false));
    });
    if (missing) {
      return;
    }
    const source = filePath.endsWith(".gz")
      ? readStream.pipe(createGunzip())
      : readStream;
    const rl = createInterface({ input: source, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
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
        yield {
          method: obj.method,
          params: obj.params,
          recordedAt: obj.recordedAt,
        };
      }
    } finally {
      rl.close();
      readStream.destroy();
    }
  }

  // Return per-archive line counts, populating the cache on first
  // touch. The cache is invalidated on spill (spillToArchive) and on
  // seal (sealArchive) so callers always see a snapshot consistent
  // with the on-disk state at call time. Sealed archives are
  // immutable so their counts, once measured, never change; the
  // currently-writable archive is re-counted when it grows.
  async getArchiveLineCounts(sessionId: string): Promise<ArchiveLineCount[]> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return [];
    }
    const cached = this.archiveLineCounts.get(sessionId);
    const archives = await this.listArchives(sessionId);
    // Fast path: shape matches cache (same indices in same order,
    // same paths — .gz vs plain distinction matters because a seal
    // changes the path). Trust the cache.
    if (
      cached &&
      cached.length === archives.length &&
      cached.every(
        (c, i) => c.index === archives[i]!.index && c.path === archives[i]!.path,
      )
    ) {
      return cached;
    }
    const out: ArchiveLineCount[] = [];
    for (const { index, path: filePath } of archives) {
      // Reuse a cached count when the same index+path is already known
      // (only the tail archive typically changes across calls).
      const known = cached?.find((c) => c.index === index && c.path === filePath);
      if (known) {
        out.push(known);
        continue;
      }
      let lineCount = 0;
      for await (const _ of this.streamFile(filePath)) {
        lineCount += 1;
      }
      out.push({ index, path: filePath, lineCount });
    }
    this.archiveLineCounts.set(sessionId, out);
    return out;
  }

  // Hydrate a single entry: expand any tool-content blob refs back to
  // inline content, using a per-session cache for repeated hashes.
  // Extracted so both the iterator and rangeSlice can share it without
  // rebuilding the cache each call.
  private async hydrateEntry(
    sessionId: string,
    entry: HistoryEntry,
    blobCache: Map<string, string | null>,
  ): Promise<HistoryEntry> {
    return expandToolRefs(entry, async (hash) => {
      const cached = blobCache.get(hash);
      if (cached !== undefined) {
        return cached;
      }
      const value = await getToolBlob(sessionId, hash);
      blobCache.set(hash, value);
      return value;
    });
  }

  // Yield every historical entry newest-first: live tail (from newest
  // recorded to oldest) followed by each archive (highest N first,
  // and within each archive newest to oldest). Each yielded RecallEntry
  // carries a stable global entryId matching the archives-first
  // concatenated view (so entryId 0 = oldest archive line, entryId
  // total-1 = newest live line). Consumers early-exit by breaking out
  // of the for-await loop; unopened archives cost nothing.
  //
  // Within a single archive we buffer the file's lines to yield them
  // in reverse (gzip is sequential-forward only, so this is the price
  // of the newest-first walk). Peak RAM per call is therefore one
  // archive's worth of parsed entries (~10MB uncompressed worst case
  // at default archiveMaxBytes), dropping to O(1) between archives.
  //
  // Live entries are also buffered for the reverse-yield, but the live
  // file is entry-capped (sessionHistoryMaxEntries) so this is bounded
  // by the operator's config, not by archive depth.
  async *iterRecallNewestFirst(
    sessionId: string,
  ): AsyncGenerator<RecallEntry> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return;
    }
    const pending = this.writeQueues.get(sessionId);
    if (pending) {
      await pending;
    }
    const metadata = await this.getArchiveLineCounts(sessionId);
    let archivedTotal = 0;
    for (const m of metadata) {
      archivedTotal += m.lineCount;
    }
    const blobCache = new Map<string, string | null>();
    const live: HistoryEntry[] = [];
    for await (const e of this.streamFile(paths.historyFile(sessionId))) {
      live.push(e);
    }
    for (let i = live.length - 1; i >= 0; i--) {
      const hydrated = await this.hydrateEntry(sessionId, live[i]!, blobCache);
      yield { entryId: archivedTotal + i, entry: hydrated };
    }
    // Walk archives newest first (highest index) and yield entries
    // within each archive newest first too. Precompute the cumulative
    // base id for each archive so the yield doesn't need a running sum.
    const bases: number[] = new Array(metadata.length);
    let running = 0;
    for (let i = 0; i < metadata.length; i++) {
      bases[i] = running;
      running += metadata[i]!.lineCount;
    }
    for (let ai = metadata.length - 1; ai >= 0; ai--) {
      const m = metadata[ai]!;
      const bucket: HistoryEntry[] = [];
      for await (const e of this.streamFile(m.path)) {
        bucket.push(e);
      }
      const base = bases[ai]!;
      for (let i = bucket.length - 1; i >= 0; i--) {
        const hydrated = await this.hydrateEntry(sessionId, bucket[i]!, blobCache);
        yield { entryId: base + i, entry: hydrated };
      }
    }
  }

  // Read a specific slice [fromEntryId, toEntryId] out of the recall
  // view without materializing everything. Uses the archive line-count
  // cache to figure out which file(s) actually contain the requested
  // range and streams only those. Returns entries in ascending entryId
  // order (chronological). Callers should clamp their inputs to the
  // total entry count reported by getRecallTotalCount(); out-of-range
  // ids yield an empty result rather than throwing.
  async rangeSlice(
    sessionId: string,
    fromEntryId: number,
    toEntryId: number,
  ): Promise<RecallEntry[]> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return [];
    }
    if (toEntryId < fromEntryId) {
      return [];
    }
    const pending = this.writeQueues.get(sessionId);
    if (pending) {
      await pending;
    }
    const metadata = await this.getArchiveLineCounts(sessionId);
    let archivedTotal = 0;
    for (const m of metadata) {
      archivedTotal += m.lineCount;
    }
    const out: RecallEntry[] = [];
    const blobCache = new Map<string, string | null>();
    // Archives: walk in order and stream only those overlapping the range.
    let base = 0;
    for (const m of metadata) {
      const start = base;
      const end = base + m.lineCount; // exclusive
      base = end;
      if (end <= fromEntryId) {
        continue;
      }
      if (start > toEntryId) {
        break;
      }
      let localIdx = 0;
      for await (const entry of this.streamFile(m.path)) {
        const globalId = start + localIdx;
        localIdx += 1;
        if (globalId < fromEntryId) {
          continue;
        }
        if (globalId > toEntryId) {
          break;
        }
        const hydrated = await this.hydrateEntry(sessionId, entry, blobCache);
        out.push({ entryId: globalId, entry: hydrated });
      }
    }
    // Live file: stream if the range overlaps.
    if (toEntryId >= archivedTotal) {
      const liveFrom = Math.max(fromEntryId - archivedTotal, 0);
      const liveTo = toEntryId - archivedTotal;
      let idx = 0;
      for await (const entry of this.streamFile(paths.historyFile(sessionId))) {
        if (idx > liveTo) {
          break;
        }
        if (idx >= liveFrom) {
          const hydrated = await this.hydrateEntry(sessionId, entry, blobCache);
          out.push({ entryId: archivedTotal + idx, entry: hydrated });
        }
        idx += 1;
      }
    }
    return out;
  }

  // Total number of entries visible to the recall iterator (archives
  // plus live). Reads only metadata + one file stat's worth of work,
  // no per-line parsing beyond what the line-count cache already did.
  async getRecallTotalCount(sessionId: string): Promise<number> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return 0;
    }
    const metadata = await this.getArchiveLineCounts(sessionId);
    let total = 0;
    for (const m of metadata) {
      total += m.lineCount;
    }
    let liveCount = 0;
    for await (const _ of this.streamFile(paths.historyFile(sessionId))) {
      liveCount += 1;
    }
    return total + liveCount;
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
      // Sweep any spill archives too (both .N and .N.gz variants);
      // missing files are fine.
      const archives = await this.listArchiveIndices(sessionId);
      for (const n of archives) {
        await this.unlinkArchive(sessionId, n);
      }
      this.nextArchiveIndex.delete(sessionId);
      this.archiveLineCounts.delete(sessionId);
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
