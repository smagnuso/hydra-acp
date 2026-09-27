import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { paths } from "../../core/paths.js";
import {
  DEFAULT_DAEMON_PORT,
  expandHome,
  loadGlobalConfig,
  updateRawConfig,
} from "../../core/config.js";
import { isProcessAlive, readDaemonPidFile } from "../../core/daemon-pidfile.js";
import { hasPassword, setPassword } from "../../core/password.js";
import { promptPassword } from "../../core/prompt-password.js";
import { promptYesNo } from "../../core/remote-target.js";
import { formatFingerprint } from "../../core/tls-trust.js";
import {
  CERTS_UNAVAILABLE_MESSAGE,
  ensurePrivateDir,
  mintTailscaleCert,
  tailscaleStatus,
} from "../../core/tailscale.js";
import { mintSelfSignedCert } from "../../core/self-signed.js";
import {
  applyListenScope,
  daysUntil,
  inferListenScope,
  isListenScope,
  LISTEN_SCOPES,
  selfSignedAltNames,
  summarizeCert,
  type ListenScope,
  type ScopeSettings,
} from "../../core/listen-scope.js";
import { flagBool } from "../parse-args.js";
import { runDaemonRestart } from "./daemon.js";

const EXPIRY_WARN_DAYS = 14;

const USAGE =
  "usage: hydra-acp daemon listen [local|tailnet|all] [--public-host <name>] [--yes] [--no-restart]\n";

function fail(msg: string, code = 1): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

export async function runDaemonListen(
  scopeArg: string | undefined,
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (scopeArg === undefined || scopeArg === "status") {
    await printListenStatus();
    return;
  }
  if (!isListenScope(scopeArg)) {
    fail(`Unknown scope '${scopeArg}'. Expected one of: ${LISTEN_SCOPES.join(", ")}.\n${USAGE}`, 2);
  }
  const publicHostFlag = typeof flags["public-host"] === "string" ? flags["public-host"] : undefined;
  const settings = await settingsForScope(scopeArg, {
    publicHost: publicHostFlag,
    yes: flagBool(flags, "yes"),
  });

  if (settings && !(await hasPassword())) {
    await promptInitialPassword();
  }

  try {
    await updateRawConfig((raw) => applyListenScope(raw, settings));
  } catch (err) {
    fail(`Couldn't update ${paths.config()}: ${(err as Error).message}`);
  }
  process.stdout.write(describeWrite(scopeArg, settings));

  await applyToRunningDaemon(flagBool(flags, "no-restart"));
  await printNextSteps(scopeArg, settings);
}

async function settingsForScope(
  scope: ListenScope,
  opts: { publicHost?: string; yes: boolean },
): Promise<ScopeSettings | undefined> {
  if (scope === "local") {
    return undefined;
  }
  const dir = paths.tlsDir();
  ensurePrivateDir(dir);
  const tls = { cert: path.join(dir, "cert.pem"), key: path.join(dir, "key.pem") };

  if (scope === "tailnet") {
    const status = tailscaleStatus();
    if (status.kind === "not-installed") {
      fail(
        "tailscale not found on PATH. Install it (https://tailscale.com/download), " +
          "or use `hydra-acp daemon listen all` for a self-signed cert on every interface.",
      );
    }
    if (status.kind === "error") {
      fail(status.message);
    }
    process.stdout.write(`Tailnet: ${status.dnsName} (${status.ip})\n`);
    process.stdout.write("Requesting cert from Tailscale (network call, can take a few seconds)...\n");
    const minted = await mintTailscaleCert({
      dnsName: status.dnsName,
      certPath: tls.cert,
      keyPath: tls.key,
      confirmSudo: async () => {
        process.stdout.write(
          "tailscale cert needs access to the tailscaled socket.\n" +
            "Fix this permanently with: sudo tailscale set --operator=$(whoami)\n",
        );
        return promptYesNo("Retry with sudo now instead? [y/N]: ");
      },
    });
    if (minted.kind === "certs-unavailable") {
      fail(CERTS_UNAVAILABLE_MESSAGE);
    }
    if (minted.kind === "declined-sudo") {
      fail("Run `sudo tailscale set --operator=$(whoami)`, then re-run this command.");
    }
    if (minted.kind === "error") {
      fail(minted.message);
    }
    if (minted.chownFailed) {
      process.stderr.write(
        `Warning: couldn't chown the cert files. Fix with: sudo chown ${os.userInfo().username} ${tls.cert} ${tls.key}\n`,
      );
    }
    restrictFiles(tls.cert, tls.key);
    return { host: status.ip, tls, publicHost: opts.publicHost ?? status.dnsName };
  }

  process.stdout.write(
    "This binds the daemon's control API to every interface (0.0.0.0). Anyone who can reach this\n" +
      "machine can try the master password, and a successful login can run agents here.\n" +
      "On a tailnet, `hydra-acp daemon listen tailnet` is narrower and gets a CA-signed cert.\n",
  );
  if (!opts.yes && !(await promptYesNo("Continue? [y/N]: "))) {
    fail("Aborted.");
  }
  // Every client that ran `remote add` pinned this cert's fingerprint, so a
  // re-run must not replace a cert that is still good.
  if (reusableSelfSigned(tls.cert, opts.publicHost)) {
    process.stdout.write(`Keeping the existing self-signed cert at ${tls.cert}.\n`);
    return { host: "0.0.0.0", tls, publicHost: opts.publicHost };
  }
  const minted = mintSelfSignedCert({
    commonName: opts.publicHost ?? os.hostname(),
    altNames: selfSignedAltNames(os.hostname(), os.networkInterfaces(), opts.publicHost),
    certPath: tls.cert,
    keyPath: tls.key,
  });
  if (minted.kind === "no-openssl") {
    fail("openssl not found on PATH; it's needed to generate a self-signed cert.");
  }
  if (minted.kind === "error") {
    fail(minted.message);
  }
  return { host: "0.0.0.0", tls, publicHost: opts.publicHost };
}

