#!/usr/bin/env node
// pr-review.mjs - Diff-scoped static analysis for a PR or branch.
//
// Runs complexity (eslint complexity rules), duplication (jscpd), eslint,
// prettier and tsc, but only reports findings that touch the lines a PR/branch
// actually changed. It writes a machine-readable report.json plus a human
// summary.md under
// <E2S_ROOT>/pr-reviews/<repo>-<id>/. This is the objective half of PR review;
// the Claude "pr-review" skill consumes report.json to write a CodeRabbit-style
// review with fix prompts.
//
// Static tools read the WORKING TREE on disk. Review from the branch's worktree
// (or check the branch out) so the analyzed code matches the diff. With --pr the
// script warns if the current branch is not the PR head.
//
// Usage: scripts/pr-review.mjs --repo <api|admin|app|eats2seats-...> [target] [flags]
//   --pr <n>            Diff via `gh pr diff <n>`
//   --base <ref>        Diff = git diff <base>...HEAD            (default: origin/dev)
//   --head <ref>        New side of the diff                     (default: HEAD)
//   --working-tree      Diff = uncommitted work vs HEAD (staged + unstaged + new files)
//   --staged            Diff = staged changes vs HEAD (the index)
//   --fetch             `git fetch` the base before diffing      (default: off)
//   --no-complexity --no-dup --no-eslint --no-prettier --no-types
//   --all-findings      Report everything in changed files, not only changed lines
//   --ccn <n>           Cyclomatic-complexity threshold          (default: 15)
//   --simple            Print the full summary.md to stdout
//   --json              Print report.json to stdout
//   --out <dir>         Output dir (default: <E2S_ROOT>/pr-reviews/<repo>-<id>/)
//   --help

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const E2S_ROOT = '/home/davidcostadevr/scrumlaunch/e2s';
const ANALYZABLE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST = /\.(spec|test)\.(ts|tsx|js|jsx)$/;
// ESLint rules driven as the complexity layer (typescript-eslint parses TS
// boundaries correctly, unlike lizard) -> rule id mapped to a severity bucket.
const COMPLEXITY_RULES = {
  complexity: 'medium',
  'max-lines-per-function': 'low',
  'max-params': 'low',
};
const SKIP = [
  /\/src\/gql\//,
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.next\//,
  /\.gen\.(ts|tsx|js)$/,
  /(^|\/)schema\.gql$/,
];

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const EMOJI = { high: '\u{1F534}', medium: '\u{1F7E1}', low: '\u{1F535}' };
const SEV_LABEL = { high: 'Potential issue', medium: 'Refactor suggestion', low: 'Nitpick' };

// ----------------------------------------------------------------------------- args
function parseArgs(argv) {
  const o = {
    repo: '',
    pr: '',
    base: 'origin/dev',
    head: 'HEAD',
    workingTree: false,
    staged: false,
    fetch: false,
    complexity: true,
    dup: true,
    eslint: true,
    prettier: true,
    types: true,
    allFindings: false,
    ccn: 15,
    simple: false,
    json: false,
    out: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--repo': o.repo = next(); break;
      case '--pr': o.pr = next(); break;
      case '--base': o.base = next(); break;
      case '--head': o.head = next(); break;
      case '--working-tree': case '--wip': o.workingTree = true; break;
      case '--staged': case '--cached': o.staged = true; break;
      case '--fetch': o.fetch = true; break;
      case '--no-complexity': o.complexity = false; break;
      case '--no-dup': o.dup = false; break;
      case '--no-eslint': o.eslint = false; break;
      case '--no-prettier': o.prettier = false; break;
      case '--no-types': o.types = false; break;
      case '--all-findings': o.allFindings = true; break;
      case '--ccn': o.ccn = Number(next()); break;
      case '--simple': o.simple = true; break;
      case '--json': o.json = true; break;
      case '--out': o.out = next(); break;
      case '--help': case '-h': usage(); process.exit(0); break;
      default:
        if (a.startsWith('--')) { die(`Unknown argument: ${a}`); }
        else if (!o.repo) { o.repo = a; }
        else { die(`Unexpected argument: ${a}`); }
    }
  }
  return o;
}

