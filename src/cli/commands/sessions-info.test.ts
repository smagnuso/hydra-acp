import { describe, it, expect } from "vitest";
import type { Bundle } from "../../core/bundle.js";
import { aggregate } from "./sessions-info.js";

function toolCallEntry(
  name: string,
  rawInput: Record<string, unknown> = {},
  opts: { locations?: Array<{ path: string }>; at?: number } = {},
) {
  return {
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `tc-${Math.random().toString(36).slice(2, 8)}`,
        name,
        title: name,
        rawInput,
        ...(opts.locations ? { locations: opts.locations } : {}),
      },
    },
    recordedAt: opts.at ?? Date.now(),
  };
}

function promptReceivedEntry(at = Date.now()) {
  return {
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "prompt_received",
        prompt: [{ type: "text", text: "hello" }],
      },
    },
    recordedAt: at,
  };
}

function makeBundle(opts: {
  history?: unknown[];
  title?: string;
  synopsis?: unknown;
  summarizedThroughEntry?: number;
  agentId?: string;
  currentModel?: string;
  currentUsage?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
} = {}): Bundle {
  return {
    version: 1 as const,
    exportedAt: "2026-05-27T12:00:00Z",
    exportedFrom: { hydraVersion: "0.1.0", machine: "test" },
    session: {
      sessionId: "hydra_session_ABC",
      lineageId: "hydra_lineage_X",
      upstreamSessionId: "u_test",
      agentId: opts.agentId ?? "claude-acp",
      cwd: "/work",
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.synopsis !== undefined ? { synopsis: opts.synopsis as never } : {}),
      ...(opts.summarizedThroughEntry !== undefined
        ? { summarizedThroughEntry: opts.summarizedThroughEntry }
        : {}),
      ...(opts.currentModel !== undefined
        ? { currentModel: opts.currentModel }
        : {}),
      ...(opts.currentUsage !== undefined
        ? { currentUsage: opts.currentUsage as never }
        : {}),
      createdAt: opts.createdAt ?? "2026-05-27T10:00:00Z",
      updatedAt: opts.updatedAt ?? "2026-05-27T12:00:00Z",
    },
    history: (opts.history ?? []) as never,
  };
}

describe("aggregate — bare bundle", () => {
  it("returns sane defaults for an empty session", () => {
    const d = aggregate(makeBundle(), "cold");
    expect(d.sessionId).toBe("hydra_session_ABC");
    expect(d.agentId).toBe("claude-acp");
    expect(d.turns).toBe(0);
    expect(d.tools).toEqual([]);
    expect(d.files).toEqual([]);
    expect(d.synopsis).toBeNull();
    expect(d.historyEntries).toBe(0);
    expect(d.cost.amount).toBeNull();
    expect(d.cost.cumulative).toBeNull();
  });

  it("propagates title, model, status, synopsis, summarizedThroughEntry", () => {
    const d = aggregate(
      makeBundle({
        title: "Wire reminder MCP",
        currentModel: "claude-opus-4-7",
        synopsis: {
          goal: "ship reminder v0.1",
          outcome: "shipped",
          files_touched: ["src/index.ts"],
        },
        summarizedThroughEntry: 42,
      }),
      "live",
    );
    expect(d.title).toBe("Wire reminder MCP");
    expect(d.currentModel).toBe("claude-opus-4-7");
    expect(d.status).toBe("live");
    expect(d.synopsis).not.toBeNull();
    expect(d.synopsis!.goal).toBe("ship reminder v0.1");
    expect(d.summarizedThroughEntry).toBe(42);
  });
});

describe("aggregate — turns + tools", () => {
  it("counts prompt_received entries as turns", () => {
    const d = aggregate(
      makeBundle({
        history: [
          promptReceivedEntry(1),
          toolCallEntry("Read", { file_path: "a.ts" }, { at: 2 }),
          promptReceivedEntry(3),
          toolCallEntry("Bash", { command: "ls" }, { at: 4 }),
          promptReceivedEntry(5),
        ],
      }),
      "cold",
    );
    expect(d.turns).toBe(3);
  });

  it("builds the tool histogram sorted by count desc, ties alphabetical", () => {
    const d = aggregate(
      makeBundle({
        history: [
          toolCallEntry("Edit", { file_path: "a.ts" }),
          toolCallEntry("Edit", { file_path: "b.ts" }),
          toolCallEntry("Edit", { file_path: "c.ts" }),
          toolCallEntry("Read", { file_path: "a.ts" }),
          toolCallEntry("Read", { file_path: "b.ts" }),
          toolCallEntry("Bash", { command: "ls" }),
          toolCallEntry("Bash", { command: "pwd" }),
        ],
      }),
      "cold",
    );
    expect(d.tools).toEqual([
      { name: "Edit", count: 3 },
      { name: "Bash", count: 2 },
      { name: "Read", count: 2 },
    ]);
  });

  it("falls back to (unnamed) when a tool_call has no name and no title", () => {
    const d = aggregate(
      makeBundle({
        history: [
          {
            method: "session/update",
            params: { update: { sessionUpdate: "tool_call", rawInput: {} } },
            recordedAt: 1,
          },
        ],
      }),
      "cold",
    );
    expect(d.tools).toEqual([{ name: "(unnamed)", count: 1 }]);
  });

  it("uses title when name is missing (claude-acp shape)", () => {
    const d = aggregate(
      makeBundle({
        history: [
          {
            method: "session/update",
            params: {
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "tc1",
                title: "Read",
                rawInput: { file_path: "src/foo.ts" },
              },
            },
            recordedAt: 1,
          },
        ],
      }),
      "cold",
    );
    expect(d.tools).toEqual([{ name: "Read", count: 1 }]);
    expect(d.files[0]!.byTool).toEqual([{ name: "Read", count: 1 }]);
  });

  it("prefers name over title when both are present", () => {
    const d = aggregate(
      makeBundle({
        history: [
          {
            method: "session/update",
            params: {
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "tc1",
                name: "spec-name",
                title: "agent-title",
                rawInput: {},
              },
            },
            recordedAt: 1,
          },
        ],
      }),
      "cold",
    );
    expect(d.tools).toEqual([{ name: "spec-name", count: 1 }]);
  });
});

