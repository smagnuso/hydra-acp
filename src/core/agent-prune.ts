import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { paths } from "./paths.js";
import type { Registry } from "./registry.js";
import { currentPlatformKey } from "./binary-install.js";

// Where the prune sweep routes its progress / failure lines. Default
// goes to stderr; the daemon swaps in pino routing so output lands in
// daemon.log alongside the install-time messages.
export type AgentPruneLog = (message: string) => void;

let logSink: AgentPruneLog = (msg) => {
  process.stderr.write(msg + "\n");
};

export function setAgentPruneLogger(log: AgentPruneLog | null): void {
  logSink = log ?? ((msg) => process.stderr.write(msg + "\n"));
}

export interface ActiveAgentVersions {
  activeAgentVersions(): Map<string, Set<string>>;
}

// Remove `<agentId>/<otherVersion>/` install dirs whose version doesn't
// match the currently-loaded registry AND isn't backing a live agent
// process. Conservative on agents that have disappeared from the
// registry — those dirs are left alone for now.
//
// Only sweeps the current platform's install dirs. A Hydra home shared
// across machines (NFS, dotfiles repo) carries each platform's binaries
// in its own subtree, and we shouldn't touch what we don't own.
export async function pruneStaleAgentVersions(
  registry: Registry,
  sessionManager: ActiveAgentVersions,
): Promise<void> {
  const platformKey = currentPlatformKey();
  if (!platformKey) {
    return;
  }
  const doc = await registry.load();
  const desiredByAgent = new Map<string, string>();
  for (const a of doc.agents) {
    desiredByAgent.set(a.id, a.version ?? "current");
  }
  const activeByAgent = sessionManager.activeAgentVersions();
  const platformDir = path.join(paths.agentsDir(), platformKey);

  let agentEntries: import("node:fs").Dirent[];
  try {
    agentEntries = await fsp.readdir(platformDir, { withFileTypes: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return;
    }
    logSink(`hydra-acp: prune: failed to read ${platformDir}: ${e.message}`);
    return;
  }

  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) {
      continue;
    }
    const agentId = agentEntry.name;
    const desired = desiredByAgent.get(agentId);
    if (desired === undefined) {
      continue;
    }
    const activeVersions = activeByAgent.get(agentId) ?? new Set<string>();
    const agentDir = path.join(platformDir, agentId);
    let versionEntries: import("node:fs").Dirent[];
    try {
      versionEntries = await fsp.readdir(agentDir, { withFileTypes: true });
    } catch (err) {
      logSink(
        `hydra-acp: prune: failed to read ${agentDir}: ${(err as Error).message}`,
      );
      continue;
    }
    for (const versionEntry of versionEntries) {
      if (!versionEntry.isDirectory()) {
        continue;
      }
      const version = versionEntry.name;
      if (version === desired) {
        continue;
      }
      if (activeVersions.has(version)) {
        continue;
      }
      const versionDir = path.join(agentDir, version);
      try {
        await fsp.rm(versionDir, { recursive: true, force: true });
        logSink(`hydra-acp: pruned stale ${agentId} ${version} (${versionDir})`);
      } catch (err) {
        logSink(
          `hydra-acp: prune: failed to remove ${versionDir}: ${(err as Error).message}`,
        );
      }
    }
  }
}
