import { writeFileSync } from "node:fs";

// Set the process title for human eyes (the `ps`/`top` command column,
// i.e. argv) while keeping the kernel "comm" name short and stable as
// `"hydra"` so `killall hydra` reaps interactive hydra processes
// without taking out the daemon.
//
// Node's stock `process.title = ...` writes BOTH argv AND comm with
// the same string. Comm gets truncated to 15 chars by the kernel,
// which means a useful long title like `hydra cat -p watch logs`
// arrives in /proc/<pid>/comm as `hydra cat -p w` — and `killall hydra`
// no longer matches it. We work around that on Linux by writing the
// long form via `process.title` (for argv/ps), then overwriting
// /proc/self/comm directly with the short anchor.
//
// On non-Linux (macOS, Windows), /proc/self/comm doesn't exist. We
// fall back to Node's vanilla behavior, which means non-Linux users
// see the short anchor in ps too (same as today). That's an
// acceptable degradation — the killall ergonomic still works on
// Linux where this matters, and macOS users typically use Activity
// Monitor / `lsof` / parent-pid heuristics anyway.
//
// The full title is built by the caller so each mode can include its
// own subcommand and args. Examples:
//   tui     → "hydra tui --session hydra_session_abc"
//   shim    → "hydra shim"           (editor-spawned, args usually absent)
//   cat     → "hydra cat -p '...' --detach"
//   launch  → "hydra launch claude-acp -c sandbox_mode=..."
//
// COMM_ANCHOR is exported so tests can match against it.
export const COMM_ANCHOR = "hydra";

export interface SetTitleDeps {
  // The kernel comm writer. Defaults to a real fs.writeFileSync on
  // /proc/self/comm; tests inject a spy.
  writeComm?: (text: string) => void;
  platform?: NodeJS.Platform;
}

const defaultWriteComm = (text: string): void => {
  writeFileSync("/proc/self/comm", text);
};

export function setHydraProcessTitle(
  fullTitle: string,
  deps: SetTitleDeps = {},
): void {
  process.title = fullTitle;
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") {
    return;
  }
  const writeComm = deps.writeComm ?? defaultWriteComm;
  try {
    writeComm(COMM_ANCHOR);
  } catch {
    // /proc not available (containers, restricted sandboxes) — leave
    // comm at whatever Node already set it to. ps still works.
  }
}

// Build the full title from argv. We omit `process.argv[0]` (node
// binary) and the bin path (`process.argv[1]`); what remains is the
// user-facing command line — the bits the user typed. Empty args
// arrays are tolerated (fall back to "hydra").
export function buildTitleFromArgv(argv: readonly string[]): string {
  if (argv.length === 0) {
    return COMM_ANCHOR;
  }
  return `${COMM_ANCHOR} ${argv.join(" ")}`;
}
