import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { NetworkInterfaceInfo } from "node:os";
import { HydraConfig } from "./config.js";
import {
  applyListenScope,
  daysUntil,
  inferListenScope,
  selfSignedAltNames,
  summarizeCert,
} from "./listen-scope.js";
import { mintSelfSignedCert } from "./self-signed.js";
import { hasBin, isCertsUnavailableError, isPermissionError, parseTailscaleStatus } from "./tailscale.js";

const TLS = { cert: "/h/.hydra-acp/tls/cert.pem", key: "/h/.hydra-acp/tls/key.pem" };

describe("applyListenScope", () => {
  it("writes host, tls and publicHost for a remote scope, keeping sibling keys", () => {
    const raw: Record<string, unknown> = { daemon: { port: 6000, logLevel: "debug" } };
    applyListenScope(raw, { host: "100.64.0.5", tls: TLS, publicHost: "box.tail1.ts.net" });
    expect(raw.daemon).toEqual({
      port: 6000,
      logLevel: "debug",
      host: "100.64.0.5",
      tls: TLS,
      publicHost: "box.tail1.ts.net",
    });
    expect(() => HydraConfig.parse(raw)).not.toThrow();
  });

  it("drops a stale publicHost when the new scope has none", () => {
    const raw: Record<string, unknown> = { daemon: { publicHost: "old.example" } };
    applyListenScope(raw, { host: "0.0.0.0", tls: TLS });
    expect((raw.daemon as Record<string, unknown>).publicHost).toBeUndefined();
  });

  it("local clears host, tls and publicHost so loopback does not serve TLS", () => {
    const raw: Record<string, unknown> = {
      daemon: { host: "100.64.0.5", tls: TLS, publicHost: "box", port: 6000 },
    };
    applyListenScope(raw, undefined);
    expect(raw.daemon).toEqual({ port: 6000 });
    const parsed = HydraConfig.parse(raw);
    expect(parsed.daemon.host).toBe("127.0.0.1");
    expect(parsed.daemon.tls).toBeUndefined();
  });

  it("creates the daemon section when config has none", () => {
    const raw: Record<string, unknown> = {};
    applyListenScope(raw, { host: "0.0.0.0", tls: TLS });
    expect(raw.daemon).toEqual({ host: "0.0.0.0", tls: TLS });
  });
});

describe("inferListenScope", () => {
  it("classifies loopback, wildcard, tailnet and anything else", () => {
    expect(inferListenScope("127.0.0.1")).toBe("local");
    expect(inferListenScope("::1")).toBe("local");
    expect(inferListenScope("0.0.0.0")).toBe("all");
    expect(inferListenScope("::")).toBe("all");
    expect(inferListenScope("100.64.0.5", "100.64.0.5")).toBe("tailnet");
    expect(inferListenScope("100.64.0.5", "100.64.0.9")).toBe("custom");
    expect(inferListenScope("192.168.1.4")).toBe("custom");
  });
});

describe("selfSignedAltNames", () => {
  const ifaces = {
    lo: [{ address: "127.0.0.1", internal: true } as NetworkInterfaceInfo],
    eth0: [
      { address: "192.168.1.4", internal: false } as NetworkInterfaceInfo,
      { address: "fe80::1", internal: false } as NetworkInterfaceInfo,
    ],
  };

  it("covers the hostname, its .local form and external addresses, not link-local", () => {
    const sans = selfSignedAltNames("box", ifaces);
    expect(sans).toContain("DNS:box");
    expect(sans).toContain("DNS:box.local");
    expect(sans).toContain("DNS:localhost");
    expect(sans).toContain("IP:192.168.1.4");
    expect(sans).not.toContain("IP:fe80::1");
  });

  it("adds a public host as DNS or IP depending on its form", () => {
    expect(selfSignedAltNames("box", ifaces, "dev.example.com")).toContain("DNS:dev.example.com");
    expect(selfSignedAltNames("box", ifaces, "203.0.113.7")).toContain("IP:203.0.113.7");
  });

  it("does not add .local to a fully qualified hostname", () => {
    expect(selfSignedAltNames("box.corp.example", ifaces)).not.toContain("DNS:box.corp.example.local");
  });
});

describe("parseTailscaleStatus", () => {
  it("returns the MagicDNS name without its trailing dot and prefers IPv4", () => {
    const out = JSON.stringify({
      BackendState: "Running",
      Self: { DNSName: "box.tail1.ts.net.", TailscaleIPs: ["fd7a:115c::5", "100.64.0.5"] },
    });
    expect(parseTailscaleStatus(out)).toEqual({ kind: "ok", dnsName: "box.tail1.ts.net", ip: "100.64.0.5" });
  });

  it("reports a logged-out backend", () => {
    const r = parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin" }));
    expect(r.kind).toBe("error");
  });

  it("reports missing MagicDNS", () => {
    const r = parseTailscaleStatus(JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["100.64.0.5"] } }));
    expect(r.kind).toBe("error");
  });

  it("reports unparseable output", () => {
    expect(parseTailscaleStatus("not json").kind).toBe("error");
  });
});

describe("tailscale cert error classification", () => {
  it("recognizes both wordings of certs being unavailable", () => {
    expect(isCertsUnavailableError("500 Internal Server Error: HTTPS is not enabled for your tailnet")).toBe(true);
    expect(isCertsUnavailableError("your Tailscale account does not support getting TLS certs")).toBe(true);
    expect(isCertsUnavailableError("connection refused")).toBe(false);
  });

  it("recognizes socket permission failures", () => {
    expect(isPermissionError("Access denied: cert access denied")).toBe(true);
    expect(isPermissionError("use 'sudo tailscale cert' or 'tailscale set --operator=$USER'")).toBe(true);
    expect(isPermissionError("no such host")).toBe(false);
  });
});

describe.skipIf(!hasBin("openssl"))("self-signed cert", () => {
  it("mints a cert summarizeCert can read, valid for about 825 days", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-listen-"));
    try {
      const certPath = path.join(dir, "cert.pem");
      const keyPath = path.join(dir, "key.pem");
      const r = mintSelfSignedCert({
        commonName: "box",
        altNames: ["DNS:box", "IP:127.0.0.1"],
        certPath,
        keyPath,
      });
      expect(r.kind).toBe("ok");
      const cert = summarizeCert(fs.readFileSync(certPath));
      expect(cert.selfSigned).toBe(true);
      expect(cert.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(cert.subjectAltName).toContain("DNS:box");
      expect(daysUntil(cert.validTo)).toBeGreaterThan(820);
      if (process.platform !== "win32") {
        expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
