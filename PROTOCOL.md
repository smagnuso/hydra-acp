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
  - [Attention](#attention)
  - [Session events](#session-events)
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

#### `GET /v1/sessions/:id`

Single-session info — same shape as one entry from `GET /v1/sessions`, looked up by id. Lets callers that already know a `sessionId` read its `agentId`, `currentModel`, `currentUsage`, `status`, `busy`, `awaitingInput`, etc. without scanning the full list. Works on both live and cold sessions.

**Response — `200 OK`** — the matching `SessionListEntry` (see [`GET /v1/sessions`](#get-v1sessions) for the shape).

**Errors**

- `404` — no session with that id.

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

#### `POST /v1/sessions/:id/stdin/open` + `POST /v1/sessions/:id/stdin`

Producer side of `hydra cat --stream`: feed piped stdin into a live session's in-memory ring, which the agent reads through the `hydra-acp-stdin` MCP server (`POST /mcp/hydra-acp-stdin`). Cursors are **absolute monotonic byte offsets**; eviction surfaces as a `gap` on the read side.

**`POST /v1/sessions/:id/stdin/open`** — allocate the ring.

```jsonc
// body
{
  "mode":          "memory" | "file",   // optional; default "memory"
  "capacityBytes": 1048576,              // optional; daemon default otherwise
  "fileCapBytes":  10485760              // optional; file mode only — soft cap on the mirror
}
// 200 response
{
  "filePath":      "<path>",   // present iff mode === "file"
  "capacityBytes": 1048576,
  "fileCapBytes":  10485760    // optional; echoes the soft cap when applied
}
```

**`POST /v1/sessions/:id/stdin`** — append a chunk.

```jsonc
// body
{
  "chunk": "<base64-encoded bytes>",
  "eof":   false   // optional; true on the final write — long-poll readers see eof:true once observed
}
// 200 response
{ "writeCursor": 4096 }   // absolute byte offset after the append
```

**Response codes** (both): `200` ok; `404` session not live; `409` ring not open / already open.

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

#### Transformer call: `hydra-acp/session/request_permission`

Broadcast a `session/request_permission` to a session's attached user-facing clients and resolve with the winning client's pick. Same broadcast-and-await logic the agent's own `session/request_permission` goes through — the difference is that any transformer/client can initiate it, not just the session's agent. Used by transformers (notably the planner) that need to surface a permission prompt on a session *other than* the one whose agent originated the request — e.g. a worker session's agent asks for permission, but the worker has no human-facing client; the planner forwards to the orchestrator session where the user is attached, then routes the answer back to the worker.

**Params** — same shape as the agent's own `session/request_permission`. `params.sessionId` targets the session whose attached clients should vote; the rest of the payload (`toolCall`, `options`, …) is the standard ACP permission payload.

**Result** — the winning client's selection, typically `{ outcome: { outcome: "selected", optionId: "..." } }` or `{ outcome: { outcome: "cancelled" } }`.

**Errors**

- `-32602` when `sessionId` is missing.
- `SessionNotFound` (-32004) when the target session is unknown.
- `PermissionDenied` (-32008) when the session has no attached clients to vote.

#### `GET /v1/sessions/:id/diff`

Reconstructed per-file diff for a session — the same aggregation `hydra session diff --json` runs client-side, but server-side so other consumers (e.g. the planner's verified-diff audit) can fetch a ready-made shape with a single HTTP call instead of pulling the full export and redoing the walk. The diff is drawn from the session's recorded `tool_call` / `tool_call_update` edit payloads (canonical `content[].type:"diff"`, Claude `Edit`/`Write`/`MultiEdit` raw inputs); no git, no filesystem read of the workspace. Deletes aren't representable today and won't appear.

**Query parameters**

| Param | Effect |
|-------|--------|
| `fold=true` | Collapse sequential hunks that rewrite the same region into one net-effect hunk (same as the CLI's `--fold` flag). |
| `paths=a,b,c` | Filter results to only the listed paths. Comma-separated, no URL encoding inside the list. |

**Response — `200 OK`**

- `Content-Type: application/json`
- Body is an array of `{ path, hunks: [{ oldText, newText }], created }` — identical to what `hydra session diff --json` emits.

**Response — `404 Not Found`** when the session id is unknown.

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

### Attention

The daemon maintains a per-session set of **attention flags** — entries that mean "the user owes this session a response." A flag carries an opaque, raiser-defined payload that holds the state needed to render the attention UI. The daemon ORs the presence of any flag (alongside an in-flight `session/request_permission`) into [`awaitingInput`](#on-sessionlist-entries-_metahydra-acp) so the picker (and any other client) lights up regardless of which mechanism flagged the session.

Flags are keyed by `(sessionId, source, reason)`:

- `source` is resolved server-side from the calling connection's identity (transformer name, or `"daemon"` for internal raisers such as the permission system). Two transformers can use the same `reason` string without colliding.
- `reason` is a raiser-chosen string. Daemon does not interpret it.
- `payload` is opaque JSON. The shape is defined by whoever raises the flag — clients render based on `source` + `reason` and the payload they recognize.

**First-class consumers:**

- The permission system raises `source: "daemon", reason: "permission"` flags with a payload that includes the tool call, options, and a replay-on-attach hook. The auto-popping permission modal (`session/request_permission`) reads from these flags.
- Transformer-owned features raise their own flags with payloads that match their use case. The daemon doesn't interpret `source` or `reason` — clients recognize the combinations they understand and ignore the rest.

**Persistence.** Every flag is mirrored to its session's `meta.json` on each `set` / `clear`. The flag set is restored when the session loads (cold or live), so `awaitingInput` and the attention payload are accurate immediately on attach.

**Startup reconcile.** Each raiser is responsible for reconciling stale state on its own startup — a raiser comes up, fetches its currently-persisted flags via `GET /v1/sessions/attention?source=<name>`, decides per flag whether the underlying state is still meaningful, and `clear`s the ones that aren't. For the permission system, reconcile is trivial: every persisted permission flag is dead on startup (the agent's turn crashed), so they're all cleared.

#### `GET /v1/sessions/:id/attention`

Returns every flag currently raised on a session. Used by clients to render attention UI (badges, modals, tooltip details).

```jsonc
{
  "flags": [
    {
      "source": "daemon",
      "reason": "permission",
      "raisedAt": 1717012800000,
      "payload": { /* shape defined by the raiser */ }
    }
  ]
}
```

**Errors**

- `404` — session unknown.

#### `GET /v1/sessions/attention?source=<name>`

Returns flags owned by a specific source across all sessions. Used by raisers during their startup-reconcile pass.

```jsonc
{
  "flags": [
    { "sessionId": "<id>", "source": "<name>", "reason": "<r>", "raisedAt": <ts>, "payload": <p> }
  ]
}
```

#### `POST /v1/sessions/:id/attention/clear`

Emergency user-side clear, intended for the case where a raiser has gone away leaving stuck flags. Body: `{ "source": "<name>", "reason": "<r>" }` to clear one flag, or `{}` to clear all flags on the session.

**Errors**

- `404` — session unknown.

### Session events

#### `GET /v1/sessions/:id/events`

Stream selected session/update kinds from a single session's `history.jsonl` as NDJSON. One entry per line, filtered by the `kinds` query parameter and optionally time-bounded by `since`. Consumed by [hydra-acp-budgeter](https://github.com/smagnuso/hydra-acp-budgeter) for time-bucketed cost reporting.

**Query parameters**

| Param | Required | Type | Description |
|-------|----------|------|-------------|
| `kinds` | **Yes** | `string` | Comma-separated list of event kinds to include. Must be a subset of the allowlist below. Unknown kinds → `400`. |
| `since` | No | ISO-8601 timestamp | Lower bound on `ts`; only entries with `recordedAt >= since` are emitted. |

**Kind allowlist**

The following session-update kinds may be queried. The list is additive — new kinds may be added without a version bump; removing or renaming entries requires one.

| Kind | Description |
|------|-------------|
| `usage_update` | Cost/token snapshot at turn boundary (persisted once per turn by `recordCurrentUsageSnapshot`, session.ts:1832). Cumulative running total — consumers diff successive rows to get per-turn deltas. |
| `tool_call` | Tool call placed |
| `tool_call_update` | Tool call updated (status, args, result refs) |
| `prompt_received` | User turn boundary marker |
| `turn_complete` | Assistant turn boundary marker |
| `permission_resolved` | Permission request resolved |

Other kinds (notably `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk`, `plan`, `current_model_update`, etc.) may exist on disk but are **not** queryable via this endpoint. Requesting one returns `400`. Rationale: chunk kinds can stream megabytes per session and need a separate pagination/byte-cap decision; state-snapshot kinds are already served via `meta.json` + attach-time synthesis.

**Response — `200 OK`**

- `Content-Type: application/x-ndjson`
- Body: one JSON object per line, sorted by `ts` ascending (oldest-first, matching the append order in `history.jsonl`). Each row has the shape:

```jsonc
{
  "ts":        "2026-06-17T08:18:32.123Z",   // recordedAt as ISO-8601
  "kind":      "usage_update",                // from params.update.sessionUpdate
  "update":    { ... raw params.update ... }, // pass-through envelope
  "messageId": "msg_..."                      // present when stamped; omitted otherwise
}
```

The `update` field carries the full `params.update` object (with `sessionUpdate`, `cost`, `tokenUsage`, etc. as recorded). The `messageId` field is included only when the original entry had one (`update.messageId !== undefined && update.messageId !== null`).

**Stability guarantee**

Consumers may rely on all documented fields being present in every row. New optional fields may be added to the `update` envelope or as top-level keys without a version bump. The daemon never removes or renames documented fields without a major version bump.

**Errors**

- `400` — `kinds` parameter missing, empty, or contains an unknown kind. Body: `{ "error": "kind \"X\" is not queryable; allowed kinds: usage_update, tool_call, ..." }`.
- `400` — `since` is not a valid ISO-8601 timestamp.
- `404` — session unknown (no live session and no on-disk record).

**Worked example**

Query a session's usage events from midnight UTC:

```bash
curl -H "Authorization: Bearer hydra_token_abc123" \
  "http://127.0.0.1:55514/v1/sessions/hydra_session_xyz/events?kinds=usage_update&since=2026-06-17T00:00:00Z"
```

Sample response (`application/x-ndjson`):

```jsonc
{"ts":"2026-06-17T08:15:01.432Z","kind":"usage_update","update":{"sessionUpdate":"usage_update","cost":{"amount":0.12,"currency":"USD"},"tokenUsage":{"prompt":1024,"completion":512}}}
{"ts":"2026-06-17T08:17:45.891Z","kind":"usage_update","update":{"sessionUpdate":"usage_update","cost":{"amount":0.34,"currency":"USD"},"tokenUsage":{"prompt":4096,"completion":2048}}}
{"ts":"2026-06-17T08:18:32.123Z","kind":"usage_update","update":{"sessionUpdate":"usage_update","cost":{"amount":0.48,"currency":"USD"},"tokenUsage":{"prompt":8192,"completion":4096}}}
```

Each row carries a cumulative running total — diff successive rows to get per-turn spend. The `messageId` field is omitted here because `recordCurrentUsageSnapshot` does not stamp it; when querying `tool_call` or `turn_complete`, `messageId` is present.

#### `GET /v1/sessions/events`

Stream selected session/update kinds from **every** session's `history.jsonl`, interleaved by `ts` ascending (k-way merge). Each emitted row carries an additional top-level `sessionId` field. Useful for cross-session cost aggregation and time-bucketed analytics.

**Query parameters** — identical to [`GET /v1/sessions/:id/events`](#get-v1sessionsidevents): `kinds` (required) and `since` (optional).

**Response — `200 OK`**

- `Content-Type: application/x-ndjson`
- Body: one JSON object per line, sorted by `ts` ascending across all sessions. Each row has the shape:

```jsonc
{
  "sessionId": "hydra_session_xyz",          // present on every row
  "ts":        "2026-06-17T08:15:01.432Z",   // recordedAt as ISO-8601
  "kind":      "usage_update",
  "update":    { ... raw params.update ... },
  "messageId": "msg_..."                     // present when stamped; omitted otherwise
}
```

**Pre-filter optimization**: sessions whose `meta.updatedAt` falls before the `since` timestamp are excluded via a cheap stat-only check — their `history.jsonl` is never opened. This avoids unnecessary disk I/O on long-lived installs with thousands of cold sessions.

**Client disconnect handling**: if the client disconnects mid-stream, all open file handles (one per session iterator) are closed immediately to avoid leaking file descriptors.

**Stability guarantee** — same as [`GET /v1/sessions/:id/events`](#get-v1sessionsidevents).

**Errors**

- `400` — same validation rules as the per-session endpoint.
- `500` — internal error (e.g., failure to open a session's `history.jsonl` that isn't ENOENT).

### Agents

#### `GET /v1/agents`

List known agents (registry + per-agent install state). The same catalog is available over ACP via [`hydra-acp/agents/list`](#hydra-acplist_agents) for protocol-only clients.

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

Several HTTP routes are reachable from spawned agents (not from generic REST clients). All daemon-owned MCP servers share the same Streamable HTTP transport, the same per-session bearer model (a capability token minted at `session/new` and embedded in the agent's `mcpServers` descriptor), and bypass the daemon's global Bearer hook.

#### `POST/GET/DELETE /mcp/hydra-acp-stdin`

In-memory `hydra cat --stream` ring buffer, exposed as MCP tools (`head`, `tail`, `read`, `grep`, `wait_for_more`, `info`).

#### `POST/GET/DELETE /mcp/hydra-acp-recall`

Pre-compaction conversation history, exposed so the agent can page back specifics after a compaction summary has replaced earlier content in working memory. Tools:

| Tool | Input | Returns | Semantics |
|---|---|---|---|
| `search` | `{ query, limit?, include_tool_calls? }` | Match list with snippets | Case-insensitive substring search across pre-compaction entries. |
| `range` | `{ from_entry, to_entry }` | Verbatim entries | Pull a contiguous slice of the pre-compaction log. |
| `tool_calls` | `{ tool_name?, limit? }` | Tool-call entries | Enumerate prior tool invocations, optionally filtered by tool name. |

All three return a short "no compacted history yet" payload until the session has been compacted at least once.

#### `POST/GET/DELETE /mcp/:name`

Extension-contributed MCP server, registered via the [`hydra-acp/mcp_tools/register`](#request-process--daemon-hydra-acpregister_mcp_tools) JSON-RPC method. Same Streamable HTTP transport and per-session bearer model as `/mcp/hydra-acp-stdin`.

Neither route is intended for human callers. They exist so spawned agents can talk MCP back into the daemon: the daemon injects the appropriate `mcpServers` descriptor into the agent's `session/new` params, and the agent calls these routes as it would any other MCP server.

---

## ACP wire protocol

The `/acp` WebSocket carries JSON-RPC 2.0 frames in both directions. After the WebSocket upgrade, the first JSON-RPC message the client sends is `initialize` per ACP. From there, the connection speaks:

- standard ACP (`initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/list`, …),
- two RFD-track additions Hydra implements (`session/attach`, `session/detach` per [RFD #533](https://github.com/agentclientprotocol/agent-client-protocol/pull/533)),
- the Hydra-specific extensions documented below.

All Hydra additions live under a single vendor prefix, `hydra-acp/`, and follow ACP's own `resource/action` shape at the leaf (e.g. `hydra-acp/prompt/cancel`, `hydra-acp/agents/list`). The single prefix guarantees no collision with future ACP standard methods.

Resource groups: `prompt/*` (cancel, update, amend, amended), `prompt_queue/*` (added, updated, removed), `child_session/*` (spawn, close, await), `session/*` (fork, closed), `commands/*` (register, invoke), `mcp_tools/*` (register, invoke), `message/*` (emit), `agents/*` (list, install_progress), `connection/*` (keep_alive), and `transformer/*` (initialize, attach, message, session_event).

The `hydra-acp/transformer/*` methods are transformer-specific: only callable on a connection that authenticated as a transformer; extensions and ordinary clients receive `MethodNotFound`.

### Agent discovery

#### Request: `hydra-acp/agents/list`

Enumerate the agents a client can select when creating a session (the id goes in `_meta["hydra-acp"].agentId` on `session/new`). Mirror of the REST [`GET /v1/agents`](#get-v1agents) endpoint — both return the same shape — so a protocol-only ACP client can discover and pick agents without the REST surface. Hydra-specific; no ACP spec equivalent exists yet.

```jsonc
// params: none (empty object accepted)
{}
// result
{
  "version":   "<registry doc version>",
  "fetchedAt": 1717012800000,            // epoch ms of last registry fetch, or null
  "agents": [
    {
      "id":            "claude-acp",
      "name":          "Claude Agent",
      "version":       "0.38.0",
      "description":   "ACP wrapper for Anthropic's Claude",
      "distributions": [ "npx" ],
      "installed":     "yes"             // "yes" | "no" | "lazy"
    }
  ]
}
```

Returns `-32603 InternalError` if the daemon has no registry wired, or surfaces a registry-fetch failure when no cached catalog is available.

### The `hydra-acp` meta namespace

Standard ACP requests and responses carry an optional `_meta: Record<string, unknown>`. Hydra-specific fields ride under the `hydra-acp` key inside that object per the ACP [Extensibility convention](https://agentclientprotocol.com/protocol/extensibility). Generic ACP clients ignore the field, so the additions are strictly additive.

#### On `session/prompt` params (`_meta.hydra-acp`)

| Field | Type | Semantics |
|---|---|---|
| `queuePosition` | `"head" \| "tail" \| { afterMessageId: string }` | Where in the per-session prompt queue this entry lands. Default `"tail"` matches historical behavior (push to the end). `"head"` splices it onto the front of the waiting queue — runs next, right after the in-flight `currentEntry`. `{ afterMessageId }` splices immediately after the named entry; if the id isn't in the queue (already completed, never existed), falls back to `"tail"`. Useful for extensions submitting follow-up prompts that should run before any other queued user prompts (e.g. the planner injecting `/hydra planner status` after an amend to re-acquire its live view), and for future UI features like drag-to-reorder queue chips. Honors are session-local — multiple entries inserted at `"head"` in quick succession are processed FIFO. |

#### On `session/new` params (`_meta.hydra-acp`)

The ACP spec `NewSessionRequest` carries only `cwd` and `mcpServers`. Everything hydra-specific — including **agent selection** — rides under `_meta["hydra-acp"]`; hydra emits **no** non-spec fields at the top level of `session/new`.

| Field | Type | Semantics |
|---|---|---|
| `agentId` | `string` | Which registry agent to spawn the session on. Falls back to `config.defaultAgent` when omitted. This is the only channel for agent selection — there is no top-level `agentId` param. Enumerate valid ids via [`hydra-acp/agents/list`](#hydra-acplist_agents) or REST `GET /v1/agents`. |
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
| `awaitingInput` | `boolean` | Always present. True when any [attention flag](#attention) is raised on the session — including in-flight permission requests (raised by the daemon) and any transformer-raised flags. May be true on cold sessions, since flags persist across cold/live. |
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
| `clientId` | `string?` | The per-attachment client id bound to this connection. **Present in `_meta` only on `session/new` and `session/load`** — those are core ACP spec methods, so the id can't ride at the top level. On the RFD-track `session/attach` response, `clientId` is a top-level field instead (per that method's surface). Lets deferred-echo clients recognize their own `prompt_queue_added` broadcasts. |

> Capability flags (the `prompt.*` and `agents.*` groups) are daemon-wide and ride on the **`initialize`** response's `_meta["hydra-acp"]`, not per-session — see [Capability discovery](#capability-discovery).

> Spec-compliance note: `session/new` and `session/load` are core ACP methods, so their results carry only the spec fields (`sessionId`, `modes?`, `models?`) at the top level — every hydra-specific field, including `clientId`, rides under `_meta["hydra-acp"]`. `session/attach`/`session/detach` are RFD-track methods: only **RFD #533's own** fields sit at the top level (request: `sessionId`, `historyPolicy`, `afterMessageId`, `clientId`, `clientInfo`; response: `sessionId`, `clientId`, `connectedClients`, `historyPolicy`, `replayed`). Hydra's *own* additions on top of the RFD ride under `_meta["hydra-acp"]`: request `readonly`/`replayMode`/`dripSpeed`, and the `session/detach` response `detachStatus`.

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
      "awaitingInput": false,   // any attention flag raised (permission, transformer flag, etc.); cold sessions too
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
| `awaitingInput` | `boolean` | Any [attention flag](#attention) raised on the session — permission requests (daemon-raised) or transformer-raised flags. May be `true` on cold sessions; flags persist. |
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

#### Hydra-only `session/attach` options (`_meta["hydra-acp"]`)

Hydra accepts these under `_meta["hydra-acp"]` on `session/attach` (not top-level — `session/attach` keeps only RFD #533's own fields there):

| Field | Type | Semantics |
|---|---|---|
| `readonly` | `boolean` | Observe-only attach. Any state-changing JSON-RPC method (`session/prompt`, `session/cancel`, `session/set_model`, the `hydra-acp/*` prompt-mutation methods) returns `-32011 PermissionDenied`. A read-only attach to a *cold* session takes a viewer path that streams history straight from disk — no `resurrect`, no agent process. |
| `replayMode` | `"instant" \| "drip"` | Debug-only replay pacing. `drip` re-emits each recorded `session/update` individually, spaced by their original `recordedAt` deltas, to reproduce a session's streaming render. Default `instant`. |
| `dripSpeed` | `number` | Multiplier on the inter-entry gaps in drip mode (>1 faster, <1 slower). Default 1. |

The `session/detach` response carries the detach outcome under `_meta["hydra-acp"].detachStatus` (`"detached"`), alongside the top-level `sessionId`.

### Prompt-queue surface

The daemon owns a per-session prompt queue. Clients submit prompts via standard `session/prompt`; everything mutating the queue afterwards goes through the Hydra methods below. Peer clients stay in sync via the `hydra-acp/prompt_queue_*` notifications.

#### Request: `hydra-acp/prompt/cancel`

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

#### Request: `hydra-acp/prompt/update`

Edit the content of a queued prompt before it runs.

```jsonc
// params
{ "sessionId": "<id>", "messageId": "<id>", "prompt": [ /* ACP prompt array */ ] }
// result
{ "updated": true, "reason": "ok" }
// or
{ "updated": false, "reason": "not_found" | "already_running" }
```

Successful updates broadcast a `hydra-acp/prompt_queue/updated` notification so peer clients can refresh their chip text.

#### Request: `hydra-acp/prompt/amend`

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

Successful amends broadcast a `hydra-acp/prompt/amended` notification — see below.

#### Notification: `hydra-acp/prompt_queue/added`

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

#### Notification: `hydra-acp/prompt_queue/updated`

Fires when a queued prompt's content was changed via `update_prompt` (or by an `amend_prompt` against a queued target).

```jsonc
{ "sessionId": "<id>", "messageId": "<id>", "prompt": [ /* new ACP prompt array */ ] }
```

#### Notification: `hydra-acp/prompt_queue/removed`

Fires when a queue entry leaves the queue.

```jsonc
{
  "sessionId": "<id>",
  "messageId": "<id>",
  "reason":    "started" | "cancelled" | "abandoned"
}
```

- `started` — head transitioned to in-flight (the active turn begins).
- `cancelled` — explicit `hydra-acp/prompt/cancel`.
- `abandoned` — session tear-down with queued entries that never ran.

#### Notification: `hydra-acp/prompt/amended`

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

#### Notification: `hydra-acp/session/closed`

Fires once when a session is closed (cold demotion, delete, daemon shutdown, import-replace). Lets attached clients paint a "session is gone" banner without waiting for the WS itself to drop.

```jsonc
{ "sessionId": "<id>" }
```

#### Notification: `hydra-acp/session/attention_updated`

Broadcast to clients attached to a session whenever its [attention flag](#attention) set changes (a flag raised, payload updated, or cleared). Lets clients refresh their attention UI without polling. The full current flag list is included so clients don't merge deltas.

```jsonc
// params
{
  "sessionId": "<id>",
  "flags": [ /* same shape as GET /v1/sessions/:id/attention */ ]
}
```

### session/update — compaction lifecycle

Attached clients receive `session/update` notifications as compaction progresses. The `update.sessionUpdate` field is `"hydra_compaction"` for all five phases.

**Envelope shape** (all phases):

```jsonc
{
  "sessionId": "<upstream session id>",
  "update": {
    "sessionUpdate": "hydra_compaction",
    "phase": "started" | "iteration" | "deferred" | "swapped" | "failed",
    // ... phase-specific fields below
  }
}
```

**Phase payloads:**

```jsonc
// started — emitted once when the catch-up loop begins
{ "sessionUpdate": "hydra_compaction", "phase": "started", "requestedAt": 1717012800000 }

// iteration — emitted once per successful catch-up loop iteration
{ "sessionUpdate": "hydra_compaction", "phase": "iteration", "iter": 1, "historyLen": 42 }

// deferred — emitted each time the swap is deferred because the session is not quiesced
{ "sessionUpdate": "hydra_compaction", "phase": "deferred", "attempts": 1 }

// swapped — emitted once when the upstream agent is replaced successfully;
//            replaces the old empty session_info_update signal
{ "sessionUpdate": "hydra_compaction", "phase": "swapped", "title": "My Session", "summarizedThroughEntry": 42 }

// failed — emitted when retrySwap exhausts deferrals or encounters a fatal error
{ "sessionUpdate": "hydra_compaction", "phase": "failed", "error": "deferral cap reached — session never quiesced" }
```

**Ordering guarantee:** S1 (state persistence) writes happen before the corresponding broadcast fires. A broadcast never implies that something happened that wasn't persisted — if the write fails, the broadcast is suppressed.

**Cold sessions:** broadcasts are dropped for sessions with no attached clients. The persistent `compactionState` field in the session record provides visibility for cold sessions.

### Local fork

#### Request: `hydra-acp/session/fork`

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

#### Notification: `hydra-acp/agents/install_progress`

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

- **Slash-command verbs.** Register with `hydra-acp/commands/register`. Whenever a user types `/hydra <name> <verb> …` in any session, the daemon forwards a `hydra-acp/commands/invoke` request to the registered connection.
- **MCP tools.** Register with `hydra-acp/mcp_tools/register`. Agents see a `/mcp/<extension-name>` HTTP MCP server; when they call a tool, the daemon forwards a `hydra-acp/mcp_tools/invoke` request to the registered connection.
- **Transformer pipeline** (transformer-only). After `hydra-acp/transformer/initialize`, the daemon calls `hydra-acp/transformer/message` for each intercepted method and `hydra-acp/transformer/session_event` for lifecycle ticks.

Registrations drop on disconnect — the daemon clears the entry and evicts any cached MCP transports.

#### Request (process → daemon): `hydra-acp/commands/register`

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

#### Request (daemon → process): `hydra-acp/commands/invoke`

Daemon dispatches a `/hydra <process-name> <verb> …` invocation. The process's response text (if any) is broadcast as a synthetic `agent_message_chunk` so it appears inline in the conversation.

```jsonc
// params
{
  "sessionId": "<id>",
  "verb":      "<name>",
  "args":      "<args string>",
  "messageId": "<queue entry id>"   // optional; present when dispatched from a user-prompt queue entry
}
// result — at most one of these:
{ "text": "<reply rendered into the conversation>" }
// or
{}   // silent acknowledgement
```

**Slash commands as user-kind queue entries.** `/hydra <name> <verb> …` invocations flow through the same prompt queue as regular user prompts — they fire `hydra-acp/prompt_queue/added`, `hydra-acp/prompt_queue/removed{started}`, `prompt_received`, and `turn_complete` notifications in the same order, so the conversation surface stays consistent regardless of whether a prompt routes to the agent or a slash handler. The `messageId` field carries the queue entry's id; extensions correlate it with `hydra-acp/commands/cancel` notifications scoped to the same id (see below) to detect mid-flight cancellation or amend.

#### Notification (daemon → process): `hydra-acp/commands/cancel`

Fires on the extension's WS connection when an in-flight `commands/invoke` dispatch is being cancelled by the daemon — extensions live outside the client broadcast fanout (`prompt_queue/*` and `prompt/amended` only reach attached clients), so they need a dedicated channel to learn about amends and cancels targeting their slash commands.

```jsonc
{
  "sessionId": "<id>",
  "messageId": "<queue entry id matching commands/invoke params.messageId>",
  "reason":    "amended" | "cancelled" | "abandoned"
}
```

| `reason` | Trigger | Extension should typically |
|---|---|---|
| `amended` | `hydra-acp/prompt/amend` cancelled this slash command in favor of a new prompt | release `commands/invoke` quickly so `drainQueue` can advance to the amended prompt; keep any background work running if it's still meaningful (the planner yields its live view but keeps workers going) |
| `cancelled` | `session/cancel` (^C / Esc / `hydra-acp/session/force_cancel`) | full cleanup, force-stop background work, release `commands/invoke` |
| `abandoned` | session is closing (kill, idle close, daemon shutdown) | cleanup; no need to respond to `commands/invoke` — the WS may already be tearing down |

**The daemon races the cancel against the extension's `commands/invoke` response** — once `cancelExtensionDispatch` fires for a `messageId`, the daemon immediately synthesizes `{stopReason: "cancelled"}` and advances `drainQueue`. If the extension still responds to `commands/invoke` after that, the response is dropped. Extensions don't need to "respond promptly"; the daemon doesn't wait for them. The notification is purely for the extension's own cleanup.

**Idempotent.** Multiple cancel triggers (e.g. amend then session-close before the race settles) only fire the notification once per `messageId` — the daemon clears its tracking on the first call.

**Slash text is excluded from the title heuristic.** The session-title first-prompt heuristic skips any prompt whose first line starts with `/` so administrative prompts like `/hydra title …`, `/model gpt-5`, `/hydra planner create …` don't become the session title. The next non-slash prompt seeds normally.

#### Request (process → daemon): `hydra-acp/mcp_tools/register`

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

#### Request (daemon → process): `hydra-acp/mcp_tools/invoke`

The MCP `tools/call` from the agent, forwarded to the registered process.

```jsonc
// params
{
  "server":    "<process-name>",
  "tool":      "<tool name>",
  "args":      { /* tool args */ },
  "sessionId": "<id>"
}
// result — MCP CallToolResult shape:
{
  "content":           [ { "type": "text", "text": "…" }, … ],
  "structuredContent": { /* optional */ },
  "isError":           false
}
```

`sessionId` carries the hydra session that originated the call. Extensions need this when their tools operate on per-session state (e.g. the planner managing a per-session project board) — agents don't see hydra session ids, so the extension can't derive this from `args`. The daemon resolves the session from the per-session bearer token used to call the MCP HTTP endpoint, so extensions can trust the value without further verification.

### Transformer-only methods

Transformers receive a higher-trust per-process token: they sit in the daemon's message pipeline and can observe (and ultimately rewrite) traffic that no client ever sees. The `hydra-acp/transformer/*` methods are only callable on a transformer-kind connection; extension and client connections get `MethodNotFound` if they try.

#### Request (transformer → daemon): `hydra-acp/transformer/initialize`

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

**Response-side scope.** Declaring `response:<method>` is only effective for `response:session/update` today — the daemon's response chain (`Session.runResponseChain`) only iterates transformers for `session/update` notifications, since those are the only thing the agent emits that flows agent → clients. There is no `response:session/prompt` event: the session/prompt RPC result is consumed by the daemon's `runQueueEntry` and translated into a synthesized `turn_complete` `session/update` via `broadcastTurnComplete`, which is published with `recordAndBroadcast` and therefore bypasses the transformer chain entirely. **A transformer cannot observe `turn_complete` through the intercept stream.** If you need an end-of-turn signal for a sub-prompt you originated via `hydra-acp/message/emit`, await the emit promise instead — see the note on `message/emit` below.

#### Request (daemon → transformer): `hydra-acp/transformer/message`

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
- `processing` — the transformer is taking ownership; the daemon parks the call until the transformer discharges the claim via `hydra-acp/message/emit` with `respondsTo: <token>`. If the transformer doesn't discharge within the claim timeout, the daemon broadcasts a `hydra-acp/transformer/abandoned_request` notification and resumes the chain from the next transformer (fail-open).

**Notification-tailed intercepts.** Most intercepted methods are JSON-RPC requests whose chain tail dispatches as a request to the agent. The exception is `request:session/cancel` — ACP cancel is a notification, so the chain tail dispatches via `agent.notify(...)` and the `payload` field on `stop`/`processing` discharge is irrelevant (no value is returned to the originator). Concretely:

- `continue` → daemon forwards `session/cancel` to the agent as a notification after the chain settles.
- `stop` → daemon suppresses the agent-side notification entirely. Useful when the transformer wholly owns the in-flight state and the agent has nothing to cancel.
- `processing` + discharge → identical to `stop` (the agent is **not** notified). To do async cleanup and *then* let the agent see cancel, the transformer should re-emit `session/cancel` via `hydra-acp/message/emit` with `route: "chain"` before/after discharge.
- `processing` + abandonment timeout → the daemon resumes the chain with notification-tailed semantics; if no downstream transformer stops, the agent is notified (fail-open).

This is the primitive that lets a transformer holding a `session/prompt` `processing`-claim (e.g. the planner holding the orchestrator's turn open across worker dispatch) absorb a user `session/cancel` by discharging the held prompt with `{stopReason: "cancelled"}` and stopping its own background work, without the cancel reaching the agent — which never received the held prompt in the first place.

**Envelope shape.** `envelope` is the **flat ACP params object** for the intercepted method, _not_ a JSON-RPC message wrapper. For example, a `request:session/prompt` intercept receives:

```jsonc
"envelope": {
  "sessionId": "<id>",
  "prompt":    [ /* ContentBlock[] */ ],
  "_meta":     { … }
}
```

— accessed as `envelope.sessionId` / `envelope.prompt`, **not** `envelope.params.sessionId`. Likewise a `response:session/update` intercept receives `{ sessionId, update: { sessionUpdate, … } }` directly; read `envelope.update.sessionUpdate`. When re-emitting via `hydra-acp/message/emit`, the value of `envelope` in the emit body must follow the same flat shape. Double-wrapping (passing `{ params: { … } }`) produces an agent-side validation error (`-32602`) because the daemon forwards the envelope verbatim as the JSON-RPC `params` field on its outgoing request.

#### Notification (daemon → transformer): `hydra-acp/transformer/session_event`

Fires for lifecycle events the transformer declared an interest in.

```jsonc
{ "event": "session.opened" | "session.idle" | "session.closed", "sessionId": "<id>" }
```

#### Request (transformer → daemon): `hydra-acp/message/emit`

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
{
  "ok":       true,
  "response": { /* the agent's response, when route was chain/daemon */ }
}
```

Setting `respondsTo` returns the envelope to the original caller and removes the parked claim. Otherwise, `route: "chain"` re-enters the transformer chain from the next position (loop-safe via the `originatedBy` lineage set).

**The `response` field.** When `route` is `"chain"` or `"daemon"` and `method` is a request (e.g. `session/prompt`, `session/set_model`), the daemon awaits the chain run to completion and includes the agent's response in `response`. This is the canonical primitive for **modify-and-continue**: a transformer parks the original call with `{action: "processing"}`, emits a rewritten envelope via `route: "chain"`, captures `response`, and discharges the parked claim with that response (via a second `message/emit` call with `respondsTo: <token>`). The wire-level turn boundary is preserved — the user's original request stays in flight throughout, and `broadcastTurnComplete` fires once with the agent's actual `stopReason`. For `session/update` notifications and the rare cases where the chain produces no return value, `response` is `undefined`.

**End-of-turn detection.** For `method: "session/prompt"` with `route: "chain"`, the emit's returned promise resolves when the agent's underlying `session/prompt` response comes back — i.e. when the synthetic turn actually completes. **Ride this promise to detect end-of-turn**; do not rely on a `response:session/update` intercept for `sessionUpdate: "turn_complete"`, because that update is published via `recordAndBroadcast` (not the response chain) and never reaches transformers. The agent's `agent_message_chunk` updates _do_ flow through the response chain during the turn, so accumulate text from those intercepts; by the time the emit promise resolves, the accumulated text is complete and ready to parse.

#### Request (transformer → daemon): `hydra-acp/transformer/attach`

Insert the calling transformer into a live session's chain. Lets a transformer self-install on demand — e.g. when its `/hydra <name> <verb>` slash command fires on a session that was not configured to include it in `defaultTransformers`. The invocation itself becomes the opt-in signal; sessions where the transformer is never invoked stay free of its intercepts.

```jsonc
// params
{ "sessionId": "<id>" }
// result
{ "ok": true }
```

**Authorization.** A transformer may only attach **itself**. The ref is resolved server-side from the calling connection's `processIdentity.name`; the request body carries no `name` field, and any attempt to spoof one is ignored. The handler is gated to transformer-kind connections — extension-kind connections receive `MethodNotFound`.

**Idempotent.** If the transformer is already in the session's chain, the existing ref is updated in place (covers transformer restarts where the WS connection is fresh but the name unchanged); duplicate entries are never created. A `session.opened` lifecycle event is emitted to the transformer when it joins, matching the signal it would have received at session creation.

**Live-only.** The target session must be live; cold sessions yield `SessionNotFound`. Transformers rehydrating from their own persisted state should wait for natural client interaction to wake the session, or explicitly resurrect it via `hydra-acp/session/load` before attaching.

**Errors.** `InvalidParams` if `sessionId` is missing or non-string. `SessionNotFound` if no live session matches. `InternalError` if the transformer has not yet completed `hydra-acp/transformer/initialize` (no ref to attach).

#### Request (transformer → daemon): `hydra-acp/attention/set`

Raise or update an [attention flag](#attention) on a session. Idempotent — `set`ting the same `(source, reason)` with the same payload is a no-op; with a different payload, the payload is replaced. The `source` is resolved server-side from the calling connection's transformer name; callers don't pass it. Triggers a [`hydra-acp/session/attention_updated`](#notification-hydra-acpsessionattention_updated) broadcast and writes the new flag set to the session's `meta.json`.

```jsonc
// params
{
  "sessionId": "<id>",
  "reason":    "<raiser-chosen string>",
  "payload":   { /* opaque to daemon; rendered by clients that recognize source+reason */ }
}
// result
{ "ok": true }
```

**Errors.** `InvalidParams` if `sessionId` or `reason` is missing or non-string. `SessionNotFound` if no session matches (live or cold).

#### Request (transformer → daemon): `hydra-acp/attention/clear`

Clear a previously-set flag. Idempotent — clearing a `(source, reason)` that isn't raised is a no-op. Triggers a broadcast.

```jsonc
// params
{ "sessionId": "<id>", "reason": "<r>" }
// result
{ "ok": true }
```

**Errors.** Same as `attention/set`.

#### Request (transformer → daemon): `hydra-acp/child_session/spawn`

Create a child session whose `parentSessionId` is set.

```jsonc
// params
{
  "agentId":         "<id>",     // optional; defaults to daemon's defaultAgent
  "cwd":             "<path>",   // optional if parentSessionId resolves to a live session (cwd inherits)
  "parentSessionId": "<id>",     // optional
  "interactive":     false,       // optional; defaults to false for transformer-spawned children
  "_meta": {
    "hydra-acp": {
      "title": "<label>"        // optional; pre-seeds Session.title so the first user prompt doesn't clobber it
    }
  }
}
// result
{ "childSessionId": "<new id>" }
```

Children start with an empty transformer chain by default. When `cwd` is omitted, the daemon inherits the parent session's cwd — covers the common transformer pattern of "spawn this worker in the same place as my parent" without forcing a separate round-trip to look up the parent's cwd. An explicit `cwd` always wins. If both are missing (no `cwd`, and no `parentSessionId` pointing at a live session), the call rejects with `InvalidParams`.

**Interactive default.** `interactive` defaults to `false` for transformer-spawned children — they exist to do automated work driven by the transformer, not to host a human at a composer, so the default keeps them out of the front-door `hydra-acp session` listing (visible only with `--all`). Pass `interactive: true` if the transformer wants the child to behave like a normal session.

**Title seed.** `_meta["hydra-acp"].title`, when present, sets `Session.title` at create time using the same path as `session/new`. Marks `_firstPromptSeeded=true` so the first user prompt doesn't replace the label. Same shape as the `title` field on [`session/new` params](#on-sessionnew-params-_metahydra-acp) — transformers labelling their children (e.g. the planner naming workers after their tasks) avoid a post-spawn `session_info_update` round-trip.

#### Request (transformer → daemon): `hydra-acp/child_session/await`

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

#### Request (transformer → daemon): `hydra-acp/child_session/close`

```jsonc
// params
{ "childSessionId": "<id>" }
// result
{ "ok": true }
```

Closes the child session (cold demotion; record preserved).

#### Request (transformer → daemon): `hydra-acp/connection/keep_alive`

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

#### Notification: `hydra-acp/transformer/abandoned_request`

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

The `initialize` response carries Hydra's extension capabilities in two places:

- **Standard `agentCapabilities.sessionCapabilities`** advertises the RFD #533 (`attach: {}`) and Session List (`list: {}`) extensions.
- **`_meta["hydra-acp"]`** on the same response carries hydra's own capability groups, keyed by resource to mirror the `hydra-acp/<resource>/<action>` method namespaces (and deliberately **not** named `promptCapabilities`/`agentCapabilities`, which are ACP spec names with different meanings):

```jsonc
"_meta": {
  "hydra-acp": {
    "prompt": {
      "queueing":   true,   // accepts concurrent session/prompt (queues)
      "cancelling": true,   // hydra-acp/prompt/cancel
      "updating":   true,   // hydra-acp/prompt/update
      "amending":   true,   // hydra-acp/prompt/amend
      "pipelining": false   // forwards concurrent prompts to the agent
    },
    "agents": {
      "list":            true,   // hydra-acp/agents/list (entries carry install state)
      "installProgress": true    // hydra-acp/agents/install_progress notifications
    }
  }
}
```

Clients gate UI on those flags rather than relying on `MethodNotFound` round-trips — e.g. probe `agents.list` before offering an agent picker, or `prompt.amending` before showing an Amend affordance. Older daemons that don't advertise a group/flag should be assumed to lack the corresponding capability.

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