function reusableSelfSigned(certPath: string, publicHost: string | undefined): boolean {
  let cert;
  try {
    cert = summarizeCert(fs.readFileSync(certPath));
  } catch {
    return false;
  }
  if (!cert.selfSigned || daysUntil(cert.validTo) < EXPIRY_WARN_DAYS) {
    return false;
  }
  if (publicHost && !(cert.subjectAltName ?? "").split(/,\s*/).some((san) => san.endsWith(`:${publicHost}`))) {
    return false;
  }
  return true;
}

function restrictFiles(...files: string[]): void {
  for (const f of files) {
    try {
      fs.chmodSync(f, 0o600);
    } catch {
      // chmod isn't meaningful on Windows
    }
  }
}

// Fresh-password path only, so unlike `auth password` there are no issued
// session tokens to revoke and no running daemon is needed.
async function promptInitialPassword(): Promise<void> {
  process.stdout.write("Remote clients log in with a master password, and none is set yet.\n");
  const next = await promptPassword("New password: ");
  if (next.length === 0) {
    fail("Password must not be empty.", 2);
  }
  const confirm = await promptPassword("Confirm new password: ");
  if (next !== confirm) {
    fail("Passwords did not match.");
  }
  await setPassword(next);
  process.stdout.write("Password set.\n");
}

function describeWrite(scope: ListenScope, settings: ScopeSettings | undefined): string {
  if (!settings) {
    return `Set scope ${scope}: daemon.host, daemon.tls and daemon.publicHost cleared (loopback, no TLS).\n`;
  }
  return (
    `Set scope ${scope}: daemon.host = ${settings.host}` +
    (settings.publicHost ? `, daemon.publicHost = ${settings.publicHost}` : "") +
    `, daemon.tls = ${settings.tls.cert}\n`
  );
}

async function applyToRunningDaemon(noRestart: boolean): Promise<void> {
  const info = await readDaemonPidFile();
  const running = info !== undefined && isProcessAlive(info.pid);
  if (!running) {
    process.stdout.write("Takes effect when the daemon starts: hydra-acp daemon start\n");
    return;
  }
  if (noRestart) {
    process.stdout.write("Takes effect on the next restart: hydra-acp daemon restart\n");
    return;
  }
  await runDaemonRestart();
}

async function printNextSteps(scope: ListenScope, settings: ScopeSettings | undefined): Promise<void> {
  if (!settings) {
    return;
  }
  const { port } = (await loadGlobalConfig()).daemon;
  const name = settings.publicHost ?? `${os.hostname().split(".")[0]}.local`;
  const target = port === DEFAULT_DAEMON_PORT ? name : `${name}:${port}`;
  process.stdout.write("\nOn another machine:\n");
  process.stdout.write(`  hydra-acp remote add ${target}\n`);
  if (scope === "tailnet") {
    // A CA-signed tailscale cert is only valid for the MagicDNS name. Added
    // by IP it would be pinned as untrusted, and the pin breaks at renewal.
    process.stdout.write("Use the MagicDNS name, not the tailnet IP: the cert is only valid for the name.\n");
    return;
  }
  const cert = summarizeCert(fs.readFileSync(settings.tls.cert));
  process.stdout.write(
    "`remote add` will ask you to trust this self-signed cert. Check the fingerprint matches:\n" +
      `  sha256: ${formatFingerprint(cert.fingerprint)}\n`,
  );
}

async function printListenStatus(): Promise<void> {
  const config = await loadGlobalConfig();
  const { host, port, tls, publicHost } = config.daemon;
  let tailnetIp: string | undefined;
  const probe = inferListenScope(host);
  if (probe === "custom") {
    const status = tailscaleStatus();
    if (status.kind === "ok") {
      tailnetIp = status.ip;
    }
  }
  const scope = inferListenScope(host, tailnetIp);
  process.stdout.write(`Scope:       ${scope}\n`);
  process.stdout.write(`Listening:   ${host}:${port}${tls ? " (TLS)" : ""}\n`);
  if (publicHost) {
    process.stdout.write(`Public host: ${publicHost}\n`);
  }
  if (tls) {
    const certPath = expandHome(tls.cert);
    try {
      const cert = summarizeCert(fs.readFileSync(certPath));
      const days = daysUntil(cert.validTo);
      process.stdout.write(`Cert:        ${certPath}\n`);
      process.stdout.write(`Issuer:      ${cert.selfSigned ? "self-signed" : cert.issuer}\n`);
      process.stdout.write(`Fingerprint: ${formatFingerprint(cert.fingerprint)}\n`);
      process.stdout.write(`Expires:     ${cert.validTo.toISOString().slice(0, 10)} (${days} days)\n`);
      if (days < EXPIRY_WARN_DAYS) {
        const renew = scope === "tailnet" || scope === "all" ? `hydra-acp daemon listen ${scope}` : "a new cert";
        process.stdout.write(`Warning: cert expires in ${days} days. Renew with: ${renew}\n`);
      }
    } catch (err) {
      process.stdout.write(`Cert:        ${certPath} (unreadable: ${(err as Error).message})\n`);
    }
  }
  const info = await readDaemonPidFile();
  if (info && isProcessAlive(info.pid) && (info.host !== host || info.port !== port)) {
    process.stdout.write(
      `Note: the running daemon is bound to ${info.host}:${info.port}. Restart to apply: hydra-acp daemon restart\n`,
    );
  }
}
