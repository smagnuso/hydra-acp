// herdr (https://herdr.dev) as a TerminalHost.
//
// EVERYTHING herdr-specific lives here. Core knows about snapshots, tab
// labels and capabilities; it does not know herdr exists. If this file were
// deleted, the only thing lost would be one entry in the candidate list.
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
// deliberate. herdr's `parse_agent_label("hydra")` returns None, which makes
// the pane permanently ineligible for herdr's own `resume_agents_on_restore`
// path. That matters: the agent process is owned by the hydra daemon, not by
// the pane, so if herdr believed it owned a resumable `claude` here it would
// relaunch a second one alongside the daemon's on restart. The underlying
// agent kind is still visible to the user as the `$kind` token.
//
// Everything here is best-effort. herdr not running, socket gone,
// half-written frame — all swallowed.
//
// ---------------------------------------------------------------------
// TWO HERDR BEHAVIOURS DRIVE THE SHAPE OF THIS FILE
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
//    including the teardown release — MUST carry a strictly greater seq or
//    it is silently discarded. Worse, `pane.release_agent` and
//    `pane.clear_agent_authority` return `{"type":"ok"}` *before* the
//    internal event is processed, so a dropped report still looks like
//    success. Hence: one module-level counter, monotonic for the life of
//    the process, never reset on session switch.
//
// 2. Token maps are per-key PATCHES, not replacements. herdr: "A string
//    sets a key, JSON null clears it, and omitted keys remain unchanged."
//    Omitting a key on a session switch would leave the previous session's
//    value on the pane, silently misattributed. So every metadata report
//    sends the COMPLETE token key set, with explicit nulls for absent
//    values. TOKEN_KEYS is that set; keep it small (herdr caps a report at
//    16 keys and a pane at 32).
// ---------------------------------------------------------------------

import * as net from "node:net";
import * as path from "node:path";
import type {
  OpenTabResult,
  OpenTabSpec,
  TabLabelView,
  TerminalHost,
  TerminalHostCandidate,
  TerminalHostSnapshot,
} from "./types.js";

const SOURCE = "hydra";
// See the header: intentionally not the underlying agent kind.
const AGENT_LABEL = "hydra";

// The complete set of tokens we own. Every metadata report sends all of
// them so a session switch can't leak stale values.
//
// `session` is the odd one out: the others are display values a user may
// render in a sidebar row, while `session` exists so external tooling can
// ask herdr which session a pane is attached to. It rides the token map
// because herdr's purpose-built field for this — `agent_session`, set via
// `pane.report_agent_session` — silently discards our value:
// `session_ref_from_report` gates on `is_official_agent_source`, a
// hardcoded allowlist of herdr's own 16 integrations, and returns `ok`
// while dropping the id for everyone else. Tokens have no such gate.
// If hydra is ever added to that allowlist, move `session` there and drop
// it from this set.
//
// `turn`/`turn_label` ride the token map rather than only the state report
// below because tokens are the only part of this that reads BACK: `pane.list`
// returns each pane's token map, so external tooling can ask herdr who caused
// a pane's last turn today, with no herdr-side change. Fields on
// pane.report_agent are write-only from our side — herdr drops what it
// doesn't know rather than storing it.
const TOKEN_KEYS = [
  "kind",
  "cwd",
  "model",
  "cost",
  "queue",
  "turn",
  "turn_label",
  "session",
] as const;
type TokenKey = (typeof TOKEN_KEYS)[number];
type Tokens = Record<TokenKey, string | null>;

const WRITE_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Env vars herdr uses to name a pane. Declared here so core/scrub-env.ts
 * has a single provenance for the list without importing this module.
 *
 * HERDR_SOCKET_PATH and HERDR_ENV are deliberately absent: they stay valid
 * for as long as herdr runs, which outlasts the daemon, so a herdr-aware
 * extension can still reach the socket. What it must not do is inherit a
 * pane.
 */
export const HERDR_PANE_SCOPED_ENV = [
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_STARTUP_CWD",
] as const;

/**
 * herdr injects these into every managed pane process
 * (`apply_pane_launch_env`). HERDR_ENV proves we're inside herdr; the other
 * two are where to report and what to report about.
 */
function detect(env: NodeJS.ProcessEnv): boolean {
  return (
    env.HERDR_ENV === "1" && !!env.HERDR_SOCKET_PATH && !!env.HERDR_PANE_ID
  );
}

