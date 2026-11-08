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

export interface FileListing {
  files: string[];
  // True when the listing stopped at the size cap, so it may be missing files.
  truncated: boolean;
}

// Fallback for a cwd that is not itself a repo. A nested repo is listed
// through git so its .gitignore applies, and is not descended into.
function walk(root: string, hidden: boolean): FileListing {
  const out: string[] = [];
  const queue = [""];
  let truncated = false;
  while (queue.length > 0) {
    if (out.length >= MAX_FILES) {
      truncated = true;
      break;
    }
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
      if ((!hidden && d.name.startsWith(".")) || SKIP_DIRS.has(d.name)) {
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
  return { files: out, truncated };
}

// Tracked and untracked-but-not-ignored files via git, else a bounded walk.
export function listProjectFilesUncached(cwd: string, hidden = false): FileListing {
  const files = gitFiles(cwd);
  if (files !== null) {
    return { files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
  }
  return walk(cwd, hidden);
}

const cache = new Map<string, { at: number; listing: FileListing }>();

export function listProjectFiles(cwd: string, hidden = false): FileListing {
  const now = Date.now();
  const key = `${cwd}\0${hidden ? "h" : "v"}`;
  const hit = cache.get(key);
  if (hit !== undefined && now - hit.at < CACHE_TTL_MS) {
    return hit.listing;
  }
  const raw = listProjectFilesUncached(cwd, hidden);
  const listing = { files: withDirectories(raw.files), truncated: raw.truncated };
  cache.set(key, { at: now, listing });
  return listing;
}

// A query naming a dot-entry (".bashr", "src/.en") opts in to hidden files,
// which the directory walk otherwise skips.
export function wantsHidden(query: string): boolean {
  return /(^|\/)\./.test(query.replace(/\\/g, "/"));
}

// What a committed "@" mention points at.
export type MentionTarget =
  | { kind: "file"; path: string }
  | { kind: "session"; id: string; title: string };

export interface MentionCandidate {
  // Shown in the candidate list.
  label: string;
  // The full "@token" inserted into the prompt.
  choice: string;
  // Null for text-only entries (a directory).
  target: MentionTarget | null;
}

export interface MentionCompletion {
  replacement: string;
  // Labels, parallel to `choices` and `targets`.
  candidates: string[];
  choices: string[];
  targets: Array<MentionTarget | null>;
  // Set when the token was committed to exactly one linkable target.
  target?: MentionTarget;
  // The file listing hit its size cap, so matches may be missing.
  truncated?: boolean;
}

// With session candidates in the list, the first few files stay on top and
// the sessions follow them, so the sessions are on screen rather than
// buried behind a screenful of files.
const FILE_SLOTS_WITH_EXTRAS = 15;
const FILES_BEFORE_EXTRAS = 2;

// For a listing that was cut short: how much of the query is a directory
// path that exists under the cwd ("dnload/foo/ma" -> base "dnload/foo/",
// rest "ma"), so the search can list just that subtree instead.
export function resolveScope(
  query: string,
  isDir: (rel: string) => boolean,
): { base: string; rest: string } {
  const segs = query.split("/");
  const last = segs.pop() ?? "";
  let base = "";
  while (segs.length > 0) {
    const seg = segs[0]!;
    if (seg === "" || seg === "." || seg === "..") {
      break;
    }
    const next = `${base}${seg}/`;
    if (!isDir(next)) {
      break;
    }
    base = next;
    segs.shift();
  }
  return { base, rest: [...segs, last].join("/") };
}

function defaultIsDirectory(abs: string): boolean {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
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
  listFiles: (cwd: string, hidden: boolean) => FileListing = listProjectFiles,
  isDirectory: (abs: string) => boolean = defaultIsDirectory,
  extra: MentionCandidate[] = [],
): MentionCompletion | null {
  if (!token.startsWith("@")) {
    return null;
  }
  const query = token.slice(1).replace(/\\ /g, " ").replace(/\\/g, "/");
  const hidden = wantsHidden(query);
  const listing = listFiles(cwd, hidden);
  let truncated = listing.truncated;
  let matches: string[] | null = null;
  if (listing.truncated) {
    // A cut-short listing can't see everywhere; search the typed directory.
    const scope = resolveScope(query, (rel) => isDirectory(path.join(cwd, rel)));
    if (scope.base !== "") {
      const sub = listFiles(path.join(cwd, scope.base), hidden);
      truncated = sub.truncated;
      matches = rankFiles(scope.rest, sub.files).map((f) => scope.base + f);
    }
  }
  matches ??= rankFiles(query, listing.files);
  const files = matches.slice(0, extra.length > 0 ? FILE_SLOTS_WITH_EXTRAS : matches.length);
  const asCandidate = (m: string): MentionCandidate => ({
    label: m,
    choice: `@${escapePath(m)}`,
    target: m.endsWith("/") ? null : { kind: "file", path: m },
  });
  const cands: MentionCandidate[] = [
    ...files.slice(0, FILES_BEFORE_EXTRAS).map(asCandidate),
    ...extra,
    ...files.slice(FILES_BEFORE_EXTRAS).map(asCandidate),
  ];
  if (cands.length === 0) {
    return null;
  }
  const base = {
    candidates: cands.map((c) => c.label),
    choices: cands.map((c) => c.choice),
    targets: cands.map((c) => c.target),
    truncated,
  };
  if (cands.length === 1) {
    const only = cands[0]!;
    return {
      ...base,
      replacement: only.choice,
      ...(only.target !== null ? { target: only.target } : {}),
    };
  }
  let common = longestCommonPrefix(cands.map((c) => c.choice.slice(1)));
  if (common.endsWith("\\")) {
    common = common.slice(0, -1);
  }
  const rawCommon = common.replace(/\\ /g, " ");
  const replacement =
    rawCommon.length > query.length &&
    rawCommon.toLowerCase().startsWith(query.toLowerCase())
      ? `@${common}`
      : token;
  return { ...base, replacement };
}

export interface ResourceLinkBlock {
  type: "resource_link";
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
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

export function sessionUri(id: string): string {
  return `hydra://sessions/${encodeURIComponent(id)}`;
}

// resource_link blocks for completed mentions still present in `text`.
// `mentions` maps the inserted "@token" to what it points at.
export function mentionBlocks(
  text: string,
  mentions: ReadonlyMap<string, MentionTarget>,
  cwd: string,
): ResourceLinkBlock[] {
  const out: ResourceLinkBlock[] = [];
  for (const [token, target] of mentions) {
    if (!mentionPresent(text, token)) {
      continue;
    }
    if (target.kind === "file") {
      out.push({
        type: "resource_link",
        uri: pathToFileURL(path.resolve(cwd, target.path)).href,
        name: target.path,
      });
    } else {
      out.push({
        type: "resource_link",
        uri: sessionUri(target.id),
        name: target.title.length > 0 ? target.title : target.id,
        description: `Hydra session ${target.id}; read it with: hydra session transcript ${target.id}`,
        mimeType: "text/markdown",
      });
    }
  }
  return out;
}
