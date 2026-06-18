import { describe, it, expect } from "vitest";
import { tryParseSnapshot, tryParseCompaction } from "./snapshot.js";

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

describe("tryParseSnapshot — compaction fields", () => {
  it("parses synopsis with new compaction fields alongside existing fields", () => {
    const raw = JSON.stringify({
      title: "Compact session",
      synopsis: {
        goal: "add compaction support",
        outcome: "merged PR",
        decisions: ["use manual trigger only"],
        file_edit_intentions: ["src/core/compact.ts"],
        unresolved_errors: ["flaky test on CI"],
        tool_state: ["server running on port 3000"],
      },
    });
    const r = tryParseSnapshot(raw);
    expect(r).toBeDefined();
    expect(r!.title).toBe("Compact session");
    expect(r!.synopsis?.goal).toBe("add compaction support");
    expect(r!.synopsis?.decisions).toEqual(["use manual trigger only"]);
    expect(r!.synopsis?.file_edit_intentions).toEqual(["src/core/compact.ts"]);
    expect(r!.synopsis?.unresolved_errors).toEqual(["flaky test on CI"]);
    expect(r!.synopsis?.tool_state).toEqual(["server running on port 3000"]);
  });

  it("registers content when synopsis has only new compaction fields", () => {
    const raw = JSON.stringify({
      title: "only compaction data",
      synopsis: {
        decisions: ["went with approach B"],
        tool_state: ["build in progress"],
      },
    });
    const r = tryParseSnapshot(raw);
    expect(r).toBeDefined();
    expect(r!.title).toBe("only compaction data");
    expect(r!.synopsis).toBeDefined();
    expect(r!.synopsis?.decisions).toEqual(["went with approach B"]);
    expect(r!.synopsis?.tool_state).toEqual(["build in progress"]);
  });

  it("drops synopsis when only new fields are present but all empty", () => {
    const raw = JSON.stringify({
      title: "ok",
      synopsis: {
        decisions: [],
        file_edit_intentions: [],
        unresolved_errors: [],
        tool_state: [],
      },
    });
    const r = tryParseSnapshot(raw);
    expect(r!.title).toBe("ok");
    expect(r!.synopsis).toBeUndefined();
  });
});

describe("tryParseCompaction — round-trip full compaction JSON", () => {
  it("parses a complete flat compaction object with all fields", () => {
    const raw = JSON.stringify({
      title: "Compact long session",
      goal: "Build a file watcher daemon",
      outcome: "Prototype working with systemd integration",
      rejected_approaches: ["inotify via native addon", "polling loop"],
      open_threads: ["add config file support", "write unit tests"],
      decisions: ["use node fs.watch instead of chokidar"],
      file_edit_intentions: ["src/core/watcher.ts", "package.json"],
      unresolved_errors: ["race condition on rapid file changes"],
      tool_state: ["daemon listening on port 8080"],
    });
    const r = tryParseCompaction(raw);
    expect(r).toBeDefined();
    expect(r!.title).toBe("Compact long session");
    expect(r!.synopsis?.goal).toBe("Build a file watcher daemon");
    expect(r!.synopsis?.outcome).toBe(
      "Prototype working with systemd integration",
    );
    expect(r!.synopsis?.rejected_approaches).toEqual([
      "inotify via native addon",
      "polling loop",
    ]);
    expect(r!.synopsis?.open_threads).toEqual([
      "add config file support",
      "write unit tests",
    ]);
    expect(r!.synopsis?.decisions).toEqual([
      "use node fs.watch instead of chokidar",
    ]);
    expect(r!.synopsis?.file_edit_intentions).toEqual([
      "src/core/watcher.ts",
      "package.json",
    ]);
    expect(r!.synopsis?.unresolved_errors).toEqual([
      "race condition on rapid file changes",
    ]);
    expect(r!.synopsis?.tool_state).toEqual(["daemon listening on port 8080"]);
  });

  it("parses compaction with only a title and one synopsis field", () => {
    const raw = JSON.stringify({
      title: "minimal compact",
      goal: "fix the build",
    });
    const r = tryParseCompaction(raw);
    expect(r).toBeDefined();
    expect(r!.title).toBe("minimal compact");
    expect(r!.synopsis?.goal).toBe("fix the build");
  });

  it("returns title-only when synopsis fields are all empty", () => {
    const raw = JSON.stringify({
      title: "just a title",
      goal: "",
      outcome: "",
      rejected_approaches: [],
      open_threads: [],
      decisions: [],
      file_edit_intentions: [],
      unresolved_errors: [],
      tool_state: [],
    });
    const r = tryParseCompaction(raw);
    expect(r!.title).toBe("just a title");
    expect(r!.synopsis).toBeUndefined();
  });
});

