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
//     Args dropped entirely if none match: full rawInput tends to be
//     noisy and adds bytes without informing a synopsis. Args are read
//     from the call MERGED with its later tool_call_update events, not
//     from the opening event alone; see mergeToolCalls for why.
//   - "Output: <text>" under a tool line, ONLY when the caller passes
//     options.toolOutput. Off by default; see that option for why.
//   - everything else (thought_chunk, plan_update, tool_call_update,
//     user_message_chunk compat shim, mode/model updates, etc.) is
//     dropped. tool_call_update contributes args to the line its
//     tool_call emitted rather than a line of its own.
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
  rawOutput?: unknown;
  toolCallId?: unknown;
  kind?: unknown;
  _meta?: unknown;
}

/** A tool call reassembled from its opening event plus every update. */
export interface MergedToolCall {
  name: string;
  rawInput: Record<string, unknown>;
  /** ACP tool kind (execute / read / edit / think / other), when sent. */
  kind?: string;
  /** What the call printed, when the slice contains the event carrying it. */
  output?: string;
}

export interface RenderTranscriptOptions {
  maxChars?: number;
  /**
   * Emit an "Output:" line under each tool call carrying what it printed.
   *
   * Off by default, and the default is the point. The synopsis and
   * compaction-seed callers want a lean transcript, and output is stale
   * by the time a seeded agent reads it: a directory listing or a `git
   * status` from before a workspace move asserts things that are no
   * longer true, where a command replays harmlessly. Recall's `range` is
   * the opposite case, an explicit pull where the agent asked for the
   * detail and can weigh its age, so that caller opts in.
   */
  toolOutput?: { maxPerCall: number; maxTotal: number };
}

const DEFAULT_MAX_CHARS = 400_000;
const TRUNCATION_MARKER = "[older history truncated]\n";

// Argument keys we surface in tool lines, in display order. Anything not
// in this list is omitted to keep tool lines compact.
// Shared with compaction-seed.ts.
export const TOOL_ARG_KEYS = [
  "file_path",
  "filePath",
  "path",
  "command",
  "pattern",
  "query",
];

// Per-argument cap. Sized off real sessions: shell commands are the long
// values here and routinely run past 200 chars, where a cut lands
// mid-pipeline and leaves a command that cannot be read or replayed.
// Paths and patterns never approach this.
const TOOL_ARG_MAX_CHARS = 600;

export function renderTranscript(
  history: HistoryEntryLike[],
  options: RenderTranscriptOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const merged = mergeToolCalls(history);
  const lines: string[] = [];
  let assistantBuf = "";
  let outputBudget = options.toolOutput?.maxTotal ?? 0;

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
      lines.push(renderToolCall(update, merged));
      if (options.toolOutput !== undefined) {
        const id = readToolCallId(update);
        const output = id !== undefined ? merged.get(id)?.output : undefined;
        if (output !== undefined && outputBudget > 0) {
          const room = Math.min(options.toolOutput.maxPerCall, outputBudget);
          const kept =
            output.length <= room
              ? output
              : `${output.slice(0, room)}…[${output.length - room} more chars]`;
          lines.push(`Output: ${kept}`);
          outputBudget -= Math.min(kept.length, room);
        }
      }
    } else if (kind === "turn_complete") {
      flushAssistant();
    }
  }
  flushAssistant();

  return truncateHead(lines.join("\n"), maxChars);
}

// Reassemble every tool call in `history`, keyed by toolCallId.
//
// A call's arguments do not arrive with the call. Agents open with a
// `tool_call` whose `rawInput` is empty or partial and fill it in on
// later `tool_call_update` events. Observed shapes:
//
//   claude-acp        tool_call {} then update {command}
//   opencode (newer)  tool_call {cwd} then update {command, cwd}
//   opencode (older)  tool_call {command} complete on the opening event
//
// So rendering the opening event alone drops every command in a session
// for two of the three, and merging is a no-op for the third.
//
// The name must come from the OPENING event, never from an update.
// Agents rewrite `title` as a call progresses: claude-acp sends
// "Terminal" then the command text, opencode sends "bash" then the
// command text. Taking the latest title yields the command masquerading
// as a tool name. claude-acp also reports the real name out of band in
// `_meta.claudeCode.toolName` ("Bash" where the title says "Terminal"),
// which is preferred when present. Older opencode never sends a name at
// all, so it degrades to its opening title, which is the command; there
// is nothing better to recover.
//
// Calls with no toolCallId are absent from the map and callers fall back
// to the unmerged event.
export function mergeToolCalls(
  history: HistoryEntryLike[],
): Map<string, MergedToolCall> {
  const merged = new Map<string, MergedToolCall>();
  for (const entry of history) {
    if (entry.method !== "session/update") {
      continue;
    }
    const params = entry.params as { update?: SessionUpdate } | undefined;
    const update = params?.update;
    if (!update) {
      continue;
    }
    const kind = update.sessionUpdate;
    if (kind !== "tool_call" && kind !== "tool_call_update") {
      continue;
    }
    const id = readToolCallId(update);
    if (id === undefined) {
      continue;
    }
    let call = merged.get(id);
    if (call === undefined) {
      call = { name: "(unnamed)", rawInput: {} };
      merged.set(id, call);
    }
    if (call.name === "(unnamed)") {
      const resolved = resolveOpeningName(update, kind);
      if (resolved !== undefined) {
        call.name = resolved;
      }
    }
    if (call.kind === undefined && typeof update.kind === "string" && update.kind.length > 0) {
      call.kind = update.kind;
    }
    if (call.output === undefined) {
      const output = readToolOutputText(update);
      if (output !== undefined) {
        call.output = output;
      }
    }
    const rawInput = update.rawInput;
    if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
      // Oldest-first walk, so a later event's value is the more complete
      // one and should win.
      Object.assign(call.rawInput, rawInput as Record<string, unknown>);
    }
  }
  for (const call of merged.values()) {
    call.name = normalizeToolName(call);
  }
  return merged;
}

