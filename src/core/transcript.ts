// Render a hydra session Bundle as a human-readable markdown transcript.
// Pure (no I/O); both the CLI's `sessions transcript` command and the
// daemon's GET /v1/sessions/:id/transcript route call into this.

import type { Bundle } from "./bundle.js";
import { mapUpdate, type RenderEvent } from "./render-update.js";
import { stripHydraSessionPrefix } from "./session.js";

export interface TranscriptOptions {
  // Include tool-call activity as a bulleted "- ✓ Read foo.ts" list per
  // turn. Default false — most transcripts read cleaner as pure
  // prose, matching the TUI's collapsed-tools default. Set true to
  // restore the bulleted tool list.
  includeTools?: boolean;
}

export function bundleToMarkdown(
  bundle: Bundle,
  options: TranscriptOptions = {},
): string {
  const events = collectEvents(bundle);
  const toolFinalStates = collectToolFinalStates(events);
  const out: string[] = [];
  emitHeader(out, bundle);
  emitBody(out, events, toolFinalStates, options.includeTools ?? false);
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
    const event = mapUpdate(params.update, { cwd: bundle.session.cwd });
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
  includeTools: boolean,
): void {
  if (!events.some((e) => isVisible(e.event))) {
    out.push("_No conversation history recorded._");
    out.push("");
    return;
  }

  let turn = 0;
  let agentBuffer = "";
  // Thought fragments stream as many small chunks; buffer and emit as
  // one blockquote so a single sentence doesn't render as a stack of
  // one-word > _..._ lines with blanks between them.
  let thoughtBuffer = "";
  // Consecutive tool-call lines coalesce into one tight list so a run
  // of N calls doesn't render as N paragraphs with blank lines in
  // viewers that treat blank-line-separated bullets as loose lists.
  let pendingToolLines: string[] = [];
  const seenToolIds = new Set<string>();
  let inTurn = false;

  const flushToolLines = (): void => {
    if (pendingToolLines.length === 0) {
      return;
    }
    for (const line of pendingToolLines) {
      out.push(line);
    }
    out.push("");
    pendingToolLines = [];
  };

  const flushAgent = (): void => {
    flushToolLines();
    if (thoughtBuffer.length > 0) {
      // Thoughts render in italic (`*...*`) so viewers style them
      // distinctly from plain agent prose and from bold user prompts —
      // three-way visual separation with no prefix glyphs.
      emitStyledParagraphs(out, thoughtBuffer.trimEnd(), "*");
      out.push("");
      thoughtBuffer = "";
    }
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
    // Cold-start (agent output before any user prompt in the bundle):
    // no separator needed, just mark that we're in a turn.
    inTurn = true;
  };

  for (const { event } of events) {
    switch (event.kind) {
      case "user-text": {
        flushAgent();
        // Between turns: a single `---` rule with the required
        // surrounding blank lines. The blockquoted user text plus plain
        // agent prose supplies enough visual contrast that per-turn
        // headings and speaker labels are just noise.
        out.push("---");
        out.push("");
        turn += 1;
        // User prompt is wrapped in `**...**` (bold) so the whole block
        // picks up a distinct face in markdown viewers — no `>` or
        // other prefix glyph needed. Each paragraph gets its own
        // wrapping since bold in CommonMark doesn't span blank lines.
        emitStyledParagraphs(out, event.text, "**");
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
        // Flush any buffered agent-text prose first so thought output
        // appears after the text that preceded it, then coalesce this
        // chunk with any already-buffered thought fragments.
        if (agentBuffer.length > 0) {
          out.push(agentBuffer.trimEnd());
          out.push("");
          agentBuffer = "";
        }
        thoughtBuffer += event.text;
        break;
      }
      case "tool-call": {
        if (!includeTools) {
          break;
        }
        startTurnIfNeeded();
        // Flush any buffered prose / thought before starting a tool
        // list, but keep multiple consecutive tool-calls tight.
        if (agentBuffer.length > 0 || thoughtBuffer.length > 0) {
          flushAgent();
        }
        if (seenToolIds.has(event.toolCallId)) {
          break;
        }
        seenToolIds.add(event.toolCallId);
        const final = toolFinalStates.get(event.toolCallId) ?? {
          title: event.title,
          status: event.status ?? "pending",
        };
        pendingToolLines.push(
          `- ${statusGlyph(final.status)} ${formatToolLine(final)}`,
        );
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
// Wrap each paragraph of `text` in `marker` (e.g. "**" bold, "*"
// italic). CommonMark emphasis doesn't span blank lines, so we split
// on paragraph breaks and wrap independently. Internal soft line
// breaks inside a paragraph stay put — the emphasis still spans them.
function emitStyledParagraphs(
  out: string[],
  text: string,
  marker: string,
): void {
  const paragraphs = text.split(/\n\s*\n/);
  for (let p = 0; p < paragraphs.length; p++) {
    const para = paragraphs[p]!;
    if (para.trim().length === 0) {
      continue;
    }
    const lines = para.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      const escaped = escapeInline(raw);
      out.push(
        i === 0 && i === lines.length - 1
          ? `${marker}${escaped}${marker}`
          : i === 0
            ? `${marker}${escaped}`
            : i === lines.length - 1
              ? `${escaped}${marker}`
              : escaped,
      );
    }
    if (p < paragraphs.length - 1) {
      out.push("");
    }
  }
}

function escapeInline(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}
