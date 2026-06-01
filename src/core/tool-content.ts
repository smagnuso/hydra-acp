import type { HistoryEntry } from "./history-store.js";

// How tool payload is materialized when reading/exporting a history.
//   "inline"  — full content, reconstructed from the blob store (the
//               default; identical to the original recorded shape).
//   "references" — leave blob references in place (the lean form): callers
//               ship the references and fetch the content on demand. Used by
//               load() for clients that opt out of inline content.
//   "summary" — shed the heavy, never-rendered tool payload entirely: edit
//               diffs keep their path (and stay recognizable as an Edited
//               block) but drop old/new text; tool stdout in rawOutput is
//               reduced to its error + metadata; over-long non-diff content
//               is clipped. Used by export/archive to trim bundles; the
//               shed content is not recoverable from the bundle.
export type ToolContentMode = "inline" | "references" | "summary";

// Parse the export `?tools=` query value. Only inline / summary are valid
// there (a bundle can't ship bare refs without the blobs), so anything else
// falls back to inline.
export function parseToolContentMode(raw: unknown): "inline" | "summary" {
  return raw === "summary" ? "summary" : "inline";
}

// Tiny preview kept for non-diff tool content so a failed tool still carries
// a hint of context, while the bulk (stdout, file reads) is shed.
const SUMMARY_TEXT_CAP = 256;

// Apply a tool-content mode to an already-loaded (inline) history. Only
// "summary" rewrites the entries (shedding heavy content);
// "inline"/"references" return the input unchanged.
export function applyToolContentMode(
  entries: HistoryEntry[],
  mode: ToolContentMode,
): HistoryEntry[] {
  if (mode !== "summary") {
    return entries;
  }
  return entries.map(summarizeEntry);
}

function summarizeEntry(entry: HistoryEntry): HistoryEntry {
  if (entry.method !== "session/update") {
    return entry;
  }
  const params = entry.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return entry;
  }
  const p = params as Record<string, unknown>;
  const update = p.update;
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    return entry;
  }
  const u = update as Record<string, unknown>;
  if (u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update") {
    return entry;
  }

  const newUpdate: Record<string, unknown> = { ...u };
  if (Array.isArray(u.content)) {
    newUpdate.content = (u.content as unknown[]).map(summarizeBlock);
  }
  const rawOutput = u.rawOutput;
  if (rawOutput && typeof rawOutput === "object" && !Array.isArray(rawOutput)) {
    const ro = rawOutput as Record<string, unknown>;
    const slim: Record<string, unknown> = {};
    if (ro.error !== undefined) {
      slim.error = clip(ro.error);
    }
    if (ro.metadata !== undefined) {
      slim.metadata = ro.metadata;
    }
    newUpdate.rawOutput = slim;
  }
  return { ...entry, params: { ...p, update: newUpdate } };
}

function isDiffBlock(block: unknown): boolean {
  return (
    !!block &&
    typeof block === "object" &&
    !Array.isArray(block) &&
    (block as { type?: unknown }).type === "diff"
  );
}

function summarizeBlock(block: unknown): unknown {
  // Edit diff: keep it recognizable (type + path, with defined empty
  // old/new so extractEditDiff still yields an Edited block) but drop the
  // full-file text that dominates the payload.
  if (isDiffBlock(block)) {
    const b = block as Record<string, unknown>;
    const out: Record<string, unknown> = {
      type: "diff",
      oldText: "",
      newText: "",
    };
    if (typeof b.path === "string") {
      out.path = b.path;
    }
    return out;
  }
  // Non-diff content (tool stdout): keep the shape, clip text payloads.
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return block;
  }
  const b = block as Record<string, unknown>;
  const out: Record<string, unknown> = { ...b };
  if (typeof b.text === "string") {
    out.text = clip(b.text);
  }
  if (typeof b.content === "string") {
    out.content = clip(b.content);
  } else if (b.content && typeof b.content === "object") {
    out.content = summarizeBlock(b.content);
  }
  return out;
}

