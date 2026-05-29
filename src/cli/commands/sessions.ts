import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "../../core/config.js";
import { loadServiceToken } from "../../core/service-token.js";
import { resolveLocalTarget } from "../../core/remote-target.js";
import { formatHydraUrl, isLoopbackHost } from "../../core/remote-url.js";
import { stripHydraSessionPrefix } from "../../core/session.js";
import { listSessions, pickMostRecent } from "../../tui/discovery.js";
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
  opts: {
    all?: boolean;
    json?: boolean;
    host?: string;
    includeNonInteractive?: boolean;
  } = {},
): Promise<void> {
  const config = await loadConfig();
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const url = new URL(`${baseUrl}/v1/sessions`);
  // `--all` means "show everything in scope" — it lifts the cold-recency
  // cap (below) AND drops the non-interactive filter. `--include-non-
  // interactive` stays as the narrower knob (surface ancillary rows but
  // still respect the cold cap).
  if (opts.includeNonInteractive || opts.all) {
    url.searchParams.set("includeNonInteractive", "true");
  }
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${serviceToken}` },
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
      importedFromMachine?: string;
      originatingClient?: { name: string; version?: string };
    }>;
  };
  // The daemon already applied the interactive filter unless we asked
  // for `?includeNonInteractive=true` above. No client-side cat-name
  // check needed; the tristate handles cat AND any future ancillary
  // tool that tags itself non-interactive on session/new.
  const sessionsAfterInteractiveFilter = body.sessions;
  // Host filter:
  //   "local" — sessions created here OR imported and bound to a local
  //             agent (upstreamSessionId set). The "I'm working on this
  //             here" bucket.
  //   "all"   — every session, no filter.
  //   <host>  — passive mirrors imported from <host> that haven't been
  //             attached locally yet. Once you attach, the session
  //             graduates to "local" and stops appearing here.
  // Default is "local". Applied before --json so scripts see the same
  // view as humans.
  const host = opts.host ?? "local";
  const hostFiltered = host === "all"
    ? sessionsAfterInteractiveFilter
    : host === "local"
      ? sessionsAfterInteractiveFilter.filter(
          (s) => !s.importedFromMachine || !!s.upstreamSessionId,
        )
      : sessionsAfterInteractiveFilter.filter(
          (s) =>
            s.importedFromMachine === host && !s.upstreamSessionId,
        );
  // --json bypasses the table renderer and the cold-cap truncation:
  // a script wants the full list verbatim, not a TTY-trimmed view.
  // The host filter still applies — scripts read the same world view
  // as the table does, so `--json --host=all` is the way to get raw.
  if (opts.json) {
    process.stdout.write(JSON.stringify(hostFiltered, null, 2) + "\n");
    return;
  }
  if (hostFiltered.length === 0) {
    if (host === "local" && body.sessions.length > 0) {
      process.stdout.write(
        "No local sessions. Use --host=all to include imported sessions.\n",
      );
      return;
    }
    if (host !== "local" && host !== "all") {
      process.stdout.write(`No sessions from ${host}.\n`);
      return;
    }
    process.stdout.write("No active sessions.\n");
    return;
  }
  const sorted = hostFiltered.slice().sort((a, b) => {
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
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const response = await fetch(`${baseUrl}/v1/sessions/${id}/kill`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceToken}` },
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
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const response = await fetch(`${baseUrl}/v1/sessions/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${serviceToken}` },
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
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const response = await fetch(
    `${baseUrl}/v1/sessions/${encodeURIComponent(id)}/export`,
    {
      headers: { Authorization: `Bearer ${serviceToken}` },
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
    const serviceToken = await loadServiceToken();
    const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
    const response = await fetch(
      `${baseUrl}/v1/sessions/${encodeURIComponent(idOrFile)}/transcript`,
      {
        headers: { Authorization: `Bearer ${serviceToken}` },
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
    const inspectConfig = await loadConfig();
    printBundleInfo(bundle, inspectConfig.tui.cwdColumnMaxWidth);
    return;
  }
  const config = await loadConfig();
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const response = await fetch(`${baseUrl}/v1/sessions/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceToken}`,
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

// Print a hydra:// URL the recipient can paste into `--session`.
// Host precedence: --host flag > config.daemon.publicHost > config.daemon.host
// > "127.0.0.1" (with a warning that the URL is loopback-only).
//
// With no id, falls back to the most-recent session in cwd — mirrors the
// behavior of `hydra-acp tui --reattach`. The wire form of the session
// id (hydra_session_<tail>) is stripped to the short display form so
// the printed URL is short and copy-paste friendly; the attach side
// accepts either form via the daemon's resolveCanonicalId.
export async function runSessionsShare(
  idArg: string | undefined,
  opts: { host?: string; cwd?: string } = {},
): Promise<void> {
  const config = await loadConfig();

  let sessionId: string;
  if (idArg !== undefined && idArg.length > 0) {
    sessionId = idArg;
  } else {
    const target = await resolveLocalTarget(config);
    const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
    const sessions = await listSessions(target, { cwd, all: true });
    const recent = pickMostRecent(sessions, cwd);
    if (!recent) {
      process.stderr.write(`No sessions found for ${cwd}.\n`);
      process.exit(1);
    }
    sessionId = recent.sessionId;
  }

  const { host, port, isFallback } = resolveShareHost(opts.host, config);
  const short = stripHydraSessionPrefix(sessionId);
  const url = formatHydraUrl({ host, port, sessionId: short });
  process.stdout.write(url + "\n");

  if (isFallback) {
    process.stderr.write(
      "Note: this URL points at loopback (127.0.0.1) and only works from the same machine. " +
        "Set daemon.publicHost in config.json or pass --host <name> to advertise an externally-reachable hostname.\n",
    );
  }
}

// Pick the host (and port) to advertise. Precedence:
//   1. --host flag — assume tunneled / public, default port 443.
//   2. config.daemon.publicHost — same: public-facing name on 443.
//   3. config.daemon.host (when non-loopback) — direct connection, so
//      use the daemon's actual bound port.
//   4. "127.0.0.1" + the daemon's port (with isFallback=true).
// Either of #1 or #2 may carry an explicit ":port" suffix, which wins
// over the 443 default.
function resolveShareHost(
  flag: string | undefined,
  config: { daemon: { host: string; port: number; publicHost?: string } },
): { host: string; port: number; isFallback: boolean } {
  if (flag !== undefined && flag.length > 0) {
    const { host, port } = splitHostPort(flag, 443);
    return { host, port, isFallback: false };
  }
  if (config.daemon.publicHost && config.daemon.publicHost.length > 0) {
    const { host, port } = splitHostPort(config.daemon.publicHost, 443);
    return { host, port, isFallback: false };
  }
  if (!isLoopbackHost(config.daemon.host)) {
    return { host: config.daemon.host, port: config.daemon.port, isFallback: false };
  }
  return { host: "127.0.0.1", port: config.daemon.port, isFallback: true };
}

// Parse a "host:port" or bare "host" value, returning the explicit
// port when present or `defaultPort` otherwise. Bracketed IPv6
// literals (`[::1]:443`) are tolerated. Invalid ports fall through
// to defaultPort silently — we'd rather emit a working URL than abort
// the share over a misconfigured publicHost.
function splitHostPort(input: string, defaultPort: number): { host: string; port: number } {
  if (input.startsWith("[")) {
    const close = input.indexOf("]");
    if (close > 0) {
      const host = input.slice(1, close);
      const rest = input.slice(close + 1);
      if (rest.startsWith(":")) {
        const n = Number(rest.slice(1));
        return { host, port: Number.isInteger(n) && n > 0 ? n : defaultPort };
      }
      return { host, port: defaultPort };
    }
  }
  const colon = input.lastIndexOf(":");
  if (colon > 0 && input.indexOf(":") === colon) {
    const host = input.slice(0, colon);
    const n = Number(input.slice(colon + 1));
    if (Number.isInteger(n) && n > 0) {
      return { host, port: n };
    }
  }
  return { host: input, port: defaultPort };
}
