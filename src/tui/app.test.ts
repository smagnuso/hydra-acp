import { describe, expect, it } from "vitest";
import { toggleToolExpansion, resolveToolsClick } from "./app.js";

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
