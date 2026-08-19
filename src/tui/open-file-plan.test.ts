import { describe, expect, it } from "vitest";

import { planOpenFile } from "./open-file-plan.js";

const FILE = "/repo/src/foo.ts";

describe("planOpenFile", () => {
  it("substitutes %f and %n", () => {
    expect(planOpenFile(["code", "--goto", "%f:%n"], FILE, 42)).toEqual({
      program: "code",
      args: ["--goto", `${FILE}:42`],
    });
  });

  it("drops an arg mentioning %n when no line number is known", () => {
    // "+%n" would collapse to a bare "+", which emacsclient reads as a
    // filename.
    expect(planOpenFile(["emacsclient", "-n", "+%n", "%f"], FILE, null)).toEqual({
      program: "emacsclient",
      args: ["-n", FILE],
    });
  });

  it("appends the path when no arg mentions %f", () => {
    expect(planOpenFile(["code", "--reuse-window"], FILE, null)).toEqual({
      program: "code",
      args: ["--reuse-window", FILE],
    });
  });

  it("returns null for an empty argv", () => {
    expect(planOpenFile([], FILE, 42)).toBeNull();
  });

  it("supplies the line number in vim syntax when the command didn't ask", () => {
    // The whole point of the $EDITOR fallback: no placeholders anywhere,
    // yet double-clicking foo.ts:42 should land on line 42.
    expect(planOpenFile(["vim"], FILE, 42)).toEqual({
      program: "vim",
      args: ["+42", FILE],
    });
  });

  it("uses path:line for helix", () => {
    expect(planOpenFile(["hx"], FILE, 42)).toEqual({
      program: "hx",
      args: [`${FILE}:42`],
    });
  });

  it("matches on the basename, not the whole path", () => {
    expect(planOpenFile(["/usr/bin/nvim", "-p"], FILE, 7)).toEqual({
      program: "/usr/bin/nvim",
      args: ["-p", "+7", FILE],
    });
  });

  it("leaves an unknown program's line number alone", () => {
    // A wrong guess would make "+42" a filename and the editor would
    // create it, so silence is the safe answer.
    expect(planOpenFile(["ed"], FILE, 42)).toEqual({
      program: "ed",
      args: [FILE],
    });
  });

  it("does not add a line arg when the command already placed one", () => {
    expect(planOpenFile(["vim", "+%n"], FILE, 42)).toEqual({
      program: "vim",
      args: ["+42", FILE],
    });
  });

  it("adds nothing when there is no line number", () => {
    expect(planOpenFile(["vim"], FILE, null)).toEqual({
      program: "vim",
      args: [FILE],
    });
  });
});
