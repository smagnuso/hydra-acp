import { agentInstallState, type Registry } from "./registry.js";
import type { SessionManager } from "./session-manager.js";

export interface AgentSyncLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface AgentSyncSchedulerOptions {
  registry: Registry;
  manager: SessionManager;
  // Total time each installed agent should wait between syncs. The
  // scheduler ticks `intervalMs / installedAgentCount` so individual
  // agent spawns spread across the window — N agents on a 1h interval
  // get one spawn every `60/N` minutes instead of all at once.
  intervalMs: number;
  logger?: AgentSyncLogger;
}

// Periodically run `manager.syncFromAgent` for every registry agent
// whose install state is "yes". uvx/"lazy" agents are skipped — they
// would trigger a resolve+download on the agent host, which is the
// opposite of "quiet background poll." Agents that disappear from the
// registry, or that advertise no `sessionCapabilities.list`, are
// silently skipped on each tick (the sync method throws; we log and
// move on so one bad agent can't wedge the rest of the schedule).
//
// Returns a stop function — call on daemon shutdown to cancel the
// pending timer.
export function startAgentSyncScheduler(
  opts: AgentSyncSchedulerOptions,
): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let cursor = 0;

  const log = (level: "info" | "warn", msg: string): void => {
    if (!opts.logger) {
      return;
    }
    opts.logger[level](`agent-sync: ${msg}`);
  };

  const tick = async (): Promise<number> => {
    const installed: string[] = [];
    try {
      const doc = await opts.registry.load();
      for (const a of doc.agents) {
        const state = await agentInstallState(a);
        if (state === "yes") {
          installed.push(a.id);
        }
      }
    } catch (err) {
      log("warn", `registry load failed: ${(err as Error).message}`);
      return opts.intervalMs;
    }
    if (installed.length === 0) {
      return opts.intervalMs;
    }
    const idx = cursor % installed.length;
    cursor = (cursor + 1) % installed.length;
    const agentId = installed[idx]!;
    try {
      const { synced, skipped } = await opts.manager.syncFromAgent(agentId);
      log(
        "info",
        `${agentId}: synced ${synced.length}, skipped ${skipped}`,
      );
    } catch (err) {
      log("warn", `${agentId}: ${(err as Error).message}`);
    }
    return Math.max(1, Math.floor(opts.intervalMs / installed.length));
  };

  const scheduleNext = (delayMs: number): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      tick()
        .then((nextDelay) => {
          scheduleNext(nextDelay);
        })
        .catch((err) => {
          log("warn", `tick crashed: ${(err as Error).message}`);
          scheduleNext(opts.intervalMs);
        });
    }, delayMs);
    timer.unref();
  };

  scheduleNext(opts.intervalMs);

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}
