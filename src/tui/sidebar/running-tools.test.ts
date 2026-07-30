import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { toolsGadget } from "./gadgets.js";
import { DEFAULT_GADGET_IDS } from "./registry.js";
import {
  RUNNING_TOOL_CAP,
  dedupeDetail,
  isGenericToolName,
  isRunningStatus,
  oneLine,
  pathHint,
  runningToolFromState,
  runningTools,
  runningVerb,
} from "./running-tools.js";
import { emptySnapshot } from "./types.js";
import type { SidebarContext, SidebarRunningTool, SidebarSnapshot } from "./types.js";

const ctx = (width = 24): SidebarContext => ({
  width,
  border: "none",
  metrics: {
    cellWidth: (s) => stringWidth(s),
    truncate: (s, max) => {
      let out = "";
      for (const ch of s) {
        if (stringWidth(out + ch) > max) {
          break;
        }
        out += ch;
      }
      return out;
    },
  },
});

const snap = (patch: Partial<SidebarSnapshot> = {}): SidebarSnapshot => ({
  ...emptySnapshot(10_000),
  ...patch,
});

const state = (patch: Record<string, unknown> = {}) =>
  ({
    rawKind: "execute",
    status: "in_progress",
    latestTitle: "Terminal",
    detail: "npm test",
    startedAt: 7_000,
    ...patch,
  }) as Parameters<typeof runningToolFromState>[0];

const text = (line: { prefix?: string; body?: string }): string =>
  `${line.prefix ?? ""}${line.body ?? ""}`;

describe("isRunningStatus", () => {
  it("treats every terminal status as not-running", () => {
    for (const s of [
      "completed",
      "succeeded",
      "ok",
      "failed",
      "error",
      "rejected",
      "cancelled",
      "canceled",
    ]) {
      expect(isRunningStatus(s)).toBe(false);
    }
  });

  it("treats pending and in_progress as running", () => {
    expect(isRunningStatus("pending")).toBe(true);
    expect(isRunningStatus("in_progress")).toBe(true);
  });
});

describe("oneLine", () => {
  // A row containing a newline corrupts the paint, and multi-line shell
  // input reaches us verbatim.
  it("collapses newlines and runs of whitespace", () => {
    expect(oneLine("cat <<EOF\nhello\nEOF")).toBe("cat <<EOF hello EOF");
    expect(oneLine("  npm    test  ")).toBe("npm test");
  });
});

describe("dedupeDetail", () => {
  // "▸ edit edit" — the agent titled the call after the tool, which is
  // also what the verb says.
  it("drops a detail that is nothing but the verb", () => {
    expect(dedupeDetail("edit", "edit", "edit")).toBe("");
    expect(dedupeDetail("Edit", "edit", "edit")).toBe("");
    expect(dedupeDetail("Fetch", "fetch", "fetch")).toBe("");
  });

  it("strips a leading copy of the verb but keeps the rest", () => {
    expect(dedupeDetail("Read /foo/bar.ts", "read", "read")).toBe("/foo/bar.ts");
    expect(dedupeDetail("Edit File", "edit", "edit")).toBe("File");
  });

  // execute renders as "run", so the echo can match either spelling.
  it("checks the raw ACP kind as well as the display verb", () => {
    expect(dedupeDetail("execute", "run", "execute")).toBe("");
    expect(dedupeDetail("run", "run", "execute")).toBe("");
  });

  it("leaves a real detail alone", () => {
    expect(dedupeDetail("npm test", "run", "execute")).toBe("npm test");
    expect(dedupeDetail("src/app.ts", "edit", "edit")).toBe("src/app.ts");
  });

  // Substring, not prefix: the file is genuinely named that.
  it("does not strip a verb that merely starts a longer word", () => {
    expect(dedupeDetail("editor.ts", "edit", "edit")).toBe("editor.ts");
    expect(dedupeDetail("readme.md", "read", "read")).toBe("readme.md");
  });
});

describe("isGenericToolName", () => {
  it("treats a bare one-word name as the tool's own name", () => {
    for (const t of ["Write", "Read", "Bash", "Terminal", "MultiEdit", ""]) {
      expect(isGenericToolName(t)).toBe(true);
    }
  });

  it("treats anything with a separator as describing a target", () => {
    for (const t of ["npm test", "src/app.ts", "gadgets.ts", "grep -rn foo"]) {
      expect(isGenericToolName(t)).toBe(false);
    }
  });
});

describe("pathHint", () => {
  it("takes the last segment and tolerates a trailing slash", () => {
    expect(pathHint("/repo/src/app.ts")).toBe("app.ts");
    expect(pathHint("/repo/src/")).toBe("src");
    expect(pathHint("app.ts")).toBe("app.ts");
  });

  it("returns empty for nothing usable, so the next source is tried", () => {
    expect(pathHint(undefined)).toBe("");
    expect(pathHint("")).toBe("");
    expect(pathHint("/")).toBe("");
  });
});

