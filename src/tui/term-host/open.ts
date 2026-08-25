// "Open this session somewhere else" — the one place hydra DRIVES its
// terminal host rather than reporting to it.
//
// Everything here is backend-independent: which hydra binary to relaunch,
// what argv to build, what to call the tab, and handing the child its
// tab-label ownership marker. The adapter only has to spawn an argv vector
// in a new container.
//
// Why it's a natural fit rather than a hack: the hydra daemon owns the agent
// process and multi-client attach is the normal case, so "show this session
// in another pane" is what hydra is for. The host just supplies the window
// management.

import { CANDIDATES, terminalHost } from "./index.js";
import { tabLabelFor, tabLabelOwnershipEnv } from "./label-sync.js";
import type { OpenTabResult } from "./types.js";

/** Whether the active host can open a new tab at all. */
export function canOpenTab(): boolean {
  const host = terminalHost();
  return !!host && host.caps.openTab && !!host.openTab;
}

/**
 * Why `--terminal-host-launcher` can't work here, or null if it can.
 *
 * Runs at CLI time, BEFORE initTerminalHost(), so it probes the candidates'
 * detect() against the given env rather than reading the active host.
 *
 * DETECTION ONLY, not capabilities. Asking a candidate for its caps means
 * calling create(), and an adapter reads process.env in its constructor
 * rather than the env passed to detect() — so a caps probe would answer for
 * the ambient environment instead of the one being validated, which is both
 * wrong and untestable. The split is the right layering anyway: this catches
 * the mistake people actually make (passing the flag in a bare terminal),
 * and a detected host that turns out not to be able to open a tab surfaces
 * at the first pick through revealOrOpen's error, which the user sees.
 *
 * Returns a sentence fragment, so the caller supplies the prefix and the
 * whole message reads as one line.
 */
export function launcherModeUnavailable(
  env: NodeJS.ProcessEnv,
): string | null {
  for (const candidate of CANDIDATES) {
    try {
      if (candidate.detect(env)) {
        return null;
      }
    } catch {
      // A candidate that throws while probing is simply not a match, and
      // must not stop the others being tried. Same rule as initTerminalHost.
    }
  }
  return "needs a supported terminal host (herdr or tmux); this pane is in neither";
}

/** Whether the active host can jump to a pane already showing a session. */
export function canReveal(): boolean {
  const host = terminalHost();
  return !!host && host.caps.reveal && !!host.revealSession;
}

/** How a request to show a session somewhere was satisfied. */
export type RevealOrOpenOutcome = "revealed" | "opened" | "failed";

export interface RevealOrOpenResult {
  outcome: RevealOrOpenOutcome;
  /** Present when outcome is "failed"; shown to the user. */
  error?: string;
}

/**
 * Show a session in the host, reusing the pane that already has it.
 *
 * The policy, in one place, because both halves are wrong alone. Opening
 * unconditionally is how a session ends up in four tabs after four visits
 * to the picker; revealing unconditionally does nothing the first time.
 *
 * Reveal-then-open rather than the reverse: the check is one round trip and
 * the fallback is idempotent, whereas the opposite order would have to close
 * a tab it had just opened.
 *
 * A host that can't reveal goes straight to opening — the old behaviour,
 * unchanged, rather than a refusal.
 */
export async function revealOrOpen(
  spec: OpenExistingSpec,
): Promise<RevealOrOpenResult> {
  const host = terminalHost();
  if (host && host.caps.reveal && host.revealSession) {
    try {
      if (await host.revealSession(spec.sessionId)) {
        return { outcome: "revealed" };
      }
    } catch {
      // A reveal that throws is not a reason to refuse to open. Falling
      // through gets the user their session; reporting the failure would
      // surface a distinction they never asked about.
    }
  }
  const result = await openInNewTab(spec);
  return result.ok
    ? { outcome: "opened" }
    : { outcome: "failed", ...(result.error ? { error: result.error } : {}) };
}

// Entry-point basenames we're willing to relaunch. hydra ships `hydra` and
// `hydra-acp` bins, both of which resolve to dist/cli.js.
const HYDRA_ENTRY_NAMES = new Set(["cli.js", "hydra", "hydra-acp"]);

/**
 * Whether `process.argv[1]` really is hydra's entry point.
 *
 * This check is not paranoia, it is load-bearing. An earlier version passed
 * `argv[1]` through unvalidated, which is correct whenever the process is
 * hydra — but when it isn't, "launch hydra in a new tab" becomes "launch
 * whatever started me in a new tab". If that thing in turn opens a tab, the
 * result is self-replicating: each new pane re-runs the caller, which opens
 * another pane. Verified the hard way — it produced ~97 tabs before it burned
 * out.
 *
 * The blast radius is what makes this worth guarding rather than assuming. A
 * wrong-but-inert argv would just fail to start; a wrong-and-recursive one
 * takes the user's whole workspace with it.
 */
function hydraEntryPoint(): string | null {
  const entry = process.argv[1];
  if (!entry) {
    return null;
  }
  const base = entry.replace(/\\/g, "/").split("/").pop() ?? "";
  return HYDRA_ENTRY_NAMES.has(base) ? entry : null;
}

/**
 * The argv the host should launch.
 *
 * Prefers this process's own entry point so the new tab runs the same build
 * as the tab that spawned it — which matters on a linked or checked-out dev
 * build, where PATH `hydra` can be a different version. Falls back to `hydra`
 * on PATH when we can't confirm what we're running from.
 *
 * Hosts launch argv directly with no shell, so there's no quoting to get
 * wrong, and `tui` is named explicitly rather than relying on the bare-verb
 * default.
 */
