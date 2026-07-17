import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import createPinoRoll from "pino-roll";
import type { SonicBoom } from "sonic-boom";
import type { ProcessTokenRegistry } from "../daemon/auth.js";
import { RestartBreaker, type BreakerOptions } from "./restart-breaker.js";
import { expandHome } from "./config.js";

// Shared lifecycle for daemon-supervised child processes (extensions and
// transformers). Each kind passes a SupervisorAdapter for the bits that
// differ — paths, env-var name for the child's configured name, token-
// registry role, log/error wording.

export interface BaseChildConfig {
  name: string;
  command: string[];
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

export interface BaseChildContext {
  daemonUrl: string;
  daemonHost: string;
  daemonPort: number;
  serviceToken: string;
  daemonWsUrl: string;
  hydraHome: string;
}

export type BaseChildStatus =
  | "running"
  | "stopped"
  | "restarting"
  | "disabled"
  | "failed";

export interface BaseChildInfo {
  name: string;
  status: BaseChildStatus;
  pid: number | undefined;
  enabled: boolean;
  restartCount: number;
  startedAt: number | undefined;
  lastExitCode: number | undefined;
  logPath: string;
  version: string | undefined;
  failureReason: string | undefined;
}

export interface SupervisorAdapter {
  kind: "extension" | "transformer";
  nameEnvVar: string;
  tokenRole: "extension" | "transformer";
  paths: {
    dir: () => string;
    logFile: (name: string) => string;
    pidFile: (name: string) => string;
  };
}

const DEFAULT_RESTART_BASE_MS = 1_000;
const DEFAULT_RESTART_CAP_MS = 60_000;
const STOP_GRACE_MS = 3_000;

interface ChildEntry<TConfig extends BaseChildConfig> {
  config: TConfig;
  child: ChildProcess | undefined;
  logStream: SonicBoom | undefined;
  restartTimer: NodeJS.Timeout | undefined;
  pid: number | undefined;
  startedAt: number | undefined;
  restartCount: number;
  lastExitCode: number | undefined;
  manuallyStopped: boolean;
  exitWaiters: Array<() => void>;
  version: string | undefined;
  // Per-process token minted at spawn time. Undefined when no registry is
  // configured (backwards compat path).
  processToken: string | undefined;
  breaker: RestartBreaker;
  failureReason: string | undefined;
}

export interface ChildSupervisorOptions {
  tokenRegistry?: ProcessTokenRegistry;
  breakerOptions?: BreakerOptions;
  // Test-only knobs to tighten the restart cadence; production callers
  // should leave these alone.
  restartBaseMs?: number;
  restartCapMs?: number;
}

export class ChildSupervisor<TConfig extends BaseChildConfig> {
  protected entries = new Map<string, ChildEntry<TConfig>>();
  private stopping = false;
  private context: BaseChildContext | undefined;
  private tokenRegistry: ProcessTokenRegistry | undefined;
  private breakerOptions: BreakerOptions | undefined;
  private restartBaseMs: number;
  private restartCapMs: number;
  private adapter: SupervisorAdapter;

  constructor(
    configs: TConfig[],
    adapter: SupervisorAdapter,
    context?: BaseChildContext,
    options: ChildSupervisorOptions = {},
  ) {
    this.adapter = adapter;
    this.context = context;
    this.tokenRegistry = options.tokenRegistry;
    this.breakerOptions = options.breakerOptions;
    this.restartBaseMs = options.restartBaseMs ?? DEFAULT_RESTART_BASE_MS;
    this.restartCapMs = options.restartCapMs ?? DEFAULT_RESTART_CAP_MS;
    for (const cfg of configs) {
      this.entries.set(cfg.name, this.makeEntry(cfg));
    }
  }

  setContext(context: BaseChildContext): void {
    this.context = context;
  }

  // Called by the WS handler after a process connects and calls initialize
  // with clientInfo.version. Stored on the entry and surfaced in list().
  reportVersion(name: string, version: string): void {
    const entry = this.entries.get(name);
    if (entry) {
      entry.version = version;
    }
  }

  async start(): Promise<void> {
    if (!this.context) {
      throw new Error(
        `${this.managerName()}: setContext must be called before start`,
      );
    }
    await fsp.mkdir(this.adapter.paths.dir(), { recursive: true });
    await this.reapOrphans();
    const spawns: Array<Promise<void>> = [];
    for (const entry of this.entries.values()) {
      if (!entry.config.enabled) {
        continue;
      }
      spawns.push(this.spawn(entry, 0));
    }
    await Promise.all(spawns);
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

  list(): BaseChildInfo[] {
    return [...this.entries.values()].map((entry) => this.infoFor(entry));
  }

  get(name: string): BaseChildInfo | undefined {
    const entry = this.entries.get(name);
    return entry ? this.infoFor(entry) : undefined;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  async startByName(name: string): Promise<BaseChildInfo> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw withCode(
        new Error(`unknown ${this.adapter.kind}: ${name}`),
        "NOT_FOUND",
      );
    }
    if (entry.child) {
      throw withCode(
        new Error(`${this.adapter.kind} ${name} already running`),
        "CONFLICT",
      );
    }
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    entry.manuallyStopped = false;
    entry.restartCount = 0;
    entry.breaker.reset();
    entry.failureReason = undefined;
    await this.spawn(entry, 0);
    return this.infoFor(entry);
  }

