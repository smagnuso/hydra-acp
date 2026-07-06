# Hooks — Stage 3: `@hydra-acp/transformer` SDK + host binary

Goal: ship the user-facing payoff for all the daemon work done in Stages 1
and 2. After Stage 3, writing a hydra hook is dropping a config file at
`~/.hydra-acp/transformer.config.js` (the casual path) or depending on
`@hydra-acp/transformer` from a sibling package and shipping a custom
binary (the planner/budgeter path).

Stages 1 and 2 (daemon wiring) are hard prerequisites. The wire protocol
defined in `cli/PROTOCOL.md` is the contract this stage builds on top of;
no further daemon changes are required.

## Repo and package conventions

Mirrors `hydra-acp/planner/` and `hydra-acp/approver/`. Lives as a
sibling directory:

```
hydra-acp/
  cli/                       # daemon + CLI
  planner/                   # @hydra-acp/planner
  approver/                  # @hydra-acp/approver
  notifier/                  # @hydra-acp/notifier
  budgeter/, clarifier/, archiver/, slack/, browser/
  transformer/               # @hydra-acp/transformer (NEW)
```

**Package metadata** (mirror `planner/package.json` exactly except where
noted; same versions, same scripts, same `tsup`/`tsconfig`/`engines`):

```jsonc
{
  "name": "@hydra-acp/transformer",
  "version": "0.0.1",
  "description": "JS-injected hooks for hydra-acp — drop a .config.js file or build a custom transformer with the SDK.",
  "license": "MIT",
  "type": "module",
  "publishConfig": { "access": "public", "registry": "https://registry.npmjs.org" },
  "files": ["dist", "README.md", "LICENSE"],
  "main": "dist/lib.js",            // library entry (defineTransformer, types)
  "bin": {
    "hydra-acp-transformer": "dist/index.js"   // host binary
  },
  "exports": {
    ".":         { "import": "./dist/lib.js", "types": "./dist/lib.d.ts" },
    "./types":   { "import": "./dist/types.js", "types": "./dist/types.d.ts" }
  },
  // scripts, engines, dependencies, devDependencies all mirror planner.
  // Extra dep: "jiti": "^2.x" for on-the-fly .ts loading in the binary.
  "dependencies": {
    "ws":   "^8.20.0",
    "jiti": "^2.4.0"
  }
}
```

The package is the **first transformer in the ecosystem that's also a
library**. Planner has only `main` pointing at its binary because nothing
imports it. The transformer SDK has both: `main` for library consumers
(planner, budgeter), `bin` for the host binary.

**tsconfig.json**: copy `planner/tsconfig.json` verbatim. Same strict
flags, same `outDir`, same module resolution.

**tsup.config.ts**: copy `planner/tsup.config.ts`. Same `bundle: false`
per-file emit, same target.

**Directory layout** (mirrors `planner/src/`):

```
transformer/
  package.json
  tsconfig.json
  tsup.config.ts
  src/
    index.ts             # entry — dual-mode like planner/src/index.ts:
                         #   if HYDRA_ACP_TRANSFORMER_NAME set → runHost()
                         #   else → CLI mode (--version, --help, --validate <path>)
    lib.ts               # library export: defineTransformer, hook types
    types.ts             # standalone exported types (re-exported by lib)
    host.ts              # the host runtime: load config, wire hooks to bridge
    bridge.ts            # TransformerBridge — connects to daemon, dispatches
                         #   intercepts to user hooks, encodes return values
    config.ts            # loadHostConfig (env, paths); loadUserScript (jiti)
    hooks/
      catalog.ts         # NAME → wire intercept mapping (the hook catalog)
      filter.ts          # sessionUpdate subtype filtering for tool/message hooks
      contract.ts        # return-value → wire action encoding
    acp/
      protocol.ts        # mirror planner/src/acp/protocol.ts
      transformer.ts     # mirror planner/src/acp/transformer.ts — WS client
    util/
      log.ts             # mirror planner/src/util/log.ts
  test/
    bridge.test.ts
    contract.test.ts
    catalog.test.ts
    host.test.ts
    config.test.ts
  README.md
  LICENSE
```

