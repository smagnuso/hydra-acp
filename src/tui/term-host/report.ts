// Turn the TUI's state funnels into TerminalHost snapshots.
//
// Backend-independent: merge what the funnels say, derive a semantic
// snapshot, diff it against the last one sent, and only then call the
// adapter. Everything about *how* a snapshot reaches a host lives in the
// adapter.
//
// ---------------------------------------------------------------------
// WHERE THIS IS DRIVEN FROM
//
// Two Screen funnels, both omnipresent and both already in the business of
// exporting state to the outside world:
//
//   setSessionbar  → identity: sessionId, agent, title, model, cost.
//                    Already calls syncWindowTitle() (OSC 2).
//   setBanner      → activity: busy/ready/cancelling/…, queue depth.
//                    Already calls writeProgressIndicator() (OSC 9;4).
//
// plus setPermissionPrompt for the blocked state, which neither of the other
// two carries.
//
// The sidebar snapshot deliberately is NOT a source here even though it looks
// like a richer one: sidebar updates are gadget-gated (app.ts skips the git
// and resources pushes entirely when those gadgets aren't configured), so a
// user with a trimmed or hidden sidebar would get partial reports. The
// session bar and banner are always maintained.
//
// Because these are funnels rather than edges, session switching needs no
// special handling: the TUI switches sessions by returning from runSession
// and re-entering the `while (nextOpts !== null)` loop, which re-seeds the
// session bar and banner for the new session, which lands here.
// ---------------------------------------------------------------------

import * as path from "node:path";
import { terminalHost } from "./index.js";
import { restoreTabLabel, syncTabLabel } from "./label-sync.js";
import type { AgentActivity, TerminalHostSnapshot } from "./types.js";

/**
 * Tab label shown while the picker is up.
 *
 * Names the pane's actual contents rather than the session it came from:
 * what's in the tab is hydra, not any particular session.
 */
const SUSPENDED_TAB_LABEL = "hydra";

/** Mirrors the subset of Screen's SessionbarState we report on. */
export interface SessionbarView {
  sessionId?: string | undefined;
  agent?: string | undefined;
  title?: string | undefined;
  model?: string | undefined;
  costAmount?: number | undefined;
  /**
   * The SESSION's cwd, which is not the pane process's cwd.
   *
   * A host derives everything it knows about our directory from the TUI
   * process, and switching sessions doesn't chdir that process — the
   * session's directory lives in the daemon. So a host's own cwd displays
   * are pinned to wherever `hydra` was launched and can never follow a
   * switch. Reporting it explicitly is the only way a pane can show the
   * session's directory.
   */
  cwd?: string | undefined;
}

/** Mirrors the subset of Screen's BannerState we report on. */
export interface BannerView {
  status?: string | undefined;
  queued?: number | undefined;
}

// Merged view of everything the funnels have told us. Partial by nature:
// each funnel patches its own fields.
const live: {
  sessionId?: string | undefined;
  agent?: string | undefined;
  title?: string | undefined;
  model?: string | undefined;
  costAmount?: number | undefined;
  cwd?: string | undefined;
  status?: string | undefined;
  queued?: number | undefined;
  permission: boolean;
  // True while the TUI isn't presenting a session — the picker is up, or the
  // screen is otherwise stopped. See setReportSuspended.
  suspended: boolean;
} = { permission: false, suspended: false };

// What we last handed to the adapter. The banner funnel fires at 1Hz while a
// turn runs (the elapsed clock), so without this we'd call report() every
// second with an identical snapshot.
let sent: string | null = null;

/**
 * Map hydra's banner status onto a semantic activity.
 *
 * A pending permission wins over everything: it's the thing the user has to
 * act on, and `blocked` is what makes a host's UI demand attention.
 */
function deriveState(): AgentActivity {
  // No suspended case here: while the picker is up the pane is released
  // outright (see suspendReport) rather than reported as `unknown`, so
  // this is only ever reached for a pane actually showing a session.
  if (live.permission) {
    return "blocked";
  }
  switch (live.status) {
    case "busy":
    case "cancelling":
      return "working";
    case "ready":
      return "idle";
    case "disconnected":
    case "cold":
      return "unknown";
    default:
      return "unknown";
  }
}

function formatCost(amount: number | undefined): string | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  return `$${amount.toFixed(2)}`;
}

function cwdLabel(): string | null {
  const cwd = live.cwd?.trim();
  if (!cwd) {
    return null;
  }
  return path.basename(cwd) || cwd;
}

/**
 * Prefer the session's own label; fall back to its directory.
 *
 * Reporting no title at all instead would let a host fall back to a label it
 * derives from the PANE's cwd, which is wherever `hydra` was launched and
 * never changes on a session switch — so an untitled session in another repo
 * would keep showing the launch directory's name.
 */
function resolveTitle(): string | null {
  return live.title?.trim() || cwdLabel();
}

function snapshot(): TerminalHostSnapshot {
  return {
    state: deriveState(),
    sessionId: live.sessionId ?? null,
    title: resolveTitle(),
    cwd: live.cwd?.trim() || null,
    agent: live.agent ?? null,
    model: live.model ?? null,
    cost: formatCost(live.costAmount),
    queued: live.queued ?? null,
  };
}

