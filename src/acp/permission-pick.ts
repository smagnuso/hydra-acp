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
  // Last-resort fallback: return a kind name where an optionId is
  // expected. Most agents will reject this, so warn so the silent
  // rejection is traceable in logs.
  const fallback = preferredKinds[0] ?? "allow";
  console.warn(
    `[permission-pick] no optionId match for preferredKinds=${JSON.stringify(
      preferredKinds,
    )}; falling back to kind name ${JSON.stringify(fallback)} (agent will likely reject)`,
  );
  return fallback;
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

// What a tool call actually wants to touch, pulled out of the ACP
// toolCall so a frontend can show it instead of a bare title like
// "external_directory". Every field is best-effort: agents populate
// these inconsistently, so callers should treat an empty result as
// "nothing extra to show" and fall back to the title.
export interface PermissionDetail {
  // Tool category (read / edit / execute / fetch / …) if the agent set it.
  kind?: string;
  // File/dir paths the call targets, from toolCall.locations[].path
  // and/or rawInput.{file_path,path,filePath}.
  paths: string[];
  // Shell command for execute-kind calls (rawInput.command).
  command?: string;
  // URL for fetch-kind calls (rawInput.url).
  url?: string;
  // Short human description (rawInput.description) when present.
  description?: string;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// Extract the human-relevant context from a session/request_permission
// params payload. Shared by the TUI prompt and the daemon-side
// formatting so every frontend describes a request the same way.
export function extractPermissionDetail(params: unknown): PermissionDetail {
  const p = asRecord(params);
  const toolCall = asRecord(p?.toolCall);
  const detail: PermissionDetail = { paths: [] };
  if (!toolCall) {
    return detail;
  }
  const kind = asString(toolCall.kind);
  if (kind) {
    detail.kind = kind;
  }

  const seen = new Set<string>();
  const addPath = (val: unknown): void => {
    const s = asString(val);
    if (s && !seen.has(s)) {
      seen.add(s);
      detail.paths.push(s);
    }
  };

  const locations = toolCall.locations;
  if (Array.isArray(locations)) {
    for (const loc of locations) {
      addPath(asRecord(loc)?.path);
    }
  }

  const rawInput = asRecord(toolCall.rawInput);
  if (rawInput) {
    addPath(rawInput.file_path);
    addPath(rawInput.filePath);
    addPath(rawInput.path);
    const command = asString(rawInput.command);
    if (command) {
      detail.command = command;
    }
    const url = asString(rawInput.url);
    if (url) {
      detail.url = url;
    }
    const description = asString(rawInput.description);
    if (description) {
      detail.description = description;
    }
  }

  return detail;
}

// Collapse a PermissionDetail into a single-line summary suitable for a
// compact surface (TUI subtitle, Slack context line). Returns "" when
// there's nothing beyond the title worth showing.
export function formatPermissionDetailLine(detail: PermissionDetail): string {
  const parts: string[] = [];
  if (detail.command) {
    parts.push(`$ ${detail.command}`);
  } else if (detail.url) {
    parts.push(detail.url);
  } else if (detail.paths.length === 1) {
    parts.push(detail.paths[0] as string);
  } else if (detail.paths.length > 1) {
    parts.push(`${detail.paths[0]} (+${detail.paths.length - 1} more)`);
  } else if (detail.description) {
    parts.push(detail.description);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
