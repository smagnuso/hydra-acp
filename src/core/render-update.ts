// Pure (no I/O, no terminal-kit) mapper from ACP `session/update` notifications
// into `RenderEvent`s the screen layer knows how to render.

import stripAnsi from "strip-ansi";

import type { Attachment } from "../tui/input.js";

// Strip ANSI escape sequences and dangerous C0 control characters from any
// string we get from the wire before it lands in a RenderEvent. The render
// layer writes bodies through terminal-kit's `.noFormat` and `term(text)`,
// neither of which filters `\x1b` bytes — so a tool whose title carries
// CUP / ED / CR / SGR codes would otherwise drive the cursor outside our
// paint regions and corrupt the screen. Keeps `\n` (the format layer
// splits multi-line text on it) and `\t`; strips everything else in C0
// + DEL.
const STRIP_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

export function sanitizeWireText(text: string): string {
  return stripAnsi(text).replace(STRIP_CONTROLS, "");
}

// Tighter variant for fields that must land in a single FormattedLine
// body. A `\n` inside a body would be written verbatim to the terminal,
// which interprets it as a line feed — the cursor leaves our row and
// subsequent chars paint outside the planned paint region (this is how
// multi-line Bash tool titles ended up splattering across the screen).
// Collapses `\n` and `\t` to single spaces and squeezes runs of
// whitespace so a 600-char heredoc command still renders as one tidy
// line that gets truncated cleanly to the row width.
export function sanitizeSingleLine(text: string): string {
  return sanitizeWireText(text)
    .replace(/[\n\t]+/g, " ")
    .replace(/  +/g, " ")
    .trim();
}

export type RenderEvent =
  | { kind: "agent-text"; text: string }
  | { kind: "agent-thought"; text: string }
  | {
      kind: "user-text";
      text: string;
      sentBy?: string;
      attachments?: Attachment[];
    }
  | {
      kind: "tool-call";
      toolCallId: string;
      title: string;
      status?: string;
      rawKind?: string;
    }
  | {
      kind: "tool-call-update";
      toolCallId: string;
      title?: string;
      status?: string;
      // Best-effort error text extracted from a `failed` update. Pulled
      // from the first text payload in `content[]`, falling back to a
      // string `rawOutput.error`. Surfaced inline under the tool row.
      errorText?: string;
      // True when the failure carries an "upstream silently gave up"
      // signature — either `rawOutput.metadata.interrupted === true` or
      // the canonical "Tool execution aborted" text. Consumed by the
      // turn-complete handler to override a misleadingly clean
      // `end_turn` stopReason from the upstream agent.
      upstreamInterrupted?: boolean;
    }
  | {
      // Claude's ExitPlanMode tool carries the plan as markdown in its
      // `rawInput.plan`. Promoted to a dedicated event so the render layer
      // can surface the plan as a scrollback block instead of dropping it
      // into a generic one-line tool row. `plan` is undefined on terminal
      // status updates (the body is already rendered; only the status
      // marker needs to mutate).
      kind: "exit-plan-mode";
      toolCallId: string;
      plan?: string;
      status?: string;
    }
  | { kind: "plan"; entries: PlanEntry[]; stopped?: boolean; amended?: boolean }
  | { kind: "mode-changed"; mode: string }
  | { kind: "model-changed"; model: string }
  | { kind: "turn-complete"; stopReason?: string; amended?: boolean }
  | {
      kind: "usage-update";
      used?: number;
      size?: number;
      costAmount?: number;
      costCurrency?: string;
    }
  | { kind: "available-commands"; commands: AvailableCommand[] }
  | { kind: "available-modes"; modes: AvailableMode[] }
  | { kind: "session-info"; title?: string; agentId?: string }
  | { kind: "unknown"; sessionUpdate: string; raw: unknown };

export interface AvailableCommand {
  name: string;
  description?: string;
}

export interface AvailableMode {
  id: string;
  name?: string;
  description?: string;
}

export interface PlanEntry {
  content: string;
  status?: string;
  priority?: string;
}

interface UpdateLike {
  sessionUpdate?: string;
  kind?: string;
  [key: string]: unknown;
}

