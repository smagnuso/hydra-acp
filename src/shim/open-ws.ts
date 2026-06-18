import { WebSocket, type ClientOptions } from "ws";
import { wsTlsOptions } from "../core/tls-trust.js";

export const DEFAULT_WS_CONNECT_TIMEOUT_MS = 10_000;

export class WsConnectTimeoutError extends Error {
  readonly url: string;
  readonly elapsedMs: number;
  constructor(url: string, elapsedMs: number) {
    super(`hydra-acp: websocket connect to ${url} timed out after ${elapsedMs}ms`);
    this.name = "WsConnectTimeoutError";
    this.url = url;
    this.elapsedMs = elapsedMs;
  }
}

// Resolve once `open` fires, reject once `error` fires — whichever comes
// first wins. A timer guards against a socket stuck in CONNECTING (TLS
// hang, slow DNS, daemon accepting TCP but never upgrading), which would
// otherwise never emit either event and block the caller forever.
export async function openWs(
  url: string,
  subprotocols: string[],
  timeoutMs: number = DEFAULT_WS_CONNECT_TIMEOUT_MS,
): Promise<WebSocket> {
  // For wss:// upgrades, fish out the pin (if any) for this host so
  // self-signed certs the user already accepted via the login TOFU
  // prompt continue to verify. Plain ws:// is a no-op — the options
  // are silently ignored.
  const tlsOpts: ClientOptions = {};
  try {
    const u = new URL(url);
    if (u.protocol === "wss:") {
      const pin = wsTlsOptions(u.hostname);
      if (pin.rejectUnauthorized !== undefined) {
        tlsOpts.rejectUnauthorized = pin.rejectUnauthorized;
      }
      if (pin.autoSelectFamily !== undefined) {
        (tlsOpts as { autoSelectFamily?: boolean }).autoSelectFamily = pin.autoSelectFamily;
      }
      if (pin.checkServerIdentity !== undefined) {
        // @types/ws's signature for checkServerIdentity is out of
        // date — ws forwards the option to tls.connect, which uses
        // (servername, cert) => Error | undefined. Cast around the
        // stale type so we don't fight the dependency.
        tlsOpts.checkServerIdentity =
          pin.checkServerIdentity as unknown as ClientOptions["checkServerIdentity"];
      }
    }
  } catch {
    // malformed URL — let ws surface the error normally
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, subprotocols, tlsOpts);
    const start = Date.now();
    const timer = setTimeout(() => {
      ws.off("open", onOpen);
      ws.off("error", onError);
      // ws emits a late 'error' ("WebSocket was closed before the
      // connection was established") when terminate() is called during
      // CONNECTING. Swallow it so it doesn't surface as unhandled.
      ws.on("error", () => undefined);
      try {
        ws.terminate();
      } catch {
        // best-effort force-close
      }
      reject(new WsConnectTimeoutError(url, Date.now() - start));
    }, timeoutMs);
    const onOpen = (): void => {
      clearTimeout(timer);
      ws.off("error", onError);
      resolve(ws);
    };
    const onError = (err: Error): void => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      reject(err);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}
