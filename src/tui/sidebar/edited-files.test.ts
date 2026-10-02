import { describe, expect, it } from "vitest";
import {
  collapseEditedFiles,
  editedFileFromTool,
  editedFilesFromTool,
  isFileMutatingTool,
} from "./edited-files.js";
import type { SidebarEditedFile } from "./types.js";
import type { ToolLineState } from "../format.js";
import type { EditDiff } from "../../core/render-update.js";
import * as path from "node:path";

// "/repo" is not an absolute path on Windows, where path.join/resolve
// against it yields D:\repo\... The code under test is right: it joins
// git's forward-slash output onto a real repo root, and a native
// separator is what you need in order to open the file afterwards. So
// build the fixtures the way the platform spells them.
const REPO = path.resolve(path.sep, "repo");
const at = (...segments: string[]): string => path.join(REPO, ...segments);


const state = (patch: Partial<ToolLineState> = {}): ToolLineState => ({
  initialTitle: "tool",
  latestTitle: "tool",
  status: "completed",
  ...patch,
});

const diff = (path: string, oldText: string, newText: string): EditDiff => ({
  path,
  oldText,
  newText,
});

// Mirrors what app.ts does: fold each tool call into a per-id map, then
// collapse by path at render time.
const collect = (
  entries: Array<[string, ToolLineState, EditDiff?]>,
  cwd: string | null = REPO,
): SidebarEditedFile[] => {
  const byTool = new Map<string, SidebarEditedFile>();
  for (const [id, state, diff] of entries) {
    const entry = editedFileFromTool(state, diff, cwd);
    if (entry !== null) {
      byTool.set(id, entry);
    }
  }
  return collapseEditedFiles(byTool.values());
};

describe("isFileMutatingTool", () => {
  it("accepts a call carrying a diff regardless of kind", () => {
    expect(
      isFileMutatingTool({ rawKind: "execute" }, diff("a.ts", "x", "y")),
    ).toBe(true);
    expect(isFileMutatingTool({}, diff("a.ts", "x", "y"))).toBe(true);
  });

  it("accepts edit, delete and move kinds", () => {
    for (const rawKind of ["edit", "delete", "move"]) {
      expect(isFileMutatingTool({ rawKind }, undefined)).toBe(true);
    }
  });

  // The reported bug: a bash call run from the repo root reports the
  // directory in locations[], and the gadget listed "cli" as an edit.
  it("rejects execute, read, search and friends", () => {
    for (const rawKind of [
      "execute",
      "read",
      "search",
      "think",
      "fetch",
      "other",
    ]) {
      expect(isFileMutatingTool({ rawKind }, undefined)).toBe(false);
    }
  });

  it("rejects a call with no kind and no diff", () => {
    expect(isFileMutatingTool({}, undefined)).toBe(false);
  });
});

