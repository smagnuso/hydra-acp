// Render a hydra session Bundle as a human-readable markdown transcript.
// Pure (no I/O); both the CLI's `sessions transcript` command and the
// daemon's GET /v1/sessions/:id/transcript route call into this.

import type { Bundle } from "./bundle.js";
import { mapUpdate, type RenderEvent } from "./render-update.js";
import { stripHydraSessionPrefix } from "./session.js";

export function bundleToMarkdown(bundle: Bundle): string {
  const events = collectEvents(bundle);
  const toolFinalStates = collectToolFinalStates(events);
  const out: string[] = [];
  emitHeader(out, bundle);
  emitBody(out, events, toolFinalStates);
  // Single trailing newline.
  let text = out.join("\n");
  if (!text.endsWith("\n")) {
    text += "\n";
  }
  return text;
}

interface TimedEvent {
  event: RenderEvent;
  recordedAt: number;
}

function collectEvents(bundle: Bundle): TimedEvent[] {
  const out: TimedEvent[] = [];
  for (const entry of bundle.history) {
    if (entry.method !== "session/update") {
      continue;
    }
    const params = entry.params as { update?: unknown } | null | undefined;
    if (!params || typeof params !== "object") {
      continue;
    }
    const event = mapUpdate(params.update);
    if (event === null) {
      continue;
    }
    out.push({ event, recordedAt: entry.recordedAt });
  }
  return out;
}

interface ToolFinalState {
  title: string;
  status: string;
}

// First pass: collapse the tool_call / tool_call_update stream into one
// terminal-state record per toolCallId. Title and status both mutate
// over a call's lifetime; we want the last non-empty value for each.
function collectToolFinalStates(
  events: TimedEvent[],
): Map<string, ToolFinalState> {
  const out = new Map<string, ToolFinalState>();
  for (const { event } of events) {
    if (event.kind === "tool-call") {
      const existing = out.get(event.toolCallId);
      out.set(event.toolCallId, {
        title: event.title,
        status: event.status ?? existing?.status ?? "pending",
      });
      continue;
    }
    if (event.kind === "tool-call-update") {
      const existing = out.get(event.toolCallId) ?? {
        title: "tool call",
        status: "pending",
      };
      out.set(event.toolCallId, {
        title: event.title ?? existing.title,
        status: event.status ?? existing.status,
      });
    }
  }
  return out;
}

function emitHeader(out: string[], bundle: Bundle): void {
  const session = bundle.session;
  const shortId = stripHydraSessionPrefix(session.sessionId);
  const title = session.title?.trim() || `Hydra session ${shortId}`;
  out.push(`# ${escapeInline(title)}`);
  out.push("");

  const lines: string[] = [];
  lines.push(`- **Session:** \`${shortId}\` (lineage \`${session.lineageId}\`)`);
  const agentBits = [session.agentId];
  if (session.currentModel) {
    agentBits.push(`model: ${session.currentModel}`);
  }
  if (session.currentMode) {
    agentBits.push(`mode: ${session.currentMode}`);
  }
  lines.push(`- **Agent:** ${agentBits.filter(Boolean).join(" · ")}`);
  lines.push(`- **Cwd:** ${session.cwd}`);
  lines.push(
    `- **Exported:** ${bundle.exportedAt} from ${bundle.exportedFrom.machine}` +
      ` (hydra ${bundle.exportedFrom.hydraVersion})`,
  );
  const usage = session.currentUsage;
  if (usage && (usage.used !== undefined || usage.costAmount !== undefined)) {
    const usageBits: string[] = [];
    if (usage.used !== undefined) {
      const denom =
        usage.size !== undefined ? `${formatNumber(usage.size)}` : undefined;
      usageBits.push(
        denom
          ? `${formatNumber(usage.used)} / ${denom} tokens`
          : `${formatNumber(usage.used)} tokens`,
      );
    }
    if (usage.costAmount !== undefined) {
      const currency = usage.costCurrency ?? "USD";
      usageBits.push(`$${usage.costAmount.toFixed(2)} ${currency}`);
    }
    lines.push(`- **Usage:** ${usageBits.join(" · ")}`);
  }
  out.push(lines.join("\n"));
  out.push("");
}

