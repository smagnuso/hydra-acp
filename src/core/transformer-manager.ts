import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { paths } from "./paths.js";
import type { TransformerConfig } from "./config.js";
import type { ProcessTokenRegistry } from "../daemon/auth.js";
import type { JsonRpcConnection } from "../acp/connection.js";

// A transformer that has completed transformer/initialize and is ready to
// participate in session chains. Held by TransformerManager and handed to
// Session when the session is created.
export interface TransformerRef {
  name: string;
  intercepts: Set<string>;
  connection: JsonRpcConnection;
}

export interface TransformerContext {
  daemonUrl: string;
  daemonHost: string;
  daemonPort: number;
  serviceToken: string;
  daemonWsUrl: string;
  hydraHome: string;
}

export type TransformerStatus = "running" | "stopped" | "restarting" | "disabled";

export interface TransformerInfo {
  name: string;
  status: TransformerStatus;
  pid: number | undefined;
  enabled: boolean;
  restartCount: number;
  startedAt: number | undefined;
  lastExitCode: number | undefined;
  logPath: string;
  version: string | undefined;
}

const RESTART_BASE_MS = 1_000;
const RESTART_CAP_MS = 60_000;
const STOP_GRACE_MS = 3_000;

interface TransformerEntry {
  config: TransformerConfig;
  child: ChildProcess | undefined;
  logStream: fs.WriteStream | undefined;
  restartTimer: NodeJS.Timeout | undefined;
  pid: number | undefined;
  startedAt: number | undefined;
  restartCount: number;
  lastExitCode: number | undefined;
  manuallyStopped: boolean;
  exitWaiters: Array<() => void>;
  version: string | undefined;
  processToken: string | undefined;
}

export class TransformerManager {
  private entries = new Map<string, TransformerEntry>();
  // Transformers that have completed transformer/initialize and are ready to
  // participate in chains. Keyed by transformer name.
  private connected = new Map<string, TransformerRef>();
  private stopping = false;
  private context: TransformerContext | undefined;
  private tokenRegistry: ProcessTokenRegistry | undefined;

  constructor(
    transformers: TransformerConfig[],
    context?: TransformerContext,
    options: { tokenRegistry?: ProcessTokenRegistry } = {},
  ) {
    this.context = context;
    this.tokenRegistry = options.tokenRegistry;
    for (const t of transformers) {
      this.entries.set(t.name, this.makeEntry(t));
    }
  }

  setContext(context: TransformerContext): void {
    this.context = context;
  }

  reportVersion(name: string, version: string): void {
    const entry = this.entries.get(name);
    if (entry) {
      entry.version = version;
    }
  }

  // Called by the WS handler after transformer/initialize completes. The
  // transformer is now eligible to participate in session chains.
  registerConnection(
    name: string,
    connection: JsonRpcConnection,
    intercepts: string[],
  ): void {
    this.connected.set(name, {
      name,
      connection,
      intercepts: new Set(intercepts),
    });
  }

  // Called by the WS handler when the transformer's WS connection closes.
  deregisterConnection(name: string): void {
    this.connected.delete(name);
  }

  // Resolve a list of transformer names to their live TransformerRef objects.
  // Names that are configured but not yet connected are silently skipped
  // (fail-open: session proceeds without that transformer rather than failing).
  resolveChain(names: string[]): TransformerRef[] {
    const out: TransformerRef[] = [];
    for (const name of names) {
      const ref = this.connected.get(name);
      if (ref) {
        out.push(ref);
      }
    }
    return out;
  }

