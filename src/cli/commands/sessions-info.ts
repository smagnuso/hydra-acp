// `hydra sessions info <id>` — dump aggregated info about a session.
//
// Pulls /v1/sessions/:id/export, decodes the bundle, aggregates the
// history (tool histogram, files touched with per-tool counts, turn
// count), and renders one of three output modes:
//   - default: summary view with top-N histograms
//   - --verbose: full histograms (all files, all tools, no truncation)
//   - --json: structured JSON for piping (same data either way)
//
// All aggregation is local — no new daemon endpoint. Same posture as
// `sessions list` / `sessions search`.

import { daemonFetch } from "./_shared.js";
import { decodeBundle, type Bundle } from "../../core/bundle.js";
import type { HistoryEntry } from "../../core/history-store.js";
import {
  countTurns,
  extractFilesTouchedDetailed,
  extractToolHistogram,
  type FileCount as AggFileCount,
  type ToolCount as AggToolCount,
} from "../../core/history-aggregate.js";
import {
  aggregateFileEdits,
  foldHunks,
  type FileEditAggregate,
} from "../../core/history-edits.js";
import { openPager } from "../pager.js";
import { renderDiff } from "./sessions-diff.js";

export interface SessionsInfoOptions {
  verbose?: boolean;
  json?: boolean;
  // Append a git-diff-shaped view of every file the session edited.
  // On a TTY the combined summary+diff output is paged. Inherits the
  // diff command's --fold / --no-color / --no-pager surface.
  diff?: boolean;
  fold?: boolean;
  noColor?: boolean;
  noPager?: boolean;
}

interface SessionInfoData {
  sessionId: string;
  // Agent-side (upstream) session id. Surfaced here because the session
  // list hides the UPSTREAM column by default — `info` is the place to
  // recover it when needed.
  upstreamSessionId?: string;
  title?: string;
  cwd: string;
  agentId: string;
  currentModel?: string;
  status: "live" | "cold";
  createdAt: string;
  updatedAt: string;
  synopsis: SessionSynopsisShape | null;
  summarizedThroughEntry: number | null;
  turns: number;
  tools: ToolCount[];
  files: FileCount[];
  cost: {
    amount: number | null;
    currency: string | null;
    cumulative: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
  };
  duration: {
    totalMs: number | null;
  };
  historyEntries: number;
}

interface SessionSynopsisShape {
  goal?: string;
  outcome?: string;
  files_touched?: string[];
  tools_used?: string[];
  rejected_approaches?: string[];
  open_threads?: string[];
}

type ToolCount = AggToolCount;
type FileCount = AggFileCount;

// Default rendering caps. --verbose disables both.
const DEFAULT_TOP_TOOLS = 10;
const DEFAULT_TOP_FILES = 15;

