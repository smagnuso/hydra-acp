import { describe, it, expect } from "vitest";
import { HydraConfig } from "./config.js";
import {
  CONFIG_TIERS,
  DAEMON_CONFIG_TIERS,
  daemonTierFor,
  overlayLimitedKeys,
  tierFor,
} from "./config-tiers.js";
import { computeConfigDigest, configDriftSummary } from "./config-digest.js";

// A fully-defaulted config, so the tests compare against exactly the key
// set the schema produces rather than a hand-maintained fixture.
function baseConfig(): HydraConfig {
  return HydraConfig.parse({});
}

describe("config tier table", () => {
  // The mapped types in config-tiers.ts already fail the BUILD when a key
  // is unclassified. This is the runtime half: it catches a key that was
  // smuggled in past the type (a cast, a loosened schema) and a stale
  // entry left behind after a key was removed.
  it("classifies exactly the schema's top-level keys", () => {
    // `.shape`, not a parsed instance: optional keys like synopsisAgent
    // are absent from a defaulted config but still need a tier, and a
    // parsed instance would let them silently fall through to the
    // conservative runtime default forever.
    expect(Object.keys(CONFIG_TIERS).sort()).toEqual(
      Object.keys(HydraConfig.shape).sort(),
    );
  });

  it("classifies exactly the daemon section's keys", () => {
    // `tls` and `publicHost` are optional and absent from a defaulted
    // config, so they're asserted against the table rather than the value.
    const present = Object.keys(baseConfig().daemon);
    for (const key of present) {
      expect(Object.keys(DAEMON_CONFIG_TIERS)).toContain(key);
    }
    for (const key of Object.keys(DAEMON_CONFIG_TIERS)) {
      expect([...present, "tls", "publicHost"]).toContain(key);
    }
  });

  it("defaults an unknown key to restart rather than live", () => {
    // Loud and wrong beats quiet and wrong: a key nobody classified must
    // not silently behave as though the daemon re-reads it.
    expect(tierFor("some-key-nobody-classified").reload).toBe("restart");
    expect(daemonTierFor("some-key-nobody-classified").reload).toBe("restart");
  });

  it("keeps tui out of the digest via its tier, not a special case", () => {
    expect(CONFIG_TIERS.tui.reload).toBe("client");
  });

  it("reports every non-effective key with a reason", () => {
    for (const entry of overlayLimitedKeys()) {
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });
});

describe("computeConfigDigest", () => {
  it("ignores changes to keys the daemon re-reads", () => {
    // The whole point: editing your default agent must not brick the CLI
    // against a healthy daemon.
    const a = baseConfig();
    const b = { ...baseConfig(), defaultAgent: "something-else" };
    expect(computeConfigDigest(a)).toBe(computeConfigDigest(b));
  });

  it("ignores tui and sessionDefaults and agents", () => {
    const a = baseConfig();
    const b: HydraConfig = {
      ...baseConfig(),
      sessionDefaults: { "claude-acp": { model: "opus" } },
      agents: { foo: { command: "/bin/foo" } },
      tui: { ...baseConfig().tui, mouse: !baseConfig().tui.mouse },
    };
    expect(computeConfigDigest(a)).toBe(computeConfigDigest(b));
  });

  it("changes when a restart-tier key changes", () => {
    const a = baseConfig();
    const b: HydraConfig = {
      ...baseConfig(),
      daemon: { ...baseConfig().daemon, port: baseConfig().daemon.port + 1 },
    };
    expect(computeConfigDigest(a)).not.toBe(computeConfigDigest(b));
  });

  it("ignores warn-tier daemon sub-keys", () => {
    const a = baseConfig();
    const b: HydraConfig = {
      ...baseConfig(),
      daemon: { ...baseConfig().daemon, logLevel: "debug" },
    };
    expect(computeConfigDigest(a)).toBe(computeConfigDigest(b));
  });
});

describe("configDriftSummary", () => {
  it("reports a warn-tier key that changed", () => {
    const booted = baseConfig();
    const current: HydraConfig = { ...baseConfig(), synopsisModel: "haiku" };
    expect(configDriftSummary(booted, current)).toContain("synopsisModel");
  });

  it("reports a warn-tier daemon sub-key with its dotted path", () => {
    const booted = baseConfig();
    const current: HydraConfig = {
      ...baseConfig(),
      daemon: { ...baseConfig().daemon, logLevel: "debug" },
    };
    expect(configDriftSummary(booted, current)).toEqual(["daemon.logLevel"]);
  });

  it("stays silent for live-tier and restart-tier keys", () => {
    // live: the daemon re-read it, nothing to report.
    // restart: the digest already refuses, so reporting it twice would
    // just be noise.
    const booted = baseConfig();
    const current: HydraConfig = {
      ...baseConfig(),
      defaultAgent: "other",
      sessionDefaults: { x: { model: "y" } },
      daemon: { ...baseConfig().daemon, port: 9999 },
    };
    expect(configDriftSummary(booted, current)).toEqual([]);
  });

  it("clears once a key is reverted, since drift is measured from boot", () => {
    const booted = baseConfig();
    expect(configDriftSummary(booted, baseConfig())).toEqual([]);
  });
});
