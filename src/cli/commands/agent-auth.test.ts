import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { JsonRpcErrorCodes } from "../../acp/types-jsonrpc.js";
import { HYDRA_META_KEY } from "../../acp/types-hydra-meta.js";
import { AuthMethod } from "../../acp/types-capabilities.js";
import { JsonRpcConnection } from "../../acp/connection.js";
import type { JsonRpcMessage, JsonRpcResponse } from "../../acp/types.js";
import type { MessageStream } from "../../acp/framing.js";
import { runAgentAuthCore } from "./agent-auth.js";

// ---- Test helpers ----------------------------------------------------------

function makeSpawn(): ReturnType<typeof vi.fn> {
  return vi.fn().mockReturnValue(new EventEmitter());
}

/** Create a message stream that routes requests through handler functions. */
function createRoutingStream(
  handlers: Record<string, (params: unknown) => Promise<unknown> | unknown>,
): MessageStream & { sendRaw(msg: JsonRpcMessage): void } {
  const messageHandlers: Array<(message: JsonRpcMessage) => void> = [];
  const closeHandlers: Array<(err?: Error) => void> = [];

  return {
    onMessage(cb: (message: JsonRpcMessage) => void): void {
      messageHandlers.push(cb);
    },
    onClose(cb: (err?: Error) => void): void {
      closeHandlers.push(cb);
    },
    async send(msg: JsonRpcMessage): Promise<void> {
      // If this is a request (has method + id), route it through handlers
      if ("method" in msg && "id" in msg) {
        const method = msg.method;
        const params = msg.params;
        const id = msg.id;

        try {
          const handler = handlers[method];
          if (handler) {
            const result = await handler(params);
            // Feed response back synchronously via message handlers
            const response: JsonRpcResponse = { jsonrpc: "2.0" as const, id, result };
            for (const cb of messageHandlers) {
              cb(response);
            }
          } else {
            const response: JsonRpcResponse = {
              jsonrpc: "2.0" as const,
              id,
              error: { code: JsonRpcErrorCodes.MethodNotFound, message: `Method not found: ${method}` },
            };
            for (const cb of messageHandlers) {
              cb(response);
            }
          }
        } catch (err) {
          const e = err as Error & { code?: number; data?: unknown };
          const response: JsonRpcResponse = {
            jsonrpc: "2.0" as const,
            id,
            error: {
              code: e.code ?? JsonRpcErrorCodes.InternalError,
              message: e.message,
              data: e.data,
            },
          };
          for (const cb of messageHandlers) {
            cb(response);
          }
        }
      }
    },
    async close(): Promise<void> {},
    sendRaw(msg: JsonRpcMessage): void {
      for (const cb of messageHandlers) {
        cb(msg);
      }
    },
  };
}

function makeAuthError(
  agentId: string | undefined,
  extra: Record<string, unknown> = {},
): Error & { code: number; data?: unknown } {
  const err = new Error("authentication required") as Error & {
    code: number;
    data?: unknown;
  };
  err.code = JsonRpcErrorCodes.AuthRequired;
  err.data = {
    _meta: {
      [HYDRA_META_KEY]: {
        ...(agentId !== undefined ? { agentId } : {}),
        authMethods: [],
        ...extra,
      },
    },
  };
  return err;
}

// ---- Tests -----------------------------------------------------------------

