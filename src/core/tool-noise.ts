// Recognizes tool calls that are scaffolding around another tool call
// rather than actions in their own right, so session-wide summary views
// (the tools histogram, the TUI's running-tools sidebar) can skip them.
//
// Currently just codex-acp's Guardian: its automated pre-execution safety
// review fires once per guarded action (every shell exec, apply_patch,
// network call, MCP call...) as its own paired tool_call/tool_call_update,
// so it roughly doubles the visible call count while adding nothing a
// summary view didn't already get from the action it's reviewing. The
// underlying history/broadcast is untouched — this only gates what a
// display aggregates, the same "shared fact, each site keeps its own
// question" split as tool-edit.ts.
//
// Both signals below come straight from codex-acp's CodexToolCallMapper.ts
// (guardianApprovalReviewToolCallId, createGuardianApprovalReviewToolCall):
// the toolCallId is always `guardian_assessment:<reviewId>` and the title
// is always the literal string "Guardian Review". Checking either alone
// would work; checking both is free and survives either one drifting.
const GUARDIAN_REVIEW_TOOL_CALL_ID_PREFIX = "guardian_assessment:";
const GUARDIAN_REVIEW_TITLE = "Guardian Review";

export function isGuardianReviewToolCall(
  toolCallId: string | undefined,
  title: string | undefined,
): boolean {
  return (
    (toolCallId !== undefined &&
      toolCallId.startsWith(GUARDIAN_REVIEW_TOOL_CALL_ID_PREFIX)) ||
    title === GUARDIAN_REVIEW_TITLE
  );
}
