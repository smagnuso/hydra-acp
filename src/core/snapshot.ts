// Parsing helpers for title+synopsis regen and compaction replies from agents.
//
// runSnapshotRegen asks the agent to reply with a single JSON object of
// shape { title: string, synopsis: { goal, outcome, files_touched[],
// tools_used[], rejected_approaches[], open_threads[] } }, with explicit
// "no prose, no markdown, no code fences" instructions. Agents are
// usually well-behaved here but occasionally prepend a preamble like
// "Here you go:" before the JSON, and occasionally produce a partial
// reply (title without synopsis or vice versa).
//
// tryParseSnapshot returns whatever it can parse:
//   - strict JSON.parse first (the common case);
//   - on failure, regex-extract the first {...} block (catches the
//     preamble case);
//   - validate title and synopsis independently so a malformed synopsis
//     doesn't lose the title;
//   - return undefined when nothing useful parsed.
//
// tryParseCompaction handles the compaction reply shape — a flat JSON
// object with all fields at the top level (title + synopsis fields). It
// uses the same parse strategy but validates against the extended schema.
//
// The SessionSynopsis type lives here (rather than in session-store.ts)
// because it's primarily about the agent-reply contract; the persisted
// record imports it.

import { z } from "zod";

export const SessionSynopsis = z.object({
  goal: z.string().optional(),
  outcome: z.string().optional(),
  files_touched: z.array(z.string()).optional(),
  tools_used: z.array(z.string()).optional(),
  rejected_approaches: z.array(z.string()).optional(),
  open_threads: z.array(z.string()).optional(),
  decisions: z.array(z.string()).optional(),
  file_edit_intentions: z.array(z.string()).optional(),
  unresolved_errors: z.array(z.string()).optional(),
  tool_state: z.array(z.string()).optional(),
});
export type SessionSynopsis = z.infer<typeof SessionSynopsis>;

// Cap the parsed title so an over-eager agent (or a model that ignored
// the ≤80 chars instruction) doesn't blow out the snapshot. Title bar
// renders truncate anyway; this is a safety bound on what we persist.
const MAX_TITLE_LEN = 200;

// The synopsis prompt sent to the agent at idle-close / shutdown /
// picker T / `/hydra title` no-arg. Asks for a single JSON object with
// title and the *qualitative* synopsis fields only — files_touched and
// tools_used are computed locally from history.jsonl (see
// history-aggregate.ts) and merged in after, so the agent doesn't have
// to enumerate them. That shrinks the output and removes a hallucination
// risk: the agent can't claim it touched a file it didn't, because we
// don't ask.
//
// Output guidance is deliberately verbose — modern models follow "no
// prose, no markdown, no code fences" pretty reliably, but the JSON-
// extraction fallback in tryParseSnapshot handles the preamble/fence
// cases when they slip through.
export const SNAPSHOT_PROMPT =
  "Reply with ONLY a JSON object with exactly these keys, no prose, no markdown, no code fences:\n" +
  "{\n" +
  '  "title": "short summary, max 80 chars",\n' +
  '  "synopsis": {\n' +
  '    "goal": "the user\'s original ask",\n' +
  '    "outcome": "what was concluded or shipped",\n' +
  '    "rejected_approaches": ["things tried and abandoned"],\n' +
  '    "open_threads": ["work started but not finished"]\n' +
  "  }\n" +
  "}\n" +
  "Use empty arrays/strings where a field doesn't apply.";

export interface SnapshotParseResult {
  title?: string;
  synopsis?: SessionSynopsis;
}

export function tryParseSnapshot(raw: string): SnapshotParseResult | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  // Strict parse first.
  let parsed: unknown = safeJsonParse(trimmed);

  // Fall back to extracting the first {...} block. Greedy: take the first
  // `{` through the last `}`. This handles preambles ("Here is your
  // summary: { ... }") and trailing prose ("{ ... } let me know if...").
  // It does NOT try to handle multiple JSON blocks — first wins.
  if (parsed === undefined) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return undefined;
    }
    parsed = safeJsonParse(trimmed.slice(start, end + 1));
    if (parsed === undefined) {
      return undefined;
    }
  }

  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;

  const out: SnapshotParseResult = {};

  // Validate title independently of synopsis — a partial parse is honored.
  if (typeof obj.title === "string") {
    const t = obj.title.trim();
    if (t.length > 0) {
      out.title = t.slice(0, MAX_TITLE_LEN);
    }
  }

  // Validate synopsis independently. Use zod's safeParse so a
  // type-mismatch (e.g. files_touched is a string, not an array) doesn't
  // poison the whole result.
  if (obj.synopsis !== undefined && obj.synopsis !== null) {
    const result = SessionSynopsis.safeParse(obj.synopsis);
    if (result.success && synopsisHasContent(result.data)) {
      out.synopsis = result.data;
    }
  }

  if (out.title === undefined && out.synopsis === undefined) {
    return undefined;
  }
  return out;
}

