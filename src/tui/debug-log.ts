// Always-on append-only TUI log. Every session/update the TUI receives is
// recorded here (paired with the RenderEvent kind it mapped to), plus any
// uncaught exception / unhandled rejection that takes the process down — so
// a crash that only ever flashed on stderr (and got wiped by the alt-screen
// reset) leaves a durable artifact. Default path is ~/.hydra-acp/tui.log;
// HYDRA_TUI_DEBUG_LOG overrides it, and setting it to "" disables logging.
import { appendFileSync, renameSync, statSync } from "node:fs";
import { paths } from "../core/paths.js";

let logMaxBytes = 5 * 1024 * 1024;

export function setLogMaxBytes(bytes: number): void {
  logMaxBytes = bytes;
}

export function writeDebugLine(payload: Record<string, unknown>): void {
  const override = process.env.HYDRA_TUI_DEBUG_LOG;
  const target = override === undefined ? paths.tuiLogFile() : override;
  if (target.length === 0) {
    return;
  }
  try {
    rotateIfBig(target);
    const line = JSON.stringify({
      t: new Date().toISOString(),
      ...payload,
    });
    appendFileSync(target, `${line}\n`);
  } catch {
    void 0;
  }
}

// Single-step rotation: when the log crosses the size cap, rename it to
// `<path>.0` (overwriting any prior rotation) and start fresh. Bounds
// disk use at ~2x cap without depending on logrotate.
function rotateIfBig(target: string): void {
  try {
    const stat = statSync(target);
    if (stat.size < logMaxBytes) {
      return;
    }
    renameSync(target, `${target}.0`);
  } catch {
    void 0;
  }
}
