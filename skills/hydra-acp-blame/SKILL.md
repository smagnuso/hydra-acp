---
name: hydra-acp-blame
description: |
  Cross-reference git history with hydra-acp session recordings to answer "how did this change get in / out". Pairs reflog + commit archaeology with `hydra session list` and `hydra session diff` to attribute each hunk to the session that authored it, or flag it as an orphan (edits that landed via `git commit -a` outside any recorded session).
  Activate when the user asks any of:
  - "how did this regression get in", "who reverted X", "these tests were passing before"
  - "which session made commit <sha>", "trace this change back"
  - "why does commit <sha> touch <file> when its message is about <other thing>"
  Also activate proactively when a suspicious hunk looks like a pure diff-inverse of an earlier commit, or when a commit's touched-file set doesn't match its stated message.
  Keywords:
  - hydra, hydra-acp, hydra session list, hydra session diff, hydra session info
  - git reflog, git blame, git stash, ORIG_HEAD, commit --amend
  - regression, revert, orphan hunk, accidental revert, working-tree drift
user-invocable: true
allowed_tools: Bash, Read, Grep
---

# hydra-acp-blame — attribute code changes to hydra sessions (or flag them as orphans)

Standard `git blame` tells you *what* commit changed a line. This skill tells you *which hydra session* (and by extension, which conversation / agent) produced that commit — and, critically, when the commit contains hunks that **no session authored**, points that out as evidence of a working-tree accident (e.g. a stale editor buffer scooped up by `git commit -a`).

## When it pays off

- The failing test was passing at a prior commit and the fix "looks like" a revert of an earlier commit — proves it and finds who did it.
- A commit's message doesn't cover all its file changes.
- You want to know which conversation introduced a helper / symbol before it was later removed.
- You suspect an unrecorded edit (editor buffer save, external tool, manual `git checkout <file>`) got folded into a session's commit.

## Data sources

| Source | What it tells you |
|---|---|
| `git log --oneline`, `git show --stat`, `git show <sha> -- <file>` | commits, their touched files, their diffs |
| `git reflog --date=iso` | resets, checkouts, stashes, amends, rebases — every HEAD move (local, ~90 days) |
| `git stash list` + `git stash show -p stash@{N}` | WIPs that might explain missing / extra state |
| `hydra session list --all --host all --include-non-interactive --columns=session,host,age,title,cwd` | every session — interactive + planner workers + imports from peer hosts. **Use these flags together for forensics**; the default `list` hides non-interactive sessions, imports, and older cold rows. |
| `hydra session diff <id>` | aggregate final-vs-initial diff for that session |
| `hydra session info <id>` | turn count, tool histogram, files touched, cost, synopsis |
| `~/.hydra-acp/sessions/<id>/meta.json` | title, cwd, agent, upstream id, timestamps, `importedFromMachine` (peer host), `interactive` (false for planner workers / `hydra cat`) |
| `~/.hydra-acp/sessions/<id>/history.jsonl` | full turn stream — grep for symbols, file paths, phrases |

`hydra session diff` shows the NET diff of a session, so a symbol introduced then removed in the same session won't appear. When the net-diff misses your symbol, fall through to `rg` on `history.jsonl` — the raw turn stream still has it.

## Workflow

Follow these in order; stop as soon as the attribution is unambiguous.

### 1. Frame the anomaly

Confirm the shape of the change. If tests are failing:

```bash
git log --oneline -20
git show <suspect-sha> --stat
git show <suspect-sha> -- <file>          # inspect actual diff
```

Ask: is this hunk a **pure inverse** of a prior commit's hunk? If yes, that's a "revert-shaped" hunk — strong signal the change came from stale on-disk content, not an intentional edit.

```bash
git show <good-sha> -- <file> > /tmp/good.diff
git show <bad-sha>  -- <file> > /tmp/bad.diff
# eyeball: do the +/- lines mirror each other?
```

### 2. Reflog first

```bash
git reflog --date=iso | head -30
```

