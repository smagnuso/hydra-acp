---
name: hydra-acp-blame
description: |
  Activate this skill whenever the user is trying to figure out why code that used to work is now broken, or asks any question that reduces to "how did this change land". Pairs git reflog + commit archaeology with `hydra session list` + `hydra session diff` to attribute each hunk to the session that authored it — or flag it as an orphan (edits that landed via `git commit -a` outside any recorded session).

  Activate on any of these user phrasings (verbatim examples — plus obvious paraphrases):
  - "help me understand how this broke", "how did this break", "how did this get broken"
  - "this used to work", "this was passing before", "these tests were passing"
  - "how did this regression get in", "who broke this", "why is this failing now"
  - "who reverted X", "trace this change back", "which session made commit <sha>"
  - "why does commit <sha> touch <file> when its message is about <other thing>"
  - Any test-failure paste (Vitest / Jest / Mocha / pytest / cargo test output) accompanied by a "how did this" / "why is this" / "what broke" question — the failing tests are the anomaly, and this skill is the tool for locating its origin.

  Also activate proactively (without an explicit prompt) when:
  - A suspicious hunk looks like a pure diff-inverse of an earlier commit.
  - A commit's touched-file set doesn't match its stated message.
  - `git blame` on a failing line lands on a commit whose message is unrelated to the code being blamed.

  Keywords:
  - hydra, hydra-acp, hydra session list, hydra session diff, hydra session info
  - git reflog, git blame, git stash, ORIG_HEAD, commit --amend
  - regression, revert, orphan hunk, accidental revert, working-tree drift
  - test failure archaeology, "used to work", "was passing"
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

`hydra session diff` shows the NET diff of **agent tool-recorded edits only**. It will miss:

- Files edited by the user manually outside any recorded tool (e.g. via their editor, hand-typed `git commit -a`, or a shell command outside a `tool_call` — extremely common when the user is "driving" and the agent is a passenger).
- Symbols introduced then removed in the same session (net-diff cancellation).
- Changes routed through a subagent, another session, or a background process.

**When session-diff attribution comes up empty, DO NOT conclude "no session did it".** The session that was active in the same cwd at the commit timestamp is very likely still the author — the human sitting in that session made the edit themselves and their `git commit` timestamp landed inside its lifetime. Fall through to `rg` on `history.jsonl` (Step 5) and the timing correlation (Step 6); those catch what the aggregate diff hides.

## Workflow

Follow these in order; stop as soon as the attribution is unambiguous.

### 0. Resolve cwd mismatch first

If the test output / diff references paths that don't exist under the current working directory, **do NOT ask the user which repo they meant** — that just re-asks them to do the routing your tools can do. Instead:

```bash
rg --files -g '<basename>' ~ 2>/dev/null | head
# Or, if lsdev is installed:
lsdev.pl -l src path:<repo-name-fragment>
# Or — the session list itself surfaces every cwd hydra has ever run in:
hydra session list --all --host all --columns=cwd | sort -u | rg '<repo-fragment>'
```

Once located, `cd` there (or run every subsequent `git` / `hydra session diff` with `-C <repo>` / `workdir`), and continue. This step unblocks the common "the user pasted test output from a different terminal" case.

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

### 5. Grep sessions for the file path AND the symbol (net-diff blind spots)

Search `history.jsonl` for BOTH the file basename and any distinctive symbol from the change — either can hit while the net diff shows nothing:

```bash
rg -l "<file-basename>|<Symbol>|<phrase>" ~/.hydra-acp/sessions/*/history.jsonl
```

Then for each hit, characterize the involvement:

```bash
for f in <matching history.jsonl files>; do
  id=$(basename $(dirname $f))
  grep -m1 '"title"\|"cwd"\|"importedFromMachine"' $(dirname $f)/meta.json
  rg -c '"kind":"edit".*<file-basename>|"kind":"write".*<file-basename>' "$f"  # agent edited
  rg -c '<file-basename>' "$f"                                                  # any mention
  stat -c 'mtime %Y' "$f"
done
```

Interpretation:

