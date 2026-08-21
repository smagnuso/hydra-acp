import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { z } from "zod";
import { paths } from "./paths.js";
import { writeServiceToken } from "./service-token.js";
import { readJsonSafe, writeJsonAtomic } from "./json-store.js";

const REGISTRY_URL_DEFAULT =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const TlsConfig = z.object({
  cert: z.string(),
  key: z.string(),
});

export const DEFAULT_DAEMON_PORT = 55514;

const DaemonConfig = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(DEFAULT_DAEMON_PORT),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  tls: TlsConfig.optional(),
  sessionIdleTimeoutSeconds: z.number().int().nonnegative().default(3600),
  // Cap on entries kept in a session's on-disk replay log (history.jsonl).
  // Compaction trims to this many on a periodic basis; reads also slice
  // to the tail at this length as a defensive measure against older
  // daemons that may have written unbounded files.
  sessionHistoryMaxEntries: z.number().int().positive().default(10_000),
  // Per-archive byte ceiling for spilled history. When history.jsonl is
  // trimmed to sessionHistoryMaxEntries, the evicted head is appended to
  // history.jsonl.N (append-only, one entry per line, never split across
  // files). Once that file's on-disk size exceeds this threshold, the
  // next spill opens history.jsonl.N+1. Byte-based because entry sizes
  // are heterogeneous (a tool-result blob can dwarf a plain prompt) and
  // a byte budget gives a truthful disk ceiling. Cap is soft: a spill
  // batch is written whole, so the final size can overshoot by up to
  // one batch. Set 0 to disable archiving entirely (silent-drop, the
  // pre-archive behavior).
  sessionHistoryArchiveMaxBytes: z.number().int().nonnegative().default(10_000_000),
  // Max number of history.jsonl.N archive files kept per session. Once
  // this many exist and a new one would be needed, the oldest
  // (history.jsonl.1 by monotonic assignment) is deleted first — the
  // only place data is ever truly dropped. Combined with
  // sessionHistoryArchiveMaxBytes this bounds worst-case per-session
  // history footprint at roughly (tiers * maxBytes) + the live file.
  sessionHistoryArchiveTiers: z.number().int().positive().default(10),
  // Bytes of trailing agent stderr buffered per AgentInstance so the
  // daemon can include it in the diagnostic message when a spawn fails.
  // Bump if your agents emit large tracebacks you want surfaced.
  agentStderrTailBytes: z.number().int().positive().default(4096),
  // Externally-reachable hostname for this daemon, used when `hydra
  // session share` constructs a URL to advertise. Useful when the
  // daemon binds to loopback (the normal case) but is exposed via a
  // tunnel (ngrok) or VPN (Tailscale) under a different name. The
  // `--host` flag on `share` overrides this; omitting both falls
  // back to `daemon.host`, then to "127.0.0.1" with a stderr warning.
  publicHost: z.string().optional(),
  // How often (minutes) the daemon runs `agent sync` against every
  // installed (non-uvx) agent in the background, picking up sessions
  // created outside hydra so the picker can resurrect them. Spawns
  // are staggered across the window — N agents on a 60-minute interval
  // mean one agent spawn every 60/N minutes. Set 0 to disable entirely.
  agentSyncIntervalMinutes: z.number().nonnegative().default(60),
  // Extra environment variable names to strip from the environment the
  // daemon passes to agents, extensions and transformers, on top of the
  // built-in pane-scoped list in core/scrub-env.ts.
  //
  // For variables that describe the terminal the daemon happened to be
  // started in rather than the machine or the user. The daemon outlives
  // that terminal, so such a value is stale at best and — once the
  // multiplexer reuses the id — points at someone else's pane at worst.
  //
  // A trailing `*` matches a prefix, so `["TMUX*", "WEZTERM_PANE"]` works.
  // Matching is case-sensitive. Only the INHERITED environment is
  // filtered: anything set explicitly in an agent's launch plan or an
  // extension's own `env` block survives, since that was deliberate.
  scrubEnv: z.array(z.string()).default([]),
  // How often (minutes) the daemon sweeps for non-interactive cold
  // session records (one-shot `hydra cat` runs, mostly) that haven't
  // been touched in `sessionGcMaxAgeDays`. Set 0 to disable. The sweep
  // runs in the background, deletes the oldest matches first, and
  // caps each pass at ~200 records to keep the event loop responsive
  // when first enabled on a long-lived install with thousands of
  // accumulated rows.
  sessionGcIntervalMinutes: z.number().nonnegative().default(60),
  // Age cutoff for the session GC. Records (and their history files)
  // older than this are dropped on the next sweep. Live sessions and
  // anything ever promoted to interactive are never touched.
  sessionGcMaxAgeDays: z.number().positive().default(2),
});

const RegistryConfig = z.object({
  url: z.string().url().default(REGISTRY_URL_DEFAULT),
  ttlHours: z.number().positive().default(24),
  // When true, the daemon never re-fetches the registry over the network:
  // it serves whatever is in the on-disk cache (~/.hydra-acp/registry.json)
  // indefinitely, ignoring ttlHours. An escape hatch for when a bad registry
  // push breaks an agent — pin to the last-known-good cache until upstream
  // is fixed. `hydra registry refresh` still forces a one-off fetch.
  pinned: z.boolean().default(false),
});

// A user-defined agent that bypasses the network registry entirely. The
// daemon spawns `command` (with `args`/`env`) directly over stdio ACP —
// no install step, no version resolution. Lets a user point hydra at a
// system binary (e.g. their own `opencode`), a locally-built agent, or
// any ACP agent not yet published to the registry. Keyed by agent id in
// config.agents; a local agent with the same id as a registry agent
// shadows the registry entry.
const LocalAgentConfig = z.object({
  // Derive from another agent (registry or local) instead of defining a
  // distribution from scratch. The base is resolved through the same
  // lookup as `--agent`, so the implied `-acp` suffix works
  // (`extends: "pi"` finds `pi-acp`). Everything below is then layered on
  // top: objects merge, scalars and arrays replace, this entry wins.
  //
  // Prefer naming the canonical base id. Per-agent config maps keyed by
  // agent id (defaultModels, agentOverrides) walk this chain most-specific
  // first, and that walk matches ids as written.
  extends: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  // Optional: defaults to the agent id (the config.agents key), mirroring
  // how extensions default their command to the extension name. Set it
  // when the executable differs from the id, or to point at an absolute
  // path / wrapper script.
  //
  // With `extends`, setting this REPLACES the inherited distribution
  // rather than merging into it. planSpawn checks npx/binary/uvx before
  // exec, so leaving an inherited npx or binary distribution in place
  // alongside this command would silently spawn the base agent instead.
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});
export type LocalAgentConfig = z.infer<typeof LocalAgentConfig>;