export function mapUpdate(update: unknown): RenderEvent | null {
  if (!update || typeof update !== "object") {
    return null;
  }
  const u = update as UpdateLike;
  // Hydra and modern agents use `sessionUpdate`; some agents/tests still emit
  // legacy `kind`. Read either.
  const tag = u.sessionUpdate ?? u.kind;
  if (typeof tag !== "string") {
    return null;
  }
  switch (tag) {
    case "agent_message_chunk":
      return mapAgentText(u);
    case "agent_thought_chunk":
    case "agent_thought":
      return mapAgentThought(u);
    case "user_message_chunk":
      return mapUserText(u);
    case "prompt_received":
      return mapPromptReceived(u);
    case "tool_call":
      return mapToolCall(u);
    case "tool_call_update":
      return mapToolCallUpdate(u);
    case "plan":
      return mapPlan(u);
    case "current_mode_update":
      return mapMode(u);
    case "current_model_update":
      return mapModel(u);
    case "turn_complete":
      return mapTurnComplete(u);
    case "usage_update":
      return mapUsage(u);
    case "available_commands_update":
      return mapAvailableCommands(u);
    case "available_modes_update":
      return mapAvailableModes(u);
    case "session_info_update":
      return mapSessionInfo(u);
    default:
      return { kind: "unknown", sessionUpdate: tag, raw: update };
  }
}

function mapSessionInfo(u: UpdateLike): RenderEvent | null {
  const rawTitle = readString(u, "title");
  const title =
    rawTitle !== undefined ? sanitizeSingleLine(rawTitle) : undefined;
  // agentId is a hydra-specific extension carried in _meta["hydra-acp"]
  // (the standard ACP schema for session_info_update has only title +
  // updatedAt + _meta — agent identity is not a protocol-level concept).
  const meta = u._meta;
  let agentId: string | undefined;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const ns = (meta as Record<string, unknown>)["hydra-acp"];
    if (ns && typeof ns === "object" && !Array.isArray(ns)) {
      const candidate = (ns as Record<string, unknown>).agentId;
      if (typeof candidate === "string") {
        agentId = candidate;
      }
    }
  }
  if (title === undefined && agentId === undefined) {
    return null;
  }
  const event: RenderEvent = { kind: "session-info" };
  if (title !== undefined) {
    event.title = title;
  }
  if (agentId !== undefined) {
    event.agentId = agentId;
  }
  return event;
}

// Coerce a raw advertised-commands list (from either a live
// available_commands_update notification or the attach/new response
// _meta) into the TUI's AvailableCommand shape. Per the ACP schema,
// agent commands are advertised by bare name (e.g. "create_plan");
// the TUI's completion model expects all entries to be slash-prefixed
// so they match what the user types.
export function normalizeAdvertisedCommands(list: unknown): AvailableCommand[] {
  if (!Array.isArray(list)) {
    return [];
  }
  const out: AvailableCommand[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const c = raw as Record<string, unknown>;
    if (typeof c.name !== "string" || c.name.length === 0) {
      continue;
    }
    const rawName = c.name.startsWith("/") ? c.name : `/${c.name}`;
    const cmd: AvailableCommand = { name: sanitizeSingleLine(rawName) };
    if (typeof c.description === "string") {
      cmd.description = sanitizeSingleLine(c.description);
    }
    out.push(cmd);
  }
  return out;
}

function mapAvailableCommands(u: UpdateLike): RenderEvent | null {
  const list = u.availableCommands ?? u.commands;
  if (!Array.isArray(list)) {
    return null;
  }
  return { kind: "available-commands", commands: normalizeAdvertisedCommands(list) };
}

function mapAvailableModes(u: UpdateLike): RenderEvent | null {
  const list = u.availableModes;
  if (!Array.isArray(list)) {
    return null;
  }
  const modes: AvailableMode[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== "string" || m.id.length === 0) {
      continue;
    }
    const mode: AvailableMode = { id: sanitizeSingleLine(m.id) };
    if (typeof m.name === "string") {
      mode.name = sanitizeSingleLine(m.name);
    }
    if (typeof m.description === "string") {
      mode.description = sanitizeSingleLine(m.description);
    }
    modes.push(mode);
  }
  return { kind: "available-modes", modes };
}

function mapUsage(u: UpdateLike): RenderEvent {
  const event: RenderEvent = { kind: "usage-update" };
  if (typeof u.used === "number") {
    event.used = u.used;
  }
  if (typeof u.size === "number") {
    event.size = u.size;
  }
  if (u.cost && typeof u.cost === "object") {
    const cost = u.cost as { amount?: unknown; currency?: unknown };
    if (typeof cost.amount === "number") {
      event.costAmount = cost.amount;
    }
    if (typeof cost.currency === "string") {
      event.costCurrency = cost.currency;
    }
  }
  return event;
}

function mapAgentText(u: UpdateLike): RenderEvent | null {
  const text = extractContentText(u.content);
  if (text === null) {
    return null;
  }
  return { kind: "agent-text", text };
}

function mapAgentThought(u: UpdateLike): RenderEvent | null {
  const text =
    typeof u.text === "string"
      ? sanitizeWireText(u.text)
      : extractContentText(u.content);
  if (text === null) {
    return null;
  }
  return { kind: "agent-thought", text };
}

