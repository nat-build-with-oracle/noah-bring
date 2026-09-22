---
name: noah-bring
description: "Carry herdr worktree spaces and their Claude sessions from this machine to another host (e.g. user@far-host), open them as herdr spaces there, and PROVE the crossing with the 4 locks — interactively, the human picks from a list. Use when the user says 'noah bring', 'maw noah bring', 'bring X up to <host>', 'ferry these worktrees to <host>', 'ขน worktree ไป <host>', or names herdr spaces plus a host. Same-ghq-root hops only (both hosts share one ghq root, e.g. /opt/Code). Do NOT use when the ghq roots differ or paths must be rewritten (use /noah), to move a session INTO herdr on this machine (use /herdr-bring), or for a plain file copy with no resume semantics."
---

# /noah-bring — pick, cross, prove 🛶

> A ferry is not a copy. A copy moves bytes; a ferry **verifies the crossing** — that the
> session is reachable, intact and resumable on the far shore. `data-exists ≠ resume-reachable`.

Everything mechanical is a **maw plugin**: `maw noah`. The source is `src/index.ts` in this
repo, symlinked into `~/.maw/plugins/noah`, so edits are live with no install step.
`bring.sh` is the superseded shell original, kept for reference; do not edit it. The agent's job is to run the
subcommands **in order**, show the human what each one measured, and **ask before the two
irreversible-ish steps** (pushing branches, writing to the far host). Never reconstruct a step
by hand when a subcommand exists for it.

```
SCRIPT="maw noah"
$SCRIPT preflight <host>              landing-zone facts; exits 3 if ghq roots differ
$SCRIPT list      <host>              every local worktree space + what <host> already holds
$SCRIPT check     <host> <slug>...    git state, sessions, agent idle?, rsync DRY-RUN
$SCRIPT ferry     <host> <slug>...    push branch, rsync (merge-safe), worktree add, direnv allow, herdr open
$SCRIPT verify    <host> <slug>...    locks 1–3 + HEAD match + space id
$SCRIPT ledger    <host> <slug>...    ledger markdown — table, locks, dirty list, all live

A **ferry is a COPY** — both machines keep the space. A **handoff is a MOVE**:

```
$SCRIPT send      <host> <slug>...    commit, push, carry sessions, open there, close HERE
$SCRIPT recall    <host> <slug>...    commit+push there, pull here, open here, close THERE
$SCRIPT toggle    <host> <slug>...    flip it to the other side — here goes there, there comes back
$SCRIPT owner     <host> <slug>...    who holds it now, plus the handoff history
```

Use `send`/`recall` when the work should exist in ONE place — two machines holding one branch
with an agent on each is the failure these prevent. Ownership is an append-only git tag
(`noah-owner/<slug>/<stamp>-<host>`), never a moved ref, so the trail of who held it survives
and no force-push is ever needed. `owner` says `OPEN ON BOTH` when the invariant is broken.

Every subcommand opens ONE ssh connection covering all slugs. Measured on this pair: 8 calls
as 8 ssh invocations took 1.305s, the same 8 inside one ssh took 0.174s.
```

`<host>` is `user@hostname` exactly as ssh takes it. `<slug>` is a **herdr workspace label**
(the sidebar name), not a repo name — the human's shorthand ("haos", "grokbridge", "big boss")
maps to labels via `list`, never to `ghq` dirs by guessing.

## The interactive loop — follow it exactly

### 1. Preflight, then show the verdict

```bash
$SCRIPT preflight user@far-host
```

Show the human the whole block. If it ends in `STOP` (ghq roots differ), stop — this skill
cannot rewrite `cwd`; say so and point at `/noah`. Also surface, in one line each, anything
that reads `MISSING`, `ABSENT` or `NOT-INSTALLED`, and a retention value under 3650.

### 2. List, then let the human pick

```bash
$SCRIPT list user@far-host
```

Columns: `ws label agent sess local-files remote remote-files`. Present it as-is (it is already a
table), then **AskUserQuestion, multiSelect**, one option per row that is *plausible*:

- include rows the human named, plus any row with `agent` ≠ `working` and `sess` > 0
- mark rows already `sess` on the remote as "(already there — merge-safe top-up)"
- leave out rows with `sess 0 local-files 0` unless the human named them
- if the human's words match nothing, say which labels came closest and ask — do not pick