// Pin overrides applied to a *registry* agent at spawn time. `packageSpec`
// replaces the npx package spec (e.g. "opencode-ai@0.5.12") so a bad
// upstream publish can be sidestepped without editing the registry. The
// pinned spec also keys its own install dir so it never collides with the
// floating "current" install.
const AgentOverrideConfig = z.object({
  packageSpec: z.string().optional(),
});
export type AgentOverrideConfig = z.infer<typeof AgentOverrideConfig>;

// Accepted keys for `tui.hotkeys`. Duplicates the KeyName union in
// src/tui/input.ts intentionally — core/ must not import from tui/. If
// the KeyName union grows, extend this list.
const TUI_HOTKEY_KEY_NAMES = z.enum([
  "enter",
  "alt-enter",
  "shift-enter",
  "ctrl-enter",
  "alt-b",
  "alt-f",
  "alt-n",
  "alt-tab",
  "shift-tab",
  "tab",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "backspace",
  "alt-backspace",
  "delete",
  "ctrl-a",
  "ctrl-b",
  "ctrl-c",
  "ctrl-d",
  "ctrl-e",
  "ctrl-f",
  "ctrl-g",
  "ctrl-k",
  "ctrl-l",
  "ctrl-n",
  "ctrl-o",
  "ctrl-p",
  "ctrl-q",
  "ctrl-r",
  "ctrl-s",
  "ctrl-u",
  "ctrl-v",
  "ctrl-t",
  "ctrl-w",
  "ctrl-x",
  "ctrl-y",
  "ctrl-underscore",
  "alt-underscore",
  "escape",
]);

// One entry in a chrome-bar slot: either a bare field id ("cwd"), an
// object naming a field with per-entry overrides, or a literal string
// to interleave.
//
// Field ids are listed in src/tui/bar/fields.ts (FIELDS). As of writing:
//   status, elapsed, sessionId, sessionIdFull, queued, scroll, usage,
//   tokens, cost, cwd, cwdFull, title, agent, model, agentModel, mode,
//   helpHint
// Unknown ids are ignored rather than rejected, so a config written
// against a newer build degrades instead of blanking the row.
//
// The literal "..." stands for the built-in list for that side, so a
// field can be added without restating the default:
//
//   "left": ["...", "cwd"]            append
//   "left": ["cwd", "..."]            prepend
//   "left": ["status", "cwd", "..."]  insert after status
//
// A field named explicitly is dropped from the expansion, so the third
// form repositions `status` rather than showing it twice. Only the
// first "..." expands.
const BarSlotEntry = z.union([
  z.string(),
  z
    .object({
      field: z.string().optional(),
      // Literal text instead of a field. Mutually exclusive with `field`.
      text: z.string().optional(),
      // Hard cap in columns; the value is truncated with an ellipsis.
      maxWidth: z.number().int().positive().optional(),
      // Marks the entry shrinkable down to this many columns before the
      // row starts dropping whole fields.
      minWidth: z.number().int().nonnegative().optional(),
      // Shed order when the two sides collide: lower goes first. Omit
      // to use the field's built-in priority.
      priority: z.number().optional(),
      prefix: z.string().optional(),
      suffix: z.string().optional(),
      // Overrides the slot separator painted *before* this entry. The
      // default layout uses this to hang `elapsed` off `status` with a
      // plain space instead of " · ".
      separator: z.string().optional(),
      // Theme token name (e.g. "rule-meta", "status-alert"). Raw colours
      // are deliberately not accepted, so themes keep working.
      style: z.string().optional(),
      // Mouse bindings, overriding the field's built-in behaviour. One
      // of: "toggle-mode", "switch-session", "show-help", "detach",
      // "copy" (put the field's value on the clipboard), "open" (hand
      // it to tui.openFileCommand), "none".
      //
      // "copy" and "open" act on the field's underlying value, not the
      // painted text: double-clicking a truncated title copies it whole,
      // and double-clicking `cwd` opens the absolute path rather than
      // the ~-abbreviated form.
      onClick: z.string().optional(),
      onDoubleClick: z.string().optional(),
    })
    .strict(),
]);

export type BarSlotEntry = z.infer<typeof BarSlotEntry>;

const BarSideConfig = z.array(BarSlotEntry);

export type BarSideConfig = z.infer<typeof BarSideConfig>;

// Built with explicit per-slot defaults so an absent key reproduces the
// layout the TUI shipped with before any of this was configurable.
function barConfig(
  left: BarSideConfig,
  right: BarSideConfig,
): z.ZodDefault<
  z.ZodObject<{ left: z.ZodDefault<typeof BarSideConfig>; right: z.ZodDefault<typeof BarSideConfig> }>
> {
  return z
    .object({
      left: BarSideConfig.default(left),
      right: BarSideConfig.default(right),
    })
    .default({});
}

export const DEFAULT_COMPOSER_TOP_LEFT: BarSideConfig = [
  "status",
  // A plain space, not " · ": renders as "Busy 1m 2s".
  { field: "elapsed", separator: " " },
  "sessionId",
  "queued",
  "scroll",
];
export const DEFAULT_COMPOSER_TOP_RIGHT: BarSideConfig = ["usage"];
export const DEFAULT_COMPOSER_BOTTOM_LEFT: BarSideConfig = [];
export const DEFAULT_COMPOSER_BOTTOM_RIGHT: BarSideConfig = ["helpHint"];
export const DEFAULT_SESSIONBAR_LEFT: BarSideConfig = ["cwd", "title"];
// No `mode` here on purpose: the composer's bottom rule already reports it,
// since helpHint rewrites its "⇧⇥ mode" legend to "⇧⇥ mode: <current>".
// Anyone who wants it on the sessionbar too can add the field, and it
// opens the mode chooser on double-click when they do.
export const DEFAULT_SESSIONBAR_RIGHT: BarSideConfig = ["agentModel"];

