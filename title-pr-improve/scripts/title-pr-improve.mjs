#!/usr/bin/env node
// Normalizes GitHub PR titles to the house convention:
//
//   ETS-1234: [MO] Worker profile modal sometimes opens without data
//   -> ETS-1234: worker profile modal sometimes opens without data
//
// Two mechanical fixes, applied to every open PR (or one --pr) across
// api/admin/app:
//   1. Drop a leading area marker right after the ticket - a bracket
//      ("[MO]", "[BE/FE]", "[Admin]", ...) or a "Admin - " / "Web - " /
//      "Backend - " style dash prefix. The repo is already the area.
//   2. Lowercase the first letter after "ETS-1234: ", the way a commit
//      subject reads. Nothing else in the title is touched - "Worker App"
//      stays "Worker App", only the leading "W" changes case.
//
// A title that is still over --max-len (default 65) after both fixes is
// reported as TOO LONG but never auto-edited: shortening a title well needs
// judgment (what to cut, what the reader still needs), which is exactly what
// a mechanical script cannot do safely. Run it through an agent instead - see
// the "/pr-review --title" option, which does the same two fixes and asks an
// agent to compress anything still too long.
//
// Usage:
//   ./scripts/title-pr-improve.mjs                       # dry-run, every open PR in api+admin+app
//   ./scripts/title-pr-improve.mjs --repos admin          # one repo
//   ./scripts/title-pr-improve.mjs --repo api --pr 1450   # one PR
//   ./scripts/title-pr-improve.mjs --apply                # write the changes via gh pr edit
//   ./scripts/title-pr-improve.mjs --max-len 72
//   ./scripts/title-pr-improve.mjs --json
//   ./scripts/title-pr-improve.mjs --help

import { execFileSync } from 'node:child_process';

const OWNER = process.env.E2S_GH_OWNER || 'Eats2Seats';
const DEFAULT_REPOS = ['api', 'admin', 'app'];

const REPOS = {
  api: 'eats2seats-api',
  admin: 'eats2seats-admin',
  app: 'eats2seats-app',
  infra: 'eats2seats-infra',
};

// Known area words for the "Word - rest" prefix form. Case-insensitive.
const AREA_WORDS = ['BE', 'FE', 'MO', 'Admin', 'Mobile', 'Web', 'iOS', 'Android', 'Backend', 'Frontend', 'Deploy'];

const HELP = `Normalize open PR titles: drop the [MO]/[BE]/[FE]/[Admin]/"Admin - " area
marker (the repo is already the area) and lowercase the first letter after
the ticket, commit-subject style. Flags, never rewrites, a title still over
--max-len after those two fixes - shortening one needs judgment.

Usage:
  ./scripts/title-pr-improve.mjs [--repos <a,b,...>] [--pr <n>] [--apply]

Options:
  --repos <a,b,...>   api | admin | app | infra, a full eats2seats-* name, or
                      owner/name, comma-separated. Default: api,admin,app.
  --repo <name>       Alias for --repos with a single repo.
  --pr <n>            Only this PR (needs exactly one --repo).
  --apply             Write the fixed titles via 'gh pr edit'. Default is a
                      dry run that only prints the before/after.
  --max-len <n>       Max title length before it is flagged TOO LONG instead
                      of applied. Default: 65.
  --json              Machine-readable output instead of the table.
  -h, --help          Show this help.

Examples:
  ./scripts/title-pr-improve.mjs --apply
  ./scripts/title-pr-improve.mjs --repos admin,api --apply
  ./scripts/title-pr-improve.mjs --repo app --pr 726 --apply
`;

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { repos: null, apply: false, maxLen: 65, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--repos': case '--repo': opts.repos = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--pr': opts.pr = next(); break;
      case '--apply': opts.apply = true; break;
      case '--max-len': opts.maxLen = Number(next()); break;
      case '--json': opts.json = true; break;
      case '-h': case '--help': process.stdout.write(HELP); process.exit(0); break;
      default: fail(`Unknown argument: ${a}`);
    }
  }
  if (!opts.repos) opts.repos = DEFAULT_REPOS;
  if (opts.pr !== undefined && opts.repos.length !== 1) {
    fail('--pr needs exactly one --repo');
  }
  if (!Number.isFinite(opts.maxLen) || opts.maxLen <= 0) fail('--max-len must be a positive number');
  return opts;
}

