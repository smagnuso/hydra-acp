// Drop the provider prefix from a model id ("openai/gpt-4o-mini" →
// "gpt-4o-mini", "ncp-anthropic/claude-opus-4-7" → "claude-opus-4-7").
// Keeps headers and table rows from blowing out on registries that
// namespace by provider. If there's no slash, returns the id as-is.
export function shortenModel(model: string | undefined): string | undefined {
  if (!model) {
    return undefined;
  }
  const idx = model.lastIndexOf("/");
  if (idx === -1) {
    return model;
  }
  return model.slice(idx + 1);
}

// "<agent-id>•<model>" when both are present (bullet ties them visually
// into a single identifier without spending two columns on parens or
// surrounding whitespace); just "<agent-id>" when the model is unknown
// (cold session that's never been attached, registry agent that
// doesn't expose a model, etc.). Used by the TUI header bar, where
// the right-aligned usage block displays cost separately.
const AGENT_MODEL_SEP = "•";

export function formatAgentWithModel(
  agentId: string | undefined,
  model: string | undefined,
): string {
  const agent = agentId ?? "?";
  const short = shortenModel(model);
  if (!short) {
    return agent;
  }
  return `${agent}${AGENT_MODEL_SEP}${short}`;
}

// Minimal usage shape consumed by formatAgentCell. Mirrors the wider
// SessionRecord/SessionListEntry/UsageSnapshot fields (so callers can
// pass any of them directly without a mapping) while only the cost
// fields are actually read here.
export interface DisplayUsage {
  used?: number;
  size?: number;
  costAmount?: number;
  costCurrency?: string;
}

// Same agent•model framing as formatAgentWithModel, but appends a
// whole-dollar cost suffix when the last-known usage carries one. Used
// by `sessions list` rows and the TUI picker, where there's no separate
// usage column — cost piggybacks on the AGENT cell so cold sessions
// surface it without claiming additional width. Sub-dollar costs are
// dropped entirely (the row stays uncluttered for cheap sessions); the
// header bar keeps full precision via formatCost.
export function formatAgentCell(
  agentId: string | undefined,
  model: string | undefined,
  usage: DisplayUsage | undefined,
): string {
  const base = formatAgentWithModel(agentId, model);
  if (!usage || typeof usage.costAmount !== "number") {
    return base;
  }
  const compact = formatCostCompact(usage.costAmount, usage.costCurrency);
  if (compact === null) {
    return base;
  }
  return `${base} ${compact}`;
}

// Formats a cost amount with sensible defaults for header display:
// USD (or unspecified) renders as `$X.XX`; other currencies fall back to
// `X.XX <code>`. More decimals for sub-dollar amounts so a $0.0042 cost
// doesn't round to `$0.00`.
export function formatCost(amount: number, currency: string | undefined): string {
  const sign = currency === "USD" || currency === undefined ? "$" : "";
  const decimals = amount >= 1 ? 2 : 4;
  return `${sign}${amount.toFixed(decimals)}${
    currency && currency !== "USD" ? ` ${currency}` : ""
  }`;
}

// Whole-dollar variant for the picker/list rows. Returns null when the
// amount rounds to zero so the caller can omit the suffix entirely
// (sub-50¢ sessions render as just `agent•model` without trailing noise).
export function formatCostCompact(
  amount: number,
  currency: string | undefined,
): string | null {
  const whole = Math.round(amount);
  if (whole === 0) {
    return null;
  }
  const sign = currency === "USD" || currency === undefined ? "$" : "";
  return `${sign}${whole}${
    currency && currency !== "USD" ? ` ${currency}` : ""
  }`;
}
