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

// Just the agent id (or "?" when unknown). Used by `sessions list` rows
// and the TUI picker. Cost lives in its own COST column now, and the
// model in its own optional MODEL column, so the AGENT cell stays a bare
// identifier. (The TUI header still shows agent•model for the live
// session separately.)
export function formatAgentCell(agentId: string | undefined): string {
  return agentId ?? "?";
}

// Cost cell for the session table's COST column. USD (or unspecified)
// renders as a whole-dollar `$N` — cents are dropped to keep the
// far-right column uncluttered. Non-USD keeps two decimals plus the
// code (`X.XX <code>`) since rounding an unfamiliar currency is riskier.
// Returns "" (not "-") when there's no cost data, so empty cost reads as
// blank rather than a column of dashes.
export function formatCostCell(usage: DisplayUsage | undefined): string {
  if (!usage || typeof usage.costAmount !== "number") {
    return "";
  }
  const { costAmount, costCurrency } = usage;
  if (costCurrency === undefined || costCurrency === "USD") {
    return `$${Math.round(costAmount)}`;
  }
  return formatCost(costAmount, costCurrency);
}

// Formats a cost amount with sensible defaults for header display:
// USD (or unspecified) renders as `$X.XX`; other currencies fall back to
// `X.XX <code>`.
export function formatCost(amount: number, currency: string | undefined): string {
  const sign = currency === "USD" || currency === undefined ? "$" : "";
  const decimals = 2;
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
