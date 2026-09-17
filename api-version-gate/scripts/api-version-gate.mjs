#!/usr/bin/env node
// api-version-gate.mjs
//
// Agent-callable gate around the deployed API's /version endpoint (ETS-1980).
// Use it to make an admin/mobile ticket WAIT until a new API build is live on a
// given environment, and to serialize ("queue") several agents that are all
// waiting on the same deploy.
//
// No dependencies. Node 22+ (uses global fetch). Times/locks live under the OS
// temp dir so concurrent agents on the same machine coordinate automatically.
//
//   node scripts/api-version-gate.mjs current
//   node scripts/api-version-gate.mjs wait --commit <sha>
//   node scripts/api-version-gate.mjs wait --changed-from <sha>
//   node scripts/api-version-gate.mjs wait --shared deploy-dev
//   node scripts/api-version-gate.mjs queue --name admin-mobile -- <command...>
//
// Run `--help` for the full reference.

import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_URL = process.env.E2S_API_VERSION_URL ?? 'https://api-v2-dev.eats2seats.com/version';
const DEFAULT_REPO = process.env.E2S_API_REPO ?? 'Eats2Seats/eats2seats-api';
const TIMED_OUT = Symbol('timed-out');
const DEFAULT_INTERVAL_S = 30;
const DEFAULT_TIMEOUT_S = 1800; // 30 min; 0 = wait forever
const FETCH_TIMEOUT_MS = 12_000;
const STATE_DIR = path.join(os.tmpdir(), 'e2s-api-version-gate');

const nowMs = () => Date.now();
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');

function clock() {
  return nowIso().slice(11, 19);
}

// --- argument parsing -------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [], cmd: [] };
  let i = 0;
  // Everything after a bare `--` is the command to run (for `queue`).
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out.cmd = argv.slice(i + 1);
      break;
    }
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

// --- version fetching -------------------------------------------------------