function usage() {
  process.stdout.write(`Usage: scripts/pr-review.mjs --repo <api|admin|app|eats2seats-...> [target] [flags]

Diff-scoped static analysis (complexity, duplication, eslint, prettier, tsc).
Writes report.json + summary.md to <E2S_ROOT>/pr-reviews/<repo>-<id>/.

Target (pick one):
  --pr <n>            Diff via 'gh pr diff <n>'
  --base <ref>        Diff = git diff <base>...HEAD   (default: origin/dev)
  --head <ref>        New side of the diff            (default: HEAD)
  --working-tree      Uncommitted work vs HEAD (staged + unstaged + new files)
  --staged            Staged changes vs HEAD (the index)
  --fetch             'git fetch' the base first       (default: off)

Toggles (all analyses on by default):
  --no-complexity --no-dup --no-eslint --no-prettier --no-types
  --all-findings      Report everything in changed files, not only changed lines
  --ccn <n>           Cyclomatic-complexity threshold (default: 15)

Output:
  --simple            Print the full summary.md to stdout
  --json              Print report.json to stdout
  --out <dir>         Override output dir
  --help

Examples:
  scripts/pr-review.mjs --repo api --base origin/dev --simple
  scripts/pr-review.mjs --repo eats2seats-api_ETS-1903 --base origin/dev
  scripts/pr-review.mjs --repo admin --pr 412 --json
  scripts/pr-review.mjs --repo api --working-tree --simple   # review uncommitted WIP before commit
`);
}

function die(msg) {
  process.stderr.write(`${C.red('error')}: ${msg}\n`);
  process.exit(2);
}

// ----------------------------------------------------------------------------- exec
function run(cmd, args, cwd, timeout = 180000) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  return {
    code: r.status ?? (r.signal ? 124 : 1),
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error,
  };
}

// ----------------------------------------------------------------------------- repo
function resolveRepo(name) {
  if (!name) die('--repo is required (api | admin | app | eats2seats-...)');
  const map = { api: 'eats2seats-api', admin: 'eats2seats-admin', app: 'eats2seats-app' };
  const full = map[name] ?? (name.startsWith('eats2seats-') ? name : `eats2seats-${name}`);
  const dir = join(E2S_ROOT, full);
  if (!existsSync(dir)) die(`repo directory not found: ${dir}`);
  if (!existsSync(join(dir, '.git'))) die(`not a git repo: ${dir}`);
  return { name: full, short: full.replace(/^eats2seats-/, ''), dir };
}

// ----------------------------------------------------------------------------- diff
function getDiff(o, repo) {
  if (o.workingTree || o.staged) return getUncommittedDiff(o, repo);
  let diffText = '';
  let label = '';
  if (o.pr) {
    const view = run('gh', ['pr', 'view', o.pr, '--json', 'headRefName,baseRefName'], repo.dir);
    let head = '';
    if (view.code === 0) {
      try {
        const j = JSON.parse(view.stdout);
        head = j.headRefName || '';
        label = `PR #${o.pr} (${j.headRefName} <- base ${j.baseRefName})`;
      } catch { /* ignore */ }
    }
    const cur = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repo.dir).stdout.trim();
    if (head && cur && head !== cur) {
      warn(`current branch '${cur}' != PR head '${head}'. Static tools read the working tree, so results may not match PR #${o.pr}. Check out the branch for accurate metrics.`);
    }
    const d = run('gh', ['pr', 'diff', o.pr], repo.dir);
    if (d.code !== 0) die(`gh pr diff ${o.pr} failed: ${d.stderr.trim() || d.stdout.trim()}`);
    diffText = d.stdout;
    if (!label) label = `PR #${o.pr}`;
  } else {
    if (o.fetch) {
      const remote = o.base.includes('/') ? o.base.split('/')[0] : 'origin';
      run('git', ['fetch', remote], repo.dir, 60000);
    }
    const d = run('git', ['diff', `${o.base}...${o.head}`], repo.dir);
    if (d.code !== 0) die(`git diff ${o.base}...${o.head} failed: ${d.stderr.trim()}`);
    diffText = d.stdout;
    label = `${o.head} vs ${o.base}`;
  }
  return { diffText, label };
}

// Diff of uncommitted work (no PR / no base branch needed):
//   --staged       -> git diff --cached            (the index vs HEAD; staged-new files included)
//   --working-tree -> git diff HEAD + untracked    (staged + unstaged + new files vs HEAD)
// The static tools already read the working tree on disk, so this just rescopes
// the "changed lines" to the current work-in-progress.
function getUncommittedDiff(o, repo) {
  if (o.pr) die('--pr cannot be combined with --working-tree/--staged');
  if (o.staged) {
    const d = run('git', ['diff', '--cached'], repo.dir);
    if (d.code !== 0) die(`git diff --cached failed: ${d.stderr.trim()}`);
    return { diffText: d.stdout, label: 'staged changes (uncommitted)' };
  }
  const tracked = run('git', ['diff', 'HEAD'], repo.dir);
  if (tracked.code !== 0) die(`git diff HEAD failed: ${tracked.stderr.trim()}`);
  let diffText = tracked.stdout;
  // git diff HEAD omits untracked files; add each new file as a fully-added diff.
  const others = run('git', ['ls-files', '--others', '--exclude-standard'], repo.dir).stdout
    .split('\n').map((s) => s.trim()).filter(Boolean);
  for (const f of others) {
    if (!isAnalyzable(f)) continue;
    const d = run('git', ['diff', '--no-index', '--', '/dev/null', f], repo.dir);
    if (d.stdout) diffText += (diffText.endsWith('\n') || !diffText ? '' : '\n') + d.stdout;
  }
  return { diffText, label: 'working tree (uncommitted) vs HEAD' };
}

