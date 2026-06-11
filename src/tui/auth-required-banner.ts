// Pre-screen "this agent needs auth" banner, shown when a fresh
// session/new bubbles up AUTH_REQUIRED (-32000) from a child agent.
//
// Render-only: we do NOT inline-drive the child's `authenticate`
// round-trip here (T8, deferred). The user reads the agent's onboarding
// hints (command / docs URL), runs them in another terminal, then
// presses `r` to retry session/new. Esc returns to the picker so the
// user can choose a different agent.
//
// Pure helpers (buildAuthBannerLines / mapAuthBannerKey /
// isAuthRequiredError / readAgentIdFromAuthError / runAuthRetryLoop)
// are exported so app-test coverage can exercise the retry logic
// without standing up a terminal.

import type { Terminal } from "terminal-kit";
import { JsonRpcErrorCodes } from "../acp/types-jsonrpc.js";
import { HYDRA_META_KEY } from "../acp/types-hydra-meta.js";
import type { AuthMethod } from "../acp/types-capabilities.js";
import {
  drawBox,
  resetTerminalModes,
  runModalPrompt,
  truncate,
  type BoxLayout,
} from "./prompt-utils.js";

export interface AuthOnboarding {
  command?: string;
  url?: string;
  description?: string;
}

export type AuthBannerResult = "retry" | "back" | "cancel";

export interface AuthBannerLines {
  title: string;
  description: string;
  command?: string;
  url?: string;
  authMethods?: AuthMethod[];
  footer: string;
}

const DEFAULT_DESCRIPTION =
  "This agent requires authentication before use.";
const FOOTER = "[r] retry  ·  [Esc] back to picker";

export function buildAuthBannerLines(
  agentId: string,
  onboarding?: AuthOnboarding,
  authMethods?: AuthMethod[],
): AuthBannerLines {
  const result: AuthBannerLines = {
    title: `Agent "${agentId}" needs to be set up`,
    description: onboarding?.description ?? DEFAULT_DESCRIPTION,
    footer: FOOTER,
  };
  if (onboarding?.command) {
    result.command = onboarding.command;
  }
  if (onboarding?.url) {
    result.url = onboarding.url;
  }
  if (authMethods && authMethods.length > 0) {
    result.authMethods = authMethods;
  }
  return result;
}

export type BannerKey =
  | { kind: "retry" }
  | { kind: "back" }
  | { kind: "cancel" }
  | { kind: "ignore" };

export function mapAuthBannerKey(
  name: string,
  data?: { isCharacter?: boolean },
): BannerKey {
  if (name === "CTRL_C" || name === "CTRL_D") {
    return { kind: "cancel" };
  }
  if (name === "ESCAPE") {
    return { kind: "back" };
  }
  if (name === "ENTER" || name === "KP_ENTER") {
    return { kind: "retry" };
  }
  if (data?.isCharacter && name.toLowerCase() === "r") {
    return { kind: "retry" };
  }
  return { kind: "ignore" };
}

// JSON-RPC error shape sniffer. The thrown value from the daemon's
// connection layer carries .code/.data as own-properties; we never
// hardcode -32000 here so the constant in types-jsonrpc.ts stays the
// single source of truth.
export function isAuthRequiredError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  return (err as { code?: unknown }).code === JsonRpcErrorCodes.AuthRequired;
}

function readHydraMetaFromAuthError(
  err: unknown,
): Record<string, unknown> | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const data = (err as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const meta = (data as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) {
    return undefined;
  }
  const hydra = (meta as Record<string, unknown>)[HYDRA_META_KEY];
  if (typeof hydra !== "object" || hydra === null) {
    return undefined;
  }
  return hydra as Record<string, unknown>;
}

export function readAgentIdFromAuthError(err: unknown): string | undefined {
  const hydra = readHydraMetaFromAuthError(err);
  if (!hydra) {
    return undefined;
  }
  const agentId = hydra.agentId;
  return typeof agentId === "string" ? agentId : undefined;
}

