// A small cache over the daemon's session list for the "@" completion.
// Tab is synchronous, so get() answers from the cache (empty before the
// first fetch lands) and refreshes in the background once it goes stale.

import type { DiscoveredSession } from "./discovery.js";

export interface SessionSource {
  get(): readonly DiscoveredSession[];
}

export function createSessionSource(
  fetchAll: () => Promise<DiscoveredSession[]>,
  ttlMs = 60_000,
  now: () => number = Date.now,
): SessionSource {
  let cached: readonly DiscoveredSession[] = [];
  let fetchedAt: number | null = null;
  let inFlight = false;

  const refresh = (): void => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    // Stamp the attempt up front so a failing daemon is retried on the
    // TTL, not on every keystroke.
    fetchedAt = now();
    fetchAll()
      .then((list) => {
        cached = list;
      })
      .catch(() => {
        // Keep the previous list; completion just stays as it was.
      })
      .finally(() => {
        inFlight = false;
      });
  };

  return {
    get: () => {
      if (fetchedAt === null || now() - fetchedAt >= ttlMs) {
        refresh();
      }
      return cached;
    },
  };
}
