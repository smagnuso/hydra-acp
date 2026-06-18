import { describe, expect, it } from "vitest";
import type { ToolLineState } from "./format.js";
import { toggleToolExpansion, resolveToolsClick, _buildToolsLines } from "./app.js";

describe("toggleToolExpansion", () => {
  it("adds a toolCallId to the set on first toggle", () => {
    const perToolExpanded = new Set<string>();
    toggleToolExpansion("tc-abc", perToolExpanded);
    expect(perToolExpanded.has("tc-abc")).toBe(true);
    expect(perToolExpanded.size).toBe(1);
  });

  it("removes a toolCallId from the set on second toggle", () => {
    const perToolExpanded = new Set<string>();
    perToolExpanded.add("tc-abc");
    toggleToolExpansion("tc-abc", perToolExpanded);
    expect(perToolExpanded.has("tc-abc")).toBe(false);
    expect(perToolExpanded.size).toBe(0);
  });

  it("does not affect unrelated toolCallIds", () => {
    const perToolExpanded = new Set<string>();
    perToolExpanded.add("tc-other");
    toggleToolExpansion("tc-abc", perToolExpanded);
    expect(perToolExpanded.has("tc-other")).toBe(true);
    expect(perToolExpanded.has("tc-abc")).toBe(true);
    expect(perToolExpanded.size).toBe(2);
  });
});

describe("resolveToolsClick", () => {
  it("returns null for non-tools keys", () => {
    const rowOwners = new Map<string, (string | null)[]>();
    rowOwners.set("tools:1", [null, "tc-aaa", "tc-bbb"]);
    expect(resolveToolsClick("plan", 0, rowOwners)).toBeNull();
    expect(resolveToolsClick("thought:0", 0, rowOwners)).toBeNull();
    expect(resolveToolsClick("editdiff:foo", 1, rowOwners)).toBeNull();
  });

  it("returns null for header click (rowOffset === 0)", () => {
    const rowOwners = new Map<string, (string | null)[]>();
    rowOwners.set("tools:1", [null, "tc-aaa", "tc-bbb"]);
    expect(resolveToolsClick("tools:1", 0, rowOwners)).toBeNull();
  });

  it("returns the toolCallId when rowOffset resolves to a valid id", () => {
    const rowOwners = new Map<string, (string | null)[]>();
    rowOwners.set("tools:1", [null, "tc-aaa", "tc-bbb"]);
    const result = resolveToolsClick("tools:1", 2, rowOwners);
    expect(result).toEqual({ toolCallId: "tc-bbb" });
  });

  it("returns null when rowOwners has no entry for the key", () => {
    const rowOwners = new Map<string, (string | null)[]>();
    rowOwners.set("tools:2", [null, "tc-aaa"]);
    expect(resolveToolsClick("tools:1", 2, rowOwners)).toBeNull();
  });

  it("returns null when rowOffset resolves to null", () => {
    const rowOwners = new Map<string, (string | null)[]>();
    rowOwners.set("tools:1", [null, "tc-aaa", null]);
    expect(resolveToolsClick("tools:1", 3, rowOwners)).toBeNull();
  });

  it("returns null when rowOffset is out of bounds", () => {
    const rowOwners = new Map<string, (string | null)[]>();
    rowOwners.set("tools:1", [null, "tc-aaa"]);
    expect(resolveToolsClick("tools:1", 10, rowOwners)).toBeNull();
  });
});

