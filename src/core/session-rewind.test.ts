import { describe, it, expect, vi } from "vitest";
import { JsonRpcConnection } from "../acp/connection.js";
import { makeMockAgent, makeControlledStream } from "../__tests__/test-utils.js";
import { Session } from "./session.js";
import { HistoryStore } from "./history-store.js";
import { JsonRpcErrorCodes } from "../acp/types.js";

function makeClient(): {
  client: { clientId: string; connection: JsonRpcConnection };
  stream: ReturnType<typeof makeControlledStream>;
} {
  const stream = makeControlledStream();
  return {
    client: { clientId: `c_${Math.random().toString(36).slice(2, 8)}`, connection: new JsonRpcConnection(stream) },
    stream,
  };
}

function makeSession(id: string) {
  const oldMock = makeMockAgent({ agentId: "a1", cwd: "/w" });
  const newMock = makeMockAgent({ agentId: "a1", cwd: "/w" });
  const spawnReplacementAgent = vi.fn().mockResolvedValue({
    agent: newMock.agent,
    upstreamSessionId: "fresh_upstream",
    initialModel: "agent-default",
  });
  const historyStore = new HistoryStore();
  const session = new Session({
    sessionId: id,
    cwd: "/w",
    agentId: "a1",
    agent: oldMock.agent,
    upstreamSessionId: "u1",
    historyStore,
    spawnReplacementAgent,
    currentModel: "picked-model",
  });
  return { session, oldMock, newMock, spawnReplacementAgent, historyStore };
}

const truncations = (stream: ReturnType<typeof makeControlledStream>): unknown[] =>
  stream.sent
    .map((m) => m as { method?: string; params?: { update?: Record<string, unknown> } })
    .filter((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "_hydra_history_truncated")
    .map((m) => m.params?.update);

describe("Session.rewind", () => {
  it("cuts, replaces the agent seeded from what is left, keeps the model and tells every client", async () => {
    const { session, oldMock, newMock, spawnReplacementAgent, historyStore } = makeSession("hydra_rewind_live");
    await historyStore.rewrite("hydra_rewind_live", [
      {
        method: "session/update",
        params: { sessionId: "hydra_rewind_live", update: { sessionUpdate: "prompt_received", messageId: "p1", prompt: [{ type: "text", text: "kept question" }] } },
        recordedAt: 1,
      },
    ]);
    const { client, stream } = makeClient();
    session.attach(client, "full");
    const cut = vi.fn().mockResolvedValue(true);

    await session.rewind("p1", cut);
    await new Promise((r) => setImmediate(r));

    expect(cut).toHaveBeenCalledOnce();
    expect(spawnReplacementAgent).toHaveBeenCalledOnce();
    expect(oldMock.agent.kill).toHaveBeenCalled();
    const seed = (newMock.agent.connection.request as ReturnType<typeof vi.fn>).mock.calls.find(
      ([method]) => method === "session/prompt",
    );
    expect(JSON.stringify(seed)).toContain("kept question");
    expect(JSON.stringify(seed)).toContain("withdrawn");
    expect(session.currentModel).toBe("picked-model");
    expect(truncations(stream)).toEqual([{ sessionUpdate: "_hydra_history_truncated", keepThrough: "p1" }]);
  });

  it("leaves the agent alone when the cut dropped nothing", async () => {
    const { session, spawnReplacementAgent } = makeSession("hydra_rewind_noop");
    const { client, stream } = makeClient();
    session.attach(client, "full");

    await session.rewind("p1", async () => false);
    await new Promise((r) => setImmediate(r));

    expect(spawnReplacementAgent).not.toHaveBeenCalled();
    expect(truncations(stream)).toEqual([]);
  });

  it("refuses while a prompt is in flight", async () => {
    const { session } = makeSession("hydra_rewind_busy");
    (session as unknown as { promptInFlight: boolean }).promptInFlight = true;
    const cut = vi.fn().mockResolvedValue(true);

    await expect(session.rewind(null, cut)).rejects.toMatchObject({ code: JsonRpcErrorCodes.InvalidRequest });
    expect(cut).not.toHaveBeenCalled();
  });
});

describe("/hydra clear", () => {
  it("hands a full rewind to the manager without waiting on it", async () => {
    const { session } = makeSession("hydra_clear_cmd");
    let settle: () => void = () => undefined;
    session.rewindHook = vi.fn().mockReturnValue(new Promise<void>((r) => { settle = r; }));
    const handle = (session as unknown as { handleSlashCommand(text: string, messageId?: string): Promise<unknown> }).handleSlashCommand.bind(session);

    await expect(handle("/hydra clear", "m_clear")).resolves.toEqual({ stopReason: "end_turn" });
    expect(session.rewindHook).toHaveBeenCalledWith(null);
    settle();
  });

  it("lets a rewind requested from the turn in flight wait for that turn", async () => {
    const { session, spawnReplacementAgent } = makeSession("hydra_clear_after");
    (session as unknown as { promptInFlight: boolean }).promptInFlight = true;
    const cut = vi.fn().mockResolvedValue(true);
    const done = session.rewind(null, cut, { afterCurrentTurn: true });
    (session as unknown as { promptInFlight: boolean }).promptInFlight = false;
    await done;
    expect(cut).toHaveBeenCalledOnce();
    expect(spawnReplacementAgent).toHaveBeenCalledOnce();
  });
});