const TuiConfig = z.object({
  // Contents of the two rules that bracket the prompt composer.
  //
  //   composer.top    ── Busy 1m2s · a1b2c3 · 2 queued ──── 12.4k/200k · $0.31 ──
  //   <the prompt itself>
  //   composer.bottom ─────────────────────── ⇧⇥ mode · ^p pick · ^g guide ──
  //
  // Each side is an ordered list of fields; see BarSlotEntry above.
  // Fields with nothing to report (no title, nothing queued, not
  // scrolled) drop out along with their separator.
  //
  // One exception to "the config decides what renders": while a
  // notification, search counter or compaction/synthesis progress
  // message is live, it takes over composer.bottom.right for its
  // duration, whatever is configured there. That channel is the app's
  // only ephemeral-message surface and there is no second place for it
  // to go, so it is not something a user can accidentally switch off. When the two sides
  // would collide the row sheds whole fields in ascending priority,
  // then shrinks the ones that declared a minWidth, then truncates —
  // it never wraps.
  composer: z
    .object({
      top: barConfig(DEFAULT_COMPOSER_TOP_LEFT, DEFAULT_COMPOSER_TOP_RIGHT),
      bottom: barConfig(
        DEFAULT_COMPOSER_BOTTOM_LEFT,
        DEFAULT_COMPOSER_BOTTOM_RIGHT,
      ),
      // How many prompts this session has to have sent before the
      // helpHint field stops rendering. The hints are onboarding, not a
      // permanent readout: past the threshold the bottom rule paints as
      // an unbroken line, and hovering it (or pressing a Ctrl chord that
      // isn't bound to anything) brings them back until the next prompt.
      // Counted from the per-session prompt history, so turns the agent
      // starts by itself don't advance it.
      //
      // null keeps them up permanently. 0 skips onboarding entirely and
      // leaves the row hover-only — the reveal overrides the threshold, so
      // it is "never on its own", not "never".
      hintTurns: z.number().int().nonnegative().nullable().default(3),
    })
    // Same reasoning as tui.sidebar: leaf defaults are the single
    // source of truth.
    .default({}),
  // Contents of the sessionbar, the last row of the terminal:
  //
  //   ~/dev/hydra-acp/cli · My title              claude•sonnet-4
  //
  // Distinct from `tui.sidebar` (the right-hand column) despite the
  // one-letter difference.
  sessionbar: barConfig(DEFAULT_SESSIONBAR_LEFT, DEFAULT_SESSIONBAR_RIGHT),
  // Minimum interval (ms) between full-screen repaints driven by content
  // events (agent text chunks, tool/plan updates, elapsed-tick refreshes).
  // User-action repaints — scrolling, prompt-row changes, modal open/close,
  // /clear, ^L, resize — bypass this throttle. Default 1000 (1 Hz) keeps
  // CPU low during heavy streaming; bump to 250 for 4 Hz, 100 for ~10 Hz,
  // or 0 to disable throttling entirely.
  repaintThrottleMs: z.number().int().nonnegative().default(1000),
  // Cap on logical lines retained in the in-memory scrollback render
  // buffer. Oldest lines are dropped on overflow. The on-disk session
  // history is unaffected; this only bounds the TUI's local view buffer.
  maxScrollbackLines: z.number().int().positive().default(10_000),
  // When true, the TUI captures mouse events so the wheel can drive
  // scrollback. The cost: terminals route clicks to the app, so text
  // selection requires shift+drag to bypass mouse reporting. Default
  // true — wheel scrolls the in-app scrollback and click-drag drives
  // the in-app selector. Set false to hand the wheel + click-drag
  // back to the terminal emulator's native scrollback / selection.
  mouse: z.boolean().default(true),
  // Whether the TUI's in-app text selection feature is enabled. This
  // is an independent escape hatch for users whose muscle memory
  // conflicts with the in-app selector, separate from `mouse` capture
  // itself. Unset (the default) means "follow `mouse`" — selection is
  // on when mouse capture is on, off when it's off, so terminals fall
  // back to native click-drag selection. Set explicitly to true or
  // false to pin the behavior regardless of mouse capture. Resolve
  // via resolveInAppSelection(config).
  inAppSelection: z.boolean().optional(),
  // Where an in-app text selection is copied. X11/Wayland expose two
  // independent buffers: the CLIPBOARD (Ctrl/Cmd+V) and the PRIMARY
  // selection (middle-click paste). Native terminal select-to-copy
  // populates PRIMARY; most apps' explicit copy populates CLIPBOARD.
  //   "both"      — write both, matching what users expect from either
  //                 paste gesture (default)
  //   "clipboard" — only the CLIPBOARD buffer
  //   "primary"   — only the PRIMARY selection
  // macOS has no PRIMARY concept, so all values behave as "clipboard".
  selectionClipboard: z.enum(["primary", "clipboard", "both"]).default("both"),
  // Command spawned when a double-click lands on a token that resolves
  // to an existing file. Accepts two shapes:
  //   - String: split on whitespace into argv; %f is replaced with the
  //     absolute file path and %n with the line number (or "" when the
  //     token lacks a `:NN` suffix). If no %f appears, the path is
  //     appended as a final arg. Examples:
  //       "code --goto %f:%n"
  //       "emacsclient -n +%n %f"
  //   - Array: pre-split argv with the same %f / %n substitution rules
  //     (use this when an arg must contain literal whitespace). Example:
  //       ["code", "--goto", "%f:%n"]
  // Unset falls back to $VISUAL, then $EDITOR, treated as the string
  // form. Those carry no %f/%n, so the path is appended; the line number
  // is passed in the editor's own syntax when it's one we know (`vim +42`,
  // `hx path:42`) and dropped otherwise.
  // With none of the three set the feature is off — double-click
  // continues to snap the word for clipboard copy. A command set here is
  // spawned detached with stdio ignored; failures are surfaced via the
  // in-app notification line, not blocking the TUI. The $VISUAL/$EDITOR
  // fallback runs in the foreground instead — see openFileInTerminal.
  openFileCommand: z.union([z.string(), z.array(z.string())]).optional(),
  // Whether the open-file gesture hands the terminal to the editor and
  // waits for it, rather than spawning it in the background.
  //
  // Unset (the default) decides by where the command came from: the
  // $VISUAL / $EDITOR fallback runs in the foreground, an explicit
  // openFileCommand runs detached. That split is the convention those
  // variables already carry — `crontab -e`, `git commit` and `visudo` all
  // require $EDITOR to block and own the terminal, which is why
  // `EDITOR="code --wait"` is the idiom — whereas openFileCommand is
  // hydra-specific and has always been a background spawn here.
  //
  // Set true when an explicit openFileCommand names a terminal editor (or
  // a wrapper we can't see through). Set false for the reverse case: a GUI
  // editor in $VISUAL, where suspending the TUI for the length of an edit
  // is not what you want.
  //
  // A foreground editor takes the whole terminal: the TUI leaves the
  // alternate screen, the editor owns stdin/stdout, and quitting it
  // repaints the session. Nothing streaming in from the daemon is lost —
  // it lands in the model and paints on the way back.
  openFileInTerminal: z.boolean().optional(),
  // Size at which the TUI's session/update debug log (tui.log) rotates
  // to tui.log.0 and resets. Bounds on-disk use at ~2x this value.
  logMaxBytes: z.number().int().positive().default(5 * 1024 * 1024),
  // Width cap on the cwd column in the `sessions list` output and the
  // TUI picker. Set higher if you keep deeply-nested working directories
  // and want them visible; the elastic title column shrinks to make room.
  cwdColumnMaxWidth: z.number().int().positive().default(32),
  // When true (default), emit OSC 9;4 progress-bar control codes so the
  // host terminal can show an indeterminate busy indicator (taskbar pulse
  // on Windows Terminal, dock badge on KDE/Konsole, etc.) while a turn is
  // running. Set false if your terminal renders this obnoxiously or you
  // just don't want it.
  progressIndicator: z.boolean().default(true),
  // When true, the TUI enters terminal-host launcher mode on its own in any
  // pane where a supported host (herdr or tmux) is detected, exactly as if
  // --terminal-host-launcher had been passed. Off by default: the mode
  // changes what picking a session does, which is too visible a change to
  // infer from the environment without being asked.
  //
  // Named for the condition rather than the mode, because true does not mean
  // "always on" — in a bare terminal there is nowhere to launch, so the
  // setting silently does nothing. That asymmetry with the flag is
  // deliberate: the flag is per-invocation intent and exits 2 when it can't
  // be honoured; this is ambient and applies to panes where it can't, so it
  // has to degrade quietly. --no-terminal-host-launcher overrides it for a
  // single run.
  launcherModeWhenHosted: z.boolean().default(false),
  // Standing default for --dangerously-skip-permissions on the TUI: every
  // session/request_permission is auto-approved with allow_once and the
  // modal never appears. Off by default, and deliberately TUI-only: shim
  // and cat are spawned by editors and scripts that pass their own argv,
  // so an ambient config key there would silently disarm paths the user
  // isn't watching.
  //
  // The flag ORs with this rather than overriding it (there is no "off"
  // value of a boolean flag to override with); pass
  // --no-dangerously-skip-permissions to get the prompts back for a
  // single run.
  skipPermissions: z.boolean().default(false),
  // What the unmodified Enter key does in the prompt composer.
  //   "amend" (default) — Enter amends the in-flight turn; Shift+Enter
  //     enqueues. With no turn in flight either key just enqueues,
  //     since there's nothing to amend.
  //   "enqueue" — flips the two: Enter enqueues the prompt (sends
  //     immediately when idle, queues behind an in-flight turn);
  //     Shift+Enter amends the in-flight turn.
  defaultEnterAction: z.enum(["enqueue", "amend"]).default("amend"),
  // When true (default), agent_thought events render as dim italic
  // streaming lines beneath the live thinking block. Set false to
  // suppress them — the TUI hotkey ^T toggles this at runtime without
  // persisting back to config.
  showThoughts: z.boolean().default(true),
  // How the terminal renders East-Asian "Ambiguous" width glyphs (em-dash
  // —, smart quotes “ ”, ellipsis …, middle-dot ·). Most modern terminals
  // draw them 1 col wide ("narrow"); CJK-locale / legacy setups (and
  // CJK-configured macOS Terminal.app profiles) draw them 2 cols wide
  // ("wide"). Defaults to "auto", which measures the terminal directly at
  // startup: it draws each glyph and asks where the cursor landed (CSI 6n),
  // so the answer reflects the emulator's actual configuration rather than a
  // guess from its name. Terminals that do not answer fall back to sniffing
  // LC_*/LANG for a CJK locale, then to "narrow" — the right answer
  // for xterm, gnome-terminal, iTerm2, Alacritty, Kitty, WezTerm, Ghostty,
  // VS Code terminal, and Windows Terminal. Set explicitly to override the
  // measurement.
  ambiguousWidth: z.enum(["auto", "narrow", "wide"]).default("auto"),
  // How the TUI receives tool payload on attach/replay.
  //   "references" — the lean path (default): the daemon ships blob refs and
  //                  the TUI fetches a diff/output body on demand when
  //                  expanded, cutting replay size on tool-heavy sessions.
  //                  Collapsed rows never fetch (they show a size hint), and
  //                  old inline sessions/live turns are unaffected (no refs).
  //   "inline"     — full content up front (the pre-externalization shape).
  toolContent: z.enum(["inline", "references"]).default("references"),
  // Unchanged context lines shown around each change in an expanded Edited
  // diff. Some agents (e.g. pi) report edits as full-file old/new text via
  // ACP "diff" content blocks; without hunking a 1-line edit would render
  // the entire file. This bounds the context so only the changed region (±N
  // lines) shows, with runs of unchanged lines collapsed to a marker.
  diffContextLines: z.number().int().min(0).default(3),
  // Cap on entries kept in the cross-session global prompt-history file
  // (~/.hydra-acp/prompt-history). This is the ^P / ^R recall list
  // shared across all sessions; it's append-only on disk, so long-lived
  // installs can grow past this — it's enforced at load time and per
  // append in memory.
  promptHistoryMaxEntries: z.number().int().positive().default(2_000),
  // Cap on tool rows shown inside the collapsed tools block. When more
  // tools have fired than the cap, only the most recent N are visible
  // and the header advertises "^O expand" so the user can see the rest.
  // 0 disables the cap entirely — every tool row stays visible.
  maxToolItems: z.number().int().nonnegative().default(5),
  // Cap on plan entries rendered before the formatter switches to a
  // sliding window around the active (in_progress / first pending)
  // entry. Counters in the header summarize what's done and what's
  // left when truncation kicks in. 0 disables the cap — every plan
  // entry is rendered.
  maxPlanItems: z.number().int().nonnegative().default(5),
  // Sidebar (^S, or the Sidebar row in ^O). A column down the right edge
  // of the transcript region; the prompt and sessionbar keep the full
  // terminal width.
  //
  // `gadgets` is the top-to-bottom display order, and therefore also
  // priority order: the column scrolls under the mouse wheel, so a stack
  // taller than the terminal isn't truncated — the gadgets listed first
  // are simply the ones visible without scrolling. Unknown ids are
  // ignored. Known ids: activity (thinking/idle timer), context (token
  // window + cost), queue, todo, files (edited this session), git,
  // resources (memory/CPU for this TUI and the agent's process tree — the
  // agent row needs a local daemon, since a remote agent's pid means
  // nothing in this machine's process table), session, tools (the tool calls
  // in flight right now, so a long turn's current call stays visible after
  // the tools block has scrolled off the top of the transcript — listed
  // last by default because it fills and empties on a per-tool-call
  // cadence, which shoves anything below it around).
  //
  // `width` pins the body width in columns; omit to size it as ~28% of the
  // terminal, clamped to 20..36. A pinned width is honored even when large:
  // once the column would take more than half the terminal it stops
  // reflowing the transcript and floats over it instead, since rewrapping
  // prose into the smaller half costs more than covering its right-hand
  // side. The sidebar suppresses itself entirely below an 80-column
  // terminal.
  sidebar: z
    .object({
      enabled: z.boolean().default(false),
      width: z.number().int().positive().optional(),
      // How the column is framed:
      //   "frame" (default) — a continuous left edge with a horizontal rule
      //     at each boundary, using the box-drawing junction the position
      //     calls for: "┌" opens the column, "├" separates gadgets, "└"
      //     closes it off at the bottom.
      //   "rule" — one unbroken vertical rule and nothing else; gadgets
      //     separated by a blank row.
      //   "none" — no rules at all, blank-row separation only.
      border: z.enum(["none", "rule", "frame"]).default("frame"),
      gadgets: z
        .array(z.string())
        // Must stay in step with DEFAULT_GADGET_IDS in tui/sidebar/registry.ts.
        // Duplicated rather than imported because core must not depend on tui.
        .default([
          "activity",
          "sessions",
          "tasks",
          "context",
          "queue",
          "todo",
          "files",
          "git",
          "resources",
          "info",
          "tools",
        ]),
    })
    // `{}` rather than a restatement: every field above has its own
    // default, so this defers to them. Spelling the object out again meant
    // two lists to keep in step, and the copy went stale the moment a
    // gadget was added — a user with no `tui.sidebar` key silently kept the
    // older column.
    .default({}),
  // How edit-style tool calls (Edit, Write, str_replace) render in
  // scrollback, *in addition to* the normal tool row inside the tools
  // block.
  //   "none" — nothing extra; the collapsed tool row is the only signal.
  //   "edit" (default) — a one-line scrollback mark naming the file
  //     that was touched, so the user can scroll back and see which
  //     files moved without expanding the tools block. Suppressed on
  //     tool-only turns (no agent prose) since the marks would only
  //     duplicate the still-visible tool rows.
  //   "diff" — same mark plus a syntax-highlighted unified diff body,
  //     Claude Code's Update(file) look.
  // The diff payload is extracted from the ACP wire (content[]
  // type:"diff" entries, falling back to rawInput shapes), so any agent
  // that emits one of those shapes gets the treatment.
  showFileUpdates: z.enum(["none", "edit", "diff"]).default("edit"),
  // Columns shown in the `sessions list` output and the TUI picker, in
  // the given order — so this controls both which columns appear and
  // their left-to-right order. Valid names: session, upstream, host,
  // state, agent, model, age, cwd, title, cost. Omit to use the built-in
  // default (session, state, agent, age, cwd, title, cost — UPSTREAM,
  // HOST, and MODEL hidden). The CLI's `--columns` flag overrides this
  // per-invocation. Duplicate or unknown names are rejected.
  sessionColumns: z
    .array(
      z.enum([
        "session",
        "upstream",
        "host",
        "state",
        "agent",
        "model",
        "age",
        "cwd",
        "title",
        "cost",
      ]),
    )
    .nonempty()
    .optional(),
  // User-defined key bindings that spawn an external command. Keyed by
  // the KeyName from src/tui/input.ts (e.g. "ctrl-x", "ctrl-underscore").
  // The command runs detached with stdio ignored — fire-and-forget.
  // Substitutions in string/array args: %s session id, %c cwd, %a agent
  // id, %u daemon base URL, %t token-file path, %% literal %. The same
  // values are also exported as HYDRA_SESSION_ID / HYDRA_CWD /
  // HYDRA_AGENT / HYDRA_BASE_URL / HYDRA_TOKEN_FILE. Keys that collide
  // with a hotkey the TUI already binds (ctrl-c, ctrl-r, ctrl-p, …) are
  // pre-empted by that binding — set your hotkey to one of the unbound
  // keys (ctrl-x, ctrl-y, ctrl-underscore). Example:
  //   { "ctrl-x": { "command": "/home/me/bin/hydra-to-emacs.sh %s" } }
  hotkeys: z
    .record(
      TUI_HOTKEY_KEY_NAMES,
      z.object({
        command: z.union([z.string(), z.array(z.string())]),
      }),
    )
    .default({}),
  // Colour theme. Either the name of a built-in ("terminal", "dracula",
  // "nord", "gruvbox-dark", "solarized-light") or of a file in
  // ~/.hydra-acp/themes/<name>.json, or an inline object:
  //   { "extends": "nord", "palette": { "red": "#ff5555" } }
  //
  // Validated loosely here and strictly in src/tui/theme: core/ must not import
  // from tui/, and the token and role vocabularies live there. Same compromise
  // `hotkeys` makes with KeyName.
  //
  // Not in computeConfigDigest — that excludes the whole `tui` section — so
  // recolouring never trips the "config changed since daemon started" warning.
  theme: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  // Your terminal's actual background: "dark", "light", or a colour.
  //
  // Only affects the background bands (the user-turn stripe, code blocks, hover
  // tints) — nothing paints a full-screen background. A theme's own `bg` states
  // what it was DESIGNED for, so a light theme on a dark terminal derives pale
  // bands that read as white blocks. This is how you say which you actually
  // have.
  //
  // Usually unnecessary now: unset, the terminal is asked directly with OSC 11 at
  // startup, and most terminals answer (including through tmux). Set this only to
  // override an answer that is wrong — doing so also skips the query. Behind both:
  // COLORFGBG, then the theme's own claim.
  themeBackground: z.string().optional(),
});

