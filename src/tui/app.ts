// Orchestrator: ties config, daemon discovery, WS connection, the screen, and
// the input dispatcher together.

import { appendFileSync, statSync, renameSync } from "node:fs";
import { nanoid } from "nanoid";
import termkit from "terminal-kit";
import { JsonRpcConnection } from "../acp/connection.js";
import {
  HYDRA_META_KEY,
  extractHydraMeta,
  type CancelPromptResult,
  type JsonRpcRequest,
  type PromptQueueEntry,
  type SessionListUsage,
  type UpdatePromptResult,
  ACP_PROTOCOL_VERSION,
  AGENT_INSTALL_PROGRESS_METHOD,
  AgentInstallProgressParams,
} from "../acp/types.js";
import { ResilientWsStream } from "../shim/resilient-ws.js";
import { loadConfig, type HydraConfig } from "../core/config.js";
import {
  resolveLocalTarget,
  type RemoteTarget,
} from "../core/remote-target.js";
import { ensureDaemonReachable } from "../core/daemon-bootstrap.js";
import { invokedBinName } from "../core/bin-name.js";
import { stripHydraSessionPrefix } from "../core/session.js";
import { paths } from "../core/paths.js";
import { HYDRA_VERSION } from "../core/hydra-version.js";
import {
  formatUpdateNoticeLine,
  getPendingUpdate,
} from "../core/update-check.js";
import {
  appendEntry,
  appendHistoryLine,
  buildCombinedHistory,
  loadHistory,
  mergeReplayedEntries,
  saveHistory,
} from "./history.js";
import { listSessions, pickMostRecent, type DiscoveredSession } from "./discovery.js";
import {
  createPickerPrefs,
  pickSession,
  type PickerPrefs,
  type PickerResult,
} from "./picker.js";
import { promptForImportCwd } from "./import-cwd-prompt.js";
import { promptForImportAction } from "./import-action-prompt.js";
import { formatElapsed, Screen } from "./screen.js";
import {
  InputDispatcher,
  type Attachment,
  type InputEffect,
  type KeyEvent,
} from "./input.js";
import {
  MAX_ATTACHMENT_BYTES,
  formatSize,
  mimeFromExtension,
  parseDataUriImage,
} from "./attachments.js";
import { readClipboard } from "./clipboard.js";
import fs from "node:fs/promises";
import path from "node:path";
import { computeTabCompletion } from "./completion.js";
import {
  parseReattachResponse,
  type ReattachResponseFields,
} from "./reconnect-state.js";
import {
  mapUpdate,
  normalizeAdvertisedCommands,
  sanitizeSingleLine,
  type AvailableCommand,
  type AvailableMode,
  type RenderEvent,
} from "../core/render-update.js";
import {
  formatEvent,
  formatExitPlanMode,
  formatToolLine,
  parseAgentMarkdown,
  parseThoughtMarkdown,
  type ExitPlanState,
  type FormattedLine,
  type ToolLineState,
} from "./format.js";

export interface TuiOptions {
  sessionId?: string;
  agentId?: string;
  cwd?: string;
  name?: string;
  // One-shot model override applied to fresh session/new only. Not
  // forwarded into nextOpts on resume/restart paths — once a session
  // exists, model is managed through session/set_model and persisted
  // as currentModel in meta.json.
  model?: string;
  resume?: boolean;
  forceNew?: boolean;
  // First-prompt seed for a freshly-created session. The picker's
  // composer pane returns the typed text here; runSession fires it via
  // enqueuePrompt once, immediately after the daemon attaches the
  // freshly-spawned session. Only honored when ctx.sessionId === "__new__"
  // so a stray forward into a resume/restart path can't re-fire it.
  initialPrompt?: string;
  // View-only mode. When true the TUI attaches with readonly:true so
  // the daemon won't resurrect or spawn an agent (cold session viewer
  // path) and refuses any state-changing JSON-RPC method from this
  // connection. The composer is hidden; prompt/cancel/set_model
  // keystrokes are inert. Per-session — switching to a different
  // session via the picker drops out of read-only unless that session
  // was re-selected via the picker's `v` keystroke.
  readonly?: boolean;
  // Pre-resolved daemon target. When set, runTuiApp skips its own
  // resolveLocalTarget() call (and the local-daemon autostart) and
  // talks to this target instead. Used by `hydra session attach
  // hydra://...` to attach to a remote daemon. Local TUI invocations
  // leave this undefined and get the default service-token + local
  // daemon flow.
  target?: RemoteTarget;
  // First-launch import hint forwarded from the ^p picker through the
  // runSession loop. resolveSession's short-circuit copies it onto the
  // returned SessionContext so the WS attach builds the same _meta
  // resume payload as the initial-picker path. Cleared by the next
  // attach.
  importAttachHint?: {
    agentId: string;
    cwd: string;
  };
}

// Shared view-only preferences that persist across the runSession loop
// (picker switch, ^T cycle, forced reconnect) so toggles set by the
// user during one session carry into the next. Seeded once from config
// in runTuiApp; mutated by hotkey handlers inside runSession.
interface ViewPrefs {
  showThoughts: boolean;
}

interface SessionContext {
  sessionId: string;
  agentId: string;
  cwd: string;
  // First-launch-on-this-machine for an imported session: the user
  // picked a local cwd via promptForImportCwd. We forward a full resume
  // hint on the initial session/attach so the daemon takes the
  // import-resurrect path (upstreamSessionId === "") with that cwd
  // instead of silently falling back to $HOME via resolveImportCwd.
  importAttachHint?: {
    agentId: string;
    cwd: string;
  };
}

// How long the upstream may be silent (no session/update arrivals)
// during a busy turn before the banner flips to a red "stalled"
// treatment. Picked at 2 min so legitimately long single-LLM-call quiet
// periods (e.g. slow reasoning models) don't trip it, but a hung
// proxy retry loop becomes obvious well before the 43-minute outages
// we've seen in practice.
const STALL_THRESHOLD_MS = 120_000;

// Hotkey cheatsheet rendered by the ^G modal. `null` is a visual
// separator between groups. The Enter / Shift+Enter pair is built
// dynamically per-session so the modal reflects which key enqueues
// and which amends (see buildHelpEntries) — config.tui.defaultEnterAction
// flips the meaning.
// Effects that mutate session state — dropped silently in read-only
// mode. Everything else (navigation, exit, redraw, scroll, switch-
// session, search escalation, etc.) passes through so the viewer
// stays usable. The daemon would refuse these anyway (-32011) if one
// slipped past the client; this filter just keeps the wire quiet.
function isReadonlyForbiddenEffect(effect: InputEffect): boolean {
  switch (effect.type) {
    case "send":
    case "amend":
    case "queue-edit":
    case "queue-remove":
    case "plan-toggle":
    case "attachment-request":
      return true;
    default:
      return false;
  }
}

const HELP_ENTRIES_TAIL: ReadonlyArray<readonly [string, string] | null> = [
  ["Alt+Enter", "newline in prompt"],
  ["Shift+Tab", "cycle agent modes (plan / accept-edits / etc.)"],
  ["Tab", "indent · slash-command completion"],
  null,
  ["↑ / ↓", "prompt history · queue navigation"],
  ["←/→ Home/End", "cursor movement"],
  ["Alt+B / Alt+F", "word back / forward"],
  ["^A / ^E", "line start / end"],
  ["^W / ^U / ^K", "kill word / line / to end"],
  ["^Y", "yank last kill"],
  null,
  ["^P", "switch session (picker)"],
  ["Alt+N / Alt+Tab", "next live session"],
  ["^T", "show / hide thoughts"],
  ["^V", "paste image from clipboard"],
  ["^O", "expand / collapse tools block"],
  null,
  ["^R", "history reverse search (^S walks forward once engaged)"],
  ["PgUp / PgDn", "scroll scrollback"],
  ["Mouse wheel", "scroll scrollback (when mouse capture is on)"],
  ["^X", "toggle mouse capture (wheel scroll vs. text selection)"],
  null,
  ["^C", "cancel turn (twice to exit)"],
  ["Esc", "cancel turn and prefill draft"],
  ["^D", "exit (or delete-forward in prompt)"],
  ["^L", "force full redraw"],
  ["^G", "toggle this help"],
];


export async function runTuiApp(opts: TuiOptions): Promise<void> {
  const config = await loadConfig();
  // Local daemon target unless the caller pre-resolved a remote one.
  // `hydra session attach hydra://...` does the resolution up front so
  // the password prompt happens before we touch the terminal; the
  // local TUI invocation falls through to resolveLocalTarget here.
  const target = opts.target ?? (await resolveLocalTarget(config));
  logMaxBytes = config.tui.logMaxBytes;
  // Only autostart the daemon when it's on this machine. Remote
  // targets get a connection error from the WS layer if the daemon
  // isn't up, which is the right behavior (we can't reach across the
  // network to spawn anything).
  if (target.isLocal && !opts.target) {
    await ensureDaemonReachable(config);
  }
  const term = termkit.terminal;

  // Filled in by runSession as soon as a session is attached/created.
  // Used to print a "To resume: …" hint on the way out so the user
  // doesn't have to dig through `hydra-acp sessions list` to come back.
  const exitHint: { sessionId?: string; readonly?: boolean } = {};
  // TUI-process-wide view preferences. Each runSession() invocation reads
  // and mutates this container so that toggles (e.g. ^T thought
  // visibility) outlive the per-session re-attach loop that picker /
  // ^T cycle / forced reconnect drives. Seeded once from config; the
  // hotkey handler inside runSession mutates in place.
  const viewPrefs: ViewPrefs = {
    showThoughts: config.tui.showThoughts,
  };
  // Picker filter toggles (cwd-only, host) are mutated in place by the
  // picker so re-opening via ^p restores the same filtered view the
  // user had set when they entered the session. Scope is per
  // TUI-process; nothing on disk.
  const pickerPrefs = createPickerPrefs();
  // Enter the alternate screen here, BEFORE the picker can paint, so
  // every TUI surface — picker included — lives in the alt buffer. On
  // exit (CSI ? 1049 l) the host terminal restores its main buffer and
  // cursor exactly as they were when the user typed `hydra-acp` at the
  // shell. Without this, the picker's first paint went to the main
  // buffer and the picker's last frame was what remained on screen
  // after we left the TUI.
  let altScreenEngaged = false;
  const enterAltScreen = (): void => {
    if (altScreenEngaged) {
      return;
    }
    term.fullscreen(true);
    altScreenEngaged = true;
  };
  const leaveAltScreen = (): void => {
    if (!altScreenEngaged) {
      return;
    }
    term.fullscreen(false);
    altScreenEngaged = false;
    // Land on a fresh line below the restored shell prompt so any
    // trailing stderr/stdout (update notice, resume hint) doesn't
    // collide with the user's original command line.
    process.stdout.write("\n");
  };
  enterAltScreen();
  // Ensure we leave the alt screen on any abnormal exit path so the
  // host shell isn't stuck in the alt buffer.
  const altScreenCleanup = (): void => {
    if (altScreenEngaged) {
      term.fullscreen(false);
      altScreenEngaged = false;
    }
  };
  process.once("exit", altScreenCleanup);
  let nextOpts: TuiOptions | null = opts;
  try {
    while (nextOpts !== null) {
      nextOpts = await runSession(
        term,
        config,
        target,
        nextOpts,
        exitHint,
        viewPrefs,
        pickerPrefs,
      );
    }
  } finally {
    leaveAltScreen();
    process.off("exit", altScreenCleanup);
  }
  // Re-surface the update notice on the way out so users who missed
  // the 30-second banner inside the TUI still see it. cli.ts suppresses
  // its own end-of-process notice for the TUI path (it owned the
  // alternate screen until just now), so this is the only post-exit
  // chance. getPendingUpdate() caches in-process — this just reads
  // whatever the in-session banner check already populated.
  const pendingUpdate = await getPendingUpdate();
  if (pendingUpdate) {
    process.stderr.write(`✨ ${formatUpdateNoticeLine(pendingUpdate)}\n`);
  }
  // Resume hint is only useful for humans — piped output (e.g. into
  // an editor's "run command" pane) treats this as noise. Skip when
  // stdout isn't a TTY.
  if (exitHint.sessionId && process.stdout.isTTY) {
    const short = stripHydraSessionPrefix(exitHint.sessionId);
    const flags = exitHint.readonly ? " --readonly" : "";
    process.stdout.write(
      `To resume: ${invokedBinName()} tui --session ${short}${flags}\n`,
    );
  }
}

