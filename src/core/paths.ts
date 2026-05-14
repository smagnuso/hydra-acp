import * as path from "node:path";
import * as os from "node:os";

const ROOT_ENV = "HYDRA_ACP_HOME";

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
  pidFile: () => path.join(hydraHome(), "daemon.pid"),
  logFile: () => path.join(hydraHome(), "daemon.log"),
  currentLogFile: () => path.join(hydraHome(), "current.log"),
  registryCache: () => path.join(hydraHome(), "registry.json"),
  agentsDir: () => path.join(hydraHome(), "agents"),
  // <platformKey>/<agentId>/<version>/ — platform at the top so a Hydra
  // home shared between machines (NFS, rsync'd dotfiles) keeps each
  // machine's binaries cleanly separated. `ls agents/` immediately
  // shows which platforms have ever installed anything.
  agentInstallDir: (id: string, platformKey: string, version: string) =>
    path.join(hydraHome(), "agents", platformKey, id, version),
  sessionsDir: () => path.join(hydraHome(), "sessions"),
  // One directory per session id under sessions/. Co-locates the
  // session record, its transcript, and any future per-session state
  // (uploads, scratch, etc.) so the lifecycle is just "rm -rf the dir".
  sessionDir: (id: string) => path.join(hydraHome(), "sessions", id),
  sessionFile: (id: string) =>
    path.join(hydraHome(), "sessions", id, "meta.json"),
  historyFile: (id: string) =>
    path.join(hydraHome(), "sessions", id, "history.jsonl"),
  extensionsDir: () => path.join(hydraHome(), "extensions"),
  extensionLogFile: (name: string) =>
    path.join(hydraHome(), "extensions", `${name}.log`),
  extensionPidFile: (name: string) =>
    path.join(hydraHome(), "extensions", `${name}.pid`),
  tuiHistoryFile: (id: string) =>
    path.join(hydraHome(), "sessions", id, "prompt-history"),
  tuiLogFile: () => path.join(hydraHome(), "tui.log"),
};
