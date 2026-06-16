// Build a plain-text compaction seed that replaces earlier conversation
// with a structured synopsis header followed by the most recent N turns
// in verbatim form.  The output mirrors what downstream swap paths send
// as the first `session/prompt` payload on a fresh agent process.
//
// Sections whose fields are empty / absent are omitted entirely except
// [Title] which always renders (defaulting to "(untitled)").

import { type SessionSynopsis } from "./snapshot.js";

// Shared entry shape so callers that hold full HistoryEntry records can
// pass them without casts.
type HistoryEntryLike = {
  method?: unknown;
  params?: unknown;
  [key: string]: unknown;
};

interface SessionUpdate {
  sessionUpdate?: string;
  prompt?: unknown;
  content?: unknown;
  name?: unknown;
  title?: unknown;
  rawInput?: unknown;
}

export interface RenderCompactionSeedOptions {
  synopsis: SessionSynopsis;
  title?: string;
  tail: HistoryEntryLike[];
  tailK: number;
}

const UNTITLED = "(untitled)";

// Argument keys surfaced in tool lines (same as history-transcript).
const TOOL_ARG_KEYS = ["file_path", "path", "command", "pattern", "query"];

export function renderCompactionSeed(
  opts: RenderCompactionSeedOptions,
): string {
  const lines: string[] = [];

  // --- prior session compaction header ---
  lines.push("--- begin prior session compaction ---");

  lines.push(`[Title] ${opts.title ?? UNTITLED}`);

  if (opts.synopsis.goal !== undefined && opts.synopsis.goal.trim().length > 0) {
    lines.push(`[Goal] ${opts.synopsis.goal}`);
  }

  if (opts.synopsis.outcome !== undefined && opts.synopsis.outcome.trim().length > 0) {
    lines.push(`[Outcome] ${opts.synopsis.outcome}`);
  }

  const openThreads = renderSection("Open threads", opts.synopsis.open_threads);
  if (openThreads.length > 0) {
    lines.push(openThreads);
  }

  const decisions = renderSection("Decisions", opts.synopsis.decisions);
  if (decisions.length > 0) {
    lines.push(decisions);
  }

  const fileEditIntentions = renderSection(
    "File edit intentions",
    opts.synopsis.file_edit_intentions,
  );
  if (fileEditIntentions.length > 0) {
    lines.push(fileEditIntentions);
  }

  const unresolvedErrors = renderSection(
    "Unresolved errors",
    opts.synopsis.unresolved_errors,
  );
  if (unresolvedErrors.length > 0) {
    lines.push(unresolvedErrors);
  }

  const toolState = renderSection("Tool state", opts.synopsis.tool_state);
  if (toolState.length > 0) {
    lines.push(toolState);
  }

  const filesTouched = renderCommaList(opts.synopsis.files_touched);
  if (filesTouched.length > 0) {
    lines.push(`[Files previously touched] ${filesTouched}`);
  }

  const toolsUsed = renderCommaList(opts.synopsis.tools_used);
  if (toolsUsed.length > 0) {
    lines.push(`[Tools previously used] ${toolsUsed}`);
  }

  lines.push("--- end prior session compaction ---");

  // --- recent turns verbatim ---
  const tailText = renderTail(opts.tail, opts.tailK);
  lines.push("--- begin recent turns (verbatim, last " + opts.tailK + ") ---");
  if (tailText.length > 0) {
    lines.push(tailText);
  }
  lines.push("--- end recent turns ---");

  // closing note
  lines.push("");
  lines.push(
    "(Hydra has compacted earlier conversation. Detail is retrievable via the hydra-recall tools if you need to look up specifics. Acknowledge briefly and wait for the next user message.)",
  );

  return lines.join("\n");
}

// Render a section with bullet points, or an empty string when the field
// is absent / empty so callers can skip adding it.
function renderSection(
  label: string,
  items: unknown[] | undefined,
): string {
  if (!items || !Array.isArray(items)) {
    return "";
  }
  const bullets = items.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (bullets.length === 0) {
    return "";
  }
  const lines = bullets.map((b) => "- " + b.trim());
  return `[${label}] ${lines.join("\n")}`;
}

