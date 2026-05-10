# acp-hydra

> **Status: experimental.** A multi-client session daemon for the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/). One head visible, many bodies behind: clients see a single ACP agent; the daemon manages real agent processes and lets multiple clients attach to the same live session.

## What it is

`acp-hydra` is a daemon + CLI shim that implements four open ACP RFDs as a single coherent surface, plus the official ACP Registry as its agent-distribution mechanism.

### The standards it stitches together

ACP itself is the [Agent Client Protocol](https://agentclientprotocol.com/) — a JSON-RPC 2.0 protocol between editors (clients) and AI coding agents. Today the protocol is canonically a 1:1 stdio relationship: one editor spawns one agent and owns its stdin/stdout. Four RFDs in the [`agentclientprotocol/agent-client-protocol`](https://github.com/agentclientprotocol/agent-client-protocol) repo extend that model. `acp-hydra` is one daemon that implements all four together so they can be used as a coherent system rather than four independent extensions.

#### 1. Multi-Client Session Attach — [RFD #533](https://github.com/agentclientprotocol/agent-client-protocol/pull/533)

Adds two new methods that turn ACP from 1:1 into 1:N:

- **`session/attach { sessionId, role, historyPolicy, clientInfo? }`** — a second (or third, or N-th) client connects to a session that's already live. `role` is `"controller"` (can prompt and respond to permission requests) or `"observer"` (read-only). `historyPolicy` controls replay on attach: `"full"`, `"pending_only"`, or `"none"`.
- **`session/detach { sessionId }`** — graceful disconnect; the session continues as long as one controller remains.

Permission requests fan out to all controllers; the first response wins, and the rest receive a `session/permission_resolved` notification. Capability is advertised in `initialize` under `agentCapabilities.sessionCapabilities.attach.roles`.

#### 2. Agent Extensions via ACP Proxies — [RFD: proxy-chains](https://agentclientprotocol.com/rfds/proxy-chains)

Defines the proxy-chain pattern: a component that sits between an ACP client and an ACP agent and either passes traffic through or transforms it. Proxies use `proxy/initialize` (instead of `initialize`) so the conductor of the chain can tell terminal agents apart from intermediate proxies. Proxies "send messages to successor and receive messages from successor" without knowing what or where the successor is — the conductor's job. `acp-hydra` operates as the conductor and as one such proxy: editors spawn it, and from their perspective it appears as a single ACP agent regardless of how many real agents the daemon is managing behind it.

#### 3. Session List — [RFD: session-list](https://agentclientprotocol.com/rfds/session-list)

Adds **`session/list { cwd?, cursor?, limit? }`** — an optional capability for enumerating live sessions on an agent (or, in this case, on the daemon). Each entry returns `{ sessionId, cwd, title, updatedAt, _meta }` plus a cursor for pagination. Capability is advertised as `agentCapabilities.sessionCapabilities.list: true`. This is what makes "list and attach" usable from any compliant client without a hydra-specific REST call.

#### 4. Streamable HTTP & WebSocket Transport — [RFD: streamable-http-websocket-transport](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport)

Defines the network transport that lets ACP run between processes that aren't parent and child. The relevant half for `acp-hydra` is the WebSocket binding: a client sends `GET /acp` with `Upgrade: websocket`, receives a `101 Switching Protocols` response, and the connection becomes a bidirectional stream of JSON-RPC text frames (binary frames are ignored). Authentication is layered on top — HTTP headers, query parameters, or WebSocket subprotocols — and is treated as orthogonal by the spec. `acp-hydra` exposes its WSS endpoint at `/acp` and authenticates via a bearer token carried in a WebSocket subprotocol or a query parameter.

### The registry it depends on

Agents are sourced from the [ACP Registry](https://github.com/agentclientprotocol/registry) — a CDN-hosted JSON document at `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`. Each entry declares `id`, `name`, `version`, `description`, and a `distribution` block that selects between `npx`, `binary`, or `uvx` installation. `acp-hydra` caches the registry locally with a 24-hour TTL, falls back to the cached copy on network failure, and resolves an agent's `distribution` to a spawn plan when a session needs that agent.

## Architecture

```
                        any ACP client
                            |
                       stdio (spawn)
                            |
                   acp-hydra (shim mode)
                            |
                      WSS / HTTP
                            |
                    acp-hydra daemon
                            |
              ┌─────────────┼─────────────┐
              │             │             │
       ACP agent A      ACP agent B   ACP agent C   ← stdio child processes
       (one per session, sourced from the ACP Registry)
```

### How it works

1. **Editor spawns `acp-hydra`** as it would any ACP agent. The shim looks like a normal stdio agent.
2. **Shim opens a WSS connection** to the daemon at `/acp`, authenticating via the bearer token.
3. **`session/new` from the editor** → daemon resolves the requested agent against the cached ACP Registry, downloads it on first use under `~/.acp-hydra/agents/`, spawns it as a child process, and creates an ACP session inside it (per RFD: proxy-chains).
4. **`session/attach` from a second client** → daemon adds the new client to the session's broadcast list and replays history per `historyPolicy` (per RFD #533).
5. **Notifications** fan out to every attached client. **Prompts** are serialized through the daemon's per-session queue. **Permission requests** broadcast to all controllers; first response wins and the rest receive `session/permission_resolved`.
6. **`session/list`** returns the daemon's active sessions, filterable by `cwd` (per RFD: session-list).
7. **`session/detach`** lets a client leave voluntarily; the session continues until the last controller detaches (per RFD #533).

### Why a shim?

Existing ACP clients are stdio-based: they `spawn(command)` a process and exchange JSON-RPC over its stdin/stdout. A shim that *looks* like an ACP agent on stdio is zero-integration on the client side — the client doesn't need to know anything about hydra, the daemon, or WSS. It just spawns `acp-hydra` and starts talking ACP.

Clients that adopt the streamable-http-websocket-transport RFD natively can connect to the daemon's `/acp` endpoint directly without the shim.

### Surviving daemon restarts (resurrection)

The shim and daemon together implement a "resume hint" pattern that lets editor sessions survive a daemon restart without the editor noticing:

1. **The daemon's `session/new` and `session/attach` responses include a `_meta` block**, with hydra-specific data namespaced under `_meta["acp-hydra"]` (per the [Session List RFD](https://agentclientprotocol.com/rfds/session-list)'s "agent-specific `_meta` fields" convention). The underlying agent's own `_meta` keys, if any, are passed through unchanged alongside `acp-hydra`.
2. **The shim caches that namespaced data in a `SessionTracker`** as messages flow through, keyed by the hydra sessionId the editor knows.
3. **The shim's WS connection is wrapped in a `ResilientWsStream`** that reconnects with exponential backoff (200ms → 5s, capped, max 60 attempts) and buffers outbound messages from the editor while disconnected.
4. **After each successful reconnect, the shim replays a `session/attach`** for every cached session, including the resume hints under `_meta["acp-hydra"].resume`.
5. **If the daemon already knows the session** (e.g., the daemon never died, just a network blip), it ignores the resume hint and does a normal attach.
6. **If the daemon doesn't know the session**, it resurrects: spawns a fresh agent of `agentId` in `cwd`, runs `initialize`, calls ACP `session/load { sessionId: upstreamSessionId }` against the agent, and registers a new hydra `Session` *with the same hydra sessionId the shim claimed*. The editor sees nothing.

The resurrection is serialized per hydra sessionId, so two shims racing to reattach to the same session don't both spawn fresh agents.

**What this requires:** the underlying agent must support `loadSession` and persist its own session state to disk between processes (e.g., claude-code-acp does, in `~/.claude/sessions/`). For agents that don't support load, resurrection fails on the daemon side and the shim surfaces an error to the editor.

**What gets lost across restart:** the daemon's in-memory streaming history and in-flight tool calls. The agent's persisted state — past completed turns, conversation context — is recovered via `session/load`. The agent will need to re-issue any tool call that was mid-stream when the daemon died.

**In-flight permission prompts:** the shim tracks open `session/request_permission` requests it has forwarded to the editor. On any reconnect (which always implies the previous daemon-side promise is gone), the shim emits a `session/permission_resolved` notification toward the editor for each pending request, with `resolvedBy: "acp-hydra"` and `outcome: { kind: "cancelled", reason: "daemon-disconnected" }`. Editors that handle `session/permission_resolved` per [RFD #533](https://github.com/agentclientprotocol/agent-client-protocol/pull/533) will dismiss their in-flight permission UI. Any response the editor still sends afterward is silently dropped by the new daemon (unknown request id).

### Wire shape of `_meta`

A hydra `session/new` response looks like:

```json
{
  "sessionId": "sess_abc123",
  "_meta": {
    "agent-vendor": { "sequence": 7 },
    "acp-hydra": {
      "upstreamSessionId": "u_xyz",
      "agentId": "claude-code",
      "cwd": "/path/to/project"
    }
  }
}
```

The `agent-vendor` key (illustrative) is whatever the underlying agent put in *its* `_meta` block — hydra forwards that through unchanged. Only the `acp-hydra` namespace is hydra's. The same shape applies to `session/attach` responses.

For resurrection, the shim sends `session/attach` with a resume hint nested in the same namespace:

```json
{
  "sessionId": "sess_abc123",
  "role": "controller",
  "historyPolicy": "pending_only",
  "_meta": {
    "acp-hydra": {
      "resume": {
        "upstreamSessionId": "u_xyz",
        "agentId": "claude-code",
        "cwd": "/path/to/project"
      }
    }
  }
}
```

## Install

```bash
npm install -g acp-hydra
```

## Quick start

```bash
# 1. Initialize: writes ~/.acp-hydra/config.json with a generated bearer token.
acp-hydra init

# 2. (Optional) Start the daemon. If you skip this step, the shim will
#    auto-start the daemon the first time an editor invokes it.
acp-hydra daemon start

# 3. Configure your editor to spawn `acp-hydra` instead of an agent directly.
#    The first session/new asks the daemon which agent to spawn (defaults to
#    config.defaultAgent). If you'd rather the editor pin a specific agent,
#    spawn `acp-hydra launch <agent-id>` (see "Launcher mode" below).

# 4. List live sessions.
acp-hydra sessions

# 5. Attach a second client (read-only) to an existing session.
acp-hydra --session-id sess_abc123 --role observer
```

## CLI

```
acp-hydra                                   # default: shim mode (stdio ACP agent)
acp-hydra launch <agent-id>                 # launcher mode: shim that forces the
                                            # daemon to spawn <agent-id> on session/new
acp-hydra --session-id <id> [--role ...]    # shim mode, attach to existing session
                                            # role: controller (default) | observer

acp-hydra init                              # generate config + auth token
acp-hydra daemon start [--port N] [--host H]
acp-hydra daemon stop
acp-hydra daemon status

acp-hydra sessions                          # list sessions
acp-hydra sessions kill <id>                # terminate a session

acp-hydra agents                            # list agents in the registry
acp-hydra agents install <id>               # pre-install an agent (else lazy on first use)

acp-hydra config                            # print resolved config path/values
```

The default invocation (`acp-hydra` with no subcommand and no positional args, or with only `--session-id`/`--role`) drops into **shim mode** — bridging stdin/stdout to the daemon's WSS endpoint. This is what editors invoke.

### Launcher mode

`acp-hydra launch <agent-id>` is a convenience for "shim me, and use *this* registry agent." It's the easiest way to wrap an existing ACP-speaking editor configuration whose agent-spawn surface is just a command and arguments:

```text
# Configure your editor's ACP-launch command to:
acp-hydra launch claude-code
```

When the editor sends `session/new`, the shim rewrites the params to `{ ..., agentId: "claude-code" }` before forwarding to the daemon. The daemon resolves `claude-code` against the cached ACP Registry, downloads/installs the agent on first use under `~/.acp-hydra/agents/`, and spawns the subprocess. The editor sees a normal ACP agent. From then on, `acp-hydra sessions` lists the live session and any other client can `session/attach` to it.

`<agent-id>` is the registry ID — e.g. `claude-code`, `gemini-cli`, `codex`. Run `acp-hydra agents` to browse what's available, or fetch the registry CDN URL directly.

If both `launch <agent-id>` and `--session-id` are given, `--session-id` wins (attach mode); the agent ID is ignored because the agent process is already running.

### Naming sessions from the editor

Set `ACP_HYDRA_NAME` in the environment when spawning the shim and the first `session/new` from that shim is labeled with the given name. The label flows through `_meta["acp-hydra"].name` on the wire, lands in `Session.title`, and shows up in `session/list` and `acp-hydra sessions`. Subsequent `session/new` calls from the same shim are not labeled — first one wins. The label survives daemon restart (it's carried in the resume hints).

Example for an editor that maps a buffer name to the env var:

```text
ACP_HYDRA_NAME="$BUFFER_NAME" acp-hydra launch claude-code
```

## Config

`~/.acp-hydra/config.json`:

```json
{
  "daemon": {
    "host": "127.0.0.1",
    "port": 8765,
    "authToken": "hyd_<random>",
    "logLevel": "info"
  },
  "registry": {
    "url": "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
    "ttlHours": 24
  },
  "defaultAgent": "claude-code"
}
```

The `authToken` is generated on `acp-hydra init` and required as `Authorization: Bearer <token>` for every REST call and as a WebSocket subprotocol or query parameter for `wss://.../acp`. Tokens never leave `~/.acp-hydra/`.

For remote access (binding to a non-loopback address), enable TLS via:

```json
{
  "daemon": {
    "tls": {
      "cert": "/path/to/cert.pem",
      "key": "/path/to/key.pem"
    }
  }
}
```

The daemon refuses to bind to non-loopback hosts without TLS configured.

## Disk layout

```
~/.acp-hydra/
├── config.json              # daemon config + auth token
├── daemon.pid               # PID + port lockfile (when running)
├── daemon.<N>.log           # rotated daemon logs (10 MB or daily, whichever first)
├── current.log              # symlink to the active daemon.<N>.log
├── registry.json            # cached ACP registry (24h TTL)
└── agents/
    └── <agent-id>/
        ├── meta.json        # registry entry snapshot
        └── ...              # agent-specific install (npx cache, binary, etc.)
```

Logs are also fanned out to stderr while the daemon is running. To follow live: `tail -F ~/.acp-hydra/current.log`.

## Wire protocol

The daemon's WSS endpoint follows the [Streamable HTTP & WebSocket Transport RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport):

```
GET /acp HTTP/1.1
Host: localhost:8765
Upgrade: websocket
Sec-WebSocket-Protocol: acp.v1, acp-hydra-token.<token>
```

Frames are JSON-RPC 2.0 text frames; binary frames are ignored.

The first JSON-RPC message a client sends is `initialize` (per ACP), or `proxy/initialize` if the client wants the daemon to act as a proxy in the proxy-chain sense (per RFD: proxy-chains).

### Methods implemented

Standard ACP:

- `initialize` — capability negotiation
- `session/new` — create a new session, spawning the requested agent
- `session/prompt` — controller-only when attached
- `session/cancel`

RFD additions:

- `session/attach { sessionId, role: "controller"|"observer", historyPolicy: "full"|"pending_only"|"none" }` — RFD #533
- `session/detach { sessionId }` — RFD #533
- `session/list { cwd?, cursor?, limit? }` — RFD: session-list
- `proxy/initialize` — RFD: proxy-chains

Capabilities advertised in the `initialize` response:

```json
{
  "agentCapabilities": {
    "promptCapabilities": {
      "image": true,
      "audio": true,
      "embeddedContext": true
    },
    "mcpCapabilities": {
      "http": true,
      "sse": true
    },
    "loadSession": false,
    "sessionCapabilities": {
      "attach": { "roles": ["controller", "observer"] },
      "list": true
    }
  }
}
```

Hydra is a transparent proxy for prompt content and MCP server configs — they're forwarded to the underlying agent unchanged — so the daemon advertises the union of relevant capabilities. The agent ultimately determines what it accepts. If an editor sends a content type the underlying agent rejects, the rejection surfaces as a normal ACP error from the agent, not a hydra-side error.

## REST API

All REST endpoints require `Authorization: Bearer <token>`.

```
GET    /v1/health                 # liveness
GET    /v1/sessions               # list sessions
POST   /v1/sessions               # create session (alternative to ACP session/new)
DELETE /v1/sessions/:id           # terminate
GET    /v1/agents                 # list known agents (registry + installed)
POST   /v1/agents/:id/install     # pre-install an agent
GET    /v1/registry               # current cached registry contents
POST   /v1/registry/refresh       # force refresh
```

Sessions are also reachable via `session/list` over ACP itself, for clients that prefer the protocol-native path.

## Security

The daemon exposes a process-management surface. Treat the auth token like an SSH key.

- **Default bind is `127.0.0.1`.** Cross-host access requires TLS + a strong token.
- **No anonymous access.** Every request — REST and WSS — must present the bearer token.
- **Token rotation:** `acp-hydra init --rotate-token` invalidates the old token; running clients are kicked.
- **Sandboxing is the user's responsibility.** Spawned agents inherit the daemon's filesystem and shell. Run the daemon under a restricted user or inside a container if you don't trust agents fully.
- **Subprocess scope:** agent processes inherit `cwd` and a sanitized environment. The daemon does not pass its auth token through to spawned agents.

## Registry entry mockup

If accepted, `acp-hydra` would land in the [ACP Registry](https://github.com/agentclientprotocol/registry) under either `agent.json` or `extension.json` (TBD with maintainers — likely `extension.json`, since hydra is a session-multiplexer rather than an LLM-backed coding agent).

```json
{
  "id": "acp-hydra",
  "name": "ACP Hydra",
  "version": "0.1.0",
  "description": "Multi-client session daemon. Spawn agents, attach over WSS, multiplex sessions across editors.",
  "authors": ["Steve Magnuson"],
  "license": "MIT",
  "icon": "icon.svg",
  "repository": "https://github.com/smagnuson/acp-hydra",
  "website": "https://github.com/smagnuson/acp-hydra",
  "distribution": {
    "npx": {
      "package": "acp-hydra",
      "args": []
    }
  },
  "capabilities": {
    "session": {
      "attach": { "roles": ["controller", "observer"] },
      "list": true,
      "proxy": true
    },
    "transport": {
      "stdio": true,
      "websocket": true
    }
  }
}
```

The accompanying `icon.svg` would be 16x16, monochrome `currentColor` per the [registry rules](https://github.com/agentclientprotocol/registry/blob/main/CONTRIBUTING.md).

## Status

This is an early experiment. See `CHANGELOG.md` for what's working today.

## License

MIT.