const ExtensionName = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._-]+$/, "extension name must be filename-safe");

const ExtensionBody = z.object({
  // Optional: if omitted, the spawn command defaults to [name], so a
  // package called `hydra-acp-slack` that exposes a `hydra-acp-slack` bin
  // can be enabled with just an empty body `{}`.
  command: z.array(z.string()).default([]),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
});

export type ExtensionBody = z.infer<typeof ExtensionBody>;
export type ExtensionConfig = ExtensionBody & { name: string };

const TransformerBody = z.object({
  command: z.array(z.string()).default([]),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
});

export type TransformerBody = z.infer<typeof TransformerBody>;
export type TransformerConfig = TransformerBody & { name: string };

export const HydraConfig = z.object({
  daemon: DaemonConfig.default({}),
  registry: RegistryConfig.default({
    url: REGISTRY_URL_DEFAULT,
    ttlHours: 24,
    pinned: false,
  }),
  // User-defined agents that bypass the network registry. Keyed by agent
  // id; each is spawned via its `command`/`args` directly. Shadow registry
  // agents of the same id.
  agents: z.record(z.string(), LocalAgentConfig).default({}),
  // Per-agent pin overrides applied to registry agents (e.g. force a
  // specific npm version of opencode). Keyed by agent id.
  agentOverrides: z.record(z.string(), AgentOverrideConfig).default({}),
  defaultAgent: z.string().default("opencode"),
  // Optional per-agent default model id. When a brand-new agent process
  // is spawned (session/new path), hydra issues session/set_model with
  // the matching entry so the user lands on their preferred model from
  // the first prompt. Not applied on resurrect — those sessions keep
  // whatever the user last selected. Keys are agent ids; values are the
  // raw model id strings the agent expects (claude-acp: "claude-opus-4-7",
  // opencode: "openai/gpt-5-codex" or "ncp-anthropic/claude-opus-4-7", …).
  defaultModels: z.record(z.string(), z.string()).default({}),
  // Optional override: the agent used to produce session synopses
  // (title + structured digest) at close / picker T / `/hydra title`.
  // When set, every background synopsis spawns an ephemeral copy of
  // this agent, independent of what the session was created with.
  // Useful when one agent is cheaper / more reliable at structured
  // JSON output than the dev agent. Unset → fall back to the
  // session's own agentId.
  synopsisAgent: z.string().optional(),
  // Optional override: model id passed to session/set_model on the
  // ephemeral synopsis agent. Unset → the agent uses its default.
  synopsisModel: z.string().optional(),
  // Compaction settings for manual session summarization (triggered via
  // `/hydra compact` or `POST /v1/sessions/:id/compact`). The daemon does
  // not auto-detect when to compact — the TUI decides.
  compaction: z
    .object({
      // Optional override: agent for compaction jobs. Falls through to
      // top-level synopsisAgent when unset (which is the same agent used
      // for /hydra title regen). Useful when you want a higher-reasoning
      // model for compaction's structured output but a cheaper model for
      // title regen.
      agent: z.string().optional(),
      // Optional override: model for compaction jobs. Falls through to
      // top-level synopsisModel when unset.
      model: z.string().optional(),
      // Number of recent turns kept verbatim in the seed after compaction.
      tailK: z.number().int().nonnegative().default(20),
      // Circuit-breaker on the catch-up loop during compaction.
      maxIterations: z.number().int().positive().default(3),
      // Fraction of the model's context window at which to prompt
      // (composed with idleBeforePromptMs). Default 0.5 → prompt at
      // 50% utilization if the session has been idle long enough.
      contextFraction: z.number().min(0).max(1).default(0.5),
      // Hard-ceiling utilization at which to prompt regardless of idle
      // time. Safety net against running out of context mid-task;
      // bypasses idleBeforePromptMs entirely per the two-signal rule.
      hardCeilingFraction: z.number().min(0).max(1).default(0.85),
      // Absolute token threshold used when the model's context window
      // is unknown (modelContextWindows lookup miss). Default 200k —
      // the smallest window among models anyone currently runs. The old
      // 120k was below every one of them, so a lookup miss made the
      // fallback path read as near-full on a session that was fine.
      absoluteFallback: z.number().int().positive().default(200_000),
      // Only prompt after the session has been idle this long, on the
      // assumption that the prompt-prefix cache has expired by then and
      // compaction is free in cache terms. Skipped entirely when
      // hardCeilingFraction is crossed. Default 300_000ms (5 minutes).
      idleBeforePromptMs: z.number().int().nonnegative().default(300_000),
      // Per-model context window sizes keyed by model id. Unknown
      // models fall back to absoluteFallback.
      modelContextWindows: z.record(z.string(), z.number().int().positive()).default({}),
    })
    .default({}),
  // Where new sessions land when POST /v1/sessions omits cwd. Stored as
  // a literal string ("~", "~/dev", "$HOME/work") so the config file is
  // portable across machines; expanded via expandHome at use time.
  defaultCwd: z.string().default("~"),
  // Turn off per-turn workspace snapshots for isolated sessions.
  //
  // Each snapshot walks the workspace tree against a temporary index. On
  // a normal repository that is cheap; on a very large one it is not,
  // and it runs after every turn that changed a file. This is the escape
  // hatch for that case. The cost of disabling it: an isolated session
  // whose workspace is deleted can only be recovered as far as its last
  // COMMIT, since nothing else was retained.
  // Optional rather than `.default(false)` on purpose: a defaulted field
  // becomes REQUIRED in the inferred config type, which would force every
  // literal config fixture in the tree to be updated for a setting they
  // do not exercise. Absent means off.
  disableWorkspaceSnapshots: z.boolean().optional(),
  // Gzip externalized tool-content blobs at rest (tools/<sha256>.gz).
  // Default true — text diffs/output compress ~3.5x and decompression is
  // lazy (only on diff expand in references mode). Set false to write plain
  // blobs instead, as an escape hatch if gzip CPU is ever a problem; reads
  // transparently handle both, so flipping it only affects new writes.
  compressToolContent: z.boolean().default(true),
  // Cap on cold sessions shown in CLI `sessions` listing and the TUI
  // picker. Live sessions are always included; cold are sorted by
  // recency and truncated to this count. `--all` overrides in the CLI.
  sessionListColdLimit: z.number().int().nonnegative().default(20),
  extensions: z.record(ExtensionName, ExtensionBody).default({}),
  transformers: z.record(ExtensionName, TransformerBody).default({}),
  defaultTransformers: z.array(z.string()).default([]),
  // npm registry URL used when installing npm-distributed agents into
  // ~/.hydra-acp/agents. Overrides the global ~/.npmrc registry so a
  // corporate .npmrc pointing at an internal registry doesn't break
  // public-package installs. Omit to let npm use its own defaults.
  npmRegistry: z.string().url().optional(),
  // Same reasoning as tui.sidebar's default: every field of TuiConfig has
  // its own default, so restating them here only creates a second copy to
  // forget to update.
  tui: TuiConfig.default({}),
});

