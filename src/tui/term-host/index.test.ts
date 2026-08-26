import { afterEach, describe, expect, it } from "vitest";
import {
  CANDIDATES,
  __resetTerminalHostForTests,
  initTerminalHost,
  setTerminalHost,
  terminalHost,
} from "./index.js";
import type { TerminalHost, TerminalHostCandidate } from "./types.js";

function stubHost(id: string): TerminalHost {
  return {
    id,
    caps: { openTab: false, split: false, label: false, report: false, reveal: false },
    report: () => Promise.resolve(),
    release: () => Promise.resolve(),
  };
}

function candidate(
  id: string,
  detect: (env: NodeJS.ProcessEnv) => boolean,
): TerminalHostCandidate {
  return { id, paneScopedEnv: [], detect, create: () => stubHost(id) };
}

/** Run detection over an explicit candidate list. */
function resolveWith(
  candidates: TerminalHostCandidate[],
  env: NodeJS.ProcessEnv,
): string | null {
  for (const c of candidates) {
    let hit = false;
    try {
      hit = c.detect(env);
    } catch {
      continue;
    }
    if (hit) {
      return c.id;
    }
  }
  return null;
}

afterEach(() => {
  __resetTerminalHostForTests();
});

describe("precedence", () => {
  // These hosts NEST — herdr inside tmux, zellij inside kitty are ordinary
  // setups — so more than one candidate detects at once. The innermost one
  // owns the pane we're actually in, and "innermost" is encoded as list
  // order because it isn't derivable from env presence.
  const inner = candidate("inner", (e) => e.INNER === "1");
  const outer = candidate("outer", (e) => e.OUTER === "1");

  it("prefers the earlier candidate when several match", () => {
    expect(resolveWith([inner, outer], { INNER: "1", OUTER: "1" })).toBe("inner");
  });

  it("falls through to a later candidate when the earlier one misses", () => {
    expect(resolveWith([inner, outer], { OUTER: "1" })).toBe("outer");
  });

  it("resolves nothing when no candidate matches", () => {
    expect(resolveWith([inner, outer], {})).toBeNull();
  });

  it("does not let a throwing candidate block the ones behind it", () => {
    const bad = candidate("bad", () => {
      throw new Error("probe blew up");
    });
    expect(resolveWith([bad, outer], { OUTER: "1" })).toBe("outer");
  });
});

describe("paseo precedence exception", () => {
  // Regression for a real environment observed live: Paseo's own daemon
  // doesn't scrub TMUX/TMUX_PANE from its own inherited environment before
  // spawning terminals, so a Paseo daemon started inside a tmux pane leaks
  // that pane's stale identity into every terminal it creates — even though
  // nothing is actually nested. Strict "innermost wins" would let that false
  // signal win over paseo's own real one, so paseo is deliberately ordered
  // first despite being the outermost host in a genuine nesting.
  it("resolves paseo even when a leaked TMUX/TMUX_PANE is also present", () => {
    const host = initTerminalHost({
      PASEO_TERMINAL_ID: "term_1",
      PASEO_ACTIVITY_TOKEN: "tok",
      PASEO_TERMINAL_ACTIVITY_URL: "http://127.0.0.1:6767/api/terminal-activity",
      TMUX: "/tmp/tmux-1000/default,4091673,0",
      TMUX_PANE: "%4",
    });
    expect(host?.id).toBe("paseo");
  });

  it("still resolves tmux when paseo's own env is genuinely absent", () => {
    // tmuxCandidate.create() reads real process.env directly (not the env
    // passed to detect()), same as herdr's — so unlike the paseo/herdr
    // cases above, this one can't be exercised via a synthetic env object
    // alone; it needs the real environment set, matching tmux.test.ts's own
    // setup.
    process.env.TMUX = "/tmp/tmux-1000/default,4091673,0";
    process.env.TMUX_PANE = "%4";
    try {
      const host = initTerminalHost(process.env);
      expect(host?.id).toBe("tmux");
    } finally {
      delete process.env.TMUX;
      delete process.env.TMUX_PANE;
    }
  });
});

describe("initTerminalHost", () => {
  it("resolves nothing from an empty environment", () => {
    expect(initTerminalHost({})).toBeNull();
    expect(terminalHost()).toBeNull();
  });

  it("resolves herdr from its full env triple", () => {
    const host = initTerminalHost({
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/h.sock",
      HERDR_PANE_ID: "w1:p1",
    });
    expect(host?.id).toBe("herdr");
    expect(terminalHost()?.id).toBe("herdr");
  });

  it("requires the whole triple, not just the marker", () => {
    expect(initTerminalHost({ HERDR_ENV: "1" })).toBeNull();
    expect(initTerminalHost({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/x" })).toBeNull();
  });

  it("clears a previously resolved host when re-run in a bare environment", () => {
    initTerminalHost({
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/h.sock",
      HERDR_PANE_ID: "w1:p1",
    });
    expect(initTerminalHost({})).toBeNull();
    expect(terminalHost()).toBeNull();
  });

  it("stays null until called — nothing reads the environment on demand", () => {
    // The gate that keeps `pnpm test` from reporting to a developer's own
    // pane. Screen's funnels run under the test suite; only an explicit init
    // from runTuiApp makes them live.
    expect(terminalHost()).toBeNull();
  });
});

describe("setTerminalHost", () => {
  it("installs a host directly, bypassing detection", () => {
    // How a config-supplied adapter module gets in: explicit config beats
    // detection outright.
    setTerminalHost(stubHost("custom"));
    expect(terminalHost()?.id).toBe("custom");
  });

  it("can clear the active host", () => {
    setTerminalHost(stubHost("custom"));
    setTerminalHost(null);
    expect(terminalHost()).toBeNull();
  });
});

describe("the built-in candidate list", () => {
  it("declares a unique id per candidate", () => {
    const ids = CANDIDATES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares pane-scoped env for every candidate that has any", () => {
    // The list feeds core/scrub-env.ts. A candidate that forgot to declare
    // its pane variables would leak them through the daemon.
    const herdr = CANDIDATES.find((c) => c.id === "herdr");
    expect(herdr?.paneScopedEnv).toContain("HERDR_PANE_ID");
    expect(herdr?.paneScopedEnv).toContain("HERDR_TAB_ID");
  });

  it("does not declare the reach-the-server variables as pane-scoped", () => {
    // Those outlast the daemon and stay useful; only pane identity is toxic.
    for (const c of CANDIDATES) {
      expect(c.paneScopedEnv).not.toContain("HERDR_SOCKET_PATH");
      expect(c.paneScopedEnv).not.toContain("HERDR_ENV");
    }
  });
});
