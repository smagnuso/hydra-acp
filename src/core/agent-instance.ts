import { spawn, type ChildProcess } from "node:child_process";
import { ndjsonStreamFromStdio } from "../acp/framing.js";
import { JsonRpcConnection } from "../acp/connection.js";
import type { SpawnPlan } from "./registry.js";

export interface AgentInstanceOptions {
  agentId: string;
  cwd: string;
  plan: SpawnPlan;
  extraEnv?: Record<string, string>;
}

// Cap how much trailing stderr we hold so a chatty agent can't grow
// the buffer without bound; just enough to give the user a hint about
// why an agent failed to come up (e.g. an auth complaint or npx ENOENT).
const STDERR_TAIL_BYTES = 4096;

export class AgentInstance {
  readonly agentId: string;
  readonly cwd: string;
  readonly connection: JsonRpcConnection;
  private child: ChildProcess;
  private exited = false;
  private killed = false;
  private stderrTail = "";
  private exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  private constructor(opts: AgentInstanceOptions, child: ChildProcess) {
    this.agentId = opts.agentId;
    this.cwd = opts.cwd;
    this.child = child;

    if (!child.stdout || !child.stdin) {
      throw new Error("agent subprocess missing stdio");
    }
    const stream = ndjsonStreamFromStdio(child.stdout, child.stdin);
    this.connection = new JsonRpcConnection(stream);

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
      process.stderr.write(`[${opts.agentId}] ${chunk}`);
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
      if (!this.killed) {
        const reason = `agent ${opts.agentId} exited before responding (code=${code} signal=${signal})`;
        this.connection.fail(new Error(this.formatFailure(reason)));
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
    await this.connection.close().catch(() => undefined);
    this.child.kill(signal);
  }
}