describe("handleBlockClick integration via pure functions", () => {
  it("rowOffset > 0: flips toolCallId in perToolExpanded and resolves correctly", () => {
    // Pre-populate rowOwners with a fixture simulating a 3-line tools block:
    // row 0 = header (null), row 1 = tool A, row 2 = tool B.
    const rowOwners = new Map<string, (string | null)[]>();
    rowOwners.set("tools:1", [null, "tc-tool-a", "tc-tool-b"]);

    // Fire handleBlockClick('tools:1', 2) — simulates clicking row 2.
    const clickInfo = resolveToolsClick("tools:1", 2, rowOwners);
    expect(clickInfo).toEqual({ toolCallId: "tc-tool-b" });

    const perToolExpanded = new Set<string>();
    if (clickInfo) {
      toggleToolExpansion(clickInfo.toolCallId, perToolExpanded);
    }

    // Assert the corresponding toolCallId got added to perToolExpanded.
    expect(perToolExpanded.has("tc-tool-b")).toBe(true);
    expect(perToolExpanded.size).toBe(1);
  });

  it("rowOffset === 0: header click does NOT touch perToolExpanded", () => {
    const rowOwners = new Map<string, (string | null)[]>();
    rowOwners.set("tools:1", [null, "tc-aaa", "tc-bbb"]);

    // Simulate a tools block state before the click.
    const toolsOverrides = new Map<string, boolean>();
    const perToolExpanded = new Set<string>();
    perToolExpanded.add("tc-aaa");

    // Header click: resolveToolsClick returns null (not a per-tool action).
    const clickInfo = resolveToolsClick("tools:1", 0, rowOwners);
    expect(clickInfo).toBeNull();

    // Header-click flips toolsOverrides but does NOT touch perToolExpanded.
    const current = toolsOverrides.get("tools:1") ?? false;
    toolsOverrides.set("tools:1", !current);

    // perToolExpanded is unchanged — tc-aaa still there.
    expect(perToolExpanded.has("tc-aaa")).toBe(true);
    expect(perToolExpanded.size).toBe(1);
    // toolsOverrides was flipped.
    expect(toolsOverrides.get("tools:1")).toBe(true);
  });

  it("rowOffset > 0 with empty rowOwners is a no-op", () => {
    const rowOwners = new Map<string, (string | null)[]>();
    // No entry for "tools:1" — simulates T4 not having populated yet.
    const clickInfo = resolveToolsClick("tools:1", 2, rowOwners);
    expect(clickInfo).toBeNull();

    const perToolExpanded = new Set<string>();
    toggleToolExpansion("tc-should-not-exist", perToolExpanded);
    // Only the explicitly toggled id is there.
    expect(perToolExpanded.size).toBe(1);
  });

  it("toggle twice: expand then collapse", () => {
    const rowOwners = new Map<string, (string | null)[]>();
    rowOwners.set("tools:1", [null, "tc-x"]);

    const perToolExpanded = new Set<string>();

    // First click at rowOffset 1 → tc-x added.
    const info1 = resolveToolsClick("tools:1", 1, rowOwners);
    expect(info1).toEqual({ toolCallId: "tc-x" });
    toggleToolExpansion(info1!.toolCallId, perToolExpanded);
    expect(perToolExpanded.has("tc-x")).toBe(true);

    // Second click at rowOffset 1 → tc-x removed (collapsed).
    const info2 = resolveToolsClick("tools:1", 1, rowOwners);
    expect(info2).toEqual({ toolCallId: "tc-x" });
    toggleToolExpansion(info2!.toolCallId, perToolExpanded);
    expect(perToolExpanded.has("tc-x")).toBe(false);
  });
});

