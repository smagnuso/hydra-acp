// Disk-backed persistence for Session.promptQueue. Survives daemon
// restarts so queued prompts can be re-fired against the resurrected
// session instead of silently dropped on the floor when the process
// dies. See cli/src/core/session.ts for the lifecycle that invokes
// this module — the contract is:
//
// - appendQueueEntry on enqueue (file is the source of truth post-
//   write; if a crash happens after the in-memory queue add but before
//   the disk append, the prompt is lost — that's the spec).
// - removeQueueEntry on dequeue, BEFORE the agent is invoked. If a
//   crash happens after the disk remove but before/during the agent
//   call, the prompt is lost. We pick "lose the prompt" over "run it
//   twice on restart" — the partial output (if any) is in history,
//   the user can re-type, and we never bill twice for the same intent.
// - rewriteQueue on update (the prompt content changed but the entry
//   stays in queue order).
// - deleteQueue on session close / record delete.
//
// The on-disk file is ndjson; each line is a PersistedQueueEntry.
// Removals are done by rewriting the file because queues are small in
// practice (rarely more than a handful of entries) and the rewrite
// stays atomic enough — fs.writeFile is replace-on-rename on most
// platforms.

import * as fs from "node:fs/promises";

import { paths } from "./paths.js";

export interface PersistedQueueEntry {
  messageId: string;
  // Just clientInfo, not clientId. The original clientId is gone after
  // a restart (the client connection that owned it is dead); name +
  // version are the human-meaningful bits we can preserve.
  originator: { clientInfo: { name?: string; version?: string } };
  // The session/prompt prompt array, kept verbatim so the replay
  // re-fires the exact same content (including any update_prompt
  // edits the original sender made before the crash).
  prompt: unknown[];
  enqueuedAt: number;
}

export async function appendQueueEntry(
  sessionId: string,
  entry: PersistedQueueEntry,
): Promise<void> {
  const file = paths.queueFile(sessionId);
  await fs.mkdir(paths.sessionDir(sessionId), { recursive: true });
  await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
}

export async function rewriteQueue(
  sessionId: string,
  entries: PersistedQueueEntry[],
): Promise<void> {
  const file = paths.queueFile(sessionId);
  if (entries.length === 0) {
    await fs.unlink(file).catch(() => undefined);
    return;
  }
  await fs.mkdir(paths.sessionDir(sessionId), { recursive: true });
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fs.writeFile(file, body, "utf8");
}

export async function loadQueue(
  sessionId: string,
): Promise<PersistedQueueEntry[]> {
  const file = paths.queueFile(sessionId);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const out: PersistedQueueEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as PersistedQueueEntry;
      // Defensive: skip malformed records rather than throwing — a
      // single bad line shouldn't prevent the rest of the queue from
      // replaying.
      if (
        parsed &&
        typeof parsed.messageId === "string" &&
        Array.isArray(parsed.prompt) &&
        typeof parsed.enqueuedAt === "number"
      ) {
        out.push(parsed);
      }
    } catch {
      // Corrupt line — drop it.
    }
  }
  return out;
}

export async function deleteQueue(sessionId: string): Promise<void> {
  const file = paths.queueFile(sessionId);
  await fs.unlink(file).catch(() => undefined);
}