// Emit only what actually changed. Called after every funnel patch.
function flush(): void {
  const host = terminalHost();
  // Don't claim the pane until we know which session we're showing —
  // otherwise a banner tick during startup would register a titleless agent
  // on the pane.
  if (!host || !live.sessionId) {
    return;
  }

  // The tab label follows the same title but on its own request/response
  // path, so it's driven from here rather than from the sessionbar tap: this
  // way it inherits the opt-in gate that keeps the test suite from renaming
  // a developer's real tab.
  //
  // While the picker is up, leaving the session's name on the tab reads from
  // the tab bar as "still in that session" — the same misreading deriveState
  // avoids one field up. Marked transient so it can never be what the tab is
  // left holding on exit.
  if (live.suspended) {
    syncTabLabel(SUSPENDED_TAB_LABEL, { transient: true });
  } else {
    syncTabLabel(resolveTitle());
  }

  // Suspended panes have already been released — see suspendReport. The
  // banner funnel keeps ticking at 1Hz while the picker is up, so without
  // this the next tick would re-claim the pane we just gave back.
  if (live.suspended) {
    return;
  }

  if (!host.caps.report) {
    return;
  }
  const snap = snapshot();
  const key = JSON.stringify(snap);
  if (sent === key) {
    return;
  }
  // Recorded optimistically so the 1Hz banner funnel doesn't re-send, but
  // dropped again if the adapter fails — otherwise one failed report would
  // convince us forever that the host is up to date.
  sent = key;
  void Promise.resolve(host.report(snap)).catch(() => {
    sent = null;
  });
}

// Both taps below take the CALLER'S ALREADY-MERGED state, not a patch.
// Screen.setSessionbar/setBanner each do `{...this.state, ...patch}` and then
// hand us the whole thing, so we assign every field unconditionally.
//
// Merging again here — e.g. skipping fields that arrive `undefined` — would
// silently retain the previous session's model or cost across a switch, since
// a session with no model yet legitimately reports `model: undefined`.
// Assign, don't merge.

/** Tap for Screen.setSessionbar — identity, title, model, cost. */
export function reportSessionbar(view: SessionbarView): void {
  if (!terminalHost()) {
    return;
  }
  live.sessionId = view.sessionId;
  live.agent = view.agent;
  live.title = view.title;
  live.model = view.model;
  live.costAmount = view.costAmount;
  live.cwd = view.cwd;
  flush();
}

/** Tap for Screen.setBanner — activity state and queue depth. */
export function reportBanner(view: BannerView): void {
  if (!terminalHost()) {
    return;
  }
  live.status = view.status;
  live.queued = view.queued;
  flush();
}

/** Mark the reporter suspended (picker up / screen stopped) or live again. */
export function setReportSuspended(suspended: boolean): void {
  if (!terminalHost() || live.suspended === suspended) {
    return;
  }
  live.suspended = suspended;
  if (suspended) {
    suspendReport();
    return;
  }
  // Force a full re-report rather than relying on the resume path to
  // re-seed the funnels. Returning from the picker to the SAME session
  // need not push a fresh sessionbar, and `live` still holds everything,
  // so dropping the dedupe key is enough to re-claim the pane.
  sent = null;
  flush();
}

/**
 * Give the pane back to the host while the picker is up.
 *
 * A pane showing a picker is not showing a session, so it should not be
 * an agent: it drops out of herdr's Agent panel entirely rather than
 * lingering as an `unknown` row, and stops advertising a session id that
 * external tooling would otherwise act on — `herdr-hardcopy.sh` would
 * happily fetch a transcript for whatever session was up before.
 *
 * `live` is deliberately NOT cleared. The session data has to survive so
 * that cancelling the picker can re-report it verbatim.
 *
 * Releasing does not clear published metadata on its own — herdr's
 * `release_agent` drops the agent label and leaves tokens and title
 * behind — so a host's release() has to null its own token set. Both
 * ours do.
 */
function suspendReport(): void {
  const host = terminalHost();
  if (!host) {
    return;
  }
  syncTabLabel(SUSPENDED_TAB_LABEL, { transient: true });
  if (sent === null) {
    return;
  }
  sent = null;
  if (!host.caps.report) {
    return;
  }
  void Promise.resolve(host.release()).catch(() => {
    // Best-effort, exactly like report(). A failed release leaves a stale
    // agent row until the next successful report replaces it.
  });
}

/** Tap for Screen.setPermissionPrompt — the blocked state. */
export function reportPermission(active: boolean): void {
  if (!terminalHost()) {
    return;
  }
  live.permission = active;
  flush();
}

/**
 * Withdraw everything on TUI exit.
 *
 * Not cosmetic: a hydra pane has no screen-scrape fallback in any host we
 * know of, so a `working` left behind by an un-torn-down TUI would sit there
 * forever with nothing able to correct it.
 *
 * Awaited, unlike every other report, because this runs from the exit path
 * and an un-awaited write would race process teardown.
 */
export async function releaseTerminalHost(): Promise<void> {
  const host = terminalHost();
  if (!host) {
    return;
  }
  // Label first: it must not be left holding a transient value, and the
  // release below may drop the authority it hangs off.
  await restoreTabLabel();
  if (sent === null) {
    return;
  }
  sent = null;
  live.sessionId = undefined;
  try {
    await host.release();
  } catch {
    // Best-effort on the way out.
  }
}

/** Test-only: reset module state between specs. */
export function __resetReportForTests(): void {
  live.sessionId = undefined;
  live.agent = undefined;
  live.title = undefined;
  live.model = undefined;
  live.costAmount = undefined;
  live.cwd = undefined;
  live.status = undefined;
  live.queued = undefined;
  live.permission = false;
  live.suspended = false;
  sent = null;
}
