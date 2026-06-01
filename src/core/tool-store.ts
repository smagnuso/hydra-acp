import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { paths } from "./paths.js";

// Content-addressed blob store for heavy tool payload externalized out of
// history.jsonl (see tool-content.ts). Blobs live in <session>/tools/<sha256>
// and are written once per unique content — identical re-sends dedupe.

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function safe(sessionId: string, hash?: string): boolean {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return false;
  }
  return hash === undefined || HASH_PATTERN.test(hash);
}

// Write `text` to the session's blob store, returning its sha256. Skips the
// write when the blob already exists (dedup). Returns null only if the
// sessionId is invalid.
export async function putToolBlob(
  sessionId: string,
  text: string,
): Promise<string | null> {
  if (!safe(sessionId)) {
    return null;
  }
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  const file = paths.toolBlobFile(sessionId, hash);
  try {
    await fs.access(file);
    return hash; // already stored
  } catch {
    // not present — write it
  }
  await fs.mkdir(paths.toolsDir(sessionId), { recursive: true });
  // wx: don't clobber if a concurrent writer beat us (same content anyway).
  await fs
    .writeFile(file, text, { encoding: "utf8", mode: 0o600, flag: "wx" })
    .catch(async (err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") {
        throw err;
      }
    });
  return hash;
}

// Read a blob by hash; null if missing or the ids are malformed.
export async function getToolBlob(
  sessionId: string,
  hash: string,
): Promise<string | null> {
  if (!safe(sessionId, hash)) {
    return null;
  }
  try {
    return await fs.readFile(paths.toolBlobFile(sessionId, hash), "utf8");
  } catch {
    return null;
  }
}

// Remove the whole blob store for a session (called on session delete).
export async function deleteToolBlobs(sessionId: string): Promise<void> {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return;
  }
  await fs
    .rm(paths.toolsDir(sessionId), { recursive: true, force: true })
    .catch(() => undefined);
}