## Two consumption modes

### Mode A — casual author (host binary)

```bash
hydra extension add @hydra-acp/transformer
# adds to ~/.hydra-acp/extensions or wherever hydra registers extensions
```

User drops `~/.hydra-acp/transformer.config.js`:

```js
import { defineTransformer } from "@hydra-acp/transformer";

export default defineTransformer({
  hooks: {
    "tool:permission": async (event) => {
      if (event.toolName === "bash" && /\brm -rf /.test(event.input.command ?? "")) {
        return { block: true, reason: "policy: rm -rf denied" };
      }
    },
    "file:edited": async (event, ctx) => {
      ctx.logger.info(`edited: ${event.path}`);
    },
    "session:idle": async () => { /* … */ },
  },
});
```

Adds `@hydra-acp/transformer` to `defaultTransformers` in hydra config.
Daemon spawns the binary on the next session. The binary detects
`HYDRA_ACP_TRANSFORMER_NAME` is set, loads the config file via `jiti`
(so `.ts` works too), and runs.

**Config resolution** (mirrors approver's pattern in
`approver/src/config.ts`):

- Default path: `${HOME}/.hydra-acp/transformer.config.js` (also tries
  `.ts`, `.mjs`, `.cjs` in that order)
- Env override: `HYDRA_ACP_TRANSFORMER_CONFIG=<absolute path>`
- Missing file: log a warning, idle (no hooks). **Do not crash** — same
  fail-open posture as approver.
- Malformed default export: log error, idle. Surfaces user mistakes
  without taking the session down.

