// `hydra session changes [<path>]` — which sessions changed files under
// a path.
//
// Thin verb over POST /v1/sessions/search's `edit:` scope: that scope
// already walks every session's history in tools:"references" mode (no
// blob inflation) and matches edit-carrier paths on segment boundaries,
// so this command is a join and a renderer, not a scanner.
//
// Two deliberate differences from `session list`:
//   - No host filter and no interactive filter by default. `list` is a
//     dashboard, so hiding imports and planner workers keeps it readable;
//     this is a query, and the session that edited the file you're asking
//     about is very often exactly a planner worker or an import. `--host`
//     narrows when you want it.
//   - No cold cap. The path IS the narrowing; capping would hide the row
//     you came here for.
//
// Inherits the blind spots of the edit-carrier vocabulary: a delete never
// reaches the wire, and a shell-driven mutation (`sed -i`, `git checkout`,
// `mv`) is a Bash call with no edit payload. Both are invisible here, so
// the empty-result path says so rather than implying the directory is
// clean.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expandHome, loadConfig } from "../../core/config.js";
import { shortenHomePath } from "../../core/paths.js";
import { daemonFetch } from "./_shared.js";
import {
  HEADER,
  DEFAULT_COLUMNS,
  computeWidths,
  formatRow,
  toRow,
  type ColumnKey,
  type FormatOptions,
  type Row,
  type SessionSummary,
} from "../session-row.js";
import type { FileEditAggregate } from "../../core/history-edits.js";
import { workspacePathNormalizer } from "../../core/history-search.js";

export interface SessionsChangesOptions {
  json?: boolean;
  // Resolve every hit's complete file list (with per-file edit counts)
  // instead of the up-to-5 sample the search response carries.
  files?: boolean;
  host?: string;
  columns?: ColumnKey[];
}

interface SearchSnippet {
  kind: string;
  text: string;
  toolName?: string;
  recordedAt: number;
}

interface SearchHit {
  sessionId: string;
  title?: string;
  cwd: string;
  status: "warm" | "cold";
  updatedAt: string;
  totalMatches: number;
  snippets: SearchSnippet[];
}

interface ChangedFile {
  path: string;
  edits: number;
  created: boolean;
}

// How many hits to resolve full file lists for at once. The endpoint
// re-aggregates a whole session per call, so this is deliberately modest.
const DIFF_CONCURRENCY = 4;

// Resolve the positional argument.
//   omitted            → the current directory
//   names something on disk → absolute path (so `changes src/tui` and
//                        `changes ../slack` mean what they look like)
//   anything else      → passed through verbatim, which the edit: scope
//                        treats as a run of whole path segments, so
//                        `changes app.ts` finds it wherever it lives
export async function resolveChangesTarget(
  input: string | undefined,
): Promise<string> {
  if (input === undefined || input.trim().length === 0) {
    return process.cwd();
  }
  const trimmed = input.trim();
  const absolute = path.resolve(expandHome(trimmed));
  try {
    await fs.stat(absolute);
    return absolute;
  } catch {
    return trimmed;
  }
}

