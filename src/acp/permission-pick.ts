// Pull an allow-flavored optionId out of an ACP
// `session/request_permission` params payload, used by code paths that
// auto-approve without showing a UI (cat's hydra-acp-stdin auto-allow, and
// the --dangerously-skip-permissions paths in tui / shim / cat). Tries
// preferredKinds in order, then falls back to the first option present,
// then to the first preferred kind name itself. Returning a kind name
// instead of an optionId is a last resort — most agents won't accept it
// — but it keeps the contract total so callers don't have to handle a
// "no options at all" case.

interface PermissionOption {
  kind?: string;
  optionId?: string;
}

export function pickPermissionOptionId(
  params: unknown,
  preferredKinds: ReadonlyArray<string>,
): string {
  const options =
    params && typeof params === "object"
      ? ((params as { options?: unknown }).options as unknown[] | undefined)
      : undefined;
  if (Array.isArray(options)) {
    for (const kind of preferredKinds) {
      const match = options.find(
        (o): o is PermissionOption =>
          typeof o === "object" &&
          o !== null &&
          (o as { kind?: unknown }).kind === kind &&
          typeof (o as { optionId?: unknown }).optionId === "string",
      );
      if (match?.optionId !== undefined) {
        return match.optionId;
      }
    }
    const fallback = options.find(
      (o): o is PermissionOption =>
        typeof o === "object" &&
        o !== null &&
        typeof (o as { optionId?: unknown }).optionId === "string",
    );
    if (fallback?.optionId !== undefined) {
      return fallback.optionId;
    }
  }
  return preferredKinds[0] ?? "allow";
}

// Build the response body for an auto-approved permission request.
// Picks allow_once first (transient — doesn't pollute the agent's
// persisted permission rules), then allow_always, then whatever's
// available. The "selected" outcome shape matches what the daemon's
// permission flow expects.
export function buildApproveResponse(
  params: unknown,
): { outcome: { outcome: "selected"; optionId: string } } {
  const optionId = pickPermissionOptionId(params, [
    "allow_once",
    "allow_always",
  ]);
  return { outcome: { outcome: "selected", optionId } };
}

export function buildRejectResponse(
  params: unknown,
): { outcome: { outcome: "selected"; optionId: string } } {
  const optionId = pickPermissionOptionId(params, [
    "reject_once",
    "reject_always",
  ]);
  return { outcome: { outcome: "selected", optionId } };
}