describe("runningVerb", () => {
  it("maps execute to the shorter 'run'", () => {
    expect(runningVerb("execute")).toBe("run");
  });

  it("falls back to a neutral verb when the agent sends no kind", () => {
    expect(runningVerb(undefined)).toBe("tool");
    expect(runningVerb("something-new")).toBe("tool");
  });
});

describe("runningToolFromState", () => {
  it("drops calls that already reached a terminal status", () => {
    expect(runningToolFromState(state({ status: "completed" }), null)).toBeNull();
    expect(runningToolFromState(state({ status: "failed" }), null)).toBeNull();
  });

  it("keeps in-flight calls with verb, detail and start time", () => {
    expect(runningToolFromState(state(), null)).toEqual({
      verb: "run",
      detail: "npm test",
      startedAt: 7_000,
      path: undefined,
    });
  });

  // "Terminal" is the tool's own name and "run" already says that, so the
  // row is just the verb rather than "run Terminal".
  it("drops the title fallback when it only names the tool", () => {
    expect(
      runningToolFromState(state({ detail: undefined }), null)?.detail,
    ).toBeUndefined();
  });

  // The title fallback is the usual source of "edit edit": the agent named
  // the call after the tool, which is what the verb already says.
  it("leaves no detail when the title just restates the verb", () => {
    const entry = runningToolFromState(
      state({ rawKind: "edit", detail: undefined, latestTitle: "Edit" }),
      null,
    );
    expect(entry?.verb).toBe("edit");
    expect(entry?.detail).toBeUndefined();
  });

  // ...but if we know the file, say which one rather than a bare "edit".
  it("names the file when there is no detail but a location is reported", () => {
    const entry = runningToolFromState(
      state({
        rawKind: "edit",
        detail: undefined,
        latestTitle: "Edit",
        locations: [{ path: "src/tui/sidebar/gadgets.ts" }],
      }),
      "/repo",
    );
    expect(entry?.detail).toBe("gadgets.ts");
    expect(entry?.path).toBe("/repo/src/tui/sidebar/gadgets.ts");
  });

  // Edit-style calls often carry their target ONLY on the diff payload;
  // locations[] is a follow-along hint many agents skip for writes.
  it("names the file from the edit diff when locations is empty", () => {
    const entry = runningToolFromState(
      state({
        rawKind: "edit",
        detail: undefined,
        latestTitle: "Edit",
        locations: undefined,
        editDiff: { path: "src/tui/app.ts", oldText: "a", newText: "b" },
      }),
      "/repo",
    );
    expect(entry?.detail).toBe("app.ts");
    expect(entry?.path).toBe("/repo/src/tui/app.ts");
  });

  it("prefers an explicit detail over the location basename", () => {
    const entry = runningToolFromState(
      state({
        rawKind: "execute",
        detail: "npm test",
        locations: [{ path: "/repo" }],
      }),
      null,
    );
    expect(entry?.detail).toBe("npm test");
  });

  // "edit Write": the initial tool_call has an empty rawInput, so the only
  // thing available is the tool's own name, which restates the kind.
  it("drops a bare tool-name title when the verb is already specific", () => {
    for (const title of ["Write", "Read", "Bash", "MultiEdit"]) {
      const entry = runningToolFromState(
        state({ rawKind: "edit", detail: undefined, locations: undefined, latestTitle: title }),
        null,
      );
      expect(entry?.detail).toBeUndefined();
    }
  });

  // ...but when the kind is unrecognized the verb is the generic "tool",
  // and the name is the only signal there is.
  it("keeps a bare tool-name title when the verb is generic", () => {
    const entry = runningToolFromState(
      state({ rawKind: "other", detail: undefined, latestTitle: "WebSearch" }),
      null,
    );
    expect(entry?.verb).toBe("tool");
    expect(entry?.detail).toBe("WebSearch");
  });

  it("keeps a descriptive title even when the verb is specific", () => {
    expect(
      runningToolFromState(
        state({ rawKind: "search", detail: undefined, latestTitle: "grep -rn foo" }),
        null,
      )?.detail,
    ).toBe("grep -rn foo");
  });

  it("absolutizes reported paths against the session cwd", () => {
    const entry = runningToolFromState(
      state({ rawKind: "read", locations: [{ path: "src/app.ts" }] }),
      "/repo",
    );
    expect(entry?.path).toBe("/repo/src/app.ts");
    expect(entry?.verb).toBe("read");
  });
});

