// Substring search across recorded session transcripts. Exposed via
// GET /v1/sessions/search and surfaced in the picker's ^F mode. Scans
// each session's history.jsonl for matches in conversation text and
// tool inputs (file paths, commands, search patterns) — see
// extractSearchableFragments below for the exact field coverage.
//
// Out of scope for v1: tool *output* content blocks. A single Read of
// a large file produces a content array that can dwarf the rest of the
// session, so we skip it to keep scans bounded. Revisit if "find the
// session that read a file containing X" becomes a real need.
//
// The matcher is intentionally simple: case-insensitive substring,
// no regex, no token weighting. It runs synchronously per session
// (history files are read in their entirety by HistoryStore.load); the
// caller bounds work via maxSessions / maxSnippetsPerSession.

import type { SessionManager } from "./session-manager.js";
import type { HistoryEntry } from "./history-store.js";
import { sanitizeSingleLine, sanitizeWireText } from "./render-update.js";

export type SnippetKind =
  | "agent"
  | "user"
  | "thought"
  | "tool"
  | "tool-input";

export interface Snippet {
  kind: SnippetKind;
  // Tool name (e.g. "Edit", "Bash") for kind "tool" / "tool-input" when
  // the entry carried one. Lets the TUI render "Edit · …/src/foo.ts…"
  // so the user knows why the session matched.
  toolName?: string;
  text: string;
  recordedAt: number;
}

export interface SessionHits {
  sessionId: string;
  title?: string;
  cwd: string;
  status: "live" | "cold";
  updatedAt: string;
  // Total match occurrences in this session across all scanned
  // fragments, including matches beyond maxSnippetsPerSession. Lets the
  // TUI show "5 of 12 matches" honestly.
  totalMatches: number;
  snippets: Snippet[];
}

export interface SessionSearchResponse {
  query: string;
  truncated: boolean;
  results: SessionHits[];
}

export interface SearchOptions {
  sessionIds?: string[];
  maxSnippetsPerSession?: number;
  maxSessions?: number;
}

// Which fragment kinds to include when matching. Controlled by an
// optional per-term prefix:
//   prompt:foo   — user text only
//   response:foo — agent text + thoughts
//   tool:foo     — tool titles, names, rawInput, locations
//   foo          — all kinds (default)
export type SearchScope = "all" | "user" | "agent" | "tool";

export interface ParsedTerm {
  scope: SearchScope;
  term: string;
}

// A parsed query ready for matching. Multiple terms are joined by the
// operator:
//   AND — session must contain at least one match for EVERY term
//   OR  — session must contain at least one match for ANY term
//
// A single-term query always uses OR (the operator is irrelevant but
// set for consistency).
export interface ParsedQuery {
  operator: "AND" | "OR";
  terms: ParsedTerm[];
}

// Split a raw query into a ParsedQuery.
//
// Quoted strings are treated as literal terms and are protected from
// boolean splitting. Supported forms:
//   "foo"                     → literal all-scope term
//   prefix:"foo bar"          → literal term with scope prefix
//   foo AND bar               → AND of two terms
//   foo OR bar                → OR of two terms
//   "drag and drop"           → single literal term (AND not split)
//   prompt:"auth error" AND tool:Edit  → mixed scopes with AND
//
// Notes:
//   - AND/OR are case-insensitive and must be standalone tokens
//     (whitespace-delimited). To search for the word "and" literally,
//     quote it: `"and"`.
//   - If both AND and OR appear as operators, AND takes precedence.
//   - A bare prefix with no term after the colon (e.g. `tool:`) is
//     filtered out (empty term).
//
// Exported for testing.
export function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { operator: "OR", terms: [] };
  }

  // Tokenize: consume in priority order so `prefix:"quoted"` lands as
  // one token and bare `"quoted"` as another, before falling through to
  // a generic non-whitespace word.
  const tokenRe = /\w+:"[^"]*"|"[^"]*"|\S+/g;
  const tokens: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(trimmed)) !== null) {
    tokens.push(m[0]!);
  }

  let operator: "AND" | "OR" = "OR";
  let sawAnd = false;
  let sawOr = false;
  const termTokens: string[] = [];
  for (const tok of tokens) {
    const upper = tok.toUpperCase();
    if (upper === "AND") {
      sawAnd = true;
    } else if (upper === "OR") {
      sawOr = true;
    } else {
      termTokens.push(tok);
    }
  }
  // AND beats OR when mixed.
  if (sawAnd) {
    operator = "AND";
  } else if (sawOr) {
    operator = "OR";
  }

  const terms = termTokens
    .map((tok) => parseTermToken(tok))
    .filter((t) => t.term.length > 0);

  return { operator, terms };
}

