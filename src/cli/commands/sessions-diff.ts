// `hydra session diff <id>` — emit a git-diff-shaped view of every
// file the session changed.
//
// Pulls /v1/sessions/:id/export, decodes the bundle, walks history for
// tool_call / tool_call_update entries carrying edit payloads
// (canonical content[].type:"diff", Claude Edit/Write/MultiEdit raw
// inputs), and groups by file path. For each file we emit one
// `--- a/path` / `+++ b/path` header followed by one `@@` hunk per
// individual edit. We do NOT try to collapse multiple Edit snippets
// into a single whole-file before/after — the Edit tool's oldText is a
// substring of the original file, not the original file itself, so
// chaining snippets across edits produces nonsense. Showing them
// sequentially mirrors how `git diff` already displays multiple hunks
// per file.
//
// No git, no filesystem read of the workspace.
//
// Deletes aren't representable today — nothing on the wire marks a
// file as removed. Deleted files just won't appear.

import { highlight, supportsLanguage } from "cli-highlight";
import { loadConfig } from "../../core/config.js";
import { loadServiceToken } from "../../core/service-token.js";
import { decodeBundle, type Bundle } from "../../core/bundle.js";
import {
  aggregateFileEdits,
  type FileEditAggregate,
} from "../../core/history-edits.js";
import { buildUnifiedDiff } from "../../tui/format.js";
import { openPager } from "../pager.js";
import { httpBase } from "./sessions.js";

export interface SessionsDiffOptions {
  json?: boolean;
  noColor?: boolean;
  noPager?: boolean;
}

export async function runSessionsDiff(
  id: string | undefined,
  opts: SessionsDiffOptions = {},
): Promise<void> {
  if (!id) {
    process.stderr.write(
      "Usage: hydra-acp session diff <session-id> [--json] [--no-color]\n",
    );
    process.exit(2);
  }
  const config = await loadConfig();
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(
    config.daemon.host,
    config.daemon.port,
    !!config.daemon.tls,
  );

  const exportResp = await fetch(
    `${baseUrl}/v1/sessions/${encodeURIComponent(id)}/export`,
    { headers: { Authorization: `Bearer ${serviceToken}` } },
  );
  if (!exportResp.ok) {
    const text = await exportResp.text().catch(() => "");
    process.stderr.write(
      `Daemon returned HTTP ${exportResp.status}: ${text}\n`,
    );
    process.exit(1);
  }
  const raw = (await exportResp.json()) as unknown;
  let bundle: Bundle;
  try {
    bundle = decodeBundle(raw);
  } catch (err) {
    process.stderr.write(
      `Failed to decode session bundle: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }

  const files = aggregateFileEdits(bundle.history);
  if (opts.json) {
    process.stdout.write(JSON.stringify(files, null, 2) + "\n");
    return;
  }
  // Pager mirrors `git diff`: only invoked when stdout is a TTY and
  // --no-pager isn't set. When the pager runs we keep colorization on
  // (the user's terminal is still a TTY; less -R passes ANSI through)
  // unless --no-color was explicitly passed.
  const pager = openPager({ disabled: opts.noPager === true });
  const onTTY = process.stdout.isTTY === true;
  const useColor = !opts.noColor && onTTY;
  pager.stream.write(renderDiff(files, useColor));
  await pager.flush();
}

export function renderDiff(
  files: FileEditAggregate[],
  useColor: boolean,
): string {
  if (files.length === 0) {
    return "No file edits found in this session.\n";
  }
  const out: string[] = [];
  // Sort by path so output order is deterministic across runs.
  const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of ordered) {
    out.push(formatFile(f, useColor));
  }
  return out.join("");
}

function formatFile(f: FileEditAggregate, useColor: boolean): string {
  const lines: string[] = [];
  lines.push(`diff --hydra a/${f.path} b/${f.path}`);
  if (f.created) {
    lines.push("new file");
    lines.push("--- /dev/null");
    lines.push(`+++ b/${f.path}`);
  } else {
    lines.push(`--- a/${f.path}`);
    lines.push(`+++ b/${f.path}`);
  }
  // One @@ hunk per individual edit. We have no file-relative line
  // numbers (Edit's old_string/new_string are substrings, not
  // coordinate-tagged), so the start positions are placeholders — 1/1
  // for normal edits, 0/1 for the all-additions case (created files
  // and snippet inserts). The counts are real: number of lines in the
  // snippet, computed the same way buildUnifiedDiff splits them.
  // After the closing @@ we tag the hunk with "edit N of M" when the
  // file has multiple hunks, using git's "function context" tail
  // convention so the marker is still a valid unified-diff header.
  const total = f.hunks.length;
  f.hunks.forEach((hunk, idx) => {
    const body = buildUnifiedDiff(hunk, { maxLines: Infinity });
    const oldCount = countSnippetLines(hunk.oldText);
    const newCount = countSnippetLines(hunk.newText);
    const oldStart = oldCount === 0 ? 0 : 1;
    const newStart = newCount === 0 ? 0 : 1;
    const tail = total > 1 ? ` edit ${idx + 1} of ${total}` : "";
    lines.push(
      `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${tail}`,
    );
    if (body.length > 0) {
      lines.push(body);
    }
  });
  const text = lines.join("\n") + "\n\n";
  if (!useColor) {
    return text;
  }
  if (!supportsLanguage("diff")) {
    return text;
  }
  return highlight(text, { language: "diff" });
}

// Count snippet lines the same way buildUnifiedDiff does: split on
// "\n" and drop a trailing empty entry caused by a final newline, so
// "foo\nbar\n" reports 2 lines rather than 3.
function countSnippetLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts.length;
}