export async function runSessionsChanges(
  target: string | undefined,
  opts: SessionsChangesOptions = {},
): Promise<void> {
  const query = await resolveChangesTarget(target);
  // The query is embedded in a quoted search term, so a double quote in
  // the path would end the term early and silently search for a prefix.
  if (query.includes('"')) {
    process.stderr.write(
      `Cannot search for a path containing a double quote: ${query}\n`,
    );
    process.exit(2);
  }
  const config = await loadConfig();

  // Join against the session list for the columns the search response
  // doesn't carry (agent, model, cost, attached clients, workspace).
  // includeNonInteractive so planner workers and `hydra cat` rows can be
  // rendered rather than falling back to the sparse hit shape.
  const listRes = await daemonFetch(
    "/v1/sessions?includeNonInteractive=true",
    { expectStatus: 200 },
  );
  const summaries = new Map<string, SessionSummary & { importedFromMachine?: string; upstreamSessionId?: string }>();
  for (const s of (listRes.body as { sessions: SessionSummary[] }).sessions) {
    summaries.set(s.sessionId, s);
  }

  const searchRes = await daemonFetch("/v1/sessions/search", {
    method: "POST",
    body: { q: `edit:"${query}"` },
    expectStatus: 200,
  });
  const body = searchRes.body as {
    truncated: boolean;
    results: SearchHit[];
  };

  let hits = body.results;
  if (opts.host !== undefined && opts.host !== "all") {
    hits = hits.filter((h) => {
      const s = summaries.get(h.sessionId);
      if (opts.host === "local") {
        return !s?.importedFromMachine || !!s?.upstreamSessionId;
      }
      return s?.importedFromMachine === opts.host && !s?.upstreamSessionId;
    });
  }

  // A daemon that predates the `edit:` scope parses the prefix (the
  // tokenizer accepts any \w+:) and falls back to scope "all", which
  // quietly turns this into a substring search over prompts and tool
  // input: every session that READ the path comes back looking like it
  // changed it. Detectable because an edit-scoped hit can only ever match
  // edit-kind fragments, so hits with none of them mean the scope was
  // ignored. Refuse rather than present mentions as changes.
  if (
    hits.length > 0 &&
    !hits.some((h) => h.snippets.some((s) => s.kind === "edit"))
  ) {
    process.stderr.write(
      "The daemon does not support the `edit:` search scope, so these " +
        "results would be file mentions (reads, greps) rather than changes.\n" +
        "Restart the daemon to pick up the current build: hydra daemon restart\n",
    );
    process.exit(1);
  }

  // Warm first, then most-recently-updated — same ordering as the list,
  // so a reader's eye lands where it already expects the live rows.
  hits = hits.slice().sort((a, b) => {
    const warmDiff = (b.status === "warm" ? 1 : 0) - (a.status === "warm" ? 1 : 0);
    if (warmDiff !== 0) {
      return warmDiff;
    }
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });

  // --files and --json both want the authoritative per-file list rather
  // than the search response's sample; scripts especially shouldn't have
  // to know that `files` was truncated at five.
  const wantFullFiles = opts.files === true || opts.json === true;
  const fullFiles = wantFullFiles
    ? await resolveFileLists(hits.map((h) => h.sessionId), query, summaries)
    : new Map<string, ChangedFile[]>();

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          query,
          truncated: body.truncated,
          results: hits.map((h) => ({
            sessionId: h.sessionId,
            ...(h.title !== undefined ? { title: h.title } : {}),
            cwd: h.cwd,
            status: h.status,
            updatedAt: h.updatedAt,
            fileCount: h.totalMatches,
            files: fullFiles.get(h.sessionId) ?? [],
          })),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  if (hits.length === 0) {
    process.stdout.write(
      `No sessions changed files under ${shortenHomePath(query)}.\n` +
        "Note: deletes and shell-driven edits (sed -i, git checkout, mv) " +
        "carry no edit payload, so they are invisible to this search.\n",
    );
    return;
  }

  const now = Date.now();
  const rows: Row[] = [];
  for (const hit of hits) {
    const summary = summaries.get(hit.sessionId);
    rows.push(toRow(summary ?? hitAsSummary(hit), now));
  }
  const formatOpts: FormatOptions = {
    columns: opts.columns ?? config.tui.sessionColumns ?? DEFAULT_COLUMNS,
    cwdMaxWidth: config.tui.cwdColumnMaxWidth,
  };
  const widths = computeWidths(rows, formatOpts);
  const maxWidth = process.stdout.isTTY ? process.stdout.columns : undefined;
  process.stdout.write(formatRow(HEADER, widths, maxWidth, formatOpts) + "\n");
  hits.forEach((hit, idx) => {
    process.stdout.write(
      formatRow(rows[idx]!, widths, maxWidth, formatOpts) + "\n",
    );
    const summary = summaries.get(hit.sessionId);
    const normalize = summary ? workspacePathNormalizer(summary) : undefined;
    for (const line of fileLines(hit, fullFiles.get(hit.sessionId), query, normalize)) {
      process.stdout.write(line + "\n");
    }
  });
  if (body.truncated) {
    process.stdout.write(
      "\n... more sessions matched than the search returns; narrow the path to see the rest.\n",
    );
  }
}

