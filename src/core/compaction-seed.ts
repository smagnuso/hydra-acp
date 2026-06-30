// Build a plain-text compaction seed that replaces earlier conversation
// with a structured synopsis header followed by the most recent N turns
// in verbatim form.  The output mirrors what downstream swap paths send
// as the first `session/prompt` payload on a fresh agent process.
//
// Sections whose fields are empty / absent are omitted entirely except
// [Title] which always renders (defaulting to "(untitled)").

import { type SessionSynopsis } from "./snapshot.js";
import {
  type SessionUpdate,
  renderToolCall,
  extractText,
  extractContentText,
} from "./history-transcript.js";

// Shared entry shape so callers that hold full HistoryEntry records can
// pass them without casts.
type HistoryEntryLike = {
  method?: unknown;
  params?: unknown;
  [key: string]: unknown;
};

export interface RenderCompactionSeedOptions {
  // Optional: omit for fork/btw seeds where no synopsis exists. The
  // synopsis header block is then skipped and only the title + recent
  // turns render, with a closing note that points at recall instead of
  // claiming a compaction happened.
  synopsis?: SessionSynopsis;
  title?: string;
  tail: HistoryEntryLike[];
  // Cap on closed turns to include verbatim. Acts as the maximum even
  // when the post-watermark gap is larger (recall covers the overflow).
  tailK: number;
  // Optional: entry index the synopsis is considered to cover through.
  // When set, the tail is anchored to turns whose first entry sits at
  // or past this index — the "gap" the synopsis doesn't yet describe.
  // When unset (or 0), the renderer falls back to the legacy "last K
  // turns" behavior.
  watermark?: number;
  // Optional: minimum number of closed turns to include verbatim even
  // when the post-watermark gap is smaller (e.g. zero, when the
  // synopsis is fresh). Pre-watermark turns are reached back into to
  // satisfy the floor — those overlap the synopsis but earn their
  // tokens by giving the new agent recent ground truth. Defaults to 0
  // (compaction: pure synopsis, no continuity tail).
  tailFloor?: number;
}

const UNTITLED = "(untitled)";

export function renderCompactionSeed(
  opts: RenderCompactionSeedOptions,
): string {
  const lines: string[] = [];
  const syn = opts.synopsis;

  if (syn !== undefined) {
    // --- prior session compaction header ---
    lines.push("--- begin prior session compaction ---");

    lines.push(`[Title] ${opts.title ?? UNTITLED}`);

    if (syn.goal !== undefined && syn.goal.trim().length > 0) {
      lines.push(`[Goal] ${syn.goal}`);
    }

    if (syn.outcome !== undefined && syn.outcome.trim().length > 0) {
      lines.push(`[Outcome] ${syn.outcome}`);
    }

    const openThreads = renderSection("Open threads", syn.open_threads);
    if (openThreads.length > 0) {
      lines.push(openThreads);
    }

    const decisions = renderSection("Decisions", syn.decisions);
    if (decisions.length > 0) {
      lines.push(decisions);
    }

    const fileEditIntentions = renderSection(
      "File edit intentions",
      syn.file_edit_intentions,
    );
    if (fileEditIntentions.length > 0) {
      lines.push(fileEditIntentions);
    }

    const unresolvedErrors = renderSection(
      "Unresolved errors",
      syn.unresolved_errors,
    );
    if (unresolvedErrors.length > 0) {
      lines.push(unresolvedErrors);
    }

    const toolState = renderSection("Tool state", syn.tool_state);
    if (toolState.length > 0) {
      lines.push(toolState);
    }

    const filesTouched = renderCommaList(syn.files_touched);
    if (filesTouched.length > 0) {
      lines.push(`[Files previously touched] ${filesTouched}`);
    }

    const toolsUsed = renderCommaList(syn.tools_used);
    if (toolsUsed.length > 0) {
      lines.push(`[Tools previously used] ${toolsUsed}`);
    }

    lines.push("--- end prior session compaction ---");
  } else {
    // No synopsis (fork/btw seed) — just the title above the recent turns.
    lines.push(`[Title] ${opts.title ?? UNTITLED}`);
  }

  // --- recent turns verbatim ---
  const { closedText, openText, keptCount } = renderTail(
    opts.tail,
    opts.tailK,
    opts.watermark ?? 0,
    opts.tailFloor ?? 0,
  );
  lines.push("--- begin recent turns (verbatim, last " + keptCount + ") ---");
  if (closedText.length > 0) {
    lines.push(closedText);
  }
  lines.push("--- end recent turns ---");
  if (openText.length > 0) {
    lines.push("--- begin current in-flight turn (no completion yet) ---");
    lines.push(openText);
    lines.push("--- end current in-flight turn ---");
  }

  // closing note
  lines.push("");
  if (syn !== undefined) {
    lines.push(
      "(Hydra has compacted earlier conversation. Do NOT call any tools yet. Do NOT read any files, run any commands, or invoke hydra-recall. Reply with the single word 'OK' and wait for the next user message — at that point you can use the hydra-recall tools to look up specifics on demand if needed.)",
    );
  } else {
    lines.push(
      "(This is a side conversation forked from another session. The turns above are the most recent; earlier history is available on demand via the hydra-recall tools. Do NOT call any tools yet. Do NOT read any files or run any commands. Reply with the single word 'OK' and wait for the next user message.)",
    );
  }

  return lines.join("\n");
}