// Parse one token into a (scope, term) pair. Handles four shapes:
//   prefix:"quoted"   → scoped literal
//   "quoted"          → all-scope literal
//   prefix:bare       → scoped bare word
//   bare              → all-scope bare word
function parseTermToken(tok: string): ParsedTerm {
  // prefix:"quoted" e.g. prompt:"drag and drop"
  const pq = /^(\w+):"([^"]*)"$/.exec(tok);
  if (pq) {
    return { scope: prefixToScope(pq[1]!), term: pq[2]! };
  }
  // "quoted" e.g. "drag and drop"
  const q = /^"([^"]*)"$/.exec(tok);
  if (q) {
    return { scope: "all", term: q[1]! };
  }
  // prefix:bare or bare
  const pb = /^(prompt|response|tool):([\s\S]*)$/i.exec(tok);
  if (pb) {
    return { scope: prefixToScope(pb[1]!), term: pb[2]!.trim() };
  }
  return { scope: "all", term: tok.trim() };
}

function prefixToScope(prefix: string): SearchScope {
  switch (prefix.toLowerCase()) {
    case "prompt":   return "user";
    case "response": return "agent";
    case "tool":     return "tool";
    default:         return "all";
  }
}

function scopeMatchesKind(scope: SearchScope, kind: SnippetKind): boolean {
  if (scope === "all") {
    return true;
  }
  if (scope === "user") {
    return kind === "user";
  }
  if (scope === "agent") {
    return kind === "agent" || kind === "thought";
  }
  // scope === "tool"
  return kind === "tool" || kind === "tool-input";
}

const DEFAULT_MAX_SNIPPETS_PER_SESSION = 5;
const DEFAULT_MAX_SESSIONS = 200;
// Half-width on each side of the match in a snippet. The snippet ends
// up roughly SNIPPET_SIDE * 2 + matchLen chars before ellipses; a typical
// terminal row can show this comfortably alongside the row prefix.
const SNIPPET_SIDE = 30;

export async function searchHistories(
  manager: SessionManager,
  query: string,
  opts: SearchOptions = {},
): Promise<SessionSearchResponse> {
  const parsed = parseQuery(query);
  if (parsed.terms.length === 0) {
    return { query, truncated: false, results: [] };
  }
  const maxPerSession =
    opts.maxSnippetsPerSession ?? DEFAULT_MAX_SNIPPETS_PER_SESSION;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const allow = opts.sessionIds ? new Set(opts.sessionIds) : null;

  const all = await manager.list();
  const candidates = allow ? all.filter((s) => allow.has(s.sessionId)) : all;

  const results: SessionHits[] = [];
  let truncated = false;
  for (const candidate of candidates) {
    if (results.length >= maxSessions) {
      truncated = true;
      break;
    }
    const entries = await manager.loadHistory(candidate.sessionId).catch(
      () => [] as HistoryEntry[],
    );
    const found = scanSessionEntries(entries, parsed, maxPerSession);
    if (found.snippets.length === 0) {
      continue;
    }
    const hit: SessionHits = {
      sessionId: candidate.sessionId,
      cwd: candidate.cwd,
      status: candidate.status,
      updatedAt: candidate.updatedAt,
      totalMatches: found.totalMatches,
      snippets: found.snippets,
    };
    if (candidate.title !== undefined) {
      hit.title = candidate.title;
    }
    results.push(hit);
  }
  return { query, truncated, results };
}

interface ScanResult {
  totalMatches: number;
  snippets: Snippet[];
}

// Visible for testing — drives one session's entries against a ParsedQuery.
// For OR queries, any matching term contributes snippets and the session
// qualifies. For AND queries, EVERY term must have at least one match;
// if any term misses the function returns an empty result so the caller
// skips the session.
export function scanSessionEntries(
  entries: ReadonlyArray<HistoryEntry>,
  query: ParsedQuery,
  maxSnippets: number,
): ScanResult {
  if (query.terms.length === 0) {
    return { totalMatches: 0, snippets: [] };
  }
  let totalMatches = 0;
  const snippets: Snippet[] = [];
  for (const { scope, term } of query.terms) {
    const result = scanForTerm(entries, term, scope, maxSnippets - snippets.length);
    if (query.operator === "AND" && result.totalMatches === 0) {
      // Short-circuit: this term has no matches, so the AND fails.
      return { totalMatches: 0, snippets: [] };
    }
    totalMatches += result.totalMatches;
    snippets.push(...result.snippets);
  }
  return { totalMatches, snippets };
}

