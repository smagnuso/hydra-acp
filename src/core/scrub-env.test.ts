import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SCRUBBED_ENV,
  PANE_SCOPED_ENV_BY_BACKEND,
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
    expect(envNameMatches("SOME_PANE_ID", "SOME_PANE_ID")).toBe(true);
    expect(envNameMatches("SOME_PANE_IDX", "SOME_PANE_ID")).toBe(false);
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

// Detection resolves to the innermost terminal host; scrubbing must not.
// These tools nest (a multiplexer inside an emulator, or one inside another),
// so scrubbing only the detected backend leaves the outer one's pane id
// sailing through. Different question, different answer.
describe("union across backends", () => {
  it("scrubs every backend's variables regardless of which one we're in", () => {
    const out = scrubInheritedEnv({
      TMUX_PANE: "%3",
      HERDR_PANE_ID: "wB:p1",
      ZELLIJ_PANE_ID: "1",
      WEZTERM_PANE: "7",
      KITTY_WINDOW_ID: "2",
      STY: "1234.pts-0.host",
      ITERM_SESSION_ID: "w0t1p0",
      PATH: "/usr/bin",
    });
    expect(out).toEqual({ PATH: "/usr/bin" });
  });

  it("strips the outer mux's pane id when nested inside another", () => {
    // One host inside another: detection picks the inner one, but the outer
    // one's pane id is just as present and just as stale.
    const out = scrubInheritedEnv({
      ZELLIJ: "0",
      ZELLIJ_PANE_ID: "1",
      TMUX: "/tmp/tmux-1000/default,123,0",
      TMUX_PANE: "%3",
    });
    expect(out).toEqual({ ZELLIJ: "0", TMUX: "/tmp/tmux-1000/default,123,0" });
  });

  it("keeps every reach-the-server variable", () => {
    // These stay valid for as long as the host runs, which outlasts the
    // daemon, so an integration can still reach it. It just must not inherit
    // a pane.
    const keep = {
      HERDR_SOCKET_PATH: "/run/herdr.sock",
      HERDR_ENV: "1",
      TMUX: "/tmp/tmux-1000/default,123,0",
      ZELLIJ: "0",
      WEZTERM_UNIX_SOCKET: "/run/wezterm.sock",
      KITTY_LISTEN_ON: "unix:/tmp/kitty",
    };
    expect(scrubInheritedEnv({ ...keep })).toEqual(keep);
  });

  it("leaves GNU screen's WINDOW alone on purpose", () => {
    // The name is generic enough that scrubbing it risks eating an
    // unrelated variable; that blast radius is worse than the leak.
    expect(scrubInheritedEnv({ WINDOW: "0" })).toEqual({ WINDOW: "0" });
  });

  it("exposes the flattened union as DEFAULT_SCRUBBED_ENV", () => {
    for (const names of Object.values(PANE_SCOPED_ENV_BY_BACKEND)) {
      for (const name of names) {
        expect(DEFAULT_SCRUBBED_ENV).toContain(name);
      }
    }
  });

  it("declares no variable under two backends", () => {
    // A duplicate would mean two adapters claiming the same variable,
    // which is a sign the grouping is wrong rather than a harmless dupe.
    expect(new Set(DEFAULT_SCRUBBED_ENV).size).toBe(DEFAULT_SCRUBBED_ENV.length);
  });
});

describe("scrubInheritedEnv", () => {
  // Driven off the table rather than a hand-written list, so a backend added
  // later is covered without anyone remembering to extend this.
  it.each(Object.entries(PANE_SCOPED_ENV_BY_BACKEND))(
    "removes every pane-scoped variable declared for %s",
    (_backend, names) => {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
      for (const name of names) {
        env[name] = "pane-identity";
      }
      expect(scrubInheritedEnv(env)).toEqual({ PATH: "/usr/bin" });
    },
  );

  it("leaves an ordinary environment untouched", () => {
    const env = { PATH: "/usr/bin", HOME: "/home/me", EDITOR: "vi" };
    expect(scrubInheritedEnv(env)).toEqual(env);
  });

  it("does not mutate the input", () => {
    const env = { TMUX_PANE: "%3", PATH: "/usr/bin" };
    scrubInheritedEnv(env);
    expect(env.TMUX_PANE).toBe("%3");
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
    const out = scrubInheritedEnv({ TMUX_PANE: "%3", FOO: "1", BAR: "2" });
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

// The daemon deliberately does not load terminal-host adapter modules, so
// PANE_SCOPED_ENV_BY_BACKEND is a hand-maintained copy of what each adapter
// declares. That duplication is the price of not loading client-side (and
// possibly user-supplied) code into a long-lived daemon — but it can drift,
// so pin it.
describe("agreement with the terminal-host adapters", () => {
  // One entry per backend that has an adapter. Extend as adapters land; a
  // backend listed in the table with no adapter yet is fine and stays absent
  // from here.
  it("lists exactly what each adapter declares as pane-scoped", async () => {
    const { CANDIDATES } = await import("../tui/term-host/index.js");
    for (const candidate of CANDIDATES) {
      expect(
        [...(PANE_SCOPED_ENV_BY_BACKEND[candidate.id] ?? [])].sort(),
        `table group "${candidate.id}" disagrees with its adapter`,
      ).toEqual([...candidate.paneScopedEnv].sort());
    }
  });

  it("lists the tab-label ownership variable under hydra's own group", async () => {
    const { TAB_LABEL_ENV } = await import("../tui/term-host/label-sync.js");
    expect(PANE_SCOPED_ENV_BY_BACKEND.hydra).toContain(TAB_LABEL_ENV);
  });
});
