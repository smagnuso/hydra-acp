import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { makeSessionPathDisplay } from "./session-path-display.js";

describe("makeSessionPathDisplay", () => {
  it("renders a plain session's paths relative to its cwd", () => {
    const show = makeSessionPathDisplay({ cwd: "/home/u/repo" });
    expect(show("/home/u/repo/src/tui/app.ts")).toBe("src/tui/app.ts");
    expect(show("/home/u/repo/README.md")).toBe("README.md");
  });

  it("maps an isolated session's workspace paths into the source tree", () => {
    const show = makeSessionPathDisplay({
      cwd: "/home/u/.hydra-acp/workspaces/abc/s-1",
      workspace: {
        sourceCwd: "/home/u/repo",
        path: "/home/u/.hydra-acp/workspaces/abc/s-1",
      },
    });
    expect(show("/home/u/.hydra-acp/workspaces/abc/s-1/src/tui/app.ts")).toBe(
      "src/tui/app.ts",
    );
    // A file the isolated session touched in the real checkout lands on the
    // same root, so both read consistently.
    expect(show("/home/u/repo/src/cli.ts")).toBe("src/cli.ts");
  });

  it("falls back to cwd as the workspace root when the list shape omits path", () => {
    const show = makeSessionPathDisplay({
      cwd: "/home/u/.hydra-acp/workspaces/abc/s-1",
      workspace: { sourceCwd: "/home/u/repo" },
    });
    expect(show("/home/u/.hydra-acp/workspaces/abc/s-1/src/tui/app.ts")).toBe(
      "src/tui/app.ts",
    );
  });

  it("keeps an absolute, home-shortened path for anything outside the root", () => {
    const show = makeSessionPathDisplay({ cwd: "/home/u/repo" });
    expect(show(`${homedir()}/.claude/plans/foo.md`)).toBe("~/.claude/plans/foo.md");
    expect(show("/tmp/scratch.mjs")).toBe("/tmp/scratch.mjs");
    // Sibling directory: a ../ prefix would be worse than the absolute form.
    expect(show("/home/u/other/x.ts")).toBe("/home/u/other/x.ts");
  });

  it("does not mistake a sibling sharing a name prefix for a child", () => {
    const show = makeSessionPathDisplay({ cwd: "/home/u/repo" });
    expect(show("/home/u/repo-2/src/a.ts")).toBe("/home/u/repo-2/src/a.ts");
  });

  it("is identity when there is no session context", () => {
    const show = makeSessionPathDisplay(undefined);
    expect(show("/home/u/repo/src/a.ts")).toBe("/home/u/repo/src/a.ts");
  });

  it("diff style leaves an escaped path absolute rather than tilde-shortened", () => {
    // `--- a/~/.claude/…` would put shell syntax where a filename goes.
    const show = makeSessionPathDisplay({ cwd: "/home/u/repo" }, "diff");
    expect(show(`${homedir()}/.claude/plans/foo.md`)).toBe(
      `${homedir()}/.claude/plans/foo.md`,
    );
    expect(show("/tmp/scratch.mjs")).toBe("/tmp/scratch.mjs");
    // Inside the root it is relative in both styles.
    expect(show("/home/u/repo/src/a.ts")).toBe("src/a.ts");
  });

  it("keeps the path itself when it equals the root", () => {
    const show = makeSessionPathDisplay({ cwd: "/home/u/repo" });
    expect(show("/home/u/repo")).toBe("/home/u/repo");
  });
});