// Scan entries for a single term+scope pair, collecting up to
// snippetBudget snippets. One snippet per matching fragment — see the
// comment on scanSessionEntries above for the rationale.
function scanForTerm(
  entries: ReadonlyArray<HistoryEntry>,
  term: string,
  scope: SearchScope,
  snippetBudget: number,
): ScanResult {
  const needle = term.toLowerCase();
  let totalMatches = 0;
  const snippets: Snippet[] = [];
  for (const entry of entries) {
    const fragments = extractSearchableFragments(entry).filter((f) =>
      scopeMatchesKind(scope, f.kind),
    );
    for (const frag of fragments) {
      const hay = frag.text.toLowerCase();
      let idx = hay.indexOf(needle);
      if (idx === -1) {
        continue;
      }
      let occurrences = 0;
      while (idx !== -1) {
        occurrences++;
        idx = hay.indexOf(needle, idx + needle.length);
      }
      totalMatches += occurrences;
      if (snippets.length < snippetBudget) {
        const first = hay.indexOf(needle);
        const snippet: Snippet = {
          kind: frag.kind,
          text: buildSnippet(frag.text, first, needle.length),
          recordedAt: entry.recordedAt,
        };
        if (frag.toolName !== undefined) {
          snippet.toolName = frag.toolName;
        }
        snippets.push(snippet);
      }
    }
  }
  return { totalMatches, snippets };
}

interface Fragment {
  kind: SnippetKind;
  toolName?: string;
  text: string;
}

// Pull every searchable haystack out of one HistoryEntry. May emit
// several fragments for a single tool_call (title, name, rawInput,
// locations) so that, say, a "foo.ts" match on rawInput.file_path
// produces a separate snippet from a "Edit" match on the tool name.
// Mirrors the field reads in render-update.ts's mapToolCall and
// extractContentText — keep these in lockstep.
export function extractSearchableFragments(entry: HistoryEntry): Fragment[] {
  if (entry.method !== "session/update") {
    return [];
  }
  const params = entry.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return [];
  }
  const update = (params as { update?: unknown }).update;
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    return [];
  }
  const u = update as Record<string, unknown>;
  const tag = typeof u.sessionUpdate === "string" ? u.sessionUpdate : u.kind;
  if (typeof tag !== "string") {
    return [];
  }
  switch (tag) {
    case "agent_message_chunk": {
      const text = readContentText(u.content);
      return text ? [{ kind: "agent", text }] : [];
    }
    case "agent_thought":
    case "agent_thought_chunk": {
      const text =
        typeof u.text === "string"
          ? sanitizeWireText(u.text)
          : readContentText(u.content);
      return text ? [{ kind: "thought", text }] : [];
    }
    case "user_message_chunk": {
      // Compat duplicate of prompt_received emitted by hydra; mapUserText
      // skips it during render, and so do we.
      if (isCompatPromptReceived(u)) {
        return [];
      }
      const text = readContentText(u.content);
      return text ? [{ kind: "user", text }] : [];
    }
    case "prompt_received": {
      const text = readPromptText(u.prompt);
      return text ? [{ kind: "user", text }] : [];
    }
    case "tool_call":
    case "tool_call_update": {
      return extractToolFragments(u);
    }
    default:
      return [];
  }
}

