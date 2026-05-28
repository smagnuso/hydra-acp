// sysexits EX_CONFIG. Children exit with this code to tell the supervisor
// that restarting is pointless until the user does something (re-login,
// fix config, etc.). Other exit codes (1, 2, anything else) remain
// restart-eligible.
export const FATAL_EXIT_CODE = 78;

const DEFAULT_WINDOW_MS = 5 * 60_000;
const DEFAULT_MAX_FAILURES = 10;

export interface BreakerOptions {
  windowMs?: number;
  maxFailuresInWindow?: number;
  now?: () => number;
}

export type BreakerDecision = "restart" | { tripped: string };

// Decides, on each child exit, whether the supervisor should reschedule
// a restart or give up. Trips immediately on FATAL_EXIT_CODE; otherwise
// trips when too many non-fatal exits land inside a rolling window.
//
// State is purely in-memory — a daemon restart wipes it, intentionally,
// so that a fresh start always gives the child another shot.
export class RestartBreaker {
  private readonly windowMs: number;
  private readonly maxFailures: number;
  private readonly now: () => number;
  private recentExits: number[] = [];
  private tripped_: string | undefined;

  constructor(opts: BreakerOptions = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxFailures = opts.maxFailuresInWindow ?? DEFAULT_MAX_FAILURES;
    this.now = opts.now ?? Date.now;
  }

  recordExit(
    code: number | null,
    name: string,
    kind: string,
  ): BreakerDecision {
    if (code === FATAL_EXIT_CODE) {
      const reason = `exited with code ${FATAL_EXIT_CODE} (unrecoverable); fix and run \`${kind}s start ${name}\``;
      this.tripped_ = reason;
      return { tripped: reason };
    }
    const now = this.now();
    this.recentExits.push(now);
    const cutoff = now - this.windowMs;
    while (this.recentExits.length > 0 && this.recentExits[0]! < cutoff) {
      this.recentExits.shift();
    }
    if (this.recentExits.length > this.maxFailures) {
      const minutes = Math.round(this.windowMs / 60_000);
      const reason = `${this.recentExits.length} exits in ${minutes}m (crash loop); fix and run \`${kind}s start ${name}\``;
      this.tripped_ = reason;
      return { tripped: reason };
    }
    return "restart";
  }

  reset(): void {
    this.recentExits = [];
    this.tripped_ = undefined;
  }

  get tripped(): string | undefined {
    return this.tripped_;
  }
}
