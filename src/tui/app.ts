// Orchestrator: ties config, daemon discovery, WS connection, the screen, and
// the input dispatcher together.

import { appendFileSync, statSync, renameSync } from "node:fs";
import { nanoid } from "nanoid";
import termkit from "terminal-kit";
import { JsonRpcConnection } from "../acp/connection.js";
import {
  HYDRA_META_KEY,
  extractHydraMeta,
  type JsonRpcRequest,
  ACP_PROTOCOL_VERSION,
} from "../acp/types.js";
import { ResilientWsStream } from "../shim/resilient-ws.js";
import { ensureConfig, type HydraConfig } from "../core/config.js";
import { ensureDaemonReachable } from "../core/daemon-bootstrap.js";
import { stripHydraSessionPrefix } from "../core/session.js";
import { paths } from "../core/paths.js";
import { HYDRA_VERSION } from "../core/hydra-version.js";
import {
  appendEntry,
  loadHistory,
  saveHistory,
} from "./history.js";
import { listSessions, pickMostRecent } from "./discovery.js";
import { pickSession, type PickerResult } from "./picker.js";
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
} from "./attachments.js";
import { readClipboard } from "./clipboard.js";
import fs from "node:fs/promises";
import path from "node:path";
import { computeTabCompletion } from "./completion.js";
import {
  mapUpdate,
  normalizeAdvertisedCommands,
  sanitizeSingleLine,
  type AvailableCommand,
  type RenderEvent,
} from "./render-update.js";
import {
  formatEvent,
  formatToolLine,
  parseAgentMarkdown,
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
}

interface SessionContext {
  sessionId: string;
  agentId: string;
  cwd: string;
}

const PLAN_PREFIX_TEXT =
  "Plan mode is on. Outline what you would do without making any changes. " +
  "Do not edit files, run shell commands, or otherwise execute side effects; " +
  "produce a plan only.";

export async function runTuiApp(opts: TuiOptions): Promise<void> {
  const config = await ensureConfig();
  logMaxBytes = config.tui.logMaxBytes;
  await ensureDaemonReachable(config);
  const term = termkit.terminal;

  // Filled in by runSession as soon as a session is attached/created.
  // Used to print a "To resume: …" hint on the way out so the user
  // doesn't have to dig through `hydra-acp sessions list` to come back.
  const exitHint: { sessionId?: string } = {};
  let nextOpts: TuiOptions | null = opts;
  while (nextOpts !== null) {
    nextOpts = await runSession(term, config, nextOpts, exitHint);
  }
  if (exitHint.sessionId) {
    const short = stripHydraSessionPrefix(exitHint.sessionId);
    process.stdout.write(`To resume: hydra-acp tui --resume ${short}\n`);
  }
}

