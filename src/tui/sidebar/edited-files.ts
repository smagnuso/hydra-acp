// Derivation of the sidebar's "edited" list from tool-call state.
//
// Two things live here, both extracted from app.ts because getting either
// wrong is invisible in the types and obvious on screen.
//
// 1. WHAT COUNTS AS AN EDIT. The first version keyed off `locations[]`,
//    which read, search and execute calls populate too, so a bash call run
//    from the repo root contributed the directory itself and the gadget
//    listed "cli" as an edited file.
//
// 2. WHERE THE LIST LIVES. `toolStates` / `toolCallOrder` in app.ts are
//    per-TURN: they drive the tools block and are cleared on
//    turn-complete and again on each new prompt. Deriving the gadget
//    straight from them meant it emptied out the moment a turn finished,
//    so "files edited this session" only ever showed the current turn.
//    The caller therefore accumulates one entry per tool call for the
//    life of the session and collapses by path at render time.

import { resolve as resolvePath } from "node:path";
import { countDiffChanges } from "../format.js";
import type { ToolLineState } from "../format.js";
import type { EditDiff } from "../../core/render-update.js";
import type { SidebarEditedFile } from "./types.js";

// ACP tool kinds that mutate a file. "delete" and "move" belong here even
// though the old path may no longer exist: the gadget reports what the
// session changed, and a stale row is better than silently omitting a
// destructive operation.
const FILE_MUTATING_KINDS = new Set(["edit", "delete", "move"]);

// A diff payload is direct proof of a mutation, so it wins outright.
// Otherwise the ACP kind has to say so. Calls from agents that send no
// kind and no diff contribute nothing: under-reporting an edit costs a row
// in a summary gadget, whereas over-reporting puts directories and
// read-only paths in a list labelled "edited" — actively misleading, and
// since the rows are clickable it also hands the editor a directory.
export function isFileMutatingTool(
  state: Pick<ToolLineState, "rawKind">,
  diff: EditDiff | undefined,
): boolean {
  if (diff !== undefined) {
    return true;
  }
  return state.rawKind !== undefined && FILE_MUTATING_KINDS.has(state.rawKind);
}

// One tool call's contribution, or null when the call didn't mutate a file
// (or mutated one we can't name). Callers key these by toolCallId and
// overwrite on update, which makes late-arriving diffs — the deferred
// `toolContent: "references"` fetch resolves a diff well after the call
// completed — idempotent instead of double-counting.
//
// `cwd` absolutizes tool-reported relative paths so double-click-to-open
// doesn't depend on the editor's own working directory.
export function editedFileFromTool(
  state: Pick<ToolLineState, "rawKind" | "status" | "locations">,
  diff: EditDiff | undefined,
  cwd: string | null,
): SidebarEditedFile | null {
  // In-flight and failed calls contribute nothing: a failed edit changed
  // nothing, and a running one hasn't yet.
  if (state.status !== "completed") {
    return null;
  }
  if (!isFileMutatingTool(state, diff)) {
    return null;
  }
  const reported = diff?.path ?? state.locations?.[0]?.path;
  if (reported === undefined || reported === "") {
    return null;
  }
  // Line counts are only known for edits that carried a diff; a Write with
  // no diff shows as touched-without-extent.
  const changes = diff === undefined ? undefined : countDiffChanges(diff);
  return {
    path: cwd === null ? reported : resolvePath(cwd, reported),
    added: changes?.added,
    removed: changes?.removed,
  };
}

// Collapse per-tool-call entries into one row per file, summing line
// counts, in first-touch order. A file edited five times is one row, so it
// can't push everything else out of the column.
export function collapseEditedFiles(
  entries: Iterable<SidebarEditedFile>,
): SidebarEditedFile[] {
  const byPath = new Map<string, SidebarEditedFile>();
  for (const entry of entries) {
    const existing = byPath.get(entry.path);
    if (existing === undefined) {
      byPath.set(entry.path, { ...entry });
      continue;
    }
    if (entry.added !== undefined) {
      existing.added = (existing.added ?? 0) + entry.added;
    }
    if (entry.removed !== undefined) {
      existing.removed = (existing.removed ?? 0) + entry.removed;
    }
  }
  return [...byPath.values()];
}
