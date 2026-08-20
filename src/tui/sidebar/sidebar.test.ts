import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import {
  activityGadget,
  backgroundGadget,
  compactCount,
  contextGadget,
  displayPaths,
  filesGadget,
  sessionsGadget,
  gitGadget,
  meterBar,
  formatBytes,
  formatCpu,
  quantizeDuration,
  resourcesGadget,
  shortDuration,
  fitIdentifier,
  sessionInfoGadget,
  todoGadget,
  toolsGadget,
} from "./gadgets.js";
import { DEFAULT_GADGET_IDS, gadgetById, SidebarRenderer } from "./registry.js";
import { HydraConfig } from "../../core/config.js";
import { emptySnapshot } from "./types.js";
import type {
  SidebarAction,
  SidebarArmedTask,
  SidebarLine,
  SidebarLiveSession,
  SidebarBorder,
  SidebarContext,
  SidebarProcUsage,
  SidebarSnapshot,
} from "./types.js";

// The real screen layer injects its grapheme/ambiguous-width-aware
// helpers; string-width is a faithful enough stand-in for these tests.
const ctx = (width = 24, border: SidebarBorder = "none"): SidebarContext => ({
  width,
  border,
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

// Full visible text of a row. Rows may split into prefix + body so the
// two halves can be styled independently (a dim label beside an unstyled
// value), so neither field alone represents the row — measuring only
// `body` would silently under-report every labelled row's width.
const rowText = (line: { prefix?: string; body: string }): string =>
  `${line.prefix ?? ""}${line.body}`;

const snap = (patch: Partial<SidebarSnapshot> = {}): SidebarSnapshot => ({
  ...emptySnapshot(1_000_000),
  ...patch,
});

describe("shortDuration", () => {
  it("formats sub-minute, minute and hour scales", () => {
    expect(shortDuration(0)).toBe("0s");
    expect(shortDuration(45_000)).toBe("45s");
    expect(shortDuration(200_000)).toBe("3m 20s");
    expect(shortDuration(3_840_000)).toBe("1h 04m");
  });

  it("clamps negative input rather than printing a negative clock", () => {
    expect(shortDuration(-5_000)).toBe("0s");
  });
});

describe("compactCount", () => {
  it("switches units at 1K and 1M", () => {
    expect(compactCount(999)).toBe("999");
    expect(compactCount(1_500)).toBe("1.5K");
    expect(compactCount(43_000)).toBe("43K");
    expect(compactCount(2_400_000)).toBe("2.4M");
  });
});

describe("meterBar", () => {
  it("occupies exactly the requested cell count at any fraction", () => {
    for (const f of [0, 0.01, 0.33, 0.5, 0.99, 1]) {
      expect(stringWidth(meterBar(f, 20))).toBe(20);
    }
  });

  it("clamps out-of-range fractions", () => {
    expect(stringWidth(meterBar(-1, 10))).toBe(10);
    expect(stringWidth(meterBar(5, 10))).toBe(10);
    expect(meterBar(5, 10)).toBe("█".repeat(10));
  });

  it("renders a partial block so small changes are still visible", () => {
    // 1/20th of a 10-cell bar is half a cell — must not round to empty.
    expect(meterBar(0.05, 10)).not.toBe("·".repeat(10));
  });
});

describe("activity gadget", () => {
  it("shows a thinking timer while busy and an idle timer when not", () => {
    const busy = activityGadget.render(
      snap({ busySince: 1_000_000 - 92_000 }),
      ctx(),
    );
    expect(busy[0]!.body).toContain("thinking");
    expect(busy[0]!.body).toContain("1m 32s");

    const idle = activityGadget.render(
      snap({ lastTurnEndedAt: 1_000_000 - 250_000 }),
      ctx(),
    );
    expect(idle[0]!.body).toContain("idle");
    expect(idle[0]!.body).toContain("4m 10s");
  });

  it("never shows thinking and idle at once — busy wins", () => {
    const lines = activityGadget.render(
      snap({ busySince: 1_000_000 - 1_000, lastTurnEndedAt: 1_000_000 - 60_000 }),
      ctx(),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.body).toContain("thinking");
    expect(lines[0]!.body).not.toContain("idle");
  });

  it("reads 'ready' before the first turn rather than 'idle 0s'", () => {
    expect(activityGadget.render(snap(), ctx())[0]!.body).toContain("ready");
  });

  // Between thinking and idle: the agent handed the turn back, but a job
  // it started is still going and can wake it up unprompted. Showing
  // "idle 12m" there is the misleading case this exists to fix.
  it("shows running, clocked from the job start, while a task is armed", () => {
    const lines = activityGadget.render(
      snap({
        armedSince: 1_000_000 - 92_000,
        lastTurnEndedAt: 1_000_000 - 250_000,
      }),
      ctx(),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.body).toContain("running");
    // From the arming, not the turn end: 1m32s, not 4m10s.
    expect(lines[0]!.body).toContain("1m 32s");
    expect(lines[0]!.body).not.toContain("idle");
  });

  it("prefers thinking over running when a turn is in flight", () => {
    const lines = activityGadget.render(
      snap({ busySince: 1_000_000 - 1_000, armedSince: 1_000_000 - 600_000 }),
      ctx(),
    );
    expect(lines[0]!.body).toContain("thinking");
    expect(lines[0]!.body).not.toContain("running");
  });

  it("falls back to idle once the armed task clears", () => {
    const lines = activityGadget.render(
      snap({ armedSince: null, lastTurnEndedAt: 1_000_000 - 250_000 }),
      ctx(),
    );
    expect(lines[0]!.body).toContain("idle");
    expect(lines[0]!.body).not.toContain("running");
  });

  it("re-renders once per whole second, not per millisecond", () => {
    const base = snap({ busySince: 0 });
    const k = (now: number): string =>
      activityGadget.versionKey({ ...base, now }, ctx());
    expect(k(5_000)).toBe(k(5_400));
    expect(k(5_000)).not.toBe(k(6_000));
  });
});

// The default gadget list is written out twice (registry.ts for the
// renderer, config.ts for the schema default) and core must not import from
// tui, so nothing but this test keeps them in step. A drifted pair is
// invisible: the renderer would know a gadget the config never names, so it
// would silently never appear for anyone who hasn't pinned their own list —
// which is the majority, since pinning is deliberately discouraged.
describe("default gadget list", () => {
  it("matches the config schema default", () => {
    const fromConfig = HydraConfig.parse({}).tui.sidebar.gadgets;
    expect(fromConfig).toEqual([...DEFAULT_GADGET_IDS]);
  });

  it("resolves every default id to a real gadget", () => {
    for (const id of DEFAULT_GADGET_IDS) {
      expect(gadgetById(id), `unknown default gadget id: ${id}`).toBeDefined();
    }
  });
});

describe("background gadget", () => {
  const task = (over: Partial<SidebarArmedTask> = {}): SidebarArmedTask => ({
    label: "Sleep 20 seconds then echo done",
    taskId: "bg_a",
    taskType: "local_bash",
    since: 1_000_000 - 45_000,
    ...over,
  });

  it("names each job and clocks it independently", () => {
    const lines = backgroundGadget.render(
      snap({
        armedTasks: [
          task(),
          task({ taskId: "bg_b", label: "device run", since: 1_000_000 - 5_000 }),
        ],
      }),
      ctx(40),
    );
    expect(lines).toHaveLength(2);
    // The aggregate armedSince would have shown 45s for both. The whole
    // point of the per-entry stamp is that these differ.
    expect(lines[0]!.body).toContain("45s");
    expect(lines[1]!.body).toContain("5s");
    expect(lines[1]!.body).toContain("device run");
  });

  it("hides itself when nothing is running", () => {
    expect(backgroundGadget.relevant(snap({ armedTasks: [] }))).toBe(false);
    expect(backgroundGadget.relevant(snap({ armedTasks: [task()] }))).toBe(true);
  });

  it("re-renders when membership changes but the clocks do not", () => {
    // The same-size swap: one job ends as another starts within the same
    // second, so counts and elapsed values are identical. A versionKey
    // built from length and timings alone would memo away a real change.
    const before = snap({ armedTasks: [task({ taskId: "A" }), task({ taskId: "B" })] });
    const after = snap({ armedTasks: [task({ taskId: "A" }), task({ taskId: "C" })] });
    expect(backgroundGadget.versionKey!(before, ctx(40))).not.toBe(
      backgroundGadget.versionKey!(after, ctx(40)),
    );
  });

  it("falls back to the task type when the agent sent no description", () => {
    const lines = backgroundGadget.render(
      snap({ armedTasks: [task({ label: "" })] }),
      ctx(40),
    );
    expect(lines[0]!.body).toContain("local_bash");
  });

  it("caps the list and says how many it dropped", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      task({ taskId: `bg_${i}`, label: `job ${i}` }));
    const lines = backgroundGadget.render(snap({ armedTasks: many }), ctx(40));
    expect(lines).toHaveLength(6);
    expect(lines[5]!.body).toContain("+3 more");
  });
});