async function fetchVersion(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    const raw = await res.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      // leave data null on non-JSON bodies
    }
    return { data, ok: res.ok, raw, status: res.status };
  } catch (err) {
    return { data: null, error: err.message, ok: false, raw: '', status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// Stable key for "which build is this". Prefers the full commit, falls back to
// the short commit, then builtAt. Returns null when the endpoint has no build
// info yet (e.g. a 404 from an older build without /version).
function buildKey(version) {
  if (!version) return null;
  const commit = typeof version.commit === 'string' ? version.commit.trim() : '';
  if (commit && commit !== 'dev') return commit.toLowerCase();
  const short = typeof version.commitShort === 'string' ? version.commitShort.trim() : '';
  if (short && short !== 'dev') return short.toLowerCase();
  if (typeof version.builtAt === 'string' && version.builtAt.trim()) return `builtAt:${version.builtAt.trim()}`;
  return null;
}

function matchesCommit(version, target) {
  if (!version) return false;
  const want = String(target).trim().toLowerCase();
  const full = (version.commit ?? '').toLowerCase();
  const short = (version.commitShort ?? '').toLowerCase();
  if (!want) return false;
  if (full && full.startsWith(want)) return true;
  if (short && (short === want || want.startsWith(short))) return true;
  return false;
}

function describe(result) {
  if (result.ok && result.data) {
    const v = result.data;
    const built = v.builtAt ? ` built=${v.builtAt}` : '';
    return `commit=${v.commitShort ?? v.commit ?? '?'} version=${v.version ?? '?'} env=${v.environment ?? '?'}${built}`;
  }
  if (result.status === 404) return 'HTTP 404 - /version not deployed yet (build predates the endpoint)';
  if (result.status) return `HTTP ${result.status}`;
  return `unreachable (${result.error ?? 'network error'})`;
}

// --- specific-PR gating (resolve the merge we are waiting on) ----------------

function ghJson(ghArgs) {
  const run = spawnSync('gh', ghArgs, { encoding: 'utf8' });
  if (run.error) throw new Error(`gh CLI not available: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`gh ${ghArgs.join(' ')} failed: ${run.stderr?.trim() || `exit ${run.status}`}`);
  return JSON.parse(run.stdout);
}

const PR_FIELDS = 'number,title,state,mergedAt,mergeCommit,url';

// Resolve the PR we are gating on, by number or by ticket (branch name == ticket
// id, per the project convention). Returns the PR object or null if not found.
function lookupPr(args) {
  const repo = args.repo && args.repo !== true ? args.repo : DEFAULT_REPO;
  if (args.pr && args.pr !== true) {
    return ghJson(['pr', 'view', String(args.pr), '--repo', repo, '--json', PR_FIELDS]);
  }
  const key = String(args.ticket);
  const list = ghJson(['pr', 'list', '--repo', repo, '--head', key, '--state', 'all', '--limit', '20', '--json', PR_FIELDS]);
  const merged = list.filter((p) => p.mergedAt).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
  return merged[0] ?? list[0] ?? null;
}

// Poll GitHub until the gated PR is merged; its merge time becomes the deploy
// floor. Returns { floorIso, pr } or TIMED_OUT.
async function waitForMerge(args, deadline, intervalMs) {
  const label = args.pr && args.pr !== true ? `PR #${args.pr}` : `ticket ${args.ticket}`;
  for (;;) {
    let pr = null;
    try {
      pr = lookupPr(args);
    } catch (err) {
      process.stderr.write(`[${clock()}] ${label}: lookup failed - ${err.message}\n`);
    }
    if (pr?.mergedAt) {
      const sha = pr.mergeCommit?.oid ? ` commit ${pr.mergeCommit.oid.slice(0, 8)}` : '';
      process.stderr.write(`[${clock()}] ${label} "${pr.title}" merged at ${pr.mergedAt}${sha}\n`);
      return { floorIso: pr.mergedAt, pr };
    }
    if (pr) {
      process.stderr.write(`[${clock()}] ${label} "${pr.title}" state=${pr.state} - not merged yet, waiting\n`);
    } else {
      process.stderr.write(`[${clock()}] ${label}: no matching PR found yet, waiting\n`);
    }
    if (nowMs() >= deadline) return TIMED_OUT;
    await sleep(intervalMs);
  }
}

// --- shared baseline (so concurrent waiters release on the same deploy) ------

function baselineFile(key) {
  return path.join(STATE_DIR, `baseline-${sanitize(key)}.json`);
}

function readBaseline(key) {
  try {
    return JSON.parse(readFileSync(baselineFile(key), 'utf8'));
  } catch {
    return null;
  }
}

// Atomically records the baseline once. If another agent already wrote it, that
// shared value wins so every waiter compares against the same starting point.
function claimBaseline(key, payload) {
  mkdirSync(STATE_DIR, { recursive: true });
  try {
    const fd = openSync(baselineFile(key), 'wx');
    writeSync(fd, JSON.stringify(payload, null, 2));
    closeSync(fd);
    return { mine: true, value: payload };
  } catch (err) {
    if (err.code === 'EEXIST') return { mine: false, value: readBaseline(key) };
    throw err;
  }
}

// --- global lock / queue ----------------------------------------------------

function lockPath(name) {
  return path.join(STATE_DIR, `lock-${sanitize(name)}`);
}

function readLockMeta(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

function lockExpired(meta) {
  if (!meta || !meta.ttlMs || !meta.acquiredAt) return false;
  return nowMs() - Date.parse(meta.acquiredAt) > meta.ttlMs;
}

async function acquireLock(name, { intervalMs = 1000, owner, ttlMs, waitMs }) {
  mkdirSync(STATE_DIR, { recursive: true });
  const dir = lockPath(name);
  const deadline = waitMs > 0 ? nowMs() + waitMs : Infinity;
  for (;;) {
    try {
      mkdirSync(dir); // atomic across processes
      writeFileSync(
        path.join(dir, 'meta.json'),
        JSON.stringify({ acquiredAt: nowIso(), owner: owner ?? `pid:${process.pid}`, pid: process.pid, ttlMs }, null, 2),
      );
      return dir;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const meta = readLockMeta(dir);
      if (lockExpired(meta)) {
        rmSync(dir, { force: true, recursive: true });
        continue; // retry immediately - stale lock reclaimed
      }
      if (nowMs() >= deadline) return null;
      const held = meta?.owner ? ` (held by ${meta.owner})` : '';
      process.stderr.write(`[${clock()}] queue "${name}" busy${held} - waiting...\n`);
      await sleep(intervalMs);
    }
  }
}

function releaseLock(name) {
  rmSync(lockPath(name), { force: true, recursive: true });
}

// --- subcommands ------------------------------------------------------------

async function cmdCurrent(args) {
  const url = args.url ?? DEFAULT_URL;
  const result = await fetchVersion(url);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: result.ok, status: result.status, url, version: result.data }, null, 2)}\n`);
  } else {
    process.stdout.write(`${url}\n${describe(result)}\n`);
  }
  return result.ok ? 0 : 1;
}

function resolveCondition(args, ctx) {
  // Best-effort commit match. Unreliable here: deploys squash-merge (the PR SHA
  // never lands on dev) and a pipeline can be cancelled by a later merge, so a
  // given commit may never deploy. Prefer the time-based default below.
  if (args.commit && args.commit !== true) {
    return { label: `commit matches ${args.commit} (best-effort)`, test: (v) => matchesCommit(v, args.commit) };
  }
  if (args.version && args.version !== true) {
    return { label: `version == ${args.version}`, test: (v) => v?.version === args.version };
  }
  if (args['changed-from'] && args['changed-from'] !== true) {
    const base = String(args['changed-from']).toLowerCase();
    return { label: `build changed from ${args['changed-from']}`, test: (v) => buildKey(v) !== null && buildKey(v) !== base };
  }

  // Default / --newer-than: TIME-based. Any successful deploy built after the
  // floor necessarily contains a change already merged to dev, regardless of
  // which commit triggered it - the robust signal under squash + cancellations.
  const floorIso = args['newer-than'] && args['newer-than'] !== true ? args['newer-than'] : ctx.floorIso;
  const floorMs = Date.parse(floorIso);
  return {
    label: `a deploy built after ${floorIso}`,
    test: (v) => {
      const builtMs = v?.builtAt ? Date.parse(v.builtAt) : NaN;
      if (!Number.isNaN(builtMs)) return builtMs > floorMs;
      // Fallback when the deployed build exposes no builtAt: any build change.
      const k = buildKey(v);
      return k != null && k !== ctx.startKey;
    },
  };
}

async function cmdWait(args) {
  const url = args.url ?? DEFAULT_URL;
  const intervalMs = Math.max(1, Number(args.interval ?? DEFAULT_INTERVAL_S)) * 1000;
  const timeoutS = Number(args.timeout ?? DEFAULT_TIMEOUT_S);
  const deadline = timeoutS > 0 ? nowMs() + timeoutS * 1000 : Infinity;

  // Establish the time floor used by the default condition.
  const startIso = nowIso();
  const probe = await fetchVersion(url);
  const startKey = buildKey(probe.data);

  // Phase 1 (optional): gate on a SPECIFIC PR/ticket. Wait for it to merge, then
  // use its merge time as the deploy floor. Every agent gating on the same PR
  // derives the same floor, so they coordinate without --shared.
  let prFloorIso = null;
  if (args.pr || args.ticket) {
    const merged = await waitForMerge(args, deadline, intervalMs);
    if (merged === TIMED_OUT) {
      process.stderr.write(`[${clock()}] TIMEOUT waiting for the PR to merge\n`);
      return 124;
    }
    prFloorIso = merged.floorIso;
  }

  // In the default time-based mode, --shared lets concurrent agents agree on a
  // single floor timestamp so they all release on the same deploy.
  let floorIso = prFloorIso ?? startIso;
  const timeMode = !args.commit && !args.version && !args['changed-from'];
  if (!prFloorIso && timeMode && args.shared && args.shared !== true && !args['newer-than']) {
    const claim = claimBaseline(args.shared, { capturedAt: startIso, floor: startIso, source: describe(probe) });
    floorIso = claim.value?.floor ?? startIso;
    process.stderr.write(`[${clock()}] shared floor "${args.shared}": ${floorIso} (${claim.mine ? 'set now' : 'joined existing'})\n`);
  }

  const condition = resolveCondition(args, { floorIso, startKey });
  process.stderr.write(`[${clock()}] gate: waiting until ${condition.label}\n`);
  process.stderr.write(`[${clock()}] target ${url} - polling every ${intervalMs / 1000}s${timeoutS > 0 ? `, timeout ${timeoutS}s` : ''}\n`);

  // Fast path: the probe we already did might satisfy the condition.
  if (probe.ok && condition.test(probe.data)) {
    return succeed(args, probe, condition);
  }
  process.stderr.write(`[${clock()}] ${describe(probe)} - not satisfied, waiting\n`);

  for (;;) {
    if (nowMs() >= deadline) {
      process.stderr.write(`[${clock()}] TIMEOUT after ${timeoutS}s - condition never met\n`);
      return 124;
    }
    await sleep(intervalMs);
    const result = await fetchVersion(url);
    if (result.ok && condition.test(result.data)) {
      return succeed(args, result, condition);
    }
    process.stderr.write(`[${clock()}] ${describe(result)} - still waiting\n`);
  }
}

function succeed(args, result, condition) {
  process.stderr.write(`[${clock()}] OK - ${condition.label} satisfied\n`);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ satisfied: true, version: result.data }, null, 2)}\n`);
  } else {
    process.stdout.write(`${describe(result)}\n`);
  }
  return 0;
}

