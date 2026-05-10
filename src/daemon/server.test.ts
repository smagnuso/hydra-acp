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
      sessionRecentMinutes: 30,
    },
    registry: {
      url: "http://127.0.0.1:65535/never-reached",
      ttlHours: 24,
    },
    defaultAgent: "claude-code",
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
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "acp-hydra-test-"));
    process.env.ACP_HYDRA_HOME = tmpHome;
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
    delete process.env.ACP_HYDRA_HOME;
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
              attach?: { roles: string[] };
              list?: boolean;
            };
            promptCapabilities?: { image?: boolean };
          };
        };
      };

      expect(response.id).toBe(1);
      expect(response.result.agentInfo.name).toBe("acp-hydra");
      expect(response.result.agentCapabilities.sessionCapabilities?.list).toBe(
        true,
      );
      expect(
        response.result.agentCapabilities.sessionCapabilities?.attach?.roles,
      ).toEqual(expect.arrayContaining(["controller", "observer"]));
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