export type HydraConfig = z.infer<typeof HydraConfig>;

export type CompactionConfig = z.infer<typeof HydraConfig>["compaction"];

// Resolve the effective in-app selection setting. When the user has
// explicitly set tui.inAppSelection, honor it. Otherwise default to
// the value of tui.mouse so selection is on with mouse capture (the
// natural pairing) and off without it (so native terminal selection
// keeps working).
export function resolveInAppSelection(config: HydraConfig): boolean {
  return config.tui.inAppSelection ?? config.tui.mouse;
}

export function extensionList(config: HydraConfig): ExtensionConfig[] {
  return Object.entries(config.extensions).map(([name, body]) => ({
    name,
    ...body,
  }));
}

export function transformerList(config: HydraConfig): TransformerConfig[] {
  return Object.entries(config.transformers).map(([name, body]) => ({
    name,
    ...body,
  }));
}

// Read config.json from disk and return its parsed object, or `{}` if
// the file is missing, empty, or corrupted. Genuine IO errors
// (permission, etc.) still throw.
async function readConfigFile(): Promise<Record<string, unknown>> {
  await assertConfigSymlinkNotBroken();
  const parsed = await readJsonSafe<Record<string, unknown>>(paths.config());
  return parsed ?? {};
}

// Guard against a config.json that is a symlink whose target is missing
// (e.g. a synced dotfile whose decrypted plaintext hasn't been regenerated
// yet). fs.readFile follows the link and reports ENOENT — indistinguishable
// from "no config exists" — so without this check readConfigFile would
// return {} and a downstream write would persist defaults *over the broken
// link*, severing it from its source. Treat a dangling link as a hard error
// instead so the user heals the link rather than silently losing config.
async function assertConfigSymlinkNotBroken(): Promise<void> {
  let lst;
  try {
    lst = await fs.lstat(paths.config());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
  if (!lst.isSymbolicLink()) {
    return;
  }
  try {
    await fs.stat(paths.config());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    const dest = await fs.readlink(paths.config()).catch(() => "<unknown>");
    throw new Error(
      `config.json at ${paths.config()} is a broken symlink (-> ${dest}); its target is missing. ` +
        `Refusing to treat this as "no config" and overwrite it. Restore the target ` +
        `(e.g. decrypt/check out your dotfiles) or remove the dangling link.`,
    );
  }
}

// One-shot heal for installs predating the auth-token split: if
// config.json carries a legacy daemon.authToken, move it to the
// service-token file and strip it from config.json. Idempotent: if no
// legacy field is present, returns without writing. Throws if BOTH
// sources hold a token, since we can't pick a winner safely.
//
// Callers that subsequently load a service token (daemon start, CLI
// commands, init, shim, TUI) should invoke this first so the legacy
// state heals before service-token lookup runs.
export async function migrateLegacyAuthToken(): Promise<void> {
  const raw = await readConfigFile();
  const daemon = raw.daemon as Record<string, unknown> | undefined;
  const legacy =
    daemon && typeof daemon.authToken === "string"
      ? daemon.authToken
      : undefined;
  if (!legacy) {
    return;
  }

  let tokenFileExists = false;
  try {
    await fs.access(paths.authToken());
    tokenFileExists = true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") {
      throw err;
    }
  }
  if (tokenFileExists) {
    throw new Error(
      `Auth token present in both ${paths.authToken()} and ${paths.config()} (daemon.authToken). ` +
        `Remove daemon.authToken from config.json to resolve.`,
    );
  }

  await writeServiceToken(legacy);
  delete daemon!.authToken;
  if (Object.keys(daemon!).length === 0) {
    delete raw.daemon;
  }
  await writeJsonAtomic(paths.config(), raw, { mode: 0o600 });
  process.stderr.write(
    `hydra-acp: migrated auth token from ${paths.config()} to ${paths.authToken()}.\n`,
  );
}

