# Hooks — Stage 2: transformer SDK + emulated hook catalog

Goal: ship a typed JS/TS SDK that lets a transformer subscribe to named
hooks (instead of raw ACP method strings), and add the remaining daemon
emit sites for compaction, planner, and edge-trigger synthesis. After
Stage 2, a hook author writes code that looks like pi or opencode
plugins — `hooks.on("tool:post", ...)` — and hydra handles the
ACP-to-hook-name mapping centrally.

Stage 1 (see `hooks-stage1.md`) is a hard prerequisite.

## Deliverables

1. `@hydra-acp/transformer` npm package — SDK that wraps the
   `hydra-acp/transformer/*` JSON-RPC protocol in a typed hook API.
2. Daemon-side synthesis for edge-trigger and compute-derived events
   (`tool:post`, `file:edited`, `session:idle`).
3. Daemon emits for compaction, planner subagent lifecycle, agent swap.
4. Reference transformer using the SDK that re-implements existing
   `archiver`, `notifier`, `clarifier`, `approver`, `budgeter` extension
   patterns to validate the API.

## Hook catalog

The SDK exposes these names. Each maps to one or more ACP intercepts +
optional daemon-side compute. "Wire" = the underlying transformer
intercept it subscribes to; "Compute" = any state hydra must track to
synthesize an edge.

### Lifecycle

| Hook | Wire | Compute | Flow control |
|---|---|---|---|
| `session:open` | `lifecycle:session.opened` | — | observe |
| `session:close` | `lifecycle:session.closed` | — | observe |
| `session:idle` | `lifecycle:session.idle` | — | observe |
| `session:cancel` | `request:session/cancel` | — | mutate, deny |
| `agent:initialize` | `agent:initialize` | — | mutate capabilities |
| `agent:swap` | `lifecycle:agent.swap` (new) | — | observe (cancellable variant deferred) |

### Prompts and messages

| Hook | Wire | Compute | Flow control |
|---|---|---|---|
| `prompt:pre` | `request:session/prompt` | — | mutate, deny, handled-without-LLM |
| `prompt:post` | `lifecycle:session.idle` | passes stopReason | observe |
| `message:user` | `response:session/update` filtered `user_message_chunk` | — | mutate outbound, drop |
| `message:assistant` | `response:session/update` filtered `agent_message_chunk` | — | mutate, drop |
| `message:thought` | `response:session/update` filtered `agent_thought_chunk` | — | mutate, drop |

### Tools

| Hook | Wire | Compute | Flow control |
|---|---|---|---|
| `tool:permission` | `request:session/request_permission` | — | mutate args, auto-approve, auto-deny |
| `tool:start` | `response:session/update` filtered `tool_call` | first sighting per `toolCallId` | observe, drop outbound |
| `tool:post` | `response:session/update` filtered `tool_call_update` | edge-trigger: status enters `completed` or `failed` exactly once per `toolCallId` | observe, mutate outbound |
| `tool:progress` | `response:session/update` filtered `tool_call_update` non-terminal | — | observe, mutate |
| `file:edited` | `response:session/update` filtered `tool_call_update` | dedup by `locations[].path` per path per session | observe |

### Plan / mode / commands

| Hook | Wire | Compute | Flow control |
|---|---|---|---|
| `plan:update` | `response:session/update` filtered `plan` | — | mutate, drop |
| `mode:change` | `request:session/set_mode` | — | mutate, deny |
| `mode:update` | `response:session/update` filtered `current_mode_update` | — | observe |
| `commands:update` | `response:session/update` filtered `available_commands_update` | — | mutate |

### Permission

| Hook | Wire | Compute | Flow control |
|---|---|---|---|
| `permission:pre` | `request:session/request_permission` | (same as `tool:permission`; alias) | mutate, deny, approve |
| `permission:replied` | `lifecycle:permission.replied` | — | observe |

### Compaction (daemon work in Stage 2)

| Hook | Wire | Compute | Flow control |
|---|---|---|---|
| `compact:pre` | `request:lifecycle:session.compact` (new request-shaped lifecycle) | — | cancel, replace summary |
| `compact:post` | `lifecycle:session.compacted` (new) | — | observe |

### Planner (daemon work in Stage 2)

