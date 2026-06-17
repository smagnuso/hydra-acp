// Helpers for the attach-time compaction prompt. Isolated here so unit
// tests can exercise the threshold logic without standing up a full TUI.

export const COMPACTION_PROMPT_TOKEN_THRESHOLD = 60_000;

export interface CompactionPromptCandidate {
  // Number of history entries that are already summarized.
  summarizedThroughEntry: number;
  // Total history entries in the session.
  totalEntries: number;
  // Total character count of entries AFTER summarizedThroughEntry.
  unsummarizedChars: number;
  // Current compactionState from the daemon, or null if none.
  compactionState: unknown | null;
}

// Rough token estimate: 4 chars ≈ 1 token (industry-standard heuristic).
export function estimateTokens(chars: number): number {
  return Math.floor(chars / 4);
}

// Returns true when the unsummarized tail of a session is large enough
// to warrant prompting the user, and no compaction is already in flight.
export function shouldShowCompactionPrompt(
  candidate: CompactionPromptCandidate,
): boolean {
  if (candidate.compactionState != null) {
    return false;
  }
  if (candidate.totalEntries === 0) {
    return false;
  }
  const tokens = estimateTokens(candidate.unsummarizedChars);
  return tokens >= COMPACTION_PROMPT_TOKEN_THRESHOLD;
}

// Format a human-readable approximate token count (e.g. "85K").
export function formatApproxTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  return `${tokens}`;
}
