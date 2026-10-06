import { describe, expect, it } from "vitest";
import { makeMockAgent } from "../__tests__/test-utils.js";
import type { HistoryStore } from "./history-store.js";
import { contextBoundary, ownEntries } from "./side-context.js";
import { Session } from "./session.js";

const frame = (seq: number | undefined, text: string) => ({
  method: "session/update",
  params: {
    sessionId: "u",
    update: { sessionUpdate: "agent_message_chunk", messageId: `m${text}`, content: { type: "text", text } },
  },
  recordedAt: 1,
  ...(seq !== undefined ? { seq } : {}),
});

describe("ownEntries", () => {
  it("drops entries up to the context boundary and keeps the rest", () => {
    const entries = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
    expect(ownEntries(entries, { contextThroughSeq: 2 })).toEqual([{ seq: 3 }]);
  });

  it("keeps entries that carry no seq", () => {
    expect(ownEntries([{}, { seq: 1 }], { contextThroughSeq: 5 })).toEqual([{}]);
  });

  it("passes everything through when there is no side or no boundary", () => {
    const entries = [{ seq: 1 }];
    expect(ownEntries(entries, undefined)).toEqual(entries);
    expect(ownEntries(entries, {})).toEqual(entries);
  });
});

describe("contextBoundary", () => {
  it("is the highest seq copied", () => {
    expect(contextBoundary([{ seq: 4 }, { seq: 9 }, {}, { seq: 2 }])).toEqual({ contextThroughSeq: 9 });
  });

  it("is absent when nothing carries a seq", () => {
    expect(contextBoundary([{}, {}])).toEqual({});
    expect(contextBoundary([])).toEqual({});
  });
});

describe("a side session's attach replay", () => {
  async function replayed(side: { contextThroughSeq?: number } | undefined): Promise<string> {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const store = {
      load: async () => [frame(1, "context"), frame(2, "more context"), frame(3, "own")],
      hydrate: async (_sessionId: string, entries: unknown[]) => entries,
    } as unknown as HistoryStore;
    const session = new Session({
      sessionId: "hydra_session_side",
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u",
      historyStore: store,
      ...(side ? { side } : {}),
    });
    const client = { clientId: "c", send: () => undefined } as never;
    const { entries } = await session.attach(client, "full");
    return entries
      .map((entry) => (entry.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? "")
      .join("");
  }

  it("leaves out the copied context", async () => {
    expect(await replayed({ contextThroughSeq: 2 })).toBe("own");
  });

  it("replays everything for an ordinary session", async () => {
    expect(await replayed(undefined)).toBe("contextmore contextown");
  });
});
