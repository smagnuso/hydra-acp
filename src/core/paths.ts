import * as path from "node:path";
import * as os from "node:os";

const ROOT_ENV = "HYDRA_ACP_HOME";

export function shortenHomePath(p: string): string {
  const home = os.homedir();
  if (!home) {
    return p;
  }
  if (p === home) {
    return "~";
  }
  if (p.startsWith(home + "/")) {
    return "~" + p.slice(home.length);
  }
  return p;
}

export function hydraHome(): string {
  const override = process.env[ROOT_ENV];
  if (override && override.length > 0) {
    return path.resolve(override);
  }
  // Safety net: under VITEST, never silently fall back to the developer's
  // real ~/.hydra-acp. vitest.setup.ts clamps HYDRA_ACP_HOME to a
  // per-worker tmpdir; if it goes missing we'd rather a fire-and-forget
  // write throw (and get swallowed by the surrounding .catch) than land
  // a stray meta.json in the user's session directory.
  if (process.env.VITEST) {
    throw new Error(
      "HYDRA_ACP_HOME is unset under VITEST; vitest.setup.ts must run first",
    );
  }
  return path.join(os.homedir(), ".hydra-acp");
}

export const paths = {
  home: hydraHome,
  config: () => path.join(hydraHome(), "config.json"),
  // Auth token lives in its own file so config.json can be version-
  // controlled without leaking the secret. Raw string contents, mode 0600.
  authToken: () => path.join(hydraHome(), "auth-token"),
  // Per-host cache of password-issued session tokens used by
  // `hydra session attach hydra://<host>/...`. JSON object keyed by
  // "<host>:<port>" → { token, expiresAt, label? }. Mode 0600.
  remotes: () => path.join(hydraHome(), "remotes.json"),
  pidFile: () => path.join(hydraHome(), "daemon.pid"),
  logFile: () => path.join(hydraHome(), "daemon.log"),
  currentLogFile: () => path.join(hydraHome(), "current.log"),
  registryCache: () => path.join(hydraHome(), "registry.json"),
  agentsDir: () => path.join(hydraHome(), "agents"),
  // Per-agent diagnostic log written by AgentInstance: spawn/exit
  // milestones plus every line the agent emits on stderr. Mirrors the
  // role extensionLogFile / transformerLogFile play for those
  // subsystems; tailed by `hydra-acp agent log <id>`.
  agentLogFile: (id: string) =>
    path.join(hydraHome(), "agents", "logs", `${id}.log`),
  // <platformKey>/<agentId>/<version>/ — platform at the top so a Hydra
  // home shared between machines (NFS, rsync'd dotfiles) keeps each
  // machine's binaries cleanly separated. `ls agents/` immediately
  // shows which platforms have ever installed anything.
  agentInstallDir: (id: string, platformKey: string, version: string) =>
    path.join(hydraHome(), "agents", platformKey, id, version),
  // npm install cache for npx-distributed agents. The trailing
  // node<ABI> segment keys on process.versions.modules so a Node
  // major bump (different ABI → native modules incompatible) yields
  // a fresh install rather than failing at require() time.
  agentNpmInstallDir: (id: string, platformKey: string, version: string) =>
    path.join(
      hydraHome(),
      "agents",
      platformKey,
      id,
      version,
      `node${process.versions.modules}`,
    ),
  sessionsDir: () => path.join(hydraHome(), "sessions"),
  // One directory per session id under sessions/. Co-locates the
  // session record, its transcript, and any future per-session state
  // (uploads, scratch, etc.) so the lifecycle is just "rm -rf the dir".
  sessionDir: (id: string) => path.join(hydraHome(), "sessions", id),
  sessionFile: (id: string) =>
    path.join(hydraHome(), "sessions", id, "meta.json"),
  historyFile: (id: string) =>
    path.join(hydraHome(), "sessions", id, "history.jsonl"),
  // Content-addressed store for heavy tool payload (diff bodies, stdout)
  // externalized out of history.jsonl. One file per unique blob, named by
  // its sha256, so repeated identical content (e.g. an agent re-emitting
  // the same full-file diff on every status tick) dedupes to one file.
  toolsDir: (id: string) =>
    path.join(hydraHome(), "sessions", id, "tools"),
  toolBlobFile: (id: string, hash: string) =>
    path.join(hydraHome(), "sessions", id, "tools", hash),
  // Persisted prompt queue for a session. ndjson, one record per
  // entry. Survives daemon restarts so queued prompts get a chance to
  // run rather than being silently lost. Entries are removed BEFORE
  // the agent invocation (see Session.drainQueue) so a crash mid-
  // generation doesn't double-run on restart.
  queueFile: (id: string) =>
    path.join(hydraHome(), "sessions", id, "queue.ndjson"),
  // Tombstones for sessions that were deleted locally but might still
  // be reported by an agent's session/list at the next periodic sync.
  // One file per (agentId, upstreamSessionId); existence is the source
  // of truth, contents are a small JSON blob for diagnostics and the
  // "agent advanced past our snapshot → resurrect" decision. Hidden
  // under sessions/ because SessionStore.read() filters non-conforming
  // dir names (the leading dot fails SESSION_ID_PATTERN) so the
  // directory cohabits safely with real session directories.
  tombstonesDir: () => path.join(hydraHome(), "sessions", ".tombstones"),
  tombstoneAgentDir: (agentId: string) =>
    path.join(hydraHome(), "sessions", ".tombstones", encodeURIComponent(agentId)),
  tombstoneFile: (agentId: string, upstreamSessionId: string) =>
    path.join(
      hydraHome(),
      "sessions",
      ".tombstones",
      encodeURIComponent(agentId),
      encodeURIComponent(upstreamSessionId),
    ),
  extensionsDir: () => path.join(hydraHome(), "extensions"),
  extensionLogFile: (name: string) =>
    path.join(hydraHome(), "extensions", `${name}.log`),
  extensionPidFile: (name: string) =>
    path.join(hydraHome(), "extensions", `${name}.pid`),
  transformersDir: () => path.join(hydraHome(), "transformers"),
  transformerLogFile: (name: string) =>
    path.join(hydraHome(), "transformers", `${name}.log`),
  transformerPidFile: (name: string) =>
    path.join(hydraHome(), "transformers", `${name}.pid`),
  // Per-session scratch directory for transformer state. Each transformer
  // gets an isolated directory keyed by session + transformer name so
  // multiple transformers on the same session don't collide.
  transformerState: (sessionId: string, transformerName: string) =>
    path.join(hydraHome(), "sessions", sessionId, "transformer-state", transformerName),
  tuiHistoryFile: (id: string) =>
    path.join(hydraHome(), "sessions", id, "prompt-history"),
  // Cross-session prompt history. Up-arrow / ^R fall through to this
  // after the per-session list is exhausted. JSONL, one entry per
  // line, append-only so concurrent TUIs don't lose each other's
  // writes.
  globalTuiHistoryFile: () => path.join(hydraHome(), "prompt-history"),
  tuiLogFile: () => path.join(hydraHome(), "tui.log"),
  // Diagnostic dump of every JSON-RPC message that crosses a `hydra-acp
  // shim` process. Append-only NDJSON. One file shared by every shim;
  // each line carries the writing process's pid for disambiguation.
  shimWireLogFile: () => path.join(hydraHome(), "shim-wire.log"),
};
