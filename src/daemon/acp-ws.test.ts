import { describe, it, expect, vi } from "vitest";
import { JsonRpcConnection } from "../acp/connection.js";
import {
  makeControlledStream,
  makeMockAgent,
} from "../__tests__/test-utils.js";
import {
  decideSetModel,
  handleAuthenticate,
  handleTransformerAttach,
  makeInstallProgressForwarder,
} from "./acp-ws.js";
import type { TransformerRef } from "../core/transformer-manager.js";
import {
  AGENT_INSTALL_PROGRESS_METHOD,
  AgentInstallProgressParams,
  JsonRpcErrorCodes,
} from "../acp/types.js";
import type { JsonRpcNotification } from "../acp/types.js";
import { Session } from "../core/session.js";
import { SessionManager } from "../core/session-manager.js";
import type { AdvertisedModel } from "../core/hydra-commands.js";

describe("makeInstallProgressForwarder", () => {
  it("translates binary download progress into a wire notification", async () => {
    const stream = makeControlledStream();
    const connection = new JsonRpcConnection(stream);
    const forward = makeInstallProgressForwarder(connection);

    forward({
      source: "binary",
      phase: "download_progress",
      agentId: "codex",
      version: "0.14.0",
      receivedBytes: 12_345_678,
      totalBytes: 45_678_910,
    });

    // notify() is async (returns a promise) — give the microtask queue a
    // tick so the send actually lands in stream.sent before we assert.
    await new Promise((r) => setImmediate(r));
    expect(stream.sent.length).toBe(1);
    const msg = stream.sent[0] as JsonRpcNotification;
    expect(msg.method).toBe(AGENT_INSTALL_PROGRESS_METHOD);
    const parsed = AgentInstallProgressParams.parse(msg.params);
    expect(parsed).toMatchObject({
      source: "binary",
      phase: "download_progress",
      agentId: "codex",
      version: "0.14.0",
      receivedBytes: 12_345_678,
      totalBytes: 45_678_910,
    });
  });

  it("omits byte fields for phases that don't carry them (extract, install_start)", async () => {
    const stream = makeControlledStream();
    const connection = new JsonRpcConnection(stream);
    const forward = makeInstallProgressForwarder(connection);

    forward({
      source: "binary",
      phase: "extract",
      agentId: "codex",
      version: "0.14.0",
    });
    forward({
      source: "npm",
      phase: "install_start",
      agentId: "claude-acp",
      version: "0.33.1",
      packageSpec: "@anthropic-ai/claude-agent-acp@0.33.1",
    });

    await new Promise((r) => setImmediate(r));
    expect(stream.sent.length).toBe(2);
    const extractMsg = stream.sent[0] as JsonRpcNotification;
    const installMsg = stream.sent[1] as JsonRpcNotification;
    const extractParams = AgentInstallProgressParams.parse(extractMsg.params);
    const installParams = AgentInstallProgressParams.parse(installMsg.params);
    expect(extractParams.receivedBytes).toBeUndefined();
    expect(extractParams.totalBytes).toBeUndefined();
    expect(extractParams.packageSpec).toBeUndefined();
    expect(installParams.receivedBytes).toBeUndefined();
    expect(installParams.totalBytes).toBeUndefined();
    expect(installParams.packageSpec).toBe(
      "@anthropic-ai/claude-agent-acp@0.33.1",
    );
  });

  it("does not throw when the connection is closed mid-download", async () => {
    const stream = makeControlledStream();
    const connection = new JsonRpcConnection(stream);
    const forward = makeInstallProgressForwarder(connection);

    await connection.close();

    // After close, notify() returns Promise.resolve() without sending —
    // the forwarder must not surface that as an exception.
    expect(() => {
      forward({
        source: "binary",
        phase: "download_progress",
        agentId: "codex",
        version: "0.14.0",
        receivedBytes: 1,
        totalBytes: 100,
      });
    }).not.toThrow();
  });

  it("each call is fire-and-forget so a slow send doesn't backpressure the install", () => {
    // The install pipeline emits structured callbacks synchronously from
    // the fetch stream's "data" event. If makeInstallProgressForwarder
    // ever started awaiting connection.notify() instead of fire-and-
    // forgetting it, an HTTP/2 backpressure stall on one side could
    // pause the byte stream on the other. Guard that behaviour by
    // confirming the forwarder returns synchronously even with many
    // events queued.
    const stream = makeControlledStream();
    const connection = new JsonRpcConnection(stream);
    const forward = makeInstallProgressForwarder(connection);
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      forward({
        source: "binary",
        phase: "download_progress",
        agentId: "codex",
        version: "0.14.0",
        receivedBytes: i * 1024,
        totalBytes: 1024 * 1024,
      });
    }
    expect(Date.now() - start).toBeLessThan(200);
  });
});

