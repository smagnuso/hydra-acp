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
// Each hunk says which it is in `scope`; only "file" hunks, where an agent
// reports the whole file each time, compose (foldWholeFileHunks).
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
import { editTexts, extractFileEdits, type EditScope } from "./file-edits.js";

type HistoryEntryLike = {
  method?: unknown;
  params?: unknown;
  [key: string]: unknown;
};

// A single hunk: one Edit/Write/MultiEdit-sub-edit or one file of a patch.
// Snippet-scoped for Edit (old_string/new_string), whole-file-scoped for
// Write (oldText="").
export interface FileHunk {
  oldText: string;
  newText: string;
  // Whether oldText and newText are the whole file or only the edited
  // snippet. Absent when the recorded update does not tell.
  scope?: EditScope;
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
  scope?: EditScope;
}

export function aggregateFileEdits(
  history: HistoryEntryLike[],
): FileEditAggregate[] {
  // Per toolCallId, the list of raw edits we've already counted, so a
  // tool_call_update that re-asserts the same payload doesn't double up.
  const seenByCall = new Map<string, RawEdit[]>();
  const hunkOf = new Map<RawEdit, FileHunk>();
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
        const same = prior.find(
          (p) =>
            p.path === e.path &&
            p.oldText === e.oldText &&
            p.newText === e.newText,
        );
        if (same === undefined) {
          remaining.push(e);
        } else if (same.scope === undefined && e.scope !== undefined) {
          // The call's first update may not carry what a later one does.
          same.scope = e.scope;
          const hunk = hunkOf.get(same);
          if (hunk) {
            hunk.scope = e.scope;
          }
        }
      }
      if (remaining.length === 0) {
        continue;
      }
      seenByCall.set(toolCallId, [...prior, ...remaining]);
      toApply = remaining;
    }
    for (const e of toApply) {
      hunkOf.set(e, mergeEdit(byPath, e));
    }
  }

  const out: FileEditAggregate[] = [];
  for (const [path, agg] of byPath) {
    out.push({ path, hunks: agg.hunks, created: agg.created });
  }
  return out;
}

// Fold sequential edits to the same region into one composed hunk.
// When a later hunk's oldText equals an earlier hunk's newText, the
// later edit is rewriting exactly what the earlier one put down — we
// can compose them to (earliest.oldText, latest.newText) without
// reading any source file. Useful for hiding agent thrash ("rewrote
// the same block 4 times"), but lossy: a session that legitimately
// touched the same region in multiple distinct steps gets collapsed
// to a single net-effect view. Opt-in via --fold.
//
// Matching is most-recent-wins. If two earlier hunks both happen to
// have the same newText (rare but possible), we fold against the
// later one so the chain reflects the most recent state of that
// region. Hunks that don't compose are left in place, preserving
// order with the folded-into hunks.
export function foldHunks(hunks: FileHunk[]): FileHunk[] {
  const out: FileHunk[] = [];
  for (const next of hunks) {
    let matchedIdx = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i]!.newText === next.oldText) {
        matchedIdx = i;
        break;
      }
    }
    if (matchedIdx === -1) {
      out.push(next);
      continue;
    }
    const earlier = out[matchedIdx]!;
    out.splice(matchedIdx, 1, {
      oldText: earlier.oldText,
      newText: next.newText,
      ...(earlier.scope !== undefined && earlier.scope === next.scope ? { scope: earlier.scope } : {}),
    });
  }
  return out;
}

// Hunks that each carry the whole file are steps of one file's history, not
// separate changes: compose them into the first before and the last after.
// Snippet and untagged hunks are left alone.
export function foldWholeFileHunks(hunks: FileHunk[]): FileHunk[] {
  const whole = hunks.filter((hunk) => hunk.scope === "file");
  const first = whole[0];
  const last = whole[whole.length - 1];
  if (!first || !last || whole.length < 2) {
    return hunks;
  }
  const composed: FileHunk = { oldText: first.oldText, newText: last.newText, scope: "file" };
  const out: FileHunk[] = [];
  for (const hunk of hunks) {
    if (hunk.scope !== "file") {
      out.push(hunk);
    } else if (hunk === first) {
      out.push(composed);
    }
  }
  return out;
}

// What the CLI shows: whole-file steps composed unless the caller wants every
// recorded step, and --fold also composes chained snippets.
export function foldForDisplay(
  files: FileEditAggregate[],
  opts: { fold?: boolean; steps?: boolean },
): FileEditAggregate[] {
  return files.map((f) => {
    const whole = opts.steps === true ? f.hunks : foldWholeFileHunks(f.hunks);
    return { ...f, hunks: opts.fold === true ? foldHunks(whole) : whole };
  });
}

function mergeEdit(
  byPath: Map<string, { hunks: FileHunk[]; created: boolean }>,
  edit: RawEdit,
): FileHunk {
  const hunk: FileHunk = {
    oldText: edit.oldText,
    newText: edit.newText,
    ...(edit.scope !== undefined ? { scope: edit.scope } : {}),
  };
  const existing = byPath.get(edit.path);
  if (existing === undefined) {
    byPath.set(edit.path, {
      hunks: [hunk],
      created: edit.oldText.length === 0,
    });
    return hunk;
  }
  existing.hunks.push(hunk);
  return hunk;
}

// Every (path, oldText, newText) triple in one update, from whichever
// carrier the agent used (see file-edits.ts). A patch tool's per-file
// unified diff becomes one hunk of its concatenated hunks.
function extractRawEdits(update: Record<string, unknown>): RawEdit[] {
  const out: RawEdit[] = [];
  for (const edit of extractFileEdits(update)) {
    if (edit.path !== undefined) {
      out.push({
        path: edit.path,
        ...editTexts(edit),
        ...(edit.scope !== undefined ? { scope: edit.scope } : {}),
      });
    }
  }
  return out;
}
