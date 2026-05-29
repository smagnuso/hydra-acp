import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import type { AddressInfo } from "node:net";
import { startDaemon, type DaemonHandle } from "../server.js";
import type { HydraConfig } from "../../core/config.js";
import { setPassword } from "../../core/password.js";

const TEST_TOKEN = "hydra_token_0123456789abcdef0123456789abcdef";
const PASSWORD = "correct horse battery staple";

function testConfig(): HydraConfig {
  return {
    daemon: {
      host: "127.0.0.1",
      port: 0,
      logLevel: "warn",
      sessionIdleTimeoutSeconds: 30,
      sessionHistoryMaxEntries: 1000,
      agentStderrTailBytes: 4096,
      agentSyncIntervalMinutes: 0,
    },
    registry: {
      url: "http://127.0.0.1:65535/never-reached",
      ttlHours: 24,
    },
    defaultAgent: "claude-acp",
    defaultModels: {},
    synopsisOnClose: false,
    defaultCwd: os.homedir(),
    sessionListColdLimit: 20,
    extensions: {},
    transformers: {},
    defaultTransformers: [],
    tui: {
      repaintThrottleMs: 1000,
      maxScrollbackLines: 10_000,
      mouse: false,
      logMaxBytes: 5 * 1024 * 1024,
      cwdColumnMaxWidth: 24,
      progressIndicator: true,
      defaultEnterAction: "amend" as const,
      showThoughts: true,
      promptHistoryMaxEntries: 2_000,
      maxToolItems: 5,
      maxPlanItems: 5,
      showFileUpdates: "none" as const,
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

describe("auth routes — POST /v1/auth/login (no password configured)", () => {
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

  it("returns 403 when no password is set", async () => {
    const r = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "anything" }),
    });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/No password configured/);
  });
});

describe("auth routes — password configured", () => {
  let handle: DaemonHandle | null = null;
  let baseUrl: string;

  beforeEach(async () => {
    await setPassword(PASSWORD);
    handle = await startDaemon(testConfig(), TEST_TOKEN);
    baseUrl = `http://127.0.0.1:${port(handle)}`;
  });

  afterEach(async () => {
    if (handle) {
      await handle.shutdown().catch(() => undefined);
      handle = null;
    }
  });

  it("issues a session token on a correct password", async () => {
    const r = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD, label: "test" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      session_token: string;
      id: string;
      expires_at: string;
    };
    expect(body.session_token.startsWith("hydra_session_")).toBe(true);
    expect(typeof body.id).toBe("string");
    expect(typeof body.expires_at).toBe("string");
  });

  it("rejects a wrong password with 401", async () => {
    const r = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(r.status).toBe(401);
  });

  it("rejects malformed body with 400", async () => {
    const r = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  it("the issued session token authenticates subsequent REST calls", async () => {
    const login = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const body = (await login.json()) as { session_token: string };
    const r = await fetch(`${baseUrl}/v1/sessions`, {
      headers: { Authorization: `Bearer ${body.session_token}` },
    });
    expect(r.status).toBe(200);
  });

  it("the service token still authenticates after step 2", async () => {
    const r = await fetch(`${baseUrl}/v1/sessions`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(r.status).toBe(200);
  });

  it("/v1/auth/verify with valid bearer returns 200", async () => {
    const r = await fetch(`${baseUrl}/v1/auth/verify`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(r.status).toBe(200);
  });

  it("/v1/auth/verify without bearer returns 401", async () => {
    const r = await fetch(`${baseUrl}/v1/auth/verify`);
    expect(r.status).toBe(401);
  });

  it("GET /v1/auth/sessions lists active session tokens", async () => {
    const login = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD, label: "alpha" }),
    });
    const issued = (await login.json()) as { id: string };

    const list = await fetch(`${baseUrl}/v1/auth/sessions`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      sessions: Array<{ id: string; label?: string }>;
    };
    expect(body.sessions).toContainEqual(
      expect.objectContaining({ id: issued.id, label: "alpha" }),
    );
  });

  it("DELETE /v1/auth/sessions/:id revokes a session token", async () => {
    const login = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const issued = (await login.json()) as {
      session_token: string;
      id: string;
    };

    // Use a different bearer to revoke (service token) so the call survives.
    const del = await fetch(`${baseUrl}/v1/auth/sessions/${issued.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(del.status).toBe(204);

    // The revoked session token is now rejected.
    const r = await fetch(`${baseUrl}/v1/sessions`, {
      headers: { Authorization: `Bearer ${issued.session_token}` },
    });
    expect(r.status).toBe(403);
  });

  it("DELETE /v1/auth/sessions/:id returns 404 for unknown id", async () => {
    const r = await fetch(`${baseUrl}/v1/auth/sessions/does-not-exist`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(r.status).toBe(404);
  });

  it("POST /v1/auth/logout revokes the current session token", async () => {
    const login = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const issued = (await login.json()) as { session_token: string };
    const logout = await fetch(`${baseUrl}/v1/auth/logout`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.session_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(logout.status).toBe(200);
    const body = (await logout.json()) as { revoked: boolean };
    expect(body.revoked).toBe(true);

    // Subsequent use of that bearer is rejected.
    const r = await fetch(`${baseUrl}/v1/sessions`, {
      headers: { Authorization: `Bearer ${issued.session_token}` },
    });
    expect(r.status).toBe(403);
  });

  it("POST /v1/auth/logout is a no-op when bearered with the service token", async () => {
    const r = await fetch(`${baseUrl}/v1/auth/logout`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { revoked: boolean };
    expect(body.revoked).toBe(false);
  });
});