Look between the "good" and "bad" commits for:
- `reset:` (especially `--hard` — can wipe working-tree edits)
- `checkout` of a single path
- `stash pop` / `stash apply`
- `commit (amend)` — the amend may be a *fix* commit that dropped hunks
- Long gaps with no activity — nothing git-visible touched the file in that window

### 3. Commit-vs-message audit

```bash
git show <sha> --stat
```

If the commit message describes work on file A but the stat also shows file B changed with a diff shape unrelated to A, that's the tell. Note: `.lock` files, generated files, and version bumps are noise — filter them out.

### 4. Session cross-reference (the hydra-specific step)

`hydra session list` **defaults hide two categories that regularly author commits** — turn both on for forensics:

- `--include-non-interactive` — surfaces planner workers, `hydra cat` one-shots, and other sessions that never had a user turn. Planner-driven multi-agent work lives here; without this flag, worker sessions that made real edits are invisible.
- `--host all` — includes sessions imported from other machines. If you might have made the edit on a laptop / peer host and it synced back, the authoring session lives under a different host and is filtered out by default (which is `--host local`).
- `--all` — drops the 20-session cold cap AND implies `--include-non-interactive`. Use when the commit is more than a few hours old.

Narrow to sessions in the same repo cwd, seeing everything:

```bash
hydra session list --all --host all --columns=session,host,age,title,cwd | rg "$(basename $PWD)"
```

Or a more targeted sweep when you know the window is recent:

```bash
hydra session list --include-non-interactive --host all --columns=session,host,age,title,cwd \
  | rg "$(basename $PWD)"
```

Cross-host authorship signal: the session's `meta.json` has `importedFromMachine` set when the session was created on a peer host. When the commit sha only makes sense as "made on my other machine", look for a session with `importedFromMachine` matching that host and a cwd that resolves to the same repo (path prefixes differ across machines — e.g. `/Users/...` vs `/home/...` — so match on the trailing repo path, not the full path).

For any session whose title / timing / host plausibly matches the commit message, get its aggregate diff:

```bash
hydra session diff <id> --no-pager --no-color | rg "^diff.*(<file>|<other-file>)"
hydra session diff <id> --no-pager --no-color | sed -n '<start>,<end>p'   # inspect specific range
```

If the session's diff touches the same files as the commit AND its title matches — that's the author. If the session touches only SOME of the commit's files, the rest are orphans (see step 6).

### 5. Grep sessions for symbols (net-diff blind spots)

When the net session diff misses the symbol you're tracking (introduced then removed, or edited only briefly):

```bash
rg -l "<symbol>|<phrase>" ~/.hydra-acp/sessions/*/history.jsonl
```

Cross-reference hits against session meta to find the one whose cwd + timing matches. `history.jsonl` records every tool call including intermediate file writes — a symbol that ever passed through a turn will appear here even if the final aggregate diff doesn't show it.

This grep scans **all** local session records regardless of interactive / host filtering, so it's the fastest way to catch planner workers and imported cross-host sessions in one shot. Match hits against `meta.json` fields (`cwd`, `importedFromMachine`, `agentId`, `interactive`) to characterize the author.

### 6. Timing correlation

Sessions' `history.jsonl` mtime = last activity. Compare against commit timestamps:

```bash
for f in ~/.hydra-acp/sessions/*/history.jsonl; do
  t=$(stat -c %Y "$f")
  # window: START_UNIX .. END_UNIX around the suspect commit
  if [ "$t" -ge <start> ] && [ "$t" -le <end> ]; then
    id=$(basename $(dirname $f))
    title=$(grep -m1 '"title"' $(dirname $f)/meta.json)
    echo "$t $id $title"
  fi
done | sort -rn
```

The session with mtime just BEFORE a commit's timestamp is the most likely author (unless the user committed hours after the session ended, which does happen).

### 7. Orphan detection

Sum up the set of files touched by every session in the commit's window. Subtract from the commit's file set. Anything left is orphaned — the commit swept up changes no session authored.

