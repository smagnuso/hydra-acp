import { describe, expect, it } from "vitest";
import { splitCommandLine } from "./command-line.js";

describe("splitCommandLine", () => {
  it("splits on whitespace like before when nothing is quoted", () => {
    expect(splitCommandLine("vim -f")).toEqual(["vim", "-f"]);
    expect(splitCommandLine("  code   --wait  ")).toEqual(["code", "--wait"]);
    expect(splitCommandLine("")).toEqual([]);
    expect(splitCommandLine("   ")).toEqual([]);
  });

  it("keeps a quoted Windows path with spaces together", () => {
    expect(
      splitCommandLine('"C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd" --wait'),
    ).toEqual(["C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd", "--wait"]);
  });

  it("treats a backslash as a literal character, not an escape", () => {
    expect(splitCommandLine("C:\\tools\\vim.exe -f")).toEqual(["C:\\tools\\vim.exe", "-f"]);
    expect(splitCommandLine('"C:\\a b\\"')).toEqual(["C:\\a b\\"]);
  });

  it("accepts single quotes and quoted arguments", () => {
    expect(splitCommandLine("'/opt/my editor/vim' -c 'set ft=md'")).toEqual([
      "/opt/my editor/vim",
      "-c",
      "set ft=md",
    ]);
  });

  it("joins a quoted part to the text next to it", () => {
    expect(splitCommandLine('--dir="a b"/x')).toEqual(["--dir=a b/x"]);
  });

  it("keeps an explicitly empty quoted argument", () => {
    expect(splitCommandLine('cmd "" end')).toEqual(["cmd", "", "end"]);
  });

  it("takes the rest of the string after an unterminated quote", () => {
    expect(splitCommandLine('code "C:\\Program Files\\x --wait')).toEqual([
      "code",
      "C:\\Program Files\\x --wait",
    ]);
  });
});
