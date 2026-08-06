// Server-side decision: should the TUI prompt the user to compact this
// session on attach? Composed from context utilization (fraction of the
// model's known window) and idle time (proxy for cache TTL expiry).
//
// Two-signal rule:
//   soft  = utilization >= contextFraction AND idleMs >= idleBeforePromptMs
//   hard  = utilization >= hardCeilingFraction (idle is ignored)
// Returns true when either fires.

export interface CompactionHeuristicConfig {
  contextFraction: number;
  hardCeilingFraction: number;
  absoluteFallback: number;
  idleBeforePromptMs: number;
  modelContextWindows: Record<string, number>;
}

export interface CompactionHeuristicInput {
  summarizedThroughEntry: number;
  totalEntries: number;
  unsummarizedChars: number;
  compactionInFlight: boolean;
  currentModel: string | undefined;
  lastActivityMs: number;
  nowMs: number;
  config: CompactionHeuristicConfig;
  // Authoritative usage reported by the agent via usage_update. When
  // present, both fields are used directly (utilization = used/size)
  // and the char-estimate path is bypassed entirely. The status bar
  // displays these same numbers, so this keeps the heuristic and the
  // user's visible utilization in sync.
  agentReportedUsed?: number;
  agentReportedSize?: number;
}

export function estimateTokens(chars: number): number {
  return Math.floor(chars / 4);
}

// Approximate the context-consuming character count of a history slice.
//
// The naive version of this — sum `JSON.stringify(entry.params).length` —
// overcounted badly enough to make the fallback path useless, in two ways:
//
//   1. Streaming envelope. Agents deltas-stream text, and a chunk carrying
//      30 bytes of prose costs ~245 bytes of JSON (sessionUpdate, toolCallId,
//      messageId, …). Cursor is the extreme case: one observed session had
//      6744 thought chunks, i.e. ~1.6 MB of envelope around ~200 KB of text.
//   2. Tool-call snapshots. `tool_call_update` re-sends the WHOLE content /
//      rawOutput payload on every status ping, so a single 60 KB file read
//      that pings four times was counted four times. Latest-replaces on the
//      wire must be latest-replaces here too, hence the per-toolCallId max.
//
// Measured against an agent's own `usage_update` on a real session: the JSON
// sum said 280k tokens where the agent reported 137k; this estimator lands
// close enough to be useful for the prompt decision. It is still only an
// estimate — `shouldCompactSession` treats it as strictly weaker evidence
// than agent-reported usage.
export function estimateContextChars(
  entries: ReadonlyArray<{ params?: unknown }>,
): number {
  let total = 0;
  // Per tool call, the largest payload seen across its updates.
  const perTool = new Map<string, number>();
  for (const entry of entries) {
    const params = entry.params;
    if (!params || typeof params !== "object") {
      continue;
    }
    const update = (params as { update?: unknown }).update;
    if (!update || typeof update !== "object") {
      continue;
    }
    const u = update as Record<string, unknown>;
    switch (u.sessionUpdate) {
      case "user_message_chunk":
      case "agent_message_chunk":
      // Thoughts count: they're generated tokens that occupy the window for
      // the turn that produced them. Some agents drop them from later turns,
      // which makes this an overcount — preferred over an undercount, since
      // the whole point of the heuristic is to warn before a wall.
      case "agent_thought_chunk":
        total += contentChars(u.content);
        break;
      case "tool_call":
      case "tool_call_update": {
        const id = typeof u.toolCallId === "string" ? u.toolCallId : "";
        const chars = toolCallChars(u);
        const prior = perTool.get(id) ?? 0;
        if (chars > prior) {
          perTool.set(id, chars);
        }
        break;
      }
      default:
        // Everything else (status pings, turn_complete, usage_update, mode /
        // model changes, prompt bookkeeping) is protocol, not context.
        break;
    }
  }
  for (const chars of perTool.values()) {
    total += chars;
  }
  return total;
}

// Chars a tool call contributes: its title plus its input and output
// payloads. rawInput is what the model emitted; content / rawOutput is what
// came back and got fed forward.
function toolCallChars(u: Record<string, unknown>): number {
  let chars = 0;
  if (typeof u.title === "string") {
    chars += u.title.length;
  }
  chars += payloadChars(u.rawInput);
  // content[] is structured (text / diff / blob-ref blocks), so it gets the
  // text-aware walk — payloadChars would also count the `type` discriminators.
  chars += contentChars(u.content);
  chars += payloadChars(u.rawOutput);
  return chars;
}

