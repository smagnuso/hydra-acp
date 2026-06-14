// Stable digest of the parsed HydraConfig, used to detect when the
// on-disk config has drifted from the config a running daemon booted
// with. The digest is computed from the parsed/validated config (not
// the raw file bytes) so that whitespace, key ordering, or omitted
// defaults don't trigger false-positive "config changed" warnings.

import { createHash } from "node:crypto";
import { loadConfig, type HydraConfig } from "./config.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function computeConfigDigest(config: HydraConfig): string {
  // The `tui` section has no bearing on daemon behavior — it's all
  // client-side rendering/input preferences. Excluding it means edits
  // to TUI options don't trip the "config changed since daemon
  // started" mismatch path.
  const { tui: _tui, ...daemonRelevant } = config as HydraConfig & {
    tui?: unknown;
  };
  const json = JSON.stringify(canonicalize(daemonRelevant));
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

export async function loadCurrentConfigDigest(): Promise<string | undefined> {
  try {
    const config = await loadConfig();
    return computeConfigDigest(config);
  } catch {
    return undefined;
  }
}
