# Hooks — Stage 1: daemon wiring

Goal: extend hydra's existing transformer/intercept surface so a JS-injected
transformer can emulate the full Claude Code + pi + opencode hook set without
further daemon changes downstream. Stage 1 lands the dispatch sites and
lifecycle emits; Stage 2 builds the user-facing transformer SDK on top.

## Background

Hydra already has a generic transformer chain (`core/session.ts:898`,
`core/session.ts:2640`) that runs on:

- `request:${method}` for any client→agent request (generic dispatch).
- `response:session/update` for agent→client notifications (HARDCODED to one method).
- `agent:initialize` (one-off bespoke dispatch in `session-manager.ts:554`).
- `lifecycle:session.opened` (notification-only, `session.ts:2619`).

The action contract is `continue` (rewrite envelope) / `stop` (synthesize
short-circuit payload) / `processing` (async claim, discharged via
`emit_message` with `respondsTo`). That's already as expressive as pi's
`block`/`transform`/`handled` or Claude's `decision`/`continue`/`additionalContext`.

What's missing is dispatch sites — specifically: `session/request_permission`
doesn't run through the chain, the response chain is locked to one method,
and there are no edge emits for idle/closed/permission-replied.

## Non-goals

- No new protocol verbs. Reuse `hydra-acp/transformer/message`,
  `continue`/`stop`/`processing`, and the existing claim/discharge flow.
- No compaction, planner, fs/terminal, or trust hooks — Stage 2.
- No SDK / DX work — Stage 2.

## Changes

### 1. Generalize the response chain

**File:** `core/session.ts` (`runResponseChain`, ~line 898)

Replace the hardcoded intercept-name check:

```ts
// before
if (!t.intercepts.has("response:session/update")) continue;
// after
if (!t.intercepts.has(`response:${method}`)) continue;
```

Rename the function to take `method` as its first parameter. Update the
`wireAgent` notification handler at `session.ts:839` to pass
`"session/update"`. Update the `forwardRequest` notification tail (which
also calls broadcast logic) if it reuses this path.

**Backward compatibility:** existing transformers declaring
`response:session/update` continue to work — the chain still fires for
that method, just via the generalized predicate.

**Tests:** extend `session-transformer.test.ts` with a transformer
declaring `response:fs/read_text_file` (or any other future method) and
assert the chain dispatches.

**LoC:** ~15 incl. signature changes.

### 2. Wire `session/request_permission` through a chain

**File:** `core/session.ts` (`wireAgent` at ~line 850, plus new helper)

Add a symmetric `runAgentRequestChain(method, params)` mirroring
`forwardRequest` but for *agent→client* requests:

```ts
private async runAgentRequestChain(
  method: string,
  params: unknown,
): Promise<{ shortCircuit: false; envelope: unknown }
         | { shortCircuit: true; payload: unknown }> {
  let envelope = params;
  for (const t of this.transformChain) {
    if (!t.intercepts.has(`request:${method}`)) continue;
    const token = `t_${generateChainToken()}`;
    const result = await t.connection.request("hydra-acp/transformer/message", {
      token, phase: "request", method,
      direction: "agent→client",
      sessionId: this.sessionId,
      envelope,
    }) as { action: string; payload?: unknown } | undefined;

    const action = result?.action ?? "continue";
    if (action === "stop") {
      return { shortCircuit: true, payload: result?.payload ?? defaultDeny(method) };
    }
    if (action === "continue") {
      if (result?.payload && typeof result.payload === "object") {
        envelope = result.payload;
      }
      continue;
    }
    if (action === "processing") {
      // reuse pendingClaims machinery; resolves to a short-circuit payload
      // or to { shortCircuit: false, envelope } depending on the
      // transformer's emit_message response.
      // ...claim-and-await logic mirroring forwardRequest's processing branch
    }
  }
  return { shortCircuit: false, envelope };
}
```

Wrap the existing permission handler:

```ts
agent.connection.onRequest("session/request_permission", async (params) => {
  const chained = await this.runAgentRequestChain(
    "session/request_permission",
    params,
  );
  if (chained.shortCircuit) {
    // notify lifecycle:permission.replied with sourceWasTransformer: true
    this.notifyLifecycle("permission.replied", {
      sessionId: this.sessionId,
      toolCallId: extractToolCallId(params),
      outcome: chained.payload,
      sourceWasTransformer: true,
    });
    return chained.payload;
  }
  const outcome = await this.handlePermissionRequest(chained.envelope);
  this.notifyLifecycle("permission.replied", {
    sessionId: this.sessionId,
    toolCallId: extractToolCallId(chained.envelope),
    outcome,
    sourceWasTransformer: false,
  });
  return outcome;
});
```

