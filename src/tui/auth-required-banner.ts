// Pre-screen "this agent needs auth" banner, shown when a fresh
// session/new bubbles up AUTH_REQUIRED (-32000) from a child agent.
//
// Modes:
//   - Read-only: no authMethods, just onboarding hints + [r] retry / [Esc].
//   - Interactive: authMethods present → user picks one by number, the
//     daemon's authenticate response drives either an in-process retry
//     (forward-to-child or no-op) or a foreground terminal-auth spawn.
//
// Pure helpers (buildAuthBannerLines / mapAuthBannerKey /
// isAuthRequiredError / readAgentIdFromAuthError /
// readAuthMethodsFromAuthError / runAuthRetryLoop /
// handleAuthMethodSelection / runTerminalAuthSpawn) are exported so
// tests can exercise the logic without standing up a terminal.

import type { Terminal } from "terminal-kit";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { writeDebugLine } from "./debug-log.js";
import { JsonRpcErrorCodes } from "../acp/types-jsonrpc.js";
import { HYDRA_META_KEY } from "../acp/types-hydra-meta.js";
import type { AuthMethod } from "../acp/types-capabilities.js";
import {
  drawBox,
  padRight,
  resetTerminalModes,
  runModalPrompt,
  truncate,
  type BoxLayout,
} from "./prompt-utils.js";
import { paint } from "./theme/index.js";

export interface AuthOnboarding {
  command?: string;
  url?: string;
  description?: string;
}

export type AuthBannerResult =
  | "retry"
  | "back"
  | "cancel"
  | "terminal-completed";

export interface AuthBannerMethodLine {
  index: number;
  label: string;
  method: AuthMethod;
}

export interface AuthBannerLines {
  title: string;
  description: string;
  command?: string;
  url?: string;
  authMethods?: AuthMethod[];
  methodLines?: AuthBannerMethodLine[];
  footer: string;
}

const DEFAULT_DESCRIPTION =
  "This agent requires authentication before use.";
const READ_ONLY_FOOTER = "[r] retry  ·  [Esc] back to picker";

function methodFriendlyLabel(m: AuthMethod): string {
  const friendly =
    (m.name && m.name.length > 0 ? m.name : undefined) ??
    (m.description && m.description.length > 0 ? m.description : undefined);
  return friendly ? `${friendly} (${m.id})` : m.id;
}

export function buildAuthBannerLines(
  agentId: string,
  onboarding?: AuthOnboarding,
  authMethods?: AuthMethod[],
): AuthBannerLines {
  const result: AuthBannerLines = {
    title: `Agent "${agentId}" needs to be set up`,
    description: onboarding?.description ?? DEFAULT_DESCRIPTION,
    footer: READ_ONLY_FOOTER,
  };
  if (onboarding?.command) {
    result.command = onboarding.command;
  }
  if (onboarding?.url) {
    result.url = onboarding.url;
  }
  if (authMethods && authMethods.length > 0) {
    result.authMethods = authMethods;
    const lines: AuthBannerMethodLine[] = authMethods.map((m, i) => ({
      index: i,
      label: `[${i + 1}] ${methodFriendlyLabel(m)}`,
      method: m,
    }));
    result.methodLines = lines;
    const max = Math.min(authMethods.length, 9);
    const range = max === 1 ? "[1]" : `[1…${max}]`;
    const enterHint =
      authMethods.length === 1 ? "  ·  [Enter] choose" : "";
    result.footer = `${range} choose method${enterHint}  ·  [r] retry  ·  [Esc] back`;
  }
  return result;
}

export type BannerKey =
  | { kind: "retry" }
  | { kind: "back" }
  | { kind: "cancel" }
  | { kind: "selectMethod"; index: number }
  | { kind: "ignore" };