export async function loadConfig(): Promise<HydraConfig> {
  // Heal legacy layout before reading config.json so the parse sees the
  // post-migration shape rather than a stale snapshot.
  await migrateLegacyAuthToken();
  return HydraConfig.parse(await readConfigFile());
}

export async function writeConfig(config: HydraConfig): Promise<void> {
  await writeJsonAtomic(paths.config(), config, { mode: 0o600 });
}

// Mutate config.json in place without expanding it to the parsed/
// defaulted shape. Reads the raw JSON (preserving the user's minimal
// file), hands it to `mutate` for in-place edits, validates the result
// against the schema so a bad value can't corrupt the file, then writes
// it back atomically (temp + rename, mode 0o600). All raw-config writers
// — `hydra agent set`, the TUI ^O options "save", and the TUI's agent
// switch — funnel through here so every edit is a single atomic write
// that only touches the keys the caller changed.
//
// The mutation runs synchronously on a fresh raw object; callers express
// their change by setting/deleting keys on it (no return value needed).
export async function updateRawConfig(
  mutate: (raw: Record<string, unknown>) => void,
): Promise<void> {
  // Heal legacy auth-token layout first so the raw object we hand back
  // matches what loadConfig would see (no orphan daemon.authToken).
  await migrateLegacyAuthToken();
  const raw = await readConfigFile();
  mutate(raw);
  // Validate the mutated shape; throws before any write if it's invalid.
  HydraConfig.parse(raw);
  await writeJsonAtomic(paths.config(), raw, { mode: 0o600 });
}

