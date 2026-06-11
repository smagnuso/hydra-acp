import { describe, expect, it, vi } from "vitest";
import { JsonRpcErrorCodes } from "../acp/types-jsonrpc.js";
import { HYDRA_META_KEY } from "../acp/types-hydra-meta.js";
import {
  buildAuthBannerLines,
  isAuthRequiredError,
  mapAuthBannerKey,
  readAgentIdFromAuthError,
  readAuthMethodsFromAuthError,
  runAuthRetryLoop,
  type AuthOnboarding,
  type AuthBannerResult,
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
});
