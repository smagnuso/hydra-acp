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
  - [Remotes](#remotes)
  - [Config](#config)
  - [Sessions](#sessions)
  - [Attention](#attention)
  - [Turn completion webhook](#turn-completion-webhook)
  - [Session events](#session-events)
  - [Agents](#agents)
  - [Registry](#registry)
  - [Extensions](#extensions)
  - [Transformers](#transformers)
- [MCP endpoints](#mcp-endpoints)
- [ACP wire protocol](#acp-wire-protocol)
  - [Federated ("foreign") sessions](#federated-foreign-sessions)
  - [The `hydra-acp` meta namespace](#the-hydra-acp-meta-namespace)
  - [Agent-initiated turns](#agent-initiated-turns)
  - [Prompt-queue surface](#prompt-queue-surface)
  - [Stdin streaming](#stdin-streaming)
  - [Authentication](#authentication)
  - [Session close](#session-close)
  - [Session delete](#session-delete)
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

### Remotes

Federation: lets one daemon act as a client of another (`hydra remote add/list/remove`, mirroring `git remote add <name> <url>`). A remote entry is a session token *this* daemon holds for a *peer* daemon, obtained the same way a human obtains one (`POST /v1/auth/login` on the peer), just performed by the daemon itself instead of a CLI. This is a separate concept from the `remotes.json` credential cache the CLI/TUI keep for their own `hydra session attach hydra://host/...` logins — that file is per-human-machine; this registry is per-daemon and is what session forwarding (`name:sessionId` addressing, see [Sessions](#sessions)) routes through.

Each remote is keyed by a **name** the caller chooses (`PEER_NAME_PATTERN` in `core/peer-store.ts`: starts with an alphanumeric, then alphanumerics/`.`/`_`/`-`, ≤64 chars — no colons or slashes). The name, not the peer's host/port, is what appears in federated session ids and in any address a client sees; the raw network location stays internal to this registry. Unlike `git remote add`, re-running `POST /v1/remotes` under a name that already exists **refreshes** the stored token instead of erroring — that's the documented way to renew a credential nearing `expiresAt`.

#### `POST /v1/remotes`

Log into a peer daemon and store the resulting session token under `name`. The password is used once for this exchange and is never persisted; only the peer's token and its expiry are kept. Never returns the token itself.

**Request body**

```jsonc
{
  "name":     "foo",           // local alias; see PEER_NAME_PATTERN above
  "host":     "foo.example.com",
  "port":     55514,          // optional, defaults to the daemon's default port
  "password": "<peer's master password>",
  "label":    "<optional human label, ≤256 chars — shown in the PEER's own `auth list`>",
  "ttlSec":   31536000        // optional; otherwise the peer's login default
}
```

**Response — `201 Created`**

```jsonc
{
  "name":      "foo",
  "host":      "foo.example.com",
  "port":      55514,
  "label":     "<optional>",
  "expiresAt": "2027-06-04T19:00:00.000Z",
  "addedAt":   "2026-09-04T19:00:00.000Z",
  "status":    "ok"    // seeded "ok" immediately — see GET /v1/remotes
}
```

**Errors**

- `400` — invalid request body (including a `name` that doesn't match `PEER_NAME_PATTERN`).
- `401` — wrong password for the peer.
- `429` — the peer rate-limited the login attempt; back off.
- `502` — the peer was unreachable, has no password configured, or returned a malformed response.

#### `GET /v1/remotes`

List configured peers. Metadata only — the token is never returned. A peer past its `expiresAt` is still listed (staleness is surfaced to the operator, not hidden); re-run `POST /v1/remotes` under the same name to refresh it.

`status` reflects the daemon's own periodic liveness poll (`daemon/peer-health.ts`, every 30s, hitting the peer's `GET /v1/auth/verify` with the stored token) — not a real-time check made by this call. One of:

- `"ok"` — last poll reached the peer and the token verified.
- `"unauthorized"` — the peer answered but rejected the token (expired/revoked — re-run `POST /v1/remotes`).
- `"unreachable"` — the peer didn't answer (network error, timeout, or down).
- `"unknown"` — no poll has completed yet (daemon just started, or the peer was just added and hasn't been independently re-verified — though `POST /v1/remotes` seeds `"ok"` immediately in that case, see above).

This is visibility only: forwarding a REST or ACP call to a peer always makes its own live attempt regardless of the cached `status`, which is why a stale `"ok"` can't cause a forward to wrongly succeed or fail — worst case, the status column lags reality by up to one poll interval.

**Response — `200 OK`**

```jsonc
{
  "remotes": [
    {
      "name":          "foo",
      "host":          "foo.example.com",
      "port":          55514,
      "label":         "<optional>",
      "expiresAt":     "<ISO-8601>",
      "addedAt":       "<ISO-8601>",
      "status":        "ok",              // "ok" | "unauthorized" | "unreachable" | "unknown"
      "lastCheckedAt": "<ISO-8601>"        // absent if status is "unknown"
    },
    …
  ]
}
```

#### `DELETE /v1/remotes/:name`

Un-federate a peer: best-effort revokes this daemon's token on the peer (`POST /v1/auth/logout`, failures ignored so an already-unreachable peer doesn't block cleanup) and forgets the local record.

**Response**

- `204` — removed.
- `404` — no remote with that name.

### Config

#### `GET /v1/config`

Read-only snapshot of the daemon's effective config. Mutations go through `~/.hydra-acp/config.json` and require `hydra-acp daemon restart` to take effect — there is no `PUT /v1/config`.

**Response — `200 OK`**

```jsonc
{
  "defaultAgent":         "claude-acp",
  "defaultCwd":           "~",
  "sessionDefaults":      { "claude-acp": { "model": "claude-opus-4-7", "mode": "plan" } },
  "synopsisAgent":        "claude-acp",                       // optional
  "synopsisModel":        "claude-haiku-4-5-20251001",        // optional
  "defaultTransformers":  []
}
```

### Sessions

**Federated session ids.** A `sessionId` of the form `name:localId` (see `formatForeignSessionId` in `core/foreign-session-id.ts`) names a session owned by the federated peer registered under `name` (see [Remotes](#remotes)) rather than this daemon. Any route below shaped `/v1/sessions/:id...` transparently forwards to that peer using this daemon's own stored peer credential when given such an id — the caller never needs its own credential for the peer, and never sees the peer's raw host/port. Unrecognized/local-looking ids (no colon) are handled locally as always. An entry merged in from a peer (see `GET /v1/sessions` below) also carries `"remote": "<name>"`. This is deliberately a different field from `importedFromMachine` (set on a cold bundle-imported record — see `POST /v1/sessions/import`): `remote` marks a *live* session that stays live on the peer, `importedFromMachine` marks a static copy sitting locally; a client that folds both into one "which host" picker/dropdown still needs to branch on which field is set before deciding what clicking the entry should do.

- `404` if this daemon has no remote registered under that name.
- `502` if the peer is federated but unreachable or errors.
- `501` for `?follow=1` on `/v1/sessions/:id/history` or `/v1/sessions/:id/events` — long-lived streaming isn't forwarded yet; attach directly to `hydra://<peer's host>[:port]/<localId>` instead (the *real* host/port, resolved server-side — the alias only works through forwarding).

`GET /v1/sessions` additionally merges in every federated peer's own list (each entry's `sessionId` rewritten to the `host:localId` form above) whenever the call has no `cwd` filter and isn't an incremental (`since=`) poll — both of those are inherently local-machine-scoped and skip the merge. An unreachable peer is silently omitted from the merge rather than failing the whole listing (there's no peer-liveness tracking yet).

#### `GET /v1/sessions`

List sessions known to the daemon.

**Query**

- `cwd=<path>` — filter to sessions opened against this working directory. Matches a session's effective `cwd` **or**, for a session running in an isolated workspace, its `workspace.sourceCwd`. So filtering by a repository returns both the plain sessions in it and every workspace derived from it, while filtering by a workspace path returns only that one. This is a match on the recorded derivation edge, **not** a path-prefix test: a workspace lives outside its source tree and shares no prefix with it. See [Workspace isolation](#workspace-isolation).
- `includeNonInteractive=1` — include piped `hydra cat` sessions that are normally hidden.
- `status=warm` | `status=cold` — return only one side of the warm/cold split, filtering on the entry's own `status` field. `warm` is answered from the daemon's in-memory session map without reading the session store, so it stays cheap on an install with a large history: a client watching live state (busy / awaiting-input) should poll this rather than the full list, which has to stat and serialize every cold record for a caller that will discard them. An unrecognised value is ignored and the full list returned, which is also how a daemon predating this parameter behaves — so a client that needs the guarantee should still check `status` on each row.
- `since=<cursor>` — incremental listing. Pass the `cursor` from a previous response and the daemon returns **every warm entry** plus **only the cold entries whose record changed at or after that cursor**, with `removed` naming the sessions deleted since. The response shape is unchanged; only the contents narrow. A client polling the list should use this: a full listing reads and validates every record on disk (tens of MB on a long-lived install), an incremental one reads only what changed. Combines with `cwd`, `includeNonInteractive` and `status` as usual. `400` if the value is not a non-negative number.

  Merge rule: replace the client's warm set with the response's warm entries, upsert the cold entries by `sessionId`, delete the `removed` ids, then store the new `cursor`. The cursor is the newest record mtime the daemon knows, and the filter is `>=`, so the newest row can be re-sent on the next poll; treat a re-sent row as an upsert, not a change. A cursor stays valid across daemon restarts: it is derived from file mtimes, and deletions are recovered from tombstones at startup. A client that never sends `since` sees exactly the pre-cursor behaviour.

**Response — `200 OK`**

```jsonc
{
  "sessions": [
    {
      "sessionId":       "hydra_session_abc",
      "agentId":         "claude-acp",
      "cwd":             "/work",
      "title":           "fix flaky test",
      "status":          "warm",     // "warm" | "cold"
      "busy":            false,
      "attachedClients": 2,
      "updatedAt":       "2026-05-29T18:01:23.000Z"
      // …other SessionListEntry fields (currentModel, currentUsage,
      // importedFromMachine, forkedFromSessionId, …)
    },
    …
  ],
  "removed": [],                    // session ids deleted since `since`; always [] without it
  "cursor":  1788396252071.123      // pass back as `since=` on the next poll
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
  "q":            "regression",
  "sessionIds":   [ "<id>", … ], // optional scope filter
  "snippetWidth": 160            // optional; target chars per snippet
}
```

`q` is tokenized on whitespace, quote-aware. Bare terms default to `OR`; a
standalone `and` / `or` token (any case) sets the operator for the whole
query, and `AND` wins if both appear. Wrap a phrase in double quotes to
match it literally, operators included. A term may carry a scope prefix:
`prompt:` (user text), `response:` (agent text + thoughts), `tool:` (tool
titles, names, rawInput, locations), `edit:` / `edited:` (paths of files
the session *changed*).

`edit:` differs from the others in three ways:

- **Edits, not mentions.** It matches only tool calls carrying an edit
  payload (canonical `content[]` `type:"diff"`, or Claude's Edit / Write /
  MultiEdit `rawInput`), so a `Read` or `Grep` of the same path does not
  match. `tool:` would match those, since it searches the whole serialized
  `rawInput`. Deletes and shell-driven mutations (`sed -i`, `git checkout`,
  `mv`) carry no edit payload and are therefore invisible to it.
- **Path-segment matching, not substring.** An absolute term is a subtree
  test (`edit:/repo/src` matches `/repo/src/tui/app.ts`); a relative term
  matches any run of whole segments (`edit:src/tui`, `edit:app.ts`), so
  `edit:foo` does not match `/dev/foobar`.
- **Counts distinct files.** `totalMatches` is the number of distinct files
  matched, not the number of sightings — a path is re-emitted on every
  `tool_call_update` for the same call, so counting sightings would be
  meaningless. Snippet `text` is the whole path rather than a centred
  window, and `snippetWidth` does not apply.

For a workspace-isolated session, a term matches against **either** the
recorded path or its source-tree equivalent (the session's `cwd` prefix
swapped for `workspace.sourceCwd`), so both the workspace path and the real
checkout find it. Snippets always report the recorded path. A session whose
workspace binding has since been cleared has no mapping left, so only its
workspace paths match.

`snippetWidth` is the caller's render width in characters, match text
included. Clamped to `[24, 512]`; defaults to `72`. Snippets are built by
centring the match in that budget and spending either side's unused
allowance on the other.

Tool *output* is not indexed — only conversation text, tool inputs, and
the failure text of tool calls that ended `failed` / `rejected` /
`cancelled`.

**Response — `200 OK`**

```jsonc
{
  "query":     "regression",
  "truncated": false,          // true when the session cap (200) was hit
  "results": [
    {
      "sessionId":    "<id>",
      "cwd":          "/path",
      "status":       "warm" | "cold",
      "updatedAt":    "<iso8601>",
      "title":        "…",     // omitted when the session has none
      "totalMatches": 12,      // every occurrence, not just the shown ones
                               // (for edit: scope, distinct files matched)
      "snippets": [            // capped at 5/session, budgeted per term
        {
          "kind":       "agent" | "user" | "thought" | "tool" | "tool-input" | "edit",
          "toolName":   "Edit", // only for tool / tool-input / edit kinds
          "text":       "…regression…",
          "recordedAt": 1782587063587
        }
      ]
    }
  ]
}
```

**Errors**

- `400` — `q` is missing or empty.

#### `POST /v1/sessions`

Create a new session. Equivalent to ACP `session/new` over REST. An omitted `agentId` resolves a `.hydra-acp.json` overlay for the finalized `cwd` (nearest `defaultAgent` between `cwd` and `$HOME`) before falling back to daemon config. An omitted `cwd` falls back to daemon config directly.

**Request body**

```jsonc
{
  "cwd":        "/work",                     // optional
  "agentId":    "claude-acp",                // optional
  "mcpServers": [ /* MCP descriptors */ ],   // optional
  "workspace":  { "label": "feature-x" },    // optional; see Workspace isolation
  "remote":     "foo"                        // optional; see below
}
```

`workspace` takes the same shape as the ACP `_meta["hydra-acp"].workspace`
request documented under [Workspace isolation](#workspace-isolation). It sits at
the top level here because the `_meta` nesting exists to satisfy ACP's rule that
`session/new` carries no non-spec top-level fields, and this is not that method.
The `201` response echoes the resulting `workspace` object when one was created.

**`remote`**: create the session directly on the federated peer registered under that name (see [Remotes](#remotes)) instead of locally. `cwd`/`agentId`/`mcpServers`/`workspace` forward as given — an omitted `cwd`/`agentId` resolves against the *peer's* defaults and directory config, not this daemon's, since the session will live entirely there. This daemon's own extension-MCP minting is skipped for a remote create (those descriptors point at loopback URLs on this box, unreachable from wherever the peer's agent actually runs); the peer performs its own enrichment for its own registered extensions. The response's `sessionId` comes back already in `name:localId` form (see [Sessions](#sessions)), so it can be attached/prompted/etc. exactly like any other federated id with no extra step.

- `404` — no remote registered under that name.
- `502` — the remote is registered but unreachable.
- Any other status/body — passed through verbatim from the peer's own `POST /v1/sessions` response (e.g. a `500` if the peer failed to spawn the agent).

**Response — `201 Created`**

```jsonc
{
  "sessionId": "hydra_session_abc",
  "agentId":   "claude-acp",
  "cwd":       "/work"
}
```

#### `POST /v1/sessions/:id/kill`

Demote a live session to cold. The on-disk record is preserved so the session can be resurrected later. Use `DELETE` to drop the record too. Idempotent. REST equivalent of the ACP [`session/close`](#session-close) method — both channels converge on the same daemon-side teardown (`Session.close({deleteRecord:false})`), differing only in that REST returns `202` immediately without awaiting the ~1s teardown, while ACP awaits and returns `{}`.

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

Mutate one field of a session record. The body shapes below are mutually exclusive.

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

**Request body — repair the working directory**

```jsonc
{ "cwd": "/absolute/path" }
```

Points a **cold** session at a different directory. Exists for records whose `cwd` outlived the directory it names (a removed workspace, a moved checkout); such a session otherwise resurrects into nowhere and cannot be fixed from outside the daemon. The target must already exist.

Response: `204` on success, `400` if `cwd` is not an absolute path or is not a directory, `404` on unknown session, `409` when the session is **live** (its agent was spawned in its cwd and cannot change directory — moving a live session is a swap, via `workspace start`) or **isolated** (its `cwd` *is* its workspace; clear the binding first, below).

**Request body — clear the workspace binding**

```jsonc
{ "workspace": null }
```

Drops the `workspace` field from the record, so an isolated session stops claiming a workspace and its next resurrect starts fresh from `sourceCwd` instead of rebuilding the checkout. Clear-only: any non-null value is rejected, because binding a session to a workspace swaps the agent's cwd, transcript, and snapshot refs together and belongs to `workspace start`.

Cold sessions only. `hydra workspace remove` calls this after the directory is already gone; the branch and the last autosave ref are left in place for recovery.

Response: `204` on success, `400` if `workspace` is anything but `null`, `404` on unknown session, `409` when the session is live — its `cwd` **is** the workspace, so the binding may only be dropped by something that moves the agent too (`workspace stop` / `workspace detach` in the session).

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

#### `POST /v1/sessions/:id/workspace/clean`

Puts a live session's workspace back to the state it was created in: the tree resets to the workspace's recorded base, untracked files are removed, and nested trees (submodules) are re-populated and reset. Equivalent to `/hydra workspace clean` inside the session, and to what `workspace start --clean` would have produced. The session stays in the workspace and its branch survives; commits made in the workspace are discarded.

**Request body**

```jsonc
{ "deep": false }   // optional; default false
```

`deep` also removes ignored files (`node_modules`, a carried `.env`) and then re-applies the repo's `carry` list and re-runs `postCreate`. The end state is the same either way; `deep` rebuilds what the default preserves.

**Response: `202 Accepted`**

```jsonc
{ "report": "Cleaned ~/.hydra-acp/workspaces/<hash>/feature back to ..." }
```

The body carries the same multi-line report the slash command prints, including the recovery refs for what was discarded. There is no other way to obtain those, so a caller should surface it rather than discard it.

**Live sessions only.** `409` when the session is cold. Every guard that makes this safe belongs to the live session: the agent must be quiesced because its working tree is about to be rewritten underneath it, the workspace must have no co-tenant session, and the returned report is the only thing that tells the agent its files are gone. A cold `clean` would be a different and more dangerous operation wearing the same name; use `hydra workspace remove` for a workspace whose session has gone.

Also `409` when a guard refuses (agent mid-turn, workspace shared, provider records no base state to return to), `400` when `deep` is not a boolean, and `404` for an unknown session.

**Landing anchor.** This rewrites the workspace's start anchor to its base commit and records `workspace.clean: true`. That is load-bearing rather than bookkeeping: a workspace created *with* the source's uncommitted work carried in has that work as its anchor, and landing excludes the anchor from the patch it replays. Cleaning deletes the workspace's copy, so an un-rewritten anchor would make the next landing restore the user's pre-start work from neither the merge nor the replay. See [Workspace isolation](#workspace-isolation).

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

**Query parameters**

- `tools=1|true|yes`: include the per-turn bulleted tool-call list. Off by default.
- `thoughts=1|true|yes`: include the agent's reasoning/thought stream. Off by default.

**Windowing parameters**

A *turn* starts at each user prompt. Events recorded before the first prompt ride with turn 1. All four windowing params are **numeric on the wire**; the duration strings the CLI accepts (`45s`, `10m`, `2h`, `3d`) are a client-side convenience that `hydra` converts before calling, so REST `since` is epoch millis and nothing else.

| Param | Type | Semantics |
|---|---|---|
| `from` | `number` | First turn to render, 1-indexed, inclusive. Negative counts back from the last turn, so `-1` is the final turn and `-5` starts five turns from the end. Default `1`. |
| `to` | `number` | Last turn to render, 1-indexed, inclusive. Negative counts back from the last turn. Default `<total>`. |
| `last` | `number` | Positive count of trailing turns. **Overrides `from`/`to`** when set. |
| `since` | `number` (epoch ms) | Applied *in addition to* the turn window: a turn renders only if it is both in range and has at least one event at or after the cutoff. |

Out-of-range bounds **clamp rather than error**: `last=99` on a 5-turn session renders all 5. An inverted window (`from=4&to=2`) selects nothing and renders the empty-body placeholder.

**Truncation is announced in the body.** When the selected window is narrower than the whole transcript, the rendered markdown carries `_Showing turns X-Y of N._` immediately after the header. This is the only signal that distinguishes a slice of a long session from a short session, so consumers that care must read it rather than infer from turn count.

**Response — `200 OK`**

- `Content-Type: text/markdown; charset=utf-8`

**Response — `400 Bad Request`** when `from`, `to`, `last`, or `since` is non-numeric. Body: `{ "error": "<param> must be a number" }`.

#### `POST /v1/sessions/:id/fork`

Branch a local session. `forkAt` defaults to the source's most-recent `turn_complete`; `cwd` and `agentId` default to the source's. The new session is minted with a fresh local id + `lineageId` and carries `forkedFromSessionId` for ancestry views.

**Request body**

```jsonc
{
  "forkAt":  "<messageId>",     // optional
  "cwd":     "/work-fork",      // optional
  "agentId": "claude-acp",      // optional
  "model":   "claude-opus-4-7"  // optional; applied via session/set_model at attach
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

### Turn completion webhook

A caller that submits a prompt (`session/prompt`, or any path that produces a `messageId`) normally learns the turn finished one of two ways: the `session/prompt` response itself (if it's the one holding that connection open), or a `turn_complete` `session/update` while attached. Both require holding a live connection to the daemon for as long as the turn takes — which is a real cost for a caller that isn't otherwise participating as an ACP client, e.g. a background service that dispatched a prompt on someone else's behalf and wants to react once, later, without keeping anything open in between.

`POST /v1/sessions/:id/prompt/:messageId/notify` registers a one-shot HTTP callback for that *specific* `messageId` instead. The daemon `POST`s to the given URL exactly once, when (and only when) that messageId's turn completes — no polling, no held connection.

**Scope.** Warm sessions only — a cold session has no turn in flight to wait for; any prompt it ever ran has already resolved. Registration is per-messageId, not per-session: completions for other prompts on the same session never trigger a callback you didn't register for.

**In-memory only.** Registrations do not survive a daemon restart. A caller whose registration was lost that way gets no callback and must notice (e.g. on reconnect) and re-register, or fall back to polling.

**Delivery is best-effort, not queued.** One `fetch` attempt, fire-and-forget, no retry. A caller that needs stronger guarantees re-registers rather than the daemon accruing retry/backoff state per callback.

**Follows an amend.** If the registered prompt is amended (`hydra-acp/prompt/amend`) before it finishes, the registration transfers to the replacement prompt rather than firing early on the original's cancellation — a caller registered to learn when this line of work is actually done, and an amend continues that work under a new `messageId`, it doesn't end it. The delivered payload's `messageId` always stays the one you registered for; `amendedTo` reports the `messageId` that actually completed, when it differs. This can only chase one hop of "the registration existed before the amend happened" — a registration made *after* an amend already fully resolved sees only that later id's own outcome via the `already_terminal` fast path, not the full chain.

#### `POST /v1/sessions/:id/prompt/:messageId/notify`

```jsonc
{
  "callbackUrl": "https://caller.example/hooks/turn-done",
  "secret":      "<caller-chosen opaque string>"
}
```

`secret` is never interpreted by the daemon — it's echoed back only as the key for signing the delivered payload (below), so the receiver can verify a delivery genuinely came from a daemon that was given this exact secret at registration time.

**Response — turn still in flight, `202 Accepted`**

```jsonc
{ "status": "registered" }
```

**Response — turn already completed, `200 OK`.** A race is possible between the caller receiving `messageId` back from wherever it came from and this call landing — if the turn already finished, there's nothing to wait for, so this resolves synchronously instead of registering a callback for information the caller can already have:

```jsonc
{ "status": "already_terminal", "stopReason": "end_turn" }
```

**Delivery payload.** Sent as the callback `POST`'s JSON body once the messageId's turn completes:

```jsonc
{
  "sessionId":   "hydra_session_xyz",
  "messageId":   "m_abc123",
  "stopReason":  "end_turn",
  "deliveredAt": 1717012800000,
  "amendedTo":   "m_def456"   // present only if amended before completion — see below
}
```

alongside header `X-Hydra-Turn-Notify-Signature: <hex HMAC-SHA256 of the exact JSON body, keyed by the registration's secret>`.

**Errors**

- `400` — `callbackUrl` or `secret` missing, or `callbackUrl` isn't a valid absolute `http(s)` URL.
- `404` — session unknown or not warm.

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
| `usage_update` | Cost/token snapshot at turn boundary (persisted once per turn by `recordCurrentUsageSnapshot`, session.ts:1832). Cumulative running total — consumers diff successive rows to get per-turn deltas. See [Cost ledger scope](#cost-ledger-scope) for how `cost.amount` behaves across agent rotation. |
| `tool_call` | Tool call placed |
| `tool_call_update` | Tool call updated (status, args, result refs) |
| `prompt_received` | User turn boundary marker |
| `turn_complete` | Assistant turn boundary marker |
| `permission_resolved` | Permission request resolved |

Other kinds (notably `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk`, `plan`, `_hydra_current_model_update`, etc.) may exist on disk but are **not** queryable via this endpoint. Requesting one returns `400`. Rationale: chunk kinds can stream megabytes per session and need a separate pagination/byte-cap decision; state-snapshot kinds are already served via `meta.json` + attach-time synthesis.

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

**Cost attribution on `usage_update`.** Recorded `usage_update` rows carry:

```jsonc
"_meta": { "hydra-acp": {
  "upstreamSessionId": "ses_...",   // the agent session that incurred this cost
  "agentId": "opencode"             // which agent's ledger to reconcile against
} }
```

`params.sessionId` is the **hydra** session id, so without this a row says
nothing about where the spend actually went. A hydra session's upstream is not
stable — it rotates on compaction swap, `/hydra agent` switch, `/hydra restart`
and `rollbackToUpstream` — and `meta.json` retains only the *current*
`upstreamSessionId`; earlier ones are overwritten. A cost series spanning
several upstream sessions is therefore unattributable after the fact without
this stamp, and reconciling it against an agent's own ledger degenerates into
guessing which of its sessions were involved by `cwd` and time window.

`agentId` is present because it selects *which* ledger applies: a session that
switched from `opencode` to `claude-acp` has rows that must be reconciled
against different stores.

Absent on rows written by daemons predating this field; consumers must tolerate
its absence and fall back to `meta.json`'s current `upstreamSessionId`.

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

#### Cost ledger scope

`usage_update`'s `cost.amount` is a cumulative total, but the protocol does not
say *what* it accumulates over, and agents disagree:

- **Process-scoped** — the total resets to `0` when the agent process restarts.
- **Session-scoped** — the total is derived from the upstream session's own
  message history, so it survives a reload and is re-reported in full. OpenCode
  is one: its adapter sends `totalSessionCost(messages)`, a re-sum of every
  assistant message in the session.

This matters because hydra maintains a `cumulativeCost` running total across
agent lives (compaction swap, `/hydra agent` switch, `rollbackToUpstream`,
cold resurrect) and adds it to whatever the current agent reports. For a
session-scoped agent that reload re-reports history hydra already banked, and
the displayed total doubles on every rotation that reloads the session.

Hydra resolves this without needing to know the agent's flavour, by splitting
lifetime cost into two quantities and deferring the decision:

- **`cumulativeCost`** — spend on *retired* upstream sessions. The incoming
  agent has never seen these and can never report them.
- **`costAmount`** — spend on the *current* upstream session, replaced wholesale
  by each `usage_update`.

On a rotation that **reloads an existing upstream session**, `costAmount` is
retained rather than banked, and the first `cost.amount` of the new life
adjudicates (`Session.reconcileCostLedger`, session.ts):

- `incoming >= retained` — the agent's ledger survived the reload and already
  covers it; replacement alone is correct.
- `incoming < retained` — the agent restarted at `0`, so replacement would drop
  the retained spend; bank it into `cumulativeCost` first.

Rotations that spawn a **new** upstream session bank unconditionally, because
the incoming agent's ledger is unrelated to the outgoing one's.

| Flow | Upstream session | On rotation | Probe |
|------|------------------|-------------|-------|
| Cold resurrect (`session/load`) | reused | retain | armed |
| `rollbackToUpstream` | reused (**earlier** id) | bank | not armed |
| Compaction swap / `/hydra agent` | new (`session/new`) | bank | not armed |
| `/hydra restart`, `forceCancel` | new (`session/new`) | bank | not armed |
| `session import` reseed | new (`session/new`) | bank exporter's total | not armed |
| `agent sync` row, first open | reused | nothing to retain | no-op |
| Fork | new | nothing (fork resets billing) | no-op |

Import is the case most easily got wrong: the reseeded agent's ledger is
unrelated to the imported total, so arming the probe there would let the first
sizeable turn cancel the import out.

**Rollback is approximate.** It reloads an *earlier* upstream session, not the
one whose `costAmount` is being retired, so the probe cannot help — it would be
comparing against the wrong session's spend. Hydra banks and does not arm. A
session-scoped agent will then re-report the earlier session's cost, which is
already inside `cumulativeCost`, inflating the total by that amount. Making
this exact needs per-upstream-session cost tracking, which hydra does not keep.
Rollback is rare and the error is an over-count, never a loss.

**Comparing against the right quantity matters.** The probe is armed with
`costAmount` alone, never the lifetime total. A session that rotated before
being resurrected has spend the reloading agent cannot possibly report, so
comparing against the total would make the test unwinnable and double-count the
current session's portion.

##### Reading cost off disk

`meta.json` stores the split; **readers must sum `cumulativeCost + costAmount`**
to get lifetime cost. Every *wire* shape collapses them for you — `GET
/v1/sessions[/:id]` `currentUsage.costAmount`, the `usage_update` envelope's
`cost.amount`, and attach `_meta` all carry a single lifetime total with
`cumulativeCost` omitted. Only direct `meta.json` readers need to sum.

Daemons predating the split wrote the lifetime total into `costAmount` and
omitted `cumulativeCost`, so summing is correct against either layout and no
migration is required; records pick up the split the next time they are
written.

Agent authors: either scope is supported, but be consistent within an agent.
An agent whose total resets only *sometimes* on reload cannot be reconciled.

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
| `search` | `{ query, limit?, include_tool_calls? }` | Match list with snippets | Case-insensitive substring search across pre-compaction entries. Covers message text, tool arguments (including full shell commands), and recorded tool output. `include_tool_calls: false` excludes both `tool_call` and `tool_call_update` entries. |
| `range` | `{ from_entry, to_entry }` | Verbatim entries | Pull a contiguous slice of the pre-compaction log. Tool calls render with their merged arguments and an `Output:` line, under the same caps as `tool_calls`, so anything `search` can match is retrievable here. |
| `tool_calls` | `{ tool_name?, kind?, file_path?, limit?, include_output? }` | Tool-call entries | Enumerate prior tool invocations. At least one of `tool_name`, `kind`, or `file_path` is required. `tool_name` matches case-insensitively by substring; `kind` matches an ACP tool kind (`execute`, `read`, `edit`, `think`, `other`) exactly. Each entry carries `tool`, `kind`, merged `args`, `status`, and (unless `include_output: false`) `output` with `outputBytes` and `outputTruncated`. |

All three return a short "no compacted history yet" payload until the session has been compacted at least once.

**Tool-call reassembly.** A call's arguments do not arrive on the `tool_call` that opens it. Agents send a partial or empty `rawInput` up front and complete it over subsequent `tool_call_update` events, and they rewrite `title` as the call proceeds:

| Agent | Opening `tool_call` | Command arrives | Name source |
|---|---|---|---|
| claude-acp | `title: "Terminal"`, `rawInput: {}` | later updates | `_meta.claudeCode.toolName` |
| opencode | `title: "bash"`, `rawInput: { cwd }` | later updates | opening `title` |
| opencode (legacy) | `title: <command>`, `rawInput: { command }` | opening event | none sent |

Consumers must therefore merge a call with its updates (union of `rawInput`, later values winning) and resolve the name from the **opening** event only. Taking the newest `title` yields the command text in the tool name's place. `core/history-transcript.ts` exposes `mergeToolCalls` and `normalizeToolName` for this; recall, the transcript renderer, and the compaction seed all go through them. When the resolved name turns out to be an echo of an argument, the ACP `kind` is used instead, which is why `kind` is the portable filter axis and `tool_name` is not.

**Abandoned chains are closed by the daemon.** An agent that is interrupted mid-tool owes no further update for the call it dropped, so without intervention the `tool_call` stays `pending` on disk forever. When a turn ends with `stopReason` `cancelled`, `error`, or `refusal`, hydra emits a synthetic terminal update for every still-open call in that session, immediately **before** the `turn_complete` (or `_hydra_turn_ended`, for an agent-initiated turn cancelled by `session/cancel`) row:

```json
{ "sessionUpdate": "tool_call_update", "toolCallId": "…", "status": "failed",
  "_meta": { "hydra-acp": { "synthetic": true, "closedBy": "cancelled" } } }
```

`status: "failed"` because ACP's tool status vocabulary has no `cancelled`, and `failed` is what consumers already treat as terminal. `_meta["hydra-acp"].synthetic` distinguishes it from a real agent-reported failure. Two consequences: a transcript never shows a tool still running under a closed turn, and the quiesce check (which reads open chains off history and gates `/hydra workspace start|sync|clean` plus deferred compaction swaps) stops reading an interrupt as "the agent is still working". `superseded` is excluded on purpose: the agent keeps running there, with a new prompt stacked on top, and may still report those tools itself.

Recorded output is read from `rawOutput` (a string for claude-acp, `{ output, metadata }` for opencode), preferring claude-acp's structured `_meta.claudeCode.toolResponse` where present so `stderr` stays distinguishable. Blob-spilled output is already rehydrated by the history store before recall sees it. Returned output is capped per call and per response; `outputTruncated` and a top-level `outputBudgetExhausted` report when a cap bit.

Output reaches an agent only through an explicit recall call (`tool_calls`, or `range`, which opts in via `renderTranscript`'s `toolOutput` option). It is deliberately absent from the compaction seed and from synopsis input: a seeded agent has often just changed working directory, and a listing or `git status` captured before the move asserts state that no longer holds, where a command replays harmlessly. Commands are safe to push; results must be pulled.

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

### Federated ("foreign") sessions

`session/attach`, `session/detach`, `session/prompt`, and `session/cancel` addressed at a federated session id (`name:localId` — see [Remotes](#remotes) and [Sessions](#sessions)) are transparently forwarded to the peer registered under `name`, using this daemon's own stored peer credential (`daemon/acp-forward.ts`). To the peer, this looks like an ordinary client attaching over its normal `/acp` endpoint — no protocol extension is required or visible on the peer's side.

Once attached, `session/update` notifications and `hydra-acp/session/request_permission` requests the peer sends for that session are relayed back to the local client with the id re-wrapped; a `hydra-acp/session/closed` from the peer (or the peer connection dropping entirely) is relayed the same way and clears the forwarding registration.

**Multi-client fan-out.** Every local `session/attach` for a federated id opens its own dedicated upstream connection to the peer, rather than sharing one connection across every local attacher. That costs an extra WS connection per local client attached to a federated session, but it means the peer sees N genuinely independent attaching clients, exactly the shape its own multi-client attach support already handles correctly — per-attach history replay, `connectedClients` accounting, and (notably) `Session.handlePermissionRequest`'s broadcast-with-abstention race all work unmodified, because the peer, not this daemon, is doing the racing. This daemon only relays each dedicated connection's traffic to the one local target it belongs to. Re-attaching the same local connection to the same federated id replaces its prior dedicated connection (mirrors `evictPriorAttachment`'s same-connection-reattaches semantics), and detaching (explicitly, or the local WS closing) tears down only that one connection — other local clients attached to the same federated session are unaffected.

Only these four methods forward today; other session-scoped methods (`hydra-acp/attention/*`, `hydra-acp/session/tool_content`, slash commands, …) are not yet extended to federated ids.

**Model changes: two upstream verbs.** Clients may set a session's model with either `session/set_model {sessionId, modelId}` or `session/set_config_option {sessionId, configId: "model", value}` — the daemon accepts both and normalizes. Upstream, the agent may implement only one: recent `@agentclientprotocol/sdk` releases (the 0.26 line, the 1.x line) **removed `session/set_model` from the dispatch table**, so agents built on them (`pi-acp`, `claude-agent-acp` ≥ 0.66) answer `-32601 MethodNotFound` to it and accept only the config-option form, while older agents accept `session/set_model`.

No capability bit distinguishes them — `AgentCapabilities` says nothing about model selection and `PROTOCOL_VERSION` is `1` on both sides of the break. The daemon therefore **infers the verb from the shape of the agent's model advertisement**, which changed in the same SDK commit that dropped the method:

| Agent advertises models as | Verb hydra uses |
|---|---|
| `availableModels` (top level, nested under `models`, or in a foreign `_meta` namespace) / `_hydra_current_model_update` | `session/set_model` |
| `configOptions[id="model"]` on `session/new`/`session/load` / `config_option_update` | `session/set_config_option` |
| nothing yet | `session/set_model` (default) |

Inference picks the **lead** verb only. A `MethodNotFound` rejection still triggers a one-shot retry with the other verb, and whichever verb an actual call accepted is pinned for the rest of that agent process (re-inferred on agent swap, restart, and resurrect). Agents that mix the two — advertising via `configOptions` while still implementing `session/set_model` — keep working.

Transformers should declare **both** `request:session/set_model` and `request:session/set_config_option` if they care about model changes, and must tolerate seeing a rejected `session/set_model` followed by an accepted `session/set_config_option` for a single client-initiated change.

**Config options beyond model/mode.** An agent may advertise dimensions of its own — claude-agent-acp's reasoning-effort picker, a fast-mode toggle, whatever it invents — on `session/new`, `session/load`, or a later `config_option_update`. Hydra harvests every entry in the agent's `configOptions` array, not just `model`/`mode`, and re-exposes it verbatim (`id`, `name`, `description`, `category`, `currentValue`, `options`) through `session.buildConfigOptions()`, appended after hydra's own `model`/`mode`/`agent` entries. `model`, `mode`, and `agent` are reserved ids — hydra owns those three dimensions, so an agent advertising under one of those ids (e.g. its own persona picker also called `"agent"`) is not re-harvested there; it stays invisible under that id. Setting one of the pass-through ids via `session/set_config_option` forwards the request to the agent unchanged (the daemon has no idea what "effort: high" means) and applies whatever the agent's reply reports as the new state, since these agents answer the call directly rather than following up with a `config_option_update` notification.

**A setter reply is state, not news about the id you set.** Setting one option can reshape the others: claude-agent-acp rebuilds `effort` for the newly selected model (dropping the option entirely when that model has no reasoning levels, and clamping a `currentValue` the new model won't accept), and shows or hides its Fast toggle on the model's `supportsFastMode`. Its reply is the complete `configOptions` array whichever id was set, and no `config_option_update` follows — the handler applies the change directly rather than going through the path that notifies. So hydra overwrites its cached set from every reply and diffs, rather than inferring which ids the agent might have touched, and broadcasts a `config_option_update` to the other attached clients when the set actually changed (a reply reaches only the client that asked, so without that they would keep rendering the old set).

The same holds wherever hydra pushes a model at bring-up rather than at a user's request: the seed in `session/new`, and the restore on `session/load` resurrect, agent swap, and compaction rollback. Those paths drain buffered `session/update` immediately afterwards, so a notification prompted by the restore is discarded and the reply is not merely the best source but the only one.

A model switch can also invalidate the current permission mode; claude-agent-acp clamps it and emits `current_mode_update` before answering. That arrives on the notification path and is applied there, so the `mode` entry in the reply is deliberately ignored, as `model` and `agent` are.

Pruning ids absent from a reply is gated on the reply naming at least one id other than the one that was set. That is what distinguishes a full snapshot from an agent reporting back the single value it just applied; pruning on the latter would delete dimensions the agent still offers. An agent that answers with only the changed id keeps its other options, at the cost of a stale picker surviving until its next full snapshot.

The same applies to hydra's own seed at bring-up. When `--model` or `sessionDefaults[agentId].model` names a model the agent didn't start on, the reply to that seed carries the dimensions rebuilt for the model the session is actually on, and is harvested in place of the `session/new` snapshot describing the one it replaced (claude-agent-acp rebuilds its effort levels per model, and drops the option entirely for a model that has none). A seed answered via `session/set_model`, which returns no snapshot, leaves the `session/new` dimensions standing.

**`config.sessionDefaults[agentId]` seeds more than the model.** Keyed by agent id, each entry is a `configId -> value` map (`{"model": "claude-opus-4-7", "mode": "plan", "effort": "high"}`) applied once at fresh `session/new` (never on resurrect — those sessions keep whatever they last had), in a fixed order: `model` first, via the verb-inference above; `mode` next, via `session/set_mode`; then every other id, via `session/set_config_option`. The ordering isn't arbitrary — a model switch can clamp the current mode (previous paragraph) and rebuilds a model-dependent dimension like `effort` (paragraph above), so seeding either before the model settles would just be undone or resolved against a stale option list. `sessionDefaults` is a config-file / `.hydra-acp.json`-overlay concept resolved daemon-side before the request is built; it adds no new field to `session/new`'s wire params. `hydra agent set <agent> <configId> <value>` is the CLI surface for it; `hydra agent set <agent>` (no configId) instead sets the top-level `defaultAgent`.

`category` is how a client is expected to recognize what a dimension *means*, independent of its `id` or `name` — agent-shell, for instance, finds claude-agent-acp's effort picker by `category: "thought_level"` alone. The vocabulary: `model`/`mode` (hydra's own two dimensions), any reserved spec string an agent defines, an agent's own `_`-prefixed custom category, or hydra's `_hydra_*` namespace (currently just `_hydra_agent`, hydra's backend selector). An agent-advertised dimension with no `category` on the wire is surfaced as `"other"` rather than dropped.

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
| `ancillary` | `boolean` | Marks the prompt as machinery rather than a user turn. Suppresses two promotions the prompt would otherwise trigger: flipping the session's [interactivity tristate](#on-sessionlist-entries-_metahydra-acp) to `true` (which is what surfaces the session in default listings), and seeding the session title from the prompt's first line. `hydra cat` sets it on every turn it sends; transformer-driven worker prompts set it too. |
| `sentBy` | `object` | Provenance for a prompt submitted on behalf of another session or an external system. Three client-settable fields; four resolved fields are computed server-side and surface downstream on [`prompt_received`](#sessionupdate-kind-prompt_received) and [`prompt_queue/added`](#notification-hydra-acpprompt_queueadded). See [Prompt provenance](#prompt-provenance). |

#### Prompt provenance

`_meta["hydra-acp"].sentBy` lets a caller declare *who was behind* a prompt when the immediate submitter is a relay: one hydra session prompting another (`hydra cat --session <id>`), or an external system reporting in with `--from-label`. It is an attribution channel only. Nothing about it is authenticated, and it is deliberately separate from the `clientInfo` identity of the connection that delivered the prompt.

**Request fields.** A client may set exactly these three:

| Field | Type | Accepted when |
|---|---|---|
| `sessionId` | `string` | Non-empty. The hydra session id the prompt originates from. |
| `label` | `string` | Non-empty. Free-form origin tag for non-session senders (`"jenkins:build-12847"`). Truncated to 200 characters. |
| `awaiting` | `boolean` | Only literal `true` is honored; any other value is dropped. Means "the sender is blocked on this turn", and its **only** consumer is the [deadlock guard](#admission-control-session-to-session-loop-guards). It is not a request for a reply, and it is never echoed downstream. |

**Resolved fields.** The daemon computes these and they are what appears on the wire afterwards. Note the names differ from the request names:

| Field | Type | Source |
|---|---|---|
| `fromSession` | `string` | The canonicalized `sessionId`, present only if it resolves to a known session. |
| `fromSessionTitle` | `string` | Looked up from the session record. **Never client-settable.** |
| `fromLabel` | `string` | The truncated `label`. |
| `depth` | `number` | Computed from the sender's live turn state. **Never read from the client**; see [Message depth](#message-depth). |

**Validation, and what "invalid" does.** The daemon checks, in order, that `params` is an object, that `_meta` is a non-array object, that `_meta["hydra-acp"]` is a non-array object, and that `.sentBy` is a non-array object. Any failure means *no provenance*, and the prompt proceeds normally. Unrecognized keys inside `sentBy` are ignored silently.

Two discard rules worth stating outright:

- If neither `sessionId` nor `label` survives parsing, the whole object is dropped. `{ "awaiting": true }` on its own is not provenance.
- If `sessionId` is dropped as unknown while a `label` is present, the label survives on its own.

**Unknown ids drop; they do not error.** An unresolvable `sessionId` produces a daemon-log warning (`session/prompt: dropping unknown sentBy.sessionId=…`) and the prompt is still delivered, unattributed. This is deliberate: a stale `HYDRA_ACP_SESSION` should yield *no* attribution rather than a wrong one, and it must not break delivery. Fail closed on the attribution, fail open on the prompt.

**The title-seed skip keys off raw presence, not resolved provenance.** The heuristic that decides whether to seed a session title from the first prompt line runs *before* validation, so a prompt asserting a bogus session id still will not seed the title. It only needs to know that some program asserted provenance, not who.

**Trust posture.** A receiver may render attribution, and may route or filter on it. It must not treat it as authorization, identity proof, or consent. A message carrying `fromSession` cannot approve a permission request, and an agent should not change configuration because a peer asked it to.

**No capability flag advertises any of this.** Nothing was added to the `initialize` capability surface (see [Capability discovery](#capability-discovery)), so a client has no negotiated way to discover provenance support, the loop guards, or transcript windowing. Detection is behavioral: attempt it and read the error.

#### Message depth

`depth` bounds session-to-session chains. It is computed as:

```
depth = (sender session's currently-running turn depth ?? 0) + 1
```

where "currently-running turn depth" is the depth stamped on the entry the *sender* session has in flight, or undefined when the sender is not live or is not running a user-kind entry. A human-typed turn carries no depth, which reads as `0`.

| Sender state | Stamped `depth` |
|---|---|
| Mid-turn on a human-typed prompt | `1` |
| Mid-turn on a peer prompt of depth `N` | `N + 1` |
| Idle, cold, or not a live session at all (CI script, git hook) | `1` (fresh chain) |

An idle sender therefore starts a new chain rather than inheriting anything: depth only climbs when the send is genuinely *caused* by an inbound message.

The cap is `MAX_MESSAGE_DEPTH`, currently 3, which allows send → reply → follow-up. Rejection triggers at depth **greater than** the cap, so depth 3 is delivered and depth 4 is refused with an [`InvalidRequest`](#json-rpc-error-codes). Because a sender that could choose its own depth would choose `0` forever, there is no code path that parses `depth` off the request.

The cap is only evaluated when `fromSession` is present. **Label-only sends are not depth-bounded**, so the guards are not a general rate limit.

#### On `session/update` params (`_meta.hydra-acp`)

| Field | Type | Semantics |
|---|---|---|
| `recordedAt` | `number` | Epoch millis at which the daemon recorded this entry in `history.jsonl`. Present on every **recordable** `session/update`, both live and replayed, and carrying the same value in each case — a client that saw an event live and one that replays it hours later date it identically. Absent on the snapshot-shaped state kinds, which are broadcast live but never recorded (`session_info_update`, `_hydra_current_model_update`, `current_mode_update`, `available_commands_update`, `_hydra_available_modes_update`, `usage_update`, `config_option_update`, `_hydra_compaction`, `_hydra_workspace`), and on ephemeral pushes such as `client_disconnected`. Also absent on entries written by daemons predating this field; clients must fall back to time-of-receipt. |
| `seq` | `number` | Monotonic frame cursor, unique per recorded entry and strictly increasing within a session. Present on every **recordable** `session/update`, live and replayed alike, carrying the same value either way. Absent on the same state kinds and ephemeral pushes as `recordedAt`, and on daemons predating the field. Send the newest one you have processed back as [`session/attach`](#request-sessionattach)'s `afterSeq` to resume exactly. Opaque: compare for equality, or order two of them; do not do arithmetic on the difference. |

**Why `seq` exists.** `messageId` names a *message*, not a frame. Agents stamp one id across every chunk of a streamed reply, thought chunks included — a single reply routinely spans dozens of entries under one id, and one measured session used 1761 distinct ids across 2990 recorded frames, the largest covering 105 of them. That makes `afterMessageId` ambiguous in exactly the situation it is used: a client that disconnected part-way through a reply names the whole reply, and the daemon must guess whether the client has all of it or only its first chunk. Resolving to the message's last frame (what `afterMessageId` does) silently drops everything the client had not yet received — **permanently**, because the client's cursor then sits beyond the gap and no later reconnect asks for it again. Resolving to the first frame instead re-sends content the client already has, which a client that appends streamed chunks cannot detect. `seq` addresses one frame, so neither guess is needed.

**Replays never open mid-turn.** A replay slice is capped (by `historyLimit`, else the daemon's own limit), and the cut is snapped back to the nearest `prompt_received` before the slice is sent. A flat "last N entries" cut lands inside a turn almost every time, and a client receiving that turn's agent output, tool calls and `turn_complete` with no `prompt_received` ahead of them renders a turn with no prompt, which reads to a user as a prompt having gone missing. The snap is bounded, so one enormous turn cannot drag unbounded history into a replay; a single turn longer than the whole budget is the one case that still arrives headless.

**Cursor discipline.** Track the newest `seq` you have processed and send it as `afterSeq`. Replay coalescing folds a run of same-kind chunks into one entry; that merged entry carries the `seq` of the **last** raw frame folded into it, so a client that stores the coalesced entry's cursor is correctly treated as having the whole run. Sending both `afterSeq` and `afterMessageId` is fine and recommended for clients that must also work against older daemons — the daemon prefers `afterSeq` when present. An unrecognised `seq` (compacted out of `history.jsonl`, or invented) falls back to `full`, reported in the response's `historyPolicy`.

**Why it exists.** Replay is otherwise undatable. A client that attaches to an existing session receives the whole history through the same notification channel as live traffic (by design — see [`session/attach`](#request-sessionattach)), with nothing distinguishing the two. Without `recordedAt`, the only clock available is time-of-receipt, so every replayed `tool_call` appears to have started the instant the client attached, and elapsed-time rendering reads `0s` for work that ran hours ago. `_meta["hydra-acp"].turnStartedAt` on the attach response fixes this at *turn* granularity only; `recordedAt` generalizes it to every event.

**Entry-scoped, not tool-scoped.** The field dates the history entry, so it is meaningful for any `sessionUpdate` kind. Deriving a tool call's duration is one application: take `recordedAt` from the `tool_call` for the start, and from the call's terminal `tool_call_update` for the end. Replay coalescing preserves both — the initial `tool_call` survives intact, and per `toolCallId` only the **last** `tool_call_update` is emitted, so its `recordedAt` is the completion time.

**Clock domain.** `recordedAt` is the *daemon's* wall clock, while a client's own receipt timestamps are local. Differencing the two across a remote daemon will show clock skew (and can go negative). Prefer differencing two `recordedAt` values against each other. This matches the existing exposure of `turnStartedAt` and `enqueuedAt`.

**Relationship to REST.** The same underlying value is served as `ts` by [`GET /v1/sessions/:id/events`](#get-v1sessionsidevents) and [`GET /v1/sessions/events`](#get-v1sessionsevents), where it is rendered as an ISO-8601 string. On the wire it is epoch millis, consistent with `turnStartedAt` and `enqueuedAt`.

> Transformers observing a `response:session/update` intercept see the payload **before** this stamp is applied, and a transformer that supplies its own `recordedAt` has it preserved rather than overwritten.

#### On `session/new` params (`_meta.hydra-acp`)

The ACP spec `NewSessionRequest` carries only `cwd` and `mcpServers`. Everything hydra-specific — including **agent selection** — rides under `_meta["hydra-acp"]`; hydra emits **no** non-spec fields at the top level of `session/new`.

| Field | Type | Semantics |
|---|---|---|
| `agentId` | `string` | Which registry agent to spawn the session on. When omitted, resolves a `.hydra-acp.json` overlay for `cwd` (nearest `defaultAgent` between `cwd` and `$HOME`) before falling back to `config.defaultAgent`. This is the only channel for agent selection — there is no top-level `agentId` param. Enumerate valid ids via [`hydra-acp/agents/list`](#hydra-acplist_agents) or REST `GET /v1/agents`. |
| `title` | `string` | Session label (`Session.title`). Surfaces in `session/list`, the picker, slack-bridge thread titles. First write wins; replaced by the first user prompt unless the *original* upstream agent has emitted its own `session_info_update`. Once the upstream has been respawned (compaction, `/hydra agent`, workspace move, rollback, crash reload), the respawned agent's own `session_info_update` no longer overrides the title, it only wins the very first race at session start. |
| `agentArgs` | `string[]` | Forwarded to the underlying agent's command line. Stored in the resume hints so a resurrected session re-spawns the agent with the same args. |
| `transformers` | `string[]` | Names of transformers to attach to the session chain. Resolves to live connections at session-creation time; missing names are silently skipped (fail-open). Falls back to `config.defaultTransformers`. |
| `model` | `string` | One-shot model id applied via `session/set_model` at agent bootstrap. Ignored on resurrect. |
| `mcpStdin` | `boolean` | Allocate a `SessionStreamBuffer` and inject a `hydra-acp-stdin` HTTP MCP descriptor into the agent's `mcpServers`. Used by `hydra cat --stream`. |
| `interactive` | `boolean` | Initial value for the session's interactivity tristate. `cat` sets `false`; everything else leaves it undefined so the first user prompt promotes it to `true`. |
| `resume` | `SessionResumeHints` | `{ upstreamSessionId, agentId, cwd, title?, agentArgs? }` — populated by the shim's reconnect path so the daemon can resurrect the session against the right agent. **Advisory, not authoritative**: see [Stale resume hints](#stale-resume-hints). |
| `workspace` | `WorkspaceRequest` | Run this session in an isolated workspace instead of directly in `cwd`. See [Workspace isolation](#workspace-isolation). |

### Stale resume hints

`resume` hints exist for one case: the daemon rotated a session's upstream
and was killed before persisting it. There the reconnecting client's view
genuinely is fresher than the record, so its `upstreamSessionId` and
`agentId` override what's on disk.

They do **not** override a rotation the daemon completed. Compaction, agent
switch and workspace enter/leave all mint a new upstream, and no wire event
tells an attached client its cached id has changed — so a client that
reconnects after one still offers the pre-rotation id. Honoring it would
resurrect the session on the old upstream and then hand that id back in the
attach response, leaving client and daemon agreed on a session the daemon
had deliberately left. A compaction "reverted" this way is
indistinguishable from a deliberate rollback except that it emits no
`compaction_phase: rolled_back` and leaves nothing to repair from.

So the daemon checks each hint against the session record's
`upstreamGenerations` chain:

- id **is** the record's current upstream → honored.
- id **absent** from the chain → honored. This is the crash-before-flush
  case; the client knows something disk doesn't.
- id **present but not current** → **ignored**, and the record wins for
  every identity field. Such an id names a generation the session
  demonstrably left, which means disk knows about a rotation the hint
  predates.

Only provable staleness costs a hint its authority; an unrecognized id is
still trusted. A dropped hint is logged at `warn` (`session/attach ignoring
stale resume hint …`) and is otherwise invisible to the client — the attach
succeeds, on the correct upstream.

Clients holding a cached `upstreamSessionId` should refresh it from the
`_meta["hydra-acp"].upstreamSessionId` that rides every `usage_update`,
rather than relying on this guard.

### Workspace isolation

Two sessions opened against the same directory edit the same files. A session
can instead be given its own **workspace**: a separate materialization of the
project, so concurrent sessions cannot collide.

Request it on `session/new` under `_meta["hydra-acp"].workspace` (it cannot be a
top-level field, per the no-non-spec-fields rule above):

```jsonc
{
  "label":    "feature-x",  // optional; generated when omitted
  "from":     "<snapshot>", // optional; OPAQUE provider token, never constructed by hand
  "required": false,        // optional; see below
  "provider": "git"         // optional; defaults to git
}
```

**The session's effective `cwd` becomes the workspace path.** `cwd` in the
request names the tree to derive *from*; `cwd` in every response and in
`session/list` is where the agent actually runs. Relative paths therefore
resolve inside the workspace, and so do the working directories of any commands
the agent spawns.

Responses carry `_meta["hydra-acp"].workspaceInfo` (named differently from the
request field, which has a different shape):

```jsonc
{
  "path":      "/home/u/.hydra-acp/workspaces/ab12cd34/feature-x",
  "sourceCwd": "/home/u/proj",
  "label":     "feature-x",
  "provider":  "git",
  "snapshot":  "<opaque>",
  "vcs":       { "kind": "git", "branch": "hydra/feature-x" },
  "clean":     true
}
```

`sourceCwd` is the load-bearing field. A workspace lives **outside** its source
tree and shares no path prefix with it, so this recorded edge is the only way to
map a session back to the project it belongs to. Consumers that group, label, or
attribute per directory should use `workspaceInfo.sourceCwd ?? cwd`; anything
relating the two by string prefix is wrong. `vcs` is provider-specific and may
be absent entirely (a non-VCS provider has no branch), so readers must tolerate
that rather than depend on it. `snapshot` is opaque: never parse it, and never
assume it is a hash.

`clean` is present and `true` when no uncommitted work was copied in, so the
workspace's landing anchor is a plain base commit rather than a snapshot of the
source's working state. It is set by `workspace start --clean`, by any start over
an already-clean source, by `workspace clean`, and on every workspace created at
`session/new` (that path never copies uncommitted work). Clients need it to
explain a landing conflict correctly: on a clean workspace the source's *entire*
working state is being replayed for the first time, whereas otherwise an overlap
means two edits to the same lines.

**Nested trees.** A workspace populates its submodules on creation, so an agent
never meets an empty submodule directory, and work inside a submodule is carried
in and landed back like any other work. This needs handling that the superproject
cannot express: a superproject snapshot records a submodule as a *gitlink*, never
as content, so uncommitted work inside one is invisible to it while still showing
in its status as a single modified path. A worktree's submodules also get their
own object store, so commits that exist only in the source's copy are unreachable
from the workspace's until fetched. Clients should not attempt to reconstruct
submodule state from a session's superproject diff.

**Failure is open by default.** A directory that is not a repository, a
repository with no commits, or a missing provider all fall back to running in
the source tree. The reason comes back as `_meta["hydra-acp"].workspaceError`,
so **`workspaceInfo` absent together with `workspaceError` present** is the case
a client must surface: isolation was requested and did not happen. That field is
live-only (it describes a creation attempt, not durable state) and never appears
on cold entries. Set `required: true` to make session creation fail instead. That matters for a
caller running several agents against one tree: a silent fallback puts them all
back in the same directory, which is the failure isolation exists to prevent,
reached quietly.

**Isolation belongs to the session, not the client.** A client-side mode (e.g.
`hydra tui --workspace`) sets this field on every `session/new` it issues; the
daemon holds no notion of "workspace mode". Attaching does not change an
existing session's isolation, and cannot: several clients may share a session,
and a live agent's working directory was fixed when its process started.
A **fork** of an isolated session is always isolated, deriving its own workspace
from the parent's, because a fork otherwise inherits its parent's `cwd` and
would land in the parent's workspace.

**Lifecycle.** Workspaces are removed when their session's record is deleted,
but only when nothing would be lost: a workspace holding uncommitted changes is
kept and reported instead. Branches are never deleted, which is what lets a
workspace whose directory has since vanished be rebuilt with its committed work
intact when the session is resurrected. If it cannot be rebuilt, the session
resurrects in a fresh workspace from the same source tree rather than in the
user's checkout. Providers that retain nothing outside the directory report
this through their capabilities rather than pretending to recover.

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
| `agentPid` | `number` | Present only while an agent process is live for the session; absent on cold sessions. OS pid of the agent child. **Diagnostic only.** It exists so a *local* client can sample the agent's resource usage (memory/CPU of its process tree) — the agent is a child of the daemon, so a client has no other way to locate it. Two caveats: it is meaningless to a client on another host, since it indexes the daemon machine's process table and may collide with an unrelated local pid there; and clients must not signal it — the daemon owns process lifecycle and signals the whole process group (`Session.kill`). It changes across an agent swap or crash-restart, so callers that care should re-read rather than cache it for the session's lifetime. |
| `cwd` | `string` | Effective working directory. For an isolated session this is the **workspace** path, not the tree it was derived from; see `workspaceInfo`. |
| `workspaceInfo` | `object?` | Present only for a session running in an isolated workspace: `{ path, sourceCwd, label, provider, snapshot?, vcs? }`. Group and attribute on `workspaceInfo.sourceCwd ?? cwd`. See [Workspace isolation](#workspace-isolation). |
| `workspaceError` | `string?` | Present when isolation was requested and fell back to the source tree. Live-only. Absent `workspaceInfo` **plus** this field is "you asked and did not get it". |
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
| `availableModels` | `{modelId, name?, description?}[]?` | Models the agent will accept on `session/set_model` (or, for SDK 0.26+ agents, `session/set_config_option` with `configId: "model"` — see [ACP wire protocol](#acp-wire-protocol)). |
| `turnStartedAt` | `number?` (epoch ms) | Present only when an agent turn is in flight at response time. Lets a fresh client paint the busy indicator with the right elapsed time. |
| `agentCapabilities` | `object?` | The underlying agent's own initialize-time capability claim, forwarded verbatim. |
| `queue` | `PromptQueueEntry[]?` | Snapshot of the daemon-side queue at attach time, so late-joining clients can paint chips without waiting for new `prompt_queue_added` notifications. Omitted when empty. |
| `mcpStdin` | `boolean?` | Echoed when stdin streaming was wired up. |
| `clientId` | `string?` | The per-attachment client id bound to this connection. **Present in `_meta` only on `session/new` and `session/load`** — those are core ACP spec methods, so the id can't ride at the top level. On the RFD-track `session/attach` response, `clientId` is a top-level field instead (per that method's surface). Lets deferred-echo clients recognize their own `prompt_queue_added` broadcasts. |

> Capability flags (the `prompt.*` and `agents.*` groups) are daemon-wide and ride on the **`initialize`** response's `_meta["hydra-acp"]`, not per-session — see [Capability discovery](#capability-discovery).

> Spec-compliance note: `session/new` and `session/load` are core ACP methods, so their results carry only the spec fields (`sessionId`, `modes?`, `models?`) at the top level — every hydra-specific field, including `clientId`, rides under `_meta["hydra-acp"]`. `session/attach`/`session/detach` are RFD-track methods: only **RFD #533's own** fields sit at the top level (request: `sessionId`, `historyPolicy`, `afterMessageId`, `afterSeq`, `clientId`, `clientInfo`; response: `sessionId`, `clientId`, `connectedClients`, `historyPolicy`, `replayed`). Hydra's *own* additions on top of the RFD ride under `_meta["hydra-acp"]`: request `readonly`/`replayMode`/`dripSpeed`/`toolContent`/`historyLimit`, and the `session/detach` response `detachStatus`.

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
      "agentPid": 51234,        // live sessions only; diagnostic, local clients only — see field table

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
| `historyLimit` | `number` | Opt-in override for how many history entries the replay may carry. Absent means the daemon's own cap. **`0` means no cap** and should be sent only for a deliberate user action (a "load full history" control), since an unbounded replay of a long session is a large payload. Whatever the value, the replay is still snapped back to a turn boundary, so it never opens part-way through a turn. |
| `dripSpeed` | `number` | Multiplier on the inter-entry gaps in drip mode (>1 faster, <1 slower). Default 1. |

The `session/detach` response carries the detach outcome under `_meta["hydra-acp"].detachStatus` (`"detached"`), alongside the top-level `sessionId`.

### Prompt-queue surface

The daemon owns a per-session prompt queue. Clients submit prompts via standard `session/prompt`; everything mutating the queue afterwards goes through the Hydra methods below. Peer clients stay in sync via the `hydra-acp/prompt_queue_*` notifications.

#### Admission control: session-to-session loop guards

Two guards run in the `session/prompt` handler **before enqueue**, and only for prompts carrying a resolved `fromSession` (see [Prompt provenance](#prompt-provenance)). Both reject with `-32600 InvalidRequest`. Neither applies to label-only sends.

**Depth cap.** A prompt whose computed [`depth`](#message-depth) exceeds `MAX_MESSAGE_DEPTH` (3 today) is refused:

```
message chain too deep (${depth} hops, max ${MAX_MESSAGE_DEPTH}): refusing to continue a session-to-session loop
```

Both numbers are interpolated. `${depth}` is the computed, rejected value, so the smallest ever seen is `4 hops`.

**Deadlock guard.** When a prompt asserts `sentBy.awaiting === true` alongside a resolved `fromSession`, the daemon records an edge `fromSession → targetSessionId` immediately before awaiting the prompt, and releases it in a `finally` around that await. The edge therefore lives exactly as long as the sender is blocked, and is released on error and on cancellation as well as on normal completion.

A blocking send is refused when the target already reaches the sender through live edges, transitively (the graph walk is cycle-safe, so unrelated cycles elsewhere do not wedge the check), or in the degenerate `from === to` case:

```
would deadlock: ${targetSessionId} is already blocked waiting on ${senderSessionId}. Send with --no-wait, or let the other turn finish first.
```

What stays **allowed** is the point of the design:

- Every fire-and-forget send (`awaiting` absent or not `true`), *including one that closes a cycle*, because nobody is waiting on it.
- A self-send that is fire-and-forget. This is how a session queues itself a follow-up turn.
- A second blocking send in the same direction as an existing edge.

Only the combination that would actually hang is rejected.

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

#### Request: `_session/steering`

Mid-turn steering: redirect the agent while it's still working, instead of
queuing behind the current turn. This is a **pre-standard extension**, not
core ACP — the real spec proposal
([agent-client-protocol#1261](https://github.com/agentclientprotocol/agent-client-protocol/pull/1261))
is still open. claude-agent-acp and codex-acp both already ship it; hydra
proxies it rather than defining its own shape, so this is the union of
both adapters':

```jsonc
// params
{
  "sessionId": "<id>",
  "prompt":    [ /* ACP prompt array */ ],
  "_meta": {                                  // optional
    "steering": { "idleBehavior": "promptRequired" }  // optional; see below
  }
}
// result
{
  "outcome":  "injected" | "startedNewTurn" | "promptRequired" | "failed",
  "reason":   "noRunningTurn",  // present only with outcome "promptRequired"
  "detached": true              // optional; only with outcome "startedNewTurn"
}
```

**Turn accounting for `"startedNewTurn"`.** The response carries an
outcome, never a `stopReason`, so a client that tracks whether the session
is busy cannot settle this turn from the reply. Two rules make that
tractable, and both matter to any client that counts turns:

- Without `detached`, the turn is one hydra enqueued on the client's
  behalf. Hydra therefore **includes the originator** in that turn's
  `turn_complete` broadcast — unlike a `session/prompt` turn, where the
  originator is excluded because its own response carries the outcome.
  This is the same rule amend-originated entries follow, and for the same
  reason: the wire `turn_complete` is the only turn-end signal the sender
  will ever receive.
- With `"detached": true`, the agent's own turn had already settled and
  the work was picked up by hydra's unsolicited-turn machinery, which
  emits its own `_hydra_turn_started` / `_hydra_turn_ended` pair. A client
  that counts turns must **not** count this outcome as well, or it books
  one turn twice and the surplus never comes back down.

Hydra advertises `_meta.steering.supported: true` **unconditionally** on
`initialize` — as a sibling of `_meta["hydra-acp"]`, the same place the
underlying agents put it, so a client written against either adapter's
own extension recognizes hydra's advertisement without translation. This
is deliberately the same pattern as `agentCapabilities.auth.logout`
(advertised before any agent is chosen, resolved per-session at call
time) — but for steering it's not just optimistic, it's always true:
hydra always has a working path, described below.

**Dispatch rule.** Forwarding this verbatim to the underlying agent
regardless of session state is dangerous: steering an *idle* session
makes the agent start a turn hydra never asked for, with no
`_claude/origin` stamp to close it, and (codex-acp has no opt-out) no way
to prevent it. So hydra forwards natively **only** when a turn is already
in flight *and* the live agent advertised native support (captured from
its own `initialize._meta.steering.supported`) — in that case the steer
rides as a second concurrent request into a turn hydra is already
tracking normally, so nothing new needs closing. Every other case — idle,
or an agent that doesn't support the extension — is handled entirely by
hydra itself:

- **Turn in flight, agent doesn't support it:** cancel the running turn
  and splice the steer content in as the next one to run, via the same
  machinery `hydra-acp/prompt/amend` uses on the current head.
- **Idle:** treated as an ordinary new prompt (`session/prompt`), unless
  the request explicitly set `_meta.steering.idleBehavior: "promptRequired"`,
  in which case hydra returns `{"outcome": "promptRequired", "reason": "noRunningTurn"}`
  and consumes nothing, mirroring claude-agent-acp's own opt-out.

Both hydra-synthesized fallback paths report `"outcome": "startedNewTurn"`
— honestly, since the steer content starts a genuinely new turn in both
cases rather than joining one in progress. `"injected"` and `"failed"`
only ever come back verbatim from a native agent's own reply.

A landed steer that joins the running turn (`outcome: "injected"`) is
recorded as a `user_message_chunk`, never as `prompt_received` itself —
the turn boundary didn't move, so announcing a new one would misinform
every other attached client. Stamped `_meta.hydra-acp.steered: true`,
deliberately **not** the `compatFor: "prompt_received"` shape used
elsewhere: that stamp means "duplicates a `prompt_received` that also
went out", which is what `mapUserText` and history search key off to
drop it as a redundant echo. No `prompt_received` ever accompanies a
steer, so reusing that stamp made this the only record of the steer and
then discarded it in both readers.

**Narrow race, now closed.** hydra checks for an in-flight turn, decides
to forward natively, but the agent's own turn can settle in the gap
before it processes the steer — the agent then replies
`"startedNewTurn"` on its own initiative, detaching a fresh turn instead
of injecting. That detached turn's content is user-lane (`kind: "human"`
on its terminal `usage_update`), which the generic unsolicited-turn
close never treats as an ending signal, so left alone this would read
BUSY forever. Hydra tracks the possibility from just before it sends
the native-forward request (a notification for the detached turn can
arrive before the reply does) and marks whichever unsolicited turn opens
next as caused by this steer specifically. A `usage_update` closes that
one turn regardless of lane — hydra already knows no other prompt is in
flight, so it can only be this turn ending, not an unrelated user turn's
terminal racing in from outside. Every other unsolicited turn (a
genuine agent-initiated resumption) still requires an autonomous
`_claude/origin` kind to close, unchanged.

That tracking carries the messageId it was armed against, because the
detached turn can also live and die entirely before hydra's own
`session/prompt` for the turn it thought was running resolves. While
that entry is still current the daemon folds the detached turn's output
into it rather than opening an unsolicited turn, so nothing consumes
the arm — and an arm left set would mark some unrelated agent-initiated
turn minutes later, whose ordinary human-lane terminal would then end it
early and report the session idle while the agent was still working. A
`usage_update` folded away while the armed entry is still current is
that case, and retires the arm.

#### Notification: `hydra-acp/prompt_queue/added`

Daemon → every attached client. Fires when a new prompt is enqueued (including new turns from any client).

```jsonc
{
  "sessionId":  "<id>",
  "messageId":  "<id>",
  "originator": {
    "clientId":         "cli_nHgsTbx5",    // always
    "name":             "hydra-acp-cat",   // when the connection supplied clientInfo
    "version":          "0.1.145",         // when the connection supplied clientInfo
    "fromSession":      "hydra_session_…", // optional; resolved provenance
    "fromSessionTitle": "fix flaky test",  // optional; resolved provenance
    "fromLabel":        "jenkins:12847",   // optional; resolved provenance
    "depth":            1                  // optional; resolved provenance
  },
  "prompt":     [ /* ACP prompt array */ ],
  "position":   0,    // 0 = head/in-flight; N = number of entries already ahead
  "queueDepth": 1,
  "enqueuedAt": 1717012800000
}
```

`originator` is a raw pass-through of the queue entry, so the four [resolved provenance fields](#prompt-provenance) ride here verbatim under the same presence rules as on [`prompt_received`](#sessionupdate-kind-prompt_received). The three original keys are unchanged in name, type and presence; the addition is purely additive.

This is the **accept-time** provenance signal. `prompt_received` carries the same content but fires later, when the entry becomes the active turn.

> Naming asymmetry, predating cross-session messaging but easy to trip on: `prompt_queue/added` calls this object `originator`, while `prompt_received` calls it `sentBy`. Same content, different key.

#### `session/update` kind: `prompt_received`

The user-turn boundary marker. Recorded and broadcast when a queue entry **becomes the active turn**, not when it was accepted, and broadcast to attached clients **excluding the originating connection**, so a sender never sees its own provenance echoed back on this channel.

```jsonc
{
  "sessionUpdate": "prompt_received",
  "sentBy": {
    "clientId":         "cli_nHgsTbx5",
    "name":             "hydra-acp-cat",
    "version":          "0.1.145",
    "fromSession":      "hydra_session_…",
    "fromSessionTitle": "fix flaky test",
    "fromLabel":        "jenkins:12847",
    "depth":            1
  }
}
```

| Field | Presence |
|---|---|
| `clientId` | Always. |
| `name`, `version` | When the connection supplied `clientInfo`. |
| `fromSession` | Iff a valid session id was asserted and resolved. |
| `fromSessionTitle` | Iff `fromSession` is present and that session has a non-empty title. |
| `fromLabel` | Iff a non-empty `label` was asserted. |
| `depth` | Iff `fromSession` is present. |

`name` and `fromSession` answer different questions and both can be present: `name` is *which program delivered it* (`hydra-acp-cat`), `fromSession` is *who was behind it*. The request-only `awaiting` flag appears here in neither form; it is consumed by the [deadlock guard](#admission-control-session-to-session-loop-guards) at admission time and never stored on the entry.

**Persistence and replay.** `prompt_received` is written to `history.jsonl` with the resolved `sentBy` intact, so provenance survives a daemon restart. It is re-emitted on `session/attach` subject to `historyPolicy` (`full` replays it; `pending_only` only while that turn is still pending; `none` not at all). It is also in the [`/events` kind allowlist](#get-v1sessionsidevents), where the row's `update` field is a raw pass-through, so `sentBy` appears verbatim there with no field projection.

See [Prompt provenance](#prompt-provenance) for the trust posture: attribution, never authorization.

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

#### Notifications: `hydra-acp/prompt_queue/held` and `.../released`

Fire around a user entry that reached the head of the queue but was not
promoted, because the agent is mid-way through an [agent-initiated
turn](#agent-initiated-turns). Dispatching onto a running agent is what
produces interleaved answers and prompts that never appear to finish, so the
daemon waits for it to settle first.

```jsonc
// held
{
  "sessionId":  "<id>",
  "messageId":  "<id>",
  "reason":     "agent_resumed",
  "cause":      { "toolCallId": "toolu_…", "label": "gibbon rebuild" }  // optional
}

// released
{
  "sessionId": "<id>",
  "messageId": "<id>",
  "reason":    "turn_ended" | "cancelled" | "closing",
  "heldMs":    3200
}
```

- `turn_ended`: the agent-initiated turn closed. The normal exit, and the
  only one that means the prompt is about to be dispatched.
- `cancelled` / `closing`: the entry or the session went away.

**The hold has no upper bound.** It ends when the turn ends, which the agent
reports (see [agent-initiated turns](#agent-initiated-turns)). Two earlier
exits, a 45s `quiet` guess and a 180s `cap`, have been removed. The cap was
actively harmful: it dispatched a prompt into a turn that was demonstrably
still running, the agent folded that prompt into the running turn and never
returned its `session/prompt` response, and the session reported BUSY for 12
minutes until the user killed the agent by hand.

An agent that never reports the end of a turn it started therefore holds the
prompt indefinitely. That is the intended failure: the entry stays in the
queue and stays cancellable, `session/cancel` closes the turn and releases it,
and the alternative is the response-losing collision above.

A `held` is always followed by exactly one `released`. `released` does **not**
mean the entry started: `removed{started}` still follows separately, and a
`cancelled` release means it never ran at all.

The entry stays **in** the queue while held, so `hydra-acp/prompt/cancel` and
amends work on it normally. Clients should render it as still-queued with the
hold reason attached, not as an active turn.

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

### Agent-initiated turns

ACP models a turn as a request and a response: the client sends
`session/prompt`, and the response means the turn is over. Some agents do not
honour that.

Claude Code (via `claude-acp`) restarts itself when a background task
finishes. If the model ends its turn while a `Monitor` or a
`Bash`-with-`run_in_background` is still outstanding, the harness later
injects a synthetic `<task-notification>` user message and runs **a whole new
turn that no `session/prompt` asked for**. There is no ACP notification for
"I am starting a turn you did not request", so the adapter sends none: it
streams `session/update` notifications with no request behind them, and emits
no `turn_complete` when that turn ends either.

Left alone this makes a session report itself idle while the agent works, so
the next prompt gets dispatched on top of a running agent and the two
responses interleave. Hydra therefore infers the turn. Turn content arriving
with no prompt in flight is already a protocol violation, which makes the
inference sound: a conforming agent can never trigger it.

**`_hydra_turn_started`** — hydra opens a synthetic turn:

```jsonc
{
  "sessionId": "hydra_session_…",
  "update": {
    "sessionUpdate": "_hydra_turn_started",
    "messageId": "m_…",
    "_meta": { "hydra-acp": {
      "unsolicited": true,
      // Best-effort: the background task we believe woke the agent, if one
      // was seen being armed. Absent when unknown.
      "cause": { "toolCallId": "toolu_…", "label": "gibbon rebuild" }
    } }
  }
}
```

**`_hydra_turn_ended`** — hydra closes it:

```jsonc
{
  "sessionId": "hydra_session_…",
  "update": {
    "sessionUpdate": "_hydra_turn_ended",
    "messageId": "m_…",
    "startedMessageId": "m_…",   // the _hydra_turn_started this closes
    "durationMs": 2100,
    "_meta": { "hydra-acp": {
      "unsolicited": true,
      // completed  — the agent reported the turn finished (the normal case)
      // cancelled  — session/cancel ended it
      // superseded — a prompt took over without waiting on the hold
      // closed     — the session shut down
      "reason": "completed"
    } }
  }
}
```

**These are not `turn_complete`.** Clients pair `turn_complete` against a
prompt they saw start; handing them an unmatched one would corrupt their
pending-turn accounting. Both kinds are additive, so a client that does not
know them ignores them (`render-update` maps unknown `sessionUpdate` values to
a no-op) and is unaffected. Aware clients should treat the pair as a turn
boundary and may label it with `cause`.

**The close is observed, not guessed.** `claude-acp` emits a `usage_update` at
every SDK `result` and stamps it with the lane that produced it:

```jsonc
{ "sessionUpdate": "usage_update", "used": 421066,
  "_meta": { "_claude/origin": { "kind": "task-notification" } } }
```

`kind` in `{task-notification, peer, coordinator, observer,
observer-activity}` means the model finished something it started on its own,
so that notification **is** the end of the agent-initiated turn, timed exactly
and naming why it began. `kind: "human"` rides the same carrier for the user's
own turns and must never be read as one. Mirrors `AUTONOMOUS_RESULT_ORIGINS`
in `claude-agent-acp`; an unknown kind is treated as the user lane, matching
that adapter's own fail-open default.

Note that `usage_update` is a state-kind and so is **not** written to
`history.jsonl`. It is broadcast to attached clients, which is where this
signal is observable.

This replaced a 90-second silence deadline, and there is deliberately **no
timer fallback**. Measured live: the signal lands within ~2s of the agent
actually finishing, while the deadline held a session BUSY for 89 further
seconds — a turn recorded as 93.0s whose real work took 3.5s. An agent that
starts turns without reporting their end leaves the turn open until it is
cancelled, which is the honest outcome; inventing a duration for it is what
produced the "random turn end/starts" this section used to describe.

Empirically this path is `claude-acp`-only: across 1291 recorded sessions,
agent-initiated turns appear in 6, all of them `claude-acp`. `opencode` has
produced none in 615 sessions.

**Salvage: when the terminal arrives for a turn that was superseded.** If a
prompt takes over an agent-initiated turn that is still running, the agent
owes exactly one SDK `result` covering both, and stamps it with the lane that
*started* the work. It therefore arrives as an autonomous terminal, not as the
`session/prompt` response, and the prompt is never answered: the session reads
`busy` until a human cancels. Observed live at 2m 08s of dead air after the
agent had streamed its complete final answer.

Hydra settles the parked `session/prompt` itself in that case, with
`stopReason: "end_turn"` plus a marker naming what happened:

```jsonc
{ "stopReason": "end_turn",
  "_meta": { "hydra-acp": { "salvaged": {
    "reason": "autonomous_terminal",
    "supersededMessageId": "m_wzEBMNkrutPIraSA" } } } }
```

The same `salvaged` block is attached to the resulting `turn_complete`, which
**is** written to `history.jsonl` — so a salvage is diagnosable after the
fact even though the `usage_update` that triggered it is not recorded.
Clients need do nothing with it; the turn is over either way.

This is not a timer. It settles on a signal the agent genuinely sent and
hydra previously discarded, so the no-fallback stance above still holds. It
is armed only for a turn that actually superseded a running agent-initiated
one, and only within that drain pass: an agent that legitimately runs a peer
or subagent lane alongside a user prompt also emits autonomous terminals, and
ending the user's turn on one of those would be worse than the wedge.

**Gating.** Detection is armed only after the session's first `turn_complete`,
since the failure mode is the agent *resuming* after a turn ended. While an
unsolicited turn is open the session reports `busy` in the REST session list,
`turnStartedAt` is set, `isQuiescedForSwap` returns false so a compaction swap
cannot pull the upstream out from under a working agent, and a user prompt
reaching the head of the queue is held rather than dispatched. See
[`prompt_queue/held`](#notifications-hydra-acpprompt_queueheld-and-released).

**Armed tasks (the third session state).** A session that has handed the
turn back but still has a background watch pending is neither "working" nor
"done": it is idle right now and can restart itself with no prompt. Session
list entries therefore carry `armedTasks`, a count of background tasks the
agent armed and has not yet been seen to wake up for. A nonzero count
renders as `BUSY` in `hydra session list` and the TUI picker even with no
turn in flight, since the session is not finished with you. Note this makes
`BUSY` in the STATE cell weaker than the `busy` field: a prompt sent to an
armed-but-idle session is dispatched immediately rather than queued. Clients
that need the distinction should read `busy` and `armedTasks` separately.

**A one-shot armed task also blocks `isQuiescedForSwap`.** A compaction
swap (or any upstream rotation: `/hydra agent`, `/hydra restart`, workspace
move) kills the old agent process outright, and a background job it owned
dies with it: nothing downstream can wake for it afterward. `quiesceBlocker`
therefore treats a confidently one-shot armed task (a backgrounded `Bash`;
level-sourced `taskType: "local_bash"`) as a blocker, the same as an open
tool-call chain, and a parked swap retries once the task discharges.
Deliberately narrower than the `armedTasks` display count: a **repeating**
watch (`Monitor`) never discharges on its own, so gating on one would stall
compaction forever, defeating the reason it exists. An unrecognized
level-sourced `taskType` fails open (does not block) for the same reason:
today only `"local_bash"` is verified one-shot. A swap that still had to
abandon work (a leaked entry, or a genuinely repeating watch) is reported
after the fact via the `"Stopped N background task(s) with the previous
agent"` notice rather than blocked on.

**Two sources, and which one you get.** The count is derived either from a
**level** signal published by the agent, or, when the agent does not publish
one, from **edge inference** by the daemon. The level is authoritative and
takes over permanently for a session's agent process the moment its first
payload lands. Everything from here to the end of the edge-inference
subsection describes the fallback; skip it for a `claude-acp` session.

### Level source (`claude-acp`)

`claude-acp` forwards its SDK's `background_tasks_changed` message: the
**complete live set** after every membership change, with REPLACE semantics.
The daemon subscribes to that one subtype by asking for it in
`_meta.claudeCode.emitRawSDKMessages` (a filter list, not a boolean, so the
raw-SDK firehose stays off), and receives it as an `extNotification` on
method `_claude/sdkMessage`. Each payload entry carries `task_id`,
`task_type` and `description`.

The request rides **both `session/new` and `session/load`**, from one
builder, and the agent honours it on both. A resurrect that dropped it would
come back permanently blind to endings and fall back to edge inference,
silently, so it is pinned by test on both verbs.

This is the only source that can report that a task **ended**: absence from
a payload is the ending. Measured live, an exit lands within ~10ms of the
process actually exiting, and it arrives whether or not a turn is running.

Consequences for clients:

- `armedTasks` and `armedSince` are accurate rather than best-effort, and
  can go **down** without any turn boundary.
- `armedSince` is the daemon's first sighting of the id, not the agent's
  start time; the payload carries no start time. The gap is the level's
  delivery latency (milliseconds).
- Level-sourced entries in `tasks[]` have **no `toolCallId`** and carry
  `taskType` instead. The SDK states the payload has no attribution and must
  not be correlated with the edge stream, so the daemon does not join them.
  Treat `toolCallId` as optional on every entry.
- The level is **per process**: nothing is emitted at agent startup. The
  daemon resets to the empty set on every agent (re)start and waits for the
  next membership change. A session that resurrects while a job is running
  therefore understates until something changes, which is the opposite of
  the edge path's failure direction.

### Edge inference (every other agent)

The count is **best-effort and must not be relied on**, and it errs toward
overstating. A single notification can batch several tasks while only one gets
attributed to the resulting turn. Notification delivery also waits for a turn
boundary, so a task can fire long after its nominal timeout (the trace has one
armed with `timeoutMs: 3600000` delivered 3h51m later, batched with three
others).

The defining limitation, and the reason the level exists: **every discharge
path keys off something the agent did** (resumed, called `TaskStop`), because
a completion never crosses the wire. A job that simply exits while the agent
is busy with an unrelated turn has its notification absorbed by that turn, so
no resumption fires and nothing ever clears the entry. Observed in the wild
at 2h43m and counting, on a `sleep 120`.

**Entries never expire on a clock.** They leave the set only on a signal from
the agent. The agent's reported `timeoutMs` is not read at all: it answers "how
long might this watch run", which is not the question. Three ceilings used to
live here (a 30-minute default, a 15-minute one-shot cap, a 60-minute repeating
cap) and each was a guess at a duration the daemon cannot observe. They failed
in both directions: a legitimate 45-minute device watch went dark 15 minutes in
while still reporting normally, and a watch killed by a bare `pkill` claimed a
wakeup for the rest of the hour.

The consequence, stated plainly: **a watch that dies without a word leaves its
entry counted for the life of the session.** `claude-acp` could close this gap
cheaply — it already maintains the exact live set internally
(`session.liveBackgroundTasks`, reconciled from `task_started` /
`task_notification` / `task_updated` against `background_tasks_changed`, a
level signal with REPLACE semantics) and forwards none of it to the client.

**One-shot versus repeating armings.** How an entry leaves the set depends
on how often the underlying tool fires, and the two kinds behave differently:

| | fires | cleared by a resumption | cleared by `TaskStop` |
|---|---|---|---|
| backgrounded `Bash` (`run_in_background`) | once, on exit | yes | yes |
| `Monitor` | once per occurrence, until its command exits | **no** | yes |

For a **one-shot**, the daemon clears **every** such entry armed since the
last turn boundary when the agent resumes, not just the one it can attribute
the resumption to. Delivery is batched at turn boundaries, so a resumption is
good evidence that everything pending reported in; clearing only the
attributable one stranded the rest indefinitely.

For a **repeating** watch that reasoning does not hold: its notification says
the watch is alive, not that it is finished. Clearing one on its first firing
left every later firing with nothing armed, so a session with six live
watches reported `armedTasks: 0`. A repeating entry therefore leaves only via
`TaskStop`. `persistent` does **not** identify these: a `persistent: false`
Monitor fires repeatedly too; the tool kind does.

Either kind is cleared when the agent cancels it with `TaskStop`, matched on
`rawInput.task_id` against the id harvested at arming time (a Monitor reports
that in `_meta.claudeCode.toolResponse.taskId`; a backgrounded Bash reports
it only in its `rawOutput` prose, which the daemon parses).

**Two cases the daemon genuinely cannot see**, and it now reports them as
unknown rather than guessing:

- A watch killed some other way. A `pkill` from a plain Bash leaves it dead
  with no signal at all: no `TaskStop`, no notification.
- A watch whose command simply exits. `Monitor`'s tool call returns within
  seconds of arming, and its final `status: "completed"` means the *tool*
  returned, **not** that the watch ended. Later firings arrive as ordinary
  agent activity, never as another `tool_call_update` for that `toolCallId`,
  so the entry is armed exactly once and nothing ever revisits it.

In both cases the entry stays counted. That is the deliberate cost of not
inventing an expiry, and it is the same best-effort caveat as above.

#### Notification: `hydra-acp/session/armed_tasks_updated`

Daemon to every attached client, whenever the armed set changes: a task is
armed, a one-shot is discharged by a resumption, or one is cancelled via
`TaskStop`.

`tasks` is the **complete current set**, never a delta. Clients must REPLACE
their local list with it rather than merging: a merge re-creates the very bug
the level signal exists to kill, this time inside the client. A dropped
notification therefore self-heals on the next one.

The entry shape depends on which source produced it, and the two carry
different keys:

```jsonc
// Level-sourced (claude-acp). No toolCallId: the agent reports its live
// set without attribution, and the daemon must not join it to the edge
// stream.
{
  "sessionId": "<id>",
  "count":     1,
  "since":     1717012800000,   // absent when count is 0; min of tasks[].since
  "tasks":     [ {
    "taskId":   "bgzem17m0",
    "label":    "Sleep 20 seconds then echo done",
    "taskType": "local_bash",
    "since":    1717012800000
  } ]
}

// Edge-sourced (every other agent). Best-effort, and overstates.
{
  "sessionId": "<id>",
  "count":     1,
  "since":     1717012800000,
  "tasks":     [ {
    "toolCallId": "toolu_01YH6jTseLAcJS",   // the tool call that armed it
    "label":      "device run",
    "taskId":     "bgzem17m0",              // absent until an update carries it
    "since":      1717012800000
  } ]
}
```

Each entry carries its own `since`, so a client can render a per-task elapsed
and not just the aggregate. Top-level `since` is the minimum across
`tasks[].since`, so the two never disagree.

Because `toolCallId` is absent on level-sourced entries, **key UI on `taskId`**
and treat `toolCallId` as an optional bonus for annotating an
already-rendered tool call.

The daemon suppresses a notification only when neither the **membership** (the
set of ids) nor `since` moved. Deliberately not keyed on `count`: with A
(oldest) and B running, B ending as C starts leaves the count at 2 and `since`
still on A, so a count-keyed dedup would drop the payload and leave every
client rendering the finished B while C stayed invisible. Reordering alone is
not a change; neither source promises a stable iteration order.

`toolCallId` is the identity of the tool call that armed the watch, which is
also the identity of the tool-call block a client has already rendered for it.
It is the only key that joins an armed entry back to that block, so a client
that wants to annotate "this watch is still running" on the call that started
it needs this field. Exact, not inferred: the daemon's armed set is keyed on
it, read straight off the arming update.

`since` is when the *oldest still-armed* task was armed. Clients clock a
"running" readout from it, because the useful question is how long the job
has been going, not how long the user has been idle since the turn ended.

Pushed rather than polled on purpose: the transition that matters most is
the task going away while nobody is looking. An idle session gets no other
traffic, so a client that only learned the count at attach time would keep
claiming a job was running long after it finished.

**But push alone is not enough — the attach response carries the state too.**
`_meta["hydra-acp"]` on the `session/attach` and `session/new` responses
includes `armedTasks` and `armedSince`, the same two values the notification
carries. Clients MUST seed from them on every attach, including reattach, and
MUST treat `armedTasks: 0` as "clear whatever you were showing".

It also includes `armedTaskList`, the set itself, with the same entries the
notification's `tasks` carries. A client that wants to *list* running jobs
(names, per-task elapsed) rather than badge a count seeds from this; without
it, a mid-flight attach would know how many jobs are running but not what
they are until the next membership change, which for a long job can be an
hour. Same replace-don't-merge contract, and the same absent-versus-empty
rule as `armedTasks`: `[]` means nothing is running, absent means the daemon
is too old to say.

`armedTaskList` is deliberately NOT on `session/list` rows. It carries
agent-authored prose per entry, and attaching that to every row of every
list response to feed a column that only ever renders `BUSY` is not worth
the payload. The count on the row is the right granularity there; the list
is per-session detail.

The armed set is per-`Session` and in-memory only; it is never persisted. So a
session that closes and comes back — force-cancel, crash, cold-resurrect,
daemon restart — returns as a *new* `Session` whose armed set is empty, and it
will never announce that: `armed_tasks_updated` fires only on a mutation, and
an empty set at construction is not one. A client relying on push alone
therefore holds its last-known count forever across any such event. Observed:
a session force-cancelled mid-turn whose TUI showed `◐ waiting 2h 36m`,
clocked from an arming two incarnations earlier, while the daemon and
`hydra session list` both correctly reported nothing armed.

`armedTasks` is emitted even when 0, and absent only from a daemon too old to
report it. Clients MUST distinguish the two: reading absence as zero would
clear a live badge on every reattach to an older daemon.

Deduplicated on membership plus `since`: several updates for one tool call
all carry the arming signal (a real `Monitor` sent seven), and re-arming an
entry already in the set moves neither, so it fires once.

**Vendor coupling.** The `cause` label is derived from
`_meta.claudeCode.toolResponse.taskId` and `rawInput.run_in_background`, which
are `claude-acp` extensions rather than ACP. This is the only place hydra keys
behaviour off a vendor `_meta` namespace; detection itself does not depend on
it, and an agent that reports neither simply gets an unlabelled turn.

### session/update — compaction lifecycle

Attached clients receive `session/update` notifications as compaction progresses. The `update.sessionUpdate` field is `"_hydra_compaction"` for all six phases.

**Envelope shape** (all phases):

```jsonc
{
  "sessionId": "<upstream session id>",
  "update": {
    "sessionUpdate": "_hydra_compaction",
    "phase": "started" | "iteration" | "deferred" | "swapped" | "converged" | "failed",
    // ... phase-specific fields below
  }
}
```

**Phase payloads:**

```jsonc
// started — emitted once when the catch-up loop begins
{ "sessionUpdate": "_hydra_compaction", "phase": "started", "requestedAt": 1717012800000 }

// iteration — emitted once per successful catch-up loop iteration
{ "sessionUpdate": "_hydra_compaction", "phase": "iteration", "iter": 1, "historyLen": 42 }

// deferred — emitted each time the swap is deferred because the session is not quiesced
{ "sessionUpdate": "_hydra_compaction", "phase": "deferred", "attempts": 1 }

// swapped — emitted once when the upstream agent is replaced successfully;
//            replaces the old empty session_info_update signal
{ "sessionUpdate": "_hydra_compaction", "phase": "swapped", "title": "My Session", "summarizedThroughEntry": 42 }

// converged: emitted once per RUN when the catch-up loop finishes having
//             produced an artifact, whether it stopped because history
//             stopped growing or because it hit maxIterations
{ "sessionUpdate": "_hydra_compaction", "phase": "converged", "iter": 2, "summarizedThroughEntry": 11646 }

// failed — emitted when retrySwap exhausts deferrals or encounters a fatal error
{ "sessionUpdate": "_hydra_compaction", "phase": "failed", "error": "deferral cap reached — session never quiesced" }
```

**`converged` is per-run; `swapped` is per-swap.** One compaction run can swap
more than once: if history grows while an iteration is in flight (a background
turn is enough), the loop runs again and swaps again. Clients counting
compactions must count `converged`, not `swapped`, or a single `/hydra compact`
reads as two. The generation entries the run appends to
`upstreamGenerations` share a `runId` for the same reason.

`converged` normally arrives **after** the run's final `swapped`, because the
swap is dispatched from inside the loop. When the swap is deferred (session not
quiesced), `converged` can arrive *before* the eventual `swapped`; it reports
that synthesis finished, not that the agent was replaced. A client clearing a
"compacting…" indicator should key off `swapped`/`failed`, not `converged`.

**Ordering guarantee:** S1 (state persistence) writes happen before the corresponding broadcast fires. A broadcast never implies that something happened that wasn't persisted — if the write fails, the broadcast is suppressed. `converged` is the exception in one direction only: it deliberately writes **no** terminal `compactionState`, because a successful swap clears that field and re-writing it would resurrect state whose absence is what "no compaction in progress" means. The durable record of a successful compaction is the `upstreamGenerations` entry, not `compactionState`.

#### Per-generation cost

An entry's `cost` is the spend on that generation, derived as
`lifetimeTotalAtClose - lifetimeCostAtStart` — the session's lifetime spend
differenced across the generation's span, not a figure any agent reports.

It has to be derived, because no per-generation figure exists to read.
`currentUsage.costAmount` looks like one and isn't: it tracks the agent
**process**, and a generation outlives many of them. Every cold resurrect —
a daemon restart, or the 1h idle timeout, which fires all day on a session
nobody is typing into — starts a process whose ledger restarts at $0, and
the retained spend is re-based into `cumulativeCost` mid-generation.
Stamping `costAmount` at rotation therefore recorded only the spend since
the **last** resurrect. On the session that surfaced this, that was $106
stamped against $543 actually spent.

The lifetime total is the one quantity immune to that: conserved across
every re-base, monotonic, already persisted. `cumulativeCost` still means
"spend on retired generations", and it is the sum of their `cost` values
for any chain with no gaps.

`lifetimeCostAtStart` is absent on generations opened before it existed;
those keep their old under-counted `cost`, and there is no way to recover
the real figure after the fact. `cost` itself is absent on the live entry
and on any generation closed by a daemon restart rather than a rotation.

#### Per-generation context figures

Each `upstreamGenerations` entry carries `usedAtStart` and `usedAtEnd`: the
context-window occupancy, in tokens, when that generation was entered and
when it was rotated away.

**These are not cumulative.** Every generation is a separate upstream
session with its own window, so the chain is a sawtooth, not a ladder — a
compaction exists precisely so that the new entry's `usedAtStart` is far
below the previous entry's `usedAtEnd`:

```
u_first    usedAtStart: 0        usedAtEnd: 868556
u_second   usedAtStart: 79193    usedAtEnd: 923708     <- compaction
u_third    usedAtStart: 80112    usedAtEnd: —          <- live
```

The one exception is a **re-entered** upstream. A rollback resumes a session
where it left off, so its new entry opens at that upstream's prior
occupancy rather than at a seed-sized figure. A re-entry and a failed
compaction are indistinguishable from the id alone and are told apart by
this pair.

Either field may be absent, and absent never means zero:

- `usedAtEnd` is absent on the live entry (still accruing), and on any
  generation closed by a **daemon restart** rather than a rotation — the
  in-memory Session is what reports the figure, and a killed daemon
  reports nothing. Same reason `cost` is absent on those entries.
- `usedAtStart` is absent whenever the opening figure was never observed:
  a rollback or restart resumes an upstream that has not reported usage
  yet. The daemon deliberately does not record the `0` its own snapshot
  holds at that instant, because `0` would read as an empty context on a
  session holding a full one.

`/hydra compact status` renders a run as `869k → 79.2k`, and renders no
span at all when either end is missing rather than emit a half-open one.

These fields exist because nothing else retains the numbers: `currentUsage`
is a single snapshot of the live generation and is overwritten at each
rotation, and the `usage_update` rows in `history.jsonl` are a ring buffer.

### session/update — workspace lifecycle

Emitted while a session moves into or out of an isolated workspace, or has its
workspace reset underneath it (`/hydra workspace start|merge|apply|sync|stop|detach|clean|discard`).
`update.sessionUpdate` is
`"_hydra_workspace"` for every phase. Ephemeral: never written to
`history.jsonl`, so replaying clients do not see it.

```jsonc
// provisioning — the workspace checkout is being created
{ "sessionUpdate": "_hydra_workspace", "phase": "provisioning" }

// setup — repo-defined setup hooks are running (these may install dependencies)
{ "sessionUpdate": "_hydra_workspace", "phase": "setup" }

// swapping — the agent process is being replaced in the new directory
{ "sessionUpdate": "_hydra_workspace", "phase": "swapping" }

// landing: the workspace is being merged back into the source tree. The
//          session STAYS in it for `merge`; for `stop` a `returning`
//          follows.
{ "sessionUpdate": "_hydra_workspace", "phase": "landing" }

// applying: the workspace's changes are being staged into the source
//           without its history. Followed by `entered` with an unchanged
//           cwd, since the session stays put.
{ "sessionUpdate": "_hydra_workspace", "phase": "applying" }

// returning: the session is being swapped back to the source tree
{ "sessionUpdate": "_hydra_workspace", "phase": "returning" }

// cleaning: the workspace's tree is being reset to its base under a
//           session that STAYS in it. Followed by `entered` with an
//           unchanged cwd, since nothing relocated.
{ "sessionUpdate": "_hydra_workspace", "phase": "cleaning", "label": "feature" }

// entered — terminal. The session now lives at `cwd`.
{ "sessionUpdate": "_hydra_workspace", "phase": "entered",
  "cwd": "/home/u/.hydra-acp/workspaces/<hash>/feature",
  "sourceCwd": "/home/u/dev/proj", "label": "feature", "branch": "hydra/feature" }

// left — terminal. The session is back in the source tree.
{ "sessionUpdate": "_hydra_workspace", "phase": "left",
  "cwd": "/home/u/dev/proj", "sourceCwd": "/home/u/dev/proj", "integrated": true }

// failed — terminal. The move was unwound; the session did not relocate.
{ "sessionUpdate": "_hydra_workspace", "phase": "failed", "error": "..." }

// drift — not a phase of a move at all: the SOURCE has gained commits the
//         workspace does not have. Emitted at a turn boundary, at most once
//         per distinct source tip, and only for providers with shared
//         history. `behind` is the commit count.
{ "sessionUpdate": "_hydra_workspace", "phase": "drift",
  "label": "feature", "sourceCwd": "/home/u/dev/proj", "behind": 3 }
```

`drift` carries no cwd and moves nothing, so a client that only tracks
relocation can ignore it. It exists because landing is fast-forward-only:
a client that surfaces it lets the user sync while they are still working,
instead of meeting the same fact as a refusal from `stop`. The daemon also
emits the equivalent sentence as a synthetic `agent_message_chunk`, so a
client that handles neither still shows it in the conversation.

**Why a client must handle this.** A session's cwd is otherwise learned
once, from `session/new` or `session/attach`, and there is no other
signal that it changed. That cwd is what a client resolves file
completion, VCS status, and diff paths against, so a client that ignores
these events keeps operating on the tree the session has left — silently,
because the old directory still exists and still answers.

**Ordering guarantee:** the terminal phases fire *after* the session
record is persisted, so a client acting on the new `cwd` can never
outrun the state that justifies it. Non-terminal phases are progress
only and carry no state.

**Cold sessions:** broadcasts are dropped for sessions with no attached clients. The persistent `compactionState` field in the session record provides visibility for cold sessions.

### Authentication

Hydra proxies to N different upstream agent kinds (claude, codex, gemini, …), each with its own independent provider auth. That breaks the vanilla ACP assumption of a single "the agent," so hydra extends both `authenticate` and `logout` with an optional `_meta["hydra-acp"].{agentId,sessionId}` disambiguator that tells the daemon which upstream to route to. When no hint is given, hydra falls back to `defaultAgent`; when no upstream is live for the selected kind, hydra bootstraps one just for the auth flow (mirrors `bootstrapAgentForAuth`).

#### Request: `authenticate`

Standard ACP `authenticate` — client selects one of the advertised `authMethods` and passes its `methodId`. Hydra advertises a placeholder `authMethods` list at `initialize` (before any upstream is selected) and resolves the real method against the routed agent at call time. Terminal-type methods trigger the two arg-shape resolution described in `handleAuthenticate`.

```jsonc
// params
{
  "methodId": "<id>",
  "_meta": { "hydra-acp": { "agentId": "<id>", "sessionId": "<id>" } }  // optional
}
```

#### Request: `logout`

Standard [ACP `logout`](https://agentclientprotocol.com/protocol/v1/authentication#logging-out) (stabilized 2026-05-22). Ends the current authenticated state on the routed upstream agent so a subsequent `session/new` requires re-auth.

```jsonc
// params
{
  "_meta": { "hydra-acp": { "agentId": "<id>", "sessionId": "<id>" } }  // optional
}
// result
{}
```

Same routing rules as `authenticate`. The upstream `logout` call is a straight pass-through — if the selected upstream doesn't implement it (older ACP version), the error surfaces to the client verbatim. Hydra advertises `agentCapabilities.auth.logout = {}` at the daemon level; whether the specific upstream selected by routing supports it is a runtime discovery, consistent with how hydra advertises the union of upstream capabilities for prompt/mcp too.

Spec explicitly does not guarantee what happens to already-running sessions after logout — hydra leaves them alone and lets attached clients discover auth failures naturally on the next authenticated call. Hydra's own bearer token (`~/.hydra-acp/auth-token`, transport auth) is deliberately untouched; use [`POST /v1/auth/logout`](#post-v1-auth-logout) for that.

### Session close

#### Request: `session/close`

Cancel any ongoing work for a session and free daemon-side resources, but keep the on-disk record so `session/list` still shows it and `session/resume` can reactivate it later. Follows the stabilized [ACP `session/close` spec](https://agentclientprotocol.com/protocol/v1/session-setup#closing-active-sessions) (v1, 2026-04-23).

```jsonc
// params
{ "sessionId": "<id>" }
// result
{}
```

Semantics slot between the neighbouring lifecycle verbs:

- `session/cancel` — abort the current turn, keep the session hot. Ends an
  [agent-initiated turn](#agent-initiated-turns) too: that turn has no
  `session/prompt` to settle, so nothing else would ever close it, and before
  this was wired up `^C` was a guaranteed no-op for the entire class of turns
  the agent starts by itself. Emits `_hydra_turn_ended` with `reason: "cancelled"`.
- `session/close` — kill the upstream agent and free session state, keep the record so a later `session/resume` can rehydrate it.
- `session/delete` — do everything close does plus remove the record from `session/list`.

Not the same as `hydra-acp/session/force_cancel`, which is an escape hatch for a wedged agent (aborts the turn but keeps the session live). This is the *routine* "I'm done for now, free the resources" verb, and it converges on the same `Session.close({deleteRecord:false})` path the daemon's own idle timer uses — so attached clients see the standard `hydra-acp/session/closed` notification regardless of who initiated the close.

Idempotent: if the session exists in history but isn't live, returns `{}` (nothing to free). Only truly-unknown session ids surface `SessionNotFound` (`-32001`). Support is advertised unconditionally via `sessionCapabilities.close = {}` on `initialize`.

### Session delete

#### Request: `session/delete`

The canonical way to remove a session from `session/list` history. Follows the stabilized [ACP `session/delete` spec](https://agentclientprotocol.com/protocol/v1/session-delete) (v1, 2026-06-05).

```jsonc
// params
{ "sessionId": "<id>" }
// result
{}
```

Hydra is the authoritative session registry to attached clients — `session/list` is answered from `~/.hydra-acp/sessions/`, not from the upstream agent — so `session/delete` is served the same way and is **not** forwarded downstream. If the session is live, hydra closes it (same teardown as `session/close` / `DELETE /v1/sessions/:id`) before deleting the on-disk record. Deleting an already-gone session succeeds silently, per spec. Support is advertised unconditionally via `sessionCapabilities.delete = {}` on `initialize`.

#### Legacy alias: `hydra-acp/session/delete`

Predates the standard method. Kept for one release cycle so external clients pinned to the hydra-prefixed name keep working. Identical params (`{ sessionId }`), but differs from the standard in two ways preserved for back-compat:

- **Return shape** is `{ "deleted": true, "sessionId": "<id>" }` instead of `{}`.
- **Missing session** returns `SessionNotFound` (`-32001`) instead of silent success.

New callers should use `session/delete`.

### Local fork

#### Request: `hydra-acp/session/fork`

Branch a local session into a new one that shares context up to a chosen turn boundary. Same machinery as `POST /v1/sessions/:id/fork`, exposed over the WS so transformers and TUIs can call it without leaving the protocol.

```jsonc
// params
{
  "sessionId": "<source>",
  "forkAt":    "<messageId>",   // optional; defaults to source's latest turn_complete
  "cwd":       "<path>",        // optional; defaults to source's cwd
  "agentId":   "<id>",          // optional; defaults to source's agent
  "model":     "<modelId>"      // optional; stamped on the fork's record.currentModel
                                //   so the resurrect path applies it via
                                //   session/set_model at agent bootstrap. Overrides
                                //   both the source's currentModel (same-agent fork)
                                //   and the cross-agent clear. Invalid ids log a
                                //   warning at attach and leave the fork on the
                                //   agent's default.
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

#### Compat alias: `session/fork`

Hydra also accepts the still-Draft standard [ACP `session/fork` RFD](https://agentclientprotocol.com/rfds/session-fork) verb as a thin alias. Generic ACP clients that don't speak the `hydra-acp/*` namespace can fork with:

```jsonc
// params
{
  "sessionId":  "<source>",
  "cwd":        "<path>",       // optional; defaults to source's cwd
  "mcpServers": [...]           // accepted but currently ignored (inherited from source)
}
// result
{ "sessionId": "<new id>" }
```

The alias always forks at the source's latest turn boundary and uses `mode: "verbatim"` — no ephemeral synopsis synthesis, no agent swap, no `forkAt`. Clients that want those knobs must use `hydra-acp/session/fork`. Hydra advertises the alias via `sessionCapabilities.fork = {}` on `initialize`, and the extras via `_meta["hydra-acp"].session.fork`.

Status caveat: the RFD is Draft (not Preview/Completed) and has been since 2025-11-20. If it reshapes when it moves to Preview, this alias will need to adjust.

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

Once registered, four surfaces become available to that process:

- **Slash-command verbs.** Register with `hydra-acp/commands/register`. Whenever a user types `/hydra <name> <verb> …` in any session, the daemon forwards a `hydra-acp/commands/invoke` request to the registered connection.
- **MCP tools.** Register with `hydra-acp/mcp_tools/register`. Agents see a `/mcp/<extension-name>` HTTP MCP server; when they call a tool, the daemon forwards a `hydra-acp/mcp_tools/invoke` request to the registered connection. Extensions that want to change the tool list a session sees can do so per-session at runtime — see `hydra-acp/mcp_tools/list_tools` and `hydra-acp/mcp_tools/refresh_session` below.
- **Per-session state.** Read/write a small durable key-value bucket attached to a specific session's `meta.json` via `hydra-acp/session/extension_state/{get,list,set,delete}`. Namespaced by the calling extension (bearer-derived); persists across daemon restarts.
- **Transformer pipeline** (transformer-only). After `hydra-acp/transformer/initialize`, the daemon calls `hydra-acp/transformer/message` for each intercepted method and `hydra-acp/transformer/session_event` for lifecycle ticks.

Registrations drop on disconnect — the daemon clears the entry and evicts any cached MCP transports.

#### Inherited environment

Extensions, transformers and agents inherit the daemon's environment, minus a scrub list. The daemon inherits its own environment from whatever shell started it and then outlives that shell, so any variable describing *one terminal pane* becomes wrong — first stale when the pane closes, then actively misleading once the multiplexer reuses the id and it names someone else's pane.

Removed by default: `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `HERDR_STARTUP_CWD`, `HYDRA_HERDR_TAB_LABEL`. Users can extend the list with `daemon.scrubEnv` in `config.json` (a trailing `*` matches a prefix, e.g. `"TMUX*"`).

Deliberately **not** removed: `HERDR_SOCKET_PATH` and `HERDR_ENV`. The socket is a per-user singleton valid for the daemon's whole life, so a multiplexer-aware extension can still drive herdr — it just has to resolve its target explicitly rather than inheriting a pane it isn't in.

Only the *inherited* environment is filtered. Anything set explicitly in an agent's launch plan or an extension's own `env` block in `config.json` is layered on afterwards and always survives.

**`HYDRA_ACP_SESSION` is scrubbed, then re-set per agent.** It names *this agent's own session id*, which is what makes a running agent able to identify itself (and to stamp [prompt provenance](#prompt-provenance) when it messages a peer). The two steps are sequential, not contradictory:

1. It is in `DAEMON_OWNED_ENV`, folded into the default scrub list, so any value inherited from the shell that started the daemon is stripped.
2. For **agent** spawns only, the correct value is layered back in as explicit `extraEnv`, applied after scrubbing. All three spawn paths do this (resurrect, `bootstrapAgent`, `bootstrapAgentLoad`), so it survives agent swaps and cold resurrects.

Extensions and transformers spawn through the child supervisor, which scrubs but does not re-set, so they see no `HYDRA_ACP_SESSION` at all. That is correct: they are not session-scoped.

**Breaking change: the `--session` fallback moved to `HYDRA_ACP_TARGET_SESSION`.** Previously `--session` fell back to `HYDRA_ACP_SESSION` for every entry point (`tui`, `shim`, `launch`, `cat`). That fallback now reads `HYDRA_ACP_TARGET_SESSION`; `HYDRA_ACP_SESSION` means the agent's own session and nothing else. Anyone with the old variable exported sees two effects, and the second is silent:

1. `--session` no longer picks it up, so bare `hydra` shows the picker and `hydra cat` creates a fresh session instead of attaching to the intended one.
2. The value is now read as *provenance*. If the id still resolves, every send is stamped `fromSession: <that id>`, misattributing messages to a session that was not involved. If it does not resolve it is dropped with a log warning, which is the benign case.

The fix is to rename the export. Related: `--from-session` resolves in the order flag → `HYDRA_ACP_FROM_SESSION` → `HYDRA_ACP_SESSION`, so an agent gets correct self-attribution with no flag.

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

The daemon mints a per-session bearer at every `session/new` and injects `mcpServers` descriptors pointing at `/mcp/<process-name>` with that bearer. Re-calling `hydra-acp/mcp_tools/register` overwrites the prior spec globally (across all sessions); the route's `onChange` listener disposes cached transports so any subsequent client reconnect re-lists against the fresh spec. For per-session changes to the tool list without disturbing other sessions, use `hydra-acp/mcp_tools/list_tools` + `hydra-acp/mcp_tools/refresh_session` (see below).

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

#### Request (daemon → process): `hydra-acp/mcp_tools/list_tools`

Optional per-session dynamic tool list. When the agent's MCP client sends a `tools/list` request for `/mcp/<extension-name>`, the daemon forwards the call to the extension for a session-specific answer. The extension replies with the tool set that particular session should see, which may differ from the static spec captured at `mcp_tools/register` time.

```jsonc
// params (daemon → process)
{
  "sessionId": "<id>"
}
// result — same tool shape as hydra-acp/mcp_tools/register:
{
  "tools": [
    { "name": "…", "description": "…", "inputSchema": { … }, "outputSchema": { … } },
    …
  ]
}
```

**Optional.** Extensions that don't implement this handler let the request fail with `MethodNotFound`; the daemon catches and falls back to whatever was registered via `mcp_tools/register`. So `list_tools` is purely an upgrade — pre-existing extensions keep working with static registration only.

**Consulted only when the session is known.** The agent's initial MCP handshake (`initialize` + first `tools/list`) fires before the daemon's `session/new` has bound the token to a hydra session; during that handshake the daemon skips the dynamic path and serves the static spec, to avoid deadlocking against a `sessionId` that doesn't yet exist.

**Used by** the planner's conservative-mode gating: register just `activate` statically, then return the full 16-tool spec via `list_tools` for sessions that have called `activate`.

#### Request (process → daemon): `hydra-acp/mcp_tools/refresh_session`

Tell the daemon this session's tool list changed. The daemon sends a `notifications/tools/list_changed` frame down the affected session's MCP transport; the agent's MCP client re-fetches `tools/list` on the same transport, which routes back through `hydra-acp/mcp_tools/list_tools` above.

```jsonc
// params (process → daemon)
{
  "sessionId": "<id>"
}
// result
{ "ok": true }
```

**No transport reset.** The connection stays open, in-flight tool calls (including the one whose response triggered the refresh) complete normally, no re-`initialize`. This is the only safe way to change a per-session tool list mid-conversation for streamable HTTP MCP.

**Silent when no transport exists.** If the session has never opened the MCP endpoint (or the transport is already gone), the call is a no-op — no error, no work.

**Scoped by connection identity.** The daemon derives `<extension-name>` from the caller's bearer, so a refresh only affects that extension's MCP transport for the given session. Cross-extension refresh isn't expressible via this method.

#### Requests (process → daemon): `hydra-acp/session/extension_state/{get,list,set,delete}`

Per-(extension, session) durable key-value store, backed by the session's on-disk `meta.json`. Extensions use it to persist small pieces of state that should survive daemon restarts and cold/warm cycles — activation flags, policy decisions, spend carryover, last-seen markers, etc. The daemon enforces namespacing based on the caller's bearer: extensions can only read and write their own bucket, and there's no wire-shape way to spoof another extension's identity.

**Persistence rules:**

| operation | `extensionState` |
|---|---|
| `session/new` | initialized to `{}` |
| daemon restart / cold session load | preserved (stored in `meta.json`) |
| `session/fork` | reset to `{}` on the child; parent untouched |
| compaction swap | preserved (same hydra `sessionId`) |
| `session/delete` | deleted with the session |

**Size cap.** Each `(extension, session)` bucket is capped at 64KB when serialized. A `set` that would exceed the cap rejects with a JSON-RPC `InvalidParams` error whose message includes the byte count and cap so the caller can trim.

**`get` — read one key.**

```jsonc
// params
{ "sessionId": "<id>", "key": "<key>" }
// result
{ "value": <any JSON value>  }   // when key exists
{ "value": null }                // when key does not exist
```

**`list` — read the caller's full bucket for this session.**

```jsonc
// params
{ "sessionId": "<id>" }
// result
{ "state": { "<key>": <value>, … } }   // {} when the extension has no keys yet
```

**`set` — write one key.**

```jsonc
// params
{ "sessionId": "<id>", "key": "<key>", "value": <any JSON value> }
// result
{ "ok": true }
```

`value` is required (any JSON value including `null` is allowed). Use `delete` to remove a key entirely — `set` with `undefined`/missing `value` is rejected. Idempotent from the caller's perspective (writing the same value again is a no-op observably; the file gets rewritten with a fresh `updatedAt`).

**`delete` — remove one key.**

```jsonc
// params
{ "sessionId": "<id>", "key": "<key>" }
// result
{ "ok": true }
```

No-op when the key doesn't exist. When the last key in the caller's bucket is removed, the bucket entry itself is dropped from `meta.json` so extensions that touched and left don't leave `"<name>": {}` clutter behind.

**Namespacing.** Every handler derives the effective `<extension-name>` from `processIdentity.name` on the WS connection — there is no wire-level knob to override it. A caller connected as `hydra-acp-planner` cannot read `hydra-acp-approver`'s bucket, cannot overwrite an approver-owned key by name, cannot delete an approver-owned key, and cannot see approver keys in `list`.

**Failure modes.**

| error | when |
|---|---|
| `-32602 InvalidParams: sessionId is required` | missing / empty `sessionId` |
| `-32602 InvalidParams: key is required` | missing / empty `key` on any method other than `list` |
| `-32602 InvalidParams: value is required (use extension_state/delete to remove)` | `set` called without `value` |
| `-32602 InvalidParams: bucket for X would be N bytes; cap is Y` | `set` would exceed the 64KB cap |

`get`/`list`/`delete` for an unknown session return normally (empty result) rather than erroring — the storage is optimistic about session existence; a session that just closed and was cleaned up shouldn't turn a stale write into a hard failure at the extension.

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

Intercepts are matched against `request:<method>`, `response:<method>`, and `lifecycle:<event>` strings. Lifecycle events currently fired:

| Event | When | Payload |
|---|---|---|
| `session.starting` | Broadcast to every connected transformer subscribed to this intercept, out-of-chain, once per session bring-up (`session/new` AND resurrect from cold), just after MCP/stdin bindings are wired and before the agent produces events. Lets transformers inspect a session's persisted state (e.g. its `extension_state` bucket) and decide whether to join the chain by calling `hydra-acp/transformer/attach`. Fire-and-forget from the daemon's side. | `{}` |
| `session.opened` | A transformer with this intercept joins a live session (`addTransformer`) or the chain runs on session creation. Note: this fires only to transformers ALREADY in the session's chain — use `session.starting` if you need to opt in based on persisted state. | `{}` |
| `session.idle` | After `idleEventTimeoutMs` of continuous quiet following the last recordable broadcast. Re-fires after each activity → quiet cycle. | `{}` |
| `session.closed` | Synchronously inside `markClosed`, before per-session state is torn down. | `{}` |
| `permission.replied` | After a `session/request_permission` resolves — whether by transformer short-circuit or by a real client reply. | `{ toolCallId, outcome, sourceWasTransformer }` |
| `tool.completed` | Edge-triggered: the first `tool_call_update` for a given `toolCallId` whose `status` is `"completed"` or `"failed"`. Deduplicated per session — repeat terminal updates do not re-fire. | `{ toolCallId, status, kind?, content?, locations? }` |
| `file.edited` | A `tool_call` or `tool_call_update` of `kind: "edit"` carries one or more `locations[].path`. Deduplicated per `(session, path)` — only the first sighting of each path emits. | `{ path, toolCallId, line? }` |
| `agent.swap` | Around `swapUpstream`. Fires twice per swap: `phase: "pre"` before the new agent is spawned, `phase: "post"` after the old agent is killed. | `{ phase, previousUpstreamSessionId, upstreamSessionId?, agentId }` |
| `compaction` | Mirrors every `broadcastCompactionPhase` call. Same envelope as the `_hydra_compaction` `session/update`, exposed as a typed lifecycle so hooks don't have to filter notifications. Notification-only — cancellable `compact:pre` is deferred to a future stage. | `{ phase, ... }` (phase ∈ `"started"`, `"iteration"`, `"deferred"`, `"swapped"`, `"failed"`, `"rolled_back"`) |

**Recognized request-side intercepts.**

| Intercept | Direction | Source |
|---|---|---|
| `request:session/prompt` | client → agent | client `session/prompt` |
| `request:session/new` | client → agent | client `session/new` |
| `request:session/load` | client → agent | client `session/load` |
| `request:session/set_mode` | client → agent | client `session/set_mode` |
| `request:session/cancel` | client → agent (notification) | client `session/cancel` |
| `request:authenticate` | client → agent | client `authenticate` |
| `request:session/request_permission` | agent → client | agent's permission gate |

The first six are dispatched by `forwardRequest`; the last by `runAgentRequestChain`. Both honor `continue` / `stop` / `processing` identically — see the action contract under `hydra-acp/transformer/message`. The `direction` field on the message payload disambiguates which side originated.

**Response-side scope.** Declaring `response:<method>` is generic — the dispatch predicate is `response:${method}` — but `session/update` is the only agent → client notification wired into a response chain today. There is no `response:session/prompt` event: the session/prompt RPC result is consumed by the daemon's `runQueueEntry` and translated into a synthesized `turn_complete` `session/update` via `broadcastTurnComplete`, which is published with `recordAndBroadcast` and therefore bypasses the transformer chain entirely. **A transformer cannot observe `turn_complete` through the intercept stream.** If you need an end-of-turn signal for a sub-prompt you originated via `hydra-acp/message/emit`, await the emit promise instead — see the note on `message/emit` below.

The response chain adopts a returned `payload` on `continue` as a rewrite of the outbound envelope (symmetric with the request side), so a transformer can mutate `session/update` notifications before clients see them.

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

- `continue` (default) — daemon proceeds with the envelope (rewritten if `payload` is present, on both request and response chains).
- `stop` — short-circuit. For `request:` intercepts with `direction: "client→agent"` the agent is not called and `payload` becomes the synthesized response to the original client caller. For `request:` intercepts with `direction: "agent→client"` (currently only `session/request_permission`), the original daemon-side handler is not called and `payload` becomes the synthesized reply returned to the agent — defaults to `{ outcome: { outcome: "cancelled" } }` (auto-deny) for `session/request_permission` when no payload is supplied. For `response:` intercepts the envelope is dropped (clients never see it). For notification-tailed intercepts (`request:session/cancel`) the message is silently discarded — `payload` is irrelevant.
- `processing` — the transformer is taking ownership; the daemon parks the call until the transformer discharges the claim via `hydra-acp/message/emit` with `respondsTo: <token>`. The discharge value becomes the short-circuit payload. If the transformer doesn't discharge within the claim timeout, the daemon broadcasts a `hydra-acp/transformer/abandoned_request` notification and resumes the chain from the next transformer (fail-open).

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
{
  "event":     "<lifecycle event name>",
  "sessionId": "<id>",
  "payload":   { /* event-specific; see the lifecycle events table above */ }
}
```

The full set of currently-fired events and their payloads is enumerated in the table above (`session.opened`, `session.idle`, `session.closed`, `permission.replied`, `tool.completed`, `file.edited`, `agent.swap`, `compaction`).

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

- **Standard `agentCapabilities.sessionCapabilities`** advertises the RFD #533 (`attach: {}`), Session List (`list: {}`), Session Resume (`resume: {}`), Session Close (`close: {}`), Session Delete (`delete: {}`), and (speculatively, still-Draft) Session Fork (`fork: {}`) extensions.
- **Standard `agentCapabilities.auth`** advertises Logout (`logout: {}`). Hydra advertises this unconditionally; the actual upstream capability is resolved at call time when routing to a specific agent kind.
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

**Standard codes with Hydra-specific conditions.** The [session-to-session loop guards](#admission-control-session-to-session-loop-guards) reject with plain `-32600 InvalidRequest` from the `session/prompt` handler, before enqueue. Callers distinguish them by message, since no dedicated code was allocated:

| Condition | Message template |
|---|---|
| Depth cap exceeded | `message chain too deep (${depth} hops, max ${MAX_MESSAGE_DEPTH}): refusing to continue a session-to-session loop` |
| Blocking send would deadlock | `would deadlock: ${targetSessionId} is already blocked waiting on ${senderSessionId}. Send with --no-wait, or let the other turn finish first.` |
