import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { JsonRpcErrorCodes } from "../acp/types-jsonrpc.js";
import { HYDRA_META_KEY } from "../acp/types-hydra-meta.js";
import {
  buildAuthBannerLines,
  handleAuthMethodSelection,
  isAuthRequiredError,
  mapAuthBannerKey,
  readAgentIdFromAuthError,
  readAuthMethodsFromAuthError,
  runAuthRetryLoop,
  runTerminalAuthSpawn,
  type AuthOnboarding,
  type AuthBannerResult,
  type SpawnFn,
} from "./auth-required-banner.js";

function makeAuthError(agentId: string | undefined, extra: object = {}): Error {
  const err = new Error("authentication required") as Error & {
    code: number;
    data: unknown;
  };
  err.code = JsonRpcErrorCodes.AuthRequired;
  err.data = {
    _meta: {
      [HYDRA_META_KEY]: {
        ...(agentId !== undefined ? { agentId } : {}),
        authMethods: [],
        ...extra,
      },
    },
  };
  return err;
}

describe("buildAuthBannerLines", () => {
  it("falls back to a generic description and includes title with agent id", () => {
    const lines = buildAuthBannerLines("claude-acp");
    expect(lines.title).toBe('Agent "claude-acp" needs to be set up');
    expect(lines.description).toBe(
      "This agent requires authentication before use.",
    );
    expect(lines.command).toBeUndefined();
    expect(lines.url).toBeUndefined();
    expect(lines.footer).toContain("[r] retry");
    expect(lines.footer).toContain("[Esc]");
  });

  it("surfaces every registry onboarding field when present", () => {
    const onboarding: AuthOnboarding = {
      description: "Log in to Foo Cloud.",
      command: "foo login",
      url: "https://foo.example/docs/auth",
    };
    const lines = buildAuthBannerLines("foo-agent", onboarding);
    expect(lines.description).toBe("Log in to Foo Cloud.");
    expect(lines.command).toBe("foo login");
    expect(lines.url).toBe("https://foo.example/docs/auth");
  });

  it("includes authMethods from the child agent when provided", () => {
    const lines = buildAuthBannerLines("claude-acp", undefined, [
      { id: "oauth", description: "Sign in with browser", type: "agent" },
      { id: "api-key", description: "Use ANTHROPIC_API_KEY", type: "terminal" },
    ]);
    expect(lines.authMethods).toHaveLength(2);
    expect(lines.authMethods?.[0].id).toBe("oauth");
  });

  it("omits authMethods when the list is empty", () => {
    const lines = buildAuthBannerLines("x", undefined, []);
    expect(lines.authMethods).toBeUndefined();
    expect(lines.methodLines).toBeUndefined();
    expect(lines.footer).toBe("[r] retry  ·  [Esc] back to picker");
  });

  it("exposes numbered methodLines and a chooser footer when methods are present", () => {
    const lines = buildAuthBannerLines("qwen", undefined, [
      { id: "qwen-oauth", description: "OAuth", name: "Qwen OAuth" },
      { id: "api-key", description: "API key" },
    ]);
    expect(lines.methodLines).toEqual([
      {
        index: 0,
        label: "[1] Qwen OAuth (qwen-oauth)",
        method: expect.objectContaining({ id: "qwen-oauth" }),
      },
      {
        index: 1,
        label: "[2] API key (api-key)",
        method: expect.objectContaining({ id: "api-key" }),
      },
    ]);
    expect(lines.footer).toContain("[1…2]");
    expect(lines.footer).toContain("choose method");
    expect(lines.footer).toContain("[Esc]");
  });

  it("offers Enter as a shortcut when exactly one method is advertised", () => {
    const lines = buildAuthBannerLines("solo", undefined, [
      { id: "only", description: "only" },
    ]);
    expect(lines.footer).toContain("[Enter] choose");
  });
});

describe("readAuthMethodsFromAuthError", () => {
  it("extracts and normalizes authMethods from the error _meta", () => {
    const err = makeAuthError("claude-acp", {
      authMethods: [
        { id: "oauth", description: "Sign in", type: "agent" },
        { id: "api", description: "API key" },
        { id: "", description: "skipped" },
        { description: "no id, skipped" },
      ],
    });
    const out = readAuthMethodsFromAuthError(err);
    expect(out).toEqual([
      { id: "oauth", description: "Sign in", type: "agent" },
      { id: "api", description: "API key" },
    ]);
  });

  it("preserves name and plain-object _meta, drops malformed variants", () => {
    const err = makeAuthError("qwen", {
      authMethods: [
        {
          id: "qwen-oauth",
          name: "Qwen OAuth",
          description: "Sign in",
          _meta: { type: "terminal", args: ["--auth"] },
        },
        { id: "bad-name", description: "n/a", name: 42 },
        { id: "bad-meta-arr", description: "n/a", _meta: ["x"] },
        { id: "bad-meta-null", description: "n/a", _meta: null },
        { id: "bad-meta-str", description: "n/a", _meta: "nope" },
      ],
    });
    const out = readAuthMethodsFromAuthError(err);
    expect(out).toEqual([
      {
        id: "qwen-oauth",
        description: "Sign in",
        name: "Qwen OAuth",
        _meta: { type: "terminal", args: ["--auth"] },
      },
      { id: "bad-name", description: "n/a" },
      { id: "bad-meta-arr", description: "n/a" },
      { id: "bad-meta-null", description: "n/a" },
      { id: "bad-meta-str", description: "n/a" },
    ]);
  });

  it("returns undefined when authMethods is missing or empty", () => {
    const err = makeAuthError("x");
    expect(readAuthMethodsFromAuthError(err)).toBeUndefined();
  });
});

