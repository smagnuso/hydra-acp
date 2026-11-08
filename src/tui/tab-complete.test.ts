import { describe, expect, it } from "vitest";
import { createTabCompleter, type ListingItem } from "./tab-complete.js";
import type { PathCompletion } from "./file-completion.js";
import type { MentionCompletion } from "./file-search.js";

// A one-line buffer with the cursor at the end, like typing at a prompt.
function setup(
  text: string,
  opts: {
    mention?: MentionCompletion | null;
    path?: PathCompletion | null;
    remote?: boolean;
  } = {},
) {
  let line = text;
  let listing: ListingItem[] = [];
  const mentions: Array<[string, string]> = [];
  const completer = createTabCompleter(
    {
      cwd: () => "/cwd",
      isRemote: () => opts.remote === true,
      state: () => ({ buffer: [line], row: 0, col: line.length }),
      replaceRange: (start, end, t) => {
        line = line.slice(0, start) + t + line.slice(end);
      },
      showListing: (items) => {
        listing = items;
      },
      recordMention: (token, file) => {
        mentions.push([token, file]);
      },
    },
    {
      completeMention: () => opts.mention ?? null,
      completePath: () => opts.path ?? null,
    },
  );
  return { completer, line: () => line, listing: () => listing, mentions };
}

const ambiguousMention: MentionCompletion = {
  replacement: "@fil",
  candidates: ["src/a.ts", "src/b.ts", "docs/"],
  choices: ["@src/a.ts", "@src/b.ts", "@docs/"],
};

describe("createTabCompleter", () => {
  it("declines when remote or when nothing completes", () => {
    expect(setup("@fil", { remote: true, mention: ambiguousMention }).completer.tab()).toBe(false);
    expect(setup("hello").completer.tab()).toBe(false);
  });

  it("commits a unique mention and records it", () => {
    const t = setup("see @rea", {
      mention: {
        replacement: "@README.md",
        candidates: ["README.md"],
        choices: ["@README.md"],
        file: "README.md",
      },
    });
    expect(t.completer.tab()).toBe(true);
    expect(t.line()).toBe("see @README.md");
    expect(t.mentions).toEqual([["@README.md", "README.md"]]);
    expect(t.completer.active()).toBe(false);
  });

  it("starts cycling when nothing can be extended, then steps and wraps", () => {
    const t = setup("@fil", { mention: ambiguousMention });
    t.completer.tab();
    expect(t.line()).toBe("@src/a.ts");
    expect(t.listing()[0]).toEqual({ name: "src/a.ts", selected: true });
    t.completer.tab();
    expect(t.line()).toBe("@src/b.ts");
    expect(t.completer.step(1)).toBe(true);
    expect(t.line()).toBe("@docs/");
    expect(t.completer.step(1)).toBe(true);
    expect(t.line()).toBe("@src/a.ts");
    expect(t.completer.step(-1)).toBe(true);
    expect(t.line()).toBe("@docs/");
  });

  it("records files but not directories while cycling", () => {
    const t = setup("@fil", { mention: ambiguousMention });
    t.completer.tab();
    t.completer.step(1);
    t.completer.step(1);
    expect(t.mentions).toEqual([
      ["@src/a.ts", "src/a.ts"],
      ["@src/b.ts", "src/b.ts"],
    ]);
  });

  it("cancel restores the typed text and clears the list", () => {
    const t = setup("@fil", { mention: ambiguousMention });
    t.completer.tab();
    t.completer.step(1);
    expect(t.completer.cancel()).toBe(true);
    expect(t.line()).toBe("@fil");
    expect(t.listing()).toEqual([]);
    expect(t.completer.active()).toBe(false);
  });

  it("accept keeps the candidate and ends the cycle", () => {
    const t = setup("@fil", { mention: ambiguousMention });
    t.completer.tab();
    expect(t.completer.accept()).toBe(true);
    expect(t.line()).toBe("@src/a.ts");
    expect(t.completer.active()).toBe(false);
  });

  it("step, cancel and accept are inert when idle", () => {
    const t = setup("x");
    expect(t.completer.step(1)).toBe(false);
    expect(t.completer.cancel()).toBe(false);
    expect(t.completer.accept()).toBe(false);
  });

  it("cycles plain path candidates too", () => {
    const t = setup("src/", {
      path: {
        replacement: "src/",
        candidates: ["a.ts", "b.ts"],
        choices: ["src/a.ts", "src/b.ts"],
      },
    });
    t.completer.tab();
    expect(t.line()).toBe("src/a.ts");
    t.completer.tab();
    expect(t.line()).toBe("src/b.ts");
    expect(t.mentions).toEqual([]);
  });

  it("an extendable prefix commits and lists instead of cycling", () => {
    const t = setup("src/f", {
      path: {
        replacement: "src/foo",
        candidates: ["foo.ts", "foobar.ts"],
        choices: ["src/foo.ts", "src/foobar.ts"],
      },
    });
    t.completer.tab();
    expect(t.line()).toBe("src/foo");
    expect(t.completer.active()).toBe(false);
    expect(t.listing()).toEqual([{ name: "foo.ts" }, { name: "foobar.ts" }]);
  });

  it("reset ends the cycle", () => {
    const t = setup("@fil", { mention: ambiguousMention });
    t.completer.tab();
    t.completer.reset();
    expect(t.completer.active()).toBe(false);
  });
});
