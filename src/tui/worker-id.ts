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