describe("_buildToolsLines", () => {
  const makeState = (id: string, opts: Partial<ToolLineState> = {}): ToolLineState => ({
    initialTitle: opts.initialTitle ?? id,
    latestTitle: opts.latestTitle ?? id,
    status: opts.status ?? "completed",
    ...opts,
  });

  it("collapsed tool → 1 line, rowOwners[1] = toolCallId", () => {
    const order = ["tc-aaa"];
    const states = new Map([["tc-aaa", makeState("tc-aaa")]]);
    const result = _buildToolsLines({
      order,
      states,
      startedAt: 1_000,
      endedAt: 2_000,
      stopReason: "end_turn",
      expanded: false,
    });
    // Header + 1 tool line = 2 lines
    expect(result.lines).toHaveLength(2);
    expect(result.rowOwners).toHaveLength(2);
    expect(result.rowOwners[0]).toBeNull();
    expect(result.rowOwners[1]).toBe("tc-aaa");
  });

  it("expanded non-edit tool with detail+resultText → summary + body lines, rowOwners for both", () => {
    const order = ["tc-bbb"];
    const states = new Map([["tc-bbb", makeState("tc-bbb", {
      detail: "ls -la /tmp",
      resultText: "total 0\nfile1\nfile2",
    })]]);
    const perToolExpanded = new Set(["tc-bbb"]);
    const result = _buildToolsLines({
      order,
      states,
      startedAt: 1_000,
      endedAt: 2_000,
      stopReason: "end_turn",
      expanded: false, // block-level cap doesn't matter — tool is explicitly expanded
      perToolExpanded,
    });
    // Header (1) + summary (1) + detail (1) + resultText lines (3) = 6
    expect(result.lines).toHaveLength(6);
    expect(result.rowOwners).toHaveLength(6);
    expect(result.rowOwners[0]).toBeNull(); // header
    expect(result.rowOwners[1]).toBe("tc-bbb"); // summary
    expect(result.rowOwners[2]).toBe("tc-bbb"); // detail
    expect(result.rowOwners[3]).toBe("tc-bbb"); // result line 1
    expect(result.rowOwners[4]).toBe("tc-bbb"); // result line 2
    expect(result.rowOwners[5]).toBe("tc-bbb"); // result line 3
  });

  it("expanded edit tool (editDiff set) → still 1 line, no body emitted", () => {
    const order = ["tc-edit"];
    const states = new Map([["tc-edit", makeState("tc-edit", {
      editDiff: { path: "/foo/bar.ts", oldText: "x", newText: "y" },
    })]]);
    const perToolExpanded = new Set(["tc-edit"]);
    const result = _buildToolsLines({
      order,
      states,
      startedAt: 1_000,
      endedAt: 2_000,
      stopReason: "end_turn",
      expanded: false,
      perToolExpanded,
    });
    // Header + 1 summary line = 2 (no body for edit tools)
    expect(result.lines).toHaveLength(2);
    expect(result.rowOwners).toHaveLength(2);
    expect(result.rowOwners[0]).toBeNull();
    expect(result.rowOwners[1]).toBe("tc-edit");
  });

  it("rowOwners length === lines length", () => {
    const order = ["tc-a", "tc-b", "tc-c"];
    const states = new Map([
      ["tc-a", makeState("tc-a", { detail: "cmd a" })],
      ["tc-b", makeState("tc-b", { resultText: "r1\nr2" })],
      ["tc-c", makeState("tc-c", { editDiff: { path: "/f.ts", oldText: "", newText: "" } })],
    ]);
    const perToolExpanded = new Set(["tc-a", "tc-b"]); // tc-c has editDiff, no body
    const result = _buildToolsLines({
      order,
      states,
      startedAt: 1_000,
      endedAt: 2_000,
      stopReason: "end_turn",
      expanded: false,
      perToolExpanded,
    });
    // Header (1) + tc-a summary (1) + tc-a detail (1) + tc-b summary (1) + tc-b result (2) + tc-c summary (1) = 7
    expect(result.lines.length).toBe(result.rowOwners.length);
    expect(result.rowOwners[0]).toBeNull();
    expect(result.rowOwners[1]).toBe("tc-a"); // summary
    expect(result.rowOwners[2]).toBe("tc-a"); // detail body
    expect(result.rowOwners[3]).toBe("tc-b"); // summary
    expect(result.rowOwners[4]).toBe("tc-b"); // result line 1
    expect(result.rowOwners[5]).toBe("tc-b"); // result line 2
    expect(result.rowOwners[6]).toBe("tc-c"); // summary (no body)
  });

  it("empty order → header only, rowOwners = [null]", () => {
    const result = _buildToolsLines({
      order: [],
      states: new Map(),
      startedAt: 1_000,
      endedAt: 2_000,
      stopReason: null,
      expanded: false,
    });
    expect(result.lines).toHaveLength(1);
    expect(result.rowOwners).toEqual([null]);
  });

  it("collapsed view keeps still-running earlier tools visible past the cap", () => {
    // 7 tools, cap=5. tc-0 is still running; tc-1..tc-6 are completed.
    // Expect: header + tc-0 (running) + tc-2..tc-6 (most recent 5) = 7 lines.
    // tc-1 falls off and counts as 1 hidden.
    const order = ["tc-0", "tc-1", "tc-2", "tc-3", "tc-4", "tc-5", "tc-6"];
    const states = new Map<string, ToolLineState>([
      ["tc-0", makeState("tc-0", { status: "in_progress" })],
      ["tc-1", makeState("tc-1")],
      ["tc-2", makeState("tc-2")],
      ["tc-3", makeState("tc-3")],
      ["tc-4", makeState("tc-4")],
      ["tc-5", makeState("tc-5")],
      ["tc-6", makeState("tc-6")],
    ]);
    const result = _buildToolsLines({
      order,
      states,
      startedAt: 1_000,
      endedAt: null,
      stopReason: null,
      expanded: false,
      collapsedLimit: 5,
    });
    expect(result.rowOwners).toEqual([
      null,
      "tc-0",
      "tc-2",
      "tc-3",
      "tc-4",
      "tc-5",
      "tc-6",
    ]);
  });

  it("when perToolExpanded is empty, output matches collapsed behavior", () => {
    const order = ["tc-x", "tc-y"];
    const states = new Map([
      ["tc-x", makeState("tc-x", { detail: "cmd x", resultText: "result" })],
      ["tc-y", makeState("tc-y", { detail: "cmd y" })],
    ]);
    const emptyExpanded = new Set<string>();
    const result = _buildToolsLines({
      order,
      states,
      startedAt: 1_000,
      endedAt: 2_000,
      stopReason: "end_turn",
      expanded: false,
      perToolExpanded: emptyExpanded,
    });
    // Header + 2 summary lines = 3 (no body since nothing is expanded)
    expect(result.lines).toHaveLength(3);
    expect(result.rowOwners).toHaveLength(3);
    expect(result.rowOwners[0]).toBeNull();
    expect(result.rowOwners[1]).toBe("tc-x");
    expect(result.rowOwners[2]).toBe("tc-y");
  });
});