function mapUserText(u: UpdateLike): RenderEvent | null {
  // Hydra broadcasts a compat user_message_chunk alongside prompt_received
  // for clients that don't yet implement RFD #533. Skip it — prompt_received
  // already renders the same text (with sentBy attribution).
  const meta = u._meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const hydra = (meta as Record<string, unknown>)["hydra-acp"];
    if (
      hydra &&
      typeof hydra === "object" &&
      !Array.isArray(hydra) &&
      (hydra as Record<string, unknown>).compatFor === "prompt_received"
    ) {
      return null;
    }
  }
  const text = extractContentText(u.content);
  if (text === null) {
    return null;
  }
  return { kind: "user-text", text };
}

function mapPromptReceived(u: UpdateLike): RenderEvent | null {
  const promptText = extractPromptText(u.prompt);
  if (promptText === null) {
    return null;
  }
  // No sentBy attribution. The names available on the wire are either
  // auto-generated clientIds ("cli_abc123") or application names
  // ("hydra-acp-tui"/"hydra-acp-slack") — none of which read as
  // human-meaningful info for the user, just clutter under each prompt.
  return { kind: "user-text", text: promptText };
}

// Recognise Claude's ExitPlanMode tool across the two casings seen on the
// wire (camelCase from claude-acp today, snake_case in case the upstream
// shape ever changes). Case-insensitive so `name` / `title` carry-overs
// from arbitrary upstreams still match.
export function isExitPlanModeTool(name: string | undefined): boolean {
  if (!name) {
    return false;
  }
  const normalised = name.toLowerCase().replace(/[_\s-]/g, "");
  return normalised === "exitplanmode";
}

function readExitPlanMarkdown(u: UpdateLike): string | null {
  const rawInput = u.rawInput;
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return null;
  }
  const plan = (rawInput as Record<string, unknown>).plan;
  if (typeof plan !== "string" || plan.length === 0) {
    return null;
  }
  return sanitizeWireText(plan);
}

function mapToolCall(u: UpdateLike): RenderEvent | null {
  const toolCallId = readString(u, "toolCallId") ?? readString(u, "id");
  if (!toolCallId) {
    return null;
  }
  const rawTitle =
    readString(u, "title") ??
    readString(u, "name") ??
    readString(u, "label") ??
    "tool call";
  const toolName = readString(u, "name") ?? readString(u, "title");
  if (isExitPlanModeTool(toolName)) {
    const plan = readExitPlanMarkdown(u);
    if (plan !== null) {
      const status = readString(u, "status");
      const event: RenderEvent = { kind: "exit-plan-mode", toolCallId, plan };
      if (status !== undefined) {
        event.status = status;
      }
      return event;
    }
    // Falls through to the generic tool-call rendering when rawInput.plan
    // is missing — better a one-line row than a vanished event.
  }
  const title = sanitizeSingleLine(rawTitle);
  const status = readString(u, "status");
  const rawKind = readString(u, "kind");
  const event: RenderEvent = { kind: "tool-call", toolCallId, title };
  if (status !== undefined) {
    event.status = status;
  }
  if (rawKind !== undefined) {
    event.rawKind = rawKind;
  }
  return event;
}

function mapToolCallUpdate(u: UpdateLike): RenderEvent | null {
  const toolCallId = readString(u, "toolCallId") ?? readString(u, "id");
  if (!toolCallId) {
    return null;
  }
  const rawTitle = readString(u, "title");
  const title =
    rawTitle !== undefined ? sanitizeSingleLine(rawTitle) : undefined;
  const status = readString(u, "status");
  // Suppress intermediate "updated" pings that carry nothing new —
  // they're a fan-out artifact, not user-visible signal. Render only
  // updates that change the title or land on a terminal status; the
  // initial tool_call line already shows "[pending]".
  const meaningful =
    title !== undefined ||
    status === "completed" ||
    status === "failed" ||
    status === "rejected" ||
    status === "cancelled";
  if (!meaningful) {
    return null;
  }
  const toolName = readString(u, "name") ?? rawTitle;
  if (isExitPlanModeTool(toolName)) {
    const event: RenderEvent = { kind: "exit-plan-mode", toolCallId };
    const plan = readExitPlanMarkdown(u);
    if (plan !== null) {
      event.plan = plan;
    }
    if (status !== undefined) {
      event.status = status;
    }
    return event;
  }
  const event: RenderEvent = { kind: "tool-call-update", toolCallId };
  if (title !== undefined) {
    event.title = title;
  }
  if (status !== undefined) {
    event.status = status;
  }
  if (status === "failed") {
    const errorText = extractToolFailureText(u);
    if (errorText !== null) {
      event.errorText = errorText;
    }
    if (isUpstreamInterrupted(u, errorText)) {
      event.upstreamInterrupted = true;
    }
  }
  return event;
}

