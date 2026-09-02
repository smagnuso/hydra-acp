// Shared local-cwd validation. Used by `sessions import --cwd`, the
// TUI's import-cwd prompt, and (eventually) the daemon's
// /v1/sessions/import route so all three accept the same input shapes
// (tilde / $HOME expansion, relative paths, etc.) and report the same
// error reasons.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expandHome } from "./config.js";

// Ido/`substitute-in-file-name`-style "guess what you meant" collapsing:
// typing "~" right after a "/" (with nothing but another "/" or end of
// input following it) means "start over from home", and typing a second
// "/" right after a "/" means "start over from root" — in both cases
// whatever was typed before that point is noise, not an intentional
// directory component. Returns the index the effective path starts at
// (0 when neither pattern appears). Only the *rightmost* trigger wins,
// so "/a/~/b//c" collapses at the "//" (the later of the two triggers),
// not the "~/".
//
// Deliberately narrow: "~user" (not followed by "/" or end of input) is
// a literal path component, not a bare-home marker, so it does not
// trigger a collapse — matches `substitute-in-file-name`'s behavior of
// leaving "~foo/bar" alone.
//
export function pathShadowBoundary(text: string): number {
  let trigger = -1;
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== "/") {
      continue;
    }
    const next = text[i + 1];
    if (next === "/") {
      trigger = i;
    } else if (next === "~") {
      const after = text[i + 2];
      if (after === "/" || after === undefined) {
        trigger = i;
      }
    }
  }
  return trigger === -1 ? 0 : trigger + 1;
}

// Stricter sibling of pathShadowBoundary for live, destructive collapsing:
// a preview boundary is one keystroke ahead of what's actually safe to
// delete, on both branches. A dangling "~" might still grow into
// "~user" — a literal path component, not a home-dir marker — so it
// needs an explicit trailing "/" before it's safe to eat the prefix in
// front of it. And two slashes might still be a typo the user is about
// to backspace out of, rather than a deliberate "start over from root"
// — so a run of exactly two is left alone too; only once it grows to
// three (confirming it was deliberate) does the run collapse, down to
// the single trailing "/" that's left once the redundant ones are
// dropped. Once the whole line is being resolved instead of edited
// live (accept, or Tab-completed), neither caveat applies — that's what
// pathShadowBoundary is for.
export function pathShadowCommitBoundary(text: string): number {
  let boundary = 0;
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== "/") {
      continue;
    }
    const next = text[i + 1];
    if (next === "/") {
      let end = i;
      while (text[end] === "/") {
        end++;
      }
      if (end - i >= 3 && end - 1 > boundary) {
        boundary = end - 1;
      }
    } else if (next === "~" && text[i + 2] === "/") {
      if (i + 1 > boundary) {
        boundary = i + 1;
      }
    }
  }
  return boundary;
}

// Applies pathShadowBoundary and drops the shadowed prefix.
export function collapseTypedPath(text: string): string {
  return text.slice(pathShadowBoundary(text));
}

export type CwdValidation =
  | { ok: true; path: string }
  | { ok: false; reason: string };

export async function validateLocalCwd(input: string): Promise<CwdValidation> {
  const trimmed = collapseTypedPath(input.trim());
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
  rawInput: string,
): Promise<PathCompletion> {
  const input = collapseTypedPath(rawInput);
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
