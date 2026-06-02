import type { SessionManager } from "./session-manager.js";

export interface SessionGcLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface SessionGcOptions {
  manager: SessionManager;
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

export interface SweepOptions {
  manager: SessionManager;
  // Records whose effective last-used timestamp is older than
  // `now - maxAgeMs` are candidates. Pass 0 to collect everything that
  // matches the interactivity filter regardless of age (used by the
  // CLI's `hydra sessions collect --all`).
  maxAgeMs: number;
  // Per-sweep deletion cap. Defaults to 200 for the background timer;
  // the CLI passes a higher number (or none) when the user is driving.
  maxDeletions?: number;
  // Selection policy for the interactivity tristate:
  //   "explicit"  — only `interactive === false` (the conservative
  //                 default the background timer uses; never touches
  //                 editor-spawned undecided sessions).
  //   "unpromoted" — `interactive !== true`, i.e. both `false` AND
  //                  `undefined`. Used by the manual CLI command:
  //                  the user typed `collect`, so collect anything
  //                  that never became a real conversation, including
  //                  editor ghosts that opened a session and never
  //                  sent a turn.
  selection?: "explicit" | "unpromoted";
  // When true, log a line at "no candidates" and emit a richer line on
  // completion. The background timer leaves this off so quiet ticks
  // produce no output.
  verbose?: boolean;
  logger?: SessionGcLogger;
}

export interface SweepResult {
  considered: number;
  deleted: number;
  failed: number;
  // Number of candidates that matched the filter but didn't get
  // deleted this sweep because we hit `maxDeletions`. The caller can
  // call sweep again (or, for the timer, wait for the next tick) to
  // drain the rest.
  deferred: number;
  // Oldest candidate's lastUsed timestamp (ms since epoch) — useful
  // for CLI output ("oldest was 47 days ago"). undefined when nothing
  // matched.
  oldestLastUsedMs?: number;
}

interface Candidate {
  sessionId: string;
  lastUsedMs: number;
}

// One sweep over manager.list(). Extracted from startSessionGc so the
// REST handler / CLI command can trigger the exact same logic on
// demand without spinning up a timer.
export async function sweepNonInteractiveSessions(
  opts: SweepOptions,
): Promise<SweepResult> {
  const cap = opts.maxDeletions ?? 200;
  const log = (level: "info" | "warn", msg: string): void => {
    if (!opts.logger) {
      return;
    }
    opts.logger[level](`session-gc: ${msg}`);
  };

  const now = Date.now();
  const cutoff = opts.maxAgeMs > 0 ? now - opts.maxAgeMs : Number.POSITIVE_INFINITY;

  // manager.list() already merges live + cold records, runs
  // effectiveInteractive(), and surfaces updatedAt as the history-file
  // mtime when present (falling back to the record's updatedAt).
  // includeNonInteractive: true is required — the default filter
  // hides exactly the rows we want to collect.
  const rows = await opts.manager
    .list({ includeNonInteractive: true })
    .catch((err) => {
      log("warn", `manager.list failed: ${(err as Error).message}`);
      return [] as Awaited<ReturnType<SessionManager["list"]>>;
    });

  const candidates: Candidate[] = [];
  for (const row of rows) {
    // Skip live sessions — they get cleaned up via their own onClose
    // path when the user (or idle timeout) ends them. We never delete
    // a record out from under a running agent.
    if (row.status !== "cold") {
      continue;
    }
    // Interactivity filter — see SweepOptions.selection. The default
    // ("explicit") only collects `false` so the background timer never
    // surprises an editor-spawned session that might still get a real
    // turn. The CLI overrides to "unpromoted" because the user is
    // driving and expects every never-promoted row gone.
    const selection = opts.selection ?? "explicit";
    if (selection === "explicit") {
      if (row.interactive !== false) {
        continue;
      }
    } else {
      if (row.interactive === true) {
        continue;
      }
    }
    const lastUsedMs = Date.parse(row.updatedAt);
    if (!Number.isFinite(lastUsedMs)) {
      continue;
    }
    if (opts.maxAgeMs > 0 && lastUsedMs > cutoff) {
      continue;
    }
    candidates.push({ sessionId: row.sessionId, lastUsedMs });
  }

  if (candidates.length === 0) {
    if (opts.verbose) {
      log("info", "no candidates");
    }
    return { considered: 0, deleted: 0, failed: 0, deferred: 0 };
  }

  // Oldest first so a sweep that hits the cap drains the longest tail
  // first; the next sweep picks up what's left.
  candidates.sort((a, b) => a.lastUsedMs - b.lastUsedMs);
  const slice = candidates.slice(0, cap);
  const oldestLastUsedMs = slice[0]?.lastUsedMs;
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
      log("warn", `delete ${sessionId} failed: ${(err as Error).message}`);
    }
  }
  const deferred = candidates.length - slice.length;
  if (opts.verbose || deleted > 0 || failed > 0) {
    const label =
      (opts.selection ?? "explicit") === "unpromoted"
        ? "unpromoted"
        : "non-interactive";
    log(
      "info",
      `swept ${deleted} ${label} session(s) older than ${formatAge(opts.maxAgeMs)}` +
        (failed > 0 ? `; ${failed} failed` : "") +
        (deferred > 0 ? `; ${deferred} deferred to next sweep` : ""),
    );
  }
  const result: SweepResult = {
    considered: candidates.length,
    deleted,
    failed,
    deferred,
  };
  if (oldestLastUsedMs !== undefined) {
    result.oldestLastUsedMs = oldestLastUsedMs;
  }
  return result;
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

  const scheduleNext = (delayMs: number): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      const run = async (): Promise<void> => {
        if (running) {
          return;
        }
        running = true;
        try {
          await sweepNonInteractiveSessions({
            manager: opts.manager,
            maxAgeMs: opts.maxAgeMs,
            // Match the manual CLI default: also reap editor-spawned
            // sessions that opened but never had a turn. After
            // sessionGcMaxAgeDays of no activity, an undecided session
            // is overwhelmingly an editor that's long gone — keeping
            // it around just bloats the picker's hidden tier and the
            // sessions/ directory.
            selection: "unpromoted",
            ...(opts.maxDeletionsPerSweep !== undefined
              ? { maxDeletions: opts.maxDeletionsPerSweep }
              : {}),
            ...(opts.logger ? { logger: opts.logger } : {}),
          });
        } finally {
          running = false;
        }
      };
      run()
        .catch((err) => {
          opts.logger?.warn(
            `session-gc: sweep crashed: ${(err as Error).message}`,
          );
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

function formatAge(ms: number): string {
  if (ms <= 0) {
    return "any age";
  }
  const days = ms / (24 * 60 * 60 * 1000);
  if (days >= 1) {
    return `${days.toFixed(days >= 10 ? 0 : 1)}d`;
  }
  const hours = ms / (60 * 60 * 1000);
  return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
}
