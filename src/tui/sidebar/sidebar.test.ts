import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import {
  activityGadget,
  compactCount,
  contextGadget,
  displayPaths,
  filesGadget,
  gitGadget,
  meterBar,
  shortDuration,
  fitIdentifier,
  sessionGadget,
  todoGadget,
} from "./gadgets.js";
import { SidebarRenderer } from "./registry.js";
import { emptySnapshot } from "./types.js";
import type {
  SidebarBorder,
  SidebarContext,
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

  it("re-renders once per whole second, not per millisecond", () => {
    const base = snap({ busySince: 0 });
    const k = (now: number): string =>
      activityGadget.versionKey({ ...base, now }, ctx());
    expect(k(5_000)).toBe(k(5_400));
    expect(k(5_000)).not.toBe(k(6_000));
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
  it("lists every edited file and heads the block with a count", () => {
    const editedFiles = Array.from({ length: 9 }, (_, i) => ({
      path: `/repo/f${i}.ts`,
    }));
    const lines = filesGadget.render(snap({ editedFiles }), ctx());
    expect(lines[0]!.body).toContain("9 files");
    expect(lines.filter((l) => l.openPath !== undefined)).toHaveLength(9);
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

  it("leaves summary and header rows without a click target", () => {
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
    // branch row + summary row carry no path; only the file row does.
    expect(lines.filter((l) => l.openPath === undefined).length).toBe(2);
  });

  it("lists every changed file, uncapped, alongside the totals", () => {
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
    expect(lines.some((l) => l.body.includes("20 dirty"))).toBe(true);
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

describe("session gadget", () => {
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
    const rows = sessionGadget.render(s, ctx(26)).map(rowText);
    expect(rows.some((b) => b.startsWith("agent"))).toBe(true);
    expect(rows.some((b) => b.startsWith("model"))).toBe(true);
    expect(rows.some((b) => b.startsWith("mode"))).toBe(true);
    expect(rows.some((b) => b.startsWith("sid"))).toBe(true);
  });

  // Colour in the sidebar marks state; these are identity strings, so the
  // label is dim scaffolding and the value keeps the default foreground —
  // matching the sessionbar, which renders agent(model) unstyled too.
  it("dims the labels and leaves the values uncoloured", () => {
    for (const line of sessionGadget.render(s, ctx(26))) {
      expect(line.prefixStyle).toBe("dim");
      expect(line.bodyStyle).toBeUndefined();
    }
  });

  it("drops the provider prefix from a model that doesn't fit", () => {
    const body = sessionGadget
      .render(s, ctx(26))
      .find((l) => rowText(l).startsWith("model"))!.body;
    expect(body).toContain("claude-opus-5");
    expect(body).not.toContain("ncp-anthropic");
  });

  it("keeps the full model when it fits", () => {
    const body = sessionGadget
      .render(s, ctx(40))
      .find((l) => rowText(l).startsWith("model"))!.body;
    expect(body).toContain("ncp-anthropic/claude-opus-5");
  });

  it("omits rows with no value", () => {
    const lines = sessionGadget.render(snap({ agent: "hydra" }), ctx(26));
    expect(lines).toHaveLength(1);
  });

  it("stays inside the column at every width", () => {
    for (const width of [10, 16, 26, 40]) {
      for (const line of sessionGadget.render(s, ctx(width))) {
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
    expect(lines.some((l) => l.actions !== undefined)).toBe(false);
    expect(lines[0]!.body).toBe("edited");
  });

  it("windows a longer list and stamps a pager on the title row", () => {
    const lines = render(12);
    expect(lines.filter((l) => l.item).length).toBe(5);
    expect(lines[0]!.body).toContain("edited");
    expect(lines[0]!.body).toContain("1/3");
    expect(lines[0]!.actions).toBeDefined();
  });

  it("keeps structural rows on every page", () => {
    for (const page of [0, 1, 2]) {
      const lines = render(12, { files: page });
      // Title plus the "N files" summary row survive the window.
      expect(lines.filter((l) => l.item !== true).length).toBe(2);
    }
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
    const first = render(12, { files: 0 })[0]!.actions!;
    expect(first).toHaveLength(1);
    expect(first[0]!.page.index).toBe(1);

    const middle = render(12, { files: 1 })[0]!.actions!;
    expect(middle.map((a) => a.page.index).sort()).toEqual([0, 2]);

    const last = render(12, { files: 2 })[0]!.actions!;
    expect(last).toHaveLength(1);
    expect(last[0]!.page.index).toBe(1);
  });

  it("targets the arrow glyphs' own columns", () => {
    const line = render(12, { files: 1 })[0]!;
    for (const action of line.actions!) {
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
    expect(lines.some((l) => l.actions !== undefined)).toBe(false);
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
    expect(lines.some((l) => l.actions !== undefined)).toBe(false);
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
    expect(lines.some((l) => l.actions !== undefined)).toBe(false);
    expect(lines[0]!.body).toBe("edited");
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
    expect(tight.some((l) => l.actions !== undefined)).toBe(true);
    expect(roomy.some((l) => l.actions !== undefined)).toBe(false);
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
    expect(lines.some((l) => l.actions !== undefined)).toBe(false);
  });
});
