#!/usr/bin/env bun
/**
 * noah-bring — carry herdr worktree spaces and their Claude Code sessions to another
 * host, open them as herdr spaces there, and prove the crossing.
 *
 *   bring.ts preflight <host>              landing-zone facts; exits 3 if ghq roots differ
 *   bring.ts list      <host>              local worktree spaces + what <host> already holds
 *   bring.ts check     <host> <slug>...    git state, sessions, agent idle?, rsync DRY-RUN
 *   bring.ts ferry     <host> <slug>...    push branch, rsync, worktree add, direnv, herdr open
 *   bring.ts verify    <host> <slug>...    the 4 locks, consumer-side
 *   bring.ts ledger    <host> <slug>...    ledger markdown: table, locks and dirty list, live
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

// ── types ────────────────────────────────────────────────────────────────────────────
type Workspace = {
  workspace_id: string;
  label: string;
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
  const out: T[] = [];
  for (const sock of sockets()) {
    const r = await $`herdr ${method}`.env({ ...process.env, HERDR_SOCKET_PATH: sock }).quiet();
    if (r.exitCode !== 0) continue;
    try {
      out.push(...pick(JSON.parse(r.stdout.toString())));
    } catch {
      /* dead or half-written socket — skip it */
    }
  }
  return out;
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

