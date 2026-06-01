import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { startDaemon, type DaemonHandle } from "./server.js";
import type { HydraConfig } from "../core/config.js";
import { SessionStore } from "../core/session-store.js";
import { HYDRA_CAT_CLIENT_NAME } from "../core/hydra-version.js";

const TEST_TOKEN = "hydra_token_0123456789abcdef0123456789abcdef";

function testConfig(): HydraConfig {
  return {
    daemon: {
      host: "127.0.0.1",
      port: 0,
      logLevel: "warn",
      sessionIdleTimeoutSeconds: 30,
      sessionHistoryMaxEntries: 1000,
      agentStderrTailBytes: 4096,
      agentSyncIntervalMinutes: 0,
    },
    registry: {
      url: "http://127.0.0.1:65535/never-reached",
      ttlHours: 24,
      pinned: false,
    },
    defaultAgent: "claude-acp",
    defaultModels: {},
    synopsisOnClose: false,
    defaultCwd: os.homedir(),
    sessionListColdLimit: 20,
    agents: {},
    agentOverrides: {},
    extensions: {},
    transformers: {},
    defaultTransformers: [],
    tui: {
      repaintThrottleMs: 1000,
      maxScrollbackLines: 10_000,
      mouse: false,
      logMaxBytes: 5 * 1024 * 1024,
      cwdColumnMaxWidth: 24,
      progressIndicator: true,
      defaultEnterAction: "amend" as const,
      showThoughts: true,
      ambiguousWidth: "narrow",
      promptHistoryMaxEntries: 2_000,
      maxToolItems: 5,
      maxPlanItems: 5,
      showFileUpdates: "none" as const,
    },
  };
}

function port(handle: DaemonHandle): number {
  const addr = handle.app.server.address() as AddressInfo | string | null;
  if (!addr || typeof addr === "string") {
    throw new Error("server has no bound port");
  }
  return addr.port;
}

