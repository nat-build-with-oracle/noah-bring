#!/usr/bin/env bun
/**
 * noah-bring — carry herdr worktree spaces and their Claude Code sessions to another
 * host, open them as herdr spaces there, and prove the crossing.
 *
 *   maw noah preflight <host>              landing-zone facts; exits 3 if ghq roots differ
 *   maw noah list      <host>              local worktree spaces + what <host> already holds
 *   maw noah check     <host> <slug>...    git state, sessions, agent idle?, rsync DRY-RUN
 *   maw noah ferry     <host> <slug>...    push branch, rsync, worktree add, direnv, herdr open
 *   maw noah verify    <host> <slug>...    the 4 locks, consumer-side
 *   maw noah ledger    <host> <slug>...    ledger markdown: table, locks and dirty list, live
 *
 * Handoff — a MOVE, not a copy. The worktree is open on exactly one machine at a time:
 *   maw noah send      <host> <slug>...    commit, push, carry sessions, open there, close HERE
 *   maw noah recall    <host> <slug>...    commit+push there, pull here, open here, close THERE
 *   maw noah owner     <host> <slug>...    who holds it, plus the handoff history
 *
 * Same-ghq-root hops only. If the roots differ, preflight says STOP — the encoded Claude
 * project directory is derived from cwd, and this tool does not rewrite paths.
 *
 * Every subcommand makes ONE ssh connection for all slugs, not one per slug. Measured:
 * 8 calls as 8 ssh invocations took 1.305s; the same 8 inside one ssh took 0.174s.
 */
import { $ } from "bun";
import { homedir, hostname, userInfo } from "node:os";

$.nothrow();

/**
 * Every line leaves through here. maw hands the plugin a writer so output streams as it is
 * produced; a direct `bun src/index.ts` run falls back to console.log. Routing both through
 * one emitter is what keeps the two paths honest — the `today` plugin notes the same thing,
 * having been bitten by a freeze that only appeared on the direct-run path.
 */
let out: (line: string) => void = (line) => console.log(line);

// ── types ────────────────────────────────────────────────────────────────────────────
type Workspace = {
  workspace_id: string;
  label: string;
  /** Which session socket answered for this workspace. Closing it needs that same server. */
  sock?: string;
  worktree?: { checkout_path?: string; repo_key?: string; is_linked_worktree?: boolean };
};
type Agent = { cwd?: string; agent_status?: string };
type Target = {
  slug: string;
  wt: string;      // the worktree checkout
  repo: string;    // its repo root
  orgRepo: string; // "org/name", for ghq get on the far side
  enc: string;     // Claude's encoded project-dir name
  pd: string;      // the local project dir
  branch: string;
  agent: string;
};

// ── shell helpers ────────────────────────────────────────────────────────────────────
/** Single-quote for embedding in a generated remote script. */
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
/** Claude encodes a project dir from its cwd: every `/` and `.` becomes `-`. */
const enc = (p: string) => p.replaceAll(/[/.]/g, "-");
const pad = (s: string, n: number) => s.padEnd(n);
/**
 * The SOURCE machine's home root (/Users on macOS, /home on Linux). Lock 1 asks whether any
 * path from this machine survived the hop, so the pattern has to come from here — hardcoding
 * /Users made the lock pass without proving anything on a linux-to-linux crossing.
 */
const homeRoot = () => homedir().split("/").slice(0, 2).join("/");

let HOST = "";

/**
 * Run a snippet on HOST in a LOGIN shell — herdr, claude and maw live in ~/.local/bin
 * there, which a non-login `ssh host cmd` cannot see. The far side's ~/.profile may also
 * print noise on every login shell, so drop "command not found" lines.
 */
async function remote(script: string): Promise<string> {
  // ssh joins its argv with spaces and hands ONE string to the far shell, which re-splits
  // it. Passing the script as its own argv entry is not enough: `bash -lc ghq root` arrives
  // word-split, so bash runs `ghq` with $0=root and prints help. Quote it into one word here.
  const r = await $`ssh -n -o BatchMode=yes -o ConnectTimeout=10 ${HOST} ${"bash -lc " + q(script)}`.quiet();
  return r.stdout
    .toString()
    .split("\n")
    .filter((l) => !l.includes("command not found"))
    .join("\n")
    .replace(/\n+$/, "");
}

async function local(cmd: string[]): Promise<string> {
  return (await $`${cmd}`.quiet()).stdout.toString().trim();
}

// ── herdr, over its own CLI (which is a client of the socket API) ─────────────────────
/**
 * Every herdr SESSION has its own server and its own socket, and `herdr workspace list`
 * only ever sees the one it is pointed at. Measured here: the default socket holds 37
 * workspaces while the machine really has 44 — the other 7 live in a named session. A
 * resolver that reads one socket silently cannot find those slugs.
 *
 * Socket resolution order is `--session`, then HERDR_SOCKET_PATH, then HERDR_SESSION.
 * Named sockets live beside the default one. Dead sessions leave their socket file
 * behind, so a failed query is normal and is skipped rather than reported.
 */
function sockets(): string[] {
  const base = `${homedir()}/.config/herdr`;
  const named = Array.from(
    new Bun.Glob("sessions/*/herdr.sock").scanSync({ cwd: base, onlyFiles: false }),
  ).map((p) => `${base}/${p}`);
  return [`${base}/herdr.sock`, ...named];
}

