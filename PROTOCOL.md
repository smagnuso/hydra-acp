# Hydra protocol reference

> **Status: experimental.** Every endpoint, method, parameter, and notification documented below may change without notice. Pin against a specific `@hydra-acp/cli` version if you're building against this surface.

The daemon exposes three surfaces on a single TCP port (default `127.0.0.1:55514`):

- **REST API** at `/v1/*` — management plane. Used by the CLI, the browser extension's UI, and any out-of-band tooling.
- **ACP WebSocket** at `/acp` — JSON-RPC 2.0. Where editors, the TUI, extensions, and transformers attach. Carries standard ACP plus the Hydra-specific extensions documented here.
- **Agent-facing MCP** at `/mcp/*` — Streamable HTTP MCP transport that spawned agents use to reach the per-session stdin ring buffer (`hydra cat --stream`) and any extension-contributed MCP tools.

## Contents

- [Authentication](#authentication)
- [REST API](#rest-api)
  - [Health](#health)
  - [Auth](#auth)
  - [Config](#config)
  - [Sessions](#sessions)
  - [Agents](#agents)
  - [Registry](#registry)
  - [Extensions](#extensions)
  - [Transformers](#transformers)
- [MCP endpoints](#mcp-endpoints)
- [ACP wire protocol](#acp-wire-protocol)
  - [The `hydra-acp` meta namespace](#the-hydra-acp-meta-namespace)
  - [Prompt-queue surface](#prompt-queue-surface)
  - [Stdin streaming](#stdin-streaming)
  - [Local fork](#local-fork)
  - [Agent install progress](#agent-install-progress)
  - [Extension and transformer plumbing](#extension-and-transformer-plumbing)
  - [Transformer-only methods](#transformer-only-methods)
  - [Capability discovery](#capability-discovery)
- [JSON-RPC error codes](#json-rpc-error-codes)

---

## Authentication

Hydra uses one auth model across REST and the WebSocket:

- A **service token** lives in `~/.hydra-acp/auth-token` (mode `0600`), generated at `hydra-acp init`. This is the long-lived root credential.
- **Session tokens** are short-lived bearers minted by [`POST /v1/auth/login`](#post-v1authlogin) (password-derived). They're scope-equivalent to the service token but can be labelled, expire on a TTL, and be revoked individually.
- **Per-process tokens** are minted at extension/transformer spawn time and injected as `HYDRA_ACP_TOKEN`. They share the service-token scope but have process-lifetime semantics.

Every REST endpoint requires `Authorization: Bearer <token>` except `GET /v1/health` and `POST /v1/auth/login`. The `/acp` WebSocket accepts the token via a `hydra-acp-token.<token>` subprotocol entry or a `?token=<token>` query parameter. The two `/mcp/*` routes use a different trust domain: per-session capability tokens minted at `session/new` time and embedded into the agent's `mcpServers` descriptors — they bypass the global Bearer hook.

### REST status codes

Standard:

- `200` — OK, body present.
- `201` — created.
- `202` — accepted, work continues asynchronously.
- `204` — OK, no body.
- `400` — request validation failed.
- `401` — missing or invalid bearer.
- `403` — preconditions not met (e.g. login without a password configured).
- `404` — unknown resource.
- `409` — conflict (lineage clash, already attached, …).
- `429` — rate limited.
- `500` — internal error.

### REST error body

All 4xx/5xx responses carry a JSON body of the shape:

```json
{ "error": "<human-readable message>" }
```

Some endpoints attach extra context fields documented in their own section (e.g. `existingSessionId` on `409 BundleAlreadyImported`, `details` on bundle decode failures). Anything you receive that isn't `error` should be treated as best-effort metadata.

---

## REST API

### Health

#### `GET /v1/health`

Liveness probe. No auth.

**Response — `200 OK`**

```json
{ "status": "ok", "version": "0.1.0" }
```

### Auth

#### `POST /v1/auth/login`

Exchange the daemon's master password (set with `hydra-acp auth password`) for a session token. No auth required on the request itself. Login is rate-limited per-IP on repeated failures.

**Request body**

```jsonc
{
  "password": "<master password>",
  "label":    "<optional human label, ≤256 chars>",
  "ttlSec":   3600   // optional; otherwise daemon default
}
```

**Response — `200 OK`**

```jsonc
{
  "session_token": "<opaque bearer>",
  "id":            "<token id, used by /v1/auth/sessions/:id>",
  "expires_at":    "2026-05-29T19:00:00.000Z"
}
```

**Errors**

- `400` — invalid request body.
- `401` — invalid password.
- `403` — no master password configured (`hydra-acp auth password` was never run).
- `429` — too many failed attempts from this IP; back off.

#### `POST /v1/auth/logout`

Revoke a session token. The body is optional; when omitted, the caller's own bearer is revoked. Calling with the service-token bearer is a no-op (returns `200 { revoked: false }`).

**Request body — optional**

```jsonc
{ "id": "<session token id>" }
```

**Response — `200 OK`**

```jsonc
{ "revoked": true }
```

#### `GET /v1/auth/verify`

Trivial validity check used by the browser extension's SPA gate to detect an expired bearer.

**Response — `200 OK`**

```json
{ "ok": true }
```

#### `GET /v1/auth/sessions`

List active session tokens. Metadata only — plaintext tokens are never returned.

**Response — `200 OK`**

```jsonc
{
  "sessions": [
    {
      "id":         "<token id>",
      "label":      "<optional>",
      "createdAt":  "<ISO-8601>",
      "expiresAt":  "<ISO-8601>",
      "lastUsedAt": "<ISO-8601>"
    },
    …
  ]
}
```

#### `DELETE /v1/auth/sessions/:id`

Revoke a specific session token.

**Response**

- `204` — revoked.
- `404` — token id unknown.

### Config

#### `GET /v1/config`

Read-only snapshot of the daemon's effective config. Mutations go through `~/.hydra-acp/config.json` and require `hydra-acp daemon restart` to take effect — there is no `PUT /v1/config`.

**Response — `200 OK`**

```jsonc
{
  "defaultAgent":         "claude-acp",
  "defaultCwd":           "~",
  "defaultModels":        { "claude-acp": "claude-opus-4-7" },
  "synopsisAgent":        "claude-acp",                       // optional
  "synopsisModel":        "claude-haiku-4-5-20251001",        // optional
  "synopsisOnClose":      false,
  "defaultTransformers":  []
}
```

### Sessions

#### `GET /v1/sessions`

List sessions known to the daemon.

**Query**

- `cwd=<path>` — filter to sessions opened against this working directory.
- `includeNonInteractive=1` — include piped `hydra cat` sessions that are normally hidden.

**Response — `200 OK`**

```jsonc
{
  "sessions": [
    {
      "sessionId":       "hydra_session_abc",
      "agentId":         "claude-acp",
      "cwd":             "/work",
      "title":           "fix flaky test",
      "status":          "live",     // "live" | "cold"
      "busy":            false,
      "attachedClients": 2,
      "updatedAt":       "2026-05-29T18:01:23.000Z"
      // …other SessionListEntry fields (currentModel, currentUsage,
      // importedFromMachine, forkedFromSessionId, …)
    },
    …
  ]
}
```

#### `POST /v1/sessions/search`

Substring search across session transcripts. POST (not GET) because the optional `sessionIds` allowlist can exceed header-size limits on long-lived installs.

**Request body**

```jsonc
{
  "q":          "regression",
  "sessionIds": [ "<id>", … ]   // optional scope filter
}
```

**Response — `200 OK`**

```jsonc
{
  "matches": [
    { "sessionId": "<id>", "messageId": "<id>", "snippet": "…regression…" },
    …
  ]
}
```

**Errors**

- `400` — `q` is missing or empty.

#### `POST /v1/sessions`

Create a new session. Equivalent to ACP `session/new` over REST. Omitted `cwd`/`agentId` fall back to daemon config.

**Request body**

```jsonc
{
  "cwd":        "/work",                     // optional
  "agentId":    "claude-acp",                // optional
  "mcpServers": [ /* MCP descriptors */ ]    // optional
}
```

**Response — `201 Created`**

```jsonc
{
  "sessionId": "hydra_session_abc",
  "agentId":   "claude-acp",
  "cwd":       "/work"
}
```

#### `POST /v1/sessions/:id/kill`

Demote a live session to cold. The on-disk record is preserved so the session can be resurrected later. Use `DELETE` to drop the record too. Idempotent.

**Response**

- `202` — live session is being closed.
- `204` — session was already cold; nothing to do.
- `404` — session unknown.

#### `PATCH /v1/sessions/:id`

Retitle a session or schedule an LLM-driven retitle. Two body shapes, mutually exclusive.

**Request body — direct retitle**

```jsonc
{ "title": "new title" }
```

Response: `204` on success, `400` on empty title, `404` on unknown session.

**Request body — regen**

```jsonc
{ "regen": true }
```

Picker `T` and `/hydra title` route here. Synopsis runs out-of-band; the new title surfaces via `session_info_update` on the next refresh. Works on live and cold sessions.

Response: `202` accepted, `404` on unknown session.

#### `DELETE /v1/sessions/:id`

Remove a session entirely (live or cold). Live sessions are closed and the record deleted; cold sessions just have the record dropped.

**Response**

- `204` — deleted.
- `404` — session unknown.

#### `GET /v1/sessions/:id/export`

Download a session bundle (`*.hydra` JSON: meta + history + optional prompt history). The bundle's `lineageId` is resolved/persisted on first export so subsequent re-exports stay consistent.

**Response — `200 OK`**

- `Content-Disposition: attachment; filename="<id>-<utc-stamp>.hydra"`
- Body is the JSON bundle.

#### `GET /v1/sessions/:id/transcript`

Render a session as a markdown transcript. Shares bundle assembly with `/export`, then pipes through `bundleToMarkdown` — byte-identical to what the CLI's `session transcript` produces.

**Response — `200 OK`**

- `Content-Type: text/markdown; charset=utf-8`

#### `POST /v1/sessions/:id/fork`

Branch a local session. `forkAt` defaults to the source's most-recent `turn_complete`; `cwd` and `agentId` default to the source's. The new session is minted with a fresh local id + `lineageId` and carries `forkedFromSessionId` for ancestry views.

**Request body**

```jsonc
{
  "forkAt":  "<messageId>",   // optional
  "cwd":     "/work-fork",    // optional
  "agentId": "claude-acp"     // optional
}
```

**Response — `201 Created`**

```jsonc
{
  "sessionId":            "hydra_session_def",
  "lineageId":            "<uuid>",
  "forkedFromSessionId":  "hydra_session_abc",
  "forkedFromMessageId":  "<messageId>"
}
```

**Errors**

- `400` — validation (empty `cwd`, empty `agentId`, agent not installed, …).
- `404` — source session unknown.

#### `POST /v1/sessions/import`

Import a session bundle. Without `replace`, a `lineageId` clash with an existing local session returns `409` citing the existing local id. With `replace: true`, the existing local session is overwritten in-place (its local id is preserved); any live in-memory copy is closed.

**Request body**

```jsonc
{
  "bundle":  { /* decoded session bundle */ },
  "replace": false,            // optional
  "cwd":     "/work-import"    // optional override
}
```

**Response — `201 Created`**

```jsonc
{
  "sessionId":               "hydra_session_xyz",
  "importedFromSessionId":   "<bundle's original id>",
  "replaced":                false
}
```

**Errors**

- `400` — `bundle` missing, decode failed (`{ "error": "invalid bundle", "details": "…" }`), or empty `cwd`.
- `409` — lineage clash. Body: `{ "error": "bundle already imported", "existingSessionId": "<id>" }`.

#### `GET /v1/sessions/:id/history`

Tail a session's recorded conversation as NDJSON. One-shot by default; `?follow=1` keeps the connection open and streams new entries as they're broadcast — useful for archivers / web exports that want the canonical conversation stream without participating as ACP clients.

**Query**

- `follow=1` (or `follow=true`) — keep the connection open after the snapshot.

**Response — `200 OK`**

- `Content-Type: application/x-ndjson`
- Body: one JSON object per line (history entries). When `follow=1`, the stream continues until the client disconnects or the session closes.

**Errors**

- `404` — session unknown.

### Agents

#### `GET /v1/agents`

List known agents (registry + per-agent install state).

**Response — `200 OK`**

```jsonc
{
  "version":   "1.0.0",
  "fetchedAt": 1717012800000,
  "agents": [
    {
      "id":            "claude-acp",
      "name":          "Claude Agent",
      "version":       "0.38.0",
      "description":   "ACP wrapper for Anthropic's Claude",
      "distributions": [ "npx" ],
      "installed":     "yes"   // "yes" | "no" | "lazy"
    },
    …
  ]
}
```

#### `POST /v1/agents/:id/install`

Pre-install an agent so the first `session/new` doesn't pay the download cost.

**Response — `200 OK`** (installed):

```jsonc
{
  "agentId":      "claude-acp",
  "version":      "0.38.0",
  "distribution": "npx",
  "installed":    true,
  "command":      "<path to bin>"
}
```

**Response — `200 OK`** (uvx-only agents resolve lazily):

```jsonc
{
  "agentId":      "<id>",
  "version":      "<version>",
  "distribution": "uvx",
  "installed":    false,
  "message":      "uvx agents resolve on first run; nothing to pre-install."
}
```

**Errors**

- `404` — agent not in the registry.
- `500` — install failed (network, decompression, …).

#### `POST /v1/agents/:id/sync`

Spawn the agent transiently, call ACP `session/list` against it, and persist any sessions it remembers as cold records. Used by `hydra agent sync` to surface sessions created outside Hydra.

**Response — `200 OK`**

```jsonc
{
  "synced": [
    {
      "sessionId":         "<hydra id>",
      "upstreamSessionId": "<agent's id>",
      "agentId":           "<id>",
      "cwd":               "<path>",
      "title":             "<title>",
      "updatedAt":         "<ISO-8601>"
    },
    …
  ],
  "skipped": 0
}
```

**Errors**

- `404` — agent not installed.
- `409` — agent failed to spawn / answer `session/list`.

### Registry

#### `GET /v1/registry`

Return the cached ACP registry document verbatim.

**Response — `200 OK`** — the raw registry JSON (`{ version, agents, extensions? }`).

#### `POST /v1/registry/refresh`

Force a network re-fetch.

**Response — `200 OK`**

```jsonc
{ "version": "1.0.0", "agentCount": 35 }
```

### Extensions

Extensions are user-configured processes managed by the daemon — see the README's Extensions section for the lifecycle model. These endpoints manage the registration without bouncing the daemon.

#### `GET /v1/extensions`

List configured extensions and their live state.

**Response — `200 OK`**

```jsonc
{
  "extensions": [
    {
      "name":     "hydra-acp-slack",
      "command":  [ "hydra-acp-slack" ],
      "args":     [],
      "env":      {},
      "enabled":  true,
      "pid":      12345,
      "status":   "running",   // "running" | "starting" | "stopped" | "crashed"
      "version":  "0.4.0"      // reported via initialize
    },
    …
  ]
}
```

#### `GET /v1/extensions/:name`

One extension's info. Same shape as a single entry in the list above.

**Errors**

- `404` — unknown extension.

#### `POST /v1/extensions`

Register a new extension. Takes effect immediately (no daemon restart).

**Request body**

```jsonc
{
  "name":    "my-extension",            // required; matches [A-Za-z0-9._-]+
  "command": [ "node", "/path/x.mjs" ], // optional; defaults to [name]
  "args":    [],                        // optional
  "env":     { "FOO": "bar" },          // optional
  "enabled": true                       // optional; default true
}
```

**Response — `201 Created`** — same shape as `GET /v1/extensions/:name`.

**Errors**

- `400` — name malformed; or `command`/`args` not arrays of strings; or `env` not a string-to-string map.
- `409` — name already registered.

#### `DELETE /v1/extensions/:name`

Unregister and stop an extension.

**Response**

- `204` — unregistered.
- `404` — unknown extension.

#### `POST /v1/extensions/:name/{start,stop,restart}`

Lifecycle control. `start` brings up a stopped extension; `stop` suppresses auto-restart until the next `start`/`restart`/daemon bounce; `restart` is stop + start.

**Response — `200 OK`** — the updated extension info (same shape as `GET`).

**Errors**

- `404` — unknown extension.
- `409` — already in the target state.

### Transformers

Transformers are pipeline middleware — see the README's Transformers section. The REST surface mirrors Extensions one-for-one; the only difference is trust posture (transformers have structurally more access than extensions).

#### `GET /v1/transformers`

#### `GET /v1/transformers/:name`

#### `POST /v1/transformers`

#### `DELETE /v1/transformers/:name`

#### `POST /v1/transformers/:name/{start,stop,restart}`

Same shapes, parameters, response codes, and errors as the Extensions endpoints — substitute "transformer" for "extension" throughout.

---

## MCP endpoints

Two HTTP routes are reachable from spawned agents (not from generic REST clients):

#### `POST/GET/DELETE /mcp/hydra-acp-stdin`

In-memory `hydra cat --stream` ring buffer, exposed as MCP tools (`head`, `tail`, `read`, `grep`, `wait_for_more`, `info`). Bearer is a per-session capability token minted at `session/new` time and embedded in the agent's `mcpServers`. The route uses the Streamable HTTP MCP transport and bypasses the daemon's global Bearer hook.

#### `POST/GET/DELETE /mcp/:name`

Extension-contributed MCP server, registered via the [`hydra-acp/register_mcp_tools`](#request-process--daemon-hydra-acpregister_mcp_tools) JSON-RPC method. Same Streamable HTTP transport and per-session bearer model as `/mcp/hydra-acp-stdin`.

Neither route is intended for human callers. They exist so spawned agents can talk MCP back into the daemon: the daemon injects the appropriate `mcpServers` descriptor into the agent's `session/new` params, and the agent calls these routes as it would any other MCP server.

---

## ACP wire protocol

The `/acp` WebSocket carries JSON-RPC 2.0 frames in both directions. After the WebSocket upgrade, the first JSON-RPC message the client sends is `initialize` per ACP. From there, the connection speaks:

- standard ACP (`initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/list`, …),
- two RFD-track additions Hydra implements (`session/attach`, `session/detach` per [RFD #533](https://github.com/agentclientprotocol/agent-client-protocol/pull/533)),
- the Hydra-specific extensions documented below.

Hydra additions use one of two prefixes:

- `hydra-acp/*` — the daemon's own extensions. Always namespaced; never collides with future ACP additions.
- `transformer/*` — transformer-specific surface. Only callable on a connection that authenticated as a transformer; extensions and ordinary clients receive `MethodNotFound`.

### The `hydra-acp` meta namespace

Standard ACP requests and responses carry an optional `_meta: Record<string, unknown>`. Hydra-specific fields ride under the `hydra-acp` key inside that object per the ACP [Extensibility convention](https://agentclientprotocol.com/protocol/extensibility). Generic ACP clients ignore the field, so the additions are strictly additive.

#### On `session/new` params (`_meta.hydra-acp`)

| Field | Type | Semantics |
|---|---|---|
| `agentId` | `string` | Override `params.agentId`. Used by `hydra-acp launch <agent>` so the editor doesn't need to know how to pick agents. |
| `cwd` | `string` | Override `params.cwd`. |
| `title` | `string` | Session label (`Session.title`). Surfaces in `session/list`, the picker, slack-bridge thread titles. First write wins; replaced by the first user prompt unless the agent has emitted its own `session_info_update`. |
| `agentArgs` | `string[]` | Forwarded to the underlying agent's command line. Stored in the resume hints so a resurrected session re-spawns the agent with the same args. |
| `transformers` | `string[]` | Names of transformers to attach to the session chain. Resolves to live connections at session-creation time; missing names are silently skipped (fail-open). Falls back to `config.defaultTransformers`. |
| `model` | `string` | One-shot model id applied via `session/set_model` at agent bootstrap. Ignored on resurrect. |
| `mcpStdin` | `boolean` | Allocate a `SessionStreamBuffer` and inject a `hydra-acp-stdin` HTTP MCP descriptor into the agent's `mcpServers`. Used by `hydra cat --stream`. |
| `interactive` | `boolean` | Initial value for the session's interactivity tristate. `cat` sets `false`; everything else leaves it undefined so the first user prompt promotes it to `true`. |
| `resume` | `SessionResumeHints` | `{ upstreamSessionId, agentId, cwd, title?, agentArgs? }` — populated by the shim's reconnect path so the daemon can resurrect the session against the right agent. |

#### On `session/new` and `session/attach` responses (`_meta.hydra-acp`)

The `session/new`, `session/attach` (live and read-only viewer), `session/load`, and `session/list` responses all build their `_meta["hydra-acp"]` object from a single function (`buildHydraSessionMeta`), so they share one consistent shape. An attaching client therefore sees the **same session info `session/list` exposes** — status, busy, attach count, provenance — plus the live-only extras below that only a resident session has. Add a field to that builder and every surface gets it.

The shared core (identical to the [`session/list` entry meta](#on-sessionlist-entries-_metahydra-acp)):

| Field | Type | Semantics |
|---|---|---|
| `status` | `"live" \| "cold"` | Always present. `cold` on the read-only viewer attach path. |
| `busy` | `boolean` | Always present. True while a turn is in flight. |
| `awaitingInput` | `boolean` | Always present. True when blocked on the user (permission/question). |
| `attachedClients` | `number` | Always present. Count of currently-attached clients. |
| `upstreamSessionId` | `string` | The agent's own session id (distinct from the daemon's id). |
| `agentId` | `string` | Resolved agent id (after registry id lookup / npx-basename fallback). |
| `cwd` | `string` | Effective working directory. |
| `title` | `string?` | Session label (`Session.title`). Matches the top-level `title` on `session/list`. |
| `currentModel` | `string?` | Last-known model id; lets attach paint header state before any new updates land. |
| `currentUsage` | `{used?, size?, costAmount?, costCurrency?}` | Last-known token/cost snapshot. |
| `importedFromMachine` | `string?` | Origin hostname; present iff imported. |
| `importedFromUpstreamSessionId` | `string?` | Origin upstream id; present iff imported. |
| `parentSessionId` | `string?` | Set iff spawned as a transformer child. |
| `forkedFromSessionId` | `string?` | Local-fork breadcrumb. |
| `forkedFromMessageId` | `string?` | Local-fork breadcrumb. |
| `originatingClient` | `{name, version?}?` | `clientInfo` of the process that issued `session/new`. |
| `interactive` | `boolean?` | Tristate filter signal; absent when undecided. |

Live-only extras (present on `session/new` and `session/attach`; the read-only viewer path supplies the disk-persisted subset, omitting `turnStartedAt`/`queue`/`agentCapabilities`):

| Field | Type | Semantics |
|---|---|---|
| `currentMode` | `string?` | Last-known agent mode. |
| `agentArgs` | `string[]?` | Agent command-line args, when set. |
| `availableCommands` | `{name, description?}[]?` | Command palette known to the daemon (agent + hydra slash commands + extension verbs). |
| `availableModes` | `{id, name?, description?}[]?` | Modes the underlying agent advertises. |
| `availableModels` | `{modelId, name?, description?}[]?` | Models the agent will accept on `session/set_model`. |
| `turnStartedAt` | `number?` (epoch ms) | Present only when an agent turn is in flight at response time. Lets a fresh client paint the busy indicator with the right elapsed time. |
| `agentCapabilities` | `object?` | The underlying agent's own initialize-time capability claim, forwarded verbatim. |
| `queue` | `PromptQueueEntry[]?` | Snapshot of the daemon-side queue at attach time, so late-joining clients can paint chips without waiting for new `prompt_queue_added` notifications. Omitted when empty. |
| `mcpStdin` | `boolean?` | Echoed when stdin streaming was wired up. |

> Capability flags (`promptQueueing`, `promptCancelling`, `promptUpdating`, `promptAmending`, `promptPipelining`) are daemon-wide and ride on the **`initialize`** response's `_meta["hydra-acp"]`, not per-session.

#### On `session/list` entries (`_meta.hydra-acp`)

Per the [Session List Protocol](https://agentclientprotocol.com/protocol/session-list), Hydra returns the spec-required fields at the top level (`sessionId`, `cwd`, `title?`, `updatedAt?`) and packs everything else into `_meta["hydra-acp"]`:

```jsonc
{
  "sessionId": "hydra_session_abc",
  "cwd": "/work",
  "title": "fix flaky test",
  "updatedAt": "2026-05-29T18:01:23.000Z",
  "_meta": {
    "hydra-acp": {
      "attachedClients": 2,
      "status": "live",         // "live" | "cold"
      "busy": false,            // mid-turn flag (live sessions only)
      "awaitingInput": false,   // blocked on user (permission/question); live only
      "agentId": "claude-acp",
      "upstreamSessionId": "<agent id>",
      "currentModel": "claude-opus-4-7",
      "currentUsage": { "used": 12345, "costAmount": 0.18, "costCurrency": "USD" },
      "importedFromMachine": "<hostname>",          // present iff imported
      "importedFromUpstreamSessionId": "<id>",      // present iff imported
      "parentSessionId": "<id>",                    // present iff spawned as a transformer child
      "forkedFromSessionId": "<id>",                // present iff locally forked
      "forkedFromMessageId": "<id>",                // present iff locally forked
      "originatingClient": { "name": "<client>", "version": "<ver?>" },
      "interactive": true       // tristate filter signal; absent when undecided
    }
  }
}
```

Field reference for `_meta["hydra-acp"]` (always-present fields first, then optional):

| Field | Type | Notes |
| --- | --- | --- |
| `attachedClients` | `number` | Count of clients currently attached. |
| `status` | `"live" \| "cold"` | Whether the session is in memory or persisted-only. |
| `busy` | `boolean` | Mid-turn flag (a prompt is in flight). Always `false` for cold sessions. |
| `awaitingInput` | `boolean` | Blocked on the user (outstanding `session/request_permission` or agent question). Always `false` for cold sessions. |
| `agentId` | `string?` | Agent that owns the session. |
| `upstreamSessionId` | `string?` | The agent-side session id. |
| `currentModel` | `string?` | Last-known model id. |
| `currentUsage` | `object?` | Last-known usage snapshot: `{ used?, size?, costAmount?, costCurrency? }`. |
| `importedFromMachine` | `string?` | Origin hostname; present iff imported. |
| `importedFromUpstreamSessionId` | `string?` | Origin upstream id; present iff imported. |
| `parentSessionId` | `string?` | Set iff spawned as a child by a transformer. |
| `forkedFromSessionId` | `string?` | Local-fork breadcrumb; present iff locally forked. |
| `forkedFromMessageId` | `string?` | Local-fork breadcrumb; present iff locally forked. |
| `originatingClient` | `object?` | `clientInfo` of the process that issued `session/new`: `{ name, version? }`. |
| `interactive` | `boolean?` | Tristate filter signal; absent when undecided. |

#### `SessionAttachParams.readonly` (Hydra-only flag)

Hydra accepts an optional `readonly: boolean` on `session/attach`. When `true`, the connection observes the session but can't mutate it: any state-changing JSON-RPC method (`session/prompt`, `session/cancel`, `session/set_model`, `hydra-acp/cancel_prompt`, `update_prompt`, `amend_prompt`) returns `-32011 PermissionDenied`. Attaching read-only to a cold session takes a viewer path that streams history straight from disk — no `resurrect`, no agent process.

### Prompt-queue surface

The daemon owns a per-session prompt queue. Clients submit prompts via standard `session/prompt`; everything mutating the queue afterwards goes through the Hydra methods below. Peer clients stay in sync via the `hydra-acp/prompt_queue_*` notifications.

#### Request: `hydra-acp/cancel_prompt`

Cancel a queued (not-yet-running) prompt. To cancel the currently-running head, use standard `session/cancel` instead.

```jsonc
// params
{ "sessionId": "<id>", "messageId": "<id>" }
// result
{ "cancelled": true, "reason": "ok" }
// or
{ "cancelled": false, "reason": "not_found" | "already_running" }
```

`already_running` means the messageId matched the in-flight head; the caller should fall back to `session/cancel`.

#### Request: `hydra-acp/update_prompt`

Edit the content of a queued prompt before it runs.

```jsonc
// params
{ "sessionId": "<id>", "messageId": "<id>", "prompt": [ /* ACP prompt array */ ] }
// result
{ "updated": true, "reason": "ok" }
// or
{ "updated": false, "reason": "not_found" | "already_running" }
```

Successful updates broadcast a `hydra-acp/prompt_queue_updated` notification so peer clients can refresh their chip text.

#### Request: `hydra-acp/amend_prompt`

Interrupt the in-flight head with a replacement prompt. The partial agent response is preserved in conversation history (cancel-and-resubmit). For a *queued* target, this behaves the same as `update_prompt` (in-place edit).

```jsonc
// params
{
  "sessionId":         "<id>",
  "targetMessageId":   "<id of the prompt to amend>",
  "prompt":            [ /* replacement ACP prompt array */ ],
  "replaceQueue":      false,                       // optional; true drops every queued entry after the target
  "onTargetCompleted": "reject" | "send_anyway"     // optional; behavior if the target finishes before the amend lands
}
// result
{
  "amended":   true,
  "reason":    "ok" | "target_completed" | "target_cancelled" | "target_not_found",
  "messageId": "<id>"   // present when a prompt was sent or replaced
}
```

The race between target completion and amend arrival is resolved deterministically via `targetMessageId`. When `onTargetCompleted: "send_anyway"` and the target completes first, the daemon forwards the amend as a regular follow-up prompt and returns the new id in `messageId`.

Successful amends broadcast a `hydra-acp/prompt_amended` notification — see below.

#### Notification: `hydra-acp/prompt_queue_added`

Daemon → every attached client. Fires when a new prompt is enqueued (including new turns from any client).

```jsonc
{
  "sessionId":  "<id>",
  "messageId":  "<id>",
  "originator": { "clientId": "<id>", "name": "<client name>", "version?": "<v>" },
  "prompt":     [ /* ACP prompt array */ ],
  "position":   0,    // 0 = head/in-flight; N = number of entries already ahead
  "queueDepth": 1,
  "enqueuedAt": 1717012800000
}
```

#### Notification: `hydra-acp/prompt_queue_updated`

Fires when a queued prompt's content was changed via `update_prompt` (or by an `amend_prompt` against a queued target).

```jsonc
{ "sessionId": "<id>", "messageId": "<id>", "prompt": [ /* new ACP prompt array */ ] }
```

#### Notification: `hydra-acp/prompt_queue_removed`

Fires when a queue entry leaves the queue.

```jsonc
{
  "sessionId": "<id>",
  "messageId": "<id>",
  "reason":    "started" | "cancelled" | "abandoned"
}
```

- `started` — head transitioned to in-flight (the active turn begins).
- `cancelled` — explicit `hydra-acp/cancel_prompt`.
- `abandoned` — session tear-down with queued entries that never ran.

#### Notification: `hydra-acp/prompt_amended`

Dedicated linkage event fired after a successful amend. Carries both messageIds so subscribers can render the M1 → M2 relationship without correlating `turn_complete` + `prompt_received` themselves.

```jsonc
{
  "sessionId":           "<id>",
  "cancelledMessageId":  "<id>",   // the amended-out prompt
  "newMessageId":        "<id>",   // the replacement
  "prompt":              [ /* amendment content */ ],
  "originator":          { "clientId": "<id>", "name?": "<n>", "version?": "<v>" },
  "amendedAt":           1717012800000
}
```

#### Notification: `hydra-acp/session_closed`

Fires once when a session is closed (cold demotion, delete, daemon shutdown, import-replace). Lets attached clients paint a "session is gone" banner without waiting for the WS itself to drop.

```jsonc
{ "sessionId": "<id>" }
```

### Stdin streaming

Three RPCs implement an in-memory ring buffer per session, used by `hydra cat --stream` to feed piped stdin to the agent without round-tripping through a tempfile. The companion MCP server at `POST /mcp/hydra-acp-stdin` exposes the same buffer to the agent as MCP tools (`head`, `tail`, `read`, `grep`, `wait_for_more`, `info`).

All cursors are **absolute monotonic byte offsets**, never ring indices. Eviction is observable: a read whose `cursor` points before the oldest still-resident byte returns `gap: <count>` and advances `cursor` to the oldest resident position.

#### Request: `hydra-acp/stream_open`

Allocate the buffer.

```jsonc
// params
{
  "sessionId":     "<id>",
  "mode":          "memory" | "file",   // optional; default "memory"
  "capacityBytes": 1048576,              // optional; daemon defaults
  "fileCapBytes":  10485760              // optional; file mode only — soft cap on the mirror
}
// result
{
  "filePath":      "<path>",   // present iff mode === "file"
  "capacityBytes": 1048576,
  "fileCapBytes":  10485760    // optional; echoes the soft cap when one was applied
}
```

`mode: "memory"` keeps the ring in RAM only — required for the MCP tool surface. `mode: "file"` also writes to a tempfile so an agent without HTTP MCP can consume it via `tail -f` / `head` / `grep`.

#### Request: `hydra-acp/stream_write`

Append bytes to the ring (and the mirror file, if any).

```jsonc
// params
{
  "sessionId": "<id>",
  "chunk":     "<base64-encoded bytes>",
  "eof":       false   // optional; true on the final write — long-poll readers return eof:true once observed
}
// result
{ "writeCursor": 4096 }   // absolute byte offset after the append
```

#### Request: `hydra-acp/stream_read`

Read from the ring at an absolute cursor.

```jsonc
// params
{
  "sessionId": "<id>",
  "cursor":    0,        // absolute byte offset to read from
  "maxBytes":  65536,    // optional; daemon caps at 64 KiB
  "waitMs":    30000     // optional; long-poll if nothing's available (server cap 60_000)
}
// result
{
  "bytes":      "<base64-encoded bytes>",   // "" when nothing new and waitMs expired
  "nextCursor": 4096,
  "gap":        128,     // optional; bytes evicted between the caller's cursor and what we still have
  "eof":        true     // optional; producer closed AND no more bytes after nextCursor
}
```

### Local fork

#### Request: `hydra-acp/fork_session`

Branch a local session into a new one that shares context up to a chosen turn boundary. Same machinery as `POST /v1/sessions/:id/fork`, exposed over the WS so transformers and TUIs can call it without leaving the protocol.

```jsonc
// params
{
  "sessionId": "<source>",
  "forkAt":    "<messageId>",   // optional; defaults to source's latest turn_complete
  "cwd":       "<path>",        // optional; defaults to source's cwd
  "agentId":   "<id>"           // optional; defaults to source's agent
}
// result
{
  "sessionId":            "<new id>",
  "lineageId":            "<new>",
  "forkedFromSessionId":  "<source>",
  "forkedFromMessageId":  "<messageId>"
}
```

The new session is minted with `upstreamSessionId=""` so its first attach triggers the same takeover-replay path used for imported bundles. Fork breadcrumbs (`forkedFromSessionId`, `forkedFromMessageId`) ride in `session/list` `_meta` for ancestry views.

### Agent install progress

When `session/new` or `session/attach` requires downloading or installing an agent (npx pre-install or binary fetch), the daemon emits progress on the originating WS connection so clients can paint a download bar.

#### Notification: `hydra-acp/agent_install_progress`

```jsonc
{
  "agentId":        "<id>",
  "version":        "<version>",
  "source":         "binary" | "npm",
  "phase":          "download_start"
                  | "download_progress"
                  | "download_done"
                  | "extract"           // binary only
                  | "install_start"     // npm only
                  | "installed",
  "receivedBytes":  1048576,   // optional; populated on download_* phases
  "totalBytes":     5242880,   // optional
  "packageSpec":    "<spec>"   // optional; populated on npm phases
}
```

The notification is *not* keyed by `sessionId` — the session may not exist yet at notification time (it's still being created). The originating WebSocket connection is the implicit scope.

### Extension and transformer plumbing

Hydra extensions and transformers connect to the daemon as ordinary ACP clients (over `/acp`) and authenticate with their `HYDRA_ACP_TOKEN` env var. After `initialize`, they identify themselves by name through the bearer token's process-identity binding; the daemon then registers the WS connection as the extension/transformer endpoint.

Once registered, three surfaces become available to that process:

- **Slash-command verbs.** Register with `hydra-acp/register_commands`. Whenever a user types `/hydra <name> <verb> …` in any session, the daemon forwards a `hydra-acp/extension_command` request to the registered connection.
- **MCP tools.** Register with `hydra-acp/register_mcp_tools`. Agents see a `/mcp/<extension-name>` HTTP MCP server; when they call a tool, the daemon forwards a `hydra-acp/invoke_mcp_tool` request to the registered connection.
- **Transformer pipeline** (transformer-only). After `transformer/initialize`, the daemon calls `transformer/message` for each intercepted method and `transformer/session_event` for lifecycle ticks.

Registrations drop on disconnect — the daemon clears the entry and evicts any cached MCP transports.

#### Request (process → daemon): `hydra-acp/register_commands`

Advertise slash-command verbs.

```jsonc
// params
{
  "commands": [
    {
      "verb":         "<name>",        // required
      "argsHint":     "<example>",     // optional; rendered in /hydra help
      "description":  "<short text>"   // optional
    },
    …
  ]
}
// result
{ "ok": true, "registered": 3 }
```

#### Request (daemon → process): `hydra-acp/extension_command`

Daemon dispatches a `/hydra <process-name> <verb> …` invocation. The process's response text (if any) is broadcast as a synthetic `agent_message_chunk` so it appears inline in the conversation.

```jsonc
// params
{
  "sessionId": "<id>",
  "verb":      "<name>",
  "args":      [ "<arg1>", … ]
}
// result — at most one of these:
{ "text": "<reply rendered into the conversation>" }
// or
{}   // silent acknowledgement
```

#### Request (process → daemon): `hydra-acp/register_mcp_tools`

Advertise MCP tools the process implements.

```jsonc
// params
{
  "instructions": "<optional server-level instructions>",
  "tools": [
    {
      "name":         "<tool name>",        // required
      "description":  "<short>",            // required
      "inputSchema":  { /* JSON schema */ },// required
      "outputSchema": { /* JSON schema */ } // optional
    },
    …
  ]
}
// result
{ "ok": true, "registered": 2 }
```

The daemon mints a per-session bearer at every `session/new` and injects `mcpServers` descriptors pointing at `/mcp/<process-name>` with that bearer. Re-calling overwrites the prior spec; the route's `onChange` listener evicts cached transports so agents reconnect against the fresh spec.

#### Request (daemon → process): `hydra-acp/invoke_mcp_tool`

The MCP `tools/call` from the agent, forwarded to the registered process.

```jsonc
// params
{
  "server": "<process-name>",
  "tool":   "<tool name>",
  "args":   { /* tool args */ }
}
// result — MCP CallToolResult shape:
{
  "content":           [ { "type": "text", "text": "…" }, … ],
  "structuredContent": { /* optional */ },
  "isError":           false
}
```

### Transformer-only methods

Transformers receive a higher-trust per-process token: they sit in the daemon's message pipeline and can observe (and ultimately rewrite) traffic that no client ever sees. The `transformer/*` methods and the transformer-specific `hydra-acp/*` outboxes are only callable on a transformer-kind connection; extension and client connections get `MethodNotFound` if they try.

#### Request (transformer → daemon): `transformer/initialize`

Declare which message kinds this transformer wants to intercept.

```jsonc
// params
{
  "intercepts": [
    "request:session/prompt",
    "response:session/update",
    "lifecycle:session.opened",
    …
  ],
  "transformerConfig": { /* opaque; reserved for future use */ }
}
// result
{ "ack": true }
```

Intercepts are matched against `request:<method>`, `response:<method>`, and `lifecycle:<event>` strings. Lifecycle events currently fired are `session.opened`, `session.idle`, and `session.closed`.

#### Request (daemon → transformer): `transformer/message`

Called for every intercepted JSON-RPC request or response.

```jsonc
// params
{
  "token":     "<chain token>",
  "phase":     "request" | "response",
  "method":    "<method>",
  "direction": "client→agent" | "agent→client",
  "sessionId": "<id>",
  "envelope":  { /* method params */ }
}
// expected result
{
  "action":  "continue" | "stop" | "processing",
  "payload": { /* new envelope */ }   // optional; used when action is "stop" or as a rewrite
}
```

- `continue` (default) — daemon proceeds with the envelope (rewritten if `payload` is present).
- `stop` — daemon never sees this message. The optional `payload` is returned to the original caller (synthetic response).
- `processing` — the transformer is taking ownership; the daemon parks the call until the transformer discharges the claim via `hydra-acp/emit_message` with `respondsTo: <token>`. If the transformer doesn't discharge within the claim timeout, the daemon broadcasts a `hydra-acp/transformer_abandoned_request` notification and resumes the chain from the next transformer (fail-open).

#### Notification (daemon → transformer): `transformer/session_event`

Fires for lifecycle events the transformer declared an interest in.

```jsonc
{ "event": "session.opened" | "session.idle" | "session.closed", "sessionId": "<id>" }
```

#### Request (transformer → daemon): `hydra-acp/emit_message`

Transformer outbox: emit an ACP message back into the system, or discharge a pending `processing` claim.

```jsonc
// params
{
  "sessionId":   "<id>",
  "method":      "<method>",
  "envelope":    { /* method params */ },
  "route":       "chain" | "daemon",  // ignored when respondsTo is present
  "respondsTo":  "<chain token>"      // optional; discharges a processing claim
}
// result
{ "ok": true }
```

Setting `respondsTo` returns the envelope to the original caller and removes the parked claim. Otherwise, `route: "chain"` re-enters the transformer chain from the next position (loop-safe via the `originatedBy` lineage set).

#### Request (transformer → daemon): `hydra-acp/spawn_child_session`

Create a child session whose `parentSessionId` is set.

```jsonc
// params
{
  "agentId":         "<id>",     // optional; defaults to daemon's defaultAgent
  "cwd":             "<path>",   // required
  "parentSessionId": "<id>"      // optional
}
// result
{ "childSessionId": "<new id>" }
```

Children start with an empty transformer chain by default.

#### Request (transformer → daemon): `hydra-acp/await_child`

Block until the child session reaches a stop condition or the timeout elapses.

```jsonc
// params
{
  "childSessionId": "<id>",
  "until":          "turn_complete" | "idle",   // default "turn_complete"
  "timeoutMs":      300000                      // optional; daemon caps at 30 minutes
}
// result
{ "entries": [ /* recorded session/update entries collected during the wait */ ] }
```

#### Request (transformer → daemon): `hydra-acp/close_child_session`

```jsonc
// params
{ "childSessionId": "<id>" }
// result
{ "ok": true }
```

Closes the child session (cold demotion; record preserved).

#### Request (transformer → daemon): `hydra-acp/keep_alive`

Reset the abandonment timer for an outstanding `processing` claim.

```jsonc
// params
{
  "token":                "<chain token>",
  "sessionId":            "<id>",
  "estimatedRemainingMs": 5000     // optional; advisory
}
// result
{ "ok": true }
```

#### Notification: `hydra-acp/transformer_abandoned_request`

Daemon → every attached client. Fires when a transformer's `processing` claim times out before being discharged.

```jsonc
{
  "sessionId":       "<id>",
  "token":           "<chain token>",
  "transformerName": "<name>"
}
```

After the broadcast, the daemon resumes the chain from the next transformer (fail-open).

### Capability discovery

The `initialize` response carries Hydra's extension capability flags in two places:

- **Standard `agentCapabilities.sessionCapabilities`** advertises the RFD #533 (`attach: {}`) and Session List (`list: {}`) extensions.
- **`_meta["hydra-acp"]`** on the same response carries the prompt-mutation booleans (`promptQueueing`, `promptCancelling`, `promptUpdating`, `promptAmending`, `promptPipelining`).

Clients can gate UI on those flags rather than relying on `MethodNotFound` round-trips. Older daemons that don't advertise a flag should be assumed to lack the corresponding capability.

---

## JSON-RPC error codes

Codes Hydra uses on top of the standard `-32000…-32700` range. These apply on the `/acp` WebSocket; REST endpoints map them to HTTP status codes where useful (`-32001` → 404, `-32010` → 409, etc.).

| Code | Name | Meaning |
|---:|---|---|
| `-32001` | `SessionNotFound` | RFD #533 reserved. The daemon emits this when a `sessionId` is unknown. |
| `-32002` | `NotAuthorisedToAttach` | RFD #533 reserved. Not emitted by Hydra today (auth is enforced at WS upgrade). |
| `-32003` | `MultiClientNotSupported` | RFD #533 reserved. Not emitted by Hydra today (multi-client is always supported). |
| `-32005` | `AgentNotInstalled` | Resolution succeeded against the registry but the agent isn't installed and can't be lazily fetched. |
| `-32010` | `BundleAlreadyImported` | `session/import` saw a `lineageId` clash; `data.existingSessionId` carries the local id of the clash. |
| `-32011` | `PermissionDenied` | Mutating method on a read-only session, or extension-only/transformer-only method called by a peer kind. |
| `-32012` | `AlreadyAttached` | A connection attempted to attach to a session it's already attached to. |
| `-32013` | `StreamNotEnabled` | `hydra-acp/stream_*` called on a session that wasn't opened with stdin streaming. |
| `-32014` | `SessionClosing` | Attach succeeds (read-only view) but mutating operations are refused because the session is mid-close (regen running, agent about to be killed). |

`-32001` through `-32003` are part of RFD #533's reserved range; Hydra-internal codes (`-32010` and up) live outside that range so they can't collide with future spec assignments.