// ---------------------------------------------------------------------
// Transport
//
// ONE REQUEST PER CONNECTION. This is not a stylistic choice: herdr serves
// exactly one request per socket and then resets the connection. Writing two
// newline-delimited frames to a single socket gets the first one processed,
// the second silently discarded, and an ECONNRESET — verified against herdr
// 0.8.0:
//
//   2 requests, 1 connection  -> 1 response, then ECONNRESET
//   1 request,  1 connection  -> 1 response
//
// That failure mode is invisible from the sending side (the dropped frame
// would have returned `ok` anyway), so it has to be designed around rather
// than detected.
// ---------------------------------------------------------------------

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
    // A reply means herdr has processed this frame, so the next one in the
    // chain is safe to send.
    sock.on("data", () => finish(true));
    sock.on("error", () => finish(false));
    sock.on("close", () => finish(false));
    sock.setTimeout(WRITE_TIMEOUT_MS, () => finish(false));
  });
}

/** Request/response, for the calls whose reply we actually need. */
function request(
  socketPath: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let sock: net.Socket;
    try {
      sock = net.connect(socketPath);
    } catch (err) {
      reject(err as Error);
      return;
    }
    let buf = "";
    let settled = false;
    const finish = (err: Error | null, value?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      sock.destroy();
      if (err) {
        reject(err);
      } else {
        resolve(value);
      }
    };
    sock.on("connect", () => {
      sock.write(`${JSON.stringify({ id: "hydra-req", method, params })}\n`);
    });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      const line = nl === -1 ? buf : buf.slice(0, nl);
      if (nl === -1 && line.length === 0) {
        return;
      }
      try {
        finish(null, JSON.parse(line.trim()));
      } catch {
        // Partial frame — wait for more bytes.
      }
    });
    sock.on("error", (err) => finish(err));
    sock.on("close", () => finish(new Error("herdr closed the connection")));
    sock.setTimeout(REQUEST_TIMEOUT_MS, () =>
      finish(new Error("herdr did not respond")),
    );
  });
}

// Monotonic and — critically — seeded from the wall clock rather than from
// zero, scaled by 1000.
//
// herdr's `hook_report_sequences` lives on the pane's terminal state, not on
// our connection, so it OUTLIVES this process. A TUI that restarted in the
// same pane and began counting from 1 again would have every single report
// rejected as stale (`seq <= last_seq`) for as long as that pane existed,
// silently and with `{"type":"ok"}` responses throughout. Using the epoch as
// the base makes any later process outrank any earlier one.
//
// The *1000 scaling matters. Plain epoch-ms leaves only one unit of headroom
// per millisecond, so a process that emitted N frames reaches `start + N`; a
// restart fewer than N milliseconds later would begin *below* that
// high-water mark and be locked out. Scaling to microseconds gives 1000
// units per millisecond, which no realistic report rate can outrun. This
// matches herdr's own integrations, which seed the same way
// (`Date.now() * 1000` in its opencode plugin, `time.time_ns()` in its
// claude hook) — for exactly this reason.
//
// Module-level and never reset within a process — see trap (1).
let seq = Date.now() * 1000;
function nextSeq(): number {
  seq += 1;
  return seq;
}

function formatQueue(queued: number | null): string | null {
  return queued !== null && queued > 0 ? String(queued) : null;
}

/**
 * Basename of the session cwd.
 *
 * Sidebar rows are narrow and the full path would be truncated by herdr's
 * 80-char cap anyway.
 */
function cwdToken(cwd: string | null): string | null {
  const trimmed = cwd?.trim();
  if (!trimmed) {
    return null;
  }
  return path.basename(trimmed) || trimmed;
}

// We deliberately never set `display_agent`.
//
// herdr resolves its built-in `agent` sidebar token as
// `display_agent ?? agent_name ?? agent_label` (workspace/aggregate.rs:47),
// and `display_agent` has no token name of its own — so setting it would
// silently outrank `herdr agent rename <pane> <name>`, i.e. override the
// user's own choice with no way to get it back. The real agent kind rides
// along as the `kind` token instead, where a user can opt into rendering it.
//
// clear_display_agent is still sent on every metadata report so that a value
// set by an older build is removed rather than inherited — the same "always
// send the whole set" discipline the token map uses.

/** The subset of a `pane.list` entry the reverse lookup needs. */
export interface HerdrPane {
  pane_id: string;
  tab_id?: string | undefined;
  workspace_id?: string | undefined;
  tokens?: { session?: string | null } | undefined;
}

