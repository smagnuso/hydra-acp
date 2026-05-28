// Parsing helper for the merged title+synopsis regen reply.
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
});
export type SessionSynopsis = z.infer<typeof SessionSynopsis>;

// Cap the parsed title so an over-eager agent (or a model that ignored
// the ≤80 chars instruction) doesn't blow out the snapshot. Title bar
// renders truncate anyway; this is a safety bound on what we persist.
const MAX_TITLE_LEN = 200;

// The synthesis prompt sent to the agent at idle-close / shutdown /
// picker T / `/hydra title` no-arg. Asks for a single JSON object with
// both title and synopsis. Output guidance is deliberately verbose —
// modern models follow "no prose, no markdown, no code fences" pretty
// reliably, but the JSON-extraction fallback in tryParseSnapshot
// handles the preamble/fence cases when they slip through.
export const SNAPSHOT_PROMPT =
  "Reply with ONLY a JSON object with exactly these keys, no prose, no markdown, no code fences:\n" +
  "{\n" +
  '  "title": "short summary, max 80 chars",\n' +
  '  "synopsis": {\n' +
  '    "goal": "the user\'s original ask",\n' +
  '    "outcome": "what was concluded or shipped",\n' +
  '    "files_touched": ["file paths edited or read"],\n' +
  '    "tools_used": ["tool names"],\n' +
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
  return false;
}