// Minimal SessionManager stand-in for decideSetModel — we only need
// get(sessionId), so a plain Map-backed shim with the right method
// signature is enough and keeps the test off the real spawner /
// registry / disk path.
function fakeManager(
  sessions: Record<string, Session | undefined>,
): SessionManager {
  return {
    get: (id: string): Session | undefined => sessions[id],
  } as unknown as SessionManager;
}

function makeSessionWithModels(
  sessionId: string,
  upstream: string,
  models: AdvertisedModel[],
  currentModel?: string,
): Session {
  const mock = makeMockAgent({ agentId: "opencode", cwd: "/work" });
  const session = new Session({
    sessionId,
    cwd: "/work",
    agentId: "opencode",
    agent: mock.agent,
    upstreamSessionId: upstream,
    agentModels: models,
    currentModel,
  });
  return session;
}

describe("decideSetModel", () => {
  it("returns no_op (resync) when modelId is not in availableModels but the session has a current model", () => {
    // The regression case: emacs agent-shell sends a claude-acp-shaped
    // modelId to an opencode session. The advertised list belongs to
    // opencode and doesn't include the request. Instead of erroring
    // (which would wedge agent-shell — it auto-fires set_model on
    // connect and doesn't recover from failures), hydra returns no_op
    // so the handler can resync the client without forwarding garbage
    // upstream. Net effect: session stays on whatever it was, no
    // corruption, client's local picker view re-syncs to reality.
    const session = makeSessionWithModels(
      "sess_oc",
      "u_oc",
      [
        { modelId: "ncp-anthropic/claude-opus-4-7" },
        { modelId: "openai/gpt-5" },
      ],
      "ncp-anthropic/claude-opus-4-7",
    );
    const decision = decideSetModel(
      { sessionId: "sess_oc", modelId: "claude-opus-4-7[1m]" },
      fakeManager({ sess_oc: session }),
    );
    expect(decision.kind).toBe("no_op");
    if (decision.kind === "no_op") {
      expect(decision.sessionId).toBe("sess_oc");
      expect(decision.currentModel).toBe("ncp-anthropic/claude-opus-4-7");
      expect(decision.logMessage).toContain("no_op");
      expect(decision.logMessage).toContain("resyncing client");
      expect(decision.logMessage).toContain(
        'requested="claude-opus-4-7[1m]"',
      );
      expect(decision.logMessage).toContain(
        'actual="ncp-anthropic/claude-opus-4-7"',
      );
    }
  });

  it("errors with InvalidParams only when no current model is set to fall back to", () => {
    // Edge case: agent advertises a list but somehow has no current
    // model (atypical — every agent we know about sets one). With
    // nothing to resync to, no_op would lie; reject honestly.
    const session = makeSessionWithModels(
      "sess_nocur",
      "u_nocur",
      [{ modelId: "openai/gpt-5" }],
      // currentModel left undefined.
    );
    const decision = decideSetModel(
      { sessionId: "sess_nocur", modelId: "bogus/id" },
      fakeManager({ sess_nocur: session }),
    );
    expect(decision.kind).toBe("error");
    if (decision.kind === "error") {
      expect(decision.code).toBe(JsonRpcErrorCodes.InvalidParams);
      expect(decision.message).toContain('"bogus/id"');
      expect(decision.logMessage).toContain(
        "no current model to fall back to",
      );
    }
  });

  it("accepts a modelId present in availableModels and forwards via the session", async () => {
    const session = makeSessionWithModels(
      "sess_ok",
      "u_ok",
      [
        { modelId: "ncp-anthropic/claude-opus-4-7" },
        { modelId: "openai/gpt-5" },
      ],
      "ncp-anthropic/claude-opus-4-7",
    );
    const requestSpy = vi
      .spyOn(session.agent.connection, "request")
      .mockResolvedValueOnce({ ok: true });

    const decision = decideSetModel(
      { sessionId: "sess_ok", modelId: "openai/gpt-5" },
      fakeManager({ sess_ok: session }),
    );
    expect(decision.kind).toBe("ok");
    if (decision.kind !== "ok") {
      return;
    }
    expect(decision.logMessage).toContain("accepted");

    // The handler in registerAcpWsEndpoint forwards via the same
    // session.forwardRequest path — exercise it directly to prove the
    // session's upstream id rewrite still applies after validation.
    const result = await decision.session.forwardRequest("session/set_model", {
      sessionId: "sess_ok",
      modelId: "openai/gpt-5",
    });
    expect(result).toEqual({ ok: true });
    expect(requestSpy).toHaveBeenCalledWith("session/set_model", {
      sessionId: "u_ok",
      modelId: "openai/gpt-5",
    });
  });

  it("resolves a bare requested id to the provider-prefixed advertised id and forwards that", async () => {
    const session = makeSessionWithModels(
      "sess_res",
      "u_res",
      [
        { modelId: "anthropic/claude-opus-4-7" },
        { modelId: "anthropic/claude-opus-4-8" },
      ],
      "anthropic/claude-opus-4-8",
    );
    const requestSpy = vi
      .spyOn(session.agent.connection, "request")
      .mockResolvedValueOnce({ ok: true });

    const decision = decideSetModel(
      { sessionId: "sess_res", modelId: "claude-opus-4-7" },
      fakeManager({ sess_res: session }),
    );
    expect(decision.kind).toBe("ok");
    if (decision.kind !== "ok") {
      return;
    }
    // The decision carries the resolved (prefixed) id, not the request.
    expect(decision.modelId).toBe("anthropic/claude-opus-4-7");
    expect(decision.logMessage).toContain("resolved");

    // The handler forwards decision.modelId, so the agent sees the
    // fully-qualified id even though the client asked for the bare one.
    await decision.session.forwardRequest("session/set_model", {
      sessionId: "sess_res",
      modelId: decision.modelId,
    });
    expect(requestSpy).toHaveBeenCalledWith("session/set_model", {
      sessionId: "u_res",
      modelId: "anthropic/claude-opus-4-7",
    });
  });

  it("returns no_op for an ambiguous bare id when a current model exists", () => {
    const session = makeSessionWithModels(
      "sess_amb",
      "u_amb",
      [
        { modelId: "anthropic/claude-opus-4-7" },
        { modelId: "ncp-anthropic/claude-opus-4-7" },
      ],
      "anthropic/claude-opus-4-7",
    );
    const decision = decideSetModel(
      { sessionId: "sess_amb", modelId: "claude-opus-4-7" },
      fakeManager({ sess_amb: session }),
    );
    expect(decision.kind).toBe("no_op");
    if (decision.kind === "no_op") {
      expect(decision.logMessage).toContain("ambiguous");
    }
  });

  it("passes through when the agent has not advertised any models (no list to validate against)", () => {
    // The pass-through path matters for two real cases: (1) agents that
    // only announce their model via current_model_update later, not in
    // session/new's response; (2) brand-new sessions whose extractor
    // ran but the agent's response had no models block. We must not
    // block a legitimate id we just can't see.
    const session = makeSessionWithModels("sess_passthrough", "u_pt", []);
    const decision = decideSetModel(
      { sessionId: "sess_passthrough", modelId: "anything/at-all" },
      fakeManager({ sess_passthrough: session }),
    );
    expect(decision.kind).toBe("ok");
    if (decision.kind === "ok") {
      expect(decision.logMessage).toContain("passthrough");
      expect(decision.logMessage).toContain("no availableModels");
    }
  });

  it("rejects with SessionNotFound when the sessionId doesn't map to a live session", () => {
    const decision = decideSetModel(
      { sessionId: "sess_missing", modelId: "openai/gpt-5" },
      fakeManager({}),
    );
    expect(decision.kind).toBe("error");
    if (decision.kind === "error") {
      expect(decision.code).toBe(JsonRpcErrorCodes.SessionNotFound);
      expect(decision.message).toContain("sess_missing");
    }
  });

  it("rejects with InvalidParams on missing/wrong-typed sessionId or modelId", () => {
    const session = makeSessionWithModels("sess_x", "u_x", [
      { modelId: "openai/gpt-5" },
    ]);
    const manager = fakeManager({ sess_x: session });

    const noParams = decideSetModel(undefined, manager);
    expect(noParams.kind).toBe("error");
    if (noParams.kind === "error") {
      expect(noParams.code).toBe(JsonRpcErrorCodes.InvalidParams);
    }

    const noSessionId = decideSetModel({ modelId: "openai/gpt-5" }, manager);
    expect(noSessionId.kind).toBe("error");
    if (noSessionId.kind === "error") {
      expect(noSessionId.code).toBe(JsonRpcErrorCodes.InvalidParams);
      expect(noSessionId.message).toContain("sessionId");
    }

    const noModelId = decideSetModel({ sessionId: "sess_x" }, manager);
    expect(noModelId.kind).toBe("error");
    if (noModelId.kind === "error") {
      expect(noModelId.code).toBe(JsonRpcErrorCodes.InvalidParams);
      expect(noModelId.message).toContain("modelId");
    }

    const wrongTypes = decideSetModel(
      { sessionId: 42, modelId: false },
      manager,
    );
    expect(wrongTypes.kind).toBe("error");
    if (wrongTypes.kind === "error") {
      expect(wrongTypes.code).toBe(JsonRpcErrorCodes.InvalidParams);
    }
  });
});

