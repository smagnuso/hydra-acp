// Stable digest of the parsed HydraConfig, used to detect when the
// on-disk config has drifted from the config a running daemon booted
// with. The digest is computed from the parsed/validated config (not
// the raw file bytes) so that whitespace, key ordering, or omitted
// defaults don't trigger false-positive "config changed" warnings.

import { createHash } from "node:crypto";
import { loadGlobalConfig, type HydraConfig } from "./config.js";
import { daemonTierFor, tierFor } from "./config-tiers.js";

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

// Digest of ONLY the keys that genuinely require a restart (see
// config-tiers). A mismatch is a hard failure in ensureDaemonReachable —
// it refuses to talk to the daemon at all — so anything broader than
// "this daemon is bound differently than my config says" makes routine
// edits brick the CLI against a perfectly healthy daemon. Changing
// defaultAgent used to do exactly that.
//
// Keys that merely drift (tier "warn") are reported by
// configDriftSummary instead, and keys the daemon re-reads (tier "live")
// need no signal at all. `tui` falls out because it's tier "client",
// which is why the hand-written exclusion that used to live here is gone.
export function computeConfigDigest(config: HydraConfig): string {
  const restartRelevant: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    const tier = tierFor(key);
    if (tier.nested) {
      const sub: Record<string, unknown> = {};
      for (const [subKey, subValue] of Object.entries(
        (value ?? {}) as Record<string, unknown>,
      )) {
        if (daemonTierFor(subKey).reload === "restart") {
          sub[subKey] = subValue;
        }
      }
      if (Object.keys(sub).length > 0) {
        restartRelevant[key] = sub;
      }
      continue;
    }
    if (tier.reload === "restart") {
      restartRelevant[key] = value;
    }
  }
  const json = JSON.stringify(canonicalize(restartRelevant));
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

// Keys that differ between the config a daemon booted with and what's on
// disk now, restricted to tier "warn" — the ones the daemon snapshots and
// nobody has made live yet. Tier "live" keys are excluded because the
// daemon re-reads them; tier "restart" keys are excluded because the
// digest already refuses outright.
export function configDriftSummary(
  booted: HydraConfig,
  current: HydraConfig,
): string[] {
  const drifted: string[] = [];
  const differs = (a: unknown, b: unknown): boolean =>
    JSON.stringify(canonicalize(a)) !== JSON.stringify(canonicalize(b));

  for (const key of Object.keys(current)) {
    const tier = tierFor(key);
    const currentValue = (current as Record<string, unknown>)[key];
    const bootedValue = (booted as Record<string, unknown>)[key];
    if (tier.nested) {
      for (const subKey of Object.keys(
        (currentValue ?? {}) as Record<string, unknown>,
      )) {
        if (daemonTierFor(subKey).reload !== "warn") {
          continue;
        }
        const c = (currentValue as Record<string, unknown>)[subKey];
        const b = ((bootedValue ?? {}) as Record<string, unknown>)[subKey];
        if (differs(b, c)) {
          drifted.push(`${key}.${subKey}`);
        }
      }
      continue;
    }
    if (tier.reload === "warn" && differs(bootedValue, currentValue)) {
      drifted.push(key);
    }
  }
  return drifted;
}

export async function loadCurrentConfigDigest(): Promise<string | undefined> {
  try {
    // Deliberately the GLOBAL config: this digest is compared against what
    // a running daemon booted with, and a per-cwd overlay never reached
    // that daemon. Hashing the merged config would report a mismatch for
    // every invocation inside a directory that has a `.hydra-acp.json`.
    const config = await loadGlobalConfig();
    return computeConfigDigest(config);
  } catch {
    return undefined;
  }
}
