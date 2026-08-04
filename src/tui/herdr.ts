// Report the currently-viewed hydra session to herdr (https://herdr.dev),
// the agent-oriented terminal multiplexer, so its sidebar shows accurate
// per-session state: working / blocked / idle, plus the session title and
// display tokens for the underlying agent, model, cost, and queue depth.
//
// This needs NO herdr-side install — no `herdr integration install`, no
// plugin manifest. herdr's own integrations are compiled into its binary
// (`include_str!`) and its "full lifecycle authority" allowlist is a
// hardcoded match on (source, agent_label) pairs, but neither gates us:
//
//   * `pane.report_agent` accepts an arbitrary `source` and an arbitrary
//     `agent` label from any socket client, and herdr's
//     `effective_agent_label()` returns that label verbatim. A pane
//     becomes an "agent pane" purely because a label is present.
//   * The allowlist only decides whether herdr SUPPRESSES its
//     screen-scraping detector. We never need suppression: the pane runs
//     `hydra`, which isn't a recognized agent binary, so herdr's detector
//     finds nothing and has nothing to say. No competing authority.
//
// Reporting `agent: "hydra"` (rather than the underlying agent kind) is
// deliberate. herdr's `parse_agent_label("hydra")` returns None, which
// makes the pane permanently ineligible for herdr's own
// `resume_agents_on_restore` path. That matters: the agent process is
// owned by the hydra daemon, not by the pane, so if herdr believed it
// owned a resumable `claude` here it would relaunch a second one
// alongside the daemon's on restart. The underlying agent kind is still
// visible to the user as the `$kind` token.
//
// Everything here is best-effort. herdr not running, socket gone,
// half-written frame — all swallowed. Nothing about reporting is allowed
// to affect the TUI.
//
// ---------------------------------------------------------------------
// WHERE THIS IS DRIVEN FROM
//
// Two Screen funnels, both omnipresent and both already in the business
// of exporting state to the outside world:
//
//   setSessionbar  → identity: sessionId, agent, title, model, cost.
//                    Already calls syncWindowTitle() (OSC 2).
//   setBanner      → activity: busy/ready/cancelling/…, queue depth.
//                    Already calls writeProgressIndicator() (OSC 9;4).
//
// plus setPermissionPrompt for the blocked state, which neither of the
// other two carries.
//
// The sidebar snapshot deliberately is NOT a source here even though it
// looks like a richer one: sidebar updates are gadget-gated (app.ts skips
// the git and resources pushes entirely when those gadgets aren't
// configured), so a user with a trimmed or hidden sidebar would get
// partial reports. The session bar and banner are always maintained.
//
// Because these are funnels rather than edges, session switching needs no
// special handling: the TUI switches sessions by returning from
// runSession and re-entering the `while (nextOpts !== null)` loop, which
// re-seeds the session bar and banner for the new session, which lands
// here.
// ---------------------------------------------------------------------
// TWO HERDR BEHAVIOURS DRIVE THE SHAPE OF THIS MODULE
//
// 1. `seq` is a one-way door, per (pane, source). herdr's
//    `accept_hook_report` treats an absent `seq` as acceptable ONLY if
//    that source has never sent a numbered one:
//
//        let Some(seq) = seq else {
//            return !self.hook_report_sequences.contains_key(source);
//        };
//
//    So once we send seq=1, every later call from source "hydra" —
//    including the teardown release — MUST carry a strictly greater seq
//    or it is silently discarded. Worse, `pane.release_agent` and
//    `pane.clear_agent_authority` return `{"type":"ok"}` *before* the
//    internal event is processed, so a dropped report still looks like
//    success. Hence: one module-level counter, monotonic for the life of
//    the process, never reset on session switch.
//
// 2. Token maps are per-key PATCHES, not replacements. herdr: "A string
//    sets a key, JSON null clears it, and omitted keys remain
//    unchanged." Omitting a key on a session switch would leave the
//    previous session's value on the pane, silently misattributed. So
//    every metadata report sends the COMPLETE token key set, with
//    explicit nulls for absent values. TOKEN_KEYS is that set; keep it
//    small (herdr caps a report at 16 keys and a pane at 32).
// ---------------------------------------------------------------------

