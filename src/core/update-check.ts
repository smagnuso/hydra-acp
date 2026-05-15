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
    const notifier = (updateNotifier as (opts: unknown) => {
      check: () => void;
      update?: { current?: string; latest?: string; type?: string };
      config?: { set?: (key: string, value: unknown) => void };
    })({
      pkg: { name: PKG_NAME, version: HYDRA_VERSION },
      updateCheckInterval: 1000 * 60 * 60 * 24,
    });
    // Constructor only sets up the on-disk configstore; the actual
    // registry probe is gated behind check(). It (a) pulls the most
    // recent cached `update` field into notifier.update, and (b) when
    // the cache is older than updateCheckInterval, spawns a detached
    // child to re-probe the registry and write a fresh `update` field
    // for the NEXT process to read. Without this call our prior code
    // saw notifier.update === undefined forever and the cache only
    // ever held configstore's seed value.
    notifier.check();
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
