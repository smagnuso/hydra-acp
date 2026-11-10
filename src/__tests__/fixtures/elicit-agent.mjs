// Scripted ACP agent for the elicitation e2e test. On every session/prompt it
// asks the client the form in HYDRA_TEST_FORM, waits for the answer, then
// reports the answer and the client capabilities it was initialized with.
import readline from "node:readline";

const form = JSON.parse(process.env.HYDRA_TEST_FORM ?? "{}");
let clientCaps = null;
let nextId = 1000;
const waiting = new Map();

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === undefined && msg.id !== undefined && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg);
    waiting.delete(msg.id);
    return;
  }
  if (msg.method === "initialize") {
    clientCaps = msg.params?.clientCapabilities ?? null;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "elicit-agent", version: "0.0.0" },
      },
    });
    return;
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "up_1" } });
    return;
  }
  if (msg.method === "session/prompt") {
    const id = nextId++;
    const answered = new Promise((resolve) => waiting.set(id, resolve));
    send({
      jsonrpc: "2.0",
      id,
      method: "elicitation/create",
      params: { ...form, sessionId: msg.params.sessionId },
    });
    const reply = await answered;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: msg.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `ANSWER:${JSON.stringify(reply.result ?? reply.error)} CAPS:${JSON.stringify(clientCaps?.elicitation ?? null)}`,
          },
        },
      },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
