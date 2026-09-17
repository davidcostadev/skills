#!/usr/bin/env node
// cleanup-worktrees.mjs - Remove git worktrees whose branch already has a merged PR.
//
// Cross-platform port of cleanup-worktrees.sh: same safety rules, but no bash and
// no python3, so it behaves identically on Windows and Linux. The e2s root is
// derived from this file's location instead of being hardcoded to one machine.
//
// Dry-run by default; --apply is the only thing that removes anything.
//
// Usage:
//   ./scripts/cleanup-worktrees.mjs                    # dry-run over api, admin, app
//   ./scripts/cleanup-worktrees.mjs --apply            # actually remove
//   ./scripts/cleanup-worktrees.mjs --repo api --apply # one repo (short or full name)
//   ./scripts/cleanup-worktrees.mjs --repo api,admin   # several
//   ./scripts/cleanup-worktrees.mjs --json             # machine-readable
//   ./scripts/cleanup-worktrees.mjs --help

import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// Directories that are real checkouts, never disposable worktrees. Matched by
// basename, so a worktree accidentally created with one of these names is left
// alone even when its PR is merged.
const PRIMARY_DIRS = new Set([
  'eats2seats-api',
  'eats2seats-admin',
  'eats2seats-app',
  'eats2seats-infra',
  'eats2seats-backoffice',
  'eats2seats-sentinela',
  'eats2seats-tester',
  'eats2seats-lovable',
  'eats2seats-migration',
  'eats2seats-schema',
  'eats2seats-cli',
]);

const DEFAULT_REPOS = ['eats2seats-api', 'eats2seats-admin', 'eats2seats-app'];

// How many `gh pr list` calls run at once. One call per worktree, each a network
// round trip, so a serial run spends most of its wall clock waiting.
const GH_CONCURRENCY = 6;

const IS_TTY = process.stdout.isTTY === true;
const C = {
  red: (s) => (IS_TTY ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s) => (IS_TTY ? `\x1b[33m${s}\x1b[0m` : s),
  green: (s) => (IS_TTY ? `\x1b[32m${s}\x1b[0m` : s),
  dim: (s) => (IS_TTY ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (IS_TTY ? `\x1b[1m${s}\x1b[0m` : s),
};

function fail(msg, code = 2) {
  process.stderr.write(`cleanup-worktrees: ${msg}\n`);
  process.exit(code);
}

function printHelp() {
  console.log(
    `cleanup-worktrees - remove git worktrees whose branch has a merged PR on GitHub\n\n` +
      `Usage: ./scripts/cleanup-worktrees.mjs [--apply] [--repo <name>] [--json] [--help]\n\n` +
      `  --apply         Actually remove worktrees and delete their branches.\n` +
      `                  Without it the run is a dry-run and changes nothing.\n` +
      `  --dry-run       Explicit opposite of --apply (the default).\n` +
      `  --repo <name>   Limit to one or more repos, comma-separated. Accepts short\n` +
      `                  (api, admin, app) or full (eats2seats-api) names.\n` +
      `                  Default: ${DEFAULT_REPOS.join(', ')}.\n` +
      `  --root <dir>    e2s root holding the repo directories.\n` +
      `                  Default: the parent of scripts/ ($E2S_ROOT overrides).\n` +
      `  --purge-ignored When 'git worktree remove' leaves the directory behind because\n` +
      `                  files are still in it (a locked node_modules on Windows), delete\n` +
      `                  the directory and prune. Lists what it purged, and names any\n` +
      `                  .env / *.pem / *.key among them - git cannot bring those back.\n` +
      `  --json          Emit JSON instead of the text report.\n` +
      `  --help          Show this help.\n\n` +
      `Protected directories (never removed, even with --apply):\n` +
      [...PRIMARY_DIRS].map((d) => `  - ${d}`).join('\n') +
      `\n\nSafety rules:\n` +
      `  1. Primary repo directories are skipped by name.\n` +
      `  2. The main checkout (first entry of 'git worktree list') is skipped.\n` +
      `  3. Worktrees with uncommitted changes are skipped with a warning.\n` +
      `  4. Worktrees with un-pushed commits ahead of upstream are skipped with a warning.\n` +
      `  5. Only branches with at least one MERGED PR are removed.\n\n` +
      `Exit codes: 0 ok, 1 a removal failed, 2 usage/setup error.\n`,
  );
}

// ----------------------------------------------------------------------------- args

function parseArgs(argv) {
  const opts = { apply: false, repos: [], root: '', json: false, purgeIgnored: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--dry-run') opts.apply = false;
    else if (a === '--purge-ignored') opts.purgeIgnored = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a === '--repo') opts.repos.push(...splitRepos(argv[++i]));
    else if (a.startsWith('--repo=')) opts.repos.push(...splitRepos(a.slice('--repo='.length)));
    else if (a === '--root') opts.root = argv[++i] ?? '';
    else if (a.startsWith('--root=')) opts.root = a.slice('--root='.length);
    else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      printHelp();
      process.exit(2);
    }
  }
  return opts;
}

