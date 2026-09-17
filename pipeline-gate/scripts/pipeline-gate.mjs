#!/usr/bin/env node
// pipeline-gate.mjs
//
// Agent-callable gate around the pipeline a MERGE triggers - the post-merge
// sibling of ci-gate.mjs (which gates the PR's own checks, pre-merge). Use it to
// make an agent WAIT until the workflow runs started by a PR's merge commit
// finish, then branch on whether the whole delivery went through.
//
// It is the only external "did it actually ship" signal for eats2seats-app: the
// app has no /version endpoint and no build-info.json, so the pipeline run
// reaching `success` is what tells us the build was produced and submitted. For
// api/admin the deploy gates still answer "is it live"; this one answers "did
// the pipeline finish, and with what result".
//
// No dependencies. Node 22+. Reads GitHub through the `gh` CLI (same as the
// other gates), so it needs `gh auth login` already done.
//
//   node scripts/pipeline-gate.mjs current --repo app --pr 583
//   node scripts/pipeline-gate.mjs wait    --repo app --pr 585
//   node scripts/pipeline-gate.mjs wait    --repo api --ticket ETS-2357
//   node scripts/pipeline-gate.mjs wait    --repo admin --sha 0d55ffd0
//
// Run `--help` for the full reference.

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const OWNER = process.env.E2S_GH_OWNER ?? 'Eats2Seats';
const DEFAULT_REPO_ALIAS = process.env.E2S_PIPELINE_REPO ?? process.env.E2S_CI_REPO ?? 'api';
const DEFAULT_INTERVAL_S = 30;
// App builds (EAS, both platforms) run ~35 min, and a merge may wait in a
// concurrency queue before that, so the default ceiling is an hour.
const DEFAULT_TIMEOUT_S = 3600; // 0 = wait forever
// How long to keep looking for the runs a merge should have started before
// concluding the push triggered nothing.
const DEFAULT_GRACE_S = 180;
// Safety stop while following a chain of cancel-in-progress takeovers.
const MAX_SUPERSEDE_HOPS = 5;

const REPO_ALIASES = {
  admin: 'eats2seats-admin',
  api: 'eats2seats-api',
  app: 'eats2seats-app',
  backoffice: 'eats2seats-backoffice',
  infra: 'eats2seats-infra',
};

// Runs from these events belong to the PR itself, not to the merge, and are
// ci-gate's job. Everything else with the merge sha counts as the pipeline.
const PR_EVENTS = new Set(['pull_request', 'pull_request_target', 'pull_request_review']);

const nowMs = () => Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = () => new Date().toISOString().slice(11, 19);

// --- argument parsing (same shape as the other gates) -----------------------

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

const optional = (value) => (value && value !== true ? String(value) : null);

// --- gh access --------------------------------------------------------------

function ghJson(ghArgs) {
  const run = spawnSync('gh', ghArgs, { encoding: 'utf8' });
  if (run.error) throw new Error(`gh CLI not available: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`gh ${ghArgs.join(' ')} failed: ${run.stderr?.trim() || `exit ${run.status}`}`);
  return JSON.parse(run.stdout);
}

const PR_FIELDS = 'number,title,state,url,baseRefName,headRefName,mergedAt,mergeCommit,mergeStateStatus';

// Resolve the PR whose merge we follow, by number, ticket (branch name == ticket
// id, per the project convention) or explicit head branch.
function lookupPr(repo, args) {
  const pr = optional(args.pr);
  if (pr) return ghJson(['pr', 'view', pr, '--repo', repo, '--json', PR_FIELDS]);

  const head = optional(args.branch) ?? optional(args.ticket);
  const list = ghJson([
    'pr', 'list', '--repo', repo, '--head', head, '--state', 'all', '--limit', '20', '--json', PR_FIELDS,
  ]);
  const open = list.filter((p) => p.state === 'OPEN');
  return open[0] ?? list[0] ?? null;
}

// GitHub matches runs by the full 40-char head_sha only, so a short sha typed
// by hand (or copied from a log line) has to be expanded first.
function expandSha(repo, sha) {
  if (/^[0-9a-f]{40}$/i.test(sha)) return sha;
  const commit = ghJson(['api', `repos/${repo}/commits/${sha}`]);
  return commit.sha;
}

// Every workflow run GitHub started for one commit, minus the PR-scoped ones.
function fetchRunsForSha(repo, sha) {
  const res = ghJson(['api', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`]);
  return (res.workflow_runs ?? []).filter((r) => !PR_EVENTS.has(r.event));
}