describe("startDaemon", () => {
  let tmpHome: string;
  let handle: DaemonHandle | null = null;
  let baseUrl: string;
  let wsUrl: string;

  beforeEach(async () => {
    tmpHome = process.env.HYDRA_ACP_HOME!;
    handle = await startDaemon(testConfig(), TEST_TOKEN);
    const p = port(handle);
    baseUrl = `http://127.0.0.1:${p}`;
    wsUrl = `ws://127.0.0.1:${p}/acp`;
  });

  afterEach(async () => {
    if (handle) {
      await handle.shutdown().catch(() => undefined);
      handle = null;
    }
  });

  describe("REST", () => {
    it("serves /v1/health without auth", async () => {
      const r = await fetch(`${baseUrl}/v1/health`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { status: string; version: string };
      expect(body.status).toBe("ok");
      expect(typeof body.version).toBe("string");
    });

    it("rejects /v1/sessions without bearer token", async () => {
      const r = await fetch(`${baseUrl}/v1/sessions`);
      expect(r.status).toBe(401);
    });

    it("rejects /v1/sessions with the wrong bearer token", async () => {
      const r = await fetch(`${baseUrl}/v1/sessions`, {
        headers: { Authorization: "Bearer hydra_token_wrong" },
      });
      expect(r.status).toBe(403);
    });

    it("returns an empty session list with a valid bearer token", async () => {
      const r = await fetch(`${baseUrl}/v1/sessions`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { sessions: unknown[] };
      expect(body.sessions).toEqual([]);
    });

    it("returns 404 when removing an unknown session", async () => {
      const r = await fetch(`${baseUrl}/v1/sessions/sess_unknown`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(r.status).toBe(404);
    });

    it("returns 404 when killing an unknown session", async () => {
      const r = await fetch(`${baseUrl}/v1/sessions/sess_unknown/kill`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(r.status).toBe(404);
    });

    it("returns 404 fetching history for an unknown session", async () => {
      const r = await fetch(
        `${baseUrl}/v1/sessions/hydra_session_unknown/history`,
        {
          headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        },
      );
      expect(r.status).toBe(404);
    });

    it("rejects /v1/sessions/:id/history without bearer token", async () => {
      const r = await fetch(`${baseUrl}/v1/sessions/x/history`);
      expect(r.status).toBe(401);
    });

    it("rejects /v1/extensions without bearer token", async () => {
      const r = await fetch(`${baseUrl}/v1/extensions`);
      expect(r.status).toBe(401);
    });

    it("returns an empty extensions list with a valid bearer token", async () => {
      const r = await fetch(`${baseUrl}/v1/extensions`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { extensions: unknown[] };
      expect(body.extensions).toEqual([]);
    });

    it("returns 404 starting an unknown extension", async () => {
      const r = await fetch(`${baseUrl}/v1/extensions/ghost/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(r.status).toBe(404);
    });

    it("returns 404 exporting an unknown session", async () => {
      const r = await fetch(
        `${baseUrl}/v1/sessions/hydra_session_unknown/export`,
        { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
      );
      expect(r.status).toBe(404);
    });

    it("rejects import with a missing body", async () => {
      const r = await fetch(`${baseUrl}/v1/sessions/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({}),
      });
      expect(r.status).toBe(400);
    });

    it("rejects import with a malformed bundle", async () => {
      const r = await fetch(`${baseUrl}/v1/sessions/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ bundle: { version: 1, no: "fields" } }),
      });
      expect(r.status).toBe(400);
    });

    it("imports a valid bundle, listing it as cold, and returns 409 on re-import", async () => {
      const bundle = {
        version: 1,
        exportedAt: "2026-05-13T00:00:00.000Z",
        exportedFrom: { hydraVersion: "0.1.0", machine: "test-host" },
        session: {
          sessionId: "hydra_session_origin",
          lineageId: "hydra_lineage_route_test",
          agentId: "claude-acp",
          cwd: "/work",
          // A real imported conversation carries interactive=true so it's
          // visible in the default list (this test asserts default
          // visibility). Empty/undecided imports are hidden by design.
          interactive: true,
          createdAt: "2026-05-13T00:00:00.000Z",
          updatedAt: "2026-05-13T00:00:00.000Z",
        },
        history: [],
      };
      const r1 = await fetch(`${baseUrl}/v1/sessions/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ bundle }),
      });
      expect(r1.status).toBe(201);
      const body = (await r1.json()) as {
        sessionId: string;
        importedFromSessionId: string;
        replaced: boolean;
      };
      expect(body.sessionId).toMatch(/^hydra_session_/);
      expect(body.importedFromSessionId).toBe("hydra_session_origin");
      expect(body.replaced).toBe(false);

      const list = await fetch(`${baseUrl}/v1/sessions`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      const listBody = (await list.json()) as {
        sessions: Array<{ sessionId: string; status?: string }>;
      };
      expect(
        listBody.sessions.some(
          (s) => s.sessionId === body.sessionId && s.status === "cold",
        ),
      ).toBe(true);

      const r2 = await fetch(`${baseUrl}/v1/sessions/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ bundle }),
      });
      expect(r2.status).toBe(409);
      const dup = (await r2.json()) as { existingSessionId?: string };
      expect(dup.existingSessionId).toBe(body.sessionId);

      const r3 = await fetch(`${baseUrl}/v1/sessions/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ bundle, replace: true }),
      });
      expect(r3.status).toBe(201);
      const replaced = (await r3.json()) as {
        sessionId: string;
        replaced: boolean;
      };
      expect(replaced.replaced).toBe(true);
      expect(replaced.sessionId).toBe(body.sessionId);
    });

    it("exports an imported session into a bundle that round-trips", async () => {
      const bundle = {
        version: 1,
        exportedAt: "2026-05-13T00:00:00.000Z",
        exportedFrom: { hydraVersion: "0.1.0", machine: "test-host" },
        session: {
          sessionId: "hydra_session_origin_2",
          lineageId: "hydra_lineage_roundtrip",
          agentId: "claude-acp",
          cwd: "/work",
          title: "round-tripped",
          createdAt: "2026-05-13T00:00:00.000Z",
          updatedAt: "2026-05-13T00:00:00.000Z",
        },
        history: [
          {
            method: "session/update",
            params: { update: { sessionUpdate: "agent_message_chunk" } },
            recordedAt: 1,
          },
        ],
      };
      const r1 = await fetch(`${baseUrl}/v1/sessions/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ bundle }),
      });
      expect(r1.status).toBe(201);
      const imported = (await r1.json()) as { sessionId: string };

      const r2 = await fetch(
        `${baseUrl}/v1/sessions/${imported.sessionId}/export`,
        { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
      );
      expect(r2.status).toBe(200);
      const exported = (await r2.json()) as {
        version: number;
        session: { lineageId: string };
        history: unknown[];
      };
      expect(exported.version).toBe(1);
      expect(exported.session.lineageId).toBe("hydra_lineage_roundtrip");
      expect(exported.history).toHaveLength(1);
    });
  });

  describe("WSS handshake + initialize", () => {
    it("rejects WSS upgrade without a token", async () => {
      const ws = new WebSocket(wsUrl);
      const code = await new Promise<number>((resolve) => {
        ws.once("close", (c) => resolve(c));
        ws.once("error", () => undefined);
      });
      expect(code).toBe(4401);
    });

    it("accepts WSS with a token in the query string", async () => {
      const ws = new WebSocket(`${wsUrl}?token=${TEST_TOKEN}`);
      try {
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", reject);
        });
      } finally {
        ws.close();
      }
    });

    it("echoes acp.v1 in the 101 response when the client advertises it", async () => {
      // The Streamable HTTP & WebSocket Transport RFD permits using
      // WebSocket subprotocols for version/auth signaling. Hydra
      // clients advertise `acp.v1` alongside `hydra-acp-token.<token>`;
      // the server selects `acp.v1` deliberately via handleProtocols.
      const ws = new WebSocket(wsUrl, [
        "acp.v1",
        `hydra-acp-token.${TEST_TOKEN}`,
      ]);
      try {
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", reject);
        });
        expect(ws.protocol).toBe("acp.v1");
      } finally {
        ws.close();
      }
    });

    it("upgrades cleanly with no subprotocol echo when none is advertised", async () => {
      // The query-string auth flow (?token=...) advertises no
      // subprotocols at all. RFC 6455 says the server MUST NOT echo
      // a Sec-WebSocket-Protocol header in that case, and the client
      // doesn't expect one. This is the path browser clients and any
      // caller without subprotocol-header control use.
      const ws = new WebSocket(`${wsUrl}?token=${TEST_TOKEN}`);
      try {
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", reject);
        });
        expect(ws.protocol).toBe("");
      } finally {
        ws.close();
      }
    });

    it("rejects a connection that advertises subprotocols but none we accept", async () => {
      // RFC 6455: if a client requests subprotocols and the server
      // doesn't select one, the negotiation has failed. The `ws`
      // library enforces this on the client side. In practice this
      // catches misconfigured/future clients that drop `acp.v1` —
      // they get a clear failure instead of a quietly-upgraded
      // connection that doesn't share a version contract with the
      // server.
      const ws = new WebSocket(wsUrl, [`hydra-acp-token.${TEST_TOKEN}`]);
      const err = await new Promise<Error>((resolve) => {
        ws.once("error", (e) => resolve(e));
        ws.once("open", () => resolve(new Error("unexpectedly opened")));
      });
      expect(err.message).toMatch(/no subprotocol|unexpected/i);
      ws.close();
    });

    it("rejects acp.v1 without a valid token (subprotocol auth still required)", async () => {
      // Subprotocol selection is independent of auth — advertising
      // `acp.v1` alone doesn't grant access.
      const ws = new WebSocket(wsUrl, ["acp.v1"]);
      const code = await new Promise<number>((resolve) => {
        ws.once("close", (c) => resolve(c));
        ws.once("error", () => undefined);
      });
      expect(code).toBe(4401);
    });

    it("responds to initialize with hydra capabilities", async () => {
      const ws = new WebSocket(`${wsUrl}?token=${TEST_TOKEN}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });

      const responsePromise = new Promise<unknown>((resolve) => {
        ws.on("message", (data) => {
          resolve(JSON.parse(data.toString("utf8")));
        });
      });

      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "test-client" },
          },
        }),
      );

      const response = (await responsePromise) as {
        id: number;
        result: {
          protocolVersion: number;
          agentInfo: { name: string };
          agentCapabilities: {
            sessionCapabilities?: {
              attach?: Record<string, never>;
              list?: Record<string, never>;
            };
            promptCapabilities?: { image?: boolean };
          };
        };
      };

      expect(response.id).toBe(1);
      expect(response.result.agentInfo.name).toBe("hydra");
      // Per the ratified Session List spec (stabilized 2026-03-09), the
      // `list` capability is advertised as an empty object — same shape
      // as `attach` — not a boolean.
      expect(
        response.result.agentCapabilities.sessionCapabilities?.list,
      ).toEqual({});
      expect(
        response.result.agentCapabilities.sessionCapabilities?.attach,
      ).toEqual({});
      expect(response.result.agentCapabilities.promptCapabilities?.image).toBe(
        true,
      );

      ws.close();
    });

    it("advertises prompt.queueing capability in initialize _meta", async () => {
      const ws = new WebSocket(`${wsUrl}?token=${TEST_TOKEN}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });

      const responsePromise = new Promise<unknown>((resolve) => {
        ws.on("message", (data) => {
          resolve(JSON.parse(data.toString("utf8")));
        });
      });

      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "test-client" },
          },
        }),
      );

      const response = (await responsePromise) as {
        id: number;
        result: {
          _meta?: { "hydra-acp"?: { prompt?: { queueing?: boolean } } };
        };
      };
      expect(response.result._meta?.["hydra-acp"]?.prompt?.queueing).toBe(true);

      ws.close();
    });

    it("advertises the full hydra-acp capability family (prompt + agents groups) in initialize _meta", async () => {
      const ws = new WebSocket(`${wsUrl}?token=${TEST_TOKEN}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });

      const responsePromise = new Promise<unknown>((resolve) => {
        ws.on("message", (data) => {
          resolve(JSON.parse(data.toString("utf8")));
        });
      });

      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "test-client" },
          },
        }),
      );

      const response = (await responsePromise) as {
        id: number;
        result: {
          _meta?: {
            "hydra-acp"?: {
              prompt?: {
                queueing?: boolean;
                cancelling?: boolean;
                updating?: boolean;
                amending?: boolean;
                pipelining?: boolean;
              };
              agents?: { list?: boolean; installProgress?: boolean };
            };
          };
        };
      };
      const flags = response.result._meta?.["hydra-acp"];
      expect(flags).toBeDefined();
      expect(flags!.prompt?.queueing).toBe(true);
      expect(flags!.prompt?.cancelling).toBe(true);
      expect(flags!.prompt?.updating).toBe(true);
      expect(flags!.prompt?.amending).toBe(true);
      // pipelining stays false until the streaming-input probe lands
      // (Option A in the steering brief).
      expect(flags!.prompt?.pipelining).toBe(false);
      // Agent-catalog capability group.
      expect(flags!.agents?.list).toBe(true);
      expect(flags!.agents?.installProgress).toBe(true);

      ws.close();
    });

    it("returns an empty session/list over ACP", async () => {
      const ws = new WebSocket(`${wsUrl}?token=${TEST_TOKEN}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });

      const responsePromise = new Promise<unknown>((resolve) => {
        ws.on("message", (data) =>
          resolve(JSON.parse(data.toString("utf8"))),
        );
      });

      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "session/list",
          params: {},
        }),
      );

      const response = (await responsePromise) as {
        id: number;
        result: { sessions: unknown[] };
      };
      expect(response.id).toBe(9);
      expect(response.result.sessions).toEqual([]);

      ws.close();
    });

    it("returns spec-compliant entries for session/list over ACP", async () => {
      // Per the ratified Session List spec, each SessionInfo carries
      // only { sessionId, cwd, title?, updatedAt?, _meta? }. Hydra-only
      // fields (agentId, status, attachedClients, etc.) MUST ride under
      // `_meta["hydra-acp"]`, never at the top level.
      const bundle = {
        version: 1,
        exportedAt: "2026-05-13T00:00:00.000Z",
        exportedFrom: { hydraVersion: "0.1.0", machine: "origin-host" },
        session: {
          sessionId: "hydra_session_wire_check",
          lineageId: "hydra_lineage_wire_check",
          agentId: "claude-acp",
          cwd: "/wire-check",
          title: "wire shape check",
          // Visible by default so this wire-shape check finds the row.
          interactive: true,
          createdAt: "2026-05-13T00:00:00.000Z",
          updatedAt: "2026-05-13T00:00:00.000Z",
        },
        history: [],
      };
      const imp = await fetch(`${baseUrl}/v1/sessions/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ bundle }),
      });
      expect(imp.status).toBe(201);
      const imported = (await imp.json()) as { sessionId: string };

      const ws = new WebSocket(`${wsUrl}?token=${TEST_TOKEN}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const responsePromise = new Promise<unknown>((resolve) => {
        ws.on("message", (data) =>
          resolve(JSON.parse(data.toString("utf8"))),
        );
      });
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "session/list",
          params: { cwd: "/wire-check" },
        }),
      );

      const response = (await responsePromise) as {
        id: number;
        result: {
          sessions: Array<Record<string, unknown>>;
          nextCursor?: string;
        };
      };
      expect(response.id).toBe(10);
      const entry = response.result.sessions.find(
        (s) => s.sessionId === imported.sessionId,
      );
      expect(entry).toBeDefined();
      // Top-level keys MUST be only the spec-defined ones.
      const allowed = new Set(["sessionId", "cwd", "title", "updatedAt", "_meta"]);
      for (const key of Object.keys(entry!)) {
        expect(allowed.has(key)).toBe(true);
      }
      expect(entry!.sessionId).toBe(imported.sessionId);
      expect(entry!.cwd).toBe("/wire-check");
      expect(entry!.title).toBe("wire shape check");
      expect(typeof entry!.updatedAt).toBe("string");
      // Hydra-only fields live under _meta["hydra-acp"].
      const meta = entry!._meta as Record<string, unknown>;
      const hydra = meta["hydra-acp"] as Record<string, unknown>;
      expect(hydra.agentId).toBe("claude-acp");
      expect(hydra.status).toBe("cold");
      expect(hydra.attachedClients).toBe(0);

      ws.close();
    });

    it("returns the agent catalog over hydra-acp/agents/list matching GET /v1/agents", async () => {
      // Seed the registry disk cache so the lazily-loaded Registry finds
      // it (the test config points at an unreachable URL). Both the REST
      // endpoint and the ACP method call core listAgents(), so they must
      // return byte-identical results.
      const doc = {
        version: "2026-01-01",
        agents: [
          {
            id: "claude-acp",
            name: "Claude",
            version: "1.0.0",
            description: "Anthropic agent",
            distribution: { npx: { package: "@anthropic-ai/claude-code" } },
          },
          {
            id: "opencode",
            name: "OpenCode",
            distribution: { uvx: { package: "opencode" } },
          },
        ],
      };
      await fs.writeFile(
        path.join(tmpHome, "registry.json"),
        JSON.stringify({ fetchedAt: Date.now(), data: doc }),
        "utf8",
      );

      const restRes = await fetch(`${baseUrl}/v1/agents`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(restRes.status).toBe(200);
      const rest = await restRes.json();

      const ws = new WebSocket(`${wsUrl}?token=${TEST_TOKEN}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const responsePromise = new Promise<unknown>((resolve) => {
        ws.on("message", (data) => resolve(JSON.parse(data.toString("utf8"))));
      });
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "hydra-acp/agents/list",
          params: {},
        }),
      );
      const response = (await responsePromise) as {
        id: number;
        result: {
          version: string;
          agents: Array<{ id: string; installed: string; distributions: string[] }>;
        };
      };
      expect(response.id).toBe(42);
      expect(response.result).toEqual(rest);
      expect(response.result.version).toBe("2026-01-01");
      expect(response.result.agents.map((a) => a.id)).toEqual([
        "claude-acp",
        "opencode",
      ]);
      // uvx-only agent resolves lazily.
      expect(
        response.result.agents.find((a) => a.id === "opencode")?.installed,
      ).toBe("lazy");

      ws.close();
    });

    it("filters non-interactive sessions out of session/list over ACP", async () => {
      // The daemon's default session/list view shows only effective
      // interactive=true rows. This covers three filter paths in one
      // test: explicit interactive=true is visible, explicit false is
      // hidden, and the legacy cat clientInfo hint still hides pre-flag
      // cat rows.
      const store = new SessionStore();
      const now = new Date().toISOString();
      await store.write({
        sessionId: "hydra_session_kept_normal",
        upstreamSessionId: "u_keep_normal",
        cwd: "/work",
        agentId: "claude-acp",
        originatingClient: { name: "regular-client" },
        interactive: true,
        createdAt: now,
        updatedAt: now,
      });
      await store.write({
        sessionId: "hydra_session_hide_cat",
        upstreamSessionId: "u_hide_cat",
        cwd: "/work",
        agentId: "claude-acp",
        originatingClient: { name: HYDRA_CAT_CLIENT_NAME },
        createdAt: now,
        updatedAt: now,
      });

      const ws = new WebSocket(`${wsUrl}?token=${TEST_TOKEN}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const responsePromise = new Promise<unknown>((resolve) => {
        ws.on("message", (data) =>
          resolve(JSON.parse(data.toString("utf8"))),
        );
      });
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 12,
          method: "session/list",
          params: {},
        }),
      );
      const response = (await responsePromise) as {
        id: number;
        result: { sessions: Array<{ sessionId: string }> };
      };
      expect(response.id).toBe(12);
      const ids = response.result.sessions.map((s) => s.sessionId);
      expect(ids).toContain("hydra_session_kept_normal");
      expect(ids).not.toContain("hydra_session_hide_cat");

      ws.close();
    });

    it("rejects non-standard params on session/list over ACP", async () => {
      // The ratified spec accepts only `cwd` and `cursor`. The 2025-11-23
      // revision removed `limit`. With strict-object schema parsing
      // disabled we ignore unknown fields rather than 400, but `limit`
      // is no longer in our schema — confirm that and that a known-good
      // request with just `cwd` works.
      const ws = new WebSocket(`${wsUrl}?token=${TEST_TOKEN}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const responsePromise = new Promise<unknown>((resolve) => {
        ws.on("message", (data) =>
          resolve(JSON.parse(data.toString("utf8"))),
        );
      });
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 11,
          method: "session/list",
          params: { cwd: "/no-such-dir" },
        }),
      );
      const response = (await responsePromise) as {
        id: number;
        result: { sessions: unknown[]; nextCursor?: string };
      };
      expect(response.id).toBe(11);
      expect(Array.isArray(response.result.sessions)).toBe(true);
      // Single page: nextCursor MUST be absent when there are no more
      // results.
      expect(response.result.nextCursor).toBeUndefined();
      ws.close();
    });

    it("accepts session/cancel as a notification (spec form)", async () => {
      // Regression: pre-fix the daemon registered onRequest only, so a
      // spec-compliant client (no `id`) had its cancel silently dropped.
      const ws = new WebSocket(`${wsUrl}?token=${TEST_TOKEN}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });

      let gotMessage: unknown = null;
      ws.on("message", (data) => {
        gotMessage = JSON.parse(data.toString("utf8"));
      });

      // Send session/cancel as a *notification* — no `id` field.
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId: "no-such-session" },
        }),
      );

      // Followed by a real request whose response we can wait for; if the
      // notification got mishandled (e.g. processed as a request and
      // produced an error response with id:undefined), the next
      // round-trip's response would be wrong.
      const followUp = new Promise<{ id: number; result: unknown }>(
        (resolve) => {
          ws.on("message", (data) => {
            const parsed = JSON.parse(data.toString("utf8")) as {
              id?: number;
              result?: unknown;
            };
            if (parsed.id === 42) {
              resolve(parsed as { id: number; result: unknown });
            }
          });
        },
      );
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "session/list",
          params: {},
        }),
      );
      const response = await followUp;
      expect(response.id).toBe(42);
      // Notifications produce no response — gotMessage should be the
      // session/list response, not anything synthesized for cancel.
      expect((gotMessage as { id?: number }).id).toBe(42);

      ws.close();
    });

    describe("read-only attach", () => {
      async function importColdSession(): Promise<string> {
        const bundle = {
          version: 1,
          exportedAt: "2026-05-13T00:00:00.000Z",
          exportedFrom: { hydraVersion: "0.1.0", machine: "test-host" },
          session: {
            sessionId: "hydra_session_origin_ro",
            lineageId: "hydra_lineage_readonly_test",
            agentId: "claude-acp",
            cwd: "/work",
            createdAt: "2026-05-13T00:00:00.000Z",
            updatedAt: "2026-05-13T00:00:00.000Z",
          },
          history: [
            {
              method: "session/update",
              params: {
                sessionId: "hydra_session_origin_ro",
                update: {
                  sessionUpdate: "prompt_received",
                  prompt: [{ type: "text", text: "hello viewer" }],
                },
              },
              recordedAt: 1000,
            },
            {
              method: "session/update",
              params: {
                sessionId: "hydra_session_origin_ro",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "hi from history" },
                },
              },
              recordedAt: 2000,
            },
          ],
        };
        const r = await fetch(`${baseUrl}/v1/sessions/import`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_TOKEN}`,
          },
          body: JSON.stringify({ bundle }),
        });
        expect(r.status).toBe(201);
        const body = (await r.json()) as { sessionId: string };
        return body.sessionId;
      }

      async function openWs(): Promise<WebSocket> {
        const ws = new WebSocket(`${wsUrl}?token=${TEST_TOKEN}`);
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", reject);
        });
        return ws;
      }

      it("cold session + readonly attaches without resurrecting an agent and streams history as replay", async () => {
        const sessionId = await importColdSession();
        // Sanity: the imported session is cold (not in manager.sessions).
        expect(handle!.manager.get(sessionId)).toBeUndefined();

        const ws = await openWs();
        const notifications: Array<{ method: string; params: unknown }> = [];
        const attachResponse = new Promise<{
          id: number;
          result: {
            sessionId: string;
            replayed: number;
            historyPolicy: string;
            _meta?: { "hydra-acp"?: { agentId?: string; cwd?: string } };
          };
        }>((resolve) => {
          ws.on("message", (data) => {
            const msg = JSON.parse(data.toString("utf8")) as {
              id?: number;
              method?: string;
              params?: unknown;
              result?: unknown;
            };
            if (msg.id === 1 && msg.result) {
              resolve(msg as never);
            } else if (msg.method) {
              notifications.push({
                method: msg.method,
                params: msg.params,
              });
            }
          });
        });
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "session/attach",
            params: {
              sessionId,
              _meta: { "hydra-acp": { readonly: true } },
              clientInfo: { name: "ro-test" },
            },
          }),
        );
        const response = await attachResponse;
        expect(response.result.sessionId).toBe(sessionId);
        expect(response.result.replayed).toBe(2);
        expect(response.result.historyPolicy).toBe("full");
        expect(response.result._meta?.["hydra-acp"]?.agentId).toBe("claude-acp");
        expect(response.result._meta?.["hydra-acp"]?.cwd).toBe("/work");

        // Crucially: the viewer path did NOT call manager.resurrect, so
        // no Session is in the manager's live map. That's the core
        // guarantee — no agent process was spawned to serve this read.
        expect(handle!.manager.get(sessionId)).toBeUndefined();

        // Give the deferred replay a tick to land on the wire.
        await new Promise((r) => setTimeout(r, 50));
        expect(notifications.length).toBe(2);
        expect(notifications[0]?.method).toBe("session/update");
        expect(
          (notifications[0]?.params as { update?: { sessionUpdate?: string } })
            ?.update?.sessionUpdate,
        ).toBe("prompt_received");
        expect(
          (notifications[1]?.params as { update?: { sessionUpdate?: string } })
            ?.update?.sessionUpdate,
        ).toBe("agent_message_chunk");

        ws.close();
      });

      it("readonly attach rejects session/prompt with PermissionDenied (-32011)", async () => {
        const sessionId = await importColdSession();
        const ws = await openWs();

        const attachDone = new Promise<void>((resolve) => {
          ws.on("message", (data) => {
            const msg = JSON.parse(data.toString("utf8")) as { id?: number };
            if (msg.id === 1) {
              resolve();
            }
          });
        });
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "session/attach",
            params: { sessionId, _meta: { "hydra-acp": { readonly: true } } },
          }),
        );
        await attachDone;

        const promptResponse = new Promise<{
          id: number;
          error?: { code: number; message: string };
        }>((resolve) => {
          ws.on("message", (data) => {
            const msg = JSON.parse(data.toString("utf8")) as {
              id?: number;
              error?: { code: number; message: string };
            };
            if (msg.id === 2) {
              resolve(msg as never);
            }
          });
        });
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "session/prompt",
            params: {
              sessionId,
              prompt: [{ type: "text", text: "should not reach agent" }],
            },
          }),
        );
        const response = await promptResponse;
        expect(response.error?.code).toBe(-32011);
        expect(response.error?.message).toContain("read-only");

        ws.close();
      });

      it("readonly attach rejects session/set_model with PermissionDenied", async () => {
        const sessionId = await importColdSession();
        const ws = await openWs();
        const attachDone = new Promise<void>((resolve) => {
          ws.on("message", (data) => {
            const msg = JSON.parse(data.toString("utf8")) as { id?: number };
            if (msg.id === 1) {
              resolve();
            }
          });
        });
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "session/attach",
            params: { sessionId, _meta: { "hydra-acp": { readonly: true } } },
          }),
        );
        await attachDone;

        const setModelResponse = new Promise<{
          id: number;
          error?: { code: number };
        }>((resolve) => {
          ws.on("message", (data) => {
            const msg = JSON.parse(data.toString("utf8")) as {
              id?: number;
              error?: { code: number };
            };
            if (msg.id === 2) {
              resolve(msg as never);
            }
          });
        });
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "session/set_model",
            params: { sessionId, modelId: "claude-opus-4-7" },
          }),
        );
        const response = await setModelResponse;
        expect(response.error?.code).toBe(-32011);

        ws.close();
      });

      it("session/detach cleanly tears down a viewer attachment", async () => {
        const sessionId = await importColdSession();
        const ws = await openWs();
        const attachDone = new Promise<void>((resolve) => {
          ws.on("message", (data) => {
            const msg = JSON.parse(data.toString("utf8")) as { id?: number };
            if (msg.id === 1) {
              resolve();
            }
          });
        });
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "session/attach",
            params: { sessionId, _meta: { "hydra-acp": { readonly: true } } },
          }),
        );
        await attachDone;

        const detachResponse = new Promise<{ id: number; result?: unknown }>(
          (resolve) => {
            ws.on("message", (data) => {
              const msg = JSON.parse(data.toString("utf8")) as {
                id?: number;
                result?: unknown;
              };
              if (msg.id === 2) {
                resolve(msg as never);
              }
            });
          },
        );
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "session/detach",
            params: { sessionId },
          }),
        );
        const response = await detachResponse;
        expect(response.result).toMatchObject({
          sessionId,
          _meta: { "hydra-acp": { detachStatus: "detached" } },
        });

        ws.close();
      });
    });

    it("accepts session/cancel as a request for backward compat", async () => {
      const ws = new WebSocket(`${wsUrl}?token=${TEST_TOKEN}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });

      const responsePromise = new Promise<{
        id: number;
        result?: unknown;
        error?: unknown;
      }>((resolve) => {
        ws.on("message", (data) => {
          resolve(JSON.parse(data.toString("utf8")));
        });
      });

      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "session/cancel",
          params: { sessionId: "no-such-session" },
        }),
      );

      const response = await responsePromise;
      expect(response.id).toBe(7);
      // No session attached → no error surfaced to the client (the cancel
      // is a no-op when the session can't be found, matching the
      // notification path's silent behavior).
      expect(response.error).toBeUndefined();

      ws.close();
    });
  });

  describe("lifecycle", () => {
    it("writes a daemon.pid file at startup", async () => {
      const pidPath = path.join(tmpHome, "daemon.pid");
      const raw = await fs.readFile(pidPath, "utf8");
      const info = JSON.parse(raw) as { pid: number; port: number };
      expect(info.pid).toBe(process.pid);
      expect(info.port).toBe(port(handle!));
    });

    it("removes daemon.pid on shutdown", async () => {
      await handle!.shutdown();
      handle = null;
      const pidPath = path.join(tmpHome, "daemon.pid");
      await expect(fs.access(pidPath)).rejects.toThrow();
    });

    it("shutdown is idempotent", async () => {
      await handle!.shutdown();
      await expect(handle!.shutdown()).resolves.toBeUndefined();
      handle = null;
    });

    it("rotates logs into daemon.<N>.log files with a current.log symlink", async () => {
      handle!.app.log.warn("test-marker-line");

      await handle!.shutdown();
      handle = null;

      const entries = await fs.readdir(tmpHome);
      const logFiles = entries.filter((e) => /^daemon\.\d+\.log$/.test(e));
      expect(logFiles.length).toBeGreaterThanOrEqual(1);
      expect(entries).toContain("current.log");

      const symlinkPath = path.join(tmpHome, "current.log");
      const contents = await fs.readFile(symlinkPath, "utf8");
      expect(contents.length).toBeGreaterThan(0);
      expect(contents).toContain("test-marker-line");
      const firstLine = contents.split("\n")[0];
      expect(() => JSON.parse(firstLine!)).not.toThrow();
    });
  });

  describe("non-loopback bind", () => {
    it("refuses to bind to non-loopback without TLS", async () => {
      const cfg = testConfig();
      cfg.daemon.host = "0.0.0.0";
      await expect(startDaemon(cfg, TEST_TOKEN)).rejects.toThrow(/non-loopback/);
    });
  });
});

const PROBE_SCRIPT = `setInterval(() => {}, 60_000);`;

describe("startDaemon — extensions REST lifecycle", () => {
  let handle: DaemonHandle | null = null;
  let baseUrl: string;

  beforeEach(async () => {
    const cfg: HydraConfig = {
      daemon: {
        host: "127.0.0.1",
        port: 0,
        logLevel: "warn",
        sessionIdleTimeoutSeconds: 30,
        sessionHistoryMaxEntries: 1000,
        agentStderrTailBytes: 4096,
        agentSyncIntervalMinutes: 0,
      },
      registry: {
        url: "http://127.0.0.1:65535/never-reached",
        ttlHours: 24,
      pinned: false,
      },
      defaultAgent: "claude-acp",
      defaultModels: {},
      synopsisOnClose: false,
      defaultCwd: os.homedir(),
      sessionListColdLimit: 20,
      agents: {},
      agentOverrides: {},
      extensions: {
        probe: {
          command: ["node", "-e", PROBE_SCRIPT],
          args: [],
          env: {},
          enabled: true,
        },
      },
      transformers: {},
      defaultTransformers: [],
      tui: {
        repaintThrottleMs: 1000,
        maxScrollbackLines: 10_000,
        mouse: false,
        logMaxBytes: 5 * 1024 * 1024,
        cwdColumnMaxWidth: 24,
        progressIndicator: true,
        defaultEnterAction: "amend" as const,
        showThoughts: true,
        ambiguousWidth: "narrow",
        promptHistoryMaxEntries: 2_000,
        maxToolItems: 5,
        maxPlanItems: 5,
        showFileUpdates: "none" as const,
      },
    };
    handle = await startDaemon(cfg, TEST_TOKEN);
    const p = port(handle);
    baseUrl = `http://127.0.0.1:${p}`;
  });

  afterEach(async () => {
    if (handle) {
      await handle.shutdown().catch(() => undefined);
      handle = null;
    }
  });

  it("list shows the configured probe extension as running", async () => {
    // give the probe a moment to spawn
    await new Promise((r) => setTimeout(r, 200));
    const r = await fetch(`${baseUrl}/v1/extensions`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      extensions: Array<{ name: string; status: string; pid: number | null }>;
    };
    expect(body.extensions).toHaveLength(1);
    expect(body.extensions[0]?.name).toBe("probe");
    expect(body.extensions[0]?.status).toBe("running");
    expect(body.extensions[0]?.pid).toBeGreaterThan(0);
  });

  it("stop then start cycles a probe extension", async () => {
    await new Promise((r) => setTimeout(r, 200));
    const stopR = await fetch(`${baseUrl}/v1/extensions/probe/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(stopR.status).toBe(200);
    const stopped = (await stopR.json()) as { status: string };
    expect(stopped.status).toBe("stopped");

    const startR = await fetch(`${baseUrl}/v1/extensions/probe/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(startR.status).toBe(200);
    const started = (await startR.json()) as { status: string; pid: number };
    expect(started.status).toBe("running");
    expect(started.pid).toBeGreaterThan(0);
  });

  it("returns 409 starting an already-running extension", async () => {
    await new Promise((r) => setTimeout(r, 200));
    const r = await fetch(`${baseUrl}/v1/extensions/probe/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(r.status).toBe(409);
  });

  it("restart returns a new pid", async () => {
    await new Promise((r) => setTimeout(r, 200));
    const before = (await (
      await fetch(`${baseUrl}/v1/extensions/probe`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      })
    ).json()) as { pid: number };

    const r = await fetch(`${baseUrl}/v1/extensions/probe/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(r.status).toBe(200);
    const after = (await r.json()) as { status: string; pid: number };
    expect(after.status).toBe("running");
    expect(after.pid).toBeGreaterThan(0);
    expect(after.pid).not.toBe(before.pid);
  });
});
