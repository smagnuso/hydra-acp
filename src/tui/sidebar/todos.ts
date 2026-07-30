// Todo extraction for the sidebar's `todo` gadget.
//
// The gadget was built against the ACP `plan` session update, which is the
// spec-native way to express a task list. In practice no agent sends it:
// across every session on disk — both opencode and claude-acp — there are
// zero `plan` updates. Both agents express todos as a `todowrite` TOOL CALL
// whose rawInput carries the whole list:
//
//   { todos: [ { content, status, priority }, ... ] }
//
// which is structurally identical to PlanEntry. So the gadget reads either
// source, and this module is the adapter for the one that actually fires.
//
// Deliberately scoped to the sidebar. Synthesizing a `plan` RenderEvent in
// render-update.ts would also make the transcript grow a plan block for
// every agent that uses todowrite — a much larger behavioural change, and
// one that would sit alongside the todowrite row already in the tools
// block.

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
