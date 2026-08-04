import { afterEach, describe, expect, it } from "vitest";
import { fileUriForCwd } from "./format.js";
import { publishReportedCwd, restoreReportedCwd } from "./terminal-user-var.js";

// Capture raw stdout so the assertions are on the actual escape bytes a
// host multiplexer would parse, not on an abstraction over them.
function captureStdout(fn: () => void): string {
  const original = process.stdout.write.bind(process.stdout);
  // The emitters are TTY-guarded on purpose (see publishReportedCwd), so a
  // spec has to look like a terminal.
  const originalIsTTY = process.stdout.isTTY;
  process.stdout.isTTY = true;
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
    void rest;
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
    process.stdout.isTTY = originalIsTTY;
  }
  return chunks.join("");
}

afterEach(() => {
  // captureStdout restores in its own finally; this is belt-and-braces so a
  // throwing spec can't leave stdout patched for the rest of the file.
  expect(typeof process.stdout.write).toBe("function");
});

describe("fileUriForCwd", () => {
  // An empty host means "local". Consumers commonly accept only an empty
  // host or "localhost" and reject anything else outright, so emitting this
  // machine's real hostname would be silently dropped.
  it("emits an empty host rather than a hostname", () => {
    expect(fileUriForCwd("/home/me/dev")).toBe("file:///home/me/dev");
  });

  it("percent-encodes spaces", () => {
    expect(fileUriForCwd("/tmp/my repo")).toBe("file:///tmp/my%20repo");
  });

  // A directory named `foo#bar` must be encoded, not treated as a URI
  // fragment — otherwise the path silently truncates at the '#'. This is
  // the reason this helper exists separately from fileUrlForPath, which
  // deliberately preserves a trailing `#L42` for OSC 8 hyperlinks.
  it("encodes '#' instead of treating it as a fragment", () => {
    expect(fileUriForCwd("/tmp/foo#bar")).toBe("file:///tmp/foo%23bar");
  });

  it("encodes '?' instead of treating it as a query", () => {
    expect(fileUriForCwd("/tmp/foo?bar")).toBe("file:///tmp/foo%3Fbar");
  });

  it("leaves path separators unencoded", () => {
    expect(fileUriForCwd("/a/b/c")).toBe("file:///a/b/c");
  });

  it("encodes non-ascii", () => {
    expect(fileUriForCwd("/tmp/café")).toBe("file:///tmp/caf%C3%A9");
  });
});

describe("publishReportedCwd", () => {
  it("writes nothing when stdout is not a terminal", () => {
    const original = process.stdout.write.bind(process.stdout);
    const originalIsTTY = process.stdout.isTTY;
    process.stdout.isTTY = false;
    const chunks: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      publishReportedCwd("/tmp");
    } finally {
      process.stdout.write = original;
      process.stdout.isTTY = originalIsTTY;
    }
    expect(chunks.join("")).toBe("");
  });

  it("writes a complete OSC 7 sequence terminated by ST", () => {
    const out = captureStdout(() => publishReportedCwd("/home/me/dev"));
    expect(out).toBe("\x1b]7;file:///home/me/dev\x1b\\");
  });

  // Consumers validate that the path is absolute and a real directory. A
  // relative path would just be discarded, so don't put it on the wire.
  it("ignores a relative path", () => {
    const out = captureStdout(() => publishReportedCwd("relative/dir"));
    expect(out).toBe("");
  });

  it("ignores an empty path", () => {
    const out = captureStdout(() => publishReportedCwd(""));
    expect(out).toBe("");
  });

  it("cannot be broken out of by a hostile directory name", () => {
    // encodeURIComponent escapes ESC and BEL, so a crafted path can't
    // terminate the sequence early and inject further escapes.
    const out = captureStdout(() => publishReportedCwd("/tmp/\x1b]0;pwned\x07"));
    expect(out).toBe("\x1b]7;file:///tmp/%1B%5D0%3Bpwned%07\x1b\\");
    // Exactly one OSC introducer and one terminator.
    expect(out.split("\x1b]").length - 1).toBe(1);
    expect(out.split("\x1b\\").length - 1).toBe(1);
  });
});

describe("restoreReportedCwd", () => {
  it("reports this process's real directory", () => {
    const out = captureStdout(() => restoreReportedCwd());
    expect(out).toBe(`\x1b]7;${fileUriForCwd(process.cwd())}\x1b\\`);
  });
});
