// Render a session's history.jsonl as a single text block suitable for
// feeding to an ephemeral synopsis agent. The ephemeral agent has zero
// prior context, so the transcript must carry every load-bearing fact
// while staying small enough to fit the agent's window cheaply.
//
// Render rules:
//   - prompt_received → "User: <verbatim text>"
//   - agent_message_chunk → buffered and emitted as one "Assistant: ..."
//     block per turn (consecutive chunks merge; turn_complete or a
//     prompt_received closes the block).
//   - tool_call → "Tool: <name>(<key>=<value>, ...)" with a small set of
//     well-known argument keys (file_path, path, command, pattern, query).
//     Args dropped entirely if none match — full rawInput tends to be
//     noisy and adds bytes without informing a synopsis.
//   - everything else (thought_chunk, plan_update, tool_call_update,
//     user_message_chunk compat shim, mode/model updates, etc.) is
//     dropped.
//
// Truncation: if the rendered text exceeds maxChars, drop lines from the
// HEAD until it fits and prepend "[older history truncated]\n". Recent
// activity carries more synopsis signal than ancient activity.

type HistoryEntryLike = {
  method?: unknown;
  params?: unknown;
  // Permit additional fields (recordedAt, messageId, etc.) so callers
  // that hold full HistoryEntry records can pass them without casts.
  [key: string]: unknown;
};

export interface SessionUpdate {
  sessionUpdate?: string;
  prompt?: unknown;
  content?: unknown;
  name?: unknown;
  title?: unknown;
  rawInput?: unknown;
}

export interface RenderTranscriptOptions {
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 400_000;
const TRUNCATION_MARKER = "[older history truncated]\n";

// Argument keys we surface in tool lines, in display order. Anything not
// in this list is omitted to keep tool lines compact.
// Shared with compaction-seed.ts.
export const TOOL_ARG_KEYS = ["file_path", "path", "command", "pattern", "query"];

export function renderTranscript(
  history: HistoryEntryLike[],
  options: RenderTranscriptOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const lines: string[] = [];
  let assistantBuf = "";

  const flushAssistant = (): void => {
    if (assistantBuf.length === 0) {
      return;
    }
    lines.push(`Assistant: ${assistantBuf}`);
    assistantBuf = "";
  };

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
      flushAssistant();
      const text = extractText(update.prompt).trim();
      if (text.length > 0) {
        lines.push(`User: ${text}`);
      }
    } else if (kind === "agent_message_chunk") {
      const chunk = extractContentText(update.content);
      if (chunk.length > 0) {
        assistantBuf += chunk;
      }
    } else if (kind === "tool_call") {
      flushAssistant();
      lines.push(renderToolCall(update));
    } else if (kind === "turn_complete") {
      flushAssistant();
    }
  }
  flushAssistant();

  return truncateHead(lines.join("\n"), maxChars);
}

// Shared with compaction-seed.ts.
export function renderToolCall(update: SessionUpdate): string {
  const name = readToolName(update);
  const args = readToolArgs(update.rawInput);
  if (args.length === 0) {
    return `Tool: ${name}`;
  }
  return `Tool: ${name}(${args.join(", ")})`;
}

// Shared with compaction-seed.ts.
export function readToolName(update: SessionUpdate): string {
  if (typeof update.name === "string" && update.name.length > 0) {
    return update.name;
  }
  if (typeof update.title === "string" && update.title.length > 0) {
    return update.title;
  }
  return "(unnamed)";
}

// Shared with compaction-seed.ts.
export function readToolArgs(rawInput: unknown): string[] {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return [];
  }
  const obj = rawInput as Record<string, unknown>;
  const out: string[] = [];
  for (const key of TOOL_ARG_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) {
      out.push(`${key}=${truncateInline(v, 200)}`);
    }
  }
  return out;
}

// Shared with compaction-seed.ts.
export function extractText(prompt: unknown): string {
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

// Shared with compaction-seed.ts.
export function extractContentText(content: unknown): string {
  if (!content || typeof content !== "object") {
    return "";
  }
  const text = (content as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

// Shared with compaction-seed.ts.
export function truncateInline(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return s.slice(0, max - 1) + "…";
}

// Drop whole lines from the head until the total fits under maxChars.
// Prepend the truncation marker when anything was dropped.
function truncateHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const lines = text.split("\n");
  while (lines.length > 0) {
    const candidate = TRUNCATION_MARKER + lines.join("\n");
    if (candidate.length <= maxChars) {
      return candidate;
    }
    lines.shift();
  }
  return TRUNCATION_MARKER;
}
