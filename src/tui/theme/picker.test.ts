// The ^O picker's mechanics, without driving the modal: the list it cycles
// through, and that each entry actually applies.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listThemes, loadTheme } from "./load.js";
import { DEFAULT_PALETTE, resolveStyle, setTheme } from "./index.js";
import { builtinNames, stepTheme } from "./builtins.js";

afterEach(() => setTheme(DEFAULT_PALETTE));

describe("listThemes", () => {
  it("offers every built-in", async () => {
    const names = (await listThemes(await mkdtemp(join(tmpdir(), "t-")))).map(
      (t) => t.name,
    );
    expect(names).toEqual(builtinNames());
  });

  it("includes user files, and lists them after the built-ins", async () => {
    const d = await mkdtemp(join(tmpdir(), "t-"));
    await writeFile(join(d, "mine.json"), '{"extends":"nord"}');
    await writeFile(join(d, "notes.txt"), "ignored");
    const names = (await listThemes(d)).map((t) => t.name);
    expect(names).toEqual([...builtinNames(), "mine"]);
  });

  it("does not duplicate a user file that shadows a built-in", async () => {
    const d = await mkdtemp(join(tmpdir(), "t-"));
    await writeFile(join(d, "nord.json"), '{"palette":{"brightYellow":"#010203"}}');
    const list = await listThemes(d);
    expect(list.filter((t) => t.name === "nord")).toHaveLength(1);
    // …and the shadowing file is what got loaded.
    setTheme(list.find((t) => t.name === "nord")!.palette);
    expect(resolveStyle("status-active", "truecolor").open).toBe(
      "\x1b[38;2;1;2;3m",
    );
  });

  it("keeps a broken user theme from removing the other choices", async () => {
    // Selecting it still reports its problems through loadTheme; it just must
    // not empty the picker.
    const d = await mkdtemp(join(tmpdir(), "t-"));
    await writeFile(join(d, "bad.json"), "{ not json");
    const names = (await listThemes(d)).map((t) => t.name);
    expect(names).toContain("bad");
    expect(names).toContain("dracula");
  });

  it("every entry applies without error", async () => {
    const d = await mkdtemp(join(tmpdir(), "t-"));
    for (const t of await listThemes(d)) {
      setTheme(t.palette);
      expect(resolveStyle("status-active", "truecolor").open, t.name).toMatch(
        /^\x1b\[/,
      );
    }
  });

  it("cycling wraps and visits each theme once", async () => {
    const list = await listThemes(await mkdtemp(join(tmpdir(), "t-")));
    let name = list[0]!.name;
    const seen: string[] = [];
    for (let i = 0; i < list.length; i++) {
      seen.push(name);
      const at = list.findIndex((t) => t.name === name);
      name = list[(at + 1) % list.length]!.name;
    }
    expect(new Set(seen).size).toBe(list.length);
    expect(name).toBe(list[0]!.name);
  });

  it("an unknown active name still advances rather than sticking", async () => {
    // findIndex returns -1, so (-1 + 1) % n === 0: the cycle lands on the
    // first entry instead of wedging.
    const list = await listThemes(await mkdtemp(join(tmpdir(), "t-")));
    const at = list.findIndex((t) => t.name === "gone");
    expect(list[(at + 1) % list.length]!.name).toBe(list[0]!.name);
  });
});

describe("what the picker persists round-trips", () => {
  it("a saved name reloads to the same palette", async () => {
    // `s` writes tui.theme = activeThemeName, so that name must resolve back.
    const d = await mkdtemp(join(tmpdir(), "t-"));
    for (const { name, palette } of await listThemes(d)) {
      const reloaded = await loadTheme(name, d);
      expect(reloaded.problems, name).toEqual([]);
      expect(reloaded.palette, name).toEqual(palette);
    }
  });
});

describe("mono", () => {
  it("emits no hue anywhere, only the terminal's own grey slots", async () => {
    // The point of mono. Any 38;2 (24-bit) or a cube index outside the greys
    // would mean a colour leaked in.
    const list = await listThemes(await mkdtemp(join(tmpdir(), "t-")));
    const mono = list.find((t) => t.name === "mono")!;
    setTheme(mono.palette, mono.overrides);
    for (const token of [
      "status-active",
      "status-alert",
      "plan-done",
      "notice-error",
      "metric",
      "tool",
      "git-dirty",
      "heading-1",
    ] as const) {
      const open = resolveStyle(token, "truecolor").open;
      expect(open, token).not.toMatch(/38;2;|48;2;/);
      // Only slot codes (30-37/90-97), bold and dim.
      for (const seq of open.match(/\x1b\[(\d+)m/g) ?? []) {
        const n = Number(/(\d+)/.exec(seq)![1]);
        expect([1, 2, 30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97]).toContain(n);
      }
    }
  });

  it("keeps the states that must stand out distinguishable from the quiet ones", async () => {
    // Without hue, the hierarchy has to survive on weight alone.
    const list = await listThemes(await mkdtemp(join(tmpdir(), "t-")));
    const mono = list.find((t) => t.name === "mono")!;
    setTheme(mono.palette, mono.overrides);
    const active = resolveStyle("status-active", "truecolor").open;
    const idle = resolveStyle("status-idle", "truecolor").open;
    const failed = resolveStyle("tool-status-fail", "truecolor").open;
    expect(active).not.toBe(idle);
    expect(failed).not.toBe(resolveStyle("tool-status-ok", "truecolor").open);
    // Failure keeps its bold.
    expect(failed).toContain("\x1b[1m");
  });
});

describe("stepTheme", () => {
  const names = ["a", "b", "c"];

  it("moves both ways", () => {
    expect(stepTheme(names, "a", 1)).toBe("b");
    expect(stepTheme(names, "b", -1)).toBe("a");
  });

  // The reason ←/→ exists: with fifteen builtins, overshooting by one used to
  // cost fourteen more presses.
  it("wraps at both ends", () => {
    expect(stepTheme(names, "c", 1)).toBe("a");
    expect(stepTheme(names, "a", -1)).toBe("c");
  });

  // `tui.theme` given as an inline object resolves to the name "custom", which
  // the picker never lists. Stepping from an unlisted name must still go
  // somewhere sensible rather than off the end of the array.
  it("handles an active theme that is not in the list", () => {
    expect(stepTheme(names, "custom", 1)).toBe("a");
    expect(stepTheme(names, "custom", -1)).toBe("c");
  });

  it("returns undefined for an empty list rather than throwing", () => {
    expect(stepTheme([], "a", 1)).toBeUndefined();
  });

  // Round-tripping is the property the modal actually depends on: press right
  // then left and you are back where you started, from every entry including
  // the ends.
  it("round-trips from every entry", async () => {
    const all = builtinNames();
    for (const name of all) {
      expect(stepTheme(all, stepTheme(all, name, 1)!, -1)).toBe(name);
      expect(stepTheme(all, stepTheme(all, name, -1)!, 1)).toBe(name);
    }
  });
});
