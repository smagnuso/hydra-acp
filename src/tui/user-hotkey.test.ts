import { describe, expect, it } from "vitest";
import {
  buildHotkeyInvocation,
  createOutputBuilder,
  type HotkeyContext,
} from "./user-hotkey.js";

const CTX: HotkeyContext = {
  sessionId: "sess-abc",
  cwd: "/home/me/dev/proj",
  agentId: "claude-acp",
  baseUrl: "https://127.0.0.1:55514",
  tokenFile: "/home/me/.hydra-acp/auth-token",
};

describe("buildHotkeyInvocation", () => {
  it("expands %s / %c / %a / %u / %t in string command", () => {
    const inv = buildHotkeyInvocation(
      {
        command:
          "/bin/mytool --session %s --cwd %c --agent %a --url %u --token %t",
      },
      CTX,
    );
    expect(inv).not.toBeNull();
    expect(inv!.program).toBe("/bin/mytool");
    expect(inv!.args).toEqual([
      "--session",
      "sess-abc",
      "--cwd",
      "/home/me/dev/proj",
      "--agent",
      "claude-acp",
      "--url",
      "https://127.0.0.1:55514",
      "--token",
      "/home/me/.hydra-acp/auth-token",
    ]);
  });

  it("treats array command as pre-split argv without whitespace splitting", () => {
    const inv = buildHotkeyInvocation(
      { command: ["/bin/foo", "arg with spaces", "sid=%s"] },
      CTX,
    );
    expect(inv).not.toBeNull();
    expect(inv!.program).toBe("/bin/foo");
    expect(inv!.args).toEqual(["arg with spaces", "sid=sess-abc"]);
  });

  it("preserves unknown %-tokens verbatim and honors %% escape", () => {
    const inv = buildHotkeyInvocation(
      { command: ["/bin/x", "%z", "100%%", "trailing%"] },
      CTX,
    );
    expect(inv!.args).toEqual(["%z", "100%", "trailing%"]);
  });

  it("exports HYDRA_* env vars", () => {
    const inv = buildHotkeyInvocation({ command: ["/bin/x"] }, CTX);
    expect(inv!.env).toEqual({
      HYDRA_SESSION_ID: "sess-abc",
      HYDRA_CWD: "/home/me/dev/proj",
      HYDRA_AGENT: "claude-acp",
      HYDRA_BASE_URL: "https://127.0.0.1:55514",
      HYDRA_TOKEN_FILE: "/home/me/.hydra-acp/auth-token",
    });
  });

  it("expands ~ and $HOME in the program and args (spawn has no shell)", () => {
    const home = process.env.HOME ?? "";
    const inv = buildHotkeyInvocation(
      { command: ["~/bin/tool", "--file", "$HOME/notes.md", "--sid", "%s"] },
      CTX,
    );
    expect(inv!.program).toBe(`${home}/bin/tool`);
    expect(inv!.args).toEqual([
      "--file",
      `${home}/notes.md`,
      "--sid",
      "sess-abc",
    ]);
  });

  it("returns null for an empty command", () => {
    expect(buildHotkeyInvocation({ command: "" }, CTX)).toBeNull();
    expect(buildHotkeyInvocation({ command: "   " }, CTX)).toBeNull();
    expect(buildHotkeyInvocation({ command: [] }, CTX)).toBeNull();
  });
});

describe("createOutputBuilder", () => {
  it("emits nothing on a clean, silent exit", () => {
    const b = createOutputBuilder(1024);
    expect(b.onExit(0, null)).toEqual([]);
  });

  it("emits stdout lines on clean exit", () => {
    const b = createOutputBuilder(1024);
    b.onStdout(Buffer.from("hi\n"));
    expect(b.onExit(0, null)).toEqual([{ text: "hi", style: "stdout" }]);
  });

  it("emits stderr lines and an [exit N] marker on non-zero exit", () => {
    const b = createOutputBuilder(1024);
    b.onStdout(Buffer.from("some out\n"));
    b.onStderr(Buffer.from("oh no\n"));
    expect(b.onExit(2, null)).toEqual([
      { text: "some out", style: "stdout" },
      { text: "oh no", style: "stderr" },
      { text: "[exit 2]", style: "error" },
    ]);
  });

  it("emits [killed by SIGTERM] on signal exit", () => {
    const b = createOutputBuilder(1024);
    expect(b.onExit(null, "SIGTERM")).toEqual([
      { text: "[killed by SIGTERM]", style: "error" },
    ]);
  });

  it("truncates output beyond the byte cap and marks it", () => {
    const b = createOutputBuilder(10);
    b.onStdout(Buffer.from("0123456789extra-overflow\n"));
    b.onStdout(Buffer.from("later\n"));
    const lines = b.onExit(0, null);
    expect(lines[0]).toEqual({ text: "0123456789", style: "stdout" });
    expect(lines[lines.length - 1]).toEqual({
      text: "[output truncated at 10 bytes]",
      style: "meta",
    });
  });

  it("splits multi-line output on \\n and drops the trailing empty line", () => {
    const b = createOutputBuilder(1024);
    b.onStdout(Buffer.from("one\ntwo\nthree\n"));
    expect(b.onExit(0, null)).toEqual([
      { text: "one", style: "stdout" },
      { text: "two", style: "stdout" },
      { text: "three", style: "stdout" },
    ]);
  });
});
