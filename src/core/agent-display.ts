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

// "<agent-id>(<model>)" when both are present; just "<agent-id>" when the
// model is unknown (cold session that's never been attached, registry agent
// that doesn't expose a model, etc.). Used by both the TUI header and the
// `hydra sessions` table.
export function formatAgentWithModel(
  agentId: string | undefined,
  model: string | undefined,
): string {
  const agent = agentId ?? "?";
  const short = shortenModel(model);
  if (!short) {
    return agent;
  }
  return `${agent}(${short})`;
}