| Hook | Wire | Compute | Flow control |
|---|---|---|---|
| `subagent:spawn` | `lifecycle:planner.spawn` (new) | — | observe |
| `subagent:result` | `lifecycle:planner.result` (new) | — | observe |
| `subagent:review` | `lifecycle:planner.review` (new) | — | observe |

### Session lifecycle gates (deferred — see Stage 3)

Cancellable session-switch/fork hooks (pi-style `session_before_*`)
require defining a request-shaped lifecycle envelope. Punted to Stage 3
unless a use case forces it earlier.

## Daemon changes

### A. Edge-trigger synthesis

**File:** `core/session.ts` or new `core/hook-edges.ts`

Track per-session state for two edges:

1. **tool completion**: a `Map<toolCallId, lastStatus>`. When a
   `tool_call_update` notification flips status to `completed` or
   `failed` (and that transition hasn't fired yet), emit a synthetic
   `hydra-acp/transformer/message` with `phase: "edge"`, `event:
   "tool:post"`, alongside the raw update. Transformers can subscribe
   to either or both.

2. **file edit dedup**: a `Set<path>` per session. When a tool_call or
   tool_call_update carries `locations[].path` matching a `kind: "edit"`
   (or any write-shaped kind), emit `file:edited` once per path per
   tool call. Reset on session close.

Optional: a TTL on the maps to bound memory.

**Wire shape:** introduce `phase: "edge"` in `hydra-acp/transformer/message`.
Existing phases are `request` / `response` / `lifecycle`. Edge messages
are notification-only (no return value used).

**Tests:** unit-test the edge tracker independently of session flow:
status transitions, idempotence under duplicate updates, multi-tool
interleaving, session reset.

### B. Compaction hooks

**File:** `core/compaction-heuristic.ts` + wherever compaction runs

Wrap the compaction trigger in a request-shaped dispatch:

```ts
const result = await this.runLifecycleRequestChain("session.compact", {
  sessionId, reason: "threshold" | "manual" | "overflow",
  willRetry, preparation,
});
if (result.shortCircuit && result.payload?.cancel) return;
const summary = result.payload?.summary ?? defaultCompact(...);
// ...
this.notifyLifecycle("session.compacted", { sessionId, summary, reason });
```

`runLifecycleRequestChain` is a new helper analogous to
`runAgentRequestChain` from Stage 1 — request-shaped, but the "method"
is a lifecycle event name. Transformers declare
`request:lifecycle:session.compact` to receive it.

**Schema:** define the envelope shape in PROTOCOL.md. At minimum:
`{ sessionId, reason, willRetry, preparation: { firstKeptEntryId,
tokensBefore, branchEntries } }`. Transformer can return
`{ cancel: true }` or `{ summary: { text, firstKeptEntryId, tokensBefore } }`.

### C. Planner emits

**File:** `planner/` (separate package, but emits cross the same daemon
broadcast path)

Add `lifecycle:planner.spawn`, `lifecycle:planner.result`,
`lifecycle:planner.review` emits at the existing planner state-machine
edges. Notification-only. Payload includes `taskId`, `agentId`,
`status`, and the relevant artifact ids.

These are observe-only in Stage 2. Cancellable variants (veto a spawn,
veto a result) deferred unless a clear use case appears.

### D. Agent swap emit

**File:** `core/session-swap-upstream.ts`

Emit `lifecycle:agent.swap` before and after a swap completes. Payload:
`{ sessionId, fromAgentId, toAgentId, phase: "pre"|"post" }`.

Cancellable variant deferred.

## SDK design

**Package:** `@hydra-acp/transformer`

```ts
import { defineTransformer } from "@hydra-acp/transformer";

export default defineTransformer({
  name: "my-hooks",

  async setup(ctx) {
    // ctx.sessionId, ctx.cwd, ctx.logger, ctx.config
  },

  hooks: {
    "tool:permission": async (event, ctx) => {
      // event.toolName, event.input (mutable), event.toolCallId
      if (event.toolName === "bash" && /rm -rf/.test(event.input.command)) {
        return { block: true, reason: "rm -rf denied by policy" };
      }
      event.input.command = `set -e\n${event.input.command}`;
      // returning nothing = continue with mutations applied
    },

    "tool:post": async (event, ctx) => {
      // event.toolCallId, event.toolName, event.status, event.content
      if (event.status === "failed" && event.toolName === "bash") {
        await ctx.notify(`bash failed: ${event.exitCode}`);
      }
    },

    "prompt:pre": async (event, ctx) => {
      // event.text, event.images
      return { transform: { text: `Be concise.\n\n${event.text}` } };
    },

    "session:idle": async (event, ctx) => {
      // event.stopReason, event.durationMs
    },

    "compact:pre": async (event, ctx) => {
      return { cancel: false, summary: await myCustomCompact(event) };
    },
  },
});
```

### Return-value contract

Each hook's return shape maps to a daemon action:

| Hook category | Return | Daemon action |
|---|---|---|
| any | `undefined` | `continue` with in-place mutations |
| any pre/request | `{ block: true, reason? }` | `stop` w/ synthesized denial |
| any pre/request | `{ transform: <envelope> }` | `continue` w/ rewritten envelope |
| `tool:permission` | `{ approve: true, optionId? }` | `stop` w/ synthesized approval |
| `prompt:pre` | `{ handled: true, reply: <chunks> }` | `stop` w/ synthesized assistant turn |
| `compact:pre` | `{ cancel: true }` or `{ summary }` | request-chain stop w/ payload |
| lifecycle / observe-only | return ignored | — |
| async | return a `Promise` | wrapped in `processing` claim automatically |

The SDK handles `continue`/`stop`/`processing` wire actions internally;
authors never see them.

### Event filtering

The SDK pre-filters by `sessionUpdate` subtype so hooks don't see
unrelated traffic. A `tool:post` handler only fires on
`tool_call_update` notifications that crossed the completion edge.

### State and lifecycle

`ctx` exposes:
- `ctx.sessionId`, `ctx.cwd`, `ctx.logger`
- `ctx.config` (transformer-specific config from daemon)
- `ctx.notify(message, level?)` — surface to client
- `ctx.state` — per-session keyed store the SDK persists across hook
  calls within a session (in-memory; opt-in disk persistence)

## Testing strategy

- SDK unit tests (no daemon): mock the JSON-RPC peer, assert each hook
  produces the correct wire `{ action, payload }`.
- Integration tests: spin up a real daemon + a test transformer using
  the SDK, drive end-to-end scenarios for each hook in the catalog.
- Convert one existing extension (suggest: `approver`) to the SDK as a
  proof-of-concept and confirm behavior parity.

## PR order

1. SDK package skeleton + types + wire mapping (no new daemon work yet —
   builds on Stage 1).
2. SDK unit tests + reference docs.
3. Daemon: edge-trigger synthesis (`tool:post`, `file:edited`).
4. SDK: edge hooks + filtering helpers.
5. Daemon: compaction hooks.
6. SDK: `compact:pre`/`compact:post`.
7. Daemon: planner emits.
8. SDK: `subagent:*`.
9. Daemon: agent-swap emit.
10. Reference transformer (port `approver` or new one) + integration tests.
11. Migration guide: how to convert existing hydra extensions
    (`archiver`, `notifier`, `slack`, etc.) to the SDK.

## Open questions

- **Naming**: `tool:permission` vs `permission:pre` vs `tool:pre`. The
  table above keeps both as aliases — confirm before locking.
- **`compact:pre` payload shape**: needs review of what compaction
  internals can stably expose.
- **Edge-trigger dedup scope**: per-session vs per-tool-call. Current
  proposal: per-`toolCallId`.
- **SDK packaging**: standalone npm vs subpath export of the existing
  CLI package. Standalone is cleaner; subpath avoids version skew.
- **Cancellable lifecycle gates** (pi's `session_before_switch` etc.):
  defer to Stage 3 unless a Stage 2 consumer needs them.

## What's still out of scope after Stage 2

- Provider-payload mutation (impossible at hydra layer; would require
  the upstream agent to expose its own hook).
- User-bash `!` interception (needs an ACP extension or hydra-specific
  side channel).
- Mutating what the *agent's LLM* remembers about a past tool result
  (the agent already has it in local conversation state; hydra can only
  mutate what the *client* sees).
- LSP / diagnostics hook surface (opencode-style). Would need a hydra
  LSP proxy — separate project.
- Project-trust hook (no trust concept in hydra yet).