function slugFor(name) {
  if (name.includes('/')) return name;
  return `${OWNER}/${REPOS[name] || name}`;
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

const TICKET = /^([A-Z][A-Z0-9]*-\d+):\s*(.*)$/;
const BRACKET_PREFIX = /^\[[^\]]{1,24}\]\s*/;
const areaWordPattern = AREA_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const DASH_PREFIX = new RegExp(`^(?:${areaWordPattern})\\s*-\\s*`, 'i');

// Strips one or more leading area markers and lowercases the first letter of
// what remains, commit-subject style. Returns null when the title carries no
// "TICKET: ..." prefix at all (deploy/hotfix/dependabot titles, etc.) - those
// are left alone rather than guessed at.
function normalize(title) {
  const m = TICKET.exec(title.trim());
  if (!m) return null;
  const [, ticket] = m;
  let rest = m[2];
  for (let i = 0; i < 5; i++) {
    if (BRACKET_PREFIX.test(rest)) { rest = rest.replace(BRACKET_PREFIX, ''); continue; }
    if (DASH_PREFIX.test(rest)) { rest = rest.replace(DASH_PREFIX, ''); continue; }
    break;
  }
  // Only a plain capitalized word is lowered. A first word carrying another
  // uppercase letter is an acronym or an identifier (SMS, API, EventForm),
  // where the capital is part of the name, not sentence case.
  const firstWord = rest.split(/\s/, 1)[0];
  if (/^[A-Z]/.test(rest) && !/[A-Z]/.test(firstWord.slice(1))) {
    rest = rest[0].toLowerCase() + rest.slice(1);
  }
  return `${ticket}: ${rest}`;
}

function listOpenPrs(slug, pr) {
  if (pr !== undefined) {
    const view = JSON.parse(gh(['pr', 'view', pr, '--repo', slug, '--json', 'number,title']));
    return [view];
  }
  return JSON.parse(gh(['pr', 'list', '--repo', slug, '--state', 'open', '--json', 'number,title', '--limit', '200']));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const results = [];
  let editFailed = false;

  for (const repoName of opts.repos) {
    const slug = slugFor(repoName);
    let prs;
    try {
      prs = listOpenPrs(slug, opts.pr);
    } catch {
      fail(`Could not list PRs for ${slug}. Is 'gh auth login' done?`);
    }

    for (const { number, title } of prs) {
      const next = normalize(title);
      let status;
      if (next === null) status = 'no-ticket';
      else if (next === title) status = 'clean';
      else if (next.length > opts.maxLen) status = 'too-long';
      else status = 'changed';

      const entry = { repo: repoName, slug, pr: number, before: title, after: next, status, len: next ? next.length : title.length };

      if (status === 'changed' && opts.apply) {
        try {
          gh(['pr', 'edit', String(number), '--repo', slug, '--title', next]);
          entry.applied = true;
        } catch (err) {
          entry.applied = false;
          entry.error = String(err.message || err);
          editFailed = true;
        }
      }

      results.push(entry);
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ maxLen: opts.maxLen, apply: opts.apply, results }, null, 2) + '\n');
  } else {
    printTable(results, opts);
  }

  process.exit(editFailed ? 1 : 0);
}

function printTable(results, opts) {
  const changed = results.filter((r) => r.status === 'changed');
  const tooLong = results.filter((r) => r.status === 'too-long');
  const clean = results.filter((r) => r.status === 'clean');
  const noTicket = results.filter((r) => r.status === 'no-ticket');

  for (const r of changed) {
    const verb = opts.apply ? (r.applied ? 'edited' : 'FAILED') : 'would edit';
    process.stdout.write(`[${r.repo}#${r.pr}] ${verb}\n`);
    process.stdout.write(`  - ${r.before}\n`);
    process.stdout.write(`  + ${r.after}  (${r.len} chars)\n`);
    if (r.error) process.stdout.write(`  error: ${r.error}\n`);
  }

  for (const r of tooLong) {
    process.stdout.write(`[${r.repo}#${r.pr}] TOO LONG (${r.len} > ${opts.maxLen}) - needs manual shortening, not applied\n`);
    process.stdout.write(`  - ${r.before}\n`);
    process.stdout.write(`  + ${r.after}\n`);
  }

  process.stdout.write(
    `\n${changed.length} changed${opts.apply ? '' : ' (dry run - pass --apply to write)'}, ` +
    `${tooLong.length} too long, ${clean.length} already clean, ${noTicket.length} skipped (no ticket prefix).\n`
  );
}

main();
