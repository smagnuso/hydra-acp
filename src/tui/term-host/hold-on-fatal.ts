// A hydra opened in a host tab dies with the tab: when the process exits the
// host closes the pane, and a fatal startup error (agent failed to spawn, daemon
// unreachable) is gone before it can be read. This keeps the pane open.

export const HOLD_ON_FATAL_ENV = "HYDRA_HOLD_ON_FATAL";

export function holdOnFatalEnv(): Record<string, string> {
  return { [HOLD_ON_FATAL_ENV]: "1" };
}

export interface HoldInput {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  once(event: "data", listener: () => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export function shouldHoldOnFatal(
  env: NodeJS.ProcessEnv,
  stdin: { isTTY?: boolean },
  stderr: { isTTY?: boolean },
): boolean {
  return env[HOLD_ON_FATAL_ENV] === "1" && !!stdin.isTTY && !!stderr.isTTY;
}

export async function holdOnFatal(
  stdin: HoldInput,
  write: (text: string) => void,
): Promise<void> {
  write("\nPress any key to close this tab.\n");
  stdin.setRawMode?.(true);
  stdin.resume();
  await new Promise<void>((resolve) => {
    stdin.once("data", () => resolve());
  });
  stdin.setRawMode?.(false);
  stdin.pause();
}