describe("relevance gating", () => {
  it("hides files, git, todo when there is nothing to report", () => {
    const s = snap();
    expect(filesGadget.relevant(s)).toBe(false);
    expect(todoGadget.relevant(s)).toBe(false);
    expect(gitGadget.relevant(s)).toBe(false);
    expect(contextGadget.relevant(s)).toBe(false);
  });

  it("hides git for a clean work tree and for a non-repo cwd", () => {
    expect(gitGadget.relevant(snap({ git: null }))).toBe(false);
    expect(
      gitGadget.relevant(
        snap({
          git: {
            branch: "main",
            staged: 0,
            unstaged: 0,
            untracked: 0,
            ahead: 0,
            behind: 0,
            files: [],
          },
        }),
      ),
    ).toBe(false);
  });

  it("shows git when the tree is dirty or the branch has diverged", () => {
    const g = {
      branch: "main",
      staged: 0,
      unstaged: 0,
      untracked: 0,
      ahead: 0,
      behind: 0,
      files: [],
    };
    expect(gitGadget.relevant(snap({ git: { ...g, unstaged: 1 } }))).toBe(true);
    expect(gitGadget.relevant(snap({ git: { ...g, ahead: 2 } }))).toBe(true);
  });

  it("shows files once anything has been edited", () => {
    expect(
      filesGadget.relevant(snap({ editedFiles: [{ path: "a.ts" }] })),
    ).toBe(true);
  });
});

describe("files gadget", () => {
  it("disambiguates identical basenames with the parent directory", () => {
    expect(displayPaths(["/a/x/index.ts", "/a/y/index.ts", "/a/z/main.ts"])).toEqual(
      ["x/index.ts", "y/index.ts", "main.ts"],
    );
  });

  // No internal cap: the column scrolls, so every edited file gets a row
  // (and therefore stays clickable) rather than being hidden behind one.
  it("lists every edited file, and every row is a file", () => {
    const editedFiles = Array.from({ length: 9 }, (_, i) => ({
      path: `/repo/f${i}.ts`,
    }));
    const lines = filesGadget.render(snap({ editedFiles }), ctx());
    expect(lines).toHaveLength(9);
    expect(lines.filter((l) => l.openPath !== undefined)).toHaveLength(9);
  });

  // The count rides on the title row (registry stamps it) rather than
  // costing a row of its own with an empty left-hand side.
  it("reports its count as a title note, only when there's more than one", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ path: `/repo/f${i}.ts` }));
    expect(filesGadget.titleNote!(snap({ editedFiles: many }), ctx())).toBe("9 files");
    expect(
      filesGadget.titleNote!(snap({ editedFiles: [{ path: "/repo/a.ts" }] }), ctx()),
    ).toBeUndefined();
  });

  it("omits the count row for a single edited file", () => {
    const lines = filesGadget.render(
      snap({ editedFiles: [{ path: "/repo/a.ts" }] }),
      ctx(),
    );
    expect(lines).toHaveLength(1);
  });

  it("lists newest first", () => {
    const lines = filesGadget.render(
      snap({
        editedFiles: [{ path: "/repo/old.ts" }, { path: "/repo/new.ts" }],
      }),
      ctx(),
    );
    expect(lines.filter((l) => l.openPath).map((l) => l.openPath)).toEqual([
      "/repo/new.ts",
      "/repo/old.ts",
    ]);
  });

  it("omits the +/- column for edits with no diff payload", () => {
    const lines = filesGadget.render(
      snap({ editedFiles: [{ path: "/repo/a.ts" }] }),
      ctx(),
    );
    expect(lines[0]!.body).not.toContain("+");
  });
});

describe("todo gadget", () => {
  // Page 1 is the only page visible without clicking, so the actionable
  // entries have to be the ones at the top: in plan order the completed ones
  // pile up there and push the active entry onto page 2.
  it("orders in-progress, then unfinished, then completed", () => {
    const lines = todoGadget.render(
      snap({
        plan: [
          { content: "done a", status: "completed" },
          { content: "done b", status: "completed" },
          { content: "active", status: "in_progress" },
          { content: "todo a", status: "pending" },
          { content: "no status" },
        ],
      }),
      ctx(),
    );
    expect(lines.map((l) => l.body)).toEqual([
      "▸ active",
      "· todo a",
      "· no status",
      "✓ done a",
      "✓ done b",
    ]);
  });

  it("keeps plan order within a status group", () => {
    const lines = todoGadget.render(
      snap({
        plan: [
          { content: "second", status: "pending" },
          { content: "first", status: "pending" },
        ],
      }),
      ctx(),
    );
    expect(lines.map((l) => l.body)).toEqual(["· second", "· first"]);
  });
});

