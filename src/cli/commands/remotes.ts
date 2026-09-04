import { parseHydraUrl, isLoopbackHost } from "../../core/remote-url.js";
import { promptPassword } from "../../core/prompt-password.js";
import {
  defaultLabel,
  defaultTlsHandshake,
  promptYesNo,
} from "../../core/remote-target.js";
import { formatFingerprint } from "../../core/tls-trust.js";
import { daemonFetch } from "./_shared.js";
import { resolveOption } from "../parse-args.js";

interface PeerSummary {
  name: string;
  host: string;
  port: number;
  expiresAt: string;
  label?: string;
  addedAt: string;
  status?: "ok" | "unauthorized" | "unreachable" | "unknown";
  lastCheckedAt?: string;
  pinnedFingerprint?: string;
}

// Accepts a bare "host", "host:port", or a full "hydra://host[:port]/"
// URL, and reuses parseHydraUrl's validation for all three by
// prefixing the scheme when it's missing.
function parseHostArg(input: string): { host: string; port: number } {
  const withScheme = input.startsWith("hydra://") ? input : `hydra://${input}/`;
  const parsed = parseHydraUrl(withScheme);
  return { host: parsed.host, port: parsed.port };
}

export async function runRemoteAdd(
  name: string | undefined,
  hostArg: string | undefined,
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (!name || !hostArg) {
    process.stderr.write("Usage: hydra remote add <name> <host[:port]>\n");
    process.exit(2);
  }
  let target: { host: string; port: number };
  try {
    target = parseHostArg(hostArg);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(2);
  }
  // TOFU, same as the human hydra:// login path (resolveRemoteTarget)
  // — probe BEFORE asking for a password so credentials never cross an
  // unverified channel. Loopback never needs this: the daemon dials
  // its peers over plain http for loopback hosts (see
  // core/peer-login.ts), so there's no cert to trust in the first
  // place.
  let pinnedFingerprint: string | undefined;
  if (!isLoopbackHost(target.host)) {
    // A previously-accepted fingerprint for this exact name, if any —
    // so re-running `remote add` to refresh a token before it expires
    // (the documented refresh path) doesn't re-prompt for a cert
    // that's already been through this once. Only a fingerprint that's
    // new or has genuinely CHANGED needs a human to look at it again.
    const existing = await daemonFetch("/v1/remotes", { expectStatus: 200 });
    const existingBody = existing.body as { remotes: PeerSummary[] };
    const previousPin = existingBody.remotes.find((r) => r.name === name)
      ?.pinnedFingerprint;

    const probe = await defaultTlsHandshake(target.host, target.port);
    if (probe.kind === "error") {
      process.stderr.write(
        `Could not connect to ${target.host}:${target.port} for TLS handshake: ${probe.message}\n`,
      );
      process.exit(1);
    }
    if (probe.kind === "untrusted") {
      if (previousPin === probe.fingerprint) {
        pinnedFingerprint = probe.fingerprint;
      } else {
        const summary =
          probe.subject || probe.issuer
            ? `\n  subject: ${probe.subject ?? "(unknown)"}\n  issuer:  ${probe.issuer ?? "(unknown)"}`
            : "";
        if (previousPin) {
          // Mirrors SSH's "REMOTE HOST IDENTIFICATION HAS CHANGED"
          // warning — could be a legitimate cert rotation on the
          // peer, could be something worse; either way it's not the
          // routine case and deserves louder phrasing than first-trust.
          process.stderr.write(
            `WARNING: the certificate presented by ${target.host}:${target.port} has changed since it was last trusted.\n` +
              `  previous sha256: ${formatFingerprint(previousPin)}\n` +
              `  new sha256:      ${formatFingerprint(probe.fingerprint)}${summary}\n`,
          );
        } else {
          process.stderr.write(
            `The certificate presented by ${target.host}:${target.port} is not signed by a trusted CA.\n` +
              `  sha256: ${formatFingerprint(probe.fingerprint)}${summary}\n`,
          );
        }
        const ok = await promptYesNo(
          `Trust this certificate for ${target.host}:${target.port}? [y/N]: `,
        );
        if (!ok) {
          process.stderr.write("Aborted: certificate not trusted.\n");
          process.exit(1);
        }
        pinnedFingerprint = probe.fingerprint;
      }
    }
    // probe.kind === "trusted" → CA-signed; no pin needed.
  }

  // Defaults to this machine's hostname, same as the human login path
  // (resolveRemoteTarget) — so the peer's own `auth list` shows which
  // daemon a token belongs to instead of an anonymous entry.
  const label = resolveOption(flags, "label") ?? defaultLabel();
  const password = await promptPassword(
    `Password for ${target.host}:${target.port}: `,
  );
  if (password.length === 0) {
    process.stderr.write("Password is required to add a remote.\n");
    process.exit(2);
  }

  const res = await daemonFetch("/v1/remotes", {
    method: "POST",
    body: {
      name,
      host: target.host,
      port: target.port,
      password,
      label,
      ...(pinnedFingerprint ? { pinnedFingerprint } : {}),
    },
  });
  if (res.status === 201) {
    const body = res.body as PeerSummary;
    process.stdout.write(
      `Added remote ${body.name} (${body.host}:${body.port})${body.label ? ` [${body.label}]` : ""}, expires ${body.expiresAt}\n`,
    );
    return;
  }
  const body = res.body as { error?: string };
  process.stderr.write(`${body.error ?? `HTTP ${res.status}`}\n`);
  process.exit(1);
}

export async function runRemoteList(): Promise<void> {
  const res = await daemonFetch("/v1/remotes", { expectStatus: 200 });
  const body = res.body as { remotes: PeerSummary[] };
  if (body.remotes.length === 0) {
    process.stdout.write("No remotes configured.\n");
    return;
  }
  const header = {
    name: "NAME",
    host: "HOST",
    status: "STATUS",
    label: "LABEL",
    addedAt: "ADDED",
    expiresAt: "EXPIRES",
  };
  const rows = body.remotes.map((r) => ({
    name: r.name,
    host: `${r.host}:${r.port}`,
    status: r.status ?? "unknown",
    label: r.label ?? "-",
    addedAt: r.addedAt,
    expiresAt: r.expiresAt,
  }));
  const widths = {
    name: maxLen(header.name, rows.map((r) => r.name)),
    host: maxLen(header.host, rows.map((r) => r.host)),
    status: maxLen(header.status, rows.map((r) => r.status)),
    label: maxLen(header.label, rows.map((r) => r.label)),
    addedAt: maxLen(header.addedAt, rows.map((r) => r.addedAt)),
  };
  const fmt = (r: typeof header): string =>
    [
      r.name.padEnd(widths.name),
      r.host.padEnd(widths.host),
      r.status.padEnd(widths.status),
      r.label.padEnd(widths.label),
      r.addedAt.padEnd(widths.addedAt),
      r.expiresAt,
    ].join("  ");
  process.stdout.write(fmt(header) + "\n");
  for (const r of rows) {
    process.stdout.write(fmt(r) + "\n");
  }
}

export async function runRemoteRemove(name: string | undefined): Promise<void> {
  if (!name) {
    process.stderr.write("Usage: hydra remote remove <name>\n");
    process.exit(2);
  }
  const res = await daemonFetch(`/v1/remotes/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (res.status === 204) {
    process.stdout.write(`Removed remote ${name}\n`);
    return;
  }
  if (res.status === 404) {
    process.stderr.write(`No remote named ${name}\n`);
    process.exit(1);
  }
  process.stderr.write(`Daemon returned HTTP ${res.status}\n`);
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