- **agent-edit count > 0** → an `Edit` / `Write` tool call in this session modified the file. Strongest possible attribution.
- **agent-edit count = 0 but general mentions > 0** → the file was discussed, read, or pasted (test output, diff), but the edit itself happened outside recorded tools. This is the **"user drove, agent watched"** pattern — the session is *still the likely author*, just via the human typing into a terminal instead of the agent invoking `Edit`. Commit was probably `git commit -m ...` in the user's terminal after they saved from their editor.
- **general mentions = 0** → not this session.

This grep scans **all** local session records regardless of interactive / host filtering, so it's the fastest way to catch planner workers and imported cross-host sessions in one shot.

### 6. Timing correlation (the load-bearing signal when session-diff misses)

When step 4 turned up no session claiming the file in its aggregate diff, timing usually settles it: **the session whose `history.jsonl` mtime brackets the commit timestamp in the same cwd is the author**, even if `hydra session diff` shows nothing about the file.

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
- **Don't confuse aggregate diff with turn-level activity.** `hydra session diff` is a NET diff of tool-recorded edits — it hides (a) symbols introduced then removed in the same session, and (b) all edits the human made outside recorded tools. Fall through to `rg` on `history.jsonl` for those.
- **Don't declare "no session authored this" from a session-diff miss alone.** Combine session-diff with `rg` on history.jsonl AND timing + cwd correlation. A session with 0 tool-recorded edits to a file but whose lifetime brackets the commit timestamp in the same repo is almost always the author — via the human, not the agent.

## Examples (real ones from this repo)

### Example 1 — user made the edit manually inside a live session

Symptom: 3 tests failing in `restart-breaker.test.ts` and `extensions.test.ts`; expectations look wrong-by-one.

1. `git log --oneline -- src/core/restart-breaker.ts` → commit `24f65a8 "do things"` is the most recent touch.
2. `git show 24f65a8` → a single-line change: `>` → `>=` in `recordExit`. Off-by-one matches the failure shape.
3. `hydra session list --all --host all --columns=session,age,cwd` filtered to `hydra-acp/cli` → session `rT3amMavMOadwOPA` was active around the commit time.
4. `hydra session diff rT3amMavMOadwOPA` → shows `SKILL.md` and `screen.ts`. **Does NOT show restart-breaker.ts.** ← naive stop-point.
5. `rg -c '"kind":"edit".*restart-breaker' ~/.hydra-acp/sessions/hydra_session_rT3amMavMOadwOPA/history.jsonl` → 0. `rg -c restart-breaker <same>` → 24 (test-output paste, discussions, diagnostic reads). "User drove, agent watched" pattern.
6. Timing: session mtime ≈ commit timestamp, same cwd, matching pasted test output.
7. Attribution: session rT3amMavMOadwOPA is the author. The edit itself was made **by the human in the terminal running that session** (or via an editor while that session was open); the agent didn't invoke `Edit`. Session diff missed it because tool-recorded edits are a strict subset of all edits.

Lesson: `hydra session diff` empty ≠ session didn't author. Check the agent-edit-count vs general-mention split, then timing + cwd.

### Example 2 — accidental revert scooped up by `git commit -a`

Symptom: 5 tests failing on HEAD; `matchOsc8At` helper was gone from `screen.ts` but the tests that depend on it were still present.

1. `git log --oneline` → the tests were added in commit A ("make sure to remove osc 8 control characters on highlight"). The screen.ts revert is in a later commit B ("skip synthesis when we are switching agents").
2. `git show B --stat` → touches `session-manager.ts` (+39, matches message) AND `screen.ts` (-89, +36, pure inverse of A). Mismatch → suspicion raised.
3. `git reflog --date=iso` → no `reset` / `checkout` between A and B; ~9-hour gap.
4. `hydra session list` filtered to cli/ → session with matching title made A. A different session ("fuzzy agent detection") made an intermediate commit; its `hydra session diff` shows it touched ONLY `session-manager.ts` — not screen.ts.
5. `rg -l matchOsc8At ~/.hydra-acp/sessions/*/history.jsonl` → only appears in the session that made A. No session in the window between A and B ever touched screen.ts through recorded tools.
6. Conclusion: screen.ts changes in B are ORPHANS. Cause: an editor buffer opened before A was saved after A, reverting on disk. `git commit -a` on the session-manager work scooped it up.
7. Fix: `git checkout A -- src/tui/screen.ts && git commit --amend` (or a follow-up commit). Tests go green.
