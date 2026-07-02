// Orchestrator: ties config, daemon discovery, WS connection, the screen, and
// the input dispatcher together.

import { readFileSync } from "node:fs";
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
import {
  ResilientWsStream,
  type ResilientWsUrl,
} from "../shim/resilient-ws.js";
import {
  loadConfig,
  expandHome,
  setTuiConfigValue,
  setDefaultAgent,
  hasConfiguredDefaultAgent,
  resolveInAppSelection,
  type HydraConfig,
} from "../core/config.js";
import { validateLocalCwd } from "../core/cwd.js";
import {
  resolveLocalTarget,
  type RemoteTarget,
} from "../core/remote-target.js";
import {
  ensureDaemonReachable,
  fetchDaemonHealth,
} from "../core/daemon-bootstrap.js";
import { computeConfigDigest } from "../core/config-digest.js";
import { invokedBinName } from "../core/bin-name.js";
import {
  type Question,
  CLARIFIER_QUESTION_LIST_METHOD,
  CLARIFIER_QUESTION_ANSWER_METHOD,
  CLARIFIER_QUESTION_DISMISS_METHOD,
} from "./clarifier-types.js";

export {
  CLARIFIER_QUESTION_ANSWER_METHOD,
  CLARIFIER_QUESTION_DISMISS_METHOD,
};
import { HYDRA_SESSION_PREFIX, stripHydraSessionPrefix } from "../core/session.js";
import { paths } from "../core/paths.js";
import { setLogMaxBytes, writeDebugLine } from "./debug-log.js";
import { HYDRA_VERSION } from "../core/hydra-version.js";
import {
  buildApproveResponse,
  extractPermissionDetail,
  formatPermissionDetailLine,
} from "../acp/permission-pick.js";
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
import {
  forkSession,
  killSession,
  listSessions,
  listAgents,
  pickMostRecent,
  type DiscoveredSession,
} from "./discovery.js";
import { runBtwSidechain, type SidechainEventEmitter } from "./btw/sidechain.js";
import { BtwOverlayBuffer } from "./btw/overlay-buffer.js";
import {
  createPickerPrefs,
  pickSession,
  type PickerPrefs,
  type PickerResult,
} from "./picker.js";
import { promptForImportCwd } from "./import-cwd-prompt.js";
import { promptForImportAction } from "./import-action-prompt.js";
import { promptForAgent } from "./agent-prompt.js";
import {
  promptAuthRequiredBanner,
  runAuthRetryLoop,
  type AuthOnboarding,
  type AuthRetryOutcome,
} from "./auth-required-banner.js";
import { promptStartupFailureBanner } from "./startup-failure-banner.js";
import {
  emergencyTerminalReset,
  formatElapsed,
  guardTerminalDimensions,
  Screen,
  resolveAmbiguousWide,
  setAmbiguousWide,
} from "./screen.js";
import { formatApproxTokens } from "../core/compaction-heuristic.js";
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
import { readClipboard, readPrimarySelection } from "./clipboard.js";
import fs from "node:fs/promises";
import path from "node:path";
import { computeTabCompletion } from "./completion.js";
import {
  completePathToken,
  extractPathToken,
} from "./file-completion.js";
import {
  computeAttachReconcile,
  parseReattachResponse,
  shouldDriftSnap,
  type ReattachResponseFields,
} from "./reconnect-state.js";
import {
  mapUpdate,
  normalizeAdvertisedCommands,
  sanitizeSingleLine,
  sanitizeWireText,
  type AvailableCommand,
  type AvailableMode,
  type EditDiff,
  type RenderEvent,
} from "../core/render-update.js";
import type { ConfigOption } from "../core/hydra-commands.js";
import {
  formatEditDiffBlock,
  formatEvent,
  formatExitPlanMode,
  renderToolDetail,
  setDiffContextLines,
  formatToolLine,
  isTerminalToolStatus,
  parseAgentMarkdown,
  parseThoughtMarkdown,
  truncateResultText,
  type ExitPlanState,
  type FormattedLine,
  type ToolLineState,
} from "./format.js";

// Pure helper: filter a question array down to entries that should appear
// in the ^Q modal. Both `open` (never-answered) and `pending-delivery`
// (answered but the deviation block hasn't been delivered to the agent yet)
// are editable — the user can revisit and change or dismiss either. Closed
// questions are excluded.
export function filterOpenQuestions(questions: Question[]): Question[] {
  return questions.filter(
    (q) => q.status === "open" || q.status === "pending-delivery",
  );
}

// Pure helper: pick the initial cycle-ring index for a question. For
// pending-delivery questions we surface the user's prior answer so the
// modal opens already showing what was committed — re-opening ^Q after
// a save shows "tabs" (or whatever was picked), not the agent's default.
export function initialSelectedValueIndex(question: Question): number {
  const ring = getQuestionValueRing(question);
  if (question.status === "pending-delivery" && question.userAnswer) {
    const idx = ring.indexOf(question.userAnswer);
    if (idx !== -1) {
      return idx;
    }
  }
  return 0;
}

// Display string used in the value column when a row is in dismiss-mode.
// Dismiss is NOT a member of the cycle ring — it's a separate per-row
// toggle (the `d` key) tracked in questionsDismissed; mixing it into the
// ring confused users by making "drop this question" look identical to
// picking an answer.
export const QUESTION_VALUE_DISMISS = "dismiss";

// Group identical open questions by their question text. The modal renders
// one row per group (with a (×N) suffix when N>1); answering or dismissing
// the row fans out the dispatch to every original question id in the group.
export type QuestionGroup = {
  representative: Question;
  ids: string[];
};

export function groupQuestions(questions: Question[]): QuestionGroup[] {
  const byKey = new Map<string, QuestionGroup>();
  const order: string[] = [];
  for (const q of questions) {
    const key = q.question;
    const existing = byKey.get(key);
    if (existing) {
      existing.ids.push(q.id);
    } else {
      byKey.set(key, { representative: q, ids: [q.id] });
      order.push(key);
    }
  }
  return order.map((k) => byKey.get(k)!);
}

// Pure helper: build the cycle ring for a single question. The ring is
// strictly the set of valid ANSWER values — dismiss is a separate per-row
// state (see questionsDismissed). Index 0 is the question's defaultAnswer:
// for explicit-options questions we hoist defaultAnswer to the front so a
// no-cycle save commits the agent-suggested default rather than "whichever
// option happened to be listed first."
export function getQuestionValueRing(question: Question): string[] {
  if (question.options && question.options.length > 0) {
    const rest = question.options.filter((o) => o !== question.defaultAnswer);
    if (question.options.includes(question.defaultAnswer)) {
      return [question.defaultAnswer, ...rest];
    }
    // defaultAnswer not in options — still surface it first so the user can
    // commit it without typing; the options trail after.
    return [question.defaultAnswer, ...question.options];
  }
  return [question.defaultAnswer];
}

function truncateQuestionLabel(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  if (max <= 1) {
    return "…";
  }
  return text.slice(0, max - 1) + "…";
}

// Pure helper: build a multi-row OptionsPromptSpec showing every open
// question group. Each row's value column renders the currently-selected
// answer — or "dismiss" when the row is in dismiss-mode. Dedup is hidden;
// save fans out under the hood. `touched` is still tracked by the caller
// to decide which rows dispatch, but it has no visual representation —
// the value column itself is enough cue.
export function buildAllQuestionsSpec(
  groups: QuestionGroup[],
  selectedValues: number[],
  dismissed: boolean[],
  currentRow: number,
  maxLabelWidth: number = 60,
): {
  title: string;
  options: Array<{ label: string; value: string }>;
  selectedIndex: number;
  hint?: string;
} {
  const options = groups.map((g, i) => {
    const ring = getQuestionValueRing(g.representative);
    const idx = selectedValues[i] ?? 0;
    const value = dismissed[i]
      ? QUESTION_VALUE_DISMISS
      : (ring[idx] ?? ring[0] ?? "");
    const label = truncateQuestionLabel(
      g.representative.question,
      maxLabelWidth,
    );
    return { label, value };
  });
  return {
    title: `Open questions (${groups.length})`,
    options,
    selectedIndex: Math.max(0, Math.min(groups.length - 1, currentRow)),
    hint: "↑/↓ row · ←/→ cycle · d dismiss · 1-9 jump · ⏎/Esc save · ^C discard",
  };
}

// Pure helper: given a selected option value and question, build the
// answer-or-dismiss dispatch action. `selectedValue === QUESTION_VALUE_DISMISS`
// routes to question/dismiss; anything else to question/answer.
export type QuestionDispatchAction =
  | {
      type: "answer";
      method: typeof CLARIFIER_QUESTION_ANSWER_METHOD;
      params: { sessionId: string; questionId: string; answer: string };
    }
  | {
      type: "dismiss";
      method: typeof CLARIFIER_QUESTION_DISMISS_METHOD;
      params: { sessionId: string; questionId: string };
    };

export function resolveQuestionDispatch(
  selectedValue: string,
  question: Question,
  sessionId: string,
): QuestionDispatchAction | null {
  if (selectedValue === QUESTION_VALUE_DISMISS) {
    return {
      type: "dismiss",
      method: CLARIFIER_QUESTION_DISMISS_METHOD,
      params: { sessionId, questionId: question.id },
    };
  }
  return {
    type: "answer",
    method: CLARIFIER_QUESTION_ANSWER_METHOD,
    params: { sessionId, questionId: question.id, answer: selectedValue },
  };
}

// Build the ordered list of dispatches the modal should fire on save —
// one per question id in every touched group. Duplicate groups fan out:
// the action applies to every id. Untouched rows are skipped. Dismissed
// rows emit dismiss for every id; otherwise the currently-selected ring
// value becomes the answer.
export function buildSaveDispatches(
  groups: QuestionGroup[],
  selectedValues: number[],
  touched: boolean[],
  dismissed: boolean[],
  sessionId: string,
): QuestionDispatchAction[] {
  const out: QuestionDispatchAction[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g || !touched[i]) {
      continue;
    }
    const dispatchValue = dismissed[i]
      ? QUESTION_VALUE_DISMISS
      : (getQuestionValueRing(g.representative)[selectedValues[i] ?? 0] ?? "");
    if (!dispatchValue) {
      continue;
    }
    for (const id of g.ids) {
      const synthetic: Question = { ...g.representative, id };
      const action = resolveQuestionDispatch(dispatchValue, synthetic, sessionId);
      if (action !== null) {
        out.push(action);
      }
    }
  }
  return out;
}

// Result of processing a key event in the multi-row questions modal.
export type QuestionsKeyResult =
  | { type: "noop" }
  | { type: "row"; selectedRow: number }
  | { type: "cycle"; selectedRow: number; newValueIndex: number }
  | { type: "dismiss-toggle"; selectedRow: number }
  | { type: "save"; dispatches: QuestionDispatchAction[] }
  | { type: "discard" };

/**
 * Process a key event while the questions modal is active.
 * Pure function — takes all state as parameters, returns an immutable result.
 * The caller applies mutations based on the result.
 */
export function handleQuestionsKey(
  ev: KeyEvent,
  questionsActive: boolean,
  groups: QuestionGroup[] | null,
  selectedValues: number[],
  touched: boolean[],
  dismissed: boolean[],
  currentRow: number,
  sessionId: string,
): QuestionsKeyResult {
  if (!questionsActive || groups === null || groups.length === 0) {
    return { type: "noop" };
  }
  if (ev.type === "char") {
    if (ev.ch === "d" || ev.ch === "D") {
      return { type: "dismiss-toggle", selectedRow: currentRow };
    }
    if (/^[1-9]$/.test(ev.ch)) {
      const idx = parseInt(ev.ch, 10) - 1;
      if (idx < groups.length) {
        return { type: "row", selectedRow: idx };
      }
    }
    return { type: "noop" };
  }
  if (ev.type !== "key") {
    return { type: "noop" };
  }
  const cycle = (delta: 1 | -1): QuestionsKeyResult => {
    const g = groups[currentRow];
    if (!g) {
      return { type: "noop" };
    }
    const ring = getQuestionValueRing(g.representative);
    if (ring.length === 0) {
      return { type: "noop" };
    }
    const cur = selectedValues[currentRow] ?? 0;
    const next = (cur + delta + ring.length) % ring.length;
    return { type: "cycle", selectedRow: currentRow, newValueIndex: next };
  };
  switch (ev.name) {
    case "up":
      return { type: "row", selectedRow: Math.max(0, currentRow - 1) };
    case "down":
      return {
        type: "row",
        selectedRow: Math.min(groups.length - 1, currentRow + 1),
      };
    case "right":
      return cycle(1);
    case "left":
      return cycle(-1);
    case "enter":
    case "escape":
    case "ctrl-q":
      return {
        type: "save",
        dispatches: buildSaveDispatches(
          groups,
          selectedValues,
          touched,
          dismissed,
          sessionId,
        ),
      };
    case "ctrl-c":
      return { type: "discard" };
    default:
      return { type: "noop" };
  }
}

// Parse the top-level `configOptions` field off a session/new or
// session/attach response by routing it through the same mapper used for
// config_option_update notifications, so the response and live-update
// paths share one shape. Returns undefined when the field is absent.
function parseResponseConfigOptions(
  raw: unknown,
): ConfigOption[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const event = mapUpdate({
    sessionUpdate: "config_option_update",
    configOptions: raw,
  });
  return event && event.kind === "config-options" ? event.options : undefined;
}

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
  // Resume hint forwarded from the ^p picker through the runSession
  // loop. resolveSession's short-circuit copies it onto the returned
  // SessionContext so the WS attach builds the _meta resume payload.
  // Used both for first-launch imports (upstreamSessionId="" routes
  // through the import-reseed path) and for repairing a local session
  // whose recorded cwd no longer exists (real upstreamSessionId, normal
  // session/load path). Cleared by the next attach.
  resumeHint?: {
    agentId: string;
    cwd: string;
    upstreamSessionId: string;
  };
  // Auto-approve every session/request_permission instead of showing
  // the modal. Wire bypass for the user; the CLI prints a stderr
  // warning at startup so it's never silent. Useful for unattended
  // demos and trusted local agents, not for shared environments.
  dangerouslySkipPermissions?: boolean;
  // Debug-only: replay the session's recorded history at its original
  // per-chunk granularity and timing instead of the normal coalesced
  // instant replay. Used to reproduce streaming render behavior (e.g.
  // flicker) deterministically. dripSpeed scales the original timing
  // (>1 = faster). Set via `--drip` / `--drip-speed`.
  drip?: boolean;
  dripSpeed?: number;
}

// Shared view-only preferences that persist across the runSession loop
// (picker switch, ^T cycle, forced reconnect) so toggles set by the
// user during one session carry into the next. Seeded once from config
// in runTuiApp; mutated by hotkey handlers inside runSession.
interface ViewPrefs {
  showThoughts: boolean;
  // Whether the tools block is expanded. Lives here (rather than as a
  // per-turn local) so the ^O session-options toggle persists across
  // turns, /clear, and session switches until the user flips it back.
  toolsExpanded: boolean;
  // Whether the plan block shows every entry (true) or the capped
  // sliding window around the active entry (false). Persisted like the
  // others; the ^O dialog flips it live for the current turn's plan.
  planExpanded: boolean;
  // Mirror of config.tui.showFileUpdates so the options dialog can flip
  // it live (edit ↔ diff) without persisting to config.
  showFileUpdates: "none" | "edit" | "diff";
  // Whether mouse capture is on (wheel scrolls vs. native text select).
  mouseEnabled: boolean;
  // Whether the in-app text-selection feature is on. Independent of
  // mouseEnabled — see core/config.ts resolveInAppSelection for the
  // default (follows mouse capture) and the override semantics.
  inAppSelectionEnabled: boolean;
  // What unmodified Enter does in the composer. Mirrors
  // config.tui.defaultEnterAction; the options dialog flips it live.
  defaultEnterAction: "enqueue" | "amend";
  // In-process memory of the last agent the user picked in the new-session
  // agent prompt. Used to highlight that row first on the next prompt so
  // they don't have to scroll back. Not persisted: pressing `s` in the
  // picker is still the explicit "save as default" path.
  lastChosenAgent?: string;
}

interface SessionContext {
  sessionId: string;
  agentId: string;
  cwd: string;
  // The user picked a local cwd via promptForImportCwd. We forward a
  // full resume hint on the initial session/attach so the daemon
  // resurrects with that cwd. upstreamSessionId === "" takes the
  // import-reseed path (first-launch imports); a real upstreamSessionId
  // takes the normal session/load path (repairing a local session whose
  // recorded cwd no longer exists).
  resumeHint?: {
    agentId: string;
    cwd: string;
    upstreamSessionId: string;
  };
  // True when this ctx was just minted by runForkFlow (the user picked
  // "fork from here" in the picker / /btw flow). Drives the launch
  // status line so the user sees "Forking session…" instead of the
  // generic "Resuming session…" while the daemon's synopsis pass runs.
  isFreshFork?: boolean;
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
  ["Tab", "indent · slash-command / file-path completion"],
  null,
  ["↑ / ↓", "prompt history · queue navigation"],
  ["←/→ Home/End", "cursor movement"],
  ["Alt+B / Alt+F", "word back / forward"],
  ["^A / ^E", "line start / end"],
  ["^W / ^U / ^K", "kill word / line / to end"],
  ["^Y", "yank last kill"],
  null,
  ["^P", "switch session (picker)"],
  ["Alt+N / Alt+Tab", "next warm session"],
  ["^T", "show / hide thoughts"],
  ["^V", "paste image from clipboard"],
  ["^O", "session options (tools · plan · thoughts · diffs · mouse · enter)"],
  null,
  ["^R", "history reverse search (^S walks forward once engaged)"],
  ["PgUp / PgDn", "scroll scrollback"],
  ["Mouse wheel", "scroll scrollback (when mouse capture is on)"],
  ["Middle-click", "paste PRIMARY selection (terminal-style)"],
  ["Right-click", "extend selection to click (drag past top/bottom to autoscroll)"],
  ["^X", "toggle mouse capture (wheel scroll vs. text selection)"],
  null,
  ["^C", "cancel turn (twice to exit)"],
  ["Esc", "cancel turn and prefill draft"],
  ["^D", "exit (or delete-forward in prompt)"],
  ["^L", "force full redraw"],
  ["^G", "toggle this help"],
];

// Pure function: toggles a toolCallId in the perToolExpanded set.
// Exported for unit testing without wiring through runSession.
export function toggleToolExpansion(
  toolCallId: string,
  perToolExpanded: Set<string>,
): void {
  if (perToolExpanded.has(toolCallId)) {
    perToolExpanded.delete(toolCallId);
  } else {
    perToolExpanded.add(toolCallId);
  }
}

// Pure function: resolves what a tools-click should do based on rowOffset.
// Returns null when the click has no effect (no rowOwners entry or null id).
// Exported for unit testing without wiring through runSession.
export function resolveToolsClick(
  key: string,
  rowOffset: number,
  rowOwners: Map<string, (string | null)[]>,
): { toolCallId: string } | null {
  if (!key.startsWith("tools:")) {
    return null;
  }
  if (rowOffset === 0) {
    // Header click — not a per-tool action.
    return null;
  }
  const owners = rowOwners.get(key);
  if (!owners) {
    return null;
  }
  const toolCallId = owners[rowOffset];
  if (!toolCallId) {
    return null;
  }
  return { toolCallId };
}

