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
  const tokens = estimateTokens(input.unsummarizedChars);
  const contextWindow = input.currentModel !== undefined
    ? input.config.modelContextWindows[input.currentModel] ?? input.config.absoluteFallback
    : input.config.absoluteFallback;
  const utilization = tokens / contextWindow;
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
