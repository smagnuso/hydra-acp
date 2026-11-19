import { describe, expect, it } from "vitest";
import type { Terminal } from "terminal-kit";

import type { InputDispatcher } from "./input.js";
import { Screen } from "./screen.js";
import type { FormattedLine } from "./format.js";

describe("selection band followed by a link span", () => {
  it("brackets the link at the right text, not shifted by the re-primed style", () => {
    const out: string[] = [];
    const handler: ProxyHandler<(...args: unknown[]) => unknown> = {
      apply: () => term,
      get(_target, prop) {
        if (prop === "width") return 200;
        if (prop === "height") return 24;
        if (prop === "noFormat") return (s: string) => out.push(s);
        if (prop === "on" || prop === "off") return () => undefined;
        return new Proxy(() => term, handler);
      },
    };
    const term = new Proxy(
      function noop() {} as (...args: unknown[]) => unknown,
      handler,
    ) as unknown as Terminal;
    const screen = new Screen({
      term,
      dispatcher: {
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
      } as unknown as InputDispatcher,
      onKey: () => {},
      repaintThrottleMs: 0,
      progressIndicator: false,
      mouse: true,
      openFileCommand: ["true"],
    });
    const body = "In \x1b[96mnative/startNativeBoot.ts:18\x1b[0m, x";
    const start = body.indexOf("native");
    const end = start + "native/startNativeBoot.ts:18".length;
    const line = { body, bodyStyle: "agent", prefix: "" } as FormattedLine;
    const write = process.stdout.write;
    process.stdout.write = ((s: string) => {
      out.push(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      (
        screen as unknown as {
          writeFormattedLine: (...a: unknown[]) => void;
        }
      ).writeFormattedLine(
        line,
        100,
        null,
        0,
        { start: start, end: start + 6, toEndOfLine: false },
        false,
        false,
        [{ start, end, url: "file:///a/b.ts" }],
      );
    } finally {
      process.stdout.write = write;
    }
    const opener = out.findIndex((s) => s.startsWith("\x1b]8;;file"));
    const closer = out.findIndex((s) => s === "\x1b]8;;\x1b\\");
    const linked = out
      .slice(opener + 1, closer)
      .join("")
      .replace(/\x1b\[[0-9;]*m/g, "");
    expect(linked).toBe("/startNativeBoot.ts:18");
  });
});
