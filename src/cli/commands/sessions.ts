import { loadConfig } from "../../core/config.js";

export async function runSessionsList(): Promise<void> {
  const config = await loadConfig();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const response = await fetch(`${baseUrl}/v1/sessions`, {
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
    }>;
  };
  if (body.sessions.length === 0) {
    process.stdout.write("No active sessions.\n");
    return;
  }
  for (const s of body.sessions) {
    process.stdout.write(
      `${s.sessionId}\t${s.agentId ?? "?"}\tclients=${s.attachedClients}\t${s.cwd}\n`,
    );
  }
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