function clip(value: unknown): unknown {
  if (typeof value === "string" && value.length > SUMMARY_TEXT_CAP) {
    const elided = value.length - SUMMARY_TEXT_CAP;
    return `${value.slice(0, SUMMARY_TEXT_CAP)}…[+${elided} chars omitted from summary export]`;
  }
  return value;
}

// --- externalization (record-time content-addressed offload) ---------------
//
// Heavy tool string fields (diff old/new text, stdout) are replaced on disk
// with a blob ref so history.jsonl stays small. HistoryStore.append calls
// externalizeToolEntry before writing; HistoryStore.load calls expandToolRefs
// after reading, so every consumer still sees the original inline shape.

// String fields longer than this (in chars) get offloaded to a blob. Smaller
// content stays inline so tiny edits/outputs don't spawn sidecar files.
export const TOOL_BLOB_THRESHOLD = 2048;

// Inline placeholder for an offloaded string. The unusual key avoids
// colliding with real payload, and `bytes` lets summary/UI report size
// without fetching the blob.
export interface ToolBlobRef {
  __hydraBlob: string;
  bytes: number;
}

export function isToolBlobRef(value: unknown): value is ToolBlobRef {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { __hydraBlob?: unknown }).__hydraBlob === "string"
  );
}

function isToolEntry(entry: HistoryEntry): boolean {
  if (entry.method !== "session/update") {
    return false;
  }
  const params = entry.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return false;
  }
  const update = (params as Record<string, unknown>).update;
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    return false;
  }
  const kind = (update as Record<string, unknown>).sessionUpdate;
  return kind === "tool_call" || kind === "tool_call_update";
}

// Replace large string fields in a tool entry's `update` with blob refs,
// storing the content via `put`. Non-tool entries and small strings are
// returned untouched. Never mutates the input (broadcast keeps full content).
export async function externalizeToolEntry(
  entry: HistoryEntry,
  put: (text: string) => Promise<string | null>,
): Promise<HistoryEntry> {
  if (!isToolEntry(entry)) {
    return entry;
  }
  const p = entry.params as Record<string, unknown>;
  const update = p.update as Record<string, unknown>;
  const newUpdate = (await deepExternalize(update, put)) as Record<
    string,
    unknown
  >;
  return { ...entry, params: { ...p, update: newUpdate } };
}

async function deepExternalize(
  value: unknown,
  put: (text: string) => Promise<string | null>,
): Promise<unknown> {
  if (typeof value === "string") {
    if (value.length <= TOOL_BLOB_THRESHOLD) {
      return value;
    }
    const hash = await put(value);
    if (hash === null) {
      return value; // store unavailable — keep inline rather than lose it
    }
    const ref: ToolBlobRef = { __hydraBlob: hash, bytes: value.length };
    return ref;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      out.push(await deepExternalize(item, put));
    }
    return out;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = await deepExternalize(v, put);
    }
    return out;
  }
  return value;
}

// Reverse of externalizeToolEntry: expand blob refs back to their content
// via `get`, yielding the original inline entry. Safe to call on any entry
// (no refs → returned unchanged) and on old inline histories (which never
// carry refs).
export async function expandToolRefs(
  entry: HistoryEntry,
  get: (hash: string) => Promise<string | null>,
): Promise<HistoryEntry> {
  const params = entry.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return entry;
  }
  const expanded = (await deepExpand(params, get)) as unknown;
  if (expanded === params) {
    return entry;
  }
  return { ...entry, params: expanded };
}

async function deepExpand(
  value: unknown,
  get: (hash: string) => Promise<string | null>,
): Promise<unknown> {
  if (isToolBlobRef(value)) {
    const text = await get(value.__hydraBlob);
    return text ?? "";
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = [];
    for (const item of value) {
      const next = await deepExpand(item, get);
      if (next !== item) {
        changed = true;
      }
      out.push(next);
    }
    return changed ? out : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = await deepExpand(v, get);
      if (next !== v) {
        changed = true;
      }
      out[k] = next;
    }
    return changed ? out : value;
  }
  return value;
}
