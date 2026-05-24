// Prompt history, persisted at ~/.hydra-acp/sessions/<id>/prompt-history
// (per-session) and ~/.hydra-acp/prompt-history (global cross-session
// fallback). One JSON-encoded string per line so multi-line prompts
// round-trip safely.

import { promises as fs } from "node:fs";
import * as path from "node:path";

export const HISTORY_CAP = 500;
// Global tier is much larger — it's the only thing carrying state
// across session boundaries, so it has to absorb the long tail of
// prompts a user might want to recall weeks later.
export const GLOBAL_HISTORY_CAP = 2000;

export async function loadHistory(file: string): Promise<string[]> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  return parseHistory(text);
}

export function parseHistory(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) {
      continue;
    }
    try {
      const decoded = JSON.parse(rawLine);
      if (typeof decoded === "string") {
        out.push(decoded);
      }
    } catch {
      // Tolerate corrupted lines from older versions or partial writes.
    }
  }
  return out;
}

export function appendEntry(
  history: string[],
  entry: string,
  cap: number = HISTORY_CAP,
): string[] {
  const trimmed = entry.replace(/\n+$/, "");
  if (trimmed.length === 0) {
    return history;
  }
  // De-dupe consecutive identical entries.
  if (history.length > 0 && history[history.length - 1] === trimmed) {
    return history;
  }
  const out = history.concat(trimmed);
  if (out.length > cap) {
    return out.slice(out.length - cap);
  }
  return out;
}

export async function saveHistory(
  file: string,
  history: string[],
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lines = history.map((entry) => JSON.stringify(entry));
  await fs.writeFile(file, lines.length > 0 ? lines.join("\n") + "\n" : "");
}

// Append a single JSON-encoded entry to a history file. Atomic on POSIX
// for writes under PIPE_BUF, which JSONL lines comfortably are — that's
// what lets multiple TUIs share the global history file without
// stomping each other's writes the way the full-rewrite saveHistory
// would.
export async function appendHistoryLine(
  file: string,
  entry: string,
): Promise<void> {
  const trimmed = entry.replace(/\n+$/, "");
  if (trimmed.length === 0) {
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(trimmed) + "\n", {
    encoding: "utf8",
  });
}

// Combine global and per-session history into the single newest-at-end
// array the InputDispatcher walks. Entries that appear in the session
// list are dropped from the global slice so the user doesn't see the
// same prompt twice when walking past the session boundary.
export function buildCombinedHistory(
  global: string[],
  session: string[],
): string[] {
  if (session.length === 0) {
    return [...global];
  }
  const sessionSet = new Set(session);
  const filteredGlobal = global.filter((e) => !sessionSet.has(e));
  return [...filteredGlobal, ...session];
}

// Append replayed prompts (from a daemon attach replay) into the
// existing per-session history. Set-based dedup against existing entries
// AND entries added in this merge so reattaches don't pile up duplicates
// when the daemon replays the same prompts again. Order: existing first,
// then new-to-this-merge replayed entries in their replay order.
export function mergeReplayedEntries(
  existing: string[],
  replayed: string[],
  cap: number = HISTORY_CAP,
): string[] {
  if (replayed.length === 0) {
    return existing;
  }
  const seen = new Set(existing);
  let out = existing;
  for (const raw of replayed) {
    const trimmed = raw.replace(/\n+$/, "");
    if (trimmed.length === 0) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out = appendEntry(out, trimmed, cap);
  }
  return out;
}
