#!/usr/bin/env bash
# noah-bring — carry herdr worktree spaces + their Claude sessions to another host, and prove it.
# Deterministic subcommands so an agent never has to reconstruct the crossing by hand.
#
#   bring.sh preflight <host>                 landing-zone facts (PATH, ghq root, retention, rsync, herdr)
#   bring.sh list      <host>                 local herdr worktree spaces + what <host> already has
#   bring.sh check     <host> <slug>...       git state, sessions, agent idle?, rsync DRY-RUN
#   bring.sh ferry     <host> <slug>...       push branch, rsync sessions (merge-safe), worktree add, herdr open
#   bring.sh verify    <host> <slug>...       the 4 locks, consumer-side
#   bring.sh ledger    <host> <slug>...       ledger markdown on stdout: table, locks and dirty list
#                                             all measured live; only the L4 term is left for a human
#
# Same-ghq-root hops only (both hosts share the same ghq root). If roots differ, preflight says STOP — use /noah.
set -uo pipefail

CMD=${1:-}; HOST=${2:-}; shift 2 2>/dev/null; SLUGS=("$@")
[ -z "$CMD" ] || [ -z "$HOST" ] && { sed -n '2,12p' "$0"; exit 2; }

# --- helpers -------------------------------------------------------------------------------
remote() {  # run a snippet on $HOST in a LOGIN shell (herdr/claude live in ~/.local/bin there)
  ssh -n -o BatchMode=yes -o ConnectTimeout=8 "$HOST" "bash -lc $(printf '%q' "$1")" 2>/dev/null \
    | grep -v 'command not found'
}
enc() { printf '%s' "$1" | sed 's#[/.]#-#g'; }          # claude's encoded project dir name
proj() { printf '%s/.claude/projects/%s' "$HOME" "$(enc "$1")"; }
ws_json() { maw herdr ls --json 2>/dev/null; }
checkout_of() { ws_json | jq -r --arg s "$1" '.workspaces[] | select(.label==$s) | .checkout // empty' | head -1; }
repo_root_of() { git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's#/\.git$##'; }
agent_status_of() { maw herdr ls --agents --json 2>/dev/null | jq -r --arg c "$1" '.agents[] | select(.cwd==$c) | .status' | head -1; }
need_slugs() { [ ${#SLUGS[@]} -gt 0 ] || { echo "need at least one <slug> (a herdr workspace label)"; exit 2; }; }
resolve() {  # sets WT REPO ENC PD BR for one slug, or returns 1
  WT=$(checkout_of "$1"); [ -n "$WT" ] || { echo "  !! '$1' is not a herdr workspace label here (maw herdr ls)"; return 1; }
  REPO=$(repo_root_of "$WT"); ENC=$(enc "$WT"); PD=$(proj "$WT"); BR=$(git -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null)
}

# --- subcommands ---------------------------------------------------------------------------
case "$CMD" in
preflight)
  echo "== local =="; printf '  ghq root   %s\n' "$(ghq root)"; printf '  rsync      %s\n' "$(command -v rsync || echo MISSING)"
  echo "== $HOST (login shell) =="
  remote 'printf "  host       %s / %s\n" "$(hostname)" "$(whoami)"
    printf "  ghq root   %s\n" "$(ghq root 2>/dev/null || echo MISSING)"
    for t in herdr claude maw rsync relic; do printf "  %-10s %s\n" $t "$(command -v $t || echo MISSING)"; done
    printf "  herdr sock %s\n" "$([ -S ~/.config/herdr/herdr.sock ] && echo present || echo ABSENT)"
    printf "  retention  settings.json=%s  .claude.json=%s\n" "$(grep -o "cleanupPeriodDays\"[^,}]*" ~/.claude/settings.json 2>/dev/null | tr -dc 0-9)" "$(grep -o "cleanupPeriodDays\"[^,}]*" ~/.claude.json 2>/dev/null | tr -dc 0-9)"
    printf "  maw herdr  %s\n" "$([ -d ~/.maw/plugins/herdr ] && echo installed || echo NOT-INSTALLED)"'
  L=$(ghq root); R=$(remote 'ghq root 2>/dev/null')
  echo "== verdict =="
  if [ "$L" = "$R" ]; then echo "  ghq roots MATCH ($L) — encoded project dirs identical, no cwd rewrite. Proceed."
  else echo "  ghq roots DIFFER ($L vs ${R:-?}) — STOP. This skill does not rewrite cwd; use /noah."; exit 3; fi
  ;;

list)
  printf '%-4s %-46s %-9s %-7s %-8s %-8s %s\n' ws label agent sess local-files remote remote-files
  remote_state=$(remote 'for d in ~/.claude/projects/*/; do n=$(ls "$d"*.jsonl 2>/dev/null | wc -l); printf "%s %s\n" "$(basename "$d")" "$n"; done')
  ws_json | jq -r '.workspaces[] | select(.linked==true) | "\(.id)\t\(.label)\t\(.checkout)"' | while IFS=$'\t' read -r id label co; do
    e=$(enc "$co"); pd=$(proj "$co")
    st=$(agent_status_of "$co"); st=${st:-none}
    ns=$(ls "$pd"/*.jsonl 2>/dev/null | wc -l | tr -d ' '); nf=$(find "$pd" -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')
    rem=$(printf '%s\n' "$remote_state" | awk -v e="$e" '$1==e{print $2}'); rem=${rem:-}
    rwt=$(printf '%s\n' "$remote_state" | awk -v e="$e" '$1==e{print "sess"}')
    printf '%-4s %-46s %-9s %-7s %-8s %-8s %s\n' "$id" "$label" "$st" "$ns" "$nf" "${rwt:-absent}" "${rem:--}"
  done
  ;;

check)
  need_slugs
  for s in "${SLUGS[@]}"; do
    echo "--- $s ---"; resolve "$s" || continue
    up=$(git -C "$WT" rev-parse --abbrev-ref '@{u}' 2>/dev/null || echo NO-UPSTREAM)
    ahead=$(git -C "$WT" rev-list --count '@{u}..HEAD' 2>/dev/null || echo '-')
    dirty=$(git -C "$WT" status --porcelain 2>/dev/null)
    st=$(agent_status_of "$WT"); st=${st:-none}
    printf '  wt        %s\n  repo      %s\n  branch    %s  upstream=%s  ahead=%s\n' "$WT" "$REPO" "$BR" "${up##origin/}" "$ahead"
    printf '  agent     %s   %s\n' "$st" "$([ "$st" = idle ] || [ "$st" = none ] && echo '(quiesced)' || echo '!! NOT IDLE — do not ferry yet')"
    if [ -n "$dirty" ]; then echo "  dirty     (uncommitted, will NOT cross via git):"; printf '%s\n' "$dirty" | sed 's/^/            /'; else echo "  dirty     clean"; fi
    printf '  sessions  %s  (%s top-level, %s files, %s)\n' "$PD" "$(ls "$PD"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')" "$(find "$PD" -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')" "$(du -sh "$PD" 2>/dev/null | cut -f1)"
    r=$(remote "printf '%s %s %s\n' \"\$([ -d $REPO/.git ] && echo repo:present || echo repo:ABSENT)\" \"\$([ -d $WT ] && echo wt:present || echo wt:absent)\" \"\$(ls ~/.claude/projects/$ENC/*.jsonl 2>/dev/null | wc -l)\"")
    printf '  remote    %s  remote-top-level-jsonl=%s\n' "$(printf '%s' "$r" | cut -d' ' -f1-2)" "$(printf '%s' "$r" | cut -d' ' -f3)"
    echo "  rsync DRY-RUN (--ignore-existing):"
    rsync -avn --ignore-existing --stats -e 'ssh -o BatchMode=yes' "$PD/" "$HOST:.claude/projects/$ENC/" 2>/dev/null \
      | grep -E 'Number of regular files transferred|Total transferred file size' | sed 's/^/            /'
  done
  ;;

ferry)
  need_slugs
  for s in "${SLUGS[@]}"; do
    echo "--- $s ---"; resolve "$s" || continue
    st=$(agent_status_of "$WT")
    case "$BR" in main|master) echo "  !! branch is $BR — never push main from here. Skipping."; continue;; esac
    if ! git -C "$WT" rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
      printf '  push      '; git -C "$WT" push -u origin "$BR" 2>&1 | tail -1
    else printf '  push      '; git -C "$WT" push origin "$BR" 2>&1 | tail -1; fi
    # idle / done / none are all quiescent; only working|blocked means a transcript is mid-append.
    # A truncated copy would be permanent under --ignore-existing, so defer the SESSIONS only —
    # the worktree and the herdr space still cross, so the far-side layout is complete now.
    case "$st" in working|blocked)
      echo "  rsync     DEFERRED — agent is '$st'; re-run ferry for this slug when it is idle (merge-safe)";;
    *)
      printf '  rsync     '; rsync -a --ignore-existing --stats -e 'ssh -o BatchMode=yes' "$PD/" "$HOST:.claude/projects/$ENC/" 2>/dev/null \
        | grep -E 'Number of regular files transferred|Total transferred file size' | tr '\n' ' '; echo;;
    esac
    org_repo=$(printf '%s' "$REPO" | sed "s#^$(ghq root)/github.com/##")
    remote "
      [ -d $REPO/.git ] || { echo '  clone     ghq get $org_repo'; ghq get -p $org_repo >/dev/null 2>&1 || ghq get $org_repo >/dev/null 2>&1; }
      [ -d $REPO/.git ] || { echo '  !! repo   still absent after ghq get — private and unreachable from here?'; exit 0; }
      git -C $REPO fetch origin --quiet 2>/dev/null || echo '  !! fetch  failed (origin unreachable or auth) — continuing with what is local'
      if [ -d $WT ]; then printf '  worktree  already present: '; git -C $WT rev-parse --short=8 HEAD
      else printf '  worktree  '; git -C $REPO worktree add $WT $BR 2>&1 | tail -1; fi
      [ -f $WT/.envrc ] && command -v direnv >/dev/null && { printf '  direnv    '; direnv allow $WT && echo allowed; }
      # parent = the repo's root space. A space made by 'workspace create --cwd' carries NO worktree
      # block until the first --trust-repository open binds it, so fall back to matching its label.
      parent=\$(herdr workspace list | jq -r --arg k \"$REPO/.git\" '.result.workspaces[] | select(.worktree.repo_key==\$k and .worktree.is_linked_worktree==false) | .workspace_id' | head -1)
      [ -n \"\$parent\" ] || parent=\$(herdr workspace list | jq -r --arg l $(basename $REPO) '.result.workspaces[] | select(.label==\$l and (.worktree|not)) | .workspace_id' | head -1)
      if [ -z \"\$parent\" ]; then
        printf '  parent    none for $REPO — creating: '
        parent=\$(herdr workspace create --cwd $REPO --label $(basename $REPO) --no-focus | jq -r '.result.workspace.workspace_id // .result.workspace_id // .error.message'); echo \"\$parent\"
      fi
      have=\$(herdr workspace list | jq -r --arg p $WT '.result.workspaces[] | select(.worktree.checkout_path==\$p) | .workspace_id' | head -1)
      if [ -n \"\$have\" ]; then echo \"  space     already open: \$have\"
      else printf '  space     '; herdr worktree open --workspace \"\$parent\" --path $WT --trust-repository --no-focus | jq -r 'if .error then .error.message else \"opened \" + .result.workspace.workspace_id end'; fi"
  done
  ;;

verify)
  need_slugs
  for s in "${SLUGS[@]}"; do
    echo "--- $s ---"; resolve "$s" || continue
    lh=$(git -C "$WT" rev-parse --short=8 HEAD)
    remote "d=~/.claude/projects/$ENC
      printf '  L1 stray-cwd(/Users/*)   %s   (must be 0)\n' \"\$(grep -ho '\"cwd\":\"/Users/[^\"]*\"' \$d/*.jsonl 2>/dev/null | wc -l)\"
      cwd=\$(grep -ho '\"cwd\":\"[^\"]*\"' \$d/*.jsonl 2>/dev/null | head -1 | cut -d'\"' -f4)
      printf '  L2 cwd==wt && exists     %s   (%s)\n' \"\$([ \"\$cwd\" = $WT ] && [ -d $WT ] && echo PASS || echo FAIL)\" \"\$cwd\"
      for f in \$d/*.jsonl; do tail -1 \"\$f\" | python3 -c 'import sys,json;json.loads(sys.stdin.read())' 2>/dev/null && t=OK || t=TORN; printf '  L3 tail %s          %s\n' \"\$(basename \$f | cut -c1-8)\" \$t; done
      printf '  HEAD remote=%s local=$lh  %s\n' \"\$(git -C $WT rev-parse --short=8 HEAD 2>/dev/null)\" \"\$([ \"\$(git -C $WT rev-parse --short=8 HEAD 2>/dev/null)\" = $lh ] && echo MATCH || echo DIFFER)\"
      printf '  space    %s\n' \"\$(herdr workspace list | jq -r --arg p $WT '.result.workspaces[] | select(.worktree.checkout_path==\$p) | .workspace_id' | head -1)\"
      printf '  files    %s  %s\n' \"\$(find \$d -name '*.jsonl' | wc -l)\" \"\$(du -sh \$d | cut -f1)\""
    echo "  L4 consumer content: run   ssh $HOST 'grep -l <term-only-the-real-work-holds> ~/.claude/projects/$ENC/*.jsonl'"
  done
  ;;

ledger)
  need_slugs
  printf '# Ferry ledger — %s worktree(s) → %s\n\n- **Date:** %s\n- **Mode:** COPY, merge-safe (`rsync -a --ignore-existing`)\n- **Source:** %s@%s\n- **Destination:** %s, same ghq root (%s) — no cwd rewrite\n- **Driven by:** /noah-bring\n\n| slug | branch | HEAD | remote files | remote size |\n|---|---|---|---|---|\n' \
    "${#SLUGS[@]}" "$HOST" "$(date +%F)" "$(whoami)" "$(hostname -s)" "$HOST" "$(ghq root)"
  for s in "${SLUGS[@]}"; do
    resolve "$s" >/dev/null 2>&1 || { printf '| %s | ? | ? | ? | ? |\n' "$s"; continue; }
    r=$(remote "printf '%s %s' \"\$(find ~/.claude/projects/$ENC -name '*.jsonl' 2>/dev/null | wc -l)\" \"\$(du -sh ~/.claude/projects/$ENC 2>/dev/null | cut -f1)\"")
    printf '| %s | %s | %s | %s | %s |\n' "$s" "$BR" "$(git -C "$WT" rev-parse --short=8 HEAD)" "${r%% *}" "${r##* }"
  done
  printf '\n## Locks\n\n```\n'
  "$0" verify "$HOST" "${SLUGS[@]}"
  printf '```\n\n**L4 (consumer content)** is the one lock a script cannot run for you: it needs a\nterm only THIS work would produce. A generic word hits on any transcript and proves\nnothing. Pick one, run it, paste the result:\n\n```\nssh %s '"'"'grep -lc <term> ~/.claude/projects/<enc>/*.jsonl'"'"'\n```\n\n## Not crossed\n\nUncommitted at ferry time, so it stayed on the source machine:\n\n```\n' "$HOST"
  for s in "${SLUGS[@]}"; do
    resolve "$s" >/dev/null 2>&1 || continue
    d=$(git -C "$WT" status --porcelain 2>/dev/null)
    [ -n "$d" ] && printf '%s:\n%s\n' "$s" "$d" || printf '%s: clean\n' "$s"
  done
  printf '```\n\n`.envrc` holds a token reference and stays local by design.\n\n## Traps hit\n\n-\n'
  ;;
*) echo "unknown subcommand: $CMD"; exit 2;;
esac
