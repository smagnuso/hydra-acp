import * as fs from "node:fs/promises";
import { paths } from "./paths.js";
import { externalizeToolEntry, expandToolRefs } from "./tool-content.js";
import { putToolBlob, getToolBlob, deleteToolBlobs } from "./tool-store.js";

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

export interface HistoryStoreOptions {
  // Defensive cap applied on read: even if a file grew unbounded (older
  // daemon, manual edit), load() tails to this many entries. Mirrors the
  // compaction cap Session uses on write.
  maxEntries?: number;
}

export class HistoryStore {
  // Serialize writes per session id so appends and rewrites don't
  // interleave JSONL lines on disk. The chain swallows errors so one
  // failed append doesn't poison every subsequent write.
  private writeQueues = new Map<string, Promise<void>>();
  private maxEntries: number;

  constructor(options: HistoryStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
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
      const trimmed = lines.slice(-maxEntries);
      await fs.writeFile(paths.historyFile(sessionId), trimmed.join("\n") + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
    });
  }

  // `tools` selects how externalized tool content is materialized:
  //   "inline" (default) — expand blob refs back to full content, so every
  //                        consumer sees the original recorded shape.
  //   "references"       — leave references in place (the lean form) for
  //                        clients that fetch tool content on demand.
  async load(
    sessionId: string,
    opts: { tools?: "inline" | "references" } = {},
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
    const kept =
      out.length > this.maxEntries ? out.slice(-this.maxEntries) : out;
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