describe("aggregate — files touched", () => {
  it("extracts file_path from Edit/Read/Write inputs", () => {
    const d = aggregate(
      makeBundle({
        history: [
          toolCallEntry("Read", { file_path: "src/a.ts" }),
          toolCallEntry("Edit", { file_path: "src/a.ts" }),
          toolCallEntry("Edit", { file_path: "src/a.ts" }),
          toolCallEntry("Write", { file_path: "src/b.ts" }),
        ],
      }),
      "cold",
    );
    expect(d.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(d.files[0]!.count).toBe(3);
    expect(d.files[0]!.byTool).toEqual([
      { name: "Edit", count: 2 },
      { name: "Read", count: 1 },
    ]);
    expect(d.files[1]!.count).toBe(1);
  });

  it("falls back to `path` when `file_path` is absent (Glob-style)", () => {
    const d = aggregate(
      makeBundle({
        history: [toolCallEntry("Glob", { path: "src/**/*.ts" })],
      }),
      "cold",
    );
    expect(d.files[0]!.path).toBe("src/**/*.ts");
  });

  it("extracts paths from rawInput.edits array (MultiEdit-style)", () => {
    const d = aggregate(
      makeBundle({
        history: [
          toolCallEntry("MultiEdit", {
            edits: [
              { file_path: "src/a.ts", old: "x", new: "y" },
              { file_path: "src/b.ts", old: "p", new: "q" },
            ],
          }),
        ],
      }),
      "cold",
    );
    expect(d.files.map((f) => f.path).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("extracts paths from the locations[] sidecar", () => {
    const d = aggregate(
      makeBundle({
        history: [
          toolCallEntry(
            "Grep",
            { pattern: "TODO" },
            { locations: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
          ),
        ],
      }),
      "cold",
    );
    expect(d.files.map((f) => f.path).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("ignores tools with no extractable file path (pure Bash)", () => {
    const d = aggregate(
      makeBundle({
        history: [toolCallEntry("Bash", { command: "echo hi" })],
      }),
      "cold",
    );
    expect(d.files).toEqual([]);
    expect(d.tools).toEqual([{ name: "Bash", count: 1 }]);
  });
});

describe("aggregate — cost + duration", () => {
  it("propagates costAmount / cumulative / tokens from currentUsage", () => {
    const d = aggregate(
      makeBundle({
        currentUsage: {
          used: 12000,
          size: 4500,
          costAmount: 0.13,
          costCurrency: "USD",
          cumulativeCost: 0.42,
        },
      }),
      "cold",
    );
    expect(d.cost.amount).toBe(0.13);
    expect(d.cost.cumulative).toBe(0.42);
    expect(d.cost.currency).toBe("USD");
    expect(d.cost.inputTokens).toBe(12000);
    expect(d.cost.outputTokens).toBe(4500);
  });

  it("computes duration from createdAt → updatedAt", () => {
    const d = aggregate(
      makeBundle({
        createdAt: "2026-05-27T10:00:00Z",
        updatedAt: "2026-05-27T12:30:00Z",
      }),
      "cold",
    );
    expect(d.duration.totalMs).toBe(2.5 * 60 * 60 * 1000);
  });

  it("handles malformed timestamps gracefully (null duration)", () => {
    const d = aggregate(
      makeBundle({
        createdAt: "not a date",
        updatedAt: "also not",
      }),
      "cold",
    );
    expect(d.duration.totalMs).toBeNull();
  });
});

describe("aggregate — historyEntries count", () => {
  it("reports the raw history length regardless of entry kind", () => {
    const d = aggregate(
      makeBundle({
        history: [
          promptReceivedEntry(1),
          toolCallEntry("Read", { file_path: "a.ts" }, { at: 2 }),
          {
            method: "session/update",
            params: { update: { sessionUpdate: "agent_message_chunk" } },
            recordedAt: 3,
          },
        ],
      }),
      "cold",
    );
    expect(d.historyEntries).toBe(3);
  });
});
