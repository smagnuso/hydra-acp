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

export type ExtensionStatus =
  | "running"
  | "stopped"
  | "restarting"
  | "disabled";

export interface ExtensionInfo {
  name: string;
  status: ExtensionStatus;
  pid: number | undefined;
  enabled: boolean;
  restartCount: number;
  startedAt: number | undefined;
  lastExitCode: number | undefined;
  logPath: string;
}

const RESTART_BASE_MS = 1_000;
const RESTART_CAP_MS = 60_000;
const STOP_GRACE_MS = 3_000;

interface ExtensionEntry {
  config: ExtensionConfig;
  child: ChildProcess | undefined;
  logStream: fs.WriteStream | undefined;
  restartTimer: NodeJS.Timeout | undefined;
  pid: number | undefined;
  startedAt: number | undefined;
  restartCount: number;
  lastExitCode: number | undefined;
  manuallyStopped: boolean;
  exitWaiters: Array<() => void>;
}

export class ExtensionManager {
  private entries = new Map<string, ExtensionEntry>();
  private stopping = false;
  private context: ExtensionContext | undefined;

  constructor(extensions: ExtensionConfig[], context?: ExtensionContext) {
    this.context = context;
    for (const ext of extensions) {
      this.entries.set(ext.name, this.makeEntry(ext));
    }
  }

  setContext(context: ExtensionContext): void {
    this.context = context;
  }

