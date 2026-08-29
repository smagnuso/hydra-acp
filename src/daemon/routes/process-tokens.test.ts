import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import type { AddressInfo } from "node:net";
import { startDaemon, type DaemonHandle } from "../server.js";
import type { HydraConfig } from "../../core/config.js";

const TEST_TOKEN = "hydra_token_0123456789abcdef0123456789abcdef";

function testConfig(): HydraConfig {
  return {
    daemon: {
      host: "127.0.0.1",
      port: 0,
      logLevel: "warn",
      sessionIdleTimeoutSeconds: 30,
      nonInteractiveOrphanTimeoutSeconds: 30,
      sessionHistoryMaxEntries: 1000,
      sessionHistoryArchiveMaxBytes: 10_000_000,
      sessionHistoryArchiveTiers: 10,
      agentStderrTailBytes: 4096,
      agentSyncIntervalMinutes: 0,
      scrubEnv: [],
      sessionGcIntervalMinutes: 0,
      sessionGcMaxAgeDays: 2,
    },
    registry: {
      url: "http://127.0.0.1:65535/never-reached",
      ttlHours: 24,
      pinned: false,
    },
    defaultAgent: "claude-acp",
    defaultModels: {},
    defaultCwd: os.homedir(),
    compressToolContent: true,
    sessionListColdLimit: 20,
    agents: {},
    agentOverrides: {},
    extensions: {},
    transformers: {},
    defaultTransformers: [],
    tui: {
      composer: {
        top: { left: ["status"], right: ["usage"] },
        bottom: { left: [], right: ["helpHint"] },
        hintTurns: 3,
      },
      sessionbar: { left: ["cwd", "title"], right: ["agentModel"] },
      scriptRefreshMs: 5_000,
      repaintThrottleMs: 1000,
      maxScrollbackLines: 10_000,
      mouse: false,
      logMaxBytes: 5 * 1024 * 1024,
      cwdColumnMaxWidth: 24,
      progressIndicator: true,
      terminalHost: true,
      launcherModeWhenHosted: false,
      skipPermissions: false,
      defaultEnterAction: "amend" as const,
      showThoughts: true,
      ambiguousWidth: "narrow",
      toolContent: "inline",
      diffContextLines: 3,
      promptHistoryMaxEntries: 2_000,
      maxToolItems: 5,
      maxPlanItems: 5,
      showFileUpdates: "none" as const,
      selectionClipboard: "both" as const,
      sidebar: { enabled: false, border: "frame" as const, gadgets: [] },
      hotkeys: {},
    },
    compaction: {
      tailK: 0,
      maxIterations: 1,
      contextFraction: 0.5,
      hardCeilingFraction: 0.85,
      absoluteFallback: 120_000,
      idleBeforePromptMs: 300_000,
      modelContextWindows: {},
    },
  };
}

function port(handle: DaemonHandle): number {
  const addr = handle.app.server.address() as AddressInfo | string | null;
  if (!addr || typeof addr === "string") {
    throw new Error("server has no bound port");
  }
  return addr.port;
}

describe("process-token routes", () => {
  let handle: DaemonHandle | null = null;
  let baseUrl: string;

  beforeEach(async () => {
    handle = await startDaemon(testConfig(), TEST_TOKEN);
    baseUrl = `http://127.0.0.1:${port(handle)}`;
  });

  afterEach(async () => {
    if (handle) {
      await handle.shutdown().catch(() => undefined);
      handle = null;
    }
  });

  it("mints a script token for a service-token caller", async () => {
    const r = await fetch(`${baseUrl}/v1/process-tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionLabel: "script:test" }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { token: string };
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
  });

  it("rejects a mint request with malformed body", async () => {
    const r = await fetch(`${baseUrl}/v1/process-tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  it("a minted script token can reach the read-only allowlist", async () => {
    const mint = await fetch(`${baseUrl}/v1/process-tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionLabel: "script:test" }),
    });
    const { token } = (await mint.json()) as { token: string };

    const sessions = await fetch(`${baseUrl}/v1/sessions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(sessions.status).toBe(200);

    const cfg = await fetch(`${baseUrl}/v1/config`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(cfg.status).toBe(200);
  });

  it("a minted script token is denied outside the allowlist", async () => {
    const mint = await fetch(`${baseUrl}/v1/process-tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionLabel: "script:test" }),
    });
    const { token } = (await mint.json()) as { token: string };

    // Not on the allowlist: creating a session is a write, and minting
    // more tokens would let a script escalate its own trust.
    const createSession = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(createSession.status).toBe(403);

    const mintAgain = await fetch(`${baseUrl}/v1/process-tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionLabel: "script:escalate" }),
    });
    expect(mintAgain.status).toBe(403);
  });

  it("revoking a sessionLabel invalidates every token minted under it", async () => {
    const mintA = await fetch(`${baseUrl}/v1/process-tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionLabel: "script:shared" }),
    });
    const { token: tokenA } = (await mintA.json()) as { token: string };
    const mintB = await fetch(`${baseUrl}/v1/process-tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionLabel: "script:shared" }),
    });
    const { token: tokenB } = (await mintB.json()) as { token: string };
    expect(tokenA).not.toBe(tokenB);

    const del = await fetch(
      `${baseUrl}/v1/process-tokens/${encodeURIComponent("script:shared")}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      },
    );
    expect(del.status).toBe(204);

    for (const token of [tokenA, tokenB]) {
      const r = await fetch(`${baseUrl}/v1/sessions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(r.status).toBe(403);
    }
  });

  it("rejects mint with an invalid bearer token", async () => {
    const mint = await fetch(`${baseUrl}/v1/process-tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer wrong-token`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionLabel: "script:test" }),
    });
    expect(mint.status).toBe(403);
  });
});
