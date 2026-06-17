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
  if (
    typeof input.agentReportedUsed === "number" &&
    typeof input.agentReportedSize === "number" &&
    input.agentReportedSize > 0
  ) {
    utilization = input.agentReportedUsed / input.agentReportedSize;
  } else {
    const tokens = estimateTokens(input.unsummarizedChars);
    const contextWindow =
      input.currentModel !== undefined
        ? input.config.modelContextWindows[input.currentModel] ??
          input.config.absoluteFallback
        : input.config.absoluteFallback;
    utilization = tokens / contextWindow;
  }
  if (utilization >= input.config.hardCeilingFraction) {
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
