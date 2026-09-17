#!/usr/bin/env node
// ci-gate.mjs
//
// Agent-callable gate around a PR's CI checks - the CI sibling of
// api-version-gate.mjs / admin-version-gate.mjs. Use it to make an agent WAIT
// until a PR's CI finishes, then branch on whether it passed. Works for any
// repo and any PR/ticket/branch.
//
// No dependencies. Node 22+. Reads GitHub through the `gh` CLI (same as the
// deploy gates), so it needs `gh auth login` already done.
//
//   node scripts/ci-gate.mjs current --repo api --pr 1039
//   node scripts/ci-gate.mjs wait    --repo api --pr 1039
//   node scripts/ci-gate.mjs wait    --repo admin --ticket ETS-2161
//   node scripts/ci-gate.mjs wait    --repo api --branch my-branch --required build,unit-tests-result
//
// Run `--help` for the full reference.

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const OWNER = process.env.E2S_GH_OWNER ?? 'Eats2Seats';
const DEFAULT_REPO_ALIAS = process.env.E2S_CI_REPO ?? 'api';
const DEFAULT_INTERVAL_S = 30;
const DEFAULT_TIMEOUT_S = 1800; // 30 min; 0 = wait forever
const TIMED_OUT = Symbol('timed-out');

// Short repo aliases, mirroring the other e2s scripts. A bare `eats2seats-*`
// name or a full `owner/name` is also accepted.
const REPO_ALIASES = {
  admin: 'eats2seats-admin',
  api: 'eats2seats-api',
  app: 'eats2seats-app',
  backoffice: 'eats2seats-backoffice',
  infra: 'eats2seats-infra',
};

const nowMs = () => Date.now();
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = () => nowIso().slice(11, 19);

// --- argument parsing (same shape as the deploy gates) ----------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function resolveRepo(r) {
  if (!r || r === true) r = DEFAULT_REPO_ALIAS;
  if (r.includes('/')) return r; // already owner/name
  const name = REPO_ALIASES[r] ?? (r.startsWith('eats2seats-') ? r : `eats2seats-${r}`);
  return `${OWNER}/${name}`;
}

// --- gh access --------------------------------------------------------------

