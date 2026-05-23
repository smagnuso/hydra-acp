#!/usr/bin/env node
/**
 * Example transformer extension — edit (transformer-edit.mjs).
 *
 * Demonstrates the core active-transformer pattern:
 *   1. Intercept the prompt (return { action: "stop" } to take ownership)
 *   2. Modify the envelope
 *   3. Re-emit the modified prompt back into the chain via emit_message
 *
 * This example prepends a configurable instruction to every user prompt.
 * The agent sees the modified text; clients see the original they sent.
 *
 * Usage:
 *   HYDRA_ACP_WS_URL=ws://127.0.0.1:55514/acp \
 *   HYDRA_ACP_TOKEN=$(cat ~/.hydra-acp/auth-token) \
 *   PREPEND="Be concise. " \
 *   node examples/prompt-modifier.mjs
 *
 * Register in config.json:
 *   "transformers": {
 *     "prompt-modifier": {
 *       "command": ["node", "/path/to/hydra-acp/cli/examples/prompt-modifier.mjs"],
 *       "env": { "PREPEND": "Be concise. " }
 *     }
 *   },
 *   "defaultTransformers": ["prompt-modifier"]
 */

import { WebSocket } from "ws";

const wsUrl = process.env.HYDRA_ACP_WS_URL ?? "ws://127.0.0.1:55514/acp";
const token = process.env.HYDRA_ACP_TOKEN ?? "";
const prepend = process.env.PREPEND ?? "Be concise. ";

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
  console.log("[prompt-modifier] connected");
  try {
    await request(ws, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "prompt-modifier", version: "0.0.1" },
    });
    await request(ws, "transformer/initialize", {
      intercepts: ["request:session/prompt"],
    });
    console.log(`[prompt-modifier] ready — prepending "${prepend}" to every prompt\n`);
  } catch (err) {
    console.error("[prompt-modifier] handshake failed:", err.message);
    ws.close();
  }
});

// ── Handle messages ───────────────────────────────────────────────────────────

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
    return;
  }

  if (msg.method === "transformer/message" && msg.id !== undefined && msg.params) {
    handleMessage(msg);
  }
});

async function handleMessage(msg) {
  const { phase, method, sessionId, envelope } = msg.params;

  if (phase !== "request" || method !== "session/prompt") {
    // Shouldn't arrive given our intercepts declaration, but be defensive.
    send(ws, { jsonrpc: "2.0", id: msg.id, result: { action: "continue" } });
    return;
  }

  // Step 1: stop the original prompt so we can replace it.
  send(ws, { jsonrpc: "2.0", id: msg.id, result: { action: "stop" } });

  // Step 2: build the modified envelope — prepend our text to the first
  // text part of the prompt array, or wrap the whole thing if it's a string.
  const modified = modifyPrompt(envelope, prepend);

  console.log(`[prompt-modifier] modified prompt for session …${sessionId?.slice(-8)}`);

  // Step 3: re-emit the modified prompt into the chain. It resumes after
  // this transformer, so we won't intercept it again.
  try {
    await request(ws, "hydra-acp/emit_message", {
      sessionId,
      method: "session/prompt",
      envelope: modified,
      route: "chain",
    });
  } catch (err) {
    console.error("[prompt-modifier] emit_message failed:", err.message);
  }
}

// ── Prompt modification ───────────────────────────────────────────────────────

function modifyPrompt(envelope, prefix) {
  if (!envelope || typeof envelope !== "object") {
    return envelope;
  }
  const env = envelope;
  const prompt = env.params?.prompt;
  if (!prompt) {
    return envelope;
  }

  let modifiedPrompt;
  if (typeof prompt === "string") {
    modifiedPrompt = prefix + prompt;
  } else if (Array.isArray(prompt)) {
    // Prepend to the first text part; leave attachments and other part types alone.
    let prepended = false;
    modifiedPrompt = prompt.map((part) => {
      if (!prepended && part && typeof part.text === "string") {
        prepended = true;
        return { ...part, text: prefix + part.text };
      }
      return part;
    });
    // If there were no text parts, add one at the front.
    if (!prepended) {
      modifiedPrompt = [{ type: "text", text: prefix }, ...prompt];
    }
  } else {
    modifiedPrompt = prompt;
  }

  return {
    ...env,
    params: { ...env.params, prompt: modifiedPrompt },
  };
}

// ── Teardown ──────────────────────────────────────────────────────────────────

ws.on("error", (err) => console.error("[prompt-modifier] error:", err.message));
ws.on("close", (code) => { console.log(`[prompt-modifier] disconnected (${code})`); process.exit(0); });
process.on("SIGINT", () => { process.stdout.write("\n[prompt-modifier] shutting down\n"); ws.close(); });
