// Per-file edit aggregation over history.jsonl. Used by `hydra session
// diff <id>` to reconstruct a git-diff-shaped view of every file the
// session changed, purely from the recorded session/update notifications
// — no git, no filesystem read of the workspace.
//
// We collect every (oldText, newText) edit per file and emit them as a
// sequence of hunks. We do NOT attempt to collapse multiple Edit
// snippets into one whole-file before/after: oldText/newText for the
// Edit tool are partial snippets (the `old_string` / `new_string`
// params), so chaining them assumes a coherence the data doesn't have.
// One file with N edits → N hunks under a single file header. Writes
// (oldText="") still render as a single hunk that's all additions.
//
// Tool-call dedup: tool_call and tool_call_update for the same
// toolCallId carry the same EditDiff payload (the canonical ACP path
// emits the diff on the initial tool_call; claude-acp re-emits it on
// tool_call_update with the final result). We dedupe on toolCallId so
// the same edit isn't counted twice.
//
// Deletes are NOT represented: nothing on the wire marks a file as
// removed. A file the session deleted will simply not appear in the
// diff output.
import { extractEditDiff } from "./render-update.js";

type HistoryEntryLike = {
  method?: unknown;
  params?: unknown;
  [key: string]: unknown;
};

// A single hunk: one Edit/Write/MultiEdit-sub-edit. Snippet-scoped for
// Edit (old_string/new_string), whole-file-scoped for Write (oldText="").
export interface FileHunk {
  oldText: string;
  newText: string;
}

export interface FileEditAggregate {
  path: string;
  hunks: FileHunk[];
  // True when the first edit on this file had oldText==="" — i.e. the
  // session brought it into existence via Write (or an Edit replacing
  // an empty pre-state). Lets the renderer emit a `new file` header.
  created: boolean;
}

interface RawEdit {
  path: string;
  oldText: string;
  newText: string;
}

export function aggregateFileEdits(
  history: HistoryEntryLike[],
): FileEditAggregate[] {
  // Per toolCallId, the list of raw edits we've already counted, so a
  // tool_call_update that re-asserts the same payload doesn't double up.
  const seenByCall = new Map<string, RawEdit[]>();
  // Insertion order = first-touch order for the file.
  const byPath = new Map<string, { hunks: FileHunk[]; created: boolean }>();

  for (const entry of history) {
    const params = entry.params as
      | { update?: Record<string, unknown> }
      | undefined;
    const update = params?.update;
    if (!update || typeof update !== "object") {
      continue;
    }
    const kind = update.sessionUpdate;
    if (kind !== "tool_call" && kind !== "tool_call_update") {
      continue;
    }
    const toolCallId =
      typeof update.toolCallId === "string" && update.toolCallId.length > 0
        ? update.toolCallId
        : undefined;
    const edits = extractRawEdits(update);
    if (edits.length === 0) {
      continue;
    }
    let toApply = edits;
    if (toolCallId !== undefined) {
      const prior = seenByCall.get(toolCallId) ?? [];
      const remaining: RawEdit[] = [];
      for (const e of edits) {
        if (
          !prior.some(
            (p) =>
              p.path === e.path &&
              p.oldText === e.oldText &&
              p.newText === e.newText,
          )
        ) {
          remaining.push(e);
        }
      }
      if (remaining.length === 0) {
        continue;
      }
      seenByCall.set(toolCallId, [...prior, ...remaining]);
      toApply = remaining;
    }
    for (const e of toApply) {
      mergeEdit(byPath, e);
    }
  }

  const out: FileEditAggregate[] = [];
  for (const [path, agg] of byPath) {
    out.push({ path, hunks: agg.hunks, created: agg.created });
  }
  return out;
}

function mergeEdit(
  byPath: Map<string, { hunks: FileHunk[]; created: boolean }>,
  edit: RawEdit,
): void {
  const hunk: FileHunk = { oldText: edit.oldText, newText: edit.newText };
  const existing = byPath.get(edit.path);
  if (existing === undefined) {
    byPath.set(edit.path, {
      hunks: [hunk],
      created: edit.oldText.length === 0,
    });
    return;
  }
  existing.hunks.push(hunk);
}

// Pull every (path, oldText, newText) triple from a single update.
// Handles three carriers:
//   1. content[] type:"diff" — canonical ACP, one block per file.
//   2. rawInput.{file_path, old_string, new_string} — Claude Edit tool.
//   3. rawInput.{path|file_path, content} — Claude Write tool.
//   4. rawInput.edits[] — Claude MultiEdit tool, all edits on the
//      shared rawInput.file_path. Expanded to one RawEdit per item.
// Falls back to extractEditDiff (which only returns the first
// canonical/rawInput hit) when none of the multi-shaped paths match,
// so single-edit tools still work without duplicating that logic.
function extractRawEdits(update: Record<string, unknown>): RawEdit[] {
  const out: RawEdit[] = [];
  // 1) MultiEdit shape — rawInput.edits[] with shared file_path.
  const rawInput = update.rawInput;
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const r = rawInput as Record<string, unknown>;
    const filePath =
      typeof r.file_path === "string"
        ? r.file_path
        : typeof r.path === "string"
          ? r.path
          : undefined;
    const subEdits = r.edits;
    if (filePath !== undefined && Array.isArray(subEdits)) {
      for (const item of subEdits) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const it = item as Record<string, unknown>;
        const oldText = typeof it.old_string === "string" ? it.old_string : undefined;
        const newText = typeof it.new_string === "string" ? it.new_string : undefined;
        if (oldText === undefined || newText === undefined) {
          continue;
        }
        out.push({ path: filePath, oldText, newText });
      }
      if (out.length > 0) {
        return out;
      }
    }
  }
  // 2) content[] type:"diff" blocks — emit one RawEdit per block. The
  // canonical ACP carrier puts one block per file, but defensively
  // accept multiple in case an agent batches.
  const content = update.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as Record<string, unknown>;
      if (b.type !== "diff") {
        continue;
      }
      const path = typeof b.path === "string" ? b.path : undefined;
      if (path === undefined) {
        continue;
      }
      const oldText = typeof b.oldText === "string" ? b.oldText : "";
      const newText = typeof b.newText === "string" ? b.newText : "";
      out.push({ path, oldText, newText });
    }
    if (out.length > 0) {
      return out;
    }
  }
  // 3) Single-edit fallback via extractEditDiff (Edit/Write).
  const diff = extractEditDiff(update);
  if (diff && diff.path) {
    out.push({
      path: diff.path,
      oldText: diff.oldText,
      newText: diff.newText,
    });
  }
  return out;
}