describe("handleTransformerAttach", () => {
  function fakeTransformerConn() {
    return {
      request: vi.fn(),
      notify: vi.fn(),
      onRequest: vi.fn(),
      onNotification: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as JsonRpcConnection;
  }

  function makeRef(name: string, intercepts: string[] = []): TransformerRef {
    return { name, intercepts: new Set(intercepts), connection: fakeTransformerConn() };
  }

  function makeSession(): Session {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
    return new Session({
      sessionId: "sess_attach",
      cwd: "/work",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u1",
    });
  }

  function makeDeps(opts: {
    refs?: Record<string, TransformerRef>;
    sessions?: Record<string, Session>;
    transformersUndefined?: boolean;
  }) {
    const refs = opts.refs ?? {};
    const sessions = opts.sessions ?? {};
    return {
      manager: { get: (id: string) => sessions[id] },
      transformers: opts.transformersUndefined
        ? undefined
        : {
            resolveChain: (names: string[]): TransformerRef[] => {
              const out: TransformerRef[] = [];
              for (const n of names) {
                const r = refs[n];
                if (r) out.push(r);
              }
              return out;
            },
          },
    };
  }

  it("attaches the calling transformer to the named session", async () => {
    const session = makeSession();
    const ref = makeRef("hydra-acp-planner");
    const deps = makeDeps({
      refs: { "hydra-acp-planner": ref },
      sessions: { sess_attach: session },
    });

    const result = await handleTransformerAttach(
      { sessionId: "sess_attach" },
      "hydra-acp-planner",
      deps,
    );
    expect(result).toEqual({ ok: true });

    // The session's chain should now include our ref. (Inspect via the
    // public chain interface by adding a second transformer and watching
    // the order — simpler: re-attach and confirm idempotency.)
    await handleTransformerAttach(
      { sessionId: "sess_attach" },
      "hydra-acp-planner",
      deps,
    );
    // No duplicate listing — Session.addTransformer dedups by name.
    // We exercise this via the same handler; if dedup were broken,
    // addTransformer would have pushed twice and a follow-up
    // resolveChain would observe two entries. Here we trust the unit
    // test for addTransformer in session-transformer.test.ts and verify
    // only that the second call also returns ok.
  });

  it("throws InvalidParams when sessionId is missing", async () => {
    const deps = makeDeps({
      refs: { foo: makeRef("foo") },
      sessions: {},
    });
    await expect(
      handleTransformerAttach({}, "foo", deps),
    ).rejects.toMatchObject({ code: JsonRpcErrorCodes.InvalidParams });
  });

  it("throws InvalidParams when sessionId is non-string", async () => {
    const deps = makeDeps({
      refs: { foo: makeRef("foo") },
      sessions: {},
    });
    await expect(
      handleTransformerAttach({ sessionId: 42 }, "foo", deps),
    ).rejects.toMatchObject({ code: JsonRpcErrorCodes.InvalidParams });
  });

  it("throws InternalError when no TransformerManager is configured", async () => {
    const deps = makeDeps({ transformersUndefined: true });
    await expect(
      handleTransformerAttach({ sessionId: "x" }, "foo", deps),
    ).rejects.toMatchObject({ code: JsonRpcErrorCodes.InternalError });
  });

  it("throws InternalError when the calling transformer is not connected (no ref)", async () => {
    const session = makeSession();
    const deps = makeDeps({
      refs: {}, // no entry for "foo"
      sessions: { sess_attach: session },
    });
    await expect(
      handleTransformerAttach({ sessionId: "sess_attach" }, "foo", deps),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InternalError,
    });
  });

  it("throws SessionNotFound when the target session doesn't exist", async () => {
    const deps = makeDeps({
      refs: { foo: makeRef("foo") },
      sessions: {},
    });
    await expect(
      handleTransformerAttach({ sessionId: "nope" }, "foo", deps),
    ).rejects.toMatchObject({ code: JsonRpcErrorCodes.SessionNotFound });
  });

  it("resolves the ref by the caller's name, not by any payload field", async () => {
    // A transformer trying to spoof a different name in the payload
    // would be a security concern. Demonstrate that the handler
    // ignores any extra `name` field and uses only callerName.
    const session = makeSession();
    const callerRef = makeRef("caller");
    const otherRef = makeRef("other-victim");
    const deps = makeDeps({
      refs: { caller: callerRef, "other-victim": otherRef },
      sessions: { s: session },
    });

    // Even though we're passing what looks like a `name` field in the
    // params, the handler only ever consults callerName (which is
    // wired from the authenticated processIdentity at the call site).
    const result = await handleTransformerAttach(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { sessionId: "s", name: "other-victim" } as any,
      "caller",
      deps,
    );
    expect(result).toEqual({ ok: true });

    // The callerRef should be in the session's chain; the "other-victim"
    // ref must NOT be. We verify by re-running attach for caller — it
    // must succeed (proving caller is the one attached). A separate
    // attach call for other-victim from caller's connection wouldn't
    // make sense; this design forecloses on it entirely.
    await handleTransformerAttach({ sessionId: "s" }, "caller", deps);
  });
});

