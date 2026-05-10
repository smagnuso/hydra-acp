import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ExtensionManager, type ExtensionContext } from "./extensions.js";
import type { ExtensionConfig } from "./config.js";

function makeContext(home: string): ExtensionContext {
  return {
    daemonUrl: "http://127.0.0.1:8765",
    daemonHost: "127.0.0.1",
    daemonPort: 8765,
    daemonToken: "hydra_token_test",
    daemonWsUrl: "ws://127.0.0.1:8765/acp",
    hydraHome: home,
  };
}

const PROBE_SCRIPT = `
const fs = require('node:fs');
const out = process.env.PROBE_OUT;
fs.writeFileSync(out, JSON.stringify({
  url: process.env.ACP_HYDRA_DAEMON_URL,
  host: process.env.ACP_HYDRA_DAEMON_HOST,
  port: process.env.ACP_HYDRA_DAEMON_PORT,
  token: process.env.ACP_HYDRA_TOKEN,
  ws: process.env.ACP_HYDRA_WS_URL,
  home: process.env.ACP_HYDRA_HOME,
  name: process.env.ACP_HYDRA_EXTENSION_NAME,
  custom: process.env.MY_CUSTOM_ENV,
}));
process.stdout.write('probe ready\\n');
setInterval(() => {}, 60_000);
`;

describe("ExtensionManager", () => {
  let tmpHome: string;
  let probeOut: string;
  let manager: ExtensionManager | undefined;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "acp-hydra-ext-"));
    process.env.ACP_HYDRA_HOME = tmpHome;
    probeOut = path.join(tmpHome, "probe-out.json");
  });

  afterEach(async () => {
    if (manager) {
      await manager.stop();
      manager = undefined;
    }
    delete process.env.ACP_HYDRA_HOME;
    await fs.rm(tmpHome, { recursive: true, force: true });
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

  it("writes a log file at ~/.acp-hydra/extensions/<name>.log", async () => {
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
});