// The runs of one workflow on one branch, newest first. Used to find the run
// that superseded a cancelled one.
function fetchWorkflowRuns(repo, workflowId, branch) {
  const res = ghJson([
    'api', `repos/${repo}/actions/workflows/${workflowId}/runs?branch=${encodeURIComponent(branch)}&per_page=20`,
  ]);
  return res.workflow_runs ?? [];
}

function fetchJobs(repo, runId) {
  const res = ghJson(['api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`]);
  return res.jobs ?? [];
}

// --- run normalization ------------------------------------------------------

// Collapse a workflow run into { bucket } where bucket is one of:
// pass | fail | cancel | pending. Buckets mirror ci-gate so both gates read the
// same, except that `cancel` is resolved against a successor run first (see
// resolveSupersede) because a cancel-in-progress concurrency group cancels the
// older run whenever a newer merge lands on the same branch.
function bucketOf(run) {
  if (run.status !== 'completed') return 'pending';
  const c = String(run.conclusion ?? '').toLowerCase();
  if (c === 'success' || c === 'neutral' || c === 'skipped') return 'pass';
  if (c === 'cancelled') return 'cancel';
  return 'fail'; // failure, timed_out, action_required, startup_failure, stale
}

function describeRun(run) {
  const bucket = bucketOf(run);
  const started = run.run_started_at ?? run.created_at;
  const mins = run.status === 'completed' && started ? Math.round((Date.parse(run.updated_at) - Date.parse(started)) / 60000) : null;
  const duration = mins === null ? '' : ` (${mins}m)`;
  return `${run.name} #${run.run_number} - ${run.status}${run.conclusion ? `/${run.conclusion}` : ''}${duration}`;
}

function summarize(runs) {
  const by = { cancel: 0, fail: 0, pass: 0, pending: 0 };
  for (const r of runs) by[bucketOf(r)] += 1;
  const total = runs.length;
  const bad = by.fail + by.cancel;
  const complete = total > 0 && by.pending === 0;
  const state = total === 0 ? 'NO_RUNS' : by.pending > 0 ? 'RUNNING' : bad > 0 ? 'FAILING' : 'PASSING';
  return { bad, by, complete, done: total - by.pending, state, total };
}

// A cancelled run on a `cancel-in-progress` concurrency group (api deploy-dev,
// admin, ...) means a later merge took over, not that delivery failed - the run
// that took over builds a branch tip that already contains this commit. Returns
// the run that took over (the FIRST one started after the cancelled one, not the
// newest: only that one is guaranteed to be the takeover rather than an
// unrelated later merge), or null when nothing followed and the cancel stands.
function resolveSupersede(repo, run) {
  let candidates;
  try {
    candidates = fetchWorkflowRuns(repo, run.workflow_id, run.head_branch);
  } catch {
    return null;
  }
  const startedAt = Date.parse(run.run_started_at ?? run.created_at);
  const newer = candidates
    .filter((c) => c.id !== run.id && Date.parse(c.run_started_at ?? c.created_at) >= startedAt)
    .sort((a, b) => Date.parse(a.run_started_at ?? a.created_at) - Date.parse(b.run_started_at ?? b.created_at));
  return newer[0] ?? null;
}

// --- merge resolution -------------------------------------------------------

// The commit the merge put on the base branch - the head_sha of every run the
// merge triggers. Squash and rebase merges both land here.
function mergeShaOf(pr) {
  return pr?.mergeCommit?.oid ?? null;
}

async function waitForMerge(repo, args, deadline, intervalMs) {
  let warned = false;
  for (;;) {
    let pr = null;
    try {
      pr = lookupPr(repo, args);
    } catch (err) {
      process.stderr.write(`[${clock()}] PR lookup failed - ${err.message}\n`);
    }

    if (pr?.mergedAt && mergeShaOf(pr)) return { pr, sha: mergeShaOf(pr) };
    if (pr && pr.state === 'CLOSED' && !pr.mergedAt) {
      process.stderr.write(`[${clock()}] PR #${pr.number} was closed without merging\n`);
      return { closed: true, pr };
    }
    if (!warned) {
      process.stderr.write(`[${clock()}] PR ${pr ? `#${pr.number}` : '(not found)'} not merged yet - waiting for the merge\n`);
      warned = true;
    }
    if (nowMs() >= deadline) return { timedOut: true };
    await sleep(intervalMs);
  }
}

// --- watching ---------------------------------------------------------------

// Keeps the watched set of runs for one commit up to date. New runs can appear
// late (a chained workflow, a manual re-run), so the set is re-read every poll
// and a cancelled run is replaced by whatever superseded it.
class RunWatcher {
  constructor(repo, sha, options) {
    this.repo = repo;
    this.sha = sha;
    this.workflowFilter = options.workflowFilter;
    this.strictCancel = options.strictCancel;
    this.adopted = new Map(); // successor runs, which carry a later head_sha
    this.reported = new Map();
    this.superseded = new Map(); // cancelled run id -> successor run id
  }

  poll() {
    const fresh = this.applyFilter(fetchRunsForSha(this.repo, this.sha));
    this.refreshAdopted();

    // A takeover run can itself be cancelled by the next merge, so follow the
    // chain until it ends in a run that is still going or finished for good.
    if (!this.strictCancel) {
      const tried = new Set();
      for (let hop = 0; hop < MAX_SUPERSEDE_HOPS; hop++) {
        const cancelled = this.effectiveRuns(fresh).filter((r) => bucketOf(r) === 'cancel' && !tried.has(r.id));
        if (cancelled.length === 0) break;
        for (const run of cancelled) {
          tried.add(run.id);
          const successor = resolveSupersede(this.repo, run);
          if (!successor) continue;
          this.superseded.set(run.id, successor.id);
          this.adopted.set(successor.id, successor);
          process.stderr.write(
            `[${clock()}]   ${run.name} #${run.run_number}: cancelled, superseded by #${successor.run_number} - following that one\n`,
          );
        }
      }
    }

    this.effective = this.effectiveRuns(fresh);
    return this.effective;
  }

  applyFilter(runs) {
    if (!this.workflowFilter) return runs;
    const want = this.workflowFilter.toLowerCase();
    return runs.filter((r) => r.name.toLowerCase().includes(want) || String(r.workflow_id) === this.workflowFilter);
  }

  // Adopted successors live on a later commit, so the head_sha query never
  // returns them and each one has to be re-read on its own.
  refreshAdopted() {
    for (const id of [...this.adopted.keys()]) {
      try {
        this.adopted.set(id, ghJson(['api', `repos/${this.repo}/actions/runs/${id}`]));
      } catch {
        /* keep the previous snapshot; the next poll retries */
      }
    }
  }

  effectiveRuns(fresh) {
    const replaced = new Set(this.superseded.keys());
    return [...fresh, ...this.adopted.values()].filter((r) => !replaced.has(r.id));
  }

  // Log each run once it reaches a terminal state, so a long wait stays quiet.
  logNewlyFinished() {
    for (const run of this.effective ?? []) {
      const bucket = bucketOf(run);
      if (bucket === 'pending' || this.reported.get(run.id) === bucket) continue;
      this.reported.set(run.id, bucket);
      process.stderr.write(`[${clock()}]   ${describeRun(run)}\n`);
    }
  }
}

function failedJobLines(repo, runs) {
  const lines = [];
  for (const run of runs) {
    if (bucketOf(run) === 'pass' || bucketOf(run) === 'pending') continue;
    let jobs = [];
    try {
      jobs = fetchJobs(repo, run.id);
    } catch {
      continue;
    }
    for (const job of jobs) {
      const conclusion = String(job.conclusion ?? job.status ?? '').toLowerCase();
      if (conclusion === 'success' || conclusion === 'skipped') continue;
      const step = (job.steps ?? []).find((s) => ['failure', 'cancelled', 'timed_out'].includes(String(s.conclusion)));
      lines.push(`    ${run.name} / ${job.name}: ${conclusion}${step ? ` (step: ${step.name})` : ''}`);
    }
  }
  return lines;
}

function report(args, repo, context, runs) {
  const sum = summarize(runs);
  const green = sum.complete && sum.bad === 0;

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          passed: green,
          pipeline: runs.map((r) => ({
            conclusion: r.conclusion,
            event: r.event,
            headBranch: r.head_branch,
            headSha: r.head_sha,
            id: r.id,
            name: r.name,
            runNumber: r.run_number,
            status: r.status,
            url: r.html_url,
          })),
          repo,
          summary: sum,
          ...context,
        },
        null,
        2,
      )}\n`,
    );
    return green;
  }

  const label = context.pr ? `PR #${context.pr.number}` : `commit ${String(context.sha).slice(0, 8)}`;
  process.stdout.write(`Pipeline ${green ? 'PASSED' : sum.state === 'NO_RUNS' ? 'NOT FOUND' : sum.complete ? 'FAILED' : 'STILL RUNNING'} for ${label} (${repo})\n`);
  for (const run of runs) {
    process.stdout.write(`  ${bucketOf(run).padEnd(8)} ${describeRun(run)}\n    ${run.html_url}\n`);
  }
  if (!green && sum.complete) {
    const lines = failedJobLines(repo, runs);
    if (lines.length) {
      process.stdout.write('  failed jobs:\n');
      for (const line of lines) process.stdout.write(`${line}\n`);
    }
  }
  return green;
}

