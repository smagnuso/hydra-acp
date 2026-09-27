// Tailscale plumbing for `hydra-acp daemon listen tailnet`. Ported from
// hydra-acp-browser's tailscale-wizard, minus the terminal output: callers
// own the prompts and messages, this module only runs `tailscale` and
// classifies what came back.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, join } from "node:path";

export function hasBin(name: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of dirs) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      if (existsSync(join(dir, name + ext))) {
        return true;
      }
    }
  }
  return false;
}

export type TailscaleStatus =
  | { kind: "ok"; dnsName: string; ip: string }
  | { kind: "not-installed" }
  | { kind: "error"; message: string };

interface RawStatus {
  BackendState?: string;
  Self?: { DNSName?: string; TailscaleIPs?: string[] };
}

export function parseTailscaleStatus(stdout: string): TailscaleStatus {
  let status: RawStatus;
  try {
    status = JSON.parse(stdout) as RawStatus;
  } catch {
    return { kind: "error", message: "Couldn't parse `tailscale status --json` output." };
  }
  if (status.BackendState !== "Running") {
    return {
      kind: "error",
      message: `Tailscale isn't logged in (state: ${status.BackendState ?? "unknown"}). Run \`sudo tailscale up\` first.`,
    };
  }
  const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
  const ips = status.Self?.TailscaleIPs ?? [];
  const ip = ips.find((a) => !a.includes(":")) ?? ips[0];
  if (!dnsName || !ip) {
    return {
      kind: "error",
      message:
        "Couldn't read this device's MagicDNS name or tailnet IP from `tailscale status`. Is MagicDNS enabled for this tailnet?",
    };
  }
  return { kind: "ok", dnsName, ip };
}

export function tailscaleStatus(): TailscaleStatus {
  if (!hasBin("tailscale")) {
    return { kind: "not-installed" };
  }
  const result = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8" });
  if (result.status !== 0) {
    return {
      kind: "error",
      message: `tailscale status failed: ${result.stderr?.trim() || "unknown error"}. Is tailscaled running?`,
    };
  }
  return parseTailscaleStatus(result.stdout);
}

export function isPermissionError(stderr: string): boolean {
  return /access denied|permission denied|must be root|operator/i.test(stderr);
}

// Tailscale's wording varies ("HTTPS is not enabled for your tailnet" from
// older CLI builds vs. "your Tailscale account does not support getting TLS
// certs" from the control plane), so match both.
export function isCertsUnavailableError(stderr: string): boolean {
  return /https is not enabled|does not support getting tls certs/i.test(stderr);
}

export const CERTS_UNAVAILABLE_MESSAGE =
  "This tailnet doesn't have HTTPS certificates enabled (or your plan doesn't support them). " +
  "Enable them at https://login.tailscale.com/admin/dns (DNS tab, HTTPS Certificates); " +
  "see https://tailscale.com/kb/1153/enabling-https.";

export type MintResult =
  | { kind: "ok"; usedSudo: boolean; chownFailed: boolean }
  | { kind: "certs-unavailable" }
  | { kind: "declined-sudo" }
  | { kind: "error"; message: string };

export async function mintTailscaleCert(opts: {
  dnsName: string;
  certPath: string;
  keyPath: string;
  // Asked only when plain `tailscale cert` hits a permission error.
  confirmSudo: () => Promise<boolean>;
}): Promise<MintResult> {
  const certArgs = ["cert", "--cert-file", opts.certPath, "--key-file", opts.keyPath, opts.dnsName];
  const attempt = spawnSync("tailscale", certArgs, { encoding: "utf8" });
  if (attempt.status === 0) {
    return { kind: "ok", usedSudo: false, chownFailed: false };
  }
  const stderr = attempt.stderr?.trim() ?? "";
  if (isCertsUnavailableError(stderr)) {
    return { kind: "certs-unavailable" };
  }
  if (!isPermissionError(stderr)) {
    return { kind: "error", message: `tailscale cert failed: ${stderr || "unknown error"}` };
  }
  if (!(await opts.confirmSudo())) {
    return { kind: "declined-sudo" };
  }
  // stdin stays on the terminal so sudo can prompt; stderr is captured so a
  // certs-unavailable failure is still recognizable.
  const sudoAttempt = spawnSync("sudo", ["tailscale", ...certArgs], {
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (sudoAttempt.status !== 0) {
    const sudoStderr = sudoAttempt.stderr?.trim() ?? "";
    if (isCertsUnavailableError(sudoStderr)) {
      return { kind: "certs-unavailable" };
    }
    return {
      kind: "error",
      message: `tailscale cert failed even with sudo: ${sudoStderr || `exit ${sudoAttempt.status ?? "?"}`}`,
    };
  }
  // tailscale ran as root and owns the files; the daemon runs as this user.
  const chown = spawnSync("sudo", ["chown", userInfo().username, opts.certPath, opts.keyPath], {
    stdio: "inherit",
  });
  return { kind: "ok", usedSudo: true, chownFailed: chown.status !== 0 };
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // chmod isn't meaningful on Windows
  }
}
