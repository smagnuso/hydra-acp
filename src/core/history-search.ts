// Substring search across recorded session transcripts. Exposed via
// GET /v1/sessions/search and surfaced in the picker's ^F mode. Scans
// each session's history.jsonl for matches in conversation text and
// tool inputs (file paths, commands, search patterns) — see
// extractSearchableFragments below for the exact field coverage.
//
// Out of scope for v1: tool *output* content blocks. A single Read of
// a large file produces a content array that can dwarf the rest of the
// session, so we skip it to keep scans bounded. Revisit if "find the
// session that read a file containing X" becomes a real need. Two
// things enforce this and both matter: the status gate in
// extractToolErrorText, and loading histories with tools:"references"
// so externalized blobs are never inflated.
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
  | "tool-input"
  // One edited file path, emitted only for tool calls carrying an edit
  // payload. Unlike "tool-input" (which is the whole rawInput serialized,
  // so a Read of a path looks identical to a Write of it), an "edit"
  // fragment is evidence the session CHANGED that file. Reachable only
  // via the `edit:` scope — see scopeMatchesKind.
  | "edit";

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
  status: "warm" | "cold";
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
  // Target width in characters for each snippet, match text included.
  // The caller knows how much room it has to paint; a fixed server-side
  // width either wastes half a wide terminal or overflows a narrow one.
  // Clamped to [MIN_SNIPPET_WIDTH, MAX_SNIPPET_WIDTH].
  snippetWidth?: number;
}

// Which fragment kinds to include when matching. Controlled by an
// optional per-term prefix:
//   prompt:foo   — user text only
//   response:foo — agent text + thoughts
//   tool:foo     — tool titles, names, rawInput, locations
//   edit:foo     — paths of files the session CHANGED (see SnippetKind
//                  "edit"); matched on path-segment boundaries rather
//                  than as a raw substring
//   foo          — all kinds (default)
export type SearchScope = "all" | "user" | "agent" | "tool" | "edit";

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
  // `changed:` is deliberately NOT an alias — it shows up in prose and
  // in status output ("changed: 3 files"), and claiming the prefix would
  // silently turn a literal search into a path search.
  const pb = /^(prompt|response|tool|edit|edited):([\s\S]*)$/i.exec(tok);
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
    case "edit":
    case "edited":   return "edit";
    default:         return "all";
  }
}

function scopeMatchesKind(scope: SearchScope, kind: SnippetKind): boolean {
  // "edit" fragments are a projection of data already covered by
  // "tool-input" (the path is in the serialized rawInput too), so they
  // are reachable ONLY via the edit: scope. Letting scope "all" see them
  // would double-count every edit and emit a near-duplicate snippet
  // beside the tool-input one.
  if (kind === "edit") {
    return scope === "edit";
  }
  if (scope === "edit") {
    return false;
  }
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
// Default total snippet width when the caller doesn't say how much room
// it has. Sized for an 80-column terminal minus the row indent.
const DEFAULT_SNIPPET_WIDTH = 72;
// Floor keeps a pathologically narrow request from producing snippets
// that are all ellipsis; ceiling bounds the response size for a caller
// that asks for something absurd.
const MIN_SNIPPET_WIDTH = 24;
const MAX_SNIPPET_WIDTH = 512;

function clampSnippetWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return DEFAULT_SNIPPET_WIDTH;
  }
  return Math.max(MIN_SNIPPET_WIDTH, Math.min(MAX_SNIPPET_WIDTH, Math.floor(width)));
}

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
  const snippetWidth = clampSnippetWidth(
    opts.snippetWidth ?? DEFAULT_SNIPPET_WIDTH,
  );
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
    // tools: "references" — we never index tool output, so inflating the
    // externalized blobs would be pure I/O for nothing (and, before the
    // status gate in extractToolErrorText, was how megabytes of spilled
    // Read output leaked into the index).
    const entries = await manager
      .loadHistory(candidate.sessionId, { tools: "references" })
      .catch(() => [] as HistoryEntry[]);
    const found = scanSessionEntries(
      entries,
      parsed,
      maxPerSession,
      snippetWidth,
      workspacePathNormalizer(candidate),
    );
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

// For a workspace-isolated session, rewrite an edited path from workspace
// coordinates into source-tree coordinates.
//
// This is what makes `edit:/abs/path/to/repo/src` find isolated sessions
// at all. An isolated session's `cwd` IS its workspace (a hash directory
// under ~/.hydra-acp/workspaces), and every file it edits is under there,
// so an absolute query naming the real checkout matches nothing without
// this — and planner workers, which are the sessions you are most often
// hunting for, are exactly the isolated ones.
//
// Returns undefined for ordinary sessions so the scan pays nothing.
export function workspacePathNormalizer(
  session: { cwd: string; workspace?: { sourceCwd: string } },
): ((p: string) => string) | undefined {
  const source = session.workspace?.sourceCwd;
  if (source === undefined || source.length === 0 || session.cwd.length === 0) {
    return undefined;
  }
  const prefix = session.cwd.endsWith("/") ? session.cwd : session.cwd + "/";
  return (p: string): string =>
    p.startsWith(prefix) ? source.replace(/\/+$/, "") + "/" + p.slice(prefix.length) : p;
}