/**
 * Which of several panes showing the same session to jump to.
 *
 * Nearest first — self, then this workspace, then anywhere — with pane id as
 * the final tiebreak so the answer is stable across calls. Stability is the
 * point rather than a nicety: pressing the same key twice landing in two
 * different panes would read as the feature being broken, and multi-client
 * attach makes duplicates ordinary rather than exceptional.
 *
 * Exported for tests; `pane.list` ordering is herdr's business and not
 * something to assert against a live daemon.
 */
export function nearestPane(
  panes: readonly HerdrPane[],
  selfPaneId: string,
  workspaceId: string | undefined,
): HerdrPane | null {
  if (panes.length === 0) {
    return null;
  }
  const rank = (p: HerdrPane): number => {
    if (p.pane_id === selfPaneId) {
      return 0;
    }
    if (workspaceId && p.workspace_id === workspaceId) {
      return 1;
    }
    return 2;
  };
  return [...panes].sort(
    (a, b) => rank(a) - rank(b) || a.pane_id.localeCompare(b.pane_id),
  )[0] as HerdrPane;
}

class HerdrHost implements TerminalHost {
  readonly id = "herdr";

  readonly caps = {
    openTab: true,
    // herdr's layout apply is the only method that can launch argv, and it
    // works on a whole TAB. Passing the current tab_id "creates the
    // replacement tab first and then closes the old tab" and "does not
    // preserve live PTYs, scrollback, or running processes" — i.e. it would
    // kill the hydra the user is sitting in to make room. So: new tab only.
    split: false,
    // Needs HERDR_TAB_ID, which is present in a managed pane but is exactly
    // the sort of thing that goes missing in a scrubbed environment.
    label: !!process.env.HERDR_TAB_ID,
    report: true,
    // `pane.list` returns every pane's token map alongside its tab and
    // workspace, so the reverse lookup is one request rather than a fan-out,
    // and `tab.focus` crosses workspaces on its own (`switch_workspace_tab`).
    reveal: true,
  };

  private readonly socketPath: string;
  private readonly paneId: string;
  private readonly tabId: string | undefined;

  // Frames are serialized rather than fired in parallel, each waiting for
  // its reply before the next connects. Two orderings depend on it: the
  // metadata report must land after the report_agent that establishes the
  // authority it hangs off, and on teardown the metadata clear must land
  // before the release that drops that authority.
  private chain: Promise<void> = Promise.resolve();

  // herdr splits one snapshot across two frames, so it dedupes at a finer
  // grain than core does: a state-only change shouldn't resend the token
  // map, and the 1Hz banner tick means that would otherwise be constant.
  // Keyed on state AND turn origin, not state alone: the origin rides the
  // state frame, so deduping on state would swallow the origin change on a
  // `working -> working` re-report. Conversely the key must not include the
  // origin LABEL, which is free-form text that belongs to the token map — a
  // changed label alone should not re-report state.
  private sentState: string | null = null;
  private sentMeta: string | null = null;
  // True once anything has been reported, so release() knows whether there
  // is any authority to withdraw.
  private claimed = false;

  constructor(env: NodeJS.ProcessEnv) {
    this.socketPath = env.HERDR_SOCKET_PATH as string;
    this.paneId = env.HERDR_PANE_ID as string;
    this.tabId = env.HERDR_TAB_ID;
  }

  private tokens(snap: TerminalHostSnapshot): Tokens {
    return {
      kind: snap.agent ?? null,
      cwd: cwdToken(snap.cwd),
      model: snap.model ?? null,
      cost: snap.cost ?? null,
      queue: formatQueue(snap.queued),
      turn: snap.turnOrigin,
      turn_label: snap.turnLabel,
      session: snap.sessionId ?? null,
    };
  }