// Parse a unified diff into { file -> [[start,end], ...] } of changed (new-side) lines.
function parseDiff(diffText) {
  const files = new Map();
  let file = null;
  let newLine = 0;
  let ranges = null;
  const flush = () => { if (file && ranges) files.set(file, mergeRanges(ranges)); };
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      flush();
      const p = line.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      ranges = file ? [] : null;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('diff ') || line.startsWith('index ')) continue;
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) { newLine = Number(hunk[1]); continue; }
    if (!file || !ranges) continue;
    if (line.startsWith('+')) { ranges.push([newLine, newLine]); newLine++; }
    else if (line.startsWith('-')) { /* removed: do not advance new-side */ }
    else if (line.startsWith('\\')) { /* "No newline" marker */ }
    else { newLine++; } // context line
  }
  flush();
  return files;
}

function mergeRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i][0] <= last[1] + 1) last[1] = Math.max(last[1], sorted[i][1]);
    else out.push(sorted[i].slice());
  }
  return out;
}

const lineIn = (line, ranges) => ranges.some(([s, e]) => line >= s && line <= e);
const rangeHits = (s, e, ranges) => ranges.some(([rs, re]) => s <= re && e >= rs);

function isAnalyzable(file) {
  if (!ANALYZABLE.test(file)) return false;
  return !SKIP.some((re) => re.test(file));
}

// ----------------------------------------------------------------------------- analyzers
// One eslint pass covers both the complexity layer and the repo's own lint
// rules. Complexity rules are layered on with --rule and bucketed as
// tool="complexity"; every other rule is the repo's own config (tool="eslint").
function runLint(files, srcFiles, changed, o, notes) {
  if (!files.length) return [];
  const srcSet = new Set(srcFiles ?? []);
  const args = ['--no-install', 'eslint', '--no-error-on-unmatched-pattern'];
  if (o.complexity) {
    args.push('--rule', JSON.stringify({
      complexity: ['warn', o.ccn],
      'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
      'max-params': ['warn', 4],
    }));
  }
  args.push('--format', 'json', ...files);
  const r = run('npx', args, cwdRepo);
  if (r.error) { notes.push(`eslint: failed to run (${r.error.message})`); return []; }
  let data;
  try { data = JSON.parse(r.stdout); }
  catch {
    notes.push(`eslint: could not parse output${r.stderr ? ` (${r.stderr.trim().split('\n')[0]})` : ''}`);
    return [];
  }
  const findings = [];
  for (const fileRes of data) {
    const rel = relOrName(fileRes.filePath);
    const ranges = changed.get(rel);
    for (const m of fileRes.messages ?? []) {
      const complexityBucket = COMPLEXITY_RULES[m.ruleId];
      if (complexityBucket) {
        // Complexity is function-scoped: skip tests, match by the whole body range.
        if (!o.complexity || !srcSet.has(rel)) continue;
        const start = m.line ?? 0;
        const end = m.endLine ?? start;
        if (!o.allFindings && ranges && !rangeHits(start, end, ranges)) continue;
        findings.push(mk('complexity', complexityBucket, rel, start, end, m.ruleId, m.message, ''));
      } else {
        if (!o.eslint) continue;
        if (!m.ruleId && /ignored/i.test(m.message)) continue; // "File ignored ..."
        if (!o.allFindings && ranges && m.line && !lineIn(m.line, ranges)) continue;
        const sev = m.severity === 2 ? 'high' : 'medium';
        findings.push(mk('eslint', sev, rel, m.line ?? 0, m.endLine ?? m.line ?? 0,
          m.ruleId || 'eslint', m.message, m.ruleId || ''));
      }
    }
  }
  return findings;
}

