import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  COMM_ANCHOR,
  buildTitleFromArgv,
  setHydraProcessTitle,
} from "./process-title.js";

describe("buildTitleFromArgv", () => {
  it("joins argv with the comm anchor as the first token", () => {
    expect(buildTitleFromArgv(["cat", "-p", "watch logs"])).toBe(
      "hydra cat -p watch logs",
    );
  });

  it("falls back to the bare anchor when argv is empty", () => {
    expect(buildTitleFromArgv([])).toBe(COMM_ANCHOR);
  });

  it("preserves args containing spaces verbatim (no extra quoting)", () => {
    // process.argv already deals in unquoted tokens — the caller has
    // no need to re-quote, and adding quotes here would lie about
    // what the user typed.
    expect(buildTitleFromArgv(["cat", "-p", "two words"])).toBe(
      "hydra cat -p two words",
    );
  });
});

describe("setHydraProcessTitle", () => {
  let originalTitle: string;
  beforeEach(() => {
    originalTitle = process.title;
  });
  afterEach(() => {
    process.title = originalTitle;
  });

  it("sets process.title to the full string regardless of platform", () => {
    setHydraProcessTitle("hydra cat -p watch logs --detach", {
      platform: "darwin",
      writeComm: vi.fn(),
    });
    expect(process.title).toContain("hydra cat -p watch logs --detach");
  });

  it("writes the comm anchor to /proc/self/comm on Linux", () => {
    const writeComm = vi.fn();
    setHydraProcessTitle("hydra cat -p something long", {
      platform: "linux",
      writeComm,
    });
    expect(writeComm).toHaveBeenCalledWith(COMM_ANCHOR);
  });

  it("does not write to /proc/self/comm on non-Linux platforms", () => {
    const writeComm = vi.fn();
    setHydraProcessTitle("hydra cat -p something long", {
      platform: "darwin",
      writeComm,
    });
    expect(writeComm).not.toHaveBeenCalled();
  });

  it("survives /proc/self/comm write failures silently (e.g. sandboxed container)", () => {
    const writeComm = vi.fn(() => {
      throw new Error("EACCES: permission denied");
    });
    expect(() =>
      setHydraProcessTitle("hydra cat -p test", {
        platform: "linux",
        writeComm,
      }),
    ).not.toThrow();
    // process.title should still have been set even though comm failed.
    expect(process.title).toContain("hydra cat -p test");
  });
});
