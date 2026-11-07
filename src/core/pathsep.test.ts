import { describe, expect, it } from "vitest";
import {
  isPathSeparator,
  lastPathSeparator,
  nativeSeparator,
  separatorFor,
} from "./pathsep.js";
import { onPlatform } from "./platform-stub.js";

describe("path separators", () => {
  it("accepts only / on POSIX, where a backslash is a filename character", async () => {
    await onPlatform("linux", () => {
      expect(isPathSeparator("/")).toBe(true);
      expect(isPathSeparator("\\")).toBe(false);
      expect(lastPathSeparator("a\\b/c")).toBe(3);
      expect(lastPathSeparator("a\\b")).toBe(-1);
      expect(nativeSeparator()).toBe("/");
    });
  });

  it("accepts both on Windows and uses the later one", async () => {
    await onPlatform("win32", () => {
      expect(isPathSeparator("/")).toBe(true);
      expect(isPathSeparator("\\")).toBe(true);
      expect(isPathSeparator(undefined)).toBe(false);
      expect(lastPathSeparator("C:\\a/b\\c")).toBe(6);
      expect(lastPathSeparator("C:/a\\b")).toBe(4);
      expect(nativeSeparator()).toBe("\\");
    });
  });

  it("appends whichever separator the user was already typing", async () => {
    await onPlatform("win32", () => {
      expect(separatorFor("C:/Users/")).toBe("/");
      expect(separatorFor("C:\\Users\\")).toBe("\\");
      expect(separatorFor("")).toBe("\\");
    });
    await onPlatform("linux", () => {
      expect(separatorFor("")).toBe("/");
      expect(separatorFor("a\\")).toBe("/");
    });
  });
});