**Hot reload** (mirrors approver's SIGHUP behavior):

- `SIGHUP` → re-import the config, atomically swap the live hook set
- Old hook invocations in flight are allowed to complete with the old
  closures; new invocations use the new ones
- Errors during reload leave the old hook set in place

### Mode B — bespoke transformer (library)

Planner-style packages depend on `@hydra-acp/transformer` and write
their own multi-file source. No host binary involved.

```jsonc
// budgeter/package.json (after porting)
{
  "name": "@hydra-acp/budgeter",
  "main": "dist/index.js",
  "bin": { "hydra-acp-budgeter": "dist/index.js" },
  "dependencies": { "@hydra-acp/transformer": "^0.0.1" }
}
```

```ts
// budgeter/src/index.ts
import { runTransformer, defineTransformer } from "@hydra-acp/transformer";

const transformer = defineTransformer({
  hooks: {
    "tool:permission": async (event) => { /* budget gating */ },
    "session:idle": async () => { /* budget rollup */ },
  },
});

if (process.env.HYDRA_ACP_TRANSFORMER_NAME) {
  void runTransformer(transformer);
}
```

`runTransformer` is the same code path the host binary uses — it accepts
a `defineTransformer` result directly instead of loading from disk.

## Library API

### `defineTransformer(spec)` → `TransformerDefinition`

```ts
export interface TransformerSpec {
  // Optional setup, runs once after WS handshake completes.
  setup?: (ctx: SetupContext) => void | Promise<void>;

  // Hook map. Keys are typed hook names from the catalog (below).
  // Values receive the typed event for that name plus a `ctx`.
  hooks: Partial<HookHandlers>;
}

export function defineTransformer(spec: TransformerSpec): TransformerDefinition;
```

The return value is intentionally opaque — it's a tagged container the
host / `runTransformer` knows how to consume. Users never construct it
manually.

### `runTransformer(definition)` → `Promise<void>`

Library consumers (budgeter, planner port) call this from their own
binary entry point. Equivalent to what the host binary does, minus the
config-file loading step.

### `ctx` API

Every hook handler and `setup` callback receives a `ctx` second
argument:

```ts
interface Context {
  sessionId: string;
  cwd: string;            // session's working directory
  logger: Logger;         // .debug / .info / .warn / .error
  notify(level: "info"|"warn"|"error", message: string): void;
                          // surfaces to attached clients
  state: Map<string, unknown>;
                          // per-session in-memory store; survives across
                          // hook invocations but not across daemon restart
  signal: AbortSignal;    // aborted when the session closes or the
                          // daemon shuts the transformer down
}

interface SetupContext extends Omit<Context, "sessionId" | "cwd"> {
  // setup runs once per transformer process, not per session
}
```

## Hook catalog (typed names → wire intercepts)

The SDK maps friendly hook names onto the wire-level intercept strings
defined by Stages 1 and 2. The map lives in `src/hooks/catalog.ts`:

| SDK hook name | Wire intercept | Filter | Event payload shape |
|---|---|---|---|
| `session:open` | `lifecycle:session.opened` | — | `{}` |
| `session:close` | `lifecycle:session.closed` | — | `{}` |
| `session:idle` | `lifecycle:session.idle` | — | `{}` |
| `prompt:pre` | `request:session/prompt` | — | `PromptEnvelope` |
| `permission:pre` (alias `tool:permission`) | `request:session/request_permission` | — | `PermissionEnvelope` |
| `permission:replied` | `lifecycle:permission.replied` | — | `{ toolCallId, outcome, sourceWasTransformer }` |
| `tool:start` | `response:session/update` | `sessionUpdate==="tool_call"` | `ToolCall` |
| `tool:progress` | `response:session/update` | `sessionUpdate==="tool_call_update"` AND not terminal | `ToolCallUpdate` |
| `tool:post` | `lifecycle:tool.completed` | — | `{ toolCallId, status, kind?, content?, locations? }` |
| `file:edited` | `lifecycle:file.edited` | — | `{ path, toolCallId, line? }` |
| `message:assistant` | `response:session/update` | `sessionUpdate==="agent_message_chunk"` | `MessageChunk` |
| `message:thought` | `response:session/update` | `sessionUpdate==="agent_thought_chunk"` | `MessageChunk` |
| `message:user` | `response:session/update` | `sessionUpdate==="user_message_chunk"` | `MessageChunk` |
| `plan:update` | `response:session/update` | `sessionUpdate==="plan"` | `PlanUpdate` |
| `mode:change` | `request:session/set_mode` | — | `ModeChangeRequest` |
| `mode:update` | `response:session/update` | `sessionUpdate==="current_mode_update"` | `ModeUpdate` |
| `commands:update` | `response:session/update` | `sessionUpdate==="available_commands_update"` | `CommandsUpdate` |
| `session:cancel` | `request:session/cancel` | — | `CancelEnvelope` |
| `session:new` | `request:session/new` | — | `NewSessionEnvelope` |
| `session:load` | `request:session/load` | — | `LoadSessionEnvelope` |
| `auth:required` | `request:authenticate` | — | `AuthEnvelope` |
| `agent:initialize` | `agent:initialize` | — | `AgentCapabilities` |
| `agent:swap` | `lifecycle:agent.swap` | — | `{ phase, previousUpstreamSessionId, upstreamSessionId?, agentId }` |
| `compaction` | `lifecycle:compaction` | — | `{ phase, ... }` |

The bridge subscribes only to wire intercepts that have at least one
registered hook, so a transformer that only listens for `tool:post`
doesn't get the full `response:session/update` firehose.

## Return-value contract

Each hook can return one of these shapes (or `undefined` / a `Promise`
of one of them). The bridge translates to the wire action verbs.

| Return | Wire action | Where it's valid |
|---|---|---|
| `undefined` | `continue` (no rewrite) | every hook |
| `{ transform: <envelope> }` | `continue` with payload rewrite | every request/response hook |
| `{ block: true, reason?: string }` | `stop` with synthesized denial | every request hook |
| `{ approve: true, optionId?: string }` | `stop` with synthesized approval | `permission:pre` only |
| `{ handled: true, reply: <chunks> }` | `stop` with synthesized assistant reply | `prompt:pre` only |
| `Promise<any of the above>` | `processing` claim + auto keep-alive + discharge | every async hook |

Lifecycle hooks (`session:open`, `tool:post`, `file:edited`, …) ignore
return values — they're notifications. The SDK accepts a return for
API uniformity but logs and discards it.

**Implementation note.** `processing`-claim discharge auto-keep-alive
is implemented by sending `hydra-acp/connection/keep_alive` every
`TRANSFORMER_CLAIM_TIMEOUT_MS / 2` for the duration of the hook's
Promise, so long-running async hooks don't time out. Daemon-side
support is already in place (`session.ts:keepAliveClaim`).

## Files mirrored from planner

These have direct equivalents and should be copied with minor
adaptations (transformer-specific instead of planner-specific):

- `src/acp/protocol.ts` — JSON-RPC framing types, `ACP_PROTOCOL_VERSION` constant.
- `src/acp/transformer.ts` — WS client + handshake. Sends
  `hydra-acp/transformer/initialize` with the computed `intercepts[]`,
  receives `hydra-acp/transformer/message` requests and dispatches them.
- `src/util/log.ts` — same structured logger.
- Top-level `src/index.ts` — dual-mode entry (HYDRA_ACP_TRANSFORMER_NAME
  triggers `runHost()` aka the host binary path; absent triggers CLI
  mode with `--validate <path>` / `--help` / `--version`).

## Files unique to the SDK

- `src/lib.ts` — library entry. Re-exports `defineTransformer`,
  `runTransformer`, `Context`, `Logger`, and all event payload types.
  This is what `import` resolves to.
- `src/host.ts` — host runtime that wraps `runTransformer` with config-
  file loading via `jiti`, SIGHUP hot reload, and the
  HYDRA_ACP_TRANSFORMER_CONFIG resolution.
- `src/bridge.ts` — `TransformerBridge`. Owns the WS client, computes
  the union of wire intercepts from the user's hook map, dispatches
  incoming `hydra-acp/transformer/message` requests to the right user
  hook (with payload typed correctly via the catalog), encodes the
  return value into a wire action.
- `src/config.ts` — `loadHostConfig` (env → paths) and
  `loadUserScript(path)` (jiti-based import + `defineTransformer`
  result validation).
- `src/hooks/catalog.ts` — the SDK hook name → wire intercept map and
  per-hook subtype filter.
- `src/hooks/filter.ts` — subtype filters (e.g. `tool:start` only fires
  on `sessionUpdate === "tool_call"`).
- `src/hooks/contract.ts` — `encodeHookReturn(hookName, returnValue) →
  { action, payload? }`.

## Config and env

Mirrors `approver/src/config.ts` exactly:

```ts
interface HostConfig {
  hydraDaemonUrl: string;             // HYDRA_ACP_DAEMON_URL
  hydraWsUrl: string;                 // HYDRA_ACP_WS_URL or derived
  hydraToken: string;                 // HYDRA_ACP_TOKEN
  configPath: string;                 // HYDRA_ACP_TRANSFORMER_CONFIG or
                                      //   ~/.hydra-acp/transformer.config.js
  debug: boolean;                     // DEBUG
}
```

`HYDRA_ACP_TRANSFORMER_NAME` is set by the daemon; presence of this
env triggers host mode. Its value identifies the transformer instance
to the daemon (used in the `initialize` handshake's `clientName`).

## Tests

Mirror planner's test layout (`test/*.test.ts`, no `__tests__` folder,
`node --test --import tsx` runner). Cover:

- `bridge.test.ts` — bridge subscribes only to wire intercepts whose
  hook is registered; dispatches the right typed payload; encodes
  return values per the contract; handles async hooks as processing
  claims with keep-alive.
- `contract.test.ts` — every return-value shape maps to the correct
  wire action verb. Invalid combinations (e.g. `approve` on
  `prompt:pre`) throw a clear error at registration time, not at
  invoke time.
- `catalog.test.ts` — every typed hook name resolves to the correct
  wire intercept + filter. Snapshot the table so additions/changes
  are explicit.
- `host.test.ts` — load `transformer.config.js` from a temp dir,
  observe hook invocations against a mock daemon. SIGHUP reload
  picks up edits. Missing file → idle, no crash.
- `config.test.ts` — env resolution: path defaults, overrides,
  derived WS URLs (same shape as approver's existing tests).

## Reference port

To validate the API against a real consumer, port **`approver`** as
the first reference transformer:

1. Approver currently uses the WS-attach extension model (broadcast
   race pattern at `approver/src/bridge.ts:101-104`).
2. With Stage 1's `session/request_permission` chain wiring, approver
   becomes the *sole* responder when registered as a transformer.
3. Port: replace `approver/src/acp/attach.ts` and the bridge wiring
   with a `defineTransformer({ hooks: { "permission:pre": ... } })`
   consuming `@hydra-acp/transformer` as a library. Keep approver's
   rule.ts / config.ts / permission.ts unchanged — those are the
   domain logic.
4. Expected shrink: ~700 → ~50 lines of plumbing in approver.

This validates both the library API and the Stage 1 wire-level
semantics in one move.

## Open questions

- **Hook name finality.** `permission:pre` vs `tool:permission` —
  catalog lists both as aliases. Pick one and deprecate the other
  before 0.1.0.
- **`prompt:post` semantics.** Maps to `lifecycle:session.idle` today
  but conflates "this turn ended" with "the session went quiet" (the
  idle timer is debounced). If a hook author needs precise turn-end
  edges, we may need a daemon emit for that specifically.
- **Multi-instance casual mode.** Should the host binary support
  multiple config files (`~/.hydra-acp/transformer.d/*.config.js`)?
  Today the design is one file per transformer-process; multi-file
  needs a clear merge semantics for hook collisions and is deferred
  to Stage 4.
- **`jiti` cost at startup.** Compare to `tsx` cold-start. Pi uses
  jiti; if startup is a concern, allow opting into precompiled
  builds (then config is a plain `.js` and we skip jiti).

## PR order

Each PR should be reviewable in isolation:

1. **Repo skeleton + package.json/tsconfig/tsup mirrors of planner.**
   No code; just the structure that signals what's coming.
2. **`src/acp/protocol.ts` + `src/acp/transformer.ts` + `src/util/log.ts`** —
   copied from planner, with imports rewritten. Standalone unit
   tests pass.
3. **`src/lib.ts` + `src/hooks/catalog.ts` + `src/hooks/contract.ts`** —
   the typed API surface, no daemon interaction yet. Pure-function
   tests for the catalog and contract.
4. **`src/bridge.ts` + `src/hooks/filter.ts`** — wire the catalog to
   the WS client. Tests against a mock daemon.
5. **`src/host.ts` + `src/config.ts` + `src/index.ts`** — host binary
   that loads `transformer.config.js`. End-to-end test with `jiti`
   and a real config file.
6. **README + examples + npm publish 0.0.1.**
7. **`approver` port** — separate PR in the approver repo. Validates
   the API and unlocks the Stage 1 sole-responder semantics.

## What's deferred to Stage 4

- Planner port (large; useful but not gating).
- Notifier / clarifier / budgeter / archiver / slack ports (do them
  one at a time after approver proves the model).
- Multi-instance casual mode (`~/.hydra-acp/transformer.d/*.js`).
- Cancellable `compact:pre` (needs daemon-side request-chain dispatch
  from `SessionManager.dispatchCompactionSwap`).
- Planner subagent emits (`subagent:spawn`/`result`/`review`) — emit
  sites in `planner/src/bridge.ts`.
- Chain walker unification in the daemon.
- LSP / diagnostics hook surface (would need a hydra LSP layer first;
  out of scope for this whole roadmap).
