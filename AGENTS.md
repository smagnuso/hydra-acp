# AGENTS.md

Brief for AI agents working in this repo.

## What this is

`hydra-acp` — the daemon, CLI, and TUI at the center of the Hydra ecosystem.
It's a multi-client session manager for the [Agent Client Protocol
(ACP)](https://agentclientprotocol.com/): one daemon spawns and owns the real
ACP agent processes (Claude Code, Codex, Gemini, …); many clients (editor
shims, TUI, browser, Slack bridge) attach over WSS and see the same live
session.

This repo is the hub. All the sibling `hydra-acp-*` repos are either
**extensions** (clients that attach over WSS) or **transformers** (middleware
that intercept the daemon's message pipeline). They depend on the surfaces
defined here; changes to those surfaces belong in this repo.

## Source of truth for the wire protocol

`PROTOCOL.md` is authoritative for:

- REST management API at `/v1/*`
- ACP WebSocket at `/acp` (standard ACP + hydra-specific extensions:
  `session/attach`, `session/detach`, prompt queue, stdin streaming,
  attention flags, MCP-tool/command registration, transformer plumbing)
- Agent-facing MCP at `/mcp/*`

Read `PROTOCOL.md` before changing anything in `src/daemon/` or `src/acp/`.
If you extend the protocol, update `PROTOCOL.md` in the same change.

## Layout

- `src/cli.ts`, `src/cli/` — CLI verb dispatch (`daemon`, `session`,
  `extension`, `transformer`, `agent`, `auth`, `init`, …)
- `src/daemon/` — the daemon itself: HTTP/WS server, session manager,
  broadcast, extension/transformer lifecycle
- `src/acp/` — ACP JSON-RPC wire types and framing
- `src/shim/` — the stdio-to-WSS shim (`hydra-acp shim`, `hydra-acp launch`)
- `src/tui/` — the interactive terminal UI
- `src/core/` — shared plumbing (config, paths, token store, registry cache)
- `examples/` — reference implementations of extensions and transformers
  (`client-observe.mjs`, `transformer-observe.mjs`, `transformer-edit.mjs`,
  `transformer-lifecycle.mjs`) — keep these working; sibling repos read them

## Build & test

```
pnpm install
pnpm build        # tsup → dist/
pnpm typecheck
pnpm test         # vitest
pnpm dev          # watch
```

Ships two bins: `hydra-acp` and `hydra` (both dispatch to `dist/cli.js`).

## Seeing the TUI

Agents changing `src/tui/` are otherwise blind to the result.
`scripts/tui-capture.mjs` renders a terminal program headlessly and turns the
screen into an SVG, so you can look at what you changed instead of guessing.

```
# spawn, drive to a state, capture — no human in the loop
node scripts/tui-capture.mjs --cols 100 --rows 30 --keys 'C-p' \
  --out /tmp/shot.svg -- hydra-acp tui --session <id> --readonly

# or grab a pane a human is already driving
node scripts/tui-capture.mjs --list-panes
node scripts/tui-capture.mjs --pane <target> --ansi /tmp/raw.ansi --out /tmp/shot.svg
```

To actually *see* it, rasterize and read the PNG — an SVG on disk tells you
nothing:

```
google-chrome --headless --disable-gpu --screenshot=/tmp/shot.png \
  --window-size=900,520 /tmp/shot.svg
```

`--ansi` writes the raw capture alongside, which is what to grep when you want
to assert on content rather than eyeball it. `--from <file>` re-renders an
existing capture without re-running anything. `--record` samples over time into
one animated SVG.

Before trusting a capture:

- **tmux withholds truecolor** unless `default-terminal` is off `screen*` with
  the RGB terminal-feature set. `theme/capability.ts` does this deliberately,
  reading a changed TERM as the signal that passthrough was configured on
  purpose, so an unconfigured tmux yields a faithful capture of a 256-colour
  downgrade rather than of the real theme.
- `--record` is a flipbook, not a recording. It polls, so anything between two
  samples is never seen, and each distinct frame is a full copy (~3.6 KB per
  second per fps on a busy screen). 6-10 fps is the useful range.
- A terminal outside tmux cannot be captured at all. A pty has no screen
  buffer; the grid lives in the emulator's memory.

## Conventions

- TypeScript, ESM, tsup for bundling, vitest for tests.
- The daemon runs long-lived; be careful with unhandled rejections and
  event-listener leaks. Every WS attach must have a matching detach path.
- REST and WSS both require the bearer token from `~/.hydra-acp/auth-token`;
  don't add anonymous endpoints.
- Extensions and transformers get **per-process scoped tokens** — treat both
  as trusted compute, but note that transformer-kind tokens unlock methods
  that extension-kind tokens must not reach (`MethodNotFound` otherwise).
- Config in `~/.hydra-acp/config.json` is safe to version-control; the token
  is not and lives in a separate 0600 file.
- Cross-repo changes: if you break an extension or transformer, update the
  matching sibling repo in the same PR sweep.

## Gotchas

- `session/attach` broadcast: every event goes to every attached client;
  permission requests race (first response wins). Don't accidentally reply
  twice.
- Session idle timeout closes quiet sessions after 1h by default —
  observer-shaped extension traffic (attach/detach, snapshot pings) doesn't
  count as activity. Test extension behavior across a timeout cycle.
- The WSS endpoint only implements the WebSocket profile of the transport
  RFD, not Streamable HTTP. Don't add HTTP-transport methods without
  revisiting the RFD status.
- `session/load` (resurrection) synthesizes a takeover transcript for the
  new agent — the original agent's internal tool-chain state is lost. Any
  feature that assumes continuity of internal state will misbehave here.
- **Permission-race abstention semantics**: a client returning
  `-32601 MethodNotFound` on a broadcast permission request is treated as
  *abstention*, not a vote (`daemon/session.ts`). Any client that sends a
  real error code will settle the race and poison the vote. If you touch
  approver/browser/notifier response paths, respect this.
- **Queue-store persists prompts before invocation** (`queue-store.ts`
  spec at top of file). A crash mid-turn *loses* the prompt; the tradeoff
  is deliberate — inverting to log-then-run would double-fire on crash.
- **Per-process token identity gates transformer-only methods**
  (`acp-ws.ts` transformer method registration). The `ProcessTokenRegistry`
  is what makes extension-vs-transformer kind gating real; without it,
  everything resolves to the service token and gating silently disappears.
  Tests that skip the registry will pass but the production behavior is
  different.
- **Attach has three modes, not two**: warm-attach, cold-resurrect, and a
  read-only viewer path that returns an entry with no live `Session`
  object. Detach paths must tolerate `session?.detach(...)` being
  undefined.
- **`route: "queue"` chain skip is by transformer *name***. If you split
  one transformer into two names, the second one will still re-intercept
  the first's emits.
- **The daemon owns session records; nothing else may write one.**
  Mutating a session means `PATCH /v1/sessions/:id` (title, priority,
  `workspace: null`, …) dispatched to a `SessionManager` method that
  handles warm and cold uniformly — see `setPriority` /
  `clearWorkspaceBinding`. A direct `meta.json` write is wrong even when
  the daemon looks idle, for two independent reasons: a live session
  holds the record in memory and rewrites it, so the edit is silently
  reverted; and `mutateRecord` serializes through `enqueueMetaWrite`, a
  queue an outside writer cannot join, so even a cold-session write can
  interleave with a rotation. Probing "is it live first?" is not a fix,
  because the answer can change between the probe and the write.
  `src/cli/commands/workspaces.ts` reads records straight off disk on
  purpose (diagnosis has to work with the daemon down); that asymmetry is
  deliberate. Read locally, write through the daemon.
- **`usage_update` is broadcast but never recorded.** `STATE_UPDATE_KINDS`
  (`core/session.ts`) filters it out of `recordAndBroadcast`, and the daemon
  writes its own snapshot at each turn boundary instead. So a signal that
  rides `usage_update` reaches attached clients but is **invisible in
  `history.jsonl`**. Do not conclude a wire field is absent because history
  lacks it — attach a WS observer instead (`examples/client-observe.mjs`).
  This is a live trap: the same reasoning produced a confidently wrong
  conclusion mid-investigation, because the only `usage_update` rows on disk
  are hydra's own and they carry no agent `_meta`.
- **The agent-initiated turn boundary is `_meta["_claude/origin"]`, and it
  is authoritative.** claude-acp stamps every SDK `result` it forwards with
  the lane that produced it. A `kind` in {`task-notification`, `peer`,
  `coordinator`, `observer`, `observer-activity`} means the model finished
  something it started on its own, and ends the turn. `kind: "human"` rides
  the same carrier for the user's own turns and must **never** be read as
  one, or every agent-initiated turn closes the instant any user turn ends.
  Mirrors `AUTONOMOUS_RESULT_ORIGINS` upstream; unknown kinds fall to the
  user lane, matching that adapter's fail-open default. There is deliberately
  no timer fallback — see `autonomousTurnTerminal`.
- **`Session.cancel()` must close an open `unsolicitedTurn`.** An
  agent-initiated turn has no `session/prompt` to settle, so nothing
  downstream will ever close it: the agent interrupts its query but owes no
  response, and no `turn_complete` is due. Without that explicit close, `^C`
  is a **guaranteed no-op for every turn the agent starts by itself** —
  measured as the agent publishing its terminal at T+2s, a cancel at T+5s
  doing nothing, and the turn surviving to T+92s. The TUI cannot compensate:
  its escalation ladder lives inside `turnInFlight`, which is null for any
  turn this client did not originate.

## Updating this file

If you discover a durable, non-obvious invariant while working here — the
kind of thing you wish had been in this file when you started — flag it
in your final turn summary so the human can decide whether to add it. Do
not silently edit AGENTS.md mid-task. Prefer additions to `## Gotchas`
over reworking existing sections; never delete a gotcha without checking
that the underlying invariant is actually gone.
