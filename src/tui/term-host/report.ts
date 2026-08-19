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
import { restoreTabLabel, syncTabLabel, TRANSIENT_TAB_LABEL } from "./label-sync.js";
import type { AgentActivity, TerminalHostSnapshot, TurnOrigin } from "./types.js";

/**
 * Tab label shown while the picker is up.
 *
 * Names the pane's actual contents rather than the session it came from:
 * what's in the tab is hydra, not any particular session.
 */

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

/**
 * One turn's provenance, pushed as the turn STARTS.
 *
 * Not derived from either funnel: the banner knows a turn is running but not
 * whose it is, and by the time it goes quiet the daemon has told us nothing
 * about who started what just ended. The three call sites that begin a turn
 * each know their own answer, so this is pushed from there.
 */
export interface TurnView {
  origin: TurnOrigin | null;
  label?: string | null | undefined;
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
  // Provenance of the most recent turn. Outlives the turn deliberately; see
  // TerminalHostSnapshot.turnOrigin.
  turnOrigin: TurnOrigin | null;
  turnLabel: string | null;
  // True while the TUI isn't presenting a session — the picker is up, or the
  // screen is otherwise stopped. See setReportSuspended.
  suspended: boolean;
} = { permission: false, turnOrigin: null, turnLabel: null, suspended: false };

// What we last handed to the adapter. The banner funnel fires at 1Hz while a
// turn runs (the elapsed clock), so without this we'd call report() every
// second with an identical snapshot.
let sent: string | null = null;

// How long a session that has stopped being reachable keeps reporting the
// state it was last in before it degrades to `unknown`.
//
// Sized to cover a `hydra daemon restart`: ResilientWsStream's backoff caps
// at 5s (BACKOFF_MAX_MS), so a restart that comes back at all comes back
// well inside this. A daemon that is genuinely gone degrades to `unknown`
// one window later, which is the honest answer, just deferred.
const UNREACHABLE_HOLD_MS = 10_000;

// Statuses that mean "this session isn't reachable right now" as opposed to
// "there is no agent here". Exactly the set deriveState would otherwise map
// straight to `unknown`; an unrecognized status is not in here on purpose,
// since that's a bug rather than a known transient.
const UNREACHABLE_STATUSES = new Set(["disconnected", "cold"]);

// The state to keep reporting while unreachable, and the timer that gives up
// on it. Null when we're not holding.
//
// WHY THIS EXISTS: herdr treats `unknown → idle` as a COMPLETION when the
// agent label is unchanged across it (is_completion_transition_parts in
// herdr's app/actions.rs), which marks the pane unseen — the blue dot — and
// fires a notification. A daemon restart reports idle → unknown → idle with
// hydra's constant agent label on every frame, so it lands in that condition
// exactly and claims the session finished something. Nothing finished; the
// socket blinked. Holding the last state means herdr never sees the round
// trip: same state before and after, so the snapshot doesn't change, so no
// frame is sent at all.
//
// herdr's rule is a recovery inference meant for screen-scraped agents that
// lost the thread and later saw a prompt box again. It shouldn't apply to a
// hook-authoritative source like hydra, which reports every transition
// explicitly — but declining to emit the transition is the half we own.
let heldState: AgentActivity | null = null;
let holdTimer: ReturnType<typeof setTimeout> | null = null;

function beginHold(state: AgentActivity): void {
  // Nothing to preserve: holding `unknown` in place of `unknown` would only
  // buy a pointless timer.
  if (state === "unknown" || holdTimer !== null) {
    return;
  }
  heldState = state;
  holdTimer = setTimeout(() => {
    holdTimer = null;
    heldState = null;
    flush();
  }, UNREACHABLE_HOLD_MS);
  // The TUI exit path awaits releaseTerminalHost, and a pending hold must
  // not be what keeps the process alive past it.
  holdTimer.unref?.();
}

function endHold(): void {
  if (holdTimer !== null) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
  heldState = null;
}

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
      // Held state while the hold is live; see heldState.
      return heldState ?? "unknown";
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
    turnOrigin: live.turnOrigin,
    turnLabel: live.turnLabel,
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
    syncTabLabel(TRANSIENT_TAB_LABEL, { transient: true });
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
  // Turn provenance is the one field that survives its own turn, so it is
  // also the one field a session switch can strand: the new session's first
  // report would otherwise be stamped with who started a turn in the session
  // we just left. Nothing else needs this because everything else arrives in
  // the patch itself, per the "assign, don't merge" note above.
  if (view.sessionId !== live.sessionId) {
    live.turnOrigin = null;
    live.turnLabel = null;
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
  // Arm or disarm the unreachable hold on the TRANSITION, reading the state
  // from the outgoing status: once live.status is overwritten the pre-outage
  // state is gone. Re-entering an already-held status must not re-arm, or a
  // disconnect hook that fires twice would extend the window indefinitely.
  const wasUnreachable = UNREACHABLE_STATUSES.has(live.status ?? "");
  const nowUnreachable = UNREACHABLE_STATUSES.has(view.status ?? "");
  if (nowUnreachable && !wasUnreachable) {
    beginHold(deriveState());
  } else if (!nowUnreachable) {
    endHold();
  }
  live.status = view.status;
  live.queued = view.queued;
  flush();
}

/**
 * Tap for the start of a turn — who caused it.
 *
 * Called on every turn START and never on an end, which is what makes the
 * value outlive the turn. A `null` origin is a real value here: it means a
 * turn we adopted rather than saw begin (post-reconnect reconcile), where the
 * daemon tells us a turn is running but not whose it is.
 *
 * DELIBERATELY DOES NOT FLUSH, the only tap that doesn't. A turn's origin is
 * only meaningful next to a state, and at the moment it arrives the banner
 * has not moved yet — `live.status` still says whatever it said before the
 * turn began. Flushing here would emit a frame pairing the NEW origin with
 * the OLD state, and the banner's own flush would follow a beat later with
 * the pair we actually meant. Two frames, the first of them a fiction.
 *
 * So provenance annotates the reports that state changes already produce
 * rather than producing any of its own. What guarantees it gets out promptly:
 * a turn beginning always moves the banner (adjustPendingTurns' 0 -> >0 edge
 * sets `busy` in the same synchronous block), and a turn beginning while the
 * session is ALREADY busy is covered by the elapsed clock's 1Hz banner tick,
 * which runs for exactly as long as a turn is in flight. The bounded cost is
 * that a second turn starting and the first completing inside the same second
 * can leave the completion carrying the earlier turn's origin — which is
 * arguably the more accurate answer for the turn that just ended anyway.
 */
export function reportTurn(view: TurnView): void {
  if (!terminalHost()) {
    return;
  }
  live.turnOrigin = view.origin;
  live.turnLabel = view.label ?? null;
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
  syncTabLabel(TRANSIENT_TAB_LABEL, { transient: true });
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
  endHold();
  if (sent === null) {
    return;
  }
  sent = null;
  live.sessionId = undefined;
  live.turnOrigin = null;
  live.turnLabel = null;
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
  live.turnOrigin = null;
  live.turnLabel = null;
  live.suspended = false;
  sent = null;
  endHold();
}