// Convenience over updateRawConfig for the common case of persisting a
// single tui.<key> value (TUI ^O options "save").
export async function setTuiConfigValue<K extends keyof HydraConfig["tui"]>(
  key: K,
  value: HydraConfig["tui"][K],
): Promise<void> {
  await updateRawConfig((raw) => {
    const tui =
      raw.tui && typeof raw.tui === "object" && !Array.isArray(raw.tui)
        ? (raw.tui as Record<string, unknown>)
        : {};
    tui[key as string] = value;
    raw.tui = tui;
  });
}

// Persist ONLY tui.sidebar.enabled, leaving every sibling key exactly as it
// is on disk — present or absent.
//
// Not setTuiConfigValue("sidebar", {...config.tui.sidebar, enabled}): that
// writes the RESOLVED object, so saving the visibility toggle also stamps
// `border` and the full `gadgets` array into the file at whatever today's
// defaults happen to be. The user then stops tracking the defaults they
// never chose to pin — a newly added built-in gadget would never appear for
// them, because their config lists the nine that existed when they last
// pressed `s` on an unrelated row.
export async function setTuiSidebarEnabled(enabled: boolean): Promise<void> {
  await updateRawConfig((raw) => {
    const tui =
      raw.tui && typeof raw.tui === "object" && !Array.isArray(raw.tui)
        ? (raw.tui as Record<string, unknown>)
        : {};
    const sidebar =
      tui.sidebar && typeof tui.sidebar === "object" && !Array.isArray(tui.sidebar)
        ? (tui.sidebar as Record<string, unknown>)
        : {};
    sidebar.enabled = enabled;
    tui.sidebar = sidebar;
    raw.tui = tui;
  });
}

