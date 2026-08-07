// The TerminalHost interface: the program hydra is running inside.
//
// "Terminal host" rather than "multiplexer" or "terminal" because the set is
// heterogeneous — tmux, zellij and screen are multiplexers, wezterm, kitty
// and iTerm2 are emulators — and no category name is true of all of them. What
// they have in common is a relationship: they own the pane hydra is in, and
// they can be asked to open another one, rename its container, and show
// something about us.
//
// ---------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT BEHIND THIS INTERFACE
//
// OSC 7 (cwd), OSC 9;4 (progress), OSC 1337 user vars, the window title.
// Those work in every terminal with no adapter at all, are already
// implemented elsewhere (terminal-user-var.ts, format.ts,
// writeProgressIndicator), and form the universal baseline this interface
// sits ABOVE. A TerminalHost enriches; it never becomes the only channel.
// ---------------------------------------------------------------------

/**
 * Semantic activity of the session this pane is showing.
 *
 * Note `unknown` is a real, useful value rather than an error case: it's
 * what a pane reports when it isn't presenting a session at all (picker
 * up), which is different from "idle".
 */
export type AgentActivity = "idle" | "working" | "blocked" | "unknown";

/**
 * Everything a host might want to display about the current session.
 *
 * DECLARATIVE, NOT EVENTS. Core merges the TUI's funnels, derives this,
 * diffs it against what was last sent, and only then calls `report()`.
 * Separate `updateTitle`/`updateStatus` methods would push that diffing
 * onto every adapter — and the banner funnel ticks at 1Hz while a turn
 * runs, so an adapter that forgot to dedupe would hammer its transport
 * once a second forever.
 *
 * SEMANTIC, NOT A WIRE FORMAT. There is deliberately no `tokens` bag here:
 * arbitrary key/values are one host's concept, and putting them in the
 * interface would make every other adapter implement someone else's schema.
 * Each adapter decides how to express these fields — as tokens, as user
 * vars, as a status-line variable, or not at all.
 */
export interface TerminalHostSnapshot {
  state: AgentActivity;
  /**
   * The session the pane is CURRENTLY attached to.
   *
   * Published so external tooling can ask a host "which hydra session is
   * this pane showing right now" — `tmux-hardcopy.sh` and its herdr
   * equivalent both hinge on it. It has to ride the snapshot rather than
   * being read from argv or the environment, because the TUI switches
   * sessions in-process: `hydra tui --session X` keeps X in argv forever
   * while this field follows the switch.
   *
   * Never null in practice — report.ts refuses to flush before it knows
   * the session — but typed like its neighbours so hosts don't have to
   * care about that invariant.
   */
  sessionId: string | null;
  /** Already resolved by core, including the fall back to a cwd label. */
  title: string | null;
  /** The SESSION's cwd (not the pane process's — they diverge on switch). */
  cwd: string | null;
  /** Agent kind, e.g. "claude-code". Never the host's notion of an agent. */
  agent: string | null;
  model: string | null;
  /** Pre-formatted, e.g. "$1.23". Null when there's no cost to show. */
  cost: string | null;
  /** Queued prompt count; null rather than 0 when there's nothing queued. */
  queued: number | null;
}

/**
 * What a host can actually do.
 *
 * Explicit rather than inferred from which optional methods exist, because
 * some capabilities are runtime facts a method's presence can't express:
 * kitty has `set-tab-title`, but only when the user enabled
 * `allow_remote_control`. An adapter needs to be able to say "I have the
 * method and it won't work here".
 *
 * Callers must treat an absent capability as FEATURE ABSENT, not as
 * "degrade gracefully". For anything that overwrites user-visible state
 * this is load-bearing: zellij can't read a tab label back, so the
 * ownership guard can't run, and a best-effort write there would silently
 * stomp the user's own tab name.
 */
export interface TerminalHostCapabilities {
  /** Can launch a command in a new tab/window. Gates the picker's ^t. */
  openTab: boolean;
  /**
   * Can launch beside the current pane.
   *
   * Separate from openTab because it isn't a parameter, it's a different
   * ability. Some hosts can only build a tab wholesale, so "put a pane
   * beside this one" would mean rebuilding the current tab and killing the
   * pane you're sitting in; others split natively. A
   * `where: "tab" | "split"` argument would hide that behind a silent
   * downgrade.
   */
  split: boolean;
  /** Can BOTH read and write the tab label. Read-only or write-only is false. */
  label: boolean;
  /** Can report session status (state/title/tokens/…) at all. */
  report: boolean;
}

