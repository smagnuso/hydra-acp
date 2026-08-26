import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same rationale as tmux.test.ts: assert on the argv/body actually sent,
// since that IS the protocol here — there's no way to inspect what Paseo's
// daemon received short of running it.
interface ExecInvocation {
  file: string;
  args: string[];
}
let execCalls: ExecInvocation[];
let stdoutFor: (args: string[]) => string;
let execFailWith: (Error & { stderr?: string }) | null;
// 0-based index of the call to fail, independent of execFailWith — lets a
// test make the FIRST (create) call succeed and only the SECOND (send-keys)
// one fail, which a single blanket execFailWith can't express.
let failOnCallIndex: number | null;

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return {
    ...orig,
    execFile: (
      file: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void,
    ) => {
      const index = execCalls.length;
      execCalls.push({ file, args });
      if (execFailWith || index === failOnCallIndex) {
        cb(execFailWith ?? new Error("send-keys failed"));
        return;
      }
      cb(null, { stdout: stdoutFor(args), stderr: "" });
    },
  };
});

import {
  __resetTerminalHostForTests,
  initTerminalHost,
  terminalHost,
} from "./index.js";
import { paseoCandidate, shellQuote, toPaseoState } from "./paseo.js";
import type { TerminalHost, TerminalHostSnapshot } from "./types.js";

const TERMINAL_ID = "term_abc123";
const TOKEN = "tok_secret";
const ACTIVITY_URL = "http://127.0.0.1:6767/api/terminal-activity";

function host(): TerminalHost {
  const h = terminalHost();
  if (!h) {
    throw new Error("no host resolved");
  }
  return h;
}

function snapshot(over: Partial<TerminalHostSnapshot> = {}): TerminalHostSnapshot {
  return {
    state: "working",
    sessionId: "hydra_session_TESTSESSION",
    title: "Refactor auth",
    cwd: "/home/me/dev/proj",
    agent: "claude-code",
    model: "opus",
    cost: "$1.23",
    queued: 2,
    turnOrigin: "self",
    turnLabel: null,
    ...over,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  execCalls = [];
  execFailWith = null;
  failOnCallIndex = null;
  stdoutFor = () => JSON.stringify({ id: "term_new", name: "hydra", cwd: "/w" });
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  process.env.PASEO_TERMINAL_ID = TERMINAL_ID;
  process.env.PASEO_ACTIVITY_TOKEN = TOKEN;
  process.env.PASEO_TERMINAL_ACTIVITY_URL = ACTIVITY_URL;
  process.env.PASEO_HOOK_CLI = "/opt/paseo/bin/paseo";
  __resetTerminalHostForTests();
  initTerminalHost();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PASEO_TERMINAL_ID;
  delete process.env.PASEO_ACTIVITY_TOKEN;
  delete process.env.PASEO_TERMINAL_ACTIVITY_URL;
  delete process.env.PASEO_HOOK_CLI;
  __resetTerminalHostForTests();
});

