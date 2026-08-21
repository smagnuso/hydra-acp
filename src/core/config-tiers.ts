import type { HydraConfig } from "./config.js";

// How each config key behaves when it changes under a running daemon, and
// whether a directory overlay can affect it.
//
// ---------------------------------------------------------------------
// WHY THIS IS ONE TABLE
//
// Three consumers used to answer "does this key matter to the daemon?"
// independently, and were already drifting:
//
//   computeConfigDigest  — hand-written `const { tui, ...rest } = config`
//   directory-config.ts  — hand-written DAEMON_OWNED_KEYS string array
//   (nothing)            — no reload path existed at all
//
// They now all read this table, so the classification has exactly one
// home. The mapped types below have no index signature and strip
// optionality with `-?`, so adding a key to the zod schema fails to
// COMPILE until it is classified here. That matters more than it sounds:
// the failure mode of a forgotten key is "silently never applies", which
// is precisely the bug this whole mechanism exists to prevent, and it is
// invisible in tests. The person adding the key is the one who knows
// which tier it belongs in.
//
// If a cast ever smuggles a key past the mapped type, the runtime default
// is `restart` (see tierFor) — loud and wrong beats quiet and wrong.
// ---------------------------------------------------------------------

// What the DAEMON does when this key changes on disk.
export type ReloadTier =
  // The daemon never reads it; it's client-side only. Excluded from the
  // digest for that reason rather than by special case.
  | "client"
  // Re-read and pushed into the running daemon. Takes effect on the next
  // use — for anything agent-related that means the next SPAWN, so a
  // session already running keeps its process until it restarts.
  | "live"
  // The daemon snapshots it at boot and nothing has made it live yet.
  // Reported as drift rather than silently going stale. Graduating one of
  // these to "live" is a table edit plus the wiring; the contract for
  // callers does not change.
  | "warn"
  // Bound at startup; changing it genuinely requires a restart. Only
  // these participate in the config digest, so only these can hard-fail
  // a client against an otherwise healthy daemon.
  | "restart";

// Whether a `.hydra-acp.json` overlay can change behavior for this key.
// A SEPARATE axis from ReloadTier: the overlay lives in the client
// process and never reaches the daemon, so `agents` can be "live" (the
// daemon re-reads config.json) and still "inert" in a directory config.
export type OverlayEffect =
  // The client's value wins outright.
  | "effective"
  // Affects some client paths but not the daemon's own use of the key.
  | "partial"
  // Only the daemon reads it, so an overlay value is never consulted.
  | "inert";

export interface ConfigKeyTier {
  reload: ReloadTier;
  overlay: OverlayEffect;
  // Why an overlay can't (fully) apply. Surfaced verbatim by
  // directory-config's notices, so it reads as an explanation rather than
  // a scold.
  overlayNote?: string;
  // Set only on `daemon`, whose sub-keys span three tiers and are
  // classified individually in DAEMON_CONFIG_TIERS.
  nested?: true;
}

const DAEMON_ONLY = "read by the daemon, which loads config.json at startup";

export const CONFIG_TIERS: { [K in keyof HydraConfig]-?: ConfigKeyTier } = {
  daemon: {
    reload: "restart",
    overlay: "partial",
    overlayNote:
      "only changes which daemon this client dials; a daemon started from here still binds config.json's host/port. Use `home` for a separate daemon",
    nested: true,
  },

  // --- live: pushed into the running daemon on change -----------------
  // Registry re-reads all four via Registry.setConfig.
  agents: { reload: "live", overlay: "inert", overlayNote: DAEMON_ONLY },
  agentOverrides: { reload: "live", overlay: "inert", overlayNote: DAEMON_ONLY },
  registry: { reload: "live", overlay: "inert", overlayNote: DAEMON_ONLY },
  npmRegistry: { reload: "live", overlay: "inert", overlayNote: DAEMON_ONLY },
  // The client resolves these itself and sends them explicitly on
  // session/new; the daemon's copy is only a fallback for callers that
  // omit them.
  defaultAgent: { reload: "live", overlay: "effective" },
  defaultCwd: { reload: "live", overlay: "effective" },
  // Partial on purpose: the TUI only sends `model` at session/new when
  // one was explicitly chosen, so an overlay fixes the composer's
  // displayed default but the daemon still applies its own value to the
  // created session. Wiring the create path would make this "effective".
  defaultModels: {
    reload: "live",
    overlay: "partial",
    overlayNote:
      "sets the model the composer displays, but the session is created with the daemon's value unless a model is chosen explicitly",
  },

  // --- warn: snapshotted at boot, drift reported ----------------------
  synopsisAgent: { reload: "warn", overlay: "inert", overlayNote: DAEMON_ONLY },
  synopsisModel: { reload: "warn", overlay: "inert", overlayNote: DAEMON_ONLY },
  compaction: { reload: "warn", overlay: "inert", overlayNote: DAEMON_ONLY },
  defaultTransformers: { reload: "warn", overlay: "inert", overlayNote: DAEMON_ONLY },
  disableWorkspaceSnapshots: { reload: "warn", overlay: "inert", overlayNote: DAEMON_ONLY },
  compressToolContent: { reload: "warn", overlay: "inert", overlayNote: DAEMON_ONLY },
  // Child processes started at boot. Reconciling a changed set is
  // plausible (extension start/stop/restart already exist) but nobody has
  // built it, so say so rather than pretend.
  extensions: { reload: "warn", overlay: "inert", overlayNote: DAEMON_ONLY },
  transformers: { reload: "warn", overlay: "inert", overlayNote: DAEMON_ONLY },

  // --- client: the daemon never reads these ---------------------------
  tui: { reload: "client", overlay: "effective" },
  sessionListColdLimit: { reload: "client", overlay: "effective" },
};

