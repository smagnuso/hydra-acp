// Derivation of the sidebar's "running" list from tool-call state.
//
// The problem this solves: the tools block lives in scrollback, so a
// long-running call scrolls off the top and there's no longer anywhere to
// see what the agent is actually doing right now.
//
// Two decisions worth knowing about.
//
// 1. SOURCE. `toolStates` / `toolCallOrder` in app.ts are per-TURN and are
//    cleared at turn boundaries. For the `edited` gadget that was a bug to
//    work around (see edited-files.ts) — but "currently running" wants
//    exactly those semantics, so this reads them directly with no
//    session-scoped accumulation.
//
// 2. NO PAGINATION. This gadget deliberately declares no `pageSize`. The
//    renderer's fitPageSize (registry.ts) computes ONE shared item limit
//    across every paginated gadget, so a list that oscillates between 0
//    and 3 entries on a per-tool-call cadence would drag the todo and
//    edited lists' page sizes up and down with it. Capping here instead,
//    with an explicit overflow row, keeps this gadget out of that budget
//    entirely. RUNNING_TOOL_CAP is that cap.

import { resolve as resolvePath } from "node:path";
import { firstLocationPath } from "../../core/tool-edit.js";
import type { ToolLineState } from "../format.js";
import type { SidebarRunningTool } from "./types.js";

// Most turns have exactly one tool in flight; parallel calls push it to a
// handful. Past that the individual rows stop being readable at a glance,
// which is the whole point of the gadget, so the rest collapse into a
// "+N more" row.
export const RUNNING_TOOL_CAP = 4;

// Terminal statuses, matching format.ts isTerminalToolStatus. Duplicated
// rather than imported because format.ts is a heavy module and this one is
// imported by the gadget layer, which is meant to stay leaf-ish; the list
// is also a wire vocabulary that changes about never.
const TERMINAL_STATUSES = new Set([
  "completed",
  "succeeded",
  "ok",
  "failed",
  "error",
  "rejected",
  "cancelled",
  "canceled",
]);

export function isRunningStatus(status: string): boolean {
  return !TERMINAL_STATUSES.has(status);
}

// Collapse whitespace and strip newlines. A gadget row containing a "\n"
// corrupts the paint, and multi-line shell input (heredocs, chained
// commands) reaches us verbatim, so this is load-bearing rather than
// cosmetic. Truncation to the column width is left to the gadget, which
// is the only layer that knows ctx.width.
export function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

// Drop the part of a detail that merely restates the verb, so a row reads
// "▸ edit" rather than "▸ edit edit".
//
// Two ways the duplication gets in. The agent refines the title to the
// tool's own name ("Edit"), which this gadget uses as its detail fallback
// and which is exactly the verb again; or an adapter encodes the verb into
// the detail itself ("Read /foo"), the same quirk formatToolLine strips at
// format.ts:1726 for the transcript row.
//
// Both the display verb and the raw ACP kind are checked, since they
// differ for execute→"run" and the agent's title could echo either.
export function dedupeDetail(
  detail: string,
  verb: string,
  rawKind?: string,
): string {
  let out = detail.trim();
  for (const word of [verb, rawKind]) {
    if (word === undefined || word === "") {
      continue;
    }
    const lower = out.toLowerCase();
    const target = word.toLowerCase();
    // Nothing but the verb: the verb is already on the row.
    if (lower === target) {
      return "";
    }
    if (lower.startsWith(`${target} `)) {
      out = out.slice(word.length).trimStart();
    }
  }
  return out;
}

// Does this title look like a bare tool NAME rather than a description of
// what the call is doing? "Write", "Read", "Bash" — one word, no path
// punctuation.
//
// This matters because the initial `tool_call` arrives with an empty
// rawInput (render-update.ts:867), so for the first moments of a call the
// title is all we have, and it's the tool's own name. Pairing it with a
// verb derived from the same `kind` produced rows like "edit Write":
// two words, one fact.
//
// A denylist of known tool names was the other option and would rot —
// every agent ships its own vocabulary. The shape of the string is the
// stabler signal.
export function isGenericToolName(title: string): boolean {
  const t = title.trim();
  if (t === "") {
    return true;
  }
  // Anything with a separator is describing a target, not naming a tool:
  // "npm test", "src/app.ts", "gadgets.ts".
  return !/[\s/.]/u.test(t);
}