function ghJson(ghArgs) {
  const run = spawnSync('gh', ghArgs, { encoding: 'utf8' });
  if (run.error) throw new Error(`gh CLI not available: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`gh ${ghArgs.join(' ')} failed: ${run.stderr?.trim() || `exit ${run.status}`}`);
  return JSON.parse(run.stdout);
}

const PR_FIELDS = 'number,title,state,headRefName,headRefOid,statusCheckRollup,url';

// Resolve the PR to gate on, by number, ticket (branch name == ticket id, per
// the project convention), or explicit branch. Returns the PR object with its
// current head SHA and check rollup, or null if none is found.
function lookupPr(repo, args) {
  if (args.pr && args.pr !== true) {
    return ghJson(['pr', 'view', String(args.pr), '--repo', repo, '--json', PR_FIELDS]);
  }
  const head = args.branch && args.branch !== true ? String(args.branch) : String(args.ticket);
  const list = ghJson(['pr', 'list', '--repo', repo, '--head', head, '--state', 'all', '--limit', '20', '--json', PR_FIELDS]);
  // Prefer an open PR; otherwise the most recently created match.
  const open = list.filter((p) => p.state === 'OPEN');
  return open[0] ?? list[0] ?? null;
}

// --- CodeRabbit review threads ----------------------------------------------

// The "CodeRabbit" entry in the check rollup only says the bot finished its run.
// It is green even when the review left findings, so a PR can be "all checks
// green" and still owe the reviewer answers. These helpers read the review
// threads themselves, which is where that state actually lives.
//
// Threads come from GraphQL because `isResolved` exists nowhere in the REST
// payload, and resolved-vs-open is the whole point.
const REVIEW_THREADS_QUERY = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100){
        nodes{
          isResolved
          isOutdated
          path
          line
          comments(first:30){ nodes{ author{login} url } }
        }
      }
    }
  }
}`;

const isCodeRabbit = (login) => String(login ?? '').toLowerCase().startsWith('coderabbitai');
const isBot = (login) => /\[bot\]$/i.test(String(login ?? '')) || isCodeRabbit(login);

// Every CodeRabbit-authored thread on the PR, with the two facts worth acting on:
// whether it is still open, and whether a human has answered it. Deliberately not
// filtered to the head commit - a finding raised two pushes ago is still owed an
// answer, and the project rule is that an unanswered one comes back on every future PR.
function fetchCodeRabbitThreads(repo, number) {
  const [owner, name] = repo.split('/');
  const data = ghJson([
    'api', 'graphql',
    '-f', `query=${REVIEW_THREADS_QUERY}`,
    '-F', `owner=${owner}`,
    '-F', `name=${name}`,
    '-F', `number=${number}`,
  ]);

  const nodes = data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];

  return nodes
    .filter((t) => isCodeRabbit(t.comments?.nodes?.[0]?.author?.login))
    .map((t) => {
      const comments = t.comments?.nodes ?? [];
      return {
        answered: comments.slice(1).some((c) => !isBot(c.author?.login)),
        file: t.line ? `${t.path}:${t.line}` : (t.path ?? '?'),
        outdated: Boolean(t.isOutdated),
        resolved: Boolean(t.isResolved),
        url: comments[0]?.url ?? null,
      };
    });
}

function summarizeReview(threads) {
  const open = threads.filter((t) => !t.resolved);
  return { open, total: threads.length, unanswered: open.filter((t) => !t.answered) };
}

function writeReviewReport(review) {
  if (review.total === 0) {
    process.stderr.write(`[${clock()}] CodeRabbit: no review threads on this PR\n`);
    return;
  }
  process.stderr.write(
    `[${clock()}] CodeRabbit: ${review.total} threads - ${review.open.length} open, ${review.unanswered.length} of those unanswered\n`,
  );
  for (const t of review.open) {
    const tags = [t.answered ? 'answered' : 'unanswered', t.outdated ? 'outdated' : null].filter(Boolean).join(', ');
    process.stderr.write(`[${clock()}]   open  ${t.file} (${tags})${t.url ? ` ${t.url}` : ''}\n`);
  }
}

// What the gate actually blocks on. An open thread you already replied to is not
// pending work: the reply IS the deliverable (CodeRabbit learns from it, and that
// is what stops the finding coming back on the next PR), and whether the thread
// then gets resolved in the UI is a human's call, often the reviewer's. Gating on
// it would leave the gate permanently red on every finding anyone declined.
const blockingThreads = (review) => review.unanswered;

// --- check normalization ----------------------------------------------------

// Collapse a statusCheckRollup entry (a CheckRun or a legacy StatusContext) into
// { name, bucket } where bucket is one of: pass | fail | pending | skipping |
// cancel. Buckets mirror `gh pr checks` so output reads the same.
function normalizeCheck(entry) {
  const name = entry.name ?? entry.context ?? 'unknown';

  // Legacy commit-status contexts expose `state`, not `status`/`conclusion`.
  if (entry.state) {
    const s = String(entry.state).toUpperCase();
    if (s === 'SUCCESS') return { bucket: 'pass', name };
    if (s === 'FAILURE' || s === 'ERROR') return { bucket: 'fail', name };
    return { bucket: 'pending', name }; // PENDING, EXPECTED
  }

  // GitHub Actions check runs.
  const status = String(entry.status ?? '').toUpperCase();
  if (status !== 'COMPLETED') return { bucket: 'pending', name }; // QUEUED, IN_PROGRESS, WAITING, ...
  const c = String(entry.conclusion ?? '').toUpperCase();
  if (c === 'SUCCESS' || c === 'NEUTRAL') return { bucket: 'pass', name };
  if (c === 'SKIPPED') return { bucket: 'skipping', name };
  if (c === 'CANCELLED') return { bucket: 'cancel', name };
  return { bucket: 'fail', name }; // FAILURE, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE
}

// GitHub keeps EVERY attempt of a check in the rollup of a commit, so a check
// that ran twice on one SHA appears twice - the stale attempt included. That
// happens whenever the checks re-run without the head moving: a re-run of failed
// jobs, a PR closed and reopened from the same commit, a workflow triggered by
// two events. Counting every entry then reports a red PR that is actually green,
// which is worse than useless - it trains you to ignore the gate.
//
// So each check is collapsed to its CURRENT attempt, the way `gh pr checks`
// reads it. Identity is workflow + name, not name alone: two workflows may each
// define a `build`, and those are genuinely different checks that must both gate.
function latestPerCheck(entries) {
  const byIdentity = new Map();

  for (const entry of entries) {
    const identity = `${entry.workflowName ?? ''} ${entry.name ?? entry.context ?? 'unknown'}`;
    const previous = byIdentity.get(identity);
    if (!previous || supersedes(entry, previous)) {
      byIdentity.set(identity, entry);
    }
  }

  return [...byIdentity.values()];
}

// Whether `candidate` is a later attempt of the same check than `previous`.
//
// An attempt still running wins over a finished one even when it looks older:
// its `startedAt` is null while queued, and a queued re-run IS the current state
// of that check. The timestamps only decide between two attempts of the same
// kind, so a finished attempt can never bury a running one.
function supersedes(candidate, previous) {
  const candidateRunning = isRunning(candidate);
  const previousRunning = isRunning(previous);
  if (candidateRunning !== previousRunning) return candidateRunning;
  return attemptTime(candidate) >= attemptTime(previous);
}

function isRunning(entry) {
  if (entry.state) return String(entry.state).toUpperCase() === 'PENDING';
  return String(entry.status ?? '').toUpperCase() !== 'COMPLETED';
}

// ISO-8601 strings in the same layout sort correctly as plain strings. An
// attempt with no timestamp at all sorts oldest, which only matters between two
// attempts of the same kind.
function attemptTime(entry) {
  return entry.completedAt ?? entry.startedAt ?? entry.createdAt ?? '';
}

// Apply the optional --required filter (comma-separated check names). When set,
// only those checks gate the result; everything else is ignored.
function selectChecks(checks, required) {
  if (!required || required === true) return checks;
  const want = new Set(String(required).split(',').map((s) => s.trim()).filter(Boolean));
  return checks.filter((c) => want.has(c.name));
}

function summarize(checks) {
  const by = { cancel: 0, fail: 0, pass: 0, pending: 0, skipping: 0 };
  for (const c of checks) by[c.bucket] = (by[c.bucket] ?? 0) + 1;
  const total = checks.length;
  const done = total - by.pending;
  const bad = by.fail + by.cancel;
  const complete = total > 0 && by.pending === 0;
  const state = total === 0 ? 'NO_CHECKS' : by.pending > 0 ? 'RUNNING' : bad > 0 ? 'FAILING' : 'PASSING';
  return { bad, by, complete, done, state, total };
}

function describe(pr, sum) {
  const head = pr.headRefOid ? pr.headRefOid.slice(0, 8) : '?';
  const counts = `${sum.by.pass} pass, ${sum.bad} not-green, ${sum.by.pending} pending, ${sum.by.skipping} skipping`;
  return `PR #${pr.number} (${pr.headRefName ?? '?'} @ ${head}) - ${sum.total} checks: ${counts} [${sum.state}]`;
}

// --- subcommands ------------------------------------------------------------

async function cmdCurrent(args) {
  const repo = resolveRepo(args.repo);
  const pr = lookupPr(repo, args);
  if (!pr) {
    process.stderr.write('No matching PR found.\n');
    return 1;
  }
  const checks = selectChecks(latestPerCheck(pr.statusCheckRollup ?? []).map(normalizeCheck), args.required);
  const sum = summarize(checks);
  const review = args.coderabbit ? summarizeReview(fetchCodeRabbitThreads(repo, pr.number)) : null;

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ checks, pr: { headRefOid: pr.headRefOid, number: pr.number, title: pr.title, url: pr.url }, review, summary: sum }, null, 2)}\n`);
  } else {
    process.stdout.write(`${repo}\n${describe(pr, sum)}\n`);
    for (const c of [...checks].sort((a, b) => a.name.localeCompare(b.name))) {
      process.stdout.write(`  ${c.bucket.padEnd(9)} ${c.name}\n`);
    }
    if (review) writeReviewReport(review);
  }

  // 0 = complete + all green; 1 = failing/incomplete/no-checks; 3 = green but
  // CodeRabbit has findings nobody answered.
  if (!sum.complete || sum.bad > 0) return 1;
  return review && blockingThreads(review).length > 0 ? 3 : 0;
}

async function cmdWait(args) {
  const repo = resolveRepo(args.repo);
  if (!args.pr && !args.ticket && !args.branch) {
    process.stderr.write('wait: pass a target - --pr <n>, --ticket <KEY>, or --branch <name>.\n');
    return 2;
  }
  const intervalMs = Math.max(1, Number(args.interval ?? DEFAULT_INTERVAL_S)) * 1000;
  const timeoutS = Number(args.timeout ?? DEFAULT_TIMEOUT_S);
  const deadline = timeoutS > 0 ? nowMs() + timeoutS * 1000 : Infinity;
  const label = args.pr && args.pr !== true ? `PR #${args.pr}` : `${repo} ${args.branch && args.branch !== true ? args.branch : args.ticket}`;

  process.stderr.write(`[${clock()}] ci-gate: waiting for CI on ${label} in ${repo}\n`);
  process.stderr.write(`[${clock()}] polling every ${intervalMs / 1000}s${timeoutS > 0 ? `, timeout ${timeoutS}s` : ''}${args.required && args.required !== true ? `, required: ${args.required}` : ''}\n`);

  // Track the head SHA and the set of checks already reported terminal, so each
  // poll only logs what changed. A new push (head SHA change) resets the run.
  let head = null;
  let reported = new Set();
  // The check set the previous poll saw complete, so a whole-looking set is confirmed once.
  let settled = null;

  for (;;) {
    let pr = null;
    try {
      pr = lookupPr(repo, args);
    } catch (err) {
      process.stderr.write(`[${clock()}] lookup failed - ${err.message}\n`);
    }

    if (pr) {
      if (pr.headRefOid !== head) {
        if (head !== null) process.stderr.write(`[${clock()}] head moved to ${pr.headRefOid?.slice(0, 8)} - watching the new run\n`);
        head = pr.headRefOid;
        reported = new Set();
        settled = null;
      }
      const checks = selectChecks(latestPerCheck(pr.statusCheckRollup ?? []).map(normalizeCheck), args.required);
      const sum = summarize(checks);

      // Log newly-terminal checks since the last poll.
      for (const c of checks) {
        if (c.bucket !== 'pending' && !reported.has(c.name)) {
          reported.add(c.name);
          process.stderr.write(`[${clock()}]   ${c.name}: ${c.bucket}\n`);
        }
      }

      // A push registers its checks over several seconds, so a set that is briefly whole is not
      // the same as a run that finished: right after a rebase the rollup can hold three green
      // checks and nothing pending, which reads as a passing PR whose suite has not started.
      const signature = checks.map((c) => c.name).sort().join('|');
      if (sum.complete && settled === signature) {
        return finish(args, repo, pr, sum, checks);
      }
      settled = sum.complete ? signature : null;
      const why = sum.complete
        ? 'complete, confirming on the next poll'
        : `${sum.done}/${sum.total} done, waiting`;
      process.stderr.write(`[${clock()}] ${describe(pr, sum)} - ${why}\n`);
    } else {
      process.stderr.write(`[${clock()}] no matching PR yet, waiting\n`);
    }

    if (nowMs() >= deadline) {
      process.stderr.write(`[${clock()}] TIMEOUT after ${timeoutS}s - CI did not complete\n`);
      return 124;
    }
    await sleep(intervalMs);
  }
}