describe("runAgentAuthCore", () => {
  it("returns exit 0 when session/new succeeds (no authenticate called)", async () => {
    const stream = createRoutingStream({
      "session/new": () => ({ sessionId: "s1" }),
    });
    const conn = new JsonRpcConnection(stream);

    const result = await runAgentAuthCore({
      conn,
      agentId: "test-agent",
      authMethods: [],
      spawn: makeSpawn(),
    });

    expect(result.exitCode).toBe(0);
  });

  it("returns exit 0 when AUTH_REQUIRED with one method and authenticate returns non-terminal success", async () => {
    const methods: AuthMethod[] = [{ id: "token", description: "API token" }];

    let sessionCalled = false;
    let authenticateCalled = false;

    const stream = createRoutingStream({
      "session/new": async () => {
        sessionCalled = true;
        throw makeAuthError("test-agent", { authMethods: methods });
      },
      authenticate: async (_params: unknown) => {
        authenticateCalled = true;
        return { authenticated: true };
      },
    });

    const conn = new JsonRpcConnection(stream);

    const result = await runAgentAuthCore({
      conn,
      agentId: "test-agent",
      authMethods: methods,
      spawn: makeSpawn(),
    });

    expect(result.exitCode).toBe(0);
    expect(sessionCalled).toBe(true);
    expect(authenticateCalled).toBe(true);
  });

  it("returns exit 0 when AUTH_REQUIRED with terminal plan and spawn exits 0", async () => {
    const methods: AuthMethod[] = [{ id: "setup", description: "Setup wizard" }];

    let authenticateCalled = false;
    const child = new EventEmitter();
    const spawnFn = vi.fn().mockReturnValue(child);

    const stream = createRoutingStream({
      "session/new": async () => {
        throw makeAuthError("test-agent", { authMethods: methods });
      },
      authenticate: async (_params: unknown) => {
        authenticateCalled = true;
        return {
          kind: "terminal",
          command: "hydra-setup",
          args: ["--auth"],
          env: { HYDRA_TOKEN: "test" },
          cwd: "/tmp",
        };
      },
    });

    const conn = new JsonRpcConnection(stream);

    // Kick off the operation
    const resultPromise = runAgentAuthCore({
      conn,
      agentId: "test-agent",
      authMethods: methods,
      spawn: spawnFn,
    });

    // Wait for all microtasks (authenticate response + spawn setup)
    await new Promise((r) => setImmediate(r));

    // Emit exit to unblock runTerminalAuth
    child.emit("exit", 0);

    const result = await resultPromise;

    expect(result.exitCode).toBe(0);
    expect(authenticateCalled).toBe(true);
    expect(spawnFn).toHaveBeenCalledWith("hydra-setup", ["--auth"], {
      stdio: "inherit",
      env: { HYDRA_TOKEN: "test" },
      cwd: "/tmp",
    });
  });

  it("returns exit 1 when AUTH_REQUIRED terminal spawn exits non-zero", async () => {
    const methods: AuthMethod[] = [{ id: "setup", description: "Setup wizard" }];

    const child = new EventEmitter();
    const spawnFn = vi.fn().mockReturnValue(child);

    const stream = createRoutingStream({
      "session/new": async () => {
        throw makeAuthError("test-agent", { authMethods: methods });
      },
      authenticate: async () => ({
        kind: "terminal",
        command: "hydra-setup",
        args: ["--auth"],
      }),
    });

    const conn = new JsonRpcConnection(stream);

    const resultPromise = runAgentAuthCore({
      conn,
      agentId: "test-agent",
      authMethods: methods,
      spawn: spawnFn,
    });

    await new Promise((r) => setImmediate(r));
    child.emit("exit", 2);

    const result = await resultPromise;

    expect(result.exitCode).toBe(1);
  });

  it("uses the method matching --method flag when provided and valid", async () => {
    const methods: AuthMethod[] = [
      { id: "oauth", description: "OAuth" },
      { id: "token", description: "Token" },
    ];

    let authenticateCalledWith: string | undefined;

    const stream = createRoutingStream({
      "session/new": async () => {
        throw makeAuthError("test-agent", { authMethods: methods });
      },
      authenticate: async (params: unknown) => {
        authenticateCalledWith = (params as { methodId?: string }).methodId;
        return { authenticated: true };
      },
    });

    const conn = new JsonRpcConnection(stream);

    const result = await runAgentAuthCore({
      conn,
      agentId: "test-agent",
      authMethods: methods,
      method: "token",
      spawn: makeSpawn(),
    });

    expect(result.exitCode).toBe(0);
    expect(authenticateCalledWith).toBe("token");
  });

  it("returns exit 2 when --method flag does not match any available method", async () => {
    const methods: AuthMethod[] = [
      { id: "oauth", description: "OAuth" },
      { id: "token", description: "Token" },
    ];

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const stream = createRoutingStream({
      "session/new": async () => {
        throw makeAuthError("test-agent", { authMethods: methods });
      },
      authenticate: async () => ({ authenticated: true }),
    });

    const conn = new JsonRpcConnection(stream);

    await expect(
      runAgentAuthCore({
        conn,
        agentId: "test-agent",
        authMethods: methods,
        method: "nonexistent",
        spawn: makeSpawn(),
      }),
    ).rejects.toThrow();

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown auth method "nonexistent"'),
    );
    stderrSpy.mockRestore();
  });
});