export const DAEMON_CONFIG_TIERS: {
  [K in keyof HydraConfig["daemon"]]-?: ConfigKeyTier;
} = {
  // The listener and TLS terminator are bound once. Rebinding would drop
  // every attached WS client, and these are the only keys that aren't
  // self-detecting: the client finds the daemon through the pidfile, not
  // config.daemon.port, so a changed port would otherwise leave it
  // happily talking to a daemon its config no longer describes.
  host: { reload: "restart", overlay: "inert" },
  port: { reload: "restart", overlay: "inert" },
  publicHost: { reload: "restart", overlay: "inert" },
  tls: { reload: "restart", overlay: "inert" },

  // Module-level setter re-read at every spawn, so pushing it is a
  // single call.
  scrubEnv: { reload: "live", overlay: "inert", overlayNote: DAEMON_ONLY },

  // Snapshotted into the logger, the schedulers' timers, or
  // SessionManager's options. Each is live-able with modest work.
  logLevel: { reload: "warn", overlay: "inert", overlayNote: DAEMON_ONLY },
  sessionIdleTimeoutSeconds: { reload: "warn", overlay: "inert", overlayNote: DAEMON_ONLY },
  sessionHistoryMaxEntries: { reload: "warn", overlay: "inert", overlayNote: DAEMON_ONLY },
  sessionHistoryArchiveMaxBytes: { reload: "warn", overlay: "inert", overlayNote: DAEMON_ONLY },
  sessionHistoryArchiveTiers: { reload: "warn", overlay: "inert", overlayNote: DAEMON_ONLY },
  agentStderrTailBytes: { reload: "warn", overlay: "inert", overlayNote: DAEMON_ONLY },
  agentSyncIntervalMinutes: { reload: "warn", overlay: "inert", overlayNote: DAEMON_ONLY },
  sessionGcIntervalMinutes: { reload: "warn", overlay: "inert", overlayNote: DAEMON_ONLY },
  sessionGcMaxAgeDays: { reload: "warn", overlay: "inert", overlayNote: DAEMON_ONLY },
};

// Tier for a top-level key, defaulting to the most conservative answer
// for anything the mapped type didn't catch (a cast, a hand-built object).
export function tierFor(key: string): ConfigKeyTier {
  return (
    (CONFIG_TIERS as Record<string, ConfigKeyTier | undefined>)[key] ?? {
      reload: "restart",
      overlay: "inert",
    }
  );
}

export function daemonTierFor(key: string): ConfigKeyTier {
  return (
    (DAEMON_CONFIG_TIERS as Record<string, ConfigKeyTier | undefined>)[key] ?? {
      reload: "restart",
      overlay: "inert",
    }
  );
}

// Top-level keys whose value an overlay cannot fully apply, with the
// reason. Replaces directory-config's hand-written DAEMON_OWNED_KEYS.
export function overlayLimitedKeys(): Array<{
  key: string;
  effect: OverlayEffect;
  note: string;
}> {
  const out: Array<{ key: string; effect: OverlayEffect; note: string }> = [];
  for (const [key, tier] of Object.entries(CONFIG_TIERS)) {
    if (tier.overlay !== "effective") {
      out.push({
        key,
        effect: tier.overlay,
        note: tier.overlayNote ?? DAEMON_ONLY,
      });
    }
  }
  return out;
}
