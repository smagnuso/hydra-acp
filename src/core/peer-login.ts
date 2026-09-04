// Daemon-side counterpart to the password → session-token exchange
// `resolveRemoteTarget` performs for a human CLI/TUI login. Used by
// `POST /v1/remotes` (see daemon/routes/remotes.ts): the daemon itself
// logs into a peer daemon, exactly the way a human would via
// `hydra session attach hydra://<peer>/...`, and keeps only the
// resulting revocable token — never the password.

import { isLoopbackHost } from "./remote-url.js";

export class PeerLoginError extends Error {
  // Suggested HTTP status for the route handler to report back to
  // *our own* caller (the `hydra remote add` CLI), distinct from
  // whatever status the peer itself returned.
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PeerLoginError";
    this.status = status;
  }
}

export interface PeerLoginResult {
  token: string;
  expiresAt: string;
}

export interface PeerLoginOptions {
  host: string;
  port: number;
  password: string;
  label?: string;
  ttlSec?: number;
  fetchImpl?: typeof fetch;
}

function baseUrlFor(host: string, port: number): string {
  const scheme = isLoopbackHost(host) ? "http" : "https";
  return `${scheme}://${host}:${port}`;
}

export async function loginToPeer(
  opts: PeerLoginOptions,
): Promise<PeerLoginResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const display = `${opts.host}:${opts.port}`;
  const baseUrl = baseUrlFor(opts.host, opts.port);

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password: opts.password,
        label: opts.label,
        ttlSec: opts.ttlSec,
      }),
    });
  } catch (err) {
    throw new PeerLoginError(
      `Could not reach ${display}: ${(err as Error).message}`,
      502,
    );
  }

  if (response.status === 401) {
    throw new PeerLoginError(`Wrong password for ${display}.`, 401);
  }
  if (response.status === 403) {
    throw new PeerLoginError(
      `No password is configured on ${display}. Run \`hydra-acp auth password\` on that daemon first.`,
      502,
    );
  }
  if (response.status === 429) {
    throw new PeerLoginError(
      `Too many failed login attempts on ${display}; try again later.`,
      429,
    );
  }
  if (!response.ok) {
    throw new PeerLoginError(
      `Login to ${display} failed: HTTP ${response.status}`,
      502,
    );
  }

  const body = (await response.json()) as {
    session_token?: string;
    expires_at?: string;
  };
  if (!body.session_token || !body.expires_at) {
    throw new PeerLoginError(
      `Login to ${display} returned a malformed response.`,
      502,
    );
  }
  return { token: body.session_token, expiresAt: body.expires_at };
}

// Best-effort revoke of our credential on the peer's side. Failures are
// swallowed — the caller deletes the local peer record regardless, and
// an unreachable peer shouldn't block `hydra remote remove` from
// forgetting about it locally.
export async function logoutFromPeer(opts: {
  host: string;
  port: number;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = baseUrlFor(opts.host, opts.port);
  try {
    await fetchImpl(`${baseUrl}/v1/auth/logout`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
  } catch {
    // Peer unreachable — nothing more we can do from here.
  }
}
