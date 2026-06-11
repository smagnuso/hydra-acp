import { WebSocket } from "ws";

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
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, subprotocols);
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
