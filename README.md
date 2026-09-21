# noah-bring

Carry a [herdr](https://github.com/herdrdev/herdr) worktree space — the git worktree,
its branch, and the Claude Code session transcripts that were written inside it — from
one machine to another, open it as a herdr space there, and prove the crossing.

A copy moves bytes. A ferry verifies the far side: that the session is reachable,
intact, and resumable. `data-exists ≠ resume-reachable`.

## What it does

```
bring.sh preflight <host>              landing-zone facts; exits 3 if ghq roots differ
bring.sh list      <host>              every local worktree space + what <host> already holds
bring.sh check     <host> <slug>...    git state, sessions, agent idle?, rsync DRY-RUN
bring.sh ferry     <host> <slug>...    push branch, rsync, worktree add, direnv allow, herdr open
bring.sh verify    <host> <slug>...    the 4 locks + HEAD match + space id
bring.sh ledger    <host> <slug>...    a ledger, measured live
```

`SKILL.md` beside it is the agent-facing half: it tells Claude Code to run those
subcommands in order, show the human what each measured, and stop for a decision before
pushing branches or writing to the far host.

## The 4 locks

Copying files proves nothing. A ferried session is only landed when all four hold:

1. **No stray roots** — no path from the source machine's home survived the hop.
2. **cwd == worktree, and it exists** — the transcript's recorded cwd resolves on the far side.
3. **Tail intact** — each transcript's last record parses; a torn tail is silent until resume fails.
4. **Consumer content** — grep the far copy for a term only *that* work would produce. This one
   is deliberately manual: a script cannot pick a term that proves anything, and a generic word
   hits any transcript.

## Requirements

Both hosts must share a ghq root, because Claude Code encodes a session's project directory
from its cwd. Same root means the encoded directory is byte-identical and no path rewriting is
needed. `preflight` checks this and refuses otherwise.

Also needed on the far host: `herdr`, `claude`, `git`, `ghq`, `jq`, `rsync`, and ssh from here.

## Install

Copy `skills/noah-bring/` into `~/.claude/skills/`, or run `bring.sh` directly — it has no
dependency on the skill wrapper.

## Traps it routes around

Every one of these cost a real debugging session; they are written up in `SKILL.md`.

- **`herdr workspace create --cwd <repo>` does not bind the repo.** The space carries no
  worktree metadata, so a parent lookup by `repo_key` misses it and children opened under it
  never nest. The first `worktree open --trust-repository` binds it. Left unfixed, one loop
  produced three parents for one repo and zero nested children.
- **`workspace create` returns `.result.workspace.workspace_id`.** The obvious
  `.result.workspace_id` is `null`, which flows into `--workspace null` and fails silently.
- **Sidebar labels are not directory names.** Reproducing a layout means carrying labels.
- **`--ignore-existing` never repairs.** A transcript copied mid-write stays truncated forever,
  because the next run sees the file and skips it. So a `working` pane's session copy is
  deferred, while its worktree and space still cross.
- **Far-side tools live in `~/.local/bin`** and are invisible to a non-login `ssh host cmd`.
  Every remote call goes through `bash -lc`.
- **Retention deletes ferried files.** They arrive with old mtimes; a far host with the default
  `cleanupPeriodDays` removes them at next start. `preflight` prints the value.

## Status

Working prototype, exercised on three real crossings: five worktrees by hand, one driven
end-to-end by the script, then a full 21-worktree layout reproduction that surfaced the
parent-binding bug above.

## License

MIT

---

🤖 AI-generated (Rule 6)
