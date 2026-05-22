// WebSocket subprotocol negotiation for the /acp endpoint.
//
// Hydra clients advertise two subprotocol tokens on upgrade:
//   1. `acp.v1` — the wire-protocol version
//   2. `hydra-acp-token.<token>` — bearer credential (handled by auth.ts)
//
// The ratified ACP transport surface doesn't define a subprotocol
// token, but the Streamable HTTP & WebSocket Transport RFD (still in
// Draft) explicitly permits WebSocket subprotocols as a place to carry
// version/auth signals. We use `acp.v<n>` as a versioning hook so we
// can negotiate a future `acp.v2` without breaking older clients.
//
// This helper is passed to the `ws` library's `handleProtocols` hook
// via @fastify/websocket. Without it, ws would echo the first
// advertised protocol unconditionally — which today happens to be
// `acp.v1` but would silently accept anything a misbehaving client
// put in the first slot. The explicit selector makes the echo
// deliberate and bounded.

import type { IncomingMessage } from "node:http";

export const ACP_WS_PROTOCOL_VERSION = "acp.v1";

// Returns the subprotocol token the server should echo back in the
// 101 Switching Protocols response, or `false` to omit the
// `Sec-WebSocket-Protocol` response header entirely. Returning
// `false` (rather than throwing) lets the upgrade proceed for
// clients that don't advertise `acp.v1`, preserving backward
// compatibility for any caller that only sends the auth token
// subprotocol.
export function selectAcpSubprotocol(
  protocols: Set<string>,
  _req: IncomingMessage,
): string | false {
  // Prefer the version token. Auth tokens (hydra-acp-token.<token>)
  // and unknown values are never echoed — they're not protocol
  // versions, and echoing an attacker-controlled string in a 101
  // response would be a small but real footgun.
  if (protocols.has(ACP_WS_PROTOCOL_VERSION)) {
    return ACP_WS_PROTOCOL_VERSION;
  }
  return false;
}