async function runSession(
  term: termkit.Terminal,
  config: HydraConfig,
  target: RemoteTarget,
  opts: TuiOptions,
  exitHint: { sessionId?: string; readonly?: boolean },
  viewPrefs: ViewPrefs,
  pickerPrefs: PickerPrefs,
): Promise<TuiOptions | null> {
  const ctx = await resolveSession(term, config, target, opts, pickerPrefs);
  if (!ctx) {
    // Picker was aborted (Ctrl+C / Esc). Belt-and-suspenders grab
    // release — the picker already does this on every exit path, but
    // a leaked grab here would keep the event loop alive past return.
    term.grabInput(false);
    return null;
  }

  // Visible status while the daemon brings up (or attaches to) the
  // session. Resurrection of cold sessions and fresh-agent spawns can
  // take a couple of seconds; without this line the terminal looks
  // hung between the picker closing and screen.start() entering
  // fullscreen. The alternate-screen switch in screen.start() naturally
  // wipes whatever we printed here.
  //
  // The line is also rewritten in-place while a fresh agent's binary or
  // npm package is being downloaded (see hydra-acp/agent_install_progress
  // handler below) so the user gets bytes-and-percent feedback during
  // what would otherwise look like a multi-second hang.
  const launchLabelBase =
    ctx.sessionId === "__new__"
      ? "Starting new session…"
      : "Resuming session…";
  const installStatus = createInstallStatusLine(term, launchLabelBase);
  installStatus.write(launchLabelBase);

  const wsUrl = target.wsUrl;
  const subprotocols = ["acp.v1", `hydra-acp-token.${target.token}`];
  // Forward-declared so the resilient stream's onConnect/onDisconnect
  // hooks (which fire before the Screen is built on first connect) can
  // call into them safely. Real implementations are assigned later.
  let onReconnect: (() => Promise<void>) | null = null;
  let onDisconnectHook: ((err?: Error) => void) | null = null;
  const stream = new ResilientWsStream({
    url: wsUrl,
    subprotocols,
    onConnect: async (firstConnect) => {
      if (firstConnect) {
        // Initial handshake runs in the outer flow so its result can
        // populate resolvedSessionId/agentId/cwd before the Screen is
        // built. Nothing to do inside onConnect on first connect.
        return;
      }
      if (onReconnect) {
        await onReconnect();
      }
    },
    onDisconnect: (err) => {
      if (onDisconnectHook) {
        onDisconnectHook(err);
      }
    },
    log: () => undefined,
  });
  const conn = new JsonRpcConnection(stream);
  await stream.start();

  // Subscribe BEFORE issuing session/new or session/attach. The daemon
  // fires hydra-acp/agent_install_progress notifications during those
  // requests if it has to fetch a binary or npm package — registering
  // late would miss the first download_start tick. Stopped once the
  // session is fully attached (see installStatus.finalize() below).
  conn.onNotification(AGENT_INSTALL_PROGRESS_METHOD, (raw) => {
    const parsed = AgentInstallProgressParams.safeParse(raw);
    if (!parsed.success) {
      return;
    }
    installStatus.applyProgress(parsed.data);
  });

  // Buffer rendered events that arrive before the screen is wired up — most
  // importantly, the history replay during session/attach. Once
  // applyRenderEvent is bound we drain the buffer through it.
  let bufferedEvents: RenderEvent[] = [];
  let applyRenderEvent: ((event: RenderEvent) => void) | null = null;
  // Flips true the moment teardown starts. Notification/request handlers
  // check this and bail before touching the screen — otherwise updates
  // streaming in during a long turn keep painting after we've left the
  // alternate screen, scrambling the host shell on detach.
  let teardownStarted = false;
  const appendRender = (event: RenderEvent | null): void => {
    if (!event) {
      return;
    }
    if (applyRenderEvent) {
      applyRenderEvent(event);
    } else {
      bufferedEvents.push(event);
    }
  };

  // Count of prompts currently in flight on the daemon — across ALL
  // clients, not just ours. Incremented when we observe a peer's
  // prompt_received (the daemon excludes us from our own broadcasts, so
  // a user-text notification arriving here is always a peer) or when we
  // start one of our own (in runPrompt). Decremented on every
  // turn_complete (peer's, observed here; ours, in runPrompt's finally).
  // Hydra serializes session/prompt requests on the wire so we don't
  // gate sending on this — it's purely for the banner busy state.
  let pendingTurns = 0;
  // messageId of the prompt currently being processed by the agent
  // (whether ours or a peer's). Tracked from prompt_received and
  // cleared on turn_complete. Used as the targetMessageId for
  // hydra-acp/amend_prompt when the user presses Shift+Enter.
  let currentHeadMessageId: string | undefined;
  // Wall-clock moment the session became busy (pendingTurns went 0 → >0).
  // Drives the banner's elapsed counter so the user sees "● running 30s"
  // for peer-triggered turns too, not just our own.
  let sessionBusySince: number | null = null;
  let sessionElapsedTimer: NodeJS.Timeout | null = null;
  // Wall-clock moment of the most recent session/update we received from
  // the daemon. The 1Hz timer reads this to detect a stalled upstream
  // (silence past STALL_THRESHOLD_MS while busy) and flip the banner red.
  let lastUpdateAt: number | null = null;
  // Latched per-turn: any tool_call_update arriving with
  // upstreamInterrupted=true sets this to true. Consumed at turn_complete
  // to override a misleadingly clean end_turn from the upstream agent —
  // opencode's retry loop reports the failed tool but still returns
  // stopReason=end_turn, which otherwise hides the failure entirely.
  let upstreamInterruptedSeen = false;
  // Centralized pending-turn arithmetic so banner state and elapsed
  // timer stay in sync regardless of whether the underlying turn was
  // ours or a peer's. Without this the banner would stay on "ready"
  // while a peer is mid-turn.
  const adjustPendingTurns = (delta: number): void => {
    const before = pendingTurns;
    pendingTurns = Math.max(0, pendingTurns + delta);
    // Banner updates reference `screen`, which is declared (as `const`)
    // later in this function. During the attach handshake the daemon
    // sends history notifications BEFORE control returns to the line
    // where `screen` is initialized, so direct access would throw a
    // ReferenceError (TDZ) and abort the onNotification handler before
    // appendRender(event) runs — silently dropping every user-text and
    // turn-complete from history. Skip banner state changes when
    // screen isn't ready yet; the eventual drain still renders the
    // events correctly.
    const screenReady = typeof screenRef !== "undefined" && screenRef !== null;
    if (before === 0 && pendingTurns > 0) {
      sessionBusySince = Date.now();
      lastUpdateAt = Date.now();
      dispatcherRef?.setTurnRunning(true);
      if (screenReady) {
        screenRef!.setBanner({ status: "busy", elapsedMs: 0, stalled: false });
      }
      if (sessionElapsedTimer === null && screenReady) {
        // Tick once per second so the "thinking · Xs" indicator visibly
        // counts up — the browser's spinner gives the user constant
        // feedback that something is happening; a 5s tick made the TUI
        // feel frozen by comparison. The 1Hz screen-repaint throttle
        // coalesces paints, so this isn't expensive.
        sessionElapsedTimer = setInterval(() => {
          if (sessionBusySince === null || screenRef === null) {
            return;
          }
          const idleMs =
            lastUpdateAt === null ? 0 : Date.now() - lastUpdateAt;
          screenRef.setBanner({
            elapsedMs: Date.now() - sessionBusySince,
            stalled: idleMs >= STALL_THRESHOLD_MS,
          });
          renderToolsBlock();
        }, 1_000);
      }
    } else if (before > 0 && pendingTurns === 0) {
      sessionBusySince = null;
      lastUpdateAt = null;
      dispatcherRef?.setTurnRunning(false);
      if (sessionElapsedTimer !== null) {
        clearInterval(sessionElapsedTimer);
        sessionElapsedTimer = null;
      }
      if (screenReady) {
        screenRef!.setBanner({
          status: "ready",
          elapsedMs: undefined,
          stalled: false,
        });
      }
    }
    void delta;
  };
  // Late-bound references so adjustPendingTurns (which can run via
  // onNotification before `screen` and `dispatcher` are assigned) can
  // tell whether it's safe to touch them. dispatcherRef in particular
  // gates the turnRunning flag that drives ^C → cancel; without it,
  // a mid-turn reattach leaves ^C falling through to the exit path.
  let screenRef: Screen | null = null;
  let dispatcherRef: InputDispatcher | null = null;
  // Last messageId we observed from a recordable session/update. Drives
  // onReconnect's `historyPolicy: "after_message"` request so the daemon
  // replays only the delta we missed. State-kind updates (model/mode/usage
  // snapshots) aren't persisted to history, so we deliberately skip them
  // here — tracking one would force after_message to fall back to "full".
  let lastSeenMessageId: string | undefined = undefined;
  // When non-null, session/update notifications get parked here instead of
  // running. Set by onReconnect before issuing session/attach with
  // after_message so the daemon's replay (delivered via notify() during
  // the attach handler — see daemon/acp-ws.ts) can be inspected against
  // the response's appliedPolicy before being flushed: if the daemon fell
  // back to "full" replay (because afterMessageId wasn't in history), we
  // discard the buffer rather than render the entire history a second time.
  let reconnectReplayBuffer: unknown[] | null = null;
  const STATE_UPDATE_KINDS = new Set([
    "session_info_update",
    "current_model_update",
    "current_mode_update",
    "available_commands_update",
    "available_modes_update",
    "usage_update",
  ]);
  const handleSessionUpdate = (params: unknown): void => {
    const { update } = (params ?? {}) as { update?: unknown };
    const event = mapUpdate(update);
    debugLogUpdate(update, event);
    // Any wire activity counts as "upstream alive" for the stall
    // watchdog — state-kind updates (usage_update, current_model_update
    // …) included, since they signal the upstream is still talking to
    // us. Read by the 1Hz timer in adjustPendingTurns.
    lastUpdateAt = Date.now();
    // Only prompt_received signals a new turn. user_message_chunk also
    // maps to a "user-text" event but agents legitimately emit it
    // mid-turn (e.g. echoing a user's reply during a permission/elicit
    // flow); counting those would leave pendingTurns stranded and lock
    // the prompt queue.
    const rawTag = (update as { sessionUpdate?: unknown } | undefined)
      ?.sessionUpdate;
    // Capture messageId for after_message reconnect replay. Skip state-
    // kind updates — those aren't persisted, so the daemon can't find
    // them when computing the replay cutoff (see session.ts:1827).
    if (typeof rawTag === "string" && !STATE_UPDATE_KINDS.has(rawTag)) {
      const u = (update as { messageId?: unknown }) ?? {};
      if (typeof u.messageId === "string") {
        lastSeenMessageId = u.messageId;
      }
    }
    if (rawTag === "prompt_received") {
      adjustPendingTurns(1);
    } else if (event?.kind === "turn-complete") {
      adjustPendingTurns(-1);
    }
    // currentHeadMessageId is tracked from prompt_queue_removed{started}
    // (set) and cleared in the render-event handler's turn-complete
    // branch. prompt_received doesn't work as the SET signal because the
    // daemon excludes the originator from that broadcast, so the TUI
    // would miss own-prompt heads. prompt_queue_removed broadcasts to
    // everyone including the originator.
    if (rawTag === "permission_resolved") {
      handlePermissionResolved(update);
      return;
    }
    appendRender(event);
    maybeDismissPermissionByToolUpdate(update);
  };
  conn.onNotification("session/update", (params) => {
    if (teardownStarted) {
      return;
    }
    if (reconnectReplayBuffer !== null) {
      reconnectReplayBuffer.push(params);
      return;
    }
    handleSessionUpdate(params);
  });

  // Daemon-side close (user typed /hydra kill, an idle-close fired, the
  // record was deleted out from under us, etc.). Drain in-flight turn
  // bookkeeping so the elapsed timer stops, then flip the banner to a
  // terminal "closed" state. The WS itself stays up; a subsequent prompt
  // will get rejected by the daemon and surface that error in scrollback.
  conn.onNotification("hydra-acp/session_closed", () => {
    if (teardownStarted) {
      return;
    }
    if (pendingTurns > 0) {
      adjustPendingTurns(-pendingTurns);
    }
    const screenReady = typeof screenRef !== "undefined" && screenRef !== null;
    if (screenReady) {
      screenRef!.setBanner({ status: "cold", elapsedMs: undefined });
    }
  });

  // Hydra-owned prompt queue: maintain a local cache so the chip row
  // and the input dispatcher's queue-edit/queue-remove targets agree
  // with what the daemon thinks. All three events arrive on every
  // attached client, so peer-originated prompts surface here too —
  // two TUIs on the same session see each other's queues.
  // Amend-pending entries get a minimum-display-delay before their chip
  // paints, so a fast cancel-and-resubmit doesn't flash a chip in and
  // out. Each pending paint is keyed by messageId → setTimeout handle.
  // If prompt_queue_removed arrives before the timer fires, the chip
  // never gets cached and the user never sees it.
  const amendPendingPaintTimers = new Map<string, NodeJS.Timeout>();
  const AMEND_CHIP_DISPLAY_DELAY_MS = 200;

  conn.onNotification("hydra-acp/prompt_queue_added", (params) => {
    if (teardownStarted) return;
    const p = (params ?? {}) as {
      messageId?: unknown;
      prompt?: unknown;
      originator?: { clientId?: unknown };
      _meta?: { "hydra-acp"?: { amending?: unknown } };
    };
    if (typeof p.messageId !== "string") return;
    const isAmendPending =
      typeof p._meta?.["hydra-acp"]?.amending === "string";
    if (isAmendPending) {
      // Defer adding the chip; if started/cancelled fires within the
      // delay window, the chip is never painted.
      const mid = p.messageId;
      const prompt = p.prompt;
      const timer = setTimeout(() => {
        amendPendingPaintTimers.delete(mid);
        queueCache.set(mid, chipFromPrompt(mid, prompt));
        if (screenRef && dispatcherRef) {
          refreshQueueDisplay();
        }
      }, AMEND_CHIP_DISPLAY_DELAY_MS);
      amendPendingPaintTimers.set(mid, timer);
    } else {
      queueCache.set(p.messageId, chipFromPrompt(p.messageId, p.prompt));
      if (screenRef && dispatcherRef) {
        refreshQueueDisplay();
      }
    }
    // If this prompt_queue_added is for one of our own session/prompt
    // sends, bind the FIFO head to its messageId so we can flush the
    // scrollback echo when prompt_queue_removed{started} arrives. Hydra
    // serializes session/prompt arrivals per session, so the order of
    // our-originator events matches the order we sent.
    if (
      ownClientId !== undefined &&
      p.originator?.clientId === ownClientId
    ) {
      const echo = pendingEchoes.shift();
      if (echo) {
        echo.messageId = p.messageId;
        ownPendingByMid.set(p.messageId, echo);
      }
    }
  });
  conn.onNotification("hydra-acp/prompt_queue_updated", (params) => {
    if (teardownStarted) return;
    const p = (params ?? {}) as {
      messageId?: unknown;
      prompt?: unknown;
    };
    if (typeof p.messageId !== "string") return;
    if (!queueCache.has(p.messageId)) return;
    queueCache.set(p.messageId, chipFromPrompt(p.messageId, p.prompt));
    // If the underlying prompt of one of our own deferred echoes was
    // mutated (via hydra-acp/update_prompt), refresh the pending echo's
    // text/attachments too so the eventual scrollback flush reflects
    // what actually got forwarded upstream.
    const pending = ownPendingByMid.get(p.messageId);
    if (pending) {
      const blocks = Array.isArray(p.prompt) ? p.prompt : [];
      let text = "";
      const attachments: Attachment[] = [];
      for (const raw of blocks) {
        if (!raw || typeof raw !== "object") continue;
        const b = raw as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          text += b.text;
        } else if (
          b.type === "image" &&
          typeof b.data === "string" &&
          typeof b.mimeType === "string"
        ) {
          // Approximate the original byte count from the base64 size —
          // exact sizeBytes isn't on the wire, and the field is only
          // used for display. 3/4 of base64 length is the decoded length.
          attachments.push({
            data: b.data,
            mimeType: b.mimeType,
            sizeBytes: Math.floor((b.data.length * 3) / 4),
          });
        }
      }
      pending.text = text;
      pending.attachments = attachments;
    }
    if (screenRef && dispatcherRef) {
      refreshQueueDisplay();
    }
  });
  conn.onNotification("hydra-acp/prompt_queue_removed", (params) => {
    if (teardownStarted) return;
    const p = (params ?? {}) as { messageId?: unknown; reason?: unknown };
    if (typeof p.messageId !== "string") return;
    // reason === "started" → this messageId is now the in-flight head.
    // Universal signal that reaches the originator too, unlike
    // prompt_received which excludes them. Used as targetMessageId for
    // Shift+Enter amend.
    if (p.reason === "started") {
      currentHeadMessageId = p.messageId;
    }
    // Cancel any deferred amend-chip paint so a fast-case amend doesn't
    // flash a chip after the remove notification has already arrived.
    const pendingTimer = amendPendingPaintTimers.get(p.messageId);
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      amendPendingPaintTimers.delete(p.messageId);
    }
    const hadChip = queueCache.delete(p.messageId);
    if (hadChip && screenRef && dispatcherRef) {
      refreshQueueDisplay();
    }
    // If this is one of our own deferred echoes, decide what to do based
    // on the reason: started → flush user-text to scrollback (the
    // prompt is actually being forwarded upstream now); cancelled or
    // abandoned → drop silently (it never ran, so it shouldn't appear
    // in scrollback at all).
    const echo = ownPendingByMid.get(p.messageId);
    if (echo) {
      ownPendingByMid.delete(p.messageId);
      if (p.reason === "started") {
        echo.flushed = true;
        appendRender({
          kind: "user-text",
          text: echo.text,
          attachments: echo.attachments,
        });
        // applyRenderEvent's user-text handler clears currentTurnEcho
        // back to null (so peer/replay user-texts don't claim our
        // echo's ownership). Re-stamp it here, after the synchronous
        // render, so runPrompt's finally can recognize that this echo
        // still owns the live tools block.
        currentTurnEcho = echo;
      }
    }
  });

  // Sibling client answered the permission first (or the daemon synthesized
  // a cancellation on disconnect). Reconstruct the JSON-RPC response shape
  // the modal expects from the update's `outcome` (preferred) or
  // `chosenOptionId` so the awaiting Promise resolves cleanly.
  conn.onNotification("hydra-acp/prompt_amended", (params) => {
    if (teardownStarted) return;
    const p = (params ?? {}) as { cancelledMessageId?: unknown };
    if (typeof p.cancelledMessageId !== "string") return;
    const cancelledId = p.cancelledMessageId;
    amendedMessageIds.add(cancelledId);
    // If the cancelled prompt is our own current turn, synthesize the
    // turn-complete immediately so the tools block freeze uses "amended"
    // before M2's prompt_queue_removed{started} arrives and triggers
    // the user-text handler's plain freeze (which has no stopReason and
    // ends up reading as "took Xs"). The wire order guarantees this
    // notification precedes M2's started — both are emitted from inside
    // broadcastTurnComplete and the next-iteration of drainQueue with
    // no microtask hop between them, but a multi-step async chain
    // separates them from M1's session/prompt response. runPrompt's
    // finally sees currentTurnEcho === null after this and skips its
    // own synth, so there's no double-render.
    if (
      currentTurnEcho !== null &&
      currentTurnEcho.messageId !== undefined &&
      currentTurnEcho.messageId === cancelledId
    ) {
      appendRender({
        kind: "turn-complete",
        stopReason: "cancelled",
        amended: true,
      });
      currentTurnEcho = null;
      amendedMessageIds.delete(cancelledId);
    }
  });

  const handlePermissionResolved = (update: unknown): void => {
    const u = (update ?? {}) as {
      toolCallId?: unknown;
      chosenOptionId?: unknown;
      outcome?: unknown;
    };
    const toolCallId =
      typeof u.toolCallId === "string" ? u.toolCallId : undefined;
    let outcome: unknown;
    if (u.outcome && typeof u.outcome === "object") {
      outcome = u.outcome;
    } else if (typeof u.chosenOptionId === "string") {
      outcome = { kind: "selected", optionId: u.chosenOptionId };
    }
    const result = outcome ? { outcome } : undefined;
    dismissPermissionExternally(toolCallId, result);
  };

  // Permission requests are handled with a modal in the prompt area. While
  // one is pending: ↑/↓ navigate options, Enter submits, Esc cancels, and
  // 1..9 are quick-pick shortcuts.
  type PermissionOption = {
    optionId: string;
    name: string;
    kind?: string;
  };
  let pendingPermission:
    | {
        title: string;
        options: PermissionOption[];
        selectedIndex: number;
        resolve: (result: unknown) => void;
        toolCallId: string | undefined;
      }
    | null = null;

  // Tear down the modal because someone/something else answered the
  // permission (sibling client, or agent already moved the toolCall off
  // "pending"). Resolves the awaited Promise so the JSON-RPC layer sends
  // a response back — the daemon already settled the original request,
  // so this response is silently dropped on its end.
  const dismissPermissionExternally = (
    toolCallId: string | undefined,
    result: unknown,
  ): void => {
    if (!pendingPermission) {
      return;
    }
    if (
      pendingPermission.toolCallId &&
      toolCallId &&
      pendingPermission.toolCallId !== toolCallId
    ) {
      return;
    }
    const resolve = pendingPermission.resolve;
    pendingPermission = null;
    screen.setPermissionPrompt(null);
    resolve(result ?? { outcome: { outcome: "cancelled" } });
    // The modal vanishing is signal enough; the tool-call row will update
    // to running/completed/failed on the next status change, so we don't
    // need a sticky scrollback line announcing the resolution.
  };

  // Fallback for the case where permission_resolved didn't arrive:
  // if the agent emits a tool_call/tool_call_update for our pending
  // permission's toolCallId in any non-pending state, the decision was
  // clearly made elsewhere — clear the modal.
  const maybeDismissPermissionByToolUpdate = (update: unknown): void => {
    if (!pendingPermission?.toolCallId) {
      return;
    }
    const u = (update ?? {}) as {
      sessionUpdate?: string;
      toolCallId?: string;
      status?: string;
    };
    if (u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update") {
      return;
    }
    if (u.toolCallId !== pendingPermission.toolCallId) {
      return;
    }
    if (!u.status || u.status === "pending") {
      return;
    }
    dismissPermissionExternally(u.toolCallId, undefined);
  };

  const refreshPermissionPrompt = (): void => {
    if (!pendingPermission) {
      screen.setPermissionPrompt(null);
      return;
    }
    screen.setPermissionPrompt({
      title: pendingPermission.title,
      options: pendingPermission.options.map((o) => ({ label: o.name })),
      selectedIndex: pendingPermission.selectedIndex,
    });
  };

  const resolvePermission = (optionId: string | null): void => {
    if (!pendingPermission) {
      return;
    }
    const { options, resolve } = pendingPermission;
    pendingPermission = null;
    screen.setPermissionPrompt(null);
    // The tool-call row updates to "running" / "done" / "failed" in
    // response to the decision, so a separate "✓ Allow" or "✗ Reject"
    // line in scrollback is redundant and sticky-feeling. Just dismiss
    // the modal and let the tool row carry the outcome.
    if (optionId === null) {
      resolve({ outcome: { outcome: "cancelled" } });
      return;
    }
    resolve({ outcome: { outcome: "selected", optionId } });
    // options is unused now that we don't echo the chosen label, but
    // keep the destructure to assert pendingPermission's shape.
    void options;
  };

  conn.onRequest("session/request_permission", async (params) => {
    if (teardownStarted) {
      // Detaching — punt the decision back to the daemon so it can route
      // to a peer or treat us as gone, instead of stranding the agent.
      return { outcome: { outcome: "cancelled" } };
    }
    const p = (params ?? {}) as {
      toolCall?: { name?: string; title?: string; toolCallId?: string };
      options?: PermissionOption[];
    };
    const rawOptions = Array.isArray(p.options) ? p.options : [];
    // Sanitize agent-controlled strings before they reach the renderer.
    // Modal title + option labels each render in a single FormattedLine
    // body, so a `\n` in either would line-feed the cursor out of the
    // paint region — use sanitizeSingleLine to collapse newlines.
    const options: PermissionOption[] = rawOptions.map((o) => ({
      optionId: o.optionId,
      name: sanitizeSingleLine(o.name ?? ""),
      ...(o.kind !== undefined ? { kind: o.kind } : {}),
    }));
    const rawTitle = p.toolCall?.title ?? p.toolCall?.name ?? "tool";
    const title = sanitizeSingleLine(rawTitle);
    const toolCallId = p.toolCall?.toolCallId;
    if (options.length === 0) {
      screen.appendLines([
        {
          prefix: "🔒 ",
          body: `Permission requested · ${title} · (no options offered, cancelling)`,
          bodyStyle: "tool-status-fail",
        },
      ]);
      return { outcome: { outcome: "cancelled" } };
    }
    return new Promise<unknown>((resolve) => {
      pendingPermission = {
        title,
        options,
        selectedIndex: 0,
        resolve,
        toolCallId,
      };
      refreshPermissionPrompt();
    });
  });

  conn.setDefaultHandler(async () => {
    return { error: { code: -32601, message: "method not implemented" } };
  });

  let upstreamSessionId: string | undefined;
  let agentInfoName: string | undefined;
  // Defaults to true: the daemon advertises image support and forwards
  // blocks unchanged; an old agent that explicitly says image=false
  // flips this and gates the chip/clipboard UI.
  let agentAcceptsImages = true;
  // Set from the initialize response's hydra-acp _meta. Gates the
  // Shift+Enter affordance — without daemon support the chord falls
  // through to plain session/prompt.
  let daemonSupportsAmend = false;
  try {
    const initResult = (await conn.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "hydra-acp-tui", version: HYDRA_VERSION },
    })) as {
      agentInfo?: { name?: string };
      agentCapabilities?: {
        promptCapabilities?: { image?: boolean };
      };
      _meta?: Record<string, unknown>;
    };
    agentInfoName = initResult?.agentInfo?.name;
    const imageCap =
      initResult?.agentCapabilities?.promptCapabilities?.image;
    if (imageCap === false) {
      agentAcceptsImages = false;
    }
    const hydraMeta = extractHydraMeta(initResult?._meta ?? undefined);
    daemonSupportsAmend = hydraMeta.promptAmending === true;
  } catch {
    // initialize is optional from the daemon's perspective; proceed regardless.
  }

  let resolvedSessionId = ctx.sessionId;
  let resolvedAgentId = ctx.agentId;
  let resolvedCwd = ctx.cwd;
  let resolvedTitle: string | undefined;
  // Captured from the session/new or session/attach response. Used to
  // filter prompt_queue_added events for entries that originated from
  // this TUI so the deferred-echo plumbing can bind a local pending
  // entry to the messageId hydra minted.
  let ownClientId: string | undefined;
  let initialModel: string | undefined;
  let initialMode: string | undefined;
  let initialCommands: AvailableCommand[] | undefined;
  let initialModes: AvailableMode[] | undefined;
  // Snapshot of the daemon-owned prompt queue at attach time. Lets the
  // chip row paint stale-but-correct queue state right after the
  // dispatcher is constructed, without waiting for new
  // prompt_queue_added notifications to arrive on the wire.
  let initialQueue: PromptQueueEntry[] | undefined;
  // Last-known usage at attach time, surfaced by the daemon's meta so the
  // sessionbar can show tokens/cost immediately on reopen rather than
  // waiting for the next live usage_update event.
  let initialUsage: SessionListUsage | undefined;
  // Epoch-ms of an in-flight turn at attach time, surfaced by the daemon
  // when we reattach mid-turn. Lets the post-drain reconcile flip the
  // banner to busy and start the elapsed timer at the right offset.
  let initialTurnStartedAt: number | undefined;
  if (ctx.sessionId === "__new__") {
    const hydraNewMeta: Record<string, unknown> = {};
    if (opts.name) {
      hydraNewMeta.name = opts.name;
    }
    if (opts.model) {
      hydraNewMeta.model = opts.model;
    }
    const created = (await conn.request("session/new", {
      cwd: ctx.cwd,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(Object.keys(hydraNewMeta).length > 0
        ? { _meta: { [HYDRA_META_KEY]: hydraNewMeta } }
        : {}),
    })) as {
      sessionId: string;
      clientId?: string;
      _meta?: Record<string, unknown>;
    };
    resolvedSessionId = created.sessionId;
    if (created.clientId) {
      ownClientId = created.clientId;
    }
    exitHint.sessionId = resolvedSessionId;
    exitHint.readonly = false;
    const hydraMeta = extractHydraMeta(created._meta ?? undefined);
    upstreamSessionId = hydraMeta.upstreamSessionId;
    if (hydraMeta.agentId) {
      resolvedAgentId = hydraMeta.agentId;
    }
    if (hydraMeta.cwd) {
      resolvedCwd = hydraMeta.cwd;
    }
    if (hydraMeta.name) {
      resolvedTitle = hydraMeta.name;
    }
    initialModel = hydraMeta.currentModel;
    initialMode = hydraMeta.currentMode;
    initialUsage = hydraMeta.currentUsage;
    initialTurnStartedAt = hydraMeta.turnStartedAt;
    if (hydraMeta.availableCommands) {
      initialCommands = normalizeAdvertisedCommands(hydraMeta.availableCommands);
    }
    if (hydraMeta.availableModes) {
      initialModes = hydraMeta.availableModes;
    }
    initialQueue = hydraMeta.queue;
  } else {
    const attached = (await conn.request("session/attach", {
      sessionId: ctx.sessionId,
      historyPolicy: "full",
      clientInfo: { name: "hydra-acp-tui", version: HYDRA_VERSION },
      ...(opts.readonly === true ? { readonly: true } : {}),
      // Forward the user-chosen cwd for first-launch imported sessions
      // via a full resume hint. upstreamSessionId is empty so the
      // daemon routes through doResurrectFromImport (session-manager.ts)
      // with the user-supplied cwd instead of silently falling back to
      // $HOME in resolveImportCwd.
      ...(ctx.importAttachHint !== undefined
        ? {
            _meta: {
              [HYDRA_META_KEY]: {
                resume: {
                  upstreamSessionId: "",
                  agentId: ctx.importAttachHint.agentId,
                  cwd: ctx.importAttachHint.cwd,
                },
              },
            },
          }
        : {}),
    })) as {
      sessionId: string;
      clientId?: string;
      _meta?: Record<string, unknown>;
    };
    resolvedSessionId = attached.sessionId;
    if (attached.clientId) {
      ownClientId = attached.clientId;
    }
    exitHint.sessionId = resolvedSessionId;
    exitHint.readonly = opts.readonly === true;
    const hydraMeta = extractHydraMeta(attached._meta ?? undefined);
    upstreamSessionId = hydraMeta.upstreamSessionId;
    if (hydraMeta.agentId) {
      resolvedAgentId = hydraMeta.agentId;
    }
    if (hydraMeta.cwd) {
      resolvedCwd = hydraMeta.cwd;
    }
    if (hydraMeta.name) {
      resolvedTitle = hydraMeta.name;
    }
    initialModel = hydraMeta.currentModel;
    initialMode = hydraMeta.currentMode;
    initialUsage = hydraMeta.currentUsage;
    initialTurnStartedAt = hydraMeta.turnStartedAt;
    if (hydraMeta.availableCommands) {
      initialCommands = normalizeAdvertisedCommands(hydraMeta.availableCommands);
    }
    if (hydraMeta.availableModes) {
      initialModes = hydraMeta.availableModes;
    }
    initialQueue = hydraMeta.queue;
  }

  const historyFile = paths.tuiHistoryFile(resolvedSessionId);
  const globalHistoryFile = paths.globalTuiHistoryFile();
  let history = await loadHistory(historyFile).catch(() => []);
  let globalHistory = await loadHistory(globalHistoryFile).catch(() => []);
  // The global file is append-only, so a long-lived install may grow
  // past the cap on disk. Tail it once at load so the in-memory view
  // (and any dispatcher walk we build from it) stays bounded.
  if (globalHistory.length > config.tui.promptHistoryMaxEntries) {
    globalHistory = globalHistory.slice(globalHistory.length - config.tui.promptHistoryMaxEntries);
  }
  const dispatcher = new InputDispatcher({
    history: buildCombinedHistory(globalHistory, history),
  });
  dispatcherRef = dispatcher;
  // Gates recording of peer user-text events into prompt history.
  // Flipped to true after the initial attach-replay drain completes —
  // before that, replayed user-text events get folded in via a single
  // set-deduped merge so reattaches don't pile up duplicates of past
  // prompts the daemon replayed again.
  let livePeerHistoryRecording = false;
  // Funnel: every place a new prompt becomes part of history goes
  // through here so the per-session list, the global list, the
  // dispatcher view, and both files stay in sync.
  const recordHistoryEntry = (entry: string): void => {
    const trimmed = entry.replace(/\n+$/, "");
    if (trimmed.length === 0) {
      return;
    }
    const nextSession = appendEntry(history, trimmed);
    const sessionChanged = nextSession !== history;
    history = nextSession;
    const nextGlobal = appendEntry(globalHistory, trimmed, config.tui.promptHistoryMaxEntries);
    const globalChanged = nextGlobal !== globalHistory;
    globalHistory = nextGlobal;
    dispatcher.setHistory(buildCombinedHistory(globalHistory, history));
    if (sessionChanged) {
      saveHistory(historyFile, history).catch(() => undefined);
    }
    if (globalChanged) {
      appendHistoryLine(globalHistoryFile, trimmed).catch(() => undefined);
    }
  };
  // Replay catch-up: history replay may have already incremented
  // pendingTurns before the dispatcher existed (notification handler
  // skips the dispatcher call when dispatcherRef is null). If we're
  // attaching mid-turn, propagate that state now so ^C correctly maps
  // to cancel instead of falling through to exit.
  if (pendingTurns > 0) {
    dispatcher.setTurnRunning(true);
  }

  let turnInFlight: {
    text: string;
    attachments: Attachment[];
    cancel: () => void;
  } | null = null;
  // Text + chips staged by an Escape cancel: applied to the prompt
  // buffer when the worker drains, but only if the buffer is still
  // empty (so we never clobber something the user typed in the
  // meantime).
  let pendingPrefill: { text: string; attachments: Attachment[] } | null =
    null;

  const screen: Screen = new Screen({
    term,
    dispatcher,
    repaintThrottleMs: config.tui.repaintThrottleMs,
    maxScrollbackLines: config.tui.maxScrollbackLines,
    mouse: config.tui.mouse,
    progressIndicator: config.tui.progressIndicator,
    readonly: opts.readonly === true,
    onKey: (events: KeyEvent[]) => {
      for (const ev of events) {
        if (pendingPermission && tryHandlePermissionKey(ev)) {
          continue;
        }
        if (exitConfirmation && tryHandleExitConfirmKey(ev)) {
          continue;
        }
        if (tryHandleHelpKey(ev)) {
          continue;
        }
        if (tryHandleScrollbackSearchKey(ev)) {
          continue;
        }
        if (tryHandleCompletionKey(ev)) {
          continue;
        }
        // Drag-and-drop file paths are intercepted before the
        // dispatcher sees them — they're not text edits, they're an
        // async file-read that ends in addAttachment().
        if (ev.type === "attachment-paths") {
          void handleAttachmentPaths(ev.paths);
          continue;
        }
        const effects = dispatcher.feed(ev);
        for (const effect of effects) {
          // Read-only mode: drop effects that mutate session state
          // (send, amend, queue-edit/remove, plan-toggle,
          // attachment-request). Navigation, search, exit, redraw,
          // ^P switch-session, ^T next-live, ^R escalate-search,
          // ^D exit, ^C cancel — all pass through. The dispatcher
          // still owns text accumulation for its internal buffer,
          // but since the composer never renders (promptRows()
          // returns 0 in readonly mode), the typed characters are
          // invisible and the user can't fire send anyway. The
          // daemon's deny check is the safety net for any effect
          // that does slip through to a state-changing JSON-RPC.
          if (opts.readonly === true && isReadonlyForbiddenEffect(effect)) {
            continue;
          }
          handleEffect(effect);
        }
      }
      refreshCompletions();
      // Surface the prompt-history reverse-search query (when one is
      // engaged) in the banner's right slot — it's otherwise invisible
      // since the prompt area shows only the matched history entry.
      screen.setBannerSearchIndicator(
        dispatcher.state().historySearchQuery,
      );
      screen.setAttachments(dispatcher.state().attachments);
      screen.refreshPrompt();
    },
  });
  // Make Screen visible to closures that can run during the attach
  // handshake (notably adjustPendingTurns via conn.onNotification).
  screenRef = screen;

  // Slash-command completion. Built-ins listed here are TUI-only verbs
  // handled locally in handleBuiltinCommand (so they never reach the
  // daemon). /hydra verbs and the agent's own commands both arrive via
  // available_commands_update — the daemon merges its /hydra registry
  // with whatever the agent advertises, so we just consume that channel.
  const builtinCommands: AvailableCommand[] = [
    { name: "/help", description: "Show TUI built-in commands" },
    { name: "/quit", description: "Exit the TUI" },
    { name: "/clear", description: "Clear scrollback" },
    { name: "/sessions", description: "List sessions" },
    { name: "/model", description: "Switch model: /model <model-id>" },
    { name: "/demo-plan", description: "Inject synthetic plan events (UI test)" },
    { name: "/demo-tool", description: "Inject a synthetic tool-call sequence (UI test)" },
  ];
  // Seeded from the attach/new response _meta so the slash-completion
  // palette is populated before any history replay or live update.
  let agentCommands: AvailableCommand[] = initialCommands ?? [];
  // Available modes advertised by the agent. Used by Shift+Tab to cycle.
  let agentModes: AvailableMode[] = initialModes ?? [];

  const allCommands = (): AvailableCommand[] => {
    const seen = new Set<string>();
    const out: AvailableCommand[] = [];
    for (const c of [...builtinCommands, ...agentCommands]) {
      if (seen.has(c.name)) {
        continue;
      }
      seen.add(c.name);
      out.push(c);
    }
    return out;
  };

  const currentCompletions = (): AvailableCommand[] => {
    const buf = dispatcher.state().buffer;
    const firstLine = buf[0] ?? "";
    if (!firstLine.startsWith("/")) {
      return [];
    }
    const space = firstLine.indexOf(" ");
    const prefix = space === -1 ? firstLine : firstLine.slice(0, space);
    const matches = allCommands().filter((c) => c.name.startsWith(prefix));
    // If the user has typed an exact command name (no args yet), don't
    // bother showing a single-element list — they're done picking.
    if (
      matches.length === 1 &&
      matches[0]?.name === prefix &&
      space === -1
    ) {
      return [];
    }
    return matches;
  };

  const refreshCompletions = (): void => {
    screen.setCompletions(currentCompletions());
  };

  const tryHandleCompletionKey = (ev: KeyEvent): boolean => {
    if (ev.type !== "key" || ev.name !== "tab") {
      return false;
    }
    const matches = currentCompletions();
    if (matches.length === 0) {
      return false;
    }
    const firstLine = dispatcher.state().buffer[0] ?? "";
    const next = computeTabCompletion({
      matches: matches.map((m) => m.name),
      firstLine,
    });
    if (next === null) {
      return true;
    }
    dispatcher.replaceFirstLine(next);
    return true;
  };

  // Scrollback reverse-search: ^r while scrolled back engages a search
  // overlay in the prompt area; subsequent ^r advances to the older match;
  // chars build the term; backspace edits it; ESC/^c cancels (restoring
  // baseline scroll); Enter accepts (keeping viewport on current match).
  // While search is active this predicate owns every keystroke so the
  // dispatcher / completion paths can't see them. Returns false when the
  // event isn't ours to handle (so normal routing continues).
  const tryHandleScrollbackSearchKey = (ev: KeyEvent): boolean => {
    if (!screen.isScrollbackSearchActive()) {
      // Not in search mode — only ^r when scrolled back kicks us in.
      if (ev.type === "key" && ev.name === "ctrl-r" && screen.isScrolledBack()) {
        screen.enterScrollbackSearch();
        screen.updateScrollbackSearchTerm("");
        return true;
      }
      return false;
    }
    // In search mode: own every key.
    if (ev.type === "char") {
      const term = screen.scrollbackSearchTerm() + ev.ch;
      screen.updateScrollbackSearchTerm(term);
      return true;
    }
    if (ev.type === "paste") {
      const term = screen.scrollbackSearchTerm() + ev.text.replace(/\n/g, " ");
      screen.updateScrollbackSearchTerm(term);
      return true;
    }
    if (ev.type === "key") {
      switch (ev.name) {
        case "ctrl-r":
          screen.advanceScrollbackSearch();
          return true;
        case "ctrl-s":
          screen.retreatScrollbackSearch();
          return true;
        case "backspace": {
          const term = screen.scrollbackSearchTerm();
          if (term.length === 0) {
            screen.cancelScrollbackSearch();
          } else {
            screen.updateScrollbackSearchTerm(term.slice(0, -1));
          }
          return true;
        }
        case "enter":
          screen.acceptScrollbackSearch();
          return true;
        case "escape":
        case "ctrl-c":
          screen.cancelScrollbackSearch();
          return true;
        default:
          // Swallow everything else so a stray arrow doesn't fall through
          // to the prompt dispatcher behind the overlay.
          return true;
      }
    }
    return true;
  };

  // While a permission is pending the modal owns input: arrow keys navigate,
  // Enter submits, Esc cancels, 1–9 are quick-pick shortcuts. All other
  // keys are dropped so the user can't draft a prompt mid-decision.
  const tryHandlePermissionKey = (ev: KeyEvent): boolean => {
    if (!pendingPermission) {
      return false;
    }
    const opts = pendingPermission.options;
    if (ev.type === "key") {
      switch (ev.name) {
        case "up":
          pendingPermission.selectedIndex = Math.max(
            0,
            pendingPermission.selectedIndex - 1,
          );
          refreshPermissionPrompt();
          return true;
        case "down":
          pendingPermission.selectedIndex = Math.min(
            opts.length - 1,
            pendingPermission.selectedIndex + 1,
          );
          refreshPermissionPrompt();
          return true;
        case "enter": {
          const opt = opts[pendingPermission.selectedIndex];
          if (opt) {
            resolvePermission(opt.optionId);
          }
          return true;
        }
        case "escape":
        case "ctrl-c":
          resolvePermission(null);
          return true;
        default:
          return true;
      }
    }
    if (ev.type === "char" && /^[1-9]$/.test(ev.ch)) {
      const idx = parseInt(ev.ch, 10) - 1;
      const opt = opts[idx];
      if (opt) {
        resolvePermission(opt.optionId);
      }
      return true;
    }
    // Swallow anything else so it doesn't land in the prompt buffer behind
    // the modal.
    return true;
  };

  const sessionbarAgent = resolvedAgentId || agentInfoName || "?";
  // Running usage snapshot — seeded from the daemon's attach _meta so the
  // sessionbar shows tokens/cost immediately on reopen, then merged in
  // place by the usage-update event handler.
  const usage: SessionListUsage = { ...(initialUsage ?? {}) };
  // The install / attach is done; release the pre-screen status line
  // before the alt-screen switch so any trailing OSC 9;4 progress
  // pulse is cleared on terminals that latch it across screens.
  installStatus.finalize();
  // runTuiApp engages the alt screen for the lifetime of the TUI
  // (so the picker lives in there too); skip the per-session toggle.
  screen.start({ skipFullscreen: true });
  screen.setHideThoughts(!viewPrefs.showThoughts);
  screen.setSessionbar({
    agent: sessionbarAgent,
    cwd: resolvedCwd,
    sessionId: resolvedSessionId,
    title: resolvedTitle,
    model: initialModel,
    usage: { ...usage },
  });
  // Surface initial snapshot state (delivered via _meta on attach) so a
  // late-joining or cold-resurrected client sees the current mode
  // immediately. The banner shows it; no need to also write it into
  // scrollback (that would re-noise every session start).
  if (initialMode) {
    screen.setBanner({ currentMode: initialMode });
  }
  void getPendingUpdate().then((info) => {
    if (info) {
      screen.notify(`✨ ${formatUpdateNoticeLine(info)}`, 30_000);
    }
  });

  let finishSession: ((next: TuiOptions | null) => void) | null = null;
  const sessionDone = new Promise<TuiOptions | null>((resolve) => {
    finishSession = resolve;
  });
  // Send session/cancel to the daemon when the turn isn't ours to settle
  // locally. `turnInFlight` is only set for turns this TUI initiated; on
  // reattach mid-turn, or for a peer-initiated turn, it stays null while
  // pendingTurns > 0. Sending cancel directly still works — the daemon
  // forwards it to the agent regardless of which client started the turn.
  const cancelRemoteTurn = (): void => {
    conn
      .notify("session/cancel", { sessionId: resolvedSessionId })
      .catch(() => undefined);
  };
  const sigintHandler = (): void => {
    if (turnInFlight) {
      turnInFlight.cancel();
      return;
    }
    if (pendingTurns > 0) {
      cancelRemoteTurn();
      return;
    }
    void requestExit();
  };

  // Pending interrupt-before-exit modal, if one is showing. Set by
  // requestExit when the user tries to leave during a turn that no other
  // client is observing — handled inline by tryHandleExitConfirmKey.
  let exitConfirmation: { offered: true } | null = null;

  // Mediated quit. If a turn is mid-flight and no peer client is watching,
  // pop a "interrupt or just detach?" modal so the user isn't unknowingly
  // leaving an agent running for nobody. Otherwise (no turn, or peers
  // attached) just exit silently as before.
  const requestExit = async (): Promise<void> => {
    if (exitConfirmation) {
      // Modal already up — second exit attempt collapses to a silent quit.
      stop(0);
      return;
    }
    if (pendingTurns === 0) {
      stop(0);
      return;
    }
    let onlyClient = false;
    try {
      const sessions = await listSessions(target);
      const me = sessions.find((s) => s.sessionId === resolvedSessionId);
      onlyClient = !me || me.attachedClients <= 1;
    } catch {
      // If the daemon is unreachable, the user almost certainly wants to
      // bail. Default to silent exit rather than block on the network.
      stop(0);
      return;
    }
    if (!onlyClient) {
      stop(0);
      return;
    }
    exitConfirmation = { offered: true };
    screen.setConfirmPrompt({
      question: "Agent is still working. Interrupt it before exit?",
      hint: "y interrupt then exit · n / Enter detach silently · Esc cancel",
    });
  };

  const dismissExitConfirmation = (): void => {
    exitConfirmation = null;
    screen.setConfirmPrompt(null);
  };

  const tryHandleExitConfirmKey = (ev: KeyEvent): boolean => {
    if (!exitConfirmation) {
      return false;
    }
    if (ev.type === "char") {
      const ch = ev.ch.toLowerCase();
      if (ch === "y") {
        dismissExitConfirmation();
        conn
          .notify("session/cancel", { sessionId: resolvedSessionId })
          .catch(() => undefined);
        stop(0);
        return true;
      }
      if (ch === "n") {
        dismissExitConfirmation();
        stop(0);
        return true;
      }
      // Any other char is a no-op so a fat-finger doesn't accidentally
      // confirm or cancel a destructive action.
      return true;
    }
    if (ev.type === "key") {
      if (ev.name === "enter") {
        // Default to the safe option: detach silently.
        dismissExitConfirmation();
        stop(0);
        return true;
      }
      if (ev.name === "escape") {
        // Esc backs out of the modal so the user can keep working.
        dismissExitConfirmation();
        return true;
      }
      if (ev.name === "ctrl-c" || ev.name === "ctrl-d") {
        // Treat a second exit signal as "yes, get me out" — silent
        // detach (not interrupt) so we don't surprise-kill the agent.
        dismissExitConfirmation();
        stop(0);
        return true;
      }
    }
    return true;
  };
  // Open or close the global hotkey cheatsheet (^G). Toggling lets the
  // same key dismiss it without a second binding.
  const buildHelpEntries = (): ReadonlyArray<
    readonly [string, string] | null
  > => {
    const enqueueDesc = "enqueue prompt (sends now, or queues during a turn)";
    const amendDesc = "amend the in-flight turn (cancel + replace)";
    // Ctrl+Enter leads — it works universally (bare LF byte), unlike
    // Shift+Enter which depends on modifyOtherKeys / kitty-protocol
    // support that some terminals (libvte / gnome-terminal pre-0.78)
    // don't have.
    const head: Array<readonly [string, string] | null> =
      config.tui.defaultEnterAction === "amend"
        ? [
            ["Enter", amendDesc],
            ["Ctrl+Enter / Shift+Enter / ^S", enqueueDesc],
          ]
        : [
            ["Enter", enqueueDesc],
            ["Ctrl+Enter / Shift+Enter / ^S", amendDesc],
          ];
    return [...head, ...HELP_ENTRIES_TAIL];
  };

  const toggleHelpModal = (): void => {
    if (screen.isHelpPromptActive()) {
      screen.setHelpPrompt(null);
      return;
    }
    screen.setHelpPrompt({
      title: "Hotkeys",
      entries: buildHelpEntries(),
      hint: "any key dismisses · /help lists commands",
    });
  };

  const tryHandleHelpKey = (ev: KeyEvent): boolean => {
    if (!screen.isHelpPromptActive()) {
      return false;
    }
    // Treat any key (other than re-pressing ^G, which toggles via the
    // dispatcher path) as dismissal. Swallow all input so a stray
    // keystroke can't leak into the prompt buffer behind the modal.
    if (ev.type === "key" && ev.name === "ctrl-g") {
      screen.setHelpPrompt(null);
      return true;
    }
    screen.setHelpPrompt(null);
    return true;
  };

  const teardown = (): void => {
    // Set first so any inbound notification/request that lands between
    // here and stream.close() bails before touching the screen.
    teardownStarted = true;
    process.off("SIGINT", sigintHandler);
    // The elapsed-time setInterval ticks every second and calls
    // screen.setBanner(), which writes raw cursor-position escapes to
    // stdout. Left running, it both keeps the event loop alive (so the
    // process never exits) and scrambles the host shell after we've
    // left the alternate screen.
    if (sessionElapsedTimer !== null) {
      clearInterval(sessionElapsedTimer);
      sessionElapsedTimer = null;
    }
    screen.clearWindowTitle();
    // runTuiApp owns alt-screen entry/exit for the whole TUI lifetime,
    // so don't toggle fullscreen here — that's done after the outer
    // runSession loop returns.
    screen.stop({ keepFullscreen: true });
    saveHistory(historyFile, history).catch(() => undefined);
    void stream.close().catch(() => undefined);
  };
  const stop = (code = 0): void => {
    teardown();
    if (finishSession) {
      finishSession(null);
      finishSession = null;
    }
    if (code !== 0) {
      process.exit(code);
    }
  };

  const switchSession = async (): Promise<void> => {
    if (!finishSession) {
      return;
    }
    // If the user has half-typed text in the prompt, snapshot it into
    // history before opening the picker. Picking a different session
    // tears down the dispatcher and loses the draft; even on abort the
    // user gets up-arrow recall.
    const pendingDraft = dispatcher.state().buffer.join("\n");
    if (pendingDraft.replace(/\s+$/, "").length > 0) {
      recordHistoryEntry(pendingDraft);
    }
    // Suspend the live screen but keep the daemon stream (and SIGINT
    // handler) alive — that way an aborted picker drops us right back
    // in the current session without a reconnect or history replay.
    // Updates that arrive while the picker is up land in the Screen's
    // in-memory state; repaints are deferred until we resume.
    // keepFullscreen=true: stay in the alt-screen buffer across the
    // picker round-trip so the user doesn't see a frame of the host
    // shell's main buffer flash between the live session tearing down
    // and the picker painting from row 1. The picker's moveTo(1,1) +
    // eraseDisplayBelow simply overwrites the alt-screen buffer the
    // live session was using; on return, screen.start() clears its
    // row-sig cache and repaints over the picker content.
    screen.pauseRepaint();
    screen.stop({ keepFullscreen: true });
    saveHistory(historyFile, history).catch(() => undefined);
    // Loop: the imported-first-launch action dialog's Esc returns
    // "back" to re-show the picker, same as the initial-picker flow.
    // Picker abort exits the loop and resumes the live session.
    let resolvedChoice: { choice: PickerResult; sessions: DiscoveredSession[] } | null = null;
    let attachOverrides: { readonly?: boolean; cwd?: string; importAttachHint?: { agentId: string; cwd: string } } | null = null;
    while (resolvedChoice === null) {
      const sessions = await listSessions(target);
      const choice: PickerResult = await pickSession(term, {
        cwd: resolvedCwd,
        sessions,
        config,
        target,
        currentSessionId: resolvedSessionId,
        prefs: pickerPrefs,
      });
      if (choice.kind === "abort") {
        // Pair with stop({ keepFullscreen: true }) above — we never left
        // the alt screen buffer, so don't re-emit fullscreen(true).
        screen.start({ skipFullscreen: true });
        screen.resumeRepaint();
        return;
      }
      if (choice.kind === "new") {
        resolvedChoice = { choice, sessions };
        break;
      }
      // attach: route imported-first-launch picks through the action /
      // cwd wizard. cancel aborts the switch (resume live session);
      // back loops to re-show the picker.
      const chosen = sessions.find((s) => s.sessionId === choice.sessionId);
      const isImportedFirstLaunch =
        chosen !== undefined &&
        !!chosen.importedFromMachine &&
        !chosen.upstreamSessionId &&
        choice.readonly !== true;
      if (!isImportedFirstLaunch) {
        resolvedChoice = { choice, sessions };
        break;
      }
      // Use a local opts shim so the helper can flip readonly without
      // mutating the live session's opts (which still owns the current
      // session). We translate the shim back into attachOverrides.
      const opsShim: TuiOptions = { ...opts, readonly: false };
      const decided = await runImportedFirstLaunchFlow(term, chosen, choice, opsShim);
      if (decided.kind === "cancel") {
        screen.start({ skipFullscreen: true });
        screen.resumeRepaint();
        return;
      }
      if (decided.kind === "back") {
        continue;
      }
      resolvedChoice = { choice, sessions };
      attachOverrides = {
        readonly: opsShim.readonly === true,
        cwd: decided.ctx.cwd,
      };
      if (decided.ctx.importAttachHint !== undefined) {
        attachOverrides.importAttachHint = decided.ctx.importAttachHint;
      }
    }
    const { choice } = resolvedChoice;
    // The user is actually switching: finish the teardown and let the
    // outer loop attach the chosen session.
    const resume = finishSession;
    finishSession = null;
    process.off("SIGINT", sigintHandler);
    void stream.close().catch(() => undefined);
    if (choice.kind === "new") {
      const { sessionId: _drop, ...rest } = opts;
      void _drop;
      // Fresh session is never read-only; explicitly clear so a viewer
      // that pressed ^P → New doesn't inherit readonly into the new
      // session's WS attach.
      const nextOpts: TuiOptions = {
        ...rest,
        cwd: resolvedCwd,
        forceNew: true,
        readonly: false,
      };
      if (choice.prompt !== undefined) {
        nextOpts.initialPrompt = choice.prompt;
      }
      resume(nextOpts);
      return;
    }
    // Read-only is per-session; default off on a picker-driven switch.
    // The picker's `v` keystroke and the action dialog's view option
    // are the only ways to re-enter read-only.
    if (choice.kind !== "attach") {
      // Unreachable — the loop only escapes on "attach" or "new", and
      // "new" returned above. Belt-and-suspenders for the type
      // narrowing.
      return;
    }
    const nextOpts: TuiOptions = {
      ...opts,
      sessionId: choice.sessionId,
      cwd: attachOverrides?.cwd ?? resolvedCwd,
      readonly: attachOverrides?.readonly ?? (choice.readonly === true),
    };
    if (choice.agentId !== undefined) {
      nextOpts.agentId = choice.agentId;
    }
    if (attachOverrides?.importAttachHint !== undefined) {
      nextOpts.importAttachHint = attachOverrides.importAttachHint;
    } else {
      // Clear any stale hint inherited from the current session's opts —
      // it was for the previous attach, not the new one.
      delete nextOpts.importAttachHint;
    }
    resume(nextOpts);
  };

  const cycleLiveSession = async (): Promise<void> => {
    if (!finishSession)
      return;
    const sessions = await listSessions(target);
    const live = sessions.filter((s) => s.status === "live");
    if (live.length <= 1)
      return;
    const idx = live.findIndex((s) => s.sessionId === resolvedSessionId);
    const next = live[(idx + 1) % live.length]!;
    const resume = finishSession;
    finishSession = null;
    process.off("SIGINT", sigintHandler);
    void stream.close().catch(() => undefined);
    // ^T cycles to another live session. Live sessions are by
    // definition agent-bound, so dropping any pending readonly state
    // matches what the user expects when bouncing between active work.
    const nextOpts: TuiOptions = {
      ...opts,
      sessionId: next.sessionId,
      cwd: resolvedCwd,
      readonly: false,
    };
    if (next.agentId !== undefined)
      nextOpts.agentId = next.agentId;
    resume(nextOpts);
  };

  const handleEffect = (effect: InputEffect): void => {
    switch (effect.type) {
      case "send":
        // config.tui.defaultEnterAction == "amend" swaps the meaning of
        // the two send routes: Enter goes through the amend path and
        // Shift+Enter enqueues. The dispatcher doesn't know about the
        // config; the swap happens here so the input layer stays a pure
        // state machine.
        if (config.tui.defaultEnterAction === "amend") {
          amendPrompt(effect.text, effect.attachments);
        } else {
          enqueuePrompt(effect.text, effect.attachments);
        }
        return;
      case "amend":
        if (config.tui.defaultEnterAction === "amend") {
          enqueuePrompt(effect.text, effect.attachments);
        } else {
          amendPrompt(effect.text, effect.attachments);
        }
        return;
      case "queue-edit": {
        const mid = queueMessageIdAt(effect.index);
        if (!mid) {
          return;
        }
        const blocks: Array<Record<string, unknown>> = [];
        if (effect.text.length > 0) {
          blocks.push({ type: "text", text: effect.text });
        }
        for (const a of effect.attachments) {
          blocks.push({ type: "image", data: a.data, mimeType: a.mimeType });
        }
        // Fire-and-forget the wire request; daemon broadcasts
        // prompt_queue_updated on success, which refreshes the chip.
        // If the entry started or got cancelled between Up-arrow and
        // Enter, hydra returns already_running / not_found — surface
        // those quietly so the user knows the edit didn't land.
        conn
          .request("hydra-acp/update_prompt", {
            sessionId: resolvedSessionId,
            messageId: mid,
            prompt: blocks,
          })
          .then((raw) => {
            const res = raw as UpdatePromptResult;
            if (!res.updated && res.reason !== "ok") {
              screen.notify(`queue edit skipped (${res.reason})`);
            }
          })
          .catch((err: Error) => {
            screen.notify(`queue edit failed: ${err.message}`);
          });
        return;
      }
      case "queue-remove": {
        const mid = queueMessageIdAt(effect.index);
        if (!mid) {
          return;
        }
        conn
          .request("hydra-acp/cancel_prompt", {
            sessionId: resolvedSessionId,
            messageId: mid,
          })
          .then((raw) => {
            const res = raw as CancelPromptResult;
            if (!res.cancelled && res.reason !== "ok") {
              screen.notify(`queue cancel skipped (${res.reason})`);
            }
          })
          .catch((err: Error) => {
            screen.notify(`queue cancel failed: ${err.message}`);
          });
        return;
      }
      case "cancel": {
        // Escape (prefill=true) wants the cancelled prompt put back into
        // the buffer so the user can edit and resubmit — but only when
        // nothing else is queued behind it and the buffer is empty (we
        // never overwrite text the user has typed). Plain ^C skips this.
        if (effect.prefill && turnInFlight) {
          const waitingEmpty = queueCache.size === 0;
          const bufferEmpty = dispatcher
            .state()
            .buffer.every((line) => line === "");
          if (waitingEmpty && bufferEmpty) {
            pendingPrefill = {
              text: turnInFlight.text,
              attachments: turnInFlight.attachments,
            };
          }
        }
        if (turnInFlight) {
          turnInFlight.cancel();
        } else if (pendingTurns > 0) {
          cancelRemoteTurn();
        }
        // ^C stops only the in-flight turn. Queued prompts stay put —
        // the daemon's queue picks the next one up once the cancelled
        // turn settles. Use Up + ^C / Enter to drop a specific queued
        // entry via hydra-acp/cancel_prompt.
        return;
      }
      case "exit":
        void requestExit();
        return;
      case "plan-toggle":
        void handleModeToggle(effect.on);
        return;
      case "redraw-banner":
        screen.setBanner({});
        return;
      case "redraw":
        screen.fullRedraw();
        return;
      case "scroll-to-top":
        screen.scrollToTop();
        return;
      case "scroll-to-bottom":
        screen.scrollToBottom();
        return;
      case "switch-session":
        void switchSession();
        return;
      case "next-live-session":
        void cycleLiveSession();
        return;
      case "toggle-tools":
        toolsExpanded = !toolsExpanded;
        renderToolsBlock();
        return;
      case "toggle-thoughts":
        viewPrefs.showThoughts = !viewPrefs.showThoughts;
        screen.setHideThoughts(!viewPrefs.showThoughts);
        screen.notify(
          viewPrefs.showThoughts ? "thoughts shown" : "thoughts hidden",
        );
        return;
      case "toggle-mouse": {
        const next = !screen.isMouseEnabled();
        screen.setMouseEnabled(next);
        screen.notify(
          next
            ? "mouse capture on — wheel scrolls; shift+drag to select text"
            : "mouse capture off — click-drag selects text; PgUp/PgDn scrolls",
        );
        return;
      }
      case "show-help":
        toggleHelpModal();
        return;
      case "escalate-search":
        // Prompt-history reverse-search ran out (no match, or the user
        // walked past the oldest match). Hand the query off to the
        // screen's scrollback search so they can keep walking through
        // session scrollback for the same term — the prompt area
        // turns into the search overlay with their typed text as the
        // search input.
        screen.enterScrollbackSearch();
        screen.updateScrollbackSearchTerm(effect.query);
        return;
      case "attachment-request":
        void handleClipboardAttachment();
        return;
    }
  };

  // Resolves each dropped token — either an absolute path on disk
  // (reads the file) or a base64 data: URI (decodes in place) — and
  // pushes the survivors onto the dispatcher. Banner-notifies on any
  // rejection so the user knows why a chip didn't appear.
  const handleAttachmentPaths = async (tokens: string[]): Promise<void> => {
    if (!agentAcceptsImages) {
      screen.notify("agent does not accept image attachments");
      return;
    }
    let added = 0;
    for (const token of tokens) {
      if (token.startsWith("data:")) {
        const parsed = parseDataUriImage(token);
        if (!parsed) {
          screen.notify("unsupported data: URI");
          continue;
        }
        if (parsed.sizeBytes > MAX_ATTACHMENT_BYTES) {
          screen.notify(
            `image too large (${formatSize(parsed.sizeBytes)}, max ${formatSize(MAX_ATTACHMENT_BYTES)})`,
          );
          continue;
        }
        dispatcher.addAttachment({
          mimeType: parsed.mimeType,
          data: parsed.data,
          name: "pasted image",
          sizeBytes: parsed.sizeBytes,
        });
        added++;
        continue;
      }
      const mimeType = mimeFromExtension(token);
      if (!mimeType) {
        screen.notify(`unsupported image type: ${path.basename(token)}`);
        continue;
      }
      try {
        const buf = await fs.readFile(token);
        if (buf.length > MAX_ATTACHMENT_BYTES) {
          screen.notify(
            `image too large (${formatSize(buf.length)}, max ${formatSize(MAX_ATTACHMENT_BYTES)})`,
          );
          continue;
        }
        dispatcher.addAttachment({
          mimeType,
          data: buf.toString("base64"),
          name: path.basename(token),
          sizeBytes: buf.length,
        });
        added++;
      } catch (err) {
        screen.notify(
          `cannot read ${path.basename(token)}: ${(err as Error).message}`,
        );
      }
    }
    if (added > 0) {
      screen.setAttachments(dispatcher.state().attachments);
      screen.refreshPrompt();
    }
  };

  const handleClipboardAttachment = async (): Promise<void> => {
    const result = await readClipboard();
    if (!result.ok) {
      screen.notify(result.reason);
      return;
    }
    if (result.kind === "image") {
      if (!agentAcceptsImages) {
        screen.notify("agent does not accept image attachments");
        return;
      }
      dispatcher.addAttachment(result.attachment);
      screen.setAttachments(dispatcher.state().attachments);
      screen.refreshPrompt();
      return;
    }
    // Text: route through the same paste path as bracketed paste so
    // multi-line content splits at \n into the buffer instead of being
    // treated as a series of Enter presses.
    const effects = dispatcher.feed({ type: "paste", text: result.text });
    for (const effect of effects) {
      handleEffect(effect);
    }
    screen.refreshPrompt();
  };

  // Per-chip view of a queued entry, derived from the prompt array on the
  // wire. text/attachmentCount are pre-computed once at add/update time so
  // refreshQueueDisplay doesn't re-walk the prompt blocks on every render.
  interface QueueChipEntry {
    messageId: string;
    text: string;
    attachmentCount: number;
  }

  const formatQueueChipText = (entry: QueueChipEntry): string =>
    entry.attachmentCount > 0
      ? `${entry.text} · 📎×${entry.attachmentCount}`
      : entry.text;

  // Convert a wire-shaped prompt array (the session/prompt prompt blocks)
  // into the chip-display shape. Mirrors the on-send projection so a chip
  // for a self-originated entry matches what the user typed.
  const chipFromPrompt = (
    messageId: string,
    prompt: unknown,
  ): QueueChipEntry => {
    const blocks = Array.isArray(prompt) ? prompt : [];
    let text = "";
    let attachmentCount = 0;
    for (const raw of blocks) {
      if (!raw || typeof raw !== "object") continue;
      const b = raw as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        text += b.text;
      } else if (b.type === "image") {
        attachmentCount += 1;
      }
    }
    return {
      messageId,
      text: sanitizeSingleLine(text),
      attachmentCount,
    };
  };

  // Server-driven view of the daemon-owned prompt queue. Populated by
  // hydra-acp/prompt_queue_added notifications and by the queue snapshot
  // delivered on attach (_meta["hydra-acp"].queue). Entries are removed
  // by prompt_queue_removed regardless of reason — once gone, the chip
  // disappears whether the entry started, was cancelled, or abandoned.
  //
  // The cache holds ALL user-visible entries (self + peers) so two TUIs
  // on the same session see each other's queues. The chip row renders
  // straight from this map; the dispatcher's queue-edit / queue-remove
  // index into it by insertion order to resolve a slot to its messageId
  // for the wire request.
  const queueCache = new Map<string, QueueChipEntry>();

  // Deferred-echo plumbing. Own prompts are NOT echoed to scrollback at
  // submit time — they're held here until hydra signals the prompt has
  // actually been forwarded upstream (prompt_queue_removed{started}).
  // Otherwise a prompt typed while another turn runs would land in
  // scrollback as if it had started, even though the chip area shows it
  // as queued.
  interface PendingEcho {
    text: string;
    attachments: Attachment[];
    messageId?: string;
    // True once the prompt actually started processing and we flushed
    // the user-text to scrollback. Used by runPrompt's finally to
    // gate the synthesized turn-complete: a prompt cancelled while
    // still in the queue never started a turn, so there's nothing
    // to mark complete and rendering "stopped (cancelled): <text>"
    // for a never-run prompt is just noise.
    flushed: boolean;
  }
  // FIFO of own prompts awaiting their prompt_queue_added confirmation
  // from hydra. Drained in order — hydra serializes session/prompt
  // arrivals per session, so the Nth prompt_queue_added with our
  // originator corresponds to the Nth entry we pushed here.
  const pendingEchoes: PendingEcho[] = [];
  // Echoes that have already been bound to a messageId. Held here
  // until prompt_queue_removed for that messageId tells us to flush
  // (started) or drop (cancelled / abandoned).
  const ownPendingByMid = new Map<string, PendingEcho>();
  // messageIds that were the target of a hydra-acp/amend_prompt — used
  // by runPrompt's finally to synthesize a turn-complete with
  // amended: true so the cancelled turn renders as "stopped (amended)"
  // instead of "stopped (cancelled)". The daemon broadcasts
  // prompt_amended to the originator (unlike turn_complete itself which
  // excludes the originator), so by the time the session/prompt
  // response returns, this set already has the id.
  const amendedMessageIds = new Set<string>();
  // The echo currently associated with the visible tools block. Set
  // by the prompt_queue_removed{started} handler immediately after it
  // flushes user-text to scrollback; cleared by any subsequent
  // user-text render (peer prompt, replay, or our own next queued
  // prompt). runPrompt's finally consults this to decide whether to
  // fire its synthetic turn-complete: if a newer prompt has already
  // taken over the block, freezing it would render as "thought · 0s"
  // — the bug we're avoiding here.
  let currentTurnEcho: PendingEcho | null = null;

  const refreshQueueDisplay = (): void => {
    const entries = [...queueCache.values()];
    const displayTexts = entries.map(formatQueueChipText);
    screen.setQueuedPrompts(displayTexts);
    screen.setBanner({ queued: entries.length });
    dispatcher.setQueue(entries.map((e) => e.text));
  };

  // Resolve a queue-display slot index to the messageId hydra knows it
  // by. Returns undefined if the index has been spliced out from under
  // the dispatcher (e.g. the entry started or was cancelled between
  // the Up-arrow render and the user's Enter / ^C).
  const queueMessageIdAt = (index: number): string | undefined => {
    const entries = [...queueCache.values()];
    return entries[index]?.messageId;
  };

  // Hydrate the cache from the attach-response queue snapshot so the
  // chip row reflects daemon state immediately, not just after the
  // first live prompt_queue_added arrives. Skips the in-flight head
  // (position 0) — that prompt's user-text is already in scrollback
  // history; only waiting entries get visible chips.
  if (initialQueue && initialQueue.length > 0) {
    for (const entry of initialQueue) {
      if (entry.position === 0) {
        // In-flight head. The live "started" notification already fired
        // before we attached, so capture the head's messageId here so
        // Shift+Enter amend doesn't silently degrade to a regular send.
        currentHeadMessageId = entry.messageId;
        continue;
      }
      queueCache.set(
        entry.messageId,
        chipFromPrompt(entry.messageId, entry.prompt),
      );
    }
    if (queueCache.size > 0) {
      refreshQueueDisplay();
    }
  }

  const enqueuePrompt = (
    text: string,
    attachments: Attachment[],
  ): void => {
    // Sending a prompt always snaps the view to the bottom — the user
    // wants to see their own input and the agent's reply.
    screen.scrollToBottom();
    if (handleBuiltinCommand(text)) {
      return;
    }
    recordHistoryEntry(text);
    void runPrompt(text, attachments);
  };

  // Shift+Enter route. Three cases:
  //   1. Daemon doesn't advertise promptAmending → fall through to a
  //      regular send. The chord still works on older daemons.
  //   2. No in-flight head (currentHeadMessageId undefined) → also a
  //      regular send. Nothing to amend.
  //   3. Head is in flight → fire hydra-acp/amend_prompt with the head
  //      as targetMessageId. On target_completed, surface a "send
  //      anyway?" affordance instead of silently submitting; the user
  //      can re-press Shift+Enter or Enter to confirm.
  const amendPrompt = (text: string, attachments: Attachment[]): void => {
    screen.scrollToBottom();
    if (handleBuiltinCommand(text)) {
      return;
    }
    recordHistoryEntry(text);
    if (!daemonSupportsAmend || currentHeadMessageId === undefined) {
      void runPrompt(text, attachments);
      return;
    }
    const target = currentHeadMessageId;
    const blocks: Array<Record<string, unknown>> = [];
    if (text.length > 0) {
      blocks.push({ type: "text", text });
    }
    for (const a of attachments) {
      blocks.push({ type: "image", data: a.data, mimeType: a.mimeType });
    }
    // Mirror runPrompt's pendingEcho dance — the typed text only flushes
    // to scrollback when prompt_queue_removed{started} fires for the
    // amendment's messageId. Without this, the user's input would be
    // invisible: amend_prompt doesn't drive runPrompt, and the daemon
    // broadcasts prompt_received for M2 excluding the originator (us).
    const echo: PendingEcho = { text, attachments, flushed: false };
    pendingEchoes.push(echo);
    const popEcho = (): void => {
      const idx = pendingEchoes.indexOf(echo);
      if (idx >= 0) {
        pendingEchoes.splice(idx, 1);
      }
      if (echo.messageId !== undefined) {
        ownPendingByMid.delete(echo.messageId);
      }
    };
    conn
      .request("hydra-acp/amend_prompt", {
        sessionId: resolvedSessionId,
        targetMessageId: target,
        prompt: blocks,
      })
      .then((raw) => {
        const res = raw as {
          amended: boolean;
          reason: string;
          messageId?: string;
        };
        if (res.amended && res.reason === "ok") {
          // The amendment will run as a fresh turn (M2). Increment
          // pendingTurns so the banner stays busy through the
          // transition; the wire turn_complete for M2 — now included
          // for amend-originated entries via the daemon's wasAmend
          // flag — will decrement it back when M2 ends.
          adjustPendingTurns(1);
          return;
        }
        // Daemon didn't accept the amend → echo will never bind to a
        // messageId, so it'd sit in the FIFO forever and steal the next
        // unrelated prompt's binding. Pop it.
        popEcho();
        if (res.reason === "target_completed") {
          screen.notify(
            "previous response finished — press Enter to send as a new turn",
          );
          // Restore the typed text so the user can re-send via Enter.
          dispatcher.setBuffer(text, attachments);
          screen.refreshPrompt();
          return;
        }
        if (res.reason === "target_cancelled") {
          screen.notify("amend skipped — previous turn was cancelled");
          dispatcher.setBuffer(text, attachments);
          screen.refreshPrompt();
          return;
        }
        if (res.reason === "target_not_found") {
          screen.notify("amend skipped — no matching prompt");
          dispatcher.setBuffer(text, attachments);
          screen.refreshPrompt();
          return;
        }
      })
      .catch((err: Error) => {
        popEcho();
        screen.notify(`amend failed: ${err.message}`);
        dispatcher.setBuffer(text, attachments);
        screen.refreshPrompt();
      });
  };

  // Handles Shift+Tab: cycles through agentModes and sets the mode on the
  // agent via session/set_mode. When no modes are advertised, we have
  // nothing to cycle through — agents typically reject empty modeId.
  const handleModeToggle = async (_on: boolean): Promise<void> => {
    if (agentModes.length === 0) {
      screen.notify("no modes advertised by agent");
      return;
    }
    const currentMode = screen.currentModeId();
    const idx = agentModes.findIndex((m) => m.id === currentMode);
    const nextIdx = idx === -1 ? 0 : (idx + 1) % agentModes.length;
    const newModeId = agentModes[nextIdx]?.id;
    if (!newModeId) {
      return;
    }
    screen.setBanner({ currentMode: newModeId });
    try {
      await conn.request("session/set_mode", {
        sessionId: resolvedSessionId,
        modeId: newModeId,
      });
    } catch (err) {
      screen.notify(`set_mode failed: ${(err as Error).message}`);
    }
  };

  // Returns true if the input was a TUI built-in slash command and was
  // handled locally; the caller should skip enqueueing / sending it.
  const handleBuiltinCommand = (text: string): boolean => {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
      return false;
    }
    const space = trimmed.indexOf(" ");
    const cmd = space === -1 ? trimmed : trimmed.slice(0, space);
    switch (cmd) {
      case "/quit":
      case "/exit":
        void requestExit();
        return true;
      case "/clear":
        toolStates.clear();
        exitPlanStates.clear();
        toolCallOrder.length = 0;
        toolsBlockStartedAt = null;
        toolsBlockEndedAt = null;
        toolsBlockStopReason = null;
        toolsExpanded = false;
        screen.clearScrollback();
        return true;
      case "/demo-plan": {
        // Force a fresh plan block at the bottom of scrollback even if a
        // prior turn or history-replay already anchored the "plan" key.
        screen.clearKey("plan");
        const steps = ["Step 1", "Step 2", "Step 3", "Step 4", "Step 5"];
        const sequences: string[][] = [
          ["pending", "pending", "pending", "pending", "pending"],
          ["in_progress", "pending", "pending", "pending", "pending"],
          ["completed", "in_progress", "pending", "pending", "pending"],
          ["completed", "completed", "in_progress", "pending", "pending"],
          ["completed", "completed", "completed", "in_progress", "pending"],
          ["completed", "completed", "completed", "completed", "in_progress"],
          ["completed", "completed", "completed", "completed", "completed"],
        ];
        let i = 0;
        const tick = (): void => {
          const statuses = sequences[i];
          if (!statuses) {
            return;
          }
          appendRender({
            kind: "plan",
            entries: steps.map((content, j) => ({
              content,
              status: statuses[j] ?? "pending",
            })),
          });
          i += 1;
          setTimeout(tick, 600);
        };
        tick();
        return true;
      }
      case "/demo-tool": {
        const id = `demo-${Date.now()}`;
        appendRender({
          kind: "tool-call",
          toolCallId: id,
          title: "Terminal",
          status: "pending",
        });
        setTimeout(() => {
          appendRender({
            kind: "tool-call-update",
            toolCallId: id,
            title: "echo hello world",
            status: "in_progress",
          });
        }, 500);
        setTimeout(() => {
          appendRender({
            kind: "tool-call-update",
            toolCallId: id,
            status: "completed",
          });
        }, 1500);
        return true;
      }
      case "/help": {
        const lines: FormattedLine[] = [
          { prefix: "  ", body: "Built-in commands:", bodyStyle: "system" },
        ];
        for (const c of builtinCommands) {
          lines.push({
            prefix: "  ",
            body: `  ${c.name.padEnd(12)} ${c.description ?? ""}`,
            bodyStyle: "info",
          });
        }
        if (agentCommands.length > 0) {
          lines.push({ prefix: "  ", body: "Agent commands:", bodyStyle: "system" });
          for (const c of agentCommands) {
            lines.push({
              prefix: "  ",
              body: `  ${c.name.padEnd(12)} ${c.description ?? ""}`,
              bodyStyle: "info",
            });
          }
        }
        screen.appendLines(lines);
        return true;
      }
      case "/sessions":
        // Defer to a future implementation — for now, hint that the daemon
        // CLI provides this view.
        screen.appendLines([
          {
            prefix: "  ",
            body: "Run `hydra-acp sessions` (or `hydra sessions`) for the full list.",
            bodyStyle: "info",
          },
        ]);
        return true;
      default:
        // Not a built-in — fall through so the agent can handle it.
        return false;
    }
  };

  // Fire a user prompt over the wire. Replaces the old local-queue
  // worker: hydra serializes for us, so we send eagerly and let the
  // daemon's prompt_queue_* notifications drive the chip area. The
  // user-text echo into scrollback is DEFERRED: we hold the text +
  // attachments in `pendingEchoes` (a FIFO matched against incoming
  // prompt_queue_added events with our originator) and only flush to
  // scrollback when prompt_queue_removed{started} for our messageId
  // arrives — i.e. when hydra actually forwards the prompt upstream
  // to the agent. That way a prompt typed during another in-flight
  // turn shows up in the chip row as queued and does not appear in
  // scrollback until it really starts processing.

  const runPrompt = async (
    text: string,
    attachments: Attachment[],
  ): Promise<void> => {
    const userBlocks: Array<Record<string, unknown>> = [];
    if (text.length > 0) {
      userBlocks.push({ type: "text", text });
    }
    for (const a of attachments) {
      userBlocks.push({ type: "image", data: a.data, mimeType: a.mimeType });
    }

    adjustPendingTurns(1);
    // Stash the user-text echo for later flush. Hold a reference so
    // we can splice this entry out on error even if other prompts
    // have been pushed behind it in the meantime.
    const echo: PendingEcho = { text, attachments, flushed: false };
    pendingEchoes.push(echo);

    let cancelled = false;
    turnInFlight = {
      text,
      attachments,
      cancel: () => {
        if (cancelled) {
          return;
        }
        cancelled = true;
        conn.notify("session/cancel", { sessionId: resolvedSessionId }).catch(
          () => undefined,
        );
      },
    };
    let stopReason: string | undefined;
    try {
      const response = (await conn.request("session/prompt", {
        sessionId: resolvedSessionId,
        prompt: userBlocks,
      })) as { stopReason?: unknown };
      if (response && typeof response.stopReason === "string") {
        stopReason = response.stopReason;
      }
    } catch (err) {
      // The send didn't make it through hydra → there will never be a
      // prompt_queue_added for this echo. Splice it out wherever it
      // sits (still in FIFO, or already bound to a messageId).
      const idx = pendingEchoes.indexOf(echo);
      if (idx >= 0) {
        pendingEchoes.splice(idx, 1);
      }
      if (echo.messageId !== undefined) {
        ownPendingByMid.delete(echo.messageId);
      }
      screen.appendLines([
        {
          prefix: "✗ ",
          prefixStyle: "tool-status-fail",
          body: (err as Error).message,
          bodyStyle: "tool-status-fail",
        },
      ]);
    } finally {
      turnInFlight = null;
      adjustPendingTurns(-1);
      // Daemon broadcasts turn_complete to other clients but excludes
      // the originator. Synthesize it locally so the streaming buffer
      // resets and a separator lands before the next turn — but ONLY
      // if the prompt actually started AND the live tools block still
      // belongs to this echo. When the daemon dispatches the next
      // queued prompt before our session/prompt response returns, the
      // next prompt's user-text handler has already replaced the live
      // block (and frozen ours in passing); firing turn-complete here
      // would re-freeze the new turn's block at near-zero elapsed —
      // the "thought · 0s" symptom we're avoiding.
      if (echo.flushed && currentTurnEcho === echo) {
        // If this turn was the cancellation half of an amend, the daemon
        // sent us a prompt_amended notification (originator NOT excluded)
        // before this session/prompt response returned. The synthesized
        // turn-complete carries amended: true so the tools block freezes
        // as "stopped (amended)" instead of "stopped (cancelled)".
        const wasAmended =
          echo.messageId !== undefined &&
          amendedMessageIds.has(echo.messageId);
        if (wasAmended && echo.messageId !== undefined) {
          amendedMessageIds.delete(echo.messageId);
        }
        const tc: RenderEvent = { kind: "turn-complete" };
        if (stopReason !== undefined) {
          tc.stopReason = stopReason;
        }
        if (wasAmended) {
          tc.amended = true;
        }
        appendRender(tc);
        currentTurnEcho = null;
      }
      // Escape-cancel staged this. Apply only if the buffer is still
      // empty — the user may have started typing while the cancelled
      // turn was settling, and we don't want to clobber that draft.
      if (pendingPrefill !== null) {
        const { text: pt, attachments: pa } = pendingPrefill;
        pendingPrefill = null;
        const bufferEmpty = dispatcher
          .state()
          .buffer.every((line) => line === "");
        if (bufferEmpty) {
          dispatcher.setBuffer(pt, pa);
          screen.refreshPrompt();
        }
      }
    }
  };

  // toolCallId → merged state for the per-call row inside the current
  // turn's tools block. Cleared at turn boundaries (the block gets
  // frozen into scrollback first) so each turn starts fresh.
  const toolStates = new Map<string, ToolLineState>();
  // toolCallId → Claude ExitPlanMode plan + latest status. Lives until
  // turn end (cleared alongside toolStates) so a permission resolution
  // landing as a tool_call_update can amend the rendered block in place.
  const exitPlanStates = new Map<string, ExitPlanState>();
  // Ordered toolCallIds for the current turn — drives the rolling
  // "most recent K" window in the tools block and is the source of
  // truth for the "ran N tools" header count.
  const toolCallOrder: string[] = [];
  // Toggled by ^O. Resets each turn so a turn always starts collapsed.
  let toolsExpanded = false;
  // Wall-clock bounds for the active tools block. startedAt is set on
  // the first tool call of the turn; endedAt is set when the turn
  // completes and freezes the block (header switches from "Xs" to
  // "took Xs"). Both null when there's no live block.
  let toolsBlockStartedAt: number | null = null;
  let toolsBlockEndedAt: number | null = null;
  // Captured at turn-end from turn-complete.stopReason. When set to
  // anything other than "end_turn" the frozen tools block renders as
  // `stopped (<reason>) · Xs` in red instead of the usual dim
  // `thought · Xs`, so a cancel/refusal/max_tokens turn is visibly distinct.
  let toolsBlockStopReason: string | null = null;
  // Last plan snapshot seen this turn, retained so turn-complete with a
  // non-success stopReason can re-render the keyed "plan" block in its
  // stopped state (header red, in-progress entries dimmed) before the
  // splice point is cleared.
  let lastPlanEvent: Extract<RenderEvent, { kind: "plan" }> | null = null;
  // How many recent tool rows the collapsed view shows; older ones get
  // rolled into the "N hidden" counter in the header.
  const TOOLS_COLLAPSED_LIMIT = 5;

  // Buffered text + a stable key for the current agent utterance. Agent
  // chunks accumulate here; on each chunk the whole buffer is re-parsed
  // through parseAgentMarkdown and upserted as one keyed block — same
  // pattern @hydra-acp/browser uses. The block "closes" (key forgotten)
  // when any interrupting event (tool call, plan, thought, turn end, peer
  // prompt) lands, so the next agent_text starts a fresh block below.
  let agentBuffer = "";
  let agentKey: string | null = null;
  let agentSeq = 0;

  const renderAgentBlock = (): void => {
    if (agentKey === null) {
      return;
    }
    const lines = parseAgentMarkdown(agentBuffer);
    if (lines.length === 0) {
      return;
    }
    screen.upsertLines(agentKey, lines);
  };

  const appendAgentText = (text: string): void => {
    if (text.length === 0) {
      return;
    }
    if (agentKey === null) {
      // Starting a new agent utterance — drop a blank separator above so
      // the new block reads as visually distinct from prior content.
      // appendStreaming would do this for us in the old streaming-line
      // model, but we bypass that path for markdown rendering.
      screen.ensureSeparator();
      agentKey = `agent:${agentSeq}`;
      agentSeq += 1;
      agentBuffer = "";
    }
    agentBuffer += text;
    renderAgentBlock();
  };

  const closeAgentText = (): void => {
    agentKey = null;
    agentBuffer = "";
  };

  // Parallel buffered-rerender for thought blocks. Same pattern as agent
  // text: chunks accumulate, whole buffer is re-parsed on each chunk,
  // result upserted as one keyed block. bodyStyle "thought" is preserved
  // on every line so the ^T hide-thoughts filter keeps working.
  let thoughtBuffer = "";
  let thoughtKey: string | null = null;
  let thoughtSeq = 0;

  const renderThoughtBlock = (): void => {
    if (thoughtKey === null)
      return;
    const lines = parseThoughtMarkdown(thoughtBuffer);
    if (lines.length === 0)
      return;
    screen.upsertLines(thoughtKey, lines);
  };

  const appendThought = (text: string): void => {
    if (text.length === 0)
      return;
    if (thoughtKey === null) {
      screen.ensureSeparator();
      thoughtKey = `thought:${thoughtSeq}`;
      thoughtSeq += 1;
      thoughtBuffer = "";
    }
    thoughtBuffer += text;
    renderThoughtBlock();
  };

  const closeThought = (): void => {
    thoughtKey = null;
    thoughtBuffer = "";
  };

  const renderToolsBlock = (): void => {
    if (toolsBlockStartedAt === null) {
      return;
    }
    const total = toolCallOrder.length;
    const visibleIds = toolsExpanded
      ? toolCallOrder
      : toolCallOrder.slice(Math.max(0, total - TOOLS_COLLAPSED_LIMIT));
    const hidden = total - visibleIds.length;
    const inProgress = toolsBlockEndedAt === null;
    const end = toolsBlockEndedAt ?? Date.now();
    const elapsed = end - toolsBlockStartedAt;
    // Any frozen non-success stopReason gets the loud "stopped (<reason>)"
    // treatment so cancel/refusal/max_tokens etc. aren't visually identical
    // to a normal end_turn finish. Amended is the exception: a deliberate
    // user replacement, not a failure — rendered dim with a softer label.
    const stoppedReason =
      !inProgress &&
      toolsBlockStopReason !== null &&
      toolsBlockStopReason !== "end_turn"
        ? toolsBlockStopReason
        : null;
    const isAmended = stoppedReason === "amended";
    const stoppedLabel = isAmended
      ? `amended · ${formatElapsed(elapsed)}`
      : `stopped (${stoppedReason}) · ${formatElapsed(elapsed)}`;
    let summary: string;
    if (total === 0) {
      // Pre-tool state — the block exists purely as a "still working"
      // indicator while the agent is thinking, then freezes as "thought · Xs"
      // at turn end so the user has a visible trace of the reasoning time.
      if (stoppedReason !== null) {
        summary = stoppedLabel;
      } else {
        summary = inProgress
          ? `thinking · ${formatElapsed(elapsed)}`
          : `thought · ${formatElapsed(elapsed)}`;
      }
    } else {
      const noun = total === 1 ? "tool" : "tools";
      const timing =
        stoppedReason !== null
          ? stoppedLabel
          : inProgress
            ? formatElapsed(elapsed)
            : `took ${formatElapsed(elapsed)}`;
      const parts: string[] = [`${total} ${noun}`, timing];
      // Only advertise the hotkey while the block is live — once frozen,
      // ^O no longer affects it and the hint would be misleading.
      if (inProgress) {
        if (hidden > 0) {
          parts.push(`${hidden} hidden — ^O expand`);
        } else if (toolsExpanded && total > TOOLS_COLLAPSED_LIMIT) {
          parts.push("^O collapse");
        }
      }
      summary = parts.join(" · ");
    }
    // Pure-thinking placeholder (no tool has fired yet and the turn is
    // still live) renders yellow to match the busy banner / active plan /
    // running tool accent. Once a tool fires the per-tool status colors
    // carry the activity signal, and once frozen ("thought · Xs") the
    // header dims so completed turns stop pulling the eye. A non-success
    // stopReason overrides the frozen dim and goes bold-red so the user
    // can spot a cancelled / refused / truncated turn at a glance.
    // Amended is the exception: stays dim since it's a user action.
    const pureThinking = total === 0 && inProgress;
    const stoppedHeaderStyle: "tool-status-fail" | "tool-status-cancelled" =
      isAmended ? "tool-status-cancelled" : "tool-status-fail";
    const frozenStyle: "tool-status-fail" | "tool-status-cancelled" | "tool" =
      stoppedReason !== null ? stoppedHeaderStyle : "tool";
    const frozenBodyStyle: "tool-status-fail" | "tool-status-cancelled" | "dim" =
      stoppedReason !== null ? stoppedHeaderStyle : "dim";
    const lines: FormattedLine[] = [
      {
        prefix: "⚙ ",
        prefixStyle: pureThinking ? "tool-status-running" : frozenStyle,
        body: summary,
        bodyStyle: pureThinking ? "tool-status-running" : frozenBodyStyle,
      },
    ];
    for (const id of visibleIds) {
      const state = toolStates.get(id);
      if (state) {
        lines.push(...formatToolLine(state));
      }
    }
    screen.upsertLines("tools", lines);
  };

  // Anchor a fresh tools block at the current bottom of scrollback so the
  // user has a visible "agent is working" indicator from the moment a turn
  // starts — even if no tool calls fire for a while. Called from the
  // user-text handler so it fires for both our own prompts (synthesized
  // via runPrompt) and peers' prompts (broadcast by the daemon).
  const startToolsBlock = (): void => {
    toolsBlockStartedAt = Date.now();
    toolsBlockEndedAt = null;
    toolsBlockStopReason = null;
    renderToolsBlock();
  };

  const recordToolCall = (
    id: string,
    title: string | undefined,
    status: string | undefined,
    errorText: string | undefined,
  ): void => {
    const wasNew = !toolStates.has(id);
    const existing = toolStates.get(id);
    const state: ToolLineState = existing ?? {
      initialTitle: title ?? "tool",
      latestTitle: title ?? "tool",
      status: status ?? "pending",
    };
    if (existing && title !== undefined) {
      state.latestTitle = title;
    }
    if (existing && status !== undefined) {
      state.status = status;
    }
    if (!existing) {
      state.status = status ?? "pending";
    }
    if (errorText !== undefined) {
      state.errorText = errorText;
    }
    toolStates.set(id, state);
    if (wasNew) {
      // The block is normally anchored by startToolsBlock on the user-text
      // event; this fallback covers replay/edge cases where a tool call
      // arrives without a preceding prompt visible to us.
      if (toolsBlockStartedAt === null) {
        toolsBlockStartedAt = Date.now();
        toolsBlockEndedAt = null;
        toolsBlockStopReason = null;
      }
      toolCallOrder.push(id);
    }
  };

  applyRenderEvent = (event: RenderEvent): void => {
    if (event.kind === "available-commands") {
      agentCommands = event.commands;
      refreshCompletions();
      return;
    }
    if (event.kind === "available-modes") {
      agentModes = event.modes;
      return;
    }
    if (event.kind === "mode-changed") {
      screen.setBanner({ currentMode: event.mode || undefined });
      return;
    }
    if (event.kind === "session-info") {
      if (event.title !== undefined) {
        screen.setSessionbar({ title: event.title });
      }
      if (event.agentId !== undefined && event.agentId !== resolvedAgentId) {
        resolvedAgentId = event.agentId;
        screen.setSessionbar({ agent: event.agentId });
      }
      return;
    }
    if (event.kind === "usage-update") {
      let changed = false;
      if (event.used !== undefined && usage.used !== event.used) {
        usage.used = event.used;
        changed = true;
      }
      if (event.size !== undefined && usage.size !== event.size) {
        usage.size = event.size;
        changed = true;
      }
      if (
        event.costAmount !== undefined &&
        usage.costAmount !== event.costAmount
      ) {
        usage.costAmount = event.costAmount;
        changed = true;
      }
      if (
        event.costCurrency !== undefined &&
        usage.costCurrency !== event.costCurrency
      ) {
        usage.costCurrency = event.costCurrency;
        changed = true;
      }
      if (changed) {
        screen.setSessionbar({ usage: { ...usage } });
      }
      return;
    }
    if (event.kind === "user-text") {
      // Fold peer prompts into the local prompt history so up-arrow
      // walks them. Own prompts were already recorded by enqueuePrompt
      // before runPrompt fired — appendEntry's consecutive dedup keeps
      // the own-prompt user-text echo (synthesized from
      // prompt_queue_removed{started}) from creating a duplicate entry.
      // Skipped during the initial attach-replay drain; replayed user-
      // text gets merged via mergeReplayedEntries instead.
      if (livePeerHistoryRecording) {
        recordHistoryEntry(event.text);
      }
      // Render the user prompt first, then anchor the "thinking…" tools
      // block directly below it. The order matters — startToolsBlock
      // appends to the bottom of scrollback, so if we called it before
      // emitting user-text the block would land above the prompt and the
      // chronology would read backwards.
      closeAgentText();
      closeThought();
      // The previous turn's tools block may still be live: that happens
      // when hydra dispatches the next prompt (queued or peer) before
      // the previous turn's local synthetic turn-complete fires. Freeze
      // it in place now — with elapsed time but no stopReason, since the
      // reason hasn't reached us yet — so the prior "thinking · Xs"
      // header transitions to a frozen "thought · Xs" / "took Xs" trace
      // before this new turn replaces it.
      if (toolsBlockStartedAt !== null) {
        toolsBlockEndedAt = Date.now();
        renderToolsBlock();
      }
      // Any pending ownership belongs to the prior turn; clear it so
      // peer/replay user-texts don't accidentally keep an old echo
      // associated with the new block. Our own queued prompts re-stamp
      // currentTurnEcho in the prompt_queue_removed{started} handler
      // immediately after appendRender returns.
      currentTurnEcho = null;
      screen.ensureSeparator();
      const formatted = formatEvent(event);
      if (formatted.length > 0) {
        screen.appendLines(formatted);
      }
      // Defensive turn-boundary cleanup. The turn-complete handler
      // normally clears these, but the daemon's broadcastTurnComplete
      // sits behind `await agent.connection.request("session/prompt")`
      // and gets skipped if the request throws (agent crash, network
      // blip, daemon restart) — leaving the prompt recorded without a
      // matching turn_complete. When that unbalanced seed history is
      // replayed at attach, the "tools"/"plan" keyed blocks stay
      // anchored mid-scrollback. The next turn's renderToolsBlock would
      // then splice into that stale anchor far above the viewport, so
      // the user never sees their live thinking/tool rows. Clear the
      // turn-scoped state here so a new turn always anchors at the
      // current bottom.
      screen.clearKey("tools");
      screen.clearKey("plan");
      lastPlanEvent = null;
      toolStates.clear();
      exitPlanStates.clear();
      toolCallOrder.length = 0;
      toolsExpanded = false;
      toolsBlockEndedAt = null;
      startToolsBlock();
      // Force an immediate paint past the content-repaint throttle. The
      // user-text event is the user's "I just sent this" signal — they
      // need to see their prompt + the thinking indicator without
      // waiting for the next throttled paint window. Otherwise a fast
      // text-only turn can complete inside one throttle window and the
      // user never sees a thinking indicator at all.
      screen.redraw();
      return;
    }
    if (event.kind === "agent-text") {
      closeThought();
      appendAgentText(event.text);
      return;
    }
    if (event.kind === "agent-thought") {
      // Thoughts are buffered and re-parsed through parseThoughtMarkdown on
      // each chunk — same pattern as agent text — so markdown (bold, code)
      // renders correctly. We always upsert even when thoughts are hidden;
      // setHideThoughts() filters at draw time so toggling ^T reveals lines
      // that streamed in while hidden.
      closeAgentText();
      appendThought(event.text);
      return;
    }
    if (event.kind === "exit-plan-mode") {
      closeAgentText();
      closeThought();
      const existing = exitPlanStates.get(event.toolCallId);
      const merged: ExitPlanState = {
        plan: event.plan ?? existing?.plan ?? "",
        status: event.status ?? existing?.status,
      };
      exitPlanStates.set(event.toolCallId, merged);
      // No plan body and none on file yet — skip until a payload carrying
      // `plan` arrives. A bare status update before any body has been
      // seen would otherwise render an empty block.
      if (merged.plan.length === 0) {
        return;
      }
      const lines = formatExitPlanMode(merged);
      if (lines.length > 0) {
        screen.upsertLines(event.toolCallId, lines);
      }
      return;
    }
    if (event.kind === "tool-call") {
      closeAgentText();
      closeThought();
      recordToolCall(event.toolCallId, event.title, event.status, undefined);
      renderToolsBlock();
      return;
    }
    if (event.kind === "plan") {
      // The agent emits a full plan snapshot each time entries get added
      // or checked off; render it as a single mutating block so the
      // scrollback doesn't accumulate one copy per update.
      closeAgentText();
      closeThought();
      lastPlanEvent = event;
      const lines = formatEvent(event);
      if (lines.length > 0) {
        screen.upsertLines("plan", lines);
      }
      return;
    }
    if (event.kind === "tool-call-update") {
      closeAgentText();
      closeThought();
      recordToolCall(
        event.toolCallId,
        event.title,
        event.status,
        event.errorText,
      );
      if (event.upstreamInterrupted) {
        upstreamInterruptedSeen = true;
      }
      renderToolsBlock();
      return;
    }
    if (event.kind === "model-changed") {
      // Sessionbar reflects live state; scrollback still gets the line
      // below for a visible audit trail.
      screen.setSessionbar({ model: event.model });
    }
    const formatted = formatEvent(event);
    if (formatted.length > 0) {
      screen.appendLines(formatted);
    }
    if (event.kind === "turn-complete") {
      // Clear here (not in handleSessionUpdate) so own-prompt turns —
      // whose wire turn_complete the daemon excludes from the originator
      // and which runPrompt synthesizes locally via appendRender — also
      // clear the tracked head id.
      currentHeadMessageId = undefined;
      // The plan upsert is keyed by "plan" so within a turn each update
      // splices in place. Reset that key at the turn boundary so the next
      // turn's first plan event appends as a fresh block below — otherwise
      // it would splice into the previous turn's plan, possibly far up in
      // (or off the top of) scrollback.
      closeAgentText();
      closeThought();
      // Substitute "amended" for the stopReason when the daemon flagged
      // this turn as cancel-due-to-amend. Downstream renderers (plan
      // stopped-state, tools block header, "turn ended" warning) display
      // whatever string they see, so "amended" reads as a softer, more
      // informative transition than "cancelled".
      //
      // Override end_turn → error when any tool in this turn carried the
      // upstream-interrupted signature. Opencode's retry loop reports
      // its failed sub-task but still returns stopReason=end_turn, which
      // would otherwise paint the turn as a clean finish despite the
      // hidden failure. The amended substitution wins over the error
      // override since an amend-cancel is a deliberate user action.
      let effectiveStopReason = event.amended
        ? "amended"
        : event.stopReason;
      if (
        !event.amended &&
        upstreamInterruptedSeen &&
        (effectiveStopReason === undefined || effectiveStopReason === "end_turn")
      ) {
        effectiveStopReason = "error";
      }
      // Repaint the plan one last time with stopped=true when the turn
      // ended on a non-success reason (cancelled, refused, max_tokens, …).
      // Header flips to red and any in_progress rows dim — so a cancelled
      // plan stops looking like it's still busy. Must happen before
      // clearKey so the upsert lands on the existing scrollback block.
      if (
        lastPlanEvent !== null &&
        effectiveStopReason !== undefined &&
        effectiveStopReason !== "end_turn"
      ) {
        const lines = formatEvent({
          ...lastPlanEvent,
          stopped: true,
          amended: event.amended === true,
        });
        if (lines.length > 0) {
          screen.upsertLines("plan", lines);
        }
      }
      lastPlanEvent = null;
      screen.clearKey("plan");
      // Freeze the tools block (header switches from live "Xs" to
      // "took Xs") and then drop the key so next turn's tool calls
      // append a fresh block below. If no tool ever fired this turn the
      // block is just a thinking-indicator with no info worth keeping;
      // splice it out of scrollback entirely.
      if (toolsBlockStartedAt !== null) {
        // Always freeze the block at turn end — even when no tool ever
        // fired — so the user has a visible "agent thought for Xs"
        // trace. Removing the placeholder for tool-less turns made the
        // turn look indistinguishable from one where the TUI silently
        // dropped events.
        toolsBlockEndedAt = Date.now();
        toolsBlockStopReason = effectiveStopReason ?? null;
        renderToolsBlock();
        screen.clearKey("tools");
      } else if (
        effectiveStopReason !== undefined &&
        effectiveStopReason !== "end_turn" &&
        effectiveStopReason !== "amended"
      ) {
        // Defense-in-depth: a non-success turn ended but we have no tools
        // block to freeze (typically because a reconnect-recovery-failed
        // path already cleared it, or because the turn arrived from a
        // path that never started one). Without this the failure would
        // be invisible — exactly the "looks like it succeeded" trap.
        // Amended turns are skipped: the user-text replacement below
        // already conveys the action, no warning needed.
        screen.appendLines([
          {
            prefix: "⚠ ",
            prefixStyle: "tool-status-fail",
            body: `turn ended: ${effectiveStopReason}`,
            bodyStyle: "tool-status-fail",
          },
        ]);
      }
      toolStates.clear();
      exitPlanStates.clear();
      toolCallOrder.length = 0;
      toolsBlockStartedAt = null;
      toolsBlockEndedAt = null;
      toolsBlockStopReason = null;
      toolsExpanded = false;
      upstreamInterruptedSeen = false;
      screen.ensureSeparator();
    }
  };

  // Drain anything that arrived during the attach handshake (history replay,
  // early usage updates, etc.) into the freshly initialized screen. Pause
  // repaints while draining so a long session doesn't visibly scroll
  // chunk-by-chunk; one repaint at the end shows the final state.
  const buffered = bufferedEvents;
  bufferedEvents = [];
  // Capture replayed user-text in attach order so peer prompts from
  // other clients show up under up-arrow even when this TUI has never
  // typed in the session. livePeerHistoryRecording is still false here
  // so the drain itself doesn't double-record; the merge below folds
  // these in with set-based dedup against existing history.
  const replayedPromptTexts: string[] = [];
  for (const event of buffered) {
    if (event.kind === "user-text" && typeof event.text === "string") {
      replayedPromptTexts.push(event.text);
    }
  }
  screen.pauseRepaint();
  try {
    for (const event of buffered) {
      applyRenderEvent(event);
    }
  } finally {
    screen.resumeRepaint();
  }
  if (replayedPromptTexts.length > 0) {
    const merged = mergeReplayedEntries(history, replayedPromptTexts);
    if (merged !== history) {
      history = merged;
      dispatcher.setHistory(buildCombinedHistory(globalHistory, history));
      saveHistory(historyFile, history).catch(() => undefined);
    }
  }
  livePeerHistoryRecording = true;

  // Mid-turn reattach reconcile. History replay incremented pendingTurns
  // for the unmatched prompt_received, but adjustPendingTurns ran before
  // screenRef was set so the busy banner / elapsed timer transition was
  // skipped. Now that the screen is up, force the busy state using the
  // daemon's authoritative recordedAt as sessionBusySince so the elapsed
  // counter shows real turn duration, not time-since-reattach. The live
  // turn_complete will arrive normally and decrement pendingTurns 1 → 0,
  // which clears the banner via the existing transition.
  if (initialTurnStartedAt !== undefined && pendingTurns > 0) {
    sessionBusySince = initialTurnStartedAt;
    screen.setBanner({
      status: "busy",
      elapsedMs: Date.now() - initialTurnStartedAt,
    });
    if (sessionElapsedTimer === null) {
      sessionElapsedTimer = setInterval(() => {
        if (sessionBusySince === null || screenRef === null) {
          return;
        }
        screenRef.setBanner({ elapsedMs: Date.now() - sessionBusySince });
        renderToolsBlock();
      }, 1_000);
    }
    startToolsBlock();
  } else if (initialTurnStartedAt === undefined && pendingTurns > 0) {
    // Daemon says idle but local replay counted unmatched user-text
    // events. The daemon's turnStartedAt is authoritative — any
    // mismatch is local accounting error (e.g. a malformed historical
    // entry). Snap pendingTurns to 0 so the prompt queue can drain.
    adjustPendingTurns(-pendingTurns);
  }

  // Tear down volatile in-flight UI state ahead of a reconnect attach.
  // Deliberately leaves the tools block live (toolsBlockStartedAt stays
  // populated) so a replayed or live turn_complete can finalize it with
  // the real stopReason. Previously we eagerly froze the block here with
  // stopReason=null, which made a turn that actually errored on the
  // daemon look like a benign "thought · 0s" — the live turn_complete
  // arriving later was silently dropped because toolsBlockStartedAt had
  // been cleared.
  const resetInFlightUiState = (): void => {
    if (pendingPermission) {
      const resolve = pendingPermission.resolve;
      pendingPermission = null;
      screen.setPermissionPrompt(null);
      resolve({ outcome: { outcome: "cancelled" } });
    }
    closeAgentText();
    closeThought();
  };

  // Force-finalize an in-flight tools block as recovery-failed. Used when
  // onReconnect can't get an incremental replay (daemon fell back to
  // "full") and we can no longer trust the locally-tracked turn state.
  // Renders the block as red "stopped (reconnect-recovery-failed) · Xs"
  // so the user sees that something went wrong even though we don't have
  // a real stopReason from the daemon.
  const markToolsBlockRecoveryFailed = (): void => {
    if (toolsBlockStartedAt === null) {
      return;
    }
    toolsBlockEndedAt = Date.now();
    toolsBlockStopReason = "reconnect-recovery-failed";
    renderToolsBlock();
    screen.clearKey("tools");
    toolStates.clear();
    exitPlanStates.clear();
    toolCallOrder.length = 0;
    toolsBlockStartedAt = null;
    toolsBlockEndedAt = null;
    toolsBlockStopReason = null;
    toolsExpanded = false;
  };

  // Disconnect signal arrives the moment the underlying WS drops and a
  // reconnect is queued. Flag the banner so the user has feedback while
  // we retry; the prompt queue keeps accepting input and ResilientWsStream
  // buffers outbound sends until the new connection is live.
  onDisconnectHook = (): void => {
    screen.setBanner({ status: "disconnected", elapsedMs: undefined });
  };

  // Re-attach after a reconnect. Uses stream.request directly (bypassing
  // conn / the connectGate) because we need this handshake to complete
  // BEFORE the resilient stream flushes its outbound queue — otherwise a
  // prompt the user typed while the daemon was down could race the
  // attach. When we have a lastSeenMessageId we ask for
  // historyPolicy:"after_message" so the daemon replays only the events
  // we missed during the outage; if the daemon falls back to "full"
  // (cutoff messageId not in history) we'd duplicate scrollback, so
  // notifications fired during the attach are parked in
  // reconnectReplayBuffer and only flushed when appliedPolicy confirms
  // an incremental replay.
  onReconnect = async (): Promise<void> => {
    resetInFlightUiState();
    const initReq: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: `tui-reinit-${nanoid()}`,
      method: "initialize",
      params: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "hydra-acp-tui", version: HYDRA_VERSION },
      },
    };
    try {
      await stream.request(initReq);
    } catch {
      // initialize failing on reconnect is non-fatal; the daemon may
      // still accept the attach below.
    }
    const useAfterMessage = lastSeenMessageId !== undefined;
    const attachReq: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: `tui-reattach-${nanoid()}`,
      method: "session/attach",
      params: {
        sessionId: resolvedSessionId,
        historyPolicy: useAfterMessage ? "after_message" : "none",
        ...(useAfterMessage ? { afterMessageId: lastSeenMessageId } : {}),
        clientInfo: { name: "hydra-acp-tui", version: HYDRA_VERSION },
        ...(upstreamSessionId !== undefined
          ? {
              _meta: {
                [HYDRA_META_KEY]: {
                  resume: {
                    upstreamSessionId,
                    agentId: resolvedAgentId,
                    cwd: resolvedCwd,
                  },
                },
              },
            }
          : {}),
      },
    };
    // Arm the buffer BEFORE we send attach. The daemon delivers replay via
    // notify() inside its attach handler (daemon/acp-ws.ts:197-199), so
    // notifications start landing before stream.request returns. Without
    // the buffer they'd render as live events, and we couldn't undo them
    // if appliedPolicy came back as "full".
    reconnectReplayBuffer = [];
    let appliedPolicy: string | undefined;
    let attachErr: Error | undefined;
    let fields: ReattachResponseFields | undefined;
    try {
      const resp = await stream.request(attachReq);
      if (resp.error) {
        throw new Error(resp.error.message);
      }
      fields = parseReattachResponse(resp.result);
      appliedPolicy = fields.appliedPolicy;
      // Refresh ownClientId from the reattach response. The daemon mints
      // a fresh clientId on every session/attach, including transparent
      // reconnects — without this update the cached id goes stale, the
      // own-prompt FIFO binding at the prompt_queue_added handler stops
      // matching, and typed prompts no longer echo to scrollback. See
      // reconnect-state.ts.
      if (fields.clientId !== undefined) {
        ownClientId = fields.clientId;
      }
    } catch (err) {
      attachErr = err as Error;
    }
    const buffered = reconnectReplayBuffer ?? [];
    reconnectReplayBuffer = null;
    if (attachErr) {
      // Reattach failed entirely — drop any buffered events (we can't
      // trust them in isolation) and surface the failure. Mark any
      // in-flight tools block as recovery-failed so a turn that was
      // running on the daemon doesn't keep counting forever.
      markToolsBlockRecoveryFailed();
      screen.appendLines([
        {
          prefix: "  ",
          body: `reattach failed: ${attachErr.message}`,
          bodyStyle: "tool-status-fail",
        },
      ]);
    } else if (useAfterMessage && appliedPolicy !== "after_message") {
      // Daemon couldn't find our afterMessageId and fell back to a full
      // replay. Discarding the buffer keeps scrollback consistent
      // (no duplicated history); the warning makes the gap visible.
      // Any in-flight tools block is now unknown to us — freeze it
      // loudly rather than leave it counting up against stale state.
      markToolsBlockRecoveryFailed();
      screen.appendLines([
        {
          prefix: "⚠ ",
          prefixStyle: "tool-status-fail",
          body: "reconnect couldn't replay events since last seen — scrollback may be incomplete",
          bodyStyle: "tool-status-fail",
        },
      ]);
    } else {
      // Either incremental replay landed cleanly, or we never had a
      // messageId to anchor on (first reconnect of a fresh session) and
      // the daemon returned no replay. Flush whatever showed up.
      for (const params of buffered) {
        handleSessionUpdate(params);
      }
    }
    // Reconcile pendingTurns against the daemon's authoritative idle state.
    // If the daemon restarted mid-turn the turn_complete was never emitted,
    // so pendingTurns can be > 0 even though the session is now idle.
    // Skip when fields is undefined (attach errored) — we have no
    // authoritative signal to reconcile against.
    if (fields && fields.turnStartedAt === undefined && pendingTurns > 0) {
      adjustPendingTurns(-pendingTurns);
    }
    screen.setBanner({
      status: pendingTurns > 0 ? "busy" : "ready",
      elapsedMs: pendingTurns > 0 ? 0 : undefined,
    });
  };

  // With ResilientWsStream this only fires once we've exhausted reconnect
  // attempts. The banner reflects intermediate disconnect/reconnect cycles
  // via onDisconnect/onConnect; only here is the connection truly dead.
  conn.onClose((err) => {
    if (err) {
      term.red(`\nconnection lost: ${err.message}\n`);
    }
    stop(err ? 1 : 0);
  });

  process.on("SIGINT", sigintHandler);

  // Composer prompt typed in the picker before the session existed.
  // Fire it once, now that screen.start() and the dispatcher are wired
  // up. Guarded by sessionId === "__new__" so a resume/restart that
  // accidentally inherits opts.initialPrompt is a no-op.
  if (opts.initialPrompt && ctx.sessionId === "__new__") {
    enqueuePrompt(opts.initialPrompt, []);
  }

  return await sessionDone;
}