async function runSession(
  term: termkit.Terminal,
  config: HydraConfig,
  opts: TuiOptions,
  exitHint: { sessionId?: string },
): Promise<TuiOptions | null> {
  const ctx = await resolveSession(term, config, opts);
  if (!ctx) {
    // Picker was aborted (Ctrl+C / Esc). singleColumnMenu leaves grabInput
    // engaged on cancel, which keeps the event loop alive past the return.
    // Release it and exit explicitly so the user gets their shell back.
    term.grabInput(false);
    process.exit(0);
  }

  // Visible status while the daemon brings up (or attaches to) the
  // session. Resurrection of cold sessions and fresh-agent spawns can
  // take a couple of seconds; without this line the terminal looks
  // hung between the picker closing and screen.start() entering
  // fullscreen. The alternate-screen switch in screen.start() naturally
  // wipes whatever we printed here.
  const launchLabel =
    ctx.sessionId === "__new__"
      ? "Starting new session…"
      : "Resuming session…";
  term.brightYellow(launchLabel)("\n");

  const protocol = config.daemon.tls ? "wss" : "ws";
  const wsUrl = `${protocol}://${config.daemon.host}:${config.daemon.port}/acp`;
  const subprotocols = ["acp.v1", `hydra-acp-token.${config.daemon.authToken}`];
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

  // Buffer rendered events that arrive before the screen is wired up — most
  // importantly, the history replay during session/attach. Once
  // applyRenderEvent is bound we drain the buffer through it.
  let bufferedEvents: RenderEvent[] = [];
  let applyRenderEvent: ((event: RenderEvent) => void) | null = null;
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
  // start one of our own (in processPrompt). Decremented on every
  // turn_complete (peer's, observed here; ours, in processPrompt's
  // finally). The worker refuses to fire session/prompt while this is
  // non-zero so we don't barge into a sibling's turn.
  let pendingTurns = 0;
  // Wall-clock moment the session became busy (pendingTurns went 0 → >0).
  // Drives the banner's elapsed counter so the user sees "● running 30s"
  // for peer-triggered turns too, not just our own.
  let sessionBusySince: number | null = null;
  let sessionElapsedTimer: NodeJS.Timeout | null = null;
  // Centralized pending-turn arithmetic so banner state, elapsed timer,
  // and (on decrement) tickWorker all stay in sync regardless of whether
  // the underlying turn was ours or a peer's. Without this the banner
  // would stay on "ready" while a peer is mid-turn.
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
      dispatcherRef?.setTurnRunning(true);
      if (screenReady) {
        screenRef!.setBanner({ status: "busy", elapsedMs: 0 });
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
          screenRef.setBanner({ elapsedMs: Date.now() - sessionBusySince });
          renderToolsBlock();
        }, 1_000);
      }
    } else if (before > 0 && pendingTurns === 0) {
      sessionBusySince = null;
      dispatcherRef?.setTurnRunning(false);
      if (sessionElapsedTimer !== null) {
        clearInterval(sessionElapsedTimer);
        sessionElapsedTimer = null;
      }
      if (screenReady) {
        screenRef!.setBanner({ status: "ready", elapsedMs: undefined });
      }
    }
    if (delta < 0) {
      tickWorker();
    }
  };
  // Late-bound references so adjustPendingTurns (which can run via
  // onNotification before `screen` and `dispatcher` are assigned) can
  // tell whether it's safe to touch them. dispatcherRef in particular
  // gates the turnRunning flag that drives ^C → cancel; without it,
  // a mid-turn reattach leaves ^C falling through to the exit path.
  let screenRef: Screen | null = null;
  let dispatcherRef: InputDispatcher | null = null;
  conn.onNotification("session/update", (params) => {
    const { update } = (params ?? {}) as { update?: unknown };
    const event = mapUpdate(update);
    debugLogUpdate(update, event);
    // Only prompt_received signals a new turn. user_message_chunk also
    // maps to a "user-text" event but agents legitimately emit it
    // mid-turn (e.g. echoing a user's reply during a permission/elicit
    // flow); counting those would leave pendingTurns stranded and lock
    // the prompt queue.
    const rawTag = (update as { sessionUpdate?: unknown } | undefined)
      ?.sessionUpdate;
    if (rawTag === "prompt_received") {
      adjustPendingTurns(1);
    } else if (event?.kind === "turn-complete") {
      adjustPendingTurns(-1);
    }
    if (rawTag === "permission_resolved") {
      handlePermissionResolved(update);
      return;
    }
    appendRender(event);
    maybeDismissPermissionByToolUpdate(update);
  });

  // Sibling client answered the permission first (or the daemon synthesized
  // a cancellation on disconnect). Reconstruct the JSON-RPC response shape
  // the modal expects from the update's `outcome` (preferred) or
  // `chosenOptionId` so the awaiting Promise resolves cleanly.
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
    };
    agentInfoName = initResult?.agentInfo?.name;
    const imageCap =
      initResult?.agentCapabilities?.promptCapabilities?.image;
    if (imageCap === false) {
      agentAcceptsImages = false;
    }
  } catch {
    // initialize is optional from the daemon's perspective; proceed regardless.
  }

  let resolvedSessionId = ctx.sessionId;
  let resolvedAgentId = ctx.agentId;
  let resolvedCwd = ctx.cwd;
  let resolvedTitle: string | undefined;
  let initialModel: string | undefined;
  let initialMode: string | undefined;
  let initialCommands: AvailableCommand[] | undefined;
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
    })) as { sessionId: string; _meta?: Record<string, unknown> };
    resolvedSessionId = created.sessionId;
    exitHint.sessionId = resolvedSessionId;
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
    initialTurnStartedAt = hydraMeta.turnStartedAt;
    if (hydraMeta.availableCommands) {
      initialCommands = normalizeAdvertisedCommands(hydraMeta.availableCommands);
    }
  } else {
    const attached = (await conn.request("session/attach", {
      sessionId: ctx.sessionId,
      historyPolicy: "full",
      clientInfo: { name: "hydra-acp-tui", version: HYDRA_VERSION },
    })) as { sessionId: string; _meta?: Record<string, unknown> };
    resolvedSessionId = attached.sessionId;
    exitHint.sessionId = resolvedSessionId;
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
    initialTurnStartedAt = hydraMeta.turnStartedAt;
    if (hydraMeta.availableCommands) {
      initialCommands = normalizeAdvertisedCommands(hydraMeta.availableCommands);
    }
  }

  const historyFile = paths.tuiHistoryFile(resolvedSessionId);
  let history = await loadHistory(historyFile).catch(() => []);
  const dispatcher = new InputDispatcher({ history });
  dispatcherRef = dispatcher;
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
    onKey: (events: KeyEvent[]) => {
      for (const ev of events) {
        if (pendingPermission && tryHandlePermissionKey(ev)) {
          continue;
        }
        if (exitConfirmation && tryHandleExitConfirmKey(ev)) {
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

  const headerName = resolvedAgentId || agentInfoName || "?";
  screen.start();
  screen.setHeader({
    agent: headerName,
    cwd: resolvedCwd,
    sessionId: resolvedSessionId,
    title: resolvedTitle,
    model: initialModel,
  });
  // Surface initial snapshot state (delivered via _meta on attach) so a
  // late-joining or cold-resurrected client sees the current mode
  // immediately — equivalent to what history replay used to do before
  // these moved into meta.json. The model isn't replayed: it's already
  // visible in the header (`agent(model)`), so a scrollback line would
  // just be noise on every session start.
  if (initialMode) {
    screen.appendLines(formatEvent({ kind: "mode-changed", mode: initialMode }));
  }

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
      const sessions = await listSessions(config);
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
  const teardown = (): void => {
    process.off("SIGINT", sigintHandler);
    screen.clearWindowTitle();
    screen.stop();
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
      history = appendEntry(history, pendingDraft);
      dispatcher.setHistory(history);
    }
    // Suspend the live screen but keep the daemon stream (and SIGINT
    // handler) alive — that way an aborted picker drops us right back
    // in the current session without a reconnect or history replay.
    // Updates that arrive while the picker is up land in the Screen's
    // in-memory state; repaints are deferred until we resume.
    screen.pauseRepaint();
    screen.stop();
    saveHistory(historyFile, history).catch(() => undefined);
    const sessions = await listSessions(config);
    const choice: PickerResult = await pickSession(term, {
      cwd: resolvedCwd,
      sessions,
      config,
    });
    if (choice.kind === "abort") {
      screen.start();
      screen.resumeRepaint();
      return;
    }
    // The user is actually switching: finish the teardown and let the
    // outer loop attach the chosen session.
    const resume = finishSession;
    finishSession = null;
    process.off("SIGINT", sigintHandler);
    void stream.close().catch(() => undefined);
    if (choice.kind === "new") {
      const { sessionId: _drop, ...rest } = opts;
      void _drop;
      resume({ ...rest, cwd: resolvedCwd, forceNew: true });
      return;
    }
    const nextOpts: TuiOptions = {
      ...opts,
      sessionId: choice.sessionId,
      cwd: resolvedCwd,
    };
    if (choice.agentId !== undefined) {
      nextOpts.agentId = choice.agentId;
    }
    resume(nextOpts);
  };

  // The dispatcher's queue indices reference the "waiting" slice (the
  // head being processed is invisible to queue editing). Translate back
  // into the real promptQueue offset when applying changes.
  const queueHeadOffset = (): number => (workerActive ? 1 : 0);

  const handleEffect = (effect: InputEffect): void => {
    switch (effect.type) {
      case "send":
        enqueuePrompt(effect.text, effect.planMode, effect.attachments);
        return;
      case "queue-edit": {
        const realIdx = effect.index + queueHeadOffset();
        const existing = promptQueue[realIdx];
        if (existing) {
          // Preserve the slot's original planMode — the user is editing
          // text, not re-deciding plan mode for this slot. Attachments
          // are overwritten with the new submission's set: editing
          // produces a new "draft" so the user's most recent chips win.
          promptQueue[realIdx] = {
            text: effect.text,
            planMode: existing.planMode,
            attachments: effect.attachments,
          };
          refreshQueueDisplay();
        }
        return;
      }
      case "queue-remove": {
        const realIdx = effect.index + queueHeadOffset();
        if (realIdx >= 0 && realIdx < promptQueue.length) {
          promptQueue.splice(realIdx, 1);
          refreshQueueDisplay();
        }
        return;
      }
      case "cancel": {
        // Escape (prefill=true) wants the cancelled prompt put back into
        // the buffer so the user can edit and resubmit — but only when
        // nothing else is queued behind it and the buffer is empty (we
        // never overwrite text the user has typed). Plain ^C skips this.
        if (effect.prefill && turnInFlight) {
          const headOffset = workerActive ? 1 : 0;
          const waitingEmpty = promptQueue.length <= headOffset;
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
        // ^C stops only the in-flight turn. Queued prompts stay put — the
        // worker loop will pick the next one up once the cancelled turn
        // settles. Use queue editing (Up + ^C / Enter) to drop individual
        // queued items, or repeat ^C as each one starts.
        return;
      }
      case "exit":
        void requestExit();
        return;
      case "plan-toggle":
        screen.setBanner({ planMode: effect.on });
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
      case "toggle-tools":
        toolsExpanded = !toolsExpanded;
        renderToolsBlock();
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

  // Reads bytes from disk for each dropped path, sniffs the mime,
  // gates on size and capability, and pushes the survivors onto the
  // dispatcher. Banner-notifies for any rejection so the user knows
  // why a chip didn't appear.
  const handleAttachmentPaths = async (paths: string[]): Promise<void> => {
    if (!agentAcceptsImages) {
      screen.notify("agent does not accept image attachments");
      return;
    }
    let added = 0;
    for (const p of paths) {
      const mimeType = mimeFromExtension(p);
      if (!mimeType) {
        screen.notify(`unsupported image type: ${path.basename(p)}`);
        continue;
      }
      try {
        const buf = await fs.readFile(p);
        if (buf.length > MAX_ATTACHMENT_BYTES) {
          screen.notify(
            `image too large (${formatSize(buf.length)}, max ${formatSize(MAX_ATTACHMENT_BYTES)})`,
          );
          continue;
        }
        dispatcher.addAttachment({
          mimeType,
          data: buf.toString("base64"),
          name: path.basename(p),
          sizeBytes: buf.length,
        });
        added++;
      } catch (err) {
        screen.notify(`cannot read ${path.basename(p)}: ${(err as Error).message}`);
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

  // Serial prompt queue. While a turn is running, Enter pushes here; the
  // worker dequeues and processes one at a time. The user echo is rendered
  // when the prompt is *processed*, not enqueued, so each turn lands as a
  // clean (user → reply) pair in scrollback even if the user typed several
  // prompts back-to-back.
  const promptQueue: Array<{
    text: string;
    planMode: boolean;
    attachments: Attachment[];
  }> = [];
  let workerActive = false;

  const refreshQueueDisplay = (): void => {
    // Skip the head — that one is being processed and is already echoed in
    // scrollback. Show only those still waiting. Attached image count is
    // surfaced as a "📎×N" suffix on the chip text so a queued slot with
    // chips is visually distinct from one without.
    const waiting = promptQueue.slice(workerActive ? 1 : 0);
    const displayTexts = waiting.map((p) =>
      p.attachments.length > 0
        ? `${p.text} · 📎×${p.attachments.length}`
        : p.text,
    );
    screen.setQueuedPrompts(displayTexts);
    screen.setBanner({ queued: waiting.length });
    dispatcher.setQueue(waiting.map((p) => p.text));
  };

  const enqueuePrompt = (
    text: string,
    planMode: boolean,
    attachments: Attachment[],
  ): void => {
    // Sending a prompt always snaps the view to the bottom — the user
    // wants to see their own input and the agent's reply.
    screen.scrollToBottom();
    if (handleBuiltinCommand(text)) {
      return;
    }
    history = appendEntry(history, text);
    dispatcher.setHistory(history);
    saveHistory(historyFile, history).catch(() => undefined);
    promptQueue.push({ text, planMode, attachments });
    refreshQueueDisplay();
    tickWorker();
  };

  // Start the worker iff there's queued work and the session is idle.
  // Called from enqueuePrompt and from the turn_complete observer, so a
  // queued prompt fires the moment a peer's turn finishes.
  const tickWorker = (): void => {
    if (workerActive || pendingTurns > 0 || promptQueue.length === 0) {
      return;
    }
    void runQueueWorker();
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
      case "/model": {
        const arg = space === -1 ? "" : trimmed.slice(space + 1).trim();
        if (arg === "") {
          screen.appendLines([
            {
              prefix: "  ",
              body: "Usage: /model <model-id>",
              bodyStyle: "info",
            },
          ]);
          return true;
        }
        conn
          .request("session/set_model", {
            sessionId: resolvedSessionId,
            modelId: arg,
          })
          .then(() => {
            screen.appendLines([
              {
                prefix: "  ",
                body: `model set to ${arg}`,
                bodyStyle: "system",
              },
            ]);
          })
          .catch((err: Error) => {
            screen.appendLines([
              {
                prefix: "  ",
                body: `set_model failed: ${err.message}`,
                bodyStyle: "tool-status-fail",
              },
            ]);
          });
        return true;
      }
      default:
        // Not a built-in — fall through so the agent can handle it.
        return false;
    }
  };

  const runQueueWorker = async (): Promise<void> => {
    workerActive = true;
    try {
      while (promptQueue.length > 0 && pendingTurns === 0) {
        const next = promptQueue[0];
        if (!next) {
          break;
        }
        // Drop the head from the visual queue zone — it's about to be
        // echoed into scrollback as a real user message.
        refreshQueueDisplay();
        await processPrompt(next.text, next.planMode, next.attachments);
        // Now that processing is fully done (including turn-complete),
        // shift the head off so the next iteration's slice(1) is correct.
        promptQueue.shift();
      }
    } finally {
      workerActive = false;
      refreshQueueDisplay();
      // Escape-cancel staged this. Apply only if the buffer is still
      // empty — the user may have started typing while the cancelled
      // turn was settling, and we don't want to clobber that draft.
      if (pendingPrefill !== null) {
        const { text, attachments } = pendingPrefill;
        pendingPrefill = null;
        const bufferEmpty = dispatcher
          .state()
          .buffer.every((line) => line === "");
        if (bufferEmpty) {
          dispatcher.setBuffer(text, attachments);
          screen.refreshPrompt();
        }
      }
    }
  };

  const processPrompt = async (
    text: string,
    planMode: boolean,
    attachments: Attachment[],
  ): Promise<void> => {
    const userBlocks: Array<Record<string, unknown>> = [];
    if (text.length > 0) {
      userBlocks.push({ type: "text", text });
    }
    for (const a of attachments) {
      userBlocks.push({ type: "image", data: a.data, mimeType: a.mimeType });
    }
    const promptArr = planMode
      ? [{ type: "text", text: PLAN_PREFIX_TEXT }, ...userBlocks]
      : userBlocks;

    // Mark a turn as in-flight before any await so a near-simultaneous
    // enqueue from this client (or a peer broadcast) doesn't slip a
    // second session/prompt past the gate. The adjust helper handles
    // banner status and the elapsed timer in one place so peer-triggered
    // turns get the same "running · 30s" treatment as ours.
    adjustPendingTurns(1);
    appendRender({ kind: "user-text", text, attachments });

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
        prompt: promptArr,
      })) as { stopReason?: unknown };
      if (response && typeof response.stopReason === "string") {
        stopReason = response.stopReason;
      }
    } catch (err) {
      appendRender({
        kind: "unknown",
        sessionUpdate: "error",
        raw: { error: (err as Error).message },
      });
    } finally {
      turnInFlight = null;
      adjustPendingTurns(-1);
      // Daemon broadcasts turn_complete to other clients but excludes the
      // originator (core/session.ts:138). Synthesize it locally so the
      // streaming buffer resets and a separator lands before the next turn.
      appendRender(
        stopReason !== undefined
          ? { kind: "turn-complete", stopReason }
          : { kind: "turn-complete" },
      );
    }
  };

  const usage: { used?: number; size?: number; costAmount?: number; costCurrency?: string } = {};

  // toolCallId → merged state for the per-call row inside the current
  // turn's tools block. Cleared at turn boundaries (the block gets
  // frozen into scrollback first) so each turn starts fresh.
  const toolStates = new Map<string, ToolLineState>();
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
    // to a normal end_turn finish.
    const stoppedReason =
      !inProgress &&
      toolsBlockStopReason !== null &&
      toolsBlockStopReason !== "end_turn"
        ? toolsBlockStopReason
        : null;
    let summary: string;
    if (total === 0) {
      // Pre-tool state — the block exists purely as a "still working"
      // indicator while the agent is thinking, then freezes as "thought · Xs"
      // at turn end so the user has a visible trace of the reasoning time.
      if (stoppedReason !== null) {
        summary = `stopped (${stoppedReason}) · ${formatElapsed(elapsed)}`;
      } else {
        summary = inProgress
          ? `thinking · ${formatElapsed(elapsed)}`
          : `thought · ${formatElapsed(elapsed)}`;
      }
    } else {
      const noun = total === 1 ? "tool" : "tools";
      const timing =
        stoppedReason !== null
          ? `stopped (${stoppedReason}) · ${formatElapsed(elapsed)}`
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
    const pureThinking = total === 0 && inProgress;
    const frozenStyle: "tool-status-fail" | "tool" =
      stoppedReason !== null ? "tool-status-fail" : "tool";
    const frozenBodyStyle: "tool-status-fail" | "dim" =
      stoppedReason !== null ? "tool-status-fail" : "dim";
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
        lines.push(formatToolLine(state));
      }
    }
    screen.upsertLines("tools", lines);
  };

  // Anchor a fresh tools block at the current bottom of scrollback so the
  // user has a visible "agent is working" indicator from the moment a turn
  // starts — even if no tool calls fire for a while. Called from the
  // user-text handler so it fires for both our own prompts (synthesized
  // via processPrompt) and peers' prompts (broadcast by the daemon).
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
    if (event.kind === "session-info") {
      if (event.title !== undefined) {
        screen.setHeader({ title: event.title });
      }
      if (event.agentId !== undefined && event.agentId !== resolvedAgentId) {
        resolvedAgentId = event.agentId;
        screen.setHeader({ agent: event.agentId });
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
        screen.setHeader({ usage: { ...usage } });
      }
      return;
    }
    if (event.kind === "user-text") {
      // Render the user prompt first, then anchor the "thinking…" tools
      // block directly below it. The order matters — startToolsBlock
      // appends to the bottom of scrollback, so if we called it before
      // emitting user-text the block would land above the prompt and the
      // chronology would read backwards.
      closeAgentText();
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
      toolStates.clear();
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
      appendAgentText(event.text);
      return;
    }
    if (event.kind === "agent-thought") {
      // Thoughts get the streaming-line treatment — short, dim, italic,
      // no markdown. Closing the agent block first ensures the next
      // text chunk starts a fresh block below the thought.
      closeAgentText();
      screen.appendStreaming(event.text, "· ", "thought", "thought");
      return;
    }
    if (event.kind === "tool-call") {
      closeAgentText();
      recordToolCall(event.toolCallId, event.title, event.status);
      renderToolsBlock();
      return;
    }
    if (event.kind === "plan") {
      // The agent emits a full plan snapshot each time entries get added
      // or checked off; render it as a single mutating block so the
      // scrollback doesn't accumulate one copy per update.
      closeAgentText();
      const lines = formatEvent(event);
      if (lines.length > 0) {
        screen.upsertLines("plan", lines);
      }
      return;
    }
    if (event.kind === "tool-call-update") {
      closeAgentText();
      recordToolCall(event.toolCallId, event.title, event.status);
      renderToolsBlock();
      return;
    }
    if (event.kind === "model-changed") {
      // Header reflects live state; scrollback still gets the line below
      // for a visible audit trail.
      screen.setHeader({ model: event.model });
    }
    const formatted = formatEvent(event);
    if (formatted.length > 0) {
      screen.appendLines(formatted);
    }
    if (event.kind === "turn-complete") {
      // The plan upsert is keyed by "plan" so within a turn each update
      // splices in place. Reset that key at the turn boundary so the next
      // turn's first plan event appends as a fresh block below — otherwise
      // it would splice into the previous turn's plan, possibly far up in
      // (or off the top of) scrollback.
      closeAgentText();
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
        toolsBlockStopReason = event.stopReason ?? null;
        renderToolsBlock();
        screen.clearKey("tools");
      }
      toolStates.clear();
      toolCallOrder.length = 0;
      toolsBlockStartedAt = null;
      toolsBlockEndedAt = null;
      toolsBlockStopReason = null;
      toolsExpanded = false;
      screen.ensureSeparator();
    }
  };

  // Drain anything that arrived during the attach handshake (history replay,
  // early usage updates, etc.) into the freshly initialized screen. Pause
  // repaints while draining so a long session doesn't visibly scroll
  // chunk-by-chunk; one repaint at the end shows the final state.
  const buffered = bufferedEvents;
  bufferedEvents = [];
  screen.pauseRepaint();
  try {
    for (const event of buffered) {
      applyRenderEvent(event);
    }
  } finally {
    screen.resumeRepaint();
  }

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

  // Tear down any visible in-flight UI state so the next live signal
  // (turn-complete on reconnect, our own next prompt, etc.) starts from
  // a clean slate. Scrollback lines stay intact — we just sever the
  // keyed-block splice points so new content appends below.
  const resetInFlightUiState = (): void => {
    if (pendingPermission) {
      const resolve = pendingPermission.resolve;
      pendingPermission = null;
      screen.setPermissionPrompt(null);
      resolve({ outcome: { outcome: "cancelled" } });
    }
    closeAgentText();
    if (toolsBlockStartedAt !== null) {
      // Freeze the block in place (with "thought · Xs" when no tool ever
      // fired) instead of removing it. Matches the turn-complete handler
      // and ensures a silent reconnect mid-turn doesn't strip the only
      // visible signal that the agent was reasoning. No stopReason is
      // known here, so the block freezes as plain "thought · Xs" — the
      // turn is genuinely unfinished from our side.
      toolsBlockEndedAt = Date.now();
      toolsBlockStopReason = null;
      renderToolsBlock();
      screen.clearKey("tools");
      toolStates.clear();
      toolCallOrder.length = 0;
      toolsBlockStartedAt = null;
      toolsBlockEndedAt = null;
      toolsBlockStopReason = null;
      toolsExpanded = false;
    }
    screen.clearKey("plan");
    if (pendingTurns > 0) {
      adjustPendingTurns(-pendingTurns);
    }
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
  // attach. historyPolicy=none avoids re-replaying scrollback we already
  // have locally; the daemon will still re-dispatch any in-flight
  // permission via replayPendingPermissions.
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
    const attachReq: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: `tui-reattach-${nanoid()}`,
      method: "session/attach",
      params: {
        sessionId: resolvedSessionId,
        historyPolicy: "none",
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
    try {
      const resp = await stream.request(attachReq);
      if (resp.error) {
        throw new Error(resp.error.message);
      }
    } catch (err) {
      // Surface in scrollback so the user understands why state may
      // diverge. The next live event (or their next prompt) will keep
      // things moving.
      screen.appendLines([
        {
          prefix: "  ",
          body: `reattach failed: ${(err as Error).message}`,
          bodyStyle: "tool-status-fail",
        },
      ]);
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

  return await sessionDone;
}

async function resolveSession(
  term: termkit.Terminal,
  config: HydraConfig,
  opts: TuiOptions,
): Promise<SessionContext | null> {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.sessionId) {
    return {
      sessionId: opts.sessionId,
      agentId: opts.agentId ?? "",
      cwd,
    };
  }
  if (opts.forceNew) {
    return newCtx(opts, cwd, config);
  }
  if (opts.resume) {
    const sessions = await listSessions(config, { cwd, all: true });
    const target = pickMostRecent(sessions, cwd);
    if (!target) {
      term.yellow(`No sessions found for ${cwd}.\n`);
      return null;
    }
    return {
      sessionId: target.sessionId,
      agentId: target.agentId ?? "",
      cwd,
    };
  }
  // Smart default: show every live session plus up to PICKER_COLD_LIMIT
  // most-recently-touched cold ones so the list stays scannable even with
  // a deep on-disk history. The picker defaults its cursor to
  // "+ New session" so just pressing Enter creates a fresh one.
  const sessions = await listSessions(config);
  if (sessions.length === 0) {
    return newCtx(opts, cwd, config);
  }
  const choice: PickerResult = await pickSession(term, {
    cwd,
    sessions,
    config,
  });
  if (choice.kind === "abort") {
    return null;
  }
  if (choice.kind === "new") {
    return newCtx(opts, cwd, config);
  }
  return {
    sessionId: choice.sessionId,
    agentId: choice.agentId ?? "",
    cwd,
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

