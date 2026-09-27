// Pure pieces of `hydra-acp daemon listen`: which config a scope writes,
// which scope a config describes, and what a cert on disk says about itself.
// Kept free of I/O so the scope rules can be tested without tailscale,
// openssl or a daemon.

import { X509Certificate } from "node:crypto";
import * as os from "node:os";
import { isLoopbackHost } from "./remote-url.js";

export const LISTEN_SCOPES = ["local", "tailnet", "all"] as const;
export type ListenScope = (typeof LISTEN_SCOPES)[number];

export function isListenScope(s: string): s is ListenScope {
  return (LISTEN_SCOPES as readonly string[]).includes(s);
}

export interface ScopeSettings {
  host: string;
  tls: { cert: string; key: string };
  publicHost?: string;
}

function daemonSection(raw: Record<string, unknown>): Record<string, unknown> {
  const existing = raw.daemon;
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const fresh: Record<string, unknown> = {};
  raw.daemon = fresh;
  return fresh;
}

// `local` deletes rather than writes 127.0.0.1 so the schema default applies.
// It must drop `tls` too: with tls set, the daemon runs its TLS terminator on
// daemon.host, so a loopback host would still serve TLS.
export function applyListenScope(
  raw: Record<string, unknown>,
  settings: ScopeSettings | undefined,
): void {
  const daemon = daemonSection(raw);
  if (!settings) {
    delete daemon.host;
    delete daemon.tls;
    delete daemon.publicHost;
    return;
  }
  daemon.host = settings.host;
  daemon.tls = { cert: settings.tls.cert, key: settings.tls.key };
  if (settings.publicHost) {
    daemon.publicHost = settings.publicHost;
  } else {
    delete daemon.publicHost;
  }
}

export type InferredScope = ListenScope | "custom";

export function inferListenScope(host: string, tailnetIp?: string): InferredScope {
  if (isLoopbackHost(host)) {
    return "local";
  }
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    return "all";
  }
  if (tailnetIp !== undefined && host === tailnetIp) {
    return "tailnet";
  }
  return "custom";
}

export interface CertSummary {
  fingerprint: string;
  issuer: string;
  subjectAltName?: string;
  validTo: Date;
  selfSigned: boolean;
}

export function summarizeCert(pem: string | Buffer): CertSummary {
  const cert = new X509Certificate(pem);
  return {
    // Same normalization tls-trust pins with, so it compares equal to a
    // fingerprint `remote add` stored.
    fingerprint: cert.fingerprint256.replace(/:/g, "").toLowerCase(),
    issuer: cert.issuer.replace(/\n/g, ", "),
    subjectAltName: cert.subjectAltName,
    validTo: new Date(cert.validTo),
    selfSigned: cert.issuer === cert.subject,
  };
}

export function daysUntil(when: Date, now: Date = new Date()): number {
  return Math.floor((when.getTime() - now.getTime()) / 86_400_000);
}

// SANs for a self-signed cert on a wildcard bind: every name and address a
// client on the LAN might plausibly dial.
export function selfSignedAltNames(
  hostname: string = os.hostname(),
  interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
  publicHost?: string,
): string[] {
  const dns = new Set<string>(["localhost", hostname]);
  if (!hostname.includes(".")) {
    dns.add(`${hostname}.local`);
  }
  const ips = new Set<string>(["127.0.0.1", "::1"]);
  if (publicHost) {
    if (/^[\d.]+$/.test(publicHost) || publicHost.includes(":")) {
      ips.add(publicHost);
    } else {
      dns.add(publicHost);
    }
  }
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (!a.internal && !a.address.startsWith("fe80:")) {
        ips.add(a.address);
      }
    }
  }
  return [...[...dns].map((d) => `DNS:${d}`), ...[...ips].map((i) => `IP:${i}`)];
}
