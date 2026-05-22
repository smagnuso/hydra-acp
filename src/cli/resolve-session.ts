// Resolves the user-facing `--session <value>` flag (or HYDRA_ACP_SESSION
// env var) into the concrete inputs the TUI / shim / cat entry points
// need: a sessionId string and a RemoteTarget.
//
// Two cases:
//   - value is a `hydra://` URL → parse it, resolve a RemoteTarget
//     (loopback service-token shortcut, cached credential lookup, or
//     password prompt; the last one is gated by `allowPrompt`), and
//     extract the URL's path component as the session id.
//   - value is a bare id → return it as-is with no target (caller
//     falls through to its own resolveLocalTarget).

import { loadConfig } from "../core/config.js";
import {
  parseHydraUrl,
  resolveLocalTarget,
  resolveRemoteTarget,
  type RemoteTarget,
} from "../core/remote-target.js";

export interface ResolvedSession {
  // Concrete daemon target. Always populated — even the "local + bare
  // id" path resolves a target so the caller has one source of truth.
  target: RemoteTarget;
  // Session id from the input. For URL inputs, this is the URL's
  // path component (may be undefined if the URL had no path).
  // For bare-id inputs, this is the input itself.
  sessionId: string | undefined;
  // True when the input was a hydra:// URL, false when it was a bare
  // id. Lets the caller distinguish "user typed a session id" from
  // "user provided a URL with no path" — the latter is a valid
  // "open the picker on that daemon" signal.
  fromUrl: boolean;
}

export interface ResolveSessionOpts {
  // Whether the resolver may prompt for a password when no cached
  // credential exists. Pass false from non-interactive entry points
  // (shim, cat) so they fail fast with NoCachedCredentialError
  // instead of hanging on a prompt.
  allowPrompt: boolean;
}

// Returns the resolved session info, or undefined when no --session
// value was provided (the caller falls back to its own picker / new
// behavior).
export async function resolveSessionFlag(
  rawValue: string | undefined,
  opts: ResolveSessionOpts,
): Promise<ResolvedSession | undefined> {
  // Treat empty / whitespace-only as absent. Mirrors how resolveOption
  // already filters out flags that arrived as bare `--session` (which
  // the parser would set to `true`, not a string).
  const value =
    typeof rawValue === "string" && rawValue.trim().length > 0
      ? rawValue.trim()
      : undefined;
  if (value === undefined) {
    return undefined;
  }

  if (value.startsWith("hydra://")) {
    const parsed = parseHydraUrl(value);
    const target = await resolveRemoteTarget(parsed, {
      allowPrompt: opts.allowPrompt,
    });
    return {
      target,
      sessionId: parsed.sessionId,
      fromUrl: true,
    };
  }

  // Bare id: resolve the local daemon and pass the id through. The
  // local-target resolution still runs (so the caller gets a target)
  // but no network I/O happens at this layer.
  const config = await loadConfig();
  const target = await resolveLocalTarget(config);
  return {
    target,
    sessionId: value,
    fromUrl: false,
  };
}

// Read --session from flags, falling back to HYDRA_ACP_SESSION env var.
// Returns the raw string value (URL or id) for resolveSessionFlag to
// interpret, or undefined when neither is set.
export function readSessionInput(
  flags: Record<string, string | boolean>,
): string | undefined {
  const flag = flags["session"];
  if (typeof flag === "string" && flag.length > 0) {
    return flag;
  }
  const env = process.env.HYDRA_ACP_SESSION;
  if (typeof env === "string" && env.length > 0) {
    return env;
  }
  return undefined;
}
