import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { hasBin } from "./tailscale.js";

export type SelfSignedResult =
  | { kind: "ok" }
  | { kind: "no-openssl" }
  | { kind: "error"; message: string };

// 825 days is the longest validity Apple platforms accept for a TLS leaf,
// even one the user has trusted by hand, so the browser extension can serve
// a phone with this same cert.
export function mintSelfSignedCert(opts: {
  commonName: string;
  altNames: string[];
  certPath: string;
  keyPath: string;
}): SelfSignedResult {
  if (!hasBin("openssl")) {
    return { kind: "no-openssl" };
  }
  const result = spawnSync(
    "openssl",
    [
      "req", "-x509",
      "-newkey", "rsa:2048",
      "-sha256",
      "-days", "825",
      "-nodes",
      "-keyout", opts.keyPath,
      "-out", opts.certPath,
      "-subj", `/CN=${opts.commonName}`,
      "-addext", `subjectAltName=${opts.altNames.join(",")}`,
      // Apple platforms refuse to trust a server cert without this, even
      // when the user installs it by hand.
      "-addext", "extendedKeyUsage=serverAuth",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    return { kind: "error", message: `openssl failed: ${result.stderr?.trim() || `exit ${result.status ?? "?"}`}` };
  }
  try {
    chmodSync(opts.keyPath, 0o600);
    chmodSync(opts.certPath, 0o600);
  } catch {
    // chmod isn't meaningful on Windows
  }
  return { kind: "ok" };
}