  async stopByName(name: string): Promise<BaseChildInfo> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw withCode(
        new Error(`unknown ${this.adapter.kind}: ${name}`),
        "NOT_FOUND",
      );
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

  async restartByName(name: string): Promise<BaseChildInfo> {
    await this.stopByName(name);
    return this.startByName(name);
  }

  // Register a new child and (if enabled) start it. Used by the POST
  // route endpoints so `<kind>s add` can take effect without a daemon
  // restart.
  register(config: TConfig): BaseChildInfo {
    if (this.entries.has(config.name)) {
      throw withCode(
        new Error(`${this.adapter.kind} ${config.name} already exists`),
        "CONFLICT",
      );
    }
    if (!this.context) {
      throw new Error(
        `${this.managerName()}: setContext must be called before register`,
      );
    }
    const entry = this.makeEntry(config);
    this.entries.set(config.name, entry);
    if (config.enabled) {
      // Fire-and-forget: register() is sync from the caller's view but
      // spawn is async. Any late failure (e.g. mkdir/logfile ENOENT
      // during a race with test teardown) is defensively surfaced onto
      // entry.failureReason rather than becoming an uncaught promise
      // rejection that crashes the process.
      this.spawn(entry, 0).catch((err) => {
        entry.failureReason = `spawn: ${(err as Error).message}`;
      });
    }
    return this.infoFor(entry);
  }

  async unregister(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw withCode(
        new Error(`unknown ${this.adapter.kind}: ${name}`),
        "NOT_FOUND",
      );
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
    entry: ChildEntry<TConfig>,
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

  protected infoFor(entry: ChildEntry<TConfig>): BaseChildInfo {
    let status: BaseChildStatus;
    if (entry.failureReason !== undefined) {
      status = "failed";
    } else if (entry.child) {
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
      logPath: this.adapter.paths.logFile(entry.config.name),
      version: entry.version,
      failureReason: entry.failureReason,
    };
  }

  private makeEntry(config: TConfig): ChildEntry<TConfig> {
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
      breaker: new RestartBreaker(this.breakerOptions),
      failureReason: undefined,
    };
  }

  private async reapOrphans(): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(this.adapter.paths.dir(), {
        withFileTypes: true,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const pidPath = this.adapter.paths.pidFile(entry.name);
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

  private async spawn(
    entry: ChildEntry<TConfig>,
    attempt: number,
  ): Promise<void> {
    if (this.stopping || entry.manuallyStopped) {
      return;
    }
    const ctx = this.context;
    if (!ctx) {
      throw new Error(`${this.managerName()}.spawn called before setContext`);
    }
    const cfg = entry.config;
    const command = cfg.command.length > 0 ? cfg.command : [cfg.name];

    // Rotate at 5 MB, keep 5 files (~25 MB per child). Numbered
    // `<name>.<N>.log` files live in a per-extension subdirectory;
    // pino-roll's symlink option maintains a `current.log` inside that dir
    // which paths.logFile() returns as the user-facing tail target.
    //
    // mkdir + createPinoRoll can both fail (permissions, disk pressure,
    // or — in tests — the tmpdir being wiped underneath a scheduled
    // restart). This function is called via `void this.spawn(...)` from
    // scheduleRestart's timer callback, so a rejection here becomes an
    // uncaught promise rejection. Catch it: if we're stopping anyway,
    // swallow silently; otherwise schedule another restart and let the
    // breaker decide when to give up on persistent failures.
    const logDir = path.dirname(this.adapter.paths.logFile(cfg.name));
    let logStream: SonicBoom;
    try {
      await fsp.mkdir(logDir, { recursive: true });
      logStream = await createPinoRoll({
        file: path.join(logDir, `${cfg.name}.log`),
        size: "5m",
        mkdir: true,
        symlink: true,
        limit: { count: 5 },
      });
      // pino-roll / sonic-boom emit 'error' asynchronously when a
      // rotation open or write fails (disk full, log dir vanished, tmpdir
      // cleaned mid-test, ...). Without a listener it becomes an uncaught
      // exception and kills the daemon; swallow it into failureReason so
      // the breaker and operators can see it via list().
      logStream.on("error", (err: Error) => {
        entry.failureReason = `log stream: ${err.message}`;
      });
    } catch (err) {
      if (this.stopping || entry.manuallyStopped) {
        return;
      }
      entry.failureReason = `log setup: ${(err as Error).message}`;
      // Don't touch the breaker for log-setup failures — the breaker
      // decides based on real child-exit codes, not pre-spawn issues.
      // scheduleRestart's own guard (stopping / manuallyStopped) is
      // sufficient here; if the underlying condition persists (e.g.
      // permanent disk failure), operators will see the failureReason
      // through list() and stop it manually.
      this.scheduleRestart(entry, attempt + 1);
      return;
    }
    if (this.stopping || entry.manuallyStopped) {
      try {
        logStream.end();
      } catch {
        void 0;
      }
      return;
    }
    logStream.write(
      `[hydra-acp] ${new Date().toISOString()} starting ${this.adapter.kind} ${cfg.name} (attempt ${attempt + 1})\n`,
    );

    // Mint a per-process token when a registry is available; fall back to the
    // shared service token so existing setups without a registry still work.
    const processToken =
      this.tokenRegistry?.mint(cfg.name, this.adapter.tokenRole) ??
      ctx.serviceToken;
    entry.processToken = processToken;
    // Clear stale version from a previous run so we don't show the old
    // version while the process is starting up.
    entry.version = undefined;

    const env = {
      ...process.env,
      HYDRA_ACP_DAEMON_URL: ctx.daemonUrl,
      HYDRA_ACP_DAEMON_HOST: ctx.daemonHost,
      HYDRA_ACP_DAEMON_PORT: String(ctx.daemonPort),
      HYDRA_ACP_TOKEN: processToken,
      HYDRA_ACP_WS_URL: ctx.daemonWsUrl,
      HYDRA_ACP_HOME: ctx.hydraHome,
      [this.adapter.nameEnvVar]: cfg.name,
      ...cfg.env,
    };

    const [rawCmd, ...baseArgs] = command;
    if (rawCmd === undefined) {
      logStream.write(
        `[hydra-acp] ${this.adapter.kind} ${cfg.name} has empty command\n`,
      );
      logStream.end();
      return;
    }
    // Expand `~/...` / `$HOME/...` in the executable path and any
    // string-valued argument so users can write portable config
    // entries like `command: ["~/bin/wrapper.sh"]`.
    const cmd = expandHome(rawCmd);
    const args = [...baseArgs, ...cfg.args].map(expandHome);

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });
    } catch (err) {
      logStream.write(
        `[hydra-acp] failed to spawn ${cfg.name}: ${(err as Error).message}\n`,
      );
      logStream.end();
      this.scheduleRestart(entry, attempt);
      return;
    }

