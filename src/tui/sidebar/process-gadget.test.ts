import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import {
  collectSidebarGadgetCommands,
  collectSidebarGadgetConfigs,
  createProcessGadget,
  extractMarkdownLinks,
  sanitizeProcessOutput,
  sidebarGadgetId,
} from "./process-gadget.js";
import { emptySnapshot } from "./types.js";
import type { SidebarBorder, SidebarContext, SidebarSnapshot } from "./types.js";

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

const snap = (processOutputs: ReadonlyMap<string, string>): SidebarSnapshot => ({
  ...emptySnapshot(1_000_000),
  processOutputs,
});

describe("sanitizeProcessOutput", () => {
  it("strips ANSI escapes but keeps newlines", () => {
    expect(sanitizeProcessOutput("\x1b[31mred\x1b[0m\nplain")).toBe(
      "red\nplain",
    );
  });

  it("returns null for output that's empty once trimmed", () => {
    expect(sanitizeProcessOutput("   \n  \n")).toBeNull();
  });

  it("trims leading/trailing whitespace", () => {
    expect(sanitizeProcessOutput("\n  hello  \n")).toBe("hello");
  });
});

describe("extractMarkdownLinks", () => {
  it("passes plain text through unchanged with no links", () => {
    expect(extractMarkdownLinks("no links here")).toEqual({
      body: "no links here",
      links: [],
    });
  });

  it("extracts a single link, stripping the markup down to its text", () => {
    const { body, links } = extractMarkdownLinks(
      "[#37140](https://github.netflix.net/corp/nrdp-nrdp/pull/37140)",
    );
    expect(body).toBe("#37140");
    expect(links).toEqual([
      {
        start: 0,
        end: 6,
        url: "https://github.netflix.net/corp/nrdp-nrdp/pull/37140",
      },
    ]);
  });

  it("extracts a link surrounded by other text, with correct offsets", () => {
    const { body, links } = extractMarkdownLinks("see [PR](http://x) now");
    expect(body).toBe("see PR now");
    expect(links).toEqual([{ start: 4, end: 6, url: "http://x" }]);
    expect(body.slice(links[0]!.start, links[0]!.end)).toBe("PR");
  });

  it("handles balanced parens inside the URL", () => {
    const { body, links } = extractMarkdownLinks("[x](http://a.com/(b))");
    expect(body).toBe("x");
    expect(links).toEqual([{ start: 0, end: 1, url: "http://a.com/(b)" }]);
  });

  it("handles multiple links on one line", () => {
    const { body, links } = extractMarkdownLinks(
      "[a](http://a) and [b](http://b)",
    );
    expect(body).toBe("a and b");
    expect(links).toEqual([
      { start: 0, end: 1, url: "http://a" },
      { start: 6, end: 7, url: "http://b" },
    ]);
  });

  it("leaves an unclosed bracket as literal text", () => {
    expect(extractMarkdownLinks("[not a link")).toEqual({
      body: "[not a link",
      links: [],
    });
  });

  it("leaves an unbalanced-paren URL as literal text", () => {
    const text = "[x](http://unclosed";
    expect(extractMarkdownLinks(text)).toEqual({ body: text, links: [] });
  });

  it("does not treat [text] with no following ( as a link", () => {
    expect(extractMarkdownLinks("[just brackets] plain")).toEqual({
      body: "[just brackets] plain",
      links: [],
    });
  });
});

describe("sidebarGadgetId / collectSidebarGadgetConfigs", () => {
  it("extracts the id from both string and object entries", () => {
    expect(sidebarGadgetId("activity")).toBe("activity");
    expect(sidebarGadgetId({ id: "proc:x", script: "echo hi" })).toBe(
      "proc:x",
    );
  });

  it("filters a mixed list down to object-form entries", () => {
    const entries = [
      "activity",
      { id: "proc:a", script: "echo a" },
      "git",
      { id: "proc:b", script: "echo b", cap: 3 },
    ];
    expect(collectSidebarGadgetConfigs(entries)).toEqual([
      { id: "proc:a", script: "echo a" },
      { id: "proc:b", script: "echo b", cap: 3 },
    ]);
  });
});

describe("collectSidebarGadgetCommands", () => {
  it("collapses a command shared by two gadgets to the minimum refreshMs", () => {
    const commands = collectSidebarGadgetCommands(
      [
        { id: "proc:a", script: "echo hi", refreshMs: 10_000 },
        { id: "proc:b", script: "echo hi", refreshMs: 2_000 },
      ],
      5_000,
    );
    expect(commands.get("echo hi")).toBe(2_000);
  });

  it("falls back to the default refresh when unset", () => {
    const commands = collectSidebarGadgetCommands(
      [{ id: "proc:a", script: "echo hi" }],
      5_000,
    );
    expect(commands.get("echo hi")).toBe(5_000);
  });
});