function emitBody(
  out: string[],
  events: TimedEvent[],
  toolFinalStates: Map<string, ToolFinalState>,
): void {
  if (!events.some((e) => isVisible(e.event))) {
    out.push("_No conversation history recorded._");
    out.push("");
    return;
  }

  const seenToolIds = new Set<string>();
  let turn = 0;
  let agentBuffer = "";
  let inTurn = false;

  const flushAgent = (): void => {
    if (agentBuffer.length === 0) {
      return;
    }
    out.push(agentBuffer.trimEnd());
    out.push("");
    agentBuffer = "";
  };

  const startTurnIfNeeded = (): void => {
    if (inTurn) {
      return;
    }
    turn += 1;
    out.push("---");
    out.push("");
    out.push(`## Turn ${turn}`);
    out.push("");
    inTurn = true;
  };

  for (const { event } of events) {
    switch (event.kind) {
      case "user-text": {
        flushAgent();
        turn += 1;
        out.push("---");
        out.push("");
        out.push(`## Turn ${turn}`);
        out.push("");
        out.push("**User:**");
        out.push("");
        for (const line of event.text.split("\n")) {
          out.push(`> ${escapeInline(line)}`);
        }
        out.push("");
        out.push("**Assistant:**");
        out.push("");
        inTurn = true;
        break;
      }
      case "agent-text":
        startTurnIfNeeded();
        agentBuffer += event.text;
        break;
      case "agent-thought": {
        startTurnIfNeeded();
        flushAgent();
        const lines = event.text.split("\n");
        for (const line of lines) {
          out.push(`> _${escapeInline(line)}_`);
        }
        out.push("");
        break;
      }
      case "tool-call": {
        startTurnIfNeeded();
        flushAgent();
        if (seenToolIds.has(event.toolCallId)) {
          break;
        }
        seenToolIds.add(event.toolCallId);
        const final = toolFinalStates.get(event.toolCallId) ?? {
          title: event.title,
          status: event.status ?? "pending",
        };
        out.push(`- ${statusGlyph(final.status)} ${formatToolLine(final)}`);
        out.push("");
        break;
      }
      case "tool-call-update":
        // Final state was captured in pass 1 and emitted at the
        // tool-call line's first appearance. Updates are no-ops here.
        break;
      case "plan": {
        startTurnIfNeeded();
        flushAgent();
        out.push("**Plan:**");
        out.push("");
        for (const entry of event.entries) {
          const checked =
            entry.status === "completed" ? "[x]" : "[ ]";
          out.push(`- ${checked} ${escapeInline(entry.content)}`);
        }
        out.push("");
        break;
      }
      case "mode-changed":
        startTurnIfNeeded();
        flushAgent();
        out.push(`_mode: ${escapeInline(event.mode)}_`);
        out.push("");
        break;
      case "model-changed":
        startTurnIfNeeded();
        flushAgent();
        out.push(`_model: ${escapeInline(event.model)}_`);
        out.push("");
        break;
      case "turn-complete":
        flushAgent();
        break;
      case "usage-update":
      case "available-commands":
      case "session-info":
      case "unknown":
        // Snapshot/meta events — not part of the readable transcript.
        break;
    }
  }
  flushAgent();
}

function isVisible(event: RenderEvent): boolean {
  switch (event.kind) {
    case "usage-update":
    case "available-commands":
    case "session-info":
    case "unknown":
    case "turn-complete":
      return false;
    default:
      return true;
  }
}

function formatToolLine(state: ToolFinalState): string {
  const status = state.status;
  const suffix =
    status === "completed" || status === undefined
      ? ""
      : ` _(${status})_`;
  return `${escapeInline(state.title)}${suffix}`;
}

function statusGlyph(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "cancelled":
    case "rejected":
      return "⊘";
    case "in_progress":
      return "↻";
    default:
      return "·";
  }
}

// Escape the inline characters that would break a markdown line: backticks,
// stray HTML, and runaway whitespace. Body text from agents is already
// markdown so we DON'T touch ** / _ / # — those are intentional. This is
// only used on fields that aren't supposed to be markdown (titles, mode
// names, user prompts in blockquotes) where we want a literal rendering.
function escapeInline(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}