// Size of an arbitrary payload, counting a `{__hydraBlob, bytes}` reference
// as the content it stands for. History loaded in "references" mode swaps
// large strings for these, and a ref stringifies to ~100 chars regardless of
// whether it points at 2 KB or 2 MB — counting the ref itself would make the
// estimate depend on how the caller loaded the history.
function payloadChars(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value === "string") {
    return value.length;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).length;
  }
  if (Array.isArray(value)) {
    let sum = 0;
    for (const item of value) {
      sum += payloadChars(item);
    }
    return sum;
  }
  if (typeof value === "object") {
    const bytes = (value as { __hydraBlob?: unknown; bytes?: unknown }).bytes;
    if (
      typeof (value as { __hydraBlob?: unknown }).__hydraBlob === "string" &&
      typeof bytes === "number"
    ) {
      return bytes;
    }
    let sum = 0;
    for (const v of Object.values(value as Record<string, unknown>)) {
      sum += payloadChars(v);
    }
    return sum;
  }
  return 0;
}

// Text length of a ContentBlock, a ToolCallContent wrapper, or an array of
// either. Only text counts — an image block's base64 is not context the way
// prose is, and its token cost isn't a function of its length.
function contentChars(content: unknown): number {
  if (content === undefined || content === null) {
    return 0;
  }
  if (typeof content === "string") {
    return content.length;
  }
  if (Array.isArray(content)) {
    let sum = 0;
    for (const item of content) {
      sum += contentChars(item);
    }
    return sum;
  }
  if (typeof content !== "object") {
    return 0;
  }
  const c = content as Record<string, unknown>;
  if (
    typeof (c as { __hydraBlob?: unknown }).__hydraBlob === "string" &&
    typeof c.bytes === "number"
  ) {
    return c.bytes;
  }
  if (c.text !== undefined) {
    return contentChars(c.text);
  }
  // Edit diffs: both sides of the file text are what the model saw. Written
  // out rather than recursing over every value so the `type` / `path` keys
  // don't get counted as prose.
  if (c.type === "diff") {
    return contentChars(c.oldText) + contentChars(c.newText);
  }
  // ACP wrapper: { type: "content", content: { type: "text", text } }
  if (c.content !== undefined) {
    return contentChars(c.content);
  }
  return 0;
}

export function shouldCompactSession(input: CompactionHeuristicInput): boolean {
  if (input.compactionInFlight) {
    return false;
  }
  if (input.totalEntries === 0) {
    return false;
  }
  // Prefer the agent's authoritative usage_update numbers. The
  // char-estimate / modelContextWindows lookup is a fallback for
  // sessions that haven't been attached to a live agent yet (cold REST
  // queries, replayed history before the first usage_update fires).
  let utilization: number;
  let authoritative: boolean;
  if (
    typeof input.agentReportedUsed === "number" &&
    typeof input.agentReportedSize === "number" &&
    input.agentReportedSize > 0
  ) {
    utilization = input.agentReportedUsed / input.agentReportedSize;
    authoritative = true;
  } else {
    const tokens = estimateTokens(input.unsummarizedChars);
    const contextWindow =
      input.currentModel !== undefined
        ? input.config.modelContextWindows[input.currentModel] ??
          input.config.absoluteFallback
        : input.config.absoluteFallback;
    utilization = tokens / contextWindow;
    authoritative = false;
  }
  // The hard ceiling exists to bypass the idle gate when we KNOW the window
  // is nearly full. An estimate against a possibly-wrong context window is
  // not that: agents that send no usage_update (Cursor) were tripping it on
  // every attach, which trained the prompt to be ignored. Estimated
  // utilization must clear the soft rule — including the idle signal —
  // like any other weak evidence.
  if (authoritative && utilization >= input.config.hardCeilingFraction) {
    return true;
  }
  const idleMs = input.nowMs - input.lastActivityMs;
  return utilization >= input.config.contextFraction && idleMs >= input.config.idleBeforePromptMs;
}

// Format a human-readable approximate token count (e.g. "85K").
export function formatApproxTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  return `${tokens}`;
}