async function everySession<T>(method: string[], pick: (j: any) => T[]): Promise<T[]> {
  const rows: T[] = [];
  for (const sock of sockets()) {
    const r = await $`herdr ${method}`.env({ ...process.env, HERDR_SOCKET_PATH: sock }).quiet();
    if (r.exitCode !== 0) continue;
    try {
      for (const row of pick(JSON.parse(r.stdout.toString()))) rows.push({ ...row, sock } as T);
    } catch {
      /* dead or half-written socket — skip it */
    }
  }
  return rows;
}

/** Run a herdr command against the specific session server that owns a workspace. */
async function herdrOn(sock: string, args: string[]) {
  return await $`herdr ${args}`.env({ ...process.env, HERDR_SOCKET_PATH: sock }).quiet();
}

let _ws: Workspace[] | null = null;
async function workspaces(): Promise<Workspace[]> {
  if (_ws) return _ws;
  _ws = await everySession<Workspace>(["workspace", "list"], (j) => j.result?.workspaces ?? []);
  return _ws!;
}
let _agents: Agent[] | null = null;
async function agents(): Promise<Agent[]> {
  if (_agents) return _agents;
  _agents = await everySession<Agent>(["agent", "list"], (j) => j.result?.agents ?? []);
  return _agents!;
}
async function agentStatus(cwd: string): Promise<string> {
  const here = (await agents()).filter((a) => a.cwd === cwd).map((a) => a.agent_status ?? "none");
  // Several panes can share one cwd — ours holds a claude and a codex. If ANY of them is
  // mid-append the whole project dir is unsafe, so the busiest status wins, not the first.
  return ["working", "blocked"].find((s) => here.includes(s)) ?? here[0] ?? "none";
}

// ── resolving a slug ─────────────────────────────────────────────────────────────────
async function ghqRoot(): Promise<string> {
  return await local(["ghq", "root"]);
}

/**
 * Slug -> checkout, remembered on disk.
 *
 * `send` closes the local herdr space on purpose, and the space is what the resolver reads,
 * so without this the slug becomes unresolvable on the machine that just handed it off —
 * `owner` and `recall` would both fail on the very worktrees they exist to manage. The
 * checkout itself is untouched, so all that is needed is a note of where it is.
 */
const STATE = `${homedir()}/.maw/noah/state.json`;

type Known = { wt: string; repo: string; branch: string; sentTo?: string; at?: string };

async function readState(): Promise<Record<string, Known>> {
  try {
    return JSON.parse(await Bun.file(STATE).text());
  } catch {
    return {};
  }
}

async function remember(t: Target, extra: Partial<Known> = {}) {
  const st = await readState();
  st[t.slug] = { wt: t.wt, repo: t.repo, branch: t.branch, ...st[t.slug], ...extra };
  await Bun.write(STATE, JSON.stringify(st, null, 2));
}

