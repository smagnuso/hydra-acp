import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTheme,
  resolveThemeBackground,
  themeBackgroundMismatch,
} from "./load.js";
import {
  DEFAULT_PALETTE,
  elementNames,
  resolveStyle,
  setInlineDepth,
  setTheme,
  type ThemeToken,
} from "./index.js";
import {
  builtinNames,
  builtinTheme,
  defaultThemeFor,
} from "./builtins.js";
import { parseAgentMarkdown } from "../format.js";
import { parseColor, rgb, type Color } from "./color.js";

const dir = async (): Promise<string> =>
  await mkdtemp(join(tmpdir(), "hydra-theme-"));

afterEach(() => {
  setTheme(DEFAULT_PALETTE);
});

const apply = (t: { palette: typeof DEFAULT_PALETTE; overrides: unknown }): void =>
  setTheme(t.palette, t.overrides as Parameters<typeof setTheme>[1]);

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
    apply(t);
    // dracula's yellow #f1fa8c, i.e. roles.active, i.e. the busy indicator.
    expect(resolveStyle("status-active", "truecolor").open).toBe(
      "\x1b[38;2;241;250;140m",
    );
  });

  it("derives bands from a declared bg, in the right direction", async () => {
    const band = (): number =>
      Number(/48;2;(\d+)/.exec(resolveStyle("user", "truecolor").open)![1]);

    apply(await loadTheme("dracula", await dir()));
    expect(band()).toBeGreaterThan(0x28); // bg #282a36 -> lighter

    apply(await loadTheme("solarized-light", await dir()));
    expect(band()).toBeLessThan(0xfd); // bg #fdf6e3 -> darker
  });

  it("keeps a light theme's busy indicator visible", async () => {
    // Solarized's published ANSI mapping puts a GREY in brightYellow, which
    // would make busy indistinguishable from idle. builtins.ts departs from
    // that on purpose; this is the assertion that says so.
    const t = await loadTheme("solarized-light", await dir());
    apply(t);
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
      apply(t);
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
      apply(t);
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
    apply(t);
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

describe("roles and elements overrides", () => {
  it("recolours a role, reaching every token that uses it", async () => {
    // roles.ok is shared by plan-done, notice-ok and meter-fill — the whole
    // point of the role tier.
    const d = await dir();
    await writeFile(join(d, "t.json"), '{"roles":{"ok":"#123456"}}');
    const t = await loadTheme("t", d);
    expect(t.problems).toEqual([]);
    apply(t);
    for (const token of ["plan-done", "notice-ok", "meter-fill"] as const) {
      expect(resolveStyle(token, "truecolor").open, token).toBe(
        "\x1b[38;2;18;52;86m",
      );
    }
  });

  // git-staged used to be on roles.ok, and moved off it: the git tokens are a
  // three-way classification of files, not a status ladder, and "staged" landing
  // on the same green as "succeeded" was a coincidence of both wanting green.
  // While it was shared, recolouring success moved the git list and recolouring
  // the git list moved plan-done, notice-ok and meter-fill. Both directions are
  // pinned here, since a future tidy-up that "deduplicates" the two greens back
  // together would reintroduce it silently.
  it("keeps git status independent of the ok/reference/muted roles", async () => {
    const d = await dir();
    await writeFile(
      join(d, "t.json"),
      '{"roles":{"ok":"#123456","reference":"#123456","muted":"#123456"}}',
    );
    apply(await loadTheme("t", d));
    expect(resolveStyle("git-staged", "truecolor").open).toBe("\x1b[32m");
    expect(resolveStyle("git-dirty", "truecolor").open).toBe("\x1b[94m");
    expect(resolveStyle("git-untracked", "truecolor").open).toBe("\x1b[2m");
  });

  it("recolours git status through its own roles", async () => {
    const d = await dir();
    await writeFile(
      join(d, "t.json"),
      '{"roles":{"gitStaged":"#123456","gitDirty":"#123456","gitUntracked":"#123456"}}',
    );
    const t = await loadTheme("t", d);
    expect(t.problems).toEqual([]);
    apply(t);
    for (const token of ["git-staged", "git-dirty"] as const) {
      expect(resolveStyle(token, "truecolor").open, token).toBe(
        "\x1b[38;2;18;52;86m",
      );
    }
    // Untracked keeps its dim: an override replaces colour, never attributes.
    expect(resolveStyle("git-untracked", "truecolor").open).toBe(
      "\x1b[2m\x1b[38;2;18;52;86m",
    );
    // ...and the status roles it used to borrow stay put.
    expect(resolveStyle("notice-ok", "truecolor").open).toBe("\x1b[32m");
  });

  it("recolours a single element without touching its role's siblings", async () => {
    const d = await dir();
    await writeFile(join(d, "t.json"), '{"elements":{"plan-done":"#123456"}}');
    apply(await loadTheme("t", d));
    expect(resolveStyle("plan-done", "truecolor").open).toBe(
      "\x1b[38;2;18;52;86m",
    );
    // notice-ok shares roles.ok but was not named, so it is unchanged.
    expect(resolveStyle("notice-ok", "truecolor").open).toBe("\x1b[32m");
  });

  it("keeps attributes when a colour is overridden", async () => {
    // heading-1 is bold + active. Recolouring must not unbold it: attributes
    // carry structure, which is why they are not themeable.
    const d = await dir();
    await writeFile(join(d, "t.json"), '{"elements":{"heading-1":"#ff0000"}}');
    apply(await loadTheme("t", d));
    const r = resolveStyle("heading-1", "truecolor");
    expect(r.open).toBe("\x1b[1m\x1b[38;2;255;0;0m");
    expect(r.close).toBe("\x1b[39m\x1b[22m");
  });

  it("a bare colour means bg on a target that has no foreground", async () => {
    // roles.cursor is background-only, so fg would be meaningless there.
    const d = await dir();
    await writeFile(join(d, "t.json"), '{"roles":{"cursor":"#ff0000"}}');
    apply(await loadTheme("t", d));
    expect(resolveStyle("input-cursor", "truecolor").open).toBe(
      "\x1b[48;2;255;0;0m",
    );
  });

  it("reaches a composite role's background through the object form", async () => {
    // roles.selection is bg + fg, so a bare string would be ambiguous; the
    // object form is how you say which.
    const d = await dir();
    await writeFile(
      join(d, "t.json"),
      '{"roles":{"selection":{"bg":"#101010","fg":"#f0f0f0"}}}',
    );
    apply(await loadTheme("t", d));
    expect(resolveStyle("list-selected", "truecolor").open).toBe(
      "\x1b[48;2;16;16;16m\x1b[38;2;240;240;240m",
    );
  });

  it("replaces a band rather than stacking a second background", async () => {
    const d = await dir();
    await writeFile(
      join(d, "t.json"),
      '{"elements":{"code":{"bg":"#202020","fg":"#e0e0e0"}}}',
    );
    apply(await loadTheme("t", d));
    const open = resolveStyle("code", "truecolor").open;
    expect(open).toBe("\x1b[48;2;32;32;32m\x1b[38;2;224;224;224m");
    expect(open.match(/48;2;/g)).toHaveLength(1);
  });

  it("adds a colour the target did not have", async () => {
    // status-ready is deliberately unstyled; a theme may still give it one.
    const d = await dir();
    await writeFile(join(d, "t.json"), '{"elements":{"status-ready":"#00ff00"}}');
    apply(await loadTheme("t", d));
    expect(resolveStyle("status-ready", "truecolor").open).toBe(
      "\x1b[38;2;0;255;0m",
    );
  });

  it("layers over a built-in via extends, and accumulates down the chain", async () => {
    const d = await dir();
    await writeFile(
      join(d, "base.json"),
      '{"extends":"nord","roles":{"ok":"#010101"}}',
    );
    await writeFile(
      join(d, "child.json"),
      '{"extends":"base","roles":{"error":"#020202"}}',
    );
    const t = await loadTheme("child", d);
    expect(t.problems).toEqual([]);
    apply(t);
    // the parent's role survived…
    expect(resolveStyle("plan-done", "truecolor").open).toBe("\x1b[38;2;1;1;1m");
    // …the child's was added…
    expect(resolveStyle("status-alert", "truecolor").open).toBe(
      "\x1b[38;2;2;2;2m",
    );
    // …and nord's palette is still underneath.
    expect(resolveStyle("metric", "truecolor").open).toBe(
      "\x1b[38;2;136;192;208m",
    );
  });

  describe("problems", () => {
    it("names an unknown role and suggests near misses", async () => {
      const d = await dir();
      await writeFile(join(d, "t.json"), '{"roles":{"eror":"#f00"}}');
      const t = await loadTheme("t", d);
      expect(t.problems.join()).toContain('unknown role "eror"');
    });

    it("names an unknown element", async () => {
      const d = await dir();
      await writeFile(join(d, "t.json"), '{"elements":{"plan-dne":"#f00"}}');
      const t = await loadTheme("t", d);
      expect(t.problems.join()).toContain('unknown element "plan-dne"');
      expect(t.problems.join()).toContain("did you mean");
    });

    it("rejects an unknown key inside an override object", async () => {
      const d = await dir();
      await writeFile(join(d, "t.json"), '{"roles":{"ok":{"foreground":"#f00"}}}');
      const t = await loadTheme("t", d);
      expect(t.problems.join()).toContain('unknown key "foreground"');
    });

    it("rejects an empty override object", async () => {
      const d = await dir();
      await writeFile(join(d, "t.json"), '{"roles":{"ok":{}}}');
      const t = await loadTheme("t", d);
      expect(t.problems.join()).toContain("needs at least one of fg or bg");
    });

    it("reports a malformed colour inside an override", async () => {
      const d = await dir();
      await writeFile(join(d, "t.json"), '{"roles":{"ok":{"fg":"nope"}}}');
      const t = await loadTheme("t", d);
      expect(t.problems.join()).toContain("is not a colour");
    });

    it("keeps the good overrides from a block that also has bad ones", async () => {
      const d = await dir();
      await writeFile(
        join(d, "t.json"),
        '{"roles":{"ok":"#00ff00","nope":"#ff0000"}}',
      );
      const t = await loadTheme("t", d);
      expect(t.problems).toHaveLength(1);
      apply(t);
      expect(resolveStyle("plan-done", "truecolor").open).toBe(
        "\x1b[38;2;0;255;0m",
      );
    });
  });
});

describe("agent prose follows the theme's foreground", () => {
  // Reported as "agent prose never changes colour no matter what theme I pick".
  // Half right: with the default palette it SHOULD stay the terminal's own
  // foreground — it is the bulk of the transcript and that is what adapts to a
  // light terminal. But the token had no layers at all rather than roles.fg, so
  // it opted out of the role system entirely and ignored a declared `fg` too.
  it("stays unstyled on the default palette", async () => {
    setTheme(DEFAULT_PALETTE);
    expect(resolveStyle("agent", "truecolor").open).toBe("");
  });

  it("takes a declared fg on every built-in that has one", async () => {
    const d = await dir();
    for (const name of ["dracula", "nord", "gruvbox-dark", "solarized-light"]) {
      const t = await loadTheme(name, d);
      apply(t);
      expect(resolveStyle("agent", "truecolor").open, name).toMatch(/^\x1b\[38;2;/);
    }
  });

  it("is overridable per element like anything else", async () => {
    const d = await dir();
    await writeFile(join(d, "t.json"), '{"elements":{"agent":"#abcdef"}}');
    apply(await loadTheme("t", d));
    expect(resolveStyle("agent", "truecolor").open).toBe(
      "\x1b[38;2;171;205;239m",
    );
  });

  it("keeps carrying inline spans", async () => {
    // agent is inlineSgr: adding a layer must not disturb that, or the trailing
    // reset writeStyled appends would stop firing.
    const d = await dir();
    apply(await loadTheme("dracula", d));
    expect(resolveStyle("agent", "truecolor").inlineSgr).toBe(true);
  });
});

describe("a theme's fg reaches text that has no style of its own", () => {
  // Reported as: mono set as the default, restarted, and some text still green
  // — the user's terminal having a green default foreground. Two separate bugs
  // of the same family, both about text falling back to the TERMINAL's
  // foreground rather than the THEME's.
  it("closes an inline span back to the theme's fg, not the terminal's", async () => {
    // The precise symptom: "**A now** — rest of line" rendered green to end of
    // line and correct on the next wrapped row, because the row re-emits the
    // token's open while the span's closer had reset to nothing.
    const d = await dir();
    apply(await loadTheme("mono", d));
    const body = parseAgentMarkdown("do **A** then more text")[0]!.body;
    // After the bold close, the base colour is re-asserted.
    expect(body).toContain("\x1b[0m\x1b[37m then more text");
  });

  it("leaves prose alone on the default palette", async () => {
    setTheme(DEFAULT_PALETTE);
    const body = parseAgentMarkdown("do **A** then more text")[0]!.body;
    // Nothing re-asserted: inheriting the terminal is correct here.
    expect(body).toBe("do \x1b[1mA\x1b[0m then more text");
  });

  it("styles chrome text that has no token of its own", async () => {
    // The sessionbar's agent cell, a session row, composer text. Unstyled
    // writes ignored a declared fg, so a themed transcript sat above an
    // unthemed sessionbar.
    apply(await loadTheme("mono", await dir()));
    expect(resolveStyle("content", "truecolor").open).toBe("\x1b[37m");
  });

  it("keeps that chrome text unstyled on the default palette", async () => {
    setTheme(DEFAULT_PALETTE);
    expect(resolveStyle("content", "truecolor").open).toBe("");
  });
});

describe("no token is left inheriting the terminal's foreground", () => {
  // The bug this catches showed up three times in a row, each time as "some
  // text is still green" on a terminal whose default foreground is green:
  //
  //   1. `agent` had no layers at all, so prose ignored a declared fg.
  //   2. prose's inline-span closer reset to nothing, so text after a **bold**
  //      span fell back to the terminal until the next wrapped row.
  //   3. every attribute-only token — bold rules, the bold `user` band, the two
  //      dozen dim ones — named no foreground either.
  //
  // Each was found by eye. This finds the whole class: for a theme that declares
  // `fg`, no token may resolve to a bare attribute with no colour at all.
  it.each(["dracula", "nord", "gruvbox-dark", "solarized-light", "mono"])(
    "%s",
    async (name) => {
      const t = await loadTheme(name, await dir());
      apply(t);
      const bare: string[] = [];
      for (const token of elementNames()) {
        const { open } = resolveStyle(token as ThemeToken, "truecolor");
        const fg = /\x1b\[(3[0-79]|9[0-7]|38;)/.test(open);
        const bg = /\x1b\[(4[0-79]|10[0-7]|48;)/.test(open);
        if (!fg && !bg) {
          bare.push(token);
        }
      }
      expect(bare).toEqual([]);
    },
  );

  it("stays a no-op on the default palette", () => {
    // The terminal palette declares no fg, so inheriting is correct there and
    // nothing should be added.
    setTheme(DEFAULT_PALETTE);
    expect(resolveStyle("rule", "truecolor").open).toBe("\x1b[1m");
    expect(resolveStyle("muted", "truecolor").open).toBe("\x1b[2m");
    expect(resolveStyle("agent", "truecolor").open).toBe("");
  });

  it("does not force a foreground onto a block cursor", async () => {
    // A cursor sets its own background, so the automatic rule must leave it
    // alone — painting the theme's foreground over it risks white on white.
    // dracula sets no cursor override, so only the automatic rule is in play.
    apply(await loadTheme("dracula", await dir()));
    const open = resolveStyle("input-cursor", "truecolor").open;
    expect(open).toMatch(/^\x1b\[48;2;/);
    expect(open).not.toMatch(/38;2;|\x1b\[3[0-79]m/);
  });

  it("lets a theme set the pair explicitly where the automatic rule cannot", async () => {
    // mono's palette is uniform, so a fg/bg pair would collapse. It states the
    // pair instead: white block, dark character.
    apply(await loadTheme("mono", await dir()));
    expect(resolveStyle("input-cursor", "truecolor").open).toBe(
      "\x1b[107m\x1b[30m",
    );
  });

  it("does give a band-bearing token a foreground", async () => {
    // A band is a boundary marker, not a highlight: its text should read in the
    // normal colour. This is the user-turn stripe.
    apply(await loadTheme("mono", await dir()));
    const open = resolveStyle("user", "truecolor").open;
    expect(open).toContain("\x1b[1m");
    expect(open).toMatch(/\x1b\[37m/);
  });
});

describe("a line with no bodyStyle at all", () => {
  // The fourth variant of the same bug. `resolveStyle(undefined)` returned
  // EMPTY, so a FormattedLine that deliberately sets no style — the sidebar's
  // field VALUES do, following its policy that identity strings earn no colour —
  // bypassed the theme entirely and rendered in the terminal's foreground.
  //
  // "No style" and "no colour" are not the same claim.
  it("takes the theme's fg", async () => {
    apply(await loadTheme("mono", await dir()));
    expect(resolveStyle(undefined, "truecolor").open).toBe("\x1b[37m");
  });

  it("stays unstyled on the default palette", () => {
    setTheme(DEFAULT_PALETTE);
    expect(resolveStyle(undefined, "truecolor").open).toBe("");
  });

  it("stays unstyled when colour is off entirely", async () => {
    apply(await loadTheme("mono", await dir()));
    expect(resolveStyle(undefined, "none").open).toBe("");
  });

  it("does not claim to carry inline spans", async () => {
    // An unstyled line has no span opts of its own, so writeStyled must not
    // append the trailing reset it adds for span-bearing bodies.
    apply(await loadTheme("mono", await dir()));
    expect(resolveStyle(undefined, "truecolor").inlineSgr).toBe(false);
  });
});

describe("a token that sets both a foreground and a background has contrast", () => {
  // Reported as "picker selected row is white on white". `roles.selection` is
  // bg-blue + fg-brightWhite, and mono's palette sets every slot to the same
  // colour, so the pair collapsed. Same for the search highlights, the cursors
  // and the queue rows.
  //
  // No single palette assignment can fix that: `red` is a FOREGROUND for
  // errorSoft and a BACKGROUND for matchActive simultaneously. A theme with a
  // uniform palette has to state those pairs as pairs. This checks it did.
  const slot = (code: number): number | null => {
    if (code >= 30 && code <= 37) return code - 30;
    if (code >= 90 && code <= 97) return code - 90 + 8;
    if (code >= 40 && code <= 47) return code - 40;
    if (code >= 100 && code <= 107) return code - 100 + 8;
    return null;
  };

  // Every builtin, derived rather than listed: a theme added to builtins.ts must
  // not be able to skip this by not being named here.
  it.each(builtinNames())(
    "%s",
    async (name) => {
      apply(await loadTheme(name, await dir()));
      const same: string[] = [];
      for (const token of elementNames()) {
        const { open } = resolveStyle(token as ThemeToken, "truecolor");
        const rgbFg = /\x1b\[38;2;(\d+;\d+;\d+)m/.exec(open)?.[1];
        const rgbBg = /\x1b\[48;2;(\d+;\d+;\d+)m/.exec(open)?.[1];
        if (rgbFg !== undefined && rgbBg !== undefined && rgbFg === rgbBg) {
          same.push(`${token} (both ${rgbFg})`);
          continue;
        }
        // Ansi slots: 37 and 47 are the same colour in different positions.
        const codes = [...open.matchAll(/\x1b\[(\d+)m/g)].map((m) => Number(m[1]));
        const fgSlots = codes.filter((c) => (c >= 30 && c <= 37) || (c >= 90 && c <= 97));
        const bgSlots = codes.filter((c) => (c >= 40 && c <= 47) || (c >= 100 && c <= 107));
        for (const f of fgSlots) {
          for (const b of bgSlots) {
            if (slot(f) !== null && slot(f) === slot(b)) {
              same.push(`${token} (both ansi slot ${slot(f)})`);
            }
          }
        }
      }
      expect(same).toEqual([]);
    },
  );
});

describe("parse-time and paint-time colour agree", () => {
  // Reported as: text before an inline code span is darker, text after it looks
  // blueish. A row's base colour is resolved at PAINT time with the terminal's
  // real depth; a span's closer re-asserts that base from a value baked in at
  // PARSE time. openOf() hardcoded 256-colour, so on a truecolor terminal the
  // two disagreed: exact #657b83 before the span, quantised rgb(95,135,135)
  // after — a blue tinge for the rest of the line.
  //
  // I had dismissed this as immaterial "while the palette is ansi slots". That
  // stopped being true the moment themes carried RGB.
  afterEach(() => setInlineDepth("ansi256"));

  it.each(["ansi256", "truecolor"] as const)(
    "a span closes to exactly the row's own colour (%s)",
    async (depth) => {
      apply(await loadTheme("solarized-light", await dir()));
      setInlineDepth(depth);
      const row = resolveStyle("agent", depth).open;
      const body = parseAgentMarkdown("a `code` b")[0]!.body;
      const afterSpan = /\x1b\[0m(\x1b\[[0-9;]+m)/.exec(body)?.[1];
      expect(afterSpan).toBe(row);
    },
  );

  it("re-bakes spans when the depth changes", async () => {
    apply(await loadTheme("dracula", await dir()));
    setInlineDepth("ansi256");
    const quantised = parseAgentMarkdown("a `b` c")[0]!.body;
    setInlineDepth("truecolor");
    const exact = parseAgentMarkdown("a `b` c")[0]!.body;
    expect(exact).not.toBe(quantised);
    expect(exact).toContain("38;2;");
  });

  it("re-bakes the syntax theme too", async () => {
    // It is built from the same roles and cached, so a depth change has to
    // invalidate it or fences keep the old quantisation.
    apply(await loadTheme("dracula", await dir()));
    setInlineDepth("ansi256");
    const a = parseAgentMarkdown("```js\nconst x = 1;\n```").map((l) => l.body).join();
    setInlineDepth("truecolor");
    const b = parseAgentMarkdown("```js\nconst x = 1;\n```").map((l) => l.body).join();
    expect(b).not.toBe(a);
    expect(b).toContain("38;2;");
  });

  it("defaults to 256-colour, which renders somewhere on everything", () => {
    // 24-bit at a terminal that cannot read it renders as garbage, so the
    // conservative default is the right one before the terminal is known.
    setTheme(DEFAULT_PALETTE);
    expect(resolveStyle("agent", "truecolor").open).toBe("");
  });
});

describe("scaffolding differs from data by colour, not just by dim", () => {
  // Reported as: in solarized-light the info gadget's agent/model values look
  // grey and flat against their labels. Both were the body colour, differing
  // only by SGR 2 — a signal some terminals ignore and most render
  // inconsistently.
  const fgOf = (open: string): string | undefined =>
    /\x1b\[38;2;[\d;]+m|\x1b\[(?:3[0-79]|9[0-7])m/.exec(open)?.[0];

  it.each(["dracula", "nord", "gruvbox-dark", "solarized-light"])(
    "%s: a label and a value are different colours",
    async (name) => {
      apply(await loadTheme(name, await dir()));
      const value = fgOf(resolveStyle(undefined, "truecolor").open);
      const label = fgOf(resolveStyle("muted", "truecolor").open);
      expect(value).toBeDefined();
      expect(label).toBeDefined();
      expect(label).not.toBe(value);
    },
  );

  it("uses the theme's own secondary colour, not an invented one", async () => {
    // solarized base1. Every theme already carries its comment colour in
    // brightBlack, which is exactly what scaffolding wants.
    apply(await loadTheme("solarized-light", await dir()));
    expect(resolveStyle("muted", "truecolor").open).toContain(
      "38;2;147;161;161",
    );
  });

  it("keeps three tiers apart: value, thought, scaffolding", async () => {
    apply(await loadTheme("dracula", await dir()));
    const value = resolveStyle(undefined, "truecolor").open;
    const thought = resolveStyle("thought", "truecolor").open;
    const label = resolveStyle("muted", "truecolor").open;
    expect(fgOf(thought)).not.toBe(fgOf(value));
    // A thought and a label share the grey; the label is additionally dimmed,
    // and they never appear on the same surface.
    expect(label).toContain("\x1b[2m");
    expect(thought).not.toContain("\x1b[2m");
  });

  it("stays dim-only on the terminal palette, which names no grey", () => {
    setTheme(DEFAULT_PALETTE);
    expect(resolveStyle("muted", "truecolor").open).toBe("\x1b[2m");
  });
});

describe("themeBackground", () => {
  // A theme's `bg` says what it was DESIGNED for; this says what the terminal
  // actually IS. Only the second can tell a light theme on a black terminal to
  // stop painting pale bands.
  const bandOf = (): string =>
    /^\x1b\[48;2;\d+;\d+;\d+m/.exec(resolveStyle("user", "truecolor").open)![0];

  const withBg = async (
    cfg: unknown,
    env: NodeJS.ProcessEnv = {},
    sensed?: Color,
  ) => {
    const t = await loadTheme("solarized-light", await dir());
    const problems: string[] = [];
    const bg = resolveThemeBackground(cfg, problems, env, sensed);
    setTheme(t.palette, { ...t.overrides, background: bg });
    return problems;
  };

  // What OSC 11 supplies: the terminal's real background, so bands derive from a
  // measurement instead of from "dark" standing in for pure black.
  it("uses a sensed background over COLORFGBG and the theme's own", async () => {
    await withBg(undefined, { COLORFGBG: "15;0" }, rgb(24, 26, 32));
    expect(bandOf()).toBe("\x1b[48;2;63;65;70m");
  });

  it("lets config outrank a sensed background", async () => {
    // tui.themeBackground exists for the case where the terminal answers wrong,
    // so it has to win — otherwise the override is unreachable.
    await withBg("dark", {}, rgb(255, 255, 255));
    expect(bandOf()).toBe("\x1b[48;2;43;43;43m");
  });

  it("falls back to COLORFGBG when nothing was sensed", async () => {
    await withBg(undefined, { COLORFGBG: "15;0" }, undefined);
    expect(bandOf()).toBe("\x1b[48;2;43;43;43m");
  });

  it("falls back to the theme's own bg when nothing is known", async () => {
    await withBg(undefined);
    expect(bandOf()).toBe("\x1b[48;2;210;204;188m"); // pale, per the theme
  });

  it('"dark" pulls the band onto the legacy dark level', async () => {
    // Chosen so band(#000, 0.17) lands on 43 — the exact level the pre-theme
    // code used, which is the value known to work on a dark terminal.
    await withBg("dark");
    expect(bandOf()).toBe("\x1b[48;2;43;43;43m");
  });

  it('"light" derives downward instead', async () => {
    await withBg("light");
    expect(bandOf()).toBe("\x1b[48;2;212;212;212m");
  });

  it("takes an explicit colour", async () => {
    await withBg("#1a1a2e");
    expect(bandOf()).toBe("\x1b[48;2;65;65;82m");
  });

  it("reads COLORFGBG when the key is unset", async () => {
    await withBg(undefined, { COLORFGBG: "15;0" });
    expect(bandOf()).toBe("\x1b[48;2;43;43;43m");
    await withBg(undefined, { COLORFGBG: "0;15" });
    expect(bandOf()).toBe("\x1b[48;2;212;212;212m");
  });

  it("lets the explicit key beat the hint", async () => {
    await withBg("light", { COLORFGBG: "15;0" });
    expect(bandOf()).toBe("\x1b[48;2;212;212;212m");
  });

  it("ignores an unparseable COLORFGBG rather than guessing", async () => {
    // A wrong guess paints a light band on a dark terminal, which is the exact
    // thing this exists to prevent.
    for (const bad of ["", "default", "rgb:0000/0000/0000", "15;99"]) {
      const problems = await withBg(undefined, { COLORFGBG: bad });
      expect(problems, bad).toEqual([]);
      expect(bandOf(), bad).toBe("\x1b[48;2;210;204;188m");
    }
  });

  it("reports a malformed key and carries on", async () => {
    const problems = await withBg("darkish");
    expect(problems.join()).toContain('not "dark", "light", or a colour');
    expect(bandOf()).toBe("\x1b[48;2;210;204;188m");
  });

  it("does not repair a light theme's foregrounds, only its bands", async () => {
    // Worth pinning as a limitation: solarized-light's text is chosen for cream,
    // so it stays dark-on-dark however the bands are derived. solarized-dark is
    // the answer for a dark terminal, not this knob.
    await withBg("dark");
    expect(resolveStyle("agent", "truecolor").open).toBe(
      "\x1b[38;2;101;123;131m",
    );
  });
});

describe("a theme's accent slots are not near-white washes", () => {
  // Reported as "dracula renders near-monochrome". Its published bright ANSI
  // variants are pale washes — #a4ffff, #d6acff, #ffffa5 — and most roles read
  // from the bright slots, so accent, active, reference and every heading landed
  // within a hair of the #f8f8f2 foreground.
  //
  // I first tried to guard this as "an accent must be far from the foreground",
  // which produced false positives: solarized's violet #6c71c4 is close to its fg
  // in RGB distance but obviously distinct to the eye, and nord is deliberately
  // muted. RGB euclidean is not a perceptual measure and "is this
  // distinguishable" is a design judgement that needs eyes.
  //
  // So this guards the mistake actually made, which is mechanical: an accent slot
  // that is nearly white. Those variants sit ~90 from #ffffff; every real accent
  // across the five themes is 116 or further.
  const MIN_FROM_WHITE = 100;

  // Catppuccin is the exception, and it is named rather than accommodated by
  // moving the threshold.
  //
  // Mocha's accents sit 65-85 from its own foreground; the dracula variants this
  // guard was written for sat at 85. They are the same kind of colour and no
  // threshold separates them. What differs is that dracula had better colours
  // going unused, and catppuccin does not: low contrast between accent and text is
  // the palette, deliberately, and it is the most widely used one there is. It is
  // also what herdr defaults to, and two tools from one ecosystem should match.
  //
  // So this is a preference being overruled for one theme, listed slot by slot so
  // that overruling is visible. Every other slot of mocha is still checked, and a
  // future theme cannot inherit the exemption by accident.
  const EXEMPT: Record<string, ReadonlySet<string>> = {
    "catppuccin-mocha": new Set(["yellow", "magenta", "brightBlue"]),
  };

  const ACCENT_SLOTS = [
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
  ] as const;

  // Derived from the builtin list for the same reason as above. Themes with no
  // rgb accents at all (terminal, mono) pass trivially, which is correct — they
  // defer to the user's own palette and have nothing to wash out.
  it.each(builtinNames())(
    "%s",
    async (name) => {
      const t = await loadTheme(name, await dir());
      const exempt = EXEMPT[name] ?? new Set<string>();
      const washed: string[] = [];
      for (const slot of ACCENT_SLOTS) {
        const c = t.palette[slot];
        if (c.kind !== "rgb" || exempt.has(slot)) {
          continue;
        }
        const d = Math.sqrt(
          (255 - c.r) ** 2 + (255 - c.g) ** 2 + (255 - c.b) ** 2,
        );
        if (d < MIN_FROM_WHITE) {
          washed.push(`${slot} (${d.toFixed(0)} from white)`);
        }
      }
      expect(washed).toEqual([]);
    },
  );

  // An exemption that stops being needed is an exemption that should be deleted,
  // and one naming a slot that no longer exists is a lie. Both are easy to leave
  // behind, so neither is allowed to go unnoticed.
  it("has no stale exemptions", async () => {
    for (const [name, slots] of Object.entries(EXEMPT)) {
      const t = await loadTheme(name, await dir());
      for (const slot of slots) {
        const c = t.palette[slot as (typeof ACCENT_SLOTS)[number]];
        expect(c, `${name}.${slot} is not a slot`).toBeDefined();
        if (c.kind !== "rgb") {
          continue;
        }
        const d = Math.sqrt(
          (255 - c.r) ** 2 + (255 - c.g) ** 2 + (255 - c.b) ** 2,
        );
        expect(
          d,
          `${name}.${slot} now passes on its own — drop the exemption`,
        ).toBeLessThan(MIN_FROM_WHITE);
      }
    }
  });
});

describe("themeBackgroundMismatch", () => {
  // themeBackground fixes the BANDS. It cannot fix a light theme's foregrounds,
  // which are chosen against a pale background — solarized-light's body text is a
  // mid grey — so on a black terminal they stay hard to read whatever the bands
  // do. The only remedy is to say so and name the other half of the pair.
  const dark = rgb(0, 0, 0);
  const light = rgb(255, 255, 255);
  const lightTheme = builtinTheme("solarized-light")!.palette;
  const darkTheme = builtinTheme("solarized-dark")!.palette;

  it("flags a light theme on a dark terminal, and names the counterpart", () => {
    const msg = themeBackgroundMismatch(lightTheme, "solarized-light", dark);
    expect(msg).toContain("light theme");
    expect(msg).toContain("solarized-dark");
  });

  it("flags the reverse too", () => {
    const msg = themeBackgroundMismatch(darkTheme, "solarized-dark", light);
    expect(msg).toContain("dark theme");
    expect(msg).toContain("solarized-light");
  });

  it("says nothing when they agree", () => {
    expect(
      themeBackgroundMismatch(darkTheme, "solarized-dark", dark),
    ).toBeUndefined();
    expect(
      themeBackgroundMismatch(lightTheme, "solarized-light", light),
    ).toBeUndefined();
  });

  // Guessing would nag people whose setup is fine.
  it("says nothing when the terminal background is unknown", () => {
    expect(
      themeBackgroundMismatch(lightTheme, "solarized-light", undefined),
    ).toBeUndefined();
  });

  // `terminal` and `mono` declare no bg, so they make no claim to disagree with.
  it("says nothing for a theme that declares no background", () => {
    const t = builtinTheme("terminal")!.palette;
    expect(t.bg).toBeUndefined();
    expect(themeBackgroundMismatch(t, "terminal", light)).toBeUndefined();
  });

  it("omits the suggestion for a theme with no counterpart", () => {
    const msg = themeBackgroundMismatch(
      builtinTheme("dracula")!.palette,
      "dracula",
      light,
    );
    expect(msg).toContain("dark theme");
    expect(msg).not.toContain("try");
  });
});

describe("defaultThemeFor", () => {
  // With no tui.theme configured, the measured background chooses. This is only
  // defensible because the background is MEASURED — `terminal` was the
  // unconditional default precisely because a curated palette that assumes the
  // wrong background is illegible, and OSC 11 is what removed the assumption.
  it("picks by background", () => {
    expect(defaultThemeFor(rgb(0, 0, 0))).toBe("catppuccin-mocha");
    expect(defaultThemeFor(rgb(30, 30, 46))).toBe("catppuccin-mocha");
    expect(defaultThemeFor(rgb(255, 255, 255))).toBe("catppuccin-latte");
    expect(defaultThemeFor(rgb(239, 241, 245))).toBe("catppuccin-latte");
  });

  // Nothing measured, nothing assumed: defer to the palette the user's terminal
  // is already configured with, which is the only choice that cannot be wrong.
  it("falls back to the terminal's own palette when nothing is known", () => {
    expect(defaultThemeFor(undefined)).toBe("terminal");
  });

  it("only ever names a real theme", async () => {
    for (const bg of [rgb(0, 0, 0), rgb(255, 255, 255), undefined]) {
      const name = defaultThemeFor(bg);
      expect(builtinNames()).toContain(name);
      // ...and it loads without complaint, which a name-only check would miss.
      const t = await loadTheme(name, await dir());
      expect(t.problems).toEqual([]);
    }
  });

  // The auto-selected theme must never trip the warning that fires right after it
  // — picking a light theme and then telling the user it is wrong would be absurd.
  it("never selects a theme that mismatches the background it selected for", async () => {
    for (const bg of [rgb(0, 0, 0), rgb(255, 255, 255)]) {
      const name = defaultThemeFor(bg);
      const t = await loadTheme(name, await dir());
      expect(themeBackgroundMismatch(t.palette, name, bg)).toBeUndefined();
    }
  });
});
