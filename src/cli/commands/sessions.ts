import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "../../core/config.js";
import {
  HEADER,
  computeWidths,
  formatRow,
  toRow,
} from "../session-row.js";

export async function runSessionsList(opts: { all?: boolean } = {}): Promise<void> {
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
  process.stdout.write(formatRow(HEADER, widths, maxWidth) + "\n");
  for (const r of rows) {
    process.stdout.write(formatRow(r, widths, maxWidth) + "\n");
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

export async function runSessionsImport(
  file: string | undefined,
  opts: { replace?: boolean } = {},
): Promise<void> {
  if (!file) {
    process.stderr.write(
      "Usage: hydra-acp sessions import <file>|- [--replace]\n",
    );
    process.exit(2);
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
  const config = await loadConfig();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const response = await fetch(`${baseUrl}/v1/sessions/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.daemon.authToken}`,
    },
    body: JSON.stringify({ bundle, replace: opts.replace === true }),
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