import * as net from "node:net";
import * as path from "node:path";
import { restoreHerdrTabLabel, syncHerdrTabLabel } from "./herdr-tab-label.js";

const SOURCE = "hydra";
// See the header: intentionally not the underlying agent kind.
const AGENT_LABEL = "hydra";

// The complete set of tokens this module owns. Every metadata report
// sends all of them so a session switch can't leak stale values.
const TOKEN_KEYS = ["kind", "cwd", "model", "cost", "queue"] as const;
type TokenKey = (typeof TOKEN_KEYS)[number];
type Tokens = Record<TokenKey, string | null>;

export type HerdrAgentState = "idle" | "working" | "blocked" | "unknown";

/** Mirrors the subset of Screen's SessionbarState we report on. */
export interface HerdrSessionbar {
  sessionId?: string | undefined;
  agent?: string | undefined;
  title?: string | undefined;
  model?: string | undefined;
  costAmount?: number | undefined;
  /**
   * The SESSION's cwd, which is not the pane process's cwd.
   *
   * herdr derives every label it owns (Space label, pane `cwd`,
   * `foreground_cwd`) from the hydra TUI process, and switching sessions
   * doesn't chdir that process — the session's directory lives in the
   * daemon. So herdr's own cwd displays are pinned to wherever `hydra`
   * was launched and can never follow a switch. Reporting it explicitly
   * is the only way a pane can show the session's directory.
   */
  cwd?: string | undefined;
}

/** Mirrors the subset of Screen's BannerState we report on. */
export interface HerdrBanner {
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
  // True while the TUI isn't presenting a session — the picker is up, or
  // the screen is otherwise stopped. See setHerdrSuspended.
  suspended: boolean;
} = { permission: false, suspended: false };

// What we last actually put on the wire. The banner funnel fires at 1Hz
// while a turn runs (the elapsed clock), so without this we would open a
// socket every second to resend an identical report.
let sent: { state: HerdrAgentState; title: string | null; tokens: string } | null = null;

// Monotonic and — critically — seeded from the wall clock rather than
// from zero, scaled by 1000.
//
// herdr's `hook_report_sequences` lives on the pane's terminal state, not
// on our connection, so it OUTLIVES this process. A TUI that restarted in
// the same pane and began counting from 1 again would have every single
// report rejected as stale (`seq <= last_seq`) for as long as that pane
// existed, silently and with `{"type":"ok"}` responses throughout. Using
// the epoch as the base makes any later process outrank any earlier one.
//
// The *1000 scaling matters. Plain epoch-ms leaves only one unit of
// headroom per millisecond, so a process that emitted N frames reaches
// `start + N`; a restart fewer than N milliseconds later would begin
// *below* that high-water mark and be locked out. Scaling to microseconds
// gives 1000 units per millisecond, which no realistic report rate can
// outrun. This matches herdr's own integrations, which seed the same way
// (`Date.now() * 1000` in its opencode plugin, `time.time_ns()` in its
// claude hook) — for exactly this reason.
//
// Deliberately module-level and never reset within a process — see trap
// (1) in the header.
let seq = Date.now() * 1000;
function nextSeq(): number {
  seq += 1;
  return seq;
}

/**
 * herdr injects these into every managed pane process
 * (`apply_pane_launch_env`). All three are required: HERDR_ENV proves
 * we're inside herdr, and the other two are where to report and what to
 * report about. Absent → this module is inert.
 */
function resolveTarget(): { socketPath: string; paneId: string } | null {
  if (process.env.HERDR_ENV !== "1") {
    return null;
  }
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const paneId = process.env.HERDR_PANE_ID;
  if (!socketPath || !paneId) {
    return null;
  }
  return { socketPath, paneId };
}