// Visible for testing — drives one session's entries against a ParsedQuery.
// For OR queries, any matching term contributes snippets and the session
// qualifies. For AND queries, EVERY term must have at least one match;
// if any term misses the function returns an empty result so the caller
// skips the session. Snippets are budgeted per term (see below) so an
// AND hit shows evidence for each term, not just the first.
export function scanSessionEntries(
  entries: ReadonlyArray<HistoryEntry>,
  query: ParsedQuery,
  maxSnippets: number,
  snippetWidth: number = DEFAULT_SNIPPET_WIDTH,
  // Maps an edited path into the coordinates the caller asked in. Set for
  // workspace-isolated sessions, where every edit lands under the
  // workspace but the question is always asked about the source tree —
  // see workspacePathNormalizer.
  normalizeEditPath?: (p: string) => string,
): ScanResult {
  if (query.terms.length === 0) {
    return { totalMatches: 0, snippets: [] };
  }
  let totalMatches = 0;
  const snippets: Snippet[] = [];
  // Budget snippets per term rather than first-come-first-served. A
  // high-frequency first term would otherwise eat the whole budget and
  // the row would render evidence for only one term of an AND query,
  // which reads as a false positive.
  const perTerm = Math.max(1, Math.floor(maxSnippets / query.terms.length));
  const spare: Snippet[] = [];
  for (const { scope, term } of query.terms) {
    const result = scanForTerm(
      entries,
      term,
      scope,
      maxSnippets,
      snippetWidth,
      normalizeEditPath,
    );
    if (query.operator === "AND" && result.totalMatches === 0) {
      // Short-circuit: this term has no matches, so the AND fails.
      return { totalMatches: 0, snippets: [] };
    }
    totalMatches += result.totalMatches;
    snippets.push(...result.snippets.slice(0, perTerm));
    spare.push(...result.snippets.slice(perTerm));
  }
  // Redistribute any budget the low-yield terms didn't use.
  for (const s of spare) {
    if (snippets.length >= maxSnippets) {
      break;
    }
    snippets.push(s);
  }
  return { totalMatches, snippets: snippets.slice(0, maxSnippets) };
}

// Scan entries for a single term+scope pair, collecting up to
// snippetBudget snippets. One snippet per matching fragment — see the
// comment on scanSessionEntries above for the rationale.
function scanForTerm(
  entries: ReadonlyArray<HistoryEntry>,
  term: string,
  scope: SearchScope,
  snippetBudget: number,
  snippetWidth: number,
  normalizeEditPath?: (p: string) => string,
): ScanResult {
  const needle = term.toLowerCase();
  let totalMatches = 0;
  const snippets: Snippet[] = [];
  // Edit fragments repeat: a single Edit call emits its path on the
  // initial tool_call and again on every tool_call_update, and a session
  // usually edits the same file many times. Counting each sighting would
  // make totalMatches meaningless and would spend the whole snippet
  // budget re-showing one path, so an edit: query counts DISTINCT files.
  // "3 of 12" then reads as 12 files changed, 3 shown.
  const seenEditPaths = new Set<string>();
  for (const entry of entries) {
    const fragments = extractSearchableFragments(entry).filter((f) =>
      scopeMatchesKind(scope, f.kind),
    );
    for (const frag of fragments) {
      const hay = frag.text.toLowerCase();
      // Edit fragments are a single path, matched on segment boundaries
      // rather than as a substring, and each counts once: the fragment
      // either names a file under the query or it doesn't. Snippet text
      // is the whole path (no windowing) since that IS the answer.
      if (frag.kind === "edit") {
        // Match on either coordinate — the real path, or (for an isolated
        // session) its source-tree equivalent — so a query naming the
        // workspace and a query naming the checkout both find it. Report
        // the real one: that an edit landed in a workspace is information,
        // not noise.
        const normalized = normalizeEditPath?.(frag.text);
        const matched =
          pathMatchesSegments(frag.text, term) ||
          (normalized !== undefined && normalized !== frag.text
            ? pathMatchesSegments(normalized, term)
            : false);
        if (!matched) {
          continue;
        }
        if (seenEditPaths.has(frag.text)) {
          continue;
        }
        seenEditPaths.add(frag.text);
        totalMatches += 1;
        if (snippets.length < snippetBudget) {
          const snippet: Snippet = {
            kind: "edit",
            text: frag.text,
            recordedAt: entry.recordedAt,
          };
          if (frag.toolName !== undefined) {
            snippet.toolName = frag.toolName;
          }
          snippets.push(snippet);
        }
        continue;
      }
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
          text: buildSnippet(frag.text, first, needle.length, snippetWidth),
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
  for (const path of editedPaths(u)) {
    const frag: Fragment = { kind: "edit", text: path };
    if (toolName !== undefined) {
      frag.toolName = toolName;
    }
    out.push(frag);
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

// Paths of files this tool call CHANGED, deduped within the call.
//
// Same carrier vocabulary as history-edits.ts's extractRawEdits and
// render-update.ts's extractEditDiff — canonical content[] type:"diff",
// plus Claude's Edit / Write / MultiEdit rawInput shapes — with one
// deliberate difference: those two gate on the body being a `string`,
// because they need the text to build a hunk. We only need the path, so
// we gate on the body field being *present*. That matters here and
// nowhere else: histories are loaded with tools:"references", so any
// body over TOOL_BLOB_THRESHOLD is a { __hydraBlob } object rather than
// a string, and a string-gated read silently drops exactly the largest
// writes a session made.
//
// Deliberately over-includes: an unknown MCP tool taking both a path and
// a content-ish field reads as an edit. Prefer that to missing real ones,
// and the caller is asking "who changed this file", not counting.
function editedPaths(u: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: unknown): void => {
    if (typeof p !== "string" || p.length === 0 || seen.has(p)) {
      return;
    }
    seen.add(p);
    out.push(p);
  };
  const content = u.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as Record<string, unknown>;
      if (b.type === "diff") {
        push(b.path);
      }
    }
  }
  const rawInput = u.rawInput;
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const r = rawInput as Record<string, unknown>;
    const carriesEdit =
      r.old_string !== undefined ||
      r.new_string !== undefined ||
      r.content !== undefined ||
      Array.isArray(r.edits);
    if (carriesEdit) {
      push(typeof r.file_path === "string" ? r.file_path : r.path);
    }
  }
  return out;
}

