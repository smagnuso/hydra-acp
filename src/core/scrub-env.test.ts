import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SCRUBBED_ENV,
  __resetScrubbedEnvForTests,
  envNameMatches,
  scrubInheritedEnv,
  scrubbedEnvPatterns,
  setExtraScrubbedEnv,
} from "./scrub-env.js";

afterEach(() => {
  __resetScrubbedEnvForTests();
});

describe("envNameMatches", () => {
  it("matches an exact name", () => {
    expect(envNameMatches("HERDR_PANE_ID", "HERDR_PANE_ID")).toBe(true);
    expect(envNameMatches("HERDR_PANE_IDX", "HERDR_PANE_ID")).toBe(false);
  });

  it("treats a trailing star as a prefix", () => {
    expect(envNameMatches("TMUX_PANE", "TMUX*")).toBe(true);
    expect(envNameMatches("TMUX", "TMUX*")).toBe(true);
    expect(envNameMatches("XTMUX", "TMUX*")).toBe(false);
  });

  it("is case-sensitive, like the environment itself", () => {
    expect(envNameMatches("path", "PATH")).toBe(false);
  });

  it("does not treat other glob or regex metacharacters as special", () => {
    // A config file is the wrong place for regex-shaped surprises: `.`
    // must mean a literal dot, not "any character".
    expect(envNameMatches("AxB", "A.B")).toBe(false);
    expect(envNameMatches("A.B", "A.B")).toBe(true);
    expect(envNameMatches("ANYTHING", ".*")).toBe(false);
  });
});

describe("scrubInheritedEnv", () => {
  it("removes every pane-scoped herdr variable", () => {
    const out = scrubInheritedEnv({
      HERDR_PANE_ID: "wB:p1",
      HERDR_TAB_ID: "wB:t1",
      HERDR_WORKSPACE_ID: "wB",
      HERDR_STARTUP_CWD: "/tmp",
      HYDRA_HERDR_TAB_LABEL: "some tab",
      PATH: "/usr/bin",
    });
    expect(out).toEqual({ PATH: "/usr/bin" });
  });

  it("keeps HERDR_SOCKET_PATH and HERDR_ENV", () => {
    // The socket is a per-user singleton and stays valid for the daemon's
    // whole life, so an extension that wants to drive herdr can still
    // reach it. What it must not do is inherit a pane.
    const out = scrubInheritedEnv({
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/run/herdr.sock",
      HERDR_PANE_ID: "wB:p1",
    });
    expect(out).toEqual({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/run/herdr.sock" });
  });

  it("leaves an ordinary environment untouched", () => {
    const env = { PATH: "/usr/bin", HOME: "/home/me", EDITOR: "vi" };
    expect(scrubInheritedEnv(env)).toEqual(env);
  });

  it("does not mutate the input", () => {
    const env = { HERDR_PANE_ID: "wB:p1", PATH: "/usr/bin" };
    scrubInheritedEnv(env);
    expect(env.HERDR_PANE_ID).toBe("wB:p1");
  });

  it("drops undefined values so the result is spawn-safe", () => {
    const out = scrubInheritedEnv({ A: undefined, B: "b" });
    expect(out).toEqual({ B: "b" });
    expect("A" in out).toBe(false);
  });

  it("applies the user's extra names", () => {
    setExtraScrubbedEnv(["WEZTERM_PANE", "ITERM_SESSION_ID"]);
    const out = scrubInheritedEnv({
      WEZTERM_PANE: "3",
      ITERM_SESSION_ID: "w0t1p0",
      WEZTERM_CONFIG_FILE: "/x",
    });
    expect(out).toEqual({ WEZTERM_CONFIG_FILE: "/x" });
  });

  it("applies a user prefix pattern", () => {
    setExtraScrubbedEnv(["TMUX*"]);
    const out = scrubInheritedEnv({ TMUX: "/tmp/s", TMUX_PANE: "%1", PATH: "/usr/bin" });
    expect(out).toEqual({ PATH: "/usr/bin" });
  });

  it("keeps the built-ins when config adds its own", () => {
    setExtraScrubbedEnv(["FOO"]);
    const out = scrubInheritedEnv({ HERDR_PANE_ID: "p", FOO: "1", BAR: "2" });
    expect(out).toEqual({ BAR: "2" });
  });

  it("treats an empty or absent config list as no-op", () => {
    setExtraScrubbedEnv([]);
    expect(scrubbedEnvPatterns()).toEqual([...DEFAULT_SCRUBBED_ENV]);
    setExtraScrubbedEnv(undefined);
    expect(scrubbedEnvPatterns()).toEqual([...DEFAULT_SCRUBBED_ENV]);
  });

  it("does not let a config list survive into the next configuration", () => {
    setExtraScrubbedEnv(["FOO"]);
    setExtraScrubbedEnv(["BAR"]);
    const out = scrubInheritedEnv({ FOO: "1", BAR: "2" });
    expect(out).toEqual({ FOO: "1" });
  });

  it("honours a dangerously broad pattern rather than second-guessing it", () => {
    // Not a guard rail — just documenting that `*` is literally a prefix
    // match on the empty string, so it removes everything. If someone
    // writes that, they get what they asked for.
    setExtraScrubbedEnv(["*"]);
    expect(scrubInheritedEnv({ PATH: "/usr/bin" })).toEqual({});
  });
});