describe("editedFileFromTool + collapseEditedFiles", () => {
  it("excludes an execute call that reported a directory", () => {
    expect(
      collect([
        [
          "t1",
          state({ rawKind: "execute", locations: [{ path: at("cli") }] }),
        ],
      ]),
    ).toEqual([]);
  });

  it("includes an edit call that only reported locations", () => {
    expect(
      collect([
        ["t1", state({ rawKind: "edit", locations: [{ path: "src/a.ts" }] })],
      ]),
    ).toEqual([{ path: at("src", "a.ts"), added: undefined, removed: undefined }]);
  });

  it("prefers the diff path over locations", () => {
    const files = collect([
      [
        "t1",
        state({ rawKind: "edit", locations: [{ path: "wrong.ts" }] }),
        diff("src/right.ts", "a\n", "b\n"),
      ],
    ]);
    expect(files[0]!.path).toBe(at("src", "right.ts"));
  });

  it("counts added and removed lines from the diff", () => {
    const files = collect([
      ["t1", state({ rawKind: "edit" }), diff("a.ts", "one\ntwo\n", "one\n2\n3\n")],
    ]);
    expect(files[0]!.added).toBe(2);
    expect(files[0]!.removed).toBe(1);
  });

  it("sums repeated edits to one file into a single row", () => {
    const files = collect([
      ["t1", state({ rawKind: "edit" }), diff("a.ts", "x\n", "y\n")],
      ["t2", state({ rawKind: "edit" }), diff("a.ts", "y\n", "z\n")],
    ]);
    expect(files).toHaveLength(1);
    expect(files[0]!.added).toBe(2);
    expect(files[0]!.removed).toBe(2);
  });

  it("leaves counts undefined for an edit with no diff payload", () => {
    const files = collect([
      ["t1", state({ rawKind: "edit", locations: [{ path: "a.ts" }] })],
    ]);
    expect(files[0]!.added).toBeUndefined();
    expect(files[0]!.removed).toBeUndefined();
  });

  it("skips in-flight and failed calls", () => {
    expect(
      collect([
        [
          "t1",
          state({ rawKind: "edit", status: "in_progress", locations: [{ path: "a.ts" }] }),
        ],
        [
          "t2",
          state({ rawKind: "edit", status: "failed", locations: [{ path: "b.ts" }] }),
        ],
      ]),
    ).toEqual([]);
  });

  // Ordered by LAST touch. The gadget reverses this list and pagination can
  // squeeze it to a single row, so the ordering decides which file survives
  // — and that should be whatever is being edited now. b.ts is touched
  // first and last here, so it belongs at the end.
  it("orders by last touch, not first", () => {
    const files = collect([
      ["t1", state({ rawKind: "edit", locations: [{ path: "b.ts" }] })],
      ["t2", state({ rawKind: "edit", locations: [{ path: "a.ts" }] })],
      ["t3", state({ rawKind: "edit", locations: [{ path: "b.ts" }] })],
    ]);
    expect(files.map((f) => f.path)).toEqual([at("a.ts"), at("b.ts")]);
  });

  it("leaves paths untouched when there is no cwd", () => {
    const files = collect(
      [["t1", state({ rawKind: "edit", locations: [{ path: "rel/a.ts" }] })]],
      null,
    );
    expect(files[0]!.path).toBe("rel/a.ts");
  });

  it("ignores an empty or missing path", () => {
    expect(
      collect([
        ["t1", state({ rawKind: "edit", locations: [{ path: "" }] })],
        ["t2", state({ rawKind: "edit" })],
      ]),
    ).toEqual([]);
  });
});

// The bug this accumulator exists to fix: app.ts's toolStates/toolCallOrder
// are per-turn (cleared on turn-complete and on each new prompt), so
// deriving the gadget from them showed only the current turn and emptied
// out the instant a turn finished. The caller keeps one entry per tool call
// for the life of the session; these tests pin the properties that makes
// safe.
describe("session-scoped accumulation", () => {
  it("keeps files from turns whose tool state is long gone", () => {
    const byTool = new Map<string, SidebarEditedFile>();
    // Turn 1.
    byTool.set(
      "t1",
      editedFileFromTool(state({ rawKind: "edit" }), diff("a.ts", "x\n", "y\n"), REPO)!,
    );
    // ... turn boundary wipes toolStates here; the map survives ...
    // Turn 2.
    byTool.set(
      "t2",
      editedFileFromTool(state({ rawKind: "edit" }), diff("b.ts", "x\n", "y\n"), REPO)!,
    );
    expect(collapseEditedFiles(byTool.values()).map((f) => f.path)).toEqual([
      at("a.ts"),
      at("b.ts"),
    ]);
  });

  // A deferred `toolContent: "references"` diff resolves well after the
  // call completed, so the same id gets folded twice.
  it("does not double-count when a late diff upgrades an entry", () => {
    const byTool = new Map<string, SidebarEditedFile>();
    const s = state({ rawKind: "edit", locations: [{ path: "a.ts" }] });
    // First fold: completed, no diff yet — counts unknown.
    byTool.set("t1", editedFileFromTool(s, undefined, REPO)!);
    expect(collapseEditedFiles(byTool.values())[0]!.added).toBeUndefined();
    // Second fold: the diff arrived.
    byTool.set("t1", editedFileFromTool(s, diff("a.ts", "x\n", "y\nz\n"), REPO)!);
    const files = collapseEditedFiles(byTool.values());
    expect(files).toHaveLength(1);
    expect(files[0]!.added).toBe(2);
    expect(files[0]!.removed).toBe(1);
  });

  it("sums distinct calls to the same file but not repeats of one call", () => {
    const byTool = new Map<string, SidebarEditedFile>();
    const d = diff("a.ts", "x\n", "y\n");
    byTool.set("t1", editedFileFromTool(state({ rawKind: "edit" }), d, REPO)!);
    byTool.set("t1", editedFileFromTool(state({ rawKind: "edit" }), d, REPO)!);
    byTool.set("t2", editedFileFromTool(state({ rawKind: "edit" }), d, REPO)!);
    const files = collapseEditedFiles(byTool.values());
    expect(files).toHaveLength(1);
    expect(files[0]!.added).toBe(2);
  });

  it("collapse does not mutate the entries handed to it", () => {
    const entry: SidebarEditedFile = { path: at("a.ts"), added: 1, removed: 1 };
    collapseEditedFiles([entry, { path: at("a.ts"), added: 2, removed: 2 }]);
    expect(entry).toEqual({ path: at("a.ts"), added: 1, removed: 1 });
  });
});

