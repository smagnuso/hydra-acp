import { writeFileSync } from "node:fs";
import { invokedBinName } from "./bin-name.js";

// Set the process title for human eyes (the `ps`/`top` command column,
// i.e. argv) and the kernel `comm` name so `killall <whatever-you-ran>`
// reaps the matching interactive hydra processes.
//
// `comm` follows the user's invocation: invoke as `hydra` and comm is
// `hydra`; invoke as `hydra-acp` and comm is `hydra-acp`. This makes
// `killall <bin>` match the bin the user actually typed at the shell.
// The daemon is the one exception: it sets `process.title =
// "hydra-daemon"` explicitly so it's always reaped by `killall
// hydra-daemon` regardless of which bin started it.
//
// Node's stock `process.title = ...` writes BOTH argv AND comm with
// the same string. Comm gets truncated to 15 chars by the kernel,
// which means a useful long title like `hydra cat -p watch logs`
// arrives in /proc/<pid>/comm as `hydra cat -p w` — and `killall hydra`
// no longer matches it. On Linux we work around that by writing the
// long form via `process.title` (for argv/ps), then overwriting
// /proc/self/comm directly with the short bin name.
//
// On non-Linux (macOS, Windows), /proc/self/comm doesn't exist. We
// fall back to Node's vanilla behavior, which means non-Linux users
// see the short bin name in ps too. That's an acceptable degradation —
// the killall ergonomic still works on Linux where this matters, and
// macOS users typically use Activity Monitor / `lsof` / parent-pid
// heuristics anyway.
//
// The full title is built by the caller so each mode can include its
// own subcommand and args. Examples (when invoked as `hydra`):
//   tui     → "hydra tui --session hydra_session_abc"
//   shim    → "hydra shim"           (editor-spawned, args usually absent)
//   cat     → "hydra cat -p '...' --detach"
//   launch  → "hydra launch claude-acp -c sandbox_mode=..."

export interface SetTitleDeps {
  // The kernel comm writer. Defaults to a real fs.writeFileSync on
  // /proc/self/comm; tests inject a spy.
  writeComm?: (text: string) => void;
  platform?: NodeJS.Platform;
  // Override the comm name written to /proc/self/comm. Defaults to
  // invokedBinName(); tests pin it to a known value rather than
  // mutating process.argv.
  commName?: string;
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
    writeComm(deps.commName ?? invokedBinName());
  } catch {
    // /proc not available (containers, restricted sandboxes) — leave
    // comm at whatever Node already set it to. ps still works.
  }
}

// Build the full title from argv. We omit `process.argv[0]` (node
// binary) and the bin path (`process.argv[1]`); what remains is the
// user-facing command line — the bits the user typed. Empty args
// arrays are tolerated (return just the prefix).
//
// `prefix` defaults to invokedBinName() so the ps row matches what
// the user typed. Tests pass an explicit prefix rather than mutating
// process.argv.
export function buildTitleFromArgv(
  argv: readonly string[],
  prefix: string = invokedBinName(),
): string {
  if (argv.length === 0) {
    return prefix;
  }
  return `${prefix} ${argv.join(" ")}`;
}