Never auto-select. The list is the menu; the human chooses.

### 3. Check the picks, then confirm

```bash
$SCRIPT check user@far-host <slug> <slug> ...
```

Show every block. Then read it for the human and state, per slug:

- `agent` — `working` or `blocked` means the transcript is mid-append. `ferry` will still push
  the branch, add the worktree and open the space (so the far layout is complete), but it
  **defers the session copy** for that slug and says so. Re-run `ferry` for it once idle;
  `--ignore-existing` makes the top-up safe. `idle`, `done` and `none` are all quiescent.
- `branch … upstream=NO-UPSTREAM` — ferry will `git push -u origin <branch>`; say so
- `dirty` lines — these do **not** cross; if one is `.envrc`, say it may hold tokens and stays local
- `rsync DRY-RUN … transferred: N` — the exact file count and bytes that will move
- `remote repo:ABSENT` — ferry will `ghq get` the repo on the far host first

Then **AskUserQuestion**: *"Cross these N now? (push feature branches + rsync + worktree +
herdr space on <host>)"* with options **Go** / **Go, but skip <slug>** / **Abort**. Do not
proceed on silence.

### 4. Ferry

```bash
$SCRIPT ferry user@far-host <slug> ...
```

Per slug it prints `push`, `rsync`, `worktree`, `direnv`, `space`. Refusals are printed with
`!!` and the slug is skipped, not failed:

- `!! agent is 'working'` — pane went busy between check and ferry; re-run later
- `!! branch is main` — never pushes main from a worktree
- `linked_worktree_source` in `space` — the far host's parent space for that repo was not
  found; the script creates one and retries, but if it still shows, read the parent with
  `ssh <host> 'bash -lc "herdr workspace list"'` and report

Idempotent: re-running on a crossed slug prints `Everything up-to-date`, `transferred: 0`,
`already present`, `already open`.

### 5. Verify — the 4 locks, and say them by name

```bash
$SCRIPT verify user@far-host <slug> ...
```

- **L1 stray-cwd = 0** — no `cwd` still points at this machine's home
- **L2 PASS** — jsonl `cwd` equals the far worktree path *and* that path exists
- **L3 OK** on every top-level jsonl — a `TORN` tail means the copy caught a write; wait for
  idle, delete that one file on the far side, re-run `ferry`
- **HEAD MATCH** — same commit both sides
- **L4 consumer content** — the script cannot pick the term; you must. Open the local
  transcript's first user turn (`relic tail <id> -n 1` or `head -c 4000 <jsonl>`), choose a
  word only that work would contain (a subagent name, a file it created, a Thai phrase), and
  run the printed `grep -l` on the far host. **Count ≥ 1 is the proof.** "N files landed" is
  not proof; "the session that remembers X opened" is.

Report all four per slug. One failed lock = not done; say which and why.

### 6. Ledger — mandatory

```bash
$SCRIPT ledger user@far-host <slug> ... > ψ/ferry-ledger/$(date +%F)_<what>-to-<host>.md
```

The table, the **Locks** block and the **Not crossed** list are measured live — `ledger` re-runs
`verify` and re-reads `git status`, so there is nothing to paste by hand.

Two things are still yours:

- **L4** — pick a term only THIS work would produce (the app it built, the bug it chased), run
  the grep the file prints, and paste the result. A generic word hits on any transcript and
  proves nothing, which is why the script refuses to guess one.
- **Traps hit** — anything that surprised you.

Leave it uncommitted unless asked; tell the human the path. A crossing without a ledger entry
did not happen.

### 7. Final report to the human

One table: `ask → label → far space id → files/bytes → locks 4/4`. Then, verbatim:

- the far panes are **bare shells** — `claude --resume` in each lists the ferried session; you
  did not start agents (that is a cost the human decides)
- what stayed behind (`.envrc`, anything `!!`-skipped)
- the far repo's `main ↓N` if `list`/screenshot showed it behind — untouched

## Hard rules

- **Merge-safe only.** `rsync --ignore-existing` is baked in; never add `--delete`, never drop
  the flag "to be sure". The far host may be the *richer* side (in the first crossing it held
  129 + 181 transcripts for one slug against 1 + 1 on the near side) — a bare `rsync -a` would still be safe, but `--delete` erases
  the richer copy.