/** A slug is a herdr workspace LABEL, never a directory name. `list` is the resolver. */
async function resolve(slug: string): Promise<Target | null> {
  const w = (await workspaces()).find(
    (w) => w.label === slug && w.worktree?.checkout_path,
  );
  if (!w) return null;
  const wt = w.worktree!.checkout_path!;
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

async function resolveAll(slugs: string[]): Promise<Target[]> {
  const out: Target[] = [];
  for (const s of slugs) {
    const t = await resolve(s);
    if (t) out.push(t);
    else console.log(`  !! '${s}' is not a herdr workspace label here — see the list subcommand`);
  }
  return out;
}

// ── subcommands ──────────────────────────────────────────────────────────────────────
async function preflight() {
  const root = await ghqRoot();
  console.log("== local ==");
  console.log(`  ghq root   ${root}`);
  console.log(`  rsync      ${(await local(["bash", "-c", "command -v rsync"])) || "MISSING"}`);
  console.log(`== ${HOST} (login shell) ==`);
  console.log(
    await remote(`printf "  host       %s / %s\\n" "$(hostname)" "$(whoami)"
printf "  ghq root   %s\\n" "$(ghq root 2>/dev/null || echo MISSING)"
for t in herdr claude maw rsync relic; do printf "  %-10s %s\\n" $t "$(command -v $t || echo MISSING)"; done
printf "  herdr sock %s\\n" "$([ -S ~/.config/herdr/herdr.sock ] && echo present || echo ABSENT)"
printf "  retention  settings.json=%s  .claude.json=%s\\n" "$(grep -o 'cleanupPeriodDays"[^,}]*' ~/.claude/settings.json 2>/dev/null | tr -dc 0-9)" "$(grep -o 'cleanupPeriodDays"[^,}]*' ~/.claude.json 2>/dev/null | tr -dc 0-9)"`),
  );
  const far = await remote("ghq root 2>/dev/null");
  console.log("== verdict ==");
  if (far.trim() === root) {
    console.log(`  ghq roots MATCH (${root}) — encoded project dirs identical, no cwd rewrite. Proceed.`);
  } else {
    console.log(`  ghq roots DIFFER (${root} vs ${far.trim() || "?"}) — STOP. This tool does not rewrite cwd.`);
    process.exit(3);
  }
}

async function list() {
  console.log(
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
    console.log(
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
    console.log(`--- ${t.slug} ---`);
    const up = (await local(["git", "-C", t.wt, "rev-parse", "--abbrev-ref", "@{u}"])) || "NO-UPSTREAM";
    const ahead = (await local(["git", "-C", t.wt, "rev-list", "--count", "@{u}..HEAD"])) || "-";
    const dirty = await local(["git", "-C", t.wt, "status", "--porcelain"]);
    console.log(`  wt        ${t.wt}`);
    console.log(`  repo      ${t.repo}`);
    console.log(`  branch    ${t.branch}  upstream=${up.replace(/^origin\//, "")}  ahead=${ahead}`);
    const quiesced = !["working", "blocked"].includes(t.agent);
    console.log(`  agent     ${t.agent}   ${quiesced ? "(quiesced)" : "!! mid-write — sessions will be DEFERRED"}`);
    if (dirty) {
      console.log("  dirty     (uncommitted, will NOT cross via git):");
      for (const l of dirty.split("\n")) console.log(`            ${l}`);
    } else console.log("  dirty     clean");
    const top = await local(["bash", "-c", `ls ${q(t.pd)}/*.jsonl 2>/dev/null | wc -l`]);
    const all = await local(["bash", "-c", `find ${q(t.pd)} -name '*.jsonl' 2>/dev/null | wc -l`]);
    const du = await local(["bash", "-c", `du -sh ${q(t.pd)} 2>/dev/null | cut -f1`]);
    console.log(`  sessions  ${t.pd}  (${top.trim()} top-level, ${all.trim()} files, ${du})`);
    const f = far.get(t.slug);
    if (f) console.log(`  remote    ${f[0]} ${f[1]}  remote-top-level-jsonl=${f[2]}`);
    console.log("  rsync DRY-RUN (--ignore-existing):");
    const dry = await $`rsync -avn --ignore-existing --stats -e ${"ssh -o BatchMode=yes"} ${t.pd + "/"} ${HOST + ":.claude/projects/" + t.enc + "/"}`.quiet();
    for (const l of dry.stdout.toString().split("\n")) {
      if (/Number of regular files transferred|Total transferred file size/.test(l)) console.log(`            ${l.trim()}`);
    }
  }
}

async function ferry(slugs: string[]) {
  const all = await resolveAll(slugs);
  const ts: Target[] = [];

  // Phase 1, local and per-slug: push the branch, then rsync the sessions.
  for (const t of all) {
    console.log(`--- ${t.slug} ---`);
    if (t.branch === "main" || t.branch === "master") {
      console.log(`  !! branch is ${t.branch} — never push main from here. Skipping.`);
      continue;
    }
    ts.push(t);
    const hasUp = (await $`git -C ${t.wt} rev-parse --abbrev-ref @{u}`.quiet()).exitCode === 0;
    const push = hasUp
      ? await $`git -C ${t.wt} push origin ${t.branch}`.quiet()
      : await $`git -C ${t.wt} push -u origin ${t.branch}`.quiet();
    const pushLines = (push.stdout.toString() + push.stderr.toString()).trim().split("\n");
    console.log(`  push      ${pushLines[pushLines.length - 1] ?? ""}`);

    // idle / done / none are quiescent; only working|blocked means a transcript is
    // mid-append. Under --ignore-existing a torn copy is PERMANENT, because the next
    // run sees the file and skips it. So defer the sessions and let the layout cross.
    if (["working", "blocked"].includes(t.agent)) {
      console.log(`  rsync     DEFERRED — agent is '${t.agent}'; re-run ferry for this slug when idle (merge-safe)`);
    } else {
      const r = await $`rsync -a --ignore-existing --stats -e ${"ssh -o BatchMode=yes"} ${t.pd + "/"} ${HOST + ":.claude/projects/" + t.enc + "/"}`.quiet();
      const stats = r.stdout
        .toString()
        .split("\n")
        .filter((l) => /Number of regular files transferred|Total transferred file size/.test(l))
        .map((l) => l.trim())
        .join("  ");
      console.log(`  rsync     ${stats}`);
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
  console.log(`--- far side (1 ssh, ${ts.length} slug${ts.length === 1 ? "" : "s"}) ---`);
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
  console.log(await remote(script));
}

async function verify(slugs: string[]) {
  const ts = await resolveAll(slugs);
  const heads = new Map<string, string>();
  for (const t of ts) heads.set(t.slug, await local(["git", "-C", t.wt, "rev-parse", "--short=8", "HEAD"]));

  // One ssh for every lock of every slug.
  const out = await remote(
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
  console.log(out);
  console.log(
    `  L4 consumer content: pick a term only THIS work would produce, then run\n     ssh ${HOST} 'grep -lc <term> ~/.claude/projects/<enc>/*.jsonl'`,
  );
}

async function ledger(slugs: string[]) {
  const ts = await resolveAll(slugs);
  const root = await ghqRoot();
  console.log(`# Ferry ledger — ${ts.length} worktree(s) → ${HOST}\n`);
  console.log(`- **Date:** ${new Date().toISOString().slice(0, 10)}`);
  console.log("- **Mode:** COPY, merge-safe (`rsync -a --ignore-existing`)");
  console.log(`- **Source:** ${userInfo().username}@${hostname().split(".")[0]}`);
  console.log(`- **Destination:** ${HOST}, same ghq root (${root}) — no cwd rewrite`);
  console.log("- **Driven by:** /noah-bring\n");
  console.log("| slug | branch | HEAD | remote files | remote size |");
  console.log("|---|---|---|---|---|");

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
    console.log(`| ${t.slug} | ${t.branch} | ${head} | ${f[0]} | ${f[1]} |`);
  }

  console.log("\n## Locks\n\n```");
  await verify(slugs);
  console.log("```\n");
  console.log(
    "**L4 (consumer content)** is the one lock a script cannot run for you: it needs a term\nonly THIS work would produce. A generic word hits on any transcript and proves nothing.\nPick one, run it, paste the result.\n",
  );
  console.log("## Not crossed\n\nUncommitted at ferry time, so it stayed on the source machine:\n\n```");
  for (const t of ts) {
    const d = await local(["git", "-C", t.wt, "status", "--porcelain"]);
    console.log(d ? `${t.slug}:\n${d}` : `${t.slug}: clean`);
  }
  console.log("```\n\n`.envrc` holds a token reference and stays local by design.\n\n## Traps hit\n\n-");
}

// ── entry ────────────────────────────────────────────────────────────────────────────
const [cmd, host, ...slugs] = Bun.argv.slice(2);
if (!cmd || !host) {
  const src = await Bun.file(import.meta.path).text();
  const doc = src.split("\n").slice(2, 18).map((l) => l.replace(/^ \*ial?/, "").replace(/^ \* ?/, "").replace(/^ \*\/?$/, ""));
  console.log(doc.join("\n").trim());
  process.exit(2);
}
HOST = host;

const needSlugs = () => {
  if (!slugs.length) {
    console.log("need at least one <slug> (a herdr workspace label — see `list`)");
    process.exit(2);
  }
};

switch (cmd) {
  case "preflight": await preflight(); break;
  case "list": await list(); break;
  case "check": needSlugs(); await check(slugs); break;
  case "ferry": needSlugs(); await ferry(slugs); break;
  case "verify": needSlugs(); await verify(slugs); break;
  case "ledger": needSlugs(); await ledger(slugs); break;
  default:
    console.log(`unknown subcommand: ${cmd}`);
    process.exit(2);
}