async function resolveSession(
  term: termkit.Terminal,
  config: HydraConfig,
  target: RemoteTarget,
  opts: TuiOptions,
  pickerPrefs: PickerPrefs,
): Promise<SessionContext | null> {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.sessionId) {
    const ctx: SessionContext = {
      sessionId: opts.sessionId,
      agentId: opts.agentId ?? "",
      cwd,
    };
    if (opts.importAttachHint !== undefined) {
      ctx.importAttachHint = opts.importAttachHint;
    }
    return ctx;
  }
  if (opts.forceNew) {
    return newCtx(opts, cwd, config);
  }
  if (opts.resume) {
    const sessions = await listSessions(target, { cwd, all: true });
    const recent = pickMostRecent(sessions, cwd);
    if (!recent) {
      term.yellow(`No sessions found for ${cwd}.\n`);
      return null;
    }
    return {
      sessionId: recent.sessionId,
      agentId: recent.agentId ?? "",
      cwd,
    };
  }
  // Smart default: show every live session plus up to PICKER_COLD_LIMIT
  // most-recently-touched cold ones so the list stays scannable even with
  // a deep on-disk history. The picker defaults its cursor to
  // "New session" so just pressing Enter creates a fresh one.
  // Outer loop: the action dialog's Esc returns "back" to re-show the
  // picker so the user isn't trapped after pressing Enter on the wrong
  // imported row. Every other picker exit path resolves the function.
  while (true) {
    const sessions = await listSessions(target);
    const choice: PickerResult = await pickSession(term, {
      cwd,
      sessions,
      config,
      target,
      prefs: pickerPrefs,
    });
    if (choice.kind === "abort") {
      return null;
    }
    if (choice.kind === "new") {
      if (choice.prompt !== undefined) {
        opts.initialPrompt = choice.prompt;
      }
      return newCtx(opts, cwd, config);
    }
    // Propagate the picker's view-only choice (set by `v`) onto opts so
    // the WS attach payload picks it up. The runtime opts is the same
    // object referenced by the attach call later in runSession — without
    // this mutation, first-launch `v` opens non-readonly even though the
    // picker returned readonly:true.
    opts.readonly = choice.readonly === true;
    // First-launch-on-this-machine for an imported session: route through
    // the fork-vs-view dialog (and on fork-local, a cwd dialog). Cancel
    // tears down the TUI; back returns here to re-show the picker.
    const chosen = sessions.find((s) => s.sessionId === choice.sessionId);
    const isImportedFirstLaunch =
      chosen !== undefined &&
      !!chosen.importedFromMachine &&
      !chosen.upstreamSessionId &&
      !opts.readonly;
    if (isImportedFirstLaunch) {
      const decided = await runImportedFirstLaunchFlow(term, chosen, choice, opts);
      if (decided.kind === "cancel") {
        return null;
      }
      if (decided.kind === "back") {
        continue;
      }
      return decided.ctx;
    }
    return {
      sessionId: choice.sessionId,
      agentId: choice.agentId ?? "",
      cwd,
    };
  }
}

