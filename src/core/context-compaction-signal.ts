// Recognizes when an underlying agent process reports that it already
// compacted its own context window on its own terms — independent of
// hydra's own compaction/synopsis machinery entirely. Feeds
// Session.armRecallInPlace: the agent already relieved its own context
// pressure, so hydra has nothing to add there. All it's missing is a
// watermark, so recall-server.ts's call-time gate stops answering
// "nothing compacted yet".
//
// codex-acp (CodexToolCallMapper.ts, createContextCompactionCompleteUpdate
// / createCompletedContextCompactionUpdate): emits a synthetic tool_call /
// tool_call_update with kind:"think", title:"Compact conversation",
// _meta.contextCompaction, status:"completed" once its own compaction
// finishes. Checking title and _meta together — same "either alone
// would work, checking both is free and survives either one drifting"
// reasoning as tool-noise.ts's Guardian detection.
//
// claude-agent-acp (acp-agent.ts): only the manual `/compact` path is
// distinguishable. The SDK's compact_result:"success" status is relayed
// as a fixed-string agent_message_chunk, "\n\nCompacting completed." —
// hardcoded in the wrapper's own code, not model-generated, so an exact
// match is safe. A self-triggered compaction there surfaces only as a
// usage_update discontinuity (no text, no structured marker), which this
// module deliberately does not try to catch: that's indistinguishable
// from hydra's own char-estimate noise and not worth a heuristic.
//
// opencode: nothing to check for. Its ACP bridge (acp/event.ts) never
// forwards the internal session.compacted event at all.

const CODEX_COMPACTION_TITLE = "Compact conversation";
const CODEX_COMPACTION_META_KEY = "contextCompaction";
const CLAUDE_COMPACTION_COMPLETE_TEXT = "\n\nCompacting completed.";

// True when `update` (the `session/update` notification's `update` field)
// is codex-acp's own-compaction-complete tool_call_update.
export function isCodexSelfCompactionUpdate(
  update: Record<string, unknown> | undefined,
): boolean {
  if (!update || update.status !== "completed") {
    return false;
  }
  if (
    update.sessionUpdate !== "tool_call" &&
    update.sessionUpdate !== "tool_call_update"
  ) {
    return false;
  }
  const meta = update._meta;
  const hasCompactionMeta =
    meta !== null &&
    typeof meta === "object" &&
    CODEX_COMPACTION_META_KEY in (meta as Record<string, unknown>);
  return update.title === CODEX_COMPACTION_TITLE || hasCompactionMeta;
}

// True when `update` is claude-agent-acp's manual-/compact-complete text
// chunk.
export function isClaudeSelfCompactionUpdate(
  update: Record<string, unknown> | undefined,
): boolean {
  if (!update || update.sessionUpdate !== "agent_message_chunk") {
    return false;
  }
  const content = update.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return false;
  }
  return (
    (content as Record<string, unknown>).text === CLAUDE_COMPACTION_COMPLETE_TEXT
  );
}

// True when this update reports that the agent already compacted its own
// context on its own terms, regardless of which agent sent it.
export function isSelfCompactionUpdate(
  update: Record<string, unknown> | undefined,
): boolean {
  return (
    isCodexSelfCompactionUpdate(update) || isClaudeSelfCompactionUpdate(update)
  );
}