function splitRepos(value) {
  if (!value) fail('--repo needs a value');
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((r) => (r.startsWith('eats2seats-') ? r : `eats2seats-${r}`));
}

// ----------------------------------------------------------------------------- exec

// Windows ships some CLIs as .cmd/.bat shims, which spawn only finds through a
// shell; the retry is ENOENT-only because shell mode does not quote arguments.
function git(dir, args) {
  const run = (extra) =>
    spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      ...extra,
    });
  let r = run({});
  if (r.error?.code === 'ENOENT' && process.platform === 'win32') r = run({ shell: true });
  if (r.error?.code === 'ENOENT') fail('git not found in PATH');
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function gh(cwd, args) {
  const opts = { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true };
  try {
    const { stdout } = await execFileAsync('gh', args, opts);
    return { ok: true, stdout };
  } catch (err) {
    if (err?.code === 'ENOENT' && process.platform === 'win32') {
      try {
        const { stdout } = await execFileAsync('gh', args, { ...opts, shell: true });
        return { ok: true, stdout };
      } catch (err2) {
        return { ok: false, stderr: String(err2?.stderr ?? err2?.message ?? err2) };
      }
    }
    return { ok: false, stderr: String(err?.stderr ?? err?.message ?? err) };
  }
}

// Runs fn over items with a fixed number of workers, preserving input order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ----------------------------------------------------------------------------- paths