// --- subcommands ------------------------------------------------------------

function resolveTarget(repo, args) {
  const sha = optional(args.sha);
  if (sha) return { sha: expandSha(repo, sha) };
  const pr = lookupPr(repo, args);
  if (!pr) return { error: 'No matching PR found.' };
  if (!pr.mergedAt) return { error: `PR #${pr.number} is not merged yet (state ${pr.state}).`, pr };
  const mergeSha = mergeShaOf(pr);
  if (!mergeSha) return { error: `PR #${pr.number} has no merge commit yet.`, pr };
  return { pr, sha: mergeSha };
}

async function cmdCurrent(args) {
  const repo = resolveRepo(args.repo);
  if (!optional(args.pr) && !optional(args.ticket) && !optional(args.branch) && !optional(args.sha)) {
    process.stderr.write('current: pass a target - --pr <n>, --ticket <KEY>, --branch <name> or --sha <commit>.\n');
    return 2;
  }

  const target = resolveTarget(repo, args);
  if (target.error) {
    process.stderr.write(`${target.error}\n`);
    return 1;
  }

  const watcher = new RunWatcher(repo, target.sha, {
    strictCancel: Boolean(args['strict-cancel']),
    workflowFilter: optional(args.workflow),
  });
  const runs = watcher.poll();
  const green = report(args, repo, { pr: target.pr, sha: target.sha }, runs);
  return green ? 0 : 1;
}

