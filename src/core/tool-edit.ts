// Shared vocabulary and wire-shape rules for "did this tool call touch a
// file, and which one?".
//
// Three places answer questions in this family, and they kept
// independently rediscovering the same two ACP facts — with one of them
// getting it wrong each time. This module holds the facts; each call site
// still asks its own question.
//
// FACT 1 — `locations[]` is not evidence of an edit. Read, search and
// execute calls populate it too, so a bash call run from a repo root
// reports the directory. Deciding "was this a mutation" requires the tool
// `kind` (or a diff payload). PROTOCOL.md's `file.edited` event documents
// this rule; the TUI's edited-files gadget once ignored it and listed the
// repo directory as an edited file.
//
// FACT 2 — the kind arrives EARLY and the path arrives LATE. Agents emit
// the initial `tool_call` with `kind` set but `rawInput`/`locations` empty,
// then name the file on a later `tool_call_update` which often omits
// `kind`. So kind must be remembered from the first sighting (ToolKindTracker)
// and any path-dependent derivation must re-run as later updates arrive.
//
// What is deliberately NOT unified here: the three call sites ask
// different questions and must keep their own answers.
//   - Session's `file.edited` lifecycle event gates on `kind === "edit"`
//     exactly, because PROTOCOL.md pins that wire contract. Broadening it
//     to delete/move would change an observable event.
//   - history-aggregate's "files touched" deliberately over-includes
//     (no kind gate, plus a rawInput key scan) because a session summary
//     wants reads too — "touched", not "edited".
//   - The sidebar's edited-files list accepts a diff payload regardless of
//     kind, since a diff is direct proof of a mutation.

// Tool kinds that change a file on disk. "delete" and "move" belong here
// even though the reported path may no longer exist afterwards: a consumer
// reporting what changed should not silently drop destructive operations.
export const FILE_MUTATING_KINDS: ReadonlySet<string> = new Set([
  "edit",
  "delete",
  "move",
]);

export function isFileMutatingKind(kind: string | undefined): boolean {
  return kind !== undefined && FILE_MUTATING_KINDS.has(kind);
}

// The single kind that PROTOCOL.md's `file.edited` event fires for. Named
// so the narrower rule reads as a deliberate wire contract at its call
// site rather than as someone having forgotten delete/move.
export const FILE_EDITED_EVENT_KIND = "edit";

// Remembers each tool call's declared kind, since only the first update
// usually carries it (FACT 2). Callers feed every update through `note`
// and read back with `effective`.
export class ToolKindTracker {
  private kinds = new Map<string, string>();

  // First non-empty kind wins. Later updates that re-send it are ignored
  // rather than overwriting, so a partial update can't downgrade a call's
  // kind to undefined or something narrower.
  note(toolCallId: string, kind: string | undefined): void {
    if (
      kind !== undefined &&
      kind.length > 0 &&
      !this.kinds.has(toolCallId)
    ) {
      this.kinds.set(toolCallId, kind);
    }
  }

  get(toolCallId: string): string | undefined {
    return this.kinds.get(toolCallId);
  }

  // The kind to act on for an update: what this update declared, else what
  // we recorded earlier for the same call.
  effective(toolCallId: string, kind: string | undefined): string | undefined {
    return kind !== undefined && kind.length > 0
      ? kind
      : this.kinds.get(toolCallId);
  }

  clear(): void {
    this.kinds.clear();
  }

  get size(): number {
    return this.kinds.size;
  }
}

// Non-empty `path` strings out of an ACP `locations[]` array, in order and
// without deduplication (callers dedupe against their own scope). Tolerates
// any shape: this runs on unvalidated wire data.
//
// Only `path` is extracted. `line` is deliberately left to callers because
// they disagree, legitimately: an editor-jump consumer treats line 0 as
// "no line" and floors the value, while a lifecycle event passes through
// whatever the agent reported.
export function locationPaths(locations: unknown): string[] {
  if (!Array.isArray(locations)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of locations) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const path = (entry as { path?: unknown }).path;
    if (typeof path === "string" && path.length > 0) {
      out.push(path);
    }
  }
  return out;
}

// First usable path from `locations[]`, the common case for a tool acting
// on a single file.
export function firstLocationPath(locations: unknown): string | undefined {
  return locationPaths(locations)[0];
}

export interface PatchedFile {
  path: string;
  added?: number;
  removed?: number;
  // Unified diff for this file: inline, or a blob ref in references mode.
  patch?: string;
  patchRef?: { hash: string; bytes: number };
}

// Rebuild old/new text from a unified diff's hunks. Hunks are concatenated,
// so unchanged lines between them are absent; the line diff downstream
// still aligns the shared context.
export function parseUnifiedPatch(patch: string): {
  oldText: string;
  newText: string;
} {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) {
      continue;
    }
    const text = line.slice(1);
    if (line.startsWith("-")) {
      oldLines.push(text);
    } else if (line.startsWith("+")) {
      newLines.push(text);
    } else if (line.startsWith(" ")) {
      oldLines.push(text);
      newLines.push(text);
    }
  }
  return {
    oldText: oldLines.length > 0 ? oldLines.join("\n") + "\n" : "",
    newText: newLines.length > 0 ? newLines.join("\n") + "\n" : "",
  };
}

// Files touched by a multi-file patch tool (opencode's apply_patch, sent
// for OpenAI models). It declares kind "edit" but carries no diff block and
// no locations; the only record of what changed is the per-file summary in
// `rawOutput.metadata.files[]` on the completed update.
export function extractPatchedFiles(update: unknown): PatchedFile[] {
  if (update === null || typeof update !== "object") {
    return [];
  }
  const rawOutput = (update as { rawOutput?: unknown }).rawOutput;
  if (rawOutput === null || typeof rawOutput !== "object") {
    return [];
  }
  const metadata = (rawOutput as { metadata?: unknown }).metadata;
  if (metadata === null || typeof metadata !== "object") {
    return [];
  }
  const files = (metadata as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    return [];
  }
  const out: PatchedFile[] = [];
  for (const entry of files) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.filePath !== "string" || e.filePath.length === 0) {
      continue;
    }
    const patch = e.patch;
    const ref =
      patch !== null && typeof patch === "object"
        ? (patch as { __hydraBlob?: unknown; bytes?: unknown })
        : undefined;
    out.push({
      path: e.filePath,
      ...(typeof e.additions === "number" ? { added: e.additions } : {}),
      ...(typeof e.deletions === "number" ? { removed: e.deletions } : {}),
      ...(typeof patch === "string" ? { patch } : {}),
      ...(typeof ref?.__hydraBlob === "string"
        ? {
            patchRef: {
              hash: ref.__hydraBlob,
              bytes: typeof ref.bytes === "number" ? ref.bytes : 0,
            },
          }
        : {}),
    });
  }
  return out;
}
