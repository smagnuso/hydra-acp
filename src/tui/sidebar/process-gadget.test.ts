import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import {
  collectSidebarGadgetCommands,
  collectSidebarGadgetConfigs,
  createProcessGadget,
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
  it("shows a placeholder before the first output arrives", () => {
    const gadget = createProcessGadget({ id: "proc:x", script: "echo hi" });
    const lines = gadget.render(snap(new Map()), ctx());
    expect(lines).toEqual([{ body: "…", bodyStyle: "muted" }]);
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

  it("is always relevant — presence in config is the signal to show it", () => {
    const gadget = createProcessGadget({ id: "proc:x", script: "echo hi" });
    expect(gadget.relevant(snap(new Map()))).toBe(true);
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
});
