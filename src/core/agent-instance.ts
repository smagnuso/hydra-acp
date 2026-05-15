import { spawn, type ChildProcess } from "node:child_process";
import { ndjsonStreamFromStdio } from "../acp/framing.js";
import { JsonRpcConnection } from "../acp/connection.js";
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
  readonly cwd: string;
  readonly connection: JsonRpcConnection;
  private child: ChildProcess;
  private exited = false;
  private killed = false;
  private stderrTail = "";
  private stderrTailBytes: number;
  private logger?: AgentLogger;
  private exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  private constructor(opts: AgentInstanceOptions, child: ChildProcess) {
    this.agentId = opts.agentId;
    this.cwd = opts.cwd;
    this.child = child;
    this.stderrTailBytes = opts.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES;
    this.logger = opts.logger;

    if (!child.stdout || !child.stdin) {
      throw new Error("agent subprocess missing stdio");
    }
    const stream = ndjsonStreamFromStdio(child.stdout, child.stdin);
    this.connection = new JsonRpcConnection(stream);

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-this.stderrTailBytes);
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
      this.connection.fail(new Error(msg));
    });

    child.on("exit", (code, signal) => {
      this.exited = true;
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
    this.logger?.info(
      `agent ${this.agentId} pid=${this.child.pid} kill requested signal=${signal}`,
    );
    await this.connection.close().catch(() => undefined);
    this.child.kill(signal);
  }
}
