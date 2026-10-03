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
// usage_update discontinuity (no text, no structured marker), caught by
// isContextUsageDrop.
//
// opencode: its ACP bridge never forwards the internal session.compacted
// event, but the summary it wrote streams as an ordinary mid-turn
// agent_message_chunk under its own messageId, always shaped
// "## Objective\n...## Important Details\n...". Matching both headings in one
// message identifies it; see OpencodeSummaryDetector.
//
// Usage discontinuity: any agent that reports `used` shows a large fall when
// it compacts itself. isContextUsageDrop is the generic fallback; the caller
// must exclude drops hydra caused (swap in flight) itself.

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

const OPENCODE_SUMMARY_HEADINGS = ["## Objective\n", "## Important Details\n"];
const OPENCODE_SUMMARY_MAX_BUFFER = 8_000;
const USAGE_DROP_MIN_PRIOR = 20_000;
const USAGE_DROP_RATIO = 0.5;

// True when `used` fell by more than half from a substantial prior figure
// to a nonzero one. Zero is excluded: that reads as a cleared context, not
// a compaction.
export function isContextUsageDrop(prev: number | undefined, next: number): boolean {
  return (
    prev !== undefined &&
    prev >= USAGE_DROP_MIN_PRIOR &&
    next > 0 &&
    next < prev * USAGE_DROP_RATIO
  );
}

// Stateful: the summary arrives as many chunks, so each new messageId's text
// is buffered while it still looks like the start of a summary and the
// detector fires once, when both headings have been seen.
export class OpencodeSummaryDetector {
  private messageId: string | undefined;
  private buffer = "";
  private settled = false;

  // True exactly once per summary message, on the chunk that completes it.
  feed(update: Record<string, unknown> | undefined): boolean {
    if (!update || update.sessionUpdate !== "agent_message_chunk") {
      return false;
    }
    const content = update.content;
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      return false;
    }
    const text = (content as Record<string, unknown>).text;
    if (typeof text !== "string") {
      return false;
    }
    const messageId =
      typeof update.messageId === "string" ? update.messageId : undefined;
    if (messageId === undefined || messageId !== this.messageId) {
      this.messageId = messageId;
      this.buffer = "";
      this.settled = messageId === undefined;
    }
    if (this.settled) {
      return false;
    }
    this.buffer += text;
    const first = OPENCODE_SUMMARY_HEADINGS[0]!;
    const head = this.buffer.slice(0, first.length);
    if (!first.startsWith(head) || this.buffer.length > OPENCODE_SUMMARY_MAX_BUFFER) {
      this.settled = true;
      this.buffer = "";
      return false;
    }
    if (OPENCODE_SUMMARY_HEADINGS.every((h) => this.buffer.includes(h))) {
      this.settled = true;
      this.buffer = "";
      return true;
    }
    return false;
  }
}