// Reporting is OPT-IN, resolved once by initHerdrReporting() rather than
// read from the ambient environment on every call.
//
// The taps live inside Screen, so anything that constructs a Screen and
// pushes a session bar or banner would otherwise report — including the
// test suite. `screen.test.ts` alone drives those funnels 13 times, so
// running `pnpm test` from a shell inside a herdr pane used to register a
// phantom `hydra` agent on the developer's own pane, pinned at `working`
// forever: the tests never call the teardown, and a hydra pane has no
// screen-scrape fallback in herdr to correct it.
//
// Gating on an explicit init from runTuiApp means only the real TUI ever
// reports. Guarding on `process.env.VITEST` instead would have fixed the
// symptom for vitest and left the hazard in place for every other
// embedder of Screen.
let target: { socketPath: string; paneId: string } | null = null;

/**
 * Enable reporting for this process if it's running in a herdr pane.
 * Called once from runTuiApp; paired with clearHerdrSession() on exit.
 * Returns true when reporting is live, for logging/debug.
 */
export function initHerdrReporting(): boolean {
  target = resolveTarget();
  return target !== null;
}

function herdrTarget(): { socketPath: string; paneId: string } | null {
  return target;
}

export function herdrActive(): boolean {
  return target !== null;
}

// ONE REQUEST PER CONNECTION. This is not a stylistic choice: herdr
// serves exactly one request per socket and then resets the connection.
// Writing two newline-delimited frames to a single socket gets the first
// one processed, the second silently discarded, and an ECONNRESET —
// verified against herdr 0.8.0:
//
//   2 requests, 1 connection  -> 1 response, then ECONNRESET
//   1 request,  1 connection  -> 1 response
//
// That failure mode is invisible from here (we're fire-and-forget, and
// the dropped frame would have returned `ok` anyway), so it has to be
// designed around rather than detected.
//
// Frames are also serialized rather than fired in parallel, each waiting
// for its reply before the next connects. Two orderings depend on it:
// report_metadata must land after the report_agent that establishes the
// authority it hangs off, and on teardown the metadata clear must land
// before the release that drops that authority.
let chain: Promise<void> = Promise.resolve();

const WRITE_TIMEOUT_MS = 2_000;

function writeFrame(
  socketPath: string,
  frame: { method: string; params: unknown },
  id: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let payload: string;
    try {
      payload = `${JSON.stringify({ id, method: frame.method, params: frame.params })}\n`;
    } catch {
      resolve(false);
      return;
    }
    let sock: net.Socket;
    try {
      sock = net.connect(socketPath);
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.on("connect", () => sock.write(payload));
    // A reply means herdr has processed this frame, so the next one in
    // the chain is safe to send.
    sock.on("data", () => finish(true));
    sock.on("error", () => finish(false));
    sock.on("close", () => finish(false));
    sock.setTimeout(WRITE_TIMEOUT_MS, () => finish(false));
  });
}

/**
 * Queue frames for delivery, in order. Returns a promise that settles
 * once they've all been attempted — callers that need the writes to
 * actually reach herdr before the process exits (teardown) must await
 * it; everything else can ignore it.
 *
 * `onFailure` lets the caller invalidate its dedupe cache when a frame
 * doesn't land, so the next state change re-sends rather than believing
 * herdr already knows.
 */
function send(
  frames: Array<{ method: string; params: unknown }>,
  onFailure?: () => void,
): Promise<void> {
  const target = herdrTarget();
  if (!target || frames.length === 0) {
    return Promise.resolve();
  }
  const batch = frames.map((f, i) => ({ frame: f, id: `hydra-${seq}-${i}` }));
  chain = chain
    .then(async () => {
      for (const { frame, id } of batch) {
        const ok = await writeFrame(target.socketPath, frame, id);
        if (!ok) {
          onFailure?.();
          // Don't attempt the rest: the orderings this chain exists to
          // guarantee are already broken.
          return;
        }
      }
    })
    .catch(() => {
      onFailure?.();
    });
  return chain;
}

/**
 * Map hydra's banner status onto herdr's semantic state.
 *
 * A pending permission wins over everything: it's the thing the user has
 * to act on, and `blocked` is what makes herdr's sidebar row demand
 * attention and satisfies `herdr agent wait --until blocked`.
 *
 * "cancelling" stays `working` because the turn hasn't settled yet —
 * session/cancel is fire-and-forget and the agent may still be running.
 * "disconnected"/"cold" become `unknown` rather than `idle`, so a dropped
 * daemon connection doesn't read as "ready for input".
 */