let crashLoggingInstalled = false;
// Installed before any TUI work so a crash in the pre-screen window —
// the picker, the new-session agent prompt, the daemon handshake — lands
// in tui.log. Screen's emergency handlers only cover the in-session
// phase, and the bare stderr stack we'd otherwise print there gets wiped
// by the alt-screen reset on the way out, so without this a pre-screen
// crash leaves no trace anywhere. Registered first, so it wins over
// Screen's later uncaughtException listener.
function installCrashLogging(): void {
  if (crashLoggingInstalled) {
    return;
  }
  crashLoggingInstalled = true;
  const stackOf = (reason: unknown): string =>
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  process.on("uncaughtException", (err) => {
    writeDebugLine({ src: "uncaughtException", stack: stackOf(err) });
    emergencyTerminalReset();
    process.stderr.write(`\nuncaught: ${stackOf(err)}\n`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    writeDebugLine({ src: "unhandledRejection", stack: stackOf(reason) });
    emergencyTerminalReset();
    process.stderr.write(`\nunhandled rejection: ${stackOf(reason)}\n`);
    process.exit(1);
  });
  process.on("exit", (code) => {
    if (code !== 0) {
      writeDebugLine({ src: "process-exit", code });
    }
  });
}

export async function runTuiApp(opts: TuiOptions): Promise<void> {
  installCrashLogging();
  const config = await loadConfig();
  // Local daemon target unless the caller pre-resolved a remote one.
  // `hydra session attach hydra://...` does the resolution up front so
  // the password prompt happens before we touch the terminal; the
  // local TUI invocation falls through to resolveLocalTarget here.
  const target = opts.target ?? (await resolveLocalTarget(config));
  setLogMaxBytes(config.tui.logMaxBytes);
  // Only autostart the daemon when it's on this machine. Remote
  // targets get a connection error from the WS layer if the daemon
  // isn't up, which is the right behavior (we can't reach across the
  // network to spawn anything).
  if (target.isLocal && !opts.target) {
    await ensureDaemonReachable(config);
  }
  const term = termkit.terminal;
  // terminal-kit hands back Infinity for width/height when stdout isn't a
  // detectable TTY; left unclamped that overflows the render math into a
  // `RangeError: Invalid string length`. Clamp once, at the source.
  guardTerminalDimensions(term);

  // Filled in by runSession as soon as a session is attached/created.
  // Used to print a "Coninue: …" hint on the way out so the user
  // doesn't have to dig through `hydra-acp sessions list` to come back.
  const exitHint: { sessionId?: string; readonly?: boolean } = {};
  // TUI-process-wide view preferences. Each runSession() invocation reads
  // and mutates this container so that toggles (e.g. ^T thought
  // visibility) outlive the per-session re-attach loop that picker /
  // ^T cycle / forced reconnect drives. Seeded once from config; the
  // hotkey handler inside runSession mutates in place.
  const viewPrefs: ViewPrefs = {
    showThoughts: config.tui.showThoughts,
    toolsExpanded: false,
    planExpanded: false,
    showFileUpdates: config.tui.showFileUpdates,
    mouseEnabled: config.tui.mouse,
    inAppSelectionEnabled: resolveInAppSelection(config),
    defaultEnterAction: config.tui.defaultEnterAction,
    ...(opts.agentId ? { lastChosenAgent: opts.agentId } : {}),
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
  // Warn (post-TUI, in the host shell) when the running daemon is
  // stale: either older/newer than this CLI, or booted from a config
  // that has since been edited on disk. Both states are silently
  // wrong-looking from inside a session, so surface them as the user
  // returns to the shell. TTY-only — piped output shouldn't see this.
  if (process.stdout.isTTY) {
    const health = await fetchDaemonHealth(config);
    if (health?.version !== undefined) {
      const versionMismatch = health.version !== HYDRA_VERSION;
      const localDigest = computeConfigDigest(config);
      const configMismatch =
        health.configDigest !== undefined &&
        health.configDigest !== localDigest;
      if (versionMismatch || configMismatch) {
        const reason = versionMismatch
          ? `daemon ${health.version} ≠ cli ${HYDRA_VERSION}`
          : "config changed since daemon started";
        const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
        process.stderr.write(
          yellow(
            `! ${reason} — run \`${invokedBinName()} daemon restart\` to apply.`,
          ) + "\n",
        );
      }
    }
  }
  // Resume hint is only useful for humans — piped output (e.g. into
  // an editor's "run command" pane) treats this as noise. Skip when
  // stdout isn't a TTY.
  if (exitHint.sessionId && process.stdout.isTTY) {
    const short = stripHydraSessionPrefix(exitHint.sessionId);
    const flags = exitHint.readonly ? " --readonly" : "";
    process.stdout.write(
      `Continue: ${invokedBinName()} --session ${short}${flags}\n`,
    );
  }
}

// Pure tools-block renderer. All turn-scoped inputs are passed in so it
// serves both the live block (current toolStates/order) and a click-driven
// re-render of a frozen snapshot. `expanded` decides whether the rolling
// collapse cap applies; `endedAt` null means the block is still live.
// `perToolExpanded` controls per-tool inline expansion — when a tool's
// id is present, its detail body (detail, errorText, resultText) renders
// inline below the summary row. Exported for unit testing without wiring
// through runSession's closure scope.
export function _buildToolsLines(args: {
  order: string[];
  states: Map<string, ToolLineState>;
  startedAt: number;
  endedAt: number | null;
  stopReason: string | null;
  expanded: boolean;
  perToolExpanded?: Set<string>;
  collapsedLimit?: number;
}): { lines: FormattedLine[]; rowOwners: (string | null)[] } {
  const { order, states, startedAt, endedAt, stopReason: stop, perToolExpanded, collapsedLimit = 20 } = args;
  const total = order.length;
  // limit <= 0 disables the cap — render every row regardless of
  // expanded so the ^O toggle is a no-op in unlimited mode.
  const capped = collapsedLimit > 0;
  // Collapsed view: show the most recent `collapsedLimit` rows, plus any
  // earlier rows whose tool call is still running (non-terminal) so the
  // user never loses sight of in-flight work just because newer tools
  // have piled on top of it.
  let visibleIds: string[];
  if (!capped || args.expanded) {
    visibleIds = order;
  } else {
    const tailStart = Math.max(0, total - collapsedLimit);
    const recent = order.slice(tailStart);
    const earlierRunning: string[] = [];
    for (let i = 0; i < tailStart; i++) {
      const id = order[i];
      if (id === undefined) continue;
      const st = states.get(id);
      if (st && !isTerminalToolStatus(st.status)) {
        earlierRunning.push(id);
      }
    }
    visibleIds = [...earlierRunning, ...recent];
  }
  const hidden = total - visibleIds.length;
  const inProgress = endedAt === null;
  const end = endedAt ?? Date.now();
  const elapsed = end - startedAt;
  // Any frozen non-success stopReason gets the loud "stopped (<reason>)"
  // treatment so cancel/refusal/max_tokens etc. aren't visually identical
  // to a normal end_turn finish. Amended is the exception: a deliberate
  // user replacement, not a failure — rendered dim with a softer label.
  const stoppedReason =
    !inProgress && stop !== null && stop !== "end_turn" ? stop : null;
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
    // Surface the hidden count while the block is live and capped so the
    // user knows there's more behind the collapse. Expand/collapse now
    // lives in the ^O options dialog, so we don't advertise a hotkey
    // here (it would be misleading — ^O opens the dialog, not a toggle).
    if (inProgress && capped && hidden > 0) {
      parts.push(`${hidden} hidden`);
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
  // rowOwners[0] is always null (header line); subsequent entries map to
  // the toolCallId of the tool that produced them.
  const rowOwners: (string | null)[] = [null];
  for (const id of visibleIds) {
    const state = states.get(id);
    if (state) {
      const toolLines = formatToolLine(state, end);
      for (const l of toolLines) l.hoverSubKey = id;
      lines.push(...toolLines);
      // Every line emitted for this tool is owned by that tool's id.
      rowOwners.push(...toolLines.map(() => id));
      // When the tool is expanded and not an edit/write tool, render its
      // detail body inline below the summary row.
      if (perToolExpanded?.has(id)) {
        const bodyLines = renderToolDetail(state);
        for (const l of bodyLines) l.hoverSubKey = id;
        lines.push(...bodyLines);
        rowOwners.push(...bodyLines.map(() => id));
      }
    }
  }
  return { lines, rowOwners };
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
  const ctx = await resolveSession(term, config, target, opts, pickerPrefs, viewPrefs);
  if (!ctx) {
    // Picker was aborted (Ctrl+C / Esc). Belt-and-suspenders grab
    // release — the picker already does this on every exit path, but
    // a leaked grab here would keep the event loop alive past return.
    term.grabInput(false);
    writeDebugLine({ src: "grab", site: "runSession.picker-aborted", on: false });
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
  // npm package is being downloaded (see hydra-acp/agents/install_progress
  // handler below) so the user gets bytes-and-percent feedback during
  // what would otherwise look like a multi-second hang.
  const launchLabelBase =
    ctx.sessionId === "__new__"
      ? "Starting new session…"
      : ctx.isFreshFork
        ? "Forking session…"
        : "Resuming session…";
  const installStatus = createInstallStatusLine(term, launchLabelBase);
  installStatus.write(launchLabelBase);

  // For local targets the URL embeds the daemon's plain-HTTP loopback
  // port — an ephemeral that changes across `daemon restart`. Pass a
  // resolver so each reconnect re-reads the pidfile and picks up the
  // current port. Remote targets stay with a fixed URL.
  const wsUrl: ResilientWsUrl = target.isLocal
    ? async (): Promise<string> => {
        const fresh = await resolveLocalTarget(await loadConfig());
        return fresh.wsUrl;
      }
    : target.wsUrl;
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
    log: (line) => writeDebugLine({ src: "resilient-ws", line }),
  });
  const conn = new JsonRpcConnection(stream);
  await stream.start();

  // Subscribe BEFORE issuing session/new or session/attach. The daemon
  // fires hydra-acp/agents/install_progress notifications during those
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
  let bufferedEvents: Array<{ event: RenderEvent; rawUpdate?: unknown }> = [];
  let applyRenderEvent: ((event: RenderEvent, rawUpdate?: unknown) => void) | null = null;
  // Flips true the moment teardown starts. Notification/request handlers
  // check this and bail before touching the screen — otherwise updates
  // streaming in during a long turn keep painting after we've left the
  // alternate screen, scrambling the host shell on detach.
  let teardownStarted = false;
  // True while applyRenderEvent is processing a replay buffer (initial
  // attach drain or onReconnect after_message drain). The drift-reconcile
  // snap inside the turn-complete branch reads this — it must NOT fire
  // while replaying historical turn_completes, because there pendingTurns
  // above 0 represents the still-open turn at the head of history, not
  // local drift. See shouldDriftSnap in reconnect-state.ts.
  let replayDraining = false;
  const appendRender = (event: RenderEvent | null, rawUpdate?: unknown): void => {
    if (!event) {
      return;
    }
    if (applyRenderEvent) {
      applyRenderEvent(event, rawUpdate);
    } else {
      bufferedEvents.push({ event, rawUpdate });
    }
  };

  // Last worker task id observed when opening an agent/thought/tool block.
  // Used to emit a single "── Tn ──" header line whenever the active
  // worker changes (or transitions to/from undefined), so consecutive
  // blocks from the same worker don't repeat the label.
  let lastWorkerTaskId: string | undefined;

  const maybeEmitWorkerHeader = (workerTaskId: string | undefined): void => {
    if (workerTaskId === lastWorkerTaskId) {
      return;
    }
    lastWorkerTaskId = workerTaskId;
    if (workerTaskId === undefined) {
      return;
    }
    screen.appendLines([{ prefix: "  ", body: `── T${workerTaskId} ──`, bodyStyle: "dim" }]);
  };

  // Holds the currently-active sidechain emitter so /btw can be cancelled
  // on session teardown or switch. btwSessionId tracks the forked
  // (daemon-side) sessionId — kept around across /btw invocations to
  // enable reuse: a follow-up /btw on a still-warm fork skips the
  // expensive forkSession + seedFromImport round-trip. btwReusableDirty
  // flips true the moment the main session has a new turn_complete,
  // signalling that the side fork's context is stale and the next /btw
  // must fork fresh. The generation counter handles rapid double-/btw.
  let currentSidechain: SidechainEventEmitter | null = null;
  let btwSessionId: string | null = null;
  let btwReusableDirty = false;
  let btwStartGen = 0;

  // Count of prompts currently in flight on the daemon — across ALL
  // clients, not just ours. Incremented when we observe a peer's
  // prompt_received (the daemon excludes us from our own broadcasts, so
  // a user-text notification arriving here is always a peer) or when we
  // start one of our own (in runPrompt). Decremented on every
  // turn_complete (peer's, observed here; ours, in runPrompt's finally).
  // Hydra serializes session/prompt requests on the wire so we don't
  // gate sending on this — it's purely for the banner busy state.
  let pendingTurns = 0;
  // True while the attach-time compaction prompt is showing. Dismisses
  // on y (triggers compact) or n (dismiss for this attach).
  let compactionPromptActive = false;
  // Set when the user has ^C-cancelled the in-flight turn but it hasn't
  // settled yet. While true the banner shows "cancelling" and the OS
  // progress pulse (OSC 9;4) stays off — session/cancel is fire-and-forget,
  // so without this the pulse would keep going until the agent acks (or
  // forever, if it never does). Cleared by adjustPendingTurns on settle or
  // when a new turn proves the session is genuinely busy again.
  let cancelling = false;
  // messageId of the prompt currently being processed by the agent
  // (whether ours or a peer's). Tracked from prompt_received and
  // cleared on turn_complete. Used as the targetMessageId for
  // hydra-acp/prompt/amend when the user presses Shift+Enter.
  let currentHeadMessageId: string | undefined;
  // Wall-clock moment the session became busy (pendingTurns went 0 → >0).
  // Drives the banner's elapsed counter so the user sees "● running 30s"
  // for peer-triggered turns too, not just our own.
  let sessionBusySince: number | null = null;
  let sessionElapsedTimer: NodeJS.Timeout | null = null;
  // Timer that periodically polls the daemon for the current session's
  // forkSynthesisState so the banner indicator stays in sync while
  // attached. Stopped when synthesis completes, fails, or on teardown.
  let synthesisPollTimer: NodeJS.Timeout | null = null;
  // Wall-clock moment of the most recent session/update we received from
  // the daemon. The 1Hz timer reads this to detect a stalled upstream
  // (silence past STALL_THRESHOLD_MS while busy) and flip the banner red.
  let lastUpdateAt: number | null = null;
  // Single 1Hz tick used by the busy banner: emits elapsedMs and a
  // stalled flag derived from the gap since the last session/update.
  // Used from the pendingTurns 0 → >0 transition and from the two
  // reattach/reconcile paths that adopt an in-flight turn after the
  // screen comes up. Returns the interval handle so the caller can
  // stash it in sessionElapsedTimer and clearInterval on teardown.
  const startSessionElapsedTimer = (): NodeJS.Timeout => {
    return setInterval(() => {
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
  };
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
      cancelling = false;
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
        sessionElapsedTimer = startSessionElapsedTimer();
      }
    } else if (before > 0 && pendingTurns === 0) {
      cancelling = false;
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
    } else if (pendingTurns > 0 && cancelling) {
      // A turn started (or one of several remains) while we were
      // optimistically showing "cancelling" — the session is genuinely
      // busy, so restore the busy banner and progress pulse.
      cancelling = false;
      if (screenReady) {
        screenRef!.setBanner({ status: "busy", stalled: false });
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
    "config_option_update",
    "hydra_compaction",
    "clarifier_question_asked",
    "clarifier_question_answered",
    "clarifier_question_dismissed",
  ]);
  const handleSessionUpdate = (params: unknown): void => {
    const { update } = (params ?? {}) as { update?: unknown };
    const event = mapUpdate(update, { cwd: resolvedCwd });
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
    // them when computing the replay cutoff.
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
      // The main session has advanced — any retained /btw fork's
      // context is now stale. Next /btw must fork fresh.
      btwReusableDirty = true;
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
    if (rawTag === "hydra_compaction") {
      handleCompactionUpdate(update);
      return;
    }
    if (rawTag === "clarifier_question_asked") {
      const u = update as { question?: { question?: unknown } };
      const text = typeof u.question?.question === "string" ? u.question.question : "";
      const short = text.length > 50 ? text.slice(0, 49) + "…" : text;
      screen.notify(short ? `new question: ${short} — ^Q to view` : "new clarifier question — ^Q to view");
      return;
    }
    if (rawTag === "clarifier_question_answered" || rawTag === "clarifier_question_dismissed") {
      // No banner — the user just acted (or the agent self-cleaned).
      // Future: tick a counter for the picker badge.
      return;
    }
    appendRender(event, update);
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
  conn.onNotification("hydra-acp/session/closed", () => {
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

  // Epoch ms of the last hydra-acp/cancel_failed we surfaced. The runPrompt
  // cancel-timeout backstop checks this to avoid double-warning when the
  // agent already told us (via an error frame) that cancel is unsupported.
  let lastCancelFailedAt = 0;
  // Set when a soft cancel was rejected/ignored for the current turn, so a
  // subsequent cancel keypress escalates to a force-stop (kill + respawn)
  // instead of re-sending the no-op session/cancel. Reset at each new turn.
  let forceStopArmed = false;
  // How long after a user cancel we wait for the turn to actually end
  // before warning that the agent didn't acknowledge it.
  const CANCEL_ACK_TIMEOUT_MS = 4000;

  conn.onNotification("hydra-acp/prompt_queue/added", (params) => {
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
        if (teardownStarted) {
          return;
        }
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
  conn.onNotification("hydra-acp/prompt_queue/updated", (params) => {
    if (teardownStarted) return;
    const p = (params ?? {}) as {
      messageId?: unknown;
      prompt?: unknown;
    };
    if (typeof p.messageId !== "string") return;
    if (!queueCache.has(p.messageId)) return;
    queueCache.set(p.messageId, chipFromPrompt(p.messageId, p.prompt));
    // If the underlying prompt of one of our own deferred echoes was
    // mutated (via hydra-acp/prompt/update), refresh the pending echo's
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
  conn.onNotification("hydra-acp/prompt_queue/removed", (params) => {
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
          text: echo.displayText,
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

  // The agent rejected our session/cancel (e.g. current opencode, which
  // returns UnsupportedOperation/-32601 for cancel after PR #29929). The
  // daemon couldn't correlate the id-less error to a request, so it
  // surfaces it here. Tell the user the cancel didn't take and why.
  conn.onNotification("hydra-acp/cancel_failed", (params) => {
    if (teardownStarted) return;
    const p = (params ?? {}) as { code?: unknown; message?: unknown };
    const screenReady = typeof screenRef !== "undefined" && screenRef !== null;
    if (!screenReady) return;
    // Suppress the runPrompt timeout backstop — we have the precise reason.
    lastCancelFailedAt = Date.now();
    // Arm escalation: the next cancel keypress force-stops the agent.
    forceStopArmed = true;
    const code = typeof p.code === "number" ? ` (${p.code})` : "";
    const detail =
      typeof p.message === "string" && p.message.length > 0
        ? `: ${p.message}`
        : "";
    screenRef!.appendLines([
      {
        prefix: "⚠ ",
        prefixStyle: "tool-status-fail",
        body: `cancel rejected by agent${code}${detail} — this agent build may not support cancellation. Cancel again to force-stop (restarts the agent).`,
        bodyStyle: "tool-status-fail",
      },
    ]);
  });

  // Sibling client answered the permission first (or the daemon synthesized
  // a cancellation on disconnect). Reconstruct the JSON-RPC response shape
  // the modal expects from the update's `outcome` (preferred) or
  // `chosenOptionId` so the awaiting Promise resolves cleanly.
  conn.onNotification("hydra-acp/prompt/amended", (params) => {
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

  const handleCompactionUpdate = (update: unknown): void => {
    const u = (update ?? {}) as {
      phase?: unknown;
      iter?: unknown;
      attempts?: unknown;
      error?: unknown;
    };
    const phase = typeof u.phase === "string" ? u.phase : undefined;
    if (phase === "started") {
      screen.setCompactionIndicator("compacting...");
    } else if (phase === "iteration") {
      screen.setCompactionIndicator("compacting...");
    } else if (phase === "deferred") {
      screen.setCompactionIndicator("compaction queued (waiting for idle)");
    } else if (phase === "swapped") {
      screen.setCompactionIndicator(null);
      screen.notify("compacted", 2000);
    } else if (phase === "rolled_back") {
      screen.setCompactionIndicator(null);
      screen.notify("rolled back", 2000);
    } else if (phase === "failed") {
      screen.setCompactionIndicator(null);
      const raw = typeof u.error === "string" ? u.error : "unknown error";
      const truncated = raw.length > 40 ? raw.slice(0, 40) + "..." : raw;
      screen.notify(`compaction failed: ${truncated}`, 5000);
    }
  };

  // Periodically poll the daemon for the current session's forkSynthesisState.
  // When synthesis completes (field removed) or fails, clears the banner
  // indicator and stops polling. Uses a 5s interval — enough cadence to
  // give visible feedback without hammering the daemon.
  const startSynthesisPoll = (): void => {
    if (synthesisPollTimer !== null) {
      return;
    }
    synthesisPollTimer = setInterval(async () => {
      try {
        const res = await fetch(
          `${target.baseUrl}/v1/sessions/${encodeURIComponent(resolvedSessionId)}`,
          { headers: { Authorization: `Bearer ${target.token}` } },
        );
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as { forkSynthesisState?: "running" | "failed" };
        if (data.forkSynthesisState === undefined) {
          // Synthesis completed — field removed.
          screen.setSynthesisIndicator(null);
          screen.notify("synthesis complete", 2000);
          if (synthesisPollTimer !== null) {
            clearInterval(synthesisPollTimer);
            synthesisPollTimer = null;
          }
        } else if (data.forkSynthesisState === "failed") {
          screen.setSynthesisIndicator("⚠ synthesis failed");
          screen.notify("synthesis failed — fork still usable via recall", 8000);
          if (synthesisPollTimer !== null) {
            clearInterval(synthesisPollTimer);
            synthesisPollTimer = null;
          }
        }
        // "running" → keep polling, indicator stays.
      } catch {
        // Non-fatal: silently skip on any error.
      }
    }, 5_000);
  };
  const stopSynthesisPoll = (): void => {
    if (synthesisPollTimer !== null) {
      clearInterval(synthesisPollTimer);
      synthesisPollTimer = null;
    }
  };

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
        detail: string;
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
      detail: pendingPermission.detail,
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
    // --dangerously-skip-permissions: approve everything without the
    // modal. Prefer allow_once so we don't pollute the agent's persisted
    // permission rules.
    if (opts.dangerouslySkipPermissions) {
      return buildApproveResponse(params);
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
    // What's actually being accessed (path / command / url), so the modal
    // describes the request instead of leaning on a terse title like
    // "external_directory". Also subject to single-line sanitizing.
    const detail = sanitizeSingleLine(
      formatPermissionDetailLine(extractPermissionDetail(params)),
    );
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
        detail,
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
    daemonSupportsAmend = hydraMeta.prompt?.amending === true;
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
  // PoC: configOptions is a top-level response field (not _meta), so it's
  // captured directly from the response object alongside the _meta hints.
  let initialConfigOptions: ConfigOption[] | undefined;
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
  // True when the session/attach call that started this TUI is what
  // brought the session from cold → warm. Drives one-shot attach-time
  // UX (currently the compaction prompt) so re-attaches to an already
  // hot session don't keep nagging.
  let attachJustResurrected = false;
  if (ctx.sessionId === "__new__") {
    const hydraNewMeta: Record<string, unknown> = {};
    if (opts.agentId) {
      hydraNewMeta.agentId = opts.agentId;
    }
    if (opts.name) {
      hydraNewMeta.title = opts.name;
    }
    if (opts.model) {
      hydraNewMeta.model = opts.model;
    }
    const sessionNewParams = {
      cwd: ctx.cwd,
      ...(Object.keys(hydraNewMeta).length > 0
        ? { _meta: { [HYDRA_META_KEY]: hydraNewMeta } }
        : {}),
    };
    type SessionNewResult = {
      sessionId: string;
      configOptions?: unknown;
      _meta?: Record<string, unknown>;
    };
    // Wrap session/new so an AUTH_REQUIRED from the child surfaces as a
    // banner (with the registry's onboarding hints) instead of an
    // opaque crash. `r` re-issues with identical params; Esc bubbles
    // back to the picker via the runTuiApp outer loop.
    let authOutcome: AuthRetryOutcome<SessionNewResult>;
    try {
      authOutcome = await runAuthRetryLoop<SessionNewResult>({
        request: () =>
          conn.request("session/new", sessionNewParams) as Promise<SessionNewResult>,
        showBanner: (agentId, onboarding, authMethods) =>
          promptAuthRequiredBanner(term, agentId, onboarding, authMethods, {
            authenticate: (methodId) =>
              conn.request("authenticate", { methodId }),
          }),
        resolveOnboarding: async (agentId) => {
          if (!agentId) {
            return undefined;
          }
          try {
            const agents = await listAgents(target);
            const entry = agents.find((a) => a.id === agentId);
            return entry?.onboarding;
          } catch {
            return undefined;
          }
        },
        fallbackAgentId: opts.agentId,
      });
    } catch (err) {
      // Non-auth bring-up failure: the agent process died (bad install,
      // missing module, immediate exit) or the connection dropped during
      // session/new. runAuthRetryLoop only handles AUTH_REQUIRED, so this
      // would otherwise bubble to the fatal top-level catch and exit the
      // whole TUI. Report the reason and stay alive — retry the same
      // agent, or fall back to the picker to choose another.
      term.grabInput(false);
      writeDebugLine({ src: "grab", site: "runSession.session-new-failed", on: false });
      void stream.close().catch(() => undefined);
      const message = err instanceof Error ? err.message : String(err);
      writeDebugLine({
        src: "session-new-failed",
        agentId: opts.agentId ?? null,
        message,
      });
      const outcome = await promptStartupFailureBanner(term, opts.agentId, message, {
        canGoBack: !opts.forceNew,
      });
      if (outcome === "cancel") {
        return null;
      }
      const nextOpts: TuiOptions = { ...opts };
      delete nextOpts.sessionId;
      delete nextOpts.resume;
      if (outcome === "retry") {
        // Re-attempt the same agent directly (skip the picker): forceNew
        // + the existing agentId re-enters resolveSession's --new path.
        nextOpts.forceNew = true;
      } else {
        // "back" — only offered when a picker exists to return to.
        delete nextOpts.forceNew;
        delete nextOpts.agentId;
      }
      return nextOpts;
    }
    if (authOutcome.kind === "cancel") {
      term.grabInput(false);
      writeDebugLine({ src: "grab", site: "runSession.auth-cancel", on: false });
      void stream.close().catch(() => undefined);
      return null;
    }
    if (authOutcome.kind === "back") {
      term.grabInput(false);
      writeDebugLine({ src: "grab", site: "runSession.auth-back", on: false });
      void stream.close().catch(() => undefined);
      // Re-enter the outer loop with sessionId/forceNew/resume cleared
      // so resolveSession re-shows the picker. agentId is cleared so
      // the user can choose a different agent on retry; their original
      // pick is still recoverable via the agent picker.
      const nextOpts: TuiOptions = { ...opts };
      delete nextOpts.sessionId;
      delete nextOpts.forceNew;
      delete nextOpts.resume;
      delete nextOpts.agentId;
      return nextOpts;
    }
    const created = authOutcome.result;
    // Modal teardown wiped the install status line; repaint it so the
    // user sees the launch label again while session bring-up continues.
    installStatus.write(launchLabelBase);
    resolvedSessionId = created.sessionId;
    exitHint.sessionId = resolvedSessionId;
    exitHint.readonly = false;
    const hydraMeta = extractHydraMeta(created._meta ?? undefined);
    // session/new is a core spec method, so the daemon delivers our
    // clientId under _meta["hydra-acp"] rather than top-level.
    if (hydraMeta.clientId) {
      ownClientId = hydraMeta.clientId;
    }
    upstreamSessionId = hydraMeta.upstreamSessionId;
    if (hydraMeta.agentId) {
      resolvedAgentId = hydraMeta.agentId;
    }
    if (hydraMeta.cwd) {
      resolvedCwd = hydraMeta.cwd;
    }
    if (hydraMeta.title) {
      resolvedTitle = hydraMeta.title;
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
    initialConfigOptions = parseResponseConfigOptions(created.configOptions);
    initialQueue = hydraMeta.queue;
  } else {
    // Hydra-specific attach options (readonly / drip pacing) and the
    // resume hint all ride under _meta["hydra-acp"] — session/attach
    // carries only RFD #533's own fields at the top level.
    const attachHydraMeta: Record<string, unknown> = {};
    if (opts.readonly === true) {
      attachHydraMeta.readonly = true;
    }
    // The lean ref form is a win regardless of showFileUpdates: tool stdout
    // blobs are never fetched (nothing renders them), and only edit diffs
    // are pulled — lazily on expand in "edit" mode, or as they render in
    // "diff" mode. Either way it ships less than inline (which carries all
    // stdout too).
    if (config.tui.toolContent === "references") {
      attachHydraMeta.toolContent = "references";
    }
    if (opts.drip === true) {
      attachHydraMeta.replayMode = "drip";
      if (opts.dripSpeed !== undefined) {
        attachHydraMeta.dripSpeed = opts.dripSpeed;
      }
    }
    // Forward the user-chosen cwd via a full resume hint. An empty
    // upstreamSessionId routes through doResurrectFromImport
    // (first-launch imports); a real one takes the normal session/load
    // path (repairing a local session whose recorded cwd is gone).
    // Either way the daemon resurrects with this cwd instead of the
    // stale recorded one.
    if (ctx.resumeHint !== undefined) {
      attachHydraMeta.resume = {
        upstreamSessionId: ctx.resumeHint.upstreamSessionId,
        agentId: ctx.resumeHint.agentId,
        cwd: ctx.resumeHint.cwd,
      };
    }
    const attached = (await conn.request("session/attach", {
      sessionId: ctx.sessionId,
      historyPolicy: "full",
      clientInfo: { name: "hydra-acp-tui", version: HYDRA_VERSION },
      ...(Object.keys(attachHydraMeta).length > 0
        ? { _meta: { [HYDRA_META_KEY]: attachHydraMeta } }
        : {}),
    })) as {
      sessionId: string;
      clientId?: string;
      configOptions?: unknown;
      _meta?: Record<string, unknown>;
    };
    resolvedSessionId = attached.sessionId;
    if (attached.clientId) {
      ownClientId = attached.clientId;
    }
    exitHint.sessionId = resolvedSessionId;
    exitHint.readonly = opts.readonly === true;
    const hydraMeta = extractHydraMeta(attached._meta ?? undefined);
    attachJustResurrected = hydraMeta.resurrected === true;
    upstreamSessionId = hydraMeta.upstreamSessionId;
    if (hydraMeta.agentId) {
      resolvedAgentId = hydraMeta.agentId;
    }
    if (hydraMeta.cwd) {
      resolvedCwd = hydraMeta.cwd;
    }
    if (hydraMeta.title) {
      resolvedTitle = hydraMeta.title;
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
    initialConfigOptions = parseResponseConfigOptions(attached.configOptions);
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
  // Parallel to `history` but stores the placeholder form of prompts
  // composed in this process. Used only to build the dispatcher's
  // up-arrow walk so large pastes stay collapsed across submits. Disk
  // files always get the expanded form.
  let displayHistory = [...history];
  const dispatcher = new InputDispatcher({
    history: buildCombinedHistory(globalHistory, displayHistory),
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
  // `entry` is the wire form (paste placeholders expanded) — what disk
  // and the daemon see. `displayEntry` is the as-typed form with paste
  // placeholders intact; it feeds the dispatcher's up-arrow walk so
  // recall stays compact in this session. Equal when no large pastes.
  const recordHistoryEntry = (entry: string, displayEntry?: string): void => {
    const trimmed = entry.replace(/\n+$/, "");
    if (trimmed.length === 0) {
      return;
    }
    const trimmedDisplay = (displayEntry ?? entry).replace(/\n+$/, "");
    const nextSession = appendEntry(history, trimmed);
    const sessionChanged = nextSession !== history;
    history = nextSession;
    // displayHistory mirrors per-session writes one-for-one. appendEntry
    // de-dupes against the consecutive previous entry; passing the
    // display form keeps the two arrays index-aligned.
    displayHistory = appendEntry(displayHistory, trimmedDisplay);
    const nextGlobal = appendEntry(globalHistory, trimmed, config.tui.promptHistoryMaxEntries);
    const globalChanged = nextGlobal !== globalHistory;
    globalHistory = nextGlobal;
    dispatcher.setHistory(buildCombinedHistory(globalHistory, displayHistory));
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

  // Tell the wrap/truncate engine how this terminal draws ambiguous-width
  // glyphs before any line is measured, so the column budget matches the
  // render (prevents right-margin bleed on ambiguous-wide terminals).
  setAmbiguousWide(resolveAmbiguousWide(config.tui.ambiguousWidth, process.env));
  // Bound expanded-diff context so full-file edit payloads (e.g. pi's ACP
  // diff blocks) render a hunk around the change, not the whole file.
  setDiffContextLines(config.tui.diffContextLines);

  // ^Z (SIGTSTP) suspend support. Set up here so the onSuspend closure
  // can call screen.stop() / screen.start() once `screen` is bound below.
  // Wired into Screen via the onSuspend option. SIGCONT is listened on
  // process and the teardown path removes both listeners.
  // Skipped on Windows — no job-control signals there.
  let suspendInProgress = false;
  let screen!: Screen;
  const onSigCont = (): void => {
    if (!suspendInProgress) {
      return;
    }
    suspendInProgress = false;
    // Re-enter alt, re-grab input, repaint from model state. screen.start()
    // is idempotent in the "already started" sense (it returns early if
    // started=true), but at this point stop() has flipped it back to
    // false, so this runs the full setup path.
    screen.start();
  };
  const onSuspend = (): void => {
    if (suspendInProgress) {
      return;
    }
    suspendInProgress = true;
    // Full tear-down: bracketed paste off, mouse off, grabInput(false),
    // emergencyTerminalReset (which leaves the alt screen), fullscreen(false),
    // and a trailing newline so we land cleanly under any host shell job-
    // control message.
    screen.stop();
    // Raise SIGTSTP on ourselves. We don't have a handler installed for
    // it (only for SIGCONT), so Node lets the kernel apply the default
    // action and stop the process. When the user `fg`s us, SIGCONT
    // delivery fires onSigCont() above.
    process.kill(process.pid, "SIGTSTP");
  };
  if (process.platform !== "win32") {
    process.on("SIGCONT", onSigCont);
  }

  // Banner-click state. A click only counts if press and release land
  // on the same cell of the same chunk; intermediate motion / drag
  // cancels it. State lives outside the onMouse closure so the press
  // event can communicate with the release event.
  let bannerPressHit: "mode" | "pick" | "guide" | "detach" | null = null;
  let bannerPressCell: { x: number; y: number } | null = null;
  screen = new Screen({
    term,
    dispatcher,
    repaintThrottleMs: config.tui.repaintThrottleMs,
    maxScrollbackLines: config.tui.maxScrollbackLines,
    mouse: viewPrefs.mouseEnabled,
    inAppSelection: viewPrefs.inAppSelectionEnabled,
    selectionClipboard: config.tui.selectionClipboard,
    openFileCommand: config.tui.openFileCommand,
    progressIndicator: config.tui.progressIndicator,
    readonly: opts.readonly === true,
    onSuspend: process.platform !== "win32" ? onSuspend : undefined,
    // Click a collapsed/expanded scrollback block to toggle just that one
    // block (the ^O dialog toggles all blocks of a type session-wide).
    // Routes by key prefix to the matching per-block override.
    onBlockClick: (_key: string, _rowOffset: number) => {
      handleBlockClick(_key, _rowOffset);
    },
    // Double-click on a keyed block: try to open the file the block is
    // *about* (a tool's recorded path, an edit diff's target) via the
    // configured tui.openFileCommand. The app has authoritative info
    // here that the screen's row-text scan would only approximate;
    // returning true claims the gesture so the screen skips its own
    // open-file scan and the word-snap copy fallback. Returning false
    // lets the screen fall through to its row-text scan.
    onBlockDoubleClick: (key: string, rowOffset: number): boolean => {
      return handleBlockDoubleClick(key, rowOffset);
    },
    // Click a hydra://sessions/<id> link in scrollback to jump to that
    // session. Returns true to claim the gesture (skip word-snap copy).
    onHydraLinkClick: (sessionId: string): boolean => {
      void switchToSessionById(sessionId);
      return true;
    },
    // Lazy-load deferred (references-mode) diff bodies only when the block
    // scrolls into view.
    onBlockVisible: (key: string) => {
      handleBlockVisible(key);
    },
    // Hover scope: thought blocks click as a whole contiguous run (a
    // click on any member expands them together), so the hover highlight
    // should preview that grouping. For a collapsed run anchored under
    // its lead, return the saved member list directly; for expanded
    // thoughts, recompute the contiguous run on the fly.
    onHoverRun: (key: string): Set<string> | null => {
      if (!key.startsWith("thought:")) return null;
      const saved = collapsedThoughtRuns.get(key);
      if (saved !== undefined && saved.length > 0) {
        return new Set(saved);
      }
      const run = screen.contiguousRun(key, new Set(renderedThoughts.keys()));
      return run.length > 0 ? new Set(run) : null;
    },
    // Middle-click pastes the PRIMARY selection, matching native terminal
    // behavior: when mouse capture is on, the terminal can't do its own
    // middle-click paste, so we read PRIMARY and paste text into the
    // prompt. Fires on press to match the X11 middle-down convention and
    // reuses the same effect + read-only gate as the ^V keybinding.
    onMouse: (ev) => {
      // Left-click on a clickable banner chunk fires the same effect as
      // the corresponding hotkey. Click = press AND release on the same
      // cell of the same chunk; a press-drag-release (or release on a
      // different chunk than the press) is intentionally ignored so
      // accidental clicks don't fire actions. Done here (not in
      // screen.ts) so the dispatch routes through the same
      // handleEffect path as keyboard input, including the
      // readonly-forbidden gate.
      if (ev.button === "left" && ev.kind === "press") {
        bannerPressHit = screen.bannerHitAt(ev.x, ev.y);
        bannerPressCell = bannerPressHit ? { x: ev.x, y: ev.y } : null;
        return;
      }
      if (ev.button === "left" && ev.kind === "release") {
        const press = bannerPressCell;
        const hit = bannerPressHit;
        bannerPressCell = null;
        bannerPressHit = null;
        if (
          hit !== null &&
          press !== null &&
          press.x === ev.x &&
          press.y === ev.y &&
          screen.bannerHitAt(ev.x, ev.y) === hit
        ) {
          if (hit === "mode") {
            void handleModeToggle(true);
            return;
          }
          const effect: InputEffect =
            hit === "pick"
              ? { type: "switch-session" }
              : hit === "detach"
                ? { type: "exit" }
                : { type: "show-help" };
          if (opts.readonly === true && isReadonlyForbiddenEffect(effect)) {
            return;
          }
          handleEffect(effect);
          return;
        }
      }
      if (ev.kind !== "press" || ev.button !== "middle") {
        return;
      }
      const effect: InputEffect = {
        type: "attachment-request",
        source: "primary",
      };
      if (opts.readonly === true && isReadonlyForbiddenEffect(effect)) {
        return;
      }
      handleEffect(effect);
    },
    onKey: (events: KeyEvent[]) => {
      // Diagnostic: log every interceptor that swallows a key (returns
      // true). Only fires for "key" events (ignores plain char input to
      // keep the noise floor low). A ^P that produces a swallow entry
      // here identifies which modal flag was stuck active.
      for (const ev of events) {
        if (compactionPromptActive && tryHandleCompactionPromptKey(ev)) {
          if (ev.type === "key") {
            writeDebugLine({ src: "key-swallowed", site: "compactionPrompt", name: ev.name });
          }
          continue;
        }
        if (pendingPermission && tryHandlePermissionKey(ev)) {
          if (ev.type === "key") {
            writeDebugLine({ src: "key-swallowed", site: "permission", name: ev.name });
          }
          continue;
        }
        if (tryHandleHelpKey(ev)) {
          if (ev.type === "key") {
            writeDebugLine({ src: "key-swallowed", site: "help", name: ev.name });
          }
          continue;
        }
        if (tryHandleQuestionsKey(ev)) {
          if (ev.type === "key") {
            writeDebugLine({ src: "key-swallowed", site: "questions", name: ev.name });
          }
          continue;
        }
        if (tryHandleOptionsKey(ev)) {
          if (ev.type === "key") {
            writeDebugLine({ src: "key-swallowed", site: "options", name: ev.name });
          }
          continue;
        }
        if (tryHandleScrollbackSearchKey(ev)) {
          if (ev.type === "key") {
            writeDebugLine({ src: "key-swallowed", site: "scrollbackSearch", name: ev.name });
          }
          continue;
        }
        if (tryHandleCompletionKey(ev)) {
          if (ev.type === "key") {
            writeDebugLine({ src: "key-swallowed", site: "completion", name: ev.name });
          }
          continue;
        }
        if (tryHandleBtwCloseKey(ev)) {
          if (ev.type === "key") {
            writeDebugLine({ src: "key-swallowed", site: "btwClose", name: ev.name });
          }
          continue;
        }
        // Escape while scrolled back snaps the viewport to the bottom
        // instead of falling through to the composer. Runs after modal /
        // overlay / search interceptors so they keep priority, but
        // before the dispatcher so a one-tap Escape doesn't also cancel
        // an in-flight turn — the user's intent here is "get me back to
        // live", not "cancel".
        if (
          ev.type === "key" &&
          ev.name === "escape" &&
          screen.isScrolledBack()
        ) {
          screen.scrollToBottom();
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

  // Keep the plan block anchored at the bottom of its turn. Without this
  // the plan stays wherever it was first emitted (often near the top of
  // the turn, above all subsequent tool calls / agent text), forcing the
  // user to scroll up to see the current entries. The screen floats the
  // sticky block back to the tail on every append/upsert; turn-end
  // clearKey("plan") freezes the previous turn's plan in place.
  screen.setStickyBottomKey("plan");

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
    { name: "/resume", description: "Switch sessions (open the picker)" },
    {
      name: "/session",
      description: "Switch session: /session <id|next|prev> (no arg opens picker)",
    },
    {
      name: "/rename",
      description: "Rename this session (alias for /hydra title): /rename [title]",
    },
    { name: "/model", description: "Switch model: /model <model-id>" },
    { name: "/agent", description: "Switch agent via config option: /agent <agent-id>" },
    { name: "/btw", description: "Run an ancillary forked session: /btw <prompt> (no args toggles the last overlay)" },
    {
      name: "/export",
      description: "Export this session as a markdown transcript: /export [path]",
    },
  ];
  // Seeded from the attach/new response _meta so the slash-completion
  // palette is populated before any history replay or live update.
  let agentCommands: AvailableCommand[] = initialCommands ?? [];
  // Available modes advertised by the agent. Used by Shift+Tab to cycle.
  let agentModes: AvailableMode[] = initialModes ?? [];
  // PoC: the unified config-options snapshot (model/mode/agent), seeded
  // from the session/new + attach response and kept fresh by
  // config_option_update notifications. Drives the `/agent` selector.
  let agentConfigOptions: ConfigOption[] = initialConfigOptions ?? [];
  const agentConfigOption = (): ConfigOption | undefined =>
    agentConfigOptions.find((o) => o.id === "agent");

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
    // Multi-line buffer (typical of pastes) is never a slash command.
    if (buf.length > 1) {
      return [];
    }
    const space = firstLine.indexOf(" ");
    const prefix = space === -1 ? firstLine : firstLine.slice(0, space);
    // Paths like /tmp/foo or /usr/bin/x have a second slash in the first
    // token; those are never command names, so don't pop completions.
    if (prefix.lastIndexOf("/") > 0) {
      return [];
    }
    const matches = allCommands().filter((c) => c.name.startsWith(prefix));
    // If the user has typed an exact command name, they're done picking.
    // Hide the popup whether or not they've started typing arguments —
    // otherwise the lone single-row popup resurfaces the moment a space
    // is added (e.g. "/btw" hides it, "/btw foo" brought it back).
    if (matches.length === 1 && matches[0]?.name === prefix) {
      return [];
    }
    return matches;
  };

  // File-path completions surfaced after the last Tab press. Held in this
  // closure (rather than recomputed by currentCompletions) because they're
  // a one-shot reaction to Tab — refreshCompletions prefers slash-command
  // matches, then these, and any non-Tab key clears them so the list doesn't
  // linger as the user keeps typing.
  let fileCompletions: AvailableCommand[] = [];

  const refreshCompletions = (): void => {
    const slash = currentCompletions();
    if (slash.length > 0) {
      fileCompletions = [];
      screen.setCompletions(slash);
      return;
    }
    screen.setCompletions(fileCompletions);
  };

  const tryHandleCompletionKey = (ev: KeyEvent): boolean => {
    if (ev.type !== "key" || ev.name !== "tab") {
      // Any non-Tab key dismisses a lingering file-completion list.
      if (fileCompletions.length > 0) {
        fileCompletions = [];
      }
      return false;
    }
    // Slash-command completion takes precedence when the first line is a
    // /command.
    const matches = currentCompletions();
    // Tab toggles pane focus when the overlay is open AND there's no
    // active slash-completion candidate to consume the Tab. Without this
    // guard the overlay would steal Tab from /command completion the
    // moment a /btw is in progress.
    if (screen.isOverlayOpen() && matches.length === 0) {
      screen.toggleFocusedPane();
      return true;
    }
    if (matches.length > 0) {
      fileCompletions = [];
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
    }
    // Otherwise, try completing a file path under the cursor. Falling
    // through (returning false) lets the dispatcher handle Tab as indent.
    return tryHandleFileCompletion();
  };

  // Complete a filesystem path token immediately before the cursor against
  // the session cwd. Returns true when Tab was consumed (a path-like token
  // was found and the directory was readable), false to let Tab indent.
  const tryHandleFileCompletion = (): boolean => {
    const st = dispatcher.state();
    const line = st.buffer[st.row] ?? "";
    const tok = extractPathToken(line, st.col);
    if (tok === null) {
      return false;
    }
    const result = completePathToken(tok.token, resolvedCwd);
    if (result === null) {
      return false;
    }
    if (result.replacement !== tok.token) {
      dispatcher.replaceRangeOnCurrentLine(
        tok.start,
        st.col,
        result.replacement,
      );
    }
    // Show the candidate basenames when more than one matched; a unique
    // match is already committed into the buffer so the list adds nothing.
    fileCompletions =
      result.candidates.length > 1
        ? result.candidates.map((name) => ({ name }))
        : [];
    return true;
  };



  // ESC / ^C always dismisses the btw overlay when it's open, regardless
  // of pane focus or dispatcher state. Runs before dispatcher.feed so we
  // don't rely on the dispatcher emitting a cancel effect — it only does
  // so in certain states (in-flight turn, prompt buffer non-empty, etc.),
  // which made ESC feel unresponsive to the overlay in other states.
  const tryHandleBtwCloseKey = (ev: KeyEvent): boolean => {
    if (!screen.isOverlayOpen()) {
      return false;
    }
    if (ev.type !== "key") {
      return false;
    }
    if (ev.name !== "escape" && ev.name !== "ctrl-c") {
      return false;
    }
    if (currentSidechain) {
      // Cancelling mid-turn — sidechain.cancel() kills the daemon-side
      // fork. The session is gone; can't reuse it. Drop both refs.
      currentSidechain.cancel();
      currentSidechain = null;
      btwSessionId = null;
    }
    // After a clean completion currentSidechain is already null and
    // btwSessionId still points at a warm, reusable fork — leave it set
    // so the next /btw can attach to it without re-forking.
    screen.closeBtwOverlay();
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
  void getPendingUpdate()
    .then((info) => {
      if (info) {
        screen.notify(`✨ ${formatUpdateNoticeLine(info)}`, 30_000);
      }
    })
    .catch(() => undefined);

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
  // Optimistically reflect a just-issued cancel: drop the busy banner and
  // OS progress pulse now rather than waiting for the cancelled turn to
  // settle. Only when this is the sole outstanding turn — a peer/amend turn
  // still running keeps the pulse on, and adjustPendingTurns re-asserts busy
  // if one arrives while we're showing "cancelling".
  const markCancelling = (): void => {
    if (screenRef === null) {
      return;
    }
    if (pendingTurns !== 1) {
      return;
    }
    cancelling = true;
    screenRef.setBanner({
      status: "cancelling",
      elapsedMs: undefined,
      stalled: false,
    });
  };
  const sigintHandler = (): void => {
    if (turnInFlight) {
      turnInFlight.cancel();
      markCancelling();
      return;
    }
    if (pendingTurns > 0) {
      cancelRemoteTurn();
      markCancelling();
      return;
    }
    requestExit();
  };

  const requestExit = (): void => {
    stop(0);
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
      viewPrefs.defaultEnterAction === "amend"
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

  // Dismiss or act on the attach-time compaction prompt (y/n/d).
  const acceptCompaction = (): void => {
    compactionPromptActive = false;
    screen.setCompactionPrompt(null);
    // Optimistic visible feedback so the user sees something happened
    // — the daemon's phase:"started" broadcast may take a moment to
    // arrive (ephemeral-agent spawn), and this indicator flips to the
    // live one as soon as it does.
    screen.setCompactionIndicator("compaction queued...");
    const sid = resolvedSessionId;
    fetch(`${target.baseUrl}/v1/sessions/${encodeURIComponent(sid)}/compact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${target.token}` },
    }).catch(() => undefined);
  };
  const declineCompaction = (): void => {
    compactionPromptActive = false;
    screen.setCompactionPrompt(null);
  };
  const cycleCompactionSelection = (delta: number): void => {
    const current = screen.compactionPromptSpec();
    if (!current) {
      return;
    }
    const n = current.options.length;
    if (n === 0) {
      return;
    }
    const next = ((current.selectedIndex + delta) % n + n) % n;
    if (next === current.selectedIndex) {
      return;
    }
    screen.setCompactionPrompt({ ...current, selectedIndex: next });
  };
  const tryHandleCompactionPromptKey = (ev: KeyEvent): boolean => {
    if (!compactionPromptActive) {
      return false;
    }
    // Selection-based UX matches the permission prompt: arrows cycle,
    // Enter submits the highlighted option, 1/2 quick-pick by index,
    // y/n preserved as muscle-memory hotkeys, Esc cancels.
    if (ev.type === "key") {
      if (ev.name === "escape") {
        declineCompaction();
        return true;
      }
      if (ev.name === "up") {
        cycleCompactionSelection(-1);
        return true;
      }
      if (ev.name === "down") {
        cycleCompactionSelection(1);
        return true;
      }
      if (ev.name === "enter") {
        const current = screen.compactionPromptSpec();
        const selected = current?.options[current.selectedIndex];
        if (selected?.key === "y") {
          acceptCompaction();
        } else {
          declineCompaction();
        }
        return true;
      }
    }
    if (ev.type === "char") {
      const ch = ev.ch.toLowerCase();
      if (ch === "y" || ch === "1") {
        acceptCompaction();
        return true;
      }
      if (ch === "n" || ch === "2") {
        declineCompaction();
        return true;
      }
    }
    return true;
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

  // Session-options modal (^O). Each entry maps a stable id to its
  // current on/off reading and a flip that applies the live side-effect.
  // Order here is the order shown in the dialog and the 1–9 quick-toggle
  // index, so keep it stable.
  const OPTION_IDS = [
    "tools",
    "plan",
    "thoughts",
    "diffs",
    "mouse",
    "enter",
  ] as const;
  type OptionId = (typeof OPTION_IDS)[number];
  let optionsSelectedIndex = 0;
  // Multi-row questions modal state. `openQuestionGroups` is the deduped
  // snapshot pulled from the clarifier at open time — identical questions
  // collapse into one group, and dispatch fans out on save.
  // `questionsSelectedValues[i]` is the index into group i's cycle ring;
  // `questionsCurrentRow` is the highlighted row.
  let openQuestionGroups: QuestionGroup[] | null = null;
  let questionsSelectedValues: number[] = [];
  // Parallel to openQuestionGroups: touched=true for any row the user has
  // cycled or dismissed. Save only dispatches touched rows. dismissed=true
  // routes the row to question/dismiss instead of question/answer.
  let questionsTouched: boolean[] = [];
  let questionsDismissed: boolean[] = [];
  let questionsCurrentRow = 0;

  const optionValue = (id: OptionId): string => {
    switch (id) {
      case "tools":
        return viewPrefs.toolsExpanded ? "expanded" : "collapsed";
      case "plan":
        return viewPrefs.planExpanded ? "expanded" : "collapsed";
      case "thoughts":
        return viewPrefs.showThoughts ? "shown" : "hidden";
      case "diffs":
        return viewPrefs.showFileUpdates;
      case "mouse":
        return viewPrefs.mouseEnabled ? "on" : "off";
      case "enter":
        return viewPrefs.defaultEnterAction;
    }
  };

  const optionLabel = (id: OptionId): string => {
    switch (id) {
      case "tools":
        return "Tools";
      case "plan":
        return "Plan";
      case "thoughts":
        return "Thoughts";
      case "diffs":
        return "File updates";
      case "mouse":
        return "Mouse capture";
      case "enter":
        return "Enter key";
    }
  };

  const buildOptionsSpec = (): {
    title: string;
    options: Array<{ label: string; value: string }>;
    selectedIndex: number;
  } => ({
    title: "Session options",
    options: OPTION_IDS.map((id) => ({
      label: optionLabel(id),
      value: optionValue(id),
    })),
    selectedIndex: optionsSelectedIndex,
  });

  const refreshOptionsPrompt = (): void => {
    if (!screen.isOptionsPromptActive()) {
      return;
    }
    // Questions modal manages its own spec — don't overwrite it with ^O spec.
    if (openQuestionGroups !== null) {
      return;
    }
    screen.setOptionsPrompt(buildOptionsSpec());
  };

  const toggleOptionsModal = (): void => {
    if (screen.isOptionsPromptActive()) {
      screen.setOptionsPrompt(null);
      return;
    }
    optionsSelectedIndex = 0;
    screen.setOptionsPrompt(buildOptionsSpec());
  };

  // Rebuild the multi-row OptionsPromptSpec from the current modal state
  // and push it to the screen. Called after every key that changes either
  // the highlighted row or a row's selected value.
  const refreshQuestionsSpec = (): void => {
    if (openQuestionGroups === null) {
      return;
    }
    const spec = buildAllQuestionsSpec(
      openQuestionGroups,
      questionsSelectedValues,
      questionsDismissed,
      questionsCurrentRow,
    );
    screen.setOptionsPrompt(spec);
  };

  const closeQuestionsModal = (): void => {
    openQuestionGroups = null;
    questionsSelectedValues = [];
    questionsTouched = [];
    questionsDismissed = [];
    questionsCurrentRow = 0;
    screen.setOptionsPrompt(null);
  };

  const toggleQuestionsModal = async (): Promise<void> => {
    if (openQuestionGroups !== null) {
      closeQuestionsModal();
      return;
    }
    try {
      const raw = await conn.request(CLARIFIER_QUESTION_LIST_METHOD, {
        sessionId: resolvedSessionId,
      });
      const res = raw as { questions: Question[] };
      const open = filterOpenQuestions(res.questions ?? []);
      if (open.length === 0) {
        screen.notify("no open questions");
        return;
      }
      const groups = groupQuestions(open);
      openQuestionGroups = groups;
      questionsCurrentRow = 0;
      questionsSelectedValues = groups.map((g) =>
        initialSelectedValueIndex(g.representative),
      );
      questionsTouched = groups.map(() => false);
      questionsDismissed = groups.map(() => false);
      refreshQuestionsSpec();
    } catch (err: unknown) {
      screen.notify("clarifier unavailable");
      writeDebugLine({
        src: "questions",
        step: "list_failed",
        error: (err as Error).message,
      });
    }
  };

  const applyOptionToggle = (id: OptionId): void => {
    switch (id) {
      case "tools":
        viewPrefs.toolsExpanded = !viewPrefs.toolsExpanded;
        // Global toggle wins over any per-block click overrides.
        toolsOverrides.clear();
        perToolExpanded.clear();
        reRenderAllTools();
        break;
      case "plan":
        viewPrefs.planExpanded = !viewPrefs.planExpanded;
        planOverride = null;
        rerenderPlan();
        break;
      case "thoughts":
        viewPrefs.showThoughts = !viewPrefs.showThoughts;
        screen.setHideThoughts(!viewPrefs.showThoughts);
        break;
      case "diffs":
        viewPrefs.showFileUpdates =
          viewPrefs.showFileUpdates === "diff" ? "edit" : "diff";
        // Global toggle wins over any per-block click overrides.
        editDiffOverrides.clear();
        // Re-converge every diff in scrollback (this turn and past turns)
        // to the new mode: "diff" surfaces full bodies, "edit" shrinks
        // them to one-line marks.
        reRenderAllEditDiffs();
        break;
      case "mouse": {
        const next = !screen.isMouseEnabled();
        screen.setMouseEnabled(next);
        viewPrefs.mouseEnabled = next;
        break;
      }
      case "enter":
        viewPrefs.defaultEnterAction =
          viewPrefs.defaultEnterAction === "amend" ? "enqueue" : "amend";
        break;
    }
    refreshOptionsPrompt();
  };

  // Persist the selected option's current value as the config default
  // (the `s` key). Tools/Plan expand state is session-only — there's no
  // config field for it — so `s` there just says so. The rest map to a
  // tui.<key> written through the shared atomic setTuiConfigValue.
  const saveOption = (id: OptionId): void => {
    void (async (): Promise<void> => {
      try {
        switch (id) {
          case "tools":
          case "plan":
            screen.notify(`${optionLabel(id)} is session-only — not saved`);
            return;
          case "thoughts":
            await setTuiConfigValue("showThoughts", viewPrefs.showThoughts);
            break;
          case "diffs":
            await setTuiConfigValue(
              "showFileUpdates",
              viewPrefs.showFileUpdates,
            );
            break;
          case "mouse":
            await setTuiConfigValue("mouse", viewPrefs.mouseEnabled);
            break;
          case "enter":
            await setTuiConfigValue(
              "defaultEnterAction",
              viewPrefs.defaultEnterAction,
            );
            break;
        }
        screen.notify(`saved default: ${optionLabel(id)} ${optionValue(id)}`);
      } catch (err) {
        screen.notify(
          `save failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  };

  // While the options modal is open it owns input: arrows navigate,
  // Enter / 1–9 cycle the selected row's value live (this session only),
  // `s` saves the selected value as the config default, Esc or ^O closes.
  // The modal stays open after Enter / `s`. Everything else is swallowed
  // so it can't leak into the prompt buffer behind the modal.
  const tryHandleOptionsKey = (ev: KeyEvent): boolean => {
    // Questions modal takes priority — it's handled before this in the key loop.
    if (openQuestionGroups !== null) {
      return false;
    }
    if (!screen.isOptionsPromptActive()) {
      return false;
    }
    if (ev.type === "key") {
      switch (ev.name) {
        case "up":
          optionsSelectedIndex = Math.max(0, optionsSelectedIndex - 1);
          refreshOptionsPrompt();
          return true;
        case "down":
          optionsSelectedIndex = Math.min(
            OPTION_IDS.length - 1,
            optionsSelectedIndex + 1,
          );
          refreshOptionsPrompt();
          return true;
        case "enter": {
          const id = OPTION_IDS[optionsSelectedIndex];
          if (id) {
            applyOptionToggle(id);
          }
          return true;
        }
        case "ctrl-o":
        case "escape":
        case "ctrl-c":
          screen.setOptionsPrompt(null);
          return true;
        case "ctrl-d":
          // Detach must always work — close the modal and let ^D fall
          // through to the dispatcher's normal exit-on-empty-buffer path.
          screen.setOptionsPrompt(null);
          return false;
        default:
          return true;
      }
    }
    if (ev.type === "char") {
      if (/^[1-9]$/.test(ev.ch)) {
        const idx = parseInt(ev.ch, 10) - 1;
        const id = OPTION_IDS[idx];
        if (id) {
          optionsSelectedIndex = idx;
          applyOptionToggle(id);
        }
        return true;
      }
      // `s` saves the selected option's current value as the config default.
      if (ev.ch === "s" || ev.ch === "S") {
        const id = OPTION_IDS[optionsSelectedIndex];
        if (id) {
          saveOption(id);
        }
        return true;
      }
    }
    return true;
  };

  // While the questions modal is open it owns input: ↑/↓ navigate rows,
  // ←/→/Enter cycle the current row's value through its ring, 1-9 jumps
  // to a row by index, Esc/^Q saves all touched rows, ^C discards. The
  // modal stays open after a cycle so several rows can be set in one
  // visit. Everything else is swallowed.
  const tryHandleQuestionsKey = (ev: KeyEvent): boolean => {
    if (openQuestionGroups === null) {
      return false;
    }
    const result = handleQuestionsKey(
      ev,
      true,
      openQuestionGroups,
      questionsSelectedValues,
      questionsTouched,
      questionsDismissed,
      questionsCurrentRow,
      resolvedSessionId,
    );
    switch (result.type) {
      case "noop":
        return true;
      case "row":
        questionsCurrentRow = result.selectedRow;
        refreshQuestionsSpec();
        return true;
      case "cycle":
        questionsSelectedValues[result.selectedRow] = result.newValueIndex;
        questionsTouched[result.selectedRow] = true;
        // Cycling out of dismiss-mode unsets the dismiss flag — user has
        // changed their mind and wants to commit a real answer instead.
        questionsDismissed[result.selectedRow] = false;
        refreshQuestionsSpec();
        return true;
      case "dismiss-toggle": {
        const i = result.selectedRow;
        if (questionsDismissed[i]) {
          // Second press: un-dismiss back to untouched state.
          questionsDismissed[i] = false;
          questionsTouched[i] = false;
        } else {
          questionsDismissed[i] = true;
          questionsTouched[i] = true;
        }
        refreshQuestionsSpec();
        return true;
      }
      case "discard":
        closeQuestionsModal();
        return true;
      case "save": {
        const dispatches = result.dispatches;
        closeQuestionsModal();
        if (dispatches.length === 0) {
          return true;
        }
        void (async (): Promise<void> => {
          let answered = 0;
          let dismissed = 0;
          let failed = 0;
          for (const action of dispatches) {
            try {
              await conn.request(action.method, action.params);
              if (action.type === "dismiss") {
                dismissed++;
              } else {
                answered++;
              }
            } catch (err: unknown) {
              failed++;
              writeDebugLine({
                src: "questions",
                step: "dispatch_failed",
                method: action.method,
                error: (err as Error).message,
              });
            }
          }
          const parts: string[] = [];
          if (answered > 0) {
            parts.push(`${answered} answered`);
          }
          if (dismissed > 0) {
            parts.push(`${dismissed} dismissed`);
          }
          if (failed > 0) {
            parts.push(`${failed} failed`);
          }
          if (parts.length > 0) {
            screen.notify(`clarifier: ${parts.join(", ")}`);
          }
        })();
        return true;
      }
    }
    return false;
  };

  const teardown = (): void => {
    // Set first so any inbound notification/request that lands between
    // here and stream.close() bails before touching the screen.
    teardownStarted = true;
    // Cancel any in-flight btw sidechain so its events don't land on a
    // stale screen after we've torn down this session. Then kill any
    // retained reusable fork — without an active TUI it would otherwise
    // sit cold until the GC sweep.
    if (currentSidechain) {
      currentSidechain.cancel();
      currentSidechain = null;
      btwSessionId = null;
    } else if (btwSessionId !== null) {
      const dead = btwSessionId;
      void killSession(target, dead).catch(() => undefined);
      btwSessionId = null;
    }
    process.off("SIGINT", sigintHandler);
    if (process.platform !== "win32") {
      process.off("SIGCONT", onSigCont);
    }
    // The elapsed-time setInterval ticks every second and calls
    // screen.setBanner(), which writes raw cursor-position escapes to
    // stdout. Left running, it both keeps the event loop alive (so the
    // process never exits) and scrambles the host shell after we've
    // left the alternate screen.
    if (sessionElapsedTimer !== null) {
      clearInterval(sessionElapsedTimer);
      sessionElapsedTimer = null;
    }
    // Synthesis poller — same cleanup pattern as the elapsed timer.
    if (synthesisPollTimer !== null) {
      clearInterval(synthesisPollTimer);
      synthesisPollTimer = null;
    }
    for (const timer of amendPendingPaintTimers.values()) {
      clearTimeout(timer);
    }
    amendPendingPaintTimers.clear();
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
    writeDebugLine({
      src: "switch-session",
      step: "entered",
      finishSessionNull: finishSession === null,
    });
    if (!finishSession) {
      // No active resume slot — the previous runSession's resolve has
      // already been called (we're in the brief window before the outer
      // loop spawns a new runSession), OR teardown ran. Either way, ^P
      // is a no-op in this state. Flag it so we can detect "stuck null"
      // (finishSession remains null indefinitely while the screen is
      // still up).
      return;
    }
    // Cancel any in-flight btw sidechain AND kill any retained reusable
    // fork before tearing down this session. Switching sessions strands
    // the reusable — nothing left to attach to it.
    if (currentSidechain) {
      currentSidechain.cancel();
      currentSidechain = null;
      btwSessionId = null;
    } else if (btwSessionId !== null) {
      const dead = btwSessionId;
      void killSession(target, dead).catch(() => undefined);
      btwSessionId = null;
    }
    // Tear down the synthesis poller when switching away from a session.
    stopSynthesisPoll();
    screen.setSynthesisIndicator(null);
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
    // shell's main buffer flash between the warm session tearing down
    // and the picker painting from row 1. The picker's moveTo(1,1) +
    // eraseDisplayBelow simply overwrites the alt-screen buffer the
    // warm session was using; on return, screen.start() clears its
    // row-sig cache and repaints over the picker content.
    screen.pauseRepaint();
    screen.stop({ keepFullscreen: true });
    saveHistory(historyFile, history).catch(() => undefined);
    // Past this point the terminal is in cooked mode (screen.stop ran
    // grabInput(false)). Any throw / silent rejection before we either
    // (a) restart the screen, or (b) hand off to a new runSession via
    // `resume(nextOpts)`, would leave the user with a hung TUI: WS still
    // alive, but keyboard input not delivered. `handedOff` tracks the
    // hand-off branch so the finally below only restarts the screen on
    // the resume-warm-session branches (abort / cancel / back-out / any
    // exception bubbling from listSessions / pickSession / sub-prompts).
    let handedOff = false;
    try {
      // Loop: the imported-first-launch action dialog's Esc returns
      // "back" to re-show the picker, same as the initial-picker flow.
      // Picker abort exits the loop and resumes the warm session.
      let resolvedChoice: { choice: PickerResult; sessions: DiscoveredSession[] } | null = null;
      let attachOverrides: { readonly?: boolean; cwd?: string; resumeHint?: { agentId: string; cwd: string; upstreamSessionId: string } } | null = null;
      while (resolvedChoice === null) {
        // Picker manages its own interactive-only filter; ask the daemon
        // for everything and let prefs.filters.includeNonInteractive decide
        // what to render.
        const sessions = await listSessions(target, { includeNonInteractive: true });
        const choice: PickerResult = await pickSession(term, {
          cwd: resolvedCwd,
          sessions,
          config,
          target,
          currentSessionId: resolvedSessionId,
          prefs: pickerPrefs,
        });
        if (choice.kind === "abort") {
          // finally restarts the screen.
          return;
        }
        if (choice.kind === "exit") {
          // Current session was killed/deleted from inside the picker, so
          // there's nothing to resume to. Exit hydra entirely. stop(0)
          // tears the screen down itself, so suppress the finally's
          // restart by marking the hand-off taken.
          handedOff = true;
          stop(0);
          return;
        }
        if (choice.kind === "new") {
          resolvedChoice = { choice, sessions };
          break;
        }
        if (choice.kind === "fork") {
          const decided = await runForkFlow(term, target, choice, sessions);
          if (decided.kind === "cancel") {
            return;
          }
          if (decided.kind === "back") {
            continue;
          }
          // Synthesize an attach pick targeting the fresh fork id so the
          // existing attach plumbing below switches us into the new
          // session.
          const synthetic: PickerResult = {
            kind: "attach",
            sessionId: decided.ctx.sessionId,
            ...(decided.ctx.agentId ? { agentId: decided.ctx.agentId } : {}),
          };
          resolvedChoice = { choice: synthetic, sessions };
          attachOverrides = {
            readonly: false,
            cwd: decided.ctx.cwd,
          };
          if (decided.ctx.resumeHint !== undefined) {
            attachOverrides.resumeHint = decided.ctx.resumeHint;
          }
          break;
        }
        // attach: route imported-first-launch picks through the action /
        // cwd wizard. cancel aborts the switch (resume warm session);
        // back loops to re-show the picker.
        const chosen = sessions.find((s) => s.sessionId === choice.sessionId);
        const isImportedFirstLaunch =
          chosen !== undefined &&
          !!chosen.importedFromMachine &&
          !chosen.upstreamSessionId &&
          choice.readonly !== true;
        if (!isImportedFirstLaunch) {
          // Same dead-cwd repair as the initial-picker path: a local
          // session whose recorded cwd is gone can't be resumed (the agent
          // is pinned to it), so prompt for a new cwd and forward a resume
          // hint with an empty upstreamSessionId to reseed there.
          if (
            target.isLocal &&
            chosen &&
            !chosen.importedFromMachine &&
            choice.readonly !== true
          ) {
            const v = await validateLocalCwd(chosen.cwd);
            if (!v.ok) {
              const r = await promptForImportCwd(term, chosen, {
                defaultCwd: expandHome(config.defaultCwd),
                title: "Working directory missing — choose cwd",
                intro:
                  "This session's working directory no longer exists. Pick a new one:",
              });
              if (r.kind === "cancel") {
                return;
              }
              if (r.kind === "back") {
                continue;
              }
              resolvedChoice = { choice, sessions };
              attachOverrides = {
                readonly: false,
                cwd: r.path,
                resumeHint: {
                  agentId: choice.agentId ?? chosen.agentId ?? "",
                  cwd: r.path,
                  upstreamSessionId: "",
                },
              };
              break;
            }
          }
          resolvedChoice = { choice, sessions };
          break;
        }
        // Use a local opts shim so the helper can flip readonly without
        // mutating the warm session's opts (which still owns the current
        // session). We translate the shim back into attachOverrides.
        const opsShim: TuiOptions = { ...opts, readonly: false };
        const decided = await runImportedFirstLaunchFlow(term, target, chosen, choice, opsShim);
        if (decided.kind === "cancel") {
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
        if (decided.ctx.resumeHint !== undefined) {
          attachOverrides.resumeHint = decided.ctx.resumeHint;
        }
      }
      const { choice } = resolvedChoice;
      // The user is actually switching: finish the teardown and let the
      // outer loop attach the chosen session. From here on, every code
      // path hands off to a new runSession via resume() — set handedOff
      // before resume() because resume() reenters the outer loop and a
      // subsequent throw must not retry to restart this dead screen.
      const resume = finishSession;
      finishSession = null;
      process.off("SIGINT", sigintHandler);
      void stream.close().catch(() => undefined);
      handedOff = true;
      if (choice.kind === "new") {
        const { sessionId: _drop, agentId: _dropAgent, ...rest } = opts;
        void _drop;
        void _dropAgent;
        // Fresh session is never read-only; explicitly clear so a viewer
        // that pressed ^P → New doesn't inherit readonly into the new
        // session's WS attach.
        //
        // agentId is also dropped so ensureAgentForNew re-shows the picker
        // (highlighted on viewPrefs.lastChosenAgent) rather than silently
        // reusing the previous session's agent. config.defaultAgent, if
        // set, still short-circuits the picker as before.
        const nextOpts: TuiOptions = {
          ...rest,
          cwd: choice.cwd ?? resolvedCwd,
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
      if (attachOverrides?.resumeHint !== undefined) {
        nextOpts.resumeHint = attachOverrides.resumeHint;
      } else {
        // Clear any stale hint inherited from the current session's opts —
        // it was for the previous attach, not the new one.
        delete nextOpts.resumeHint;
      }
      resume(nextOpts);
    } finally {
      // If we exit without handing off (abort, cancel, back-out, or any
      // thrown rejection from listSessions / pickSession / sub-prompts),
      // resume the warm session — restoring raw mode along with it.
      // finishSession check guards against the choice.kind === "exit"
      // path where stop(0) cleared it (and screen too).
      if (!handedOff && finishSession) {
        screen.start({ skipFullscreen: true });
        screen.resumeRepaint();
      }
    }
  };

  const cycleLiveSession = async (direction: "next" | "prev" = "next"): Promise<void> => {
    if (!finishSession)
      return;
    const sessions = await listSessions(target);
    const live = sessions.filter((s) => s.status === "warm");
    if (live.length <= 1)
      return;
    const idx = live.findIndex((s) => s.sessionId === resolvedSessionId);
    const step = direction === "prev" ? -1 : 1;
    const baseIdx = idx === -1 ? 0 : idx;
    const nextIdx = (baseIdx + step + live.length) % live.length;
    const next = live[nextIdx]!;
    const resume = finishSession;
    finishSession = null;
    process.off("SIGINT", sigintHandler);
    void stream.close().catch(() => undefined);
    // Live sessions are by definition agent-bound, so dropping any
    // pending readonly state matches what the user expects when
    // bouncing between active work.
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

  const switchToSessionById = async (idArg: string): Promise<void> => {
    if (!finishSession)
      return;
    const sessions = await listSessions(target, { includeNonInteractive: true });
    const needle = idArg.trim();
    if (!needle) {
      screen.notify("usage: /session <id|next|prev>");
      return;
    }
    // Accept the short form (what the picker and `sessions list` show)
    // as well as the canonical hydra_session_<tail> id. Mirrors the way
    // `--session <id>` is resolved by SessionManager.resolveCanonicalId.
    const candidates = needle.startsWith(HYDRA_SESSION_PREFIX)
      ? [needle]
      : [needle, HYDRA_SESSION_PREFIX + needle];
    let match = sessions.find((s) => candidates.includes(s.sessionId));
    if (!match) {
      const prefixed = sessions.filter((s) =>
        candidates.some((c) => s.sessionId.startsWith(c)),
      );
      if (prefixed.length === 1) {
        match = prefixed[0];
      } else if (prefixed.length > 1) {
        screen.notify(`ambiguous session id: ${needle} (${prefixed.length} matches)`);
        return;
      }
    }
    if (!match) {
      screen.notify(`no session matches: ${needle}`);
      return;
    }
    if (match.sessionId === resolvedSessionId) {
      screen.notify("already on that session");
      return;
    }
    const resume = finishSession;
    finishSession = null;
    process.off("SIGINT", sigintHandler);
    void stream.close().catch(() => undefined);
    const nextOpts: TuiOptions = {
      ...opts,
      sessionId: match.sessionId,
      cwd: match.cwd ?? resolvedCwd,
      readonly: match.status !== "warm",
    };
    if (match.agentId !== undefined)
      nextOpts.agentId = match.agentId;
    delete nextOpts.resumeHint;
    resume(nextOpts);
  };

  const handleEffect = (effect: InputEffect): void => {
    switch (effect.type) {
      case "send":
        // viewPrefs.defaultEnterAction == "amend" swaps the meaning of
        // the two send routes: Enter goes through the amend path and
        // Shift+Enter enqueues. The dispatcher doesn't know about the
        // pref; the swap happens here so the input layer stays a pure
        // state machine. Seeded from config; the ^O dialog flips it live.
        if (viewPrefs.defaultEnterAction === "amend") {
          amendPrompt(effect.text, effect.attachments, effect.displayText);
        } else {
          enqueuePrompt(effect.text, effect.attachments, effect.displayText);
        }
        return;
      case "amend":
        if (viewPrefs.defaultEnterAction === "amend") {
          enqueuePrompt(effect.text, effect.attachments, effect.displayText);
        } else {
          amendPrompt(effect.text, effect.attachments, effect.displayText);
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
          .request("hydra-acp/prompt/update", {
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
          .request("hydra-acp/prompt/cancel", {
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
        // Defensive backstop — tryHandleBtwCloseKey claims ESC/^C before
        // the dispatcher in normal flows, but if a synthetic cancel
        // effect arrives some other way, still dismiss the overlay.
        // Same reuse logic as the key handler.
        if (screen.isOverlayOpen()) {
          if (currentSidechain) {
            currentSidechain.cancel();
            currentSidechain = null;
            btwSessionId = null;
          }
          screen.closeBtwOverlay();
          return;
        }
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
        markCancelling();
        // ^C stops only the in-flight turn. Queued prompts stay put —
        // the daemon's queue picks the next one up once the cancelled
        // turn settles. Use Up + ^C / Enter to drop a specific queued
        // entry via hydra-acp/prompt/cancel.
        return;
      }
      case "exit":
        requestExit();
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
        void switchSession().catch((err: unknown) => {
          writeDebugLine({
            src: "switch-session-failed",
            stack: err instanceof Error ? (err.stack ?? err.message) : String(err),
          });
        });
        return;
      case "next-live-session":
        void cycleLiveSession().catch(() => undefined);
        return;
      case "toggle-options":
        toggleOptionsModal();
        return;
      case "toggle-questions":
        toggleQuestionsModal();
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
        viewPrefs.mouseEnabled = next;
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
        void handleClipboardAttachment(effect.source);
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

  const handleClipboardAttachment = async (
    source: "clipboard" | "primary" = "clipboard",
  ): Promise<void> => {
    // PRIMARY (middle-click) is text-only and mirrors a terminal's
    // select-to-paste; CLIPBOARD (ctrl-v) tries an image first.
    const result =
      source === "primary"
        ? await readPrimarySelection()
        : await readClipboard();
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
  // hydra-acp/prompt_queue/added notifications and by the queue snapshot
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
    // Wire form (paste placeholders expanded) — what the daemon sees.
    text: string;
    // As-typed form with paste placeholders intact — used to render the
    // scrollback echo so a large paste stays compact. Falls back to
    // `text` when no placeholders were involved.
    displayText: string;
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
  // messageIds that were the target of a hydra-acp/prompt/amend — used
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
    displayText?: string,
  ): void => {
    // Sending a prompt always snaps the view to the bottom — the user
    // wants to see their own input and the agent's reply.
    screen.scrollToBottom();
    if (handleBuiltinCommand(text)) {
      return;
    }
    recordHistoryEntry(text, displayText);
    void runPrompt(text, attachments, displayText);
  };

  // Shift+Enter route. Three cases:
  //   1. Daemon doesn't advertise prompt.amending → fall through to a
  //      regular send. The chord still works on older daemons.
  //   2. No in-flight head (currentHeadMessageId undefined) → also a
  //      regular send. Nothing to amend.
  //   3. Head is in flight → fire hydra-acp/prompt/amend with the head
  //      as targetMessageId. On target_completed, surface a "send
  //      anyway?" affordance instead of silently submitting; the user
  //      can re-press Shift+Enter or Enter to confirm.
  const amendPrompt = (
    text: string,
    attachments: Attachment[],
    displayText?: string,
  ): void => {
    screen.scrollToBottom();
    if (handleBuiltinCommand(text)) {
      return;
    }
    recordHistoryEntry(text, displayText);
    if (!daemonSupportsAmend || currentHeadMessageId === undefined) {
      void runPrompt(text, attachments, displayText);
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
    const echo: PendingEcho = {
      text,
      displayText: displayText ?? text,
      attachments,
      flushed: false,
    };
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
      .request("hydra-acp/prompt/amend", {
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
    // Trim trailing whitespace only — a leading space (or a multi-line
    // paste whose first line is blank) should escape slash-command
    // handling so pasted paths like "/tmp/foo" go through as prompts.
    const trimmed = text.replace(/\s+$/, "");
    if (!trimmed.startsWith("/") || trimmed.includes("\n")) {
      return false;
    }
    const space = trimmed.indexOf(" ");
    const cmd = space === -1 ? trimmed : trimmed.slice(0, space);
    switch (cmd) {
      case "/quit":
      case "/exit":
        requestExit();
        return true;
      case "/clear":
        toolStates.clear();
        exitPlanStates.clear();
        toolCallOrder.length = 0;
        toolsBlockStartedAt = null;
        toolsBlockEndedAt = null;
        toolsBlockStopReason = null;
        renderedEditDiffs.clear();
        editDiffOverrides.clear();
        renderedTools.clear();
        toolsOverrides.clear();
        renderedThoughts.clear();
        collapsedThoughtRuns.clear();
        screen.clearScrollback();
        return true;
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
      case "/agent": {
        // PoC: drive an agent swap through the spec config-options surface
        // (session/set_config_option) rather than the `/hydra agent` text
        // command. With no arg, list the agent option's values; otherwise
        // request the swap and let the resulting config_option_update
        // repaint the sessionbar.
        const arg = space === -1 ? "" : trimmed.slice(space + 1).trim();
        const opt = agentConfigOption();
        if (!opt) {
          screen.appendLines([
            {
              prefix: "  ",
              body: "no agent config option advertised for this session",
              bodyStyle: "info",
            },
          ]);
          return true;
        }
        if (!arg) {
          const lines: FormattedLine[] = [
            { prefix: "  ", body: "Available agents:", bodyStyle: "system" },
          ];
          for (const v of opt.options) {
            const marker = v.value === opt.currentValue ? "* " : "  ";
            lines.push({
              prefix: "  ",
              body: `${marker}${v.value.padEnd(16)} ${v.name}`,
              bodyStyle: "info",
            });
          }
          screen.appendLines(lines);
          return true;
        }
        if (!opt.options.some((v) => v.value === arg)) {
          screen.notify(`unknown agent: ${arg}`);
          return true;
        }
        if (arg === opt.currentValue) {
          screen.notify(`already on agent ${arg}`);
          return true;
        }
        screen.notify(`switching to ${arg}…`);
        void conn
          .request("session/set_config_option", {
            sessionId: resolvedSessionId,
            configId: "agent",
            value: arg,
          })
          .catch((err: Error) => {
            screen.notify(`set_config_option failed: ${err.message}`);
          });
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
      case "/resume":
        // Same destination as the switch-session hotkey: suspend the live
        // session and open the picker.
        void switchSession().catch((err: unknown) => {
          writeDebugLine({
            src: "switch-session-failed",
            stack: err instanceof Error ? (err.stack ?? err.message) : String(err),
          });
        });
        return true;
      case "/session": {
        const arg = space === -1 ? "" : trimmed.slice(space + 1).trim();
        if (!arg) {
          void switchSession().catch((err: unknown) => {
          writeDebugLine({
            src: "switch-session-failed",
            stack: err instanceof Error ? (err.stack ?? err.message) : String(err),
          });
        });
          return true;
        }
        if (arg === "next" || arg === "prev") {
          void cycleLiveSession(arg).catch((err: Error) => {
            screen.notify(`session ${arg} failed: ${err.message}`);
          });
          return true;
        }
        void switchToSessionById(arg).catch((err: Error) => {
          screen.notify(`session switch failed: ${err.message}`);
        });
        return true;
      }
      case "/rename": {
        // Alias for the daemon-side `/hydra title` command. Rewrite to the
        // wire form and send it like any agent slash command, but keep the
        // user's literal "/rename …" as the scrollback echo + history entry
        // so up-arrow recall re-aliases rather than surfacing the
        // expansion.
        const arg = space === -1 ? "" : trimmed.slice(space + 1).trim();
        const wire = arg.length > 0 ? `/hydra title ${arg}` : "/hydra title";
        recordHistoryEntry(trimmed, trimmed);
        void runPrompt(wire, [], trimmed);
        return true;
      }
      case "/btw": {
        // Fork a new ancillary session and stream its updates into an
        // overlay pane (not the main transcript).  Does NOT enqueue onto
        // the main prompt queue — it targets a different sessionId so it
        // dispatches immediately even when the main turn is in flight.
        const prompt = space === -1 ? "" : trimmed.slice(space + 1).trim();
        if (!prompt) {
          // No-arg /btw toggles the overlay: visible → hide (same as ESC),
          // hidden-with-history → reopen, otherwise nothing to toggle and
          // we ask for a prompt.
          if (screen.isOverlayOpen()) {
            if (currentSidechain) {
              currentSidechain.cancel();
              currentSidechain = null;
              btwSessionId = null;
            }
            screen.closeBtwOverlay();
            return true;
          }
          if (screen.reopenBtwOverlay()) {
            return true;
          }
          screen.appendLines([
            { prefix: "  ", body: "/btw requires a prompt", bodyStyle: "info" },
          ]);
          return true;
        }
        // Must have an active session to fork from.
        if (resolvedSessionId === "__new__") {
          screen.appendLines([
            { prefix: "  ", body: "no active session to fork", bodyStyle: "info" },
          ]);
          return true;
       }
        // Generation-stamp this invocation. A rapid second /btw before
        // the first runBtwSidechain promise resolves bumps the gen; the
        // first promise's .then() then sees a stale gen and aborts the
        // emitter it would otherwise have installed, preventing a leaked
        // fork.
        btwStartGen += 1;
        const myGen = btwStartGen;
        if (currentSidechain) {
          currentSidechain.cancel();
          currentSidechain = null;
        }
        // Reuse decision: if a prior /btw left a fork alive AND the main
        // session hasn't moved since (no turn_complete), attach to that
        // fork instead of paying for a fresh fork + seedFromImport. This
        // makes follow-up /btws feel snappy. If main HAS moved, the
        // retained context is stale — kill the old fork and start fresh.
        let reuseSessionId: string | null = null;
        if (btwSessionId !== null && !btwReusableDirty) {
          reuseSessionId = btwSessionId;
        } else if (btwSessionId !== null) {
          void killSession(target, btwSessionId).catch(() => undefined);
          btwSessionId = null;
        }
        btwReusableDirty = false;
        screen.openBtwOverlay();
        screen.setBtwOverlayStatus({ label: "busy", style: "busy" });
        const buffer = new BtwOverlayBuffer({
          getMaxWidth: () => {
            const w = screen.width();
            return w > 0 ? w : undefined;
          },
        });
        buffer.on("changed", () => {
          screen.setBtwOverlayContent(buffer.getLines());
        });
        // Running usage snapshot for the btw fork, fed by usage_update
        // session/update events. Mirrors how the main sessionbar tracks
        // usage; the formatted string lands in the overlay header.
        const btwUsage: SessionListUsage = {};
        // Echo the user's prompt at the top of the overlay so it reads
        // like a mini-conversation, rendered with the same "▎ " gutter
        // the main transcript uses for user messages. The daemon excludes
        // the originator from prompt_received broadcasts so the only way
        // this lands in the overlay is by us seeding it ourselves.
        buffer.append({
          sessionUpdate: "prompt_received",
          prompt: [{ type: "text", text: prompt }],
        });
        const appendOverlayMessage = (text: string): void => {
          buffer.append({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          });
        };
        const sidechainOpts: { reuseSessionId?: string } = {};
        if (reuseSessionId !== null) {
          sidechainOpts.reuseSessionId = reuseSessionId;
        }
        void runBtwSidechain(target, resolvedSessionId, prompt, sidechainOpts).then(
          (emitter) => {
            // Superseded by a newer /btw — discard this emitter so it
            // doesn't clobber the active one.
            if (myGen !== btwStartGen) {
              emitter.cancel();
              return;
            }
            currentSidechain = emitter;
            btwSessionId = emitter.sessionId;
            screen.setBtwOverlayMeta({ sessionId: emitter.sessionId });
            emitter.on("event", (ev) => {
              if (myGen !== btwStartGen) {
                return;
              }
              if (ev.kind === "update") {
                buffer.append(ev.update);
                // Tap usage_update events into the overlay header. Other
                // event kinds carry visible content that the buffer
                // already renders into the overlay body.
                const mapped = mapUpdate(ev.update);
                if (mapped && mapped.kind === "usage-update") {
                  let dirty = false;
                  if (mapped.used !== undefined && btwUsage.used !== mapped.used) {
                    btwUsage.used = mapped.used;
                    dirty = true;
                  }
                  if (mapped.size !== undefined && btwUsage.size !== mapped.size) {
                    btwUsage.size = mapped.size;
                    dirty = true;
                  }
                  if (
                    mapped.costAmount !== undefined &&
                    btwUsage.costAmount !== mapped.costAmount
                  ) {
                    btwUsage.costAmount = mapped.costAmount;
                    dirty = true;
                  }
                  if (
                    mapped.costCurrency !== undefined &&
                    btwUsage.costCurrency !== mapped.costCurrency
                  ) {
                    btwUsage.costCurrency = mapped.costCurrency;
                    dirty = true;
                  }
                  if (dirty) {
                    screen.setBtwOverlayMeta({ usage: { ...btwUsage } });
                  }
                }
              } else if (ev.kind === "completed") {
                // Clean completion — keep the session alive for reuse on
                // a follow-up /btw. btwSessionId stays set; the next
                // /btw will check btwReusableDirty and either reuse this
                // session or kill it and fork fresh.
                screen.setBtwOverlayStatus({ label: "done", style: "done" });
                currentSidechain = null;
              } else if (ev.kind === "cancelled") {
                // Cancelled mid-turn — the side session's state is
                // ambiguous (the agent saw an interrupted prompt). Don't
                // reuse it. sidechain.cancel() already killed the
                // daemon-side fork; just drop our reference.
                screen.setBtwOverlayStatus({ label: "cancelled", style: "cancelled" });
                currentSidechain = null;
                btwSessionId = null;
              } else if (ev.kind === "errored") {
                screen.setBtwOverlayStatus({ label: "errored", style: "errored" });
                appendOverlayMessage(`btw errored: ${ev.error.message}`);
                // Errored sessions are unsafe to reuse — kill it.
                if (btwSessionId !== null) {
                  const dead = btwSessionId;
                  void killSession(target, dead).catch(() => undefined);
                }
                currentSidechain = null;
                btwSessionId = null;
              }
            });
          },
        ).catch((err) => {
          if (myGen !== btwStartGen) {
            return;
          }
          // Startup failure (e.g. WS connect, fork HTTP error) — surface
          // it in the overlay and main transcript so the user isn't left
          // wondering why /btw produced no visible output.
          const msg = err instanceof Error ? err.message : String(err);
          screen.setBtwOverlayStatus({ label: "errored", style: "errored" });
          appendOverlayMessage(`btw startup failed: ${msg}`);
          screen.appendLines([
            {
              prefix: "  ",
              body: `btw startup failed: ${msg}`,
              bodyStyle: "tool-status-fail",
            },
          ]);
        });
        return true;
      }
      case "/export": {
        // Write a markdown transcript of the current session to disk.
        // Mirrors `hydra-acp sessions transcript <id> --out <file>`: hits
        // the daemon's GET /v1/sessions/:id/transcript route (which uses
        // the same bundleToMarkdown renderer as the CLI). Argument is an
        // optional destination path; with no arg we derive a timestamped
        // filename in the current working directory.
        if (resolvedSessionId === "__new__") {
          screen.appendLines([
            { prefix: "  ", body: "no active session to export", bodyStyle: "info" },
          ]);
          return true;
        }
        const arg = space === -1 ? "" : trimmed.slice(space + 1).trim();
        const sid = resolvedSessionId;
        void (async () => {
          try {
            const resp = await fetch(
              `${target.baseUrl}/v1/sessions/${encodeURIComponent(sid)}/transcript`,
              { headers: { Authorization: `Bearer ${target.token}` } },
            );
            if (!resp.ok) {
              const text = await resp.text().catch(() => "");
              screen.appendLines([
                {
                  prefix: "  ",
                  body: `/export failed: HTTP ${resp.status} ${text}`.trim(),
                  bodyStyle: "info",
                },
              ]);
              return;
            }
            const body = await resp.text();
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const defaultName = `hydra-${stripHydraSessionPrefix(sid)}-${stamp}.md`;
            const target_path = arg.length > 0 ? expandHome(arg) : defaultName;
            const resolved = path.resolve(target_path);
            await fs.mkdir(path.dirname(resolved), { recursive: true });
            await fs.writeFile(resolved, body, { encoding: "utf8", mode: 0o600 });
            screen.appendLines([
              { prefix: "  ", body: `Wrote ${resolved}`, bodyStyle: "system" },
            ]);
          } catch (err) {
            screen.appendLines([
              {
                prefix: "  ",
                body: `/export failed: ${(err as Error).message}`,
                bodyStyle: "info",
              },
            ]);
          }
        })();
        return true;
      }
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
    displayText?: string,
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
    const echo: PendingEcho = {
      text,
      displayText: displayText ?? text,
      attachments,
      flushed: false,
    };
    pendingEchoes.push(echo);

    // Each new turn starts un-escalated: the first cancel is always a soft
    // session/cancel; only a failed/ignored one arms the force-stop.
    forceStopArmed = false;
    let softCancelSent = false;
    let cancelAckTimer: NodeJS.Timeout | null = null;
    const warnLine = (body: string): void => {
      const screenReady =
        typeof screenRef !== "undefined" && screenRef !== null;
      if (!screenReady) return;
      screenRef!.appendLines([
        { prefix: "⚠ ", prefixStyle: "tool-status-fail", body, bodyStyle: "tool-status-fail" },
      ]);
    };
    let forceStopRequested = false;
    turnInFlight = {
      text,
      attachments,
      cancel: () => {
        // Escalation: a prior cancel was rejected/ignored. Tear the agent
        // down to actually stop the turn; the session resumes (via
        // session/load) on the next message.
        if (forceStopArmed) {
          forceStopArmed = false;
          forceStopRequested = true;
          warnLine("force-stopping agent — turn aborted; resumes on your next message…");
          conn
            .request("hydra-acp/session/force_cancel", {
              sessionId: resolvedSessionId,
            })
            .catch((err) => {
              warnLine(`force-stop failed: ${(err as Error).message}`);
            });
          return;
        }
        if (softCancelSent) {
          return;
        }
        softCancelSent = true;
        conn.notify("session/cancel", { sessionId: resolvedSessionId }).catch(
          () => undefined,
        );
        // Backstop: if the turn is still in flight after the window and we
        // didn't already get an explicit cancel_failed, the agent silently
        // ignored the cancel. Warn + arm the force-stop escalation.
        const cancelSentAt = Date.now();
        cancelAckTimer = setTimeout(() => {
          if (turnInFlight === null) return;
          if (lastCancelFailedAt >= cancelSentAt) return;
          forceStopArmed = true;
          warnLine(
            "cancel not acknowledged by agent — the turn is still running. Cancel again to force-stop (restarts the agent).",
          );
        }, CANCEL_ACK_TIMEOUT_MS);
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
      // A force-stop tears the agent down, so the in-flight prompt may
      // reject with a transport error before the daemon's cancelled
      // response lands. Render it as a clean cancellation, not a failure.
      if (forceStopRequested) {
        screen.appendLines([
          {
            prefix: "⚠ ",
            prefixStyle: "tool-status-fail",
            body: "turn force-stopped",
            bodyStyle: "tool-status-fail",
          },
        ]);
      } else {
        screen.appendLines([
          {
            prefix: "✗ ",
            prefixStyle: "tool-status-fail",
            body: (err as Error).message,
            bodyStyle: "tool-status-fail",
          },
        ]);
      }
    } finally {
      turnInFlight = null;
      if (cancelAckTimer !== null) {
        clearTimeout(cancelAckTimer);
        cancelAckTimer = null;
      }
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
  // toolCallId → the edit diff that was rendered into scrollback for it,
  // in render order. Unlike toolStates this survives turn boundaries (the
  // editdiff: scrollback blocks do too), so the ^O "File updates" toggle
  // can re-converge every past diff to the new mode. Cleared only when
  // scrollback itself is cleared (/clear).
  const renderedEditDiffs = new Map<string, EditDiff>();
  // Per-block expand overrides set by clicking an edit-diff block. Keyed by
  // toolCallId; true = force the full "diff" body, false = force the
  // one-line "edit" mark. Layered over viewPrefs.showFileUpdates for that
  // one block. Cleared when the global ^O File-updates toggle fires.
  const editDiffOverrides = new Map<string, boolean>();
  // toolCallId → Claude ExitPlanMode plan + latest status. Lives until
  // turn end (cleared alongside toolStates) so a permission resolution
  // landing as a tool_call_update can amend the rendered block in place.
  const exitPlanStates = new Map<string, ExitPlanState>();
  // Ordered toolCallIds for the current turn — drives the rolling
  // "most recent K" window in the tools block and is the source of
  // truth for the "ran N tools" header count.
  const toolCallOrder: string[] = [];
  // Per-turn key for the tools block. A fresh key each turn (rather than a
  // single reused "tools") lets every turn's frozen block stay individually
  // addressable for click-to-expand. Bumped in startToolsBlock; the live
  // block upserts under it, and the freeze sites clear it.
  let toolsBlockSeq = 0;
  let currentToolsKey = `tools:${toolsBlockSeq}`;
  // Snapshot of every frozen tools block, keyed by its per-turn key, so a
  // click on a past turn can re-render it at a different expand level even
  // after toolStates/toolCallOrder are wiped. Mirrors renderedEditDiffs.
  // Cleared only when scrollback itself is cleared (/clear).
  const renderedTools = new Map<
    string,
    {
      order: string[];
      states: Map<string, ToolLineState>;
      startedAt: number;
      endedAt: number;
      stopReason: string | null;
      rowOwners: (string | null)[];
    }
  >();
  // Per-block expand overrides set by clicking a tools block. Keyed by the
  // per-turn tools key; value is the desired expanded state. Layered over
  // viewPrefs.toolsExpanded for that one block. Cleared when the global ^O
  // Tools toggle fires (global wins).
  const toolsOverrides = new Map<string, boolean>();
  // Per-tool expansion state: a Set of toolCallIds whose detail is expanded.
  // Cleared by the global ^O Tools toggle only — NOT by header-click or turn
  // boundary so a user can still click into a past turn's tool after a reset.
  const perToolExpanded = new Set<string>();
  // Maps tools:N key → an array whose length equals the number of lines in
  // that block's render, where each entry is either the toolCallId for that
  // row or null for the header line. Populated by buildToolsLines; used by
  // handleBlockClick to resolve (key, rowOffset) → toolCallId. Snapshot
  // blocks store their own rowOwners so click resolution works on past turns.
  const rowOwners = new Map<string, (string | null)[]>();
  // Retained thought text, keyed by thought block key, so a click can
  // re-render the block collapsed/expanded even after closeThought wipes
  // the live buffer (the lines stay painted in scrollback). Cleared on
  // /clear. Mirrors renderedTools / renderedEditDiffs.
  const renderedThoughts = new Map<string, { text: string; workerTaskId?: string }>();
  // Collapsed thought runs, keyed by the run's lead (first) thought key →
  // the full ordered list of thought keys folded behind the single
  // "▸ Thoughts" line. A run is the maximal set of visually-contiguous
  // thought blocks (split only by tool calls, which update in place
  // elsewhere). Clicking the lead "Thoughts" line expands it back to all
  // its blocks. Cleared on /clear.
  const collapsedThoughtRuns = new Map<string, string[]>();
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
  // Per-block expand override for the live plan, set by clicking it. true =
  // expanded, false = collapsed, null = follow the global ^O Plan setting.
  // Plans don't persist across turns, so this only ever affects the live
  // block; it's reset at each turn boundary alongside lastPlanEvent.
  let planOverride: boolean | null = null;
  // How many recent tool rows the collapsed view shows; older ones get
  // rolled into the "N hidden" counter in the header. 0 disables the
  // cap so every tool row stays visible.
  const TOOLS_COLLAPSED_LIMIT = config.tui.maxToolItems;
  // Same for the plan. Plumbed into formatEvent so the agent's plan
  // updates and the turn-end stopped re-render share the cap. Computed
  // per render so the ^O "Plan" toggle (viewPrefs.planExpanded) can lift
  // the cap live — expanded → Infinity (show every entry), else the
  // configured maxPlanItems window.
  const PLAN_VISIBLE_LIMIT = config.tui.maxPlanItems;
  const planFormatOptions = (): { maxPlanItems: number } => {
    const expanded = planOverride ?? viewPrefs.planExpanded;
    return { maxPlanItems: expanded ? Infinity : PLAN_VISIBLE_LIMIT };
  };
  // Re-render the current turn's plan block under the active expand
  // setting. Driven by the ^O "Plan" toggle. A no-op once the turn ended
  // (lastPlanEvent is cleared and the block frozen) — only the live plan
  // can change its window.
  const rerenderPlan = (): void => {
    if (lastPlanEvent === null) {
      return;
    }
    const lines = formatEvent(lastPlanEvent, planFormatOptions());
    if (lines.length > 0) {
      screen.upsertLines("plan", [{ body: "" }, ...lines]);
    }
  };

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
    const w = screen.width();
    const lines = parseAgentMarkdown(
      agentBuffer,
      w > 0 ? { maxWidth: w } : undefined,
    );
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

  // The single dim line a collapsed thought run folds down to. Keeps
  // bodyStyle "thought" so the ^T hide-thoughts filter still drops it; the
  // ▸ marker hints a click expands it back to the full thinking.
  const thinkingLine = (): FormattedLine => ({
    prefix: "  ",
    body: "▸ Thoughts",
    bodyStyle: "thought",
  });

  const renderThoughtBlock = (): void => {
    if (thoughtKey === null)
      return;
    if (thoughtBuffer.length === 0)
      return;
    const lines = parseThoughtMarkdown(thoughtBuffer);
    if (lines.length === 0)
      return;
    screen.upsertLines(thoughtKey, lines);
  };

  // Full (expanded) lines for a thought block from retained text.
  const expandedThoughtLines = (key: string): FormattedLine[] => {
    const entry = renderedThoughts.get(key);
    if (entry === undefined)
      return [];
    const lines = parseThoughtMarkdown(entry.text);
    if (entry.workerTaskId) {
      lines.unshift({
        prefix: "  ",
        body: `[T${entry.workerTaskId}] `,
        bodyStyle: "dim",
      });
    }
    return lines;
  };

  const appendThought = (text: string, workerTaskId?: string): void => {
    if (text.length === 0)
      return;
    if (thoughtKey === null) {
      // Tag the leading separator "thought" so the ^T hide-thoughts filter
      // drops the gap above the block along with its body — otherwise the
      // blank survives the filter and stacks up between visible content.
      screen.ensureSeparator("thought");
      thoughtKey = `thought:${thoughtSeq}`;
      thoughtSeq += 1;
      thoughtBuffer = "";
    }
    thoughtBuffer += text;
    renderedThoughts.set(thoughtKey, { text: thoughtBuffer, workerTaskId });
    renderThoughtBlock();
  };

  const closeThought = (): void => {
    thoughtKey = null;
    thoughtBuffer = "";
  };

  // Reference to the module-level pure renderer (avoids re-declaring the
  // logic inside this closure).
  const buildToolsLines = (args: Parameters<typeof _buildToolsLines>[0]): ReturnType<typeof _buildToolsLines> =>
    _buildToolsLines({ ...args, collapsedLimit: TOOLS_COLLAPSED_LIMIT });

  // Whether the tools block for `key` should render expanded: a per-block
  // click override wins; otherwise the global ^O Tools setting applies.
  const toolsExpandedFor = (key: string): boolean =>
    toolsOverrides.get(key) ?? viewPrefs.toolsExpanded;

  // Render the live (current-turn) tools block under its per-turn key.
  const renderToolsBlock = (): void => {
    if (toolsBlockStartedAt === null) {
      return;
    }
    const { lines, rowOwners: owners } = buildToolsLines({
      order: toolCallOrder,
      states: toolStates,
      startedAt: toolsBlockStartedAt,
      endedAt: toolsBlockEndedAt,
      stopReason: toolsBlockStopReason,
      expanded: toolsExpandedFor(currentToolsKey),
      perToolExpanded,
    });
    screen.upsertLines(currentToolsKey, lines);
    rowOwners.set(currentToolsKey, owners);
  };

  // Re-render a frozen tools snapshot in place (click-to-expand on a past
  // turn). No-op if we don't have a snapshot for the key.
  const renderToolsBlockFor = (key: string): void => {
    const snap = renderedTools.get(key);
    if (!snap) {
      return;
    }
    const { lines, rowOwners: owners } = buildToolsLines({
      order: snap.order,
      states: snap.states,
      startedAt: snap.startedAt,
      endedAt: snap.endedAt,
      stopReason: snap.stopReason,
      expanded: toolsExpandedFor(key),
      perToolExpanded,
    });
    screen.upsertLines(key, lines);
    rowOwners.set(key, owners);
  };

  // Re-render every tools block (live + frozen snapshots) under the current
  // global setting. Driven by the ^O Tools toggle, which must reach past
  // turns too. The live block re-renders only if its key isn't also a
  // snapshot (a frozen turn whose key collides — it won't, keys are unique).
  const reRenderAllTools = (): void => {
    if (toolsBlockStartedAt !== null && !renderedTools.has(currentToolsKey)) {
      renderToolsBlock();
    }
    for (const key of renderedTools.keys()) {
      renderToolsBlockFor(key);
    }
  };

  // Capture the just-frozen tools block so a later click can re-render it.
  // Called at each freeze site right before clearKey wipes the live state.
  const snapshotToolsBlock = (): void => {
    if (toolsBlockStartedAt === null) {
      return;
    }
    renderedTools.set(currentToolsKey, {
      order: [...toolCallOrder],
      states: new Map(toolStates),
      startedAt: toolsBlockStartedAt,
      endedAt: toolsBlockEndedAt ?? Date.now(),
      stopReason: toolsBlockStopReason,
      rowOwners: rowOwners.get(currentToolsKey) ?? [],
    });
  };

  // Anchor a fresh tools block at the current bottom of scrollback so the
  // user has a visible "agent is working" indicator from the moment a turn
  // starts — even if no tool calls fire for a while. Called from the
  // user-text handler so it fires for both our own prompts (synthesized
  // via runPrompt) and peers' prompts (broadcast by the daemon).
  const startToolsBlock = (): void => {
    toolsBlockSeq += 1;
    currentToolsKey = `tools:${toolsBlockSeq}`;
    toolsBlockStartedAt = Date.now();
    toolsBlockEndedAt = null;
    toolsBlockStopReason = null;
    renderToolsBlock();
  };

  // Extract result text from a `content[]` array (ACP content blocks).
  // Returns parts as either inline strings or blob refs (hashes from the
  // lean "references" mode, where the daemon swaps `text` for
  // `{ __hydraBlob, bytes }` so large file Reads don't bloat history).
  // Callers stitch inline parts immediately and fetch refs on demand.
  // Returns null when no content was found at all.
  function extractResultText(
    rawUpdate: unknown,
  ): Array<{ text: string } | { hash: string }> | null {
    if (!rawUpdate || typeof rawUpdate !== "object") {
      return null;
    }
    const u = rawUpdate as Record<string, unknown>;
    const content = Array.isArray(u.content) ? u.content : undefined;
    if (!content) {
      return null;
    }
    const parts: Array<{ text: string } | { hash: string }> = [];
    const pushFromText = (v: unknown): void => {
      if (typeof v === "string") {
        parts.push({ text: sanitizeWireText(v) });
        return;
      }
      if (v && typeof v === "object") {
        const blob = v as { __hydraBlob?: unknown };
        if (typeof blob.__hydraBlob === "string") {
          parts.push({ hash: blob.__hydraBlob });
        }
      }
    };
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as Record<string, unknown>;
      // ACP canonical ToolCallContent wrapper:
      //   { type: "content", content: { type: "text", text: "..." | blobRef } }
      if (b.type === "content" && b.content && typeof b.content === "object") {
        const inner = b.content as Record<string, unknown>;
        if (inner.text !== undefined) {
          pushFromText(inner.text);
          continue;
        }
      }
      // Bare ContentBlock shape: { type: "text", text: "..." | blobRef }
      if (b.type === "text" && b.text !== undefined) {
        pushFromText(b.text);
        continue;
      }
      // Last-resort fallback: bare { text: "..." } with no type field.
      if (b.text !== undefined) {
        pushFromText(b.text);
      }
    }
    return parts.length > 0 ? parts : null;
  }

  const applyResultParts = (
    state: ToolLineState,
    parts: Array<{ text: string } | { hash: string }>,
  ): void => {
    const joined = parts
      .map((p) => ("text" in p ? p.text : ""))
      .join("\n");
    if (joined.length === 0) {
      return;
    }
    const { text, truncated } = truncateResultText(joined);
    state.resultText = text;
    state.resultTruncated = truncated;
  };

  // Per-tool guard so a content-blob fetch isn't issued twice when the
  // same tool_call_update is re-emitted (status pings).
  const fetchingToolBlobs = new Set<string>();

  const resolveBlobsAndUpdate = (
    id: string,
    parts: Array<{ text: string } | { hash: string }>,
  ): void => {
    const hasRefs = parts.some((p) => "hash" in p);
    if (!hasRefs || fetchingToolBlobs.has(id)) {
      return;
    }
    fetchingToolBlobs.add(id);
    (async () => {
      const resolved: Array<{ text: string } | { hash: string }> =
        await Promise.all(
          parts.map(async (p) => {
            if ("text" in p) {
              return p;
            }
            const fetched = await fetchToolContent(p.hash);
            return { text: fetched ?? "" };
          }),
        );
      fetchingToolBlobs.delete(id);
      // toolStates is cleared at turn boundaries, so by the time a
      // fetch resolves the live map may not have this tool anymore.
      // Find the state in any frozen snapshot too — snapshots clone the
      // map shallowly, so the ToolLineState reference is shared with
      // toolStates while live, and survives the clear inside snapshots.
      let target = toolStates.get(id);
      if (!target) {
        for (const snap of renderedTools.values()) {
          const s = snap.states.get(id);
          if (s) {
            target = s;
            break;
          }
        }
      }
      if (!target) {
        return;
      }
      applyResultParts(target, resolved);
      if (toolStates.has(id)) {
        renderToolsBlock();
      }
      for (const [key, snap] of renderedTools) {
        if (snap.states.has(id)) {
          renderToolsBlockFor(key);
        }
      }
      screen.repaintNow();
    })().catch(() => {
      fetchingToolBlobs.delete(id);
    });
  };

  const recordToolCall = (
    id: string,
    title: string | undefined,
    status: string | undefined,
    errorText: string | undefined,
    editDiff: EditDiff | undefined,
    detail: string | undefined,
    detailFull: string | undefined,
    locations: import("../core/render-update.js").ToolCallLocation[] | undefined,
    workerTaskId?: string,
    rawUpdate?: unknown,
  ): void => {
    const wasNew = !toolStates.has(id);
    const existing = toolStates.get(id);
    const state: ToolLineState = existing ?? {
      initialTitle: title ?? "tool",
      latestTitle: title ?? "tool",
      status: status ?? "pending",
      startedAt: Date.now(),
    };
    if (!existing && workerTaskId !== undefined) {
      state.workerTaskId = workerTaskId;
    }
    if (existing && title !== undefined) {
      state.latestTitle = title;
    }
    // Keep the first non-empty detail (the command/path from the initial
    // tool_call); later "updated" pings rarely re-send it.
    if (detail !== undefined && state.detail === undefined) {
      state.detail = detail;
    }
    if (detailFull !== undefined && state.detailFull === undefined) {
      state.detailFull = detailFull;
    }
    // Locations carry richer info than detailFull (an array of
    // {path,line} rather than a single clipped string) and updates can
    // genuinely refine them as the agent works through a file, so we
    // replace rather than first-wins.
    if (locations !== undefined && locations.length > 0) {
      state.locations = locations;
    }
    if (existing && status !== undefined) {
      state.status = status;
    }
    if (!existing) {
      state.status = status ?? "pending";
    }
    // Freeze the duration the first time the call reaches a terminal
    // status; a started-but-not-yet-ended call keeps ticking live.
    if (state.endedAt === undefined && isTerminalToolStatus(state.status)) {
      state.endedAt = Date.now();
    }
    if (errorText !== undefined) {
      state.errorText = errorText;
    }
    if (editDiff !== undefined) {
      state.editDiff = editDiff;
    }
    // Extract and store resultText from the raw update's content[].
    // Latest-replaces: every tool_call_update carries a snapshot of all
    // content blocks, so we rebuild and overwrite on each call. Inline
    // text shows immediately; blob refs (lean references mode) are
    // fetched asynchronously and spliced in once they arrive.
    if (rawUpdate !== undefined) {
      const extracted = extractResultText(rawUpdate);
      if (extracted !== null) {
        applyResultParts(state, extracted);
        if (extracted.some((p) => "hash" in p)) {
          resolveBlobsAndUpdate(id, extracted);
        }
      }
    }
    toolStates.set(id, state);
    if (wasNew) {
      // The block is normally anchored by startToolsBlock on the user-text
      // event; this fallback covers replay/edge cases where a tool call
      // arrives without a preceding prompt visible to us. Must bump the
      // per-turn key too (like startToolsBlock) — otherwise this turn's
      // tools splice into the previous turn's frozen-but-still-keyed block,
      // and the eventual startToolsBlock then renders a second block.
      if (toolsBlockStartedAt === null) {
        toolsBlockSeq += 1;
        currentToolsKey = `tools:${toolsBlockSeq}`;
        toolsBlockStartedAt = Date.now();
        toolsBlockEndedAt = null;
        toolsBlockStopReason = null;
      }
      toolCallOrder.push(id);
    }
  };

  // Drop a separate scrollback block under the tool row when the user
  // has opted in via `tui.showFileUpdates`. Keyed by toolCallId so a
  // re-render against the same id amends in place.
  //
  // Only fires once a tool reaches status="completed" — failed/rejected/
  // cancelled edits leave no trace in scrollback. The diff payload is
  // pulled from ToolLineState, where recordToolCall stashes whatever
  // arrived via the initial tool_call's rawInput, so a completion update
  // with no content[] of its own still finds it.
  // Fetch one externalized tool-content body over the WS connection (the
  // lean "references" path). Null on any error so callers degrade to "".
  const fetchToolContent = async (hash: string): Promise<string | null> => {
    try {
      const res = (await conn.request("hydra-acp/session/tool_content", {
        sessionId: resolvedSessionId,
        hash,
      })) as { content?: unknown };
      return typeof res?.content === "string" ? res.content : null;
    } catch {
      return null;
    }
  };

  // In-flight guard so a deferred diff isn't fetched twice if the user
  // toggles it rapidly.
  const fetchingDiffs = new Set<string>();

  // A diff delivered in references mode carries oldRef/newRef instead of
  // body text. Fetch the blob(s), splice the content in, and re-render the
  // block with the real diff.
  const resolveDeferredDiff = (toolCallId: string, diff: EditDiff): void => {
    if (fetchingDiffs.has(toolCallId)) {
      return;
    }
    if (diff.oldRef === undefined && diff.newRef === undefined) {
      return;
    }
    fetchingDiffs.add(toolCallId);
    void (async () => {
      const [oldText, newText] = await Promise.all([
        diff.oldRef ? fetchToolContent(diff.oldRef.hash) : Promise.resolve(diff.oldText),
        diff.newRef ? fetchToolContent(diff.newRef.hash) : Promise.resolve(diff.newText),
      ]);
      // A required blob came back null → the fetch failed. Show an error
      // in place of the body but keep the diff deferred so a later click /
      // scroll-into-view retries, rather than silently collapsing to empty.
      const failed =
        (diff.oldRef !== undefined && oldText === null) ||
        (diff.newRef !== undefined && newText === null);
      if (failed) {
        fetchingDiffs.delete(toolCallId);
        const out = formatEditDiffBlock(diff, "diff", { deferredStatus: "error" });
        if (out.length > 0) {
          screen.upsertLines(`editdiff:${toolCallId}`, out);
          screen.repaintNow();
        }
        return;
      }
      const resolved: EditDiff = {
        ...(diff.path !== undefined ? { path: diff.path } : {}),
        oldText: oldText ?? "",
        newText: newText ?? "",
      };
      renderedEditDiffs.set(toolCallId, resolved);
      const st = toolStates.get(toolCallId);
      if (st?.editDiff) {
        st.editDiff = resolved;
      }
      fetchingDiffs.delete(toolCallId);
      // Re-render at whatever mode the block is currently showing.
      const override = editDiffOverrides.get(toolCallId);
      const mode =
        override === undefined
          ? viewPrefs.showFileUpdates
          : override
            ? "diff"
            : "edit";
      if (mode !== "none") {
        renderEditDiffBlock(toolCallId, resolved, mode === "diff" ? "diff" : "edit");
        screen.repaintNow();
      }
    })();
  };

  // Upsert a diff block at the given mode, kicking off a lazy fetch when an
  // expanded diff is still in deferred (references) form.
  const renderEditDiffBlock = (
    toolCallId: string,
    diff: EditDiff,
    mode: "edit" | "diff",
  ): void => {
    const key = `editdiff:${toolCallId}`;
    const out = formatEditDiffBlock(diff, mode);
    if (out.length === 0) {
      screen.removeKey(key);
      return;
    }
    screen.upsertLines(key, out);
    if (mode === "diff" && (diff.oldRef !== undefined || diff.newRef !== undefined)) {
      // Don't fetch yet — register for a "became visible" callback so the
      // body is pulled only when this diff is actually on screen (lazy even
      // in showFileUpdates="diff", where many diffs render off-screen).
      screen.notifyWhenVisible(key);
    }
  };

  // Fired by the screen when a registered (deferred) diff block scrolls into
  // view: pull its body and re-render. Guarded by resolveDeferredDiff's
  // in-flight set + the diff turning non-deferred after the fetch.
  const handleBlockVisible = (key: string): void => {
    if (!key.startsWith("editdiff:")) {
      return;
    }
    const id = key.slice("editdiff:".length);
    const diff = renderedEditDiffs.get(id);
    if (diff && (diff.oldRef !== undefined || diff.newRef !== undefined)) {
      resolveDeferredDiff(id, diff);
    }
  };

  const maybeRenderEditDiff = (toolCallId: string): void => {
    const key = `editdiff:${toolCallId}`;
    // Decide the mode this id should render at; null means "show nothing".
    const globalMode = viewPrefs.showFileUpdates;
    const state = toolStates.get(toolCallId);
    let mode: "edit" | "diff" | null;
    if (globalMode === "none" || !state?.editDiff || state.status !== "completed") {
      mode = null;
    } else {
      // A per-block click override forces this id's mode; otherwise the
      // global mode applies. Every completed edit gets its own clickable
      // "▸ Edited <path>" mark that expands to its own diff.
      const override = editDiffOverrides.get(toolCallId);
      mode =
        override !== undefined
          ? override
            ? "diff"
            : "edit"
          : globalMode === "diff"
            ? "diff"
            : "edit";
    }
    if (mode === null) {
      screen.removeKey(key);
      return;
    }
    const diff = state!.editDiff!;
    // Remember the payload so a later ^O mode toggle can re-render this
    // diff even after the turn boundary wipes toolStates/toolCallOrder.
    renderedEditDiffs.set(toolCallId, diff);
    renderEditDiffBlock(toolCallId, diff, mode);
  };

  // Re-converge every diff ever rendered this scrollback to the current
  // showFileUpdates mode. Driven by the ^O "File updates" toggle, which
  // must affect past turns too — those diffs still sit in scrollback but
  // their toolStates are long gone, so we rebuild from renderedEditDiffs.
  // Unconditional per mode (no turn-scoped prose/dedup gating): diff →
  // full body, edit → one-line mark, none → removed.
  const reRenderAllEditDiffs = (): void => {
    const globalMode = viewPrefs.showFileUpdates;
    for (const [toolCallId, diff] of renderedEditDiffs) {
      const key = `editdiff:${toolCallId}`;
      // A surviving per-block override forces that block's mode; otherwise
      // the global mode applies (and "none" removes the block).
      const override = editDiffOverrides.get(toolCallId);
      const mode = override === undefined ? globalMode : override ? "diff" : "edit";
      if (mode === "none") {
        screen.removeKey(key);
        continue;
      }
      renderEditDiffBlock(toolCallId, diff, mode === "diff" ? "diff" : "edit");
    }
  };

  // Route a left-click on a keyed scrollback block to a per-block
  // expand/collapse toggle. Only the clicked block changes; the global ^O
  // settings are untouched. Unknown keys (agent text, thoughts, etc.) are
  // ignored. Each toggle flips relative to what the block currently shows.
  // Locate the first changed line of an edit inside the file on disk.
  // For Claude-style Edit / str_replace tools, oldText/newText are
  // snippets, so walking the common prefix only tells you where the
  // change is *within the snippet* — useless as a file line. After the
  // edit lands, the changed line from newText exists in the file at
  // its real location, so we anchor on it: take the first line of
  // newText that differs from oldText, then grep the file for that
  // exact line and return its 1-based position. Returns null when the
  // file can't be read, the diff is missing a path, the anchor is
  // empty (pure whitespace / blank line), or no match is found —
  // letting the caller fall back to opening at the file top.
  const firstChangedFileLine = (
    diff: import("../core/render-update.js").EditDiff,
  ): number | null => {
    if (!diff.path) {
      return null;
    }
    const oldLines = sanitizeWireText(diff.oldText).split("\n");
    const newLines = sanitizeWireText(diff.newText).split("\n");
    let start = 0;
    const minLen = Math.min(oldLines.length, newLines.length);
    while (start < minLen && oldLines[start] === newLines[start]) {
      start++;
    }
    const anchor = newLines[start];
    if (!anchor) {
      return null;
    }
    const filePath = path.isAbsolute(diff.path)
      ? diff.path
      : path.resolve(resolvedCwd, diff.path);
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
    const fileLines = content.split("\n");
    for (let i = 0; i < fileLines.length; i++) {
      if (fileLines[i] === anchor) {
        return i + 1;
      }
    }
    return null;
  };

  // Resolve the file path a keyed block is about (tool detail / edit
  // diff target) and hand it to the screen's open-file dispatcher.
  // Returns true when the path was real and a spawn was attempted, so
  // the screen knows to suppress its row-text scan + word-snap copy
  // fallback. False means "I don't have a path for this block — go
  // ahead with the default double-click handling."
  const handleBlockDoubleClick = (key: string, rowOffset: number): boolean => {
    // Edit-diff block: combine the best path (locations[] is canonical
    // when present, otherwise the diff.path) with the best line
    // (locations[0].line when present, otherwise the first-changed
    // file line derived from the diff body + file on disk). Agents
    // like Claude often populate locations with a path but no line —
    // an all-or-nothing locations check would dispatch with no line
    // info and skip the in-file lookup that knows where the change
    // actually landed.
    if (key.startsWith("editdiff:")) {
      const id = key.slice("editdiff:".length);
      const diff = renderedEditDiffs.get(id);
      const state = toolStates.get(id);
      const loc = state?.locations?.[0];
      const filePath = loc?.path ?? diff?.path;
      if (!filePath) {
        return false;
      }
      let lineNum: number | null = null;
      if (loc?.line !== undefined) {
        lineNum = loc.line;
      } else if (diff) {
        lineNum = firstChangedFileLine(diff);
      }
      const suffix = lineNum === null ? "" : `:${lineNum}`;
      return screen.tryOpenPathString(filePath + suffix);
    }
    // Tools block: prefer locations[] (canonical {path, line}) when
    // present; otherwise fall back to whatever path the tool's detail
    // string carries (line info not available there).
    if (key.startsWith("tools:")) {
      if (rowOffset === 0) {
        return false;
      }
      const owners = rowOwners.get(key);
      const toolCallId = owners ? owners[rowOffset] : undefined;
      if (!toolCallId) {
        return false;
      }
      const state = toolStates.get(toolCallId);
      const loc = state?.locations?.[0];
      if (loc) {
        const suffix = loc.line === undefined ? "" : `:${loc.line}`;
        if (screen.tryOpenPathString(loc.path + suffix)) {
          return true;
        }
      }
      const candidate = state?.detailFull ?? state?.detail;
      if (candidate) {
        return screen.tryOpenPathString(candidate);
      }
    }
    return false;
  };

  const handleBlockClick = (key: string, rowOffset: number): void => {
    if (key.startsWith("editdiff:")) {
      const id = key.slice("editdiff:".length);
      const diff = renderedEditDiffs.get(id);
      if (!diff) {
        return;
      }
      // Current shown state: an existing override, else the global mode
      // ("diff" counts as expanded, "edit" as collapsed). Flip it.
      const current =
        editDiffOverrides.get(id) ?? viewPrefs.showFileUpdates === "diff";
      editDiffOverrides.set(id, !current);
      // Past-turn diffs have no live toolState; re-render from the retained
      // payload. maybeRenderEditDiff handles the live turn, but using the
      // retained-payload path uniformly is simpler and correct for both.
      const next = !current ? "diff" : "edit";
      renderEditDiffBlock(id, diff, next);
      screen.repaintNow();
      return;
    }
    if (key === "plan") {
      if (lastPlanEvent === null) {
        return;
      }
      const current = planOverride ?? viewPrefs.planExpanded;
      planOverride = !current;
      rerenderPlan();
      screen.repaintNow();
      return;
    }
    if (key.startsWith("tools:")) {
      // rowOffset === 0 → header click: flip the block-level cap via
      // toolsOverrides. Does NOT touch perToolExpanded.
      if (rowOffset === 0) {
        const current = toolsOverrides.get(key) ?? viewPrefs.toolsExpanded;
        toolsOverrides.set(key, !current);
        if (key === currentToolsKey && toolsBlockStartedAt !== null) {
          renderToolsBlock();
        } else {
          renderToolsBlockFor(key);
        }
        screen.repaintNow();
        return;
      }
      // rowOffset > 0 → per-tool click: resolve toolCallId from rowOwners.
      const owners = rowOwners.get(key);
      if (!owners) {
        return;
      }
      const toolCallId = owners[rowOffset];
      if (!toolCallId) {
        return;
      }
      toggleToolExpansion(toolCallId, perToolExpanded);
      renderToolsBlockFor(key);
      screen.repaintNow();
      return;
    }
    if (key.startsWith("thought:")) {
      if (!renderedThoughts.has(key)) {
        return;
      }
      // Clicking the lead line of an already-collapsed run expands it:
      // restore the lead block's full content and unfold the trailing
      // (hidden) blocks back into view.
      const collapsedRun = collapsedThoughtRuns.get(key);
      if (collapsedRun !== undefined) {
        collapsedThoughtRuns.delete(key);
        screen.setRunCollapsed(collapsedRun, false, expandedThoughtLines(key));
        screen.repaintNow();
        return;
      }
      // Otherwise fold the whole visually-contiguous run of thoughts (split
      // only by tool calls, which render elsewhere) behind a single
      // "Thoughts" line anchored at the run's first block.
      const run = screen.contiguousRun(key, new Set(renderedThoughts.keys()));
      if (run.length === 0) {
        return;
      }
      const anchor = run[0]!;
      collapsedThoughtRuns.set(anchor, run);
      screen.setRunCollapsed(run, true, [thinkingLine()]);
      screen.repaintNow();
      return;
    }
  };

  applyRenderEvent = (event: RenderEvent, rawUpdate?: unknown): void => {
    if (event.kind === "available-commands") {
      agentCommands = event.commands;
      refreshCompletions();
      return;
    }
    if (event.kind === "available-modes") {
      agentModes = event.modes;
      return;
    }
    if (event.kind === "config-options") {
      // PoC: drive the agent indicator entirely from the unified config
      // snapshot. The agent option's currentValue is authoritative; reflect
      // it into the sessionbar the same way the session_info_update path
      // does (the two arrive together today, so this is belt-and-braces).
      agentConfigOptions = event.options;
      const agentOpt = event.options.find((o) => o.id === "agent");
      if (
        agentOpt &&
        agentOpt.currentValue &&
        agentOpt.currentValue !== resolvedAgentId
      ) {
        resolvedAgentId = agentOpt.currentValue;
        screen.setSessionbar({ agent: agentOpt.currentValue });
      }
      // opencode 1.15.13+ advertises its mode list inside the unified
      // config snapshot rather than via available_modes_update. Map the
      // `mode` option's value list into agentModes so Shift+Tab cycling
      // works without relying on the spec-shape broadcast.
      const modeOpt = event.options.find((o) => o.id === "mode");
      if (modeOpt) {
        agentModes = modeOpt.options.map((v) => ({
          id: v.value,
          name: v.name ?? v.value,
          ...(v.description !== undefined ? { description: v.description } : {}),
        }));
      }
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
      // A pending /hydra agent switch reuses the compaction banner slot:
      // a string names the target while synthesis runs, null clears it
      // once the swap lands (the agentId update above reflects the new
      // agent, so a "switched to" toast mirrors compaction's "compacted").
      if (event.pendingAgentSwap !== undefined) {
        if (typeof event.pendingAgentSwap === "string") {
          screen.setCompactionIndicator(
            `switching to ${event.pendingAgentSwap}...`,
          );
        } else {
          screen.setCompactionIndicator(null);
          if (event.agentId !== undefined) {
            screen.notify(`switched to ${event.agentId}`, 2000);
          }
        }
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
      // replayed at attach, the previous turn's plan keyed block stays
      // anchored mid-scrollback. The next turn's plan event would then
      // splice into that stale anchor far above the viewport, so clear
      // it here. The tools block uses a per-turn key (bumped in
      // startToolsBlock), so the next turn anchors fresh regardless — we
      // snapshot it (for click-to-expand) but keep its keyedBlocks entry
      // so a click can still re-render it in place.
      snapshotToolsBlock();
      screen.clearKey("plan");
      lastPlanEvent = null;
      planOverride = null;
      toolStates.clear();
      exitPlanStates.clear();
      toolCallOrder.length = 0;
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
      if (agentKey === null) {
        maybeEmitWorkerHeader(event.workerTaskId);
      }
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
      if (thoughtKey === null) {
        maybeEmitWorkerHeader(event.workerTaskId);
      }
      appendThought(event.text, event.workerTaskId);
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
      if (!toolStates.has(event.toolCallId)) {
        maybeEmitWorkerHeader(event.workerTaskId);
      }
      recordToolCall(
        event.toolCallId,
        event.title,
        event.status,
        undefined,
        event.editDiff,
        event.detail,
        event.detailFull,
        event.locations,
        event.workerTaskId,
        rawUpdate,
      );
      renderToolsBlock();
      maybeRenderEditDiff(event.toolCallId);
      return;
    }
    if (event.kind === "plan") {
      // The agent emits a full plan snapshot each time entries get added
      // or checked off; render it as a single mutating block so the
      // scrollback doesn't accumulate one copy per update.
      closeAgentText();
      closeThought();
      lastPlanEvent = event;
      const lines = formatEvent(event, planFormatOptions());
      if (lines.length > 0) {
        // Leading blank stays part of the keyed block so it floats with
        // the plan when sticky bumps it back to the tail — keeping the
        // visual gap between the plan and whatever's above it.
        // ensureSeparator is taught to skip when the sticky block
        // already starts with this blank, so other code paths don't
        // stack a second one on top.
        screen.upsertLines("plan", [{ body: "" }, ...lines]);
      }
      // While the plan still has open entries it anchors to the bottom
      // of the turn (the sticky float bumps it back below any tool
      // calls / agent text that lands afterward). Once every entry is
      // checked off the plan is historical: drop the sticky float so
      // further activity appends below it. We keep the upsert key
      // tracked so a redundant all-completed snapshot (some agents send
      // the same plan more than once) still splices in place — clearing
      // the key here was the cause of duplicate plan blocks. If the
      // agent later re-opens an entry, the next event flips sticky
      // back on.
      const allComplete =
        event.entries.length > 0 &&
        event.entries.every(
          (e) => (e.status ?? "pending") === "completed",
        );
      screen.setStickyBottomKey(allComplete ? null : "plan");
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
        event.editDiff,
        event.detail,
        event.detailFull,
        event.locations,
        event.workerTaskId,
        rawUpdate,
      );
      if (event.upstreamInterrupted) {
        upstreamInterruptedSeen = true;
      }
      renderToolsBlock();
      maybeRenderEditDiff(event.toolCallId);
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
        const lines = formatEvent(
          {
            ...lastPlanEvent,
            stopped: true,
            amended: event.amended === true,
          },
          planFormatOptions(),
        );
        if (lines.length > 0) {
          screen.upsertLines("plan", [{ body: "" }, ...lines]);
        }
      }
      lastPlanEvent = null;
      planOverride = null;
      screen.clearKey("plan");
      // Re-arm the sticky float for the next turn. If this turn's plan
      // completed, the in-turn handler set the sticky key to null to let
      // post-completion content append below — that needs to flip back
      // to "plan" before the next turn so a fresh plan event there
      // anchors to the bottom of its turn.
      screen.setStickyBottomKey("plan");
      // Freeze the tools block (header switches from live "Xs" to
      // "took Xs"). The next turn uses a fresh per-turn key, so we keep
      // this block's keyedBlocks entry — a click can then re-render it in
      // place from the snapshot. If no tool ever fired this turn the
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
        snapshotToolsBlock();
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
      upstreamInterruptedSeen = false;
      screen.ensureSeparator();
      // Drift reconcile. At a real turn boundary with no queued prompt,
      // no own prompt awaiting (turnInFlight), and no in-flight head id,
      // pendingTurns MUST be 0. Anything higher is accumulated desync —
      // typically a turn_complete that never reached us (e.g. lost during
      // a daemon restart while a turn was in flight; markClosed's
      // fire-and-forget history append can race a SIGTERM). Snap to 0 so
      // the banner returns to ready instead of staying stuck on "busy".
      if (
        shouldDriftSnap({
          pendingTurns,
          queueSize: queueCache.size,
          ownTurnInFlight: turnInFlight !== null,
          hasInFlightHead: currentHeadMessageId !== undefined,
          replayDraining,
          amended: event.amended === true,
        })
      ) {
        adjustPendingTurns(-pendingTurns);
      }
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
  for (const { event } of buffered) {
    if (event.kind === "user-text" && typeof event.text === "string") {
      replayedPromptTexts.push(event.text);
    }
  }
  screen.pauseRepaint();
  replayDraining = true;
  try {
    for (const { event, rawUpdate } of buffered) {
      applyRenderEvent(event, rawUpdate);
    }
  } finally {
    replayDraining = false;
    screen.resumeRepaint();
  }
  if (replayedPromptTexts.length > 0) {
    const merged = mergeReplayedEntries(history, replayedPromptTexts);
    if (merged !== history) {
      history = merged;
      // Replayed prompts arrive expanded (the daemon stores wire form).
      // Mirror them into displayHistory so the dispatcher walk sees the
      // same set of entries — they show as full text on recall, which is
      // the best we can do without paste-id context from another process.
      displayHistory = mergeReplayedEntries(displayHistory, replayedPromptTexts);
      dispatcher.setHistory(buildCombinedHistory(globalHistory, displayHistory));
      saveHistory(historyFile, history).catch(() => undefined);
    }
  }
  livePeerHistoryRecording = true;

  // Attach-time compaction work — two independent concerns share one
  // GET /compact/status call:
  //   A. If compaction is ACTIVE on the daemon (compactionState.status
  //      is requested/running/swap_pending/swap_deferred), seed the
  //      status-line indicator so re-attaching to an in-flight compaction
  //      shows "compacting..." right away rather than waiting for the
  //      next phase broadcast. This runs on every attach.
  //   B. If shouldCompact is true AND this attach woke the session up
  //      (cold → warm), surface the "compact?" prompt. Re-attaches to
  //      an already-hot session don't re-prompt.
  void (async () => {
    try {
      const compactInfoRes = await fetch(
        `${target.baseUrl}/v1/sessions/${encodeURIComponent(resolvedSessionId)}/compact/status`,
        { headers: { Authorization: `Bearer ${target.token}` } },
      );
      if (!compactInfoRes.ok) {
        return;
      }
      const compactInfo = (await compactInfoRes.json()) as {
        shouldCompact?: boolean;
        approxTokens?: number;
        compactionState?: { status?: string; attempts?: number } | null;
      };
      // (A) Seed the indicator from the live compactionState. Mirrors
      // the phase → text mapping in handleCompactionUpdate so the
      // visible state is identical whether sourced from broadcast or
      // from this read.
      const status = compactInfo.compactionState?.status;
      if (status === "requested" || status === "running") {
        screen.setCompactionIndicator("compacting...");
      } else if (status === "swap_pending" || status === "swap_deferred") {
        screen.setCompactionIndicator("compaction queued (waiting for idle)");
      }
      // (B) The prompt only fires on a fresh wake. Gated to avoid
      // nagging on every re-attach.
      if (!attachJustResurrected) {
        return;
      }
      if (compactInfo.shouldCompact !== true) {
        return;
      }
      const approxTokens = compactInfo.approxTokens ?? 0;
      compactionPromptActive = true;
      screen.setCompactionPrompt({
        message: `This session has ~${formatApproxTokens(approxTokens)} tokens of history above the compaction watermark.`,
        options: [
          { label: "Compact now", key: "y" },
          { label: "Not now", key: "n" },
        ],
        selectedIndex: 0,
      });
    } catch {
      // Non-fatal: silently skip on any error.
    }
  })();

  // Attach-time fork-synthesis check — mirrors the compaction block above.
  // If this session is a synthesis fork that's still in progress, seed the
  // banner indicator and start a periodic poller so the user sees state
  // transitions (completion / failure) without having to re-attach.
  void (async () => {
    try {
      const res = await fetch(
        `${target.baseUrl}/v1/sessions/${encodeURIComponent(resolvedSessionId)}`,
        { headers: { Authorization: `Bearer ${target.token}` } },
      );
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as { forkSynthesisState?: "running" | "failed" };
      if (data.forkSynthesisState === "running") {
        screen.setSynthesisIndicator("synthesizing context…");
        startSynthesisPoll();
      } else if (data.forkSynthesisState === "failed") {
        screen.setSynthesisIndicator("⚠ synthesis failed");
        screen.notify("synthesis failed — fork still usable via recall", 8000);
      }
    } catch {
      // Non-fatal: silently skip on any error.
    }
  })();

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
      sessionElapsedTimer = startSessionElapsedTimer();
    }
    // Only anchor a fresh tools block if the replay didn't already leave
    // one live. The busy turn's replayed user-text calls startToolsBlock,
    // so its tool rows are already rendered under the current per-turn
    // key; a second startToolsBlock here would bump to a new key and
    // paint a duplicate empty block below the replayed one. (Harmless
    // before per-turn keys, when both calls shared the constant "tools"
    // key and the second just re-anchored the same block in place.)
    if (toolsBlockStartedAt === null) {
      startToolsBlock();
    }
    // Anchor the tools header's elapsed clock to the daemon's authoritative
    // turn start, not the reattach moment. Whether the block was anchored
    // by replay or by startToolsBlock above, its startedAt is Date.now()
    // (time-of-reattach), which would make the header read "thinking · 0s"
    // for a turn that's actually been running a while. Override it so the
    // tools "Xs" matches the banner elapsed.
    toolsBlockStartedAt = initialTurnStartedAt;
    renderToolsBlock();
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
    snapshotToolsBlock();
    toolStates.clear();
    exitPlanStates.clear();
    toolCallOrder.length = 0;
    toolsBlockStartedAt = null;
    toolsBlockEndedAt = null;
    toolsBlockStopReason = null;
  };

  // Disconnect signal arrives the moment the underlying WS drops and a
  // reconnect is queued. Flag the banner so the user has feedback while
  // we retry; the prompt queue keeps accepting input and ResilientWsStream
  // buffers outbound sends until the new connection is live.
  onDisconnectHook = (err): void => {
    writeDebugLine({
      src: "reconnect",
      step: "disconnect",
      message: err?.message,
    });
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
    writeDebugLine({ src: "reconnect", step: "begin", sessionId: resolvedSessionId });
    // Refresh target.baseUrl / target.wsUrl from the pidfile on every
    // reconnect for local daemons. The WS layer's ResilientWsUrl resolver
    // already re-reads the pidfile per attempt (wsUrl above), but
    // target.baseUrl was captured once at runSession entry and is used by
    // every HTTP path (listSessions for ^P picker, /v1/sessions/.../compact,
    // /v1/sessions/.../export, fork/kill/info endpoints). If `hydra daemon
    // restart` lands on a different ephemeral loopback port, those HTTP
    // calls all reject with 'fetch failed' against the stale URL — making
    // ^P silently do nothing while WS-driven UI keeps working. Mutate in
    // place so every downstream reference (closures, helper calls) picks
    // up the fresh URLs without rewiring.
    if (target.isLocal) {
      try {
        const fresh = await resolveLocalTarget(await loadConfig());
        if (fresh.baseUrl !== target.baseUrl || fresh.wsUrl !== target.wsUrl) {
          writeDebugLine({
            src: "reconnect",
            step: "target-refresh",
            oldBase: target.baseUrl,
            newBase: fresh.baseUrl,
          });
          target.baseUrl = fresh.baseUrl;
          target.wsUrl = fresh.wsUrl;
          target.display = fresh.display;
        }
      } catch (err) {
        // Best-effort: if the pidfile read fails the stale URL stays in
        // place and downstream HTTP calls will surface the error in their
        // own catch paths. The WS reconnect itself still succeeds.
        writeDebugLine({
          src: "reconnect",
          step: "target-refresh-failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
    writeDebugLine({ src: "reconnect", step: "initialize-send" });
    try {
      await stream.request(initReq);
      writeDebugLine({ src: "reconnect", step: "initialize-ok" });
    } catch (err) {
      writeDebugLine({
        src: "reconnect",
        step: "initialize-fail",
        message: (err as Error).message,
      });
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
        ...(() => {
          const meta: Record<string, unknown> = {};
          if (upstreamSessionId !== undefined) {
            meta.resume = {
              upstreamSessionId,
              agentId: resolvedAgentId,
              cwd: resolvedCwd,
            };
          }
          if (config.tui.toolContent === "references") {
            meta.toolContent = "references";
          }
          return Object.keys(meta).length > 0
            ? { _meta: { [HYDRA_META_KEY]: meta } }
            : {};
        })(),
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
    writeDebugLine({
      src: "reconnect",
      step: "attach-send",
      useAfterMessage,
      lastSeenMessageId,
    });
    try {
      const resp = await stream.request(attachReq);
      writeDebugLine({
        src: "reconnect",
        step: "attach-resp",
        hasError: Boolean(resp.error),
      });
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
      writeDebugLine({
        src: "reconnect",
        step: "attach-fail",
        message: attachErr.message,
      });
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
      replayDraining = true;
      try {
        for (const params of buffered) {
          handleSessionUpdate(params);
        }
      } finally {
        replayDraining = false;
      }
    }
    // Reconcile pendingTurns against the daemon's authoritative state.
    // The daemon's turnStartedAt is the source of truth: if it's defined
    // we're mid-turn (even when local accounting missed the prompt_received
    // — e.g. own-originator path where session/prompt rejected during the
    // disconnect and runPrompt's finally cleared pendingTurns); if it's
    // undefined we're idle (even when local accounting has stale +1s left
    // over from a daemon-restart-dropped turn_complete). Skip when fields
    // is undefined (attach errored) — we have no authoritative signal.
    if (fields) {
      const reconcile = computeAttachReconcile({
        daemonTurnStartedAt: fields.turnStartedAt,
        pendingTurns,
      });
      if (reconcile.pendingTurnsDelta !== 0) {
        adjustPendingTurns(reconcile.pendingTurnsDelta);
      }
      if (reconcile.banner === "busy" && reconcile.busySince !== undefined) {
        sessionBusySince = reconcile.busySince;
        screen.setBanner({
          status: "busy",
          elapsedMs: Date.now() - reconcile.busySince,
        });
        if (sessionElapsedTimer === null) {
          sessionElapsedTimer = startSessionElapsedTimer();
        }
      } else {
        screen.setBanner({ status: "ready", elapsedMs: undefined });
      }
    } else {
      screen.setBanner({
        status: pendingTurns > 0 ? "busy" : "ready",
        elapsedMs: pendingTurns > 0 ? 0 : undefined,
      });
    }
    writeDebugLine({ src: "reconnect", step: "end" });
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
  viewPrefs: ViewPrefs,
): Promise<SessionContext | null> {
  let cwd = opts.cwd ?? process.cwd();
  if (opts.sessionId) {
    const ctx: SessionContext = {
      sessionId: opts.sessionId,
      agentId: opts.agentId ?? "",
      cwd,
    };
    if (opts.resumeHint !== undefined) {
      ctx.resumeHint = opts.resumeHint;
    }
    return ctx;
  }
  if (opts.forceNew) {
    // --new bypasses the picker, so there's no list to fall back to:
    // both Esc (back) and ^C (cancel) from the agent prompt exit all.
    const agentStep = await ensureAgentForNew(term, target, opts, viewPrefs);
    if (agentStep !== "ok") {
      return null;
    }
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
  // Smart default: show every warm session plus up to PICKER_COLD_LIMIT
  // most-recently-touched cold ones so the list stays scannable even with
  // a deep on-disk history. The picker defaults its cursor to
  // "New session" so just pressing Enter creates a fresh one.
  // Outer loop: the action dialog's Esc returns "back" to re-show the
  // picker so the user isn't trapped after pressing Enter on the wrong
  // imported row. Every other picker exit path resolves the function.
  while (true) {
    // Picker manages its own interactive-only filter; ask for everything.
    const sessions = await listSessions(target, { includeNonInteractive: true });
    const choice: PickerResult = await pickSession(term, {
      cwd,
      sessions,
      config,
      target,
      prefs: pickerPrefs,
      ...(opts.initialPrompt !== undefined
        ? { initialPrompt: opts.initialPrompt }
        : {}),
    });
    if (choice.kind === "abort" || choice.kind === "exit") {
      return null;
    }
    if (choice.kind === "new") {
      if (choice.prompt !== undefined) {
        opts.initialPrompt = choice.prompt;
      }
      if (choice.cwd !== undefined) {
        cwd = choice.cwd;
        opts.cwd = choice.cwd;
      }
      // If no agent is configured, choose one before creating the
      // session. Esc (back) re-shows the picker — opts.initialPrompt is
      // preserved above, so the composer re-opens with the typed text.
      // ^C (cancel) tears down the launch.
      const agentStep = await ensureAgentForNew(term, target, opts, viewPrefs);
      if (agentStep === "cancel") {
        return null;
      }
      if (agentStep === "back") {
        continue;
      }
      return newCtx(opts, cwd, config);
    }
    if (choice.kind === "fork") {
      const decided = await runForkFlow(term, target, choice, sessions);
      if (decided.kind === "cancel") {
        return null;
      }
      if (decided.kind === "back") {
        continue;
      }
      return decided.ctx;
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
      const decided = await runImportedFirstLaunchFlow(term, target, chosen, choice, opts);
      if (decided.kind === "cancel") {
        return null;
      }
      if (decided.kind === "back") {
        continue;
      }
      return decided.ctx;
    }
    // A local session whose recorded cwd no longer exists (e.g. a `cat`
    // session whose /tmp sandbox was cleaned up) can't be resumed: the
    // agent's own session is pinned to that dir (claude-acp fails with
    // `Path "…" does not exist`). Prompt for a replacement cwd, defaulting
    // to the configured defaultCwd, and forward it as a resume hint with
    // an empty upstreamSessionId so the daemon reseeds a fresh agent
    // session there and replays history. Only for local, non-imported,
    // non-readonly picks — remote daemons own a cwd we can't stat here.
    if (target.isLocal && chosen && !chosen.importedFromMachine && !opts.readonly) {
      const v = await validateLocalCwd(chosen.cwd);
      if (!v.ok) {
        const r = await promptForImportCwd(term, chosen, {
          defaultCwd: expandHome(config.defaultCwd),
          title: "Working directory missing — choose cwd",
          intro: "This session's working directory no longer exists. Pick a new one:",
        });
        if (r.kind === "cancel") {
          return null;
        }
        if (r.kind === "back") {
          continue;
        }
        const agentId = choice.agentId ?? chosen.agentId ?? "";
        return {
          sessionId: choice.sessionId,
          agentId,
          cwd: r.path,
          resumeHint: {
            agentId,
            cwd: r.path,
            upstreamSessionId: "",
          },
        };
      }
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
  target: RemoteTarget,
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
    const picked = await resolveForkAgent(
      term,
      target,
      choice.agentId ?? chosen.agentId ?? "",
    );
    if (picked.kind === "cancel") {
      return { kind: "cancel" };
    }
    if (picked.kind === "back") {
      continue;
    }
    const cwdResult = await promptForImportCwd(term, chosen);
    if (cwdResult.kind === "cancel") {
      return { kind: "cancel" };
    }
    if (cwdResult.kind === "back") {
      continue;
    }
    const agentId = picked.agentId;
    return {
      kind: "ctx",
      ctx: {
        sessionId: choice.sessionId,
        agentId,
        cwd: cwdResult.path,
        // Empty upstreamSessionId → import-reseed path for a never-launched
        // imported session.
        resumeHint: { agentId, cwd: cwdResult.path, upstreamSessionId: "" },
      },
    };
  }
}

// Forking inherits the source session's agent. If that agent isn't
// available on this host (absent from /v1/agents — the same condition the
// daemon's getAgent rejects at resurrect), prompt for a local replacement
// using the shared agent picker. Best-effort: a fetch failure, empty list,
// or unknown source agent leaves the source agent unchanged so the flow
// proceeds exactly as before.
async function resolveForkAgent(
  term: termkit.Terminal,
  target: RemoteTarget,
  sourceAgentId: string,
): Promise<
  | { kind: "ok"; agentId: string; changed: boolean }
  | { kind: "back" }
  | { kind: "cancel" }
> {
  if (!sourceAgentId) {
    return { kind: "ok", agentId: sourceAgentId, changed: false };
  }
  let agents;
  try {
    agents = await listAgents(target);
  } catch {
    return { kind: "ok", agentId: sourceAgentId, changed: false };
  }
  if (agents.length === 0 || agents.some((a) => a.id === sourceAgentId)) {
    return { kind: "ok", agentId: sourceAgentId, changed: false };
  }
  const result = await promptForAgent(term, agents, sourceAgentId, {
    title: "Agent not available here",
    intro: `Source agent "${sourceAgentId}" isn't installed on this machine — pick a local agent to fork to:`,
  });
  if (result.kind === "cancel") {
    return { kind: "cancel" };
  }
  if (result.kind === "back") {
    return { kind: "back" };
  }
  return { kind: "ok", agentId: result.agentId, changed: true };
}

// Picker's `f` keystroke landed here. If the source was imported from
// another machine and has never been launched locally, ask the user for
// a local cwd (the source's recorded cwd may not exist here) — same
// dialog runImportedFirstLaunchFlow uses for the launch path. Otherwise
// inherit the source's cwd. Then POST /v1/sessions/:id/fork and route
// the caller to attach against the new session id.
async function runForkFlow(
  term: termkit.Terminal,
  target: RemoteTarget,
  choice: PickerResult & { kind: "fork" },
  sessions: DiscoveredSession[],
): Promise<ImportedFirstLaunchDecision> {
  const source = sessions.find((s) => s.sessionId === choice.sourceSessionId);
  const isForeignNeverLaunched =
    !!choice.sourceImportedFromMachine && !choice.sourceUpstreamSessionId;
  let cwd = choice.sourceCwd;

  const picked = await resolveForkAgent(
    term,
    target,
    choice.sourceAgentId ?? source?.agentId ?? "",
  );
  if (picked.kind === "cancel") {
    return { kind: "cancel" };
  }
  if (picked.kind === "back") {
    return { kind: "back" };
  }
  const chosenAgentId = picked.changed ? picked.agentId : undefined;

  if (isForeignNeverLaunched) {
    if (!source) {
      // Source row vanished between picker close and lookup — re-show
      // the picker so the user can pick again.
      return { kind: "back" };
    }
    const cwdResult = await promptForImportCwd(term, source);
    if (cwdResult.kind === "cancel") {
      return { kind: "cancel" };
    }
    if (cwdResult.kind === "back") {
      return { kind: "back" };
    }
    cwd = cwdResult.path;
  }
  const agentId = chosenAgentId ?? choice.sourceAgentId ?? "";
  let result;
  try {
    result = await forkSession(target, choice.sourceSessionId, {
      ...(isForeignNeverLaunched ? { cwd } : {}),
      ...(chosenAgentId ? { agentId: chosenAgentId } : {}),
    });
  } catch (err) {
    term.red(`\nfork failed: ${(err as Error).message}\n`);
    return { kind: "cancel" };
  }
  return {
    kind: "ctx",
    ctx: {
      sessionId: result.sessionId,
      agentId,
      cwd,
      isFreshFork: true,
      // For foreign-never-launched forks, the daemon stamped the chosen
      // cwd onto meta.json via the POST body, but the very first attach
      // still goes through the import-reseed path (upstreamSessionId=""),
      // and the resume hint is what makes attachManagerHooks persist
      // the local cwd over the bundle's recorded one.
      ...(isForeignNeverLaunched
        ? {
            resumeHint: {
              agentId,
              cwd,
              upstreamSessionId: "",
            },
          }
        : {}),
    },
  };
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

// When a new session is about to spawn an agent and the user has neither
// passed --agent nor configured a default, surface the agent picker.
// Returns "ok" once opts.agentId is set (either it already was, a default
// is configured, or the user just chose one), "back" if the user pressed
// Esc, or "cancel" on ^C/^D. On a successful pick, `s` also persists the
// choice as config.defaultAgent. A fetch failure is non-fatal: we leave
// opts.agentId unset and let the daemon fall back to its schema default.
async function ensureAgentForNew(
  term: termkit.Terminal,
  target: RemoteTarget,
  opts: TuiOptions,
  viewPrefs: ViewPrefs,
): Promise<"ok" | "back" | "cancel"> {
  if (opts.agentId) {
    return "ok";
  }
  if (await hasConfiguredDefaultAgent()) {
    return "ok";
  }
  let agents;
  try {
    agents = await listAgents(target);
  } catch {
    return "ok";
  }
  if (agents.length === 0) {
    return "ok";
  }
  const config = await loadConfig();
  // Prefer the in-process last pick over config.defaultAgent (which is
  // unset on this path anyway, since hasConfiguredDefaultAgent() gated
  // above) so the second+ prompt in a launch lands on the user's most
  // recent choice instead of the hardcoded fallback.
  const preferred = viewPrefs.lastChosenAgent ?? config.defaultAgent;
  const result = await promptForAgent(term, agents, preferred);
  if (result.kind === "cancel") {
    return "cancel";
  }
  if (result.kind === "back") {
    return "back";
  }
  opts.agentId = result.agentId;
  viewPrefs.lastChosenAgent = result.agentId;
  if (result.persist) {
    try {
      await setDefaultAgent(result.agentId);
    } catch {
      // Persisting is best-effort — the session still launches with the
      // chosen agent via opts.agentId even if the config write fails.
    }
  }
  return "ok";
}

// Records every session/update the TUI receives, paired with the
// RenderEvent kind we mapped it to (or null when the mapper rejected the
// shape), so a user reporting "thoughts/tools aren't rendering" has a
// ready artifact to share. Backed by the shared tui.log writer.
function debugLogUpdate(update: unknown, event: RenderEvent | null): void {
  writeDebugLine({
    src: "session/update",
    update,
    event: event === null ? null : { kind: event.kind },
  });
}

// Single-line, redraw-in-place status indicator used in the pre-screen
// gap between the picker closing and screen.start() entering the
// alternate screen. Backs the launch label ("Starting new session…"
// / "Resuming session…") and overwrites it with live agent-install
// progress when the daemon fires hydra-acp/agents/install_progress.
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


