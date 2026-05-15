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
      update?: { current?: string; latest?: string; type?: string };
    })({
      pkg: { name: PKG_NAME, version: HYDRA_VERSION },
      updateCheckInterval: 1000 * 60 * 60 * 24,
    });
    const u = notifier.update;
    if (
      u &&
      typeof u.latest === "string" &&
      typeof u.current === "string" &&
      u.latest !== u.current
    ) {
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
