#!/usr/bin/env node
// pending-promotion-all.mjs
//
// Which tickets are on `dev` but NOT yet on `staging` or `main`, across every
// repo at once - the full promotion backlog for the whole product.
//
// It is the multi-repo sibling of pending-promotion.mjs. By default it scans
// api, admin, app and infra; pass --repos to narrow it. For each repo it reads
// the promotion pipeline straight from git (no checkout, no running API):
//
//   dev --> staging --> main
//
// and reports, per hop, the non-merge commits present on the source branch but
// absent from the target branch. It extracts the Jira ticket (ETS-####) and
// GitHub PR (#NNN) from each commit subject, fetches each ticket's live Jira
// status once (batched via the tasks/jira CLI), then groups the result two ways:
//
//   - by branch (repo)  -> what each codebase still needs to promote
//   - by status         -> what is actually cleared to promote right now
//
// A ticket that lives in more than one repo (e.g. a coordinated api+admin change)
// is shown under each repo, and once in the by-status rollup tagged with its repos.
//
// It also surfaces HOTFIXES: changes that shipped straight to `staging`/`main`
// and never made it back to `dev`. Those must be back-merged or the next
// promotion silently reverts them. A plain reverse sha diff is pure noise here -
// promotions squash-remerge, so the same ticket lives on staging/main under a
// DIFFERENT sha than on dev. So a commit is only a hotfix when its Jira ticket
// (or, for ticketless commits, its exact subject) is absent from dev entirely.
//
// Two further ways a pipeline goes wrong, each with its own section:
//
//   - HALF-PROMOTED: a ticket delivered by several repos that reached production
//     in only some of them. Every repo looks internally fine, so nothing else
//     catches it - and the ticket reads as Done while half of it is not live.
//   - BEHIND: a target branch missing what the branch BELOW it already has
//     (staging behind main). The hotfix check only compares targets against dev,
//     so a change promoted straight to main stays invisible there, and staging
//     silently stops representing what production runs.
//
// Usage:
//   ./scripts/pending-promotion-all.mjs                    # all repos, dev->staging->main
//   ./scripts/pending-promotion-all.mjs --repos api,admin  # only these repos
//   ./scripts/pending-promotion-all.mjs api                # positional shorthand
//   ./scripts/pending-promotion-all.mjs --to staging       # only the dev->staging hop
//   ./scripts/pending-promotion-all.mjs --no-hotfixes      # skip the hotfix (back-merge) section
//   ./scripts/pending-promotion-all.mjs --no-fetch         # skip git fetch (offline / fast)
//   ./scripts/pending-promotion-all.mjs --no-jira          # skip the Jira status lookup
//   ./scripts/pending-promotion-all.mjs --json             # machine-readable output
//   ./scripts/pending-promotion-all.mjs --help

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2S_ROOT = path.resolve(SCRIPT_DIR, '..');
const JIRA_CLI_DIR = path.join(E2S_ROOT, 'tasks', 'jira');

// Repo short name -> { dir under e2s root, GitHub owner/repo for PR links }.
const REPOS = {
  api: { dir: 'eats2seats-api', slug: 'Eats2Seats/eats2seats-api' },
  admin: { dir: 'eats2seats-admin', slug: 'Eats2Seats/eats2seats-admin' },
  app: { dir: 'eats2seats-app', slug: 'Eats2Seats/eats2seats-app' },
  infra: { dir: 'eats2seats-infra', slug: 'Eats2Seats/eats2seats-infra' },
};
const DEFAULT_REPOS = ['api', 'admin', 'app', 'infra'];