// Tool names that mutate a file's contents. Used to filter the default
// "Files edited" view; --verbose still shows every file touched
// (including pure reads, globs, etc.).
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export async function runSessionsInfo(
  id: string | undefined,
  opts: SessionsInfoOptions = {},
): Promise<void> {
  if (!id) {
    process.stderr.write(
      "Usage: hydra-acp sessions info <session-id> [--verbose] [--json] [--diff] [--fold] [--no-color] [--no-pager]\n",
    );
    process.exit(2);
  }
  // Resolve `live` vs `cold` from the single-session endpoint — /export
  // doesn't carry it. Previously this hit /v1/sessions and scanned the
  // full list; /v1/sessions/:id returns the same per-entry shape for one id.
  const infoRes = await daemonFetch(
    `/v1/sessions/${encodeURIComponent(id)}`,
    { expectStatus: [200, 404] },
  );
  const liveStatus =
    infoRes.status === 200
      ? (infoRes.body as { status?: "live" | "cold" }).status
      : undefined;

  const exportRes = await daemonFetch(
    `/v1/sessions/${encodeURIComponent(id)}/export`,
    { expectStatus: 200 },
  );
  const raw = exportRes.body;
  let bundle: Bundle;
  try {
    bundle = decodeBundle(raw);
  } catch (err) {
    process.stderr.write(
      `Failed to decode session bundle: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }

  const data = aggregate(bundle, liveStatus ?? "cold");
  // --diff opt-in: append a git-diff-shaped view of every file the
  // session edited beneath the summary. Same aggregation/fold/render
  // pipeline `hydra session diff` uses, against the same bundle we
  // already loaded.
  const includeDiff = opts.diff === true;
  let diffFiles: FileEditAggregate[] | null = null;
  if (includeDiff) {
    const rawFiles = aggregateFileEdits(bundle.history);
    diffFiles =
      opts.fold === true
        ? rawFiles.map((f) => ({ ...f, hunks: foldHunks(f.hunks) }))
        : rawFiles;
  }
  if (opts.json) {
    const payload: Record<string, unknown> = { ...data };
    if (diffFiles !== null) {
      payload.diff = diffFiles;
    }
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  // Page the combined output when --diff is set (mirrors session diff);
  // plain info stays unpaged since it's short.
  const onTTY = process.stdout.isTTY === true;
  const useColor = !opts.noColor && onTTY;
  if (includeDiff) {
    const pager = openPager({ disabled: opts.noPager === true });
    pager.stream.write(formatSummary(data, opts.verbose === true));
    pager.stream.write("\n");
    pager.stream.write(renderDiff(diffFiles ?? [], useColor));
    await pager.flush();
    return;
  }
  process.stdout.write(formatSummary(data, opts.verbose === true));
}

export function aggregate(
  bundle: Bundle,
  status: "live" | "cold",
): SessionInfoData {
  const r = bundle.session;
  const history = bundle.history;

  const turns = countTurns(history);
  const tools: ToolCount[] = extractToolHistogram(history);
  const files: FileCount[] = extractFilesTouchedDetailed(history);

  const usage = r.currentUsage;
  const createdMs = Date.parse(r.createdAt);
  const updatedMs = Date.parse(r.updatedAt);
  const durationMs =
    Number.isFinite(createdMs) && Number.isFinite(updatedMs)
      ? updatedMs - createdMs
      : null;

  return {
    sessionId: r.sessionId,
    ...(r.upstreamSessionId !== undefined
      ? { upstreamSessionId: r.upstreamSessionId }
      : {}),
    ...(r.title !== undefined ? { title: r.title } : {}),
    cwd: r.cwd,
    agentId: r.agentId,
    ...(r.currentModel !== undefined ? { currentModel: r.currentModel } : {}),
    status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    synopsis: (r.synopsis as SessionSynopsisShape | undefined) ?? null,
    summarizedThroughEntry: r.summarizedThroughEntry ?? null,
    turns,
    tools,
    files,
    cost: {
      amount: usage?.costAmount ?? null,
      currency: usage?.costCurrency ?? null,
      cumulative: usage?.cumulativeCost ?? null,
      inputTokens: usage?.used ?? null,
      outputTokens: usage?.size ?? null,
    },
    duration: { totalMs: durationMs },
    historyEntries: history.length,
  };
}

// Extract file path candidates from a tool_call's rawInput plus its
export function formatSummary(d: SessionInfoData, verbose: boolean): string {
  const lines: string[] = [];
  const pad = (label: string): string => label.padEnd(14);

  lines.push(`${pad("Session:")}${d.sessionId}`);
  if (d.upstreamSessionId) {
    lines.push(`${pad("Upstream:")}${d.upstreamSessionId}`);
  }
  if (d.title) {
    lines.push(`${pad("Title:")}${d.title}`);
  }
  lines.push(`${pad("Cwd:")}${d.cwd}`);
  const modelPart = d.currentModel ? ` · ${d.currentModel}` : "";
  lines.push(`${pad("Agent:")}${d.agentId}${modelPart}`);
  lines.push(`${pad("Status:")}${d.status}`);
  lines.push(`${pad("Created:")}${d.createdAt}`);
  lines.push(`${pad("Last active:")}${d.updatedAt}`);
  if (d.duration.totalMs !== null) {
    lines.push(`${pad("Duration:")}${formatDuration(d.duration.totalMs)}`);
  }
  lines.push(`${pad("Turns:")}${d.turns}`);

  // Cost block (skipped entirely if nothing's known).
  const costBits: string[] = [];
  if (d.cost.amount !== null) {
    const cur = d.cost.currency ?? "USD";
    costBits.push(`${cur} ${d.cost.amount.toFixed(4)}`);
  } else if (d.cost.cumulative !== null) {
    const cur = d.cost.currency ?? "USD";
    costBits.push(`${cur} ${d.cost.cumulative.toFixed(4)} (cumulative)`);
  }
  if (d.cost.inputTokens !== null || d.cost.outputTokens !== null) {
    const tokenBits: string[] = [];
    if (d.cost.inputTokens !== null) {
      tokenBits.push(`${d.cost.inputTokens.toLocaleString()} in`);
    }
    if (d.cost.outputTokens !== null) {
      tokenBits.push(`${d.cost.outputTokens.toLocaleString()} out`);
    }
    costBits.push(tokenBits.join(" / "));
  }
  if (costBits.length > 0) {
    lines.push(`${pad("Cost:")}${costBits.join("  |  ")}`);
  }

  // Synopsis block.
  if (d.synopsis) {
    lines.push("");
    lines.push("Synopsis:");
    const indent = "  ";
    const synPad = (label: string): string => label.padEnd(22);
    if (d.synopsis.goal) {
      lines.push(`${indent}${synPad("Goal:")}${d.synopsis.goal}`);
    }
    if (d.synopsis.outcome) {
      lines.push(`${indent}${synPad("Outcome:")}${d.synopsis.outcome}`);
    }
    if (d.synopsis.rejected_approaches && d.synopsis.rejected_approaches.length > 0) {
      lines.push(`${indent}${synPad("Rejected approaches:")}`);
      for (const r of d.synopsis.rejected_approaches) {
        lines.push(`${indent}  - ${r}`);
      }
    }
    if (d.synopsis.open_threads && d.synopsis.open_threads.length > 0) {
      lines.push(`${indent}${synPad("Open threads:")}`);
      for (const t of d.synopsis.open_threads) {
        lines.push(`${indent}  - ${t}`);
      }
    }
  } else {
    lines.push("");
    lines.push("Synopsis:      (none yet — generated on idle-close or daemon shutdown)");
  }

  // Tool histogram.
  if (d.tools.length > 0) {
    lines.push("");
    const totalCalls = d.tools.reduce((s, t) => s + t.count, 0);
    lines.push(`Tools (${totalCalls} calls):`);
    const shown = verbose ? d.tools : d.tools.slice(0, DEFAULT_TOP_TOOLS);
    const nameWidth = Math.max(...shown.map((t) => t.name.length), 4);
    for (const t of shown) {
      lines.push(`  ${t.name.padEnd(nameWidth)}  ${t.count}`);
    }
    if (!verbose && d.tools.length > DEFAULT_TOP_TOOLS) {
      lines.push(`  ... ${d.tools.length - DEFAULT_TOP_TOOLS} more (use --verbose to see all)`);
    }
  }

  // Files touched / edited.
  // Default view filters to files with at least one edit-tool call and
  // shows just the edit count; --verbose shows every file with the full
  // per-tool breakdown (reads included).
  const filesForRender: FileCount[] = verbose
    ? d.files
    : d.files
        .map((f) => {
          const byTool = f.byTool.filter((t) => EDIT_TOOLS.has(t.name));
          const count = byTool.reduce((s, t) => s + t.count, 0);
          return { path: f.path, count, byTool };
        })
        .filter((f) => f.count > 0);
  if (filesForRender.length > 0) {
    lines.push("");
    const label = verbose ? "Files touched" : "Files edited";
    lines.push(`${label} (${filesForRender.length}):`);
    const shown = verbose
      ? filesForRender
      : filesForRender.slice(0, DEFAULT_TOP_FILES);
    const pathWidth = Math.max(...shown.map((f) => f.path.length), 4);
    for (const f of shown) {
      if (verbose) {
        const breakdown = f.byTool
          .map((t) => `${t.name}×${t.count}`)
          .join(", ");
        lines.push(`  ${f.path.padEnd(pathWidth)}  ${f.count}  (${breakdown})`);
      } else {
        lines.push(`  ${f.path.padEnd(pathWidth)}  ${f.count}`);
      }
    }
    if (!verbose && filesForRender.length > DEFAULT_TOP_FILES) {
      lines.push(`  ... ${filesForRender.length - DEFAULT_TOP_FILES} more (use --verbose to see all)`);
    }
  }

  return lines.join("\n") + "\n";
}

function formatDuration(ms: number): string {
  if (ms < 0) {
    return "0s";
  }
  const sec = Math.floor(ms / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = sec % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (mins > 0) {
    parts.push(`${mins}m`);
  }
  if (parts.length === 0 || secs > 0) {
    parts.push(`${secs}s`);
  }
  return parts.join(" ");
}

// Re-export the aggregator + types for the test file.
export type { SessionInfoData, ToolCount, FileCount, HistoryEntry };
