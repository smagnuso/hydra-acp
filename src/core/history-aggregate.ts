// Deterministic extractions over history.jsonl. Used by:
//   - sessions-info.ts to render tool histograms and file lists.
//   - session.ts::runSnapshotRegen to prefill the synopsis's
//     files_touched and tools_used fields without asking the LLM
//     (faster output, no hallucination risk).
//
// All functions are pure over the history entry array — no I/O, no
// state. Callers load history once and pass it in.

// We accept the minimal "has a params field" shape rather than
// HistoryEntry directly. The bundle's HistoryEntrySchema infers params
// as optional (zod's z.unknown() permits undefined) while the runtime
// HistoryEntry has params required. Same field, different optionality
// — accepting both lets callers pass either without casts.
type HistoryEntryLike = {
  method?: unknown;
  params?: unknown;
  // Permit additional fields (recordedAt, messageId, etc.) so callers
  // that hold full HistoryEntry records can pass them without casts.
  [key: string]: unknown;
};

interface ToolCallUpdate {
  sessionUpdate?: string;
  name?: unknown;
  title?: unknown;
  rawInput?: unknown;
  locations?: unknown;
}

// Distinct tool names invoked across the session, sorted by descending
// call count then by name. claude-acp emits the human-readable name in
// `title`; the spec-shaped path uses `name`. We try both, mirroring
// render-update.ts:441's resolution order.
export interface ToolCount {
  name: string;
  count: number;
}

export function extractToolHistogram(history: HistoryEntryLike[]): ToolCount[] {
  const counts = new Map<string, number>();
  for (const update of iterToolCalls(history)) {
    const toolName = readToolName(update);
    counts.set(toolName, (counts.get(toolName) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]): ToolCount => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// Just the names, for the synopsis prefill.
export function extractToolsUsed(history: HistoryEntryLike[]): string[] {
  return extractToolHistogram(history).map((t) => t.name);
}

// One file with its per-tool breakdown. The breakdown is what
// sessions-info --verbose surfaces; the count is what the default view
// uses; the path alone is what the synopsis prefill uses.
export interface FileCount {
  path: string;
  count: number;
  byTool: ToolCount[];
}

export function extractFilesTouchedDetailed(
  history: HistoryEntryLike[],
): FileCount[] {
  // path → tool → count
  const fileTouches = new Map<string, Map<string, number>>();
  for (const update of iterToolCalls(history)) {
    const toolName = readToolName(update);
    for (const p of extractPaths(update.rawInput, update.locations)) {
      let byTool = fileTouches.get(p);
      if (byTool === undefined) {
        byTool = new Map();
        fileTouches.set(p, byTool);
      }
      byTool.set(toolName, (byTool.get(toolName) ?? 0) + 1);
    }
  }
  return [...fileTouches.entries()]
    .map(([path, byTool]): FileCount => {
      const perTool = [...byTool.entries()]
        .map(([name, count]): ToolCount => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      const total = perTool.reduce((s, t) => s + t.count, 0);
      return { path, count: total, byTool: perTool };
    })
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
}

// Just the unique file paths, for the synopsis prefill. Ordered by
// most-touched first so a synopsis that gets truncated still surfaces
// the most relevant files.
export function extractFilesTouched(history: HistoryEntryLike[]): string[] {
  return extractFilesTouchedDetailed(history).map((f) => f.path);
}

// Count of user prompts (prompt_received entries). Useful as a "turn
// count" approximation; doesn't account for slash-command prompts that
// short-circuit before reaching the agent.
export function countTurns(history: HistoryEntryLike[]): number {
  let n = 0;
  for (const entry of history) {
    const params = entry.params as
      | { update?: { sessionUpdate?: string } }
      | undefined;
    if (params?.update?.sessionUpdate === "prompt_received") {
      n += 1;
    }
  }
  return n;
}

// Walk history entries and yield each tool_call update payload. Skips
// non-update entries and entries whose sessionUpdate isn't tool_call.
// Excludes tool_call_update — those are status/output updates on an
// already-issued call, double-counting them would inflate every metric.
function* iterToolCalls(
  history: HistoryEntryLike[],
): IterableIterator<ToolCallUpdate> {
  for (const entry of history) {
    const params = entry.params as
      | { update?: ToolCallUpdate }
      | undefined;
    const update = params?.update;
    if (update?.sessionUpdate === "tool_call") {
      yield update;
    }
  }
}

function readToolName(update: ToolCallUpdate): string {
  // claude-acp emits the human-readable name in `title`; the spec-shaped
  // path uses `name`. Mirror render-update.ts:441's resolution order.
  if (typeof update.name === "string" && update.name.length > 0) {
    return update.name;
  }
  if (typeof update.title === "string" && update.title.length > 0) {
    return update.title;
  }
  return "(unnamed)";
}

// Extract file path candidates from a tool_call's rawInput plus its
// optional locations[] sidecar. Covers Edit/Read/Write/Glob (file_path
// or path), Edit/MultiEdit's `edits[]` array, plus any tool that emits
// a locations array of { path }. Tool-specific schemas vary, so this
// is a best-effort scan — we'd rather over-include a Bash command's
// `--file` arg than miss real edits. Bash commands themselves aren't
// decomposed; we just look for `file_path` / `path` keys.
function extractPaths(rawInput: unknown, locations: unknown): Set<string> {
  const out = new Set<string>();
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const obj = rawInput as Record<string, unknown>;
    if (typeof obj.file_path === "string") {
      out.add(obj.file_path);
    } else if (typeof obj.path === "string") {
      out.add(obj.path);
    }
    const edits = obj.edits;
    if (Array.isArray(edits)) {
      for (const e of edits) {
        if (e && typeof e === "object") {
          const fp = (e as { file_path?: unknown }).file_path;
          if (typeof fp === "string") {
            out.add(fp);
          }
        }
      }
    }
  }
  if (Array.isArray(locations)) {
    for (const loc of locations) {
      if (loc && typeof loc === "object") {
        const p = (loc as { path?: unknown }).path;
        if (typeof p === "string") {
          out.add(p);
        }
      }
    }
  }
  return out;
}
