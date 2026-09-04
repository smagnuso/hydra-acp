// Tracks whether each federated peer is actually reachable and our
// stored token still works, so `hydra remote list` can show real
// status instead of leaving the operator to infer it from the next
// forward attempt's error. Polling rather than a persistent
// connection per peer: simpler (no reconnect/backoff state machine to
// get right), at the cost of detecting a state change up to one
// interval late rather than the instant it happens.
//
// This is ephemeral runtime state, not persisted — PeerStore holds
// the durable credential, this holds "as of the last check, did it
// work." A daemon restart starts every peer at "unknown" until the
// first check completes.
//
// Deliberately not wired into the forwarding hot path (session-
// forward.ts, acp-forward.ts): those already get an equally accurate,
// equally real-time answer by just attempting the real call. This
// tracker is for visibility between attempts, not for gating them.

import { isLoopbackHost } from "../core/remote-url.js";
import type { PeerStore } from "../core/peer-store.js";

export type PeerStatus = "ok" | "unauthorized" | "unreachable" | "unknown";

export interface PeerHealthSnapshot {
  status: PeerStatus;
  checkedAt: string;
  error?: string;
}

const DEFAULT_INTERVAL_MS = 30_000;
const CHECK_TIMEOUT_MS = 5_000;

export class PeerHealthTracker {
  private snapshots = new Map<string, PeerHealthSnapshot>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: PeerStore,
    private readonly opts: {
      intervalMs?: number;
      fetchImpl?: typeof fetch;
    } = {},
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    void this.checkAll();
    this.timer = setInterval(
      () => void this.checkAll(),
      this.opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  get(name: string): PeerHealthSnapshot | undefined {
    return this.snapshots.get(name);
  }

  // Seeds an immediate "ok" snapshot right after a successful
  // `POST /v1/remotes` login, so `remote list` doesn't show "unknown"
  // for up to a full poll interval after adding a peer we just proved
  // works.
  markOk(name: string): void {
    this.snapshots.set(name, { status: "ok", checkedAt: new Date().toISOString() });
  }

  forget(name: string): void {
    this.snapshots.delete(name);
  }

  async checkAll(): Promise<void> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    await Promise.allSettled(
      this.store.list().map(async (summary) => {
        const record = this.store.get(summary.name);
        if (!record) {
          return;
        }
        const scheme = isLoopbackHost(record.host) ? "http" : "https";
        const url = `${scheme}://${record.host}:${record.port}/v1/auth/verify`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
        try {
          const res = await fetchImpl(url, {
            headers: { Authorization: `Bearer ${record.token}` },
            signal: controller.signal,
          });
          this.snapshots.set(summary.name, {
            status: res.ok ? "ok" : "unauthorized",
            checkedAt: new Date().toISOString(),
          });
        } catch (err) {
          this.snapshots.set(summary.name, {
            status: "unreachable",
            checkedAt: new Date().toISOString(),
            error: (err as Error).message,
          });
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  }
}