describe("detection", () => {
  it("resolves as the active host when all three env vars are present", () => {
    expect(host().id).toBe("paseo");
  });

  it("does not detect with only some of the env vars present", () => {
    __resetTerminalHostForTests();
    // Isolated env, not ambient process.env: this test's whole point is that
    // paseo detection fails, but running inside a real tmux pane (as this
    // suite often does) leaves TMUX/TMUX_PANE set on process.env, and
    // detection would then fall through and match the real tmux host.
    expect(
      initTerminalHost({
        PASEO_TERMINAL_ID: TERMINAL_ID,
        PASEO_ACTIVITY_TOKEN: TOKEN,
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("candidate detect() matches the same rule directly", () => {
    expect(paseoCandidate.detect(process.env)).toBe(true);
    expect(
      paseoCandidate.detect({ PASEO_TERMINAL_ID: "x" } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe("capabilities", () => {
  it("reports, opens tabs, but cannot split, label, or reveal", () => {
    expect(host().caps).toEqual({
      openTab: true,
      split: false,
      label: false,
      report: true,
      reveal: false,
    });
  });
});

describe("toPaseoState", () => {
  it("maps working to running", () => {
    expect(toPaseoState("working")).toBe("running");
  });
  it("maps blocked to needs-input", () => {
    expect(toPaseoState("blocked")).toBe("needs-input");
  });
  it("maps idle to idle", () => {
    expect(toPaseoState("idle")).toBe("idle");
  });
  it("maps unknown to idle (no wire equivalent)", () => {
    expect(toPaseoState("unknown")).toBe("idle");
  });
});

describe("shellQuote", () => {
  it("wraps a plain token in single quotes", () => {
    expect(shellQuote("hydra")).toBe("'hydra'");
  });
  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("report", () => {
  it("POSTs the mapped state to the activity URL with terminalId and token", async () => {
    await host().report(snapshot({ state: "working" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ACTIVITY_URL);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      terminalId: TERMINAL_ID,
      token: TOKEN,
      state: "running",
    });
  });

  it("dedupes repeated reports that map to the same wire state", async () => {
    await host().report(snapshot({ state: "working" }));
    // Distinct hydra state (blocked vs working would differ) but here we
    // resend the identical mapped state — model/title changes carry no
    // information Paseo's activity endpoint can use.
    await host().report(snapshot({ state: "working", title: "different" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends a fresh POST once the mapped state actually changes", async () => {
    await host().report(snapshot({ state: "working" }));
    await host().report(snapshot({ state: "idle" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("swallows a fetch failure without throwing", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(host().report(snapshot())).resolves.toBeUndefined();
  });
});

describe("release", () => {
  it("does nothing if nothing was ever reported", async () => {
    await host().release();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts idle once something has been reported, clearing the indicator", async () => {
    await host().report(snapshot({ state: "working" }));
    fetchMock.mockClear();

    await host().release();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ state: "idle" });
  });

  it("is a no-op on a second call", async () => {
    await host().report(snapshot({ state: "working" }));
    await host().release();
    fetchMock.mockClear();

    await host().release();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("openTab", () => {
  it("creates a terminal then types the argv plus Enter into it", async () => {
    const result = await host().openTab!({
      label: "feature-x",
      argv: ["hydra", "tui", "--session", "hydra_session_abc"],
      cwd: "/home/me/dev/proj",
    });

    expect(result).toEqual({ ok: true });
    expect(execCalls).toHaveLength(2);
    expect(execCalls[0]).toMatchObject({
      file: "/opt/paseo/bin/paseo",
      args: [
        "terminal",
        "create",
        "--json",
        "--name",
        "feature-x",
        "--cwd",
        "/home/me/dev/proj",
      ],
    });
    expect(execCalls[1]).toMatchObject({
      file: "/opt/paseo/bin/paseo",
      args: [
        "terminal",
        "send-keys",
        "term_new",
        "'hydra' 'tui' '--session' 'hydra_session_abc'",
        "Enter",
      ],
    });
  });

  it("omits --cwd when the spec has none", async () => {
    await host().openTab!({ label: "x", argv: ["hydra"] });
    expect(execCalls[0]?.args).not.toContain("--cwd");
  });

  it("prefixes the typed command with spec.env as shell assignments", async () => {
    await host().openTab!({
      label: "x",
      argv: ["hydra", "tui"],
      env: { HYDRA_TAB_LABEL: "owner-token" },
    });

    expect(execCalls[1]?.args[3]).toBe("HYDRA_TAB_LABEL='owner-token' 'hydra' 'tui'");
  });

  it("falls back to bare 'paseo' when PASEO_HOOK_CLI is unset", async () => {
    __resetTerminalHostForTests();
    delete process.env.PASEO_HOOK_CLI;
    initTerminalHost();

    await host().openTab!({ label: "x", argv: ["hydra"] });

    expect(execCalls[0]?.file).toBe("paseo");
  });

  it("fails when terminal create rejects", async () => {
    execFailWith = Object.assign(new Error("daemon unreachable"), {});
    const result = await host().openTab!({ label: "x", argv: ["hydra"] });
    expect(result).toEqual({ ok: false, error: "daemon unreachable" });
  });

  it("fails when create returns no usable id", async () => {
    stdoutFor = () => JSON.stringify({ name: "x" });
    const result = await host().openTab!({ label: "x", argv: ["hydra"] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no id/);
  });

  it("fails when send-keys rejects after a successful create", async () => {
    failOnCallIndex = 1;

    const result = await host().openTab!({ label: "x", argv: ["hydra"] });

    expect(result).toEqual({ ok: false, error: "send-keys failed" });
    expect(execCalls).toHaveLength(2);
  });
});
