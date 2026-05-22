import { loadConfig } from "../../core/config.js";
import { loadServiceToken } from "../../core/service-token.js";
import {
  hasPassword,
  setPassword,
  verifyPassword,
} from "../../core/password.js";
import { promptPassword } from "../../core/prompt-password.js";
import { httpBase } from "./sessions.js";
import { flagBool } from "../parse-args.js";

interface SessionTokenSummary {
  id: string;
  label?: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
}

export async function runAuthPasswordSet(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const force = flagBool(flags, "force");
  if ((await hasPassword()) && !force) {
    const current = await promptPassword("Current password: ");
    if (!(await verifyPassword(current))) {
      process.stderr.write("Wrong password.\n");
      process.exit(1);
    }
  }
  const next = await promptPassword("New password: ");
  if (next.length === 0) {
    process.stderr.write("Password must not be empty.\n");
    process.exit(2);
  }
  const confirm = await promptPassword("Confirm new password: ");
  if (next !== confirm) {
    process.stderr.write("Passwords did not match.\n");
    process.exit(1);
  }
  await setPassword(next);
  process.stdout.write("Password set.\n");
}

export async function runAuthList(): Promise<void> {
  const config = await loadConfig();
  const token = await loadServiceToken();
  const baseUrl = httpBase(
    config.daemon.host,
    config.daemon.port,
    !!config.daemon.tls,
  );
  const r = await fetch(`${baseUrl}/v1/auth/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    process.stderr.write(`Daemon returned HTTP ${r.status}\n`);
    process.exit(1);
  }
  const body = (await r.json()) as { sessions: SessionTokenSummary[] };
  if (body.sessions.length === 0) {
    process.stdout.write("No active session tokens.\n");
    return;
  }
  const header = {
    id: "ID",
    label: "LABEL",
    createdAt: "CREATED",
    expiresAt: "EXPIRES",
    lastUsedAt: "LAST USED",
  };
  const rows = body.sessions.map((s) => ({
    id: s.id,
    label: s.label ?? "-",
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    lastUsedAt: s.lastUsedAt,
  }));
  const widths = {
    id: maxLen(header.id, rows.map((r) => r.id)),
    label: maxLen(header.label, rows.map((r) => r.label)),
    createdAt: maxLen(header.createdAt, rows.map((r) => r.createdAt)),
    expiresAt: maxLen(header.expiresAt, rows.map((r) => r.expiresAt)),
  };
  const fmt = (r: typeof header): string =>
    [
      r.id.padEnd(widths.id),
      r.label.padEnd(widths.label),
      r.createdAt.padEnd(widths.createdAt),
      r.expiresAt.padEnd(widths.expiresAt),
      r.lastUsedAt,
    ].join("  ");
  process.stdout.write(fmt(header) + "\n");
  for (const r of rows) {
    process.stdout.write(fmt(r) + "\n");
  }
}

export async function runAuthRevoke(id: string | undefined): Promise<void> {
  if (!id) {
    process.stderr.write("Usage: hydra-acp auth revoke <id>\n");
    process.exit(2);
  }
  const config = await loadConfig();
  const token = await loadServiceToken();
  const baseUrl = httpBase(
    config.daemon.host,
    config.daemon.port,
    !!config.daemon.tls,
  );
  const r = await fetch(`${baseUrl}/v1/auth/sessions/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 204) {
    process.stdout.write(`Revoked ${id}\n`);
    return;
  }
  if (r.status === 404) {
    process.stderr.write(`No session token with id ${id}\n`);
    process.exit(1);
  }
  process.stderr.write(`Daemon returned HTTP ${r.status}\n`);
  process.exit(1);
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
