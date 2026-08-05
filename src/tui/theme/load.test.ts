import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTheme } from "./load.js";
import { DEFAULT_PALETTE, resolveStyle, setTheme } from "./index.js";
import { builtinNames } from "./builtins.js";
import { parseColor } from "./color.js";

const dir = async (): Promise<string> =>
  await mkdtemp(join(tmpdir(), "hydra-theme-"));

afterEach(() => {
  setTheme(DEFAULT_PALETTE);
});

describe("loadTheme", () => {
  it("defaults to the terminal palette when unset", async () => {
    for (const empty of [undefined, null]) {
      const t = await loadTheme(empty, await dir());
      expect(t.name).toBe("terminal");
      expect(t.problems).toEqual([]);
      expect(t.palette).toBe(DEFAULT_PALETTE);
    }
  });

  it("resolves every built-in by name", async () => {
    const d = await dir();
    for (const name of builtinNames()) {
      const t = await loadTheme(name, d);
      expect(t.problems, name).toEqual([]);
      expect(t.name).toBe(name);
    }
  });

  it("applies a built-in through the whole token table", async () => {
    const t = await loadTheme("dracula", await dir());
    setTheme(t.palette);
    // dracula's brightYellow, i.e. roles.active, i.e. the busy indicator.
    expect(resolveStyle("status-active", "truecolor").open).toBe(
      "\x1b[38;2;255;255;165m",
    );
  });

  it("derives bands from a declared bg, in the right direction", async () => {
    const band = (): number =>
      Number(/48;2;(\d+)/.exec(resolveStyle("user", "truecolor").open)![1]);

    setTheme((await loadTheme("dracula", await dir())).palette);
    expect(band()).toBeGreaterThan(0x28); // bg #282a36 -> lighter

    setTheme((await loadTheme("solarized-light", await dir())).palette);
    expect(band()).toBeLessThan(0xfd); // bg #fdf6e3 -> darker
  });

  it("keeps a light theme's busy indicator visible", async () => {
    // Solarized's published ANSI mapping puts a GREY in brightYellow, which
    // would make busy indistinguishable from idle. builtins.ts departs from
    // that on purpose; this is the assertion that says so.
    const t = await loadTheme("solarized-light", await dir());
    setTheme(t.palette);
    const active = resolveStyle("status-active", "truecolor").open;
    const [, r, g, b] = /38;2;(\d+);(\d+);(\d+)/.exec(active)!.map(Number);
    // A grey has r ≈ g ≈ b; solarized yellow #b58900 emphatically does not.
    expect(Math.abs(r! - b!)).toBeGreaterThan(60);
  });

  describe("user theme files", () => {
    it("loads one, and extends a built-in", async () => {
      const d = await dir();
      await writeFile(
        join(d, "mine.json"),
        JSON.stringify({
          extends: "nord",
          palette: { brightYellow: "#ff00ff" },
        }),
      );
      const t = await loadTheme("mine", d);
      expect(t.problems).toEqual([]);
      setTheme(t.palette);
      // The override took…
      expect(resolveStyle("status-active", "truecolor").open).toBe(
        "\x1b[38;2;255;0;255m",
      );
      // …and the rest is still nord (its green, via roles.ok).
      expect(resolveStyle("plan-done", "truecolor").open).toBe(
        "\x1b[38;2;163;190;140m",
      );
    });

    it("shadows a built-in of the same name", async () => {
      const d = await dir();
      await writeFile(
        join(d, "dracula.json"),
        JSON.stringify({ palette: { brightYellow: "#010203" } }),
      );
      setTheme((await loadTheme("dracula", d)).palette);
      expect(resolveStyle("status-active", "truecolor").open).toBe(
        "\x1b[38;2;1;2;3m",
      );
    });

    it("refuses a name that could escape the themes directory", async () => {
      const t = await loadTheme("../../etc/passwd", await dir());
      expect(t.problems.join()).toContain("unknown theme");
      expect(t.palette).toBe(DEFAULT_PALETTE);
    });
  });

  describe("problems are reported, never swallowed", () => {
    it("names an unknown theme, and what was expected", async () => {
      const t = await loadTheme("nope", await dir());
      expect(t.problems).toHaveLength(1);
      expect(t.problems[0]).toContain("dracula");
      expect(t.problems[0]).toContain("nope.json");
      // Still renders.
      expect(t.palette).toBe(DEFAULT_PALETTE);
    });

    it("names a misspelt palette slot rather than ignoring it", async () => {
      // The worst outcome for a hand-edited file is a silent no-op.
      const d = await dir();
      await writeFile(join(d, "t.json"), '{"palette":{"rd":"#ff0000"}}');
      const t = await loadTheme("t", d);
      expect(t.problems.join()).toContain('unknown palette slot "rd"');
    });

    it("names a malformed colour and says what is accepted", async () => {
      const d = await dir();
      await writeFile(join(d, "t.json"), '{"palette":{"red":"reddish"}}');
      const t = await loadTheme("t", d);
      expect(t.problems.join()).toContain("is not a colour");
      expect(t.problems.join()).toContain("#rrggbb");
    });

    it("reports malformed JSON with the file path", async () => {
      const d = await dir();
      await writeFile(join(d, "t.json"), "{ not json");
      const t = await loadTheme("t", d);
      expect(t.problems.join()).toContain(join(d, "t.json"));
    });

    it("breaks an extends cycle instead of recursing forever", async () => {
      const d = await dir();
      await writeFile(join(d, "a.json"), '{"extends":"b"}');
      await writeFile(join(d, "b.json"), '{"extends":"a"}');
      const t = await loadTheme("a", d);
      expect(t.problems.join()).toContain("cycle");
    });

    it("rejects a non-object, non-string theme value", async () => {
      const t = await loadTheme([1, 2, 3], await dir());
      expect(t.problems.join()).toContain("must be a theme name or an object");
    });

    it("keeps good keys from a file that also has bad ones", async () => {
      const d = await dir();
      await writeFile(
        join(d, "t.json"),
        '{"palette":{"green":"#00ff00","red":"nope"}}',
      );
      const t = await loadTheme("t", d);
      expect(t.problems).toHaveLength(1);
      setTheme(t.palette);
      expect(resolveStyle("plan-done", "truecolor").open).toBe(
        "\x1b[38;2;0;255;0m",
      );
    });
  });

  it("accepts an inline spec", async () => {
    const t = await loadTheme(
      { extends: "dracula", palette: { brightYellow: "#00ff00" } },
      await dir(),
    );
    expect(t.problems).toEqual([]);
    setTheme(t.palette);
    expect(resolveStyle("status-active", "truecolor").open).toBe(
      "\x1b[38;2;0;255;0m",
    );
  });

  it("accepts every colour syntax parseColor does", async () => {
    const d = await dir();
    await writeFile(
      join(d, "t.json"),
      '{"palette":{"red":"#f00","green":"#00ff00","blue":"rgb(0, 0, 255)"}}',
    );
    const t = await loadTheme("t", d);
    expect(t.problems).toEqual([]);
    expect(t.palette.red).toEqual(parseColor("#ff0000"));
    expect(t.palette.blue).toEqual(parseColor("#0000ff"));
  });
});