describe("mapAuthBannerKey", () => {
  it("maps `r` (and Enter) to retry", () => {
    expect(mapAuthBannerKey("r", { isCharacter: true }).kind).toBe("retry");
    expect(mapAuthBannerKey("R", { isCharacter: true }).kind).toBe("retry");
    expect(mapAuthBannerKey("ENTER").kind).toBe("retry");
  });
  it("maps Esc to back, ^C/^D to cancel", () => {
    expect(mapAuthBannerKey("ESCAPE").kind).toBe("back");
    expect(mapAuthBannerKey("CTRL_C").kind).toBe("cancel");
    expect(mapAuthBannerKey("CTRL_D").kind).toBe("cancel");
  });
  it("ignores unrelated keys", () => {
    expect(mapAuthBannerKey("x", { isCharacter: true }).kind).toBe("ignore");
    expect(mapAuthBannerKey("UP").kind).toBe("ignore");
  });

  it("maps digit keys 1..9 to selectMethod when methodCount permits", () => {
    expect(mapAuthBannerKey("1", { isCharacter: true }, 3)).toEqual({
      kind: "selectMethod",
      index: 0,
    });
    expect(mapAuthBannerKey("3", { isCharacter: true }, 3)).toEqual({
      kind: "selectMethod",
      index: 2,
    });
    expect(mapAuthBannerKey("9", { isCharacter: true }, 9)).toEqual({
      kind: "selectMethod",
      index: 8,
    });
  });

  it("ignores digits that exceed methodCount", () => {
    expect(mapAuthBannerKey("5", { isCharacter: true }, 2).kind).toBe("ignore");
    expect(mapAuthBannerKey("1", { isCharacter: true }, 0).kind).toBe("ignore");
  });

  it("treats Enter as a shortcut for index 0 when exactly one method exists", () => {
    expect(mapAuthBannerKey("ENTER", undefined, 1)).toEqual({
      kind: "selectMethod",
      index: 0,
    });
    expect(mapAuthBannerKey("ENTER", undefined, 2).kind).toBe("retry");
    expect(mapAuthBannerKey("ENTER").kind).toBe("retry");
  });
});

describe("isAuthRequiredError / readAgentIdFromAuthError", () => {
  it("matches the AuthRequired code from the central enum (no hardcoded -32000)", () => {
    const err = makeAuthError("claude-acp");
    expect(isAuthRequiredError(err)).toBe(true);
    expect(readAgentIdFromAuthError(err)).toBe("claude-acp");
  });
  it("returns false for non-auth errors", () => {
    const err = new Error("nope") as Error & { code: number };
    err.code = -32603;
    expect(isAuthRequiredError(err)).toBe(false);
    expect(readAgentIdFromAuthError(err)).toBeUndefined();
  });
  it("returns undefined agentId when _meta is missing", () => {
    const err = new Error("auth") as Error & { code: number; data: unknown };
    err.code = JsonRpcErrorCodes.AuthRequired;
    err.data = {};
    expect(readAgentIdFromAuthError(err)).toBeUndefined();
  });
});

