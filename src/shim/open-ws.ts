import { WebSocket } from "ws";

// Resolve once `open` fires, reject once `error` fires — whichever comes
// first wins. Returning the raw `WebSocket` (rather than a wrapped
// MessageStream) keeps this usable both from cat.ts (which talks the
// daemon's ACP protocol directly off the socket) and resilient-ws.ts
// (which wraps the result with wsToMessageStream itself).
export async function openWs(
  url: string,
  subprotocols: string[],
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, subprotocols);
    const onOpen = (): void => {
      ws.off("error", onError);
      resolve(ws);
    };
    const onError = (err: Error): void => {
      ws.off("open", onOpen);
      reject(err);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}