// Render a comma-separated list, or empty string when absent/unparseable.
function renderCommaList(items: unknown[] | undefined): string {
  if (!items || !Array.isArray(items)) {
    return "";
  }
  const valid = items.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (valid.length === 0) {
    return "";
  }
  return valid.map((v) => v.trim()).join(", ");
}

// Extract the last `tailK` user/agent turn pairs from the history and
// render them verbatim, reusing the same extraction logic as
// renderTranscript in history-transcript.ts.
function renderTail(history: HistoryEntryLike[], tailK: number): string {
  if (history.length === 0 || tailK <= 0) {
    return "";
  }

  const turns = extractTurns(history);
  if (turns.length === 0) {
    return "";
  }

  const kept = turns.slice(-tailK);
  const rendered: string[] = [];

  for (const turn of kept) {
    if (turn.user.length > 0) {
      rendered.push("User: " + turn.user);
    }
    if (turn.agent.length > 0) {
      rendered.push("Assistant: " + turn.agent);
    }
    if (turn.tools.length > 0) {
      for (const tool of turn.tools) {
        rendered.push(tool);
      }
    }
  }

  return rendered.join("\n");
}

// Extract user/agent turns from history entries using the same logic as
// renderTranscript.  Consecutive agent_message_chunk entries are merged
// into one assistant message per turn; tool_call entries are captured
// inline.  Incomplete turns at the start of the slice (agent without a
// preceding prompt) are dropped.
function extractTurns(history: HistoryEntryLike[]): Array<{
  user: string;
  agent: string;
  tools: string[];
}> {
  const turns: Array<{
    user: string;
    agent: string;
    tools: string[];
  }> = [];
  let currentTurn: { user: string; agent: string; tools: string[] } | null = null;

  for (const entry of history) {
    if (entry.method !== "session/update") {
      continue;
    }
    const params = entry.params as { update?: SessionUpdate } | undefined;
    const update = params?.update;
    if (!update || typeof update.sessionUpdate !== "string") {
      continue;
    }

    const kind = update.sessionUpdate;

    if (kind === "prompt_received") {
      // Close any incomplete prior turn.
      if (currentTurn !== null && currentTurn.user.length > 0) {
        turns.push(currentTurn);
      }
      currentTurn = {
        user: extractText(update.prompt).trim(),
        agent: "",
        tools: [],
      };
    } else if (kind === "agent_message_chunk" && currentTurn !== null) {
      const chunk = extractContentText(update.content);
      if (chunk.length > 0) {
        currentTurn.agent += chunk;
      }
    } else if (kind === "tool_call" && currentTurn !== null) {
      currentTurn.tools.push(renderToolCall(update));
    } else if (kind === "turn_complete") {
      // End of a turn — push it for later slicing.
      if (currentTurn !== null) {
        turns.push(currentTurn);
        currentTurn = null;
      }
    }
  }

  // Flush any remaining incomplete turn (no closing turn_complete).
  if (currentTurn !== null && currentTurn.user.length > 0) {
    turns.push(currentTurn);
  }

  return turns;
}

// --- helpers mirroring history-transcript.ts internals ---

function renderToolCall(update: SessionUpdate): string {
  const name = readToolName(update);
  const args = readToolArgs(update.rawInput);
  if (args.length === 0) {
    return "Tool: " + name;
  }
  return "Tool: " + name + "(" + args.join(", ") + ")";
}

function readToolName(update: SessionUpdate): string {
  if (typeof update.name === "string" && update.name.length > 0) {
    return update.name;
  }
  if (typeof update.title === "string" && update.title.length > 0) {
    return update.title;
  }
  return "(unnamed)";
}

function readToolArgs(rawInput: unknown): string[] {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return [];
  }
  const obj = rawInput as Record<string, unknown>;
  const out: string[] = [];
  for (const key of TOOL_ARG_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) {
      out.push(key + "=" + truncateInline(v, 200));
    }
  }
  return out;
}

function extractText(prompt: unknown): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  if (!Array.isArray(prompt)) {
    return "";
  }
  return prompt
    .map((b) => {
      if (b && typeof b === "object") {
        const text = (b as { text?: unknown }).text;
        if (typeof text === "string") {
          return text;
        }
      }
      return "";
    })
    .join("");
}

function extractContentText(content: unknown): string {
  if (!content || typeof content !== "object") {
    return "";
  }
  const text = (content as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function truncateInline(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return s.slice(0, max - 1) + "\u2026";
}