// Last path segment, whatever the separator - git reports Windows paths with
// forward slashes, so path.basename alone is not enough under Git Bash or WSL.
function baseName(p) {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function samePath(a, b) {
  const norm = (p) => path.resolve(p).split(path.sep).join('/').replace(/\/+$/, '');
  const [x, y] = [norm(a), norm(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// ----------------------------------------------------------------------------- git reads

// One entry per `git worktree list --porcelain` block, in git's own order: the
// main checkout is always first.
function listWorktrees(repoDir) {
  const r = git(repoDir, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) return null;
  const entries = [];
  let cur = null;
  for (const raw of r.stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      if (cur) entries.push(cur);
      cur = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), branch: '', locked: false, prunable: false };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('branch refs/heads/')) cur.branch = line.slice('branch refs/heads/'.length);
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true;
  }
  if (cur) entries.push(cur);
  return entries;
}

function isDirty(wtPath) {
  const r = git(wtPath, ['status', '--porcelain']);
  return r.code === 0 && r.stdout.trim() !== '';
}

// Commits on the branch that never reached its upstream. 0 when there is no
// upstream at all: nothing was pushed, so this check has nothing to compare -
// rule 5 still requires a merged PR before anything is removed.
function aheadCount(wtPath) {
  if (git(wtPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).code !== 0) return 0;
  const r = git(wtPath, ['rev-list', '--count', '@{u}..HEAD']);
  if (r.code !== 0) return 0;
  return Number.parseInt(r.stdout.trim(), 10) || 0;
}

// The failure that --purge-ignored exists for: git deleted what it knew about
// and could not rmdir the rest. Any other error is a reason to keep hands off.
const LEFTOVER_ERROR = /not empty|failed to delete|unable to remove/i;

// Ignored paths still sitting in the worktree, collapsed to directories by git
// (`!! node_modules/`, not 40k lines). null when git could not answer, which the
// caller treats as "unknown, do not purge".
function ignoredEntries(wtPath) {
  const r = git(wtPath, ['status', '--porcelain', '--ignored']);
  if (r.code !== 0) return null;
  return r.stdout
    .split('\n')
    .filter((l) => l.startsWith('!! '))
    .map((l) => l.slice(3).replace(/\r$/, '').trim())
    .filter(Boolean);
}

// Files a re-created worktree does not get back, because git never had them.
// Purged like any other ignored file - `git worktree remove` deletes them too -
// but called out by name so their loss is never silent.
function isSecretLike(entry) {
  const base = baseName(entry).toLowerCase();
  return /^\.env($|\.)/.test(base) || /\.(pem|key|p12|pfx)$/.test(base) || base.startsWith('id_rsa');
}

// Finishes a removal git left half-done. Only ever called with --purge-ignored.
function purgeLeftovers(repoPath, wtPath, detail, ignored) {
  // A failed remove often still deregisters the worktree (its .git marker is
  // gone), which says git considered the removal done bar the file deletion.
  const deregistered = !fs.existsSync(path.join(wtPath, '.git'));
  if (!LEFTOVER_ERROR.test(detail) && !deregistered) {
    return { ok: false, reason: 'not a leftover-files failure - directory left untouched' };
  }
  try {
    // Windows holds locks briefly after a process exits; retries cover that.
    fs.rmSync(wtPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (err) {
    return { ok: false, reason: `purge failed: ${err?.message ?? err}` };
  }
  git(repoPath, ['worktree', 'prune']);
  return { ok: true };
}

// Directories a failed removal left behind: named like a worktree of this repo,
// sitting in the e2s root, holding no .git, registered nowhere. git deregisters
// a worktree even when deleting its files fails, so `git worktree list` cannot
// see these - without this scan nothing ever reports them again.
function orphanDirs(repoName, registeredPaths) {
  let entries;
  try {
    entries = fs.readdirSync(E2S_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith(`${repoName}_`) && !PRIMARY_DIRS.has(e.name))
    .map((e) => path.join(E2S_ROOT, e.name))
    // A .git of any kind means a live worktree or clone, never a leftover.
    .filter((p) => !fs.existsSync(path.join(p, '.git')))
    .filter((p) => !registeredPaths.some((r) => samePath(r, p)));
}

function describeEntries(entries) {
  if (!entries || entries.length === 0) return 'the leftover directory';
  const noun = entries.length === 1 ? 'entry' : 'entries';
  return `${entries.length} ignored ${noun}: ${entries.join(', ')}`;
}

async function mergedPr(repoDir, branch) {
  const r = await gh(repoDir, [
    'pr',
    'list',
    '--state',
    'merged',
    '--head',
    branch,
    '--json',
    'number,mergedAt',
    '--limit',
    '5',
  ]);
  if (!r.ok) return null;
  let list;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(list) || list.length === 0) return null;
  return { number: list[0].number, mergedAt: (list[0].mergedAt || '').slice(0, 10) };
}

// ----------------------------------------------------------------------------- report

const LABEL_WIDTH = 40;
const out = { json: false };

function say(text = '') {
  if (!out.json) console.log(text);
}

function row(label, text) {
  say(`  ${label.padEnd(LABEL_WIDTH)} -> ${text}`);
}

// ----------------------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));
out.json = opts.json;
const E2S_ROOT = path.resolve(opts.root || process.env.E2S_ROOT || path.join(SCRIPT_DIR, '..'));
if (!fs.existsSync(E2S_ROOT)) fail(`e2s root not found: ${E2S_ROOT} (pass --root)`);

const repos = opts.repos.length > 0 ? opts.repos : DEFAULT_REPOS;
const totals = { removed: 0, dirty: 0, noPr: 0, other: 0, failed: 0 };
const results = [];

say(
  opts.apply
    ? C.bold('Mode: APPLY (will remove worktrees and delete branches)')
    : C.bold('Mode: DRY-RUN (no changes will be made; pass --apply to execute)'),
);
say(`Root:  ${E2S_ROOT}`);
say(`Repos: ${repos.join(' ')}`);

for (const repoName of repos) {
  await processRepo(repoName);
}

say('');
say('Summary:');
say(`  ${opts.apply ? 'removed:          ' : 'would remove:     '} ${totals.removed}`);
say(`  skipped (dirty):   ${totals.dirty}`);
say(`  skipped (no PR):   ${totals.noPr}`);
say(`  skipped (other):   ${totals.other}`);
if (totals.failed > 0) say(`  ${C.red(`removal failed:    ${totals.failed}`)}`);
if (!opts.apply && totals.removed > 0) {
  say('');
  say('Run again with --apply to actually remove.');
}

if (opts.json) {
  console.log(
    JSON.stringify(
      { mode: opts.apply ? 'apply' : 'dry-run', root: E2S_ROOT, repos: results, summary: totals },
      null,
      2,
    ),
  );
}

process.exit(totals.failed > 0 ? 1 : 0);

// ----------------------------------------------------------------------------- per repo

async function processRepo(repoName) {
  const repoPath = path.join(E2S_ROOT, repoName);
  const repoResult = { repo: repoName, path: repoPath, worktrees: [] };
  results.push(repoResult);

  // A worktree's .git is a file, not a directory - existsSync accepts both.
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    say('');
    say(`[${repoName}] not a git repo at ${repoPath} -> skipping`);
    repoResult.skipped = 'not-a-git-repo';
    return;
  }

  const entries = listWorktrees(repoPath);
  if (!entries) {
    say('');
    say(`[${repoName}] could not read worktree list -> skipping`);
    repoResult.skipped = 'worktree-list-failed';
    return;
  }

  say('');
  say(`[${repoName}] ${entries.length} worktrees found (1 main + ${entries.length - 1} candidates)`);

  // git lists the main checkout first; the path compare is a second line of
  // defense in case that ever stops holding.
  const candidates = entries.filter((e, i) => i !== 0 && !samePath(e.path, repoPath));

  // Resolve the merged PR of every candidate that gets that far, in parallel.
  const needsPr = candidates.filter((w) => !preSkipReason(w));
  await mapLimit(needsPr, GH_CONCURRENCY, async (w) => {
    w.pr = await mergedPr(repoPath, w.branch);
  });

  for (const w of candidates) {
    repoResult.worktrees.push(decide(repoPath, w));
  }

  for (const dir of orphanDirs(repoName, entries.map((e) => e.path))) {
    repoResult.worktrees.push(handleOrphan(repoPath, dir));
  }
}

function handleOrphan(repoPath, dir) {
  const label = baseName(dir);
  const record = { path: dir, branch: '', decision: 'skip', reason: 'orphan of a failed removal' };

  if (!opts.purgeIgnored) {
    row(label, C.yellow('ORPHAN (left by a failed removal; --purge-ignored deletes it)'));
    totals.other++;
    return record;
  }
  if (!opts.apply) {
    row(label, `${C.dim('[DRY-RUN]')} would purge (orphan of a failed removal)`);
    totals.removed++;
    record.decision = 'would-purge';
    return record;
  }

  row(label, C.green('PURGING (orphan of a failed removal)'));
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (err) {
    const detail = `purge failed: ${err?.message ?? err}`;
    say(`    ${C.red(detail)}`);
    totals.failed++;
    record.decision = 'failed';
    record.reason = detail;
    return record;
  }
  git(repoPath, ['worktree', 'prune']);
  totals.removed++;
  record.decision = 'purged';
  return record;
}

// Why a worktree is out of scope before any network call, or null when it is a
// real candidate.
function preSkipReason(w) {
  if (PRIMARY_DIRS.has(baseName(w.path))) return 'protected primary directory';
  if (!w.branch) return 'detached HEAD, no branch to check';
  if (w.locked) return 'worktree is locked';
  if (w.prunable || !fs.existsSync(w.path)) return 'directory missing (run: git worktree prune)';
  return null;
}

function decide(repoPath, w) {
  const label = w.branch || '<detached>';
  const record = { path: w.path, branch: w.branch, decision: 'skip', reason: '', pr: null };

  const pre = preSkipReason(w);
  if (pre) {
    row(label, `SKIP (${pre})`);
    totals.other++;
    record.reason = pre;
    return record;
  }

  if (!w.pr) {
    row(label, C.dim('skip (no merged PR found)'));
    totals.noPr++;
    record.reason = 'no merged PR';
    return record;
  }
  record.pr = w.pr;
  const prInfo = `PR #${w.pr.number} merged ${w.pr.mergedAt}`;

  if (isDirty(w.path)) {
    row(label, C.yellow(`SKIP (${prInfo}, but worktree has uncommitted changes)`));
    totals.dirty++;
    record.reason = 'uncommitted changes';
    return record;
  }

  const ahead = aheadCount(w.path);
  if (ahead > 0) {
    row(label, C.yellow(`SKIP (${prInfo}, but ${ahead} un-pushed commit(s))`));
    totals.dirty++;
    record.reason = `${ahead} un-pushed commit(s)`;
    return record;
  }

  if (!opts.apply) {
    row(label, `${C.dim('[DRY-RUN]')} would remove (${prInfo})`);
    totals.removed++;
    record.decision = 'would-remove';
    return record;
  }

  row(label, C.green(`REMOVING (${prInfo})`));
  // Read the ignore list while the worktree still has its .git: a failed remove
  // can leave it deregistered, and then the ignore rules are gone.
  const ignored = opts.purgeIgnored ? ignoredEntries(w.path) : [];
  const removal = git(repoPath, ['worktree', 'remove', w.path]);
  if (removal.code !== 0) {
    const detail = removal.stderr.trim().split('\n')[0] || 'worktree remove failed';
    const purge = opts.purgeIgnored ? purgeLeftovers(repoPath, w.path, detail, ignored) : null;
    if (!purge?.ok) {
      say(`    ${C.red(`worktree remove FAILED for ${w.path}`)}`);
      say(`    ${C.dim(detail)}`);
      if (purge?.reason) say(`    ${C.dim(purge.reason)}`);
      else if (LEFTOVER_ERROR.test(detail)) {
        say(`    ${C.dim('re-run with --purge-ignored to delete the leftover ignored files')}`);
      }
      totals.failed++;
      record.decision = 'failed';
      record.reason = purge?.reason ?? detail;
      return record;
    }
    say(`    ${C.dim(`git left the directory behind; purged ${describeEntries(ignored)}`)}`);
    const risky = (ignored ?? []).filter(isSecretLike);
    if (risky.length > 0) {
      say(`    ${C.yellow(`purged ${risky.join(', ')} - not in git, re-create it if you rebuild this worktree`)}`);
    }
    record.purged = ignored;
  }

  // Safe delete only: -d refuses a branch git does not consider merged, and a
  // squash-merged PR usually is not. The worktree is gone either way.
  const branchDelete = git(repoPath, ['branch', '-d', w.branch]);
  if (branchDelete.code === 0) {
    say(`    branch ${w.branch} deleted`);
    record.branchDeleted = true;
  } else {
    say(`    ${C.dim(`branch ${w.branch} not deleted (use git branch -D to force)`)}`);
    record.branchDeleted = false;
  }
  totals.removed++;
  record.decision = 'removed';
  return record;
}
