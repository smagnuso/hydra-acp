import { describe, expect, it } from "vitest";
import { formatEvent, parseAgentMarkdown } from "./format.js";

const ESC = "";

describe("parseAgentMarkdown", () => {
  it("renders prose lines with agent style and no ansi flag", () => {
    const lines = parseAgentMarkdown("hello world\nhow are you");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      body: "hello world",
      bodyStyle: "agent",
    });
    expect(lines[0]?.ansi).toBeUndefined();
  });

  it("renders an unlabeled code fence as plain code, no ansi flag", () => {
    const lines = parseAgentMarkdown("```\nplain code\nmore code\n```");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.bodyStyle).toBe("code");
      expect(line.fillRow).toBe(true);
      expect(line.ansi).toBeUndefined();
      expect(line.body).not.toContain(ESC);
    }
    expect(lines[0]?.body).toBe("plain code");
    expect(lines[1]?.body).toBe("more code");
  });

  it("highlights a ```diff block — +/- lines carry ANSI", () => {
    const lines = parseAgentMarkdown(
      "```diff\n- old line\n+ new line\n@@ -1,1 +1,1 @@\n```",
    );
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.bodyStyle).toBe("code");
    }
    // - old line: deletion (red)
    expect(lines[0]?.ansi).toBe(true);
    expect(lines[0]?.body).toContain(ESC);
    // + new line: addition (green)
    expect(lines[1]?.ansi).toBe(true);
    expect(lines[1]?.body).toContain(ESC);
    // @@ ... @@ hunk header: meta (magenta)
    expect(lines[2]?.ansi).toBe(true);
    expect(lines[2]?.body).toContain(ESC);
  });

  it("highlights ```javascript blocks with ANSI", () => {
    const lines = parseAgentMarkdown("```javascript\nconst x = 1;\n```");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.ansi).toBe(true);
    expect(lines[0]?.body).toContain(ESC);
  });

  it("highlights ```typescript blocks — lines with recognized tokens carry ANSI", () => {
    const lines = parseAgentMarkdown(
      "```typescript\nfunction foo(x: number) {\n  return x + 1;\n}\n```",
    );
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.bodyStyle).toBe("code");
    }
    // At least one line must have been highlighted to prove the
    // highlighter ran. Lines with no recognized tokens (a bare `}`)
    // can legitimately come back unchanged — that's intentional.
    expect(lines.some((l) => l.ansi === true)).toBe(true);
    expect(lines.some((l) => l.body.includes(ESC))).toBe(true);
  });

  it("highlights ```cpp blocks — lines with recognized tokens carry ANSI", () => {
    const lines = parseAgentMarkdown(
      "```cpp\n#include <iostream>\nint main() { return 0; }\n```",
    );
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.ansi === true)).toBe(true);
    expect(lines.some((l) => l.body.includes(ESC))).toBe(true);
  });

  it("falls back to plain code for unknown language tag", () => {
    const lines = parseAgentMarkdown(
      "```nonsensenotalang\nsome text\nmore text\n```",
    );
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.bodyStyle).toBe("code");
      expect(line.ansi).toBeUndefined();
      expect(line.body).not.toContain(ESC);
    }
  });

  it("emits highlighted lines mid-stream when the closing fence hasn't arrived", () => {
    // Simulates a chunk that opens a fence and emits content but hasn't
    // closed yet — parseAgentMarkdown is re-run on every chunk against
    // the full accumulated buffer, so the in-progress code must still
    // render as code (and be highlighted when a known lang is present).
    const lines = parseAgentMarkdown("```diff\n- old\n+ new");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.bodyStyle).toBe("code");
      expect(line.ansi).toBe(true);
    }
  });

  it("does not apply ansi to interleaved prose, only to code-block lines", () => {
    const lines = parseAgentMarkdown(
      "prose line\n```diff\n- old\n```\nmore prose",
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ body: "prose line", bodyStyle: "agent" });
    expect(lines[0]?.ansi).toBeUndefined();
    expect(lines[1]?.bodyStyle).toBe("code");
    expect(lines[1]?.ansi).toBe(true);
    expect(lines[2]).toMatchObject({
      body: "more prose",
      bodyStyle: "agent",
    });
    expect(lines[2]?.ansi).toBeUndefined();
  });
});

describe("formatEvent — user-text with attachments", () => {
  it("appends one thumbnail line per attachment after the text body", () => {
    const lines = formatEvent({
      kind: "user-text",
      text: "look at this",
      attachments: [
        { mimeType: "image/png", data: "AAAA", name: "a.png", sizeBytes: 3 },
        { mimeType: "image/jpeg", data: "BBBB", name: "b.jpg", sizeBytes: 5 },
      ],
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]?.body).toBe("look at this");
    expect(lines[1]?.body).toBe("📎 a.png");
    expect(lines[1]?.iterm2Image).toEqual({ data: "AAAA", heightCells: 5 });
    expect(lines[2]?.body).toBe("📎 b.jpg");
    expect(lines[2]?.iterm2Image).toEqual({ data: "BBBB", heightCells: 5 });
  });

  it("emits the text body unchanged when there are no attachments", () => {
    const lines = formatEvent({ kind: "user-text", text: "plain" });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.body).toBe("plain");
    expect(lines[0]?.iterm2Image).toBeUndefined();
  });
});
