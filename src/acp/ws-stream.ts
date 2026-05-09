import type { WebSocket } from "ws";
import { JsonRpcErrorCodes, type JsonRpcMessage } from "./types.js";
import type { MessageStream } from "./framing.js";

export function wsToMessageStream(ws: WebSocket): MessageStream {
  const messageHandlers: Array<(m: JsonRpcMessage) => void> = [];
  const closeHandlers: Array<(err?: Error) => void> = [];
  let closed = false;

  const emitClose = (err?: Error): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const handler of closeHandlers) {
      handler(err);
    }
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      return;
    }
    const text = data.toString("utf8");
    try {
      const parsed = JSON.parse(text) as JsonRpcMessage;
      for (const handler of messageHandlers) {
        handler(parsed);
      }
    } catch (err) {
      for (const handler of messageHandlers) {
        handler({
          jsonrpc: "2.0",
          id: 0,
          error: {
            code: JsonRpcErrorCodes.ParseError,
            message: `Failed to parse WS frame: ${(err as Error).message}`,
          },
        });
      }
    }
  });

  ws.on("close", () => emitClose());
  ws.on("error", (err) => emitClose(err));

  return {
    async send(message) {
      if (closed) {
        throw new Error("ws is closed");
      }
      const text = JSON.stringify(message);
      await new Promise<void>((resolve, reject) => {
        ws.send(text, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    async close() {
      if (closed) {
        return;
      }
      ws.close();
      emitClose();
    },
  };
}
