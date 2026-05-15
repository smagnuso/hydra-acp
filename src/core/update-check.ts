// Background npm-registry update check, surfaced in the TUI and CLI.
// update-notifier spawns a detached child to do the HTTPS lookup and
// caches the result in ~/.config/configstore for a day, so calls here
// are cheap and never block the main process.

import { HYDRA_VERSION } from "./hydra-version.js";

const PKG_NAME = "@hydra-acp/cli";

export interface PendingUpdate {
  current: string;
  latest: string;
  type: string;
}

let cached: PendingUpdate | null | undefined;

function disabled(): boolean {
  if (process.env.NO_UPDATE_NOTIFIER === "1") {
    return true;
  }
  if (process.argv.includes("--no-update-notifier")) {
    return true;
  }
  return false;
}

// Kick off (or refresh) the cached check and return whatever the most
// recent run produced. The check itself runs in a detached child the
// first time per TTL; subsequent calls in the same process just read
// the configstore file the child wrote.
export async function getPendingUpdate(): Promise<PendingUpdate | null> {
  if (cached !== undefined) {
    return cached;
  }
  if (disabled()) {
    cached = null;
    return cached;
  }
  try {
    const mod = await import("update-notifier");
    const updateNotifier =
      (mod as { default?: unknown }).default ?? (mod as unknown);
    // update-notifier's default export already calls check() internally
    // (see node_modules/update-notifier/index.js) — it (a) reads the
    // cached `update` field into notifier.update and (b) spawns the
    // detached registry probe if the cache is stale. Calling check()
    // a second time would re-read the (now-deleted) `update` field and
    // clobber notifier.update back to undefined, which is the bug we
    // just fixed. Trust the default export and don't double-check.
    //
    // updateCheckInterval is left at update-notifier's 24h default.
    const notifier = (updateNotifier as (opts: unknown) => {
      update?: { current?: string; latest?: string; type?: string };
      config?: { set?: (key: string, value: unknown) => void };
    })({
      pkg: { name: PKG_NAME, version: HYDRA_VERSION },
    });
    const u = notifier.update;
    if (
      u &&
      typeof u.latest === "string" &&
      typeof u.current === "string" &&
      u.latest !== u.current
    ) {
      // update-notifier intentionally deletes the cached `update` field
      // after check() reads it (it's designed for the show-once-per-
      // process notify() flow). We surface this notification across
      // multiple processes — CLI end-of-process, in-session TUI banner,
      // and TUI exit hint — so write the field back so the next hydra
      // invocation still has it. The detached child overwrites (or
      // clears, on upgrade) this field at the next stale-cache check.
      try {
        notifier.config?.set?.("update", u);
      } catch {
        void 0;
      }
      cached = {
        current: u.current,
        latest: u.latest,
        type: typeof u.type === "string" ? u.type : "unknown",
      };
    } else {
      cached = null;
    }
  } catch {
    cached = null;
  }
  return cached;
}

export function formatUpdateNoticeLine(info: PendingUpdate): string {
  return `hydra-acp ${info.latest} available (current ${info.current}) · run: npm update -g ${PKG_NAME}`;
}
