// Per-file line counts for the edits a tool call carries, stamped on the
// update by the daemon as it is recorded and broadcast. Every client then
// knows an edit's extent without diffing it, including one replaying
// history in references mode, where a large body is only a blob ref.
import { extractFileEdits } from "./file-edits.js";
import { countLineChanges } from "./line-diff.js";

const META_KEY = "hydra-acp";

export interface EditStat {
  path: string;
  added: number;
  removed: number;
}

// A unified diff states its own counts: the +/- lines inside its hunks.
function countPatchLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith("+")) {
      added++;
    } else if (line.startsWith("-")) {
      removed++;
    }
  }
  return { added, removed };
}

// One entry per edit, in order; a file edited twice in one call appears
// twice. Edits whose text is not inline are left out rather than guessed.
export function computeEditStats(update: Record<string, unknown>): EditStat[] {
  const out: EditStat[] = [];
  for (const edit of extractFileEdits(update)) {
    if (edit.path === undefined) {
      continue;
    }
    if (edit.patch !== undefined) {
      if (edit.patch.text !== undefined) {
        out.push({ path: edit.path, ...countPatchLines(edit.patch.text) });
      }
      continue;
    }
    if (
      (edit.old !== undefined && edit.old.text === undefined) ||
      (edit.new !== undefined && edit.new.text === undefined)
    ) {
      continue;
    }
    out.push({
      path: edit.path,
      ...countLineChanges(edit.old?.text ?? "", edit.new?.text ?? ""),
    });
  }
  return out;
}

// The session/update envelope with its tool call's edit counts stamped
// under _meta["hydra-acp"].editStats; anything else passes through as is.
export function withEditStats<T>(envelope: T): T {
  const update = (envelope as { update?: Record<string, unknown> }).update;
  if (
    !update ||
    (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")
  ) {
    return envelope;
  }
  const stats = computeEditStats(update);
  if (stats.length === 0) {
    return envelope;
  }
  const meta = (update._meta ?? {}) as Record<string, unknown>;
  const ours = (meta[META_KEY] ?? {}) as Record<string, unknown>;
  return {
    ...envelope,
    update: {
      ...update,
      _meta: { ...meta, [META_KEY]: { ...ours, editStats: stats } },
    },
  };
}

export function readEditStats(update: unknown): EditStat[] | undefined {
  if (!update || typeof update !== "object") {
    return undefined;
  }
  const meta = (update as { _meta?: Record<string, unknown> })._meta;
  const ours = meta?.[META_KEY] as { editStats?: unknown } | undefined;
  if (!Array.isArray(ours?.editStats)) {
    return undefined;
  }
  const out: EditStat[] = [];
  for (const raw of ours.editStats) {
    const s = raw as { path?: unknown; added?: unknown; removed?: unknown };
    if (typeof s.path === "string" && typeof s.added === "number" && typeof s.removed === "number") {
      out.push({ path: s.path, added: s.added, removed: s.removed });
    }
  }
  return out;
}
