/**
 * Extract the optional `workerTaskId` field from a raw session update.
 * Returns `undefined` when the field is absent or the input is not an object.
 */
export function getWorkerTaskId(update: unknown): string | undefined {
  if (!update || typeof update !== "object") {
    return undefined;
  }
  const u = update as Record<string, unknown>;
  return typeof u.workerTaskId === "string" ? u.workerTaskId : undefined;
}

/**
 * Extract Claude Code's `parentToolUseId` from a raw update's
 * `_meta.claudeCode` namespace. Set on a tool call issued by a subagent
 * spawned via the `Task` tool, not by the top-level turn — unlike
 * `workerTaskId` (hydra's own background-task extension), this is never
 * set for a native Claude subagent's own tool calls. Returns `undefined`
 * when absent.
 */
export function getParentToolUseId(update: unknown): string | undefined {
  if (!update || typeof update !== "object") {
    return undefined;
  }
  const meta = (update as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== "object") {
    return undefined;
  }
  const claudeCode = (meta as Record<string, unknown>).claudeCode;
  if (!claudeCode || typeof claudeCode !== "object") {
    return undefined;
  }
  const id = (claudeCode as Record<string, unknown>).parentToolUseId;
  return typeof id === "string" ? id : undefined;
}
