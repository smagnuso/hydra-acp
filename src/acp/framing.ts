import type { Readable, Writable } from "node:stream";
import { JsonRpcErrorCodes, type JsonRpcMessage } from "./types.js";

export interface MessageStream {
  send(message: JsonRpcMessage): Promise<void>;
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  onClose(handler: (err?: Error) => void): void;
  close(): Promise<void>;
}

export function ndjsonStreamFromStdio(stdout: Readable, stdin: Writable): MessageStream {
  let buffer = "";
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

  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          const parsed = JSON.parse(line) as JsonRpcMessage;
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
                message: `Failed to parse ndjson line: ${(err as Error).message}`,
              },
            });
          }
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });

  stdout.on("end", () => emitClose());
  stdout.on("error", (err) => emitClose(err));
  stdin.on("error", (err) => emitClose(err));

  return {
    async send(message) {
      if (closed) {
        throw new Error("stream is closed");
      }
      const line = JSON.stringify(message) + "\n";
      await new Promise<void>((resolve, reject) => {
        stdin.write(line, (err) => {
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
      stdin.end();
      emitClose();
    },
  };
}
