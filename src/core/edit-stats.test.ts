import { describe, expect, it } from "vitest";
import { computeEditStats, readEditStats, withEditStats } from "./edit-stats.js";

describe("computeEditStats", () => {
  it("counts each edit shape by its changed lines", () => {
    expect(computeEditStats({ rawInput: { file_path: "/e", old_string: "a\nb\n", new_string: "a\nc\nd\n" } })).toEqual([
      { path: "/e", added: 2, removed: 1 },
    ]);
    expect(computeEditStats({ rawInput: { path: "/w", content: "x\ny\n" } })).toEqual([{ path: "/w", added: 2, removed: 0 }]);
    expect(
      computeEditStats({
        rawOutput: { metadata: { files: [{ filePath: "/p", patch: "--- a\n+++ b\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n+more\n" }] } },
      }),
    ).toEqual([{ path: "/p", added: 2, removed: 1 }]);
  });

  it("leaves out an edit whose text is only a blob ref", () => {
    expect(
      computeEditStats({ content: [{ type: "diff", path: "/d", oldText: "a", newText: { __hydraBlob: "h", bytes: 9000 } }] }),
    ).toEqual([]);
  });
});

describe("withEditStats", () => {
  it("stamps a tool call's counts beside its other hydra-acp meta", () => {
    const envelope = {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        rawInput: { path: "/w", content: "x\n" },
        _meta: { other: 1, "hydra-acp": { kept: true } },
      },
    };
    const stamped = withEditStats(envelope);
    expect(stamped.update._meta).toEqual({
      other: 1,
      "hydra-acp": { kept: true, editStats: [{ path: "/w", added: 1, removed: 0 }] },
    });
    expect(readEditStats(stamped.update)).toEqual([{ path: "/w", added: 1, removed: 0 }]);
  });

  it("passes through updates that are not edits", () => {
    const chunk = { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } };
    expect(withEditStats(chunk)).toBe(chunk);
    const read = { update: { sessionUpdate: "tool_call", rawInput: { command: "ls" } } };
    expect(withEditStats(read)).toBe(read);
    expect(readEditStats(read.update)).toBeUndefined();
  });
});