  /**
   * Queue frames for delivery, in order.
   *
   * `onFailure` lets the caller invalidate its dedupe cache when a frame
   * doesn't land, so the next change re-sends rather than believing herdr
   * already knows.
   */
  private send(
    frames: Array<{ method: string; params: unknown }>,
    onFailure?: () => void,
  ): Promise<void> {
    if (frames.length === 0) {
      return Promise.resolve();
    }
    const batch = frames.map((f, i) => ({ frame: f, id: `hydra-${seq}-${i}` }));
    this.chain = this.chain
      .then(async () => {
        for (const { frame, id } of batch) {
          const ok = await writeFrame(this.socketPath, frame, id);
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
    return this.chain;
  }

  async report(snap: TerminalHostSnapshot): Promise<void> {
    const tokens = this.tokens(snap);
    const metaKey = JSON.stringify({ title: snap.title, tokens });
    const frames: Array<{ method: string; params: unknown }> = [];
    // Withhold an OPENING `unknown`, and only that one.
    //
    // The two funnels core reports from don't arrive together: the session
    // bar seeds first, so there is no banner to derive activity from yet and
    // the state is `unknown`. The banner lands a moment later and corrects it
    // to `idle`. Publishing both makes herdr see `unknown -> idle, same
    // agent`, which is precisely its definition of a COMPLETION — so every
    // freshly attached pane announces that its agent just finished. Attach a
    // few at once and it is a burst of false "done" toasts.
    //
    // This lives in the adapter rather than in core because it is herdr's
    // reading of that pair that causes the problem; tmux is indifferent to
    // it, and core's state machine should not be bent around one host's
    // notification heuristic.
    //
    // Skipping the frame means herdr never learns an agent label here, which
    // is what makes the following `idle` a first observation rather than a
    // transition. The cost is no agent row until a real state arrives, a
    // fraction of a second, versus a false notification on every attach.
    const withholdOpeningUnknown = this.sentState === null && snap.state === "unknown";
    const stateKey = `${snap.state} ${snap.turnOrigin ?? ""}`;
    if (this.sentState !== stateKey && !withholdOpeningUnknown) {
      frames.push({
        method: "pane.report_agent",
        params: {
          pane_id: this.paneId,
          source: SOURCE,
          agent: AGENT_LABEL,
          state: snap.state,
          // Unknown to herdr today, and harmless: nothing in its api schema
          // sets deny_unknown_fields, so these deserialize away. Sent anyway
          // so the day herdr wants to gate its completion chime on "did a
          // human ask for this", the data is already arriving on the frame
          // that carries the transition — no hydra release needed to turn it
          // on. herdr does not store or echo these; `turn`/`turn_label` in
          // the token map are the readable copy.
          ...(snap.turnOrigin ? { turn_origin: snap.turnOrigin } : {}),
          ...(snap.turnLabel ? { turn_label: snap.turnLabel } : {}),
          seq: nextSeq(),
        },
      });
    }
    if (this.sentMeta !== metaKey) {
      frames.push({
        method: "pane.report_metadata",
        params: {
          pane_id: this.paneId,
          source: SOURCE,
          seq: nextSeq(),
          ...(snap.title ? { title: snap.title } : { clear_title: true }),
          clear_display_agent: true,
          tokens,
        },
      });
    }
    if (frames.length === 0) {
      return;
    }
    // Recorded optimistically so a repeat call doesn't re-send, but dropped
    // again if the write fails — otherwise a single failed frame would
    // convince us forever that herdr is up to date.
    const prevState = this.sentState;
    const prevMeta = this.sentMeta;
    this.sentState = stateKey;
    this.sentMeta = metaKey;
    this.claimed = true;
    await this.send(frames, () => {
      this.sentState = prevState;
      this.sentMeta = prevMeta;
    });
  }

  /**
   * Order matters: the metadata clear has to land before the release,
   * because releasing first would drop the authority the metadata hangs
   * off. Both carry a seq for the reason in trap (1); without one they are
   * accepted and discarded.
   */
  async release(): Promise<void> {
    if (!this.claimed) {
      return;
    }
    const cleared: Tokens = {
      kind: null,
      cwd: null,
      model: null,
      cost: null,
      queue: null,
      turn: null,
      turn_label: null,
      session: null,
    };
    const flushed = this.send([
      {
        method: "pane.report_metadata",
        params: {
          pane_id: this.paneId,
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
          pane_id: this.paneId,
          source: SOURCE,
          agent: AGENT_LABEL,
          seq: nextSeq(),
        },
      },
    ]);
    this.sentState = null;
    this.sentMeta = null;
    this.claimed = false;
    await flushed;
  }

  /**
   * Neither tab.create nor pane.split can launch a command — their params
   * are only cwd/env/focus/label. layout.apply is the only method that takes
   * an argv `command`, on the pane nodes of a declarative tab tree, and its
   * unit is a TAB. Omitting `tab_id` creates a new one, which is what we
   * want; see the `split: false` note above for why we never pass one.
   */
  async openTab(spec: OpenTabSpec): Promise<OpenTabResult> {
    const pane: Record<string, unknown> = {
      type: "pane",
      label: spec.label,
      command: spec.argv,
    };
    // Only send cwd when it's usable — herdr validates absolute + is_dir and
    // would otherwise reject the whole call rather than just ignoring it.
    if (spec.cwd && spec.cwd.startsWith("/")) {
      pane.cwd = spec.cwd;
    }
    if (spec.env && Object.keys(spec.env).length > 0) {
      pane.env = spec.env;
    }
    const params: Record<string, unknown> = {
      tab_label: spec.label,
      focus: true,
      root: pane,
    };
    // Scope to this pane's workspace when herdr told us which one;
    // otherwise let herdr fall back to the active workspace.
    if (process.env.HERDR_WORKSPACE_ID) {
      params.workspace_id = process.env.HERDR_WORKSPACE_ID;
    }
    let reply: unknown;
    try {
      reply = await request(this.socketPath, "layout.apply", params);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const body = reply as { error?: { code?: string; message?: string } };
    if (body?.error) {
      return {
        ok: false,
        error:
          body.error.message ||
          body.error.code ||
          "herdr rejected the request",
      };
    }
    return { ok: true };
  }

  /**
   * Find the pane whose `session` token is `sessionId` and go there.
   *
   * The token is the whole index. herdr keeps no notion of a hydra session
   * itself — every pane in the list is showing one only because the hydra
   * inside it said so via report(), and stopped saying so on release(). That
   * makes this lookup self-maintaining in a way a registry could not be: a
   * pane that crashed hard leaves a stale token, but a pane that merely
   * switched sessions or opened the picker is accurate immediately.
   *
   * tab.focus then pane.focus, in that order and both best-effort. tab.focus
   * alone lands on the right tab but leaves focus wherever it was inside a
   * split; pane.focus alone is not documented to pull the tab or workspace
   * along with it. Doing both is one extra round trip on a keystroke-rate
   * path, which is cheap, and makes the split case land on the hydra rather
   * than next to it.
   */
  async revealSession(sessionId: string): Promise<boolean> {
    if (!sessionId) {
      return false;
    }
    let reply: unknown;
    try {
      reply = await request(this.socketPath, "pane.list", {});
    } catch {
      return false;
    }
    const panes = (reply as { result?: { panes?: unknown } })?.result?.panes;
    if (!Array.isArray(panes)) {
      return false;
    }
    const matches = panes.filter(
      (p): p is HerdrPane =>
        !!p &&
        typeof p === "object" &&
        typeof (p as HerdrPane).pane_id === "string" &&
        ((p as HerdrPane).tokens?.session ?? null) === sessionId,
    );
    const target = nearestPane(matches, this.paneId, process.env.HERDR_WORKSPACE_ID);
    if (!target) {
      return false;
    }
    if (target.tab_id) {
      await request(this.socketPath, "tab.focus", {
        tab_id: target.tab_id,
      }).catch(() => undefined);
    }
    await request(this.socketPath, "pane.focus", {
      pane_id: target.pane_id,
    }).catch(() => undefined);
    return true;
  }

  async readLabel(): Promise<TabLabelView | null> {
    if (!this.tabId) {
      return null;
    }
    const reply = (await request(this.socketPath, "tab.get", {
      tab_id: this.tabId,
    })) as { result?: { tab?: unknown }; error?: unknown };
    if (!reply || reply.error) {
      return null;
    }
    const tab = reply.result?.tab as
      | { label?: unknown; pane_count?: unknown }
      | undefined;
    if (
      !tab ||
      typeof tab.label !== "string" ||
      typeof tab.pane_count !== "number"
    ) {
      return null;
    }
    return { label: tab.label, paneCount: tab.pane_count };
  }

  async writeLabel(label: string): Promise<boolean> {
    if (!this.tabId) {
      return false;
    }
    const reply = (await request(this.socketPath, "tab.rename", {
      tab_id: this.tabId,
      label,
    })) as { error?: unknown };
    return !reply?.error;
  }

  /**
   * herdr's default tab label is the tab number rendered as a string
   * (`custom_name.unwrap_or_else(|| (tab_idx + 1).to_string())`), so a
   * purely numeric label means "never named". Empty is treated the same way.
   */
  isAutoLabel(label: string): boolean {
    const trimmed = label.trim();
    return trimmed.length === 0 || /^[0-9]+$/.test(trimmed);
  }
}

export const herdrCandidate: TerminalHostCandidate = {
  id: "herdr",
  paneScopedEnv: HERDR_PANE_SCOPED_ENV,
  detect,
  create: () => new HerdrHost(process.env),
};