describe("runAuthRetryLoop", () => {
  it("returns the request result unchanged on success", async () => {
    const request = vi.fn().mockResolvedValue({ sessionId: "s1" });
    const showBanner = vi.fn();
    const resolveOnboarding = vi.fn();
    const out = await runAuthRetryLoop({
      request,
      showBanner,
      resolveOnboarding,
    });
    expect(out).toEqual({ kind: "ok", result: { sessionId: "s1" } });
    expect(showBanner).not.toHaveBeenCalled();
    expect(resolveOnboarding).not.toHaveBeenCalled();
  });

  it("re-throws non-auth errors untouched", async () => {
    const boom = new Error("kaboom") as Error & { code: number };
    boom.code = -32603;
    const request = vi.fn().mockRejectedValue(boom);
    await expect(
      runAuthRetryLoop({
        request,
        showBanner: vi.fn(),
        resolveOnboarding: vi.fn(),
      }),
    ).rejects.toBe(boom);
  });

  it("on AUTH_REQUIRED: shows banner with onboarding lookup, returns back on Esc", async () => {
    const err = makeAuthError("claude-acp");
    const request = vi.fn().mockRejectedValue(err);
    const onboarding: AuthOnboarding = {
      description: "Authenticate with Claude.",
      command: "claude login",
      url: "https://docs.example/auth",
    };
    const resolveOnboarding = vi.fn().mockResolvedValue(onboarding);
    const showBanner = vi
      .fn<(id: string, o: AuthOnboarding | undefined, m: unknown) => Promise<AuthBannerResult>>()
      .mockResolvedValue("back");

    const out = await runAuthRetryLoop({
      request,
      showBanner,
      resolveOnboarding,
    });
    expect(out).toEqual({ kind: "back" });
    expect(resolveOnboarding).toHaveBeenCalledWith("claude-acp");
    expect(showBanner).toHaveBeenCalledWith("claude-acp", onboarding, undefined);
    // The banner is for display only; one paint, no auto-retry.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("on AUTH_REQUIRED then retry: re-issues identical request and resolves ok", async () => {
    const err = makeAuthError("claude-acp");
    const success = { sessionId: "s-after-auth" };
    const request = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(success);
    const showBanner = vi.fn().mockResolvedValue("retry");
    const out = await runAuthRetryLoop({
      request,
      showBanner,
      resolveOnboarding: vi.fn().mockResolvedValue(undefined),
    });
    expect(out).toEqual({ kind: "ok", result: success });
    expect(request).toHaveBeenCalledTimes(2);
    expect(showBanner).toHaveBeenCalledTimes(1);
  });

  it("re-renders the banner when retry still returns AUTH_REQUIRED", async () => {
    const err = makeAuthError("claude-acp");
    const request = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err);
    const showBanner = vi
      .fn<(id: string, o: AuthOnboarding | undefined, m: unknown) => Promise<AuthBannerResult>>()
      .mockResolvedValueOnce("retry")
      .mockResolvedValueOnce("back");
    const out = await runAuthRetryLoop({
      request,
      showBanner,
      resolveOnboarding: vi.fn().mockResolvedValue(undefined),
    });
    expect(out).toEqual({ kind: "back" });
    expect(showBanner).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("falls back to fallbackAgentId when the error's _meta omits agentId", async () => {
    const err = new Error("auth") as Error & { code: number; data: unknown };
    err.code = JsonRpcErrorCodes.AuthRequired;
    err.data = { _meta: { [HYDRA_META_KEY]: { authMethods: [] } } };
    const request = vi.fn().mockRejectedValueOnce(err).mockResolvedValue({});
    const showBanner = vi.fn().mockResolvedValue("retry");
    const resolveOnboarding = vi.fn().mockResolvedValue(undefined);
    await runAuthRetryLoop({
      request,
      showBanner,
      resolveOnboarding,
      fallbackAgentId: "opencode",
    });
    expect(resolveOnboarding).toHaveBeenCalledWith("opencode");
    expect(showBanner).toHaveBeenCalledWith("opencode", undefined, undefined);
  });

  it("cancel decision bubbles out as kind:cancel", async () => {
    const err = makeAuthError("x");
    const request = vi.fn().mockRejectedValue(err);
    const showBanner = vi.fn().mockResolvedValue("cancel");
    const out = await runAuthRetryLoop({
      request,
      showBanner,
      resolveOnboarding: vi.fn().mockResolvedValue(undefined),
    });
    expect(out).toEqual({ kind: "cancel" });
  });

  it("treats a 'terminal-completed' banner result as an automatic retry", async () => {
    const err = makeAuthError("qwen");
    const success = { sessionId: "after-terminal" };
    const request = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(success);
    const showBanner = vi.fn().mockResolvedValue("terminal-completed");
    const out = await runAuthRetryLoop({
      request,
      showBanner,
      resolveOnboarding: vi.fn().mockResolvedValue(undefined),
    });
    expect(out).toEqual({ kind: "ok", result: success });
    expect(request).toHaveBeenCalledTimes(2);
    expect(showBanner).toHaveBeenCalledTimes(1);
  });
});

describe("handleAuthMethodSelection", () => {
  const method = { id: "qwen-oauth", description: "Sign in" };

  it("returns retry when authenticate response is not a terminal plan", async () => {
    const authenticate = vi.fn().mockResolvedValue({ ok: true });
    const runTerminalAuth = vi.fn();
    const out = await handleAuthMethodSelection(method, {
      authenticate,
      runTerminalAuth,
    });
    expect(out).toEqual({ kind: "retry" });
    expect(authenticate).toHaveBeenCalledWith("qwen-oauth");
    expect(runTerminalAuth).not.toHaveBeenCalled();
  });

  it("runs the terminal-auth plan verbatim and returns terminal-completed on exit 0", async () => {
    const plan = {
      kind: "terminal" as const,
      command: "qwen",
      args: ["--auth"],
      env: { FOO: "bar" },
      cwd: "/tmp",
    };
    const authenticate = vi.fn().mockResolvedValue(plan);
    const runTerminalAuth = vi
      .fn<(p: { command: string; args: string[]; env?: Record<string, string>; cwd?: string }) => Promise<{ exitCode: number | null }>>()
      .mockResolvedValue({ exitCode: 0 });
    const out = await handleAuthMethodSelection(method, {
      authenticate,
      runTerminalAuth,
    });
    expect(runTerminalAuth).toHaveBeenCalledWith({
      command: "qwen",
      args: ["--auth"],
      env: { FOO: "bar" },
      cwd: "/tmp",
    });
    expect(out).toEqual({ kind: "terminal-completed" });
  });

  it("returns exit-nonzero for non-zero exits", async () => {
    const authenticate = vi.fn().mockResolvedValue({
      kind: "terminal",
      command: "qwen",
      args: [],
    });
    const runTerminalAuth = vi.fn().mockResolvedValue({ exitCode: 2 });
    const out = await handleAuthMethodSelection(method, {
      authenticate,
      runTerminalAuth,
    });
    expect(out).toEqual({ kind: "exit-nonzero", exitCode: 2 });
  });

  it("surfaces an authenticate error message without throwing", async () => {
    const boom = new Error("bad methodId");
    const authenticate = vi.fn().mockRejectedValue(boom);
    const runTerminalAuth = vi.fn();
    const out = await handleAuthMethodSelection(method, {
      authenticate,
      runTerminalAuth,
    });
    expect(out).toEqual({ kind: "error", message: "bad methodId" });
    expect(runTerminalAuth).not.toHaveBeenCalled();
  });
});

describe("runTerminalAuthSpawn", () => {
  function makeFakeTerm(): {
    grabInput: ReturnType<typeof vi.fn>;
    moveTo: ReturnType<typeof vi.fn>;
    eraseDisplayBelow: ReturnType<typeof vi.fn>;
  } {
    const term = {
      grabInput: vi.fn(),
      moveTo: vi.fn(),
      eraseDisplayBelow: vi.fn(),
    };
    (term.moveTo as ReturnType<typeof vi.fn>).mockReturnValue(term);
    return term;
  }

  function makeFakeChild(): EventEmitter & { emit: EventEmitter["emit"] } {
    return new EventEmitter() as EventEmitter & {
      emit: EventEmitter["emit"];
    };
  }

  it("passes command/args/env/cwd verbatim to spawn and resolves with the exit code", async () => {
    const term = makeFakeTerm();
    const child = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
    const plan = {
      command: "qwen",
      args: ["--auth", "--quiet"],
      env: { FOO: "bar", PATH: "/usr/bin" },
      cwd: "/home/user",
    };
    const p = runTerminalAuthSpawn(
      term as unknown as Parameters<typeof runTerminalAuthSpawn>[0],
      plan,
      { spawn },
    );
    // Allow the dynamic import path to settle before asserting the spawn
    // call shape.
    await Promise.resolve();
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledWith("qwen", ["--auth", "--quiet"], {
      stdio: "inherit",
      env: { FOO: "bar", PATH: "/usr/bin" },
      cwd: "/home/user",
    });
    child.emit("exit", 0);
    await expect(p).resolves.toEqual({ exitCode: 0 });
    expect(term.grabInput).toHaveBeenCalledWith(false);
    // Re-grab after exit so the banner can repaint.
    expect(term.grabInput).toHaveBeenCalledWith({});
  });

  it("on a child error, resolves with exitCode -1 instead of crashing", async () => {
    const term = makeFakeTerm();
    const child = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
    const p = runTerminalAuthSpawn(
      term as unknown as Parameters<typeof runTerminalAuthSpawn>[0],
      { command: "missing", args: [] },
      { spawn },
    );
    await Promise.resolve();
    child.emit("error", new Error("ENOENT"));
    await expect(p).resolves.toEqual({ exitCode: -1 });
  });

  it("catches synchronous spawn throws (e.g. immediate ENOENT) without crashing", async () => {
    const term = makeFakeTerm();
    const spawn = vi.fn().mockImplementation(() => {
      throw new Error("ENOENT: missing");
    }) as unknown as SpawnFn;
    const out = await runTerminalAuthSpawn(
      term as unknown as Parameters<typeof runTerminalAuthSpawn>[0],
      { command: "nope", args: [] },
      { spawn },
    );
    expect(out).toEqual({ exitCode: -1 });
  });
});
