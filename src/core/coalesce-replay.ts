import type { HistoryEntry } from "./history-store.js";

// Reduce chatty chunk/update events from a replay buffer into the
// minimal set that produces identical end state on consuming clients.
// Live broadcast is untouched - this only runs at attach-replay time.
//
// Rules per session/update kind:
//  - agent_message_chunk / agent_thought_chunk / user_message_chunk:
//    consecutive chunks sharing the same messageId have their text
//    concatenated into the first occurrence; the rest are dropped.
//    A chunk separated from its run by an event of a different kind
//    (e.g. a tool_call) ends the run, matching how clients render.
//  - tool_call_update: per toolCallId, only the last update is emitted;
//    its content array is the concatenation of every dropped update's
//    content plus its own. Other fields (status, title, kind, ...)
//    come from the last update by virtue of it being the emitted one.
//  - plan: each plan event is a full snapshot, so only the last plan
//    within a turn (between prompt_received and turn_complete) is kept.
//  - everything else: passed through unchanged.
export function coalesceReplay(entries: HistoryEntry[]): HistoryEntry[] {
  if (entries.length === 0) {
    return entries;
  }

  const lastToolUpdateIndex = new Map<string, number>();
  const mergedToolContent = new Map<string, unknown[]>();
  // The command/file path rides on intermediate updates and is gone by the
  // terminal update we keep; carry the last non-empty rawInput forward so
  // the replayed tool row can still show what it acted on.
  const carriedRawInput = new Map<string, unknown>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) {
      continue;
    }
    const upd = readUpdate(entry);
    if (upd?.sessionUpdate !== "tool_call_update") {
      continue;
    }
    const id = typeof upd.toolCallId === "string" ? upd.toolCallId : undefined;
    if (id === undefined) {
      continue;
    }
    lastToolUpdateIndex.set(id, i);
    if (
      upd.rawInput &&
      typeof upd.rawInput === "object" &&
      !Array.isArray(upd.rawInput) &&
      Object.keys(upd.rawInput).length > 0
    ) {
      carriedRawInput.set(id, upd.rawInput);
    }
    if (Array.isArray(upd.content) && upd.content.length > 0) {
      const buf = mergedToolContent.get(id);
      if (buf) {
        buf.push(...(upd.content as unknown[]));
      } else {
        mergedToolContent.set(id, [...(upd.content as unknown[])]);
      }
    }
  }

  const out: HistoryEntry[] = [];
  // Tracks the index in `out` of the most recent chunk we'd merge a
  // follow-up chunk into. Each streamed chunk gets a fresh messageId,
  // so we can't key on that — but the daemon's broadcast order is the
  // wire order, and clients render any consecutive run of same-kind
  // chunks as one utterance. The run ends the moment any other kind
  // of event interrupts.
  let chunkRun: { outIndex: number; kind: string } | null = null;
  let planIndex: number | null = null;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) {
      continue;
    }
    const upd = readUpdate(entry);
    if (!upd || typeof upd.sessionUpdate !== "string") {
      out.push(entry);
      chunkRun = null;
      continue;
    }
    const kind = upd.sessionUpdate;

    if (
      kind === "agent_message_chunk" ||
      kind === "agent_thought_chunk" ||
      kind === "user_message_chunk"
    ) {
      if (chunkRun && chunkRun.kind === kind) {
        appendChunkText(out, chunkRun.outIndex, readChunkText(upd.content));
      } else {
        out.push(entry);
        chunkRun = { outIndex: out.length - 1, kind };
      }
      continue;
    }

    chunkRun = null;

    if (kind === "tool_call_update") {
      const id =
        typeof upd.toolCallId === "string" ? upd.toolCallId : undefined;
      if (id !== undefined && lastToolUpdateIndex.get(id) !== i) {
        continue;
      }
      let emitted =
        id !== undefined && mergedToolContent.has(id)
          ? withReplacedContent(entry, mergedToolContent.get(id) ?? [])
          : entry;
      // Restore the command/path detail dropped by the terminal update.
      if (id !== undefined && carriedRawInput.has(id) && !hasRawInput(emitted)) {
        emitted = withRawInput(emitted, carriedRawInput.get(id));
      }
      out.push(emitted);
      continue;
    }

    if (kind === "plan") {
      if (planIndex !== null) {
        out[planIndex] = entry;
      } else {
        out.push(entry);
        planIndex = out.length - 1;
      }
      continue;
    }

    if (kind === "prompt_received" || kind === "turn_complete") {
      planIndex = null;
    }

    out.push(entry);
  }

  return out;
}

function readUpdate(entry: HistoryEntry): Record<string, unknown> | undefined {
  if (entry.method !== "session/update") {
    return undefined;
  }
  const params = entry.params as Record<string, unknown> | undefined;
  const update = params?.update;
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    return undefined;
  }
  return update as Record<string, unknown>;
}

function readChunkText(content: unknown): string {
  if (!content || typeof content !== "object") {
    return "";
  }
  const c = content as Record<string, unknown>;
  return typeof c.text === "string" ? c.text : "";
}

function appendChunkText(
  out: HistoryEntry[],
  index: number,
  text: string,
): void {
  if (text.length === 0) {
    return;
  }
  const entry = out[index];
  if (entry === undefined) {
    return;
  }
  const params = (entry.params ?? {}) as Record<string, unknown>;
  const update = (params.update ?? {}) as Record<string, unknown>;
  const content = (update.content ?? {}) as Record<string, unknown>;
  const prev = typeof content.text === "string" ? content.text : "";
  out[index] = {
    ...entry,
    params: {
      ...params,
      update: {
        ...update,
        content: { ...content, text: prev + text },
      },
    },
  };
}

function withReplacedContent(
  entry: HistoryEntry,
  content: unknown[],
): HistoryEntry {
  const params = (entry.params ?? {}) as Record<string, unknown>;
  const update = (params.update ?? {}) as Record<string, unknown>;
  return {
    ...entry,
    params: {
      ...params,
      update: { ...update, content },
    },
  };
}

function hasRawInput(entry: HistoryEntry): boolean {
  const update = readUpdate(entry);
  const ri = update?.rawInput;
  return (
    !!ri &&
    typeof ri === "object" &&
    !Array.isArray(ri) &&
    Object.keys(ri).length > 0
  );
}

function withRawInput(entry: HistoryEntry, rawInput: unknown): HistoryEntry {
  const params = (entry.params ?? {}) as Record<string, unknown>;
  const update = (params.update ?? {}) as Record<string, unknown>;
  return {
    ...entry,
    params: {
      ...params,
      update: { ...update, rawInput },
    },
  };
}