- **Never push `main`, never `--force`, never `--amend`.** Feature branches only, and only
  because the far host needs the branch to cut the worktree.
- **Never copy a `working`/`blocked` pane's session.** A torn tail is silent until `/resume`
  fails, and under `--ignore-existing` the torn copy is permanent — a later run skips it as
  "already there". That is why the script defers rather than risks it.
- **Never ferry `.envrc`** or any dirty file by hand. Show it; the human recreates it.
- **Never guess a slug from a nickname.** `list` is the resolver. The first attempt at this
  task guessed `haos-oracle`, `omx-grokbot`, `oracle-skills-cli` — all wrong; every target was
  a worktree of one repo, not separate repos.
- **Never `sleep`-poll** waiting on a pane. Use `herdr events.wait`, or hand the wait to a
  herdr pane (`/herdr-pane-run`).

## Traps this skill already routes around (so you recognise them if they surface)

- Far host's `herdr`, `claude`, `maw` live in `~/.local/bin` — invisible to a non-login
  `ssh host cmd`. Every remote call goes through `bash -lc`. A far-side `~/.profile` that
  prints noise on login is filtered out.
- **ssh does not preserve argv.** It joins its command arguments with spaces and hands ONE
  string to the far shell, which re-splits it. So `ssh host bash -lc "$script"` runs only
  the script's FIRST WORD under `-c`; the rest executes in the outer login shell with the
  second word as `$0`. The whole remote command has to be quoted into one word before it is
  handed to ssh. Passing the script as its own argv entry looks right and is not.
- **One cwd can hold several panes.** Ours holds a claude and a codex. If any pane there is
  `working` or `blocked` the project dir is unsafe to copy, so the busiest status decides —
  taking the first match can report `idle` for a directory another pane is appending to.
- **Each herdr SESSION has its own server and socket**, and `herdr workspace list` only sees
  the one it is pointed at. Measured: the default socket held 37 workspaces on a machine
  with 44. The resolver reads the default socket plus every `sessions/*/herdr.sock`, and
  skips the ones whose server is gone.
- `herdr worktree open --path X` fails with `linked_worktree_source` unless `--workspace`
  names the repo's **parent** space. The script finds it by `worktree.repo_key == <repo>/.git`,
  then by label, then creates it.
- **A parent made by `herdr workspace create --cwd <repo>` is not bound to the repo.** It has
  no `.worktree` block, so a lookup by `repo_key` misses it and children opened under it do not
  nest. The first `worktree open --workspace <it> --trust-repository` binds it; after that every
  child nests. Measured on herdr 0.9.0: the unfixed loop produced three `nexus-oracle` parents
  and zero nested children. `workspace create` also returns `.result.workspace.workspace_id`,
  not `.result.workspace_id` — the wrong path yields `null` and `--workspace null` fails silently.
- **Sidebar labels are not directory names.** `homekeeper-oracle` for `homelab`, `glyph` for
  `glyph-oracle`. A layout is labels; carry them, do not derive them from `basename`.
- Fresh worktrees block on `direnv: .envrc is blocked`. The script runs `direnv allow` after
  `worktree add`. An `.envrc` that reads a token from a password store needs that entry on the
  far host too; without it `claude` there starts unauthenticated.
- `ghq list` on a large tree takes > 120 s. The script never calls it; `ls -d "$(ghq root)"/github.com/*/<name>*` is instant if you need a repo path.
- `maw herdr ls` (pretty) hides `checkout`; `--json` has it — maw-herdr-plugin#56.
- Retention: ferried files carry old mtimes; a far host with default `cleanupPeriodDays` (30)
  silently deletes them on `claude` start. `preflight` prints both values; anything under
  3650 → set it in **both** `~/.claude/settings.json` and `~/.claude.json` before step 4.

## Provenance

Built 2026-09-22 from the first crossing: 5 worktrees by hand, then 1 driven by the script
(the first real test of it), then a full layout — 21 worktrees and 16 repo-level spaces — which
is where the parent-binding trap above surfaced and was fixed. Strategy is noah's (`/noah`,
`/oracle-ferry`); ledger discipline is `/ferry-ledger`'s. The `maw noah` CLI this was meant to
become does not exist yet — `bring.ts` is its working prototype.