/** A command to launch, fully assembled by core. */
export interface OpenTabSpec {
  /** Tab/window label to give the new container. */
  label: string;
  /** argv, launched directly — no shell, so nothing needs escaping. */
  argv: string[];
  /** Working directory, or undefined to inherit. Always absolute if set. */
  cwd?: string | undefined;
  /**
   * Extra environment for the new pane.
   *
   * Core uses this to hand the child its tab-label ownership marker, so
   * that policy stays in core rather than being re-derived per adapter.
   */
  env?: Record<string, string> | undefined;
}

export interface OpenTabResult {
  ok: boolean;
  /** Present when ok is false; shown to the user, so keep it readable. */
  error?: string;
}

/** What core needs to know about a tab before it may rename it. */
export interface TabLabelView {
  label: string;
  /**
   * Whether the host generated this label rather than a human choosing it,
   * when the host can answer authoritatively.
   *
   * Preferred over isAutoLabel when present. Some hosts track this as a fact
   * rather than a naming convention — tmux has a per-window
   * `automatic-rename` flag, so it can simply say, where herdr can only
   * infer from the string. Omitted means "I don't know, use isAutoLabel".
   */
  auto?: boolean;
  /**
   * Panes in this tab. Core refuses to rename a split tab: no single
   * pane's session has a claim on the whole tab's name, and a second
   * hydra in the other pane would fight over it.
   */
  paneCount: number;
}

/**
 * One terminal host adapter.
 *
 * Every method may reject or throw; callers wrap each call in try/catch
 * plus a timeout and never await one in a render path. That discipline
 * lives with the CALLER on purpose — an adapter can be a user-supplied
 * module loaded into the TUI process, sharing it with the alt-screen
 * render loop and the raw stdin handler, so "the adapter is well behaved"
 * is not a safe assumption to build on.
 */
export interface TerminalHost {
  /** Stable id, used in logs and as the config/override key. */
  readonly id: string;
  readonly caps: TerminalHostCapabilities;

  /** Push the current snapshot. Called only when something changed. */
  report(snapshot: TerminalHostSnapshot): Promise<void>;

  /**
   * Withdraw everything on TUI exit.
   *
   * Not cosmetic: a host that shows agent state has no way to notice this
   * pane's hydra is gone, so anything left behind stays until the pane
   * dies. Awaited by core, unlike report().
   */
  release(): Promise<void>;

  /** Launch argv in a new tab. Required when caps.openTab. */
  openTab?(spec: OpenTabSpec): Promise<OpenTabResult>;

  /** Launch argv beside this pane. Required when caps.split. */
  splitTab?(spec: OpenTabSpec): Promise<OpenTabResult>;

  /** Read this pane's tab label. Required when caps.label. */
  readLabel?(): Promise<TabLabelView | null>;

  /** Set this pane's tab label. Required when caps.label. */
  writeLabel?(label: string): Promise<boolean>;

  /**
   * Whether `label` is one this host generated rather than one a human
   * chose. Per-adapter because the conventions differ sharply: some number
   * their tabs, tmux names them after the running command ("zsh", "node"),
   * zellij uses "Tab #1". Required when caps.label.
   *
   * Only consulted when readLabel() did not return an authoritative `auto`.
   * Answer conservatively (false) when unsure: the cost of a false negative
   * is a tab that doesn't follow the title, the cost of a false positive is
   * stomping a name the user chose.
   */
  isAutoLabel?(label: string): boolean;
}

/**
 * A detectable adapter.
 *
 * `detect` is separate from `create` so probing costs nothing and never
 * instantiates a transport for a host we aren't in.
 */
export interface TerminalHostCandidate {
  id: string;
  /** Env vars this host uses to name a pane — see core/scrub-env.ts. */
  paneScopedEnv: readonly string[];
  detect(env: NodeJS.ProcessEnv): boolean;
  create(): TerminalHost;
}
