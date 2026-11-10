import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { startDaemon, type DaemonHandle } from "./server.js";
import { HydraConfig } from "../core/config.js";

const TEST_TOKEN = "hydra_token_0123456789abcdef0123456789abcdef";
const AGENT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../__tests__/fixtures/elicit-agent.mjs",
);

const FORM = {
  mode: "form",
  message: "Which cache?",
  requestedSchema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        title: "Cache",
        oneOf: [
          { const: "redis", title: "Redis" },
          { const: "memcached", title: "Memcached" },
        ],
      },
    },
  },
};

interface Wire {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

class Client {
  readonly seen: Wire[] = [];
  private next = 1;
  private pending = new Map<number, (m: Wire) => void>();
  onRequest: (m: Wire) => unknown | Promise<unknown> = () => ({
    __error: { code: -32601, message: "no" },
  });

  constructor(private ws: WebSocket) {
    ws.on("message", (data) => {
      const m = JSON.parse(data.toString("utf8")) as Wire;
      this.seen.push(m);
      if (m.method === undefined && typeof m.id === "number") {
        this.pending.get(m.id)?.(m);
        return;
      }
      if (m.method !== undefined && m.id !== undefined) {
        void Promise.resolve(this.onRequest(m)).then((out: any) => {
          const reply =
            out && out.__error !== undefined
              ? { jsonrpc: "2.0", id: m.id, error: out.__error }
              : { jsonrpc: "2.0", id: m.id, result: out };
          ws.send(JSON.stringify(reply));
        });
      }
    });
  }

  static async open(url: string): Promise<Client> {
    const ws = new WebSocket(`${url}?token=${TEST_TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new Client(ws);
  }

  request(method: string, params: unknown): Promise<Wire> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  texts(): string[] {
    return this.seen
      .filter((m) => m.method === "session/update")
      .map((m) => m.params?.update?.content?.text)
      .filter((t): t is string => typeof t === "string");
  }

  has(method: string): boolean {
    return this.seen.some((m) => m.method === method);
  }

  async until(pred: () => boolean, what: string): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > 10_000) {
        throw new Error(
          `timed out waiting for ${what}; saw ${JSON.stringify(this.seen.map((m) => m.method ?? "resp"))} ${JSON.stringify(this.texts())}`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  close(): void {
    this.ws.close();
  }
}

describe("elicitation end to end (real daemon, scripted agent)", { timeout: 30_000 }, () => {
  let handle: DaemonHandle | null = null;
  let wsUrl: string;
  const clients: Client[] = [];

  beforeEach(async () => {
    const cfg = HydraConfig.parse({
      daemon: {
        host: "127.0.0.1",
        port: 1,
        logLevel: "warn",
        sessionIdleTimeoutSeconds: 30,
        nonInteractiveOrphanTimeoutSeconds: 30,
        agentSyncIntervalMinutes: 0,
        sessionGcIntervalMinutes: 0,
      },
      registry: { url: "http://127.0.0.1:65535/never-reached", ttlHours: 24, pinned: false },
      defaultAgent: "elicit",
      defaultCwd: os.tmpdir(),
      agents: {
        elicit: {
          command: process.execPath,
          args: [AGENT],
          env: { HYDRA_TEST_FORM: JSON.stringify(FORM) },
        },
      },
    });
    cfg.daemon.port = 0;
    handle = await startDaemon(cfg, TEST_TOKEN);
    const addr = handle.app.server.address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${addr.port}/acp`;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) {
      c.close();
    }
    await handle?.shutdown().catch(() => undefined);
    handle = null;
  });

  async function connect(name: string, capable: boolean): Promise<Client> {
    const c = await Client.open(wsUrl);
    clients.push(c);
    await c.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: capable ? { elicitation: { form: {} } } : {},
      clientInfo: { name },
    });
    return c;
  }

  async function startSession(owner: Client, other: Client): Promise<string> {
    const created = await owner.request("session/new", {
      cwd: os.tmpdir(),
      mcpServers: [],
      _meta: { "hydra-acp": { agentId: "elicit" } },
    });
    const sessionId = created.result?.sessionId as string;
    expect(sessionId).toBeTruthy();
    const attached = await other.request("session/attach", {
      sessionId,
      historyPolicy: "none",
    });
    expect(attached.error).toBeUndefined();
    return sessionId;
  }

  it("advertises form support to the agent, asks the capable client, shows plain clients the question, and records the outcome for both", async () => {
    const tui = await connect("tui", true);
    const plain = await connect("editor", false);
    tui.onRequest = (m) =>
      m.method === "elicitation/create"
        ? { action: "accept", content: { q: "redis" } }
        : { __error: { code: -32601, message: "no" } };
    const sessionId = await startSession(tui, plain);

    void tui.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });

    await tui.until(() => tui.texts().some((t) => t.startsWith("ANSWER:")), "agent answer");
    const answer = tui.texts().find((t) => t.startsWith("ANSWER:"))!;
    expect(answer).toContain('"action":"accept"');
    expect(answer).toContain('"q":"redis"');
    expect(answer).toContain('CAPS:{"form":{}}');

    expect(tui.has("elicitation/create")).toBe(true);
    expect(plain.has("elicitation/create")).toBe(false);
    await plain.until(() => plain.texts().some((t) => t.includes("Answered by tui")), "outcome line");
    expect(plain.texts().some((t) => t.includes("The agent asked") && t.includes("Redis / Memcached"))).toBe(true);
    expect(tui.texts().some((t) => t.includes("Answered by tui"))).toBe(true);
  });

  it("lets a plain client answer by prompt and dismisses the capable client's form", async () => {
    const tui = await connect("tui", true);
    const plain = await connect("editor", false);
    tui.onRequest = (m) =>
      m.method === "elicitation/create"
        ? new Promise(() => undefined)
        : { __error: { code: -32601, message: "no" } };
    const sessionId = await startSession(tui, plain);

    void tui.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    await tui.until(() => tui.has("elicitation/create"), "form on the capable client");
    await plain.until(() => plain.texts().some((t) => t.includes("Reply with")), "question text");

    const reply = await plain.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "2" }],
    });
    expect(reply.result?.stopReason).toBe("end_turn");

    await tui.until(
      () => tui.texts().some((t) => t.startsWith("ANSWER:")),
      "agent answer",
    );
    expect(tui.texts().find((t) => t.startsWith("ANSWER:"))).toContain('"q":"memcached"');
    expect(
      tui.seen.some(
        (m) =>
          m.method === "session/update" &&
          m.params?.update?.sessionUpdate === "elicitation_resolved",
      ),
    ).toBe(true);
    expect(plain.texts().some((t) => t.includes("Answered by editor"))).toBe(true);
  });

  it("answers cancel and records the question when no attached client can show a form", async () => {
    const plain = await connect("editor", false);
    const other = await connect("viewer", false);
    const sessionId = await startSession(plain, other);

    await plain.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    await plain.until(() => plain.texts().some((t) => t.startsWith("ANSWER:")), "agent answer");
    expect(plain.texts().find((t) => t.startsWith("ANSWER:"))).toContain('"action":"cancel"');
    expect(plain.texts().some((t) => t.includes("No attached client can show a form"))).toBe(true);
  });
});
