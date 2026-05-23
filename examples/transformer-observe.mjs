#!/usr/bin/env node
/**
 * Example transformer extension — observe (transformer-observe.mjs).
 *
 * A transformer sits inside the daemon's message pipeline. Unlike a client
 * extension, it sees every in-flight ACP message before the daemon acts on it
 * — before prompts reach the agent and before responses reach clients.
 *
 * The transformer declares which message kinds it wants to intercept via
 * transformer/initialize. For each message the daemon delivers it via
 * transformer/message and waits for one of:
 *   { action: "continue" }  — pass through unchanged (Phase 2 only action)
 *   { action: "stop" }      — block the message (Phase 3+)
 *   { action: "processing" }— transformer will respond itself (Phase 3+)
 *
 * This demo:
 *   - Intercepts outbound prompts (request:session/prompt) and logs them
 *   - Intercepts inbound updates (response:session/update) and logs them
 *   - Always returns { action: "continue" }
 *
 * Usage (manual):
 *   HYDRA_ACP_WS_URL=ws://127.0.0.1:55514/acp \
 *   HYDRA_ACP_TOKEN=$(cat ~/.hydra-acp/auth-token) \
 *   node examples/transformer-extension.mjs
 *
 * Register in config.json as a transformer:
 *   "transformers": {
 *     "debug": {
 *       "command": ["node", "/path/to/hydra-acp/cli/examples/transformer-extension.mjs"]
 *     }
 *   },
 *   "defaultTransformers": ["debug"]
 *
 * Key differences from a client extension:
 *   - Uses transformer/initialize instead of (or after) initialize
 *   - Must respond to every transformer/message request it receives
 *   - Sees traffic before state mutation — the daemon's world view only
 *     reflects what comes out of the chain
 *   - Token in each message is the daemon's chain correlation id
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

// ── Connect ───────────────────────────────────────────────────────────────────

const ws = new WebSocket(wsUrl, ["acp.v1", `hydra-acp-token.${token}`]);

ws.on("open", async () => {
  console.log("[debug-transformer] connected to", wsUrl);
  try {
    // Step 1: standard ACP initialize (reports our version to the daemon).
    await request(ws, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "debug-transformer", version: "0.0.1" },
    });

    // Step 2: transformer/initialize declares which message kinds we want
    // to see. Only callable with a transformer process token.
    await request(ws, "transformer/initialize", {
      intercepts: [
        "request:session/prompt",    // outbound: client → agent
        "response:session/update",   // inbound:  agent  → clients
      ],
    });

    console.log("[debug-transformer] ready — intercepting session traffic\n");
  } catch (err) {
    console.error("[debug-transformer] handshake failed:", err.message);
    ws.close();
  }
});

// ── Handle messages ───────────────────────────────────────────────────────────

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());

  // Responses to our own requests (initialize, transformer/initialize).
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
    return;
  }

  // transformer/message — the daemon is asking us to process an in-flight
  // message. We MUST respond to every one of these.
  if (msg.method === "transformer/message" && msg.id !== undefined && msg.params) {
    handleTransformerMessage(msg);
    return;
  }
});

function handleTransformerMessage(msg) {
  const { token: chainToken, phase, method, sessionId, envelope } = msg.params;
  const arrow = phase === "request" ? "→" : "←";
  const sid = sessionId?.slice(-8) ?? "?";
  const tok = chainToken?.slice(-8) ?? "?";

  if (phase === "request" && method === "session/prompt") {
    // Outbound prompt: client → agent.
    const text = extractPromptText(envelope?.params?.prompt);
    console.log(`  ${arrow} session/prompt   session=…${sid}  token=…${tok}`);
    if (text) console.log(`     "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);
  } else if (phase === "response" && method === "session/update") {
    // Inbound update: agent → clients.
    const updateType = envelope?.params?.update?.sessionUpdate ?? "?";
    console.log(`  ${arrow} session/update   [${updateType}]  session=…${sid}  token=…${tok}`);
  }

  // Always continue in Phase 2 — stop/processing are Phase 3+ features.
  send(ws, { jsonrpc: "2.0", id: msg.id, result: { action: "continue" } });
}

// ── Teardown ──────────────────────────────────────────────────────────────────

ws.on("error", (err) => console.error("[debug-transformer] error:", err.message));
ws.on("close", (code) => { console.log(`[debug-transformer] disconnected (${code})`); process.exit(0); });
process.on("SIGINT", () => { process.stdout.write("\n[debug-transformer] shutting down\n"); ws.close(); });

// ── Utility ───────────────────────────────────────────────────────────────────

function extractPromptText(prompt) {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .filter((p) => typeof p?.text === "string")
    .map((p) => p.text)
    .join(" ");
}
