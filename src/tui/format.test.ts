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

  it("renders a basic 2-column pipe table aligned by widest cell", () => {
    const lines = parseAgentMarkdown(
      "| Subscriber concern | Subscribes to |\n|---|---|\n| Queue chip rendering | prompt_queue_added |\n| Turn lifecycle | turn_complete |",
    );
    expect(lines).toHaveLength(4);
    expect(lines[0]?.bodyStyle).toBe("heading-3");
    expect(lines[0]?.body).toBe("Subscriber concern   │ Subscribes to     ");
    expect(lines[1]?.bodyStyle).toBe("dim");
    expect(lines[1]?.body).toBe("─────────────────────┼───────────────────");
    expect(lines[2]?.bodyStyle).toBe("agent");
    expect(lines[2]?.body).toBe("Queue chip rendering │ prompt_queue_added");
    expect(lines[3]?.body).toBe("Turn lifecycle       │ turn_complete     ");
  });

  it("does NOT treat a stray `a | b` in prose as a table", () => {
    const lines = parseAgentMarkdown("here is a thing: a | b in a sentence");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.bodyStyle).toBe("agent");
    expect(lines[0]?.body).toBe("here is a thing: a | b in a sentence");
  });

  it("renders mid-stream: header + separator with no body rows yet", () => {
    const lines = parseAgentMarkdown("| a | b |\n|---|---|");
    expect(lines).toHaveLength(2);
    expect(lines[0]?.bodyStyle).toBe("heading-3");
    expect(lines[0]?.body).toBe("a │ b");
    expect(lines[1]?.bodyStyle).toBe("dim");
    expect(lines[1]?.body).toBe("──┼──");
  });

  it("accepts tables without outer pipes", () => {
    const lines = parseAgentMarkdown("a | b\n---|---\nfoo | bar");
    expect(lines).toHaveLength(3);
    expect(lines[0]?.bodyStyle).toBe("heading-3");
    expect(lines[0]?.body).toBe("a   │ b  ");
    expect(lines[2]?.bodyStyle).toBe("agent");
    expect(lines[2]?.body).toBe("foo │ bar");
  });

  it("widens column to fit the widest body cell", () => {
    const lines = parseAgentMarkdown(
      "| a | b |\n|---|---|\n| short | a_much_longer_value |",
    );
    expect(lines[0]?.body).toBe("a     │ b                  ");
    expect(lines[2]?.body).toBe("short │ a_much_longer_value");
  });

  it("ignores GFM alignment markers (renders left-aligned) but accepts them as a valid separator", () => {
    const lines = parseAgentMarkdown(
      "| a | b |\n| :--- | ---: |\n| x | y |",
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]?.bodyStyle).toBe("heading-3");
    expect(lines[2]?.body).toBe("x │ y");
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