// Jira browse base, derived from the single source of truth ($JIRA_BASE_URL, or
// tasks/jira/.env - the same value the jira CLI uses) so the host never drifts
// out of sync again. Note: the org is "Eats2Seats" but the Jira site is spelled
// "eatstoseats" (with "to"); the fallback below is the known-correct host.
function jiraBrowseBase() {
  const fallback = 'https://eatstoseats.atlassian.net';
  let base = process.env.JIRA_BASE_URL;
  if (!base) {
    try {
      const env = fs.readFileSync(path.join(JIRA_CLI_DIR, '.env'), 'utf8');
      const m = env.match(/^\s*JIRA_BASE_URL\s*=\s*(.+?)\s*$/m);
      if (m) base = m[1].replace(/^["']|["']$/g, '');
    } catch {
      // no .env reachable - fall back to the known host.
    }
  }
  return `${(base || fallback).replace(/\/+$/, '')}/browse`;
}
const JIRA_BASE = jiraBrowseBase();
// Code promotes strictly in this direction; a target must be "below" the source.
const PROMOTION_ORDER = ['dev', 'staging', 'main'];
// Every run drops a timestamped copy of the report here (inside the global-docs repo).
const SYNC_DIR = path.join(E2S_ROOT, 'global-docs', 'sync');

function fail(msg, code = 2) {
  console.error(`pending-promotion-all: ${msg}`);
  process.exit(code);
}

function printHelp() {
  console.log(
    `pending-promotion-all - tickets on dev not yet on staging/main, across every repo\n\n` +
      `Usage: ./scripts/pending-promotion-all.mjs [repos] [options]\n\n` +
      `  [repos]                        Comma list, positional (e.g. "api,admin"). Same as --repos.\n` +
      `  --repos <a,b,...>              Repos to scan (default: ${DEFAULT_REPOS.join(',')}).\n` +
      `                                 Short (api/admin/app/infra) or full eats2seats-* names.\n` +
      `  --from <branch>               Source env branch (default: dev).\n` +
      `  --to <staging|main>           Furthest target (default: main = show both hops).\n` +
      `                                 staging = only the dev->staging hop.\n` +
      `  --no-hotfixes                 Skip the hotfix section (changes on staging/main\n` +
      `                                 whose ticket never made it back to dev).\n` +
      `  --no-fetch                    Do not run 'git fetch' first.\n` +
      `  --no-jira                     Skip the Jira status lookup.\n` +
      `  --no-report                   Do not write the timestamped copy under global-docs/sync/.\n` +
      `  --json                        Emit JSON instead of Markdown.\n` +
      `  --help                        Show this help.\n\n` +
      `Each run also saves the Markdown report to global-docs/sync/<timestamp>.check.md\n` +
      `(unless --no-report). --json prints JSON to stdout and writes no file.\n`,
  );
}

function git(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

// Patch-ids already present on `to` (via `git cherry`). A commit that reached the
// target under a DIFFERENT sha - a cherry-pick or hotfix, common because dev is
// squash-merged - is marked "-" here. Plain ancestry (`to..from`) can't see that
// and would report it as pending: a false positive.
function alreadyAppliedShas(repoDir, from, to) {
  const applied = new Set();
  let out;
  try {
    out = git(repoDir, ['cherry', `origin/${to}`, `origin/${from}`]);
  } catch {
    return applied; // patch-id compare unavailable - fall back to ancestry only.
  }
  for (const line of out.split('\n')) {
    if (line.startsWith('- ')) applied.add(line.slice(2).trim());
  }
  return applied;
}

// A commit subject reduced to what identifies the CHANGE rather than the merge
// that carried it: the trailing "(#NNN)" differs between the dev squash and the
// hotfix cherry-pick of the same work, so it must not defeat the comparison.
function normalizeSubject(subject) {
  return subject.replace(/\s*\(#\d+\)\s*$/, '').trim().toLowerCase();
}

// Non-merge commits present on `from` but not yet on `to`, newest first.
// Uses a NUL field separator so subjects with spaces stay intact.
//
// Two independent filters decide "already on the target", because neither alone
// is sufficient:
//
//   1. patch-id (`git cherry`) - catches a re-squash whose diff is byte-identical.
//   2. normalized subject      - catches a cherry-pick whose diff is NOT identical.
//
// (2) exists because patch-id is fragile in exactly the cases we care about: git
// cherry compares without rename detection (a commit that moves files gets a
// different id on each branch), a cherry-pick taken before a directory reorg
// touches a different path, and a version bump applied over a hotfixed base has a
// different "from" line. All three shipped and must not resurface as pending.
// A ticketless commit needs an EXACT subject match, since a generic subject
// ("fix lint") is not evidence on its own.
//
// Subject matching is one-to-one: each occurrence on the target vouches for a
// single pending commit. A ticket often ships a follow-up under the very same
// subject ("[FE] Event Date cut off in import matrix modal" twice), and only the
// first of them is on the target - counting matches keeps the second pending.
// Candidates are consumed oldest-first so the leftover is the newer commit.
function commitsAhead(repoDir, from, to) {
  const applied = alreadyAppliedShas(repoDir, from, to);
  const target = branchIndex(repoDir, to);
  const budget = new Map(target.subjectCounts);
  const out = git(repoDir, [
    'log',
    '--no-merges',
    '--format=%H%x00%s',
    `origin/${to}..origin/${from}`,
  ]);
  if (!out) return [];
  const commits = out.split('\n').map((line) => {
    const [sha, subject] = line.split('\x00');
    return { sha, subject };
  });
  const pending = [];
  for (const c of [...commits].reverse()) {
    const norm = normalizeSubject(c.subject);
    // A patch-id match consumes its subject's budget as well - otherwise the
    // target occurrence it just matched would be spent a second time, on a
    // same-subject follow-up that is genuinely still pending.
    if (applied.has(c.sha)) {
      budget.set(norm, Math.max(0, (budget.get(norm) ?? 0) - 1));
      continue;
    }
    const hasTicket = /\b(?:ETS|EAT)-\d+\b/.test(c.subject);
    const matchable = hasTicket || target.subjects.has(c.subject);
    const left = budget.get(norm) ?? 0;
    if (matchable && left > 0) {
      budget.set(norm, left - 1);
      continue;
    }
    pending.push(c);
  }
  return pending.reverse(); // back to newest-first
}

function shortSha(repoDir, ref) {
  try {
    return git(repoDir, ['rev-parse', '--short', ref]);
  } catch {
    return '?';
  }
}

// Pull ETS-#### / EAT-#### tickets and the trailing "(#NNN)" PR out of a subject.
function parseSubject(subject) {
  const tickets = [...subject.matchAll(/\b((?:ETS|EAT)-\d+)\b/g)].map((m) => m[1]);
  const prMatch = subject.match(/\(#(\d+)\)\s*$/) || subject.match(/#(\d+)/);
  return { tickets: [...new Set(tickets)], pr: prMatch ? Number(prMatch[1]) : null };
}

// Group a hop's commits by ticket; commits with no ticket land under a null bucket.
function groupByTicket(commits) {
  const groups = new Map();
  for (const c of commits) {
    const { tickets, pr } = parseSubject(c.subject);
    const keys = tickets.length ? tickets : [null];
    for (const key of keys) {
      if (!groups.has(key)) groups.set(key, { ticket: key, prs: new Set(), commits: [] });
      const g = groups.get(key);
      if (pr) g.prs.add(pr);
      g.commits.push(c);
    }
  }
  return [...groups.values()].map((g) => ({
    ticket: g.ticket,
    prs: [...g.prs].sort((a, b) => a - b),
    commitCount: g.commits.length,
    subjects: g.commits.map((c) => c.subject),
  }));
}

// Everything that identifies a change already present on `branch`: the Jira ticket
// keys seen in any subject, the raw subjects, and their normalized form. Used both
// to decide whether a downstream commit is a real hotfix or just a squash-remerge
// of something dev already has (same ticket, different sha), and to filter the
// promotion backlog itself. Memoized: a full `git log` per branch is walked once,
// and several callers ask for the same branch.
const BRANCH_INDEX_CACHE = new Map();
function branchIndex(repoDir, branch) {
  const cacheKey = `${repoDir} ${branch}`;
  const cached = BRANCH_INDEX_CACHE.get(cacheKey);
  if (cached) return cached;
  const out = git(repoDir, ['log', '--no-merges', '--format=%s', `origin/${branch}`]);
  const tickets = new Set();
  const subjects = new Set();
  // How MANY times each subject occurs, not merely whether it does: a follow-up
  // commit often reuses its predecessor's subject verbatim, and one match on the
  // target must not vouch for both.
  const subjectCounts = new Map();
  if (out) {
    for (const subject of out.split('\n')) {
      subjects.add(subject);
      const norm = normalizeSubject(subject);
      subjectCounts.set(norm, (subjectCounts.get(norm) ?? 0) + 1);
      for (const m of subject.matchAll(/\b((?:ETS|EAT)-\d+)\b/g)) tickets.add(m[1]);
    }
  }
  const index = { tickets, subjects, subjectCounts };
  BRANCH_INDEX_CACHE.set(cacheKey, index);
  return index;
}

// Hotfixes: commits living on a downstream branch (staging/main) whose change
// never reached the upstream `from` branch (dev). We key on the ticket, not the
// sha - a ticket promoted forward sits on staging/main under a re-squashed sha,
// so a sha-only reverse diff would flag every promoted commit. A commit counts
// as a hotfix only when none of its tickets appear on `from` (and, for a
// ticketless commit, when its exact subject is absent from `from`). Returns
// commits deduped by sha, each tagged with the downstream branch(es) it sits on.
function findHotfixes(repoDir, from, downstreamBranches) {
  const upstream = branchIndex(repoDir, from);
  const bySha = new Map();
  for (const branch of downstreamBranches) {
    for (const c of commitsAhead(repoDir, branch, from)) {
      const { tickets } = parseSubject(c.subject);
      const reachedUpstream = tickets.length
        ? tickets.every((t) => upstream.tickets.has(t))
        : upstream.subjects.has(c.subject);
      if (reachedUpstream) continue;
      if (!bySha.has(c.sha)) bySha.set(c.sha, { ...c, branches: new Set() });
      bySha.get(c.sha).branches.add(branch);
    }
  }
  return [...bySha.values()];
}

// Group hotfix commits by ticket, merging the branch(es) each ticket appears on.
function groupHotfixes(commits) {
  const groups = new Map();
  for (const c of commits) {
    const { tickets, pr } = parseSubject(c.subject);
    const keys = tickets.length ? tickets : [null];
    for (const key of keys) {
      if (!groups.has(key)) {
        groups.set(key, { ticket: key, prs: new Set(), branches: new Set(), commits: [] });
      }
      const g = groups.get(key);
      if (pr) g.prs.add(pr);
      for (const b of c.branches) g.branches.add(b);
      g.commits.push(c);
    }
  }
  return [...groups.values()].map((g) => ({
    ticket: g.ticket,
    prs: [...g.prs].sort((a, b) => a - b),
    branches: [...g.branches].sort((a, b) => PROMOTION_ORDER.indexOf(a) - PROMOTION_ORDER.indexOf(b)),
    commitCount: g.commits.length,
    subjects: g.commits.map((c) => c.subject),
  }));
}

// Reverse drift BETWEEN TARGETS: commits on a downstream branch (main) that the
// branch above it (staging) does not have. The hotfix section only compares the
// targets against `from` (dev), so a change that is on dev AND on main but was
// never promoted through staging is invisible there - yet it means staging no
// longer represents what production runs, and the next staging deploy ships an
// older artifact than prod. `onSource` separates the two causes: true = staging
// merely lagging behind a straight-to-main promotion, false = a genuine hotfix
// (already listed in the hotfix section) that also skipped staging.
function findBehind(repoDir, upper, lower, sourceBranch) {
  const source = branchIndex(repoDir, sourceBranch);
  const commits = commitsAhead(repoDir, lower, upper);
  return groupByTicket(commits).map((t) => ({
    ...t,
    onSource: t.ticket ? source.tickets.has(t.ticket) : source.subjects.has(t.subjects[0]),
  }));
}

// Tickets delivered by more than one repo where only SOME repos reached the final
// target. The per-repo backlog cannot show this: each repo looks internally
// consistent, and the ticket reads as pending in one place and shipped in another,
// so a `[FE/BE]` ticket marked Done can be half-live in production - the worst
// case, because it looks delivered and is not. Keyed on the ticket appearing in
// any subject on the branch, not on sha or patch-id, since the two repos share
// nothing but the ticket id.
function findHalfPromoted(repoIndexes) {
  const byTicket = new Map();
  for (const { repo, shipped, pending } of repoIndexes) {
    for (const ticket of shipped) {
      if (!byTicket.has(ticket)) byTicket.set(ticket, { ticket, shipped: [], pending: [] });
      byTicket.get(ticket).shipped.push(repo);
    }
    for (const ticket of pending) {
      if (!byTicket.has(ticket)) byTicket.set(ticket, { ticket, shipped: [], pending: [] });
      byTicket.get(ticket).pending.push(repo);
    }
  }
  return [...byTicket.values()]
    .filter((t) => t.shipped.length > 0 && t.pending.length > 0)
    .map((t) => ({ ...t, shipped: t.shipped.sort(), pending: t.pending.sort() }));
}

// Batch-fetch live Jira status for many keys via the tasks/jira CLI (chunked).
function fetchJiraStatuses(keys) {
  const byKey = {};
  if (keys.length === 0) return byKey;
  const CHUNK = 80;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const jql = `key in (${chunk.join(',')}) ORDER BY key ASC`;
    let raw;
    try {
      raw = execFileSync(
        'pnpm',
        ['--silent', 'jira', 'jql', jql, '--json', '--limit', String(chunk.length)],
        { cwd: JIRA_CLI_DIR, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      );
    } catch (err) {
      console.error(
        `pending-promotion-all: Jira lookup failed (${err.message}); continuing without statuses.`,
      );
      return byKey;
    }
    const start = raw.indexOf('[');
    if (start === -1) continue;
    let rows;
    try {
      rows = JSON.parse(raw.slice(start));
    } catch {
      continue;
    }
    for (const row of rows) byKey[row.key] = row;
  }
  return byKey;
}

// dev->staging->main hops to inspect, given the furthest target `to`.
function hopsFor(from, to) {
  const fromIdx = PROMOTION_ORDER.indexOf(from);
  const toIdx = PROMOTION_ORDER.indexOf(to);
  const hops = [];
  for (let i = fromIdx; i < toIdx; i++) {
    hops.push({ from: PROMOTION_ORDER[i], to: PROMOTION_ORDER[i + 1] });
  }
  return hops;
}

// Maps a Jira status to its report marker. Matching is on substrings because the workflow
// renames its statuses from time to time; an unmatched status degrades to '•' rather than
// failing, so a rename shows up as a missing marker, never as a crash.
//
// 'In Staging' must be tested before 'ready for staging': a ticket already on staging is
// further along than one merely cleared for it, and they are ranked differently.
function statusEmoji(status) {
  if (!status) return '';
  const s = status.toLowerCase();
  if (s.includes('reject')) return '🔴';
  if (s.includes('done')) return '✅';
  if (s.includes('in staging')) return '🚀';
  // Covers both 'Ready for Staging' and 'Ready for Production', plus the pre-2026-07 wording
  // ('Ready to release to STG/Prod') in case a stale cache or an old export is read back.
  if (s.includes('ready for staging') || s.includes('ready for production') || s.includes('release')) return '🟢';
  if (s.includes('qa ready')) return '🔵';
  if (s.includes('in progress')) return '🟡';
  if (s.includes('to do')) return '⚪';
  return '•';
}

function ticketSortKey(a, b) {
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b, undefined, { numeric: true });
}

// Filesystem-safe local timestamp, e.g. 2026-07-08_14-30-05 (for the report filename).
function fileStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

function main() {
  // parseArgs has no built-in --no-<flag> negation, so strip those first.
  const rawArgs = process.argv.slice(2);
  const noFetch = rawArgs.includes('--no-fetch');
  const noJira = rawArgs.includes('--no-jira');
  const noReport = rawArgs.includes('--no-report');
  const noHotfixes = rawArgs.includes('--no-hotfixes');
  const cleanArgs = rawArgs.filter(
    (a) =>
      a !== '--no-fetch' && a !== '--no-jira' && a !== '--no-report' && a !== '--no-hotfixes',
  );

  let parsed;
  try {
    parsed = parseArgs({
      args: cleanArgs,
      allowPositionals: true,
      options: {
        repos: { type: 'string' },
        repo: { type: 'string' }, // alias, for muscle memory with pending-promotion.mjs
        from: { type: 'string', default: 'dev' },
        to: { type: 'string', default: 'main' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    fail(err.message);
  }
  const opts = parsed.values;
  opts.fetch = !noFetch;
  opts.jira = !noJira;
  opts.report = !noReport;
  opts.hotfixes = !noHotfixes;
  if (opts.help) {
    printHelp();
    return;
  }

  const { from, to } = opts;
  if (!PROMOTION_ORDER.includes(from)) fail(`--from must be one of ${PROMOTION_ORDER.join(', ')}`);
  if (!PROMOTION_ORDER.includes(to)) fail(`--to must be one of ${PROMOTION_ORDER.join(', ')}`);
  if (PROMOTION_ORDER.indexOf(from) >= PROMOTION_ORDER.indexOf(to)) {
    fail(`--from ${from} must be higher than --to ${to} in the ${PROMOTION_ORDER.join(' -> ')} order`);
  }
  const hops = hopsFor(from, to);

  // Repo selection: positional list, --repos, or --repo alias; default all four.
  const repoSpec = parsed.positionals.join(',') || opts.repos || opts.repo || DEFAULT_REPOS.join(',');
  const repoKeys = repoSpec
    .split(',')
    .map((r) => r.trim().replace(/^eats2seats-/, ''))
    .filter(Boolean);
  const unknown = repoKeys.filter((r) => !REPOS[r]);
  if (unknown.length) fail(`unknown repo(s): ${unknown.join(', ')} (expected ${Object.keys(REPOS).join(', ')})`);

  const perRepo = [];
  for (const key of repoKeys) {
    const repo = REPOS[key];
    const repoDir = path.join(E2S_ROOT, repo.dir);
    if (!fs.existsSync(path.join(repoDir, '.git'))) {
      console.error(`pending-promotion-all: skipping ${key} - not a git repo at ${repoDir}`);
      continue;
    }
    if (opts.fetch) {
      try {
        // --quiet + ignored stderr so the "[deleted] -> origin/ETS-xxxx" prune
        // lines (stale merged-PR branches git cleans up) never leak into output.
        execFileSync('git', ['-C', repoDir, 'fetch', '--all', '--prune', '--quiet'], {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } catch (err) {
        console.error(`pending-promotion-all: git fetch failed for ${key} (${err.message}); using local refs.`);
      }
    }
    const hopResults = hops.map((hop) => {
      const commits = commitsAhead(repoDir, hop.from, hop.to);
      return {
        from: hop.from,
        to: hop.to,
        commitCount: commits.length,
        tickets: groupByTicket(commits),
      };
    });
    // Hotfixes flow the other way: things on the downstream branches (staging/main)
    // that never made it back up to `from` (dev).
    const downstream = hops.map((h) => h.to);
    const hotfixes = opts.hotfixes
      ? groupHotfixes(findHotfixes(repoDir, from, downstream))
      : null;
    // Drift between the targets themselves (staging behind main). The first hop
    // starts at `from`, and that direction is what the hotfix section covers.
    const behind = hops.slice(1).map((hop) => ({
      upper: hop.from,
      lower: hop.to,
      tickets: findBehind(repoDir, hop.from, hop.to, from),
    }));
    // Ticket-level reach, for the cross-repo half-promotion check.
    const finalTo = hops[hops.length - 1].to;
    const shippedTickets = branchIndex(repoDir, finalTo).tickets;
    const sourceTickets = branchIndex(repoDir, from).tickets;
    perRepo.push({
      repo: key,
      dir: repo.dir,
      slug: repo.slug,
      tips: Object.fromEntries(
        [...new Set([from, ...hops.map((h) => h.to)])].map((b) => [b, shortSha(repoDir, `origin/${b}`)]),
      ),
      hops: hopResults,
      hotfixes,
      behind,
      shipped: shippedTickets,
      pending: new Set([...sourceTickets].filter((t) => !shippedTickets.has(t))),
    });
  }

  const halfPromoted = findHalfPromoted(perRepo);

  // One batched Jira lookup for every distinct ticket across all repos + hops.
  const allKeys = new Set();
  for (const r of perRepo) {
    for (const h of r.hops) for (const t of h.tickets) if (t.ticket) allKeys.add(t.ticket);
    for (const t of r.hotfixes ?? []) if (t.ticket) allKeys.add(t.ticket);
    for (const b of r.behind) for (const t of b.tickets) if (t.ticket) allKeys.add(t.ticket);
  }
  for (const t of halfPromoted) allKeys.add(t.ticket);
  const sortedKeys = [...allKeys].sort(ticketSortKey);
  const statuses = opts.jira ? fetchJiraStatuses(sortedKeys) : {};
  const statusOf = (key) => (key ? statuses[key]?.status ?? (opts.jira ? 'Unknown' : null) : null);
  const titleOf = (key) => (key ? statuses[key]?.title ?? null : null);

  if (opts.json) {
    const out = {
      meta: { from, to, repos: repoKeys, hops: hops.map((h) => `${h.from}->${h.to}`) },
      repos: perRepo.map((r) => ({
        repo: r.repo,
        tips: r.tips,
        hops: r.hops.map((h) => ({
          from: h.from,
          to: h.to,
          commitCount: h.commitCount,
          tickets: h.tickets.map((t) => ({
            ...t,
            status: statusOf(t.ticket),
            title: titleOf(t.ticket),
          })),
        })),
        hotfixes:
          r.hotfixes &&
          r.hotfixes.map((t) => ({
            ...t,
            status: statusOf(t.ticket),
            title: titleOf(t.ticket),
          })),
        behind: r.behind.map((b) => ({
          upper: b.upper,
          lower: b.lower,
          tickets: b.tickets.map((t) => ({
            ...t,
            status: statusOf(t.ticket),
            title: titleOf(t.ticket),
          })),
        })),
      })),
      halfPromoted: halfPromoted.map((t) => ({
        ...t,
        status: statusOf(t.ticket),
        title: titleOf(t.ticket),
      })),
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const markdown = renderMarkdown(perRepo, hops, halfPromoted, statusOf, titleOf);
  console.log(markdown);

  // Drop a timestamped copy under global-docs/sync/ so runs are auditable over time.
  if (opts.report) {
    try {
      fs.mkdirSync(SYNC_DIR, { recursive: true });
      const outPath = path.join(SYNC_DIR, `${fileStamp()}.check.md`);
      fs.writeFileSync(outPath, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
      console.error(`\npending-promotion-all: report saved to ${path.relative(E2S_ROOT, outPath)}`);
    } catch (err) {
      console.error(`pending-promotion-all: could not write report file (${err.message}).`);
    }
  }
}

function renderMarkdown(perRepo, hops, halfPromoted, statusOf, titleOf) {
  const L = [];
  const hopLabel = hops.map((h) => `${h.from} -> ${h.to}`).join(', ');
  L.push(`# Pending promotion - ${perRepo.map((r) => r.repo).join(', ')}`);
  L.push('');
  L.push(`Generated: ${new Date().toLocaleString('sv')} (local time)`);
  L.push(`Hops: ${hopLabel}. Anything listed is on the source branch but not yet on the target.`);
  L.push('');

  // ---- Grouping 1: by branch (repo) ----
  L.push('## By branch (repo)');
  for (const r of perRepo) {
    const totalTickets = r.hops.reduce((n, h) => n + h.tickets.filter((t) => t.ticket).length, 0);
    L.push('');
    L.push(`### ${r.repo}`);
    if (r.hops.every((h) => h.tickets.length === 0)) {
      L.push('_In sync - nothing pending._');
      continue;
    }
    for (const h of r.hops) {
      const tips = `${r.tips[h.from]} -> ${r.tips[h.to]}`;
      L.push('');
      L.push(`**${h.from} -> ${h.to}** (${tips}) - ${h.commitCount} commit(s):`);
      if (h.tickets.length === 0) {
        L.push('- _in sync_');
        continue;
      }
      L.push('');
      L.push('| Ticket | Title | PRs | Jira status |');
      L.push('|--------|-------|-----|-------------|');
      for (const t of [...h.tickets].sort((a, b) => ticketSortKey(a.ticket, b.ticket))) {
        L.push(row(t, r.slug, statusOf, titleOf));
      }
    }
  }
  L.push('');

  // ---- Grouping 2: by status (across every repo) ----
  // Aggregate each ticket once, tracking which repo(s) and hop(s) it sits in.
  const agg = new Map();
  for (const r of perRepo) {
    for (const h of r.hops) {
      for (const t of h.tickets) {
        if (!t.ticket) continue;
        if (!agg.has(t.ticket)) {
          agg.set(t.ticket, { ticket: t.ticket, repos: new Set(), hops: new Set(), prs: new Set() });
        }
        const a = agg.get(t.ticket);
        a.repos.add(r.repo);
        a.hops.add(`${h.from}->${h.to}`);
        for (const pr of t.prs) a.prs.add(pr);
      }
    }
  }

  const byStatus = new Map();
  for (const a of agg.values()) {
    const status = statusOf(a.ticket) ?? 'Unknown';
    if (!byStatus.has(status)) byStatus.set(status, []);
    byStatus.get(status).push(a);
  }

  L.push('## By status');
  if (byStatus.size === 0) {
    L.push('');
    L.push('_Nothing pending - every selected repo is in sync._');
  } else {
    // Sort statuses by a rough "closeness to release" order, then alphabetically.
    const statusRank = (s) => {
      const e = statusEmoji(s);
      return ['🚀', '🟢', '🔵', '🟡', '⚪', '🔴', '✅', '•', ''].indexOf(e);
    };
    const statusesSorted = [...byStatus.keys()].sort((a, b) => statusRank(a) - statusRank(b) || a.localeCompare(b));
    for (const status of statusesSorted) {
      const items = byStatus.get(status).sort((a, b) => ticketSortKey(a.ticket, b.ticket));
      L.push('');
      L.push(`### ${statusEmoji(status)} ${status} (${items.length})`);
      for (const a of items) {
        const repos = [...a.repos].sort().join(', ');
        const title = titleOf(a.ticket) ? ` - ${titleOf(a.ticket)}` : '';
        L.push(`- [${a.ticket}](${JIRA_BASE}/${a.ticket}) [${repos}]${title}`);
      }
    }
  }

  renderHalfPromoted(L, halfPromoted, perRepo, statusOf, titleOf);
  renderHotfixes(L, perRepo, statusOf, titleOf);
  renderBehind(L, perRepo, statusOf, titleOf);

  return L.join('\n');
}

// ---- Half-promoted: shipped in one repo, still pending in another ----
function renderHalfPromoted(L, halfPromoted, perRepo, statusOf, titleOf) {
  if (perRepo.length < 2) return; // needs at least two repos to compare
  L.push('');
  L.push('## Half-promoted across repos');
  L.push('');
  L.push(
    '_Tickets whose work reached the final target in one repo but is still waiting in another - a `[FE/BE]` ticket half-live in production. Each repo looks internally consistent, so only this cross-repo view catches it._',
  );
  if (halfPromoted.length === 0) {
    L.push('');
    L.push('_None - every shared ticket landed in the same place in every repo._');
    return;
  }
  L.push('');
  L.push('| Ticket | Title | Shipped | Still pending | Jira status |');
  L.push('|--------|-------|---------|---------------|-------------|');
  for (const t of [...halfPromoted].sort((a, b) => ticketSortKey(a.ticket, b.ticket))) {
    const title = (titleOf(t.ticket) ?? '').replace(/\|/g, '\\|');
    const status = statusOf(t.ticket);
    const statusCell = status ? `${statusEmoji(status)} ${status}`.trim() : '';
    L.push(
      `| [${t.ticket}](${JIRA_BASE}/${t.ticket}) | ${title} | ${t.shipped.join(', ')} | ${t.pending.join(', ')} | ${statusCell} |`,
    );
  }
}

// ---- Behind: a target branch missing what the branch below it already has ----
function renderBehind(L, perRepo, statusOf, titleOf) {
  const pairs = perRepo.flatMap((r) =>
    (r.behind ?? []).filter((b) => b.tickets.length).map((b) => ({ repo: r, ...b })),
  );
  const labels = [...new Set((perRepo[0]?.behind ?? []).map((b) => `${b.lower} -> ${b.upper}`))];
  if (labels.length === 0) return; // single hop: nothing between targets to compare
  L.push('');
  L.push('## Behind (a target is missing what the branch below it has)');
  L.push('');
  L.push(
    `_Commits on the downstream branch that the branch above it never got (${labels.join(', ')}). Staging then no longer represents production, and its next deploy ships an older artifact than prod. "On dev" = the change exists upstream and staging is simply lagging; "not on dev" means it is also an un-back-merged hotfix._`,
  );
  if (pairs.length === 0) {
    L.push('');
    L.push('_None - every target branch is a superset of the one below it._');
    return;
  }
  for (const p of pairs) {
    L.push('');
    L.push(`### ${p.repo.repo}: ${p.upper} is behind ${p.lower} (${p.tickets.length})`);
    L.push('');
    L.push('| Ticket | Title | PRs | On dev | Jira status |');
    L.push('|--------|-------|-----|--------|-------------|');
    for (const t of [...p.tickets].sort((a, b) => ticketSortKey(a.ticket, b.ticket))) {
      const ticketCell = t.ticket ? `[${t.ticket}](${JIRA_BASE}/${t.ticket})` : '_(no ticket)_';
      const rawTitle = titleOf(t.ticket) ?? (t.ticket ? '' : t.subjects[0]);
      const title = (rawTitle ?? '').replace(/\|/g, '\\|');
      const prCell = t.prs.length
        ? t.prs.map((n) => `[#${n}](https://github.com/${p.repo.slug}/pull/${n})`).join(', ')
        : '';
      const status = statusOf(t.ticket);
      const statusCell = status ? `${statusEmoji(status)} ${status}`.trim() : '';
      L.push(`| ${ticketCell} | ${title} | ${prCell} | ${t.onSource ? 'yes' : 'no'} | ${statusCell} |`);
    }
  }
}

// ---- Hotfixes: on staging/main but never back-merged to dev ----
// Appends the section to L in place. Skipped entirely when hotfixes were not
// computed (--no-hotfixes): every repo then carries a null `hotfixes`.
function renderHotfixes(L, perRepo, statusOf, titleOf) {
  const computed = perRepo.some((r) => r.hotfixes != null);
  if (!computed) return;
  L.push('');
  L.push('## Hotfixes (on staging/main, missing from dev)');
  L.push('');
  L.push(
    '_Changes that shipped straight to `staging`/`main` and never made it back to `dev` - back-merge them or the next promotion reverts them. Matched by ticket, so squash re-merges are not flagged._',
  );
  const withHotfixes = perRepo.filter((r) => r.hotfixes && r.hotfixes.length);
  if (withHotfixes.length === 0) {
    L.push('');
    L.push('_None - every downstream branch traces back to dev._');
    return;
  }
  for (const r of withHotfixes) {
    L.push('');
    L.push(`### ${r.repo} (${r.hotfixes.length})`);
    L.push('');
    L.push('| Ticket | Title | On | PRs | Jira status |');
    L.push('|--------|-------|-----|-----|-------------|');
    for (const t of [...r.hotfixes].sort((a, b) => ticketSortKey(a.ticket, b.ticket))) {
      L.push(hotfixRow(t, r.slug, statusOf, titleOf));
    }
  }
}

function hotfixRow(t, slug, statusOf, titleOf) {
  const ticketCell = t.ticket ? `[${t.ticket}](${JIRA_BASE}/${t.ticket})` : '_(no ticket)_';
  // Ticketless hotfixes have no Jira title; fall back to the commit subject.
  const rawTitle = titleOf(t.ticket) ?? (t.ticket ? '' : t.subjects[0]);
  const title = (rawTitle ?? '').replace(/\|/g, '\\|');
  const onCell = t.branches.map((b) => `\`${b}\``).join(', ');
  const prCell = t.prs.length
    ? t.prs.map((n) => `[#${n}](https://github.com/${slug}/pull/${n})`).join(', ')
    : '';
  const status = statusOf(t.ticket);
  const statusCell = status ? `${statusEmoji(status)} ${status}`.trim() : '';
  return `| ${ticketCell} | ${title} | ${onCell} | ${prCell} | ${statusCell} |`;
}

function row(t, slug, statusOf, titleOf) {
  const ticketCell = t.ticket ? `[${t.ticket}](${JIRA_BASE}/${t.ticket})` : '_(no ticket)_';
  const title = (titleOf(t.ticket) ?? '').replace(/\|/g, '\\|');
  const prCell = t.prs.length
    ? t.prs.map((n) => `[#${n}](https://github.com/${slug}/pull/${n})`).join(', ')
    : '';
  const status = statusOf(t.ticket);
  const statusCell = status ? `${statusEmoji(status)} ${status}`.trim() : '';
  return `| ${ticketCell} | ${title} | ${prCell} | ${statusCell} |`;
}

main();
