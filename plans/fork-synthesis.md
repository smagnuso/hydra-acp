# Plan: Synthesis-Based Fork

## Goal

Replace fork's current "copy sliced history + verbatim replay" with "copy full history + run synopsis + seed via compaction prompt + mint recall." Forks become snapshot-isolated successors that carry the parent's entire conversation, present a concise synthesized brief to the new agent, and use the recall MCP as the deep-dive escape hatch.

## Design

A fork is created via the synopsis pipeline (same machinery as compaction) but its sink is a brand-new session, not a swapped upstream. The new session owns a full, frozen copy of the parent's `history.jsonl` so recall queries stay self-contained (no cross-session pointers, no rewrite-leakage footguns, exports/deletes of the parent are safe).

Compaction and fork end up as two sinks on one pipeline:
- **Compaction**: synopsis → swap upstream in same session, keep same history file.
- **Fork**: synopsis → write new session, copy full parent history, seed new agent with synopsis prompt on first attach, mint recall.

## Touch list

### 1. `src/core/session-store.ts`
**No schema change.** The seed-path discriminator is derived at first-attach from existing fields:
- `forkedFromSessionId` set + `synopsis` populated → `seedFromFork()` (synthesis).
- `forkedFromSessionId` set + no `synopsis` → `seedFromImport()` (verbatim — graceful fallback if synopsis generation failed at fork time).
- Neither fork breadcrumb → `seedFromImport()` (cross-machine import path, unchanged).

`tailK` is a module constant, not per-session state.

### 2. `src/core/synopsis-agent.ts`
No code change. Already reusable as a pure function over a passed-in history array — `sessionId` opt is cosmetic. Call from `forkSession` directly.

### 3. `src/core/session-manager.ts` — `forkSession` (L2386–2522)
Insert a synthesis branch between slice and bundle:

- Add `mode?: "verbatim" | "synthesis"` to `ForkSessionOpts`, default `"synthesis"`.
- For `mode === "synthesis"`:
  - Skip `forkAt` resolution (synthesis forks always include everything).
  - `slicedHistory = sourceHistory` (full).
  - Call `generateSynopsis({ agentId: targetAgentId, cwd, history: sourceHistory, modelId, sessionId: sourceSessionId, ... })`.
  - On success: set `recordForBundle.synopsis = result.synopsis`, `recordForBundle.summarizedThroughEntry = sourceHistory.length`.
  - On synopsis failure: log + fall back to `mode = "verbatim"` (graceful degrade — fork still works, just without the brief).
- `mode === "verbatim"` keeps today's behavior verbatim (used by `/btw` sidechain, see §6).

`writeImportedRecord` (L2532–2628) needs no schema-level change since the new field rides on `SessionRecord`. Just plumb it through the bundle.

