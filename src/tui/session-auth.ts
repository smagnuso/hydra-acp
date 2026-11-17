import { isAuthRequiredError, type AuthBannerResult } from "./auth-required-banner.js";
import type { AuthMethod } from "../acp/types-capabilities.js";
import type { RenderEvent } from "../core/render-update.js";

export function replayNeedsSessionAuth(events: readonly RenderEvent[]): boolean {
  let needsAuth = false;
  for (const event of events) {
    if (event.kind === "user-text" || event.kind === "turn-started") {
      needsAuth = false;
    }
    if (event.kind === "turn-complete") {
      needsAuth = event.stopReason === "error" &&
        typeof event.errorMessage === "string" &&
        isSessionAuthError(new Error(event.errorMessage));
    }
  }
  return needsAuth;
}

export function isSessionAuthError(error: unknown): boolean {
  if (isAuthRequiredError(error)) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return /^Authentication required\.?$/i.test(error.message) ||
    /^Failed to authenticate: this login reached its time limit and cannot be renewed\./.test(error.message);
}

export async function recoverSessionAuth(deps: {
  isLocal: boolean;
  agentId: string;
  sessionId: string;
  request: (method: string, params: unknown) => Promise<unknown>;
  showBanner: (
    methods: AuthMethod[],
    authenticate: (methodId: string) => Promise<unknown>,
  ) => Promise<AuthBannerResult>;
  suspend: () => void;
  resume: () => void;
}): Promise<string | undefined> {
  if (!deps.isLocal) {
    return "Sign in on the daemon host with `hydra agent auth " + deps.agentId +
      "`, then retry your prompt. Remote terminal login is not supported yet.";
  }
  const result = await deps.request("hydra-acp/agents/auth_methods", {
    agentId: deps.agentId,
  }) as { authMethods?: AuthMethod[] };
  const methods = result.authMethods ?? [];
  if (methods.length === 0) {
    return "This agent advertises no login methods. Sign in on the daemon host, then retry your prompt.";
  }
  deps.suspend();
  try {
    const outcome = await deps.showBanner(methods, (methodId) =>
      deps.request("authenticate", {
        methodId,
        _meta: { "hydra-acp": {
          agentId: deps.agentId,
          sessionId: deps.sessionId,
        } },
      }),
    );
    if (outcome === "terminal-completed") {
      return "Login flow finished. Retry your prompt when signed in; it was not resent automatically.";
    }
    if (outcome === "retry") {
      return "Retry your prompt after signing in; it was not resent automatically.";
    }
    return undefined;
  } finally {
    deps.resume();
  }
}