    const forward = (chunk: Buffer | string): void => {
      try {
        logStream.write(typeof chunk === "string" ? chunk : chunk.toString());
      } catch {
        void 0;
      }
    };
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);

    if (typeof child.pid === "number") {
      try {
        fs.writeFileSync(
          this.adapter.paths.pidFile(cfg.name),
          `${child.pid}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      } catch (err) {
        logStream.write(
          `[hydra-acp] failed to write pid file for ${cfg.name}: ${(err as Error).message}\n`,
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
        `[hydra-acp] ${this.adapter.kind} ${cfg.name} error: ${err.message}\n`,
      );
    });

    child.on("exit", (code, signal) => {
      try {
        fs.unlinkSync(this.adapter.paths.pidFile(cfg.name));
      } catch {
        void 0;
      }
      logStream.write(
        `[hydra-acp] ${this.adapter.kind} ${cfg.name} exited code=${code ?? "null"} signal=${signal ?? "null"}\n`,
      );
      entry.child = undefined;
      entry.pid = undefined;
      entry.lastExitCode = typeof code === "number" ? code : undefined;
      // Revoke the per-process token so it can't be reused between restarts.
      if (entry.processToken) {
        this.tokenRegistry?.revoke(cfg.name);
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
      const decision = entry.breaker.recordExit(
        code,
        cfg.name,
        this.adapter.kind,
      );
      if (typeof decision === "object") {
        entry.failureReason = decision.tripped;
        logStream.write(
          `[hydra-acp] ${this.adapter.kind} ${cfg.name} circuit breaker tripped: ${decision.tripped}\n`,
        );
        try {
          logStream.end();
        } catch {
          void 0;
        }
        entry.logStream = undefined;
        return;
      }
      this.scheduleRestart(entry, attempt + 1);
    });
  }

  private scheduleRestart(entry: ChildEntry<TConfig>, attempt: number): void {
    if (this.stopping || entry.manuallyStopped) {
      return;
    }
    const delay = Math.min(
      this.restartBaseMs * 2 ** Math.min(attempt, 10),
      this.restartCapMs,
    );
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = undefined;
      // Same defensive-catch as register()'s fire-and-forget spawn:
      // a rejection here (e.g. mkdir ENOENT if the log directory
      // disappeared) would otherwise be uncaught, since the timer
      // callback has no caller to await it.
      this.spawn(entry, attempt).catch((err) => {
        entry.failureReason = `spawn: ${(err as Error).message}`;
      });
    }, delay);
    if (typeof entry.restartTimer.unref === "function") {
      entry.restartTimer.unref();
    }
  }

  private managerName(): string {
    return this.adapter.kind === "extension"
      ? "ExtensionManager"
      : "TransformerManager";
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
