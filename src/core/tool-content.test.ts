import { describe, it, expect } from "vitest";
import {
  applyToolContentMode,
  parseToolContentMode,
  externalizeToolEntry,
  expandToolRefs,
  isToolBlobRef,
  TOOL_BLOB_THRESHOLD,
} from "./tool-content.js";
import type { HistoryEntry } from "./history-store.js";

// In-memory content-addressed blob store for round-trip tests.
function memBlobs() {
  const map = new Map<string, string>();
  let putCount = 0;
  return {
    put: async (text: string) => {
      putCount++;
      const hash = `h${[...text].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)}`;
      map.set(hash, text);
      return hash;
    },
    get: async (hash: string) => map.get(hash) ?? null,
    get blobs() {
      return map;
    },
    get puts() {
      return putCount;
    },
  };
}

function toolUpdate(update: Record<string, unknown>): HistoryEntry {
  return {
    method: "session/update",
    params: { sessionId: "s", update: { sessionUpdate: "tool_call_update", ...update } },
    recordedAt: 0,
  };
}

describe("parseToolContentMode", () => {
  it("defaults to inline for anything but 'summary'", () => {
    expect(parseToolContentMode("summary")).toBe("summary");
    expect(parseToolContentMode("inline")).toBe("inline");
    expect(parseToolContentMode(undefined)).toBe("inline");
    expect(parseToolContentMode("nonsense")).toBe("inline");
  });
});

describe("applyToolContentMode", () => {
  it("inline returns the same array reference (no copy, full fidelity)", () => {
    const entries = [toolUpdate({ toolCallId: "t1", content: [] })];
    expect(applyToolContentMode(entries, "inline")).toBe(entries);
  });

  it("summary drops edit-diff old/new text but keeps it a recognizable Edited block", () => {
    const big = "x".repeat(100_000);
    const out = applyToolContentMode(
      [
        toolUpdate({
          toolCallId: "e1",
          status: "completed",
          content: [{ type: "diff", path: "/repo/a.ts", oldText: big, newText: big + "y" }],
        }),
      ],
      "summary",
    );
    const block = (out[0]!.params as { update: { content: Array<Record<string, unknown>> } })
      .update.content[0]!;
    expect(block.type).toBe("diff");
    expect(block.path).toBe("/repo/a.ts");
    // Heavy text shed, but defined (so extractEditDiff still yields a diff).
    expect(block.oldText).toBe("");
    expect(block.newText).toBe("");
  });

  it("summary slims rawOutput to error + metadata and clips stdout", () => {
    const big = "y".repeat(100_000);
    const out = applyToolContentMode(
      [
        toolUpdate({
          toolCallId: "t1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: big } }],
          rawOutput: { content: big, error: "boom", metadata: { interrupted: true } },
        }),
      ],
      "summary",
    );
    const u = (out[0]!.params as {
      update: {
        content: Array<{ content: { text: string } }>;
        rawOutput: Record<string, unknown>;
      };
    }).update;
    expect(u.content[0]!.content.text.length).toBeLessThan(big.length);
    expect(u.rawOutput.content).toBeUndefined();
    expect(u.rawOutput.error).toBe("boom");
    expect(u.rawOutput.metadata).toEqual({ interrupted: true });
  });

  it("summary leaves non-tool entries untouched", () => {
    const agent: HistoryEntry = {
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
      recordedAt: 0,
    };
    const out = applyToolContentMode([agent], "summary");
    expect(out[0]).toEqual(agent);
  });

  it("summary does not mutate the input entries", () => {
    const big = "z".repeat(100_000);
    const entry = toolUpdate({
      toolCallId: "t1",
      content: [{ type: "diff", path: "/a", oldText: big, newText: big }],
    });
    applyToolContentMode([entry], "summary");
    const block = (entry.params as { update: { content: Array<Record<string, unknown>> } })
      .update.content[0]!;
    expect((block.oldText as string).length).toBe(big.length);
  });
});

describe("externalize / hydrate round-trip", () => {
  const big = "x".repeat(TOOL_BLOB_THRESHOLD + 10);

  it("offloads large tool strings to refs and hydrates them back", async () => {
    const blobs = memBlobs();
    const entry = toolUpdate({
      toolCallId: "e1",
      status: "completed",
      content: [{ type: "diff", path: "/a.ts", oldText: big, newText: big + "z" }],
    });
    const ext = await externalizeToolEntry(entry, blobs.put);
    const block = (ext.params as { update: { content: Array<Record<string, unknown>> } })
      .update.content[0]!;
    // On-disk shape: large fields are refs, small ones (path) stay inline.
    expect(isToolBlobRef(block.oldText)).toBe(true);
    expect(isToolBlobRef(block.newText)).toBe(true);
    expect(block.path).toBe("/a.ts");

    const back = await expandToolRefs(ext, blobs.get);
    expect(back).toEqual(entry);
  });

  it("keeps small strings inline (no blob)", async () => {
    const blobs = memBlobs();
    const entry = toolUpdate({ toolCallId: "t1", content: [{ type: "diff", path: "/a", oldText: "tiny", newText: "tinier" }] });
    const ext = await externalizeToolEntry(entry, blobs.put);
    expect(blobs.puts).toBe(0);
    expect(ext).toEqual(entry);
  });

  it("leaves non-tool entries untouched", async () => {
    const blobs = memBlobs();
    const agent: HistoryEntry = {
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: big } } },
      recordedAt: 0,
    };
    const ext = await externalizeToolEntry(agent, blobs.put);
    expect(ext).toBe(agent);
    expect(blobs.puts).toBe(0);
  });

  it("hydrate is a no-op for entries without refs (old inline histories)", async () => {
    const blobs = memBlobs();
    const entry = toolUpdate({ toolCallId: "t1", content: [{ type: "diff", path: "/a", oldText: big, newText: big }] });
    const back = await expandToolRefs(entry, blobs.get);
    expect(back).toBe(entry);
  });

  it("dedupes identical content to a single blob", async () => {
    const blobs = memBlobs();
    const mk = () => toolUpdate({ toolCallId: "e1", content: [{ type: "diff", path: "/a", oldText: big, newText: big }] });
    await externalizeToolEntry(mk(), blobs.put);
    await externalizeToolEntry(mk(), blobs.put);
    // Same content hashes to the same key — one unique blob.
    expect(blobs.blobs.size).toBe(1);
  });

  it("does not mutate the input entry when externalizing", async () => {
    const blobs = memBlobs();
    const entry = toolUpdate({
      toolCallId: "t1",
      content: [{ type: "diff", path: "/a", oldText: big, newText: big }],
    });
    await externalizeToolEntry(entry, blobs.put);
    const block = (entry.params as { update: { content: Array<Record<string, unknown>> } })
      .update.content[0]!;
    // original still holds the full inline text (broadcast path is safe)
    expect((block.oldText as string).length).toBe(big.length);
  });
});
