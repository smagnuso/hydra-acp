// The session/update payloads of a history, one per entry (undefined for
// entries that are not session/update), for locating turns.
export type TurnUpdates = ReadonlyArray<{ messageId?: unknown; sessionUpdate?: unknown } | undefined>;

// Index of the last entry of the turn holding `messageId` (the last entry
// carrying it), or -1 when none does. Any id recorded in the turn names
// it: its prompt's, an agent message's, or the turn_complete's own. The
// turn ends at its turn_complete (or _hydra_turn_ended, for one the agent
// started), or just before the next turn starts, so a cut there keeps the
// whole turn: the prompt with its answer.
export function turnEndIndex(updates: TurnUpdates, messageId: string): number {
  let target = -1;
  for (let i = updates.length - 1; i >= 0; i--) {
    if (updates[i]?.messageId === messageId) {
      target = i;
      break;
    }
  }
  if (target < 0) {
    return -1;
  }
  for (let i = target; i < updates.length; i++) {
    const kind = updates[i]?.sessionUpdate;
    if (kind === "turn_complete" || kind === "_hydra_turn_ended") {
      return i;
    }
    if (i > target && (kind === "prompt_received" || kind === "_hydra_turn_started")) {
      return i - 1;
    }
  }
  return updates.length - 1;
}

export function updatesOf(entries: ReadonlyArray<{ method: string; params?: unknown }>): TurnUpdates {
  return entries.map((entry) =>
    entry.method === "session/update"
      ? (entry.params as { update?: { messageId?: unknown; sessionUpdate?: unknown } } | undefined)?.update
      : undefined,
  );
}
