#!/usr/bin/env node
/**
 * Example client extension.
 *
 * A client extension connects to the daemon as a regular ACP client. It can
 * observe sessions, attach to them to watch conversation traffic, and send
 * prompts. It cannot intercept or modify messages — for that, see
 * transformer-extension.mjs.
 *
 * This demo:
 *   - Polls session/list every 5 seconds and logs any new sessions
 *   - Attaches to each live session it discovers and logs session/update events
 *   - Shows how to handle permission requests (auto-approves for demo purposes)
 *
 * Usage (manual):
 *   HYDRA_ACP_WS_URL=ws://127.0.0.1:55514/acp \
 *   HYDRA_ACP_TOKEN=$(cat ~/.hydra-acp/auth-token) \
 *   node examples/client-extension.mjs
 *
 * Register in config.json as an extension (daemon manages lifecycle):
 *   "extensions": {
 *     "demo-client": {
 *       "command": ["node", "/path/to/hydra-acp/cli/examples/client-extension.mjs"],
 *       "enabled": true
 *     }
 *   }
 *
 * The daemon injects HYDRA_ACP_WS_URL, HYDRA_ACP_TOKEN, and HYDRA_ACP_HOME
 * automatically when spawning extensions.
 */

import { WebSocket } from "ws";

const wsUrl = process.env.HYDRA_ACP_WS_URL ?? "ws://127.0.0.1:55514/acp";
const token = process.env.HYDRA_ACP_TOKEN ?? "";

if (!token) {
  process.stderr.write("HYDRA_ACP_TOKEN is required\n");
  process.exit(1);
}

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

let nextId = 1;
const pending = new Map();

function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

function request(ws, method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send(ws, { jsonrpc: "2.0", id, method, params });
  });
}

function onMessage(ws, handler) {
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    // Route responses to pending requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        return;
      }
    }
    handler(msg);
  });
}

// ── Per-session connection ────────────────────────────────────────────────────

const attachedSessions = new Set();

function attachSession(sessionId) {
  if (attachedSessions.has(sessionId)) return;
  attachedSessions.add(sessionId);

  const sessionWs = new WebSocket(wsUrl, ["acp.v1", `hydra-acp-token.${token}`]);

  sessionWs.on("open", async () => {
    try {
      await request(sessionWs, "initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "demo-client-extension", version: "0.0.1" },
      });
      await request(sessionWs, "session/attach", {
        sessionId,
        historyPolicy: "none",   // don't replay history, just watch from now
      });
      console.log(`[demo-client] attached to session …${sessionId.slice(-8)}`);
    } catch (err) {
      console.warn(`[demo-client] attach failed for …${sessionId.slice(-8)}: ${err.message}`);
      attachedSessions.delete(sessionId);
      sessionWs.close();
    }
  });

  onMessage(sessionWs, (msg) => {
    if (msg.method === "session/update") {
      const update = msg.params?.update ?? {};
      const type = update.sessionUpdate ?? "?";

      if (type === "prompt_received") {
        const text = extractText(update.prompt);
        console.log(`[demo-client] ← prompt   …${sessionId.slice(-8)}  "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`);
      } else if (type === "turn_complete") {
        console.log(`[demo-client] ← complete …${sessionId.slice(-8)}  stopReason=${update.stopReason ?? "?"}`);
      }
      // Ignore other update types (model changes, commands, etc.)
    }

    // Permission request — the daemon asks whether to allow a tool call.
    // A real extension would check the tool name / args before approving.
    if (msg.method === "session/request_permission" && msg.id !== undefined) {
      const tool = msg.params?.permission?.toolName ?? "?";
      console.log(`[demo-client] permission requested: ${tool} — auto-approving`);
      send(sessionWs, {
        jsonrpc: "2.0",
        id: msg.id,
        result: { granted: true },
      });
    }

    // Session closed by the daemon.
    if (msg.method === "session/update" && msg.params?.update?.sessionUpdate === "session_closed") {
      console.log(`[demo-client] session …${sessionId.slice(-8)} closed`);
      attachedSessions.delete(sessionId);
      sessionWs.close();
    }
  });

  sessionWs.on("close", () => {
    attachedSessions.delete(sessionId);
  });
}

// ── Main connection: session/list polling ─────────────────────────────────────

const mainWs = new WebSocket(wsUrl, ["acp.v1", `hydra-acp-token.${token}`]);

mainWs.on("open", async () => {
  console.log("[demo-client] connected to", wsUrl);
  await request(mainWs, "initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "demo-client-extension", version: "0.0.1" },
  });
  console.log("[demo-client] ready — polling for sessions every 5s\n");
  poll();
});

onMessage(mainWs, (_msg) => {
  // Main connection only used for session/list — no inbound traffic expected.
});

async function poll() {
  try {
    const result = await request(mainWs, "session/list", {});
    for (const entry of result?.sessions ?? []) {
      if (entry.status === "live") {
        attachSession(entry.sessionId);
      }
    }
  } catch (err) {
    console.warn("[demo-client] session/list failed:", err.message);
  }
  setTimeout(poll, 5_000);
}

mainWs.on("error", (err) => console.error("[demo-client] error:", err.message));
mainWs.on("close", () => { console.log("[demo-client] disconnected"); process.exit(0); });
process.on("SIGINT", () => { process.stdout.write("\n[demo-client] shutting down\n"); mainWs.close(); });

// ── Utility ───────────────────────────────────────────────────────────────────

function extractText(prompt) {
  if (!Array.isArray(prompt)) return String(prompt ?? "");
  return prompt
    .filter((p) => typeof p?.text === "string")
    .map((p) => p.text)
    .join(" ");
}
