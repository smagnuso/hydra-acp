import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { expect, vi } from "vitest";
import type { MessageStream } from "../acp/framing.js";
import type { JsonRpcMessage } from "../acp/types.js";
import type { AgentInstance } from "../core/agent-instance.js";
import type {
  RequestHandler,
  NotificationHandler,
} from "../acp/connection.js";
import { JsonRpcConnection } from "../acp/connection.js";

// Put a fake command on PATH that runs a Node script.
//
// The bodies these fakes need (make a directory, drop a file, write to
// stderr, pick an exit code) have no portable shell spelling: a
// `#!/bin/sh` script is not executable on Windows at all, and CMD's
// equivalents diverge enough that maintaining two dialects is worse
// than maintaining none. Node is already present, so the body is JS and
// the platform difference collapses to how it gets invoked.
//
// On Windows that means a `.cmd` shim, because a `.cmd`/`.exe` is the
// only thing CreateProcess can launch and the extensionless file npm
// itself lays down there is a POSIX sh script (see windows-command.ts).
export async function writeFakeCommand(
  dir: string,
  name: string,
  jsBody: string,
): Promise<void> {
  const scriptPath = path.join(dir, `${name}.mjs`);
  await fs.writeFile(scriptPath, jsBody, "utf8");
  if (process.platform === "win32") {
    // process.execPath, not a bare `node`: callers sandbox PATH down to
    // the fake's own directory, so a bare name has nothing to resolve
    // against and the shim exits 1 before running anything. Same reason
    // the POSIX branch below spells it out.
    await fs.writeFile(
      path.join(dir, `${name}.cmd`),
      `@echo off\r\n"${process.execPath}" "%~dp0${name}.mjs" %*\r\n`,
      "utf8",
    );
    return;
  }
  await writeExecutable(
    path.join(dir, name),
    `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
  );
}

// A port that can actually be bound, chosen by the OS.
//
// A random number in the dynamic range is not safe on Windows:
// WinNAT/Hyper-V reserve blocks inside 49152-65535, and binding one of
// those fails with EACCES (permission denied) rather than EADDRINUSE, so
// a test picking blind fails intermittently for a reason that looks
// nothing like a port conflict. Asking for port 0 never yields a
// reserved port. The probe listener is closed before the caller binds,
// which leaves a small race, but a far smaller one than guessing.
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (addr === null || typeof addr === "string") {
        probe.close(() => reject(new Error("no port was assigned")));
        return;
      }
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });
}

// Assert a file carries owner-only permissions.
//
// A no-op on Windows, which derives file access from ACLs. Node's chmod
// there only toggles the read-only bit, so the mode always reads back
// 0o666 and there is nothing meaningful to assert. The exposure is real
// but cannot be closed by chmod; see the Windows note in README's
// security section.
export function expectOwnerOnlyMode(mode: number): void {
  if (process.platform === "win32") {
    return;
  }
  expect(mode & 0o777).toBe(0o600);
}

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
    dropBufferedWhere(
      method: string,
      drop: (params: unknown) => boolean,
    ): void {
      const buf = bufferedNotifications.get(method);
      if (!buf) {
        return;
      }
      bufferedNotifications.set(
        method,
        buf.filter((note) => !drop(note.params)),
      );
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