// Action-then-cwd wizard for imported-first-launch sessions. Returned
// shape is a small sum type so the caller can either commit
// (kind:"ctx"), bail entirely (kind:"cancel"), or re-show the picker
// (kind:"back").
type ImportedFirstLaunchDecision =
  | { kind: "ctx"; ctx: SessionContext }
  | { kind: "cancel" }
  | { kind: "back" };

async function runImportedFirstLaunchFlow(
  term: termkit.Terminal,
  chosen: DiscoveredSession,
  choice: PickerResult & { kind: "attach" },
  opts: TuiOptions,
): Promise<ImportedFirstLaunchDecision> {
  // Inner loop: cwd dialog's Esc returns "back" to re-show the action
  // dialog. Action dialog's Esc bubbles out as "back" so the picker
  // re-shows.
  while (true) {
    const action = await promptForImportAction(term, chosen);
    if (action === "cancel") {
      return { kind: "cancel" };
    }
    if (action === "back") {
      return { kind: "back" };
    }
    if (action === "view") {
      // Mirror the picker's `v` path: flip opts.readonly so the WS
      // attach payload sets readonly:true (daemon takes the viewer
      // path, no agent resurrect). The runtime opts is the same
      // object referenced by the attach call later in runSession.
      opts.readonly = true;
      const agentId = choice.agentId ?? chosen.agentId ?? "";
      return {
        kind: "ctx",
        ctx: {
          sessionId: choice.sessionId,
          agentId,
          cwd: chosen.cwd,
        },
      };
    }
    // action === "fork-local"
    const cwdResult = await promptForImportCwd(term, chosen);
    if (cwdResult.kind === "cancel") {
      return { kind: "cancel" };
    }
    if (cwdResult.kind === "back") {
      continue;
    }
    const agentId = choice.agentId ?? chosen.agentId ?? "";
    return {
      kind: "ctx",
      ctx: {
        sessionId: choice.sessionId,
        agentId,
        cwd: cwdResult.path,
        importAttachHint: { agentId, cwd: cwdResult.path },
      },
    };
  }
}

