import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import type { AddressInfo } from "node:net";
import { startDaemon, type DaemonHandle } from "../server.js";
import type { HydraConfig } from "../../core/config.js";
import { setPassword } from "../../core/password.js";
import { _resetForTests, getPin } from "../../core/tls-trust.js";

const A_TOKEN = "hydra_token_" + "a".repeat(52);
const B_TOKEN = "hydra_token_" + "b".repeat(52);
const PEER_PASSWORD = "correct horse battery staple";

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
    sessionDefaults: {},
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

// These tests spin up two real daemons on loopback — A (the daemon
// under test, exercising /v1/remotes) and B (the peer being federated
// with) — and drive the real /v1/auth/login + /v1/auth/logout exchange
// between them, the same way `hydra remote add` will in production.
describe("remote routes", () => {
  let a: DaemonHandle | null = null;
  let b: DaemonHandle | null = null;
  let aUrl: string;
  let bPort: number;

  beforeEach(async () => {
    _resetForTests();
    await setPassword(PEER_PASSWORD);
    b = await startDaemon(testConfig(), B_TOKEN);
    bPort = port(b);
    a = await startDaemon(testConfig(), A_TOKEN);
    aUrl = `http://127.0.0.1:${port(a)}`;
  });

  afterEach(async () => {
    await a?.shutdown().catch(() => undefined);
    await b?.shutdown().catch(() => undefined);
    a = null;
    b = null;
    _resetForTests();
  });

  it("POST /v1/remotes logs into the peer and stores a summary (no token)", async () => {
    const res = await fetch(`${aUrl}/v1/remotes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${A_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "b",
        host: "127.0.0.1",
        port: bPort,
        password: PEER_PASSWORD,
        label: "b-label",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("password");
    expect(body.name).toBe("b");
    expect(body.host).toBe("127.0.0.1");
    expect(body.port).toBe(bPort);
    expect(body.label).toBe("b-label");
    expect(typeof body.expiresAt).toBe("string");
    expect(typeof body.addedAt).toBe("string");
    // Seeded immediately from the login that just succeeded, not left
    // "unknown" until the next health-poll tick.
    expect(body.status).toBe("ok");
  });

  it("POST /v1/remotes rejects an invalid name", async () => {
    const res = await fetch(`${aUrl}/v1/remotes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${A_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "not a valid name",
        host: "127.0.0.1",
        port: bPort,
        password: PEER_PASSWORD,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /v1/remotes re-run under the same name refreshes rather than erroring", async () => {
    const first = await fetch(`${aUrl}/v1/remotes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${A_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "b", host: "127.0.0.1", port: bPort, password: PEER_PASSWORD }),
    });
    expect(first.status).toBe(201);
    const second = await fetch(`${aUrl}/v1/remotes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${A_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "b", host: "127.0.0.1", port: bPort, password: PEER_PASSWORD }),
    });
    expect(second.status).toBe(201);
    const list = await fetch(`${aUrl}/v1/remotes`, {
      headers: { Authorization: `Bearer ${A_TOKEN}` },
    });
    const body = (await list.json()) as { remotes: unknown[] };
    expect(body.remotes).toHaveLength(1);
  });

  it("GET /v1/remotes lists a previously added peer", async () => {
    await fetch(`${aUrl}/v1/remotes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${A_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "b", host: "127.0.0.1", port: bPort, password: PEER_PASSWORD }),
    });
    const list = await fetch(`${aUrl}/v1/remotes`, {
      headers: { Authorization: `Bearer ${A_TOKEN}` },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { remotes: Array<Record<string, unknown>> };
    expect(body.remotes).toHaveLength(1);
    const [summary] = body.remotes;
    expect(summary).not.toHaveProperty("token");
    expect(summary?.name).toBe("b");
    expect(summary?.port).toBe(bPort);
    expect(summary?.status).toBe("ok");
  });

  it("POST /v1/remotes with the wrong password returns 401 and stores nothing", async () => {
    const res = await fetch(`${aUrl}/v1/remotes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${A_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "b", host: "127.0.0.1", port: bPort, password: "wrong" }),
    });
    expect(res.status).toBe(401);
    const list = await fetch(`${aUrl}/v1/remotes`, {
      headers: { Authorization: `Bearer ${A_TOKEN}` },
    });
    const body = (await list.json()) as { remotes: unknown[] };
    expect(body.remotes).toHaveLength(0);
  });

  it("POST /v1/remotes against an unreachable peer returns 502", async () => {
    const res = await fetch(`${aUrl}/v1/remotes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${A_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "down", host: "127.0.0.1", port: 1, password: PEER_PASSWORD }),
    });
    expect(res.status).toBe(502);
  });

  it("DELETE /v1/remotes/:name revokes the token on the peer and forgets it locally", async () => {
    const add = await fetch(`${aUrl}/v1/remotes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${A_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "b", host: "127.0.0.1", port: bPort, password: PEER_PASSWORD }),
    });
    expect(add.status).toBe(201);

    // Confirm the token actually works against B before revoking, so the
    // later 403 check is meaningful and not just "token never worked".
    const listOnB = await fetch(`http://127.0.0.1:${bPort}/v1/auth/sessions`, {
      headers: { Authorization: `Bearer ${B_TOKEN}` },
    });
    const bSessions = (await listOnB.json()) as { sessions: Array<{ id: string }> };
    expect(bSessions.sessions.length).toBeGreaterThan(0);

    const del = await fetch(`${aUrl}/v1/remotes/b`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${A_TOKEN}` },
    });
    expect(del.status).toBe(204);

    const list = await fetch(`${aUrl}/v1/remotes`, {
      headers: { Authorization: `Bearer ${A_TOKEN}` },
    });
    const body = (await list.json()) as { remotes: unknown[] };
    expect(body.remotes).toHaveLength(0);

    // The token was actually revoked on B, not just forgotten locally.
    const listOnBAfter = await fetch(`http://127.0.0.1:${bPort}/v1/auth/sessions`, {
      headers: { Authorization: `Bearer ${B_TOKEN}` },
    });
    const bSessionsAfter = (await listOnBAfter.json()) as { sessions: unknown[] };
    expect(bSessionsAfter.sessions).toHaveLength(0);
  });

  it("DELETE /v1/remotes/:name returns 404 for a name that was never added", async () => {
    const del = await fetch(`${aUrl}/v1/remotes/never-added`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${A_TOKEN}` },
    });
    expect(del.status).toBe(404);
  });

  it("POST /v1/remotes with pinnedFingerprint sets the pin and persists it", async () => {
    const res = await fetch(`${aUrl}/v1/remotes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${A_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "b",
        host: "127.0.0.1",
        port: bPort,
        password: PEER_PASSWORD,
        pinnedFingerprint: "abc123",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { pinnedFingerprint?: string };
    expect(body.pinnedFingerprint).toBe("abc123");
    expect(getPin("127.0.0.1", bPort)).toBe("abc123");

    const list = await fetch(`${aUrl}/v1/remotes`, {
      headers: { Authorization: `Bearer ${A_TOKEN}` },
    });
    const listBody = (await list.json()) as {
      remotes: Array<{ pinnedFingerprint?: string }>;
    };
    expect(listBody.remotes[0]?.pinnedFingerprint).toBe("abc123");
  });

  it("DELETE /v1/remotes/:name clears the pin when no other remote shares its host:port", async () => {
    await fetch(`${aUrl}/v1/remotes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${A_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "b",
        host: "127.0.0.1",
        port: bPort,
        password: PEER_PASSWORD,
        pinnedFingerprint: "abc123",
      }),
    });
    expect(getPin("127.0.0.1", bPort)).toBe("abc123");

    await fetch(`${aUrl}/v1/remotes/b`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${A_TOKEN}` },
    });
    expect(getPin("127.0.0.1", bPort)).toBeUndefined();
  });

  it("DELETE /v1/remotes/:name leaves the pin alone when another remote still shares its host:port", async () => {
    for (const name of ["b1", "b2"]) {
      await fetch(`${aUrl}/v1/remotes`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${A_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          host: "127.0.0.1",
          port: bPort,
          password: PEER_PASSWORD,
          pinnedFingerprint: "abc123",
        }),
      });
    }
    expect(getPin("127.0.0.1", bPort)).toBe("abc123");

    await fetch(`${aUrl}/v1/remotes/b1`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${A_TOKEN}` },
    });
    // b2 still points at the same host:port — the pin must survive.
    expect(getPin("127.0.0.1", bPort)).toBe("abc123");
  });
});
