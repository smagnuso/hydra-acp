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

export async function runSessionsRm(id: string | undefined): Promise<void> {
  if (!id) {
    process.stderr.write("Usage: hydra-acp sessions rm <session-id>\n");
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

export function httpBase(host: string, port: number, tls: boolean): string {
  const protocol = tls ? "https" : "http";
  return `${protocol}://${host}:${port}`;
}