function newCtx(
  opts: TuiOptions,
  cwd: string,
  config: HydraConfig,
): SessionContext {
  return {
    sessionId: "__new__",
    agentId: opts.agentId ?? config.defaultAgent ?? "",
    cwd,
  };
}

// Always-on append-only log of every session/update the TUI receives,
// paired with the RenderEvent kind we mapped it to (or null when the
// mapper rejected the shape). Default path is ~/.hydra-acp/tui.log so a
// user reporting "thoughts/tools aren't rendering" has a ready artifact
// to share. HYDRA_TUI_DEBUG_LOG overrides the path; setting it to an
// empty string disables logging.
let logMaxBytes = 5 * 1024 * 1024;
function debugLogUpdate(update: unknown, event: RenderEvent | null): void {
  writeDebugLine({
    src: "session/update",
    update,
    event: event === null ? null : { kind: event.kind },
  });
}

function writeDebugLine(payload: Record<string, unknown>): void {
  const override = process.env.HYDRA_TUI_DEBUG_LOG;
  const target = override === undefined ? paths.tuiLogFile() : override;
  if (target.length === 0) {
    return;
  }
  try {
    rotateIfBig(target);
    const line = JSON.stringify({
      t: new Date().toISOString(),
      ...payload,
    });
    appendFileSync(target, `${line}\n`);
  } catch {
    void 0;
  }
}

