#!/usr/bin/env node
// Generate release notes for a PR (or any ref range) as one line per Jira ticket:
//
//   - [ETS-2292]: #874 (10224126) / #870 (0d7ca178) - [FE] Stop Move-to-Standby modal reloading
//
// A ticket delivered by several PRs lists each of them, newest first, joined by " / ".
//
// Reverts are netted out per ticket, so a ticket held out of a release is never reported as
// delivered. See `classify` for the three buckets and why presence of a revert is not enough.
//
// Works for api, admin, app and infra, and retroactively on already-merged PRs: a merged PR's
// range is recovered from its merge commit's parents, so it does not depend on the head branch
// still existing.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = process.env.E2S_GH_OWNER || 'Eats2Seats';

const REPOS = {
  api: 'eats2seats-api',
  admin: 'eats2seats-admin',
  app: 'eats2seats-app',
  infra: 'eats2seats-infra',
};

// Markers let --apply rewrite only the notes and leave the rest of a PR body untouched.
const START = '<!-- release-notes:start -->';
const END = '<!-- release-notes:end -->';

const HELP = `Generate release notes for a PR or ref range.

Usage:
  ./scripts/release-notes.mjs --repo <name> --pr <n> [--apply]
  ./scripts/release-notes.mjs --repo <name> --from <ref> --to <ref>

Target (pick one):
  --pr <n>            Use the PR's commits. Works on open and merged PRs.
  --from <ref> --to <ref>
                      Any range, e.g. --from origin/main --to origin/staging.

Repo:
  --repo <name>       api | admin | app | infra, a full eats2seats-* name, or owner/name.
                      Default: api (or $E2S_RELEASE_NOTES_REPO).

Options:
  --apply             Write the notes into the PR body, between HTML markers, so
                      re-running updates them in place and keeps the rest of the body.
  --json              Print structured JSON instead of markdown.
  --no-fetch          Skip git fetch and use local refs.
  --title <text>      Heading above the notes in --apply mode. Default: "Release notes".
  -h, --help          Show this help.

Reverts:
  A ticket reverted inside the range is moved to a "Held out of this release" section
  instead of being listed as delivered, and a range that only removes code gets a
  "Rolled back in this release" section. A revert followed by a reapply still counts
  as delivered. Both sections live inside the --apply block, so they stay in sync.

Examples:
  ./scripts/release-notes.mjs --repo api --pr 1098
  ./scripts/release-notes.mjs --repo admin --pr 902 --apply
  ./scripts/release-notes.mjs --repo app --from origin/main --to origin/staging
  ./scripts/release-notes.mjs --repo infra --pr 137 --json
`;

function parseArgs(argv) {
  const opts = {
    repo: process.env.E2S_RELEASE_NOTES_REPO || 'api',
    title: 'Release notes',
    fetch: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--repo': opts.repo = next(); break;
      case '--pr': opts.pr = next(); break;
      case '--from': opts.from = next(); break;
      case '--to': opts.to = next(); break;
      case '--title': opts.title = next(); break;
      case '--apply': opts.apply = true; break;
      case '--json': opts.json = true; break;
      case '--no-fetch': opts.fetch = false; break;
      case '-h': case '--help': process.stdout.write(HELP); process.exit(0);
      default: fail(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(2);
}

// Resolves a repo argument to both its local checkout (for reading commits) and its
// owner/name slug (for the GitHub API).
function resolveRepo(name) {
  const full = REPOS[name] || name;
  const slug = full.includes('/') ? full : `${OWNER}/${full}`;
  const dir = join(ROOT, full.includes('/') ? full.split('/')[1] : full);
  if (!existsSync(join(dir, '.git'))) {
    fail(`No checkout for '${name}' at ${dir}. Expected one of: ${Object.keys(REPOS).join(', ')}`);
  }
  return { dir, slug };
}

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

// A merged PR's head branch is usually gone, so recover its range from the merge commit:
// a merge commit's first parent is the base tip it landed on and its second parent is the
// PR's head. A squash-merged PR has a single-parent merge commit and thus a single commit.
function rangeForPr(repo, pr) {
  let view;
  try {
    view = JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo.slug, '--json', 'state,baseRefName,headRefName,mergeCommit,title']));
  } catch {
    fail(`Could not read PR #${pr} from ${repo.slug}. Is 'gh auth login' done?`);
  }
  if (view.state === 'MERGED' && view.mergeCommit?.oid) {
    const oid = view.mergeCommit.oid;
    let parents;
    try {
      parents = git(repo.dir, ['log', '-1', '--format=%P', oid]).split(/\s+/).filter(Boolean);
    } catch {
      fail(`Merge commit ${oid} of PR #${pr} is not in the local checkout. Fetch it first (drop --no-fetch).`);
    }
    if (parents.length >= 2) return { spec: `${parents[0]}..${parents[1]}`, view };
    return { spec: null, single: [oid], view }; // squash merge: the PR is that one commit
  }
  return { spec: `origin/${view.baseRefName}..origin/${view.headRefName}`, view };
}

