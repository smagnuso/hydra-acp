import * as fs from "node:fs/promises";
import { vi } from "vitest";
import type { MessageStream } from "../acp/framing.js";
import type { JsonRpcMessage } from "../acp/types.js";
import type { AgentInstance } from "../core/agent-instance.js";
import type {
  RequestHandler,
  NotificationHandler,
} from "../acp/connection.js";
import { JsonRpcConnection } from "../acp/connection.js";

// Write an executable script to disk in a way that minimizes the
// window for execve's ETXTBSY race on Linux. The kernel briefly
// refuses to exec a file whose inode has any outstanding writer fd;
// libuv worker threads can hold that fd for tens of milliseconds
// after the JS-level close resolves. Writing to a temp path + atomic
// rename means by the time the target name exists, the writer fd was
// closed against a *different* path, shrinking the race window.
//
// Production callers (runNpmInstall) handle the residual race with a
// retry on ETXTBSY; we still write through this helper so tests
// minimize the chance of needing those retries — every retry costs
// 25ms+ which would add up across the suite.
export async function writeExecutable(
  filePath: string,
  body: string,
): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const handle = await fs.open(tmp, "w", 0o755);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
}

export interface ControlledStream extends MessageStream {
  sent: JsonRpcMessage[];
  emitMessage(msg: JsonRpcMessage): void;
  emitClose(err?: Error): void;
  closed: boolean;
}

export function makeControlledStream(): ControlledStream {
  const sent: JsonRpcMessage[] = [];
  const messageHandlers: Array<(m: JsonRpcMessage) => void> = [];
  const closeHandlers: Array<(err?: Error) => void> = [];
  let closed = false;

  return {
    sent,
    closed: false,
    async send(msg) {
      if (closed) {
        throw new Error("stream is closed");
      }
      sent.push(msg);
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
      closed = true;
      this.closed = true;
      for (const handler of closeHandlers) {
        handler();
      }
    },
    emitMessage(msg) {
      for (const handler of messageHandlers) {
        handler(msg);
      }
    },
    emitClose(err) {
      if (closed) {
        return;
      }
      closed = true;
      this.closed = true;
      for (const handler of closeHandlers) {
        handler(err);
      }
    },
  };
}

export interface MockAgentControls {
  agent: AgentInstance;
  triggerNotification(method: string, params: unknown): void;
  triggerRequest(method: string, params: unknown): Promise<unknown>;
  triggerExit(code?: number, signal?: NodeJS.Signals | null): void;
  agentToClient: ReturnType<typeof vi.fn>;
}

export function makeMockAgent(opts: {
  agentId?: string;
  cwd?: string;
  version?: string;
} = {}): MockAgentControls {
  const requestHandlers = new Map<string, RequestHandler>();
  const notificationHandlers = new Map<string, NotificationHandler>();
  // Mirror JsonRpcConnection's buffering: a notification that arrives
  // before a handler is registered must queue rather than vanish, so
  // tests can faithfully reproduce the "agent emits chunks during
  // session/load" pattern and verify the drainBuffered escape hatch.
  const bufferedNotifications = new Map<
    string,
    Array<{ method: string; params: unknown }>
  >();
  const exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  const requestMock = vi.fn().mockResolvedValue(undefined);
  const notifyMock = vi.fn().mockResolvedValue(undefined);
  const closeMock = vi.fn().mockResolvedValue(undefined);

  const fakeConnection = {
    onRequest(method: string, handler: RequestHandler): void {
      requestHandlers.set(method, handler);
    },
    onNotification(method: string, handler: NotificationHandler): void {
      notificationHandlers.set(method, handler);
      const queued = bufferedNotifications.get(method);
      if (!queued) {
        return;
      }
      bufferedNotifications.delete(method);
      for (const note of queued) {
        handler(note.params, note.method);
      }
    },
    drainBuffered(method: string): void {
      bufferedNotifications.delete(method);
    },
    onClose(_handler: (err?: Error) => void): void {
      void _handler;
    },
    request: requestMock,
    notify: notifyMock,
    close: closeMock,
  } as unknown as JsonRpcConnection;

  const agent = {
    agentId: opts.agentId ?? "mock-agent",
    version: opts.version ?? "test",
    cwd: opts.cwd ?? "/tmp/mock",
    connection: fakeConnection,
    onExit(handler: (code: number | null, signal: NodeJS.Signals | null) => void): void {
      exitHandlers.push(handler);
    },
    isAlive(): boolean {
      return true;
    },
    stderrTailText(): string {
      return "";
    },
    kill: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentInstance;

  return {
    agent,
    agentToClient: requestMock,
    triggerNotification(method, params) {
      const handler = notificationHandlers.get(method);
      if (handler) {
        handler(params, method);
        return;
      }
      let queued = bufferedNotifications.get(method);
      if (!queued) {
        queued = [];
        bufferedNotifications.set(method, queued);
      }
      queued.push({ method, params });
    },
    async triggerRequest(method, params) {
      const handler = requestHandlers.get(method);
      if (!handler) {
        throw new Error(`no handler for ${method}`);
      }
      return handler(params, method);
    },
    triggerExit(code = 0, signal = null) {
      for (const handler of exitHandlers) {
        handler(code, signal);
      }
    },
  };
}
