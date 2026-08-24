// One-shot HTTP callback delivery for Session.registerTurnNotify — lets a
// caller learn when a specific prompt's turn completes without holding an
// ACP attach (or any connection at all) open for the duration. Kept
// separate from session.ts so the signing/delivery mechanics are testable
// in isolation from the session lifecycle they're triggered by.

import { createHmac } from "node:crypto";

export interface TurnNotifyRegistration {
  callbackUrl: string;
  secret: string;
  registeredAt: number;
  // The messageId the caller actually registered against. Stays fixed
  // even if the registration is later transferred to follow an amend
  // chain (Session.amendOnHead moves the map entry to the replacement
  // messageId, but this field travels with it unchanged) — so the
  // caller always sees the id it asked about, not whichever downstream
  // id happened to be the one that actually finished.
  originalMessageId: string;
}

export interface TurnNotifyPayload {
  sessionId: string;
  messageId: string;
  stopReason: string;
  deliveredAt: number;
  // Present only when the registered prompt was amended before it
  // finished: the messageId that actually completed and produced this
  // delivery, if different from `messageId` above.
  amendedTo?: string;
}

// HMAC-SHA256 over the exact JSON body sent, so the receiver can verify a
// delivery genuinely came from a daemon that knows the secret exchanged
// at registration time — the callbackUrl is caller-supplied and otherwise
// unauthenticated from the receiver's point of view.
export function signTurnNotifyPayload(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// Fire-and-forget by contract, matching this file's other delivery hooks
// (e.g. the workspace snapshot hook): no retry, no queue. A caller that
// needs stronger delivery guarantees re-registers (or falls back to
// polling) rather than the daemon accruing retry/backoff state on behalf
// of every registered callback.
export function deliverTurnNotify(
  registration: TurnNotifyRegistration,
  payload: TurnNotifyPayload,
): void {
  const body = JSON.stringify(payload);
  const signature = signTurnNotifyPayload(registration.secret, body);
  void fetch(registration.callbackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hydra-Turn-Notify-Signature": signature,
    },
    body,
  }).catch(() => undefined);
}
