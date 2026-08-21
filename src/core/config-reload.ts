import * as fsp from "node:fs/promises";
import { loadGlobalConfig, type HydraConfig } from "./config.js";
import { configDriftSummary } from "./config-digest.js";
import { paths } from "./paths.js";

// Watch config.json and push tier-"live" values into the running daemon.
//
// ---------------------------------------------------------------------
// WHY POLLING RATHER THAN fs.watch
//
// Every config writer in this repo goes through writeJsonAtomic, which
// writes a temp file and renames it over the target. fs.watch on a FILE
// follows the inode, so the very first write after the watch is
// established swaps the file out from under it and no further events
// arrive — the watcher silently goes deaf, which is worse than not
// watching at all. Watching the directory avoids that but fires on every
// unrelated file in ~/.hydra-acp, which is a busy directory (logs,
// pidfile, tokens, tty state).
//
// A stat every few seconds costs nothing next to what the daemon already
// does, and can't go deaf.
// ---------------------------------------------------------------------

export interface ConfigReloadOptions {
  // What the daemon booted with. Drift is always measured against this,
  // not against the previous poll, so a key edited and reverted stops
  // being reported rather than staying flagged forever.
  bootConfig: HydraConfig;
  // Push tier-"live" values into the running daemon. Called only when
  // something actually changed.
  apply: (next: HydraConfig) => void;
  // Receives the tier-"warn" keys that now differ from bootConfig.
  // Called on every successful reload, including with an empty array
  // when drift clears.
  onDrift?: (driftedKeys: string[]) => void;
  intervalMs?: number;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

const DEFAULT_INTERVAL_MS = 3_000;

async function configMtimeMs(): Promise<number | undefined> {
  try {
    const st = await fsp.stat(paths.config());
    return st.mtimeMs;
  } catch {
    // Missing config is not an error — hydra runs on defaults. Treat it
    // as "nothing to reload" and keep polling, so creating the file later
    // is picked up.
    return undefined;
  }
}

// Returns a stop function; call it on daemon shutdown.
export function startConfigReloader(opts: ConfigReloadOptions): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let lastMtime: number | undefined;
  // Primed at CONSTRUCTION, not on the first tick. Priming on the first
  // tick captures the mtime one interval after boot, so any edit landing
  // inside that window is baked into the baseline and never detected —
  // which is exactly the "change config right after starting the daemon"
  // case a person is most likely to hit, and it looks identical to hot
  // reload being broken.
  const primed = configMtimeMs().then((m) => {
    lastMtime = m;
  });

  const tick = async (): Promise<void> => {
    await primed;
    const mtime = await configMtimeMs();
    if (mtime === lastMtime) {
      return;
    }
    lastMtime = mtime;
    let next: HydraConfig;
    try {
      next = await loadGlobalConfig();
    } catch (err) {
      // A half-written or invalid config must not take the daemon's
      // in-memory config with it. Keep serving what we have; the next
      // successful parse wins.
      opts.logger?.warn(
        `config-reload: config.json changed but did not parse (${(err as Error).message}); keeping the loaded config`,
      );
      return;
    }
    try {
      opts.apply(next);
    } catch (err) {
      opts.logger?.warn(
        `config-reload: applying live config failed: ${(err as Error).message}`,
      );
    }
    const drifted = configDriftSummary(opts.bootConfig, next);
    opts.onDrift?.(drifted);
    opts.logger?.info(
      drifted.length > 0
        ? `config-reload: applied live config; restart-only keys differing from boot: ${drifted.join(", ")}`
        : "config-reload: applied live config",
    );
  };

  const schedule = (): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void tick().finally(schedule);
    }, intervalMs);
    // Don't hold the event loop open on this alone.
    timer.unref?.();
  };
  schedule();

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}