### 4. `src/core/session.ts` — first-attach seeding (L4806 `seedFromImport`)
Add a sibling `seedFromFork()` method:
- Reads `this.record.synopsis` (already populated by `forkSession`).
- Loads `historyEntries = await historyStore.load(this.sessionId)` (the copied full parent history is now this session's own history file).
- Computes `tail = historyEntries.slice(-TAIL_K)` using the same module constant compaction uses.
- Renders prompt via `renderCompactionSeed({ synopsis, title: record.title, tail, tailK: TAIL_K })`.
- Runs via `runInternalPrompt(prompt)` with suppress-broadcast-and-record behavior matching `swapUpstream` (so the seed doesn't pollute the fork's own history).

### 5. `src/core/session-manager.ts` — `doResurrectFromImport` dispatch (~L887–983, call at L981)
Branch: if `record.forkedFromSessionId && record.synopsis` → `session.seedFromFork()`; else `session.seedFromImport()`. Verbatim-mode forks (no synopsis populated) and cross-machine imports both fall through to the existing path.

### 6. `src/daemon/acp-ws.ts` — recall mint
- Resurrect path predicate at L258: extend to `alreadyCompacted || forkSynthesisSeed != null`. Simpler alternative: since synthesis forks set `summarizedThroughEntry = parentHistoryLen` at write time, the existing predicate fires for free. **Use the implicit path — no acp-ws change required.**
- Verify: `mintMcpServersForSwap` wiring already covers post-attach swap re-mints; nothing new needed there either.

### 7. `src/tui/btw/sidechain.ts`
Pin sidechain forks to `mode: "verbatim"` at the call site (L325-ish in `discovery.ts` or wherever sidechain invokes fork — needs a body field). Rationale: `/btw` attaches with `historyPolicy: "full"` (L205) and renders the prior conversation verbatim in the overlay; a synthesis fork would degrade that UX. Also keeps sidechain latency low (no ephemeral synopsis spawn for a short-lived ancillary prompt).

### 8. HTTP + ACP fork endpoints
- `src/daemon/routes/sessions.ts:527` (`POST /v1/sessions/:id/fork`): accept optional `mode` in body, pass through.
- `src/daemon/acp-ws.ts:771` (`hydra-acp/session/fork`): same.
- TUI: keep current default ("synthesis") for the picker-triggered fork; explicit `mode` only on programmatic callers that opt out.

## Behavioral matrix

| Caller | Mode | History copied | Synopsis generated | Seed prompt | Recall minted |
|---|---|---|---|---|---|
| TUI fork picker | synthesis (default) | full | yes | compaction-seed | yes (via `summarizedThroughEntry`) |
| `/btw` sidechain | verbatim | sliced | no | switch-transcript replay | only if parent was already compacted |
| API caller (explicit) | either | per mode | per mode | per mode | per mode |
| Cross-agent fork | synthesis | full | yes | compaction-seed | yes |

## Edge cases / decisions

- **Synopsis failure during fork**: fall back to verbatim. User still gets a usable fork. Log loudly.
- **Forking a session that's mid-compaction**: queue behind it, or just snapshot whatever `histories.load` returns at fork time (it's a consistent read). Pick the latter — simpler, fork is allowed to "see" a slightly-stale parent.
- **Fork of a fork**: works trivially. The parent fork has its own full `history.jsonl` (frozen baseline + post-fork turns). Synthesis runs over it. Disk grows linearly with fork depth; acceptable.
- **Tool blobs**: extend the existing fork-time blob copy to cover the full history's referenced blobs, not just the sliced range. Already handled by `writeImportedRecord` if we pass the full bundle.
- **`forkAt` (forking at past message)**: only meaningful for `mode: "verbatim"`. For synthesis mode, `forkAt` is silently ignored (synthesis always covers full history). Or: pass `forkAt` as a slice bound *into the synopsis input*, producing a brief that pretends history ended at that point. Decision needed — recommend ignore-and-document for v1, revisit if anyone asks.
- **Prompt history**: copy in full (matches "no data lost" goal). Already copied today.
- **`interactive: false`** on new fork: keep as-is.

## Implementation order

1. `Session.seedFromFork()` in `session.ts` (mirrors `swapUpstream` seed render, no agent swap).
2. Dispatch branch in `doResurrectFromImport` (`session-manager.ts`).
3. `forkSession` synthesis branch + `mode` opt (`session-manager.ts`).
4. Wire `mode` through HTTP + ACP fork endpoints.
5. Pin `/btw` sidechain to `mode: "verbatim"`.
6. Tests: synthesis fork creates session, runs synopsis, first attach emits seed, recall returns results from parent history; verbatim fork unchanged; sidechain still renders verbatim history in overlay.

## Open questions for you

1. **Default mode at the HTTP/ACP layer**: synthesis or verbatim? I'd default the *internal* TS option to synthesis but require external callers to opt in via `mode: "synthesis"` for one release, so anyone consuming the API today doesn't get behavior-shifted under them. OK?
2. **`forkAt` in synthesis mode**: ignore (recommend) vs. error vs. slice-then-synthesize? I lean ignore + doc.
3. **`tailK` for the seed**: what value? Compaction's current default lives in the swap call site — reuse the same constant or expose it on fork?
4. **`/btw` sidechain**: confirm it stays verbatim. (I think yes — synthesis adds latency the sidechain doesn't want, and the overlay needs verbatim history to render.)