function runDup(changedAbs, changed, o, notes, srcFiles) {
  const srcAbs = new Set((srcFiles ?? []).map((f) => resolve(cwdRepo, f)));
  const out = join(tmpdir(), `jscpd-${process.pid}`);
  rmSync(out, { recursive: true, force: true });
  const scan = existsSync(join(cwdRepo, 'src')) ? 'src' : '.';
  const r = run('pnpm', [
    // Pinned to v4: jscpd@5 is a rewrite with an incompatible CLI (no --ignore)
    // and a different report format.
    'dlx', 'jscpd@4', scan,
    '--reporters', 'json', '--silent', '--mode', 'mild',
    '--min-lines', '5', '--min-tokens', '50',
    '--output', out,
    '--ignore', '**/node_modules/**,**/dist/**,**/.next/**,**/*.spec.ts,**/*.test.ts,**/src/gql/**',
  ], cwdRepo, 240000);
  const reportPath = join(out, 'jscpd-report.json');
  if (!existsSync(reportPath)) {
    notes.push(`duplication: jscpd produced no report${r.stderr ? ` (${r.stderr.trim().split('\n').pop()})` : ''}`);
    return [];
  }
  let data;
  try { data = JSON.parse(readFileSync(reportPath, 'utf8')); }
  catch { notes.push('duplication: could not parse jscpd report'); return []; }
  rmSync(out, { recursive: true, force: true });
  const findings = [];
  const seen = new Set();
  for (const dup of data.duplicates ?? []) {
    for (const [side, other] of [[dup.firstFile, dup.secondFile], [dup.secondFile, dup.firstFile]]) {
      const abs = resolve(cwdRepo, side.name);
      const rel = changedAbs.get(abs);
      if (!rel) continue;
      if (srcAbs.size && !srcAbs.has(abs)) continue; // skip test/non-src changed files

      const s = side.start ?? side.startLoc?.line;
      const e = side.end ?? side.endLoc?.line;
      const ranges = changed.get(rel);
      if (!o.allFindings && ranges && !rangeHits(s, e, ranges)) continue;
      const key = `${rel}:${s}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const otherRel = abs === resolve(cwdRepo, other.name)
        ? other.name : relOrName(other.name);
      findings.push(mk('duplication', 'medium', rel, s, e, 'duplicate-code',
        `Lines ${s}-${e} duplicate ${dup.lines} lines from ${otherRel}:${other.start ?? other.startLoc?.line}. Extract a shared helper.`,
        `${dup.lines} lines`));
    }
  }
  return findings;
}

function relOrName(name) {
  const abs = isAbsolute(name) ? name : resolve(cwdRepo, name);
  return abs.startsWith(cwdRepo + '/') ? abs.slice(cwdRepo.length + 1) : name;
}

function runPrettier(files, notes) {
  const r = run('npx', ['--no-install', 'prettier', '--list-different', ...files], cwdRepo);
  if (r.error) { notes.push(`prettier: failed (${r.error.message})`); return []; }
  const findings = [];
  for (const line of r.stdout.split('\n')) {
    const f = line.trim();
    if (!f) continue;
    findings.push(mk('prettier', 'low', relOrName(f), 0, 0, 'formatting',
      'File is not formatted. Run pnpm format.', ''));
  }
  return findings;
}

function runTypes(changed, o, notes) {
  const r = run('npx', ['--no-install', 'tsc', '--noEmit', '--pretty', 'false'], cwdRepo);
  if (r.error) { notes.push(`types: tsc failed to run (${r.error.message})`); return []; }
  const findings = [];
  const re = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/;
  for (const line of (r.stdout + '\n' + r.stderr).split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const rel = relOrName(m[1]);
    const ln = Number(m[2]);
    const ranges = changed.get(rel);
    if (!ranges) continue; // only changed files
    if (!o.allFindings && !lineIn(ln, ranges)) continue;
    findings.push(mk('types', 'high', rel, ln, ln, m[5], m[6], m[5]));
  }
  return findings;
}

function mk(tool, severity, file, line, endLine, rule, message, metric) {
  return { tool, severity, file, line, endLine, rule, message, metric };
}

// ----------------------------------------------------------------------------- report
function buildSummary(report) {
  const { repo, target, base, head, files, findings, totals, notes } = report;
  const lines = [];
  lines.push(`# PR Review - ${repo} (${target})`);
  lines.push('');
  lines.push(`- Base: \`${base}\`  Head: \`${head}\``);
  lines.push(`- Changed analyzable files: ${files.length}`);
  lines.push(`- Findings: ${EMOJI.high} ${totals.high} high  ${EMOJI.medium} ${totals.medium} medium  ${EMOJI.low} ${totals.low} low`);
  lines.push('');
  if (notes.length) {
    lines.push('> Notes: ' + notes.join('; '));
    lines.push('');
  }
  lines.push('## Files');
  lines.push('');
  lines.push('| File | Findings |');
  lines.push('| --- | --- |');
  for (const f of files) lines.push(`| \`${f.path}\` | ${f.findingCount} |`);
  lines.push('');
  for (const sev of ['high', 'medium', 'low']) {
    const group = findings.filter((x) => x.severity === sev);
    if (!group.length) continue;
    lines.push(`## ${EMOJI[sev]} ${SEV_LABEL[sev]} (${group.length})`);
    lines.push('');
    for (const f of group) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      lines.push(`- **${loc}** \`[${f.tool}${f.rule ? `/${f.rule}` : ''}]\` - ${f.message}`);
    }
    lines.push('');
  }
  if (!findings.length) {
    lines.push('No static findings in the changed lines. Looks clean.');
    lines.push('');
  }
  return lines.join('\n');
}

function printStdoutSummary(report, outDir) {
  const { totals, files } = report;
  process.stdout.write(
    `\n${C.bold('PR Review')} - ${report.repo} (${report.target})\n` +
    `  files: ${files.length}   ` +
    `${C.red(`${EMOJI.high} ${totals.high}`)}  ${C.yellow(`${EMOJI.medium} ${totals.medium}`)}  ${C.blue(`${EMOJI.low} ${totals.low}`)}\n` +
    `  ${C.dim('report:')} ${join(outDir, 'report.json')}\n` +
    `  ${C.dim('summary:')} ${join(outDir, 'summary.md')}\n\n`,
  );
}

function warn(msg) { process.stderr.write(`${C.yellow('warn')}: ${msg}\n`); }

// ----------------------------------------------------------------------------- main
let cwdRepo = '';

function main() {
  const o = parseArgs(process.argv.slice(2));
  const repo = resolveRepo(o.repo);
  cwdRepo = repo.dir;

  const { diffText, label } = getDiff(o, repo);
  const changed = parseDiff(diffText);

  // analyzable changed files (relative paths) that still exist on disk
  const relFiles = [...changed.keys()].filter(
    (f) => isAnalyzable(f) && existsSync(join(cwdRepo, f)),
  );
  const changedAbs = new Map(relFiles.map((f) => [resolve(cwdRepo, f), f]));

  const branchName = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwdRepo).stdout.trim().replace(/[^\w.-]/g, '_') || 'head';
  const id = o.pr ? `pr-${o.pr}`
    : o.staged ? `staged-${branchName}`
    : o.workingTree ? `worktree-${branchName}`
    : `branch-${branchName}`;
  const outDir = o.out ? resolve(o.out) : join(E2S_ROOT, 'pr-reviews', `${repo.short}-${id}`);

  // Effective base/head shown in the report (working-tree modes diff against HEAD on disk).
  const reportBase = (o.workingTree || o.staged) ? 'HEAD' : o.base;
  const reportHead = o.staged ? 'index (staged)' : o.workingTree ? 'working tree' : o.head;

  const notes = [];
  let findings = [];

  if (!relFiles.length) {
    notes.push('no analyzable changed files found');
  } else {
    // Complexity/duplication skip test files: long describe/it bodies are expected, not actionable.
    const srcFiles = relFiles.filter((f) => !TEST.test(f));
    // One eslint pass handles both the complexity layer and the repo's lint rules.
    if (o.complexity || o.eslint) findings = findings.concat(runLint(relFiles, srcFiles, changed, o, notes));
    if (o.dup) findings = findings.concat(runDup(changedAbs, changed, o, notes, srcFiles));
    if (o.prettier) findings = findings.concat(runPrettier(relFiles, notes));
    if (o.types) findings = findings.concat(runTypes(changed, o, notes));
  }

  findings.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return (a.line || 0) - (b.line || 0);
  });

  const totals = {
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    low: findings.filter((f) => f.severity === 'low').length,
  };
  const files = relFiles.map((path) => ({
    path,
    addedRanges: changed.get(path) ?? [],
    findingCount: findings.filter((f) => f.file === path).length,
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    repo: repo.name,
    repoDir: cwdRepo,
    target: label,
    base: reportBase,
    head: reportHead,
    pr: o.pr || null,
    scopedToChangedLines: !o.allFindings,
    files,
    findings,
    totals,
    notes,
  };

  mkdirSync(outDir, { recursive: true });
  const summary = buildSummary(report);
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(outDir, 'summary.md'), summary + '\n');

  if (o.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else if (o.simple) process.stdout.write(summary + '\n');
  else printStdoutSummary(report, outDir);
}

main();
