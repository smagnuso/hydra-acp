// Strip pane-scoped variables out of the environment the daemon hands to
// the processes it spawns (agents, extensions, transformers).
//
// ---------------------------------------------------------------------
// WHY THIS EXISTS
//
// The daemon inherits its environment from whatever shell started it, and
// then outlives that shell by days. Most of what it inherits is fine to
// pass on — PATH, HOME, proxy settings, an editor preference. A handful of
// variables are different in kind: they don't describe the machine or the
// user, they describe *one terminal pane*. Multiplexers set them so a
// process can report back to the pane it is running in.
//
// For a long-lived daemon and its children that is not merely stale, it is
// actively wrong, and it gets worse over time:
//
//   1. The pane the daemon was started in closes. The variables still name
//      it, so anything that acts on them writes into nothing.
//   2. The multiplexer restarts and REUSES the id. Now they name a
//      different pane, and a child process writes into an innocent
//      bystander's terminal.
//
// This is not theoretical. It was found because a hydra TUI, launched from
// a shell that had inherited the daemon's environment, renamed a herdr tab
// it had never been running in — and left a phantom "working" agent report
// pinned on an unrelated pane, which nothing could clear because the
// process that made the report had exited.
//
// WHAT IS NOT SCRUBBED, AND WHY
//
// Only *pane-scoped* variables. `HERDR_SOCKET_PATH` and `HERDR_ENV`
// deliberately survive: the socket is a per-user singleton and stays valid
// for the daemon's whole life, so an extension that wants to drive herdr
// can still reach it. What it must not do is *assume a pane*. Removing the
// ids while keeping the socket says exactly that — talk to the
// multiplexer, but resolve your target explicitly instead of inheriting
// someone else's.
//
// It also means hydra's own reporter (src/tui/herdr.ts) goes inert in a
// daemon-spawned process without any extra check, since it gates on
// HERDR_PANE_ID being present.
//
// EXPLICIT CONFIG ALWAYS WINS
//
// Scrubbing applies to the INHERITED environment only. A variable set
// deliberately — in an agent's launch plan, or an extension's `env` block
// in config.json — is layered on afterwards and is never removed. Someone
// who writes `HERDR_PANE_ID` into their extension config means it.
// ---------------------------------------------------------------------

/**
 * Pane-scoped variables scrubbed by default.
 *
 * herdr today; the same reasoning applies to any multiplexer that
 * advertises a pane identity this way, which is why the config escape
 * hatch below exists rather than this list being the only answer.
 */
export const DEFAULT_SCRUBBED_ENV = [
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_STARTUP_CWD",
  // Written by hydra's own ^t hand-off to tell the child it owns the tab
  // label. Names one specific tab, so it has exactly the same problem.
  "HYDRA_HERDR_TAB_LABEL",
] as const;

// Set once at daemon startup from config. Module-level rather than
// threaded through every spawn site because the two call sites
// (AgentInstance.spawn, ChildSupervisor) are deep in constructors that
// have no config handle, and inventing one for a list of strings would be
// a lot of plumbing for no added correctness.
let extraScrubbed: readonly string[] = [];

/**
 * Install the user's additional patterns. Called once from daemon start;
 * safe to call again (last call wins) and safe never to call.
 */
export function setExtraScrubbedEnv(patterns: readonly string[] | undefined): void {
  extraScrubbed = patterns ? [...patterns] : [];
}

/** Test-only: drop back to the built-in list. */
export function __resetScrubbedEnvForTests(): void {
  extraScrubbed = [];
}

/**
 * Whether `name` matches `pattern`.
 *
 * Exact match, plus a trailing `*` wildcard so a user can scrub a whole
 * family (`TMUX_*`, `WEZTERM_*`) without enumerating it. Only a trailing
 * `*` is special — a real glob would invite regex-shaped mistakes in a
 * config file, and env-var names are flat enough that a prefix covers the
 * realistic cases.
 *
 * Case-sensitive, because POSIX environments are. A Windows user writing
 * lowercase would be surprised, but so would a Linux user whose
 * `path` entry silently ate `PATH`.
 */
export function envNameMatches(name: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return name.startsWith(pattern.slice(0, -1));
  }
  return name === pattern;
}

/** Every pattern in force: built-ins plus whatever config added. */
export function scrubbedEnvPatterns(): readonly string[] {
  return [...DEFAULT_SCRUBBED_ENV, ...extraScrubbed];
}

/**
 * A copy of `env` with pane-scoped and user-listed variables removed.
 *
 * Returns a new object; the input is not mutated. Undefined values are
 * dropped too, so the result is safe to pass to `spawn` as-is.
 */
export function scrubInheritedEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const patterns = scrubbedEnvPatterns();
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    if (patterns.some((p) => envNameMatches(name, p))) {
      continue;
    }
    out[name] = value;
  }
  return out;
}
