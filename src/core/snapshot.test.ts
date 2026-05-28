import { describe, it, expect } from "vitest";
import { tryParseSnapshot } from "./snapshot.js";

describe("tryParseSnapshot — strict JSON happy path", () => {
  it("parses a complete title + synopsis object", () => {
    const raw = JSON.stringify({
      title: "Add MCP plug-point",
      synopsis: {
        goal: "Let extensions register MCP servers",
        outcome: "Shipped Phase 1 with 45 new tests",
        files_touched: ["cli/src/core/extension-mcp.ts"],
        tools_used: ["Edit", "Write", "Bash"],
        rejected_approaches: ["Per-server tokens"],
        open_threads: [],
      },
    });
    const r = tryParseSnapshot(raw);
    expect(r).toBeDefined();
    expect(r!.title).toBe("Add MCP plug-point");
    expect(r!.synopsis?.goal).toBe("Let extensions register MCP servers");
    expect(r!.synopsis?.files_touched).toEqual([
      "cli/src/core/extension-mcp.ts",
    ]);
    expect(r!.synopsis?.open_threads).toEqual([]);
  });

  it("trims whitespace around the title", () => {
    const raw = JSON.stringify({
      title: "  Padded title  ",
      synopsis: { goal: "thing" },
    });
    const r = tryParseSnapshot(raw);
    expect(r!.title).toBe("Padded title");
  });
});

describe("tryParseSnapshot — preamble/postamble", () => {
  it("extracts JSON from a reply with a preamble", () => {
    const raw =
      'Sure, here is your snapshot:\n\n{"title":"hello","synopsis":{"goal":"x"}}';
    const r = tryParseSnapshot(raw);
    expect(r!.title).toBe("hello");
    expect(r!.synopsis?.goal).toBe("x");
  });

  it("extracts JSON from a reply with a postamble", () => {
    const raw =
      '{"title":"hello","synopsis":{"outcome":"shipped"}}\n\nLet me know if you need anything else.';
    const r = tryParseSnapshot(raw);
    expect(r!.title).toBe("hello");
    expect(r!.synopsis?.outcome).toBe("shipped");
  });

  it("handles ```json fenced output", () => {
    const raw =
      '```json\n{"title":"fenced","synopsis":{"goal":"fenced goal"}}\n```';
    const r = tryParseSnapshot(raw);
    expect(r!.title).toBe("fenced");
    expect(r!.synopsis?.goal).toBe("fenced goal");
  });
});

describe("tryParseSnapshot — partial parses honored", () => {
  it("returns title-only when synopsis is malformed (wrong type)", () => {
    const raw = JSON.stringify({
      title: "title-only",
      synopsis: "not-an-object",
    });
    const r = tryParseSnapshot(raw);
    expect(r!.title).toBe("title-only");
    expect(r!.synopsis).toBeUndefined();
  });

  it("returns synopsis-only when title is missing", () => {
    const raw = JSON.stringify({
      synopsis: { goal: "g", outcome: "o" },
    });
    const r = tryParseSnapshot(raw);
    expect(r!.title).toBeUndefined();
    expect(r!.synopsis?.goal).toBe("g");
  });

  it("returns synopsis-only when title is empty/whitespace", () => {
    const raw = JSON.stringify({
      title: "   ",
      synopsis: { outcome: "x" },
    });
    const r = tryParseSnapshot(raw);
    expect(r!.title).toBeUndefined();
    expect(r!.synopsis?.outcome).toBe("x");
  });

  it("drops synopsis when individual field types are wrong", () => {
    const raw = JSON.stringify({
      title: "ok",
      synopsis: { files_touched: "should-be-array" },
    });
    const r = tryParseSnapshot(raw);
    expect(r!.title).toBe("ok");
    expect(r!.synopsis).toBeUndefined();
  });

  it("drops an all-empty synopsis", () => {
    const raw = JSON.stringify({
      title: "ok",
      synopsis: {},
    });
    const r = tryParseSnapshot(raw);
    expect(r!.title).toBe("ok");
    expect(r!.synopsis).toBeUndefined();
  });

  it("drops a synopsis with only empty-string/empty-array fields", () => {
    const raw = JSON.stringify({
      title: "ok",
      synopsis: {
        goal: "",
        outcome: "",
        files_touched: [],
        tools_used: [],
      },
    });
    const r = tryParseSnapshot(raw);
    expect(r!.synopsis).toBeUndefined();
  });
});

describe("tryParseSnapshot — failures", () => {
  it("returns undefined for empty input", () => {
    expect(tryParseSnapshot("")).toBeUndefined();
    expect(tryParseSnapshot("   \n  ")).toBeUndefined();
  });

  it("returns undefined for non-JSON prose", () => {
    expect(tryParseSnapshot("Sorry, I can't summarize that.")).toBeUndefined();
  });

  it("returns undefined for malformed JSON with no extractable object", () => {
    expect(tryParseSnapshot("[1, 2, 3]")).toBeUndefined();
    expect(tryParseSnapshot("not even close")).toBeUndefined();
  });

  it("returns undefined when both title and synopsis are missing/invalid", () => {
    const raw = JSON.stringify({
      something_else: "x",
      title: 42, // wrong type
    });
    expect(tryParseSnapshot(raw)).toBeUndefined();
  });

  it("returns undefined when top-level is an array", () => {
    expect(tryParseSnapshot('[{"title":"x"}]')).toBeUndefined();
  });
});

describe("tryParseSnapshot — title clamping", () => {
  it("caps overly long titles at 200 chars", () => {
    const longTitle = "A".repeat(300);
    const raw = JSON.stringify({
      title: longTitle,
      synopsis: { goal: "x" },
    });
    const r = tryParseSnapshot(raw);
    expect(r!.title!.length).toBe(200);
    expect(r!.title).toBe("A".repeat(200));
  });
});
