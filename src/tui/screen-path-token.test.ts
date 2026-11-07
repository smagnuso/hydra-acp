import { homedir } from "node:os";

import { describe, expect, it } from "vitest";
import type { Terminal } from "terminal-kit";

import { onPlatform } from "../core/platform-stub.js";
import type { InputDispatcher } from "./input.js";
import { Screen, isDriveColonAt } from "./screen.js";
import type { FormattedLine } from "./format.js";

function makeScreen(): Screen {
  const handler: ProxyHandler<(...args: unknown[]) => unknown> = {
    apply: () => term,
    get(_target, prop) {
      if (prop === "width") return 200;
      if (prop === "height") return 24;
      if (prop === "on" || prop === "off") return () => undefined;
      return new Proxy(() => term, handler);
    },
  };
  const term = new Proxy(
    function noop() {} as (...args: unknown[]) => unknown,
    handler,
  ) as unknown as Terminal;
  const dispatcher = {
    state: () => ({
      buffer: [""],
      row: 0,
      col: 0,
      planMode: false,
      historyIndex: -1,
      queueIndex: -1,
      attachments: [],
      historySearchQuery: null,
    }),
  } as unknown as InputDispatcher;
  return new Screen({
    term,
    dispatcher,
    onKey: () => {},
    repaintThrottleMs: 0,
    progressIndicator: false,
    mouse: true,
    openFileCommand: ["true"],
  });
}

type Token = { raw: string; line: number | null } | null;

// The token a double-click at `offset` would resolve to.
function tokenAt(line: FormattedLine, offset: number): Token {
  const screen = makeScreen();
  screen.appendLine(line);
  const id = (screen as unknown as { lineIds: Map<unknown, number> }).lineIds.get(line)!;
  return (
    screen as unknown as {
      pathTokenAt: (p: { sourceLineId: number; offset: number }) => Token;
    }
  ).pathTokenAt({ sourceLineId: id, offset });
}

// Click the middle of `needle` inside `body`, and at both ends.
function tokensAcross(body: string, needle: string): Token[] {
  const at = body.indexOf(needle);
  const line = { body };
  return [at, at + Math.floor(needle.length / 2), at + needle.length - 1].map((o) =>
    tokenAt(line, o),
  );
}

describe("double-click path detection on Windows", () => {
  const cases: Array<[string, string, string, number | null]> = [
    ["drive and backslashes", "error at C:\\Users\\Sam\\proj\\src\\app.ts:42:7 in foo", "C:\\Users\\Sam\\proj\\src\\app.ts", 42],
    ["drive and forward slashes", "error at C:/Users/Sam/proj/src/app.ts:42 in foo", "C:/Users/Sam/proj/src/app.ts", 42],
    ["mixed separators", "open C:\\proj/src\\x.ts now", "C:\\proj/src\\x.ts", null],
    ["UNC share", "see \\\\server\\share\\dir\\file.txt now", "\\\\server\\share\\dir\\file.txt", null],
    ["another drive", "see D:\\a\\hydra-acp\\hydra-acp\\src\\x.ts please", "D:\\a\\hydra-acp\\hydra-acp\\src\\x.ts", null],
    ["relative backslash", "open src\\tui\\screen.ts:100 now", "src\\tui\\screen.ts", 100],
    ["dot-relative", "open .\\src\\x.ts now", ".\\src\\x.ts", null],
    ["parent-relative", "open ..\\lib\\y.ts now", "..\\lib\\y.ts", null],
    ["home-relative", "open ~\\notes.md now", "~\\notes.md", null],
  ];

  for (const [name, body, raw, lineNum] of cases) {
    it(`takes the whole path for ${name}, wherever in it you click`, async () => {
      await onPlatform("win32", () => {
        for (const t of tokensAcross(body, raw)) {
          expect(t).toEqual({ raw, line: lineNum });
        }
      });
    });
  }

  it("also finds the path when the drive letter or colon is clicked", async () => {
    await onPlatform("win32", () => {
      const body = "see C:\\proj\\x.ts now";
      const line = { body };
      const drive = body.indexOf("C");
      expect(tokenAt(line, drive)).toEqual({ raw: "C:\\proj\\x.ts", line: null });
      expect(tokenAt(line, drive + 1)).toEqual({ raw: "C:\\proj\\x.ts", line: null });
    });
  });

  it("keeps a quoted path whole", async () => {
    await onPlatform("win32", () => {
      const body = 'file "C:\\proj\\x.ts" changed';
      expect(tokenAt({ body }, body.indexOf("proj"))).toEqual({
        raw: "C:\\proj\\x.ts",
        line: null,
      });
    });
  });

  it("still rejects the tail of a URL", async () => {
    await onPlatform("win32", () => {
      const body = "ran on https://example.com/job/4690626/console ok";
      expect(tokenAt({ body }, body.indexOf("example"))).toBeNull();
      expect(tokenAt({ body }, body.indexOf("job"))).toBeNull();
    });
  });

  it("does not treat an ordinary word and colon as a drive", async () => {
    await onPlatform("win32", () => {
      const body = "note:foo/bar.ts now";
      expect(tokenAt({ body }, body.indexOf("bar"))?.raw).toBe("foo/bar.ts");
    });
  });
});