describe("tryParseCompaction — preamble tolerance", () => {
  it("extracts JSON from a reply with a preamble", () => {
    const raw =
      'Here is your compaction summary:\n\n{"title":"hello","goal":"x"}';
    const r = tryParseCompaction(raw);
    expect(r!.title).toBe("hello");
    expect(r!.synopsis?.goal).toBe("x");
  });

  it("extracts JSON from a reply with trailing prose", () => {
    const raw =
      '{"title":"hello","outcome":"shipped"}\n\nLet me know if you need anything else.';
    const r = tryParseCompaction(raw);
    expect(r!.title).toBe("hello");
    expect(r!.synopsis?.outcome).toBe("shipped");
  });

  it("handles ```json fenced output", () => {
    const raw =
      '```json\n{"title":"fenced","goal":"fenced goal"}\n```';
    const r = tryParseCompaction(raw);
    expect(r!.title).toBe("fenced");
    expect(r!.synopsis?.goal).toBe("fenced goal");
  });

  it("handles ``` fenced output without language tag", () => {
    const raw =
      '```\n{"title":"bare-fenced","goal":"bare goal"}\n```';
    const r = tryParseCompaction(raw);
    expect(r!.title).toBe("bare-fenced");
    expect(r!.synopsis?.goal).toBe("bare goal");
  });
});

describe("tryParseCompaction — empty content rejection", () => {
  it("returns undefined for empty input", () => {
    expect(tryParseCompaction("")).toBeUndefined();
    expect(tryParseCompaction("   \n  ")).toBeUndefined();
  });

  it("returns undefined for non-JSON prose", () => {
    expect(tryParseCompaction("Sorry, I can't summarize that.")).toBeUndefined();
  });

  it("returns undefined for malformed JSON with no extractable object", () => {
    expect(tryParseCompaction("[1, 2, 3]")).toBeUndefined();
    expect(tryParseCompaction("not even close")).toBeUndefined();
  });

  it("returns undefined when title and all fields are missing/invalid", () => {
    const raw = JSON.stringify({
      something_else: "x",
      title: 42, // wrong type
    });
    expect(tryParseCompaction(raw)).toBeUndefined();
  });

  it("returns undefined when top-level is an array", () => {
    expect(tryParseCompaction('[{"title":"x"}]')).toBeUndefined();
  });

  it("returns undefined for all-empty fields with no title", () => {
    const raw = JSON.stringify({
      goal: "",
      outcome: "",
      rejected_approaches: [],
      open_threads: [],
      decisions: [],
      file_edit_intentions: [],
      unresolved_errors: [],
      tool_state: [],
    });
    expect(tryParseCompaction(raw)).toBeUndefined();
  });
});

