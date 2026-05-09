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

export class AgentInstance {
  readonly agentId: string;
  readonly cwd: string;
  readonly connection: JsonRpcConnection;
  private child: ChildProcess;
  private exited = false;
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
      process.stderr.write(`[${opts.agentId}] ${chunk}`);
    });

    child.on("exit", (code, signal) => {
      this.exited = true;
      for (const handler of this.exitHandlers) {
        handler(code, signal);
      }
    });
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
    await this.connection.close().catch(() => undefined);
    this.child.kill(signal);
  }
}