  async start(): Promise<void> {
    if (!this.context) {
      throw new Error("TransformerManager: setContext must be called before start");
    }
    await fsp.mkdir(paths.transformersDir(), { recursive: true });
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

  list(): TransformerInfo[] {
    return [...this.entries.values()].map((entry) => this.infoFor(entry));
  }

  get(name: string): TransformerInfo | undefined {
    const entry = this.entries.get(name);
    return entry ? this.infoFor(entry) : undefined;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  async startByName(name: string): Promise<TransformerInfo> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw withCode(new Error(`unknown transformer: ${name}`), "NOT_FOUND");
    }
    if (entry.child) {
      throw withCode(new Error(`transformer ${name} already running`), "CONFLICT");
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

  async stopByName(name: string): Promise<TransformerInfo> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw withCode(new Error(`unknown transformer: ${name}`), "NOT_FOUND");
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

  async restartByName(name: string): Promise<TransformerInfo> {
    await this.stopByName(name);
    return this.startByName(name);
  }

  register(config: TransformerConfig): TransformerInfo {
    if (this.entries.has(config.name)) {
      throw withCode(
        new Error(`transformer ${config.name} already exists`),
        "CONFLICT",
      );
    }
    if (!this.context) {
      throw new Error("TransformerManager: setContext must be called before register");
    }
    const entry = this.makeEntry(config);
    this.entries.set(config.name, entry);
    if (config.enabled) {
      this.spawn(entry, 0);
    }
    return this.infoFor(entry);
  }

  async unregister(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw withCode(new Error(`unknown transformer: ${name}`), "NOT_FOUND");
    }
    entry.manuallyStopped = true;
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    const child = entry.child;
    if (child) {
      await this.terminate(entry, child);
    }
    try {
      entry.logStream?.end();
    } catch {
      void 0;
    }
    this.entries.delete(name);
  }

  private async terminate(
    entry: TransformerEntry,
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

  private infoFor(entry: TransformerEntry): TransformerInfo {
    let status: TransformerStatus;
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
      logPath: paths.transformerLogFile(entry.config.name),
      version: entry.version,
    };
  }

  private makeEntry(config: TransformerConfig): TransformerEntry {
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
      version: undefined,
      processToken: undefined,
    };
  }

  private async reapOrphans(): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(paths.transformersDir());
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
      const pidPath = path.join(paths.transformersDir(), entry);
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

  private spawn(entry: TransformerEntry, attempt: number): void {
    if (this.stopping || entry.manuallyStopped) {
      return;
    }
    const ctx = this.context;
    if (!ctx) {
      throw new Error("TransformerManager.spawn called before setContext");
    }
    const t = entry.config;
    const command = t.command.length > 0 ? t.command : [t.name];

    const logStream = fs.createWriteStream(paths.transformerLogFile(t.name), {
      flags: "a",
    });
    logStream.write(
      `[hydra-acp] ${new Date().toISOString()} starting transformer ${t.name} (attempt ${attempt + 1})\n`,
    );

    const processToken =
      this.tokenRegistry?.mint(t.name, "transformer") ?? ctx.serviceToken;
    entry.processToken = processToken;
    entry.version = undefined;

    const env = {
      ...process.env,
      HYDRA_ACP_DAEMON_URL: ctx.daemonUrl,
      HYDRA_ACP_DAEMON_HOST: ctx.daemonHost,
      HYDRA_ACP_DAEMON_PORT: String(ctx.daemonPort),
      HYDRA_ACP_TOKEN: processToken,
      HYDRA_ACP_WS_URL: ctx.daemonWsUrl,
      HYDRA_ACP_HOME: ctx.hydraHome,
      HYDRA_ACP_TRANSFORMER_NAME: t.name,
      ...t.env,
    };

    const [cmd, ...baseArgs] = command;
    if (cmd === undefined) {
      logStream.write(`[hydra-acp] transformer ${t.name} has empty command\n`);
      logStream.end();
      return;
    }
    const args = [...baseArgs, ...t.args];

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });
    } catch (err) {
      logStream.write(
        `[hydra-acp] failed to spawn ${t.name}: ${(err as Error).message}\n`,
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
        fs.writeFileSync(paths.transformerPidFile(t.name), `${child.pid}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      } catch (err) {
        logStream.write(
          `[hydra-acp] failed to write pid file for ${t.name}: ${(err as Error).message}\n`,
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
        `[hydra-acp] transformer ${t.name} error: ${err.message}\n`,
      );
    });

    child.on("exit", (code, signal) => {
      try {
        fs.unlinkSync(paths.transformerPidFile(t.name));
      } catch {
        void 0;
      }
      logStream.write(
        `[hydra-acp] transformer ${t.name} exited code=${code ?? "null"} signal=${signal ?? "null"}\n`,
      );
      entry.child = undefined;
      entry.pid = undefined;
      entry.lastExitCode = typeof code === "number" ? code : undefined;
      if (entry.processToken) {
        this.tokenRegistry?.revoke(t.name);
        entry.processToken = undefined;
      }
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

  private scheduleRestart(entry: TransformerEntry, attempt: number): void {
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
