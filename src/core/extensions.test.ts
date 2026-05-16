import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ExtensionManager, type ExtensionContext } from "./extensions.js";
import type { ExtensionConfig } from "./config.js";

function makeContext(home: string): ExtensionContext {
  return {
    daemonUrl: "http://127.0.0.1:8765",
    daemonHost: "127.0.0.1",
    daemonPort: 8765,
    serviceToken: "hydra_token_test",
    daemonWsUrl: "ws://127.0.0.1:8765/acp",
    hydraHome: home,
  };
}

const PROBE_SCRIPT = `
const fs = require('node:fs');
const out = process.env.PROBE_OUT;
fs.writeFileSync(out, JSON.stringify({
  url: process.env.HYDRA_ACP_DAEMON_URL,
  host: process.env.HYDRA_ACP_DAEMON_HOST,
  port: process.env.HYDRA_ACP_DAEMON_PORT,
  token: process.env.HYDRA_ACP_TOKEN,
  ws: process.env.HYDRA_ACP_WS_URL,
  home: process.env.HYDRA_ACP_HOME,
  name: process.env.HYDRA_ACP_EXTENSION_NAME,
  custom: process.env.MY_CUSTOM_ENV,
}));
process.stdout.write('probe ready\\n');
setInterval(() => {}, 60_000);
`;