// Resolve a merged call's display name. Exported so the recall server
// applies the same rule as this renderer: the two keeping independent
// copies of the name logic is exactly what let them drift apart, with
// recall reporting command text where the transcript reported a name.
export function normalizeToolName(call: MergedToolCall): string {
  if (nameIsActuallyTheArgs(call)) {
    return call.kind ?? "(unnamed)";
  }
  return call.name;
}

// Older opencode sends no tool name at all: its opening title is already
// the command, so the naive read produces
// "Tool: <command>(command=<command>)" and pays for the command twice.
// When the name turns out to be one of the arguments, fall back to the
// ACP `kind`, which every agent does send.
function nameIsActuallyTheArgs(call: MergedToolCall): boolean {
  for (const key of TOOL_ARG_KEYS) {
    const value = call.rawInput[key];
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    if (value === call.name) {
      return true;
    }
    // A long title is usually a truncation of the value it came from.
    // The floor keeps a genuine short name ("bash", "grep") from
    // matching a command that merely starts with it.
    if (call.name.length >= 12 && value.startsWith(call.name)) {
      return true;
    }
  }
  return false;
}

function resolveOpeningName(
  update: SessionUpdate,
  kind: string,
): string | undefined {
  const metaName = readMetaToolName(update);
  if (metaName !== undefined) {
    return metaName;
  }
  if (typeof update.name === "string" && update.name.length > 0) {
    return update.name;
  }
  if (kind === "tool_call" && typeof update.title === "string" && update.title.length > 0) {
    return update.title;
  }
  return undefined;
}

export function readToolCallId(update: SessionUpdate): string | undefined {
  const id = update.toolCallId;
  if (typeof id === "string" && id.length > 0) {
    return id;
  }
  return undefined;
}

// What a tool call printed, normalized across agents. Blob references are
// already expanded by the history store's hydrateEntry, so anything
// spilled to the blob store arrives here as a plain string.
//
//   opencode    rawOutput { output: <text>, metadata }
//   claude-acp  rawOutput <text>, plus a structured
//               _meta.claudeCode.toolResponse { stdout, stderr, ... }
//
// claude's structured form is preferred where present because it keeps
// stderr distinguishable, which is usually the interesting half of a
// failure.
export function readToolOutputText(update: SessionUpdate): string | undefined {
  const response = readClaudeToolResponse(update);
  if (response !== undefined) {
    return response;
  }
  const raw = update.rawOutput;
  if (typeof raw === "string") {
    return raw.length > 0 ? raw : undefined;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const output = (raw as { output?: unknown }).output;
    if (typeof output === "string") {
      return output.length > 0 ? output : undefined;
    }
  }
  return undefined;
}

function readClaudeToolResponse(update: SessionUpdate): string | undefined {
  const meta = update._meta;
  if (!meta || typeof meta !== "object") {
    return undefined;
  }
  const claudeCode = (meta as { claudeCode?: unknown }).claudeCode;
  if (!claudeCode || typeof claudeCode !== "object") {
    return undefined;
  }
  const response = (claudeCode as { toolResponse?: unknown }).toolResponse;
  if (typeof response === "string") {
    return response.length > 0 ? response : undefined;
  }
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const { stdout, stderr } = response as { stdout?: unknown; stderr?: unknown };
  const parts: string[] = [];
  if (typeof stdout === "string" && stdout.length > 0) {
    parts.push(stdout);
  }
  if (typeof stderr === "string" && stderr.length > 0) {
    parts.push(`[stderr] ${stderr}`);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("\n");
}

/** claude-acp's out-of-band tool name, absent for every other agent. */
export function readMetaToolName(update: SessionUpdate): string | undefined {
  const meta = update._meta;
  if (!meta || typeof meta !== "object") {
    return undefined;
  }
  const claudeCode = (meta as { claudeCode?: unknown }).claudeCode;
  if (!claudeCode || typeof claudeCode !== "object") {
    return undefined;
  }
  const name = (claudeCode as { toolName?: unknown }).toolName;
  if (typeof name === "string" && name.length > 0) {
    return name;
  }
  return undefined;
}

// Shared with compaction-seed.ts. Pass `merged` from mergeToolCalls to
// render the call's full arguments; without it only the opening event's
// (usually empty) rawInput is available.
export function renderToolCall(
  update: SessionUpdate,
  merged?: Map<string, MergedToolCall>,
): string {
  const id = readToolCallId(update);
  const call = id !== undefined ? merged?.get(id) : undefined;
  const name = call?.name ?? readToolName(update);
  const args = readToolArgs(call?.rawInput ?? update.rawInput);
  if (args.length === 0) {
    return `Tool: ${name}`;
  }
  return `Tool: ${name}(${args.join(", ")})`;
}

// Shared with compaction-seed.ts.
export function readToolName(update: SessionUpdate): string {
  const metaName = readMetaToolName(update);
  if (metaName !== undefined) {
    return metaName;
  }
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
      out.push(`${key}=${truncateInline(v, TOOL_ARG_MAX_CHARS)}`);
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