// The verb shown at the head of each row. ACP `kind` is the reliable
// signal; agents that omit it get a neutral fallback rather than a guess
// derived from the title, which varies per agent.
// Verb used when the agent sent no recognizable ACP kind. Named because
// the title-fallback rule keys off it.
export const GENERIC_VERB = "tool";

export function runningVerb(rawKind: string | undefined): string {
  switch (rawKind) {
    case "read":
      return "read";
    case "edit":
      return "edit";
    case "delete":
      return "delete";
    case "move":
      return "move";
    case "search":
      return "search";
    case "execute":
      return "run";
    case "fetch":
      return "fetch";
    case "think":
      return "think";
    default:
      return GENERIC_VERB;
  }
}

// One in-flight tool call's contribution, or null when the call has
// reached a terminal status.
//
// `cwd` absolutizes tool-reported relative paths so double-click-to-open
// doesn't depend on the editor's own working directory — same convention
// as edited-files.ts.
export function runningToolFromState(
  state: Pick<
    ToolLineState,
    | "rawKind"
    | "status"
    | "locations"
    | "detail"
    | "latestTitle"
    | "startedAt"
    | "editDiff"
  >,
  cwd: string | null,
): SidebarRunningTool | null {
  if (!isRunningStatus(state.status)) {
    return null;
  }
  const verb = runningVerb(state.rawKind);
  const clean = (raw: string | undefined): string =>
    raw === undefined ? "" : dedupeDetail(oneLine(raw), verb, state.rawKind);
  // The diff's path first, then locations[] — the same order and for the
  // same reason as edited-files.ts:61. Edit-style calls (Edit / Write /
  // str_replace) routinely carry their target ONLY on the diff payload;
  // `locations[]` is the follow-along hint and plenty of agents never
  // populate it for a write. Reading locations alone left edit rows with
  // no filename at all.
  const reported = state.editDiff?.path ?? firstLocationPath(state.locations);
  const path =
    reported === undefined || reported === ""
      ? undefined
      : cwd === null
        ? reported
        : resolvePath(cwd, reported);
  // Preference order, most to least specific:
  //
  //  1. `detail` — the clipped single-line hint (the bash command, the
  //     file path). Never detailFull: that's the unclipped command and is
  //     unbounded.
  //  2. The reported location's basename. File-mutating calls routinely
  //     arrive with NO detail and a title that's just the tool's own name,
  //     which dedupeDetail then strips to nothing — leaving a bare "edit"
  //     row even though we know the file. This is that case.
  //  3. `latestTitle` — last resort, and only when it says something the
  //     verb doesn't. A bare tool name ("Write") is dropped when the verb
  //     is already specific, which is what produced "edit Write"; it is
  //     KEPT when the agent sent no recognizable kind, because then the
  //     verb is the generic "tool" and the name is the only signal there
  //     is ("tool WebSearch").
  //
  // Basename rather than the path: the column is 20-36 cells and the verb
  // and timer take about ten of them, so a leading-edge truncation of an
  // absolute path yields "/repo/src/tu" and tells the user nothing.
  const title = clean(state.latestTitle);
  const titleHint =
    verb !== GENERIC_VERB && isGenericToolName(title) ? "" : title;
  const detail = clean(state.detail) || pathHint(path) || titleHint;
  return {
    verb,
    detail: detail === "" ? undefined : detail,
    startedAt: state.startedAt,
    path,
  };
}

// Last path segment, ignoring any trailing slash. "" when there's nothing
// usable, so it falls through to the next detail source.
export function pathHint(path: string | undefined): string {
  if (path === undefined) {
    return "";
  }
  const parts = path.split("/").filter((p) => p !== "");
  return parts.at(-1) ?? "";
}

// In-flight calls in render order, capped. `order` is the app's
// toolCallOrder so rows appear in the same sequence as the tools block,
// which is what makes the gadget legible as a summary of it.
export function runningTools(
  order: readonly string[],
  states: ReadonlyMap<
    string,
    Pick<
      ToolLineState,
      | "rawKind"
      | "status"
      | "locations"
      | "detail"
      | "latestTitle"
      | "startedAt"
      | "editDiff"
    >
  >,
  cwd: string | null,
): SidebarRunningTool[] {
  const out: SidebarRunningTool[] = [];
  for (const id of order) {
    const state = states.get(id);
    if (state === undefined) {
      continue;
    }
    const entry = runningToolFromState(state, cwd);
    if (entry !== null) {
      out.push(entry);
    }
  }
  return out;
}