describe("double-click path detection off Windows", () => {
  it("leaves a backslash path as separate words, as before", async () => {
    await onPlatform("linux", () => {
      const body = "error at C:\\Users\\Sam\\app.ts:42 in foo";
      expect(tokenAt({ body }, body.indexOf("Users"))).toEqual({ raw: "Users", line: null });
      expect(tokenAt({ body }, body.indexOf("app"))).toEqual({ raw: "app.ts", line: 42 });
    });
  });

  it("does not take a drive prefix from a forward-slash path", async () => {
    await onPlatform("linux", () => {
      const body = "at C:/Users/Sam/app.ts:42 now";
      expect(tokenAt({ body }, body.indexOf("Sam"))).toEqual({
        raw: "/Users/Sam/app.ts",
        line: 42,
      });
    });
  });

  it("is unchanged for POSIX paths", async () => {
    await onPlatform("linux", () => {
      const body = "open /usr/bin/node:12 and src/tui/screen.ts:100";
      expect(tokenAt({ body }, body.indexOf("bin"))).toEqual({ raw: "/usr/bin/node", line: 12 });
      expect(tokenAt({ body }, body.indexOf("tui"))).toEqual({ raw: "src/tui/screen.ts", line: 100 });
    });
  });
});

describe("isDriveColonAt", () => {
  it("matches a lone letter, colon and separator on Windows only", async () => {
    await onPlatform("win32", () => {
      expect(isDriveColonAt("C:\\x", 1)).toBe(true);
      expect(isDriveColonAt("C:/x", 1)).toBe(true);
      expect(isDriveColonAt("see D:\\x", 5)).toBe(true);
      expect(isDriveColonAt("C:42", 1)).toBe(false);
      expect(isDriveColonAt("abC:\\x", 3)).toBe(false);
      expect(isDriveColonAt("https://x", 5)).toBe(false);
    });
    await onPlatform("linux", () => {
      expect(isDriveColonAt("C:\\x", 1)).toBe(false);
    });
  });
});

describe("file links and ~ on Windows", () => {
  it("drops the leading slash of a file:///C:/ link target", async () => {
    const line: FormattedLine = {
      body: "see report here",
      links: [{ start: 4, end: 10, url: "file:///C:/Users/Sam/a.ts#L7" }],
    };
    await onPlatform("win32", () => {
      expect(tokenAt(line, 5)).toEqual({ raw: "C:/Users/Sam/a.ts", line: 7 });
    });
    await onPlatform("linux", () => {
      expect(tokenAt(line, 5)).toEqual({ raw: "/C:/Users/Sam/a.ts", line: 7 });
    });
  });

  it("expands ~\\ to the home directory on Windows only", async () => {
    const screen = makeScreen();
    const resolve = (raw: string): string | null =>
      (screen as unknown as { resolvePathToken: (r: string) => string | null }).resolvePathToken(raw);
    await onPlatform("win32", () => {
      expect(resolve("~\\notes.md")).toBe(`${homedir()}/notes.md`);
    });
    await onPlatform("linux", () => {
      expect(resolve("~\\notes.md")).not.toBe(`${homedir()}/notes.md`);
    });
  });

  it("does not mistake a drive letter for a URL scheme in a link target", () => {
    const screen = makeScreen();
    const url = (u: string): string | null =>
      (screen as unknown as { osc8UrlFor: (u: string) => string | null }).osc8UrlFor(u);
    expect(url("C:/Users/x.ts")).not.toBe("C:/Users/x.ts");
    expect(url("https://example.com/a")).toBe("https://example.com/a");
    expect(url("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(url("ssh://host/x")).toBe("ssh://host/x");
  });
});