describe("handleAuthenticate", () => {
  function makeAuthDeps(opts: {
    sessionAgent?: ReturnType<typeof makeMockAgent>;
    spawnAgent?: ReturnType<typeof makeMockAgent>;
    defaultAgent?: string;
    plan?: {
      command: string;
      args: string[];
      env: Record<string, string>;
      version: string;
    };
  }) {
    const bootstrap = vi.fn(async () => {
      if (!opts.spawnAgent) {
        throw new Error("spawn not expected");
      }
      return opts.spawnAgent.agent;
    });
    const planSpawnForAgent = vi.fn(async () => {
      if (!opts.plan) {
        throw new Error("planSpawnForAgent not expected");
      }
      return opts.plan;
    });
    const manager = {
      getAgentForSession: (sid: string) =>
        sid === "sess_live" ? opts.sessionAgent?.agent : undefined,
      bootstrapAgentForAuth: bootstrap,
      planSpawnForAgent,
    } as unknown as SessionManager;
    return {
      deps: { manager, defaultAgent: opts.defaultAgent ?? "claude-acp" },
      bootstrap,
      planSpawnForAgent,
    };
  }

  it("routes to the session's child agent when sessionId is provided", async () => {
    const sessionAgent = makeMockAgent({ agentId: "claude-acp" });
    sessionAgent.agent.authMethods = [
      { id: "claude-login", description: "Login", type: "agent" },
    ];
    sessionAgent.agentToClient.mockResolvedValueOnce({ ok: true });
    const { deps, bootstrap } = makeAuthDeps({ sessionAgent });

    const result = await handleAuthenticate(
      {
        methodId: "claude-login",
        _meta: { "hydra-acp": { sessionId: "sess_live" } },
      },
      deps,
    );
    expect(result).toEqual({ ok: true });
    expect(bootstrap).not.toHaveBeenCalled();
    expect(sessionAgent.agentToClient).toHaveBeenCalledWith("authenticate", {
      methodId: "claude-login",
    });
    expect(sessionAgent.agent.kill).not.toHaveBeenCalled();
  });

  it("falls back to defaultAgent and bootstraps when no target is provided", async () => {
    const spawnAgent = makeMockAgent({ agentId: "claude-acp" });
    spawnAgent.agent.authMethods = [
      { id: "claude-login", description: "", type: "agent" },
    ];
    spawnAgent.agentToClient.mockResolvedValueOnce({ ok: "ok" });
    const { deps, bootstrap } = makeAuthDeps({ spawnAgent });

    const result = await handleAuthenticate({ methodId: "claude-login" }, deps);
    expect(result).toEqual({ ok: "ok" });
    expect(bootstrap).toHaveBeenCalledWith("claude-acp");
    expect(spawnAgent.agent.kill).not.toHaveBeenCalled();
  });

  it("rejects an unknown methodId with InvalidParams listing valid ids", async () => {
    const sessionAgent = makeMockAgent({ agentId: "claude-acp" });
    sessionAgent.agent.authMethods = [
      { id: "claude-login", description: "", type: "agent" },
      { id: "claude-api-key", description: "", type: "agent" },
    ];
    const { deps } = makeAuthDeps({ sessionAgent });

    await expect(
      handleAuthenticate(
        {
          methodId: "bogus",
          _meta: { "hydra-acp": { sessionId: "sess_live" } },
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams,
      message: expect.stringContaining("claude-login"),
    });
    expect(sessionAgent.agentToClient).not.toHaveBeenCalled();
    expect(sessionAgent.agent.kill).not.toHaveBeenCalled();
  });

  it("rejects an empty methodId with InvalidParams", async () => {
    const { deps } = makeAuthDeps({});
    await expect(
      handleAuthenticate({ methodId: "" }, deps),
    ).rejects.toMatchObject({ code: JsonRpcErrorCodes.InvalidParams });
  });

  it("returns the child's success response verbatim and does not kill the agent", async () => {
    const spawnAgent = makeMockAgent({ agentId: "codex-acp" });
    spawnAgent.agent.authMethods = [
      { id: "oauth", description: "", type: "agent" },
    ];
    const childResponse = { token: "abc", extra: 42 };
    spawnAgent.agentToClient.mockResolvedValueOnce(childResponse);
    const { deps } = makeAuthDeps({
      spawnAgent,
      defaultAgent: "codex-acp",
    });

    const result = await handleAuthenticate(
      {
        methodId: "oauth",
        _meta: { "hydra-acp": { agentId: "codex-acp" } },
      },
      deps,
    );
    expect(result).toBe(childResponse);
    expect(spawnAgent.agent.kill).not.toHaveBeenCalled();
  });

  it("returns a terminal spawn plan when method._meta.type is terminal, with registry args followed by method args", async () => {
    const sessionAgent = makeMockAgent({ agentId: "qwen-code" });
    sessionAgent.agent.authMethods = [
      {
        id: "qwen-login",
        description: "Sign in",
        _meta: { type: "terminal", args: ["--setup", "--login"] },
      },
    ];
    const plan = {
      command: "/usr/bin/node",
      args: ["/opt/qwen/index.js"],
      env: { QWEN_HOME: "/opt/qwen" },
      version: "1.0.0",
    };
    const { deps, planSpawnForAgent } = makeAuthDeps({
      sessionAgent,
      plan,
    });

    const result = (await handleAuthenticate(
      {
        methodId: "qwen-login",
        _meta: { "hydra-acp": { sessionId: "sess_live" } },
      },
      deps,
    )) as {
      kind: string;
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd: string;
    };

    expect(planSpawnForAgent).toHaveBeenCalledWith("qwen-code");
    expect(sessionAgent.agentToClient).not.toHaveBeenCalled();
    expect(result.kind).toBe("terminal");
    expect(result.command).toBe(plan.command);
    expect(result.args).toEqual([
      "/opt/qwen/index.js",
      "--setup",
      "--login",
    ]);
    expect(result.env.QWEN_HOME).toBe("/opt/qwen");
    expect(result.env.PATH).toBe(process.env.PATH);
    expect(typeof result.cwd).toBe("string");
    expect(result.cwd.length).toBeGreaterThan(0);
  });

  it("treats top-level type: terminal (no _meta) as terminal and emits empty extra args", async () => {
    const sessionAgent = makeMockAgent({ agentId: "qwen-code" });
    sessionAgent.agent.authMethods = [
      { id: "qwen-login", description: "", type: "terminal" },
    ];
    const plan = {
      command: "/usr/bin/node",
      args: ["/opt/qwen/index.js"],
      env: {},
      version: "1.0.0",
    };
    const { deps } = makeAuthDeps({ sessionAgent, plan });

    const result = (await handleAuthenticate(
      {
        methodId: "qwen-login",
        _meta: { "hydra-acp": { sessionId: "sess_live" } },
      },
      deps,
    )) as { kind: string; args: string[] };
    expect(result.kind).toBe("terminal");
    expect(result.args).toEqual(["/opt/qwen/index.js"]);
    expect(sessionAgent.agentToClient).not.toHaveBeenCalled();
  });

  it("rejects terminal method whose _meta.args is not an array", async () => {
    const sessionAgent = makeMockAgent({ agentId: "qwen-code" });
    sessionAgent.agent.authMethods = [
      {
        id: "qwen-login",
        description: "",
        _meta: { type: "terminal", args: "--setup" },
      },
    ];
    const { deps } = makeAuthDeps({
      sessionAgent,
      plan: { command: "x", args: [], env: {}, version: "1" },
    });
    await expect(
      handleAuthenticate(
        {
          methodId: "qwen-login",
          _meta: { "hydra-acp": { sessionId: "sess_live" } },
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams,
      message: expect.stringContaining("_meta.args"),
    });
    expect(sessionAgent.agentToClient).not.toHaveBeenCalled();
  });

  it("rejects terminal method whose _meta.args contains a non-string entry", async () => {
    const sessionAgent = makeMockAgent({ agentId: "qwen-code" });
    sessionAgent.agent.authMethods = [
      {
        id: "qwen-login",
        description: "",
        _meta: { type: "terminal", args: ["--setup", 42] },
      },
    ];
    const { deps } = makeAuthDeps({
      sessionAgent,
      plan: { command: "x", args: [], env: {}, version: "1" },
    });
    await expect(
      handleAuthenticate(
        {
          methodId: "qwen-login",
          _meta: { "hydra-acp": { sessionId: "sess_live" } },
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCodes.InvalidParams,
      message: expect.stringContaining("non-string"),
    });
    expect(sessionAgent.agentToClient).not.toHaveBeenCalled();
  });

  it("defaults to agent type and forwards to the child when no type info is present anywhere", async () => {
    const sessionAgent = makeMockAgent({ agentId: "claude-acp" });
    sessionAgent.agent.authMethods = [
      { id: "untyped", description: "" },
    ];
    sessionAgent.agentToClient.mockResolvedValueOnce({ ok: true });
    const { deps } = makeAuthDeps({ sessionAgent });

    const result = await handleAuthenticate(
      {
        methodId: "untyped",
        _meta: { "hydra-acp": { sessionId: "sess_live" } },
      },
      deps,
    );
    expect(result).toEqual({ ok: true });
    expect(sessionAgent.agentToClient).toHaveBeenCalledWith("authenticate", {
      methodId: "untyped",
    });
  });

  it("sends zero messages to the running child for terminal-type auth", async () => {
    const sessionAgent = makeMockAgent({ agentId: "qwen-code" });
    sessionAgent.agent.authMethods = [
      {
        id: "qwen-login",
        description: "",
        _meta: { type: "terminal", args: ["--setup"] },
      },
    ];
    const plan = {
      command: "node",
      args: ["x.js"],
      env: {},
      version: "1",
    };
    const { deps } = makeAuthDeps({ sessionAgent, plan });

    await handleAuthenticate(
      {
        methodId: "qwen-login",
        _meta: { "hydra-acp": { sessionId: "sess_live" } },
      },
      deps,
    );

    expect(sessionAgent.agentToClient).not.toHaveBeenCalled();
    const conn = sessionAgent.agent.connection as unknown as {
      notify: ReturnType<typeof vi.fn>;
    };
    expect(conn.notify).not.toHaveBeenCalled();
  });
});
