import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { startDaemon, type DaemonHandle } from "./server.js";
import type { HydraConfig } from "../core/config.js";

const TEST_TOKEN = "hydra_token_0123456789abcdef0123456789abcdef";

function testConfig(): HydraConfig {
  return {
    daemon: {
      host: "127.0.0.1",
      port: 0,
      authToken: TEST_TOKEN,
      logLevel: "warn",
      sessionIdleTimeoutSeconds: 30,
    },
    registry: {
      url: "http://127.0.0.1:65535/never-reached",
      ttlHours: 24,
    },
    defaultAgent: "claude-acp",
    defaultCwd: os.homedir(),
    extensions: {},
  };
}

function port(handle: DaemonHandle): number {
  const addr = handle.app.server.address() as AddressInfo | string | null;
  if (!addr || typeof addr === "string") {
    throw new Error("server has no bound port");
  }
  return addr.port;
}

describe("startDaemon", () => {
  let tmpHome: string;
  let handle: DaemonHandle | null = null;
  let baseUrl: string;
  let wsUrl: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-acp-test-"));
    process.env.HYDRA_ACP_HOME = tmpHome;
    handle = await startDaemon(testConfig());
    const p = port(handle);
    baseUrl = `http://127.0.0.1:${p}`;
    wsUrl = `ws://127.0.0.1:${p}/acp`;
  });

  afterEach(async () => {
    if (handle) {
      await handle.shutdown().catch(() => undefined);
      handle = null;
    }
    delete process.env.HYDRA_ACP_HOME;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  describe("REST", () => {
    it("serves /v1/health without auth", async () => {
      const r = await fetch(`${baseUrl}/v1/health`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { status: string; version: string };
      expect(body.status).toBe("ok");
      expect(typeof body.version).toBe("string");
    });

    it("rejects /v1/sessions without bearer token", async () => {
      const r = await fetch(`${baseUrl}/v1/sessions`);
      expect(r.status).toBe(401);
    });

    it("rejects /v1/sessions with the wrong bearer token", async () => {
      const r = await fetch(`${baseUrl}/v1/sessions`, {
        headers: { Authorization: "Bearer hydra_token_wrong" },
      });
      expect(r.status).toBe(403);
    });

    it("returns an empty session list with a valid bearer token", async () => {
      const r = await fetch(`${baseUrl}/v1/sessions`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { sessions: unknown[] };
      expect(body.sessions).toEqual([]);
    });

    it("returns 404 when killing an unknown session", async () => {
      const r = await fetch(`${baseUrl}/v1/sessions/sess_unknown`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(r.status).toBe(404);
    });

    it("returns 404 fetching history for an unknown session", async () => {
      const r = await fetch(
        `${baseUrl}/v1/sessions/hydra_session_unknown/history`,
        {
          headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        },
      );
      expect(r.status).toBe(404);
    });

    it("rejects /v1/sessions/:id/history without bearer token", async () => {
      const r = await fetch(`${baseUrl}/v1/sessions/x/history`);
      expect(r.status).toBe(401);
    });

    it("rejects /v1/extensions without bearer token", async () => {
      const r = await fetch(`${baseUrl}/v1/extensions`);
      expect(r.status).toBe(401);
    });

    it("returns an empty extensions list with a valid bearer token", async () => {
      const r = await fetch(`${baseUrl}/v1/extensions`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { extensions: unknown[] };
      expect(body.extensions).toEqual([]);
    });

    it("returns 404 starting an unknown extension", async () => {
      const r = await fetch(`${baseUrl}/v1/extensions/ghost/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(r.status).toBe(404);
    });
  });

  describe("WSS handshake + initialize", () => {
    it("rejects WSS upgrade without a token", async () => {
      const ws = new WebSocket(wsUrl);
      const code = await new Promise<number>((resolve) => {
        ws.once("close", (c) => resolve(c));
        ws.once("error", () => undefined);
      });
      expect(code).toBe(4401);
    });

    it("accepts WSS with a token in the query string", async () => {
      const ws = new WebSocket(`${wsUrl}?token=${TEST_TOKEN}`);
      try {
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", reject);
        });
      } finally {
        ws.close();
      }
    });

    it("responds to initialize with hydra capabilities", async () => {
      const ws = new WebSocket(`${wsUrl}?token=${TEST_TOKEN}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });

      const responsePromise = new Promise<unknown>((resolve) => {
        ws.on("message", (data) => {
          resolve(JSON.parse(data.toString("utf8")));
        });
      });

      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "test-client" },
          },
        }),
      );

      const response = (await responsePromise) as {
        id: number;
        result: {
          protocolVersion: number;
          agentInfo: { name: string };
          agentCapabilities: {
            sessionCapabilities?: {
              attach?: Record<string, never>;
              list?: boolean;
            };
            promptCapabilities?: { image?: boolean };
          };
        };
      };

      expect(response.id).toBe(1);
      expect(response.result.agentInfo.name).toBe("hydra");
      expect(response.result.agentCapabilities.sessionCapabilities?.list).toBe(
        true,
      );
      expect(
        response.result.agentCapabilities.sessionCapabilities?.attach,
      ).toBeDefined();
      expect(response.result.agentCapabilities.promptCapabilities?.image).toBe(
        true,
      );

      ws.close();
    });

    it("returns an empty session/list over ACP", async () => {
      const ws = new WebSocket(`${wsUrl}?token=${TEST_TOKEN}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });

      const responsePromise = new Promise<unknown>((resolve) => {
        ws.on("message", (data) =>
          resolve(JSON.parse(data.toString("utf8"))),
        );
      });

      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "session/list",
          params: {},
        }),
      );

      const response = (await responsePromise) as {
        id: number;
        result: { sessions: unknown[] };
      };
      expect(response.id).toBe(9);
      expect(response.result.sessions).toEqual([]);

      ws.close();
    });

    it("accepts session/cancel as a notification (spec form)", async () => {
      // Regression: pre-fix the daemon registered onRequest only, so a
      // spec-compliant client (no `id`) had its cancel silently dropped.
      const ws = new WebSocket(`${wsUrl}?token=${TEST_TOKEN}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });

      let gotMessage: unknown = null;
      ws.on("message", (data) => {
        gotMessage = JSON.parse(data.toString("utf8"));
      });

      // Send session/cancel as a *notification* — no `id` field.
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId: "no-such-session" },
        }),
      );

      // Followed by a real request whose response we can wait for; if the
      // notification got mishandled (e.g. processed as a request and
      // produced an error response with id:undefined), the next
      // round-trip's response would be wrong.
      const followUp = new Promise<{ id: number; result: unknown }>(
        (resolve) => {
          ws.on("message", (data) => {
            const parsed = JSON.parse(data.toString("utf8")) as {
              id?: number;
              result?: unknown;
            };
            if (parsed.id === 42) {
              resolve(parsed as { id: number; result: unknown });
            }
          });
        },
      );
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "session/list",
          params: {},
        }),
      );
      const response = await followUp;
      expect(response.id).toBe(42);
      // Notifications produce no response — gotMessage should be the
      // session/list response, not anything synthesized for cancel.
      expect((gotMessage as { id?: number }).id).toBe(42);

      ws.close();
    });

    it("accepts session/cancel as a request for backward compat", async () => {
      const ws = new WebSocket(`${wsUrl}?token=${TEST_TOKEN}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });

      const responsePromise = new Promise<{
        id: number;
        result?: unknown;
        error?: unknown;
      }>((resolve) => {
        ws.on("message", (data) => {
          resolve(JSON.parse(data.toString("utf8")));
        });
      });

      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "session/cancel",
          params: { sessionId: "no-such-session" },
        }),
      );

      const response = await responsePromise;
      expect(response.id).toBe(7);
      // No session attached → no error surfaced to the client (the cancel
      // is a no-op when the session can't be found, matching the
      // notification path's silent behavior).
      expect(response.error).toBeUndefined();

      ws.close();
    });
  });

  describe("lifecycle", () => {
    it("writes a daemon.pid file at startup", async () => {
      const pidPath = path.join(tmpHome, "daemon.pid");
      const raw = await fs.readFile(pidPath, "utf8");
      const info = JSON.parse(raw) as { pid: number; port: number };
      expect(info.pid).toBe(process.pid);
      expect(info.port).toBe(port(handle!));
    });

    it("removes daemon.pid on shutdown", async () => {
      await handle!.shutdown();
      handle = null;
      const pidPath = path.join(tmpHome, "daemon.pid");
      await expect(fs.access(pidPath)).rejects.toThrow();
    });

    it("shutdown is idempotent", async () => {
      await handle!.shutdown();
      await expect(handle!.shutdown()).resolves.toBeUndefined();
      handle = null;
    });

    it("rotates logs into daemon.<N>.log files with a current.log symlink", async () => {
      handle!.app.log.warn("test-marker-line");

      await handle!.shutdown();
      handle = null;

      const entries = await fs.readdir(tmpHome);
      const logFiles = entries.filter((e) => /^daemon\.\d+\.log$/.test(e));
      expect(logFiles.length).toBeGreaterThanOrEqual(1);
      expect(entries).toContain("current.log");

      const symlinkPath = path.join(tmpHome, "current.log");
      const contents = await fs.readFile(symlinkPath, "utf8");
      expect(contents.length).toBeGreaterThan(0);
      expect(contents).toContain("test-marker-line");
      const firstLine = contents.split("\n")[0];
      expect(() => JSON.parse(firstLine!)).not.toThrow();
    });
  });

  describe("non-loopback bind", () => {
    it("refuses to bind to non-loopback without TLS", async () => {
      const cfg = testConfig();
      cfg.daemon.host = "0.0.0.0";
      await expect(startDaemon(cfg)).rejects.toThrow(/non-loopback/);
    });
  });
});

const PROBE_SCRIPT = `setInterval(() => {}, 60_000);`;

describe("startDaemon — extensions REST lifecycle", () => {
  let tmpHome: string;
  let handle: DaemonHandle | null = null;
  let baseUrl: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-acp-test-"));
    process.env.HYDRA_ACP_HOME = tmpHome;
    const cfg: HydraConfig = {
      daemon: {
        host: "127.0.0.1",
        port: 0,
        authToken: TEST_TOKEN,
        logLevel: "warn",
        sessionIdleTimeoutSeconds: 30,
      },
      registry: {
        url: "http://127.0.0.1:65535/never-reached",
        ttlHours: 24,
      },
      defaultAgent: "claude-acp",
      defaultCwd: os.homedir(),
      extensions: {
        probe: {
          command: ["node", "-e", PROBE_SCRIPT],
          args: [],
          env: {},
          enabled: true,
        },
      },
    };
    handle = await startDaemon(cfg);
    const p = port(handle);
    baseUrl = `http://127.0.0.1:${p}`;
  });

  afterEach(async () => {
    if (handle) {
      await handle.shutdown().catch(() => undefined);
      handle = null;
    }
    delete process.env.HYDRA_ACP_HOME;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("list shows the configured probe extension as running", async () => {
    // give the probe a moment to spawn
    await new Promise((r) => setTimeout(r, 200));
    const r = await fetch(`${baseUrl}/v1/extensions`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      extensions: Array<{ name: string; status: string; pid: number | null }>;
    };
    expect(body.extensions).toHaveLength(1);
    expect(body.extensions[0]?.name).toBe("probe");
    expect(body.extensions[0]?.status).toBe("running");
    expect(body.extensions[0]?.pid).toBeGreaterThan(0);
  });

  it("stop then start cycles a probe extension", async () => {
    await new Promise((r) => setTimeout(r, 200));
    const stopR = await fetch(`${baseUrl}/v1/extensions/probe/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(stopR.status).toBe(200);
    const stopped = (await stopR.json()) as { status: string };
    expect(stopped.status).toBe("stopped");

    const startR = await fetch(`${baseUrl}/v1/extensions/probe/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(startR.status).toBe(200);
    const started = (await startR.json()) as { status: string; pid: number };
    expect(started.status).toBe("running");
    expect(started.pid).toBeGreaterThan(0);
  });

  it("returns 409 starting an already-running extension", async () => {
    await new Promise((r) => setTimeout(r, 200));
    const r = await fetch(`${baseUrl}/v1/extensions/probe/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(r.status).toBe(409);
  });

  it("restart returns a new pid", async () => {
    await new Promise((r) => setTimeout(r, 200));
    const before = (await (
      await fetch(`${baseUrl}/v1/extensions/probe`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      })
    ).json()) as { pid: number };

    const r = await fetch(`${baseUrl}/v1/extensions/probe/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(r.status).toBe(200);
    const after = (await r.json()) as { status: string; pid: number };
    expect(after.status).toBe("running");
    expect(after.pid).toBeGreaterThan(0);
    expect(after.pid).not.toBe(before.pid);
  });
});