// Single-line, redraw-in-place status indicator used in the pre-screen
// gap between the picker closing and screen.start() entering the
// alternate screen. Backs the launch label ("Starting new session…"
// / "Resuming session…") and overwrites it with live agent-install
// progress when the daemon fires hydra-acp/agent_install_progress.
//
// Implementation notes:
//   - We never know the previous line's printed width precisely (TTY
//     line wrap, double-width glyphs), so we redraw by writing CR +
//     eraseLineAfter + new content rather than counting columns.
//   - OSC 9;4 (indeterminate pulse: ESC]9;4;3 ST, clear: ESC]9;4;0 ST)
//     is emitted directly here — Screen.writeProgressIndicator only
//     fires after .start(), and the install happens before that.
//     Terminals that don't implement the sequence ignore it silently.
//   - finalize() is idempotent: calling it after screen.start() (which
//     wipes the line via alt-screen switch) is a no-op.
interface InstallStatusLine {
  write(text: string): void;
  applyProgress(event: AgentInstallProgressParams): void;
  finalize(): void;
}

function createInstallStatusLine(
  term: termkit.Terminal,
  baseLabel: string,
): InstallStatusLine {
  let finalized = false;
  let lastText = "";
  let osc94Active = false;

  const writeOsc94 = (state: 0 | 3): void => {
    if (finalized) {
      return;
    }
    if (state === 3 && osc94Active) {
      return;
    }
    if (state === 0 && !osc94Active) {
      return;
    }
    osc94Active = state === 3;
    process.stdout.write(`\x1b]9;4;${state}\x1b\\`);
  };

  const redraw = (text: string): void => {
    if (finalized) {
      return;
    }
    // CR + eraseLineAfter() rewrites in place without scrolling. We
    // intentionally do NOT emit a trailing newline — the line stays
    // open for the next redraw, then finalize() drops a newline once.
    process.stdout.write("\r");
    term.eraseLineAfter();
    term.brightYellow(text);
    lastText = text;
  };

  const formatProgressText = (event: AgentInstallProgressParams): string => {
    const idVer = `${event.agentId}@${event.version}`;
    if (event.source === "npm") {
      if (event.phase === "install_start" || event.phase === "download_start") {
        return `${baseLabel} installing ${idVer} via npm…`;
      }
      if (event.phase === "installed") {
        return `${baseLabel} ${idVer} installed`;
      }
      return `${baseLabel} installing ${idVer} via npm…`;
    }
    // binary
    if (event.phase === "download_start" || event.phase === "download_progress") {
      const received = event.receivedBytes ?? 0;
      const total = event.totalBytes ?? 0;
      const rxMb = (received / 1_000_000).toFixed(1);
      if (total > 0) {
        const totalMb = (total / 1_000_000).toFixed(1);
        const pct = Math.min(100, Math.floor((received / total) * 100));
        return `${baseLabel} downloading ${idVer} ${rxMb}/${totalMb} MB (${pct}%)`;
      }
      return `${baseLabel} downloading ${idVer} ${rxMb} MB`;
    }
    if (event.phase === "download_done") {
      return `${baseLabel} downloaded ${idVer}, verifying…`;
    }
    if (event.phase === "extract") {
      return `${baseLabel} extracting ${idVer}…`;
    }
    if (event.phase === "installed") {
      return `${baseLabel} ${idVer} installed`;
    }
    return lastText || baseLabel;
  };

  return {
    write(text) {
      if (finalized) {
        return;
      }
      // First write — no leading CR needed, the cursor is already at
      // column 1. Match the existing "static label" behavior of writing
      // a single yellow line without a newline yet.
      term.brightYellow(text);
      lastText = text;
    },
    applyProgress(event) {
      if (finalized) {
        return;
      }
      const isActive =
        event.phase === "download_start" ||
        event.phase === "download_progress" ||
        event.phase === "install_start" ||
        event.phase === "extract" ||
        event.phase === "download_done";
      if (isActive) {
        writeOsc94(3);
      } else if (event.phase === "installed") {
        writeOsc94(0);
      }
      redraw(formatProgressText(event));
    },
    finalize() {
      if (finalized) {
        return;
      }
      finalized = true;
      writeOsc94(0);
      // Drop a newline so anything we print next (or the alt-screen
      // entry itself) starts on a fresh row rather than concatenating
      // onto our status line.
      process.stdout.write("\n");
    },
  };
}

// Single-step rotation: when the log crosses the size cap, rename it to
// `<path>.0` (overwriting any prior rotation) and start fresh. Bounds
// disk use at ~2x cap without depending on logrotate.
function rotateIfBig(target: string): void {
  try {
    const stat = statSync(target);
    if (stat.size < logMaxBytes) {
      return;
    }
    renameSync(target, `${target}.0`);
  } catch {
    void 0;
  }
}