describe("ExtensionManager", () => {
  let tmpHome: string;
  let probeOut: string;
  let manager: ExtensionManager | undefined;

  beforeEach(() => {
    tmpHome = process.env.HYDRA_ACP_HOME!;
    probeOut = path.join(tmpHome, "probe-out.json");
  });

  afterEach(async () => {
    if (manager) {
      await manager.stop();
      manager = undefined;
    }
  });

  async function waitForProbe(timeoutMs = 3_000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const raw = await fs.readFile(probeOut, "utf8");
        if (raw.length > 0) {
          return JSON.parse(raw);
        }
      } catch {
        void 0;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`probe did not emit data within ${timeoutMs}ms`);
  }

  it("spawns extensions with hydra env vars set, plus user-supplied env", async () => {
    const cfg: ExtensionConfig = {
      name: "probe",
      command: ["node", "-e", PROBE_SCRIPT],
      args: [],
      env: { PROBE_OUT: probeOut, MY_CUSTOM_ENV: "hello" },
      enabled: true,
    };
    manager = new ExtensionManager([cfg], makeContext(tmpHome));
    await manager.start();

    const probe = (await waitForProbe()) as Record<string, string | undefined>;

    expect(probe.url).toBe("http://127.0.0.1:8765");
    expect(probe.host).toBe("127.0.0.1");
    expect(probe.port).toBe("8765");
    expect(probe.token).toBe("hydra_token_test");
    expect(probe.ws).toBe("ws://127.0.0.1:8765/acp");
    expect(probe.home).toBe(tmpHome);
    expect(probe.name).toBe("probe");
    expect(probe.custom).toBe("hello");
  });

  it("skips disabled extensions", async () => {
    const cfg: ExtensionConfig = {
      name: "disabled",
      command: ["node", "-e", PROBE_SCRIPT],
      args: [],
      env: { PROBE_OUT: probeOut },
      enabled: false,
    };
    manager = new ExtensionManager([cfg], makeContext(tmpHome));
    await manager.start();

    await new Promise((r) => setTimeout(r, 200));
    await expect(fs.readFile(probeOut, "utf8")).rejects.toThrow();
  });

  it("stop() terminates running extensions", async () => {
    const cfg: ExtensionConfig = {
      name: "long",
      command: ["node", "-e", PROBE_SCRIPT],
      args: [],
      env: { PROBE_OUT: probeOut },
      enabled: true,
    };
    manager = new ExtensionManager([cfg], makeContext(tmpHome));
    await manager.start();
    await waitForProbe();

    const pid = manager.list()[0]?.pid;
    expect(pid).toBeGreaterThan(0);

    await manager.stop();
    manager = undefined;

    await new Promise((r) => setTimeout(r, 100));
    if (typeof pid === "number") {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  });

  it("writes a pid file on spawn and unlinks it on stop", async () => {
    const cfg: ExtensionConfig = {
      name: "pidf",
      command: ["node", "-e", PROBE_SCRIPT],
      args: [],
      env: { PROBE_OUT: probeOut },
      enabled: true,
    };
    manager = new ExtensionManager([cfg], makeContext(tmpHome));
    await manager.start();
    await waitForProbe();

    const pidPath = path.join(tmpHome, "extensions", "pidf.pid");
    const raw = await fs.readFile(pidPath, "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    expect(pid).toBeGreaterThan(0);

    await manager.stop();
    manager = undefined;

    await new Promise((r) => setTimeout(r, 100));
    await expect(fs.access(pidPath)).rejects.toThrow();
  });

  it("reaps orphan extensions from a prior daemon run on start", async () => {
    const { spawn } = await import("node:child_process");
    const orphanOut = path.join(tmpHome, "orphan-out.json");
    await fs.mkdir(path.join(tmpHome, "extensions"), { recursive: true });
    const orphan = spawn("node", ["-e", PROBE_SCRIPT], {
      env: { ...process.env, PROBE_OUT: orphanOut },
      stdio: "ignore",
      detached: true,
    });
    orphan.unref();
    if (typeof orphan.pid !== "number") {
      throw new Error("could not spawn orphan");
    }
    const pidPath = path.join(tmpHome, "extensions", "ghost.pid");
    await fs.writeFile(pidPath, `${orphan.pid}\n`);

    let alive = false;
    try {
      process.kill(orphan.pid, 0);
      alive = true;
    } catch {
      void 0;
    }
    expect(alive).toBe(true);

    manager = new ExtensionManager([], makeContext(tmpHome));
    await manager.start();

    await new Promise((r) => setTimeout(r, 200));
    let stillAlive = false;
    try {
      process.kill(orphan.pid, 0);
      stillAlive = true;
    } catch {
      void 0;
    }
    expect(stillAlive).toBe(false);
    await expect(fs.access(pidPath)).rejects.toThrow();
  });

  it("defaults command to [name] when omitted", async () => {
    const cfg: ExtensionConfig = {
      name: "node",
      command: [],
      args: ["-e", PROBE_SCRIPT],
      env: { PROBE_OUT: probeOut },
      enabled: true,
    };
    manager = new ExtensionManager([cfg], makeContext(tmpHome));
    await manager.start();
    const probe = (await waitForProbe()) as Record<string, string | undefined>;
    expect(probe.name).toBe("node");
  });

  it("writes a log file at ~/.hydra-acp/extensions/<name>.log", async () => {
    const cfg: ExtensionConfig = {
      name: "loggy",
      command: ["node", "-e", PROBE_SCRIPT],
      args: [],
      env: { PROBE_OUT: probeOut },
      enabled: true,
    };
    manager = new ExtensionManager([cfg], makeContext(tmpHome));
    await manager.start();
    await waitForProbe();

    const logPath = path.join(tmpHome, "extensions", "loggy.log");
    const content = await fs.readFile(logPath, "utf8");
    expect(content).toContain("starting extension loggy");
    expect(content).toContain("probe ready");
  });

  describe("per-name lifecycle", () => {
    it("list() reports running with pid + restartCount + status + logPath", async () => {
      const cfg: ExtensionConfig = {
        name: "lst",
        command: ["node", "-e", PROBE_SCRIPT],
        args: [],
        env: { PROBE_OUT: probeOut },
        enabled: true,
      };
      manager = new ExtensionManager([cfg], makeContext(tmpHome));
      await manager.start();
      await waitForProbe();

      const info = manager.list();
      expect(info).toHaveLength(1);
      expect(info[0]?.name).toBe("lst");
      expect(info[0]?.status).toBe("running");
      expect(info[0]?.pid).toBeGreaterThan(0);
      expect(info[0]?.enabled).toBe(true);
      expect(info[0]?.restartCount).toBe(0);
      expect(info[0]?.startedAt).toBeGreaterThan(0);
      expect(info[0]?.logPath).toContain("extensions/lst.log");
    });

    it("stopByName() suppresses auto-restart (manuallyStopped flag)", async () => {
      const cfg: ExtensionConfig = {
        name: "manual",
        command: ["node", "-e", PROBE_SCRIPT],
        args: [],
        env: { PROBE_OUT: probeOut },
        enabled: true,
      };
      manager = new ExtensionManager([cfg], makeContext(tmpHome));
      await manager.start();
      await waitForProbe();

      const before = manager.list()[0];
      expect(before?.status).toBe("running");
      const pidBefore = before?.pid;

      await manager.stopByName("manual");

      const afterStop = manager.list()[0];
      expect(afterStop?.status).toBe("stopped");
      expect(afterStop?.pid).toBeUndefined();
      if (typeof pidBefore === "number") {
        expect(() => process.kill(pidBefore, 0)).toThrow();
      }

      // wait longer than the default restart backoff to confirm
      // the supervisor doesn't respawn manually-stopped children.
      await new Promise((r) => setTimeout(r, 1500));
      expect(manager.list()[0]?.status).toBe("stopped");
    });

    it("startByName() respawns a previously stopped extension", async () => {
      const cfg: ExtensionConfig = {
        name: "respawn",
        command: ["node", "-e", PROBE_SCRIPT],
        args: [],
        env: { PROBE_OUT: probeOut },
        enabled: true,
      };
      manager = new ExtensionManager([cfg], makeContext(tmpHome));
      await manager.start();
      await waitForProbe();
      await manager.stopByName("respawn");
      expect(manager.list()[0]?.status).toBe("stopped");

      await fs.unlink(probeOut).catch(() => undefined);
      await manager.startByName("respawn");
      await waitForProbe();
      expect(manager.list()[0]?.status).toBe("running");
      expect(manager.list()[0]?.pid).toBeGreaterThan(0);
    });

    it("restartByName() returns a different pid", async () => {
      const cfg: ExtensionConfig = {
        name: "bounce",
        command: ["node", "-e", PROBE_SCRIPT],
        args: [],
        env: { PROBE_OUT: probeOut },
        enabled: true,
      };
      manager = new ExtensionManager([cfg], makeContext(tmpHome));
      await manager.start();
      await waitForProbe();
      const pidBefore = manager.list()[0]?.pid;

      await fs.unlink(probeOut).catch(() => undefined);
      await manager.restartByName("bounce");
      await waitForProbe();
      const pidAfter = manager.list()[0]?.pid;

      expect(pidAfter).toBeGreaterThan(0);
      expect(pidAfter).not.toBe(pidBefore);
      expect(manager.list()[0]?.status).toBe("running");
    });

    it("startByName() throws CONFLICT if already running", async () => {
      const cfg: ExtensionConfig = {
        name: "dup",
        command: ["node", "-e", PROBE_SCRIPT],
        args: [],
        env: { PROBE_OUT: probeOut },
        enabled: true,
      };
      manager = new ExtensionManager([cfg], makeContext(tmpHome));
      await manager.start();
      await waitForProbe();

      await expect(manager.startByName("dup")).rejects.toMatchObject({
        code: "CONFLICT",
      });
    });

    it("startByName() throws NOT_FOUND for unknown extension", async () => {
      manager = new ExtensionManager([], makeContext(tmpHome));
      await manager.start();
      await expect(manager.startByName("ghost")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });
  });
});