// True when `needle` names `path` itself or an ancestor directory of it,
// aligned to path separators. An absolute needle is a subtree test; a
// relative one may match any run of whole segments, so `src/tui` finds
// /home/u/repo/src/tui/app.ts and `app.ts` finds it too, while `foo`
// does not match /dev/foobar.
//
// Case-insensitive, consistent with every other scope. On a
// case-sensitive filesystem that can over-match (/Users vs /users); the
// alternative is a scope that behaves differently from the rest of the
// search box, which is worse.
export function pathMatchesSegments(path: string, needle: string): boolean {
  const hay = trimTrailingSlash(path.toLowerCase());
  const nee = trimTrailingSlash(needle.toLowerCase());
  if (nee.length === 0) {
    return false;
  }
  if (nee.startsWith("/")) {
    return hay === nee || hay.startsWith(nee + "/");
  }
  // Relative: require a leading separator (or start-of-path) and a
  // trailing separator (or end-of-path) so only whole segments match.
  const probe = "/" + nee;
  let idx = hay.indexOf(probe);
  while (idx !== -1) {
    const after = idx + probe.length;
    if (after === hay.length || hay[after] === "/") {
      return true;
    }
    idx = hay.indexOf(probe, idx + 1);
  }
  return hay === nee || hay.startsWith(nee + "/");
}

function trimTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

// Failure text from a tool_call_update. Two on-disk shapes (per
// render-update.ts:455 extractToolFailureText): content[].content.text
// (ACP canonical) and rawOutput.error (fallback). Inlined here rather
// than imported because that helper is private to render-update.
//
// The status gate is load-bearing: on a *successful* tool call the
// content[] blocks hold the tool's normal output, which the header
// comment says we deliberately don't index. Without the gate every
// tool result in every session lands in the index mislabeled as error
// text.
function extractToolErrorText(u: Record<string, unknown>): string | null {
  if (!isFailedToolStatus(u.status)) {
    return null;
  }
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

// Mirrors the failure-ish statuses render-update.ts:876 treats as
// terminal-with-a-reason. "completed" is excluded on purpose.
function isFailedToolStatus(status: unknown): boolean {
  return (
    status === "failed" || status === "rejected" || status === "cancelled"
  );
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
  width: number = DEFAULT_SNIPPET_WIDTH,
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
  // Budget the context around the match, then spend whatever one side
  // can't use on the other — a match near the start of the fragment
  // should still fill the row with trailing context rather than leaving
  // the right half blank.
  const target = clampSnippetWidth(width);
  const context = Math.max(0, target - needleSlice.length);
  const half = Math.floor(context / 2);
  const wantBefore = Math.min(half, pos);
  const wantAfter = Math.min(
    context - wantBefore,
    flat.length - (pos + needleSlice.length),
  );
  const start = Math.max(0, pos - (context - wantAfter));
  const end = Math.min(flat.length, pos + needleSlice.length + wantAfter);
  const head = start > 0 ? "…" : "";
  const tail = end < flat.length ? "…" : "";
  return `${head}${flat.slice(start, end)}${tail}`;
}