// Agents name the file piecemeal: the initial tool_call carries no path at
// all (empty rawInput, empty locations[]) and a follow-up update supplies
// it — the invariant history-aggregate.ts:122 calls out. Two consequences
// for the caller, both of which were bugs:
//
//   1. Folding only on the transition into a terminal status meant a
//      write-style call, whose only path source is that later locations[]
//      and which carries no diff, never contributed a row at all.
//   2. Looking the state up by id inside the fold missed any call whose
//      FIRST event already carries a terminal status (what an incremental
//      reattach replay delivers for a call that started before the
//      disconnect), because the caller inserts into its map afterwards.
describe("paths that arrive on a later update", () => {
  // Mirrors recordToolCall's documented merge rules.
  const merge = (
    st: ToolLineState,
    ev: { rawKind?: string; status?: string; locations?: Array<{ path: string }> },
  ): ToolLineState => {
    if (ev.rawKind !== undefined && st.rawKind === undefined) {
      st.rawKind = ev.rawKind;
    }
    if (ev.locations !== undefined && ev.locations.length > 0) {
      st.locations = ev.locations;
    }
    if (ev.status !== undefined) {
      st.status = ev.status;
    }
    return st;
  };

  it("records a write-style call whose path only arrives mid-flight", () => {
    const byTool = new Map<string, SidebarEditedFile>();
    const st: ToolLineState = {
      initialTitle: "write",
      latestTitle: "write",
      status: "pending",
    };
    const fold = (): void => {
      const entry = editedFileFromTool(st, undefined, REPO);
      if (entry === null) {
        byTool.delete("t1");
      } else {
        byTool.set("t1", entry);
      }
    };
    // tool_call: kind known, no path yet.
    merge(st, { rawKind: "edit", status: "pending", locations: [] });
    fold();
    expect(byTool.size).toBe(0);
    // tool_call_update: the path appears, still running.
    merge(st, { status: "in_progress", locations: [{ path: "src/a.ts" }] });
    fold();
    expect(byTool.size).toBe(0);
    // tool_call_update: completed, and carries NO locations of its own.
    merge(st, { status: "completed" });
    fold();
    expect([...byTool.values()].map((f) => f.path)).toEqual([at("src", "a.ts")]);
  });

  it("records a call whose first event is already completed", () => {
    const st = merge(
      { initialTitle: "write", latestTitle: "write", status: "pending" },
      {
        rawKind: "edit",
        status: "completed",
        locations: [{ path: "src/a.ts" }],
      },
    );
    expect(editedFileFromTool(st, undefined, REPO)).toEqual({
      path: at("src", "a.ts"),
      added: undefined,
      removed: undefined,
    });
  });

  it("keeps the path once seen, even though later updates omit locations", () => {
    const st: ToolLineState = {
      initialTitle: "edit",
      latestTitle: "edit",
      status: "pending",
    };
    merge(st, { rawKind: "edit", locations: [{ path: "src/a.ts" }] });
    // A later update with locations: [] must not clear it.
    merge(st, { status: "completed", locations: [] });
    expect(editedFileFromTool(st, undefined, REPO)!.path).toBe(at("src", "a.ts"));
  });
});

describe("editedFilesFromTool", () => {
  it("expands a multi-file patch into one entry per file", () => {
    const entries = editedFilesFromTool(
      state({
        rawKind: "edit",
        patchedFiles: [
          { path: at("a.ts"), added: 3, removed: 1 },
          { path: "b.ts", added: 2, removed: 0 },
        ],
      }),
      undefined,
      REPO,
    );
    expect(entries).toEqual([
      { path: at("a.ts"), added: 3, removed: 1 },
      { path: at("b.ts"), added: 2, removed: 0 },
    ]);
  });

  it("ignores patched files until the call completes", () => {
    expect(
      editedFilesFromTool(
        state({
          rawKind: "edit",
          status: "in_progress",
          patchedFiles: [{ path: "a.ts" }],
        }),
        undefined,
        REPO,
      ),
    ).toEqual([]);
  });

  it("falls back to the single-file rules", () => {
    expect(
      editedFilesFromTool(
        state({ rawKind: "edit", locations: [{ path: "a.ts" }] }),
        undefined,
        REPO,
      ),
    ).toEqual([{ path: at("a.ts"), added: undefined, removed: undefined }]);
  });
});
