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
//    come from the last update by virtue of it being the emitted one —
//    EXCEPT the two that identify what the call acted on, `rawInput` and
//    `locations`, which agents send on an intermediate update and omit from
//    the terminal one. Those are carried forward explicitly; see
//    CARRIED_FIELDS.
//  - plan: each plan event is a full snapshot, so only the last plan
//    within a turn (between prompt_received and turn_complete) is kept.
//  - everything else: passed through unchanged.
export function coalesceReplay(entries: HistoryEntry[]): HistoryEntry[] {
  if (entries.length === 0) {
    return entries;
  }

  const lastToolUpdateIndex = new Map<string, number>();
  const mergedToolContent = new Map<string, unknown[]>();
  // Per toolCallId, the last non-empty value seen for each carried field.
  const carried = new Map<string, Map<string, unknown>>();
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
    for (const field of CARRIED_FIELDS) {
      if (!isNonEmpty(upd[field])) {
        continue;
      }
      const forId = carried.get(id);
      if (forId === undefined) {
        carried.set(id, new Map([[field, upd[field]]]));
      } else {
        forId.set(field, upd[field]);
      }
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
      // Restore the identity of what the call acted on. Only when the
      // terminal update didn't supply it itself: an agent that re-sends the
      // field is authoritative over anything we remembered.
      const forId = id === undefined ? undefined : carried.get(id);
      if (forId !== undefined) {
        for (const [field, value] of forId) {
          if (!isNonEmpty(readUpdate(emitted)?.[field])) {
            emitted = withUpdateField(emitted, field, value);
          }
        }
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

// Fields on a tool_call_update that name WHAT the call acted on, rather than
// describing its progress. Agents populate these on an intermediate update
// and omit them from the terminal one (the initial `tool_call` usually
// carries an empty placeholder), so dropping intermediates loses them
// outright — the coalescer has to carry them across.
//
// `locations[]` in particular is the only path source for a write-style call:
// no diff, and `rawInput` is a tool-specific blob that consumers are right
// not to guess at. Losing it made the TUI's edited-files gadget list a
// single file for a session that had written several, because only the tool
// call still in flight at attach time had its path delivered live.
const CARRIED_FIELDS = ["rawInput", "locations"] as const;

// Non-empty in the sense the carry cares about: a value worth remembering.
// `{}` and `[]` are what agents send as placeholders on the initial call, so
// they must not displace a real value seen later.
function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined || typeof value !== "object") {
    return false;
  }
  return Array.isArray(value)
    ? value.length > 0
    : Object.keys(value).length > 0;
}

function withUpdateField(
  entry: HistoryEntry,
  field: string,
  value: unknown,
): HistoryEntry {
  const params = (entry.params ?? {}) as Record<string, unknown>;
  const update = (params.update ?? {}) as Record<string, unknown>;
  return {
    ...entry,
    params: {
      ...params,
      update: { ...update, [field]: value },
    },
  };
}
