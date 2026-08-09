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
// a shell that had inherited the daemon's environment, renamed a terminal tab
// it had never been running in — and left a phantom "working" agent report
// pinned on an unrelated pane, which nothing could clear because the
// process that made the report had exited.
//
// WHAT IS NOT SCRUBBED, AND WHY
//
// Only *pane-scoped* variables. The "how do I reach the server" variables
// deliberately survive: a control socket or session handle is a per-user
// thing that stays valid for the daemon's whole life, so an extension that
// wants to drive the multiplexer can still reach it. What it must not do is
// *assume a pane*. Removing the ids while keeping the socket says exactly
// that — talk to the multiplexer, but resolve your target explicitly instead
// of inheriting someone else's.
//
// It also means hydra's own reporting (src/tui/term-host/) goes inert in a
// daemon-spawned process without any extra check, since every adapter's
// detection requires a pane id.
//
// EXPLICIT CONFIG ALWAYS WINS
//
// Scrubbing applies to the INHERITED environment only. A variable set
// deliberately — in an agent's launch plan, or an extension's `env` block
// in config.json — is layered on afterwards and is never removed. Someone
// who writes a pane id into their extension config means it.
// ---------------------------------------------------------------------

/**
 * Pane-identity variables, grouped by the multiplexer that sets them.
 *
 * ---------------------------------------------------------------------
 * WHY EVERY GROUP IS SCRUBBED, NOT JUST THE ONE WE DETECTED
 *
 * It is tempting to scrub only the multiplexer hydra is actually running
 * under. That is wrong, because these things NEST — a multiplexer inside an
 * emulator, or one inside another, are both ordinary setups. Detection
 * deliberately
 * resolves to the innermost one (it owns the pane you are really in), so
 * scrubbing only the detected backend leaves the outer one's pane id
 * sailing straight through.
 *
 * The two questions are not the same question:
 *
 *   detection — "who do I talk to?"        exactly one answer
 *   scrubbing — "what must not outlive     everything pane-scoped,
 *                this pane?"                unconditionally
 *
 * Stripping TMUX_PANE while running under something else costs nothing;
 * leaving it costs a child process that believes it is in a pane it has
 * never seen.
 * So the effective list is the union of every group below, regardless of
 * what we detected — and this table needs no detection to be correct.
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 * The "how do I reach the server" variables — control sockets and session
 * handles such as TMUX, ZELLIJ, WEZTERM_UNIX_SOCKET, KITTY_LISTEN_ON, and
 * each host's own equivalent. Those stay valid for as long as the host is
 * running, which outlasts the daemon, so a host-aware extension can still
 * reach it. What it must not do is inherit a *pane*.
 *
 * GNU screen's `WINDOW` is also absent, on purpose: the name is generic
 * enough that scrubbing it risks eating an unrelated variable, and the
 * blast radius of that is worse than the leak it would prevent. `STY`
 * (the session name) is specific and is scrubbed.
 * ---------------------------------------------------------------------
 */
export const PANE_SCOPED_ENV_BY_BACKEND: Readonly<Record<string, readonly string[]>> = {
  // Each key mirrors what the matching adapter in tui/term-host/ declares as
  // its pane-scoped env. Duplicated rather than imported on purpose: the
  // daemon must not load terminal-host adapter modules (that's client-side
  // plumbing, and loading user-supplied adapters into a long-lived daemon is
  // a worse trust story), so it needs a static list of its own. Tests pin
  // each group against its adapter so the copies can't drift.
  //
  // These are names, not integrations: nothing here imports an adapter, and
  // a host with no adapter yet can still be listed.
  herdr: ["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_STARTUP_CWD"],
  tmux: ["TMUX_PANE"],
  zellij: ["ZELLIJ_PANE_ID", "ZELLIJ_SESSION_NAME"],
  wezterm: ["WEZTERM_PANE"],
  kitty: ["KITTY_WINDOW_ID"],
  screen: ["STY"],
  iterm2: ["ITERM_SESSION_ID"],
  // hydra's own: written by the ^t hand-off to tell the child it owns the
  // tab label. Names one specific tab, so it has the same problem. Host
  // agnostic — it describes hydra's claim, not any host's tab. Must stay in
  // step with TAB_LABEL_ENV in tui/term-host/label-sync.ts.
  hydra: ["HYDRA_TAB_LABEL"],
};

/**
 * The agent's own hydra session id, exported into every agent process so
 * a tool the agent shells out to knows which session it is speaking for
 * (`hydra cat --from-session` defaults to it).
 *
 * Scrubbed from the inherited environment for the same reason the
 * pane-scoped names above are: the daemon outlives the shell that
 * started it, so a value inherited from that shell describes some other
 * session and would attribute this agent's messages to it. The daemon
 * sets the correct value per-agent afterwards, and explicit spawn env is
 * layered on after scrubbing, so scrubbing here can't erase it.
 */
export const SELF_SESSION_ENV = "HYDRA_ACP_SESSION";

/** Variables the daemon owns and re-sets per agent, so never inherited. */
export const DAEMON_OWNED_ENV: readonly string[] = [SELF_SESSION_ENV];

/** Every variable scrubbed from the inherited environment by default. */
export const DEFAULT_SCRUBBED_ENV: readonly string[] = [
  ...Object.values(PANE_SCOPED_ENV_BY_BACKEND).flat(),
  ...DAEMON_OWNED_ENV,
];

/**
 * Layer the agent's own session id onto caller-supplied spawn env.
 * Wins over anything forwarded: the daemon knows which session it is
 * spawning for, and a caller passing a different value is either stale
 * or confused.
 */
export function withSelfSessionEnv(
  sessionId: string | undefined,
  forwarded?: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!sessionId) {
    return forwarded;
  }
  return { ...(forwarded ?? {}), [SELF_SESSION_ENV]: sessionId };
}

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