describe("runningTools", () => {
  it("returns in-flight calls in tools-block order and skips finished ones", () => {
    const states = new Map([
      ["a", state({ detail: "one" })],
      ["b", state({ detail: "two", status: "completed" })],
      ["c", state({ detail: "three" })],
    ]);
    expect(runningTools(["a", "b", "c"], states, null).map((t) => t.detail)).toEqual([
      "one",
      "three",
    ]);
  });

  it("ignores ids with no recorded state", () => {
    expect(runningTools(["ghost"], new Map(), null)).toEqual([]);
  });
});

describe("toolsGadget", () => {
  const tool = (patch: Partial<SidebarRunningTool> = {}): SidebarRunningTool => ({
    verb: "run",
    detail: "npm test",
    startedAt: 7_000,
    ...patch,
  });

  it("hides itself while nothing is in flight", () => {
    expect(toolsGadget.relevant(snap())).toBe(false);
    expect(toolsGadget.relevant(snap({ running: [tool()] }))).toBe(true);
  });

  it("shows the verb, the detail and a live elapsed time", () => {
    const [line] = toolsGadget.render(snap({ running: [tool()] }), ctx());
    expect(text(line!)).toContain("run");
    expect(text(line!)).toContain("npm test");
    expect(text(line!)).toContain("3s");
  });

  // The whole reason the gadget takes `detail` and never `detailFull`.
  it("never emits a row wider than the column, even for a huge command", () => {
    const huge = "docker run --rm -v " + "x".repeat(4000);
    for (const width of [20, 24, 36]) {
      const lines = toolsGadget.render(
        snap({ running: [tool({ detail: huge })] }),
        ctx(width),
      );
      for (const line of lines) {
        expect(stringWidth(text(line))).toBeLessThanOrEqual(width);
      }
    }
  });

  it("keeps the verb legible when the detail cannot fit at all", () => {
    const [line] = toolsGadget.render(
      snap({ running: [tool({ verb: "fetch", detail: "x".repeat(200) })] }),
      ctx(20),
    );
    expect(text(line!)).toContain("fetch");
  });

  // Not paginated on purpose: it must stay out of the renderer's shared
  // page budget so it can't resize todo/edited as tools start and stop.
  it("declares no pageSize and caps itself with an overflow row", () => {
    expect(toolsGadget.pageSize).toBeUndefined();
    const many = Array.from({ length: RUNNING_TOOL_CAP + 3 }, (_, i) =>
      tool({ detail: `job${i}` }),
    );
    const lines = toolsGadget.render(snap({ running: many }), ctx());
    expect(lines).toHaveLength(RUNNING_TOOL_CAP + 1);
    expect(text(lines.at(-1)!)).toContain("+3 more");
  });

  it("emits no rows as items, so pagination never windows it", () => {
    const many = Array.from({ length: RUNNING_TOOL_CAP }, () => tool());
    for (const line of toolsGadget.render(snap({ running: many }), ctx())) {
      expect(line.item).toBeUndefined();
    }
  });

  it("carries the path so a double-click opens the file", () => {
    const [line] = toolsGadget.render(
      snap({ running: [tool({ verb: "edit", path: "/repo/src/app.ts" })] }),
      ctx(),
    );
    expect(line!.openPath).toBe("/repo/src/app.ts");
  });

  // Same trap the activity gadget documents: an un-quantized key would
  // re-render every frame to produce identical bytes.
  it("quantizes the version key to whole seconds", () => {
    const key = (now: number): string =>
      toolsGadget.versionKey(snap({ now, running: [tool()] }), ctx());
    expect(key(10_000)).toBe(key(10_400));
    expect(key(10_000)).not.toBe(key(11_000));
  });

  it("changes the version key when the running set changes", () => {
    const c = ctx();
    const a = toolsGadget.versionKey(snap({ running: [tool()] }), c);
    const b = toolsGadget.versionKey(
      snap({ running: [tool(), tool({ detail: "other" })] }),
      c,
    );
    expect(a).not.toBe(b);
  });

  // Last on purpose: the list fills and empties on a per-tool-call
  // cadence, so anything below it visibly jumps every few seconds.
  it("is last in the default gadget order", () => {
    expect(DEFAULT_GADGET_IDS.at(-1)).toBe("tools");
  });

  it("renders a bare verb row without a dangling separator", () => {
    const [line] = toolsGadget.render(
      snap({ running: [tool({ verb: "edit", detail: undefined })] }),
      ctx(),
    );
    expect(text(line!)).toMatch(/^▸ edit\s+3s$/u);
  });

  it("omits the timer for calls that arrived without a start time", () => {
    const [line] = toolsGadget.render(
      snap({ running: [tool({ startedAt: undefined })] }),
      ctx(),
    );
    expect(text(line!).trim()).toBe("▸ run npm test");
  });
});