async function cmdQueue(args) {
  const name = args.name && args.name !== true ? args.name : 'default';
  if (args.cmd.length === 0) {
    process.stderr.write('queue: nothing to run. Pass the command after `--`, e.g. queue --name x -- echo hi\n');
    return 2;
  }
  const ttlMs = Math.max(1, Number(args.ttl ?? 900)) * 1000; // lease auto-expires (default 15 min)
  const waitMs = Number(args.wait ?? 0) > 0 ? Number(args.wait) * 1000 : 3600 * 1000; // max time to wait for a turn

  const dir = await acquireLock(name, { owner: args.owner === true ? undefined : args.owner, ttlMs, waitMs });
  if (!dir) {
    process.stderr.write(`[${clock()}] queue "${name}": could not acquire lock within wait window\n`);
    return 124;
  }
  process.stderr.write(`[${clock()}] queue "${name}": acquired - running command\n`);
  const release = () => releaseLock(name);
  process.on('SIGINT', () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });
  try {
    const run = spawnSync(args.cmd[0], args.cmd.slice(1), { stdio: 'inherit' });
    const code = run.status ?? (run.error ? 1 : 0);
    if (run.error) process.stderr.write(`[${clock()}] queue "${name}": command error - ${run.error.message}\n`);
    return code;
  } finally {
    release();
    process.stderr.write(`[${clock()}] queue "${name}": released\n`);
  }
}

