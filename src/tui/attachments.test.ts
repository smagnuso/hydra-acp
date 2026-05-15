import { describe, expect, it } from "vitest";

import {
  formatSize,
  isSupportedImagePath,
  mimeFromExtension,
  parseImageDropPaste,
} from "./attachments.js";

describe("mimeFromExtension", () => {
  it("recognises common image extensions case-insensitively", () => {
    expect(mimeFromExtension("/tmp/a.png")).toBe("image/png");
    expect(mimeFromExtension("/tmp/a.PNG")).toBe("image/png");
    expect(mimeFromExtension("/tmp/a.jpg")).toBe("image/jpeg");
    expect(mimeFromExtension("/tmp/a.jpeg")).toBe("image/jpeg");
    expect(mimeFromExtension("/tmp/a.gif")).toBe("image/gif");
    expect(mimeFromExtension("/tmp/a.webp")).toBe("image/webp");
  });

  it("returns null for unsupported extensions", () => {
    expect(mimeFromExtension("/tmp/a.txt")).toBeNull();
    expect(mimeFromExtension("/tmp/a")).toBeNull();
    expect(mimeFromExtension("/tmp/a.svg")).toBeNull();
  });
});

describe("isSupportedImagePath", () => {
  it("mirrors mimeFromExtension as a boolean", () => {
    expect(isSupportedImagePath("/tmp/a.png")).toBe(true);
    expect(isSupportedImagePath("/tmp/a.txt")).toBe(false);
  });
});

describe("formatSize", () => {
  it("formats bytes / KB / MB", () => {
    expect(formatSize(512)).toBe("512B");
    expect(formatSize(1024)).toBe("1KB");
    expect(formatSize(1536)).toBe("2KB");
    expect(formatSize(1024 * 1024)).toBe("1.0MB");
    expect(formatSize(1.2 * 1024 * 1024)).toBe("1.2MB");
  });
});

describe("parseImageDropPaste", () => {
  it("returns a single path for a bare path paste", () => {
    expect(parseImageDropPaste("/tmp/cat.png")).toEqual(["/tmp/cat.png"]);
    expect(parseImageDropPaste("  /tmp/cat.png  \n")).toEqual([
      "/tmp/cat.png",
    ]);
  });

  it("splits multiple whitespace-separated paths", () => {
    expect(parseImageDropPaste("/tmp/a.png /tmp/b.jpg")).toEqual([
      "/tmp/a.png",
      "/tmp/b.jpg",
    ]);
    expect(parseImageDropPaste("/tmp/a.png\n/tmp/b.jpg")).toEqual([
      "/tmp/a.png",
      "/tmp/b.jpg",
    ]);
  });

  it("unquotes single- and double-quoted paths", () => {
    expect(parseImageDropPaste("'/tmp/with space.png'")).toEqual([
      "/tmp/with space.png",
    ]);
    expect(parseImageDropPaste('"/tmp/with space.png"')).toEqual([
      "/tmp/with space.png",
    ]);
  });

  it("handles backslash-escaped spaces", () => {
    expect(parseImageDropPaste("/tmp/with\\ space.png")).toEqual([
      "/tmp/with space.png",
    ]);
  });

  it("decodes file:// URIs", () => {
    expect(parseImageDropPaste("file:///tmp/a.png")).toEqual(["/tmp/a.png"]);
    expect(parseImageDropPaste("file:///tmp/with%20space.png")).toEqual([
      "/tmp/with space.png",
    ]);
  });

  it("returns null when the paste is mixed text", () => {
    expect(
      parseImageDropPaste("Here's a screenshot: /tmp/cat.png"),
    ).toBeNull();
  });

  it("returns null when any token has an unsupported extension", () => {
    expect(parseImageDropPaste("/tmp/a.png /tmp/b.txt")).toBeNull();
  });

  it("returns null when any token is not an absolute path", () => {
    expect(parseImageDropPaste("./relative.png")).toBeNull();
    expect(parseImageDropPaste("cat.png")).toBeNull();
  });

  it("returns null on empty paste", () => {
    expect(parseImageDropPaste("")).toBeNull();
    expect(parseImageDropPaste("   ")).toBeNull();
  });
});