// The compaction prompt sent to the agent during `/hydra compact`. Asks for
// a single flat JSON object with title and all synopsis fields — including
// the extended compaction-only fields (decisions, file_edit_intentions,
// unresolved_errors, tool_state). No synopsis wrapper; everything is at
// the top level so the full shape is available directly.
//
// Output guidance mirrors SNAPSHOT_PROMPT — modern models follow "no prose,
// no markdown, no code fences" reliably, and tryParseCompaction handles the
// preamble/fence cases when they slip through.
export const COMPACTION_PROMPT =
  "Reply with ONLY a JSON object with exactly these keys, no prose, no markdown, no code fences:\n" +
  "{\n" +
  '  "title": "short summary, max 80 chars",\n' +
  '  "goal": "the user\'s original ask",\n' +
  '  "outcome": "what was concluded or shipped",\n' +
  '  "rejected_approaches": ["things tried and abandoned"],\n' +
  '  "open_threads": ["work started but not finished"],\n' +
  '  "decisions": ["key architectural or implementation decisions"],\n' +
  '  "file_edit_intentions": ["files planned to be edited"],\n' +
  '  "unresolved_errors": ["errors left open at session end"],\n' +
  '  "tool_state": ["runtime state relevant for recall"]\n' +
  "}\n" +
  "Use empty arrays/strings where a field doesn't apply.";

// Parse and validate an agent reply produced under COMPACTION_PROMPT. The
// expected shape is a flat JSON object with title + synopsis fields at the
// top level (no synopsis wrapper). Returns whatever passes validation:
//   - strict JSON.parse first;
//   - on failure, regex-extract the first {...} block;
//   - validate title and each synopsis field independently via zod's
//     safeParse so a type-mismatch doesn't poison the whole result;
//   - return undefined when nothing useful parsed.
//
// Structurally identical to tryParseSnapshot but validates against the
// extended schema (all SessionSynopsis fields) on a flat object.
export function tryParseCompaction(raw: string): SnapshotParseResult | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  // Strict parse first.
  let parsed: unknown = safeJsonParse(trimmed);

  // Fall back to extracting the first {...} block, same strategy as
  // tryParseSnapshot for preamble/postamble handling.
  if (parsed === undefined) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return undefined;
    }
    parsed = safeJsonParse(trimmed.slice(start, end + 1));
    if (parsed === undefined) {
      return undefined;
    }
  }

  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;

  const out: SnapshotParseResult = {};

  // Validate title independently — a partial parse is honored.
  if (typeof obj.title === "string") {
    const t = obj.title.trim();
    if (t.length > 0) {
      out.title = t.slice(0, MAX_TITLE_LEN);
    }
  }

  // Validate synopsis fields individually using zod safeParse so a
  // type-mismatch on one field doesn't poison the whole result. This is
  // the extended schema path — all SessionSynopsis fields are checked.
  const syn: Record<string, unknown> = {};
  let hasContent = false;

  const stringFields: (keyof SessionSynopsis)[] = [
    "goal",
    "outcome",
  ];
  for (const field of stringFields) {
    if (typeof obj[field] === "string") {
      const val = obj[field].trim();
      if (val.length > 0) {
        syn[field] = val;
        hasContent = true;
      }
    }
  }

  const arrayFields: (keyof SessionSynopsis)[] = [
    "files_touched",
    "tools_used",
    "rejected_approaches",
    "open_threads",
    "decisions",
    "file_edit_intentions",
    "unresolved_errors",
    "tool_state",
  ];
  for (const field of arrayFields) {
    if (Array.isArray(obj[field])) {
      const arr = obj[field] as unknown[];
      // Validate each element is a string via zod safeParse.
      const result = z.array(z.string()).safeParse(arr);
      if (result.success && arr.length > 0) {
        syn[field] = result.data;
        hasContent = true;
      }
    }
  }

  if (hasContent) {
    out.synopsis = syn as SessionSynopsis;
  }

  if (out.title === undefined && out.synopsis === undefined) {
    return undefined;
  }
  return out;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// At least one field must carry content for the synopsis to count.
// All-empty parses (agent emitted `synopsis: {}` or an all-empty struct)
// don't merit overwriting an existing synopsis or marking progress.
function synopsisHasContent(s: SessionSynopsis): boolean {
  if (s.goal !== undefined && s.goal.trim().length > 0) {
    return true;
  }
  if (s.outcome !== undefined && s.outcome.trim().length > 0) {
    return true;
  }
  if (s.files_touched !== undefined && s.files_touched.length > 0) {
    return true;
  }
  if (s.tools_used !== undefined && s.tools_used.length > 0) {
    return true;
  }
  if (s.rejected_approaches !== undefined && s.rejected_approaches.length > 0) {
    return true;
  }
  if (s.open_threads !== undefined && s.open_threads.length > 0) {
    return true;
  }
  if (s.decisions !== undefined && s.decisions.length > 0) {
    return true;
  }
  if (s.file_edit_intentions !== undefined && s.file_edit_intentions.length > 0) {
    return true;
  }
  if (s.unresolved_errors !== undefined && s.unresolved_errors.length > 0) {
    return true;
  }
  if (s.tool_state !== undefined && s.tool_state.length > 0) {
    return true;
  }
  return false;
}