async function cmdWait(args) {
  const repo = resolveRepo(args.repo);
  if (!optional(args.pr) && !optional(args.ticket) && !optional(args.branch) && !optional(args.sha)) {
    process.stderr.write('wait: pass a target - --pr <n>, --ticket <KEY>, --branch <name> or --sha <commit>.\n');
    return 2;
  }

  const intervalMs = Math.max(1, Number(args.interval ?? DEFAULT_INTERVAL_S)) * 1000;
  const timeoutS = Number(args.timeout ?? DEFAULT_TIMEOUT_S);
  const deadline = timeoutS > 0 ? nowMs() + timeoutS * 1000 : Infinity;
  const graceS = Number(args.grace ?? DEFAULT_GRACE_S);
  const allowNoRuns = Boolean(args['allow-no-runs']);

  let pr = null;
  let sha = optional(args.sha);
  if (sha) sha = expandSha(repo, sha);

  if (!sha) {
    process.stderr.write(`[${clock()}] pipeline-gate: resolving the merge of ${optional(args.pr) ? `PR #${args.pr}` : optional(args.ticket) ?? optional(args.branch)} in ${repo}\n`);
    const merged = await waitForMerge(repo, args, deadline, intervalMs);
    if (merged.timedOut) {
      process.stderr.write(`[${clock()}] TIMEOUT after ${timeoutS}s - the PR never merged\n`);
      return 124;
    }
    if (merged.closed) return 1;
    pr = merged.pr;
    sha = merged.sha;
    process.stderr.write(`[${clock()}] PR #${pr.number} merged into ${pr.baseRefName} as ${sha.slice(0, 8)} - watching its pipeline\n`);
  }

  const watcher = new RunWatcher(repo, sha, {
    strictCancel: Boolean(args['strict-cancel']),
    workflowFilter: optional(args.workflow),
  });

  const graceDeadline = nowMs() + graceS * 1000;
  let settled = false; // one extra clean poll before finishing, to catch chained runs

  for (;;) {
    let runs = [];
    try {
      runs = watcher.poll();
    } catch (err) {
      process.stderr.write(`[${clock()}] run lookup failed - ${err.message}\n`);
    }
    watcher.logNewlyFinished();
    const sum = summarize(runs);

    if (sum.total === 0) {
      if (nowMs() >= graceDeadline) {
        process.stderr.write(`[${clock()}] no pipeline run started for ${sha.slice(0, 8)} within ${graceS}s\n`);
        if (args.json) report(args, repo, { pr, sha }, runs);
        else process.stdout.write(`Pipeline NOT FOUND for commit ${sha.slice(0, 8)} (${repo}) - the push triggered no workflow\n`);
        return allowNoRuns ? 0 : 1;
      }
      process.stderr.write(`[${clock()}] no runs for ${sha.slice(0, 8)} yet, waiting\n`);
    } else if (sum.complete) {
      if (settled) {
        const green = report(args, repo, { pr, sha }, runs);
        process.stderr.write(`[${clock()}] pipeline ${green ? 'PASSED' : 'FAILED'}: ${sum.by.pass}/${sum.total} green\n`);
        return green ? 0 : 1;
      }
      settled = true; // re-check once; a workflow can start another one
      process.stderr.write(`[${clock()}] all ${sum.total} run(s) complete - confirming no follow-up run starts\n`);
    } else {
      settled = false;
      process.stderr.write(`[${clock()}] ${sum.done}/${sum.total} run(s) done, waiting\n`);
    }

    if (nowMs() >= deadline) {
      process.stderr.write(`[${clock()}] TIMEOUT after ${timeoutS}s - the pipeline did not finish\n`);
      report(args, repo, { pr, sha }, runs);
      return 124;
    }
    await sleep(intervalMs);
  }
}

const HELP = `pipeline-gate.mjs - wait for the pipeline a PR's MERGE triggers, then branch on the result.

The post-merge sibling of ci-gate.mjs: ci-gate watches the PR's own checks
before the merge, this one watches the workflow runs the merge commit starts on
the base branch (build, deploy, submit, ...). Works for api, admin, app and
infra. For eats2seats-app it is the only external "it shipped" signal, since the
app exposes no /version or build-info.json to poll.

USAGE
  node scripts/pipeline-gate.mjs <command> [options]

COMMANDS
  current   Print the pipeline status for the merge commit once.
  wait      Wait for the merge (if still open), then block until every run the
            merge started completes. Exit 0 if all green.

TARGET (pick one)
  --pr <number>       the PR number; \`wait\` also waits for it to be merged.
  --ticket <KEY>      resolve the PR by head branch == ticket id (e.g. ETS-2357).
  --branch <name>     resolve the PR by an explicit head branch name.
  --sha <commit>      skip the PR entirely and watch the runs of one commit.

OPTIONS
  --repo <name>       short (api|admin|app|infra), eats2seats-*, or owner/name
                      (default ${DEFAULT_REPO_ALIAS}, or $E2S_PIPELINE_REPO). Owner from
                      $E2S_GH_OWNER (default ${OWNER}).
  --workflow <text>   only runs whose workflow name contains this text.
  --interval <secs>   poll interval (default ${DEFAULT_INTERVAL_S}).
  --timeout <secs>    give up after N seconds, 0 = forever (default ${DEFAULT_TIMEOUT_S}).
  --grace <secs>      how long to wait for the first run to appear (default ${DEFAULT_GRACE_S}).
  --allow-no-runs     exit 0 instead of 1 when the push triggers no workflow.
  --strict-cancel     treat a cancelled run as a failure (see below).
  --json              machine-readable output on stdout.

CANCELLED RUNS
  The deploy workflows use \`concurrency: cancel-in-progress\`, so a merge that
  lands while an earlier deploy is running cancels it. That is a supersede, not a
  failure: the newer run deploys a branch tip that already contains this commit.
  By default the gate follows the successor run and reports its result. Use
  --strict-cancel to keep the old "cancelled == not green" reading.

EXIT CODES
  0    every run the merge started finished green
  1    a run failed/was cancelled, the PR was closed unmerged, or no run started
  2    usage error
  124  timed out waiting for the merge or for the pipeline

AGENT TIPS
  - Run \`wait\` as a background shell task; the harness notifies you when it
    exits, with the code (0 = green, 1 = red) so you can act on the result.
  - The full chain around a PR: ci-gate wait (pre-merge, checks green) -> merge
    -> pipeline-gate wait (build/deploy pipeline finished) -> api-version-gate /
    admin-version-gate wait (the new build is actually serving). Start
    pipeline-gate BEFORE the merge and it will wait for the merge first.
  - Pipeline green means the workflow finished, not that every downstream system
    caught up: the app submits to TestFlight with --no-wait, so Apple processing
    still takes a few minutes after this gate returns.
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
    process.stderr.write(`pipeline-gate: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
