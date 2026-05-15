import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadConfig, loadConfigReadOnly } from "../../core/config.js";
import { decodeBundle, type Bundle } from "../../core/bundle.js";
import { bundleToMarkdown } from "../../core/transcript.js";
import {
  HEADER,
  computeWidths,
  formatRow,
  toRow,
  type SessionSummary,
} from "../session-row.js";

export async function runSessionsList(
  opts: { all?: boolean; json?: boolean } = {},
): Promise<void> {
  const config = await loadConfig();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const url = new URL(`${baseUrl}/v1/sessions`);
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${config.daemon.authToken}` },
  });
  if (!response.ok) {
    process.stderr.write(`Daemon returned HTTP ${response.status}\n`);
    process.exit(1);
  }
  const body = (await response.json()) as {
    sessions: Array<{
      sessionId: string;
      upstreamSessionId?: string;
      cwd: string;
      agentId?: string;
      currentModel?: string;
      currentUsage?: {
        used?: number;
        size?: number;
        costAmount?: number;
        costCurrency?: string;
      };
      title?: string;
      attachedClients: number;
      updatedAt: string;
      status?: "live" | "cold";
    }>;
  };
  // --json bypasses the table renderer and the cold-cap truncation:
  // a script wants the full list verbatim, not a TTY-trimmed view.
  if (opts.json) {
    process.stdout.write(JSON.stringify(body.sessions, null, 2) + "\n");
    return;
  }
  if (body.sessions.length === 0) {
    process.stdout.write("No active sessions.\n");
    return;
  }
  const sorted = body.sessions.slice().sort((a, b) => {
    const liveDiff = (b.status === "live" ? 1 : 0) - (a.status === "live" ? 1 : 0);
    if (liveDiff !== 0) {
      return liveDiff;
    }
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });
  // Always keep every live session; cap cold at sessionListColdLimit (most
  // recent first) unless --all is passed. Sort is live-first then
  // recency, so cold entries are already contiguous at the tail.
  let visible = sorted;
  let truncated = 0;
  if (!opts.all) {
    const liveCount = sorted.filter((s) => s.status !== "cold").length;
    const limit = config.sessionListColdLimit;
    const coldSlice = sorted.slice(liveCount, liveCount + limit);
    const hiddenCold = sorted.length - liveCount - coldSlice.length;
    visible = [...sorted.slice(0, liveCount), ...coldSlice];
    truncated = hiddenCold;
  }
  const now = Date.now();
  const rows = visible.map((s) => toRow(s, now));
  const widths = computeWidths(rows);
  // Truncate to terminal width only when stdout is a TTY — piping to a
  // file or grep should preserve the full row.
  const maxWidth = process.stdout.isTTY ? process.stdout.columns : undefined;
  const cwdMax = config.tui.cwdColumnMaxWidth;
  process.stdout.write(formatRow(HEADER, widths, maxWidth, cwdMax) + "\n");
  for (const r of rows) {
    process.stdout.write(formatRow(r, widths, maxWidth, cwdMax) + "\n");
  }
  if (truncated > 0) {
    process.stdout.write(
      `\n... ${truncated} more cold session${truncated === 1 ? "" : "s"} hidden. Use --all to show.\n`,
    );
  }
}

export async function runSessionsKill(id: string | undefined): Promise<void> {
  if (!id) {
    process.stderr.write("Usage: hydra-acp sessions kill <session-id>\n");
    process.exit(2);
  }
  const config = await loadConfig();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const response = await fetch(`${baseUrl}/v1/sessions/${id}/kill`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.daemon.authToken}` },
  });
  if (!response.ok && response.status !== 204) {
    process.stderr.write(`Daemon returned HTTP ${response.status}\n`);
    process.exit(1);
  }
  process.stdout.write(`Killed ${id}\n`);
}

export async function runSessionsRemove(id: string | undefined): Promise<void> {
  if (!id) {
    process.stderr.write("Usage: hydra-acp sessions remove <session-id>\n");
    process.exit(2);
  }
  const config = await loadConfig();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const response = await fetch(`${baseUrl}/v1/sessions/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${config.daemon.authToken}` },
  });
  if (!response.ok && response.status !== 204) {
    process.stderr.write(`Daemon returned HTTP ${response.status}\n`);
    process.exit(1);
  }
  process.stdout.write(`Removed ${id}\n`);
}

