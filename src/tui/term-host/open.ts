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

import { terminalHost } from "./index.js";
import { tabLabelOwnershipEnv } from "./label-sync.js";
import type { OpenTabResult } from "./types.js";

/** Whether the active host can open a new tab at all. */
export function canOpenTab(): boolean {
  const host = terminalHost();
  return !!host && host.caps.openTab && !!host.openTab;
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

const PROMPT_LABEL_MAX = 40;

/**
 * A tab label derived from a prompt: first line, truncated.
 *
 * Only the first line, because a pasted multi-line prompt would otherwise put
 * newlines in a tab label. Truncated because tab bars are narrow and hosts
 * render whatever they're given.
 */
export function labelForPrompt(prompt: string | undefined): string {
  const first = prompt?.split("\n")[0]?.trim();
  if (!first) {
    return "new session";
  }
  return first.length > PROMPT_LABEL_MAX
    ? `${first.slice(0, PROMPT_LABEL_MAX - 1)}…`
    : first;
}

export interface OpenExistingSpec {
  kind: "attach";
  sessionId: string;
  /** Session title, used as the tab label. Falls back to the session id. */
  title?: string | undefined;
  /** Session cwd, so the pane (and anything split off it) starts there. */
  cwd?: string | undefined;
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
    return {
      label: spec.title?.trim() || spec.sessionId,
      args: ["--session", spec.sessionId],
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