export function mapAuthBannerKey(
  name: string,
  data?: { isCharacter?: boolean },
  methodCount = 0,
): BannerKey {
  if (name === "CTRL_C" || name === "CTRL_D") {
    return { kind: "cancel" };
  }
  if (name === "ESCAPE") {
    return { kind: "back" };
  }
  if (name === "ENTER" || name === "KP_ENTER") {
    if (methodCount === 1) {
      return { kind: "selectMethod", index: 0 };
    }
    return { kind: "retry" };
  }
  if (data?.isCharacter && /^[1-9]$/.test(name)) {
    const index = Number(name) - 1;
    if (index < methodCount) {
      return { kind: "selectMethod", index };
    }
    return { kind: "ignore" };
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
    const name = (m as { name?: unknown }).name;
    const rawMeta = (m as { _meta?: unknown })._meta;
    const method: AuthMethod = {
      id,
      description: typeof description === "string" ? description : "",
    };
    if (type === "agent" || type === "terminal") {
      method.type = type;
    }
    if (typeof name === "string") {
      method.name = name;
    }
    if (
      rawMeta !== null &&
      typeof rawMeta === "object" &&
      !Array.isArray(rawMeta)
    ) {
      method._meta = rawMeta as Record<string, unknown>;
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
// non-auth errors are re-thrown untouched. "retry" and
// "terminal-completed" both continue the loop (the latter signals the
// banner already finished an interactive auth flow and we should
// immediately re-issue the request without another keystroke).
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

// ---- Terminal-auth spawn ---------------------------------------------------

export interface TerminalAuthPlan {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface TerminalAuthOutcome {
  exitCode: number | null;
}

export type SpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

// Foreground one-shot child runner: release input grab, clear screen,
// print a one-line banner, inherit stdio so the child owns the TTY,
// wait, then re-grab so the caller can repaint. The spawn function is
// injectable so tests don't need to fork a real process.
export async function runTerminalAuthSpawn(
  term: Terminal,
  plan: TerminalAuthPlan,
  deps?: { spawn?: SpawnFn },
): Promise<TerminalAuthOutcome> {
  term.grabInput(false);
  writeDebugLine({ src: "grab", site: "runTerminalAuthSpawn.release", on: false });
  resetTerminalModes();
  term.moveTo(1, 1).eraseDisplayBelow();
  const headline = `─ Running ${plan.command} ${plan.args.join(" ")} — finish setup, then return to hydra ─`;
  process.stdout.write(headline + "\n");

  const spawnFn =
    deps?.spawn ?? ((await import("node:child_process")).spawn as SpawnFn);

  return await new Promise<TerminalAuthOutcome>((resolve) => {
    const reGrab = (): void => {
      try {
        term.grabInput({});
        writeDebugLine({ src: "grab", site: "runTerminalAuthSpawn.reGrab", on: true });
      } catch {
        // best-effort; the caller will repaint anyway
      }
    };
    try {
      const child = spawnFn(plan.command, plan.args, {
        stdio: "inherit",
        env: plan.env,
        cwd: plan.cwd,
      });
      child.on("exit", (code) => {
        reGrab();
        resolve({ exitCode: code });
      });
      child.on("error", (err) => {
        reGrab();
        process.stdout.write(
          `\nfailed to spawn ${plan.command}: ${(err as Error).message}\n`,
        );
        resolve({ exitCode: -1 });
      });
    } catch (err) {
      reGrab();
      process.stdout.write(
        `\nfailed to spawn ${plan.command}: ${(err as Error).message}\n`,
      );
      resolve({ exitCode: -1 });
    }
  });
}

// ---- Method selection orchestration ---------------------------------------

export type MethodSelectionOutcome =
  | { kind: "terminal-completed" }
  | { kind: "retry" }
  | { kind: "error"; message: string }
  | { kind: "exit-nonzero"; exitCode: number | null };

export interface HandleMethodSelectionDeps {
  authenticate: (methodId: string) => Promise<unknown>;
  runTerminalAuth: (plan: TerminalAuthPlan) => Promise<TerminalAuthOutcome>;
}

function isTerminalSpawnResponse(value: unknown): value is TerminalAuthPlan & {
  kind: "terminal";
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as { kind?: unknown; command?: unknown; args?: unknown };
  return (
    v.kind === "terminal" &&
    typeof v.command === "string" &&
    Array.isArray(v.args)
  );
}

// Glue between "user picked method N" and the resulting daemon
// behavior. Exported standalone so tests can replace authenticate +
// runTerminalAuth with mocks and assert the full pipeline without
// instantiating a Terminal.
export async function handleAuthMethodSelection(
  method: AuthMethod,
  deps: HandleMethodSelectionDeps,
): Promise<MethodSelectionOutcome> {
  let response: unknown;
  try {
    response = await deps.authenticate(method.id);
  } catch (err) {
    const message =
      err instanceof Error && err.message.length > 0
        ? err.message
        : String(err);
    return { kind: "error", message };
  }
  if (isTerminalSpawnResponse(response)) {
    const plan: TerminalAuthPlan = {
      command: response.command,
      args: response.args,
      env: response.env,
      cwd: response.cwd,
    };
    const outcome = await deps.runTerminalAuth(plan);
    if (outcome.exitCode === 0) {
      return { kind: "terminal-completed" };
    }
    return { kind: "exit-nonzero", exitCode: outcome.exitCode };
  }
  return { kind: "retry" };
}

// ---- Interactive banner ----------------------------------------------------

export interface PromptAuthBannerDeps {
  authenticate?: (methodId: string) => Promise<unknown>;
  runTerminalAuth?: (plan: TerminalAuthPlan) => Promise<TerminalAuthOutcome>;
}

export async function promptAuthRequiredBanner(
  term: Terminal,
  agentId: string,
  onboarding?: AuthOnboarding,
  authMethods?: AuthMethod[],
  deps?: PromptAuthBannerDeps,
): Promise<AuthBannerResult> {
  resetTerminalModes();
  const lines = buildAuthBannerLines(agentId, onboarding, authMethods);

  let busy = false;
  let statusNote: string | undefined;
  let errorMessage: string | undefined;
  // Mouse state: the box and the screen row the method list starts on,
  // both refreshed by every render, plus which method row the pointer is
  // over. The keyboard picks methods by number and carries no cursor, so
  // the hover highlight is the only thing that says a row is clickable.
  let boxBounds: BoxLayout | null = null;
  let methodRowsStart: number | null = null;
  let hovered: number | null = null;
  let pressCell: { x: number; y: number } | null = null;

  const paintMethodRow = (
    layout: BoxLayout,
    rowOnScreen: number,
    label: string,
    isHovered: boolean,
  ): void => {
    const text = truncate(label, layout.contentW - 3);
    term.moveTo(layout.contentX, rowOnScreen);
    if (isHovered) {
      paint(term, "list-selected", padRight(`   ${text}`, layout.contentW));
      return;
    }
    paint(term, "modal-label", "   ");
    paint(term, "content", text);
    // Pad so a previous hover bar's cells are overwritten.
    if (3 + text.length < layout.contentW) {
      term.noFormat(" ".repeat(layout.contentW - 3 - text.length));
    }
  };

  const render = (): BoxLayout => {
    let rows = 4;
    if (lines.command) {
      rows++;
    }
    if (lines.url) {
      rows++;
    }
    if (lines.methodLines) {
      rows += 1 + lines.methodLines.length;
    }
    if (statusNote) {
      rows++;
    }
    if (errorMessage) {
      rows++;
    }
    const layout = drawBox(term, {
      contentHeight: rows,
      contentWidth: 80,
      title: "Authentication required",
    });
    const innerW = layout.contentW;
    let row = 0;
    if (statusNote) {
      term.moveTo(layout.contentX, layout.contentY + row);
      paint(term, "modal-note", truncate(` ${statusNote}`, innerW));
      row++;
    }
    if (errorMessage) {
      term.moveTo(layout.contentX, layout.contentY + row);
      paint(term, "modal-error", truncate(` ${errorMessage}`, innerW));
      row++;
    }
    term.moveTo(layout.contentX, layout.contentY + row);
    paint(term, "modal-title", truncate(` ${lines.title}`, innerW));
    row += 2;
    term.moveTo(layout.contentX, layout.contentY + row);
    paint(term, "content", truncate(` ${lines.description}`, innerW));
    row++;
    if (lines.command) {
      term.moveTo(layout.contentX, layout.contentY + row);
      paint(term, "modal-label", " Run:  ");
      paint(term, "modal-value", truncate(lines.command, innerW - 7));
      row++;
    }
    if (lines.url) {
      term.moveTo(layout.contentX, layout.contentY + row);
      paint(term, "modal-label", " Docs: ");
      paint(term, "modal-value", truncate(lines.url, innerW - 7));
      row++;
    }
    if (lines.methodLines) {
      term.moveTo(layout.contentX, layout.contentY + row);
      paint(term, "modal-label", " Methods reported by the agent:");
      row++;
      methodRowsStart = layout.contentY + row;
      for (const ml of lines.methodLines) {
        paintMethodRow(layout, layout.contentY + row, ml.label, ml.index === hovered);
        row++;
      }
    } else {
      methodRowsStart = null;
    }
    row++;
    term.moveTo(layout.contentX, layout.contentY + row);
    paint(term, "modal-hint", ` ${lines.footer}`);
    boxBounds = layout;
    return layout;
  };

  // Hover changes two rows at most; a full render() per motion event
  // repaints the whole box and flickers.
  const repaintMethodRows = (): void => {
    const layout = boxBounds;
    const start = methodRowsStart;
    if (layout === null || start === null || !lines.methodLines) {
      return;
    }
    for (const ml of lines.methodLines) {
      paintMethodRow(layout, start + ml.index, ml.label, ml.index === hovered);
    }
  };

  const methodAtRow = (y: number): number | null => {
    const start = methodRowsStart;
    const count = lines.methodLines?.length ?? 0;
    if (start === null || count === 0) {
      return null;
    }
    const idx = y - start;
    return idx >= 0 && idx < count ? idx : null;
  };

  const methodCount = lines.methodLines?.length ?? 0;

  return runModalPrompt<AuthBannerResult>({
    term,
    render: () => {
      render();
    },
    onKey: (name, _matches, data, finish) => {
      if (busy) {
        return;
      }
      const input = mapAuthBannerKey(name, data, methodCount);
      if (input.kind === "ignore") {
        return;
      }
      if (input.kind === "retry" || input.kind === "back" || input.kind === "cancel") {
        finish(input.kind);
        return;
      }
      if (input.kind === "selectMethod") {
        selectMethod(input.index, finish);
      }
    },
    // Hover highlights the method row under the pointer, a click on it
    // runs that method, and a click outside the box backs out. The
    // keyboard picks by number, so hover is what makes the rows read as
    // targets at all.
    onMouse: (name, data, finish) => {
      if (busy) {
        return;
      }
      if (name === "MOUSE_LEFT_BUTTON_PRESSED") {
        pressCell = { x: data?.x ?? -1, y: data?.y ?? -1 };
        return;
      }
      const y = data?.y;
      if (typeof y !== "number") {
        return;
      }
      if (name === "MOUSE_MOTION") {
        const idx = methodAtRow(y);
        if (idx !== hovered) {
          hovered = idx;
          repaintMethodRows();
        }
        return;
      }
      if (name !== "MOUSE_LEFT_BUTTON_RELEASED") {
        return;
      }
      const x = data?.x;
      const sameCell =
        pressCell !== null && x === pressCell.x && y === pressCell.y;
      pressCell = null;
      if (!sameCell) {
        return;
      }
      if (
        boxBounds !== null &&
        typeof x === "number" &&
        (x < boxBounds.x ||
          x >= boxBounds.x + boxBounds.w ||
          y < boxBounds.y ||
          y >= boxBounds.y + boxBounds.h)
      ) {
        finish("back");
        return;
      }
      const idx = methodAtRow(y);
      if (idx !== null) {
        selectMethod(idx, finish);
      }
    },
  });

  // Run one auth method. Shared by the number keys and by a click on the
  // row: both mean "authenticate with this one".
  function selectMethod(
    index: number,
    finish: (value: AuthBannerResult) => void,
  ): void {
    const method = lines.methodLines?.[index]?.method;
    if (!method || !deps?.authenticate) {
      return;
    }
    busy = true;
    hovered = null;
    errorMessage = undefined;
    statusNote = `Authenticating with ${methodFriendlyLabel(method)}…`;
    render();
    const runTA =
      deps.runTerminalAuth ?? ((plan: TerminalAuthPlan) =>
        runTerminalAuthSpawn(term, plan));
    void (async () => {
      const outcome = await handleAuthMethodSelection(method, {
        authenticate: deps.authenticate!,
        runTerminalAuth: runTA,
      });
      if (outcome.kind === "terminal-completed") {
        finish("terminal-completed");
        return;
      }
      if (outcome.kind === "retry") {
        finish("retry");
        return;
      }
      if (outcome.kind === "error") {
        errorMessage = outcome.message;
        statusNote = undefined;
        busy = false;
        render();
        return;
      }
      // exit-nonzero
      statusNote = undefined;
      errorMessage = `auth process exited with code ${outcome.exitCode ?? "(signal)"}`;
      busy = false;
      render();
    })();
  }
}