function hydraArgv(args: string[]): string[] {
  const entry = hydraEntryPoint();
  const base = entry ? [process.execPath, entry] : ["hydra"];
  return [...base, "tui", ...args];
}

/**
 * Whether tabs we open should inherit launcher mode.
 *
 * Set once by runTuiApp from TuiOptions. Module state rather than a
 * parameter on every OpenSpec because it is a property of the PROCESS, not
 * of any one request: every caller would otherwise have to thread it
 * through, and the one that forgot would silently mint a tab that breaks
 * the layout's invariant — the failure this mode exists to prevent, and
 * invisible until someone pressed ^p in the wrong tab.
 */
let launcherMode = false;

/**
 * Whether the mode is off because a human said so, rather than merely
 * unasked-for. Only matters for propagation: with
 * tui.launcherModeWhenHosted set, "unasked-for" is not inherited by a child
 * — the child reads the config and turns the mode on — so an opted-out pane
 * has to say so in the argv or its tabs come up opted back in.
 */
let launcherOptOut = false;

export function setLauncherMode(on: boolean, optedOut = false): void {
  launcherMode = on;
  launcherOptOut = optedOut;
}

export function launcherModeActive(): boolean {
  return launcherMode;
}

export function __resetLauncherModeForTests(): void {
  launcherMode = false;
  launcherOptOut = false;
}

/**
 * A tab label derived from a prompt: first line, truncated.
 *
 * Shares tabLabelFor with the session-title path so both obey one cap;
 * this function only adds the empty-prompt fallback.
 */
export function labelForPrompt(prompt: string | undefined): string {
  return (prompt ? tabLabelFor(prompt) : "") || "new session";
}

export interface OpenExistingSpec {
  kind: "attach";
  sessionId: string;
  /** Session title, used as the tab label. Falls back to the session id. */
  title?: string | undefined;
  /** Session cwd, so the pane (and anything split off it) starts there. */
  cwd?: string | undefined;
  /**
   * Land the new tab's transcript on the turn open at this recordedAt
   * (epoch ms) instead of the live tail — carried from a find-picker hit's
   * PickerResult.jumpToRecordedAt. Only reaches the pane when revealOrOpen
   * actually opens a fresh one; a revealed (already-open) pane keeps
   * whatever it was already showing, since nothing about it restarts.
   */
  jumpToRecordedAt?: number | undefined;
}

export interface OpenNewSpec {
  kind: "new";
  cwd?: string | undefined;
  agentId?: string | undefined;
  model?: string | undefined;
  /** Composer text to fire as the new session's first turn. */
  prompt?: string | undefined;
}

export type OpenSpec = OpenExistingSpec | OpenNewSpec;

function buildArgs(spec: OpenSpec): { label: string; args: string[] } {
  if (spec.kind === "attach") {
    const args = ["--session", spec.sessionId];
    if (spec.jumpToRecordedAt !== undefined) {
      args.push("--jump-to-recorded-at", String(spec.jumpToRecordedAt));
    }
    return {
      // Same cap as labelForPrompt below: a session title is often the
      // user's opening message and runs to hundreds of characters.
      label: (spec.title ? tabLabelFor(spec.title) : "") || spec.sessionId,
      args,
    };
  }
  // --new is what stops the new pane from re-entering the picker (or
  // reattaching to a recent session for the cwd) and instead going straight
  // to a fresh one.
  const args = ["--new"];
  // --cwd as well as the pane cwd: the pane cwd is what the host spawns in
  // and is silently dropped when non-absolute, whereas --cwd is what hydra
  // records on the session.
  if (spec.cwd) {
    args.push("--cwd", spec.cwd);
  }
  if (spec.agentId) {
    args.push("--agent", spec.agentId);
  }
  if (spec.model) {
    args.push("--model", spec.model);
  }
  // Last, so the long free-text argument doesn't sit between flag pairs in a
  // `ps` listing.
  const prompt = spec.prompt?.trim();
  if (prompt) {
    args.push("--prompt", prompt);
  }
  return { label: labelForPrompt(prompt), args };
}

/**
 * Open a hydra session in a new tab of the active terminal host.
 *
 * The new pane inherits the host's own pane env automatically, so the hydra
 * it launches reports its own state and cwd with no extra work.
 */
export async function openInNewTab(spec: OpenSpec): Promise<OpenTabResult> {
  const host = terminalHost();
  if (!host || !host.caps.openTab || !host.openTab) {
    return { ok: false, error: "no terminal host available" };
  }
  const { label, args } = buildArgs(spec);
  // Propagate the mode, so an index-shaped workspace stays index-shaped no
  // matter which tab spawned which. Opting in at the root is the only place
  // a human should have to think about it.
  //
  // An explicit opt-out propagates too, and for the same reason: with
  // tui.launcherModeWhenHosted set, saying nothing is not saying "off" —
  // the child would read the config and turn the mode back on. Silence is
  // still right for the third case (mode off, nobody asked either way),
  // which is why this isn't just "state the mode": that would put a flag
  // after --prompt in every argv, and the prompt is deliberately last.
  if (launcherMode) {
    args.push("--terminal-host-launcher");
  } else if (launcherOptOut) {
    args.push("--no-terminal-host-launcher");
  }
  try {
    return await host.openTab({
      label,
      argv: hydraArgv(args),
      cwd: spec.cwd,
      // Tell the child the tab label is hydra's, not a human's, so it may
      // keep it in sync with the session title. Without this the label guard
      // misfires exactly where the feature matters most: the tab comes up
      // already named after the session, and the hydra in it — a different
      // process, with no memory of the call that named it — would conclude a
      // human named the tab and leave it alone forever.
      env: tabLabelOwnershipEnv(label),
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