export async function runSessionsExport(
  id: string | undefined,
  outPath: string | undefined,
): Promise<void> {
  if (!id) {
    process.stderr.write(
      "Usage: hydra-acp sessions export <session-id> [--out <file>]\n",
    );
    process.exit(2);
  }
  const config = await loadConfig();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const response = await fetch(
    `${baseUrl}/v1/sessions/${encodeURIComponent(id)}/export`,
    {
      headers: { Authorization: `Bearer ${config.daemon.authToken}` },
    },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    process.stderr.write(`Daemon returned HTTP ${response.status}: ${text}\n`);
    process.exit(1);
  }
  const body = await response.text();
  if (!outPath) {
    process.stdout.write(body);
    if (!body.endsWith("\n")) {
      process.stdout.write("\n");
    }
    return;
  }
  const resolved = outPath === "." ? deriveFilenameFrom(response, id) : outPath;
  await fs.mkdir(path.dirname(path.resolve(resolved)), { recursive: true });
  await fs.writeFile(resolved, body, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`Wrote ${resolved}\n`);
}

// Render a session as a markdown transcript. Accepts either a session
// id (fetches the daemon's GET /transcript route) or a local .hydra
// bundle file (decoded + rendered in-process via bundleToMarkdown).
// Both paths share the same renderer in core/transcript.ts.
export async function runSessionsTranscript(
  idOrFile: string | undefined,
  outPath: string | undefined,
): Promise<void> {
  if (!idOrFile) {
    process.stderr.write(
      "Usage: hydra-acp sessions transcript <session-id>|<file> [--out <file>|.]\n",
    );
    process.exit(2);
  }
  // File-path branch: avoids a daemon round-trip and works on bundles
  // the user hasn't imported (or on hosts without a daemon running).
  let body: string;
  let defaultName: string;
  const localFile = await readBundleFileIfExists(idOrFile);
  if (localFile !== null) {
    const bundle = decodeBundleOrExit(localFile.raw);
    body = bundleToMarkdown(bundle);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    defaultName = `${path.basename(idOrFile, path.extname(idOrFile))}-${stamp}.md`;
  } else {
    const config = await loadConfig();
    const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
    const response = await fetch(
      `${baseUrl}/v1/sessions/${encodeURIComponent(idOrFile)}/transcript`,
      {
        headers: { Authorization: `Bearer ${config.daemon.authToken}` },
      },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      process.stderr.write(`Daemon returned HTTP ${response.status}: ${text}\n`);
      process.exit(1);
    }
    body = await response.text();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    defaultName = `hydra-${idOrFile}-${stamp}.md`;
  }
  if (!outPath) {
    process.stdout.write(body);
    if (!body.endsWith("\n")) {
      process.stdout.write("\n");
    }
    return;
  }
  const resolved = outPath === "." ? defaultName : outPath;
  await fs.mkdir(path.dirname(path.resolve(resolved)), { recursive: true });
  await fs.writeFile(resolved, body, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`Wrote ${resolved}\n`);
}

