// Shared helpers for persisting JSON state files under ~/.hydra-acp.
//
// writeJsonAtomic writes to a sibling temp file and renames it onto the
// final path. POSIX rename within a filesystem is atomic, so a kill or
// crash mid-write leaves either the old file fully intact or the new file
// fully written — never a zero-byte or half-written blob. Plain
// fs.writeFile truncates the target first; if the process dies between
// truncate and write, the file is left empty and any loader that does
// `JSON.parse(raw)` blows up on `Unexpected end of JSON input`.
//
// readJsonSafe is the loader-side counterpart. A missing file, an empty
// file, or a syntax-corrupted file all return undefined so the caller
// can start from defaults rather than crashing. Genuine IO errors
// (EPERM, EACCES, etc.) still throw — those are operator-level and
// shouldn't be silently swallowed.
//
// Together they remove a class of "daemon hangs on startup because some
// JSON file got truncated by an earlier hard kill" failures.
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export interface WriteJsonAtomicOptions {
  mode?: number;
  pretty?: boolean;
}

export async function writeJsonAtomic(
  filePath: string,
  data: unknown,
  opts: WriteJsonAtomicOptions = {},
): Promise<void> {
  const pretty = opts.pretty ?? true;
  const body = (pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)) + "\n";
  await writeFileAtomic(filePath, body, opts);
}

export interface WriteFileAtomicOptions {
  mode?: number;
}

// Same atomicity guarantee as writeJsonAtomic but for callers that have
// already serialized their payload (or are writing non-JSON text like
// the password hash file).
export async function writeFileAtomic(
  filePath: string,
  body: string,
  opts: WriteFileAtomicOptions = {},
): Promise<void> {
  // If filePath is a symlink, write through to its target rather than
  // renaming a temp file onto the link (rename replaces the symlink node
  // with a regular file, silently severing a config.json that points into
  // a synced/encrypted dotfiles repo). resolveWriteTarget returns the real
  // path to write — preserving the link — even when the target file itself
  // doesn't exist yet (a freshly-decrypted dotfile).
  const target = await resolveWriteTarget(filePath);
  const dir = dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${randSuffix()}`;
  try {
    const writeOpts: { encoding: BufferEncoding; mode?: number } = {
      encoding: "utf8",
    };
    if (opts.mode !== undefined) {
      writeOpts.mode = opts.mode;
    }
    await fs.writeFile(tmp, body, writeOpts);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
  if (opts.mode !== undefined) {
    // Defensive: a previous (pre-atomic) write may have left the final
    // path with looser perms, and on some platforms fs.rename preserves
    // the destination's existing mode rather than the temp file's.
    try {
      fsSync.chmodSync(target, opts.mode);
    } catch {
      void 0;
    }
  }
}

// Resolve the path writeFileAtomic should rename onto. When `filePath` is a
// symlink we must write through to its target, because rename(2) onto a
// symlink replaces the link itself with a regular file. We resolve the
// link's destination (relative links are resolved against the link's dir)
// and realpath its parent directory so an intermediate symlink in the path
// (e.g. ~/netflix/private -> ~/private) is followed too. The target file
// need not exist — only its directory — so a symlink to a not-yet-present
// dotfile is re-materialized in place rather than clobbered.
async function resolveWriteTarget(filePath: string): Promise<string> {
  let lst: fsSync.Stats;
  try {
    lst = await fs.lstat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return filePath;
    }
    throw err;
  }
  if (!lst.isSymbolicLink()) {
    return filePath;
  }
  const dest = await fs.readlink(filePath);
  const abs = path.isAbsolute(dest)
    ? dest
    : path.resolve(path.dirname(filePath), dest);
  try {
    const realDir = await fs.realpath(path.dirname(abs));
    return path.join(realDir, path.basename(abs));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Target directory is missing too (deeper breakage); fall back to the
      // unresolved absolute path and let the write surface the real error.
      return abs;
    }
    throw err;
  }
}

export async function readJsonSafe<T = unknown>(
  filePath: string,
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
  if (raw.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function dirname(p: string): string {
  const slash = p.lastIndexOf("/");
  if (slash <= 0) {
    return ".";
  }
  return p.slice(0, slash);
}

function randSuffix(): string {
  return randomBytes(4).toString("hex");
}
