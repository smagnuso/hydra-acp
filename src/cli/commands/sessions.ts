import { loadConfig } from "../../core/config.js";

export async function runSessionsList(opts: { all?: boolean } = {}): Promise<void> {
  const config = await loadConfig();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const url = new URL(`${baseUrl}/v1/sessions`);
  if (opts.all) {
    url.searchParams.set("all", "true");
  }
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
  const rows = body.sessions.map((s) => ({
    session: s.sessionId,
    status: (s.status ?? "live").toUpperCase(),
    clients: s.status === "cold" ? "-" : String(s.attachedClients),
    agent: s.agentId ?? "?",
    title: s.title ?? "-",
    cwd: s.cwd,
  }));
  const header = {
    session: "SESSION",
    status: "STATUS",
    clients: "CLIENTS",
    agent: "AGENT",
    title: "TITLE",
    cwd: "CWD",
  };
  const widths = {
    session: maxLen(header.session, rows.map((r) => r.session)),
    status: maxLen(header.status, rows.map((r) => r.status)),
    clients: maxLen(header.clients, rows.map((r) => r.clients)),
    agent: maxLen(header.agent, rows.map((r) => r.agent)),
    title: maxLen(header.title, rows.map((r) => r.title)),
  };
  const formatRow = (r: typeof header): string =>
    [
      r.session.padEnd(widths.session),
      r.status.padEnd(widths.status),
      r.clients.padStart(widths.clients),
      r.agent.padEnd(widths.agent),
      r.title.padEnd(widths.title),
      r.cwd,
    ].join("  ");
  process.stdout.write(formatRow(header) + "\n");
  for (const r of rows) {
    process.stdout.write(formatRow(r) + "\n");
  }
}

function maxLen(headerCell: string, values: string[]): number {
  let max = headerCell.length;
  for (const v of values) {
    if (v.length > max) {
      max = v.length;
    }
  }
  return max;
}

export async function runSessionsKill(id: string | undefined): Promise<void> {
  if (!id) {
    process.stderr.write("Usage: acp-hydra sessions kill <session-id>\n");
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
  process.stdout.write(`Killed ${id}\n`);
}

export function httpBase(host: string, port: number, tls: boolean): string {
  const protocol = tls ? "https" : "http";
  return `${protocol}://${host}:${port}`;
}