describe("openPath targets", () => {
  it("marks edited-file rows with the absolute path to open", () => {
    const lines = filesGadget.render(
      snap({ editedFiles: [{ path: "/repo/src/a.ts", added: 3, removed: 1 }] }),
      ctx(),
    );
    const targets = lines.filter((l) => l.openPath !== undefined);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.openPath).toBe("/repo/src/a.ts");
    // The row displays a basename but the click target is the full path.
    expect(targets[0]!.body).toContain("a.ts");
    expect(targets[0]!.body).not.toContain("/repo/src/");
  });

  it("marks git file rows, one target per file", () => {
    const lines = gitGadget.render(
      snap({
        git: {
          branch: "main",
          staged: 1,
          unstaged: 1,
          untracked: 1,
          ahead: 0,
          behind: 0,
          files: [
            { path: "/repo/a.ts", state: "staged" },
            { path: "/repo/b.ts", state: "dirty" },
            { path: "/repo/c.ts", state: "new" },
          ],
        },
      }),
      ctx(),
    );
    expect(lines.filter((l) => l.openPath).map((l) => l.openPath)).toEqual([
      "/repo/a.ts",
      "/repo/b.ts",
      "/repo/c.ts",
    ]);
  });

  it("leaves the branch row without a click target", () => {
    const lines = gitGadget.render(
      snap({
        git: {
          branch: "main",
          staged: 0,
          unstaged: 1,
          untracked: 0,
          ahead: 0,
          behind: 0,
          files: [{ path: "/repo/a.ts", state: "dirty" }],
        },
      }),
      ctx(),
    );
    // Only the file row is openable; the branch row is not.
    expect(lines.filter((l) => l.openPath === undefined).length).toBe(1);
  });

  it("lists every changed file, uncapped, and counts them on the title", () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `/repo/f${i}.ts`,
      state: "dirty" as const,
    }));
    const lines = gitGadget.render(
      snap({
        git: {
          branch: "main",
          staged: 0,
          unstaged: 20,
          untracked: 0,
          ahead: 0,
          behind: 0,
          files,
        },
      }),
      ctx(),
    );
    expect(lines.filter((l) => l.openPath).length).toBe(20);
    // The count rides on the title row the registry stamps, not on a row of
    // the gadget's own.
    expect(lines.every((l) => l.openPath !== undefined || l.body === "main")).toBe(true);
  });

  // The old summary row read "1 staged · 2 dirty · 1 new". Its counters can
  // exceed the number of rows, because a file that is both staged and
  // unstaged bumps two of them while producing one (dirty) row — so the
  // header counts rows instead.
  it("counts rows, not the staged/unstaged/untracked totals", () => {
    const note = gitGadget.titleNote!(
      snap({
        git: {
          branch: "main",
          staged: 2,
          unstaged: 2,
          untracked: 0,
          ahead: 0,
          behind: 0,
          files: [
            { path: "/repo/a.ts", state: "dirty" },
            { path: "/repo/b.ts", state: "dirty" },
          ],
        },
      }),
      ctx(),
    );
    expect(note).toBe("2 files");
  });

  it("re-renders git when only the file list changed", () => {
    const base = {
      branch: "main",
      staged: 0,
      unstaged: 1,
      untracked: 0,
      ahead: 0,
      behind: 0,
    };
    const a = gitGadget.versionKey(
      snap({ git: { ...base, files: [{ path: "/repo/a.ts", state: "dirty" }] } }),
      ctx(),
    );
    const b = gitGadget.versionKey(
      snap({ git: { ...base, files: [{ path: "/repo/b.ts", state: "dirty" }] } }),
      ctx(),
    );
    expect(a).not.toBe(b);
  });
});

describe("width safety", () => {
  const wide = "日本語のとてもとても長いファイル名です";
  it("keeps every gadget row inside the column at narrow widths", () => {
    const s = snap({
      busySince: 900_000,
      usage: { used: 43_000, size: 200_000, costAmount: 1.25 },
      queued: 2,
      plan: [
        { content: wide, status: "in_progress" },
        { content: "short", status: "pending" },
      ],
      editedFiles: [{ path: `/repo/${wide}.ts`, added: 10, removed: 2 }],
      git: {
        branch: wide,
        staged: 1,
        unstaged: 2,
        untracked: 3,
        ahead: 1,
        behind: 1,
        files: [
          { path: `/repo/${wide}.ts`, state: "dirty" as const },
          { path: "/repo/b.ts", state: "staged" as const },
        ],
      },
      sessionId: "abcdef123456",
      agent: wide,
      model: wide,
      mode: "plan",
    });
    for (const width of [12, 20, 24, 36]) {
      const c = ctx(width);
      const lines = new SidebarRenderer().render(s, c);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(stringWidth(rowText(line))).toBeLessThanOrEqual(width);
      }
    }
  });
});

// A gadget id that no longer exists must keep working: setGadgets drops
// unknown ids silently, so a rename would delete the block outright for
// anyone who had pinned the old name.
// The folded/open distinction is the renderer's to pass through; a gadget
// that ignores the flag (files, git) must behave identically either way.
describe("folded title notes", () => {
  const render = (ids: string[], collapsed: string[]) =>
    new SidebarRenderer(ids).render(
      snap({
        liveSessions: [
          { sessionId: "a", label: "alpha", busy: false, armed: false, waiting: true },
          { sessionId: "b", label: "beta", busy: false, armed: false, waiting: false },
        ],
        editedFiles: [{ path: "/repo/a.ts" }, { path: "/repo/b.ts" }],
      }),
      { ...ctx(26), collapsed: new Set(collapsed) },
    );

  it("shows the sessions count on the folded title and not the open one", () => {
    expect(rowText(render(["sessions"], [])[0]!)).not.toContain("waiting");
    const folded = rowText(render(["sessions"], ["sessions"])[0]!);
    expect(folded).toContain("1 waiting");
    // The fold marker still rides at the end.
    expect(folded.trimEnd().endsWith("+")).toBe(true);
  });

  it("leaves a gadget that ignores the flag unchanged", () => {
    expect(rowText(render(["files"], [])[0]!)).toContain("2 files");
    expect(rowText(render(["files"], ["files"])[0]!)).toContain("2 files");
  });
});

describe("gadget id aliases", () => {
  it("resolves the pre-rename 'session' id to the info gadget", () => {
    expect(gadgetById("session")).toBe(sessionInfoGadget);
    expect(gadgetById("info")).toBe(sessionInfoGadget);
    // And it is NOT the list-of-other-sessions gadget, which is the
    // confusion the rename existed to remove.
    expect(gadgetById("sessions")).toBe(sessionsGadget);
  });

  it("still drops an id that never existed", () => {
    expect(gadgetById("nonsense")).toBeUndefined();
  });

  it("renders the block for a config pinning the old id", () => {
    const lines = new SidebarRenderer(["session"]).render(
      snap({ agent: "opencode", model: "claude-opus-5", sessionId: "abc123" }),
      ctx(26),
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => rowText(l).includes("opencode"))).toBe(true);
  });
});

describe("SidebarRenderer", () => {
  const dirty = snap({
    busySince: 999_000,
    usage: { used: 10, size: 100 },
    plan: [{ content: "do it", status: "pending" }],
    editedFiles: [{ path: "/repo/a.ts" }],
    sessionId: "abc12345",
    agent: "claude-code",
  });

  it("renders nothing when no gadget is relevant", () => {
    expect(new SidebarRenderer([]).render(dirty, ctx())).toEqual([]);
  });

  it("memoizes per gadget — an unchanged gadget returns the same array", () => {
    const r = new SidebarRenderer(["context", "files"]);
    const first = r.render(dirty, ctx());
    const second = r.render(dirty, ctx());
    expect(second).not.toBe(first);
    // Identical line objects prove the gadget bodies came from the cache
    // rather than being re-rendered.
    expect(second.every((l, i) => l === first[i])).toBe(true);
  });

  it("re-renders a gadget whose inputs changed", () => {
    const r = new SidebarRenderer(["context"]);
    const first = r.render(dirty, ctx());
    const second = r.render(
      { ...dirty, usage: { used: 90, size: 100 } },
      ctx(),
    );
    expect(second[1]!.body).not.toBe(first[1]!.body);
  });

  it("busts the cache when the column width changes", () => {
    const r = new SidebarRenderer(["context"]);
    const narrow = r.render(dirty, ctx(16));
    const wide = r.render(dirty, ctx(30));
    expect(wide[1]!.body).not.toBe(narrow[1]!.body);
  });

  // Fitting the column to the terminal is the screen layer's job now:
  // it windows this list and scrolls it, so nothing is dropped and the
  // first-configured gadgets are simply the ones visible at offset 0.
  it("returns the whole column unclipped", () => {
    const r = new SidebarRenderer(["activity", "context", "files", "session"]);
    const full = r.render(dirty, ctx());
    expect(full.length).toBeGreaterThan(4);
    expect(full[0]!.body).toContain("thinking");
  });

  it("returns nothing for a zero-width column", () => {
    const r = new SidebarRenderer(["activity", "context", "session"]);
    expect(r.render(dirty, ctx(0))).toEqual([]);
  });

  it("ignores unknown gadget ids instead of throwing", () => {
    const r = new SidebarRenderer(["nope", "activity", "alsonope"]);
    expect(r.configuredIds()).toEqual(["activity"]);
    expect(r.render(dirty, ctx())).toHaveLength(1);
  });

  it("honours configured order", () => {
    const a = new SidebarRenderer(["session", "activity"]).render(dirty, ctx());
    const b = new SidebarRenderer(["activity", "session"]).render(dirty, ctx());
    expect(a[0]!.body).not.toBe(b[0]!.body);
  });

  it("reports whether a gadget is configured, for data-collection gating", () => {
    const r = new SidebarRenderer(["activity"]);
    expect(r.isConfigured("git")).toBe(false);
    expect(r.isConfigured("activity")).toBe(true);
  });

  it("separates blocks with a blank row but never leads or trails with one", () => {
    const lines = new SidebarRenderer(["activity", "session"]).render(
      dirty,
      ctx(),
    );
    expect(lines[0]!.body).not.toBe("");
    expect(lines.at(-1)!.body).not.toBe("");
    expect(lines.filter((l) => l.body === "")).toHaveLength(1);
  });
});

