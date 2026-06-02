import * as fs from "node:fs/promises";
import { paths } from "./paths.js";
import { effectiveInteractive } from "./session-manager.js";
import type { SessionManager } from "./session-manager.js";
import type { SessionStore } from "./session-store.js";

export interface SessionGcLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface SessionGcOptions {
  manager: SessionManager;
  store: SessionStore;
  // How often the GC sweeps. The first sweep runs once `intervalMs`
  // after startup; we don't sweep on boot to avoid stacking with the
  // queue-replay scan and the first agent-sync tick.
  intervalMs: number;
  // Cold records whose last-used timestamp is older than this are
  // candidates for deletion. "Last used" is the mtime of history.jsonl
  // when present, falling back to record.updatedAt.
  maxAgeMs: number;
  // Hard cap on deletions per sweep so a one-time backlog (e.g. the
  // first run after the GC ships) doesn't pin the event loop for a
  // long time. Subsequent sweeps drain the rest.
  maxDeletionsPerSweep?: number;
  logger?: SessionGcLogger;
}

interface Candidate {
  sessionId: string;
  lastUsedMs: number;
}

// Periodically delete non-interactive cold session records that haven't
// been touched in `maxAgeMs`. "Non-interactive" matches
// effectiveInteractive's rule: explicit `interactive === false`, or a
// `hydra cat` originating client with no other interactivity signal.
// Sessions promoted to interactive at any point are skipped, as are
// any sessions currently live (manager.sessions).
//
// Returns a stop function — call on daemon shutdown to cancel the
// pending timer.
export function startSessionGc(opts: SessionGcOptions): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running = false;
  const cap = opts.maxDeletionsPerSweep ?? 200;

  const log = (level: "info" | "warn", msg: string): void => {
    if (!opts.logger) {
      return;
    }
    opts.logger[level](`session-gc: ${msg}`);
  };

  const sweep = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      const now = Date.now();
      const cutoff = now - opts.maxAgeMs;
      const records = await opts.store.list().catch((err) => {
        log("warn", `store.list failed: ${(err as Error).message}`);
        return [];
      });

      // Live sessions are skipped entirely — they get cleaned up via
      // their own onClose path when the user (or idle timeout) ends
      // them. We never delete a record out from under a running agent.
      const liveIds = new Set<string>();
      // We only have access to manager.list() here, not the live map.
      // Cheaper: list once, filter to status === "live". list() is
      // cached so this is a single fs sweep at worst.
      const live = await opts.manager
        .list({ includeNonInteractive: true })
        .catch(() => []);
      for (const row of live) {
        if (row.status === "live") {
          liveIds.add(row.sessionId);
        }
      }

      const candidates: Candidate[] = [];
      for (const record of records) {
        if (liveIds.has(record.sessionId)) {
          continue;
        }
        // Skip anything currently interactive (or undecided — undefined
        // means "fresh editor panel" or "no signal yet", neither of
        // which we want to GC).
        const interactive = effectiveInteractive(record, true);
        if (interactive !== false) {
          continue;
        }
        const lastUsedMs = await lastUsedMillis(record.sessionId, record.updatedAt);
        if (lastUsedMs > cutoff) {
          continue;
        }
        candidates.push({ sessionId: record.sessionId, lastUsedMs });
      }

      if (candidates.length === 0) {
        return;
      }

      // Oldest first so a sweep that hits the cap drains the longest
      // tail first; the next sweep picks up what's left.
      candidates.sort((a, b) => a.lastUsedMs - b.lastUsedMs);
      const slice = candidates.slice(0, cap);
      let deleted = 0;
      let failed = 0;
      for (const { sessionId } of slice) {
        try {
          const ok = await opts.manager.deleteRecord(sessionId);
          if (ok) {
            deleted += 1;
          }
        } catch (err) {
          failed += 1;
          log(
            "warn",
            `delete ${sessionId} failed: ${(err as Error).message}`,
          );
        }
      }
      const remaining = candidates.length - slice.length;
      log(
        "info",
        `swept ${deleted} non-interactive session(s) older than ${formatAge(opts.maxAgeMs)}` +
          (failed > 0 ? `; ${failed} failed` : "") +
          (remaining > 0 ? `; ${remaining} deferred to next sweep` : ""),
      );
    } finally {
      running = false;
    }
  };

  const scheduleNext = (delayMs: number): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      sweep()
        .catch((err) => {
          log("warn", `sweep crashed: ${(err as Error).message}`);
        })
        .finally(() => {
          scheduleNext(opts.intervalMs);
        });
    }, delayMs);
    timer.unref();
  };

  scheduleNext(opts.intervalMs);

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

async function lastUsedMillis(
  sessionId: string,
  fallbackIso: string,
): Promise<number> {
  try {
    const st = await fs.stat(paths.historyFile(sessionId));
    return st.mtimeMs;
  } catch {
    const parsed = Date.parse(fallbackIso);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}

function formatAge(ms: number): string {
  const days = ms / (24 * 60 * 60 * 1000);
  if (days >= 1) {
    return `${days.toFixed(days >= 10 ? 0 : 1)}d`;
  }
  const hours = ms / (60 * 60 * 1000);
  return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
}