describe("tryParseCompaction — type validation", () => {
  it("drops array fields that are not arrays", () => {
    const raw = JSON.stringify({
      title: "ok",
      goal: "do stuff",
      decisions: "should-be-array",
      open_threads: null,
    });
    const r = tryParseCompaction(raw);
    expect(r!.title).toBe("ok");
    expect(r!.synopsis?.goal).toBe("do stuff");
    expect(r!.synopsis?.decisions).toBeUndefined();
    expect(r!.synopsis?.open_threads).toBeUndefined();
  });

  it("drops string fields that are not strings", () => {
    const raw = JSON.stringify({
      title: "ok",
      goal: 42,
      outcome: ["should-be-string"],
    });
    const r = tryParseCompaction(raw);
    expect(r!.title).toBe("ok");
    expect(r!.synopsis?.goal).toBeUndefined();
    expect(r!.synopsis?.outcome).toBeUndefined();
  });

  it("trims whitespace around string fields", () => {
    const raw = JSON.stringify({
      title: "  compacted  ",
      goal: "  do the thing  ",
    });
    const r = tryParseCompaction(raw);
    expect(r!.title).toBe("compacted");
    expect(r!.synopsis?.goal).toBe("do the thing");
  });

  it("caps title at 200 chars", () => {
    const longTitle = "A".repeat(300);
    const raw = JSON.stringify({
      title: longTitle,
      goal: "x",
    });
    const r = tryParseCompaction(raw);
    expect(r!.title!.length).toBe(200);
    expect(r!.title).toBe("A".repeat(200));
  });
});

describe("tryParseCompaction — compaction fields only", () => {
  it("parses synopsis with only new compaction fields", () => {
    const raw = JSON.stringify({
      title: "compaction-only data",
      decisions: ["went with approach B"],
      file_edit_intentions: ["src/core/compact.ts"],
      unresolved_errors: ["flaky test on CI"],
      tool_state: ["server running on port 3000"],
    });
    const r = tryParseCompaction(raw);
    expect(r).toBeDefined();
    expect(r!.title).toBe("compaction-only data");
    expect(r!.synopsis?.decisions).toEqual(["went with approach B"]);
    expect(r!.synopsis?.file_edit_intentions).toEqual([
      "src/core/compact.ts",
    ]);
    expect(r!.synopsis?.unresolved_errors).toEqual(["flaky test on CI"]);
    expect(r!.synopsis?.tool_state).toEqual(["server running on port 3000"]);
  });

  it("registers content when only new compaction fields are present", () => {
    const raw = JSON.stringify({
      title: "only compaction data",
      decisions: ["went with approach B"],
      tool_state: ["build in progress"],
    });
    const r = tryParseCompaction(raw);
    expect(r).toBeDefined();
    expect(r!.title).toBe("only compaction data");
    expect(r!.synopsis).toBeDefined();
    expect(r!.synopsis?.decisions).toEqual(["went with approach B"]);
    expect(r!.synopsis?.tool_state).toEqual(["build in progress"]);
  });

  it("drops synopsis when only new fields are present but all empty", () => {
    const raw = JSON.stringify({
      title: "ok",
      decisions: [],
      file_edit_intentions: [],
      unresolved_errors: [],
      tool_state: [],
    });
    const r = tryParseCompaction(raw);
    expect(r!.title).toBe("ok");
    expect(r!.synopsis).toBeUndefined();
  });
});

describe("tryParseSnapshot — concatenated duplicate objects (claude-acp quirk)", () => {
  it("picks the first balanced object when the agent emits {…}{…}", () => {
    const obj = JSON.stringify({
      title: "first object",
      synopsis: { goal: "the goal" },
    });
    const r = tryParseSnapshot(obj + obj);
    expect(r).toBeDefined();
    expect(r!.title).toBe("first object");
    expect(r!.synopsis?.goal).toBe("the goal");
  });

  it("tolerates braces inside string values during balanced extraction", () => {
    const obj = JSON.stringify({
      title: "has }{ in title",
      synopsis: { goal: "code: function() {} more {{}}" },
    });
    const r = tryParseSnapshot(obj + obj);
    expect(r).toBeDefined();
    expect(r!.title).toBe("has }{ in title");
    expect(r!.synopsis?.goal).toBe("code: function() {} more {{}}");
  });
});

describe("tryParseCompaction — concatenated duplicate objects", () => {
  it("picks the first balanced object when the agent emits {…}{…}", () => {
    const obj = JSON.stringify({
      title: "comp first",
      goal: "g",
      outcome: "o",
    });
    const r = tryParseCompaction(obj + obj);
    expect(r).toBeDefined();
    expect(r!.title).toBe("comp first");
    expect(r!.synopsis?.goal).toBe("g");
    expect(r!.synopsis?.outcome).toBe("o");
  });
});