function finish(args, repo, pr, sum, checks) {
  const green = sum.bad === 0;
  const verdict = green ? 'PASSED' : 'FAILED';
  process.stderr.write(`[${clock()}] CI ${verdict}: ${describe(pr, sum)}\n`);

  // Only read the review threads once CI is green. A red build is the thing to
  // fix first, and reporting both at once buries it.
  let review = null;
  if (args.coderabbit && green) {
    try {
      review = summarizeReview(fetchCodeRabbitThreads(repo, pr.number));
      writeReviewReport(review);
    } catch (err) {
      // A review lookup that fails must not rewrite a real CI verdict.
      process.stderr.write(`[${clock()}] CodeRabbit lookup failed - ${err.message}\n`);
    }
  }

  const pending = review ? blockingThreads(review).length : 0;

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ checks, passed: green, pr: { headRefOid: pr.headRefOid, number: pr.number, url: pr.url }, review, summary: sum }, null, 2)}\n`);
  } else {
    const bad = checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel').map((c) => c.name);
    process.stdout.write(`CI ${verdict} on PR #${pr.number} (${repo}) - ${sum.by.pass}/${sum.total} green${green ? '' : `, not-green: ${bad.join(', ')}`}\n`);
    if (pending > 0) {
      process.stdout.write(`CodeRabbit has ${pending} unanswered finding(s) of ${review.open.length} open - see stderr for the list\n`);
    }
  }

  if (!green) return 1;
  return pending > 0 ? 3 : 0;
}

