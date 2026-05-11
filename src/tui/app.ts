// Orchestrator: ties config, daemon discovery, WS connection, the screen, and
// the input dispatcher together.

import WebSocket from "ws";
import { once } from "node:events";
import termkit from "terminal-kit";
import { JsonRpcConnection } from "../acp/connection.js";
import { wsToMessageStream } from "../acp/ws-stream.js";
import {
  HYDRA_META_KEY,
  type SessionRole,
  extractHydraMeta,
} from "../acp/types.js";
import { ensureConfig, type HydraConfig } from "../core/config.js";
import { ensureDaemonReachable } from "../core/daemon-bootstrap.js";
import { paths } from "../core/paths.js";
import {
  appendEntry,
  loadHistory,
  saveHistory,
} from "./history.js";
import { listSessions, pickMostRecent } from "./discovery.js";
import { pickSession, type PickerResult } from "./picker.js";
import { Screen } from "./screen.js";
import { InputDispatcher, type InputEffect, type KeyEvent } from "./input.js";
import {
  mapUpdate,
  type AvailableCommand,
  type RenderEvent,
} from "./render-update.js";
import { formatEvent, type FormattedLine } from "./format.js";

export interface TuiOptions {
  sessionId?: string;
  role?: SessionRole;
  agentId?: string;
  cwd?: string;
  name?: string;
  resume?: boolean;
  forceNew?: boolean;
}

interface SessionContext {
  sessionId: string;
  agentId: string;
  cwd: string;
  role: SessionRole;
}

const PLAN_PREFIX_TEXT =
  "Plan mode is on. Outline what you would do without making any changes. " +
  "Do not edit files, run shell commands, or otherwise execute side effects; " +
  "produce a plan only.";

export async function runTuiApp(opts: TuiOptions): Promise<void> {
  const config = await ensureConfig();
  await ensureDaemonReachable(config);
  const term = termkit.terminal;

  let nextOpts: TuiOptions | null = opts;
  while (nextOpts !== null) {
    nextOpts = await runSession(term, config, nextOpts);
  }
}