/** A slug is a herdr workspace LABEL, never a directory name. `list` is the resolver. */
async function resolve(slug: string): Promise<Target | null> {
  const w = (await workspaces()).find(
    (w) => w.label === slug && w.worktree?.checkout_path,
  );
  // No open space here? That is the NORMAL state after a `send` — closing it is the point.
  // Fall back in order: what was remembered on disk, then the far host, which is where the
  // space now lives and is therefore authoritative. Paths are identical across a same-root
  // hop, so the far side's checkout_path is directly usable here.
  let wt = w?.worktree?.checkout_path;
  if (!wt) wt = (await readState())[slug]?.wt;
  if (!wt && HOST) {
    const far = await remote(
      `herdr workspace list | jq -r --arg l ${q(slug)} '[.result.workspaces[] | select(.label==$l) | .worktree.checkout_path // empty][0] // empty'`,
    );
    if (far.trim()) wt = far.trim();
  }
  if (!wt) return null;
  // The checkout has to still exist HERE — resolve returns a local Target either way.
  if ((await $`test -d ${wt}`.quiet()).exitCode !== 0) return null;
  const repo = (
    await local(["git", "-C", wt, "rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).replace(/\/\.git$/, "");
  const branch = await local(["git", "-C", wt, "rev-parse", "--abbrev-ref", "HEAD"]);
  const root = await ghqRoot();
  return {
    slug,
    wt,
    repo,
    orgRepo: repo.replace(`${root}/github.com/`, ""),
    enc: enc(wt),
    pd: `${homedir()}/.claude/projects/${enc(wt)}`,
    branch,
    agent: await agentStatus(wt),
  };
}

async function resolveAndRemember(slug: string): Promise<Target | null> {
  const t = await resolve(slug);
  if (t) await remember(t);
  return t;
}

async function resolveAll(slugs: string[]): Promise<Target[]> {
  const found: Target[] = [];
  for (const s of slugs) {
    const t = await resolveAndRemember(s);
    if (t) found.push(t);
    else out(`  !! '${s}' is not a herdr workspace label here — see the list subcommand`);
  }
  return found;
}

// ── subcommands ──────────────────────────────────────────────────────────────────────
async function preflight(): Promise<boolean> {
  const root = await ghqRoot();
  out("== local ==");
  out(`  ghq root   ${root}`);
  out(`  rsync      ${(await local(["bash", "-c", "command -v rsync"])) || "MISSING"}`);
  out(`== ${HOST} (login shell) ==`);
  out(
    await remote(`printf "  host       %s / %s\\n" "$(hostname)" "$(whoami)"
printf "  ghq root   %s\\n" "$(ghq root 2>/dev/null || echo MISSING)"
for t in herdr claude maw rsync relic; do printf "  %-10s %s\\n" $t "$(command -v $t || echo MISSING)"; done
printf "  herdr sock %s\\n" "$([ -S ~/.config/herdr/herdr.sock ] && echo present || echo ABSENT)"
printf "  retention  settings.json=%s  .claude.json=%s\\n" "$(grep -o 'cleanupPeriodDays"[^,}]*' ~/.claude/settings.json 2>/dev/null | tr -dc 0-9)" "$(grep -o 'cleanupPeriodDays"[^,}]*' ~/.claude.json 2>/dev/null | tr -dc 0-9)"`),
  );
  const far = await remote("ghq root 2>/dev/null");
  out("== verdict ==");
  if (far.trim() === root) {
    out(`  ghq roots MATCH (${root}) — encoded project dirs identical, no cwd rewrite. Proceed.`);
    return true;
  }
  out(`  ghq roots DIFFER (${root} vs ${far.trim() || "?"}) — STOP. This tool does not rewrite cwd.`);
  return false;
}

async function list() {
  out(
    [pad("ws", 4), pad("label", 46), pad("agent", 9), pad("sess", 7), pad("local-files", 12), pad("remote", 8), "remote-files"].join(" "),
  );
  // One ssh for the whole far-side picture, not one per row.
  const farRaw = await remote(
    `for d in ~/.claude/projects/*/; do printf "%s %s\\n" "$(basename "$d")" "$(ls "$d"*.jsonl 2>/dev/null | wc -l)"; done`,
  );
  const far = new Map(
    farRaw.split("\n").filter(Boolean).map((l) => {
      const [k, v] = l.trim().split(/\s+/);
      return [k, v] as const;
    }),
  );
  for (const w of await workspaces()) {
    const co = w.worktree?.checkout_path;
    if (!co || !w.worktree?.is_linked_worktree) continue;
    const e = enc(co);
    const pd = `${homedir()}/.claude/projects/${e}`;
    const top = (await local(["bash", "-c", `ls ${q(pd)}/*.jsonl 2>/dev/null | wc -l`])).trim();
    const all = (await local(["bash", "-c", `find ${q(pd)} -name '*.jsonl' 2>/dev/null | wc -l`])).trim();
    out(
      [
        pad(w.workspace_id, 4),
        pad(w.label, 46),
        pad(await agentStatus(co), 9),
        pad(top, 7),
        pad(all, 12),
        pad(far.has(e) ? "sess" : "absent", 8),
        far.get(e) ?? "-",
      ].join(" "),
    );
  }
}

async function check(slugs: string[]) {
  const ts = await resolveAll(slugs);
  // One ssh covering every slug.
  const farRaw = await remote(
    ts
      .map(
        (t) =>
          `printf '%s|%s|%s|%s\\n' ${q(t.slug)} "$([ -d ${q(t.repo)}/.git ] && echo repo:present || echo repo:ABSENT)" "$([ -d ${q(t.wt)} ] && echo wt:present || echo wt:absent)" "$(ls ~/.claude/projects/${q(t.enc)}/*.jsonl 2>/dev/null | wc -l)"`,
      )
      .join("\n"),
  );
  const far = new Map(farRaw.split("\n").filter(Boolean).map((l) => [l.split("|")[0], l.split("|").slice(1)] as const));

  for (const t of ts) {
    out(`--- ${t.slug} ---`);
    const up = (await local(["git", "-C", t.wt, "rev-parse", "--abbrev-ref", "@{u}"])) || "NO-UPSTREAM";
    const ahead = (await local(["git", "-C", t.wt, "rev-list", "--count", "@{u}..HEAD"])) || "-";
    const dirty = await local(["git", "-C", t.wt, "status", "--porcelain"]);
    out(`  wt        ${t.wt}`);
    out(`  repo      ${t.repo}`);
    out(`  branch    ${t.branch}  upstream=${up.replace(/^origin\//, "")}  ahead=${ahead}`);
    const quiesced = !["working", "blocked"].includes(t.agent);
    out(`  agent     ${t.agent}   ${quiesced ? "(quiesced)" : "!! mid-write — sessions will be DEFERRED"}`);
    if (dirty) {
      out("  dirty     (uncommitted, will NOT cross via git):");
      for (const l of dirty.split("\n")) out(`            ${l}`);
    } else out("  dirty     clean");
    const top = await local(["bash", "-c", `ls ${q(t.pd)}/*.jsonl 2>/dev/null | wc -l`]);
    const all = await local(["bash", "-c", `find ${q(t.pd)} -name '*.jsonl' 2>/dev/null | wc -l`]);
    const du = await local(["bash", "-c", `du -sh ${q(t.pd)} 2>/dev/null | cut -f1`]);
    out(`  sessions  ${t.pd}  (${top.trim()} top-level, ${all.trim()} files, ${du})`);
    const f = far.get(t.slug);
    if (f) out(`  remote    ${f[0]} ${f[1]}  remote-top-level-jsonl=${f[2]}`);
    out("  rsync DRY-RUN (--ignore-existing):");
    const dry = await $`rsync -avn --ignore-existing --stats -e ${"ssh -o BatchMode=yes"} ${t.pd + "/"} ${HOST + ":.claude/projects/" + t.enc + "/"}`.quiet();
    for (const l of dry.stdout.toString().split("\n")) {
      if (/Number of regular files transferred|Total transferred file size/.test(l)) out(`            ${l.trim()}`);
    }
  }
}

async function ferry(slugs: string[]) {
  const all = await resolveAll(slugs);
  const ts: Target[] = [];

  // Phase 1, local and per-slug: push the branch, then rsync the sessions.
  for (const t of all) {
    out(`--- ${t.slug} ---`);
    if (t.branch === "main" || t.branch === "master") {
      out(`  !! branch is ${t.branch} — never push main from here. Skipping.`);
      continue;
    }
    ts.push(t);
    const hasUp = (await $`git -C ${t.wt} rev-parse --abbrev-ref @{u}`.quiet()).exitCode === 0;
    const push = hasUp
      ? await $`git -C ${t.wt} push origin ${t.branch}`.quiet()
      : await $`git -C ${t.wt} push -u origin ${t.branch}`.quiet();
    const pushLines = (push.stdout.toString() + push.stderr.toString()).trim().split("\n");
    out(`  push      ${pushLines[pushLines.length - 1] ?? ""}`);

    // idle / done / none are quiescent; only working|blocked means a transcript is
    // mid-append. Under --ignore-existing a torn copy is PERMANENT, because the next
    // run sees the file and skips it. So defer the sessions and let the layout cross.
    if (["working", "blocked"].includes(t.agent)) {
      out(`  rsync     DEFERRED — agent is '${t.agent}'; re-run ferry for this slug when idle (merge-safe)`);
    } else {
      const r = await $`rsync -a --ignore-existing --stats -e ${"ssh -o BatchMode=yes"} ${t.pd + "/"} ${HOST + ":.claude/projects/" + t.enc + "/"}`.quiet();
      const stats = r.stdout
        .toString()
        .split("\n")
        .filter((l) => /Number of regular files transferred|Total transferred file size/.test(l))
        .map((l) => l.trim())
        .join("  ");
      out(`  rsync     ${stats}`);
    }
  }

  if (!ts.length) return;

  // Phase 2, ONE ssh for every slug: clone if needed, cut the worktree, open the space.
  //
  // `herdr worktree open --cwd <repo>` is the whole trick. Scoping to the repo makes
  // herdr resolve the parent workspace itself, creating and binding it when it does not
  // exist. Omitting --cwd falls back to the ACTIVE workspace, which errors with
  // linked_worktree_source whenever that happens to be a worktree. Managing the parent
  // by hand (workspace create + label lookup + --trust-repository) is not needed and
  // produced one duplicate parent per child when its binding was misunderstood.
  out(`--- far side (1 ssh, ${ts.length} slug${ts.length === 1 ? "" : "s"}) ---`);
  const script = ts
    .map(
      (t) => `
( echo "--- ${t.slug} ---"
[ -d ${q(t.repo)}/.git ] || { echo '  clone     ghq get ${t.orgRepo}'; ghq get -p ${q(t.orgRepo)} >/dev/null 2>&1 || ghq get ${q(t.orgRepo)} >/dev/null 2>&1; }
[ -d ${q(t.repo)}/.git ] || { echo '  !! repo   still absent after ghq get — private and unreachable from here?'; exit 0; }
git -C ${q(t.repo)} fetch origin --quiet 2>/dev/null || echo '  !! fetch  failed (origin unreachable or auth) — continuing with what is local'
if [ -d ${q(t.wt)} ]; then printf '  worktree  already present: '; git -C ${q(t.wt)} rev-parse --short=8 HEAD
else printf '  worktree  '; git -C ${q(t.repo)} worktree add ${q(t.wt)} ${q(t.branch)} 2>&1 | tail -1; fi
[ -f ${q(t.wt)}/.envrc ] && command -v direnv >/dev/null && { printf '  direnv    '; direnv allow ${q(t.wt)} && echo allowed; }
printf '  space     '
herdr worktree open --cwd ${q(t.repo)} --path ${q(t.wt)} --no-focus \\
  | jq -r 'if .error then "ERROR " + .error.code else (if .result.already_open then "already open " else "opened " end) + .result.workspace.workspace_id end' )`,
    )
    .join("\n");
  out(await remote(script));
}

async function verify(slugs: string[]) {
  const ts = await resolveAll(slugs);
  const heads = new Map<string, string>();
  for (const t of ts) heads.set(t.slug, await local(["git", "-C", t.wt, "rev-parse", "--short=8", "HEAD"]));

  // One ssh for every lock of every slug.
  const lockOutput = await remote(
    ts
      .map((t) => {
        const lh = heads.get(t.slug)!;
        return `
echo "--- ${t.slug} ---"
d=~/.claude/projects/${q(t.enc)}
printf '  L1 stray-cwd(%s)  %s   (must be 0)\\n' ${q(homeRoot())} "$(grep -ho '"cwd":"'${q(homeRoot())}'/[^"]*"' $d/*.jsonl 2>/dev/null | wc -l | tr -d ' ')"
cwd=$(grep -ho '"cwd":"[^"]*"' $d/*.jsonl 2>/dev/null | head -1 | cut -d'"' -f4)
printf '  L2 cwd==wt && exists      %s   (%s)\\n' "$([ "$cwd" = ${q(t.wt)} ] && [ -d ${q(t.wt)} ] && echo PASS || echo FAIL)" "$cwd"
for f in $d/*.jsonl; do [ -e "$f" ] || continue; tail -1 "$f" | python3 -c 'import sys,json;json.loads(sys.stdin.read())' 2>/dev/null && t=OK || t=TORN; printf '  L3 tail %s           %s\\n' "$(basename $f | cut -c1-8)" $t; done
rh=$(git -C ${q(t.wt)} rev-parse --short=8 HEAD 2>/dev/null)
printf '  HEAD remote=%s local=%s  %s\\n' "$rh" ${q(lh)} "$([ "$rh" = ${q(lh)} ] && echo MATCH || echo DIFFER)"
printf '  space     %s\\n' "$(herdr workspace list | jq -r --arg p ${q(t.wt)} '.result.workspaces[] | select(.worktree.checkout_path==$p) | .workspace_id' | head -1)"
printf '  files     %s  %s\\n' "$(find $d -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')" "$(du -sh $d 2>/dev/null | cut -f1)"`;
      })
      .join("\n"),
  );
  out(lockOutput);
  out(
    `  L4 consumer content: pick a term only THIS work would produce, then run\n     ssh ${HOST} 'grep -lc <term> ~/.claude/projects/<enc>/*.jsonl'`,
  );
}

async function ledger(slugs: string[]) {
  const ts = await resolveAll(slugs);
  const root = await ghqRoot();
  out(`# Ferry ledger — ${ts.length} worktree(s) → ${HOST}\n`);
  out(`- **Date:** ${new Date().toISOString().slice(0, 10)}`);
  out("- **Mode:** COPY, merge-safe (`rsync -a --ignore-existing`)");
  out(`- **Source:** ${userInfo().username}@${hostname().split(".")[0]}`);
  out(`- **Destination:** ${HOST}, same ghq root (${root}) — no cwd rewrite`);
  out("- **Driven by:** /noah-bring\n");
  out("| slug | branch | HEAD | remote files | remote size |");
  out("|---|---|---|---|---|");

  const farRaw = await remote(
    ts
      .map(
        (t) =>
          `printf '%s|%s|%s\\n' ${q(t.slug)} "$(find ~/.claude/projects/${q(t.enc)} -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')" "$(du -sh ~/.claude/projects/${q(t.enc)} 2>/dev/null | cut -f1)"`,
      )
      .join("\n"),
  );
  const far = new Map(farRaw.split("\n").filter(Boolean).map((l) => [l.split("|")[0], l.split("|").slice(1)] as const));
  for (const t of ts) {
    const head = await local(["git", "-C", t.wt, "rev-parse", "--short=8", "HEAD"]);
    const f = far.get(t.slug) ?? ["?", "?"];
    out(`| ${t.slug} | ${t.branch} | ${head} | ${f[0]} | ${f[1]} |`);
  }

  out("\n## Locks\n\n```");
  await verify(slugs);
  out("```\n");
  out(
    "**L4 (consumer content)** is the one lock a script cannot run for you: it needs a term\nonly THIS work would produce. A generic word hits on any transcript and proves nothing.\nPick one, run it, paste the result.\n",
  );
  out("## Not crossed\n\nUncommitted at ferry time, so it stayed on the source machine:\n\n```");
  for (const t of ts) {
    const d = await local(["git", "-C", t.wt, "status", "--porcelain"]);
    out(d ? `${t.slug}:\n${d}` : `${t.slug}: clean`);
  }
  out("```\n\n`.envrc` holds a token reference and stays local by design.\n\n## Traps hit\n\n-");
}

// ── ownership: a handoff MOVES a worktree, it does not copy it ───────────────────────
//
// Two machines holding the same branch with agents on both is the failure this prevents.
// The owner is recorded as an APPEND-ONLY git tag, never a moved ref: `git push --force` is
// forbidden here, and an append-only trail means the history of who held it survives.
//
//   noah-owner/<slug>/<utc-stamp>-<host>
//
// Newest tag wins. Reading is a fetch plus a sort; there is nothing to reconcile.
const OWNER_NS = "noah-owner";

async function ownerTags(t: Target): Promise<string[]> {
  await $`git -C ${t.wt} fetch origin --tags --quiet`.quiet();
  const tags = await local(["git", "-C", t.wt, "tag", "-l", `${OWNER_NS}/${t.slug}/*`]);
  return tags ? tags.split("\n").filter(Boolean).sort() : [];
}

async function ownerOf(t: Target): Promise<string> {
  const tags = await ownerTags(t);
  const last = tags[tags.length - 1];
  if (!last) return "unclaimed";
  // Tag is <ns>/<slug>/<stamp>-<host>. The slug is full of dashes and the host may contain
  // dots and an @, so split the LAST path segment on its FIRST dash only.
  const seg = last.split("/").pop()!;
  const i = seg.indexOf("-");
  return i === -1 ? seg : seg.slice(i + 1);
}

async function claim(t: Target, host: string) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const tag = `${OWNER_NS}/${t.slug}/${stamp}-${host}`;
  await $`git -C ${t.wt} tag ${tag}`.quiet();
  const r = await $`git -C ${t.wt} push origin ${tag}`.quiet();
  out(`  owner     ${host}   (tag ${tag}${r.exitCode === 0 ? "" : " — LOCAL ONLY, push failed"})`);
}

/** Commit tracked changes so nothing is stranded on the machine being left. */
async function commitTracked(t: Target, why: string): Promise<boolean> {
  const dirty = await local(["git", "-C", t.wt, "status", "--porcelain"]);
  if (!dirty) {
    out("  commit    nothing to commit");
    return true;
  }
  // .envrc commonly holds a token reference. It never crosses, and it is never committed.
  await $`git -C ${t.wt} add -A ${":(exclude).envrc"}`.quiet();
  const staged = await local(["git", "-C", t.wt, "diff", "--cached", "--name-only"]);
  if (!staged) {
    out("  commit    only .envrc changed — left in place, nothing committed");
    return true;
  }
  const msg = `wip(handoff): ${why}\n\nAutomatic commit so the worktree can move machines with\nnothing stranded. Squash or reword it freely.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>`;
  const c = await $`git -C ${t.wt} commit -m ${msg}`.quiet();
  out(`  commit    ${staged.split("\n").length} file(s)${c.exitCode === 0 ? "" : " — FAILED"}`);
  const skipped = dirty.split("\n").filter((l) => l.includes(".envrc"));
  if (skipped.length) out(`  kept      ${skipped.map((l) => l.trim()).join(", ")} (stays on this machine)`);
  return c.exitCode === 0;
}

/**
 * Shell that walks EVERY herdr server on the far host — the default socket plus each named
 * session — and prints `<socket>\t<workspace_id>` for a checkout. Asking only the default
 * socket is how a workspace in a named session gets misread as closed.
 */
const farSpaceLookup = (wt: string) => `
for s in ~/.config/herdr/herdr.sock ~/.config/herdr/sessions/*/herdr.sock; do
  [ -S "$s" ] || continue
  id=$(HERDR_SOCKET_PATH="$s" herdr workspace list 2>/dev/null \
    | jq -r --arg p ${q(wt)} '[.result.workspaces[]? | select(.worktree.checkout_path==$p) | .workspace_id][0] // empty' 2>/dev/null)
  [ -n "$id" ] && { printf '%s\\t%s\\n' "$s" "$id"; break; }
done`;

/** The far host's workspace id for a checkout, or "closed" — across all its session servers. */
async function farSpaceId(wt: string): Promise<string> {
  const row = (await remote(farSpaceLookup(wt))).trim();
  return row ? row.split("\t")[1] : "closed";
}

async function localSpaceOf(wt: string): Promise<Workspace | undefined> {
  return (await workspaces()).find((w) => w.worktree?.checkout_path === wt);
}

/** here → <host>. Push the work, carry the sessions, open there, then close HERE. */
/** Set by any path that breaks the one-machine invariant, so the exit code can report it. */
let failed = false;

async function send(slugs: string[]) {
  for (const t of await resolveAll(slugs)) {
    out(`--- ${t.slug} → ${HOST} ---`);
    if (["working", "blocked"].includes(t.agent)) {
      out(`  !! agent is '${t.agent}' here — a handoff mid-turn strands the reply. Wait for idle.`);
      continue;
    }
    if (t.branch === "main" || t.branch === "master") {
      out(`  !! branch is ${t.branch} — refusing to hand off a main checkout.`);
      continue;
    }
    if (!(await commitTracked(t, `${t.slug} → ${HOST}`))) continue;

    const hasUp = (await $`git -C ${t.wt} rev-parse --abbrev-ref @{u}`.quiet()).exitCode === 0;
    const p = hasUp
      ? await $`git -C ${t.wt} push origin ${t.branch}`.quiet()
      : await $`git -C ${t.wt} push -u origin ${t.branch}`.quiet();
    const pl = (p.stdout.toString() + p.stderr.toString()).trim().split("\n");
    out(`  push      ${pl[pl.length - 1] ?? ""}`);
    if (p.exitCode !== 0) {
      out("  !! push failed — NOT handing off, the far side would get stale code.");
      continue;
    }

    const r = await $`rsync -a --ignore-existing -e ${"ssh -o BatchMode=yes"} ${t.pd + "/"} ${HOST + ":.claude/projects/" + t.enc + "/"}`.quiet();
    out(`  sessions  ${r.exitCode === 0 ? "carried" : "RSYNC FAILED"}`);

    const far = await remote(`
( [ -d ${q(t.repo)}/.git ] || ghq get ${q(t.orgRepo)} >/dev/null 2>&1
  [ -d ${q(t.repo)}/.git ] || { echo '  !! repo absent on far side'; exit 0; }
  git -C ${q(t.repo)} fetch origin --quiet 2>/dev/null
  if [ -d ${q(t.wt)} ]; then
    if git -C ${q(t.wt)} pull --ff-only --quiet 2>/dev/null; then printf '  far-wt    updated: '; git -C ${q(t.wt)} rev-parse --short=8 HEAD
    else echo '  !! far-wt fast-forward pull FAILED — far checkout is stale, not handing off'; exit 0; fi
  else printf '  far-wt    '; git -C ${q(t.repo)} worktree add ${q(t.wt)} ${q(t.branch)} 2>&1 | tail -1; fi
  [ -f ${q(t.wt)}/.envrc ] && command -v direnv >/dev/null && direnv allow ${q(t.wt)} 2>/dev/null
  printf '  far-space '
  herdr worktree open --cwd ${q(t.repo)} --path ${q(t.wt)} --no-focus \\
    | jq -r 'if .error then "ERROR " + .error.code else (if .result.already_open then "already open " else "opened " end) + .result.workspace.workspace_id end' )`);
    out(far);
    if (far.includes("ERROR") || far.includes("!!")) {
      out("  !! far side did not open — keeping the space HERE. Nothing was closed.");
      failed = true;
      continue;
    }

    await claim(t, HOST);
    await remember(t, { sentTo: HOST, at: new Date().toISOString() });

    // Close last, and only after the far side is proven open. The checkout stays on disk —
    // the branch and the work are recoverable; only the herdr space goes away, which is what
    // "show it there, not here" actually means.
    const ws = await localSpaceOf(t.wt);
    if (!ws?.sock) out("  here      no local space to close");
    else {
      const c = await herdrOn(ws.sock, ["workspace", "close", ws.workspace_id]);
      const body = c.stdout.toString();
      if (body.includes("error") || c.exitCode !== 0) {
        // Open there AND still open here is the one state this command exists to prevent,
        // so it is a failure, not a note. Say so loudly and fail the run.
        out(`  !! here    close FAILED (${body.trim().slice(0, 90)})`);
        out(`  !! ${t.slug} is now OPEN ON BOTH — close it here, or run recall ${HOST} ${t.slug}`);
        failed = true;
      } else out(`  here      closed ${ws.workspace_id}`);
    }
  }
}

/** <host> → here. The mirror image: commit and push THERE, pull here, close THERE. */
async function recall(slugs: string[]) {
  for (const t of await resolveAll(slugs)) {
    out(`--- ${t.slug} ← ${HOST} ---`);
    const far = await remote(`
( cd ${q(t.wt)} 2>/dev/null || { echo '  !! not on the far side'; exit 0; }
  busy=$(herdr agent list | jq -r --arg c ${q(t.wt)} '[.result.agents[] | select(.cwd==$c) | .agent_status] | map(select(.=="working" or .=="blocked")) | length')
  [ "$busy" = "0" ] || { echo "  !! an agent is mid-turn on the far side — wait for idle"; exit 0; }
  git -C ${q(t.wt)} add -A ':(exclude).envrc' 2>/dev/null
  if git -C ${q(t.wt)} diff --cached --quiet 2>/dev/null; then echo '  far-commit nothing to commit'
  else git -C ${q(t.wt)} commit -q -m 'wip(handoff): back from the far machine' 2>/dev/null && echo '  far-commit committed'; fi
  printf '  far-push  '; git -C ${q(t.wt)} push origin ${q(t.branch)} 2>&1 | tail -1 )`);
    out(far);
    if (far.includes("!!")) {
      failed = true;
      continue;
    }

    // Sessions come BACK, same merge-safe rule in the other direction.
    const r = await $`rsync -a --ignore-existing -e ${"ssh -o BatchMode=yes"} ${HOST + ":.claude/projects/" + t.enc + "/"} ${t.pd + "/"}`.quiet();
    out(`  sessions  ${r.exitCode === 0 ? "carried back" : "RSYNC FAILED"}`);

    await $`git -C ${t.wt} fetch origin --quiet`.quiet();
    const pull = await $`git -C ${t.wt} pull --ff-only`.quiet();
    const pl = (pull.stdout.toString() + pull.stderr.toString()).trim().split("\n");
    out(`  pull      ${pl[pl.length - 1] ?? ""}`);
    if (pull.exitCode !== 0) {
      out("  !! fast-forward pull failed — resolve here before closing the far space.");
      failed = true;
      continue;
    }

    const open = await $`herdr worktree open --cwd ${t.repo} --path ${t.wt} --no-focus`.quiet();
    const oj = (() => { try { return JSON.parse(open.stdout.toString()); } catch { return {}; } })();
    out(`  here      ${oj.error ? "ERROR " + oj.error.code : (oj.result?.already_open ? "already open " : "opened ") + oj.result?.workspace?.workspace_id}`);
    if (oj.error) {
      failed = true;
      continue;
    }

    await claim(t, `${userInfo().username}@${hostname().split(".")[0]}`);
    await remember(t, { sentTo: undefined, at: new Date().toISOString() });

    // Close on the right server, not just the default one.
    const row = (await remote(farSpaceLookup(t.wt))).trim();
    if (!row) out("  far-close no space there");
    else {
      const [sock, id] = row.split("\t");
      const res = (await remote(
        `HERDR_SOCKET_PATH=${q(sock)} herdr workspace close ${q(id)} | jq -r 'if .error then "ERROR " + .error.code else "closed" end'`,
      )).trim();
      out(`  far-close ${res} ${id}`);
      if (!res.startsWith("closed")) {
        out(`  !! ${t.slug} is now OPEN ON BOTH — close ${id} on ${HOST}, or run send ${HOST} ${t.slug}`);
        failed = true;
      }
    }
  }
}

/**
 * One verb for "put it on the other machine". If it is open HERE, send it; if it is open
 * THERE, bring it back. A worktree belongs to exactly one side, so the useful control is a
 * flip, not two commands the caller has to choose between.
 *
 * Open on BOTH is the state a plain ferry leaves behind. There is no safe automatic answer
 * to "which copy is real", so toggle refuses it and names the two explicit commands.
 */
async function toggle(slugs: string[]) {
  for (const slug of slugs) {
    const t = await resolveAndRemember(slug);
    if (!t) continue;
    const here = !!(await localSpaceOf(t.wt));
    const there = (await farSpaceId(t.wt)) !== "closed";

    if (here && there) {
      out(`--- ${t.slug} ---`);
      out(`  !! open on BOTH — toggle will not guess which copy is real.`);
      out(`     send ${HOST} ${t.slug}    to keep the far one`);
      out(`     recall ${HOST} ${t.slug}  to keep this one`);
      // Reporting a broken invariant is still a failure — a script calling toggle in a loop
      // must not read this as "done".
      failed = true;
      continue;
    }
    if (here) await send([slug]);
    else if (there) await recall([slug]);
    else {
      out(`--- ${t.slug} ---\n  !! open on neither side — nothing to toggle.`);
      failed = true;
    }
  }
}

async function owner(slugs: string[]) {
  for (const t of await resolveAll(slugs)) {
    const tags = await ownerTags(t);
    out(`--- ${t.slug} ---`);
    out(`  owner     ${await ownerOf(t)}`);
    const here = await localSpaceOf(t.wt);
    out(`  space here ${here ? here.workspace_id : "closed"}`);
    const there = await farSpaceId(t.wt);
    out(`  space ${HOST} ${there}`);
    if (here && there !== "closed") out("  !! OPEN ON BOTH — that is the state handoffs exist to prevent.");
    for (const tag of tags.slice(-4)) out(`  history   ${tag}`);
  }
}

// ── maw plugin entry ─────────────────────────────────────────────────────────────────
export const command = {
  name: "noah",
  description: "Ferry or hand off herdr worktree spaces and their Claude sessions between machines.",
};

const USAGE = `maw noah <cmd> <host> [slug...]

  preflight <host>              landing-zone facts; stops if the ghq roots differ
  list      <host>              local worktree spaces + what <host> already holds
  check     <host> <slug>...    git state, sessions, agent idle?, rsync DRY-RUN
  ferry     <host> <slug>...    COPY: push, rsync, worktree add, open there (both sides keep it)
  verify    <host> <slug>...    the 4 locks, consumer-side
  ledger    <host> <slug>...    ledger markdown, measured live

  send      <host> <slug>...    MOVE: commit, push, carry sessions, open there, close HERE
  recall    <host> <slug>...    MOVE back: commit+push there, pull here, open here, close THERE
  toggle    <host> <slug>...    flip it to the other machine — here goes there, there comes back
  owner     <host> <slug>...    who holds it now, and the handoff history

A slug is a herdr workspace LABEL. \`list\` is the resolver — never guess one from a directory.`;

type HandlerArgs = { source?: string; args?: unknown; writer?: (...v: unknown[]) => void };

export async function handler({ args, writer }: HandlerArgs = {}) {
  const argv = Array.isArray(args)
    ? args.map(String)
    : typeof args === "string"
      ? args.split(/\s+/).filter(Boolean)
      : [];
  const buf: string[] = [];
  out = writer ? (l: string) => writer(l) : (l: string) => buf.push(l);

  const [cmd, host, ...slugs] = argv;
  if (!cmd || !host) return { ok: false, output: USAGE };
  HOST = host;

  const needsSlugs = ["check", "ferry", "verify", "ledger", "send", "recall", "owner", "toggle"];
  if (needsSlugs.includes(cmd) && !slugs.length) {
    return { ok: false, error: `${cmd} needs at least one <slug> — run \`maw noah list ${host}\`` };
  }

  // Any command can now veto: preflight on a root mismatch, and send/recall/toggle whenever
  // the one-machine invariant ends up broken. Exit code has to be usable from a script.
  let ok = true;
  failed = false;
  switch (cmd) {
    case "preflight": ok = await preflight(); break;
    case "list": await list(); break;
    case "check": await check(slugs); break;
    case "ferry": await ferry(slugs); break;
    case "verify": await verify(slugs); break;
    case "ledger": await ledger(slugs); break;
    case "send": await send(slugs); break;
    case "recall": await recall(slugs); break;
    case "owner": await owner(slugs); break;
    case "toggle": await toggle(slugs); break;
    default:
      return { ok: false, error: `unknown subcommand: ${cmd}\n\n${USAGE}` };
  }
  return { ok: ok && !failed, output: buf.length ? buf.join("\n") : undefined };
}

export default handler;

// Runnable directly as well as through maw, so it can be exercised before it is installed.
// The writer is passed on purpose: without it the direct run buffers and only prints at the
// end, which is exactly the parity bug that hides a hang in a long ferry.
if (import.meta.main) {
  const r = await handler({
    source: "cli",
    args: process.argv.slice(2),
    writer: (...v: unknown[]) => console.log(v.map(String).join(" ")),
  });
  if (r.output) console.log(r.output);
  if (r.error) console.error(r.error);
  process.exit(r.ok ? 0 : 1);
}
