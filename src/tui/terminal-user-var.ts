// Advertise the currently-attached hydra session id to external
// tooling. Two independent channels — one per consumer:
//
//  1. tmux pane user option `@hydra_session` (via `tmux set-option
//     -p`). Set on TUI attach, cleared on TUI exit. Used by
//     `tmux-hardcopy.sh` and any other tmux binding that needs to
//     know "is hydra running in this pane right now, and if so which
//     session". Skipped when $TMUX_PANE is unset.
//
//  2. A per-TTY sticky file at ~/.hydra-acp/tty/<tty-basename>
//     containing the session id. Set on TUI attach; NEVER cleared on
//     exit. Used by `hydra --reattach` to prefer "the last session
//     that lived on this terminal" over "the most-recent session for
//     this cwd". Works on any terminal — WezTerm, iTerm2, Kitty,
//     Alacritty, Ghostty, plain xterm, in or out of tmux/screen —
//     because it only depends on stdin pointing at a real TTY.
//
// The tmux setopt runs detached; failures are swallowed (missing
// binary, unreachable server). The file write is best-effort too —
// if we can't resolve the controlling TTY or writing fails, we just
// skip the sticky part. Neither channel is required to be reliable
// enough to block session attach.
//
// The OSC 1337 SetUserVar bytes still go on the wire in case a
// terminal picks them up natively (iTerm2, Kitty), but nothing in
// hydra depends on that path — it's decoration.
//
// Files accumulate one per pty basename that ever hosted hydra on
// this host; they're small and rarely churn. If cleanup ever
// matters, add a periodic sweep that unlinks entries older than N
// days — out of scope here.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { paths } from "../core/paths.js";

const OSC = "\x1b]";
const BEL = "\x07";

function writeOSC(name: string, value: string): void {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  process.stdout.write(`${OSC}1337;SetUserVar=${name}=${encoded}${BEL}`);
}

function runTmuxDetached(args: string[]): void {
  if (!process.env.TMUX_PANE) {
    return;
  }
  try {
    const child = spawn("tmux", args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort — nothing to surface to the user here.
  }
}

// Resolve the controlling TTY's basename (e.g. "pts0", "ttys004").
// Tried in order:
//   - readlink /proc/self/fd/0 (Linux)
//   - readlink /dev/fd/0 (BSD / macOS)
//   - spawnSync("tty") (fallback, works everywhere with a real TTY)
// Returns null when stdin isn't a TTY or every strategy fails.
function resolveTtyBasename(): string | null {
  if (!process.stdin.isTTY) {
    return null;
  }
  const tryReadlink = (p: string): string | null => {
    try {
      const target = fs.readlinkSync(p);
      if (target.startsWith("/dev/") && target !== "/dev/tty") {
        return path.basename(target);
      }
      return null;
    } catch {
      return null;
    }
  };
  const linked = tryReadlink("/proc/self/fd/0") ?? tryReadlink("/dev/fd/0");
  if (linked) {
    return linked;
  }
  try {
    const r = spawnSync("tty", [], { encoding: "utf8", timeout: 500 });
    if (r.status !== 0) {
      return null;
    }
    const line = r.stdout.trim();
    if (!line.startsWith("/dev/") || line === "/dev/tty") {
      return null;
    }
    return path.basename(line);
  } catch {
    return null;
  }
}

let cachedTtyBasename: string | null | undefined = undefined;
function ttyBasename(): string | null {
  if (cachedTtyBasename === undefined) {
    cachedTtyBasename = resolveTtyBasename();
  }
  return cachedTtyBasename;
}

function writeTtyStickyFile(sessionId: string): void {
  const base = ttyBasename();
  if (!base) {
    return;
  }
  try {
    fs.mkdirSync(paths.ttySessionDir(), { recursive: true });
    fs.writeFileSync(paths.ttySessionFile(base), sessionId + "\n", {
      mode: 0o600,
    });
  } catch {
    // Best-effort; --reattach falls back to cwd-based selection.
  }
}

function readTtyStickyFile(): string | null {
  const base = ttyBasename();
  if (!base) {
    return null;
  }
  try {
    const raw = fs.readFileSync(paths.ttySessionFile(base), "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function publishActiveHydraSession(sessionId: string): void {
  writeOSC("hydra_session", sessionId);
  runTmuxDetached([
    "set-option",
    "-pt",
    process.env.TMUX_PANE ?? "",
    "@hydra_session",
    sessionId,
  ]);
  writeTtyStickyFile(sessionId);
}

export function clearActiveHydraSession(): void {
  writeOSC("hydra_session", "");
  runTmuxDetached([
    "set-option",
    "-put",
    process.env.TMUX_PANE ?? "",
    "@hydra_session",
  ]);
  // Deliberately does NOT delete the per-TTY sticky file — that file
  // is the sticky "last session on this terminal" pointer that
  // `hydra --reattach` reads.
}

// Read the sticky pointer for the current controlling TTY. Called
// from the --reattach path before the TUI takes over the terminal.
export function readStickyHydraSession(): string | null {
  return readTtyStickyFile();
}

// Reset the memoized TTY resolution — test-only so specs can control
// what stdin looks like across cases without process restart.
export function __resetTtyCacheForTests(): void {
  cachedTtyBasename = undefined;
}