const HELP = `api-version-gate.mjs - wait for a new deployed API version, and queue agents around it.

Reads the /version endpoint added in ETS-1980 and blocks until a new build is
live, so an admin/mobile ticket only starts after its API dependency is deployed.

WHY TIME, NOT COMMIT
  Deploys squash-merge, so a PR's commit SHA never lands on dev; and a pipeline
  can be cancelled by a later merge, so a given commit may never deploy. But ANY
  successful deploy built after a change merged to dev necessarily contains it.
  So the gate is time-based: wait until the deployed build's builtAt is later
  than a floor. The most precise floor is a specific PR's merge time (--pr).

USAGE
  node scripts/api-version-gate.mjs <command> [options]

COMMANDS
  current                       Fetch and print the deployed version once.
  wait                          Block until a deploy newer than the floor is live.
  queue --name N -- <cmd...>    Run <cmd> under a global mutex (one agent at a time).

wait FLOOR / CONDITION (pick one; default = a deploy built after "now")
  --pr <number>           wait for that PR to MERGE, then for a deploy built
                          after its merge time. The robust "specific change" gate.
  --ticket <KEY>          same, resolving the PR by branch name == ticket id
                          (e.g. --ticket ETS-1980).
  --newer-than <iso>      until deployed builtAt is later than <iso> (explicit floor,
                          e.g. the dev merge time: git show -s --format=%cI origin/dev).
  --shared <key>          default mode only: concurrent agents share one floor
                          timestamp under <key> and release on the same deploy.
  --commit <sha>          best-effort: until deployed commit matches <sha>. Unreliable
                          under squash + cancelled pipelines; prefer --pr.
  --version <semver>      until deployed version equals <semver>.
  --changed-from <sha>    until deployed build differs from <sha>.

COMMON OPTIONS
  --repo <owner/name>     GitHub repo for --pr/--ticket (default ${DEFAULT_REPO}
                          or $E2S_API_REPO).
  --url <url>             Override endpoint (default ${DEFAULT_URL}
                          or $E2S_API_VERSION_URL).
  --interval <seconds>    Poll interval for wait (default ${DEFAULT_INTERVAL_S}).
  --timeout <seconds>     Give up after N seconds, 0 = forever (default ${DEFAULT_TIMEOUT_S}).
                          Covers both phases (merge wait + deploy wait).
  --json                  Machine-readable output on stdout.

queue OPTIONS
  --name <name>           Lock name (agents sharing a name are serialized).
  --owner <id>            Label shown to others waiting on the lock.
  --ttl <seconds>         Lease length; a crashed holder's lock auto-expires (default 900).
  --wait <seconds>        Max time to wait for your turn (default 3600).

EXIT CODES
  0   condition met / queued command succeeded
  2   usage error
  124 timed out (PR never merged, deploy never landed, or queue turn never came)
  *   queued command's own exit code

AGENT TIPS
  - An admin/mobile ticket that depends on a specific API PR (named in its
    comments): \`wait --pr <number>\` (or \`--ticket <KEY>\`). Several agents gating
    on the same PR share the merge-time floor automatically.
  - Run \`wait\` as a background shell task; the harness wakes you when it exits 0.
  - Generic "next deploy" across agents: each runs \`wait --shared deploy-dev\`.
  - To serialize the downstream work itself, wrap it: \`queue --name admin-mobile -- <build/codegen/...>\`.
`;

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
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
    case 'queue':
      return cmdQueue(args);
    default:
      process.stderr.write(`Unknown command: ${command}\nRun --help for usage.\n`);
      return 2;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(`api-version-gate: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
