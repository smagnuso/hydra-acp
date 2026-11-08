// Tearing down a supervised child on Windows.
//
// An extension installed from npm is launched through its `<name>.cmd` shim,
// so the pid we hold is a cmd.exe wrapper and the real process is its child.
// child.kill() and process.kill(pid) are TerminateProcess on that one pid:
// the wrapper dies and the real process is orphaned, still attached to the
// daemon, and a restart then runs a second copy beside it. taskkill /T ends
// the whole tree. It is always a hard kill, so on Windows the SIGTERM then
// SIGKILL escalation collapses into one step.
//
// Identity on every other platform.

import { spawnSync, type ChildProcess } from "node:child_process";

export interface ProcessTreeDeps {
  platform?: NodeJS.Platform;
  killTree?: (pid: number) => void;
}

export function killTreeByPid(pid: number): void {
  const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
}

export function terminateChild(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: NodeJS.Signals,
  deps: ProcessTreeDeps = {},
): void {
  const platform = deps.platform ?? process.platform;
  const pid = child.pid;
  if (platform === "win32" && pid !== undefined) {
    try {
      (deps.killTree ?? killTreeByPid)(pid);
      return;
    } catch {
      void 0;
    }
  }
  child.kill(signal);
}

export function terminatePid(
  pid: number,
  signal: NodeJS.Signals,
  deps: ProcessTreeDeps = {},
): void {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    try {
      (deps.killTree ?? killTreeByPid)(pid);
      return;
    } catch {
      void 0;
    }
  }
  process.kill(pid, signal);
}
