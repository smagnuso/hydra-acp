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
import { loadConfig, type HydraConfig } from "../core/config.js";
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
import { mapUpdate, type RenderEvent } from "./render-update.js";
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
  const config = await loadConfig();
  await ensureDaemonReachable(config);

  const term = termkit.terminal;
  const ctx = await resolveSession(term, config, opts);
  if (!ctx) {
    return;
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
  });

  conn.onRequest("session/request_permission", async (params) => {
    appendRender({
      kind: "unknown",
      sessionUpdate: "permission_request",
      raw: params,
    });
    // Auto-deny for v1 so the agent doesn't hang. Interactive approval is a
    // follow-up.
    return { outcome: { kind: "cancelled", reason: "tui-v1-no-permission-ui" } };
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
      clientInfo: { name: "acp-hydra-tui", version: "0.1.0" },
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
      clientInfo: { name: "acp-hydra-tui", version: "0.1.0" },
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
        const effects = dispatcher.feed(ev);
        for (const effect of effects) {
          handleEffect(effect);
        }
      }
      screen.refreshPrompt();
    },
  });

  const headerName = resolvedAgentId || agentInfoName || "?";
  screen.start();
  screen.setHeader({
    agent: headerName,
    cwd: resolvedCwd,
    sessionId: resolvedSessionId,
  });

  const stop = (code = 0): never => {
    screen.stop();
    saveHistory(historyFile, history).catch(() => undefined);
    try {
      ws.close();
    } catch {
      void 0;
    }
    process.exit(code);
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
    history = appendEntry(history, text);
    dispatcher.setHistory(history);
    saveHistory(historyFile, history).catch(() => undefined);
    promptQueue.push({ text, planMode });
    refreshQueueDisplay();
    if (!workerActive) {
      void runQueueWorker();
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

  process.on("SIGINT", () => {
    if (turnInFlight) {
      turnInFlight.cancel();
      return;
    }
    stop(0);
  });
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
  // Smart default: live picker if any live in cwd, else straight to new.
  // Pull cold sessions too so the picker shows everything `acp-hydra sessions`
  // would list.
  const sessions = await listSessions(config, { cwd, all: true });
  const live = sessions.filter((s) => s.cwd === cwd && s.status === "live");
  if (live.length === 0) {
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
    `acp-hydra-token.${config.daemon.authToken}`,
  ]);
  await once(ws, "open");
  return ws;
}
