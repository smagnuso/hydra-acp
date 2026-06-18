import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as https from "node:https";
import { AddressInfo } from "node:net";
import {
  _resetForTests,
  clearPin,
  fetchPeerFingerprint,
  formatFingerprint,
  getPin,
  loadPinsFromStore,
  setPin,
  sha256Hex,
} from "./tls-trust.js";
import { RemotesStore } from "./remotes-store.js";

describe("formatFingerprint", () => {
  it("groups hex pairs with colons", () => {
    const hex = "deadbeef00112233445566778899aabbccddeeff";
    expect(formatFingerprint(hex)).toBe(
      "de:ad:be:ef:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff",
    );
  });

  it("normalises colons / case before grouping", () => {
    const formatted = formatFingerprint("DE:AD:BE:EF");
    expect(formatted).toBe("de:ad:be:ef");
  });
});

describe("sha256Hex", () => {
  it("produces a 64-char lowercase hex digest", () => {
    const out = sha256Hex(Buffer.from("hello"));
    expect(out).toMatch(/^[0-9a-f]{64}$/);
    expect(out).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("pin map", () => {
  beforeEach(() => {
    _resetForTests();
  });

  it("stores and retrieves fingerprints keyed by host:port", () => {
    setPin("blackbox.local", 55514, "ABCDEF");
    expect(getPin("blackbox.local", 55514)).toBe("abcdef");
    expect(getPin("blackbox.local", 12345)).toBeUndefined();
  });

  it("normalises colons and case on set", () => {
    setPin("h", 1, "DE:AD:BE:EF");
    expect(getPin("h", 1)).toBe("deadbeef");
  });

  it("clearPin removes the entry", () => {
    setPin("h", 1, "ff");
    clearPin("h", 1);
    expect(getPin("h", 1)).toBeUndefined();
  });

  it("loadPinsFromStore hydrates from a RemotesStore", async () => {
    const store = await RemotesStore.load();
    await store.set("blackbox.local", 55514, {
      token: "tok",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pinnedFingerprint: "abc123",
    });
    _resetForTests();
    loadPinsFromStore(store);
    expect(getPin("blackbox.local", 55514)).toBe("abc123");
  });

  it("loadPinsFromStore skips entries without a fingerprint", async () => {
    const store = await RemotesStore.load();
    await store.set("h", 1, {
      token: "tok",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    _resetForTests();
    loadPinsFromStore(store);
    expect(getPin("h", 1)).toBeUndefined();
  });
});

describe("fetchPeerFingerprint", () => {
  // Stands up a real self-signed TLS server (mints the cert via
  // openssl on PATH) and asserts that the captured fingerprint
  // matches the cert's DER sha256. Skipped silently when openssl
  // isn't available so the suite stays portable.
  let server: https.Server | undefined;
  let port = 0;
  let expectedFp: string | undefined;

  beforeEach(async () => {
    if (server) {
      return;
    }
    const crypto = await import("node:crypto");
    const { execFileSync } = await import("node:child_process");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tls-trust-test-"));
    const keyPath = path.join(tmpDir, "key.pem");
    let pemKey: string;
    let pemCert: string;
    try {
      pemKey = execFileSync("openssl", [
        "genpkey",
        "-algorithm",
        "RSA",
        "-pkeyopt",
        "rsa_keygen_bits:2048",
      ]).toString();
      fs.writeFileSync(keyPath, pemKey);
      pemCert = execFileSync("openssl", [
        "req",
        "-new",
        "-x509",
        "-key",
        keyPath,
        "-days",
        "1",
        "-subj",
        "/CN=tls-trust-test",
      ]).toString();
    } catch {
      return;
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    const x509 = new crypto.X509Certificate(pemCert);
    expectedFp = sha256Hex(x509.raw);
    server = https.createServer({ key: pemKey, cert: pemCert }, (_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });

  it("captures the leaf cert's sha256 fingerprint over an untrusted TLS handshake", async () => {
    if (!server || !expectedFp) {
      // openssl wasn't available; skip rather than fail.
      return;
    }
    const fp = await fetchPeerFingerprint("127.0.0.1", port);
    expect(fp).toBe(expectedFp);
  });
});