// Pull the human-readable failure text out of a tool_call_update. Two
// shapes seen on the wire:
//   - content: [{ type: "content", content: { type: "text", text } }]   (ACP)
//   - rawOutput.error: "…"                                              (fallback)
// We try `content[]` first since it's the canonical ACP carrier; fall
// back to rawOutput.error so non-conforming agents still surface
// something useful.
function extractToolFailureText(u: UpdateLike): string | null {
  const content = u.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as { content?: unknown };
      const text = extractContentText(b.content);
      if (text !== null && text.length > 0) {
        return text;
      }
    }
  }
  const rawOutput = u.rawOutput;
  if (rawOutput && typeof rawOutput === "object") {
    const err = (rawOutput as { error?: unknown }).error;
    if (typeof err === "string" && err.length > 0) {
      return sanitizeWireText(err);
    }
  }
  return null;
}

// True when a failed tool_call_update carries the canonical "upstream
// silently gave up" signature: either the explicit
// `rawOutput.metadata.interrupted` flag, or the "Tool execution aborted"
// text that opencode emits when its retry loop runs out. Used by the
// turn-complete handler to override a misleadingly clean end_turn from
// the upstream agent.
function isUpstreamInterrupted(
  u: UpdateLike,
  errorText: string | null,
): boolean {
  const rawOutput = u.rawOutput;
  if (rawOutput && typeof rawOutput === "object") {
    const meta = (rawOutput as { metadata?: unknown }).metadata;
    if (meta && typeof meta === "object") {
      if ((meta as { interrupted?: unknown }).interrupted === true) {
        return true;
      }
    }
  }
  if (
    errorText !== null &&
    errorText.toLowerCase().includes("tool execution aborted")
  ) {
    return true;
  }
  return false;
}

function mapPlan(u: UpdateLike): RenderEvent | null {
  const entries = u.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }
  const normalized: PlanEntry[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const e = raw as Record<string, unknown>;
    const content =
      typeof e.content === "string"
        ? sanitizeSingleLine(e.content)
        : undefined;
    if (!content) {
      continue;
    }
    const entry: PlanEntry = { content };
    if (typeof e.status === "string") {
      entry.status = e.status;
    }
    if (typeof e.priority === "string") {
      entry.priority = e.priority;
    }
    normalized.push(entry);
  }
  return { kind: "plan", entries: normalized };
}

function mapMode(u: UpdateLike): RenderEvent | null {
  const mode =
    readString(u, "currentModeId") ??
    readString(u, "currentMode") ??
    readString(u, "mode");
  if (!mode) {
    return null;
  }
  return { kind: "mode-changed", mode: sanitizeSingleLine(mode) };
}

function mapModel(u: UpdateLike): RenderEvent | null {
  const model = readString(u, "currentModel") ?? readString(u, "model");
  if (!model) {
    return null;
  }
  return { kind: "model-changed", model: sanitizeSingleLine(model) };
}

function mapTurnComplete(u: UpdateLike): RenderEvent {
  const stopReason = readString(u, "stopReason");
  // Daemon attaches _meta["hydra-acp"].amended on the cancelled turn's
  // turn_complete when the cancellation was caused by an amend_prompt.
  // Renderers use this to paint an "amended" treatment instead of the
  // red cancelled banner.
  const meta = u._meta as
    | { "hydra-acp"?: { amended?: unknown } }
    | undefined;
  const amended =
    meta?.["hydra-acp"]?.amended !== undefined &&
    meta["hydra-acp"]!.amended !== null;
  const out: RenderEvent = { kind: "turn-complete" };
  if (stopReason !== undefined) {
    out.stopReason = stopReason;
  }
  if (amended) {
    out.amended = true;
  }
  return out;
}

function extractContentText(content: unknown): string | null {
  if (typeof content === "string") {
    return sanitizeWireText(content);
  }
  if (!content || typeof content !== "object") {
    return null;
  }
  const c = content as { type?: unknown; text?: unknown };
  if (c.type === "text" && typeof c.text === "string") {
    return sanitizeWireText(c.text);
  }
  if (typeof c.text === "string") {
    return sanitizeWireText(c.text);
  }
  return null;
}

function extractPromptText(prompt: unknown): string | null {
  if (!Array.isArray(prompt)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of prompt) {
    const text = extractContentText(block);
    if (text !== null) {
      parts.push(text);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join("");
}

function readString(u: UpdateLike, key: string): string | undefined {
  const v = u[key];
  return typeof v === "string" ? v : undefined;
}