  async start(): Promise<void> {
    if (!this.context) {
      throw new Error("ExtensionManager: setContext must be called before start");
    }
    await fsp.mkdir(paths.extensionsDir(), { recursive: true });
    await this.reapOrphans();
    for (const entry of this.entries.values()) {
      if (!entry.config.enabled) {
        continue;
      }
      this.spawn(entry, 0);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const tasks: Array<Promise<void>> = [];
    for (const entry of this.entries.values()) {
      if (entry.restartTimer) {
        clearTimeout(entry.restartTimer);
        entry.restartTimer = undefined;
      }
      const child = entry.child;
      if (!child) {
        continue;
      }
      try {
        child.kill("SIGTERM");
      } catch {
        void 0;
      }
      tasks.push(
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              void 0;
            }
            resolve();
          }, STOP_GRACE_MS);
          child.on("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        }),
      );
    }
    await Promise.allSettled(tasks);
    for (const entry of this.entries.values()) {
      try {
        entry.logStream?.end();
      } catch {
        void 0;
      }
      entry.child = undefined;
      entry.logStream = undefined;
      entry.pid = undefined;
    }
  }

  list(): ExtensionInfo[] {
    return [...this.entries.values()].map((entry) => this.infoFor(entry));
  }

  get(name: string): ExtensionInfo | undefined {
    const entry = this.entries.get(name);
    return entry ? this.infoFor(entry) : undefined;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  async startByName(name: string): Promise<ExtensionInfo> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw withCode(new Error(`unknown extension: ${name}`), "NOT_FOUND");
    }
    if (entry.child) {
      throw withCode(new Error(`extension ${name} already running`), "CONFLICT");
    }
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    entry.manuallyStopped = false;
    entry.restartCount = 0;
    this.spawn(entry, 0);
    return this.infoFor(entry);
  }

  async stopByName(name: string): Promise<ExtensionInfo> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw withCode(new Error(`unknown extension: ${name}`), "NOT_FOUND");
    }
    entry.manuallyStopped = true;
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    const child = entry.child;
    if (!child) {
      return this.infoFor(entry);
    }
    await this.terminate(entry, child);
    return this.infoFor(entry);
  }

  async restartByName(name: string): Promise<ExtensionInfo> {
    await this.stopByName(name);
    return this.startByName(name);
  }

  private async terminate(
    entry: ExtensionEntry,
    child: ChildProcess,
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolve) => {
      entry.exitWaiters.push(resolve);
    });
    try {
      child.kill("SIGTERM");
    } catch {
      void 0;
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        void 0;
      }
    }, STOP_GRACE_MS);
    if (typeof killTimer.unref === "function") {
      killTimer.unref();
    }
    try {
      await exited;
    } finally {
      clearTimeout(killTimer);
    }
  }

  private infoFor(entry: ExtensionEntry): ExtensionInfo {
    let status: ExtensionStatus;
    if (entry.child) {
      status = "running";
    } else if (entry.restartTimer) {
      status = "restarting";
    } else if (!entry.config.enabled) {
      status = "disabled";
    } else {
      status = "stopped";
    }
    return {
      name: entry.config.name,
      status,
      pid: entry.pid,
      enabled: entry.config.enabled,
      restartCount: entry.restartCount,
      startedAt: entry.startedAt,
      lastExitCode: entry.lastExitCode,
      logPath: paths.extensionLogFile(entry.config.name),
    };
  }

  private makeEntry(config: ExtensionConfig): ExtensionEntry {
    return {
      config,
      child: undefined,
      logStream: undefined,
      restartTimer: undefined,
      pid: undefined,
      startedAt: undefined,
      restartCount: 0,
      lastExitCode: undefined,
      manuallyStopped: false,
      exitWaiters: [],
    };
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

  private spawn(entry: ExtensionEntry, attempt: number): void {
    if (this.stopping || entry.manuallyStopped) {
      return;
    }
    const ctx = this.context;
    if (!ctx) {
      throw new Error("ExtensionManager.spawn called before setContext");
    }
    const ext = entry.config;
    const command = ext.command.length > 0 ? ext.command : [ext.name];

    const logStream = fs.createWriteStream(paths.extensionLogFile(ext.name), {
      flags: "a",
    });
    logStream.write(
      `[acp-hydra] ${new Date().toISOString()} starting extension ${ext.name} (attempt ${attempt + 1})\n`,
    );

    const env = {
      ...process.env,
      ACP_HYDRA_DAEMON_URL: ctx.daemonUrl,
      ACP_HYDRA_DAEMON_HOST: ctx.daemonHost,
      ACP_HYDRA_DAEMON_PORT: String(ctx.daemonPort),
      ACP_HYDRA_TOKEN: ctx.daemonToken,
      ACP_HYDRA_WS_URL: ctx.daemonWsUrl,
      ACP_HYDRA_HOME: ctx.hydraHome,
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
      this.scheduleRestart(entry, attempt);
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

    entry.child = child;
    entry.logStream = logStream;
    entry.pid = typeof child.pid === "number" ? child.pid : undefined;
    entry.startedAt = Date.now();
    entry.lastExitCode = undefined;

    child.on("error", (err) => {
      logStream.write(
        `[acp-hydra] extension ${ext.name} error: ${err.message}\n`,
      );
    });

    child.on("exit", (code, signal) => {
      try {
        fs.unlinkSync(paths.extensionPidFile(ext.name));
      } catch {
        void 0;
      }
      logStream.write(
        `[acp-hydra] extension ${ext.name} exited code=${code ?? "null"} signal=${signal ?? "null"}\n`,
      );
      entry.child = undefined;
      entry.pid = undefined;
      entry.lastExitCode = typeof code === "number" ? code : undefined;
      const waiters = entry.exitWaiters.splice(0);
      for (const resolve of waiters) {
        resolve();
      }
      if (this.stopping || entry.manuallyStopped) {
        try {
          logStream.end();
        } catch {
          void 0;
        }
        entry.logStream = undefined;
        return;
      }
      entry.restartCount += 1;
      this.scheduleRestart(entry, attempt + 1);
    });
  }

  private scheduleRestart(entry: ExtensionEntry, attempt: number): void {
    if (this.stopping || entry.manuallyStopped) {
      return;
    }
    const delay = Math.min(
      RESTART_BASE_MS * 2 ** Math.min(attempt, 10),
      RESTART_CAP_MS,
    );
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = undefined;
      this.spawn(entry, attempt);
    }, delay);
    if (typeof entry.restartTimer.unref === "function") {
      entry.restartTimer.unref();
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

function withCode(err: Error, code: string): Error & { code: string } {
  (err as Error & { code: string }).code = code;
  return err as Error & { code: string };
}
