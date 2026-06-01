// File-path tab completion for the prompt composer. Tab normally indents;
// when the whitespace-delimited token immediately before the cursor looks
// like a filesystem path, Tab instead completes it against the directory
// it names (relative to the session cwd, with ~ expanded). The pure pieces
// — token extraction, "is this a path", building the completed token — live
// here so they can be unit-tested without touching the real filesystem; the
// directory read is injected via the `listDir` callback.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { longestCommonPrefix } from "./completion.js";

// The whitespace-delimited run ending at the cursor, plus the column it
// starts at. Honors backslash-escaped spaces ("foo\ bar/") so paths with
// spaces complete as one token. Returns null when the cursor sits right
// after whitespace (empty token).
export function extractPathToken(
  line: string,
  col: number,
): { token: string; start: number } | null {
  let start = col;
  while (start > 0) {
    const ch = line[start - 1] ?? "";
    if (/\s/.test(ch)) {
      // A backslash immediately before the space escapes it — keep going.
      if (ch === " " && line[start - 2] === "\\") {
        start -= 2;
        continue;
      }
      break;
    }
    start -= 1;
  }
  if (start === col) {
    return null;
  }
  return { token: line.slice(start, col), start };
}

// Heuristic: a token is path-like if it contains a slash, or begins with a
// home/relative/absolute marker. Bare words (e.g. "hello") are left alone so
// Tab keeps indenting in ordinary prose.
export function looksLikePath(token: string): boolean {
  if (token.length === 0) {
    return false;
  }
  if (token.includes("/")) {
    return true;
  }
  return token === "~" || token === "." || token === "..";
}

// Strip backslash escapes (used for spaces) so the token can be fed to the
// filesystem; re-escaping happens when we rebuild the replacement.
function unescapeToken(token: string): string {
  return token.replace(/\\ /g, " ");
}

function escapeToken(token: string): string {
  return token.replace(/ /g, "\\ ");
}

// Split a (already unescaped) path token into the directory portion the user
// typed (verbatim, so we can paste it back) and the final base segment we're
// completing. "src/fo" → { dirPrefix: "src/", base: "fo" }; "fo" →
// { dirPrefix: "", base: "fo" }.
function splitToken(token: string): { dirPrefix: string; base: string } {
  const slash = token.lastIndexOf("/");
  if (slash === -1) {
    return { dirPrefix: "", base: token };
  }
  return { dirPrefix: token.slice(0, slash + 1), base: token.slice(slash + 1) };
}

// Resolve the directory a token's dirPrefix names into an absolute path,
// expanding a leading ~ and anchoring relative prefixes at `cwd`.
function resolveDir(dirPrefix: string, cwd: string): string {
  let p = dirPrefix.length === 0 ? "." : dirPrefix;
  if (p === "~" || p.startsWith("~/")) {
    p = os.homedir() + p.slice(1);
  }
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

export interface DirEntry {
  name: string;
  isDir: boolean;
}

export interface PathCompletion {
  // The token text to substitute for the original (escaped, with a trailing
  // "/" when the sole match is a directory).
  replacement: string;
  // Basenames of every candidate (directories carry a trailing "/"), for the
  // completion list. Single-element when the match is unambiguous.
  candidates: string[];
}

// Default directory lister: returns entries or null when the directory can't
// be read (missing / not a directory / permission denied).
export function readDir(dir: string): DirEntry[] | null {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  return dirents.map((d) => ({
    name: d.name,
    isDir: d.isDirectory(),
  }));
}

// Compute the completion for a path token. `listDir` is injected for tests;
// production callers pass `readDir`. Returns null when there's nothing to do
// (not path-like, unreadable directory, or no matching entries).
export function completePathToken(
  token: string,
  cwd: string,
  listDir: (dir: string) => DirEntry[] | null = readDir,
): PathCompletion | null {
  if (!looksLikePath(token)) {
    return null;
  }
  const raw = unescapeToken(token);
  const { dirPrefix, base } = splitToken(raw);
  const dir = resolveDir(dirPrefix, cwd);
  const entries = listDir(dir);
  if (entries === null) {
    return null;
  }
  // Hide dotfiles unless the user has started typing the leading dot.
  const showHidden = base.startsWith(".");
  const matched = entries.filter(
    (e) =>
      e.name.startsWith(base) && (showHidden || !e.name.startsWith(".")),
  );
  if (matched.length === 0) {
    return null;
  }
  const candidates = matched.map((e) => (e.isDir ? e.name + "/" : e.name));
  if (matched.length === 1) {
    const only = matched[0]!;
    const completedBase = only.isDir ? only.name + "/" : only.name;
    return {
      replacement: escapeToken(dirPrefix + completedBase),
      candidates,
    };
  }
  const common = longestCommonPrefix(matched.map((e) => e.name));
  return {
    replacement: escapeToken(dirPrefix + common),
    candidates,
  };
}