// Convenience over updateRawConfig for persisting the default agent and
// optionally its default model in one atomic write. Used by `hydra agent
// set` and the TUI agent switch. Pass model=undefined to set only the
// agent; pass a model to also record it under defaultModels[agent].
export async function setDefaultAgent(agentId: string): Promise<void> {
  await updateRawConfig((raw) => {
    raw.defaultAgent = agentId;
  });
}

// Set the default model for a specific agent without touching the
// top-level defaultAgent. Used by `hydra agent set <agent> <model>`.
export async function setDefaultModelForAgent(
  agentId: string,
  modelId: string,
): Promise<void> {
  await updateRawConfig((raw) => {
    const models =
      raw.defaultModels && typeof raw.defaultModels === "object"
        ? (raw.defaultModels as Record<string, unknown>)
        : {};
    models[agentId] = modelId;
    raw.defaultModels = models;
  });
}

// Pin a registry agent to a specific npm package spec (e.g.
// "opencode-ai@0.5.12"). Pass packageSpec=undefined to clear the pin.
// Used by `hydra agent pin`.
export async function setAgentOverride(
  agentId: string,
  packageSpec: string | undefined,
): Promise<void> {
  await updateRawConfig((raw) => {
    const overrides =
      raw.agentOverrides && typeof raw.agentOverrides === "object"
        ? (raw.agentOverrides as Record<string, unknown>)
        : {};
    if (packageSpec === undefined) {
      delete overrides[agentId];
    } else {
      overrides[agentId] = { packageSpec };
    }
    raw.agentOverrides = overrides;
  });
}

// Define (or update) a local agent that bypasses the registry. Pass
// def=undefined to remove it. Used by `hydra agent local`.
export async function setLocalAgent(
  agentId: string,
  def: LocalAgentConfig | undefined,
): Promise<void> {
  await updateRawConfig((raw) => {
    const agents =
      raw.agents && typeof raw.agents === "object"
        ? (raw.agents as Record<string, unknown>)
        : {};
    if (def === undefined) {
      delete agents[agentId];
    } else {
      agents[agentId] = def;
    }
    raw.agents = agents;
  });
}

// Toggle registry pinning (freeze on the on-disk cache). Used by
// `hydra registry pin` / `hydra registry unpin`.
export async function setRegistryPinned(pinned: boolean): Promise<void> {
  await updateRawConfig((raw) => {
    const registry =
      raw.registry && typeof raw.registry === "object"
        ? (raw.registry as Record<string, unknown>)
        : {};
    registry.pinned = pinned;
    raw.registry = registry;
  });
}

// True when the user has explicitly recorded a defaultAgent in
// config.json. The parsed HydraConfig always carries the schema default
// ("opencode"), which masks "never chosen" — so detecting first-launch
// requires reading the raw file. Used by the TUI to decide whether to
// surface the agent picker on a new session.
export async function hasConfiguredDefaultAgent(): Promise<boolean> {
  const raw = await readConfigFile();
  return typeof raw.defaultAgent === "string" && raw.defaultAgent.length > 0;
}

export function defaultConfig(): HydraConfig {
  return HydraConfig.parse({});
}

// Expand a leading "~", "~/...", "$HOME", or "$HOME/..." to the current
// user's home directory. Other paths pass through unchanged. Used so
// defaultCwd in the config can be portable across linux ("/home/x")
// and mac ("/Users/x") machines.
export function expandHome(p: string): string {
  if (p === "~" || p === "$HOME") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return homedir() + p.slice(1);
  }
  if (p.startsWith("$HOME/")) {
    return homedir() + p.slice("$HOME".length);
  }
  return p;
}
