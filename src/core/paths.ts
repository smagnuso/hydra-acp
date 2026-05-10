import * as path from "node:path";
import * as os from "node:os";

const ROOT_ENV = "HYDRA_ACP_HOME";

export function hydraHome(): string {
  const override = process.env[ROOT_ENV];
  if (override && override.length > 0) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".hydra-acp");
}

export const paths = {
  home: hydraHome,
  config: () => path.join(hydraHome(), "config.json"),
  pidFile: () => path.join(hydraHome(), "daemon.pid"),
  logFile: () => path.join(hydraHome(), "daemon.log"),
  registryCache: () => path.join(hydraHome(), "registry.json"),
  agentsDir: () => path.join(hydraHome(), "agents"),
  agentDir: (id: string) => path.join(hydraHome(), "agents", id),
  sessionsDir: () => path.join(hydraHome(), "sessions"),
  sessionFile: (id: string) => path.join(hydraHome(), "sessions", `${id}.json`),
  extensionsDir: () => path.join(hydraHome(), "extensions"),
  extensionLogFile: (name: string) =>
    path.join(hydraHome(), "extensions", `${name}.log`),
  extensionPidFile: (name: string) =>
    path.join(hydraHome(), "extensions", `${name}.pid`),
  tuiHistoryFile: () => path.join(hydraHome(), "tui-history"),
};