// The indented detail line(s) under a session row. Mirrors the picker's
// snippet line: the evidence for why this row is here, shown for every
// row rather than only the focused/first one.
// `normalize` maps an isolated session's workspace paths back to source-tree
// coordinates for display only, so its files line up with every other row's
// instead of repeating the workspace prefix on each line. Nothing is hidden
// by this: the row's CWD cell already carries the workspace label, and
// --json reports the real paths.
export function fileLines(
  hit: SearchHit,
  full: ChangedFile[] | undefined,
  query: string,
  normalize?: (p: string) => string,
): string[] {
  const show = (p: string): string => display(normalize ? normalize(p) : p, query);
  const noun = hit.totalMatches === 1 ? "file" : "files";
  if (full !== undefined) {
    const out = [`    ${full.length} ${full.length === 1 ? "file" : "files"}`];
    for (const f of full) {
      out.push(`      ${String(f.edits).padStart(3)}×  ${show(f.path)}${f.created ? "  (new)" : ""}`);
    }
    return out;
  }
  const shown = hit.snippets
    .filter((s) => s.kind === "edit")
    .map((s) => show(s.text));
  if (shown.length === 0) {
    return [];
  }
  const suffix =
    hit.totalMatches > shown.length
      ? `  (${shown.length} shown; --files for all)`
      : "";
  return [`    ${hit.totalMatches} ${noun}: ${shown.join(" · ")}${suffix}`];
}

// Render a matched path relative to the query when the query named a
// directory the path sits under, so the column of paths lines up on the
// part that differs. Absolute queries only: a segment query like
// "app.ts" has no meaningful base to strip.
function display(p: string, query: string): string {
  if (query.startsWith("/") && p.startsWith(query + "/")) {
    return p.slice(query.length + 1);
  }
  return shortenHomePath(p);
}

// Full per-file lists via the existing /diff aggregation, filtered to the
// query. Bodies come back too and are discarded — the endpoint has no
// paths-only mode, and adding one to save bytes over a handful of already
// matched sessions isn't worth a protocol change.
async function resolveFileLists(
  sessionIds: string[],
  query: string,
  summaries: Map<string, SessionSummary>,
): Promise<Map<string, ChangedFile[]>> {
  const out = new Map<string, ChangedFile[]>();
  const queue = [...sessionIds];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(DIFF_CONCURRENCY, queue.length); i++) {
    workers.push(
      (async () => {
        for (;;) {
          const id = queue.shift();
          if (id === undefined) {
            return;
          }
          const res = await daemonFetch(
            `/v1/sessions/${encodeURIComponent(id)}/diff`,
          );
          if (!res.ok) {
            out.set(id, []);
            continue;
          }
          // Same workspace normalization the server applied when the row
          // matched. Without it an isolated session shows up as a hit and
          // then expands to zero files, because /diff reports the real
          // workspace paths and the query names the source tree.
          const summary = summaries.get(id);
          const normalize = summary
            ? workspacePathNormalizer(summary)
            : undefined;
          const files = (res.body as FileEditAggregate[])
            .filter(
              (f) =>
                matchesQuery(f.path, query) ||
                (normalize !== undefined && matchesQuery(normalize(f.path), query)),
            )
            .map((f) => ({
              path: f.path,
              edits: f.hunks.length,
              created: f.created,
            }))
            .sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path));
          out.set(id, files);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}

// Client-side mirror of the edit: scope's segment matching, applied to
// /diff output. Same rule, so --files can't show a different set than the
// row it expands.
function matchesQuery(p: string, query: string): boolean {
  const hay = p.toLowerCase();
  const nee = query.toLowerCase().replace(/\/+$/, "");
  if (nee.startsWith("/")) {
    return hay === nee || hay.startsWith(nee + "/");
  }
  const probe = "/" + nee;
  let idx = hay.indexOf(probe);
  while (idx !== -1) {
    const after = idx + probe.length;
    if (after === hay.length || hay[after] === "/") {
      return true;
    }
    idx = hay.indexOf(probe, idx + 1);
  }
  return false;
}

// Fallback row source for a hit whose session left the list between the
// search and the join (killed, removed). The search response carries
// enough to render an honest row; the agent/cost cells go empty.
function hitAsSummary(hit: SearchHit): SessionSummary {
  return {
    sessionId: hit.sessionId,
    cwd: hit.cwd,
    ...(hit.title !== undefined ? { title: hit.title } : {}),
    attachedClients: 0,
    updatedAt: hit.updatedAt,
    status: hit.status,
  };
}
