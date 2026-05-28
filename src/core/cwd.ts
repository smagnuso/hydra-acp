// Shared local-cwd validation. Used by `sessions import --cwd`, the
// TUI's import-cwd prompt, and (eventually) the daemon's
// /v1/sessions/import route so all three accept the same input shapes
// (tilde / $HOME expansion, relative paths, etc.) and report the same
// error reasons.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expandHome } from "./config.js";

export type CwdValidation =
  | { ok: true; path: string }
  | { ok: false; reason: string };

export async function validateLocalCwd(input: string): Promise<CwdValidation> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "path is empty" };
  }
  const resolved = path.resolve(expandHome(trimmed));
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolved);
  } catch {
    return { ok: false, reason: `${resolved} does not exist` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: `${resolved} is not a directory` };
  }
  return { ok: true, path: resolved };
}

// Heuristic default for the "pick a local cwd" prompt on imported
// sessions. Tries the recorded cwd as-is, then a /Users ↔ /home prefix
// swap so a session recorded on macOS opens cleanly on Linux (and vice
// versa) when the per-user subpath is identical. Returns the first
// existing directory, or null if neither resolves.
export async function pickInitialLocalCwd(
  sessionCwd: string,
): Promise<string | null> {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (p: string): void => {
    if (!seen.has(p)) {
      seen.add(p);
      candidates.push(p);
    }
  };
  push(sessionCwd);
  if (sessionCwd.startsWith("/Users/")) {
    push("/home/" + sessionCwd.slice("/Users/".length));
  } else if (sessionCwd.startsWith("/home/")) {
    push("/Users/" + sessionCwd.slice("/home/".length));
  }
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
      // try next
    }
  }
  return null;
}

export interface PathCompletion {
  // The portion of the input before the basename (including any
  // trailing "/"). Preserves a leading "~/" so the caller can rebuild
  // the buffer with the tilde intact.
  prefix: string;
  // The typed basename prefix the matches were filtered against.
  basePrefix: string;
  // Matching directory entries (basenames only). Directories carry a
  // trailing "/". Sorted alphabetically.
  matches: string[];
}

// Filesystem-backed path completion for the import-cwd prompt. Splits
// the input on the last "/" and lists entries in that directory whose
// basename starts with the typed prefix. Hides dot-prefixed names
// unless the user is explicitly typing a dotfile prefix.
export async function completeLocalPath(
  input: string,
): Promise<PathCompletion> {
  const lastSlash = input.lastIndexOf("/");
  let prefix: string;
  let basePrefix: string;
  let dirForRead: string;
  if (lastSlash === -1) {
    prefix = "";
    basePrefix = input;
    dirForRead = ".";
  } else {
    prefix = input.slice(0, lastSlash + 1);
    basePrefix = input.slice(lastSlash + 1);
    dirForRead = lastSlash === 0 ? "/" : prefix;
  }
  const resolvedDir = path.resolve(expandHome(dirForRead));
  let entries: { name: string; isDir: boolean }[];
  try {
    const list = await fs.readdir(resolvedDir, { withFileTypes: true });
    entries = list.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return { prefix, basePrefix, matches: [] };
  }
  const showHidden = basePrefix.startsWith(".");
  const matches = entries
    .filter((e) => e.name.startsWith(basePrefix))
    .filter((e) => showHidden || !e.name.startsWith("."))
    .map((e) => (e.isDir ? `${e.name}/` : e.name))
    .sort();
  return { prefix, basePrefix, matches };
}