```bash
# files the commit touched
git show <sha> --stat --format= | awk '{print $1}' > /tmp/commit-files

# files any session in the window touched (aggregate)
: > /tmp/session-files
for id in <candidate ids...>; do
  hydra session diff $id --no-pager --no-color | rg -o '^diff .*a/(\S+)' -r '$1' >> /tmp/session-files
done
sort -u /tmp/session-files > /tmp/session-files.sorted

# orphans
comm -23 <(sort -u /tmp/commit-files) /tmp/session-files.sorted
```

Orphans typically come from:
- editor buffers that were open before an earlier commit modified the file on disk, then saved (overwriting) later
- `git checkout <path>` a user ran to experiment, then forgot
- other tools writing to the tree (formatters, codegen)
- a peer branch / worktree

### 8. Stash sanity check

```bash
git stash list
git stash show -p stash@{0}     # peek without popping
```

Stashes on top of relevant base commits sometimes hold the missing (or unwanted) delta.

## Output shape

Produce a short causal narrative, not a raw log dump:

1. **What broke** — the failing behavior + the hunk shape (revert / novel edit / mixed).
2. **Who committed it** — sha + commit message + author-session (or "no session — likely manual").
3. **Per-hunk attribution** — for each meaningful hunk in the commit, name the session that authored it or mark it ORPHAN with the most plausible cause.
4. **Timeline** — 5-10 lines: `HH:MM  event  (source: reflog | session <id> | stash)`.
5. **Fix suggestion** — usually one of: revert the orphan hunk, `git checkout <good-sha> -- <file>`, amend the offending commit.

## Anti-patterns

- **Don't run `hydra session list` without `--include-non-interactive --host all`.** The defaults hide planner workers (the actual authors of most parallel multi-agent work) and imported sessions from peer machines. Forensics needs every candidate visible.
- **Don't match on full path.** Cross-host cwd paths differ (`/Users/x/dev/foo` vs `/home/x/dev/foo`). Match on the repo-relative suffix.
- **Don't `git blame`-and-stop.** Blame reports the last-touching commit, which for a revert is the reverter — not the original author of the reverted logic. This skill is specifically for going deeper than that.
- **Don't trust commit messages alone.** The whole point is that a commit's diff can outrun its message.
- **Don't skip the reflog.** A missing session author + a `reset --hard` in the reflog usually means "user ran a git command manually."
- **Don't page interactively.** All the `hydra session *` commands accept `--no-pager --no-color` for scripting; use them so output is greppable.
- **Don't confuse aggregate diff with turn-level activity.** `hydra session diff` is a NET diff — it can hide symbols introduced and later removed within the same session. Fall through to `rg` on `history.jsonl` for those.

## Example (real one from this repo)

Symptom: 5 tests failing on HEAD; `matchOsc8At` helper was gone from `screen.ts` but the tests that depend on it were still present.

1. `git log --oneline` → the tests were added in commit A ("make sure to remove osc 8 control characters on highlight"). The screen.ts revert is in a later commit B ("skip synthesis when we are switching agents").
2. `git show B --stat` → touches `session-manager.ts` (+39, matches message) AND `screen.ts` (-89, +36, pure inverse of A). Mismatch → suspicion raised.
3. `git reflog --date=iso` → no `reset` / `checkout` between A and B; ~9-hour gap.
4. `hydra session list` filtered to cli/ → session with matching title made A. A different session ("fuzzy agent detection") made an intermediate commit; its `hydra session diff` shows it touched ONLY `session-manager.ts` — not screen.ts.
5. `rg -l matchOsc8At ~/.hydra-acp/sessions/*/history.jsonl` → only appears in the session that made A. No session in the window between A and B ever touched screen.ts.
6. Conclusion: screen.ts changes in B are ORPHANS. Cause: an editor buffer opened before A was saved after A, reverting on disk. `git commit -a` on the session-manager work scooped it up.
7. Fix: `git checkout A -- src/tui/screen.ts && git commit --amend` (or a follow-up commit). Tests go green.
