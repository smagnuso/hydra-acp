// Mint/revoke "script"-kind daemon tokens for composer-bar script slots
// (and, eventually, sidebar process gadgets) — see ProcessTokenRegistry in
// daemon/auth.ts and routes/process-tokens.ts. One TUI process mints every
// script token under the same sessionLabel so a single revoke call at
// shutdown cleans them all up.

export interface ScriptTokenTarget {
  baseUrl: string;
  token: string;
}

const MINT_TIMEOUT_MS = 3_000;
const REVOKE_TIMEOUT_MS = 3_000;

async function mintOne(
  target: ScriptTokenTarget,
  sessionLabel: string,
): Promise<string | undefined> {
  try {
    const response = await fetch(`${target.baseUrl}/v1/process-tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionLabel }),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as { token?: unknown };
    return typeof body.token === "string" ? body.token : undefined;
  } catch {
    return undefined;
  }
}

// Mint one token per distinct command, all grouped under `sessionLabel` for
// bulk revoke at shutdown. A command whose mint call fails (daemon
// unreachable, etc.) is simply absent from the returned map — callers treat
// a missing token the same as "this script has no daemon callback", not as
// fatal to starting the TUI.
export async function mintScriptTokens(
  target: ScriptTokenTarget,
  sessionLabel: string,
  commands: ReadonlyMap<string, number>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    [...commands.keys()].map(async (command) => {
      const token = await mintOne(target, sessionLabel);
      if (token) {
        out.set(command, token);
      }
    }),
  );
  return out;
}

// Best-effort: an unclean TUI exit (crash, kill -9) leaves these tokens live
// until the daemon restarts. There's no process-supervision link between
// the TUI and the daemon the way child-supervisor.ts has for extensions, so
// there's no exit signal to hook — same blast radius as the script already
// having full local shell access, accepted rather than solved with a TTL.
export async function revokeScriptTokens(
  target: ScriptTokenTarget,
  sessionLabel: string,
): Promise<void> {
  try {
    await fetch(
      `${target.baseUrl}/v1/process-tokens/${encodeURIComponent(sessionLabel)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${target.token}` },
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      },
    );
  } catch {
    void 0;
  }
}
