import type { HistoryEntry } from "../../core/history-store.js";

export function* iterSessionUpdates(
  history: ReadonlyArray<unknown>,
): Iterable<{
  entryId: number;
  entry: HistoryEntry;
  kind: string;
  update: Record<string, unknown>;
}> {
  for (let i = 0; i < history.length; i++) {
    const raw = history[i];
    if (!raw) {
      continue;
    }
    const entry = raw as HistoryEntry;
    if (entry.method !== "session/update") {
      continue;
    }
    const params = entry.params as { update?: Record<string, unknown> } | undefined;
    const update = params?.update;
    if (!update || typeof update.sessionUpdate !== "string") {
      continue;
    }
    yield {
      entryId: i,
      entry,
      kind: update.sessionUpdate,
      update,
    };
  }
}

// Classify a single HistoryEntry as a session/update of a known kind.
// Returns null for entries that aren't session/update or don't carry a
// well-formed update body. Used by callers that already have entries
// paired with a stable entryId (e.g. the streaming recall iterator)
// and don't need iterSessionUpdates' array-index numbering.
export function classifyUpdate(
  entry: HistoryEntry,
): { kind: string; update: Record<string, unknown> } | null {
  if (entry.method !== "session/update") {
    return null;
  }
  const params = entry.params as { update?: Record<string, unknown> } | undefined;
  const update = params?.update;
  if (!update || typeof update.sessionUpdate !== "string") {
    return null;
  }
  return { kind: update.sessionUpdate, update };
}

export function mcpJsonResult<T>(payload: T): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: T;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
