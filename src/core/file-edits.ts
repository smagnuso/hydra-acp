// The file edits a tool_call / tool_call_update carries, in every shape an
// agent reports them. One place for the readers so the TUI's renderer, the
// session diff aggregation and history search all see the same edits.
//
// Bodies are an inline string or, in references mode, a blob ref
// ({ __hydraBlob, bytes }); each caller decides whether it needs the text.
import { extractPatchedFiles, parseUnifiedPatch } from "./tool-edit.js";

export interface BlobRef {
  hash: string;
  bytes: number;
}

export interface EditBody {
  text?: string;
  ref?: BlobRef;
}

export interface FileEdit {
  path?: string;
  // Absent on a write: the file's prior content was not part of the edit.
  old?: EditBody;
  new?: EditBody;
  // Multi-file patch tools carry a unified diff per file instead.
  patch?: EditBody;
}

export function readEditBody(value: unknown): EditBody | undefined {
  if (typeof value === "string") {
    return { text: value };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as { __hydraBlob?: unknown; bytes?: unknown };
    if (typeof v.__hydraBlob === "string") {
      return {
        ref: {
          hash: v.__hydraBlob,
          bytes: typeof v.bytes === "number" ? v.bytes : 0,
        },
      };
    }
  }
  return undefined;
}

function rawInputOf(update: Record<string, unknown>): Record<string, unknown> | undefined {
  const rawInput = update.rawInput;
  return rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
    ? (rawInput as Record<string, unknown>)
    : undefined;
}

function filePathOf(rawInput: Record<string, unknown>): string | undefined {
  if (typeof rawInput.file_path === "string") {
    return rawInput.file_path;
  }
  return typeof rawInput.path === "string" ? rawInput.path : undefined;
}

// content[] type:"diff" blocks, the canonical ACP carrier: one per file.
export function diffBlockEdits(update: Record<string, unknown>): FileEdit[] {
  const content = update.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const out: FileEdit[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type !== "diff") {
      continue;
    }
    const old = readEditBody(b.oldText);
    const next = readEditBody(b.newText);
    if (old === undefined && next === undefined) {
      continue;
    }
    out.push({
      ...(typeof b.path === "string" ? { path: b.path } : {}),
      ...(old ? { old } : {}),
      ...(next ? { new: next } : {}),
    });
  }
  return out;
}

// Claude's Edit (file_path, old_string, new_string) or Write (path or
// file_path, content). Any tool taking a path and one of those fields reads
// as an edit; that over-includes the odd MCP tool rather than miss real ones.
export function rawInputEdit(update: Record<string, unknown>): FileEdit | undefined {
  const r = rawInputOf(update);
  if (!r) {
    return undefined;
  }
  const path = filePathOf(r);
  if (r.old_string !== undefined || r.new_string !== undefined) {
    const old = readEditBody(r.old_string);
    const next = readEditBody(r.new_string);
    return {
      ...(path !== undefined ? { path } : {}),
      ...(old ? { old } : {}),
      ...(next ? { new: next } : {}),
    };
  }
  if (r.content !== undefined) {
    const next = readEditBody(r.content);
    return {
      ...(path !== undefined ? { path } : {}),
      old: { text: "" },
      ...(next ? { new: next } : {}),
    };
  }
  return undefined;
}

// Claude's MultiEdit: rawInput.edits[] against one shared file.
export function multiEditEdits(update: Record<string, unknown>): FileEdit[] {
  const r = rawInputOf(update);
  const path = r ? filePathOf(r) : undefined;
  if (!r || path === undefined || !Array.isArray(r.edits)) {
    return [];
  }
  const out: FileEdit[] = [];
  for (const item of r.edits) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const it = item as Record<string, unknown>;
    const old = readEditBody(it.old_string);
    const next = readEditBody(it.new_string);
    if (old === undefined || next === undefined) {
      continue;
    }
    out.push({ path, old, new: next });
  }
  return out;
}

// Multi-file patch tools (opencode's apply_patch): one unified diff per file
// in rawOutput.metadata.files[], on the completed update.
export function patchFileEdits(update: Record<string, unknown>): FileEdit[] {
  return extractPatchedFiles(update).map((file) => ({
    path: file.path,
    ...(file.patch !== undefined ? { patch: { text: file.patch } } : {}),
    ...(file.patchRef !== undefined ? { patch: { ref: file.patchRef } } : {}),
  }));
}

// Every file edit in one update, taking the first carrier that has any:
// MultiEdit, diff blocks, a single Edit/Write, then patch files.
export function extractFileEdits(update: Record<string, unknown>): FileEdit[] {
  const multi = multiEditEdits(update);
  if (multi.length > 0) {
    return multi;
  }
  const blocks = diffBlockEdits(update).filter((edit) => edit.path !== undefined);
  if (blocks.length > 0) {
    return blocks;
  }
  const single = rawInputEdit(update);
  if (single?.path !== undefined) {
    return [single];
  }
  return patchFileEdits(update);
}

// Paths of every file the update changed, from any carrier, deduped.
export function editedFilePaths(update: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const r = rawInputOf(update);
  const candidates = [
    ...diffBlockEdits(update).map((edit) => edit.path),
    rawInputEdit(update)?.path,
    r && Array.isArray(r.edits) ? filePathOf(r) : undefined,
    ...patchFileEdits(update).map((edit) => edit.path),
  ];
  for (const path of candidates) {
    if (typeof path === "string" && path.length > 0) {
      seen.add(path);
    }
  }
  return [...seen];
}

// The edit's before and after text; a patch is unfolded into its hunks.
// Bodies only known by reference read as "".
export function editTexts(edit: FileEdit): { oldText: string; newText: string } {
  if (edit.patch !== undefined) {
    return edit.patch.text !== undefined ? parseUnifiedPatch(edit.patch.text) : { oldText: "", newText: "" };
  }
  return { oldText: edit.old?.text ?? "", newText: edit.new?.text ?? "" };
}