`defaultDeny(method)` returns the ACP-canonical "cancelled" outcome:
`{ outcome: { cancelled: {} } }`. Transformers can override by supplying
their own `payload`.

**Semantics surfaced to transformers:**

- `continue` w/ rewritten envelope → user prompt sees modified options /
  tool args. Use case: narrow option set, rewrite dangerous args.
- `stop` w/ `payload: { outcome: { selected: { optionId } } }` →
  auto-approve without prompting.
- `stop` w/ `payload: { outcome: { cancelled: {} } }` → auto-deny.
- `processing` → async (e.g. external policy service).

**Tests:** new file `permission-chain.test.ts`. Cover:

- transformer declares `request:session/request_permission`, returns
  `continue` w/ rewrite → handler runs with rewritten params.
- transformer returns `stop` w/ approval → user never prompted, outcome
  forwarded to agent.
- transformer returns `stop` w/ denial → same.
- transformer returns `processing`, then discharges via `emit_message`
  with `respondsTo` → resolves correctly.
- timeout on `processing` → fail-open to next transformer or to handler.
- chain with two transformers, first rewrites, second short-circuits →
  second sees the rewritten envelope.

**LoC:** ~80 incl. tests.

### 3. Lifecycle emit sites

**Files:** `core/session.ts`, possibly `core/session-manager.ts`

Reuse the existing `notifyLifecycle(event, payload)` helper at
`session.ts:5387`. Add three emit sites:

| Event | Emit site | Payload |
|---|---|---|
| `lifecycle:session.idle` | After in-flight `session/prompt` resolves, before returning to client | `{ sessionId, stopReason, durationMs }` |
| `lifecycle:session.closed` | In `markClosed`, before tearing state down | `{ sessionId, reason }` |
| `lifecycle:permission.replied` | After `handlePermissionRequest` resolves (see change #2) | `{ sessionId, toolCallId, outcome, sourceWasTransformer }` |

All three are notification-only — `notifyLifecycle` already runs as
fire-and-forget. Transformers that declare the matching intercept name
get a `hydra-acp/transformer/message` with `phase: "lifecycle"`.

**Tests:** extend `session-transformer.test.ts`:

- prompt completes → `lifecycle:session.idle` fires with the agent's
  stopReason.
- session closes via `markClosed` → `lifecycle:session.closed` fires
  exactly once.
- transformer not declaring the intercept → no call.

**LoC:** ~30 incl. tests.

### 4. Optional: route `agent:initialize` through the generalized chain

**File:** `core/session-manager.ts:554`

The existing one-off dispatch becomes a call to the same
`runAgentResponseChain` with `method: "initialize"`. Identical behavior,
shared code path, future-proof against `agent:reinitialize` on swap.

**Tests:** existing `agent:initialize` tests should pass unchanged.

**LoC:** ~20 (refactor, net delete likely).

### 5. PROTOCOL.md updates

**File:** `PROTOCOL.md`

Add three sections:

1. **Action contract** — formally spec `continue` / `stop` /
   `processing`, their payload semantics per phase, and the
   `respondsTo` discharge flow.

2. **Lifecycle intercepts** — enumerate `session.opened`,
   `session.closed`, `session.idle`, `permission.replied`,
   `agent:initialize`. Notification-only, no response expected.

3. **Recognized intercept names** — add `request:session/request_permission`
   to the list. Note that `response:${method}` is now generic.

**LoC:** doc-only.

## Migration / compatibility

- No transformer needs to change its declared intercepts. Existing
  declarations (`request:session/prompt`, `response:session/update`,
  `agent:initialize`, `lifecycle:session.opened`) all continue to work
  unchanged.
- The `hydra-acp/transformer/message` envelope shape is unchanged;
  `direction` field already exists and is now set to `agent→client` for
  the new `request:session/request_permission` dispatch.
- Daemon version bump optional. No protocol break.

## PR order

Each change can land independently:

1. PROTOCOL.md updates (no code; sets expectations for downstream).
2. Generalize response chain (#1).
3. Lifecycle emit sites (#3).
4. Permission chain (#2) — the headline change.
5. `agent:initialize` refactor (#4) — polish.

After all five: a transformer can emulate the full hook set documented
in `plans/hooks-stage2.md`.

## What's deferred to Stage 2

- Transformer SDK / DX (typed event names, helper for filtering
  `tool_call_update` subtype, edge-trigger dedup).
- Compaction hooks (`compact:pre`/`compact:post`).
- Planner hooks (`subagent:spawn`/`subagent:result`/`subagent:review`).
- File-edit dedup (`file:edited`) and idle synthesis from streams.
- Project-trust hook.
- User-bash interception (needs ACP extension).
- Provider-payload hooks (impossible at hydra layer — agent owns provider).