// Render a section with bullet points, or an empty string when the field
// is absent / empty so callers can skip adding it.
function renderSection(
  label: string,
  items: unknown[] | undefined,
): string {
  if (!items || !Array.isArray(items)) {
    return "";
  }
  const bullets = items.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (bullets.length === 0) {
    return "";
  }
  const lines = bullets.map((b) => "- " + b.trim());
  return `[${label}] ${lines.join("\n")}`;
}

// Render a comma-separated list, or empty string when absent/unparseable.
function renderCommaList(items: unknown[] | undefined): string {
  if (!items || !Array.isArray(items)) {
    return "";
  }
  const valid = items.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (valid.length === 0) {
    return "";
  }
  return valid.map((v) => v.trim()).join(", ");
}

// Select and render the verbatim tail: closed turns (clamped by
// watermark + floor + max) and any in-flight open turn.
//
// Selection rule for closed turns:
//   postWatermark = closed turns whose first entry index >= watermark
//   keep          = clamp(postWatermark.length, floor, max)
//   tail          = closed.slice(-keep)
//
// When watermark === 0 (legacy / not provided), this degrades to
// "last min(max, closed.length) turns" because floor defaults to 0 and
// postWatermark = all closed turns. That preserves the original
// fixed-last-K behavior for callers that don't anchor.
function renderTail(
  history: HistoryEntryLike[],
  tailMax: number,
  watermark: number,
  tailFloor: number,
): { closedText: string; openText: string; keptCount: number } {
  if (history.length === 0) {
    return { closedText: "", openText: "", keptCount: 0 };
  }

  const { closed, open } = extractTurns(history);
  let keptCount = 0;
  let kept: ClosedTurn[] = [];
  if (tailMax > 0 && closed.length > 0) {
    const postWatermark = closed.filter((t) => t.startEntryIndex >= watermark).length;
    const target = Math.max(postWatermark, tailFloor);
    const clamped = Math.min(target, tailMax, closed.length);
    keptCount = clamped;
    kept = clamped > 0 ? closed.slice(-clamped) : [];
  }

  const closedText = kept.length > 0 ? renderTurns(kept) : "";
  const openText = open ? renderTurns([open]) : "";
  return { closedText, openText, keptCount };
}

function renderTurns(turns: Array<{ user: string; agent: string; tools: string[] }>): string {
  const rendered: string[] = [];
  for (const turn of turns) {
    if (turn.user.length > 0) {
      rendered.push("User: " + turn.user);
    }
    if (turn.agent.length > 0) {
      rendered.push("Assistant: " + turn.agent);
    }
    for (const tool of turn.tools) {
      rendered.push(tool);
    }
  }
  return rendered.join("\n");
}

type ClosedTurn = {
  user: string;
  agent: string;
  tools: string[];
  // Entry index of this turn's prompt_received within the history
  // array. Used to anchor the tail against the synopsis watermark.
  startEntryIndex: number;
};

// Extract user/agent turns from history entries using the same logic as
// renderTranscript. Consecutive agent_message_chunk entries are merged
// into one assistant message per turn; tool_call entries are captured
// inline. Returns closed turns separately from any trailing in-flight
// turn (a prompt_received with no matching turn_complete), so callers
// can render the open turn in its own section. Incomplete turns at the
// start of the slice (agent activity without a preceding prompt) are
// dropped.
function extractTurns(history: HistoryEntryLike[]): {
  closed: ClosedTurn[];
  open: ClosedTurn | null;
} {
  const closed: ClosedTurn[] = [];
  let currentTurn: ClosedTurn | null = null;

  for (let i = 0; i < history.length; i++) {
    const entry = history[i] as HistoryEntryLike;
    if (entry.method !== "session/update") {
      continue;
    }
    const params = entry.params as { update?: SessionUpdate } | undefined;
    const update = params?.update;
    if (!update || typeof update.sessionUpdate !== "string") {
      continue;
    }

    const kind = update.sessionUpdate;

    if (kind === "prompt_received") {
      if (currentTurn !== null && currentTurn.user.length > 0) {
        closed.push(currentTurn);
      }
      currentTurn = {
        user: extractText(update.prompt).trim(),
        agent: "",
        tools: [],
        startEntryIndex: i,
      };
    } else if (kind === "agent_message_chunk" && currentTurn !== null) {
      const chunk = extractContentText(update.content);
      if (chunk.length > 0) {
        currentTurn.agent += chunk;
      }
    } else if (kind === "tool_call" && currentTurn !== null) {
      currentTurn.tools.push(renderToolCall(update));
    } else if (kind === "turn_complete") {
      if (currentTurn !== null) {
        closed.push(currentTurn);
        currentTurn = null;
      }
    }
  }

  const open =
    currentTurn !== null && currentTurn.user.length > 0 ? currentTurn : null;
  return { closed, open };
}


