import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { paths } from "./paths.js";
import type { ExtensionConfig } from "./config.js";

export interface ExtensionContext {
  daemonUrl: string;
  daemonHost: string;
  daemonPort: number;
  daemonToken: string;
  daemonWsUrl: string;
  hydraHome: string;
}

const RESTART_BASE_MS = 1_000;
const RESTART_CAP_MS = 60_000;
const STOP_GRACE_MS = 3_000;

interface RunningExtension {
  config: ExtensionConfig;
  child: ChildProcess;
  logStream: fs.WriteStream;
  restartTimer?: NodeJS.Timeout;
}

export class ExtensionManager {
  private running = new Set<RunningExtension>();
  private stopping = false;

  constructor(
    private extensions: ExtensionConfig[],
    private context: ExtensionContext,
  ) {}

  async start(): Promise<void> {
    await fsp.mkdir(paths.extensionsDir(), { recursive: true });
    await this.reapOrphans();
    if (this.extensions.length === 0) {
      return;
    }
    for (const ext of this.extensions) {
      if (!ext.enabled) {
        continue;
      }
      this.spawnExtension(ext, 0);
    }
  }

  private async reapOrphans(): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(paths.extensionsDir());
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".pid")) {
        continue;
      }
      const pidPath = path.join(paths.extensionsDir(), entry);
      let pid: number | undefined;
      try {
        const raw = await fsp.readFile(pidPath, "utf8");
        const parsed = Number.parseInt(raw.trim(), 10);
        if (Number.isInteger(parsed) && parsed > 0) {
          pid = parsed;
        }
      } catch {
        void 0;
      }
      if (typeof pid === "number" && isAlive(pid)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          void 0;
        }
        const deadline = Date.now() + STOP_GRACE_MS;
        while (Date.now() < deadline && isAlive(pid)) {
          await new Promise((r) => setTimeout(r, 50));
        }
        if (isAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            void 0;
          }
        }
      }
      await fsp.unlink(pidPath).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const tasks: Array<Promise<void>> = [];
    for (const r of this.running) {
      if (r.restartTimer) {
        clearTimeout(r.restartTimer);
      }
      try {
        r.child.kill("SIGTERM");
      } catch {
        void 0;
      }
      tasks.push(
        new Promise<void>((resolve) => {
          if (r.child.exitCode !== null || r.child.signalCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            try {
              r.child.kill("SIGKILL");
            } catch {
              void 0;
            }
            resolve();
          }, STOP_GRACE_MS);
          r.child.on("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        }),
      );
    }
    await Promise.allSettled(tasks);
    for (const r of this.running) {
      try {
        r.logStream.end();
      } catch {
        void 0;
      }
    }
    this.running.clear();
  }

  list(): Array<{
    name: string;
    pid: number | undefined;
    enabled: boolean;
  }> {
    return this.extensions.map((ext) => {
      const running = [...this.running].find((r) => r.config.name === ext.name);
      return {
        name: ext.name,
        pid: running?.child.pid,
        enabled: ext.enabled,
      };
    });
  }

  private spawnExtension(ext: ExtensionConfig, attempt: number): void {
    if (this.stopping) {
      return;
    }
    const command = ext.command.length > 0 ? ext.command : [ext.name];

    const logStream = fs.createWriteStream(paths.extensionLogFile(ext.name), {
      flags: "a",
    });
    logStream.write(
      `[acp-hydra] ${new Date().toISOString()} starting extension ${ext.name} (attempt ${attempt + 1})\n`,
    );

    const env = {
      ...process.env,
      ACP_HYDRA_DAEMON_URL: this.context.daemonUrl,
      ACP_HYDRA_DAEMON_HOST: this.context.daemonHost,
      ACP_HYDRA_DAEMON_PORT: String(this.context.daemonPort),
      ACP_HYDRA_TOKEN: this.context.daemonToken,
      ACP_HYDRA_WS_URL: this.context.daemonWsUrl,
      ACP_HYDRA_HOME: this.context.hydraHome,
      ACP_HYDRA_EXTENSION_NAME: ext.name,
      ...ext.env,
    };

    const [cmd, ...baseArgs] = command;
    if (cmd === undefined) {
      logStream.write(`[acp-hydra] extension ${ext.name} has empty command\n`);
      logStream.end();
      return;
    }
    const args = [...baseArgs, ...ext.args];

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });
    } catch (err) {
      logStream.write(
        `[acp-hydra] failed to spawn ${ext.name}: ${(err as Error).message}\n`,
      );
      logStream.end();
      this.scheduleRestart(ext, attempt);
      return;
    }

    if (child.stdout) {
      child.stdout.pipe(logStream, { end: false });
    }
    if (child.stderr) {
      child.stderr.pipe(logStream, { end: false });
    }

    if (typeof child.pid === "number") {
      try {
        fs.writeFileSync(paths.extensionPidFile(ext.name), `${child.pid}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      } catch (err) {
        logStream.write(
          `[acp-hydra] failed to write pid file for ${ext.name}: ${(err as Error).message}\n`,
        );
      }
    }

    const running: RunningExtension = { config: ext, child, logStream };
    this.running.add(running);

    child.on("error", (err) => {
      logStream.write(
        `[acp-hydra] extension ${ext.name} error: ${err.message}\n`,
      );
    });

    child.on("exit", (code, signal) => {
      this.running.delete(running);
      try {
        fs.unlinkSync(paths.extensionPidFile(ext.name));
      } catch {
        void 0;
      }
      logStream.write(
        `[acp-hydra] extension ${ext.name} exited code=${code ?? "null"} signal=${signal ?? "null"}\n`,
      );
      if (this.stopping) {
        logStream.end();
        return;
      }
      this.scheduleRestart(ext, attempt + 1);
    });
  }

  private scheduleRestart(ext: ExtensionConfig, attempt: number): void {
    if (this.stopping) {
      return;
    }
    const delay = Math.min(
      RESTART_BASE_MS * 2 ** Math.min(attempt, 10),
      RESTART_CAP_MS,
    );
    const timer = setTimeout(() => {
      this.spawnExtension(ext, attempt);
    }, delay);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
