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

// File format: `<hydra-pid>:<parent-pid>:<session-id>\n`. Keys by pty
// basename so the total file count is bounded by unique ptys the
// machine has ever handed out (no GC needed). The parent-pid field
// lets --reattach detect "same shell instance" (staleness after a
// tab close/reopen even if the pty basename gets reused). The
// hydra-pid field lets any consumer walking the dir cheaply tell
// live-attached TUIs from stale entries via `kill(pid, 0)` — used
// for potential features like `hydra ttys` listing.
function writeTtyStickyFile(sessionId: string): void {
  const base = ttyBasename();
  if (!base) {
    return;
  }
  try {
    fs.mkdirSync(paths.ttySessionDir(), { recursive: true });
    const line = `${process.pid}:${process.ppid}:${sessionId}\n`;
    fs.writeFileSync(paths.ttySessionFile(base), line, { mode: 0o600 });
  } catch {
    // Best-effort; --reattach falls back to cwd-based selection.
  }
}

interface StickyRecord {
  hydraPid: number;
  parentPid: number;
  sessionId: string;
}

function parseStickyLine(raw: string): StickyRecord | null {
  const line = raw.trim();
  if (line.length === 0) {
    return null;
  }
  // Legacy shape (before the pid fields) was just the bare session
  // id. Detect it by the absence of colons and treat as no-parent-pid
  // (staleness check is skipped — worst case is one wrong-reattach
  // during migration).
  if (!line.includes(":")) {
    return { hydraPid: 0, parentPid: 0, sessionId: line };
  }
  const parts = line.split(":");
  if (parts.length < 3) {
    return null;
  }
  const hydraPid = Number.parseInt(parts[0]!, 10);
  const parentPid = Number.parseInt(parts[1]!, 10);
  const sessionId = parts.slice(2).join(":");
  if (!Number.isFinite(hydraPid) || !Number.isFinite(parentPid) || sessionId.length === 0) {
    return null;
  }
  return { hydraPid, parentPid, sessionId };
}

function readStickyRecord(): StickyRecord | null {
  const base = ttyBasename();
  if (!base) {
    return null;
  }
  try {
    const raw = fs.readFileSync(paths.ttySessionFile(base), "utf8");
    return parseStickyLine(raw);
  } catch {
    return null;
  }
}

// Returns the session id from the sticky file if the recorded
// parent-pid still matches the caller's parent — i.e. the same shell
// instance that originally wrote the file is now running the
// --reattach. Legacy files (no pid fields) are trusted as a
// migration convenience.
function readTtyStickyFile(): string | null {
  const rec = readStickyRecord();
  if (!rec) {
    return null;
  }
  if (rec.parentPid > 0 && rec.parentPid !== process.ppid) {
    return null;
  }
  return rec.sessionId;
}

// Enumerate every recorded (pty-basename, session-id, is-live) tuple
// so consumers (e.g. `hydra ttys`) can render "which TUIs are
// currently attached" without touching the daemon. `alive` is true
// when the recorded hydra pid still exists (checked via kill(pid,
// 0)); it doesn't verify that the pid is *hydra* specifically, only
// that the process is still around — good enough for a status
// display where the alternative is "definitely dead". Legacy files
// without a pid always return alive=false.
export interface LiveTtyEntry {
  ttyBasename: string;
  sessionId: string;
  hydraPid: number;
  parentPid: number;
  alive: boolean;
}

export function listLiveHydraTtys(): LiveTtyEntry[] {
  const dir = paths.ttySessionDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: LiveTtyEntry[] = [];
  for (const name of names) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    const rec = parseStickyLine(raw);
    if (!rec) {
      continue;
    }
    let alive = false;
    if (rec.hydraPid > 0) {
      try {
        process.kill(rec.hydraPid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    out.push({
      ttyBasename: name,
      sessionId: rec.sessionId,
      hydraPid: rec.hydraPid,
      parentPid: rec.parentPid,
      alive,
    });
  }
  return out;
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