describe("borders", () => {
  // All three gadgets used below must be RELEVANT, or a test that counts
  // junctions silently counts fewer blocks than it means to.
  const s = snap({
    busySince: 900_000,
    usage: { used: 10, size: 100 },
    agent: "opencode",
  });

  const gutters = (border: SidebarBorder): string[] =>
    new SidebarRenderer(["activity", "context"])
      .render(s, ctx(24, border))
      .map((l) => l.gutter ?? " ");

  it("draws no rules in 'none' mode and separates blocks with a blank row", () => {
    const lines = new SidebarRenderer(["activity", "context"]).render(
      s,
      ctx(24, "none"),
    );
    expect(lines.every((l) => l.gutter === undefined)).toBe(true);
    expect(lines.filter((l) => l.body === "")).toHaveLength(1);
  });

  it("draws one unbroken rule in 'rule' mode, separators included", () => {
    expect(gutters("rule").every((g) => g === "│")).toBe(true);
  });

  it("frames the column with the junction each position calls for", () => {
    const lines = new SidebarRenderer(["activity", "context"]).render(
      s,
      ctx(24, "frame"),
    );
    const g = lines.map((l) => l.gutter);
    // Opens with "┌", closes with "└", and the boundary between the two
    // gadgets is "├" because the vertical edge continues through it.
    expect(g[0]).toBe("┌");
    expect(g.at(-1)).toBe("└");
    expect(g.filter((x) => x === "┌")).toHaveLength(1);
    expect(g.filter((x) => x === "├")).toHaveLength(1);
    expect(g.filter((x) => x === "└")).toHaveLength(1);
    // No gaps: every row carries some part of the edge.
    expect(g.every((x) => x !== undefined)).toBe(true);
    // Rule rows span the full body width.
    for (const line of lines) {
      if (line.gutter !== "│") {
        expect(line.body).toBe("─".repeat(24));
      }
    }
    // No blank separators: the rules do that job.
    expect(lines.some((l) => l.body === "")).toBe(false);
  });

  // The closing rule is the point: without it the vertical edge just stops
  // in mid-air under the last gadget.
  it("closes the bottom even with a single gadget", () => {
    const g = new SidebarRenderer(["activity"])
      .render(s, ctx(24, "frame"))
      .map((l) => l.gutter);
    expect(g).toEqual(["┌", "│", "└"]);
  });

  it("puts one junction between every adjacent pair of gadgets", () => {
    const lines = new SidebarRenderer([
      "activity",
      "context",
      "session",
    ]).render(s, ctx(24, "frame"));
    expect(lines.filter((l) => l.gutter === "├")).toHaveLength(2);
  });

  it("places the opening rule directly above the first gadget's content", () => {
    const lines = new SidebarRenderer(["context"]).render(s, ctx(24, "frame"));
    expect(lines[0]!.gutter).toBe("┌");
    expect(lines[1]!.body).toBe("context");
  });

  it("keeps the rule inside the column width", () => {
    for (const width of [1, 12, 40]) {
      const lines = new SidebarRenderer(["activity"]).render(
        s,
        ctx(width, "frame"),
      );
      for (const line of lines) {
        expect(stringWidth(rowText(line))).toBeLessThanOrEqual(width);
      }
    }
  });

  // Blank separation spends one row per interior boundary; the frame
  // spends the same, plus its opening and closing rules.
  it("costs two rows more than blank separation", () => {
    const plain = new SidebarRenderer(["activity", "context"]).render(
      s,
      ctx(24, "none"),
    );
    const framed = new SidebarRenderer(["activity", "context"]).render(
      s,
      ctx(24, "frame"),
    );
    expect(framed.length).toBe(plain.length + 2);
  });

  it("re-renders when the border mode changes", () => {
    const r = new SidebarRenderer(["activity"]);
    const none = r.render(s, ctx(24, "none"))[0]!;
    const rule = r.render(s, ctx(24, "rule"))[0]!;
    expect(none.gutter).toBeUndefined();
    expect(rule.gutter).toBe("│");
  });

  it("keeps rows referentially stable across identical frames", () => {
    const r = new SidebarRenderer(["activity", "context"]);
    const first = r.render(s, ctx(24, "frame"));
    const second = r.render(s, ctx(24, "frame"));
    // Gutter decoration is baked into the cached block, so an unchanged
    // frame still returns the very same row objects.
    expect(second.every((l, i) => l === first[i])).toBe(true);
  });
});

