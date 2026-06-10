import { describe, expect, it } from "vitest";
import { BtwOverlayBuffer } from "./overlay-buffer.js";
import type { FormattedLine } from "../format.js";

// The buffer now stores rich FormattedLine entries so the screen can
// apply per-style painting (user bg band, tool blue, etc.). Most tests
// only care about the visible text — flatten for assertion ergonomics.
const txt = (fl: FormattedLine): string => (fl.prefix ?? "") + fl.body;
const linesOf = (buf: BtwOverlayBuffer): string[] => buf.getLines().map(txt);

describe("BtwOverlayBuffer", () => {
  describe("append — agent_message_chunk", () => {
    it("produces expected lines for a single chunk", () => {
      const buf = new BtwOverlayBuffer();
      let changedFired = false;
      buf.on("changed", () => { changedFired = true; });

      const count = buf.append({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello world" },
      });

      expect(count).toBe(1);
      expect(changedFired).toBe(true);
      expect(linesOf(buf)).toEqual(["  hello world"]);
    });

    it("handles multi-line agent text", () => {
      const buf = new BtwOverlayBuffer();
      buf.append({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "line one\nline two" },
      });
      expect(linesOf(buf)).toEqual(["  line one", "  line two"]);
    });

    it("coalesces consecutive chunks into one paragraph (no per-chunk line)", () => {
      const buf = new BtwOverlayBuffer();
      buf.append({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "first" },
      });
      buf.append({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " second" },
      });
      expect(linesOf(buf)).toEqual(["  first second"]);
    });

    it("a non-agent-text event seals the paragraph", () => {
      const buf = new BtwOverlayBuffer();
      buf.append({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "para1" },
      });
      buf.append({ sessionUpdate: "current_mode_update", currentModeId: "build" });
      buf.append({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "para2" },
      });
      const lines = linesOf(buf);
      expect(lines[0]).toBe("  para1");
      expect(lines[lines.length - 1]).toBe("  para2");
    });

    it("returns 0 for an update with no visual representation", () => {
      const buf = new BtwOverlayBuffer();
      const count = buf.append({
        sessionUpdate: "turn_complete",
      });
      expect(count).toBe(0);
    });
  });

  describe("append — tool_call + tool_call_update", () => {
    it("renders initial tool_call then updates coherently", () => {
      const buf = new BtwOverlayBuffer();

      // Initial tool call
      buf.append({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "bash",
        name: "bash",
        status: "pending",
        rawInput: { command: "ls -la" },
      });

      expect(buf.getLines()).toHaveLength(1);
      expect(linesOf(buf)[0]).toContain("bash");
      expect(linesOf(buf)[0]).toContain("◐");

      // Update with refined title and running status
      buf.append({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        title: "ls -la",
        name: "bash",
        status: "running",
        rawInput: { command: "ls -la" },
      });

      const afterUpdate = linesOf(buf);
      // tool_call_update replaces the prior rendering in place — a single
      // coherent block, not stacked duplicates.
      expect(afterUpdate).toHaveLength(1);
      expect(afterUpdate[0]).toContain("bash · ls -la");
    });

    it("renders completion status on tool_call_update", () => {
      const buf = new BtwOverlayBuffer();

      buf.append({
        sessionUpdate: "tool_call",
        toolCallId: "call_2",
        title: "Edit",
        name: "edit",
        rawInput: { file_path: "/foo.ts" },
      });

      buf.append({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_2",
        status: "completed",
        rawInput: { file_path: "/foo.ts" },
      });

      const lines = linesOf(buf);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("✓");
    });

    it("renders failure with error text", () => {
      const buf = new BtwOverlayBuffer();

      buf.append({
        sessionUpdate: "tool_call",
        toolCallId: "call_3",
        title: "Task",
        name: "task",
      });

      buf.append({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_3",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "timeout" } }],
      });

      const lines = linesOf(buf);
      // tool_call_update replaces the initial rendering: failed tool with
      // error renders as ✗ row + indented error row = 2 lines total.
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("✗");
      expect(lines[0]).toContain("Task");
      expect(lines[1]).toBe("     timeout");
    });

    it("handles multiple tool calls independently", () => {
      const buf = new BtwOverlayBuffer();

      buf.append({
        sessionUpdate: "tool_call",
        toolCallId: "a",
        title: "Tool A",
        name: "task",
      });

      buf.append({
        sessionUpdate: "tool_call",
        toolCallId: "b",
        title: "Tool B",
        name: "task",
      });

      expect(buf.getLines()).toHaveLength(2);
      expect(linesOf(buf)[0]).toContain("Tool A");
      expect(linesOf(buf)[1]).toContain("Tool B");
    });

    it("ignores tool_call_update with unknown toolCallId", () => {
      const buf = new BtwOverlayBuffer();
      const count = buf.append({
        sessionUpdate: "tool_call_update",
        toolCallId: "unknown",
        status: "completed",
      });
      expect(count).toBe(0);
    });
  });

  describe("clear", () => {
    it("resets the line buffer to empty", () => {
      const buf = new BtwOverlayBuffer();
      buf.append({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      });
      expect(linesOf(buf)).toEqual(["  hello"]);

      buf.clear();
      expect(linesOf(buf)).toEqual([]);
      expect(buf.size).toBe(0);
    });

    it("clears accumulated tool states", () => {
      const buf = new BtwOverlayBuffer();
      buf.append({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "bash",
        name: "bash",
      });
      expect(buf.getLines()).toHaveLength(1);

      buf.clear();
      // A subsequent update should not find the old state
      buf.append({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
      });
      expect(linesOf(buf)).toEqual([]);
    });

    it("emits changed when clearing non-empty buffer", () => {
      const buf = new BtwOverlayBuffer();
      buf.append({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "x" },
      });
      let cleared = false;
      buf.on("changed", () => { cleared = true; });
      buf.clear();
      expect(cleared).toBe(true);
    });

    it("does not emit changed when clearing already-empty buffer", () => {
      const buf = new BtwOverlayBuffer();
      let emitted = false;
      buf.on("changed", () => { emitted = true; });
      buf.clear();
      expect(emitted).toBe(false);
    });
  });

  describe("changed event", () => {
    it("fires when lines are appended", () => {
      const buf = new BtwOverlayBuffer();
      const events: number[] = [];
      buf.on("changed", () => { events.push(buf.size); });

      buf.append({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "a\nb" },
      });

      expect(events).toEqual([2]);
    });

    it("fires after each append even when chunks coalesce", () => {
      const buf = new BtwOverlayBuffer();
      const events: number[] = [];
      buf.on("changed", () => { events.push(buf.size); });

      buf.append({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "x" },
      });
      buf.append({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "y" },
      });

      // Both chunks coalesce into one line, so size stays at 1 — but the
      // event must still fire on each append so consumers re-render.
      expect(events).toEqual([1, 1]);
    });

    it("does not fire when appending an update that produces no lines", () => {
      const buf = new BtwOverlayBuffer();
      let fired = false;
      buf.on("changed", () => { fired = true; });

      buf.append({ sessionUpdate: "turn_complete" });
      expect(fired).toBe(false);
    });

    it("can be disabled via options", () => {
      const buf = new BtwOverlayBuffer({ emitChanged: false });
      let fired = false;
      buf.on("changed", () => { fired = true; });

      buf.append({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "x" },
      });
      expect(fired).toBe(false);
    });
  });

  describe("size accessor", () => {
    it("reflects the current number of lines", () => {
      const buf = new BtwOverlayBuffer();
      expect(buf.size).toBe(0);
      buf.append({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "a" },
      });
      expect(buf.size).toBe(1);
      buf.append({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "b\nc" },
      });
      // Coalesced: "a" + "b\nc" → "ab\nc" → 2 lines after split.
      expect(buf.size).toBe(2);
    });

    it("resets to zero after clear", () => {
      const buf = new BtwOverlayBuffer();
      buf.append({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "x" },
      });
      buf.clear();
      expect(buf.size).toBe(0);
    });
  });

  describe("getLines returns a snapshot", () => {
    it("returned array is independent of the buffer's internal state", () => {
      const buf = new BtwOverlayBuffer();
      buf.append({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      });
      const snapshot = buf.getLines();
      buf.clear();
      // Snapshot should still hold the old data
      expect(snapshot.map(txt)).toEqual(["  hello"]);
    });
  });
});