export function readAuthMethodsFromAuthError(
  err: unknown,
): AuthMethod[] | undefined {
  const hydra = readHydraMetaFromAuthError(err);
  if (!hydra) {
    return undefined;
  }
  const methods = hydra.authMethods;
  if (!Array.isArray(methods)) {
    return undefined;
  }
  const out: AuthMethod[] = [];
  for (const m of methods) {
    if (typeof m !== "object" || m === null) {
      continue;
    }
    const id = (m as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }
    const description = (m as { description?: unknown }).description;
    const type = (m as { type?: unknown }).type;
    const method: AuthMethod = {
      id,
      description: typeof description === "string" ? description : "",
    };
    if (type === "agent" || type === "terminal") {
      method.type = type;
    }
    out.push(method);
  }
  return out.length > 0 ? out : undefined;
}

export type AuthRetryOutcome<T> =
  | { kind: "ok"; result: T }
  | { kind: "back" }
  | { kind: "cancel" };

// Drive the retry loop without any terminal coupling. Callers inject
// the JSON-RPC request, the banner prompt, and the onboarding lookup;
// non-auth errors are re-thrown untouched.
export async function runAuthRetryLoop<T>(args: {
  request: () => Promise<T>;
  showBanner: (
    agentId: string,
    onboarding: AuthOnboarding | undefined,
    authMethods: AuthMethod[] | undefined,
  ) => Promise<AuthBannerResult>;
  resolveOnboarding: (
    agentId: string,
  ) => Promise<AuthOnboarding | undefined>;
  fallbackAgentId?: string;
}): Promise<AuthRetryOutcome<T>> {
  while (true) {
    try {
      const result = await args.request();
      return { kind: "ok", result };
    } catch (err) {
      if (!isAuthRequiredError(err)) {
        throw err;
      }
      const agentId =
        readAgentIdFromAuthError(err) ?? args.fallbackAgentId ?? "";
      const authMethods = readAuthMethodsFromAuthError(err);
      const onboarding = await args.resolveOnboarding(agentId);
      const decision = await args.showBanner(agentId, onboarding, authMethods);
      if (decision === "back") {
        return { kind: "back" };
      }
      if (decision === "cancel") {
        return { kind: "cancel" };
      }
    }
  }
}

export async function promptAuthRequiredBanner(
  term: Terminal,
  agentId: string,
  onboarding?: AuthOnboarding,
  authMethods?: AuthMethod[],
): Promise<AuthBannerResult> {
  resetTerminalModes();
  const lines = buildAuthBannerLines(agentId, onboarding, authMethods);

  const render = (): BoxLayout => {
    let rows = 4;
    if (lines.command) {
      rows++;
    }
    if (lines.url) {
      rows++;
    }
    if (lines.authMethods) {
      rows += 1 + lines.authMethods.length;
    }
    const layout = drawBox(term, {
      contentHeight: rows,
      contentWidth: 80,
      title: "Authentication required",
    });
    const innerW = layout.contentW;
    let row = 0;
    term.moveTo(layout.contentX, layout.contentY + row);
    term.brightWhite.bold.noFormat(truncate(` ${lines.title}`, innerW));
    row += 2;
    term.moveTo(layout.contentX, layout.contentY + row);
    term.noFormat(truncate(` ${lines.description}`, innerW));
    row++;
    if (lines.command) {
      term.moveTo(layout.contentX, layout.contentY + row);
      term.dim.noFormat(" Run:  ");
      term.brightWhite.noFormat(truncate(lines.command, innerW - 7));
      row++;
    }
    if (lines.url) {
      term.moveTo(layout.contentX, layout.contentY + row);
      term.dim.noFormat(" Docs: ");
      term.brightWhite.noFormat(truncate(lines.url, innerW - 7));
      row++;
    }
    if (lines.authMethods) {
      term.moveTo(layout.contentX, layout.contentY + row);
      term.dim.noFormat(" Methods reported by the agent:");
      row++;
      for (const m of lines.authMethods) {
        term.moveTo(layout.contentX, layout.contentY + row);
        const label = m.description && m.description.length > 0
          ? `${m.description} (${m.id})`
          : m.id;
        term.dim.noFormat("   • ");
        term.noFormat(truncate(label, innerW - 5));
        row++;
      }
    }
    row++;
    term.moveTo(layout.contentX, layout.contentY + row);
    term.dim.noFormat(` ${lines.footer}`);
    return layout;
  };

  return runModalPrompt<AuthBannerResult>({
    term,
    render,
    onKey: (name, _matches, data, finish) => {
      const input = mapAuthBannerKey(name, data);
      if (input.kind === "ignore") {
        return;
      }
      finish(input.kind);
    },
  });
}
