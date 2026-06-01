import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzip as gzipCb, gunzip as gunzipCb } from "node:zlib";
import { promisify } from "node:util";
import { paths } from "./paths.js";

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

// Content-addressed blob store for heavy tool payload externalized out of
// history.jsonl (see tool-content.ts). Blobs live in
// <session>/tools/<sha256>.gz and are written once per unique content —
// identical re-sends dedupe. The hash is over the RAW (uncompressed)
// content, so dedup is independent of the compression.
//
// The ".gz" suffix is the format marker: getToolBlob reads "<hash>.gz" and
// gunzips, falling back to a plain "<hash>" (pre-compression blobs already
// on disk). Both coexist, so no migration is needed and a user can still
// `zcat tools/*.gz | grep …`.

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

// Whether new blobs are gzipped at rest. Reads always handle both forms, so
// toggling this only changes the format of subsequently-written blobs. Set
// from config at daemon startup; defaults on.
let compressBlobs = true;
export function setToolBlobCompression(enabled: boolean): void {
  compressBlobs = enabled;
}

function safe(sessionId: string, hash?: string): boolean {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return false;
  }
  return hash === undefined || HASH_PATTERN.test(hash);
}

function gzPath(sessionId: string, hash: string): string {
  return `${paths.toolBlobFile(sessionId, hash)}.gz`;
}

// Write `text` to the session's blob store (gzipped), returning its sha256.
// Skips the write when the blob already exists (dedup). Null if the
// sessionId is invalid.
export async function putToolBlob(
  sessionId: string,
  text: string,
): Promise<string | null> {
  if (!safe(sessionId)) {
    return null;
  }
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  // Either form counts as already-stored (dedup); never write twice.
  const gzFile = gzPath(sessionId, hash);
  const plainFile = paths.toolBlobFile(sessionId, hash);
  for (const existing of [gzFile, plainFile]) {
    try {
      await fs.access(existing);
      return hash;
    } catch {
      // not present
    }
  }
  await fs.mkdir(paths.toolsDir(sessionId), { recursive: true });
  const file = compressBlobs ? gzFile : plainFile;
  const data = compressBlobs
    ? await gzip(Buffer.from(text, "utf8"))
    : Buffer.from(text, "utf8");
  await fs
    .writeFile(file, data, { mode: 0o600, flag: "wx" })
    .catch(async (err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") {
        throw err;
      }
    });
  return hash;
}

// Read a blob by hash, decompressed to text. Tries the gzipped form first,
// then a legacy plain file. Null if missing or the ids are malformed.
export async function getToolBlob(
  sessionId: string,
  hash: string,
): Promise<string | null> {
  if (!safe(sessionId, hash)) {
    return null;
  }
  try {
    const buf = await fs.readFile(gzPath(sessionId, hash));
    return (await gunzip(buf)).toString("utf8");
  } catch {
    // fall through to legacy plain file
  }
  try {
    return await fs.readFile(paths.toolBlobFile(sessionId, hash), "utf8");
  } catch {
    return null;
  }
}

// Read a blob as gzipped bytes for bundling (export). For a stored ".gz"
// blob the bytes are returned as-is (no decompress/recompress); a legacy
// plain blob is compressed on the fly. Null if missing/malformed.
export async function readToolBlobGz(
  sessionId: string,
  hash: string,
): Promise<Buffer | null> {
  if (!safe(sessionId, hash)) {
    return null;
  }
  try {
    return await fs.readFile(gzPath(sessionId, hash));
  } catch {
    // legacy plain — compress on the fly
  }
  try {
    const plain = await fs.readFile(paths.toolBlobFile(sessionId, hash));
    return await gzip(plain);
  } catch {
    return null;
  }
}

// Write a gzipped blob received in a bundle (import) under "<hash>.gz".
// Idempotent / dedup-friendly (skips if present).
export async function writeToolBlobGz(
  sessionId: string,
  hash: string,
  gzBytes: Buffer,
): Promise<void> {
  if (!safe(sessionId, hash)) {
    return;
  }
  const file = gzPath(sessionId, hash);
  try {
    await fs.access(file);
    return;
  } catch {
    // not present
  }
  await fs.mkdir(paths.toolsDir(sessionId), { recursive: true });
  await fs
    .writeFile(file, gzBytes, { mode: 0o600, flag: "wx" })
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") {
        throw err;
      }
    });
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
