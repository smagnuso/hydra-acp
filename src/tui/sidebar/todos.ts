// Todo extraction from a `todowrite` tool call, for anything that wants an
// agent's task list.
//
// There are two channels for the same information and agents pick between
// them arbitrarily. The spec-native one is the ACP `plan` session update;
// the other is a `todowrite` TOOL CALL whose rawInput carries the whole list:
//
//   { todos: [ { content, status, priority }, ... ] }
//
// structurally identical to PlanEntry. This module is the adapter for the
// second.
//
// Do not assume either channel is dead. Measured across the sessions on
// disk: claude-acp sends thousands of `plan` updates and no todowrite;
// opencode sends both, and WHICH ONE varies session to session for the same
// build — some of its sessions carry only `plan`, some only todowrite, some
// both. So a consumer that reads just one silently loses the list for an
// arbitrary subset of sessions. That is exactly what happened to the
// transcript's plan block, which understood only `plan` until app.ts started
// routing this adapter's output through renderPlanBlock too.

import type { PlanEntry } from "../../core/render-update.js";

// Statuses the plan formatter understands. Anything else is normalized to
// "pending" rather than passed through, so an unexpected value can't leak
// into a style lookup.
const KNOWN_STATUSES = new Set(["pending", "in_progress", "completed"]);

interface RawUpdateLike {
  rawInput?: unknown;
  [key: string]: unknown;
}

// Pull a todo list off a raw session update, or null when the update isn't
// one. Null means "not a todo payload", which callers must distinguish from
// an empty list — an empty `todos: []` is a real event (the agent cleared
// its list) and should clear the gadget.
export function parseTodoWrite(rawUpdate: unknown): PlanEntry[] | null {
  if (rawUpdate === null || typeof rawUpdate !== "object") {
    return null;
  }
  const update = rawUpdate as RawUpdateLike;
  const rawInput = update.rawInput;
  if (rawInput === null || typeof rawInput !== "object") {
    return null;
  }
  const todos = (rawInput as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) {
    return null;
  }
  const out: PlanEntry[] = [];
  for (const item of todos) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const { content, status, priority } = item as {
      content?: unknown;
      status?: unknown;
      priority?: unknown;
    };
    if (typeof content !== "string" || content.length === 0) {
      continue;
    }
    const entry: PlanEntry = {
      content,
      status:
        typeof status === "string" && KNOWN_STATUSES.has(status)
          ? status
          : "pending",
    };
    if (typeof priority === "string" && priority.length > 0) {
      entry.priority = priority;
    }
    out.push(entry);
  }
  return out;
}