async function runSession(
  term: termkit.Terminal,
  config: HydraConfig,
  opts: TuiOptions,
): Promise<TuiOptions | null> {
  const ctx = await resolveSession(term, config, opts);
  if (!ctx) {
    // Picker was aborted (Ctrl+C / Esc). singleColumnMenu leaves grabInput
    // engaged on cancel, which keeps the event loop alive past the return.
    // Release it and exit explicitly so the user gets their shell back.
    term.grabInput(false);
    process.exit(0);
  }

  const ws = await openWs(config);
  const stream = wsToMessageStream(ws);
  const conn = new JsonRpcConnection(stream);

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

  conn.onNotification("session/update", (params) => {
    const { update } = (params ?? {}) as { update?: unknown };
    appendRender(mapUpdate(update));
    maybeDismissPermissionByToolUpdate(update);
  });

  // Sibling client answered the permission first. The daemon stamps the
  // notification with our request id (post-fix) and the toolCall echo, so
  // matching by toolCallId works regardless of how we keyed the modal.
  conn.onNotification("session/permission_resolved", (params) => {
    const p = (params ?? {}) as {
      toolCall?: { toolCallId?: string };
      result?: unknown;
    };
    dismissPermissionExternally(p.toolCall?.toolCallId, p.result);
  });

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
    screen.appendLines([
      {
        prefix: "  ",
        body: "(resolved by another client)",
        bodyStyle: "info",
      },
    ]);
  };

  // Fallback for the case where session/permission_resolved didn't arrive:
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

  const renderPermissionResolved = (label: string, denied: boolean): void => {
    screen.appendLines([
      {
        prefix: "  ",
        body: `${denied ? "✗" : "✓"} ${label}`,
        bodyStyle: denied ? "tool-status-fail" : "tool-status-ok",
      },
    ]);
  };

  const resolvePermission = (optionId: string | null): void => {
    if (!pendingPermission) {
      return;
    }
    const { options, resolve } = pendingPermission;
    pendingPermission = null;
    screen.setPermissionPrompt(null);
    if (optionId === null) {
      resolve({ outcome: { outcome: "cancelled" } });
      renderPermissionResolved("Cancelled", true);
      return;
    }
    const opt = options.find((o) => o.optionId === optionId);
    resolve({ outcome: { outcome: "selected", optionId } });
    const denied = (opt?.kind ?? "").startsWith("reject");
    renderPermissionResolved(opt?.name ?? optionId, denied);
  };

  conn.onRequest("session/request_permission", async (params) => {
    const p = (params ?? {}) as {
      toolCall?: { name?: string; title?: string; toolCallId?: string };
      options?: PermissionOption[];
    };
    const options = Array.isArray(p.options) ? p.options : [];
    const title = p.toolCall?.title ?? p.toolCall?.name ?? "tool";
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
  try {
    const initResult = (await conn.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "hydra-acp-tui", version: "0.1.0" },
    })) as { agentInfo?: { name?: string } };
    agentInfoName = initResult?.agentInfo?.name;
  } catch {
    // initialize is optional from the daemon's perspective; proceed regardless.
  }

  let resolvedSessionId = ctx.sessionId;
  let resolvedAgentId = ctx.agentId;
  let resolvedCwd = ctx.cwd;
  if (ctx.sessionId === "__new__") {
    const created = (await conn.request("session/new", {
      cwd: ctx.cwd,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.name
        ? { _meta: { [HYDRA_META_KEY]: { name: opts.name } } }
        : {}),
    })) as { sessionId: string; _meta?: Record<string, unknown> };
    resolvedSessionId = created.sessionId;
    const hydraMeta = extractHydraMeta(created._meta ?? undefined);
    upstreamSessionId = hydraMeta.upstreamSessionId;
    if (hydraMeta.agentId) {
      resolvedAgentId = hydraMeta.agentId;
    }
    if (hydraMeta.cwd) {
      resolvedCwd = hydraMeta.cwd;
    }
  } else {
    const attached = (await conn.request("session/attach", {
      sessionId: ctx.sessionId,
      role: ctx.role,
      historyPolicy: "full",
      clientInfo: { name: "hydra-acp-tui", version: "0.1.0" },
    })) as { sessionId: string; _meta?: Record<string, unknown> };
    resolvedSessionId = attached.sessionId;
    const hydraMeta = extractHydraMeta(attached._meta ?? undefined);
    upstreamSessionId = hydraMeta.upstreamSessionId;
    if (hydraMeta.agentId) {
      resolvedAgentId = hydraMeta.agentId;
    }
    if (hydraMeta.cwd) {
      resolvedCwd = hydraMeta.cwd;
    }
  }
  void upstreamSessionId;

  const historyFile = paths.tuiHistoryFile();
  let history = await loadHistory(historyFile).catch(() => []);
  const dispatcher = new InputDispatcher({ history });

  let turnInFlight: { cancel: () => void } | null = null;

  const screen = new Screen({
    term,
    dispatcher,
    onKey: (events: KeyEvent[]) => {
      for (const ev of events) {
        if (pendingPermission && tryHandlePermissionKey(ev)) {
          continue;
        }
        if (tryHandleCompletionKey(ev)) {
          continue;
        }
        const effects = dispatcher.feed(ev);
        for (const effect of effects) {
          handleEffect(effect);
        }
      }
      refreshCompletions();
      screen.refreshPrompt();
    },
  });

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
  ];
  let agentCommands: AvailableCommand[] = [];

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

  // Tab when completions are visible commits the first match; ESC dismisses
  // the list. Other keys fall through.
  const tryHandleCompletionKey = (ev: KeyEvent): boolean => {
    if (ev.type !== "key") {
      return false;
    }
    if (ev.name === "tab") {
      const matches = currentCompletions();
      const first = matches[0];
      if (!first) {
        return false;
      }
      // If multiple matches share a longer common prefix, prefer that;
      // otherwise commit the first match outright (with a trailing space
      // ready for an argument).
      const commonPrefix = longestCommonPrefix(matches.map((m) => m.name));
      const buf = dispatcher.state().buffer;
      const firstLine = buf[0] ?? "";
      const space = firstLine.indexOf(" ");
      const typedPrefix = space === -1 ? firstLine : firstLine.slice(0, space);
      const tail = space === -1 ? "" : firstLine.slice(space);
      let next = commonPrefix;
      if (commonPrefix.length <= typedPrefix.length || matches.length === 1) {
        next = first.name + (tail.startsWith(" ") ? "" : " ");
      }
      dispatcher.replaceFirstLine(next + tail);
      return true;
    }
    return false;
  };

  function longestCommonPrefix(names: string[]): string {
    if (names.length === 0) {
      return "";
    }
    let prefix = names[0] ?? "";
    for (let i = 1; i < names.length; i++) {
      const n = names[i] ?? "";
      let j = 0;
      while (j < prefix.length && j < n.length && prefix[j] === n[j]) {
        j += 1;
      }
      prefix = prefix.slice(0, j);
      if (prefix.length === 0) {
        break;
      }
    }
    return prefix;
  }

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
  });

  let finishSession: ((next: TuiOptions | null) => void) | null = null;
  const sessionDone = new Promise<TuiOptions | null>((resolve) => {
    finishSession = resolve;
  });
  const sigintHandler = (): void => {
    if (turnInFlight) {
      turnInFlight.cancel();
      return;
    }
    stop(0);
  };
  const teardown = (): void => {
    process.off("SIGINT", sigintHandler);
    screen.stop();
    saveHistory(historyFile, history).catch(() => undefined);
    try {
      ws.close();
    } catch {
      void 0;
    }
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
    const resume = finishSession;
    if (!resume) {
      return;
    }
    finishSession = null;
    teardown();
    const sessions = await listSessions(config);
    const choice: PickerResult = await pickSession(term, {
      cwd: resolvedCwd,
      sessions,
    });
    if (choice.kind === "abort") {
      // Stay on the current session: outer loop will re-attach with the same
      // sessionId rather than re-running the picker.
      resume({ ...opts, sessionId: resolvedSessionId, cwd: resolvedCwd });
      return;
    }
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

  const handleEffect = (effect: InputEffect): void => {
    switch (effect.type) {
      case "send":
        enqueuePrompt(effect.text, effect.planMode);
        return;
      case "cancel":
        if (turnInFlight) {
          turnInFlight.cancel();
        }
        // Drop any queued prompts beyond the one currently processing —
        // Ctrl+C means stop, not "stop just this". The head (if any) keeps
        // its current state until the in-flight turn settles.
        if (promptQueue.length > (workerActive ? 1 : 0)) {
          promptQueue.length = workerActive ? 1 : 0;
          refreshQueueDisplay();
        }
        return;
      case "exit":
        stop(0);
        return;
      case "plan-toggle":
        screen.setBanner({ planMode: effect.on });
        return;
      case "redraw-banner":
        screen.setBanner({});
        return;
      case "redraw":
        screen.redraw();
        return;
      case "switch-session":
        void switchSession();
        return;
    }
  };

  // Serial prompt queue. While a turn is running, Enter pushes here; the
  // worker dequeues and processes one at a time. The user echo is rendered
  // when the prompt is *processed*, not enqueued, so each turn lands as a
  // clean (user → reply) pair in scrollback even if the user typed several
  // prompts back-to-back.
  const promptQueue: Array<{ text: string; planMode: boolean }> = [];
  let workerActive = false;

  const refreshQueueDisplay = (): void => {
    // Skip the head — that one is being processed and is already echoed in
    // scrollback. Show only those still waiting.
    const waiting = promptQueue.slice(workerActive ? 1 : 0);
    screen.setQueuedPrompts(waiting.map((p) => p.text));
    screen.setBanner({ queued: waiting.length });
  };

  const enqueuePrompt = (text: string, planMode: boolean): void => {
    // Sending a prompt always snaps the view to the bottom — the user
    // wants to see their own input and the agent's reply.
    screen.scrollToBottom();
    if (handleBuiltinCommand(text)) {
      return;
    }
    history = appendEntry(history, text);
    dispatcher.setHistory(history);
    saveHistory(historyFile, history).catch(() => undefined);
    promptQueue.push({ text, planMode });
    refreshQueueDisplay();
    if (!workerActive) {
      void runQueueWorker();
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
        stop(0);
        return true;
      case "/clear":
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

  const runQueueWorker = async (): Promise<void> => {
    workerActive = true;
    try {
      while (promptQueue.length > 0) {
        const next = promptQueue[0];
        if (!next) {
          break;
        }
        // Drop the head from the visual queue zone — it's about to be
        // echoed into scrollback as a real user message.
        refreshQueueDisplay();
        await processPrompt(next.text, next.planMode);
        // Now that processing is fully done (including turn-complete),
        // shift the head off so the next iteration's slice(1) is correct.
        promptQueue.shift();
      }
    } finally {
      workerActive = false;
      refreshQueueDisplay();
    }
  };

  const processPrompt = async (text: string, planMode: boolean): Promise<void> => {
    const userBlocks = [{ type: "text", text }];
    const promptArr = planMode
      ? [{ type: "text", text: PLAN_PREFIX_TEXT }, ...userBlocks]
      : userBlocks;

    appendRender({ kind: "user-text", text });
    dispatcher.setTurnRunning(true);
    screen.setBanner({ status: "running" });

    let cancelled = false;
    turnInFlight = {
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
      dispatcher.setTurnRunning(false);
      screen.setBanner({ status: "ready" });
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

  applyRenderEvent = (event: RenderEvent): void => {
    if (event.kind === "available-commands") {
      agentCommands = event.commands;
      refreshCompletions();
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
      screen.ensureSeparator();
    }
    if (event.kind === "agent-text") {
      screen.appendStreaming(event.text, "  ", "agent");
      return;
    }
    if (event.kind === "agent-thought") {
      screen.appendStreaming(event.text, "· ", "thought", "thought");
      return;
    }
    const formatted = formatEvent(event);
    if (formatted.length > 0) {
      screen.appendLines(formatted);
    }
    if (event.kind === "turn-complete") {
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
      role: opts.role ?? "controller",
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
      role: opts.role ?? "controller",
    };
  }
  // Smart default: show the same table `hydra-acp sessions` produces (live
  // sessions + recent cold within sessionRecentMinutes) and let the user
  // pick. The picker defaults its cursor to "+ New session" so just pressing
  // Enter creates a fresh one.
  const sessions = await listSessions(config);
  if (sessions.length === 0) {
    return newCtx(opts, cwd, config);
  }
  const choice: PickerResult = await pickSession(term, { cwd, sessions });
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
    role: opts.role ?? "controller",
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
    role: opts.role ?? "controller",
  };
}

async function openWs(config: HydraConfig): Promise<WebSocket> {
  const protocol = config.daemon.tls ? "wss" : "ws";
  const url = `${protocol}://${config.daemon.host}:${config.daemon.port}/acp`;
  const ws = new WebSocket(url, [
    "acp.v1",
    `hydra-acp-token.${config.daemon.authToken}`,
  ]);
  await once(ws, "open");
  return ws;
}