describe("info gadget", () => {
  const s = snap({
    agent: "hydra",
    model: "ncp-anthropic/claude-opus-5",
    mode: "build",
    sessionId: "a1b2c3d4e5f6",
  });

  // Every row used to be a bare value, so the block read as an unlabelled
  // pile of identifiers: "hydra / ncp-anthropic/claude-opus-5 / build /
  // hydra_se".
  it("labels every row", () => {
    const rows = sessionInfoGadget.render(s, ctx(26)).map(rowText);
    expect(rows.some((b) => b.startsWith("agent"))).toBe(true);
    expect(rows.some((b) => b.startsWith("model"))).toBe(true);
    expect(rows.some((b) => b.startsWith("mode"))).toBe(true);
    expect(rows.some((b) => b.startsWith("id"))).toBe(true);
  });

  // The three switchable dimensions open the same chooser their sessionbar
  // fields do. The action carries the CONFIG ID, not the current setting:
  // the chooser reads the live option list, and the row's own text is a
  // head-clipped display form anyway.
  it("makes agent / model / mode open their chooser, and id copy in full", () => {
    const rows = sessionInfoGadget.render(s, ctx(26));
    expect(rows.map((r) => r.doubleAction)).toEqual([
      { action: "choose-agent", value: "agent" },
      { action: "choose-model", value: "model" },
      { action: "choose-mode", value: "mode" },
      { action: "copy", value: "a1b2c3d4e5f6" },
    ]);
  });

  // Colour in the sidebar marks state; these are identity strings, so the
  // label is dim scaffolding and the value keeps the default foreground —
  // matching the sessionbar, which renders agent(model) unstyled too.
  it("dims the labels and gives the values the body colour", () => {
    for (const line of sessionInfoGadget.render(s, ctx(26))) {
      expect(line.prefixStyle).toBe("muted");
      // Named rather than absent. It resolves to the same bytes an unstyled row
      // would, but saying it makes the plainness a decision — and gives the
      // sessions list a token to match.
      expect(line.bodyStyle).toBe("sidebar-value");
    }
  });

  it("drops the provider prefix from a model that doesn't fit", () => {
    const body = sessionInfoGadget
      .render(s, ctx(26))
      .find((l) => rowText(l).startsWith("model"))!.body;
    expect(body).toContain("claude-opus-5");
    expect(body).not.toContain("ncp-anthropic");
  });

  it("keeps the full model when it fits", () => {
    const body = sessionInfoGadget
      .render(s, ctx(40))
      .find((l) => rowText(l).startsWith("model"))!.body;
    expect(body).toContain("ncp-anthropic/claude-opus-5");
  });

  it("omits rows with no value", () => {
    const lines = sessionInfoGadget.render(snap({ agent: "hydra" }), ctx(26));
    expect(lines).toHaveLength(1);
  });

  it("stays inside the column at every width", () => {
    for (const width of [10, 16, 26, 40]) {
      for (const line of sessionInfoGadget.render(s, ctx(width))) {
        expect(stringWidth(rowText(line))).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("fitIdentifier", () => {
  const c = ctx(30);

  it("returns the value untouched when it fits", () => {
    expect(fitIdentifier("claude-opus-5", 20, c)).toBe("claude-opus-5");
  });

  it("prefers dropping a provider prefix over clipping", () => {
    expect(fitIdentifier("ncp-anthropic/claude-opus-5", 20, c)).toBe(
      "claude-opus-5",
    );
  });

  // The tail distinguishes one id from another, so it's the head that goes.
  it("clips from the head when even the last segment is too long", () => {
    const out = fitIdentifier("abcdefghijklmnop", 6, c);
    expect(out).toBe("…lmnop");
    expect(stringWidth(out)).toBeLessThanOrEqual(6);
  });

  it("never exceeds the budget", () => {
    for (const budget of [1, 2, 3, 7, 15]) {
      const out = fitIdentifier("ncp-anthropic/claude-opus-5", budget, c);
      expect(stringWidth(out)).toBeLessThanOrEqual(budget);
    }
  });

  it("returns empty for a non-positive budget", () => {
    expect(fitIdentifier("anything", 0, c)).toBe("");
  });
});

// Bounding each list gadget keeps every gadget on screen at once. The column
// scrolls too, but scrolling is a poor substitute here: one long list would
// push the gadgets below it out of view even though nothing was truncated.
// The title row carries a fold toggle alongside any pager arrows; these
// assertions are about the arrows.
const pageActions = (
  line: { actions?: readonly SidebarAction[] },
): Array<Extract<SidebarAction, { page: unknown }>> =>
  (line.actions ?? []).filter(
    (a): a is Extract<SidebarAction, { page: unknown }> => "page" in a,
  );

describe("pagination", () => {
  const files = (n: number): SidebarSnapshot =>
    snap({
      editedFiles: Array.from({ length: n }, (_, i) => ({
        path: `/repo/f${i}.ts`,
      })),
    });

  const render = (
    n: number,
    pages?: Record<string, number>,
    width = 26,
  ): ReturnType<SidebarRenderer["render"]> =>
    new SidebarRenderer(["files"]).render(files(n), {
      ...ctx(width),
      pages,
    });

  it("leaves a list that fits alone — no pager, no window", () => {
    const lines = render(5);
    expect(lines.filter((l) => l.item).length).toBe(5);
    expect(pageActions(lines[0]!)).toHaveLength(0);
    expect(lines[0]!.body).toContain("edited");
    expect(lines[0]!.body).toContain("5 files");
  });

  it("windows a longer list and stamps a pager on the title row", () => {
    const lines = render(12);
    expect(lines.filter((l) => l.item).length).toBe(5);
    expect(lines[0]!.body).toContain("edited");
    expect(lines[0]!.body).toContain("1/3");
    expect(lines[0]!.actions).toBeDefined();
  });

  it("keeps the title row, and only that, on every page", () => {
    for (const page of [0, 1, 2]) {
      const lines = render(12, { files: page });
      expect(lines.filter((l) => l.item !== true).length).toBe(1);
    }
  });

  // The count and the pager share the title row's right-hand slot. When
  // both apply the pager wins outright — it's the more urgent of the two,
  // and showing them together would need width the column may not have.
  it("replaces the count with the pager when windowing", () => {
    const windowed = render(12)[0]!.body!;
    expect(windowed).toContain("1/3");
    expect(windowed).not.toContain("files");
  });

  it("shows the requested page's items", () => {
    const first = render(12, { files: 0 })
      .filter((l) => l.item)
      .map((l) => l.openPath);
    const second = render(12, { files: 1 })
      .filter((l) => l.item)
      .map((l) => l.openPath);
    expect(first).not.toEqual(second);
    expect(first.some((p) => second.includes(p!))) .toBe(false);
  });

  it("gives the last page whatever remains", () => {
    // 12 items, 5 per page → pages of 5, 5, 2.
    expect(render(12, { files: 2 }).filter((l) => l.item).length).toBe(2);
  });

  it("clamps a page index past the end rather than going blank", () => {
    const lines = render(12, { files: 99 });
    expect(lines.filter((l) => l.item).length).toBeGreaterThan(0);
    expect(lines[0]!.body).toContain("3/3");
  });

  it("clamps a negative page index", () => {
    expect(render(12, { files: -4 })[0]!.body).toContain("1/3");
  });

  // Arrows carry absolute targets, so an arrow at the end of its range
  // simply records no action and renders inert.
  it("omits the back arrow on the first page and forward on the last", () => {
    const first = pageActions(render(12, { files: 0 })[0]!);
    expect(first).toHaveLength(1);
    expect(first[0]!.page.index).toBe(1);

    const middle = pageActions(render(12, { files: 1 })[0]!);
    expect(middle.map((a) => a.page.index).sort()).toEqual([0, 2]);

    const last = pageActions(render(12, { files: 2 })[0]!);
    expect(last).toHaveLength(1);
    expect(last[0]!.page.index).toBe(1);
  });

  it("targets the arrow glyphs' own columns", () => {
    const line = render(12, { files: 1 })[0]!;
    for (const action of pageActions(line)) {
      const glyph = line.body[action.start - 1];
      expect(["‹", "›"]).toContain(glyph);
      expect(action.end).toBe(action.start);
    }
  });

  it("keeps the pager row inside the column width", () => {
    for (const width of [20, 26, 40]) {
      const line = render(12, { files: 1 }, width)[0]!;
      expect(stringWidth(line.body)).toBeLessThanOrEqual(width);
    }
  });

  it("drops the pager rather than truncating it in a too-narrow column", () => {
    const lines = render(12, { files: 0 }, 7);
    // Still windowed, just without a control that wouldn't fit.
    expect(lines.filter((l) => l.item).length).toBe(5);
    expect(pageActions(lines[0]!)).toHaveLength(0);
  });

  it("paginates git and todo too", () => {
    const g = new SidebarRenderer(["git"]).render(
      snap({
        git: {
          branch: "main",
          staged: 0,
          unstaged: 9,
          untracked: 0,
          ahead: 0,
          behind: 0,
          files: Array.from({ length: 9 }, (_, i) => ({
            path: `/repo/g${i}.ts`,
            state: "dirty" as const,
          })),
        },
      }),
      ctx(26),
    );
    expect(g.filter((l) => l.item).length).toBe(5);
    expect(g[0]!.body).toContain("1/2");

    const t = new SidebarRenderer(["todo"]).render(
      snap({
        plan: Array.from({ length: 11 }, (_, i) => ({
          content: `task ${i}`,
          status: "pending" as const,
        })),
      }),
      ctx(26),
    );
    expect(t.filter((l) => l.item).length).toBe(5);
    expect(t[0]!.body).toContain("1/3");
  });

  it("does not paginate gadgets with no list", () => {
    const lines = new SidebarRenderer(["activity", "context", "session"]).render(
      snap({
        busySince: 0,
        usage: { used: 1, size: 2 },
        agent: "opencode",
        model: "m",
        mode: "build",
        sessionId: "abc",
      }),
      ctx(26),
    );
    expect(lines.every((l) => pageActions(l).length === 0)).toBe(true);
  });

  // Paging must not invalidate the gadget's memo entry: the cached block is
  // the full list, and the window is applied on top of it.
  it("pages without re-rendering the gadget", () => {
    const r = new SidebarRenderer(["files"]);
    const s = files(12);
    const page0 = r.render(s, { ...ctx(26), pages: { files: 0 } });
    const page1 = r.render(s, { ...ctx(26), pages: { files: 1 } });
    const back = r.render(s, { ...ctx(26), pages: { files: 0 } });
    // Same row objects from the cache on the way back.
    expect(back.filter((l) => l.item)).toEqual(page0.filter((l) => l.item));
    expect(page1.filter((l) => l.item)).not.toEqual(page0.filter((l) => l.item));
  });
});

// Pagination is a response to scarcity, not a fixed rule: eliding items
// while a third of the column sits empty is strictly worse than showing
// them. So the renderer fits the page to the available height — no pager at
// all when everything fits, and the largest page that does fit otherwise.
describe("pagination fits the available height", () => {
  const files = (n: number): SidebarSnapshot =>
    snap({
      editedFiles: Array.from({ length: n }, (_, i) => ({
        path: `/repo/f${i}.ts`,
      })),
    });

  const render = (
    n: number,
    maxRows: number | undefined,
    ids: string[] = ["files"],
  ): ReturnType<SidebarRenderer["render"]> =>
    new SidebarRenderer(ids).render(files(n), { ...ctx(26), maxRows });

  it("shows every item and no pager when there is room", () => {
    const lines = render(12, 40);
    expect(lines.filter((l) => l.item).length).toBe(12);
    expect(lines.every((l) => pageActions(l).length === 0)).toBe(true);
    expect(lines[0]!.body).toContain("edited");
    expect(lines[0]!.body).toContain("12 files");
    expect(lines.length).toBeLessThanOrEqual(40);
  });

  it("paginates once the list cannot fit", () => {
    const lines = render(40, 12);
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines[0]!.actions).toBeDefined();
    expect(lines.filter((l) => l.item).length).toBeLessThan(40);
  });

  // The bug this exists to prevent: snapping to the declared pageSize of 5
  // and leaving the rest of the column blank.
  it("grows the page past the declared default to use the room", () => {
    // Room for well over 5 items, but not all 40.
    const lines = render(40, 16);
    const shown = lines.filter((l) => l.item).length;
    expect(shown).toBeGreaterThan(5);
    expect(lines.length).toBeLessThanOrEqual(16);
  });

  it("uses as much of the column as it can without overflowing", () => {
    for (const maxRows of [8, 10, 12, 16, 20, 24]) {
      const lines = render(40, maxRows);
      expect(lines.length).toBeLessThanOrEqual(maxRows);
      // One more item would not have fit: the fit is tight, not timid.
      const items = lines.filter((l) => l.item).length;
      expect(lines.length + 1).toBeGreaterThan(maxRows);
      expect(items).toBeGreaterThan(0);
    }
  });

  it("accounts for other gadgets competing for the same rows", () => {
    const roomy = render(20, 40, ["activity", "files"]);
    const tight = render(20, 12, ["activity", "files"]);
    expect(roomy.filter((l) => l.item).length).toBeGreaterThan(
      tight.filter((l) => l.item).length,
    );
    expect(tight.length).toBeLessThanOrEqual(12);
  });

  it("counts the border rows against the budget", () => {
    for (const border of ["none", "rule", "frame"] as const) {
      const lines = new SidebarRenderer(["files"]).render(files(40), {
        ...ctx(26, border),
        maxRows: 14,
      });
      expect(lines.length).toBeLessThanOrEqual(14);
    }
  });

  it("keeps the floor of one item per page when nothing fits", () => {
    const lines = render(40, 4);
    expect(lines.filter((l) => l.item).length).toBeGreaterThanOrEqual(1);
    // Overflow is allowed here — the column scrolls, which beats pages of
    // zero items.
    expect(lines.length).toBeGreaterThan(0);
  });

  it("paginates at the declared default when the height is unknown", () => {
    const lines = render(12, undefined);
    expect(lines.filter((l) => l.item).length).toBe(5);
    expect(lines[0]!.body).toContain("1/3");
  });

  it("re-fits when the column grows, dropping the pager", () => {
    const r = new SidebarRenderer(["files"]);
    const s = files(12);
    const tight = r.render(s, { ...ctx(26), maxRows: 10 });
    const roomy = r.render(s, { ...ctx(26), maxRows: 40 });
    expect(tight.some((l) => pageActions(l).length > 0)).toBe(true);
    expect(roomy.every((l) => pageActions(l).length === 0)).toBe(true);
    expect(roomy.filter((l) => l.item).length).toBe(12);
  });

  it("keeps a stale page index harmless once everything fits", () => {
    const lines = new SidebarRenderer(["files"]).render(files(12), {
      ...ctx(26),
      maxRows: 40,
      pages: { files: 2 },
    });
    // Nothing is elided, so the page index has nothing to select.
    expect(lines.filter((l) => l.item).length).toBe(12);
    expect(lines.every((l) => pageActions(l).length === 0)).toBe(true);
  });
});

// The idle readout refreshes on the sidebar ticker's slow cadence, so it
// must not display a precision that cadence can't sustain — exact seconds
// made it jump "4s → 9s → 14s", which reads as a stuttering clock rather
// than a coarse one.
describe("idle counter precision", () => {
  const idleAt = (ms: number): string =>
    activityGadget.render(
      snap({ now: 1_000_000, lastTurnEndedAt: 1_000_000 - ms }),
      ctx(),
    )[0]!.body;

  it("quantizes the displayed value to the refresh step", () => {
    expect(idleAt(4_000)).toContain("0s");
    expect(idleAt(6_000)).toContain("5s");
    expect(idleAt(9_999)).toContain("5s");
    expect(idleAt(10_000)).toContain("10s");
  });

  it("holds steady between refreshes rather than stepping every second", () => {
    const within = [5_000, 6_200, 7_500, 9_900].map(idleAt);
    expect(new Set(within).size).toBe(1);
  });

  it("advances at the step boundary", () => {
    expect(idleAt(9_900)).not.toBe(idleAt(10_100));
  });

  // An un-quantized key re-rendered the gadget every second to produce
  // byte-identical output.
  it("changes its version key only when the display changes", () => {
    const key = (ms: number): string =>
      activityGadget.versionKey(
        snap({ now: 1_000_000, lastTurnEndedAt: 1_000_000 - ms }),
        ctx(),
      );
    expect(key(5_000)).toBe(key(9_900));
    expect(key(9_900)).not.toBe(key(10_100));
  });

  // The busy counter is on the fast tick, so it keeps second precision.
  it("leaves the thinking counter at one-second precision", () => {
    const busy = (ms: number): string =>
      activityGadget.render(
        snap({ now: 1_000_000, busySince: 1_000_000 - ms }),
        ctx(),
      )[0]!.body;
    expect(busy(4_000)).toContain("4s");
    expect(busy(5_000)).toContain("5s");
  });
});

describe("quantizeDuration", () => {
  it("rounds down to the step", () => {
    expect(quantizeDuration(0, 5_000)).toBe(0);
    expect(quantizeDuration(4_999, 5_000)).toBe(0);
    expect(quantizeDuration(5_000, 5_000)).toBe(5_000);
    expect(quantizeDuration(12_345, 5_000)).toBe(10_000);
  });

  it("clamps negatives and tolerates a zero step", () => {
    expect(quantizeDuration(-9, 5_000)).toBe(0);
    expect(quantizeDuration(1_234, 0)).toBe(1_234);
  });
});

describe("sessions gadget", () => {
  const live = (
    label: string,
    opts: { busy?: boolean; armed?: boolean; waiting?: boolean } = {},
  ): SidebarLiveSession => ({
    sessionId: `hydra_session_${label}`,
    label,
    busy: opts.busy === true,
    armed: opts.armed === true,
    waiting: opts.waiting === true,
  });

  it("hides itself when there are no other live sessions", () => {
    expect(sessionsGadget.relevant(snap())).toBe(false);
    expect(sessionsGadget.relevant(snap({ liveSessions: [live("a")] }))).toBe(true);
  });

  // The two axes are independent, which is the point of the layout: the
  // right-hand bubble is busy/idle, the left-hand marker is waiting-or-not,
  // and all four combinations have to be distinguishable.
  it("shows busy and waiting independently", () => {
    const lines = sessionsGadget.render(
      snap({
        liveSessions: [
          live("both", { busy: true, waiting: true }),
          live("justbusy", { busy: true }),
          live("justwaiting", { waiting: true }),
          live("quiet"),
        ],
      }),
      ctx(26),
    );
    // The two-cell marker IS the body; the label rides in the prefix so the
    // marker can be coloured on its own.
    const marker = (name: string): string =>
      lines.find((l) => (l.prefix ?? "").includes(name))!.body;
    expect(marker("both")).toBe("◦●");
    expect(marker("justbusy")).toBe(" ●");
    expect(marker("justwaiting")).toBe("◦○");
    expect(marker("quiet")).toBe(" ○");
  });

  // A session that armed a background task and handed the turn back is
  // still working: `hydra session list` and the picker both call it BUSY.
  // Here it gets its own glyph but busy's colour, so it reads as active at a
  // glance without claiming a turn is in flight.
  it("marks a session with an armed background task as working", () => {
    const row = (e: SidebarLiveSession) =>
      sessionsGadget.render(snap({ liveSessions: [e] }), ctx(26))[0]!;
    const armed = row(live("armed", { armed: true }));
    expect(armed.body).toBe(" ◐");
    expect(armed.bodyStyle).toBe("status-active");
    expect(armed.prefixStyle).toBe("status-active");
    // Same accent as a mid-turn session, different shape.
    const busy = row(live("busy", { busy: true }));
    expect(armed.bodyStyle).toBe(busy.bodyStyle);
    expect(armed.body).not.toBe(busy.body);
    // The waiting cell is independent of it, like it is of busy.
    expect(row(live("both", { armed: true, waiting: true })).body).toBe("◦◐");
  });

  // A turn in flight outranks a mere armed task, and an armed task outranks
  // quiet — otherwise a session that will restart itself sinks in with the
  // ones that are done.
  it("sorts waiting first, then busy, then armed, then quiet", () => {
    const lines = sessionsGadget.render(
      snap({
        liveSessions: [
          live("quiet"),
          live("justarmed", { armed: true }),
          live("justbusy", { busy: true }),
          live("justwaiting", { waiting: true }),
          live("both", { busy: true, waiting: true }),
        ],
      }),
      ctx(26),
    );
    expect(lines.map((l) => l.doubleAction!.value.split("_").pop())).toEqual([
      "both",
      "justwaiting",
      "justbusy",
      "justarmed",
      "quiet",
    ]);
  });

  // Labels stay flush left, like every other gadget's rows — the markers
  // hang off the right instead of indenting the block. And the marker slot
  // is two cells whether or not the ◦ is there, so the bubbles line up.
  it("keeps labels flush left and bubbles in one column", () => {
    const lines = sessionsGadget.render(
      snap({ liveSessions: [live("aaa", { waiting: true }), live("bbb")] }),
      ctx(26),
    );
    for (const line of lines) {
      expect(line.prefix!.startsWith(" ")).toBe(false);
      expect(stringWidth(line.body)).toBe(2);
      expect(stringWidth(rowText(line))).toBe(26);
    }
  });

  // Quiet labels dim away; anything working or wanting attention stays at
  // full brightness.
  // The labels are values, like the agent and model in the info gadget, and read
  // the same whatever the session is doing. They used to carry the state: idle
  // took `status-idle`, which is the common case, so the list read as dim and
  // unimportant — and `status-waiting` is the same muted grey, so a session
  // blocked on the user was dimmed too. State belongs to the marker, which
  // carries it as both a glyph and a colour.
  it("keeps busy loud and leaves the rest legible", () => {
    const labelStyle = (e: SidebarLiveSession): string | undefined =>
      sessionsGadget.render(snap({ liveSessions: [e] }), ctx(26))[0]!.prefixStyle;
    // Working is the one state worth pulling the eye across the whole row,
    // whether the work is a turn or a background task it armed.
    expect(labelStyle(live("b", { busy: true }))).toBe("status-active");
    expect(labelStyle(live("r", { armed: true }))).toBe("status-active");
    // The rest read as values, like the agent and model in the info gadget.
    // Neither may be `status-idle`, which is what made the list look dim, nor
    // undefined, which would silently inherit the marker's colour.
    expect(labelStyle(live("quiet"))).toBe("sidebar-value");
    expect(labelStyle(live("w", { waiting: true }))).toBe("sidebar-value");
  });

  // What the labels stopped carrying, the marker must still carry — otherwise
  // dropping the dim would have dropped the signal with it.
  it("still distinguishes every state on the marker", () => {
    const row = (e: SidebarLiveSession) =>
      sessionsGadget.render(snap({ liveSessions: [e] }), ctx(26))[0]!;
    const states = [
      live("quiet"),
      live("b", { busy: true }),
      live("r", { armed: true }),
      live("w", { waiting: true }),
    ].map((e) => `${row(e).body}|${row(e).bodyStyle}`);
    expect(new Set(states).size).toBe(states.length);
  });

  // The working bubble carries the same yellow accent as the banner and the
  // activity gadget. Nothing here is red: red means failure elsewhere in the
  // TUI, and a session on a permission prompt hasn't failed.
  it("paints the working bubble with the active accent, and nothing red", () => {
    const bubbleStyle = (e: SidebarLiveSession): string | undefined =>
      sessionsGadget.render(snap({ liveSessions: [e] }), ctx(26))[0]!.bodyStyle;
    // status-active, shared with the banner and the activity gadget, rather
    // than tool-status-running — a peer session being in a turn is not a tool
    // call. Waiting has its own token even though it renders like idle.
    expect(bubbleStyle(live("b", { busy: true }))).toBe("status-active");
    expect(bubbleStyle(live("w", { waiting: true }))).toBe("status-waiting");
    expect(bubbleStyle(live("quiet"))).toBe("status-idle");
    for (const e of [
      live("b", { busy: true }),
      live("w", { waiting: true }),
      live("both", { busy: true, waiting: true }),
    ]) {
      const line = sessionsGadget.render(snap({ liveSessions: [e] }), ctx(26))[0]!;
      expect([line.bodyStyle, line.prefixStyle]).not.toContain("tool-status-fail");
    }
  });

  // Double-click names its intent ("go to this session") rather than
  // encoding it in a URL for the link dispatcher to parse back out. Same
  // action the sessionbar's btw session-id chunk uses.
  it("carries an open-session action, and no link span", () => {
    const line = sessionsGadget.render(
      snap({ liveSessions: [live("blocked", { waiting: true })] }),
      ctx(26),
    )[0]!;
    expect(line.doubleAction).toEqual({
      action: "open-session",
      value: "hydra_session_blocked",
    });
    expect(line.openPath).toBeUndefined();
    // No openSpan: the screen layer only paints an OSC 8 link for
    // filesystem paths. See the gadget's header comment.
    expect(line.openSpan).toBeUndefined();
  });

  // The counter is folded-only. Open, the rows already sort waiting first
  // and carry their own markers; folded, it is the only thing left that can
  // say something is blocked on you.
  it("notes the waiting count only when folded", () => {
    const s = snap({
      liveSessions: [live("a", { waiting: true }), live("b", { busy: true })],
    });
    expect(sessionsGadget.titleNote!(s, ctx(26), false)).toBeUndefined();
    expect(sessionsGadget.titleNote!(s, ctx(26), true)).toBe("1 waiting");
  });

  it("falls back to the live count when nothing is waiting, folded", () => {
    const s = snap({
      liveSessions: [live("a", { busy: true }), live("b")],
    });
    expect(sessionsGadget.titleNote!(s, ctx(26), true)).toBe("2 live");
  });

  it("keeps every session row inside the column", () => {
    for (const width of [14, 20, 26]) {
      for (const line of sessionsGadget.render(
        snap({
          liveSessions: [live("a-very-long-session-title-indeed", { waiting: true })],
        }),
        ctx(width),
      )) {
        expect(stringWidth(rowText(line))).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("resources gadget", () => {
  const usage = (patch: Partial<SidebarProcUsage> = {}): SidebarProcUsage => ({
    label: "hydra",
    rssBytes: 142 * 1024 * 1024,
    cpuFraction: 0.031,
    processes: 1,
    ...patch,
  });

  it("hides itself when there is nothing to report", () => {
    expect(resourcesGadget.relevant(snap())).toBe(false);
    expect(resourcesGadget.relevant(snap({ resources: [usage()] }))).toBe(true);
  });

  it("renders one row per tree, memory then cpu", () => {
    const lines = resourcesGadget.render(
      snap({
        resources: [
          usage(),
          usage({ label: "agent", rssBytes: 1.25 * 1024 ** 3, cpuFraction: 0.87, processes: 4 }),
        ],
      }),
      ctx(26),
    );
    expect(lines).toHaveLength(2);
    const rows = lines.map(rowText);
    expect(rows[0]).toContain("hydra");
    expect(rows[0]).toContain("142M");
    expect(rows[1]).toContain("agent");
    // 1.25 GiB rounds to 1.3, not truncates to 1.2.
    expect(rows[1]).toContain("1.3G");
    expect(rows[1]).toContain("87.0%");
  });

  // "×1" is noise; a real tree is worth flagging.
  it("shows the process count only for a multi-process tree", () => {
    const one = rowText(
      resourcesGadget.render(snap({ resources: [usage()] }), ctx(26))[0]!,
    );
    const many = rowText(
      resourcesGadget.render(
        snap({ resources: [usage({ processes: 6 })] }),
        ctx(26),
      )[0]!,
    );
    expect(one).not.toContain("×");
    expect(many).toContain("×6");
  });

  it("stays inside the column", () => {
    for (const width of [14, 20, 26, 40]) {
      const lines = resourcesGadget.render(
        snap({
          resources: [usage({ label: "a-very-long-label-indeed", processes: 12 })],
        }),
        ctx(width),
      );
      for (const line of lines) {
        expect(stringWidth(rowText(line))).toBeLessThanOrEqual(width);
      }
    }
  });

  // Sampling produces new byte counts constantly; keying on raw values would
  // re-render the gadget every tick to emit identical text.
  it("keys its version on the displayed text, not the raw numbers", () => {
    const key = (rssBytes: number): string =>
      resourcesGadget.versionKey(snap({ resources: [usage({ rssBytes })] }), ctx(26));
    // Both round to the same displayed megabytes.
    expect(key(142 * 1024 ** 2)).toBe(key(142 * 1024 ** 2 + 5000));
    expect(key(142 * 1024 ** 2)).not.toBe(key(200 * 1024 ** 2));
  });
});

describe("formatBytes", () => {
  it("scales units and keeps the string short", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(900)).toBe("900B");
    expect(formatBytes(64 * 1024)).toBe("64K");
    expect(formatBytes(5.5 * 1024 ** 2)).toBe("5.5M");
    expect(formatBytes(142 * 1024 ** 2)).toBe("142M");
    expect(formatBytes(1.25 * 1024 ** 3)).toBe("1.3G");
    expect(formatBytes(1.24 * 1024 ** 3)).toBe("1.2G");
  });
});

describe("formatCpu", () => {
  it("reports a fraction of one core as a percentage", () => {
    expect(formatCpu(0).trim()).toBe("0.0%");
    expect(formatCpu(0.031).trim()).toBe("3.1%");
    expect(formatCpu(0.87).trim()).toBe("87.0%");
  });

  // A tree spanning cores really does exceed 100%; clamping would misreport
  // exactly the situation the row exists to surface.
  it("does not clamp at one core", () => {
    expect(formatCpu(3.4).trim()).toBe("340%");
  });

  it("distinguishes 'no reading yet' from zero", () => {
    expect(formatCpu(undefined).trim()).toBe("–");
    expect(formatCpu(0)).not.toBe(formatCpu(undefined));
  });

  // The field is padded so the rows column up: the value is right-aligned
  // as a whole, so a ragged CPU field walks the memory figure sideways.
  it("pads every reading to one width", () => {
    const widths = [undefined, 0, 0.031, 0.87, 3.4, 12].map(
      (f) => formatCpu(f).length,
    );
    expect(new Set(widths).size).toBe(1);
  });
});

describe("file row link spans", () => {
  it("spans only the name in a files row that carries a +/- delta", () => {
    const lines = filesGadget.render(
      {
        ...emptySnapshot(),
        editedFiles: [{ path: "/repo/src/alpha.ts", added: 3, removed: 1 }],
      },
      ctx(30),
    );
    const fileLine = lines.find((l) => l.openPath !== undefined);
    expect(fileLine).toBeDefined();
    expect(fileLine?.openSpan).toBeDefined();
    const { start, end } = fileLine!.openSpan!;
    const body = fileLine!.body ?? "";
    // The bracketed run is the name alone: no delta, no gap padding.
    expect(body.slice(start, end)).toBe("alpha.ts");
    expect(body).toContain("+3 -1");
  });

  it("spans only the name in a git row, excluding the state word", () => {
    const lines = gitGadget.render(
      {
        ...emptySnapshot(),
        git: {
          branch: "main",
          ahead: 0,
          behind: 0,
          staged: 0,
          unstaged: 1,
          untracked: 0,
          files: [{ path: "/repo/src/beta.ts", state: "dirty" }],
        },
      },
      ctx(30),
    );
    const fileLine = lines.find((l) => l.openPath !== undefined);
    expect(fileLine).toBeDefined();
    const { start, end } = fileLine!.openSpan!;
    const body = fileLine!.body ?? "";
    expect(body.slice(start, end)).toBe("beta.ts");
    // The state word is in the body but outside the span: only the name is
    // a link target, so a click on "dirty" doesn't try to open a file.
    expect(body).toContain("dirty");
    expect(end).toBeLessThan(body.length);
    expect(start).toBe(0);
  });
});

describe("running-tools row link span", () => {
  const running = (path: string | undefined, detail: string) => ({
    ...emptySnapshot(),
    now: 1_000,
    running: [{ verb: "Read", detail, path, startedAt: 0 }],
  });

  it("spans the basename when it is visible in the row", () => {
    const lines = toolsGadget.render(running("/repo/src/gamma.ts", "src/gamma.ts"), ctx(40));
    const l = lines.find((x: SidebarLine) => x.openPath !== undefined);
    expect(l?.openSpan).toBeDefined();
    const { start, end } = l!.openSpan!;
    expect((l!.body ?? "").slice(start, end)).toBe("gamma.ts");
  });

  it("omits the span when the row shows a command instead of the path", () => {
    const lines = toolsGadget.render(
      running("/repo/src/gamma.ts", "pnpm test --run"),
      ctx(40),
    );
    const l = lines.find((x: SidebarLine) => x.openPath !== undefined);
    // Still clickable via openPath, but nothing is underlined: the visible
    // text doesn't name the file.
    expect(l?.openPath).toBe("/repo/src/gamma.ts");
    expect(l?.openSpan).toBeUndefined();
  });
});
