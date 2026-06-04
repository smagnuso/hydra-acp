#!/usr/bin/env node
/**
 * Example transformer extension — lifecycle (transformer-lifecycle.mjs).
 *
 * Demonstrates how to receive session lifecycle events from the daemon:
 *   session.opened  — fires when a session is created with this transformer
 *                     in its chain
 *   session.idle    — fires after a configurable quiet period (default 30s)
 *                     with no recordable activity
 *   session.closed  — fires when a session is closing
 *
 * Unlike hydra-acp/transformer/message (which intercepts in-flight traffic), lifecycle
 * events are fire-and-forget notifications — the daemon does not wait for a
 * response. They are declared in intercepts under the "lifecycle:" prefix.
 *
 * This example:
 *   - Tracks open sessions and logs transitions
 *   - On session.idle, optionally emits a follow-up prompt (ralph-loop pattern)
 *   - Persists a small per-session counter to the transformer state dir to
 *     demonstrate how to carry state across idle events
 *
 * Usage:
 *   HYDRA_ACP_WS_URL=ws://127.0.0.1:55514/acp \
 *   HYDRA_ACP_TOKEN=$(cat ~/.hydra-acp/auth-token) \
 *   HYDRA_ACP_HOME=~/.hydra-acp \
 *   HYDRA_ACP_TRANSFORMER_NAME=lifecycle-demo \
 *   node examples/transformer-lifecycle.mjs
 *
 * Register in config.json:
 *   "transformers": {
 *     "lifecycle-demo": {
 *       "command": ["node", "/path/to/hydra-acp/cli/examples/transformer-lifecycle.mjs"]
 *     }
 *   },
 *   "defaultTransformers": ["lifecycle-demo"]
 *
 * Set IDLE_PROMPT to a non-empty string to enable auto-continuation on idle:
 *   "env": { "IDLE_PROMPT": "Please continue." }
 * Leave it unset (the default) to observe-only.
 */

import { WebSocket } from "ws";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const wsUrl = process.env.HYDRA_ACP_WS_URL ?? "ws://127.0.0.1:55514/acp";
const token = process.env.HYDRA_ACP_TOKEN ?? "";
const hydraHome = process.env.HYDRA_ACP_HOME ?? join(process.env.HOME ?? "~", ".hydra-acp");
const transformerName = process.env.HYDRA_ACP_TRANSFORMER_NAME ?? "lifecycle-demo";
const idlePrompt = process.env.IDLE_PROMPT ?? ""; // empty = observe-only

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

// ── Per-session state ─────────────────────────────────────────────────────────

// Simple in-memory map; also persisted to the state scratch dir so it
// survives transformer restarts (the daemon keeps sessions alive across them).
const sessionState = new Map(); // sessionId → { idleCount, openedAt }

function stateDir(sessionId) {
  return join(hydraHome, "sessions", sessionId, "transformer-state", transformerName);
}

function loadState(sessionId) {
  try {
    const raw = readFileSync(join(stateDir(sessionId), "state.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return { idleCount: 0 };
  }
}

function saveState(sessionId, state) {
  try {
    const dir = stateDir(sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
  } catch {
    // Non-fatal — state is still in memory.
  }
}

// ── Connect ───────────────────────────────────────────────────────────────────

const ws = new WebSocket(wsUrl, ["acp.v1", `hydra-acp-token.${token}`]);

ws.on("open", async () => {
  console.log("[lifecycle-demo] connected to", wsUrl);
  try {
    await request(ws, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "transformer-lifecycle", version: "0.0.1" },
    });
    await request(ws, "hydra-acp/transformer/initialize", {
      // Lifecycle intercepts use the "lifecycle:" prefix.
      // No "request:" or "response:" intercepts — this transformer only
      // reacts to session events, not in-flight messages.
      intercepts: [
        "lifecycle:session.opened",
        "lifecycle:session.idle",
        "lifecycle:session.closed",
      ],
      capabilities: {
        canOriginate: true, // needed to emit follow-up prompts on idle
      },
    });
    console.log("[lifecycle-demo] ready — listening for session lifecycle events\n");
  } catch (err) {
    console.error("[lifecycle-demo] handshake failed:", err.message);
    ws.close();
  }
});

// ── Handle messages ───────────────────────────────────────────────────────────

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());

  // Responses to our requests.
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
    return;
  }

  // hydra-acp/transformer/session_event — lifecycle notification (no response expected).
  if (msg.method === "hydra-acp/transformer/session_event" && msg.params) {
    handleLifecycleEvent(msg.params).catch((err) => {
      console.error("[lifecycle-demo] event handler error:", err.message);
    });
  }
});

async function handleLifecycleEvent({ event, sessionId }) {
  const sid = sessionId?.slice(-8) ?? "?";

  switch (event) {
    case "session.opened": {
      const state = loadState(sessionId);
      sessionState.set(sessionId, { ...state, openedAt: Date.now() });
      console.log(`[lifecycle-demo] session.opened   …${sid}  (idleCount so far: ${state.idleCount})`);
      break;
    }

    case "session.idle": {
      const state = sessionState.get(sessionId) ?? loadState(sessionId);
      state.idleCount = (state.idleCount ?? 0) + 1;
      sessionState.set(sessionId, state);
      saveState(sessionId, state);

      console.log(`[lifecycle-demo] session.idle     …${sid}  idleCount=${state.idleCount}`);

      // Optional: emit a follow-up prompt so the session auto-continues.
      // The envelope is the FLAT ACP params shape — { sessionId, prompt }
      // directly, NOT wrapped in another { params: ... }. See PROTOCOL.md
      // → "Envelope shape" on hydra-acp/transformer/message.
      if (idlePrompt) {
        console.log(`[lifecycle-demo]   → emitting idle prompt for …${sid}`);
        try {
          await request(ws, "hydra-acp/message/emit", {
            sessionId,
            method: "session/prompt",
            envelope: {
              sessionId,
              prompt: [{ type: "text", text: idlePrompt }],
            },
            route: "chain",
          });
        } catch (err) {
          console.warn(`[lifecycle-demo]   emit failed: ${err.message}`);
        }
      }
      break;
    }

    case "session.closed": {
      const state = sessionState.get(sessionId);
      const duration = state?.openedAt
        ? Math.round((Date.now() - state.openedAt) / 1000)
        : "?";
      console.log(
        `[lifecycle-demo] session.closed  …${sid}  duration=${duration}s  idleCount=${state?.idleCount ?? "?"}`,
      );
      sessionState.delete(sessionId);
      break;
    }
  }
}

// ── Teardown ──────────────────────────────────────────────────────────────────

ws.on("error", (err) => console.error("[lifecycle-demo] error:", err.message));
ws.on("close", (code) => { console.log(`[lifecycle-demo] disconnected (${code})`); process.exit(0); });
process.on("SIGINT", () => { process.stdout.write("\n[lifecycle-demo] shutting down\n"); ws.close(); });
