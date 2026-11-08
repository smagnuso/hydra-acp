// "@" file mentions for the prompt composer. Tab on a token like "@fcomp"
// fuzzy-searches the session's files and substitutes the best path. The
// ranking and completion logic is pure; the file listing is injected so it
// can be tested without touching the real filesystem.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { longestCommonPrefix } from "./completion.js";

const MAX_FILES = 20000;
const MAX_CANDIDATES = 20;
const CACHE_TTL_MS = 5000;
const SKIP_DIRS = new Set([".git", "node_modules"]);
const SEGMENT_START = "/._-";

// Subsequence match, null when `query` is not a subsequence of `file`.
// Higher is better: contiguous runs, segment starts, and basename hits win,
// and shorter paths break ties.
export function fuzzyScore(query: string, file: string): number | null {
  const q = query.toLowerCase();
  const s = file.toLowerCase();
  if (q.length === 0) {
    return -file.length;
  }
  const body = s.endsWith("/") ? s.slice(0, -1) : s;
  const baseStart = body.lastIndexOf("/") + 1;
  let pos = 0;
  let prev = -2;
  let score = 0;
  for (const ch of q) {
    const idx = s.indexOf(ch, pos);
    if (idx === -1) {
      return null;
    }
    score += 1;
    if (idx === prev + 1) {
      score += 3;
    }
    if (idx === 0 || SEGMENT_START.includes(s[idx - 1] ?? "")) {
      score += 2;
    }
    if (idx >= baseStart) {
      score += 2;
    }
    prev = idx;
    pos = idx + 1;
  }
  if (s.slice(baseStart).startsWith(q)) {
    score += 10;
  }
  return score - file.length * 0.05;
}

// Unique ancestor directories of `files`, each with a trailing "/".
export function withDirectories(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    let idx = file.indexOf("/");
    while (idx !== -1) {
      dirs.add(file.slice(0, idx + 1));
      idx = file.indexOf("/", idx + 1);
    }
  }
  return [...files, ...dirs];
}

export function rankFiles(
  query: string,
  files: string[],
  limit: number = MAX_CANDIDATES,
): string[] {
  // Results are always forward-slashed; accept a Windows-typed query.
  const q = query.replace(/\\/g, "/");
  const scored: { file: string; score: number }[] = [];
  for (const file of files) {
    const score = fuzzyScore(q, file);
    if (score !== null) {
      scored.push({ file, score });
    }
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.file.length - b.file.length ||
      a.file.localeCompare(b.file),
  );
  return scored.slice(0, limit).map((s) => s.file);
}

function gitFiles(dir: string): string[] | null {
  try {
    const stdout = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    return stdout.split("\0").filter((f) => f.length > 0);
  } catch {
    return null;
  }
}

// Fallback for a cwd that is not itself a repo. A nested repo is listed
// through git so its .gitignore applies, and is not descended into.
function walk(root: string): string[] {
  const out: string[] = [];
  const queue = [""];
  while (queue.length > 0 && out.length < MAX_FILES) {
    const rel = queue.shift() as string;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    if (rel !== "" && dirents.some((d) => d.name === ".git")) {
      const nested = gitFiles(path.join(root, rel));
      if (nested !== null) {
        for (const f of nested) {
          out.push(`${rel}/${f}`);
        }
        continue;
      }
    }
    for (const d of dirents) {
      if (d.name.startsWith(".") || SKIP_DIRS.has(d.name)) {
        continue;
      }
      const child = rel === "" ? d.name : `${rel}/${d.name}`;
      if (d.isDirectory()) {
        queue.push(child);
      } else {
        out.push(child);
      }
    }
  }
  return out;
}

// Tracked and untracked-but-not-ignored files via git, else a bounded walk.
export function listProjectFilesUncached(cwd: string): string[] {
  const files = gitFiles(cwd);
  return files !== null ? files.slice(0, MAX_FILES) : walk(cwd);
}

let cache: { cwd: string; at: number; files: string[] } | null = null;

export function listProjectFiles(cwd: string): string[] {
  const now = Date.now();
  if (cache !== null && cache.cwd === cwd && now - cache.at < CACHE_TTL_MS) {
    return cache.files;
  }
  const files = withDirectories(listProjectFilesUncached(cwd));
  cache = { cwd, at: now, files };
  return files;
}

export interface MentionCompletion {
  replacement: string;
  candidates: string[];
  // Full "@path" token for each candidate, parallel to `candidates`.
  choices: string[];
  // Set when the token was committed to exactly one file (cwd-relative);
  // unset for a directory, which is sent as text only.
  file?: string;
}

function escapePath(p: string): string {
  return p.replace(/ /g, "\\ ");
}

// Complete an "@query" token. Returns null when the token is not a mention
// or nothing matches. A single match is committed in full; several matches
// extend the token to their common prefix (when that goes beyond what was
// typed) and are returned as candidates for the completion list.
export function completeAtMention(
  token: string,
  cwd: string,
  listFiles: (cwd: string) => string[] = listProjectFiles,
): MentionCompletion | null {
  if (!token.startsWith("@")) {
    return null;
  }
  const query = token.slice(1).replace(/\\ /g, " ").replace(/\\/g, "/");
  const matches = rankFiles(query, listFiles(cwd));
  if (matches.length === 0) {
    return null;
  }
  if (matches.length === 1) {
    return {
      replacement: `@${escapePath(matches[0]!)}`,
      candidates: matches,
      choices: matches.map((m) => `@${escapePath(m)}`),
      file: matches[0]!.endsWith("/") ? undefined : matches[0]!,
    };
  }
  const common = longestCommonPrefix(matches);
  const replacement =
    common.length > query.length && common.toLowerCase().startsWith(query.toLowerCase())
      ? `@${escapePath(common)}`
      : token;
  return {
    replacement,
    candidates: matches,
    choices: matches.map((m) => `@${escapePath(m)}`),
  };
}

export interface ResourceLinkBlock {
  type: "resource_link";
  uri: string;
  name: string;
}

function mentionPresent(text: string, token: string): boolean {
  let from = 0;
  for (;;) {
    const idx = text.indexOf(token, from);
    if (idx === -1) {
      return false;
    }
    const next = text[idx + token.length];
    if (next === undefined || /\s/.test(next)) {
      return true;
    }
    from = idx + 1;
  }
}

// resource_link blocks for completed mentions still present in `text`.
// `mentions` maps the inserted "@token" to its cwd-relative file.
export function mentionBlocks(
  text: string,
  mentions: ReadonlyMap<string, string>,
  cwd: string,
): ResourceLinkBlock[] {
  const out: ResourceLinkBlock[] = [];
  for (const [token, file] of mentions) {
    if (mentionPresent(text, token)) {
      out.push({
        type: "resource_link",
        uri: pathToFileURL(path.resolve(cwd, file)).href,
        name: file,
      });
    }
  }
  return out;
}
