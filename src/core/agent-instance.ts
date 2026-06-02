import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ndjsonStreamFromStdio } from "../acp/framing.js";
import { JsonRpcConnection } from "../acp/connection.js";
import { paths } from "./paths.js";
import type { SpawnPlan } from "./registry.js";

export interface AgentInstanceOptions {
  agentId: string;
  cwd: string;
  plan: SpawnPlan;
  extraEnv?: Record<string, string>;
  // Bytes of trailing stderr buffered for diagnostic dumps on spawn
  // failure. Defaults to 4096 — just enough to surface a typical
  // auth complaint or ENOENT without unbounded growth.
  stderrTailBytes?: number;
  // Grace period (ms) between SIGTERM and SIGKILL in kill(). Exposed
  // mainly so tests can shorten the default 2s wait.
  killEscalationMs?: number;
  // Pino-style logger for diagnostic output. The daemon's stderr is
  // wired to /dev/null (spawnDaemonDetached), so raw process.stderr
  // writes are invisible — route stderr lines and unexpected exits
  // through here to land in daemon.log.
  logger?: AgentLogger;
}

export interface AgentLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

const DEFAULT_STDERR_TAIL_BYTES = 4096;

export class AgentInstance {
  readonly agentId: string;
  // Version this process was spawned from — used by the registry-fetch
  // prune sweep to skip install dirs belonging to a live agent.
  readonly version: string;
  readonly cwd: string;
  readonly connection: JsonRpcConnection;
  private child: ChildProcess;
  private exited = false;
  private killed = false;
  private stderrTail = "";
  private stderrTailBytes: number;
  private killEscalationMs: number;
  private logger?: AgentLogger;
  private fileLog?: fs.WriteStream;
  private exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  private constructor(opts: AgentInstanceOptions, child: ChildProcess) {
    this.agentId = opts.agentId;
    this.version = opts.plan.version;
    this.cwd = opts.cwd;
    this.child = child;
    this.stderrTailBytes = opts.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES;
    this.killEscalationMs = opts.killEscalationMs ?? DEFAULT_KILL_ESCALATION_MS;
    this.logger = opts.logger;
    this.fileLog = openAgentLog(opts.agentId);
    this.writeLog(
      `--- spawn pid=${child.pid} version=${opts.plan.version} cwd=${opts.cwd} cmd=${opts.plan.command} args=${JSON.stringify(opts.plan.args)} time=${new Date().toISOString()} ---\n`,
    );

    if (!child.stdout || !child.stdin) {
      throw new Error("agent subprocess missing stdio");
    }
    const stream = ndjsonStreamFromStdio(child.stdout, child.stdin);
    this.connection = new JsonRpcConnection(stream);

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-this.stderrTailBytes);
      this.writeLog(chunk);
      // The daemon's stderr is redirected to /dev/null, so route agent
      // stderr through the pino logger instead — otherwise debugging an
      // agent that's misbehaving is impossible.
      if (this.logger) {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.length > 0) {
            this.logger.info(`[${opts.agentId}] ${line}`);
          }
        }
      } else {
        process.stderr.write(`[${opts.agentId}] ${chunk}`);
      }
    });

    // Without this listener, a spawn-level failure (cwd ENOENT,
    // executable not on PATH, etc.) is emitted as an unhandled
    // EventEmitter 'error' and crashes the daemon. Funnel it through
    // the connection so the pending request rejects with context.
    child.on("error", (err) => {
      const msg = this.formatFailure(err.message);
      this.writeLog(
        `--- spawn error: ${err.message} time=${new Date().toISOString()} ---\n`,
      );
      this.connection.fail(new Error(msg));
    });

    child.on("exit", (code, signal) => {
      this.exited = true;
      this.writeLog(
        `--- exit code=${code} signal=${signal} ${this.killed ? "(after kill) " : ""}time=${new Date().toISOString()} ---\n`,
      );
      this.fileLog?.end();
      this.fileLog = undefined;
      if (this.killed) {
        // Intentional shutdown (session close, idle timeout, agent
        // switch). Logged at info so the close path leaves a trail.
        this.logger?.info(
          `agent ${opts.agentId} pid=${child.pid} exited after kill code=${code} signal=${signal}`,
        );
      } else {
        const reason = `agent ${opts.agentId} exited before responding (code=${code} signal=${signal})`;
        this.connection.fail(new Error(this.formatFailure(reason)));
        this.logger?.warn(
          `agent ${opts.agentId} pid=${child.pid} exited unexpectedly code=${code} signal=${signal}`,
        );
      }
      for (const handler of this.exitHandlers) {
        handler(code, signal);
      }
    });
  }

  private writeLog(line: string): void {
    if (!this.fileLog) {
      return;
    }
    try {
      this.fileLog.write(line);
    } catch {
      void 0;
    }
  }

  private formatFailure(reason: string): string {
    const tail = this.stderrTail.trim();
    return tail ? `${reason}\nstderr: ${tail}` : reason;
  }

  static spawn(opts: AgentInstanceOptions): AgentInstance {
    const env = {
      ...process.env,
      ...opts.plan.env,
      ...(opts.extraEnv ?? {}),
    };
    const child = spawn(opts.plan.command, opts.plan.args, {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // setsid the agent into its own session/process group. The daemon
      // already runs in its own setsid'd session, but macOS terminals
      // (iTerm2, Terminal.app) sometimes still reach inherited child
      // processes when the user closes a window — putting the agent
      // one more session-boundary away keeps it alive across terminal
      // restarts. The daemon still owns the pipes, so this.kill()
      // continues to terminate it cleanly on idle/close.
      detached: true,
    });
    // detached:true alone makes Node's event loop wait for the child. We
    // own the lifecycle explicitly via kill() and the connection's stdio,
    // so unref the handle: a stuck or leaked agent must not pin the
    // daemon (or a test runner) alive past its own exit.
    child.unref();
    return new AgentInstance(opts, child);
  }

  onExit(handler: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitHandlers.push(handler);
  }

  isAlive(): boolean {
    return !this.exited;
  }

  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.exited) {
      return;
    }
    this.killed = true;
    this.writeLog(
      `--- kill requested signal=${signal} time=${new Date().toISOString()} ---\n`,
    );
    this.logger?.info(
      `agent ${this.agentId} pid=${this.child.pid} kill requested signal=${signal}`,
    );
    await this.connection.close().catch(() => undefined);
    this.signalProcessGroup(signal);
    // Escalate to SIGKILL if the agent ignores the graceful signal. Without
    // this, agents that don't handle SIGTERM (codex-acp is the known
    // offender) linger after the daemon stops tracking them and get
    // reparented to systemd --user — a per-sync leak that accumulates
    // forever.
    await this.waitForExit(this.killEscalationMs);
    if (this.exited) {
      return;
    }
    this.writeLog(
      `--- kill escalating signal=SIGKILL time=${new Date().toISOString()} ---\n`,
    );
    this.logger?.warn(
      `agent ${this.agentId} pid=${this.child.pid} did not exit after ${signal}; sending SIGKILL`,
    );
    this.signalProcessGroup("SIGKILL");
    await this.waitForExit(this.killEscalationMs);
  }

  // Spawned with detached:true, so the child is the leader of its own
  // process group. Signal the group (negative pid) so any helper
  // processes the agent forked off die with it; fall back to a direct
  // pid kill if the group send fails (e.g. group already empty).
  private signalProcessGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) {
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        void 0;
      }
    }
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (this.exited) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.off("exit", onExit);
        resolve();
      }, timeoutMs);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.child.once("exit", onExit);
    });
  }
}

const DEFAULT_KILL_ESCALATION_MS = 2_000;

function openAgentLog(agentId: string): fs.WriteStream | undefined {
  try {
    const logPath = paths.agentLogFile(agentId);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const stream = fs.createWriteStream(logPath, { flags: "a" });
    stream.on("error", () => undefined);
    return stream;
  } catch {
    return undefined;
  }
}