function deriveState(): HerdrAgentState {
  // While the picker is up this pane isn't showing any session, so the
  // session's activity is not this pane's state. Reporting `working` here
  // sends herdr's attention machinery after a pane that will just show a
  // picker when you tab to it — and it makes `agent wait --until done`
  // resolve against a session the user has navigated away from.
  //
  // `unknown` is herdr's own term for exactly this: "an agent is present
  // but Herdr cannot classify its lifecycle confidently." It also sits
  // below every other state in herdr's rollup, so it won't pull attention.
  //
  // This mirrors writeProgressIndicator, which already declines to touch
  // the OSC 9;4 taskbar pulse while the screen is stopped.
  if (live.suspended) {
    return "unknown";
  }
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

// Always emits every key in TOKEN_KEYS — see trap (2) in the header.
function cwdLabel(): string | null {
  const cwd = live.cwd?.trim();
  if (!cwd) {
    return null;
  }
  // Basename: sidebar rows are narrow, and the full path would be
  // truncated by herdr's 80-char cap anyway.
  return path.basename(cwd) || cwd;
}

// We deliberately never set `display_agent`.
//
// herdr resolves its built-in `agent` sidebar token as
// `display_agent ?? agent_name ?? agent_label`
// (workspace/aggregate.rs:47), and `display_agent` has no token name of
// its own — it is not independently renderable. So setting it does not
// *add* information, it overrides the pane's identity slot.
//
// From herdr's point of view the agent in this pane IS hydra; which
// backing agent hydra happens to be driving is a property of the session,
// not of the pane. That detail rides along as the `kind` token next to
// `model`, where a user can opt into rendering it.
//
// Leaving it unset has a second benefit: the fallback chain reaches
// `agent_name`, so `herdr agent rename <pane> <name>` keeps working.
// Setting display_agent would silently outrank the user's own rename.
//
// clear_display_agent is still sent on every metadata report so that a
// value set by an older build is removed rather than inherited — the same
// "always send the whole set" discipline the token map uses.

function deriveTokens(): Tokens {
  return {
    kind: live.agent ?? null,
    cwd: cwdLabel(),
    model: live.model ?? null,
    cost: formatCost(live.costAmount),
    queue: live.queued && live.queued > 0 ? String(live.queued) : null,
  };
}

// Emit only what actually changed. Called after every funnel patch.
function flush(): void {
  const target = herdrTarget();
  // Don't claim the pane as an agent until we know which session we're
  // showing — otherwise a banner tick during startup would register a
  // titleless agent on the pane.
  if (!target || !live.sessionId) {
    return;
  }
  const state = deriveState();
  // Prefer the session's own label; fall back to its directory. Clearing
  // the title instead would let herdr fall back to a label it derives
  // from the PANE's cwd, which is wherever `hydra` was launched and never
  // changes on a session switch — so an untitled session in another repo
  // would keep showing the launch directory's name.
  const title = live.title?.trim() || cwdLabel();
  const tokens = deriveTokens();
  const tokensKey = JSON.stringify(tokens);

  const frames: Array<{ method: string; params: unknown }> = [];
  if (sent === null || sent.state !== state) {
    frames.push({
      method: "pane.report_agent",
      params: {
        pane_id: target.paneId,
        source: SOURCE,
        agent: AGENT_LABEL,
        state,
        seq: nextSeq(),
      },
    });
  }
  if (sent === null || sent.title !== title || sent.tokens !== tokensKey) {
    frames.push({
      method: "pane.report_metadata",
      params: {
        pane_id: target.paneId,
        source: SOURCE,
        seq: nextSeq(),
        ...(title ? { title } : { clear_title: true }),
        clear_display_agent: true,
        tokens,
      },
    });
  }
  // Tab label follows the same title, but on its own request/response
  // path. Called from here rather than from the sessionbar tap so it
  // inherits the opt-in gate above (see initHerdrReporting): the taps run
  // under the test suite, and renaming a developer's tab from `pnpm test`
  // is the same hazard as registering a phantom agent on their pane.
  syncHerdrTabLabel(title);
  if (frames.length === 0) {
    return;
  }
  // Recorded optimistically so the 1Hz banner funnel doesn't re-send,
  // but dropped again if the write fails — otherwise a single failed
  // frame would convince us forever that herdr is up to date.
  sent = { state, title, tokens: tokensKey };
  void send(frames, () => {
    sent = null;
  });
}

// Both taps below take the CALLER'S ALREADY-MERGED state, not a patch.
// Screen.setSessionbar/setBanner each do `{...this.state, ...patch}` and
// then hand us the whole thing, so we assign every field unconditionally.
//
// Merging again here — e.g. skipping fields that arrive `undefined` —
// would silently retain the previous session's model or cost across a
// switch, since a session with no model yet legitimately reports
// `model: undefined`. That is the same stale-value failure the
// full-token-set rule in trap (2) exists to prevent, just moved one layer
// up. Assign, don't merge.

/** Tap for Screen.setSessionbar — identity, title, model, cost. */
export function syncHerdrSessionbar(view: HerdrSessionbar): void {
  if (!herdrActive()) {
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
export function syncHerdrBanner(view: HerdrBanner): void {
  if (!herdrActive()) {
    return;
  }
  live.status = view.status;
  live.queued = view.queued;
  flush();
}

/**
 * Mark the reporter suspended (picker up / screen stopped) or live again.
 *
 * Suspending forces `unknown` rather than simply muting updates: muting
 * would freeze whatever was last reported, so a session that went busy just
 * before the picker opened would sit at `working` for as long as the user
 * browsed. Title and tokens are deliberately left alone so the pane stays
 * identifiable in herdr's sidebar while picking.
 */
export function setHerdrSuspended(suspended: boolean): void {
  if (!herdrActive() || live.suspended === suspended) {
    return;
  }
  live.suspended = suspended;
  flush();
}

/** Tap for Screen.setPermissionPrompt — the blocked state. */
export function syncHerdrPermission(active: boolean): void {
  if (!herdrActive()) {
    return;
  }
  live.permission = active;
  flush();
}

/**
 * Withdraw everything on TUI exit: clear the title and every token, then
 * release the agent so the pane stops rendering as one.
 *
 * Order matters — the metadata clear has to land before the release,
 * because releasing first would drop the authority the metadata hangs
 * off. Both carry a seq for the reason in trap (1); without one they are
 * accepted and discarded.
 *
 * This is not cosmetic. A hydra pane has no screen-scraping fallback
 * (herdr detects no agent in it), so a `working` left behind by an
 * un-torn-down TUI would sit there forever with nothing able to correct
 * it.
 */
export async function clearHerdrSession(): Promise<void> {
  const target = herdrTarget();
  if (!target || sent === null) {
    return;
  }
  // Before the reports, and awaited for the same reason they are. A
  // session title left on the tab bar after the TUI is gone names a tab
  // that now holds a plain shell.
  await restoreHerdrTabLabel();
  const cleared: Tokens = { kind: null, cwd: null, model: null, cost: null, queue: null };
  const flushed = send([
    {
      method: "pane.report_metadata",
      params: {
        pane_id: target.paneId,
        source: SOURCE,
        seq: nextSeq(),
        clear_title: true,
        clear_display_agent: true,
        clear_state_labels: true,
        tokens: cleared,
      },
    },
    {
      method: "pane.release_agent",
      params: {
        pane_id: target.paneId,
        source: SOURCE,
        agent: AGENT_LABEL,
        seq: nextSeq(),
      },
    },
  ]);
  sent = null;
  live.sessionId = undefined;
  // Awaited, unlike every other report: this runs from the TUI's exit
  // path, and an un-awaited write would race the process teardown. A
  // hydra pane has no screen-scrape fallback in herdr, so losing this
  // leaves the pane showing a phantom agent with nothing able to correct
  // it.
  await flushed;
}

/** Test-only: reset module state between specs. */
export function __resetHerdrForTests(): void {
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
  seq = Date.now() * 1000;
  chain = Promise.resolve();
  target = null;
}
