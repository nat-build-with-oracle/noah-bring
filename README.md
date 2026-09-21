# noah-bring

Carry a [herdr](https://github.com/herdrdev/herdr) worktree space — the git worktree,
its branch, and the Claude Code session transcripts that were written inside it — from
one machine to another, open it as a herdr space there, and prove the crossing.

A copy moves bytes. A ferry verifies the far side: that the session is reachable,
intact, and resumable. `data-exists ≠ resume-reachable`.

## What it does

```
bun bring.ts preflight <host>              landing-zone facts; exits 3 if ghq roots differ
bun bring.ts list      <host>              every local worktree space + what <host> already holds
bun bring.ts check     <host> <slug>...    git state, sessions, agent idle?, rsync DRY-RUN
bun bring.ts ferry     <host> <slug>...    push branch, rsync, worktree add, direnv allow, herdr open
bun bring.ts verify    <host> <slug>...    the 4 locks + HEAD match + space id
bun bring.ts ledger    <host> <slug>...    a ledger, measured live
```

Installed as a **maw plugin**, so the above is also `maw noah preflight <host>` and so on.
Symlink the checkout into `~/.maw/plugins/noah` and edits are live with no install step.

TypeScript on [Bun](https://bun.sh), using `Bun.$` for every shell call. `bring.sh` is the
superseded shell original, kept beside it for reference. Each subcommand opens ONE ssh
connection covering all slugs: 8 calls as 8 ssh invocations measured 1.305s, the same 8
inside one ssh measured 0.174s.

`SKILL.md` beside it is the agent-facing half: it tells Claude Code to run those
subcommands in order, show the human what each measured, and stop for a decision before
pushing branches or writing to the far host.

## Ferry copies. Handoff moves.

`ferry` leaves the worktree open on both machines. That is right for carrying history, and
wrong for carrying WORK: two machines holding one branch with an agent on each other's stale
code is the failure mode.

```
bun src/index.ts send   <host> <slug>...   commit, push, carry sessions, open there, close HERE
bun src/index.ts recall <host> <slug>...   commit+push there, pull here, open here, close THERE
bun src/index.ts owner  <host> <slug>...   who holds it now, plus the handoff history
```

Ownership is an **append-only git tag**, `noah-owner/<slug>/<stamp>-<host>`, never a moved
ref. Newest tag wins, nothing is force-pushed, and the full trail of who held it survives.
`owner` reports `OPEN ON BOTH` when the invariant is broken.

`send` refuses to act while an agent is mid-turn, refuses `main`, and closes the local space
**last** — only after the far side is proven open. The checkout stays on disk, so the branch
and the work remain recoverable; only the herdr space moves.

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

- **Scope worktree calls with `--cwd <repo>`, and the parent problem disappears.** herdr
  resolves the repo's parent workspace itself, creating and binding it as needed. Omitting
  `--cwd` falls back to the *active* workspace, which errors `linked_worktree_source` whenever
  that happens to be a worktree. Managing the parent by hand instead (`workspace create`, then
  a lookup by `repo_key`) produces one duplicate parent per child and zero nesting, because a
  space made by `workspace create --cwd` carries no worktree metadata at all until a
  `--trust-repository` open binds it. None of that code needs to exist.
- **ssh does not preserve argv.** It joins its command arguments with spaces and hands one
  string to the far shell, which re-splits it. `ssh host bash -lc "$script"` therefore runs
  only the script's first word under `-c`. Quote the whole remote command into one word.
- **Each herdr session has its own socket.** `herdr workspace list` sees only the one it is
  pointed at; on one machine here the default socket held 37 of 44 workspaces. Read the
  default plus every `sessions/*/herdr.sock`.
- **One cwd can hold several panes.** If any pane there is mid-write the directory is unsafe
  to copy, so the busiest status has to win over the first one found.
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
