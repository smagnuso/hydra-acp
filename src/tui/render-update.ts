// Pure (no I/O, no terminal-kit) mapper from ACP `session/update` notifications
// into `RenderEvent`s the screen layer knows how to render.

export type RenderEvent =
  | { kind: "agent-text"; text: string }
  | { kind: "agent-thought"; text: string }
  | { kind: "user-text"; text: string; sentBy?: string }
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
    }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "mode-changed"; mode: string }
  | { kind: "model-changed"; model: string }
  | { kind: "turn-complete"; stopReason?: string }
  | {
      kind: "usage-update";
      used?: number;
      size?: number;
      costAmount?: number;
      costCurrency?: string;
    }
  | { kind: "available-commands"; commands: AvailableCommand[] }
  | { kind: "unknown"; sessionUpdate: string; raw: unknown };

export interface AvailableCommand {
  name: string;
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
    default:
      return { kind: "unknown", sessionUpdate: tag, raw: update };
  }
}

function mapAvailableCommands(u: UpdateLike): RenderEvent | null {
  const list = u.availableCommands ?? u.commands;
  if (!Array.isArray(list)) {
    return null;
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
    // Per the ACP schema, agent commands are advertised by bare name
    // (e.g. "create_plan"). The TUI's completion model expects all
    // entries to be slash-prefixed so they match what the user types.
    const name = c.name.startsWith("/") ? c.name : `/${c.name}`;
    const cmd: AvailableCommand = { name };
    if (typeof c.description === "string") {
      cmd.description = c.description;
    }
    out.push(cmd);
  }
  return { kind: "available-commands", commands: out };
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
    typeof u.text === "string" ? u.text : extractContentText(u.content);
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

function mapToolCall(u: UpdateLike): RenderEvent | null {
  const toolCallId = readString(u, "toolCallId") ?? readString(u, "id");
  if (!toolCallId) {
    return null;
  }
  const title =
    readString(u, "title") ??
    readString(u, "name") ??
    readString(u, "label") ??
    "tool call";
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
  const title = readString(u, "title");
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
  const event: RenderEvent = { kind: "tool-call-update", toolCallId };
  if (title !== undefined) {
    event.title = title;
  }
  if (status !== undefined) {
    event.status = status;
  }
  return event;
}

function mapPlan(u: UpdateLike): RenderEvent | null {
  const entries = u.entries;
  if (!Array.isArray(entries)) {
    return null;
  }
  const normalized: PlanEntry[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const e = raw as Record<string, unknown>;
    const content = typeof e.content === "string" ? e.content : undefined;
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
  const mode = readString(u, "currentMode") ?? readString(u, "mode");
  if (!mode) {
    return null;
  }
  return { kind: "mode-changed", mode };
}

function mapModel(u: UpdateLike): RenderEvent | null {
  const model = readString(u, "currentModel") ?? readString(u, "model");
  if (!model) {
    return null;
  }
  return { kind: "model-changed", model };
}

function mapTurnComplete(u: UpdateLike): RenderEvent {
  const stopReason = readString(u, "stopReason");
  return stopReason !== undefined
    ? { kind: "turn-complete", stopReason }
    : { kind: "turn-complete" };
}

function extractContentText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!content || typeof content !== "object") {
    return null;
  }
  const c = content as { type?: unknown; text?: unknown };
  if (c.type === "text" && typeof c.text === "string") {
    return c.text;
  }
  if (typeof c.text === "string") {
    return c.text;
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