describe("createProcessGadget", () => {
  it("is not relevant before the first output arrives", () => {
    const gadget = createProcessGadget({ id: "proc:x", script: "echo hi" });
    expect(gadget.relevant(snap(new Map()))).toBe(false);
  });

  it("becomes relevant once output exists for its command", () => {
    const gadget = createProcessGadget({ id: "proc:x", script: "echo hi" });
    expect(gadget.relevant(snap(new Map([["echo hi", "one"]])))).toBe(true);
  });

  it("renders nothing when called without output (defensive, relevant() gates this)", () => {
    const gadget = createProcessGadget({ id: "proc:x", script: "echo hi" });
    expect(gadget.render(snap(new Map()), ctx())).toEqual([]);
  });

  it("splits output into lines, dropping blanks", () => {
    const gadget = createProcessGadget({ id: "proc:x", script: "echo hi" });
    const lines = gadget.render(
      snap(new Map([["echo hi", "one\n\ntwo\nthree"]])),
      ctx(),
    );
    expect(lines.map((l) => l.body)).toEqual(["one", "two", "three"]);
  });

  it("caps at the configured line count with a '+N more' row", () => {
    const gadget = createProcessGadget({
      id: "proc:x",
      script: "seq 5",
      cap: 2,
    });
    const lines = gadget.render(
      snap(new Map([["seq 5", "1\n2\n3\n4\n5"]])),
      ctx(),
    );
    expect(lines.map((l) => l.body)).toEqual(["1", "2", "  +3 more"]);
    expect(lines[2]!.bodyStyle).toBe("muted");
  });

  it("does not cap when under the limit", () => {
    const gadget = createProcessGadget({
      id: "proc:x",
      script: "echo hi",
      cap: 10,
    });
    const lines = gadget.render(
      snap(new Map([["echo hi", "one\ntwo"]])),
      ctx(),
    );
    expect(lines.map((l) => l.body)).toEqual(["one", "two"]);
  });

  it("truncates a line to the available width", () => {
    const gadget = createProcessGadget({ id: "proc:x", script: "echo hi" });
    const lines = gadget.render(
      snap(new Map([["echo hi", "a".repeat(50)]])),
      ctx(10),
    );
    expect(lines[0]!.body.length).toBeLessThanOrEqual(10);
  });

  it("keys output lookup by the configured script, not the gadget id", () => {
    const gadget = createProcessGadget({
      id: "proc:x",
      script: "some command",
    });
    const lines = gadget.render(
      snap(new Map([["some command", "hit"], ["proc:x", "miss"]])),
      ctx(),
    );
    expect(lines.map((l) => l.body)).toEqual(["hit"]);
  });

  it("versionKey changes when the command's output changes", () => {
    const gadget = createProcessGadget({ id: "proc:x", script: "echo hi" });
    const a = gadget.versionKey(snap(new Map([["echo hi", "one"]])), ctx());
    const b = gadget.versionKey(snap(new Map([["echo hi", "two"]])), ctx());
    expect(a).not.toBe(b);
  });

  it("versionKey changes when the column width changes", () => {
    const gadget = createProcessGadget({ id: "proc:x", script: "echo hi" });
    const snapshot = snap(new Map([["echo hi", "one"]]));
    expect(gadget.versionKey(snapshot, ctx(20))).not.toBe(
      gadget.versionKey(snapshot, ctx(30)),
    );
  });

  it("defaults the title to the gadget id when unset", () => {
    const gadget = createProcessGadget({ id: "proc:x", script: "echo hi" });
    expect(gadget.title).toBe("proc:x");
  });

  it("uses the configured title when given", () => {
    const gadget = createProcessGadget({
      id: "proc:x",
      script: "echo hi",
      title: "My Log",
    });
    expect(gadget.title).toBe("My Log");
  });

  it("renders a markdown link as a stripped body with a links span", () => {
    const gadget = createProcessGadget({ id: "proc:x", script: "gh_pr" });
    const lines = gadget.render(
      snap(new Map([["gh_pr", "[#37140](https://example.com/pull/37140)"]])),
      ctx(),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.body).toBe("#37140");
    expect(lines[0]!.links).toEqual([
      { start: 0, end: 6, url: "https://example.com/pull/37140" },
    ]);
  });

  it("leaves a link-less line with no links field", () => {
    const gadget = createProcessGadget({ id: "proc:x", script: "echo hi" });
    const lines = gadget.render(
      snap(new Map([["echo hi", "plain text"]])),
      ctx(),
    );
    expect(lines[0]!.links).toBeUndefined();
  });

  it("clips a link span that gets partially truncated", () => {
    const gadget = createProcessGadget({ id: "proc:x", script: "gh_pr" });
    // Body is "#37140 some long trailing text" — truncate to 4 columns so
    // the link span (0-6, "#37140") is cut mid-span.
    const lines = gadget.render(
      snap(
        new Map([
          [
            "gh_pr",
            "[#37140](https://example.com/pull/37140) some long trailing text",
          ],
        ]),
      ),
      ctx(4),
    );
    expect(lines[0]!.body).toBe("#371");
    expect(lines[0]!.links).toEqual([
      { start: 0, end: 4, url: "https://example.com/pull/37140" },
    ]);
  });

  it("drops a link span that gets fully truncated away", () => {
    const gadget = createProcessGadget({ id: "proc:x", script: "gh_pr" });
    const lines = gadget.render(
      snap(
        new Map([["gh_pr", "prefix text [link](http://x) more text here"]]),
      ),
      ctx(6),
    );
    expect(lines[0]!.body).toBe("prefix");
    expect(lines[0]!.links).toBeUndefined();
  });
});