// Returns parsed JSON if `arg` refers to an existing readable file,
// otherwise null. Used to disambiguate the file path from a session id
// at the top of runSessionsTranscript. Session ids are alnum + `_-`
// only (see SESSION_ID_PATTERN in core/session-store), so collisions
// with real filenames are vanishingly rare; we still prefer the file
// branch when the path resolves so a user with a session id that
// happens to match a file in their cwd gets a clear "decode this
// file" error instead of a confusing daemon 404.
async function readBundleFileIfExists(
  arg: string,
): Promise<{ raw: unknown } | null> {
  try {
    const stat = await fs.stat(arg);
    if (!stat.isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  const text = await fs.readFile(arg, "utf8");
  try {
    return { raw: JSON.parse(text) };
  } catch (err) {
    process.stderr.write(`Failed to parse bundle file: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

function decodeBundleOrExit(raw: unknown): Bundle {
  try {
    return decodeBundle(raw);
  } catch (err) {
    process.stderr.write(`Not a valid bundle: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

export async function runSessionsImport(
  file: string | undefined,
  opts: { replace?: boolean; cwd?: string; info?: boolean } = {},
): Promise<void> {
  if (!file) {
    process.stderr.write(
      "Usage: hydra-acp sessions import <file>|- [--replace] [--cwd <path>] [--info]\n",
    );
    process.exit(2);
  }
  let cwdOverride: string | undefined;
  if (opts.cwd !== undefined) {
    const resolved = path.resolve(opts.cwd);
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        process.stderr.write(`--cwd ${resolved} is not a directory\n`);
        process.exit(1);
      }
    } catch {
      process.stderr.write(`--cwd ${resolved} does not exist\n`);
      process.exit(1);
    }
    cwdOverride = resolved;
  }
  let body: string;
  if (file === "-") {
    body = await readStdin();
  } else {
    body = await fs.readFile(file, "utf8");
  }
  let bundle: unknown;
  try {
    bundle = JSON.parse(body);
  } catch (err) {
    process.stderr.write(`Failed to parse bundle: ${(err as Error).message}\n`);
    process.exit(1);
  }
  if (opts.info === true) {
    const inspectConfig = await loadConfigReadOnly();
    printBundleInfo(bundle, inspectConfig.tui.cwdColumnMaxWidth);
    return;
  }
  const config = await loadConfig();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const response = await fetch(`${baseUrl}/v1/sessions/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.daemon.authToken}`,
    },
    body: JSON.stringify({
      bundle,
      replace: opts.replace === true,
      ...(cwdOverride !== undefined ? { cwd: cwdOverride } : {}),
    }),
  });
  if (response.status === 409) {
    const detail = (await response.json().catch(() => ({}))) as {
      existingSessionId?: string;
    };
    process.stderr.write(
      `Bundle already imported as ${detail.existingSessionId ?? "unknown"}. Use --replace to overwrite.\n`,
    );
    process.exit(1);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    process.stderr.write(`Daemon returned HTTP ${response.status}: ${text}\n`);
    process.exit(1);
  }
  const result = (await response.json()) as {
    sessionId: string;
    importedFromSessionId: string;
    replaced: boolean;
  };
  process.stdout.write(
    result.replaced
      ? `Replaced ${result.sessionId} (from ${result.importedFromSessionId})\n`
      : `Imported as ${result.sessionId} (from ${result.importedFromSessionId})\n`,
  );
}

// Map a Bundle to the SessionSummary shape the list formatter consumes.
// upstreamSessionId is left undefined so toRow falls through to the
// import-machine breadcrumb (`← <host>`) — that's more informative
// than a bare "-" for a bundle preview, which by definition came
// from another machine. attachedClients/status mark this as inert.
export function bundleToSummary(parsed: Bundle): SessionSummary {
  return {
    sessionId: parsed.session.sessionId,
    cwd: parsed.session.cwd,
    agentId: parsed.session.agentId,
    currentUsage: parsed.session.currentUsage,
    title: parsed.session.title,
    importedFromMachine: parsed.exportedFrom.machine,
    attachedClients: 0,
    updatedAt: parsed.session.updatedAt,
    status: "cold",
  };
}

// Render a single-row "session list" view of a bundle file, using the
// same column layout as `hydra sessions list`. Local-only — never hits
// the daemon — so it works on a host that isn't running hydra and on
// bundles the user hasn't imported yet.
function printBundleInfo(raw: unknown, cwdColumnMaxWidth: number): void {
  let parsed;
  try {
    parsed = decodeBundle(raw);
  } catch (err) {
    process.stderr.write(`Not a valid bundle: ${(err as Error).message}\n`);
    process.exit(1);
  }
  const summary = bundleToSummary(parsed);
  const row = toRow(summary);
  const widths = computeWidths([row]);
  const maxWidth = process.stdout.isTTY ? process.stdout.columns : undefined;
  process.stdout.write(formatRow(HEADER, widths, maxWidth, cwdColumnMaxWidth) + "\n");
  process.stdout.write(formatRow(row, widths, maxWidth, cwdColumnMaxWidth) + "\n");
  const originUpstream = parsed.session.upstreamSessionId ?? "-";
  process.stdout.write(
    `\nlineage: ${parsed.session.lineageId}\n` +
      `exported: ${parsed.exportedAt} from ${parsed.exportedFrom.machine} (hydra ${parsed.exportedFrom.hydraVersion})\n` +
      `origin session: ${parsed.session.sessionId}\n` +
      `origin upstream: ${originUpstream}\n` +
      `history entries: ${parsed.history.length}` +
      (parsed.promptHistory
        ? `, prompt history: ${parsed.promptHistory.length}\n`
        : "\n"),
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function deriveFilenameFrom(response: Response, id: string): string {
  const cd = response.headers.get("content-disposition");
  if (cd) {
    const match = cd.match(/filename="([^"]+)"/);
    if (match) {
      return match[1]!;
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `hydra-${id}-${stamp}.hydra`;
}

export function httpBase(host: string, port: number, tls: boolean): string {
  const protocol = tls ? "https" : "http";
  return `${protocol}://${host}:${port}`;
}