function extractToolFragments(u: Record<string, unknown>): Fragment[] {
  const toolName = readString(u, "name");
  const title = readString(u, "title");
  const out: Fragment[] = [];
  // Title and name are searched separately so a query on "Bash" or
  // "Edit" matches via the name path while a query on the bash command
  // line matches via rawInput.
  if (title !== undefined) {
    const sanitized = sanitizeSingleLine(title);
    if (sanitized.length > 0) {
      const frag: Fragment = { kind: "tool", text: sanitized };
      if (toolName !== undefined) {
        frag.toolName = toolName;
      }
      out.push(frag);
    }
  }
  if (toolName !== undefined && toolName !== title) {
    const sanitized = sanitizeSingleLine(toolName);
    if (sanitized.length > 0) {
      out.push({ kind: "tool", toolName, text: sanitized });
    }
  }
  const rawInput = u.rawInput;
  if (rawInput && typeof rawInput === "object") {
    const serialized = safeStringify(rawInput);
    if (serialized.length > 0) {
      const frag: Fragment = {
        kind: "tool-input",
        text: sanitizeSingleLine(serialized),
      };
      if (toolName !== undefined) {
        frag.toolName = toolName;
      }
      out.push(frag);
    }
  }
  const locations = u.locations;
  if (Array.isArray(locations) && locations.length > 0) {
    const serialized = safeStringify(locations);
    if (serialized.length > 0) {
      const frag: Fragment = {
        kind: "tool-input",
        text: sanitizeSingleLine(serialized),
      };
      if (toolName !== undefined) {
        frag.toolName = toolName;
      }
      out.push(frag);
    }
  }
  const errorText = extractToolErrorText(u);
  if (errorText !== null) {
    const frag: Fragment = { kind: "tool", text: errorText };
    if (toolName !== undefined) {
      frag.toolName = toolName;
    }
    out.push(frag);
  }
  return out;
}

// Failure text from a tool_call_update. Two on-disk shapes (per
// render-update.ts:455 extractToolFailureText): content[].content.text
// (ACP canonical) and rawOutput.error (fallback). Inlined here rather
// than imported because that helper is private to render-update.
function extractToolErrorText(u: Record<string, unknown>): string | null {
  const content = u.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as { content?: unknown };
      const inner = b.content;
      if (!inner || typeof inner !== "object") {
        continue;
      }
      const i = inner as { type?: unknown; text?: unknown };
      if (i.type === "text" && typeof i.text === "string") {
        const s = sanitizeSingleLine(i.text);
        if (s.length > 0) {
          return s;
        }
      }
    }
  }
  const rawOutput = u.rawOutput;
  if (rawOutput && typeof rawOutput === "object") {
    const err = (rawOutput as { error?: unknown }).error;
    if (typeof err === "string") {
      const s = sanitizeSingleLine(err);
      if (s.length > 0) {
        return s;
      }
    }
  }
  return null;
}

function isCompatPromptReceived(u: Record<string, unknown>): boolean {
  const meta = u._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return false;
  }
  const hydra = (meta as Record<string, unknown>)["hydra-acp"];
  if (!hydra || typeof hydra !== "object" || Array.isArray(hydra)) {
    return false;
  }
  return (
    (hydra as Record<string, unknown>).compatFor === "prompt_received"
  );
}

function readContentText(content: unknown): string {
  if (typeof content === "string") {
    return sanitizeWireText(content);
  }
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return "";
  }
  const c = content as { type?: unknown; text?: unknown };
  if (typeof c.text === "string") {
    return sanitizeWireText(c.text);
  }
  return "";
}

function readPromptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of prompt) {
    const text = readContentText(block);
    if (text.length > 0) {
      parts.push(text);
    }
  }
  return parts.join("");
}

function readString(
  u: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = u[key];
  return typeof v === "string" ? v : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

// Build a snippet centered on a match. The result fits in a single
// terminal row; sanitizeSingleLine is applied by the caller for tool
// fragments (which can carry braces/newlines from JSON.stringify), but
// here we still collapse stray whitespace to keep multi-line text
// readable in one row.
export function buildSnippet(
  text: string,
  matchIdx: number,
  matchLen: number,
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) {
    return "";
  }
  // matchIdx was computed against the original `text` (lowercased), so
  // re-find on the flattened version when whitespace collapse shifted
  // the position. Best-effort: if the match isn't found (sanitization
  // dropped it), fall back to the head of the string.
  const flatLower = flat.toLowerCase();
  const needleSlice = text
    .slice(matchIdx, matchIdx + matchLen)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  let pos = needleSlice.length > 0 ? flatLower.indexOf(needleSlice) : 0;
  if (pos === -1) {
    pos = 0;
  }
  const start = Math.max(0, pos - SNIPPET_SIDE);
  const end = Math.min(flat.length, pos + needleSlice.length + SNIPPET_SIDE);
  const head = start > 0 ? "…" : "";
  const tail = end < flat.length ? "…" : "";
  return `${head}${flat.slice(start, end)}${tail}`;
}