// Commit subjects follow "ETS-1234: title (#567)". Multi-ticket subjects ("ETS-1 / ETS-2: title")
// are allowed by the repos' PR-title check, so a commit can belong to more than one ticket.
// The trailing "(#567)" is absent when a PR was merged with a merge commit rather than squashed;
// callers fall back to the GitHub API for those.
const SUBJECT = /^(ETS-\d+(?:\s*\/\s*ETS-\d+)*)\s*:\s*(.+?)(?:\s+\(#(\d+)\))?$/;

// A revert carries its ticket inside the quoted original subject, so it never matches SUBJECT and
// used to be dropped as ticketless - which reported a ticket reverted out of a release as shipping.
// Both shapes appear: GitHub's Revert button quotes the whole original subject including its own
// "(#567)", and a hand-written hold-out PR quotes a summary instead.
const REVERT = /^Revert\s+"(.+)"(?:\s+\(#(\d+)\))?$/;
const ANY_TICKET = /ETS-\d+/g;

// { tickets, title, pr, revert } for a commit subject, or null when it carries no ticket at all.
function parseSubject(subject) {
  const revert = REVERT.exec(subject);
  if (revert) {
    const [, inner, prInSubject] = revert;
    const tickets = inner.match(ANY_TICKET);
    if (!tickets) return null;
    const innerMatch = SUBJECT.exec(inner);
    return {
      pr: prInSubject ? Number(prInSubject) : null,
      revert: true,
      tickets: [...new Set(tickets)],
      title: innerMatch ? innerMatch[2] : inner,
    };
  }
  const m = SUBJECT.exec(subject);
  if (!m) return null;
  const [, ticketField, title, prInSubject] = m;
  return {
    pr: prInSubject ? Number(prInSubject) : null,
    revert: false,
    tickets: ticketField.split('/').map((t) => t.trim()),
    title,
  };
}

// Replay a ticket's commits oldest-first and see what is left standing at the end:
//
//   delivered   something survives the last revert - the code ships in this range
//   held        it entered and left the range - nothing ships, the ticket is NOT delivered
//   rolledBack  the range only removes code that was already on the target branch
//
// A revert clears every earlier delivery of that ticket rather than cancelling one, because a
// hold-out PR is squashed into a single commit that undoes however many PRs the ticket had. It is
// also the safe direction to be wrong in: the failure this replaces reported held-out work as
// shipped. Replaying (instead of counting) is what keeps a revert-then-reapply - both land in the
// range that spans a release cut - correctly reported as delivered.
function classify(entry) {
  let live = 0;
  let removed = 0;
  for (const c of [...entry.commits].reverse()) {
    if (!c.revert) live += 1;
    else if (live > 0) live = 0;
    else removed += 1;
  }
  if (live > 0) return 'delivered';
  return removed === 0 ? 'held' : 'rolledBack';
}

function readCommits(repo, range) {
  const SEP = '\x1f'; // subjects can contain any printable char, so split on a control char
  const args = ['log', '--no-merges', `--format=%H${SEP}%s`];
  // Merge commits are the vehicle (a hotfix or deploy PR), not the work, so they are excluded
  // and their underlying per-ticket commits are reported instead.
  if (range.spec) args.push(range.spec);
  else args.push('-1', ...range.single, '--');
  const out = git(repo.dir, args);
  if (!out) return [];
  return out.split('\n').map((line) => {
    const [hash, subject] = line.split(SEP);
    return { hash, subject };
  });
}

// The PR number is missing from the subject when the commit reached the branch through a merge
// commit. GitHub can map a commit to its PRs; the lowest number is the PR that introduced it
// (later, higher-numbered ones are the hotfix/deploy PRs that carried it onward).
function prForCommit(repo, hash) {
  try {
    const pulls = JSON.parse(gh(['api', `repos/${repo.slug}/commits/${hash}/pulls`, '--jq', '[.[].number]']));
    if (!Array.isArray(pulls) || pulls.length === 0) return null;
    return Math.min(...pulls);
  } catch {
    return null;
  }
}

function build(repo, commits) {
  const byTicket = new Map();
  const skipped = [];
  for (const c of commits) {
    const parsed = parseSubject(c.subject);
    if (!parsed) {
      skipped.push(c);
      continue;
    }
    const pr = parsed.pr ?? prForCommit(repo, c.hash);
    for (const ticket of parsed.tickets) {
      if (!byTicket.has(ticket)) byTicket.set(ticket, { ticket, title: parsed.title, commits: [] });
      // git log is newest-first, so the first title seen for a ticket is its latest wording.
      byTicket.get(ticket).commits.push({ pr, hash: c.hash.slice(0, 8), revert: parsed.revert });
    }
  }
  const all = [...byTicket.values()].sort(
    (a, b) => Number(a.ticket.slice(4)) - Number(b.ticket.slice(4)),
  );
  const buckets = { delivered: [], held: [], rolledBack: [] };
  for (const entry of all) buckets[classify(entry)].push(entry);
  return { ...buckets, entries: buckets.delivered, skipped };
}

// The ticket id must NOT be wrapped in brackets. "- [ETS-1]: #2 (abc1234)" is valid
// CommonMark for a link reference definition ([label]: destination (title)), so GitHub
// swallows the whole line and renders an empty bullet. Only entries with two or more PRs
// survived, because the trailing " / #3 (def5678)" breaks the definition syntax - which is
// why the bug looked intermittent. A bare id renders as text and Jira still auto-links it.
function line(entry) {
  const ref = (c) => `${c.pr ? `#${c.pr}` : '(no PR)'} (${c.hash})`;
  const delivered = entry.commits.filter((c) => !c.revert);
  const reverts = entry.commits.filter((c) => c.revert);
  // No PR title here: GitHub already renders the linked #PR with its title.
  const parts = [delivered.map(ref).join(' / ')].filter(Boolean);
  if (reverts.length) parts.push(`reverted by ${reverts.map(ref).join(' / ')}`);
  return `- ${entry.ticket}: ${parts.join(', ')}`;
}

// The held and rolled-back sections are part of the generated block on purpose: written by hand
// outside it they go stale on the next --apply, which is exactly when they matter most.
function render({ delivered, held, rolledBack }) {
  const sections = [delivered.map(line).join('\n')];
  if (held.length) {
    sections.push(
      `### Held out of this release\n\nReverted before the cut - the code below is NOT in this deploy.\n\n${held.map(line).join('\n')}`,
    );
  }
  if (rolledBack.length) {
    sections.push(
      `### Rolled back in this release\n\nThis deploy removes code that was already on the target branch.\n\n${rolledBack.map(line).join('\n')}`,
    );
  }
  return sections.filter(Boolean).join('\n\n');
}

function applyToPr(repo, pr, notes, title) {
  const body = JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo.slug, '--json', 'body'])).body || '';
  const block = `${START}\n## ${title}\n\n${notes}\n${END}`;
  let next;
  if (body.includes(START) && body.includes(END)) {
    next = body.replace(new RegExp(`${START}[\\s\\S]*${END}`), block);
  } else {
    next = body.trim() ? `${body.trim()}\n\n${block}\n` : `${block}\n`;
  }
  gh(['pr', 'edit', String(pr), '--repo', repo.slug, '--body', next]);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.pr && !(opts.from && opts.to)) fail('Pick a target: --pr <n>, or --from <ref> --to <ref>. See --help.');
  if (opts.pr && (opts.from || opts.to)) fail('--pr and --from/--to are mutually exclusive.');
  if (opts.apply && !opts.pr) fail('--apply needs --pr (there is no PR body to write to for a range).');

  const repo = resolveRepo(opts.repo);
  if (opts.fetch) {
    try {
      git(repo.dir, ['fetch', '--prune', '--quiet', 'origin']);
    } catch {
      process.stderr.write('warning: git fetch failed, continuing with local refs\n');
    }
  }

  const range = opts.pr ? rangeForPr(repo, opts.pr) : { spec: `${opts.from}..${opts.to}` };
  const commits = readCommits(repo, range);
  const { delivered, held, rolledBack, entries, skipped } = build(repo, commits);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ repo: repo.slug, pr: opts.pr ?? null, range: range.spec ?? null, entries, held, rolledBack, skipped }, null, 2)}\n`);
    return;
  }

  const notes = render({ delivered, held, rolledBack });
  const total = delivered.length + held.length + rolledBack.length;
  if (opts.apply) {
    if (!total) fail('No ticket commits found, refusing to write an empty release-notes block.');
    applyToPr(repo, opts.pr, notes, opts.title);
    const extra = held.length ? ` (${held.length} held out)` : '';
    process.stdout.write(`Wrote ${delivered.length} entr${delivered.length === 1 ? 'y' : 'ies'}${extra} to ${repo.slug}#${opts.pr}\n\n`);
  }
  process.stdout.write(total ? `${notes}\n` : 'No ticket commits found in range.\n');
  if (skipped.length) {
    process.stderr.write(`\nSkipped ${skipped.length} commit(s) with no ETS ticket in the subject:\n`);
    for (const c of skipped) process.stderr.write(`  ${c.hash.slice(0, 8)} ${c.subject}\n`);
  }
}

main();