const HELP = `ci-gate.mjs - wait for a PR's CI to finish, then branch on pass/fail.

The CI sibling of api-version-gate.mjs / admin-version-gate.mjs. Reads a PR's
head-commit check rollup via the gh CLI, so it always tracks the CURRENT run:
right after a push it sees the new run's checks (no stale previous run), and if
the head moves mid-wait it re-targets automatically.

USAGE
  node scripts/ci-gate.mjs <command> [options]

COMMANDS
  current   Print the PR's CI status once (exit 0 iff complete and all green).
  wait      Block until CI completes; exit 0 if all green, 1 if anything failed.

TARGET (pick one)
  --pr <number>       the PR number.
  --ticket <KEY>      resolve the PR by head branch == ticket id (e.g. ETS-2161).
  --branch <name>     resolve the PR by an explicit head branch name.

OPTIONS
  --repo <name>       short (api|admin|app|infra), eats2seats-*, or owner/name
                      (default ${DEFAULT_REPO_ALIAS}, or $E2S_CI_REPO). Owner from
                      $E2S_GH_OWNER (default ${OWNER}).
  --required <a,b>    only these check names gate the result; others are ignored.
  --coderabbit        once CI is green, also read CodeRabbit's review threads and
                      exit 3 if any finding is still unanswered. The "CodeRabbit"
                      check going green only means the bot finished - it is green
                      even when the review left findings. A thread you already
                      replied to does not gate: the reply is the deliverable, and
                      resolving it is a human's call.
  --interval <secs>   poll interval for wait (default ${DEFAULT_INTERVAL_S}).
  --timeout <secs>    give up after N seconds, 0 = forever (default ${DEFAULT_TIMEOUT_S}).
  --json              machine-readable output on stdout.

CHECK BUCKETS
  pass / skipping     count as green.
  fail / cancel       count as not-green (a cancelled check is not a pass).
  pending             still running - wait keeps polling until none remain.

  A check that ran more than once on the same commit - re-run of failed jobs, a
  PR reopened from the same commit, a workflow triggered twice - counts ONCE, as
  its latest attempt, the way 'gh pr checks' reads it. Counting the stale attempt
  too reports a red PR that is actually green.

EXIT CODES
  0    CI complete and all required checks green (and, with --coderabbit, every
       finding answered)
  1    CI complete but something failed/cancelled (or current: not yet green)
  2    usage error
  3    CI green but CodeRabbit has unanswered findings (--coderabbit only)
  124  timed out before CI completed

  3 is separate from 1 on purpose: a red build and an unanswered reviewer need
  different work, so an agent can branch on the code instead of parsing output.

AGENT TIPS
  - Run \`wait\` as a background shell task; the harness notifies you when it
    exits, with the code (0 = green, 1 = red) so you can act on the result.
  - Gate the deploy AND the CI together: run this alongside api-version-gate.mjs
    (CI green on the PR, deploy live on the env) for the full "shipped" signal.
  - Watch a specific set only: \`wait --repo api --pr 1039 --required build,unit-tests-result,integration-tests-result\`.
  - \`--coderabbit\` closes the gap between "CI is green" and "the PR is ready".
    Exit 3 means: fix or answer the findings it lists. Answering matters even when
    you decline one - CodeRabbit learns from replies, and a silent skip comes back
    on the next PR, on every branch, forever. Once answered a thread stops gating,
    so declining a finding never leaves the gate stuck red.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (args.help || command === 'help' || !command) {
    process.stdout.write(HELP);
    return command ? 0 : 2;
  }

  switch (command) {
    case 'current':
      return cmdCurrent(args);
    case 'wait':
      return cmdWait(args);
    default:
      process.stderr.write(`Unknown command: ${command}\nRun --help for usage.\n`);
      return 2;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(`ci-gate: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
