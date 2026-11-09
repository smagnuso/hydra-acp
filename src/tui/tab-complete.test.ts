import { describe, expect, it } from "vitest";
import { createTabCompleter, type ListingItem } from "./tab-complete.js";
import type { PathCompletion } from "./file-completion.js";
import type { MentionCompletion, MentionTarget } from "./file-search.js";

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
  const mentions: Array<[string, MentionTarget]> = [];
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
  return {
    completer,
    line: () => line,
    // Edit the buffer behind the completer's back, as a keystroke would.
    setLine: (t: string) => {
      line = t;
    },
    listing: () => listing,
    mentions,
  };
}

const ambiguousMention: MentionCompletion = {
  replacement: "@fil",
  candidates: ["src/a.ts", "src/b.ts", "docs/"],
  choices: ["@src/a.ts", "@src/b.ts", "@docs/"],
  targets: [
    { kind: "file", path: "src/a.ts" },
    { kind: "file", path: "src/b.ts" },
    null,
  ],
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
        targets: [{ kind: "file", path: "README.md" }],
        target: { kind: "file", path: "README.md" },
      },
    });
    expect(t.completer.tab()).toBe(true);
    expect(t.line()).toBe("see @README.md");
    expect(t.mentions).toEqual([["@README.md", { kind: "file", path: "README.md" }]]);
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
      ["@src/a.ts", { kind: "file", path: "src/a.ts" }],
      ["@src/b.ts", { kind: "file", path: "src/b.ts" }],
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

  it("adds a truncation note to the list, but never selects or cycles onto it", () => {
    const t = setup("@fil", { mention: { ...ambiguousMention, truncated: true } });
    t.completer.tab();
    const last = t.listing()[t.listing().length - 1]!;
    expect(last.note).toBe(true);
    expect(t.listing().filter((i) => i.selected)).toHaveLength(1);
    t.completer.step(1);
    t.completer.step(1);
    t.completer.step(1);
    expect(t.line()).toBe("@src/a.ts");
  });

  it("shows no note for a complete listing", () => {
    const t = setup("@fil", { mention: { ...ambiguousMention, truncated: false } });
    t.completer.tab();
    expect(t.listing().some((i) => i.note)).toBe(false);
  });

  it("records a session target when the cycle lands on a session", () => {
    const t = setup("@fix", {
      mention: {
        replacement: "@fix",
        candidates: ["src/fix.ts", "session: Fix login  (ab12, ~/p)"],
        choices: ["@src/fix.ts", "@fix-login-ab12"],
        targets: [
          { kind: "file", path: "src/fix.ts" },
          { kind: "session", id: "hydra_session_ab12cd", title: "Fix login" },
        ],
      },
    });
    t.completer.tab();
    t.completer.step(1);
    expect(t.line()).toBe("@fix-login-ab12");
    expect(t.mentions[t.mentions.length - 1]).toEqual([
      "@fix-login-ab12",
      { kind: "session", id: "hydra_session_ab12cd", title: "Fix login" },
    ]);
  });

  it("reset ends the cycle", () => {
    const t = setup("@fil", { mention: ambiguousMention });
    t.completer.tab();
    t.completer.reset();
    expect(t.completer.active()).toBe(false);
  });
});

describe("undo (Backspace right after a completion)", () => {
  const unique: MentionCompletion = {
    replacement: "@src/main.cpp",
    candidates: ["src/main.cpp"],
    choices: ["@src/main.cpp"],
    targets: [{ kind: "file", path: "src/main.cpp" }],
    target: { kind: "file", path: "src/main.cpp" },
  };

  it("puts back what was typed after a unique expansion, then deletes normally", () => {
    const t = setup("@main", { mention: unique });
    t.completer.tab();
    expect(t.line()).toBe("@src/main.cpp");
    expect(t.completer.undo()).toBe(true);
    expect(t.line()).toBe("@main");
    expect(t.completer.undo()).toBe(false);
  });

  it("undoes a prefix extension of a plain path", () => {
    const t = setup("src/f", {
      path: {
        replacement: "src/foo",
        candidates: ["foo.ts", "foobar.ts"],
        choices: ["src/foo.ts", "src/foobar.ts"],
      },
    });
    t.completer.tab();
    expect(t.completer.undo()).toBe(true);
    expect(t.line()).toBe("src/f");
    expect(t.listing()).toEqual([]);
  });

  it("goes back to the original token from any step of a cycle", () => {
    const t = setup("@fil", { mention: ambiguousMention });
    t.completer.tab();
    t.completer.step(1);
    expect(t.completer.undo()).toBe(true);
    expect(t.line()).toBe("@fil");
    expect(t.completer.active()).toBe(false);
  });

  it("does nothing when idle or when Tab changed nothing", () => {
    expect(setup("hello").completer.undo()).toBe(false);
    const t = setup("hello");
    t.completer.tab();
    expect(t.completer.undo()).toBe(false);
    expect(t.line()).toBe("hello");
  });

  it("is dropped by any other key, so a later Backspace deletes a character", () => {
    const t = setup("@main", { mention: unique });
    t.completer.tab();
    t.completer.reset();
    expect(t.completer.undo()).toBe(false);
    expect(t.line()).toBe("@src/main.cpp");
  });

  it("leaves the buffer alone when it was edited after the expansion", () => {
    const t = setup("@main", { mention: unique });
    t.completer.tab();
    t.setLine("@src/main.cp");
    expect(t.completer.undo()).toBe(false);
    expect(t.line()).toBe("@src/main.cp");
  });

  it("can be repeated: Tab again after an undo, then Backspace again", () => {
    const t = setup("@main", { mention: unique });
    t.completer.tab();
    t.completer.undo();
    t.completer.tab();
    expect(t.line()).toBe("@src/main.cpp");
    expect(t.completer.undo()).toBe(true);
    expect(t.line()).toBe("@main");
  });
});
