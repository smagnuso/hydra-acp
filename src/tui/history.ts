// Prompt history, persisted at ~/.acp-hydra/tui-history. One JSON-encoded
// string per line so multi-line prompts round-trip safely.

import { promises as fs } from "node:fs";
import * as path from "node:path";

export const HISTORY_CAP = 500;

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

export function appendEntry(history: string[], entry: string): string[] {
  const trimmed = entry.replace(/\n+$/, "");
  if (trimmed.length === 0) {
    return history;
  }
  // De-dupe consecutive identical entries.
  if (history.length > 0 && history[history.length - 1] === trimmed) {
    return history;
  }
  const out = history.concat(trimmed);
  if (out.length > HISTORY_CAP) {
    return out.slice(out.length - HISTORY_CAP);
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
